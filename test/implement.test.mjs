// implement.mjs end to end: a local bare repository as origin, a main checkout, and fakes for
// opencode and gh. Nothing leaves the machine.
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

function project(harness = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-impl-')));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'proj');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['clone', '-q', origin, main]);
  fs.mkdirSync(path.join(main, '.opencode', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(root, '.opencode/agents/implementer.md'), path.join(main, '.opencode/agents/implementer.md'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8'));
  config.implementer = { ...config.implementer, startupTimeoutSec: 2, idleTimeoutSec: 5, totalTimeoutSec: 20, ...harness };
  fs.writeFileSync(path.join(main, 'harness.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(main, 'README.md'), 'project\n');
  git(main, 'add', '.');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  git(main, 'push', '-q', 'origin', 'main');
  // Agents' commits in the worktree need an identity.
  git(main, 'config', 'user.name', 't');
  git(main, 'config', 'user.email', 't@example.com');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(here, 'fake-gh.mjs'), path.join(bin, 'gh'));
  const ghState = path.join(base, 'gh.json');
  fs.writeFileSync(ghState, JSON.stringify({ prs: [] }));
  fs.writeFileSync(path.join(base, 'brief.md'), 'Implement T07.\n');
  return { base, main, origin, ghState };
}

function implement(p, env, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'tools/harness/implement.mjs'),
    '--task', 'T07', '--slug', 'calendar', '--issue', '12', '--brief', path.join(p.base, 'brief.md'), ...args], {
    cwd: p.main, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${path.join(p.base, 'bin')}${path.delimiter}${process.env.PATH}`,
      HARNESS_OPENCODE_EXE: path.join(here, 'fake-opencode.mjs'),
      FAKE_OC_STATE: path.join(p.base, 'oc.json'), FAKE_GH_STATE: p.ghState, ...env,
    },
  });
}

const posix = { skip: process.platform === 'win32' };

test('a task runs to an open PR, in its own worktree, with the agent kept out of git', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /implemented by: glm-flash \(opencode-go\/glm-5.3-flash\)/);
  assert.match(r.stdout, /PR: https:\/\/example.com\/pr\/100/);
  const wt = path.join(p.base, 'proj-work', 'T07');
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');           // detached for the reviewer
  assert.equal(git(p.origin, 'rev-parse', 'task/T07-calendar'), git(wt, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(path.join(wt, '.opencode/agents/implementer.md')));
  assert.equal(git(wt, 'status', '--porcelain'), '');                           // the copy is excluded
  assert.equal(git(p.main, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');       // main checkout untouched
});

test('an implementer that stops and reports is not retried, and exits 1', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'glm-flash'] });
  const r = implement(p, { FAKE_OC_MODE: 'stop-report' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /attempt: glm/);
  assert.match(r.stdout, /Done-when 2 cannot be met/);
  assert.match(r.stderr, /No open PR/);
});

test('a failure that left a commit is not retried on the next model', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'glm-flash'] });
  const r = implement(p, { FAKE_OC_MODE: 'commit-fail' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /attempt: glm/);
  assert.match(r.stderr, /not retrying/);
});

test('an infrastructure failure that left nothing falls back to the next model', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'glm-flash'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/deepseek-v4.1-flash': 'exit-no-session', 'opencode-go/glm-5.3-flash': 'implement' }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /fell back: deepseek-flash: exited without a session/);
  assert.match(r.stdout, /implemented by: glm/);
});

test('a rejected tool call is a failure, not a clean finish: the next model runs (IC2 #501)', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'glm-flash'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/deepseek-v4.1-flash': 'permission', 'opencode-go/glm-5.3-flash': 'implement' }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /fell back: deepseek-flash: permission rejected: external_directory \(\/tmp\/\*\)/);
  assert.match(r.stdout, /implemented by: glm/);
});

test('the same failure twice stops the chain with exit 3', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'luna', 'glm-flash'] });
  const r = implement(p, { FAKE_OC_MODE: 'no-session' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /same failure twice: no-session/);
  assert.doesNotMatch(r.stdout, /attempt: glm/);
});

test('OpenCode missing exits 3 before touching anything', posix, async () => {
  const p = project();
  const r = implement(p, { HARNESS_OPENCODE_EXE: '/no/such/opencode' });
  assert.equal(r.status, 3);
  assert.equal(fs.existsSync(path.join(p.base, 'proj-work')), false);
});
