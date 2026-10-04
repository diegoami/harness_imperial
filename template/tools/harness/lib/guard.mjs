// The commands a Claude agent of each role must never run, for the PreToolUse hook in its agent
// file (.claude/agents/<role>.md, through tools/harness/guard.mjs). The agent's prompt says the same;
// the hook makes it hold whatever the prompt says (#3).
//
// It reads a command line as the shell would: its simple commands at ;, &&, ||, |, newlines,
// subshells and $( ), with every kind of quoting and escape respected ('…', "…", $'…', $"…", \),
// and each simple command as the words the shell passes. A `git` or `gh` word is checked wherever
// it stands, so no prefix hides it (`timeout 10 git push`, `sudo -u root git push`: #62); every
// argument of a shell (`bash -o pipefail -c '…'`) or of `eval` is read as a command line in turn.
// It fails closed (Sol's R1 and R2 on PR 66): what it cannot read before the shell runs it is
// refused, namely a variable, substitution, glob or brace expansion where a command name or a
// git/gh subcommand could stand, or as an argument of a command not known to leave its arguments
// unrun (SAFE); a shell reading commands from stdin; a git alias set on the command line; and
// nesting deeper than it reads. An unquoted mention (`echo git push`) is refused too. It is a
// safeguard against an agent's mistakes, not a sandbox: a script file, or a program that makes
// the call itself, is beyond it.

// A git command, after any of git's own options: -C <dir>, -c <key=value>, --git-dir <dir> and the
// like with their argument, and flags such as --no-pager or --git-dir=<dir> (Luna's R1, round 2).
const GIT_OPT = `(?:\\s+(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)\\s+(?:"[^"]*"|'[^']*'|\\S+)|\\s+-{1,2}[\\w-]+(?:=\\S+)?)*`;
const git = (sub) => new RegExp(`^git${GIT_OPT}\\s+${sub}`);

// gh commands that only read. Every other gh command is a write for the reviewer.
const GH_READ = /^gh\s+(?:--version\b|version\b|auth\s+status\b|pr\s+(?:view|diff|list|checks|status)\b|issue\s+(?:view|list|status)\b|run\s+(?:view|list|watch)\b|workflow\s+(?:view|list)\b|repo\s+view\b|release\s+(?:view|list)\b|label\s+list\b|search\s+\w+)/;
// `gh api` reads only as a plain GET: no other method, and no field or input (which make it a POST).
const ghApiWrite = (cmd) => /^gh\s+api\b/.test(cmd)
  && (/\s(?:-X|--method)(?:\s+|=)(?!GET\b)\w+/i.test(cmd) || /\s(?:-f|-F|--field|--raw-field|--input)(?:\s|=)/.test(cmd));
const ghWrite = (cmd) => /^gh\b/.test(cmd) && (/^gh\s+api\b/.test(cmd) ? ghApiWrite(cmd) : !GH_READ.test(cmd));

export const RULES = {
  // Read-only: the reviewer returns its review, and post-review.mjs posts it.
  reviewer: [
    [git('commit\\b'), 'git commit'], [git('push\\b'), 'git push'],
    [ghWrite, 'a gh command that writes (only view, diff, list, checks and GET api calls are allowed)'],
  ],
  // The Claude fallback implementer: one branch, one PR, never shared state.
  implementer: [
    [git('stash\\b'), 'git stash (shared by every worktree, L19)'], [git('worktree\\b'), 'git worktree'],
    [git('push\\b.*(?:\\s--force\\b|\\s--force-with-lease\\b|\\s-(?!-)[a-zA-Z]*f[a-zA-Z]*\\b|\\s\\+\\S)'), 'a force-push'],
    [/^gh\s+pr\s+merge\b/, 'gh pr merge'], [/^gh\s+api\b.*\/pulls\/\d+\/merge\b/, 'a merge through gh api'],
  ],
};

// The simple commands in a shell command line, split at ;, &&, ||, |, & and newlines and at subshell
// parentheses. Quotes and backslash escapes are respected, so `"fix; then push"` and `\"; git push`
// are read as the shell reads them. A substitution, $( … ) or `…`, stays inside its word: its value
// can become a command name (`$(echo git) push`), and substitutions() reads what it runs.
export function simpleCommands(line) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && quote !== "'" && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '$' && s[i + 1] === "'") { const j = ansiEnd(s, i); cur += s.slice(i, j + 1); i = j; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '$' && s[i + 1] === '(' || c === '`') { const j = substitutionEnd(s, i); cur += s.slice(i, j + 1); i = j; continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (';|\n()&'.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// The command lines inside $( … ) and backquotes, wherever they are but in single quotes: the shell
// runs them inside double quotes too (`echo "$(git push)"`, Luna's R1, round 2). Nested ones are
// found when these are read in turn.
export function substitutions(line) {
  const s = String(line);
  const out = [];
  let single = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && !single) { i++; continue; }
    if (c === '$' && s[i + 1] === "'" && !single && !inDouble(s, i)) { i = ansiEnd(s, i); continue; }
    if (c === "'" && !single && !inDouble(s, i)) { single = true; continue; }
    if (c === "'" && single) { single = false; continue; }
    if (single) continue;
    if (c === '$' && s[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < s.length && depth; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; }
      out.push(s.slice(i + 2, depth ? s.length : j - 1));
      i = j - 1;
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      out.push(s.slice(i + 1, j < 0 ? s.length : j));
      i = j < 0 ? s.length : j;
    }
  }
  return out;
}
// Whether position i of s is inside double quotes (a single quote there is a plain character).
function inDouble(s, i) {
  let d = false;
  let q = false;
  for (let k = 0; k < i; k++) {
    if (s[k] === '\\' && !q) { k++; continue; }
    if (s[k] === "'" && !d) q = !q;
    else if (s[k] === '"' && !q) d = !d;
  }
  return d;
}

