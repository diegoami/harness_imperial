// review.mjs end to end: a PR head in a local bare origin, and fakes for opencode and gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../template');
const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (cwd, msg) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg);

function project(reviewer = {}, prLabels = []) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rev-')));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'proj');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['clone', '-q', origin, main]);
  fs.mkdirSync(path.join(main, '.opencode', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(root, '.opencode/agents/reviewer.md'), path.join(main, '.opencode/agents/reviewer.md'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8'));
  config.models.spare = { id: 'opencode-go/spare-model', variant: 'high', family: 'spare' };   // a third model, tests only
  config.reviewer = { ...config.reviewer, startupTimeoutSec: 2, idleTimeoutSec: 5, totalTimeoutSec: 20, ...reviewer };
  fs.writeFileSync(path.join(main, 'harness.json'), JSON.stringify(config));
  git(main, 'add', '.');
  commit(main, 'init');
  git(main, 'push', '-q', 'origin', 'main');
  // The PR: one commit on a branch, published as refs/pull/7/head like GitHub does.
  git(main, 'checkout', '-q', '-b', 'task/T07-x');
  fs.writeFileSync(path.join(main, 'feature.txt'), 'x\n');
  git(main, 'add', 'feature.txt');
  commit(main, 'feature');
  const sha = git(main, 'rev-parse', 'HEAD');
  git(main, 'push', '-q', 'origin', `HEAD:refs/pull/7/head`);
  git(main, 'checkout', '-q', 'main');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(here, 'fake-gh.mjs'), path.join(bin, 'gh'));
  const ghState = path.join(base, 'gh.json');
  fs.writeFileSync(ghState, JSON.stringify({ prs: [{ number: 7, head: 'task/T07-x', sha, labels: prLabels }] }));
  fs.writeFileSync(path.join(base, 'brief.md'), 'T07 review (x)\nReview PR #7.\n');
  return { base, main, ghState, sha };
}

function review(p, env, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'tools/harness/review.mjs'),
    '--pr', '7', '--brief', path.join(p.base, 'brief.md'), ...args], {
    cwd: p.main, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${path.join(p.base, 'bin')}${path.delimiter}${process.env.PATH}`,
      HARNESS_OPENCODE_EXE: path.join(here, 'fake-opencode.mjs'),
      FAKE_OC_STATE: path.join(p.base, 'oc.json'), FAKE_GH_STATE: p.ghState,
      HARNESS_OPENCODE_HOME: path.join(p.base, 'oc-home'), HARNESS_OPENCODE_AUTH_SOURCE: path.join(p.base, 'auth.json'),
      ...env,
    },
  });
}
const gh = (p) => ({ comments: [], issueLabels: {}, ...JSON.parse(fs.readFileSync(p.ghState, 'utf8')) });
const posix = { skip: process.platform === 'win32' };

test('a complete review is posted once, labelled, and its worktree removed', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok' }, '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = gh(p);
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /^T07 review \(luna\)\napprove\n[\s\S]*approve\n\n— luna, via/);
  assert.doesNotMatch(s.comments[0].body, /reading the diff/);
  assert.deepEqual(s.issueLabels['12'], ['status:approved']);
  assert.deepEqual(fs.readdirSync(path.join(p.base, 'proj-work')), []);
  assert.doesNotMatch(git(p.main, 'worktree', 'list'), /review/);
});

test('the reviewer runs git in its worktree and is never asked to type its path (L30)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [session] = JSON.parse(fs.readFileSync(path.join(p.base, 'oc.json'), 'utf8'));
  assert.match(session.prompt, /it is already your working directory\. Run git\n {2}there without -C, and never type that path/);
  assert.doesNotMatch(session.prompt, /git -C/);
  const instructions = fs.readFileSync(path.join(root, '.opencode/agents/reviewer.md'), 'utf8').split(/^---$/m).slice(2).join('');
  assert.doesNotMatch(instructions, /git -C/);
  assert.match(instructions, /git rev-parse --show-toplevel/);
});

// A brief with the task file pasted in, three Done-when lines (L32).
const TASK = '# T07 Thing\n\n- **Done when**:\n  1. `node a.js` prints 1.\n  2. `node b.js` prints 2.\n  3. `npm test` is green.\n- **Hazards**: none.\n';
const withTask = (p) => fs.writeFileSync(path.join(p.base, 'brief.md'), `T07 review (x)\nReview PR #7. The task file follows.\n\n${TASK}`);
const reviewWith = (verdict, dw) => `T07 review (luna)\n${verdict}\n\n${dw.join('\n')}\n\nR1: fine.\n\n${verdict}\n`;

test('an approve without a DW line for every Done-when line is posted, not applied, and exits 4 (L32)', posix, () => {
  const p = project();
  withTask(p);
  const r = review(p, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: reviewWith('approve', ['DW1: ran node a.js → 1', 'DW2: ran node b.js → 2']) }, '--issue', '12', '--apply-label');
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.match(r.stderr, /approve, not applied: no DW line for Done-when 3/);
  const s = gh(p);
  assert.match(s.comments[0].body, /^> Note from tools\/harness\/review\.mjs: approve not applied: no DW line for Done-when 3 \(L32\)\./);
  assert.match(s.comments[0].body, /\n\nT07 review \(luna\)\napprove\n\nDW1: ran node a\.js → 1/);
  assert.equal(s.issueLabels['12'], undefined);
  const [session] = JSON.parse(fs.readFileSync(path.join(p.base, 'oc.json'), 'utf8'));
  assert.match(session.prompt, /The task has 3 Done-when lines\. Right after the verdict line, account for each/);
});

