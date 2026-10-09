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
  commandLineTooLong, briefFileName, scratchAllow, withScratchAllow, denialVerdict, runFailure, deniedNote, withContinueOnDeny, canonicalInput,
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
    workDir: dir, title: 'test', opencode, env, logDir: path.join(dir, 'logs'), scratchRoot: path.join(dir, 'tmp'),
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

test('the brief rides a file in the worktree, not the command line (L60)', async () => {
  const { dir, env } = setup('ok');
  const r = await runOpenCodeWatched({
    args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'line one\nline two',
    workDir: dir, title: 'test', opencode, env, logDir: path.join(dir, 'logs'),
    pollMs: 50, startupTimeoutMs: 1500, idleTimeoutMs: 800, totalTimeoutMs: 5000,
  });
  // The command line carried only the pointer, and the file held the whole brief, byte-exact.
  const [session] = readSessions(path.join(dir, 'state.json'));
  assert.match(session.prompt, new RegExp(`Your complete brief for this run is the file \\.harness-brief-${r.title}\\.md at the root of this worktree\\.`));
  assert.doesNotMatch(session.prompt, /line one/);
  assert.equal(session.brief, 'line one\nline two');
  // Success deleted the brief file with the log files.
  assert.equal(fs.existsSync(path.join(dir, `.harness-brief-${r.title}.md`)), false);
});

test('a failed run shelves the brief into the log directory, out of the worktree (L60, #87)', async () => {
  const { dir, env } = setup('exit2');
  const r = await run('exit2', { workDir: dir, logDir: path.join(dir, 'logs') }, {});
  assert.equal(r.exitCode, 2);
  const kept = path.join(dir, 'logs', `${r.title}.brief.md`);
  assert.ok(r.files.includes(kept), `kept files name the brief: ${r.files.join(', ')}`);
  assert.equal(r.briefFile, kept);
  assert.equal(fs.readFileSync(kept, 'utf8'), 'line one\nline two');
  // The worktree is left clean: no untracked brief for a reset to save as the implementer's work.
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.harness-brief-')), false);
});

