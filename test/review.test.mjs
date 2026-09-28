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
      FAKE_OC_STATE: path.join(p.base, 'oc.json'), FAKE_GH_STATE: p.ghState, ...env,
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
  assert.match(s.comments[0].body, /^T07 review \(glm\)\napprove\n[\s\S]*approve\n\n— glm, via/);
  assert.doesNotMatch(s.comments[0].body, /reading the diff/);
  assert.deepEqual(s.issueLabels['12'], ['status:approved']);
  assert.deepEqual(fs.readdirSync(path.join(p.base, 'proj-work')), []);
  assert.doesNotMatch(git(p.main, 'worktree', 'list'), /review/);
});

test('a cut-off review is never posted; the next model reviews and the header says why', posix, () => {
  const p = project({ chain: ['glm', 'luna'] });
  const r = review(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode/glm-5.3': 'review-cut', 'opencode/gpt-6-luna': 'review-ok' }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = gh(p);
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /^T07 review \(luna; glm failed: review cut off\)\napprove/);
});

test('every model cut off: nothing posted, exit 3', posix, () => {
  const p = project({ chain: ['glm', 'luna'] });
  const r = review(p, { FAKE_OC_MODE: 'review-cut' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /same failure twice: cut-off/);
  assert.equal(gh(p).comments.length, 0);
});

test('the implementer\'s family never reviews: dropped from the chain, or refused when named', posix, () => {
  const p = project({ chain: ['glm'] });
  const dropped = review(p, { FAKE_OC_MODE: 'review-ok' }, '--exclude', 'glm');
  assert.equal(dropped.status, 3);
  const refused = review(p, { FAKE_OC_MODE: 'review-ok' }, '--reviewer', 'glm', '--exclude', 'glm');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refused/);
  assert.equal(gh(p).comments.length, 0);
});

test('a model:<name> label on the PR excludes that family without --exclude', posix, () => {
  const p = project({ chain: ['deepseek-flash', 'glm'] }, ['model:deepseek-flash']);
  const r = review(p, { FAKE_OC_MODE: 'review-ok' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(gh(p).comments[0].body, /^T07 review \(glm\)/);
  assert.doesNotMatch(r.stdout, /attempt: deepseek-flash/);
});
