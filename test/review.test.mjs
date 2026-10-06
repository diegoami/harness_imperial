// review.mjs end to end: a PR head in a local bare origin, and fakes for opencode and gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessions } from './fake-state.mjs';
import { quotaServer, entry } from './quota-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../template');
const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (cwd, msg) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg);

function project(reviewer = {}, prLabels = [], jail = false) {
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
  config.jail = { enabled: jail };
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
      HARNESS_OPENCODE_EXE: path.join(here, 'fake-opencode.mjs'), HARNESS_QUOTA_URL: 'http://127.0.0.1:9',
      FAKE_OC_STATE: path.join(p.base, 'oc.json'), FAKE_GH_STATE: p.ghState, HARNESS_GH_EXE: path.join(here, 'fake-gh.mjs'),
      HARNESS_OPENCODE_HOME: path.join(p.base, 'oc-home'), HARNESS_OPENCODE_AUTH_SOURCE: path.join(p.base, 'auth.json'),
      HARNESS_BWRAP: path.join(here, 'fake-bwrap.sh'), FAKE_BWRAP_LOG: path.join(p.base, 'bwrap.log'),
      ...env,
    },
  });
}
const gh = (p) => ({ comments: [], issueLabels: {}, ...JSON.parse(fs.readFileSync(p.ghState, 'utf8')) });
// The fakes run through Node (HARNESS_GH_EXE, HARNESS_OPENCODE_EXE), so these tests run on Windows too (#2).
const posix = {};

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
  assert.doesNotMatch(git(p.main, 'worktree', 'list'), /proj-work[\\/]7-review-/);
});

test('the jail is off unless harness.json enables it: OpenCode runs outside it, and nothing warns', () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!fs.existsSync(path.join(p.base, 'bwrap.log')), 'bwrap never ran');
  assert.doesNotMatch(r.stdout, /credential jail/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8')).jail, { enabled: false });   // the template's default
});

