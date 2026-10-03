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

test('a file the project already has with other content stops everything; an identical one is left alone', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n');
  const r = adopt('--profile', 'review', '--target', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Nothing written: .* already has CLAUDE\.md with other content/);
  assert.deepEqual(files(dir), ['CLAUDE.md']);
  const same = project();
  fs.mkdirSync(path.join(same, 'docs'));
  fs.copyFileSync(path.join(repo, 'template/docs/environment.md'), path.join(same, 'docs/environment.md'));
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
