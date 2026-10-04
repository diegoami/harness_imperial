// The Claude agents' PreToolUse guard (tools/harness/guard.mjs, lib/guard.mjs), and the agent files
// that declare it (#3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusal, simpleCommands, words } from '../template/tools/harness/lib/guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../template');

const REFUSED = {
  reviewer: ['git commit -m x', 'git -C /w commit -am x', 'npm test && git push origin HEAD', 'gh pr comment 7 --body x',
    'gh pr merge 7', 'gh pr edit 7 --add-label x', 'gh issue edit 3 --add-label status:approved', 'echo ok; gh pr review 7 --approve',
    'GH_TOKEN=x gh issue comment 3 -b y', '(git push)',
    // Luna's R1 and R2 on PR 29: an escaped quote, a nested shell, a gh api write.
    'echo \\"; git push origin HEAD', "bash -c 'git push origin HEAD'", 'sh -c "npm test && git commit -m x"',
    'eval git push', 'env FOO=1 git push', 'xargs git push', 'git push & wait',
    'gh api -X DELETE repos/o/r/issues/3', 'gh api --method=POST repos/o/r/issues', 'gh api repos/o/r/issues/3/comments -f body=x',
    'gh pr ready 7', 'gh label create x', 'gh repo delete o/r',
    // Luna's R1, round 2: a substitution inside double quotes, git options before the subcommand.
    'echo "$(git push origin HEAD)"', 'echo "x `git push` y"', 'echo "$(echo "$(git commit -m x)")"',
    'git --no-pager push origin HEAD', 'git --git-dir=.git push', 'git --git-dir .git -p commit -m x',
    // #62 (GLM-5.3 on PR 29's final head): a prefix the guard did not know, shell options, quoting.
    "bash -o pipefail -c 'git push origin HEAD'", "bash -euo pipefail -c 'git commit -m x'", 'sh -o errexit -c "git push"',
    'sudo -u root git push', 'env -u X git push', 'timeout 10 git push origin HEAD', 'nice git push', 'stdbuf -o0 git push',
    'git "push"', "'git' push", `bash -c "git 'push'"`, "git pu''sh", 'git \\push', 'git \\\npush origin HEAD', 'eval "git push"',
    'git -C "a b" push', 'find . -exec git push \\;', 'xargs -I{} git commit -m x', 'time git push', '/usr/bin/git push',
    'gh issue delete 3', 'gh pr reopen 7', 'gh --repo o/r pr comment 7 -b x', 'gh pr -R o/r comment 7 -b x',
    'sudo -u root -- git commit -m x', 'nice -n 5 git commit -am x', 'timeout --signal=KILL 5 git push', 'bash -lc "git push"'],
  implementer: ['git stash', 'git stash list', 'echo $(git stash pop)', 'git worktree add ../x', 'git push --force',
    'git push -f origin b', 'git push --force-with-lease', 'git push origin +b', 'gh pr merge 7 --squash',
    'bash -c "git stash"', 'gh api -X PUT repos/o/r/pulls/7/merge', 'git --no-pager stash', 'echo "$(git worktree list)"',
    'gh --repo o/r pr merge 7', 'gh pr -R o/r merge 7', 'git push -fq origin main', 'git push -qf origin main', 'timeout 5 git stash',
    'nice git worktree add x', 'sudo -u me gh pr merge 7'],
};
const ALLOWED = {
  reviewer: ['git log --oneline | head', 'git diff --name-only origin/main...HEAD', 'gh pr view 7 --json body',
    'git checkout -- src/a.js', 'git fetch origin pull/7/head', 'npm test', 'grep -rn "git push" docs', 'echo "gh pr merge is not for you"',
    'gh pr diff 7', 'gh pr checks 7', 'gh issue view 3 --comments', 'gh api repos/o/r/pulls/7', 'gh api -X GET repos/o/r/pulls',
    'gh run view 123 --log-failed', 'npm test 2>&1 | tail -5', "bash -c 'npm test'",
    "echo '$(git push)'", 'echo "$(git log -1)"', 'git --no-pager log -3',
    'git log --grep push', 'ls /usr/bin/git', 'git -C "a b" log', 'npm test -- --grep "git push"', 'cat .git/HEAD',
    'git show HEAD:git/push.txt', 'gh -R o/r pr view 7', 'gh pr view 7 -R o/r', 'timeout 60 npm test', 'sh scripts/check.sh'],
  implementer: ['git commit -m "fix; then git stash nothing"', 'git push origin task/T07-x', 'git push -u origin task/T07-x',
    'gh pr create --title t --body-file b.md', 'git checkout --detach', 'npm test', 'gh pr view 7',
    'git push --set-upstream origin x'],
};