test('OpenCode reviews in the credential jail; without one, the log warns first and the review still runs (#68)', { skip: process.platform !== 'linux' }, () => {
  const p = project({}, [], true);
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const runs = fs.readFileSync(path.join(p.base, 'bwrap.log'), 'utf8').split('===\n').filter(Boolean).map((b) => b.split('\n'));
  const reviewRun = runs.find((a) => a.includes('run'));
  assert.ok(reviewRun, 'the review run went through bwrap');
  assert.ok(reviewRun.includes('--unshare-pid') && reviewRun.includes('GH_TOKEN'));
  assert.deepEqual(reviewRun.slice(reviewRun.indexOf('--') + 1, reviewRun.indexOf('--') + 3), [process.execPath, path.join(here, 'fake-opencode.mjs')]);
  assert.doesNotMatch(r.stdout, /credential jail is off/);
  const q = project({}, [], true);
  const off = review(q, { FAKE_OC_MODE: 'review-ok', HARNESS_BWRAP: path.join(q.base, 'no-bwrap') });
  assert.equal(off.status, 0, off.stderr + off.stdout);
  assert.match(off.stdout, /WARNING: the reviewer's credential jail is off \(HARNESS_BWRAP points at a missing file/);
  assert.equal(gh(q).comments.length, 1);
});

test('every reviewer is told a proven bypass of what the task protects is blocking, never follow-up hardening (L47)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  const prompt = session.brief.replace(/\s+/g, " ");
  assert.match(prompt, /A finding you proved that lets a forbidden action or a wrong result past what the task protects is blocking, and blocks an approve: never "follow-up hardening" or "outside the threat model" unless the task's text says so \(L47\)\./);
  const instructions = fs.readFileSync(path.join(root, '.opencode/agents/reviewer.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(instructions, /A proven bypass of the task's own guard is blocking even when it looks like an edge case/);
  assert.match(instructions, /When unsure, say how likely the problem is, and rate it blocking only if it is likely and would get past what the task protects; otherwise it is a follow-up \(L53\)/);
  const claude = fs.readFileSync(path.join(root, '.claude/agents/reviewer.md'), 'utf8').replace(/\s+/g, ' ');   // the Claude fallback reviewer too
  assert.match(claude, /A proven bypass of the task's own guard is blocking even when it looks like an edge case/);
  assert.match(claude, /When unsure, say how likely the problem is, and rate it blocking only if it is likely and would get past what the task protects; otherwise it is a follow-up \(L53\)/);
  for (const f of ['docs/review-brief.md', '../profiles/review/docs/review.md']) {
    assert.match(fs.readFileSync(path.join(root, f), 'utf8').replace(/\s+/g, ' '), /When unsure, say how likely the problem is\. Rate it blocking only if it is likely and would get past what the task protects; otherwise it is a follow-up\. \(L53\)/, f);
  }
  assert.match(instructions, /Scratch output goes to a file in the worktree root .* never `\/tmp`\. Run git commands one at a time, never in parallel, and never touch `\.git`/);
});

test('the reviewer runs git in its worktree and is never asked to type its path (L30)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  assert.match(session.brief, /it is already your working directory\. Run git\n {2}there without -C, and never type that path/);
  assert.doesNotMatch(session.brief, /git -C/);
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
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  assert.match(session.brief, /The task has 3 Done-when lines\. Right after the verdict line, account for each/);
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

test('an approve whose DW lines are malformed or repeated is not applied (Luna\'s R1 on PR 22)', posix, () => {
  const p = project();
  withTask(p);
  const r = review(p, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: reviewWith('approve', ['DW1: ran node a.js → 1', 'DW2: looks fine', 'DW3: not run — x', 'DW3: ran npm test → ok']) }, '--issue', '12', '--apply-label');
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.match(r.stderr, /more than one DW line for Done-when 3; the DW line for Done-when 2 is neither/);
  assert.equal(gh(p).issueLabels['12'], undefined);
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

test('a brief naming another commit as the one to review exits 2 before anything runs (#23)', posix, () => {
  const p = project();
  const other = 'b'.repeat(40);
  fs.writeFileSync(path.join(p.base, 'brief.md'), `T07 review (x)\nYou review PR #7 at ${other}.\n0. Prove the tree: HEAD is ${other}.\n`);
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, new RegExp(`names ${other} as the commit to review, but PR 7's head is ${p.sha}`));
  assert.match(r.stderr, /git rev-parse <branch>/);
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);              // no OpenCode run
  const work = path.join(p.base, 'proj-work');
  assert.deepEqual(fs.existsSync(work) ? fs.readdirSync(work) : [], []);          // no worktree
  assert.equal(gh(p).comments.length, 0);
});

test('a brief naming the head runs, and one citing another commit only in passing runs too (#23)', posix, () => {
  const p = project();
  fs.writeFileSync(path.join(p.base, 'brief.md'),
    `T07 review (x)\nYou review PR #7 at ${p.sha}.\n0. Prove the tree: HEAD is ${p.sha}.\nThe PR body: reverts what was merged as ${'c'.repeat(40)}.\n`);
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(gh(p).comments.length, 1);
});

test('a task file citing its evidence "at <sha>" does not block the review (#32)', posix, () => {
  const p = project();
  fs.writeFileSync(path.join(p.base, 'brief.md'),
    `T07 review (x)\nYou review PR #7 at ${p.sha}.\n0. Prove the tree: HEAD is ${p.sha}.\n\n# T07 Calendar\n\nThe source: malpaco-godot-poc at \`${'d'.repeat(40)}\`, the merge of PR #9.\n`);
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(gh(p).comments.length, 1);
});

test('the reviewer\'s agent comes from the main checkout, never from the PR under review (#10, L34)', posix, () => {
  const p = project();
  // The PR changes its own reviewer: a new description, and git push allowed.
  git(p.main, 'checkout', '-q', 'task/T07-x');
  const own = path.join(p.main, '.opencode/agents/reviewer.md');
  fs.writeFileSync(own, fs.readFileSync(own, 'utf8').replace(/^description: .*$/m, 'description: THE PR\'S OWN REVIEWER')
    .replace('"git push *": deny', '"git push *": allow'));
  git(p.main, 'commit', '-q', '-am', 'loosen my own reviewer');
  const sha = git(p.main, 'rev-parse', 'HEAD');
  git(p.main, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head');
  git(p.main, 'checkout', '-q', 'main');
  const state = JSON.parse(fs.readFileSync(p.ghState, 'utf8'));
  state.prs[0].sha = sha;
  fs.writeFileSync(p.ghState, JSON.stringify(state));
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  // Both sides through realpathSync.native: Windows may give the temp directory as an 8.3 short name.
  assert.equal(fs.realpathSync.native(session.agentFile), fs.realpathSync.native(path.join(p.main, '.opencode', 'agents', 'reviewer.md')));
  assert.doesNotMatch(session.agentDescription, /THE PR'S OWN REVIEWER/);
  // and the PR's .opencode/ is not read at all: an opencode.json or a plugin there is ignored too.
  assert.equal(session.projectConfig, 'disabled');
});

test('a checkout without the reviewer agent exits 2 before anything runs (#10)', posix, () => {
  const p = project();
  fs.rmSync(path.join(p.main, '.opencode/agents/reviewer.md'));
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reviewer agent is missing from this checkout/);
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
});

test('a 2.x OpenCode exits 3 before any worktree or run, and nothing is posted (#26)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok', FAKE_OC_VERSION: '2.0.18' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /OpenCode 2\.0\.18 at .* is not supported.*use a Claude reviewer \(opus\)/);
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
  assert.equal(gh(p).comments.length, 0);
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
    FAKE_OC_MODES: JSON.stringify({ 'openai/gpt-5.6-luna': 'exit-no-session', 'opencode-go/spare-model': 'ok' }),
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
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
  assert.equal(gh(p).comments.length, 0);
});

test('the run uses the scripts\' own data directory, with auth.json copied in', posix, () => {
  const p = project();
  fs.writeFileSync(path.join(p.base, 'auth.json'), '{"secret":"never printed"}');
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const data = path.join(p.base, 'oc-home', 'data');
  const [session] = readSessions(path.join(p.base, 'oc.json'));
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

test('a review whose tool printed a quoted rejection line is posted: only OpenCode\'s coloured line counts (PR 35)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'permission-quoted' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout + r.stderr, /permission rejected/);
  assert.equal(gh(p).comments.length, 1);
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

test('a reviewer on watch says what to look for before it runs (L35)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok', FAKE_OC_MODELS: '["zai-coding-plan/glm-5.3-flash"]' }, '--reviewer', 'glm-flash');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /watch: glm-flash \(zai-coding-plan\/glm-5\.3-flash\) is on watch: .*no DW evidence \(L32\)/);
  assert.doesNotMatch(review(project(), { FAKE_OC_MODE: 'review-ok' }).stdout, /watch:/);
});

// The review profile's reviewers (#39): GLM-5.3 Flash, then Luna, then DeepSeek; Luna's second opinion; no Claude.
const PROFILE = { chain: ['glm-flash', 'luna', 'deepseek-flash'], secondOpinion: 'luna', claudeFallback: null };
const LISTED = JSON.stringify(['zai-coding-plan/glm-5.3-flash', 'openai/gpt-5.6-luna', 'opencode-go/deepseek-v4.1-flash']);
const modes = (m) => JSON.stringify({ 'zai-coding-plan/glm-5.3-flash': m[0], 'openai/gpt-5.6-luna': m[1], 'opencode-go/deepseek-v4.1-flash': m[2] ?? 'review-ok' });
const labels = (p) => gh(p).issueLabels['12'] ?? [];

test('a second opinion posts both reviews, and the stricter verdict decides the label (#39)', posix, () => {
  const p = project(PROFILE);
  const r = review(p, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'review-fixes']) }, '--exclude', 'claude', '--second-opinion', '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [first, second] = gh(p).comments.map((c) => c.body);
  assert.match(first, /^T07 review \(glm-flash\)\napprove/);
  assert.match(second, /^T07 review \(luna, second opinion\)\nrework/);
  assert.deepEqual(labels(p), ['status:rework']);
  const q = project(PROFILE);
  const both = review(q, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'review-ok']) }, '--exclude', 'claude', '--second-opinion', '--issue', '12', '--apply-label');
  assert.equal(both.status, 0, both.stderr + both.stdout);
  assert.equal(gh(q).comments.length, 2);
  assert.deepEqual(labels(q), ['status:approved']);
});

