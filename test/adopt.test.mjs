// adopt.mjs: installing the harness into a throwaway git repository, by profile (#39).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-adopt-')));
  spawnSync('git', ['init', '-q', dir]);
  return dir;
};
const adopt = (...a) => spawnSync(process.execPath, [path.join(repo, 'adopt.mjs'), ...a], { encoding: 'utf8' });
const files = (dir) => {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (r === '.git') continue;
      if (e.isDirectory()) walk(r); else out.push(r);
    }
  };
  walk('');
  return out.sort();
};
// harness.lock's own check, in Node: every hashed file is there with that content.
const verify = (dir) => {
  const lines = fs.readFileSync(path.join(dir, 'harness.lock'), 'utf8').split('\n').filter((l) => /^[0-9a-f]{64} {2}/.test(l));
  for (const l of lines) {
    const [hash, f] = [l.slice(0, 64), l.slice(66)];
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'), hash, f);
  }
  return lines.length;
};
const profile = JSON.parse(fs.readFileSync(path.join(repo, 'profiles/review/profile.json'), 'utf8'));
const template = JSON.parse(fs.readFileSync(path.join(repo, 'template/harness.json'), 'utf8'));

test('the review profile installs only the reviewer, with its own reviewers and no Claude reviewer (#39)', () => {
  const dir = project();
  const r = adopt('--profile', 'review', '--target', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(files(dir), [...profile.files, ...profile.overlay, 'harness.json', 'harness.lock'].sort());
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'harness.json'), 'utf8'));
  assert.deepEqual(config.reviewer.chain, ['glm-flash', 'luna', 'deepseek-flash']);
  assert.equal(config.reviewer.secondOpinion, 'luna');
  assert.equal(config.reviewer.claudeFallback, null);
  assert.equal(config.implementer, undefined);
  for (const [name, m] of Object.entries(config.models)) assert.deepEqual(m, template.models[name]);   // never drifts
  const lock = fs.readFileSync(path.join(dir, 'harness.lock'), 'utf8');
  assert.match(lock, /^profile review$/m);
  assert.match(lock, /^adapt CLAUDE\.md$/m);
  assert.equal(verify(dir), files(dir).length - 2);                               // all but CLAUDE.md and the lock
  const self = spawnSync(process.execPath, ['tools/harness/review.mjs', '--self-test'], { cwd: dir, encoding: 'utf8' });
  assert.equal(self.status, 0, self.stderr);                                      // its imports are all there
});

test('every model a profile\'s reviewer names is one it has: no hard chain inherited from the template', () => {
  for (const p of ['full', 'review']) {
    const dir = project();
    assert.equal(adopt('--profile', p, '--target', dir).status, 0);
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'harness.json'), 'utf8'));
    const named = [...(c.reviewer.chain ?? []), ...(c.reviewer.hard ?? []), ...(c.reviewer.sol ? [c.reviewer.sol] : []), ...(c.reviewer.secondOpinion ? [c.reviewer.secondOpinion] : []),
      ...(c.implementer?.chain ?? [])];
    for (const m of named) assert.ok(c.models[m], `${p}: ${m} is named but not defined`);
  }
  const review = project();
  adopt('--profile', 'review', '--target', review);
  const r = JSON.parse(fs.readFileSync(path.join(review, 'harness.json'), 'utf8')).reviewer;
  assert.equal(r.hard, null);
  assert.equal(r.sol, null);
});

test('a file the project already has with other content stops everything; an identical one is left alone', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n');
  const r = adopt('--profile', 'review', '--target', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Nothing written: .* already has CLAUDE\.md, with other content/);
  assert.deepEqual(files(dir), ['CLAUDE.md']);
  const same = project();
  fs.mkdirSync(path.join(same, 'docs'));
  fs.copyFileSync(path.join(repo, 'profiles/review/docs/environment.md'), path.join(same, 'docs/environment.md'));
  const s = adopt('--profile', 'review', '--target', same);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(adopt('--profile', 'review', '--target', same).status, 1);         // a second run meets its own lock
});