// Where a substitution that starts at i ($( … ) or `…`) ends: the index of its last character.
function substitutionEnd(s, i) {
  if (s[i] === '`') { const j = s.indexOf('`', i + 1); return j < 0 ? s.length - 1 : j; }
  let depth = 1;
  let j = i + 2;
  for (; j < s.length && depth; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; }
  return j - 1;
}

// Where an ANSI-C string $'…' that starts at i ends: the index of its closing quote.
function ansiEnd(s, i) {
  let j = i + 2;
  while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
  return Math.min(j, s.length);
}

// The text of an ANSI-C string $'…' that starts at i, as bash decodes it, and where it ends.
const ANSI = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function ansiC(s, i) {
  const end = ansiEnd(s, i);
  let v = '';
  for (let j = i + 2; j < end; j++) {
    if (s[j] !== '\\') { v += s[j]; continue; }
    const e = s[++j];
    const hex = (n) => s.slice(j + 1, j + 1 + n).match(/^[0-9a-fA-F]+/)?.[0];
    if (e in ANSI) v += ANSI[e];
    else if (/[0-7]/.test(e)) { const m = s.slice(j, j + 3).match(/^[0-7]+/)[0]; v += String.fromCharCode(parseInt(m, 8) & 255); j += m.length - 1; }
    else if (e === 'x' && hex(2)) { const m = hex(2); v += String.fromCharCode(parseInt(m, 16)); j += m.length; }
    else if ((e === 'u' || e === 'U') && hex(e === 'u' ? 4 : 8) && parseInt(hex(e === 'u' ? 4 : 8), 16) <= 0x10ffff) {
      const m = hex(e === 'u' ? 4 : 8); v += String.fromCodePoint(parseInt(m, 16)); j += m.length;
    } else if (e === 'c' && j + 1 < end) { v += String.fromCharCode(s[j + 1].toUpperCase().charCodeAt(0) & 31); j++; }
    else v += `\\${e ?? ''}`;
  }
  return [v, end];
}

// A `$` that starts an expansion: $name, ${…}, $(…), $((…)), or a special parameter.
const expands = (s, i) => s[i] === '$' && /[\w{(@*#?!$-]/.test(s[i + 1] ?? '');

// The words of a simple command as the shell passes them, each with whether the shell only knows
// it at run time (`dynamic`: a variable, substitution, glob or brace expansion in it). Quotes are
// removed, escapes resolved, $'…' decoded, adjacent quoted parts joined (`pu''sh` is `push`), and a
// backslash-newline dropped (#62).
function parseWords(cmd) {
  const out = [];
  let w = null;
  let dyn = false;
  const s = String(cmd);
  const add = (x) => { w = (w ?? '') + x; };
  const end = () => { if (w !== null) out.push({ text: w, dynamic: dyn }); w = null; dyn = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] !== '\n') add(s[i + 1] ?? '');
      i++;
    } else if (c === '$' && s[i + 1] === "'") {
      const [v, j] = ansiC(s, i);
      add(v);
      i = j;
    } else if (c === '$' && s[i + 1] === '"') {
      add('');                                                     // $"…" is read as "…"
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      add(s.slice(i + 1, j < 0 ? s.length : j));
      i = j < 0 ? s.length : j;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && '"\\$`\n'.includes(s[j + 1])) { if (s[j + 1] !== '\n') v += s[j + 1]; j++; continue; }
        if (expands(s, j) || s[j] === '`') dyn = true;
        v += s[j];
      }
      add(v);
      i = j;
    } else if (/\s/.test(c)) end();
    else {
      const rest = s.slice(i).match(/^\S*/)[0];
      if (expands(s, i) || c === '`' || c === '*' || c === '?' || (c === '[' && rest.indexOf(']') > 1)
        || (c === '{' && /^\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(rest))) dyn = true;
      add(c);
    }
  }
  end();
  return out;
}
export const words = (cmd) => parseWords(cmd).map((w) => w.text);