test('a second opinion\'s dry run names a label only with --apply-label (Sol\'s R2 on PR 41, round 2)', posix, () => {
  const run = (...x) => review(project(PROFILE), { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'review-ok']) }, '--exclude', 'claude', '--second-opinion', '--dry-run', ...x);
  const plain = run();
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  assert.match(plain.stdout, /dry run: would post 2 review\(s\), no label, and exit 0/);
  assert.match(run('--issue', '12', '--apply-label').stdout, /dry run: would post 2 review\(s\), label status:approved, and exit 0/);
});

test('the second opinion is never the model that wrote the first review (#39)', posix, () => {
  const p = project(PROFILE);
  const r = review(p, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['exit-no-session', 'review-ok', 'review-ok']) }, '--exclude', 'claude', '--second-opinion');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const bodies = gh(p).comments.map((c) => c.body.split('\n')[0]);
  assert.deepEqual(bodies, ['T07 review (luna; glm-flash failed: exited without a session (exit 1))', 'T07 review (deepseek-flash, second opinion)']);
});

test('no second opinion: the first review is posted, no label, exit 3 to the owner (#39)', posix, () => {
  const p = project(PROFILE);
  const r = review(p, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'exit-no-session', 'exit2']) }, '--exclude', 'claude', '--second-opinion', '--issue', '12', '--apply-label');
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.match(r.stderr, /no second opinion \(.*luna failed.*\): escalate to the owner/);
  assert.equal(gh(p).comments.length, 1);
  assert.deepEqual(labels(p), []);
});

