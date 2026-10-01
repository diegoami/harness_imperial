import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runOpenCodeWatched, OpenCodeInfraError, failureClass, agentWarning, permissionRejection, resolveOpenCode,
} from '../template/tools/harness/lib/opencode.mjs';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-opencode.mjs');
const opencode = { exe: process.execPath, prefix: [fake] };

function setup(mode, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-oc-'));
  const env = { ...process.env, FAKE_OC_STATE: path.join(dir, 'state.json'), FAKE_OC_MODE: mode, ...extra };
  return { dir, env };
}

const run = (mode, opts = {}, extra = {}) => {
  const { dir, env } = setup(mode, extra);
  return runOpenCodeWatched({
    args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'line one\nline two',
    workDir: dir, title: 'test', opencode, env, logDir: path.join(dir, 'logs'),
    pollMs: 50, startupTimeoutMs: 1500, idleTimeoutMs: 800, totalTimeoutMs: 5000, ...opts,
  });
};

const infra = (reasonRe) => (e) => e instanceof OpenCodeInfraError && reasonRe.test(e.reason);

test('a normal run returns its output, exit code and session', async () => {
  const r = await run('ok', {}, { FAKE_OC_STEPS: '3' });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /done/);
  assert.match(r.sessionId, /^ses_/);
  assert.equal(r.agentFallback, false);
  assert.deepEqual(r.files, []);
});

test('stdin is closed: a run that waits for stdin EOF still starts (IC2 #490)', async () => {
  const r = await run('read-stdin');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /after stdin EOF/);
});

test('no session within the startup timeout kills the run', async () => {
  await assert.rejects(run('no-session', { startupTimeoutMs: 400 }), infra(/^no session in/));
});

test('a killed run takes its whole process tree with it', { skip: process.platform === 'win32' }, async () => {
  const { dir } = setup('x');
  const pidFile = path.join(dir, 'grandchild.pid');
  await assert.rejects(run('no-session', { startupTimeoutMs: 400 }, { FAKE_OC_PIDFILE: pidFile }), infra(/^no session in/));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 200));
  // Gone, or a zombie waiting to be reaped (a container's PID 1 may never reap it): not running.
  let state = 'gone';
  try { state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]; } catch { /* gone */ }
  if (process.platform !== 'linux') { try { process.kill(pid, 0); state = 'running'; } catch { /* gone */ } }
  assert.ok(state === 'gone' || state === 'Z', `grandchild ${pid} is still running (state ${state})`);
});

test('a session whose updated time stops advancing is killed as idle', async () => {
  await assert.rejects(run('idle', { idleTimeoutMs: 600 }), infra(/^session idle for/));
});

test('a session that keeps making progress is not idle, but the total deadline still holds', async () => {
  await assert.rejects(run('slow', { idleTimeoutMs: 600, totalTimeoutMs: 1500 }), infra(/^no exit in/));
});

test('steps that keep advancing updated survive an idle limit shorter than the whole run', async () => {
  // The run (about 2 s) outlasts the idle limit (1.5 s), so a watch that never saw progress fails
  // this. The margin leaves room for a slow session lookup on a loaded machine.
  const r = await run('ok', { idleTimeoutMs: 1500, totalTimeoutMs: 10000 }, { FAKE_OC_STEPS: '20', FAKE_OC_STEP_MS: '100' });
  assert.equal(r.exitCode, 0);
});

test('a run that exits without creating a session is an infrastructure failure', async () => {
  await assert.rejects(run('exit-no-session'), infra(/^exited without a session/));
});

test('a non-zero exit is returned, not thrown, and its files are kept', async () => {
  const r = await run('exit2');
  assert.equal(r.exitCode, 2);
  assert.equal(r.files.length, 2);
  for (const f of r.files) assert.ok(fs.existsSync(f));
});

test('the fallback to the default agent is read from the session record', async () => {
  const r = await run('fallback');
  assert.equal(r.agentFallback, true);
  assert.equal(r.sessionAgent, 'build');
});