// git's own options before its subcommand, those that take an argument (Luna's R1, round 2).
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const SHELL = /^(?:ba|z|da|k)?sh$/;
const base = (w) => w.replace(/^.*\//, '');
// Words that come before a command without being one: shell keywords and VAR=value assignments.
const LEADING = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time']);
// Commands known to leave their arguments unrun, so a dynamic argument cannot become a command.
// Anything else (timeout, sudo, env, xargs, find, sed, awk, an unknown program) may run its
// arguments, so a dynamic argument there is refused.
const SAFE = new Set(['echo', 'printf', 'cat', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'sort', 'uniq',
  'diff', 'cmp', 'test', '[', '[[', 'stat', 'file', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'jq',
  'node', 'npm', 'pwd', 'true', 'false', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'cd', 'export', 'read', 'tee', 'date', 'sleep',
  'du', 'df', 'tree', 'which', 'type', 'wait']);
// Markers for what the guard refuses because it cannot read it.
const UNREAD = '\0unread';
const DEEP = '\0deep';

// What a simple command runs, as the rules read it (each starts with git or gh): from each `git`
// word, `git <sub> …` with git's own options dropped; from each `gh` word, `gh …` without
// -R/--repo; for each shell or `eval` word, the commands in its arguments, recursively; and a
// marker for what cannot be read before it runs.
function effective(cmd, depth) {
  const ws = parseWords(cmd);
  const out = [];
  let first = 0;
  while (first < ws.length && (LEADING.has(ws[first].text) && !ws[first].dynamic || /^[A-Za-z_]\w*=/.test(ws[first].text))) first++;
  if (first < ws.length && !ws[first].dynamic && ['for', 'select', 'case'].includes(ws[first].text)) return out;
  // Dynamic words read as arguments of a git or gh command, after its subcommand. Any other dynamic
  // word (a command name, a subcommand, an option's value, an argument of an unknown command) is
  // refused below.
  const read = new Set();
  ws.forEach(({ text, dynamic }, k) => {
    if (dynamic) return;
    const b = base(text);
    if (b === 'git') {
      let n = k + 1;
      for (; n < ws.length && ws[n].text.startsWith('-') && !ws[n].dynamic; n += GIT_ARG_OPTS.has(ws[n].text) ? 2 : 1) {
        if (ws[n].text === '-c' && /^alias\./.test(ws[n + 1]?.text ?? '')) out.push(`${UNREAD} ${cmd}`);
      }
      for (let m = n + 1; m < ws.length; m++) read.add(m);
      out.push(['git', ...ws.slice(n).map((x) => x.text)].join(' '));
    } else if (b === 'gh') {
      const rest = [];
      for (let n = k + 1; n < ws.length; n++) {
        if (ws[n].text === '-R' || ws[n].text === '--repo') n++;
        else if (!/^(?:--repo=|-R\S)/.test(ws[n].text)) rest.push(n);
      }
      const path = rest.filter((n) => !ws[n].text.startsWith('-')).slice(0, ws[rest[0]]?.text === 'api' ? 1 : 2);
      for (const n of rest) if (n > (path.at(-1) ?? k)) read.add(n);
      out.push(['gh', ...rest.map((n) => ws[n].text)].join(' '));
    } else if (SHELL.test(b) || b === 'eval') {
      const args = ws.slice(k + 1).map((x) => x.text);
      if (depth >= 5) out.push(`${DEEP} ${cmd}`);
      else if (b === 'eval') out.push(...commandsOf(args.join(' '), depth + 1));
      else if (!args.some((a) => !a.startsWith('-')) || args.includes('-s')) out.push(`${UNREAD} ${cmd}`);   // reads stdin
      else for (const x of args) out.push(...commandsOf(x, depth + 1));
    }
  });
  const unread = ws.some((w, m) => m >= first && w.dynamic && !read.has(m));
  if (unread && (ws[first]?.dynamic || !SAFE.has(base(ws[first].text)))) out.push(`${UNREAD} ${cmd}`);
  return out;
}

// Every command a command line runs: its simple commands, what they wrap, and what its command
// substitutions run, recursively; nesting deeper than that is refused, never skipped.
function commandsOf(line, depth = 0) {
  const own = simpleCommands(line).flatMap((x) => effective(x, depth));
  const subs = substitutions(line);
  if (!subs.length) return own;
  if (depth >= 5) return [...own, `${DEEP} ${line}`];
  return [...own, ...subs.flatMap((x) => commandsOf(x, depth + 1))];
}

// Why `command` is refused for `role`, or null when it is allowed.
export function refusal(command, role) {
  const rules = RULES[role];
  if (!rules) return `unknown role ${role}`;
  for (const part of commandsOf(command)) {
    if (part.startsWith(UNREAD)) return `the ${role} may not run what the guard cannot read before it runs (a variable, substitution, glob or brace where a command could stand, a shell reading stdin, or a git alias): refused \`${part.slice(UNREAD.length + 1)}\``;
    if (part.startsWith(DEEP)) return `the ${role} may not run commands nested deeper than the guard reads: refused \`${part.slice(DEEP.length + 1)}\``;
    const hit = rules.find(([test]) => (typeof test === 'function' ? test(part) : test.test(part)));
    if (hit) return `the ${role} may not run ${hit[1]}: refused \`${part}\``;
  }
  return null;
}