test('with no Claude reviewer, or when Claude implemented, a failure escalates to the owner (#39)', posix, () => {
  const p = project(PROFILE);
  const r = review(p, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODE: 'exit2' }, '--exclude', 'claude');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Nothing posted; escalate to the owner \(harness\.json names no Claude reviewer\)/);
  assert.doesNotMatch(r.stderr, /use a Claude reviewer/);
  const q = project({ chain: ['luna'] });
  const s = review(q, { FAKE_OC_MODE: 'exit2' }, '--exclude', 'claude');
  assert.equal(s.status, 3);
  assert.match(s.stderr, /escalate to the owner: Claude implemented this PR/);
  const t = review(project({ chain: ['luna'] }), { FAKE_OC_MODE: 'exit2' }, '--exclude', 'deepseek-flash');
  assert.match(t.stderr, /use a Claude reviewer \(opus\)/);
  const u = review(project({ chain: ['luna'] }), { FAKE_OC_MODE: 'review-ok' }, '--second-opinion');
  assert.equal(u.status, 2);
  assert.match(u.stderr, /--second-opinion needs reviewer\.secondOpinion/);
});

const withLabels = (p, l) => { const s = JSON.parse(fs.readFileSync(p.ghState, 'utf8')); s.issueLabels = { 12: l }; fs.writeFileSync(p.ghState, JSON.stringify(s)); };
const withAlias = (p) => {   // a second name for GLM-5.3 Flash, as the second opinion
  const f = path.join(p.main, 'harness.json');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.models['glm-alias'] = { ...c.models['glm-flash'] };
  c.reviewer.secondOpinion = 'glm-alias';
  fs.writeFileSync(f, JSON.stringify(c));
};