test('commandLineTooLong: the win32 tripwire, per platform', () => {
  assert.equal(commandLineTooLong(['opencode', 'run', 'x'], 'win32'), false);
  assert.equal(commandLineTooLong(['opencode', 'run', 'x'.repeat(33000)], 'win32'), true);
  assert.equal(commandLineTooLong(['opencode', 'run', 'x'.repeat(33000)], 'linux'), false);
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

test('a non-zero exit is returned, not thrown, and its files — the brief among them — are kept (L60)', async () => {
  const r = await run('exit2');
  assert.equal(r.exitCode, 2);
  assert.equal(r.files.length, 3);
  assert.ok(r.files.some((f) => f.endsWith('.brief.md')), 'the brief file is kept');
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
  assert.equal(r.files.length, 3);   // out, err and the brief file (L60)
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
  const { env } = setup('ok', { FAKE_OC_MODELS: '["opencode-go/mimo-v2.6-flash", "openrouter/x"]' });
  const { listed, errors } = await listedModels(opencode, ['opencode-go', 'opencode-go', 'anthropic'], { env, cwd: os.tmpdir() });
  assert.deepEqual([...listed], ['opencode-go/mimo-v2.6-flash']);
  assert.equal(errors.size, 0);                              // "Provider not found" is a missing login
  assert.match(loginHint('opencode-go/nope', listed, '/d'), /is not in `opencode models opencode-go`: check the id/);
  assert.match(loginHint('opencode-go/mimo-v2.6-flash', new Set(), '/d'), /OpenCode Go is not logged in for \/d\. Run `opencode console login` with XDG_DATA_HOME=\/d/);
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
  const hint = loginHint('opencode-go/mimo-v2.6-flash', listed, '/d', errors);
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

test('a cross-device shelve (EXDEV) falls back to copy; a hopeless one still clears the worktree (L60, R1)', async () => {
  const realRename = fs.renameSync; const realCopy = fs.copyFileSync;
  const call = (dir, env, title) => runOpenCodeWatched({
    args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'line one\nline two',
    workDir: dir, title, opencode, env, logDir: path.join(dir, 'logs'),
    pollMs: 50, startupTimeoutMs: 1500, idleTimeoutMs: 800, totalTimeoutMs: 5000,
  });
  const exdev = () => Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  fs.renameSync = () => { throw exdev(); };
  try {
    const { dir, env } = setup('exit2');
    const r = await call(dir, env, 'exdev');
    assert.equal(r.exitCode, 2);
    const kept = path.join(dir, 'logs', `${r.title}.brief.md`);
    assert.equal(r.briefFile, kept, 'the copy fallback kept the brief');
    assert.equal(fs.readFileSync(kept, 'utf8'), 'line one\nline two');
    assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.harness-brief-')), false);
  } finally { fs.renameSync = realRename; }
  fs.renameSync = () => { throw exdev(); };
  fs.copyFileSync = () => { throw new Error('no space left on device'); };
  try {
    const { dir, env } = setup('exit2');
    const r = await call(dir, env, 'hopeless');
    assert.equal(r.exitCode, 2);
    assert.equal(r.briefFile, null, 'no kept path is claimed');
    assert.ok(!r.files.some((f) => f.includes('brief')), JSON.stringify(r.files));
    for (const f of r.files) assert.ok(fs.existsSync(f), `named path exists: ${f}`);
    assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.harness-brief-')), false, 'worktree cleared anyway');
  } finally { fs.renameSync = realRename; fs.copyFileSync = realCopy; }
});

test('a throw before the watch starts still shelves the brief out of the worktree (L60, R2)', async () => {
  const { dir, env } = setup('ok');
  await assert.rejects(runOpenCodeWatched({
    args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'line one\nline two',
    workDir: dir, title: 'spawnthrow', opencode: { exe: null, prefix: [] }, env, logDir: path.join(dir, 'logs'),
    pollMs: 50, startupTimeoutMs: 1500, idleTimeoutMs: 800, totalTimeoutMs: 5000,
  }), /The "file" argument must be|invalid/i);
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.harness-brief-')), false, 'worktree cleared');
  assert.ok(fs.readdirSync(path.join(dir, 'logs')).some((n) => n.endsWith('.brief.md')), 'brief shelved into the log directory');
});

test('a thrown watch failure names the shelved brief, and every kept path it names exists (L60, R3)', async () => {
  const { dir, env } = setup('no-session');
  let error = null;
  await runOpenCodeWatched({
    args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'line one\nline two',
    workDir: dir, title: 'nosession', opencode, env, logDir: path.join(dir, 'logs'),
    pollMs: 50, startupTimeoutMs: 400, idleTimeoutMs: 800, totalTimeoutMs: 5000,
  }).catch((e) => { error = e; });
  assert.ok(error, 'the run threw');
  assert.match(error.message, /\.brief\.md/);
  assert.doesNotMatch(error.message, /\.harness-brief-/);
  const kept = /files kept: (.*?)\. stderr tail:/s.exec(error.message)?.[1].split(',').map((s) => s.trim()) ?? [];
  assert.ok(kept.some((f) => f.endsWith('.brief.md')), `kept list names the shelved brief: ${kept.join(', ')}`);
  for (const f of kept) assert.ok(fs.existsSync(f), `named path exists: ${f}`);
});

test('a hopeless shelve on a thrown failure names no path that does not exist (L60, round-2 R1)', async () => {
  const realRename = fs.renameSync; const realCopy = fs.copyFileSync;
  fs.renameSync = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
  fs.copyFileSync = () => { throw new Error('no space left on device'); };
  let error = null; let dir = null;
  try {
    ({ dir, env: globalThis.__unused } = { dir: null });
    const s = setup('no-session'); dir = s.dir;
    await runOpenCodeWatched({
      args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'line one\nline two',
      workDir: dir, title: 'hopeless-throw', opencode, env: s.env, logDir: path.join(dir, 'logs'),
      pollMs: 50, startupTimeoutMs: 400, idleTimeoutMs: 800, totalTimeoutMs: 5000,
    }).catch((e) => { error = e; });
    assert.ok(error, 'the run threw');
    assert.doesNotMatch(error.message, /\.harness-brief-/, `no stale worktree path: ${error.message}`);
    const kept = /files kept: (.*?)\. stderr tail:/s.exec(error.message)?.[1].split(',').map((x) => x.trim()) ?? [];
    assert.ok(!kept.some((f) => f.includes('brief')), `dropped brief not listed: ${kept.join(', ')}`);
    for (const f of kept) assert.ok(fs.existsSync(f), `named path exists: ${f}`);
    assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.harness-brief-')), false, 'worktree cleared');
  } finally { fs.renameSync = realRename; fs.copyFileSync = realCopy; }
});

// L66a (#138): a scratch folder per run, allowed to that run alone.
const agentMd = (perm, eol = '\n') => `---\ndescription: d\nmode: all\npermission:\n${perm}  bash:\n    "*": allow\n---\nbody\n`.replace(/\n/g, eol);
// Never the reviewer's inherited settings (review.mjs, L34): these tests are about the worktree's agent.
const isolated = (s) => {
  const { OPENCODE_CONFIG_DIR: _dir, OPENCODE_DISABLE_PROJECT_CONFIG: _off, ...env } = s.env;
  return { ...s, env };
};
const withAgent = (mode, text) => {
  const s = isolated(setup(mode));
  fs.mkdirSync(path.join(s.dir, '.opencode', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, '.opencode', 'agents', 'reviewer.md'), text);
  return s;
};
const runIn = ({ dir, env }, opts = {}) => runOpenCodeWatched({
  args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'p', workDir: dir, title: 'test', opencode, env,
  logDir: path.join(dir, 'logs'), scratchRoot: path.join(dir, 'tmp'), pollMs: 50, startupTimeoutMs: 1500, idleTimeoutMs: 800, totalTimeoutMs: 5000, ...opts,
});

test('a run gets its own scratch folder as TMPDIR, TEMP and TMP, named in the pointer; removed after a clean run, kept after a failed one (L66)', async () => {
  const s = withAgent('ok', agentMd('  external_directory:\n    "/tmp/opencode/*": allow\n'));
  const r = await runIn(s);
  const [session] = readSessions(path.join(s.dir, 'state.json'));
  const scratch = fs.realpathSync.native(path.join(s.dir, 'tmp'));
  const own = path.join(scratch, `harness-run-${r.title}`);
  assert.equal(session.tmpdir, own);
  assert.equal(session.temp, own);
  assert.equal(session.tmp, own);
  assert.ok(session.prompt.includes(`Your scratch folder for this run is ${own} (also $TMPDIR)`), session.prompt);
  assert.equal(r.scratch, null);
  assert.equal(fs.existsSync(own), false, 'removed after a clean run');
  for (const mode of ['exit2', 'permission']) {
    const bad = await runIn(withAgent(mode, agentMd('')));
    assert.ok(bad.scratch && fs.existsSync(bad.scratch), `${mode}: kept`);
    assert.match(path.basename(bad.scratch), /^harness-run-test-[0-9a-f]{12}$/);
  }
});

test('the scratch folder is under /tmp on POSIX by default, never the caller\'s TMPDIR', { skip: process.platform === 'win32' && 'POSIX only' }, async () => {
  const s = withAgent('ok', agentMd(''));
  const callers = path.join(s.dir, 'callers-tmp');
  fs.mkdirSync(callers);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = callers;
  let r;
  try {
    r = await runOpenCodeWatched({ args: ['run', '--agent', 'reviewer', '--model', 'opencode-go/x'], prompt: 'p', workDir: s.dir, title: 'test', opencode,
      env: { ...s.env, TMPDIR: callers }, logDir: path.join(s.dir, 'logs'), pollMs: 50, startupTimeoutMs: 1500, idleTimeoutMs: 800, totalTimeoutMs: 5000 });
  } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  const [session] = readSessions(path.join(s.dir, 'state.json'));
  assert.equal(session.tmpdir, path.join(fs.realpathSync.native('/tmp'), `harness-run-${r.title}`));
});

test('each run loads a per-run copy of its agent file whose last external_directory rule allows its own folder exactly (Sol\'s R1 on PR 137)', async () => {
  const runs = [];
  for (const k of [1, 2]) {
    const s = withAgent('ok', agentMd('  external_directory:\n    "*": deny\n    "/tmp/opencode/*": allow\n'));
    const r = await runIn(s);
    runs.push({ r, s, session: readSessions(path.join(s.dir, 'state.json'))[0] });
  }
  for (const { r, s, session } of runs) {
    const own = path.join(fs.realpathSync.native(path.join(s.dir, 'tmp')), `harness-run-${r.title}`);
    assert.equal(session.configDir, path.join(s.dir, 'logs', `${r.title}.config`));
    assert.ok(session.agentFile.startsWith(session.configDir), session.agentFile);
    const block = /\n  external_directory:\n((?: {4}.*\n)*)/.exec(session.agentText)[1];
    assert.equal(block, `    "*": deny\n    "/tmp/opencode/*": allow\n    "${own.replace(/\\/g, '/')}/*": allow\n`);
    assert.equal(fs.existsSync(session.configDir), false, 'the config dir is removed after the run');
  }
  assert.notEqual(runs[0].r.title, runs[1].r.title);
});

test('an inherited OPENCODE_CONFIG_DIR is copied whole into the run\'s own, but OpenCode\'s node_modules (the reviewer, L34)', async () => {
  const s = setup('ok');
  const main = path.join(s.dir, 'main-opencode');
  fs.mkdirSync(path.join(main, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(main, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(main, 'agents', 'reviewer.md'), agentMd('  edit: deny\n'));
  fs.writeFileSync(path.join(main, 'agents', 'other.md'), 'other agent');
  fs.writeFileSync(path.join(main, 'opencode.json'), '{}');
  let seen = null;
  const realCp = fs.cpSync;
  fs.cpSync = (src, dst, o) => { realCp(src, dst, o); seen = { dst, files: fs.readdirSync(dst, { recursive: true }).map(String).sort() }; };
  try {
    await runIn({ dir: s.dir, env: { ...s.env, OPENCODE_CONFIG_DIR: main, OPENCODE_DISABLE_PROJECT_CONFIG: '1' } });
  } finally { fs.cpSync = realCp; }
  const [session] = readSessions(path.join(s.dir, 'state.json'));
  assert.equal(session.configDir, seen.dst);
  assert.deepEqual(seen.files, ['agents', path.join('agents', 'other.md'), path.join('agents', 'reviewer.md'), 'opencode.json']);
  assert.match(session.agentText, /permission:\n  external_directory:\n    "[^"]*\/harness-run-test-[0-9a-f]{12}\/\*": allow\n  edit: deny\n/);
  assert.equal(fs.readFileSync(path.join(main, 'agents', 'reviewer.md'), 'utf8'), agentMd('  edit: deny\n'), 'the inherited file is untouched');
});

test('without an agent file to copy, the run goes on with no config of its own and says writes to the scratch folder will be rejected', async () => {
  const s = isolated(setup('ok'));
  const said = [];
  await runIn(s, { log: (l) => said.push(l) });
  assert.equal(readSessions(path.join(s.dir, 'state.json'))[0].configDir, null);
  assert.ok(said.some((l) => /no agent file .*reviewer\.md to allow the scratch folder in/.test(l)), said.join('\n'));
});

test('scratchAllow is the folder\'s own path with / and /*: no ? standing in for a separator (Sol\'s R1, PR 137 round 2)', () => {
  assert.equal(scratchAllow('/tmp/harness-run-a'), '/tmp/harness-run-a/*');
  assert.equal(scratchAllow('C:\\Users\\u\\AppData\\Local\\Temp\\harness-run-a'), 'C:/Users/u/AppData/Local/Temp/harness-run-a/*');
});

test('withScratchAllow: last in the block or a new block; BOM, CRLF and blanks after --- read, line ends kept (Sol\'s R5, PR 137 round 2)', () => {
  const inBlock = withScratchAllow(agentMd('  external_directory:\n    "*": deny\n    "/x/*": allow\n'), '/tmp/r/*');
  assert.match(inBlock, /\n  external_directory:\n    "\*": deny\n    "\/x\/\*": allow\n    "\/tmp\/r\/\*": allow\n  bash:/);
  assert.match(inBlock, /\n---\nbody\n$/);
  // A blank or comment line inside the block does not end it: the allow still goes last (Sol's R2, PR 152).
  const gaps = withScratchAllow(agentMd('  external_directory:\n\n    # the run\'s own\n    "*": deny\n\n    "/x/*": deny\n  # next\n'), '/tmp/r/*');
  assert.match(gaps, /\n    "\/x\/\*": deny\n    "\/tmp\/r\/\*": allow\n\n?  # next\n  bash:/);
  assert.match(withScratchAllow(agentMd('  edit: deny\n'), '/tmp/r/*'), /permission:\n  external_directory:\n    "\/tmp\/r\/\*": allow\n  edit: deny/);
  const crlf = withScratchAllow(`\uFEFF${agentMd('  external_directory:\n    "/x/*": allow\n', '\r\n').replace(/^---\r\n/, '--- \r\n')}`, '/tmp/r/*');
  assert.ok(crlf.startsWith('\uFEFF--- \r\n'), JSON.stringify(crlf.slice(0, 12)));
  assert.match(crlf, /\r\n  external_directory:\r\n    "\/x\/\*": allow\r\n    "\/tmp\/r\/\*": allow\r\n  bash:/);
  assert.doesNotMatch(crlf.replace(/\r\n/g, ''), /\n/, 'no LF without its CR');
  assert.equal(withScratchAllow('no front matter\n', '/tmp/r/*'), null);
  assert.equal(withScratchAllow('---\ndescription: d\n---\nbody\n', '/tmp/r/*'), null);
  assert.equal(withScratchAllow(agentMd('  external_directory: deny\n'), '/tmp/r/*'), null, 'not a block: never a second key');
  assert.equal(withScratchAllow(agentMd(''), '/tmp/"q/*'), null);
  assert.equal(withScratchAllow(agentMd(''), 'C:\\x/*'), null);
});

test('a CRLF agent file still gets the run\'s scratch allow (Windows checkouts; Sol\'s R5, PR 137 round 2)', async () => {
  const s = withAgent('ok', `\uFEFF${agentMd('  external_directory:\n    "/tmp/opencode/*": allow\n', '\r\n')}`);
  const r = await runIn(s);
  const [session] = readSessions(path.join(s.dir, 'state.json'));
  const own = path.join(fs.realpathSync.native(path.join(s.dir, 'tmp')), `harness-run-${r.title}`).replace(/\\/g, '/');
  assert.ok(session.configDir, 'a per-run config dir');
  assert.ok(session.agentText.includes(`    "/tmp/opencode/*": allow\r\n    "${own}/*": allow\r\n`), JSON.stringify(session.agentText));
});

test('a failure while making the run\'s config leaves no brief in the worktree', async () => {
  const s = withAgent('ok', agentMd(''));
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (f, ...a) => { if (String(f).endsWith(`${path.sep}reviewer.md`) && String(f).includes('.config')) throw new Error('disk full'); return realWrite(f, ...a); };
  try { await assert.rejects(runIn(s), /disk full/); } finally { fs.writeFileSync = realWrite; }
  assert.equal(fs.readdirSync(s.dir).some((n) => n.startsWith('.harness-brief-')), false);
});

test('a thrown failure removes the run\'s config dir too (Sol\'s R3, PR 152)', async () => {
  const s = withAgent('no-session', agentMd(''));
  await assert.rejects(runIn(s), infra(/no session/));
  const [session] = readSessions(path.join(s.dir, 'state.json')).concat([undefined]);
  assert.equal(session, undefined, 'no session was made');
  const logs = path.join(s.dir, 'logs');
  assert.deepEqual(fs.readdirSync(logs).filter((n) => n.endsWith('.config')), [], fs.readdirSync(logs).join(', '));
});

// #146: a denied call no longer ends the run; the record decides, at the thresholds.
const deny = (denials, extra = {}, opts = {}) => {
  const s = withAgent('deny', agentMd(''));
  return runIn({ ...s, env: { ...s.env, FAKE_OC_DENIALS: JSON.stringify(denials), ...extra } }, opts);
};
const D = (input, kind = 'rejected', tool = 'read') => ({ tool, input, kind });

test('one-shot-reject: a run that went on after one denied call is not failed; the call is reported (#146)', async () => {
  const r = await deny([D('/etc/a')]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.permissionRejected, null);
  assert.equal(r.stopped, null);
  assert.deepEqual(r.permissionsDenied.map((d) => [d.tool, d.input, d.recovered]), [['read', '/etc/a', true]]);
  assert.equal(runFailure(r), null);
  assert.equal(deniedNote(r), '1 denied call, the model went on: read /etc/a');
  assert.equal(r.scratch, null, 'a clean run');
});

test('retry-recover: two different denied calls, each corrected, still pass (#146)', async () => {
  const r = await deny([D('/etc/a'), D('ls /etc', 'denied', 'bash')]);
  assert.equal(r.permissionRejected, null);
  assert.equal(r.permissionsDenied.length, 2);
});

test('retry-fail: the same call denied twice fails as permission-rejected-after-retry; a rule\'s deny counts too (#146)', async () => {
  for (const kind of ['rejected', 'denied']) {
    const r = await deny([D('/etc/a', kind), D('/etc/a', kind)]);
    assert.match(r.permissionRejected ?? '', /^permission-rejected-after-retry: /, kind);
    assert.match(runFailure(r), /^permission rejected: permission-rejected-after-retry: /);
    assert.deepEqual(r.permissionsDenied, []);
    assert.ok(r.scratch, 'kept: a failed run');
  }
});

test('distinct-x3: three different denied calls fail as permission-rejected-x3-distinct, recovered or not (#146)', async () => {
  const r = await deny([D('/etc/a'), D('/etc/b'), D('/etc/c')]);
  assert.match(r.permissionRejected ?? '', /^permission-rejected-x3-distinct: /);
});

test('a run past a threshold is killed as soon as the record shows it, not left to the idle or total timeout (#146)', async () => {
  const started = Date.now();
  const r = await deny([D('/etc/a'), D('/etc/b'), D('/etc/c')], { FAKE_OC_DENY_HANG: '1' }, { idleTimeoutMs: 20_000, totalTimeoutMs: 30_000 });
  assert.equal(r.stopped, 'permission-rejected-x3-distinct');
  assert.match(r.permissionRejected, /^permission-rejected-x3-distinct: /);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  assert.match(runFailure({ ...r, exitCode: 137 }), /^permission rejected: permission-rejected-x3-distinct/, 'the verdict, not the kill\'s exit code');
});

test('a run whose record ends on a denied call stopped there: it fails as before, naming what was rejected (L26, IC2 #501)', async () => {
  const r = await deny([D('/etc/a')], { FAKE_OC_DENY_STOPPED: '1' });
  assert.equal(r.permissionRejected, 'external_directory (/etc/*)');
  assert.equal(r.stopped, null);
});

test('every run sets continue_loop_on_deny, over the caller\'s own OPENCODE_CONFIG_CONTENT (#146)', async () => {
  const s = withAgent('ok', agentMd(''));
  await runIn({ ...s, env: { ...s.env, OPENCODE_CONFIG_CONTENT: '{"experimental":{"other":1},"share":"disabled"}' } });
  const [session] = readSessions(path.join(s.dir, 'state.json'));
  assert.deepEqual(JSON.parse(session.configContent), { experimental: { other: 1, continue_loop_on_deny: true }, share: 'disabled' });
  assert.deepEqual(JSON.parse(withContinueOnDeny(undefined)), { experimental: { continue_loop_on_deny: true } });
  // OpenCode reads JSONC; a caller's comments and trailing commas keep its settings, and its own
  // false is overridden (Sol's R4 on PR 155). Content that does not parse is left to the caller.
  assert.deepEqual(JSON.parse(withContinueOnDeny('{"share":"disabled", /* caller setting */ "experimental":{"continue_loop_on_deny":false,}, // end\n}')),
    { share: 'disabled', experimental: { continue_loop_on_deny: true } });
  assert.deepEqual(JSON.parse(withContinueOnDeny('{"url":"http://x/*y*/", "a":"//b"}')), { url: 'http://x/*y*/', a: '//b', experimental: { continue_loop_on_deny: true } });
  assert.equal(withContinueOnDeny('not json'), null);
  const bad = withAgent('ok', agentMd(''));
  const said = [];
  await runIn({ ...bad, env: { ...bad.env, OPENCODE_CONFIG_CONTENT: 'not json' } }, { log: (l) => said.push(l) });
  assert.equal(readSessions(path.join(bad.dir, 'state.json'))[0].configContent, 'not json');
  assert.ok(said.some((l) => /OPENCODE_CONFIG_CONTENT does not parse/.test(l)), said.join('\n'));
});

test('denialVerdict: after-retry before x3; two different calls, or one, pass', () => {
  assert.equal(denialVerdict([]), null);
  assert.equal(denialVerdict([D('/a'), D('/b')]), null);
  assert.equal(denialVerdict([D('/a'), D('/a', 'rejected', 'bash')]), null, 'another tool is another call');
  assert.equal(denialVerdict([D('/a'), D('/b'), D('/a'), D('/c')]), 'permission-rejected-after-retry');
  assert.equal(denialVerdict([D('/a'), D('/b'), D('/c')]), 'permission-rejected-x3-distinct');
});

test('agentfallback-real and agentfallback-load: a fallback with no agent file keeps its reason; one with the file given is a load failure (#146, L11)', async () => {
  const given = await runIn(withAgent('fallback', agentMd('')));
  assert.equal(given.agentFallback, true);
  assert.equal(given.agentLoad, 'load-failure');
  assert.match(runFailure(given), /^agent-load-failure: /);
  const none = await runIn(isolated(setup('fallback')));
  assert.equal(none.agentFallback, true);
  assert.equal(none.agentLoad, 'fallback');
  assert.equal(runFailure(none), 'fell back to the default agent');
});

test('only the model\'s own later work recovers a denial: not a user\'s or a synthetic message, not a call that never ran (Sol\'s R1 on PR 155)', async () => {
  const cases = {
    user: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'system reminder' }] }],
    synthetic: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'note', synthetic: true }] }],
    pending: [{ info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'pending', input: { command: 'ls' } } }] }],
    blank: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: '  ' }] }],
  };
  for (const [name, after] of Object.entries(cases)) {
    const r = await deny([D('/etc/a')], { FAKE_OC_DENY_AFTER: JSON.stringify(after) });
    assert.equal(r.permissionRejected, 'external_directory (/etc/*)', name);
  }
  const worked = await deny([D('/etc/a')], { FAKE_OC_DENY_AFTER: JSON.stringify([{ info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } }] }]) });
  assert.equal(worked.permissionRejected, null, 'its own call that ran');
});

