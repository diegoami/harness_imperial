// The commands a Claude agent of each role must never run, for the PreToolUse hook in its agent
// file (.claude/agents/<role>.md, through tools/harness/guard.mjs). The agent's prompt says the same;
// the hook makes it hold whatever the prompt says (#3).

// A git command, after any leading VAR=value and git's own -C <dir> / -c <key=value> options.
const git = (sub) => new RegExp(`^(?:\\w+=\\S*\\s+)*git(?:\\s+(?:-C|-c)\\s+(?:"[^"]*"|'[^']*'|\\S+))*\\s+${sub}`);
const gh = (sub) => new RegExp(`^(?:\\w+=\\S*\\s+)*gh\\s+${sub}`);

export const RULES = {
  // Read-only: the reviewer returns its review, and post-review.mjs posts it.
  reviewer: [
    [git('commit\\b'), 'git commit'], [git('push\\b'), 'git push'],
    [gh('pr\\s+(?:comment|merge|edit|review|close|create)\\b'), 'gh pr comment/merge/edit/review/close/create'],
    [gh('issue\\s+(?:edit|comment|close|create)\\b'), 'gh issue edit/comment/close/create'],
  ],
  // The Claude fallback implementer: one branch, one PR, never shared state.
  implementer: [
    [git('stash\\b'), 'git stash (shared by every worktree, L19)'], [git('worktree\\b'), 'git worktree'],
    [git('push\\b.*(?:\\s--force\\b|\\s--force-with-lease\\b|\\s-f\\b|\\s\\+\\S)'), 'a force-push'],
    [gh('pr\\s+merge\\b'), 'gh pr merge'],
  ],
};

// The simple commands in a shell command line: split at ;, &&, ||, |, newlines, subshell
// parentheses and $( … ). Quotes are respected, so a message such as "fix; then push" stays whole.
export function simpleCommands(line) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') { out.push(cur); cur = ''; i++; continue; }
    if (';|\n()`'.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim().replace(/^(?:sudo|exec|time|nohup|command|builtin)\s+/, '')).filter(Boolean);
}

// Why `command` is refused for `role`, or null when it is allowed.
export function refusal(command, role) {
  const rules = RULES[role];
  if (!rules) return `unknown role ${role}`;
  for (const part of simpleCommands(command)) {
    const hit = rules.find(([re]) => re.test(part));
    if (hit) return `the ${role} may not run ${hit[1]}: refused \`${part}\``;
  }
  return null;
}