test('an earlier approval never survives two reviews that did not both approve (Sol\'s R3 on PR 41)', posix, () => {
  const p = project(PROFILE);
  withLabels(p, ['status:approved', 'status:in-review']);
  const r = review(p, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'review-fixes']) }, '--exclude', 'claude', '--second-opinion', '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(labels(p), ['status:rework']);
  const q = project(PROFILE);
  withLabels(q, ['status:rework']);
  review(q, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'review-ok']) }, '--exclude', 'claude', '--second-opinion', '--issue', '12', '--apply-label');
  assert.deepEqual(labels(q), ['status:approved']);
  const n = project(PROFILE);
  withLabels(n, ['status:approved']);
  const none = review(n, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'exit-no-session', 'exit2']) }, '--exclude', 'claude', '--second-opinion', '--issue', '12', '--apply-label');
  assert.equal(none.status, 3);
  assert.deepEqual(labels(n), []);
});

test('two names for one model never make two opinions, nor retry a failed model (Sol\'s R2 on PR 41)', posix, () => {
  const p = project(PROFILE);
  withAlias(p);
  const r = review(p, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['review-ok', 'review-ok']) }, '--exclude', 'claude', '--second-opinion');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(gh(p).comments.map((c) => c.body.split('\n')[0]), ['T07 review (glm-flash)', 'T07 review (luna, second opinion)']);
  const q = project(PROFILE);
  withAlias(q);
  const s = review(q, { FAKE_OC_MODELS: LISTED, FAKE_OC_MODES: modes(['exit-no-session', 'review-ok', 'review-ok']) }, '--exclude', 'claude', '--second-opinion');
  assert.equal(s.status, 0, s.stderr + s.stdout);
  assert.match(gh(q).comments[1].body, /^T07 review \(deepseek-flash, second opinion\)/);
});

test('OpenCode missing says the same as any other failure: the owner, or a Claude reviewer (Sol\'s R1 on PR 41)', posix, () => {
  const missing = { HARNESS_OPENCODE_EXE: '/no/such/opencode' };
  const a = review(project({ chain: ['luna'] }), missing, '--exclude', 'claude');
  assert.equal(a.status, 3);
  assert.match(a.stderr, /OpenCode unavailable: .*escalate to the owner: Claude implemented this PR/);
  const b = review(project(PROFILE), missing, '--exclude', 'deepseek-flash');
  assert.match(b.stderr, /escalate to the owner \(harness\.json names no Claude reviewer\)/);
  const c = review(project({ chain: ['luna'] }), missing, '--exclude', 'deepseek-flash');
  assert.match(c.stderr, /OpenCode unavailable: .*use a Claude reviewer \(opus\)/);
});

// --hard (L39, L41): GLM-5.3, then DeepSeek V4 Pro and Luna; --hard --sol puts GPT-6.1 Sol first.
const HARD = JSON.stringify(['openai/gpt-6.1-sol', 'zai-coding-plan/glm-5.3', 'opencode-go/deepseek-v4-pro', 'openai/gpt-5.6-luna']);
const hardModes = (m) => JSON.stringify({ 'openai/gpt-6.1-sol': m[0] ?? 'review-ok', 'zai-coding-plan/glm-5.3': m[1] ?? 'review-ok', 'opencode-go/deepseek-v4-pro': m[2] ?? 'review-ok', 'openai/gpt-5.6-luna': m[3] ?? 'review-ok' });

test('--hard reviews with GLM-5.3, never Sol, and with a third family when GLM cannot run, saying so (L39, L41)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes([]) }, '--exclude', 'claude', '--hard');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(gh(p).comments[0].body, /^T07 review \(glm\)\napprove/);
  assert.doesNotMatch(r.stdout, /attempt: sol/);
  const q = project();                                                           // GLM out of quota: DeepSeek V4 Pro reviews
  const s = review(q, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes(['review-ok', 'exit2']) }, '--exclude', 'claude', '--hard');
  assert.equal(s.status, 0, s.stderr + s.stdout);
  assert.match(gh(q).comments[0].body, /^T07 review \(deepseek-pro; glm failed: exit 2\)\napprove/);
});

