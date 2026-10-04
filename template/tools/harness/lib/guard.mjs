// The commands a Claude agent of each role must never run, for the PreToolUse hook in its agent
// file (.claude/agents/<role>.md, through tools/harness/guard.mjs). The agent's prompt says the same;
// the hook makes it hold whatever the prompt says (#3).
//
// It does not model all of Bash: it reads a strict subset exactly and refuses everything outside it
// (Sol's rework on PR 66, rounds 1 and 2; L38: each round of modelling found another corner).
//
// Read: simple commands split at ;, &&, ||, |, &, newlines and subshell parentheses; words in plain
// text, '…', "…" (with \" \\ \$ \` escapes), $"…" read as "…", $'…' only without a backslash, and a
// backslash before a printable character or a newline; redirections as operators with a target.
// A `git` or `gh` command is checked against the rules wherever it stands (#62). A shell is read
// only as `sh -c '<string>'`, its string checked in turn, or as `sh <script file>`; `eval` has its
// arguments checked; an assignment before a command has its value checked (GIT_PAGER='…' git log).
// A command in SAFE never runs its arguments, so they are not read (`echo git push` is allowed). Any
// other program may run its arguments, so each one with a space is checked as a command line
// (`watch 'git push'`, `trap '…' EXIT`), and a git, gh or shell among them is checked as a command.
//
// Refused as unreadable: a control character; $'…' with an escape; a shell with any other option,
// or with no script (it would read stdin), or reading a script from /dev or /proc; process
// substitution; git's -c, --config-env and --exec-path (they can make git run a program); git or
// gh run by another program (it may add to their arguments: `xargs -I{} git {}`); a word only known
// at run time (a variable, substitution, glob or brace expansion) anywhere but as an argument of
// git or gh after the subcommand, or of a SAFE command; and nesting past five levels.
//
// It is a safeguard against an agent's mistakes, not a sandbox: a script file, or a program that
// makes the call itself (node -e, awk's system()), is beyond it.

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
    [/^gh\s+api\s+graphql\b.*merge/i, 'a merge through the GraphQL API'], [/^gh\s+alias\b/, 'gh alias (an alias can run gh pr merge)'],
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

// The line with its quoted parts and escaped characters blanked, for a check of what is unquoted.
function unquoted(line) {
  let out = '';
  let quote = null;
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && quote !== "'") { out += '  '; i++; continue; }
    if (quote) { out += ' '; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; out += ' '; continue; }
    out += c;
  }
  return out;
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

