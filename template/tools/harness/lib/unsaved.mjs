// The reset between implementer attempts, and the save before it (#87, ported from
// isle-wars-archaeology 8377ece). On isle-wars T13 round 3 an implementer edited files without
// committing, a rejected tool call ended its run, and the reset (git reset --hard; git clean -fd)
// discarded about 435 lines, twice: leftWork counts only commits, pushes and PRs. Now, before the
// reset destroys the worktree's state, what the attempt left uncommitted is written to one binary
// patch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sh } from './common.mjs';

/**
 * Saves the worktree's uncommitted changes (staged, unstaged and untracked) against the run's start
 * commit, to <workRoot>/<name>.<model key>.<UTC time>.unsaved.patch: a file created exclusively
 * ('.1', '.2', … if the same millisecond ever collides), never an overwrite. Logs its path. Returns
 * the patch's path, or null when the worktree is clean: nothing changed, no file. `stamp` is for tests.
 */
export function saveUnsavedWork({ worktree, startSha, workRoot, name, model, log = () => {}, stamp = new Date() }) {
  if (!sh('git', ['-C', worktree, 'status', '--porcelain'])) return null;
  sh('git', ['-C', worktree, 'add', '-A']);
  // sh() trims stdout, which would corrupt a patch's last line: the diff goes through its own
  // spawn, raw and binary-safe.
  const d = spawnSync('git', ['-C', worktree, 'diff', '--cached', '--binary', startSha], { encoding: 'buffer' });
  if (d.error) throw new Error(`git diff could not run: ${d.error.message}`);
  if (d.status !== 0) throw new Error(`git diff --cached --binary ${startSha} failed (${d.status}):\n${d.stderr}`);
  const stampText = stamp.toISOString().replaceAll(':', '-');
  fs.mkdirSync(workRoot, { recursive: true });
  for (let i = 0; ; i++) {
    const file = path.join(workRoot, `${name}.${model}.${stampText}${i ? `.${i}` : ''}.unsaved.patch`);
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, d.stdout); } finally { fs.closeSync(fd); }
      log(`unsaved work saved to: ${file}`);
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST' || i >= 100) throw e;
    }
  }
}

/**
 * The reset between chain attempts: first save what the failed attempt left uncommitted, then
 * hard-reset to the start commit and drop untracked files, as before. Returns the patch's path, or
 * null when there was nothing to save.
 */
export function resetWorktree({ worktree, startSha, workRoot, name, model, log, stamp }) {
  const patch = saveUnsavedWork({ worktree, startSha, workRoot, name, model, log, stamp });
  sh('git', ['-C', worktree, 'reset', '-q', '--hard', startSha]);
  sh('git', ['-C', worktree, 'clean', '-q', '-fd']);
  return patch;
}

// implement.mjs --self-test: the reset's save on a throwaway repository, with no OpenCode, gh or
// network. A tracked change and an untracked file survive in one patch that applies cleanly to the
// start commit; a clean worktree writes no file; a save never overwrites an earlier one. Returns
// the failures; fails when the save is removed.
export function selfTest() {
  const failures = [];
  const ok = (what, cond) => { if (!cond) failures.push(what); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-selftest-'));
  const saves = path.join(dir, 'saves');        // outside the repository, as workRoot always is
  const repo = path.join(dir, 'repo');
  try {
    fs.mkdirSync(repo);
    const git = (...args) => sh('git', ['-C', repo, ...args]);
    git('init', '-q');
    git('config', 'user.email', 'selftest@invalid');
    git('config', 'user.name', 'selftest');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'start');
    const startSha = git('rev-parse', 'HEAD');
    const reset = (o) => resetWorktree({ worktree: repo, startSha, workRoot: saves, name: 'selftest', model: 'test-model', ...o });
    const stamp = new Date('2026-10-05T12:00:00Z');
    const want = path.join(saves, 'selftest.test-model.2026-10-05T12-00-00.000Z.unsaved.patch');

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'fresh\n');
    const patch = reset({ stamp });
    ok(`the patch is written where the naming says (${patch})`, patch === want && fs.existsSync(want));
    if (patch !== want || !fs.existsSync(want)) return failures;
    ok('the worktree is clean after the reset', git('status', '--porcelain') === '');
    try { git('apply', '--check', want); git('apply', want); } catch (e) { failures.push(`the patch does not apply cleanly: ${e.message}`); }
    ok('the tracked change is restored', fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8') === 'one\ntwo\n');
    ok('the untracked file is restored', fs.existsSync(path.join(repo, 'untracked.txt')) && fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8') === 'fresh\n');

    reset({ stamp: new Date('2026-10-05T12:00:01Z') });                   // the applied patch, saved again
    ok('a clean worktree writes no file', reset({ stamp }) === null && fs.readdirSync(saves).length === 2);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
    const second = reset({ stamp });                                         // the first name is taken
    ok(`a second save takes another name, never an overwrite (${second})`,
      second === path.join(saves, 'selftest.test-model.2026-10-05T12-00-00.000Z.1.unsaved.patch'));
    ok('the first patch is intact', fs.readFileSync(want, 'utf8').includes('two') && !fs.readFileSync(want, 'utf8').includes('three'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failures;
}