test('an approve with every DW line is applied; one "not run" is not (L32)', posix, () => {
  const p = project();
  withTask(p);
  const all = ['DW1: ran node a.js → 1', 'DW2: ran node b.js → 2', 'DW3: ran npm test → 9 pass'];
  const ok = review(p, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: reviewWith('approve', all) }, '--issue', '12', '--apply-label');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.deepEqual(gh(p).issueLabels['12'], ['status:approved']);
  const q = project();
  withTask(q);
  const notRun = review(q, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: reviewWith('approve', [...all.slice(0, 2), 'DW3: not run — no key']) }, '--issue', '12', '--apply-label');
  assert.equal(notRun.status, 4);
  assert.match(notRun.stderr, /Done-when 3 not run/);
  assert.equal(gh(q).issueLabels['12'], undefined);
});

test('a dry run of an unaccounted approve says it would apply no label and exit 4 (L32)', posix, () => {
  const p = project();
  withTask(p);
  const r = review(p, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: reviewWith('approve', ['DW1: ran a → 1']) }, '--dry-run', '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /approve not applied: no DW line for Done-when 2, 3/);
  assert.match(r.stdout, /dry run: would post the above, no label, and exit 4\./);
  assert.equal(gh(p).comments.length, 0);
});

test('a rework is labelled whatever its DW lines; --done-when overrides the count (L32)', posix, () => {
  const p = project();
  withTask(p);
  const rework = review(p, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: reviewWith('rework', ['DW1: ran node a.js → 0']) }, '--issue', '12', '--apply-label');
  assert.equal(rework.status, 0, rework.stderr + rework.stdout);
  assert.deepEqual(gh(p).issueLabels['12'], ['status:rework']);
  const q = project();
  withTask(q);
  const two = review(q, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: reviewWith('approve', ['DW1: ran a → 1', 'DW2: ran b → 2']) }, '--done-when', '2');
  assert.equal(two.status, 0, two.stderr + two.stdout);
});

test('a review that may be cut off is posted under a note, unlabelled, exit 4, and no other model runs', posix, () => {
  const p = project({ chain: ['luna', 'spare'] });
  const r = review(p, { FAKE_OC_MODE: 'review-cut' }, '--issue', '12', '--apply-label');
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /attempt: spare/);
  assert.match(r.stderr, /flagged \(may be cut off\); no label/);
  const s = gh(p);
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /^> Note from tools\/harness\/review\.mjs: may be cut off; no label applied\.[^\n]*\n\nT07 review \(luna\)\n[\s\S]*R1: the loop in/);
  assert.equal(s.issueLabels['12'], undefined);
});

