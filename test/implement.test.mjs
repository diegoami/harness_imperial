// implement.mjs end to end: a local bare repository as origin, a main checkout, and fakes for
// opencode and gh. Nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessions } from './fake-state.mjs';

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
  config.models.spare = { id: 'opencode-go/spare-model', variant: 'high', family: 'spare' };   // a third model, tests only
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
      FAKE_OC_STATE: path.join(p.base, 'oc.json'), FAKE_GH_STATE: p.ghState,
      HARNESS_OPENCODE_HOME: path.join(p.base, 'oc-home'), HARNESS_OPENCODE_AUTH_SOURCE: path.join(p.base, 'auth.json'),
      ...env,
    },
  });
}

const posix = { skip: process.platform === 'win32' };

test('the implementer does not inherit the reviewer\'s OpenCode settings (L34)', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_DIR: path.join(p.base, 'elsewhere') });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  assert.equal(session.projectConfig, 'read');
  assert.equal(session.agentFile, path.join(p.base, 'proj-work', 'T07', '.opencode', 'agents', 'implementer.md'));
});

test('a task runs to an open PR, in its own worktree, with the agent kept out of git', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /implemented by: deepseek-flash \(opencode-go\/deepseek-v4.1-flash\)/);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  assert.equal(session.dataHome, path.join(p.base, 'oc-home', 'data'));                // its own data directory
  assert.match(r.stdout, /PR: https:\/\/example.com\/pr\/100/);
  const wt = path.join(p.base, 'proj-work', 'T07');
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');           // detached for the reviewer
  assert.equal(git(p.origin, 'rev-parse', 'task/T07-calendar'), git(wt, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(path.join(wt, '.opencode/agents/implementer.md')));
  assert.equal(git(wt, 'status', '--porcelain'), '');                           // the copy is excluded
  assert.equal(git(p.main, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');       // main checkout untouched
});

test('a model on watch says what to look for, on the console and in the run log; others say nothing (L35)', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS: '["zai-coding-plan/glm-5.3"]' }, '--model', 'glm');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const line = /watch: glm \(zai-coding-plan\/glm-5\.3\) is on watch: .*exit 0 with no commit/;
  assert.match(r.stdout, line);
  assert.match(fs.readFileSync(path.join(p.base, 'proj-work', 'T07.implementer.log'), 'utf8'), line);
  const q = project();
  const plain = implement(q, { FAKE_OC_MODE: 'implement' });
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  assert.doesNotMatch(plain.stdout, /watch:/);
});

test('an implementer that stops and reports is not retried, and exits 1', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'stop-report' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
  assert.match(r.stdout, /Done-when 2 cannot be met/);
  assert.match(r.stderr, /No open PR/);
});

test('a failure that left a commit is not retried on the next model', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'commit-fail' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
  assert.match(r.stderr, /not retrying/);
});

test('an infrastructure failure that left nothing falls back to the next model', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/deepseek-v4.1-flash': 'exit-no-session', 'openai/gpt-6-luna': 'implement' }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /fell back: deepseek-flash: exited without a session/);
  assert.match(r.stdout, /implemented by: luna/);
});

test('a rejected tool call is a failure, not a clean finish: the next model runs (IC2 #501)', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/deepseek-v4.1-flash': 'permission', 'openai/gpt-6-luna': 'implement' }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /fell back: deepseek-flash: permission rejected: external_directory \(\/tmp\/\*\)/);
  assert.match(r.stdout, /implemented by: luna/);
});

test('a rejection from cd or .. says so in the failure, naming L31 (#14)', posix, async () => {
  const p = project({ chain: ['deepseek-flash'] });
  const r = implement(p, { FAKE_OC_MODE: 'permission-cd' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /permission rejected: external_directory \(\/tmp\/\*\); the rejected command used cd or \.\.: run commands from the worktree root.*\(L31\)/);
});

test('the same failure twice stops the chain with exit 3', posix, async () => {
  const p = project({ chain: ['deepseek-flash', 'spare', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'no-session' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /same failure twice: no-session/);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
});

test('a model OpenCode does not list exits 3 with the fallback, before any worktree or run', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS: '["opencode-go/spare-model"]' });
  assert.equal(r.status, 3);
  assert.match(r.stdout + r.stderr, /deepseek-flash: opencode-go\/deepseek-v4.1-flash is not in `opencode models opencode-go`/);
  assert.match(r.stderr, /Fall back to a Claude implementer \(sonnet\)/);
  assert.equal(fs.existsSync(path.join(p.base, 'proj-work', 'T07')), false);
});

test('OpenCode Go not logged in: exit 3 with the login command for the scripts\' data directory', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS: '["openai/gpt-6-luna"]' });
  assert.equal(r.status, 3);
  const home = path.join(p.base, 'oc-home', 'data');
  assert.ok((r.stdout + r.stderr).includes(`OpenCode Go is not logged in for ${home}. Run \`opencode console login\` with XDG_DATA_HOME=${home}`));
  assert.match(r.stderr, /Fall back to a Claude implementer \(sonnet\)/);
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
});

test('a 2.x OpenCode (the desktop app\'s CLI) exits 3 with the fallback, before any worktree or run (#26)', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_VERSION: '2.0.18' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /OpenCode 2\.0\.18 at .* is not supported.*Fall back to a Claude implementer \(sonnet\)/);
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
  assert.equal(fs.existsSync(path.join(p.base, 'proj-work', 'T07')), false);
  const ok = implement(project(), { FAKE_OC_MODE: 'implement' });
  assert.match(ok.stdout, /^opencode: 1\.18\.34 \(/m);                             // the version is logged
});

test('OpenCode missing exits 3 before touching anything', posix, async () => {
  const p = project();
  const r = implement(p, { HARNESS_OPENCODE_EXE: '/no/such/opencode' });
  assert.equal(r.status, 3);
  assert.equal(fs.existsSync(path.join(p.base, 'proj-work')), false);
});
