// The commands a Claude agent of each role must never run, for the PreToolUse hook in its agent
// file (.claude/agents/<role>.md, through tools/harness/guard.mjs). The agent's prompt says the same;
// the hook makes it hold whatever the prompt says (#3).
//
// It reads a command line as the shell would: its simple commands at ;, &&, ||, |, newlines,
// subshells and $( ), with quotes and backslash escapes respected; it looks inside `bash -c '…'`,
// `sh -c`, `eval` and `xargs`, and past `env VAR=…`, `command`, `sudo` and the like. It is a
// safeguard against an agent's mistakes, not a sandbox: a program that makes the call itself (a
// Python script, say) is beyond it.

// A git command, after git's own -C <dir> / -c <key=value> options.
const git = (sub) => new RegExp(`^git(?:\\s+(?:-C|-c)\\s+(?:"[^"]*"|'[^']*'|\\S+))*\\s+${sub}`);

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
    [git('push\\b.*(?:\\s--force\\b|\\s--force-with-lease\\b|\\s-f\\b|\\s\\+\\S)'), 'a force-push'],
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

// One shell word with its quotes and escapes removed.
const unquote = (w) => w.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1');

// The commands a simple command runs: itself, without wrappers (env VAR=…, command, sudo, xargs and
// the like) and leading VAR=value assignments; and, for `sh -c '…'` or `eval …`, the commands inside,
// recursively.
function effective(cmd, depth = 0) {
  let c = cmd;
  for (let prev = null; prev !== c;) {
    prev = c;
    c = c.replace(/^\w+=(?:"[^"]*"|'[^']*'|\S)*\s+/, '')
      .replace(/^(?:sudo|exec|time|nohup|command|builtin|xargs|env)(?:\s+-\S+)*\s+/, '');
  }
  const inner = c.match(/^(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c\w*\s+([\s\S]+)$/) ?? c.match(/^eval\s+([\s\S]+)$/);
  if (!inner || depth > 4) return [c];
  const arg = inner[1].trim();
  const first = arg.match(/^'[^']*'|^"(?:\\.|[^"\\])*"/)?.[0] ?? arg;
  return [c, ...simpleCommands(unquote(first)).flatMap((x) => effective(x, depth + 1))];
}

// Why `command` is refused for `role`, or null when it is allowed.
export function refusal(command, role) {
  const rules = RULES[role];
  if (!rules) return `unknown role ${role}`;
  for (const part of simpleCommands(command).flatMap((x) => effective(x))) {
    const hit = rules.find(([test]) => (typeof test === 'function' ? test(part) : test.test(part)));
    if (hit) return `the ${role} may not run ${hit[1]}: refused \`${part}\``;
  }
  return null;
}