test('an Alibaba reviewer refused for its key says which data directory\'s auth.json to check, and nothing is posted', posix, () => {
  const p = project();
  const file = path.join(p.main, 'harness.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.models.qwen = { id: 'alibaba-token-plan/qwen3.8-flash', variant: 'high', family: 'qwen' };
  fs.writeFileSync(file, JSON.stringify(config));
  const r = review(p, { FAKE_OC_MODE: 'invalid-key', FAKE_OC_MODELS: JSON.stringify(['alibaba-token-plan/qwen3.8-flash']) }, '--exclude', 'claude', '--reviewer', 'qwen');
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.match(r.stderr, /qwen failed: invalid API key for alibaba-token-plan: the auth\.json in \S+oc-home[\\/]data may hold a stale Alibaba entry/);
  assert.equal(gh(p).comments.length, 0);
  // A review that only quotes the phrase is a review (Luna's R1, round 2).
  const q = project();
  fs.writeFileSync(path.join(q.main, 'harness.json'), JSON.stringify(config));
  const ok = review(q, { FAKE_OC_MODE: 'review-ok', FAKE_OC_REVIEW_EXTRA: 'R1: the docs mention "Invalid API-key".', FAKE_OC_MODELS: JSON.stringify(['alibaba-token-plan/qwen3.8-flash']) }, '--exclude', 'claude', '--reviewer', 'qwen');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(gh(q).comments.length, 1);
});

test('a reviewer whose provider is out of quota is skipped before it runs, saying why; with no quota-tracker nothing is skipped (L50)', posix, async () => {
  const s = await quotaServer([entry('zai', 'exhausted', [], { available_in: '2h08m' }), entry('openai', 'ok'), entry('opencode_go', 'ok')]);
  try {
    const p = project();
    const r = review(p, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes([]), HARNESS_QUOTA_URL: s.url }, '--exclude', 'claude', '--hard');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /quota: checked \(zai exhausted, openai ok, opencode_go ok\)/);
    assert.match(r.stdout, /glm: skipped, out of quota: zai is exhausted until it is usable again in 2h08m \(quota-tracker, L50\)/);
    assert.doesNotMatch(r.stdout, /attempt: glm/);
    assert.match(gh(p).comments[0].body, /^T07 review \(deepseek-pro; glm not available\)\napprove/);
  } finally { s.stop(); }
  const q = project();                                                           // no service: GLM runs
  const r = review(q, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes([]) }, '--exclude', 'claude', '--hard');
  assert.match(r.stdout, /quota: not checked: http:\/\/127\.0\.0\.1:9\/quota did not answer/);
  assert.match(gh(q).comments[0].body, /^T07 review \(glm\)\napprove/);
});

test('every reviewer out of quota: exit 3 before any run, naming why (L50)', posix, async () => {
  const s = await quotaServer([entry('openai', 'exhausted', [{ name: '7d', used_pct: 100 }, { name: 'gpt-5.6-luna:7d', used_pct: 97 }])]);
  try {
    const p = project();
    const r = review(p, { FAKE_OC_MODE: 'review-ok', HARNESS_QUOTA_URL: s.url }, '--exclude', 'claude');
    assert.equal(r.status, 3, r.stderr + r.stdout);
    assert.match(r.stderr, /luna: skipped, out of quota: its own gpt-5\.6-luna:7d window is 97% used/);
    assert.equal(gh(p).comments.length, 0);
    assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
  } finally { s.stop(); }
});

