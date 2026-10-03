#!/usr/bin/env node
// Installs harness_imperial into a project, by profile (#39):
//
//   node adopt.mjs --profile full|review --target <project> [--dry-run]
//
// - full: everything under template/, as README.md's "In a project" copies it.
// - review: only the reviewer (profiles/review/profile.json): review.mjs and its library, the
//   reviewer agent, a harness.json with the profile's reviewers and no implementer, and the
//   profile's CLAUDE.md and docs/review.md. The main session plans and implements (L37).
//
// Nothing is overwritten: a file the project already has with other content is a conflict, and so
// is a symlink, or a file or symlink where a directory is needed. Any conflict exits 1 before
// anything is written, and a write that fails removes what this run wrote. A file already identical
// is left alone. Files keep the template's executable bit. The
// project gets harness.lock: the commit and profile copied, the files to adapt, and the sha256 of
// every other file written, with the command that verifies them.
//
// Exit 0: installed (or a dry run). Exit 1: conflicts, nothing written. Exit 2: usage.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const template = path.join(root, 'template');
const say = (s) => console.log(s);
const die = (code, s) => { console.error(s); process.exit(code); };
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const profile = opt('profile');
const target = opt('target') && path.resolve(opt('target'));
const dryRun = args.includes('--dry-run');
const profiles = fs.readdirSync(path.join(root, 'profiles'));
if (!target || !['full', ...profiles].includes(profile)) {
  die(2, `Usage: node adopt.mjs --profile ${['full', ...profiles].join('|')} --target <project> [--dry-run]`);
}
if (git(target, 'rev-parse', '--show-toplevel').status !== 0) die(2, `${target} is not a git repository.`);

// Every file of the template, as paths relative to it.
const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
  const r = path.posix.join(rel, e.name);
  return e.isDirectory() ? walk(dir, r) : [r];
});

// The plan: each file the project gets, with its content and mode (the executable bit kept: the
// full profile's session-start hook is run directly, Sol's R3 on PR 42).
const plan = [];
const from = (dir, f) => ({ path: f, content: fs.readFileSync(path.join(dir, f)), mode: fs.statSync(path.join(dir, f)).mode & 0o777 });
let adapt = [];
if (profile === 'full') {
  for (const f of walk(template)) plan.push(from(template, f));
  adapt = ['CLAUDE.md'];
} else {
  const dir = path.join(root, 'profiles', profile);
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  for (const f of p.files) plan.push(from(template, f));
  for (const f of p.overlay) plan.push(from(dir, f));
  // harness.json from the template's, so a model's id and watch note never drift from it.
  const t = JSON.parse(fs.readFileSync(path.join(template, 'harness.json'), 'utf8'));
  const config = {
    worktreeRoot: t.worktreeRoot,
    models: Object.fromEntries(p.harness.models.map((m) => [m, t.models[m]])),
    reviewer: { ...t.reviewer, ...p.harness.reviewer },
  };
  plan.push({ path: 'harness.json', content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`), mode: 0o644 });
  adapt = p.adapt;
}

const commit = git(root, 'rev-parse', 'HEAD').stdout.trim();
// --no-optional-locks: status never writes the index, so a run that fails (a size limit) leaves no index.lock.
const dirty = git(root, '--no-optional-locks', 'status', '--porcelain', '--', 'template', 'profiles', 'adopt.mjs').stdout.trim();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const lock = [
  `# harness.lock: what this repository copied from diegoami/harness_imperial (profile ${profile}).`,
  '# A bump: move this file and every file it lists aside, run adopt.mjs at the new commit,',
  '# then carry your changes to the adapted files (and any other) over to the new copies.',
  "# Verify:  grep -E '^[0-9a-f]{64}  ' harness.lock | sha256sum -c --quiet",
  `commit ${commit}${dirty ? ' (with uncommitted changes)' : ''}`,
  `profile ${profile}`,
  `copied ${new Date().toISOString().slice(0, 10)}`,
  ...adapt.map((f) => `adapt ${f}`),
  ...plan.filter((f) => !adapt.includes(f.path)).map((f) => `${sha(f.content)}  ${f.path}`),
].join('\n');
plan.push({ path: 'harness.lock', content: Buffer.from(`${lock}\n`), mode: 0o644 });

// What is at a path, without following a symlink (a dangling one included, Sol's R2 on PR 42).
const at = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const conflicts = new Set();
const same = [];
for (const f of plan) {
  // Every directory on the way must be a real directory or absent (Sol's R1 on PR 42).
  const parts = f.path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const s = at(path.join(target, ...parts.slice(0, i)));
    if (s && (s.isSymbolicLink() || !s.isDirectory())) conflicts.add(`${parts.slice(0, i).join('/')} (not a directory)`);
  }
  const s = at(path.join(target, f.path));
  if (!s) continue;
  if (s.isSymbolicLink()) conflicts.add(`${f.path} (a symlink)`);
  else if (!s.isFile()) conflicts.add(`${f.path} (not a file)`);
  else if (f.path !== 'harness.lock' && fs.readFileSync(path.join(target, f.path)).equals(f.content)) same.push(f.path);
  else conflicts.add(f.path);
}
if (conflicts.size) {
  die(1, `Nothing written: ${target} already has ${[...conflicts].join(', ')}, with other content or of another kind. Merge them by hand, or move them aside and run again.`);
}
const writes = plan.filter((f) => !same.includes(f.path));
if (dryRun) {
  for (const f of writes) say(`would write ${f.path}`);
  for (const f of same) say(`identical, left alone: ${f}`);
  say(`dry run: profile ${profile} at ${commit.slice(0, 7)}; nothing written.`);
  process.exit(0);
}
// A failed write removes what this run wrote and the directories it made, so nothing is half done.
const made = [];
try {
  for (const f of writes) {
    const dest = path.join(target, f.path);
    const dir = fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (dir) made.push({ dir });
    // Created first and recorded, then written: a write that fails part-way (a full disk, a size
    // limit) is still removed (Sol's R1 on PR 42, round 2).
    const fd = fs.openSync(dest, 'wx', f.mode);
    made.push({ file: dest });
    try {
      // writeSync may write less than asked (a size limit): write the rest, and fail on no progress.
      for (let off = 0; off < f.content.length;) {
        const n = fs.writeSync(fd, f.content, off);
        if (n <= 0) throw new Error(`could not write ${f.path} past byte ${off}`);
        off += n;
      }
    } finally { fs.closeSync(fd); }
    fs.chmodSync(dest, f.mode);
  }
} catch (e) {
  for (const m of made.reverse()) fs.rmSync(m.file ?? m.dir, { recursive: true, force: true });
  die(1, `Nothing written: ${e.message}. What this run had written was removed.`);
}
say(`wrote ${writes.length} files (profile ${profile}, harness_imperial ${commit.slice(0, 7)}${dirty ? ', with uncommitted changes' : ''}).`);
say(`Next: fill in ${adapt.join(', ')}; log in as docs/environment.md says; run`
  + ' `node tools/harness/review.mjs --self-test`; commit on a branch and open a PR.');