test('a large export is read whole: the agent check does not depend on a pipe', async () => {
  const r = await run('ok', {}, { FAKE_OC_BIG_EXPORT: '1' });
  assert.equal(r.sessionAgent, 'reviewer');
  assert.equal(r.agentFallback, false);
});

test('a model quoting the fallback warning is not a fallback (IC2 #482)', async () => {
  const r = await run('quote');
  assert.equal(r.agentFallback, false);
  assert.equal(r.sessionAgent, 'reviewer');
});

test('a run that exits 0 after OpenCode rejected a tool call reports it, and keeps its files (IC2 #501)', async () => {
  const r = await run('permission');
  assert.equal(r.exitCode, 0);
  assert.equal(r.permissionRejected, 'external_directory (/tmp/*)');
  assert.equal(r.files.length, 2);
});

test('a model quoting the rejection line is not a rejection', async () => {
  const r = await run('ok', {}, { FAKE_OC_OUTPUT: 'R1: the guard matches "! permission requested: external_directory (/tmp/*); auto-rejecting"\n' });
  assert.equal(r.permissionRejected, null);
});

test('output is read back as UTF-8', async () => {
  const r = await run('utf8');
  assert.match(r.stdout, /em — dash, ü, “quotes”/);
});

test('agentWarning matches only OpenCode\'s own line for the requested agent', () => {
  const line = '\x1b[93m\x1b[1m! \x1b[0m agent "reviewer" not found. Falling back to default agent';
  assert.equal(agentWarning(line, 'reviewer'), true);
  assert.equal(agentWarning(line, 'implementer'), false);
  assert.equal(agentWarning(`R1: ${line}`, 'reviewer'), false);
});

test('failureClass strips the numbers from a reason', () => {
  assert.equal(failureClass('no session in 180 s'), failureClass('no session in 30 s'));
  assert.equal(failureClass('session idle for 600 s'), 'idle');
  assert.equal(failureClass('exit 2'), 'non-zero-exit');
  assert.equal(failureClass('review cut off'), 'cut-off');
  assert.equal(failureClass('fell back to the default agent'), 'fallback-agent');
  assert.equal(failureClass('permission rejected: external_directory (/tmp/*)'), 'permission-rejected');
});

test('permissionRejection matches only OpenCode\'s own line, and returns the last one', () => {
  const line = (what) => `\x1b[93m\x1b[1m! \x1b[0mpermission requested: ${what}; auto-rejecting`;
  assert.equal(permissionRejection(`${line('external_directory (/a/*)')}\nok\n${line('external_directory (/b/*)')}`), 'external_directory (/b/*)');
  assert.equal(permissionRejection(`R1: ${line('external_directory (/a/*)')}`), null);
  assert.equal(permissionRejection('done\n'), null);
});

test('resolveOpenCode fails as an infrastructure failure when opencode is missing', () => {
  assert.throws(() => resolveOpenCode({ PATH: '' }), infra(/^opencode not found/));
  assert.throws(() => resolveOpenCode({ HARNESS_OPENCODE_EXE: '/no/such/opencode' }), infra(/^opencode not found/));
});

test('under WSL the Windows npm shim is skipped for OpenCode\'s own install in ~/.opencode/bin', { skip: process.platform === 'win32' }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-')));
  const shimDir = path.join(home, 'npm');
  fs.mkdirSync(shimDir);
  // What WSL sees of the Windows npm shim, on PATH under /mnt/c.
  fs.writeFileSync(path.join(shimDir, 'opencode'), '#!/bin/sh\nexec "$basedir/node_modules/opencode-ai/bin/opencode.exe"   "$@"\n', { mode: 0o755 });
  assert.throws(() => resolveOpenCode({ PATH: shimDir }), infra(/^opencode not found/));
  const installed = path.join(home, '.opencode', 'bin', 'opencode');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveOpenCode({ PATH: shimDir, HOME: home }).exe, installed);
});