test('a call is the same call whatever its keys\' order, and two calls differing past 300 characters are two (Sol\'s R2, R5 on PR 155)', async () => {
  const grep = (o) => ({ tool: 'grep', input: 'x', kind: 'rejected', inputObject: o });
  const same = await deny([grep({ pattern: 'secret', include: '*.txt' }), grep({ include: '*.txt', pattern: 'secret' })]);
  assert.match(same.permissionRejected ?? '', /^permission-rejected-after-retry: /);
  const long = 'x'.repeat(300);
  const two = await deny([D(`echo ${long} a`, 'rejected', 'bash'), D(`echo ${long} b`, 'rejected', 'bash')]);
  assert.equal(two.permissionRejected, null);
  assert.equal(two.permissionsDenied.length, 2);
  assert.equal(canonicalInput({ b: [1, { d: 2, c: 3 }], a: null }), '{"a":null,"b":[1,{"c":3,"d":2}]}');
});

test('a stale first export does not use up the marks: the next poll reads the record again and stops the run (Sol\'s R3 on PR 155)', async () => {
  const started = Date.now();
  const r = await deny([D('/etc/a'), D('/etc/b'), D('/etc/c')], { FAKE_OC_DENY_HANG: '1', FAKE_OC_EXPORT_STALE: '1' }, { idleTimeoutMs: 20_000, totalTimeoutMs: 30_000 });
  assert.equal(r.stopped, 'permission-rejected-x3-distinct');
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
});
