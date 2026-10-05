import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessions } from './fake-state.mjs';
import {
  runOpenCodeWatched, lookupSession, OpenCodeInfraError, failureClass, agentWarning, permissionRejection, rejectionHint, resolveOpenCode,
  openCodeHome, listedModels, loginHint, keyProblem, openCodeVersion, versionProblem,
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

test('a run with no session logs and says why the last lookup missed it (#45)', async () => {
  const logs = [];
  await assert.rejects(run('exit-no-session', { log: (l) => logs.push(l) }), (e) => infra(/^exited without a session/)(e)
    && /\(last lookup: no session titled test-[0-9a-f]+ among the 0 listed\)/.test(e.message));
  assert.ok(logs.some((l) => /^opencode: session lookup missed: no session titled test-/.test(l)), logs.join('\n'));
  const slow = [];                                                               // the listing, not the match
  await assert.rejects(run('no-session', { startupTimeoutMs: 400, log: (l) => slow.push(l) }, { FAKE_OC_SESSION_SLEEP_MS: '5000' }),
    (e) => infra(/^no session in/)(e) && /last lookup: `session list` gave no result within \d+ ms/.test(e.message));
  assert.ok(slow.some((l) => /session lookup missed: `session list` gave no result/.test(l)), slow.join('\n'));
});

test('a session lookup that misses says why: the listing, its output, or the match (#45)', async () => {
  const { dir, env } = setup('ok');
  const startedMs = Date.now();
  const look = (extra = {}, opts = {}) => lookupSession(opencode, { workDir: dir, title: 't1', startedMs, timeoutMs: 5000, env: { ...env, ...extra }, ...opts });
  const save = (s) => fs.writeFileSync(env.FAKE_OC_STATE, JSON.stringify(s));
  assert.match((await look({}, { timeoutMs: 0 })).miss, /^no time left to list sessions$/);
  assert.match((await look({ FAKE_OC_SESSION_SLEEP_MS: '3000' }, { timeoutMs: 200 })).miss, /^`session list` gave no result within 200 ms/);
  assert.match((await look({ FAKE_OC_SESSION_OUTPUT: '', FAKE_OC_SESSION_STDERR: 'database is locked' })).miss,
    /^`session list` printed nothing \(exit 1\); stderr: database is locked$/);
  assert.match((await look({ FAKE_OC_SESSION_OUTPUT: 'Error: boom' })).miss, /^`session list` printed no JSON \(exit 1\): Error: boom$/);
  save([{ id: 'ses_a', title: 'other', directory: dir, created: startedMs }]);
  assert.match((await look()).miss, /^no session titled t1 among the 1 listed$/);
  save([{ id: 'ses_b', title: 't1', directory: '/elsewhere', created: startedMs }]);
  assert.match((await look()).miss, /^session ses_b titled t1 is in \/elsewhere, not /);
  save([{ id: 'ses_c', title: 't1', directory: dir, created: startedMs - 5000 }]);
  assert.match((await look()).miss, /^session ses_c titled t1 was created at \d+, before the run started at \d+$/);
  save([{ id: 'ses_d', title: 't1', directory: dir, created: startedMs }]);
  assert.deepEqual(await look(), { session: { id: 'ses_d', title: 't1', directory: dir, created: startedMs }, miss: null });
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

test('whether a tool call was rejected is read from the session record, not from text a tool printed (PR 35, PR 37)', async () => {
  const quoted = await run('permission-quoted');                    // a quoted line, a clean record
  assert.equal(quoted.permissionRejected, null);
  const plain = await run('permission-plain');                      // an uncoloured line, a rejection in the record
  assert.equal(plain.permissionRejected, 'external_directory (/tmp/*)');
  const noRecord = await run('permission-quoted', {}, { FAKE_OC_EXPORT_FAIL: '1' });   // no record: the text decides
  assert.equal(noRecord.permissionRejected, 'external_directory (<review-dir>/*)');
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
  assert.equal(failureClass('no review in its output'), 'no-review');
  assert.equal(failureClass('fell back to the default agent'), 'fallback-agent');
  assert.equal(failureClass('permission rejected: external_directory (/tmp/*)'), 'permission-rejected');
});

test('permissionRejection matches only OpenCode\'s own line, and returns the last one', () => {
  const line = (what) => `\x1b[93m\x1b[1m! \x1b[0mpermission requested: ${what}; auto-rejecting`;
  assert.equal(permissionRejection(`${line('external_directory (/a/*)')}\nok\n${line('external_directory (/b/*)')}`), 'external_directory (/b/*)');
  assert.equal(permissionRejection(`R1: ${line('external_directory (/a/*)')}`), null);
  assert.equal(permissionRejection('done\n'), null);
  // OpenCode's coloured line is preferred over a plain copy a tool printed (PR 35), for what and why.
  const quoted = `\x1b[0m$ \x1b[0mgh issue view 14\n! permission requested: external_directory (<review-dir>/*); auto-rejecting\n✗ cd a && ls failed\n`;
  assert.equal(permissionRejection(`${quoted}${line('external_directory (/b/*)')}\n✗ cat /b/x failed`), 'external_directory (/b/*)');
  assert.equal(rejectionHint(`${quoted}${line('external_directory (/b/*)')}\n✗ cat /b/x failed`), null);   // the quoted cd is not the rejected command
  // With no colour (NO_COLOR), the line is read plain.
  assert.equal(permissionRejection('! permission requested: external_directory (/c/*); auto-rejecting\n'), 'external_directory (/c/*)');
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

test('openCodeHome: data, cache and state of one root, a relative override made absolute', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-och-')));
  const lines = [];
  const prev = process.cwd();
  process.chdir(base);
  try {
    const { env, root, dataHome } = openCodeHome({ HOME: base, HARNESS_OPENCODE_HOME: 'oc', PATH: '/bin' }, { log: (l) => lines.push(l) });
    assert.equal(root, path.join(base, 'oc'));
    assert.equal(env.XDG_DATA_HOME, path.join(base, 'oc', 'data'));
    assert.equal(env.XDG_CACHE_HOME, path.join(base, 'oc', 'cache'));
    assert.equal(env.XDG_STATE_HOME, path.join(base, 'oc', 'state'));
    assert.equal(dataHome, env.XDG_DATA_HOME);
    assert.equal(env.PATH, '/bin');
    assert.ok(fs.existsSync(path.join(dataHome, 'opencode')));
    assert.match(lines[0], /no auth\.json/);
  } finally { process.chdir(prev); }
  assert.equal(process.env.XDG_DATA_HOME === path.join(base, 'oc', 'data'), false);   // process.env untouched
});

test('openCodeHome copies auth.json when the copy is missing or older, never over a newer one', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-och-')));
  const src = path.join(base, '.local', 'share', 'opencode', 'auth.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  const env = { HOME: base, HARNESS_OPENCODE_HOME: path.join(base, 'oc') };
  const dst = path.join(base, 'oc', 'data', 'opencode', 'auth.json');
  const logged = [];
  const log = (l) => logged.push(l);
  fs.writeFileSync(src, 'one');
  openCodeHome(env, { log });
  assert.equal(fs.readFileSync(dst, 'utf8'), 'one');
  fs.writeFileSync(src, 'two');
  fs.utimesSync(src, new Date(), new Date(Date.now() + 5000));
  openCodeHome(env, { log });
  assert.equal(fs.readFileSync(dst, 'utf8'), 'two');
  fs.utimesSync(src, new Date(), new Date(Date.now() - 60_000));
  fs.writeFileSync(src, 'old');
  fs.utimesSync(src, new Date(), new Date(Date.now() - 60_000));
  openCodeHome(env, { log });
  assert.equal(fs.readFileSync(dst, 'utf8'), 'two');
  assert.deepEqual(logged.map((l) => l.replace(/.*\((.*)\)$/, '$1')), ['auth.json copied', 'auth.json copied', 'auth.json already current']);
  assert.doesNotMatch(logged.join('\n'), /one|two|old/);
  fs.rmSync(src);
  openCodeHome(env, { log });
  assert.match(logged.at(-1), /source missing; using the copy/);
});

test('listedModels and loginHint: Go not logged in, or an unknown id', async () => {
  const { env } = setup('ok', { FAKE_OC_MODELS: '["opencode-go/deepseek-v4.1-flash", "openrouter/x"]' });
  const { listed, errors } = await listedModels(opencode, ['opencode-go', 'opencode-go', 'anthropic'], { env, cwd: os.tmpdir() });
  assert.deepEqual([...listed], ['opencode-go/deepseek-v4.1-flash']);
  assert.equal(errors.size, 0);                              // "Provider not found" is a missing login
  assert.match(loginHint('opencode-go/nope', listed, '/d'), /is not in `opencode models opencode-go`: check the id/);
  assert.match(loginHint('opencode-go/deepseek-v4.1-flash', new Set(), '/d'), /OpenCode Go is not logged in for \/d\. Run `opencode console login` with XDG_DATA_HOME=\/d/);
  // An Alibaba run refused for its key names the data directory whose auth.json may override the variable.
  assert.match(keyProblem('Error: Invalid API-key provided.', 'alibaba-token-plan/qwen3.8-max', '/d'), /auth\.json in \/d may hold a stale Alibaba entry.*Tell the owner which XDG_DATA_HOME/);
  assert.equal(keyProblem('Error: Invalid API-key provided.', 'openai/gpt-5.6-luna', '/d'), null);
  assert.equal(keyProblem('all fine', 'alibaba-token-plan/qwen3.8-max', '/d'), null);
  assert.match(loginHint('alibaba-token-plan/qwen3.8-max', new Set(), '/d'), /ALIBABA_TOKEN_PLAN_API_KEY is not in this environment.*tell the owner\. Do not retry; never add the key with `opencode auth login`/);
  assert.match(loginHint('openai/gpt-6-luna', new Set(), '/d'), /openai lists no models for \/d: it is not logged in there\. Log in once with `opencode auth login`.*copies auth\.json into \/d/);
});

test('an `opencode models` that fails for another reason is an OpenCode failure, never a missing login', async () => {
  const { env } = setup('ok', { FAKE_OC_MODELS_ERROR: 'Error: Unexpected error: no such column: project_id' });
  const { listed, errors } = await listedModels(opencode, ['opencode-go'], { env, cwd: os.tmpdir() });
  assert.equal(listed.size, 0);
  const hint = loginHint('opencode-go/deepseek-v4.1-flash', listed, '/d', errors);
  assert.match(hint, /`opencode models opencode-go` failed with exit 1: Error: Unexpected error: no such column: project_id/);
  assert.match(hint, /not a missing login/);
  assert.doesNotMatch(hint, /console login/);
});

test('a rejection caused by cd or .. in the agent\'s command names L31; any other gets no hint (#14)', async () => {
  const rej = '\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (/w/*); auto-rejecting\n';
  for (const cmd of ['cd evidence/a && grep x f; cd ../b && ls', 'grep -n x ../other/README.md', '(cd src && ls)']) {
    assert.match(rejectionHint(`${rej}\x1b[31m✗\x1b[0m ${cmd} failed\n`), /cd or \.\..*\(L31\)/, cmd);
  }
  for (const cmd of ['cat /tmp/notes.txt', 'grep -n abcd src/a.js', 'ls ...', 'echo cdrom']) {
    assert.equal(rejectionHint(`${rej}\x1b[31m✗\x1b[0m ${cmd} failed\n`), null, cmd);
  }
  assert.equal(rejectionHint('✗ cd a && cd ../b failed\n'), null);                // no rejection line, no hint
  const r = await run('permission-cd');
  assert.equal(r.permissionRejected, 'external_directory (/tmp/*)');
  assert.match(r.permissionHint, /\(L31\)/);
  assert.equal((await run('permission')).permissionHint, null);
});

test('the OpenCode version is read from --version; any major but 1 is refused (#26)', async () => {
  assert.equal(versionProblem('1.18.34', '/x/opencode'), null);
  assert.match(versionProblem('2.0.18', '/x/opencode-cli.exe'), /^OpenCode 2\.0\.18 at \/x\/opencode-cli\.exe is not supported: .*desktop app's 2\.x CLI differs \(#26\)/);
  assert.match(versionProblem(null, '/x/opencode'), /^OpenCode gave no version at \/x\/opencode is not supported/);
  assert.equal(await openCodeVersion(opencode, { env: setup('ok', { FAKE_OC_VERSION: 'opencode 2.0.18 (desktop)' }).env, cwd: os.tmpdir() }), '2.0.18');
  assert.equal(await openCodeVersion(opencode, { env: setup('ok', { FAKE_OC_VERSION: 'none' }).env, cwd: os.tmpdir() }), null);
});

test('fake opencode processes saving at once neither crash nor lose a session or its updates (#45)', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-race-'));
  // Each run creates its session, then updates it five times while the others do the same: the
  // store shares no file between runs, so no write can drop or roll back another's.
  const env = { ...process.env, FAKE_OC_STATE: path.join(dir, 'state.json'), FAKE_OC_MODE: 'ok', FAKE_OC_STEPS: '5', FAKE_OC_STEP_MS: '5' };
  const runs = Array.from({ length: 32 }, (_, i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [fake, 'run', '--title', `t${i}`, 'go'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, err }));
  }));
  for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.err);
  // And none lost another's session: a lost one is what the runner reports as "exited without a session".
  const sessions = readSessions(path.join(dir, 'state.json'));
  assert.deepEqual(sessions.map((s) => s.title).sort(), Array.from({ length: 32 }, (_, i) => `t${i}`).sort());
  for (const s of sessions) assert.ok(s.updated >= s.created + 25, `${s.title}'s updates were lost`);
});
