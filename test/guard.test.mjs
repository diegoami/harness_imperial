// The Claude agents' PreToolUse guard (tools/harness/guard.mjs, lib/guard.mjs), and the agent files
// that declare it (#3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusal, simpleCommands, words } from '../template/tools/harness/lib/guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../template');

// Six bash -c levels around a git push, each quoted for the next: past the guard's depth.
let NESTED = 'git push';
for (let i = 0; i < 6; i++) NESTED = `bash -c '${NESTED.replace(/'/g, "'\\''")}'`;

const REFUSED = {
  reviewer: ['git commit -m x', 'git -C /w commit -am x', 'npm test && git push origin HEAD', 'gh pr comment 7 --body x',
    'gh pr merge 7', 'gh pr edit 7 --add-label x', 'gh issue edit 3 --add-label status:approved', 'echo ok; gh pr review 7 --approve',
    'GH_TOKEN=x gh issue comment 3 -b y', '(git push)',
    // Luna's R1 and R2 on PR 29: an escaped quote, a nested shell, a gh api write.
    'echo \\"; git push origin HEAD', "bash -c 'git push origin HEAD'", 'sh -c "npm test && git commit -m x"',
    'eval git push', 'env FOO=1 git push', 'xargs git push', 'git push & wait',
    'gh api -X DELETE repos/o/r/issues/3', 'gh api --method=POST repos/o/r/issues', 'gh api repos/o/r/issues/3/comments -f body=x',
    // #79 (Luna on goal2-archaeology PR 39): a method that is not literally GET.
    'gh api --method="$METHOD" repos/o/r/issues/1/comments', 'gh api -X $(printf POST) repos/o/r/issues', 'gh api -XPOST repos/o/r/issues',
    'gh api repos/o/r/issues -X',
    // Sol's R1-R3 on PR 92: a method in a short cluster, a field with its value attached, an option
    // that a variable supplies; and the forms gh's flag parser accepts.
    'gh api repos/o/r -iXPOST', 'gh api repos/o/r -fbody=x', 'gh api repos/o/r -Fbody=x', 'FLAGS=-XPOST; gh api repos/o/r "$FLAGS"',
    'FLAGS=--input=package.json; gh api repos/o/r "$FLAGS"', 'gh api repos/o/r --raw-field=a=b', 'gh api repos/o/r --input body.json',
    'gh api "$EP"', 'gh api repos/o/r --$OPT=1',
    // Sol's R1-R3 on PR 92, round 2: an unquoted expansion that splits into an option, in an
    // endpoint or in a value; -R's value shifting what an option consumes; -R before api.
    'VALUE="r -XPOST"; gh api repos/$VALUE', 'VALUE="x -XPOST"; gh api repos/o/r -H X-Test:$VALUE',
    'gh api repos/o/r -q -Rfoo -X POST', 'gh api -R o/r repos/x -X POST', 'gh -R o/r api repos/x -X POST',
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
    'sudo -u root -- git commit -m x', 'nice -n 5 git commit -am x', 'timeout --signal=KILL 5 git push', 'bash -lc "git push"',
    // Sol's R1 and R2 on PR 66: ANSI-C quoting, and nesting past what the guard reads; then the class,
    // what the guard cannot read before the shell runs it.
    "git $'push'", "git $'\\x70ush'", "git $'\\160ush'", "$'git' push", 'git $"push"', NESTED,
    'echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(git push)")")")")")")"',
    'g=git; $g push', 'timeout 1 $g push', 'git $s', 'git ${s}', 'git -C $d push', 'gi* push', 'g?t push', '{git,push}',
    '$(echo git) push', '`echo git` push', '"$(echo git)" push', 'sudo $cmd', 'xargs $x < f',
    "echo 'git push' | sh", "printf 'git push' | bash -s", 'git -c alias.p=push p',
    // Sol's R1 and R2, round 2: a NUL escape in $'…', a shell option's value taken for a script. The
    // strict subset refuses every $'…' with an escape and every shell form but -c and a script.
    "git$'\\0x' push", "echo 'git push' | bash -o pipefail", "bash -lc 'git push'", "bash -e -c 'git push'",
    "sh -x -c 'git push'", 'timeout 5 bash', "echo 'git push' | bash -", 'git\u0000 push', 'git\x01 push',
    'npm exec -- git push', 'npm exec $x', "bash -oc pipefail 'git push'",
    // The sweep after round 2 (L38): a program that runs a command string, a variable that sets
    // what git runs, a git config override, git through xargs, stdin from a here-string, a here-doc
    // or a process substitution, a script read from a device.
    "watch 'git push'", "flock /tmp/l -c 'git push'", "trap 'git push' EXIT", "GIT_PAGER='git push' git log",
    "PAGER=$p git log", "git -c core.pager='git push' log", 'git --config-env=core.pager=P log', 'echo push | xargs git',
    'xargs -I{} git {} < cmds', "bash <<< 'git push'", "bash <<'EOF'", ". <(echo git push)", 'bash <(echo git push)',
    "echo 'git push' | bash /dev/stdin", "echo 'git push' | source /dev/stdin", 'npm test -- --grep "git push"',
    "bash<<<'git push'", `awk -f <(echo 'BEGIN{system("git push")}') /dev/null`,
    // Sol's R1, round 3: another spelling of a device; and a script that does not exist yet.
    "echo 'git push' | bash //dev/stdin", "echo 'git push' | source //dev/stdin", "echo 'git push' | bash /./dev/stdin",
    "echo 'git push' | bash /dev/fd/0", "printf 'git push' > s.sh; bash s.sh", 'sh scripts/no-such-script.sh',
    // Sol's R1, round 4: a quote inside a comment; then the class, places where separate scanners
    // read a line differently from bash (each checked against bash with a mock git).
    "echo # '\ngit push\n# '", 'echo $(echo ")"; git push)', 'echo "$(echo ")"; git push; echo "(")"', 'echo `echo #` ; git push',
    'echo $(true)#x; git push', "cat <<EOF\nhello it's me\nEOF\ngit push", 'cat <<EOF\n$(git push)\nEOF',
    'x=$(echo a b) && git push', "echo $(echo '(' ; git push)", 'echo $(case x in a) echo;; esac); git push',
    "echo 'unclosed", 'echo "unclosed', 'echo $(unclosed', 'cat <<EOF\nno end',
    "(true)#'\ngit push\n#'", 'echo $(case x in a) echo ok;; esac)',   // after a subshell, # is a comment
    // Sol's R1, round 5: an unquoted here-document joins a line ending in \ before it looks for the end.
    'cat <<EOF\nEO\\\nF\ngit push\nEOF', 'cat <<E"OF"\nx\nEOF\ngit push\nE'],
  implementer: ['git stash', 'git stash list', 'echo $(git stash pop)', 'git worktree add ../x', 'git push --force',
    'git push -f origin b', 'git push --force-with-lease', 'git push origin +b', 'gh pr merge 7 --squash',
    'bash -c "git stash"', 'gh api -X PUT repos/o/r/pulls/7/merge', 'git --no-pager stash', 'echo "$(git worktree list)"',
    'gh --repo o/r pr merge 7', 'gh pr -R o/r merge 7', 'git push -fq origin main', 'git push -qf origin main', 'timeout 5 git stash',
    'nice git worktree add x', 'sudo -u me gh pr merge 7', "gh alias set m 'pr merge'",
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'"],
};
const ALLOWED = {
  reviewer: ['git log --oneline | head', 'git diff --name-only origin/main...HEAD', 'gh pr view 7 --json body',
    'git checkout -- src/a.js', 'git fetch origin pull/7/head', 'npm test', 'grep -rn "git push" docs', 'echo "gh pr merge is not for you"',
    'gh pr diff 7', 'gh pr checks 7', 'gh issue view 3 --comments', 'gh api repos/o/r/pulls/7', 'gh api -X GET repos/o/r/pulls', 'gh api -XGET repos/o/r', 'gh api --method=get repos/o/r', 'gh api -X "GET" repos/o/r',
    // Sol's R4 on PR 92: an option's value is a value, never read as an option.
    'gh api repos/o/r -H "X-Test: -XPOST"', 'gh api repos/o/r -X GET -H "X-Test: --method=POST"', 'gh api -q ".[] | -XPOST" repos/o/r',
    'gh api repos/o/r/pulls --jq .x --paginate', 'gh api -R o/r repos/x',
    // Sol's R4-R5 on PR 92, round 2: after --, a word is the endpoint; a header may say (writes).
    'gh api -- -XPOST', 'gh api repos/o/r -H "X-Test: (writes)"',
    'gh run view 123 --log-failed', 'npm test 2>&1 | tail -5', "bash -c 'npm test'",
    "echo '$(git push)'", 'echo "$(git log -1)"', 'git --no-pager log -3',
    'git log --grep push', 'ls /usr/bin/git', 'git -C "a b" log', 'cat .git/HEAD',
    'git show HEAD:git/push.txt', 'gh -R o/r pr view 7', 'gh pr view 7 -R o/r', 'timeout 60 npm test',
    // What the guard reads although the shell expands it: arguments of a command that runs none.
    'echo $HOME', 'ls test/*.mjs', 'for f in test/*.mjs; do echo "$f"; done', '[ -f "$f" ] && echo y',
    'cd "$dir" && npm test', 'git log --format="%H $x"', 'gh pr view $n --json body', 'gh api "repos/o/r/pulls?per_page=5"',
    'cat $(ls docs/*.md)', 'export X=$(pwd)', 'git diff $base...HEAD', 'if [ -n "$x" ]; then echo y; fi',
    'while read l; do echo "$l"; done < f.txt', "printf '%s' $'plain'",
    // A SAFE command's arguments are never run: a mention of git or a shell there is allowed.
    'echo git push', 'which bash', 'ls /bin/sh', 'grep -rn sh docs', 'echo "use bash -c"', 'cat git push.txt',
    // Comments and here-documents, read as bash reads them.
    '# run the tests\nnpm test', 'npm test # quick', "echo 'a # b'", 'echo "#x"', 'echo a#b', 'git log --oneline # recent',
    "cat <<'EOF' > notes.md\nit's fine; git push is mentioned\nEOF", "cat <<EOF\nplain text, it's ok\nEOF",
    "cat <<'EOF'\n$(git push)\nEOF", "cat <<-EOF\n\tindented\n\tEOF", "grep -n '#' src/a.js",
    'echo $(echo ")")', "echo $(echo ')')", 'echo "$(echo ")")"', "echo $(echo hi # it's a comment\n)",
    "cat <<'EOF'\nEO\\\nF\nEOF"],                                 // a quoted here-document joins no lines
  implementer: ['git commit -m "fix; then git stash nothing"', 'git push origin task/T07-x', 'git push -u origin task/T07-x',
    'gh pr create --title t --body-file b.md', 'git checkout --detach', 'npm test', 'gh pr view 7',
    'gh pr create --title "Fix: git push docs" --body x', 'git commit -m "mention: gh pr merge"',
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
  assert.deepEqual(words(`git $'push' $"a b"`), ['git', 'push', 'a b']);         // $'…' without an escape reads as '…'
});

test('simpleCommands splits at ; && || | ( ) and newlines, but not inside quotes or a substitution', () => {
  assert.deepEqual(simpleCommands('a && b || c; d | e\nf $(g; h) "h; i" (j) `k; l` m'), ['a', 'b', 'c', 'd', 'e', 'f $(g; h) "h; i"', 'j', '`k; l` m']);
  assert.deepEqual(simpleCommands('echo \\"; git push'), ['echo \\"', 'git push']);          // an escaped quote opens nothing
});

// The hook itself, fed PreToolUse JSON on stdin as Claude Code does.
const hook = (role, event, env = {}) => spawnSync(process.execPath, [path.join(root, 'tools/harness/guard.mjs'), role],
  { input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8',
    env: { ...process.env, HARNESS_BWRAP: path.join(here, 'fake-bwrap.sh'), ...env } });
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

// A project directory whose harness.json turns the jail on, or leaves it off.
const projectDir = (enabled) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-project-'));
  fs.writeFileSync(path.join(d, 'harness.json'), JSON.stringify({ jail: { enabled } }));
  return d;
};