test('--hard --sol reviews with Sol, and with the hard chain when Sol cannot run, saying so (L41)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes([]) }, '--exclude', 'claude', '--hard', '--sol');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(gh(p).comments[0].body, /^T07 review \(sol-6\.1\)\napprove/);
  const q = project();                                                           // Sol out of quota: GLM-5.3 reviews
  const s = review(q, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes(['exit2']) }, '--exclude', 'claude', '--hard', '--sol');
  assert.equal(s.status, 0, s.stderr + s.stdout);
  assert.match(gh(q).comments[0].body, /^T07 review \(glm; sol-6\.1 failed: exit 2\)\napprove/);
});

test('a Sol that cannot run at all is named in the substitute\'s header (Sol\'s R2 on PR 47)', posix, () => {
  const p = project();
  const notListed = JSON.stringify(['zai-coding-plan/glm-5.3', 'opencode-go/deepseek-v4-pro', 'openai/gpt-5.6-luna']);
  const r = review(p, { FAKE_OC_MODELS: notListed, FAKE_OC_MODE: 'review-ok' }, '--exclude', 'claude', '--hard', '--sol');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(gh(p).comments[0].body, /^T07 review \(glm; sol-6\.1 not available\)\napprove/);
  const q = project();                                                           // unchanged without --hard
  review(q, { FAKE_OC_MODE: 'review-ok' });
  assert.match(gh(q).comments[0].body, /^T07 review \(luna\)\napprove/);
});

test('--hard skips the implementer\'s family: a GLM implementer gets DeepSeek V4 Pro, after Sol with --sol (L39, L41)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes([]) }, '--exclude', 'glm', '--hard');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(gh(p).comments[0].body, /^T07 review \(deepseek-pro\)/);
  assert.doesNotMatch(r.stdout, /attempt: (glm|sol)/);
  const q = project();
  const s = review(q, { FAKE_OC_MODELS: HARD, FAKE_OC_MODES: hardModes(['exit2']) }, '--exclude', 'glm', '--hard', '--sol');
  assert.equal(s.status, 0, s.stderr + s.stdout);
  assert.match(gh(q).comments[0].body, /^T07 review \(deepseek-pro; sol-6\.1 failed: exit 2\)/);
  assert.doesNotMatch(s.stdout, /attempt: glm\b/);
});

test('--hard with no reviewer left exits 3, to the owner when Claude implemented; --hard with --reviewer, without reviewer.hard, or --sol without --hard or reviewer.sol, is refused (L39, L41)', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODELS: HARD, FAKE_OC_MODE: 'exit2' }, '--exclude', 'claude', '--hard', '--sol');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /escalate to the owner: Claude implemented this PR/);
  assert.equal(gh(p).comments.length, 0);
  const glm = review(project(), { FAKE_OC_MODELS: HARD, FAKE_OC_MODE: 'exit2' }, '--exclude', 'glm', '--hard');
  assert.equal(glm.status, 3);                                                   // a non-Claude implementer: the Claude fallback
  assert.match(glm.stderr, /use a Claude reviewer \(opus\)/);
  const both = review(project(), { FAKE_OC_MODELS: HARD }, '--hard', '--reviewer', 'luna');
  assert.equal(both.status, 2);
  assert.match(both.stderr, /--hard runs reviewer\.hard; it does not take --reviewer/);
  const none = review(project({ hard: undefined }), { FAKE_OC_MODELS: HARD }, '--hard');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--hard needs reviewer\.hard/);
  const alone = review(project(), { FAKE_OC_MODELS: HARD }, '--sol');
  assert.equal(alone.status, 2);
  assert.match(alone.stderr, /--sol goes with --hard/);
  const noSol = review(project({ sol: null }), { FAKE_OC_MODELS: HARD }, '--hard', '--sol');
  assert.equal(noSol.status, 2);
  assert.match(noSol.stderr, /--sol needs reviewer\.sol/);
  const unknown = review(project({ sol: 'nobody' }), { FAKE_OC_MODELS: HARD }, '--hard', '--sol');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown reviewer nobody in reviewer\.sol/);
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