test('a dry run writes nothing; a bad profile or a directory outside git is a usage error', () => {
  const dir = project();
  const r = adopt('--profile', 'review', '--target', dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would write tools\/harness\/review\.mjs/);
  assert.deepEqual(files(dir), []);
  assert.equal(adopt('--profile', 'tiny', '--target', dir).status, 2);
  assert.equal(adopt('--profile', 'review', '--target', fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nogit-'))).status, 2);
});

test('the full profile copies the whole template', () => {
  const dir = project();
  const r = adopt('--profile', 'full', '--target', dir);
  assert.equal(r.status, 0, r.stderr);
  const all = files(path.join(repo, 'template'));
  assert.deepEqual(files(dir), [...all, 'harness.lock'].sort());
  assert.equal(verify(dir), all.length - 1);
});

test('a file where a directory belongs, or a symlink, stops everything before a write (Sol\'s R1, R2 on PR 42)', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'docs'), 'a file\n');                            // where docs/ must go
  const r = adopt('--profile', 'review', '--target', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs \(not a directory\)/);
  assert.deepEqual(files(dir), ['docs']);
  const link = project();
  fs.mkdirSync(path.join(link, 'tools/harness'), { recursive: true });
  fs.symlinkSync('switch-model.mjs', path.join(link, 'tools/harness/review.mjs')); // dangling, onto another of its files
  const s = adopt('--profile', 'review', '--target', link);
  assert.equal(s.status, 1);
  assert.match(s.stderr, /tools\/harness\/review\.mjs \(a symlink\)/);
  assert.equal(fs.existsSync(path.join(link, 'tools/harness/switch-model.mjs')), false);
  const outside = project();
  fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-elsewhere-')), path.join(outside, 'tools'));
  const t = adopt('--profile', 'review', '--target', outside);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /tools \(not a directory\)/);
});

test('a write that fails removes what the run wrote', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.opencode'), { mode: 0o500 });                   // its agent cannot be written
  const r = adopt('--profile', 'review', '--target', dir);
  fs.chmodSync(path.join(dir, '.opencode'), 0o700);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /What this run had written was removed/);
  assert.deepEqual(files(dir), []);
  assert.equal(fs.existsSync(path.join(dir, 'tools')), false);
});

test('installed files keep the template\'s executable bit (Sol\'s R3 on PR 42)', { skip: process.platform === 'win32' }, () => {
  const dir = project();
  assert.equal(adopt('--profile', 'full', '--target', dir).status, 0);
  const hook = '.claude/hooks/session-start.sh';
  assert.equal(fs.statSync(path.join(dir, hook)).mode & 0o111, fs.statSync(path.join(repo, 'template', hook)).mode & 0o111);
  assert.notEqual(fs.statSync(path.join(dir, hook)).mode & 0o100, 0);
});

test('the review profile\'s environment guide is its own: its reviewers, no Claude reviewer, no Jev (Sol\'s R4 on PR 42)', () => {
  const dir = project();
  assert.equal(adopt('--profile', 'review', '--target', dir).status, 0);
  const env = fs.readFileSync(path.join(dir, 'docs/environment.md'), 'utf8');
  for (const m of profile.harness.models) assert.match(env, new RegExp(template.models[m].id.replace(/[.]/g, '\\.')));
  assert.match(env, /there is no Claude reviewer here/);
  assert.doesNotMatch(env, /Jev|session-start|falls back to Claude/);
});

test('a write that fails part-way, in a directory that was already there, is removed too (Sol\'s R1 on PR 42, round 2)', { skip: process.platform === 'win32' }, () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'tools/harness'), { recursive: true });
  // A 1-block file size limit: the first large file fails after it was created.
  const r = spawnSync('bash', ['-c', `ulimit -f 1; exec "${process.execPath}" "${path.join(repo, 'adopt.mjs')}" --profile review --target "${dir}"`], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /What this run had written was removed/);
  assert.deepEqual(files(dir), []);
  assert.equal(adopt('--profile', 'review', '--target', dir).status, 0);          // a retry is not blocked
});

test('harness.lock says how to bump: set the lock and its files aside, and adopt again', () => {
  const dir = project();
  assert.equal(adopt('--profile', 'review', '--target', dir).status, 0);
  const lock = fs.readFileSync(path.join(dir, 'harness.lock'), 'utf8');
  assert.match(lock, /move this file and every file it lists aside, run adopt\.mjs at the new commit/);
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-aside-'));
  for (const f of [...lock.matchAll(/^(?:[0-9a-f]{64} {2}|adapt )(.+)$/gm)].map((m) => m[1]).concat('harness.lock')) {
    fs.mkdirSync(path.dirname(path.join(aside, f)), { recursive: true });
    fs.renameSync(path.join(dir, f), path.join(aside, f));
  }
  assert.equal(adopt('--profile', 'review', '--target', dir).status, 0);
});