test('the hook leaves a reviewer\'s command as typed, and says nothing, unless harness.json enables the jail', () => {
  for (const env of [{ CLAUDE_PROJECT_DIR: projectDir(false) }, { CLAUDE_PROJECT_DIR: '' }]) {
    const r = hook('reviewer', bash('git log'), env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('the hook runs a reviewer\'s allowed command in the credential jail, and warns where there is none (#68)', { skip: process.platform !== 'linux' }, () => {
  const out = (r) => (r.stdout ? JSON.parse(r.stdout) : null);
  const command = `echo "it's" 'ok'`;
  const on = { CLAUDE_PROJECT_DIR: projectDir(true) };
  const r = hook('reviewer', bash(command), on);
  assert.equal(r.status, 0, r.stderr);
  const updated = out(r).hookSpecificOutput;
  assert.equal(updated.hookEventName, 'PreToolUse');
  assert.equal(updated.updatedInput.command.split(' ')[0], `'${path.join(here, 'fake-bwrap.sh')}'`);
  assert.match(updated.updatedInput.command, / '--unshare-pid' .* '--' 'bash' '-c' /);
  assert.equal(spawnSync('sh', ['-c', updated.updatedInput.command], { encoding: 'utf8' }).stdout, "it's ok\n");
  assert.equal(hook('implementer', bash(command), on).stdout, '');                      // the implementer pushes
  assert.equal(hook('reviewer', bash('git push origin HEAD'), on).stdout, '');           // refused, not rewritten
  for (const bwrap of ['/nonexistent/bwrap', '/bin/false']) {                        // missing, or does not run
    const off = hook('reviewer', bash(command), { ...on, HARNESS_BWRAP: bwrap });
    assert.equal(off.status, 0);
    assert.match(out(off).systemMessage, /^WARNING: the reviewer's credential jail is off/);
    assert.equal(out(off).hookSpecificOutput, undefined);
  }
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

test('the hook refuses a reviewer\'s Read, Grep or Glob where credentials are kept, and nothing else', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-home-')));
  fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/gh/hosts.yml'), 'oauth_token: x\n');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-work-')));
  const env = { HOME: home, XDG_CONFIG_HOME: '' };
  const tool = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: work });
  for (const [name, input] of [['Read', { file_path: path.join(home, '.config/gh/hosts.yml') }],
    ['Grep', { pattern: 'token', path: home }], ['Glob', { pattern: '**', path: path.join(home, '.config') }], ['Read', { file_path: 42 }]]) {
    const r = hook('reviewer', tool(name, input), env);
    assert.equal(r.status, 2, `${name} ${JSON.stringify(input)}`);
    assert.match(r.stderr, /where credentials are kept|no readable path/);
  }
  assert.equal(hook('reviewer', tool('Read', { file_path: path.join(work, 'a.txt') }), env).status, 0);
  assert.equal(hook('reviewer', tool('Grep', { pattern: 'x' }), env).status, 0);
  assert.equal(hook('implementer', tool('Read', { file_path: path.join(home, '.config/gh/hosts.yml') }), env).status, 0);
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
    // The reviewer's reading tools pass the guard too (#68).
    if (role === 'reviewer') assert.match(f, /- matcher: "Read\|Grep\|Glob"\s*\n\s*hooks:\s*\n\s*- type: command\s*\n\s*command: '.*tools\/harness\/guard\.mjs" reviewer'/);
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

test('a script for sh or source is read only when it is a regular file that exists, links followed (Sol\'s R1, round 3)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-script-'));
  fs.writeFileSync(path.join(dir, 'check.sh'), 'npm test\n');
  fs.symlinkSync('/dev/stdin', path.join(dir, 'in'));
  fs.symlinkSync('check.sh', path.join(dir, 'ok.sh'));
  for (const c of ['bash check.sh', 'sh ./check.sh', '. check.sh', 'bash ok.sh']) assert.equal(refusal(c, 'reviewer', { cwd: dir }), null, c);
  for (const c of ['bash in', 'source in', 'bash missing.sh', `bash ${dir}`]) assert.match(refusal(c, 'reviewer', { cwd: dir }) ?? 'allowed', /^the reviewer may not run/, c);
  if (process.platform === 'linux') {                                             // a regular file under /proc, through a link
    fs.symlinkSync('/proc/self/environ', path.join(dir, 'envf'));
    assert.match(refusal('bash envf', 'reviewer', { cwd: dir }) ?? 'allowed', /^the reviewer may not run/);
  }
  // The hook looks the script up in the event's cwd, not its own.
  assert.equal(hook('reviewer', { ...bash('bash check.sh'), cwd: dir }).status, 0);
  assert.equal(hook('reviewer', { ...bash('bash in'), cwd: dir }).status, 2);
});