for (const role of ['reviewer', 'implementer']) {
  test(`the ${role} guard refuses what the role may not run, in any part of a command line`, () => {
    for (const c of REFUSED[role]) assert.match(refusal(c, role) ?? 'allowed', new RegExp(`^the ${role} may not run`), c);
  });
  test(`the ${role} guard allows the rest, quoted mentions included`, () => {
    for (const c of ALLOWED[role]) assert.equal(refusal(c, role), null, c);
  });
}

test('words reads a simple command as the shell passes it: quotes off, escapes resolved, quoted parts joined (#62)', () => {
  assert.deepEqual(words(`git pu''sh "a b" 'c d' e\\ f \\g`), ['git', 'push', 'a b', 'c d', 'e f', 'g']);
  assert.deepEqual(words('git \\\npush'), ['git', 'push']);                        // a backslash-newline joins the line
  assert.deepEqual(words(`echo "x \\"y\\" $z" ''`), ['echo', 'x "y" $z', '']);
});

test('simpleCommands splits at ; && || | ( ) $( ) and newlines, but not inside quotes', () => {
  assert.deepEqual(simpleCommands('a && b || c; d | e\nf $(g) "h; i" (j)'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', '"h; i"', 'j']);
  assert.deepEqual(simpleCommands('echo \\"; git push'), ['echo \\"', 'git push']);          // an escaped quote opens nothing
});

// The hook itself, fed PreToolUse JSON on stdin as Claude Code does.
const hook = (role, event) => spawnSync(process.execPath, [path.join(root, 'tools/harness/guard.mjs'), role],
  { input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8' });
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/w' });

test('the hook blocks a refused command with exit 2 and the reason on stderr; allows the rest with exit 0', () => {
  const blocked = hook('reviewer', bash('git push origin HEAD'));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /the reviewer may not run git push/);
  assert.equal(hook('reviewer', bash('git log --oneline')).status, 0);
  assert.equal(hook('implementer', bash('git stash')).status, 2);
  assert.equal(hook('implementer', bash('git push origin task/T07-x')).status, 0);
  assert.equal(hook('reviewer', { tool_name: 'Read', tool_input: { file_path: 'a' } }).status, 0);
});

test('the hook refuses what it cannot read, rather than fail open', () => {
  const r = hook('reviewer', 'not json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not JSON/);
  // Luna's R2, round 2: a Bash call without a command string.
  for (const tool_input of [{}, null, { command: 42 }]) {
    const b = hook('reviewer', { tool_name: 'Bash', tool_input });
    assert.equal(b.status, 2, JSON.stringify(tool_input));
    assert.match(b.stderr, /no command string/);
  }
});

// The agent files: the hook declared for the right role, the reviewer without editing tools, and
// the briefs' fixed parts equal to process.md's, so the two never drift apart.
// Line endings are normalised: a Windows checkout has CRLF (the test failed there without this).
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const agent = (name) => read(path.join(root, '.claude/agents', `${name}.md`));
const front = (text) => text.split(/^---$/m)[1];
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const processBlock = (n) => read(path.join(root, 'docs/process.md'))
  .match(new RegExp(`## ${n}\\..*?\`\`\`text\\n([\\s\\S]*?)\`\`\``, 's'))[1];

test('each agent file declares the guard for its own role on Bash', () => {
  for (const role of ['reviewer', 'implementer']) {
    const f = front(agent(role));
    assert.match(f, new RegExp(`^name: ${role}$`, 'm'));
    assert.match(f, /PreToolUse:\s*\n\s*- matcher: "Bash"\s*\n\s*hooks:\s*\n\s*- type: command\s*\n\s*command: '.*tools\/harness\/guard\.mjs" (\w+)'/);
    assert.equal(f.match(/guard\.mjs" (\w+)'/)[1], role);
  }
  assert.match(front(agent('reviewer')), /^tools: Read, Grep, Glob, Bash$/m);
  assert.match(front(agent('reviewer')), /^model: opus$/m);
  assert.match(front(agent('implementer')), /^model: sonnet$/m);
});

test('the agent files carry process.md\'s brief blocks word for word', () => {
  assert.ok(flat(agent('implementer')).includes(flat(processBlock(4))), 'implementer.md lacks process.md §4\'s block');
  const fixed5 = processBlock(5).split('\n').slice(2).join('\n');
  assert.ok(flat(agent('reviewer')).includes(flat(fixed5)), 'reviewer.md lacks process.md §5\'s block');
});
