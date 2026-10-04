// The commands a Claude agent of each role must never run, for the PreToolUse hook in its agent
// file (.claude/agents/<role>.md, through tools/harness/guard.mjs). The agent's prompt says the same;
// the hook makes it hold whatever the prompt says (#3).
//
// It reads a command line as the shell would: its simple commands at ;, &&, ||, |, newlines,
// subshells and $( ), with quotes and backslash escapes respected, and each simple command as the
// words the shell passes. A `git` or `gh` word is checked wherever it stands, so no prefix hides it
// (`timeout 10 git push`, `sudo -u root git push`, `VAR=x nice git push`: #62); every argument of a
// shell (`bash -o pipefail -c '…'`) or of `eval` is read as a command line in turn. It fails closed:
// an unquoted mention (`echo git push`) is refused too. It is a safeguard against an agent's
// mistakes, not a sandbox: a program that makes the call itself (a Python script, a git alias) is
// beyond it.

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

// The simple commands in a shell command line, split at ;, &&, ||, |, newlines, subshell parentheses,
// backquotes and $( ). Quotes and backslash escapes are respected, so `"fix; then push"` and
// `\"; git push` are read as the shell reads them.
export function simpleCommands(line) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && quote !== "'" && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') { out.push(cur); cur = ''; i++; continue; }
    if (';|\n()`&'.includes(c)) { out.push(cur); cur = ''; continue; }
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

// The words of a simple command as the shell passes them: quotes removed, escapes resolved,
// adjacent quoted parts joined (`pu''sh` is `push`), a backslash-newline dropped (#62).
export function words(cmd) {
  const out = [];
  let w = null;
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] !== '\n') w = (w ?? '') + (s[i + 1] ?? '');
      i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      w = (w ?? '') + s.slice(i + 1, j < 0 ? s.length : j);
      i = j < 0 ? s.length : j;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && '"\\$`\n'.includes(s[j + 1])) { if (s[j + 1] !== '\n') v += s[j + 1]; j++; } else v += s[j];
      }
      w = (w ?? '') + v;
      i = j;
    } else if (/\s/.test(c)) {
      if (w !== null) out.push(w);
      w = null;
    } else w = (w ?? '') + c;
  }
  if (w !== null) out.push(w);
  return out;
}

// git's own options before its subcommand, those that take an argument (Luna's R1, round 2).
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const SHELL = /^(?:ba|z|da|k)?sh$/;
const base = (w) => w.replace(/^.*\//, '');

// What a simple command runs, as the rules read it (each starts with git or gh): from each `git`
// word, `git <sub> …` with git's own options dropped; from each `gh` word, `gh …` without
// -R/--repo; and for each shell or `eval` word, the commands in its arguments, recursively.
function effective(cmd, depth) {
  const ws = words(cmd);
  const out = [];
  ws.forEach((w, k) => {
    const b = base(w);
    if (b === 'git') {
      let n = k + 1;
      while (n < ws.length && ws[n].startsWith('-')) n += GIT_ARG_OPTS.has(ws[n]) ? 2 : 1;
      out.push(['git', ...ws.slice(n)].join(' '));
    } else if (b === 'gh') {
      const rest = [];
      for (let n = k + 1; n < ws.length; n++) {
        if (ws[n] === '-R' || ws[n] === '--repo') n++;
        else if (!/^(?:--repo=|-R\S)/.test(ws[n])) rest.push(ws[n]);
      }
      out.push(['gh', ...rest].join(' '));
    } else if ((SHELL.test(b) || b === 'eval') && depth < 5) {
      const args = ws.slice(k + 1);
      for (const x of b === 'eval' ? [args.join(' ')] : args) out.push(...commandsOf(x, depth + 1));
    }
  });
  return out;
}

// Every command a command line runs: its simple commands, what they wrap, and what its command
// substitutions run, recursively.
function commandsOf(line, depth = 0) {
  const own = simpleCommands(line).flatMap((x) => effective(x, depth));
  if (depth > 4) return own;
  return [...own, ...substitutions(line).flatMap((x) => commandsOf(x, depth + 1)),
    ...own.flatMap((x) => (x === line ? [] : substitutions(x).flatMap((y) => commandsOf(y, depth + 1))))];
}

// Why `command` is refused for `role`, or null when it is allowed.
export function refusal(command, role) {
  const rules = RULES[role];
  if (!rules) return `unknown role ${role}`;
  for (const part of commandsOf(command)) {
    const hit = rules.find(([test]) => (typeof test === 'function' ? test(part) : test.test(part)));
    if (hit) return `the ${role} may not run ${hit[1]}: refused \`${part}\``;
  }
  return null;
}
