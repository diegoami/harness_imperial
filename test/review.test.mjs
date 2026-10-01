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
  assert.match(s.comments[0].body, /^T07 review \(glm-flash\)\napprove\n[\s\S]*approve\n\n— glm-flash, via/);
  assert.doesNotMatch(s.comments[0].body, /reading the diff/);
  assert.deepEqual(s.issueLabels['12'], ['status:approved']);
  assert.deepEqual(fs.readdirSync(path.join(p.base, 'proj-work')), []);
  assert.doesNotMatch(git(p.main, 'worktree', 'list'), /review/);
});

test('a review that may be cut off is posted under a note, unlabelled, exit 4, and no other model runs', posix, () => {
  const p = project({ chain: ['glm-flash', 'luna'] });
  const r = review(p, { FAKE_OC_MODE: 'review-cut' }, '--issue', '12', '--apply-label');
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
  assert.match(r.stderr, /flagged \(may be cut off\); no label/);
  const s = gh(p);
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /^> Note from tools\/harness\/review\.mjs: may be cut off; no label applied\.[^\n]*\n\nT07 review \(glm-flash\)\n[\s\S]*R1: the loop in/);
  assert.equal(s.issueLabels['12'], undefined);
});

test('a decorated review after a preamble is read, posted normalised, and labelled', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-decorated' }, '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = gh(p);
  assert.match(s.comments[0].body, /^T07 review \(glm-flash\)\nrework\n\nR1: x\.\n\nrework\n\n— glm-flash, via/);
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

test('OpenCode Go not logged in: exit 3 with the login command, before any worktree or run', posix, () => {
  const p = project();
  const r = review(p, { FAKE_OC_MODE: 'review-ok', FAKE_OC_MODELS: '[]' });
  assert.equal(r.status, 3);
  const home = path.join(p.base, 'oc-home', 'data');
  assert.match(r.stdout + r.stderr, new RegExp(`OpenCode Go is not logged in for ${home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\s\\S]*opencode console login`));
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

test('a review whose tool call was rejected is never posted, even when it looks complete', posix, () => {
  const p = project({ chain: ['glm-flash'] });
  const r = review(p, { FAKE_OC_MODE: 'permission-review' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /permission rejected: external_directory/);
  assert.equal(gh(p).comments.length, 0);
});

test('no review at all (tool chatter only, an early stop) is the one failure: nothing posted, exit 3', posix, () => {
  const p = project({ chain: ['glm-flash', 'luna'] });
  const r = review(p, { FAKE_OC_MODE: 'ok', FAKE_OC_OUTPUT: 'reading src/a.js\nrunning the tests\n' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /same failure twice: no-review/);
  assert.match(r.stderr, /use a Claude reviewer \(opus\)/);
  assert.equal(gh(p).comments.length, 0);
});

test('the implementer\'s family never reviews: dropped from the chain, or refused when named', posix, () => {
  const p = project({ chain: ['glm-flash'] });
  const dropped = review(p, { FAKE_OC_MODE: 'review-ok' }, '--exclude', 'glm-flash');
  assert.equal(dropped.status, 3);
  const refused = review(p, { FAKE_OC_MODE: 'review-ok' }, '--reviewer', 'glm-flash', '--exclude', 'glm-flash');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refused/);
  assert.equal(gh(p).comments.length, 0);
});

test('a model:<name> label on the PR excludes that family without --exclude', posix, () => {
  const p = project({ chain: ['deepseek-flash', 'glm-flash'] }, ['model:deepseek-flash']);
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(gh(p).comments[0].body, /^T07 review \(glm-flash\)/);
  assert.doesNotMatch(r.stdout, /attempt: deepseek-flash/);
});
