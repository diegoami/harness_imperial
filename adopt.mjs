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
// Nothing is overwritten: a file the project already has with other content is a conflict, and
// any conflict exits 1 before anything is written. A file already identical is left alone. The
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

// The plan: each file the project gets, with its content.
const plan = [];
let adapt = [];
if (profile === 'full') {
  for (const f of walk(template)) plan.push({ path: f, content: fs.readFileSync(path.join(template, f)) });
  adapt = ['CLAUDE.md'];
} else {
  const dir = path.join(root, 'profiles', profile);
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  for (const f of p.files) plan.push({ path: f, content: fs.readFileSync(path.join(template, f)) });
  for (const f of p.overlay) plan.push({ path: f, content: fs.readFileSync(path.join(dir, f)) });
  // harness.json from the template's, so a model's id and watch note never drift from it.
  const t = JSON.parse(fs.readFileSync(path.join(template, 'harness.json'), 'utf8'));
  const config = {
    worktreeRoot: t.worktreeRoot,
    models: Object.fromEntries(p.harness.models.map((m) => [m, t.models[m]])),
    reviewer: { ...t.reviewer, ...p.harness.reviewer },
  };
  plan.push({ path: 'harness.json', content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`) });
  adapt = p.adapt;
}

const commit = git(root, 'rev-parse', 'HEAD').stdout.trim();
const dirty = git(root, 'status', '--porcelain', '--', 'template', 'profiles', 'adopt.mjs').stdout.trim();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const lock = [
  `# harness.lock: what this repository copied from diegoami/harness_imperial (profile ${profile}).`,
  '# A bump runs adopt.mjs again at the new commit, after setting the adapted files aside.',
  "# Verify:  grep -E '^[0-9a-f]{64}  ' harness.lock | sha256sum -c --quiet",
  `commit ${commit}${dirty ? ' (with uncommitted changes)' : ''}`,
  `profile ${profile}`,
  `copied ${new Date().toISOString().slice(0, 10)}`,
  ...adapt.map((f) => `adapt ${f}`),
  ...plan.filter((f) => !adapt.includes(f.path)).map((f) => `${sha(f.content)}  ${f.path}`),
].join('\n');
plan.push({ path: 'harness.lock', content: Buffer.from(`${lock}\n`) });

const conflicts = [];
const same = [];
for (const f of plan) {
  const dest = path.join(target, f.path);
  if (!fs.existsSync(dest)) continue;
  if (f.path !== 'harness.lock' && fs.readFileSync(dest).equals(f.content)) same.push(f.path);
  else conflicts.push(f.path);
}
if (conflicts.length) {
  die(1, `Nothing written: ${target} already has ${conflicts.join(', ')} with other content. Merge them by hand, or move them aside and run again.`);
}
const writes = plan.filter((f) => !same.includes(f.path));
if (dryRun) {
  for (const f of writes) say(`would write ${f.path}`);
  for (const f of same) say(`identical, left alone: ${f}`);
  say(`dry run: profile ${profile} at ${commit.slice(0, 7)}; nothing written.`);
  process.exit(0);
}
for (const f of writes) {
  fs.mkdirSync(path.dirname(path.join(target, f.path)), { recursive: true });
  fs.writeFileSync(path.join(target, f.path), f.content);
}
say(`wrote ${writes.length} files (profile ${profile}, harness_imperial ${commit.slice(0, 7)}${dirty ? ', with uncommitted changes' : ''}).`);
say(`Next: fill in ${adapt.join(', ')}; log in as docs/environment.md says; run`
  + ' `node tools/harness/review.mjs --self-test`; commit on a branch and open a PR.');