test('a flagged review after a failed model: the reason goes in the note, the review stays whole', posix, () => {
  const p = project({ chain: ['luna', 'spare'] });
  const r = review(p, {
    FAKE_OC_MODES: JSON.stringify({ 'openai/gpt-6-luna': 'exit-no-session', 'opencode-go/spare-model': 'ok' }),
    FAKE_OC_OUTPUT: 'Notes first.\nT07 review (spare)\nrework\n\nR1: the loop in',
  });
  assert.equal(r.status, 4, r.stderr + r.stdout);
  const body = gh(p).comments[0].body;
  assert.match(body, /^> Note from tools\/harness\/review\.mjs: may be cut off; no label applied \(luna failed: exited without a session/);
  assert.ok(body.includes('\n\nNotes first.\nT07 review (spare)\nrework\n\nR1: the loop in\n\n— spare, via'));
});

test('a decorated review after a preamble is read, posted normalised, and labelled', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-decorated' }, '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = gh(p);
  assert.match(s.comments[0].body, /^T07 review \(luna\)\nrework\n\nR1: x\.\n\n— signed, the reviewer\n\nrework\n\n— luna, via/);
  assert.deepEqual(s.issueLabels['12'], ['status:rework']);
});

test('a closing keyword is rewritten, logged, and the review still posted', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-fixes' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /rewrote a closing keyword: fixes #12 -> fixes 12/);
  assert.match(gh(p).comments[0].body, /this fixes 12 only in part/);
});

test('a dry run prints the note and the exit code it would use, and posts nothing', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-cut' }, '--dry-run', '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /> Note from tools\/harness\/review\.mjs: may be cut off/);
  assert.match(r.stdout, /dry run: would post the above, no label, and exit 4\./);
  assert.equal(gh(p).comments.length, 0);
});

test('the OpenAI login missing: exit 3 saying how to log in, before any worktree or run', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok', FAKE_OC_MODELS: '["opencode-go/deepseek-v4.1-flash"]' });
  assert.equal(r.status, 3);
  const home = path.join(p.base, 'oc-home', 'data');
  assert.ok((r.stdout + r.stderr).includes(`luna: openai lists no models for ${home}: it is not logged in there`));
  assert.match(r.stderr, /use a Claude reviewer \(opus\)/);
  assert.equal(fs.existsSync(path.join(p.base, 'oc.json')), false);
  assert.equal(gh(p).comments.length, 0);
});

test('the run uses the scripts\' own data directory, with auth.json copied in', posix, () => {
  const p = project();
  fs.writeFileSync(path.join(p.base, 'auth.json'), '{"secret":"never printed"}');
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const data = path.join(p.base, 'oc-home', 'data');
  const [session] = JSON.parse(fs.readFileSync(path.join(p.base, 'oc.json'), 'utf8'));
  assert.equal(session.dataHome, data);
  assert.equal(fs.readFileSync(path.join(data, 'opencode', 'auth.json'), 'utf8'), '{"secret":"never printed"}');
  assert.match(r.stdout, /data directory .* \(auth\.json copied\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /never printed/);
});

test('a review rejected for cd or .. says so, naming L31 (#14)', posix, () => {
  const p = project({ chain: ['luna'] });
  const r = review(p, { FAKE_OC_MODE: 'permission-cd' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /permission rejected: external_directory \(\/tmp\/\*\); the rejected command used cd or \.\..*\(L31\)/);
  assert.equal(gh(p).comments.length, 0);
});

test('a review whose tool call was rejected is never posted, even when it looks complete', posix, () => {
  const p = project({ chain: ['luna'] });
  const r = review(p, { FAKE_OC_MODE: 'permission-review' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /permission rejected: external_directory/);
  assert.equal(gh(p).comments.length, 0);
});

test('no review at all (tool chatter only, an early stop) is the one failure: nothing posted, exit 3', posix, () => {
  const p = project({ chain: ['luna', 'spare'] });
  const r = review(p, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: 'reading src/a.js\nrunning the tests\n' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /same failure twice: no-review/);
  assert.match(r.stderr, /use a Claude reviewer \(opus\)/);
  assert.equal(gh(p).comments.length, 0);
});

test('the implementer\'s family never reviews: dropped from the chain, or refused when named', posix, () => {
  const p = project({ chain: ['luna'] });
  const dropped = review(p, { FAKE_OC_MODE: 'review-ok' }, '--exclude', 'luna');
  assert.equal(dropped.status, 3);
  const refused = review(p, { FAKE_OC_MODE: 'review-ok' }, '--reviewer', 'luna', '--exclude', 'luna');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refused/);
  assert.equal(gh(p).comments.length, 0);
});

test('a model:<name> label on the PR excludes that family without --exclude', posix, () => {
  const p = project({ chain: ['deepseek-flash', 'luna'] }, ['model:deepseek-flash']);
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(gh(p).comments[0].body, /^T07 review \(luna\)/);
  assert.doesNotMatch(r.stdout, /attempt: deepseek-flash/);
});