// A `$` that starts an expansion: $name, ${…}, $(…), $((…)), or a special parameter.
const expands = (s, i) => s[i] === '$' && /[\w{(@*#?!$-]/.test(s[i + 1] ?? '');

// The words of a simple command as the shell passes them, each with whether the shell only knows
// it at run time (`dynamic`: a variable, substitution, glob or brace expansion in it). Quotes are
// removed, escapes resolved, adjacent quoted parts joined (`pu''sh` is `push`), and a
// backslash-newline dropped (#62). `out.unreadable` is set for $'…' with an escape, which the guard
// does not decode (Sol's R1, round 2).
function parseWords(cmd) {
  const out = [];
  out.unreadable = false;
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
      const j = ansiEnd(s, i);
      const v = s.slice(i + 2, j);
      if (v.includes('\\')) out.unreadable = true;
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
    else if (c === '<' || c === '>') {
      const fd = w !== null && /^\d+$/.test(w) && !dyn ? w : '';
      if (!fd) end(); else { w = null; dyn = false; }
      const op = s.slice(i).match(/^[<>&]+/)[0];
      out.push({ text: fd + op, dynamic: false, op: true });
      i += op.length - 1;
    } else {
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
// Words that come before a command without being one: shell keywords (VAR=value assignments too).
const LEADING = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time']);
// Commands that never run a program named in their arguments, so neither a dynamic argument nor a
// `git` word among them can become a command. Anything else (timeout, sudo, env, xargs, find, sed,
// awk, watch, npm exec, rg --pre, sort --compress-program, node, an unknown program) may run one,
// so its arguments are read as commands and command lines, and a dynamic one is refused.
const SAFE = new Set(['echo', 'printf', 'cat', 'ls', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'wc', 'uniq', 'diff', 'cmp',
  'test', '[', '[[', 'stat', 'file', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'pwd', 'true',
  'false', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'cd', 'export', 'read', 'tee', 'date', 'sleep', 'du', 'df', 'tree', 'which',
  'type', 'wait']);
// Markers for what the guard refuses because it cannot read it.
const UNREAD = '\0unread';
const DEEP = '\0deep';
// A script file a shell or `source` may read: a plain path, never a device or a process's file.
const scriptFile = (w) => w && !w.dynamic && !w.op && /^[\w./][\w./-]*$/.test(w.text) && !/^\/(?:dev|proc)\//.test(w.text);

// What a simple command runs, as the rules read it (each starts with git or gh), with a marker for
// what cannot be read before it runs.
function effective(cmd, depth) {
  const ws = parseWords(cmd);
  if (ws.unreadable) return [`${UNREAD} ${cmd}`];
  // Redirections: an operator and its target are not arguments (a shell left with no script reads
  // its stdin, and is refused).
  const plain = [];
  for (let k = 0; k < ws.length; k++) { if (ws[k].op) k++; else plain.push(ws[k]); }
  let first = 0;
  while (first < plain.length && (!plain[first].dynamic && LEADING.has(plain[first].text) || /^[A-Za-z_]\w*=/.test(plain[first].text))) first++;
  if (first === plain.length) return [];                          // assignments alone run nothing
  // An assignment before a command can set what a program runs (GIT_PAGER='git push' git log):
  // its value is read as a command line, and a dynamic one is refused.
  const out = plain.slice(0, first).filter((w) => /^[A-Za-z_]\w*=/.test(w.text))
    .flatMap((w) => (w.dynamic ? [`${UNREAD} ${cmd}`] : commandsOf(w.text.replace(/^[^=]*=/, ''), depth + 1)));
  return [...out, ...run(plain.slice(first), depth, cmd)];
}

// What running ws[0] with the rest as its arguments may run.
function run(ws, depth, cmd) {
  const unread = `${UNREAD} ${cmd}`;
  const [head, ...args] = ws;
  if (head.dynamic) return [unread];
  const name = base(head.text);
  if (['for', 'select', 'case'].includes(head.text) || SAFE.has(name)) return [];
  if (name === 'git') return gitParts(args, unread);
  if (name === 'gh') return ghParts(args, unread);
  if (depth >= 5 && (SHELL.test(name) || name === 'eval')) return [`${DEEP} ${cmd}`];
  if (SHELL.test(name)) {
    // Only `sh -c '<string>'` (the string read in turn) and `sh <script file>`; any other option,
    // or commands from stdin, is refused (Sol's R2, round 2).
    if (args[0] && !args[0].dynamic && args[0].text === '-c' && args[1] && !args[1].dynamic) return commandsOf(args[1].text, depth + 1);
    return scriptFile(args[0]) ? [] : [unread];
  }
  if (name === 'eval') return commandsOf(args.map((a) => a.text).join(' '), depth + 1);
  if (name === '.' || name === 'source') return scriptFile(args[0]) ? [] : [unread];
  // Any other program may run its arguments: as a program (`xargs git`, `timeout 5 git push`) or as a
  // command line (`watch 'git push'`, `trap 'git push' EXIT`). A git or gh run that way is refused,
  // since the program may add to its arguments (`xargs -I{} git {}`).
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.dynamic) { out.push(unread); continue; }
    const b = base(a.text);
    if (b === 'git' || b === 'gh' || SHELL.test(b) || ['eval', '.', 'source'].includes(b)) {
      out.push(...run(args.slice(k), depth, cmd));
      if (b === 'git' || b === 'gh') out.push(unread);
      break;
    }
    if (/\s/.test(a.text)) out.push(...(depth >= 5 ? [`${DEEP} ${cmd}`] : commandsOf(a.text, depth + 1)));
  }
  return out;
}

// A git command as the rules read it: `git <sub> …`, git's own options dropped. A config override or
// exec path (-c, --config-env, --exec-path) can make git run a program (an alias, core.pager,
// core.sshCommand) and is refused, as is a dynamic option, option value or subcommand.
function gitParts(args, unread) {
  const out = [];
  let n = 0;
  for (; n < args.length && args[n].text.startsWith('-') && !args[n].dynamic; n += GIT_ARG_OPTS.has(args[n].text) ? 2 : 1) {
    if (/^(?:-c|--config-env|--exec-path)(?:=|$)/.test(args[n].text)) out.push(unread);
  }
  if (args.slice(0, n + 1).some((a) => a.dynamic)) out.push(unread);
  out.push(['git', ...args.slice(n).map((a) => a.text)].join(' '));
  return out;
}

// A gh command as the rules read it, without -R/--repo; a dynamic word before its arguments is refused.
function ghParts(args, unread) {
  const rest = args.filter((a, k) => !(a.text === '-R' || a.text === '--repo' || /^(?:--repo=|-R\S)/.test(a.text)
    || (k > 0 && (args[k - 1].text === '-R' || args[k - 1].text === '--repo'))));
  const path = rest.filter((a) => !a.text.startsWith('-')).slice(0, rest[0]?.text === 'api' ? 1 : 2);
  const last = rest.indexOf(path.at(-1));
  const out = rest.slice(0, last + 1).some((a) => a.dynamic) || !path.length && rest.some((a) => a.dynamic) ? [unread] : [];
  return [...out, ['gh', ...rest.map((a) => a.text)].join(' ')];
}

// Every command a command line runs: its simple commands, what they wrap, and what its command
// substitutions run, recursively; nesting deeper than that is refused, never skipped.
function commandsOf(line, depth = 0) {
  if (/[<>]\(/.test(unquoted(line))) return [`${UNREAD} ${line}`];         // process substitution
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
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(String(command))) return `the ${role} may not run a command line with a control character in it`;
  for (const part of commandsOf(command)) {
    if (part.startsWith(UNREAD)) return `the ${role} may not run what the guard cannot read before it runs (a variable, substitution, glob or brace where a command could stand, $'…' with an escape, a shell with options or reading stdin, or a git alias): refused \`${part.slice(UNREAD.length + 1)}\``;
    if (part.startsWith(DEEP)) return `the ${role} may not run commands nested deeper than the guard reads: refused \`${part.slice(DEEP.length + 1)}\``;
    const hit = rules.find(([test]) => (typeof test === 'function' ? test(part) : test.test(part)));
    if (hit) return `the ${role} may not run ${hit[1]}: refused \`${part}\``;
  }
  return null;
}
