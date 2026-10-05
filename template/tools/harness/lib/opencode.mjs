// Runs `opencode run` as a watched child process. Ported from imperial_conquest_2's
// scripts/Invoke-OpenCodeWatched.ps1; each guard below cites the failure that produced it.
//
//   1. stdin is closed (EOF at once). `opencode run` reads a non-terminal stdin to its end before
//      it creates a session, so an inherited pipe that never closes hangs it at "init" (IC2 #490).
//   2. The session is found by a unique title, in the run's directory, created after the start.
//      No session within the startup timeout kills the run.
//   3. The idle watch: the session's `updated` time advances at step boundaries (a tool call's
//      completion, the next model turn), not while a tool runs or a reply streams (measured on
//      IC2 #482). If it does not advance for the idle timeout, the run is killed, so the idle
//      timeout must exceed the longest single step.
//   4. A total deadline.
//   5. Whether OpenCode loaded the requested --agent is decided on OpenCode's own evidence: the
//      session record (`opencode export`), else its exact warning line on stderr. Never the
//      model's words: a reviewer reading these scripts quotes the warning (IC2 #482's own reviews).
//      The export is written to a file: through a pipe, a large export arrives truncated
//      (ic2-conquest's WSL reviewer).
//   6. Output is read back as UTF-8.
//   7. A tool call OpenCode auto-rejected (a path outside --dir, in a non-interactive run) ends the
//      run with exit 0, so it looks like a clean finish. It is read from the session record, and
//      reported as `permissionRejected` with what OpenCode's warning line says was rejected (IC2
//      #501: three runs in one day, on TEMP and on tools' install directories). The line decides
//      alone only when the record cannot be read: a tool's output can quote it (PR 35).
//
// Every failure of OpenCode itself throws an OpenCodeInfraError with a short `reason`; a fallback
// chain may move past it. Anything else thrown is a defect of the caller.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class OpenCodeInfraError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'OpenCodeInfraError';
    this.reason = reason;
  }
}

// A failure reason without its numbers, so a chain can tell the same failure twice (two startup
// hangs, two idle kills) from two different ones.
export function failureClass(reason) {
  const r = String(reason);
  if (/^opencode not found/.test(r)) return 'not-found';
  if (/^no session in/.test(r)) return 'no-session';
  if (/^session idle/.test(r)) return 'idle';
  if (/^no exit in/.test(r)) return 'total-timeout';
  if (/^exited without a session/.test(r)) return 'exited-without-session';
  if (/fell back to the default agent/.test(r)) return 'fallback-agent';
  if (/^exit -?\d+/.test(r)) return 'non-zero-exit';
  if (/^permission rejected/.test(r)) return 'permission-rejected';
  if (/^no review/.test(r)) return 'no-review';
  return r;
}

// OpenCode's own warning when --agent names an agent it cannot find (OpenCode 1.18, stderr):
//   ESC[93mESC[1m! ESC[0m agent "x" not found. Falling back to default agent
// Anchored to the start of a line and to the requested agent's name, so quoted text does not match.
export function agentWarning(stderr, agent) {
  const ansi = '(?:\\x1b\\[[0-9;]*m|[ \\t])*';
  const esc = agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${ansi}!${ansi}agent "?${esc}"? not found\\. Falling back to default agent`, 'm');
  return re.test(stderr);
}

// OpenCode's own line when a non-interactive run rejects a tool call (OpenCode 1.18):
//   ESC[93mESC[1m! ESC[0mpermission requested: external_directory (/tmp/*); auto-rejecting
// Anchored like agentWarning. Text alone cannot tell this line from a tool's output quoting it (an
// issue printed by gh, PR 35), so whether a rejection happened is read from the session record
// (sessionRecord); the text says what was rejected, and decides only when the record cannot be read.
// OpenCode colours its own line, so a coloured match is preferred over a plain one.
function rejectionLines(text) {
  const ansi = '(?:\\x1b\\[[0-9;]*m|[ \\t])*';
  const all = [...String(text).matchAll(new RegExp(`^${ansi}!${ansi}permission requested: ([^\\r\\n]*?); auto-rejecting`, 'gm'))];
  const coloured = all.filter((m) => /\x1b\[/.test(m[0]));
  return coloured.length ? coloured : all;
}

// What was rejected (the last rejection), or null.
export function permissionRejection(text) {
  return rejectionLines(text).at(-1)?.[1] ?? null;
}

// Why a rejection happened, when the agent's own command shows it: OpenCode prints the rejected
// command on a `✗` line after its rejection line. A `cd` or a `..` in it means the agent wrote a path
// relative to an earlier `cd`, which OpenCode resolves against --dir instead (#14): a false
// positive the agent files now forbid (L31). Returns the hint, or null.
export function rejectionHint(text) {
  const first = rejectionLines(text)[0];
  if (!first) return null;
  const plain = String(text).slice(first.index).replace(/\x1b\[[0-9;]*m/g, '');
  const cmd = plain.split(/\r?\n/).slice(1).find((l) => /^\s*✗/.test(l));
  if (!cmd || !/(^|[\s;&|(])cd\s|(^|[\s/'"=])\.\.(\/|\s|$)/.test(cmd.replace(/^\s*✗\s*/, ''))) return null;
  return 'the rejected command used cd or ..: run commands from the worktree root, with paths relative to it (L31)';
}

// The Windows npm shim as WSL sees it: a shell script that execs opencode.exe. Under WSL it runs
// the Windows OpenCode, which cannot read the run's Linux paths and survives the kill of its
// process group: both real-OpenCode tests failed through it on 2026-10-01.
function isWindowsShim(file) {
  try {
    const head = fs.readFileSync(file, { encoding: 'latin1' }).slice(0, 2048);
    return head.startsWith('#!') && /opencode\.exe/.test(head);
  } catch { return false; }
}

// The command that runs OpenCode: { exe, prefix } (prefix = arguments before OpenCode's own).
// Never the npm shim on Windows: opencode.cmd cannot carry a multi-line prompt through cmd.exe,
// and killing the shim leaves opencode.exe running. Elsewhere, never the Windows shim either; then
// OpenCode's own installer location (~/.opencode/bin), which is not always on PATH.
export function resolveOpenCode(env = process.env) {
  if (env.HARNESS_OPENCODE_EXE) {
    // A script (the tests' fake, #2) runs through Node, since Windows cannot execute one.
    if (fs.existsSync(env.HARNESS_OPENCODE_EXE) && /\.m?js$/.test(env.HARNESS_OPENCODE_EXE)) return { exe: process.execPath, prefix: [env.HARNESS_OPENCODE_EXE] };
    if (fs.existsSync(env.HARNESS_OPENCODE_EXE)) return { exe: env.HARNESS_OPENCODE_EXE, prefix: [] };
    throw new OpenCodeInfraError('opencode not found', `HARNESS_OPENCODE_EXE points at a missing file: ${env.HARNESS_OPENCODE_EXE}`);
  }
  const win = process.platform === 'win32';
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    if (win) {
      const exe = path.join(dir, 'opencode.exe');
      if (fs.existsSync(exe)) return { exe, prefix: [] };
      if (fs.existsSync(path.join(dir, 'opencode.cmd'))) {
        const npmExe = path.join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
        if (fs.existsSync(npmExe)) return { exe: npmExe, prefix: [] };
      }
    } else {
      const exe = path.join(dir, 'opencode');
      if (fs.existsSync(exe) && !isWindowsShim(exe)) return { exe, prefix: [] };
    }
  }
  const installed = env.HOME && path.join(env.HOME, '.opencode', 'bin', 'opencode');
  if (!win && installed && fs.existsSync(installed)) return { exe: installed, prefix: [] };
  throw new OpenCodeInfraError('opencode not found', 'opencode is not on PATH (set HARNESS_OPENCODE_EXE to the real executable).');
}

// The scripts' own OpenCode data directory: XDG_DATA_HOME, XDG_CACHE_HOME and XDG_STATE_HOME, each
// a folder of one root (HARNESS_OPENCODE_HOME, else ~/.local/share/harness-opencode). OpenCode's
// desktop app (2.x) shares the default ~/.local/share/opencode and migrated its opencode.db to a
// schema the 1.x CLI cannot read ("no such column: project_id", IC2 #540). Only the children's
// environment changes; process.env is never touched, so there is nothing to restore.
// auth.json (the API-key providers) is copied from the default directory, or from
// HARNESS_OPENCODE_AUTH_SOURCE, when the copy is missing or older: copied, never read or logged.
// OpenCode Go is not in auth.json: its `opencode console login` lives in the data directory's
// database, so this directory needs its own login (loginHint says how).
// Returns { env, root, dataHome }.
export function openCodeHome(env = process.env, { log = () => {} } = {}) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const root = path.resolve(env.HARNESS_OPENCODE_HOME || path.join(home, '.local', 'share', 'harness-opencode'));
  const dirs = {
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(dirs.XDG_DATA_HOME, 'opencode'), { recursive: true });
  const src = path.resolve(env.HARNESS_OPENCODE_AUTH_SOURCE
    || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json'));
  const dst = path.join(dirs.XDG_DATA_HOME, 'opencode', 'auth.json');
  let auth;
  if (src !== dst && fs.existsSync(src) && (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs)) {
    fs.copyFileSync(src, dst);
    auth = 'auth.json copied';
  } else if (fs.existsSync(dst)) auth = fs.existsSync(src) ? 'auth.json already current' : 'auth.json source missing; using the copy';
  else auth = 'no auth.json: API-key providers are not logged in';
  log(`opencode: data directory ${dirs.XDG_DATA_HOME} (${auth})`);
  return { env: { ...env, ...dirs }, root, dataHome: dirs.XDG_DATA_HOME };
}

// The OpenCode version the runner drives ("1.18.34"), or null when `--version` gives none. The
// harness was checked on the 1.18 line, the public CLI. The desktop app ships a 2.x CLI whose run
// flags, session fields and agent format differ (#26), so any major but 1 is refused before
// anything is billed.
export const SUPPORTED_MAJOR = 1;
export async function openCodeVersion(cmd, { env, cwd, timeoutMs = 30_000 }) {
  const r = await execBounded(cmd, ['--version'], { cwd, env, timeoutMs });
  return r && r.code === 0 ? r.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0] ?? null : null;
}
export function versionProblem(version, exe) {
  if (version && Number(version.split('.')[0]) === SUPPORTED_MAJOR) return null;
  return `OpenCode ${version ?? 'gave no version'} at ${exe} is not supported: the harness runs on the public `
    + `${SUPPORTED_MAJOR}.x CLI (checked on 1.18), and the desktop app's 2.x CLI differs (#26). Point it at a 1.18 CLI: `
    + '~/.opencode/bin/opencode, npm opencode-ai@1.18, or HARNESS_OPENCODE_EXE';
}

// The model ids OpenCode lists for these providers in this environment (`opencode models <p>`), so
// an unknown id or a provider that is not logged in stops a run before anything is billed. A
// provider with no login exits 1 with "Provider not found" (OpenCode 1.18.34); any other failure,
// or a timeout, is OpenCode's own and lands in `errors`, so it is never reported as a login.
// Returns { listed: Set, errors: Map provider -> message }.
export async function listedModels(cmd, providers, { env, cwd, timeoutMs = 60_000 }) {
  const listed = new Set();
  const errors = new Map();
  for (const p of new Set(providers)) {
    const r = await execBounded(cmd, ['models', p], { cwd, env, timeoutMs });
    if (!r) { errors.set(p, `\`opencode models ${p}\` did not finish in ${Math.round(timeoutMs / 1000)} s`); continue; }
    if (r.code === 0) {
      for (const l of r.stdout.split(/\r?\n/)) if (l.trim()) listed.add(l.trim());
    } else if (!/provider not found/i.test(r.stderr)) {
      const last = r.stderr.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).at(-1) || '(no output)';
      errors.set(p, `\`opencode models ${p}\` failed with exit ${r.code}: ${last}`);
    }
  }
  return { listed, errors };
}

// Why a model is missing from the list, and the command that fixes it.
export function loginHint(modelId, listed, dataHome, errors = new Map()) {
  const provider = modelId.split('/')[0];
  if (errors.has(provider)) return `${errors.get(provider)}. That is OpenCode failing in ${dataHome}, not a missing login`;
  if ([...listed].some((id) => id.startsWith(`${provider}/`))) {
    return `${modelId} is not in \`opencode models ${provider}\`: check the id in harness.json`;
  }
  if (provider === 'opencode-go') {
    return `OpenCode Go is not logged in for ${dataHome}. Run \`opencode console login\` with XDG_DATA_HOME=${dataHome} `
      + `(bash: XDG_DATA_HOME="${dataHome}" opencode console login; PowerShell: $env:XDG_DATA_HOME="${dataHome}"; opencode console login)`;
  }
  return `${provider} lists no models for ${dataHome}: it is not logged in there. Log in once with `
    + `\`opencode auth login\` (or set its API key) in your usual OpenCode; the next run copies auth.json into ${dataHome}`;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL'); // the run's own process group, and nothing else
  } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function spawnDetached(cmd, args, options) {
  // Own process group on POSIX, so the whole tree can be killed; stdin 'ignore' is /dev/null (EOF).
  return spawn(cmd.exe, [...cmd.prefix, ...args], { ...options, detached: process.platform !== 'win32', windowsHide: true });
}

// A short OpenCode command (`session list`, `export`), bounded and killed if it overruns. With
// outFile, stdout goes to that file instead of a pipe. Resolves { code, stdout, stderr } or null
// on a timeout or a spawn error.
function execBounded(cmd, args, { cwd, timeoutMs, env, outFile }) {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    const fd = outFile ? fs.openSync(outFile, 'w') : null;
    try {
      child = spawnDetached(cmd, args, { cwd, env, stdio: ['ignore', fd ?? 'pipe', 'pipe'] });
    } catch { resolve(null); return; } finally { if (fd !== null) fs.closeSync(fd); }
    const out = [];
    const err = [];
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => { killTree(child); resolve(null); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code, stdout: outFile ? fs.readFileSync(outFile, 'utf8') : Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function sameDir(a, b) {
  const norm = (p) => {
    let n = String(p).replace(/[\\/]+$/, '');
    try { n = fs.realpathSync(n); } catch { /* keep as given */ }
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

// This run's session: its unique title, in its directory, created after it started. `session list`
// is scoped to the project of its working directory, so it runs in workDir. A miss says why, the
// listing or the match, so that "exited without a session" can be diagnosed (#45).
export async function lookupSession(cmd, { workDir, title, startedMs, timeoutMs, env }) {
  const miss = (why) => ({ session: null, miss: why });
  if (timeoutMs <= 0) return miss('no time left to list sessions');
  const res = await execBounded(cmd, ['session', 'list', '--format', 'json', '-n', '20'], { cwd: workDir, timeoutMs, env });
  if (!res) return miss(`\`session list\` gave no result within ${timeoutMs} ms (timed out, or could not start)`);
  const said = res.stderr.trim() ? `; stderr: ${res.stderr.trim().slice(-200)}` : '';
  if (!res.stdout.trim()) return miss(`\`session list\` printed nothing (exit ${res.code})${said}`);
  let sessions;
  try { sessions = JSON.parse(res.stdout); } catch { return miss(`\`session list\` printed no JSON (exit ${res.code}): ${res.stdout.trim().slice(0, 200)}`); }
  if (!Array.isArray(sessions)) sessions = [sessions];
  const titled = sessions.filter((s) => s && s.title === title);
  if (!titled.length) return miss(`no session titled ${title} among the ${sessions.length} listed`);
  const here = titled.filter((s) => s.directory && sameDir(s.directory, workDir));
  if (!here.length) return miss(`session ${titled[0].id} titled ${title} is in ${titled[0].directory}, not ${workDir}`);
  const session = here.find((s) => Number(s.created) >= startedMs - 1000);
  if (!session) return miss(`session ${here[0].id} titled ${title} was created at ${here[0].created}, before the run started at ${startedMs}`);
  return { session, miss: null };
}

// The agent OpenCode recorded for the session (`opencode export <id>`: .info.agent), or null.
// What the session record says: the agent that ran (L11), and whether OpenCode rejected a tool
// call, which it records as the tool's error "The user rejected permission to use this specific
// tool call." (OpenCode 1.18.34). Null when the export cannot be read.
export async function sessionRecord(cmd, { workDir, sessionId, outFile, timeoutMs = 30000, env }) {
  const res = await execBounded(cmd, ['export', sessionId], { cwd: workDir, timeoutMs, env, outFile });
  if (!res || res.code !== 0) return null;
  try {
    const j = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    const parts = (j.messages ?? []).flatMap((m) => m.parts ?? []);
    const rejected = parts.some((p) => p.type === 'tool' && p.state?.status === 'error' && /rejected permission/i.test(String(p.state.error ?? '')));
    return { agent: j.info?.agent ?? null, rejected };
  } catch { return null; }
}

function tail(file, lines = 30) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text.split(/\r?\n/).slice(-lines).join('\n') : '(empty)';
  } catch { return '(no output file)'; }
}

/**
 * Runs `opencode <args...> --title <title-token> <prompt>` in workDir, watched.
 * Returns { output, stdout, stderr, exitCode, sessionId, title, agentFallback, sessionAgent,
 *   permissionRejected, permissionHint, files, seconds }.
 * A non-zero exit is returned, not thrown: the caller decides.
 */
export async function runOpenCodeWatched({
  args, prompt, workDir, title,
  startupTimeoutMs = 180_000, totalTimeoutMs = 3_600_000, idleTimeoutMs = 600_000, pollMs = 10_000,
  logDir = path.join(os.tmpdir(), 'harness-opencode'), opencode, env = process.env, log = () => {},
}) {
  if (args[0] !== 'run') throw new Error(`runOpenCodeWatched runs 'opencode run'; got '${args[0]}'.`);
  const cmd = opencode ?? resolveOpenCode(env);
  workDir = fs.realpathSync(workDir);
  title = `${title}-${randomBytes(6).toString('hex')}`;
  fs.mkdirSync(logDir, { recursive: true });
  const outFile = path.join(logDir, `${title}.out.txt`);
  const errFile = path.join(logDir, `${title}.err.txt`);
  const files = [outFile, errFile];
  const all = [...args, '--title', title, prompt];
  if (process.platform === 'win32' && all.join(' ').length > 32000) {
    throw new Error('The opencode command line exceeds what Windows allows (32767 characters). Shorten the brief.');
  }

  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const startedMs = Date.now();
  let child;
  try {
    child = spawnDetached(cmd, all, { cwd: workDir, env, stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  let exitCode = null;
  let spawnError = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => { exitCode = code ?? (signal ? 128 : 1); resolve(true); });
    child.on('error', (e) => { spawnError = e; resolve(true); });
  });
  const hasExited = () => exitCode !== null || spawnError !== null;
  const waitExit = (ms) => Promise.race([exited, sleep(ms).then(() => false)]);
  const elapsed = () => Date.now() - startedMs;
  let session = null;
  let lastMiss = 'no lookup ran';
  const lookup = async (timeoutMs) => {
    const r = await lookupSession(cmd, { workDir, title, startedMs, env, timeoutMs });
    if (r.miss) lastMiss = r.miss;
    return r.session;
  };
  // A run with no session says why the last lookup missed it (#45).
  const noSession = (reason, message) => {
    log(`opencode: session lookup missed: ${lastMiss}`);
    return fail(reason, `${message} (last lookup: ${lastMiss})`);
  };
  const fail = (reason, message) => new OpenCodeInfraError(reason,
    `${message}; files kept: ${files.join(', ')}. stderr tail:\n${tail(errFile)}`);
  log(`opencode: pid ${child.pid}, session title ${title}, output ${outFile}`);

  try {
    await Promise.race([exited, sleep(0)]);
    if (spawnError) throw new OpenCodeInfraError('opencode not found', `could not start ${cmd.exe}: ${spawnError.message}`);

    // Startup watch.
    const startupMs = Math.min(startupTimeoutMs, totalTimeoutMs);
    while (!session && !hasExited()) {
      const remaining = startupMs - elapsed();
      if (remaining <= 0) break;
      if (await waitExit(Math.min(pollMs, remaining))) break;
      session = await lookup(Math.max(0, startupMs - elapsed()));
    }
    if (!session && !hasExited()) {
      killTree(child);
      const secs = Math.round(startupMs / 1000);
      throw noSession(`no session in ${secs} s`, `OpenCode created no session within ${secs} s (is stdin closed?); killed pid ${child.pid}`);
    }
    if (session) log(`opencode: session ${session.id} started after ${Math.round(elapsed() / 1000)} s`);

    // Run watch: the total deadline, and the idle watch on the session's `updated` time. A lookup
    // that fails leaves `lastUpdated` unchanged, so the idle clock keeps running.
    const idlePollMs = Math.max(pollMs, Math.min(60_000, Math.ceil(idleTimeoutMs / 5)));
    let lastUpdated = session ? Number(session.updated) : startedMs;
    while (!hasExited()) {
      const remaining = Math.max(0, totalTimeoutMs - elapsed());
      const wait = session && idleTimeoutMs > 0 ? Math.min(idlePollMs, remaining) : remaining;
      if (await waitExit(wait)) break;
      if (elapsed() >= totalTimeoutMs) {
        killTree(child);
        const secs = Math.round(totalTimeoutMs / 1000);
        throw fail(`no exit in ${secs} s`, `OpenCode did not finish within ${secs} s; killed pid ${child.pid}`);
      }
      if (!session || idleTimeoutMs <= 0) continue;
      const { session: seen } = await lookupSession(cmd, { workDir, title, startedMs, env, timeoutMs: Math.max(0, Math.min(30_000, totalTimeoutMs - elapsed())) });
      if (hasExited()) break;
      if (seen && Number(seen.updated) > lastUpdated) lastUpdated = Number(seen.updated);
      const idleFor = Date.now() - lastUpdated;
      if (idleFor >= idleTimeoutMs) {
        killTree(child);
        const secs = Math.round(idleTimeoutMs / 1000);
        throw fail(`session idle for ${secs} s`, `OpenCode session idle for ${Math.round(idleFor / 1000)} s (limit ${secs} s); killed pid ${child.pid}`);
      }
    }
    await exited;
    // A run that finished before the first poll: its session must still exist, or it never ran.
    if (!session) {
      session = await lookup(Math.max(0, Math.min(15_000, totalTimeoutMs - elapsed())));
      if (!session) throw noSession(`exited without a session (exit ${exitCode})`, `OpenCode exited with ${exitCode} without creating a session`);
    }
  } catch (e) {
    killTree(child);
    throw e;
  }

  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  const agentIdx = args.indexOf('--agent');
  const requestedAgent = agentIdx >= 0 ? args[agentIdx + 1] : null;
  const exportFile = path.join(logDir, `${title}.export.json`);
  const record = await sessionRecord(cmd, { workDir, sessionId: session.id, outFile: exportFile, env });
  const recordedAgent = requestedAgent ? record?.agent ?? null : null;
  fs.rmSync(exportFile, { force: true });
  const agentFallback = !requestedAgent ? false
    : recordedAgent ? recordedAgent !== requestedAgent
    : agentWarning(stderr, requestedAgent);
  const said = permissionRejection(`${stdout}\n${stderr}`);
  const permissionRejected = !record ? said : record.rejected ? said ?? 'a tool call (in the session record)' : null;
  const permissionHint = permissionRejected ? rejectionHint(`${stdout}\n${stderr}`) : null;
  if (exitCode === 0 && !permissionRejected) for (const f of files) fs.rmSync(f, { force: true });
  else log(`opencode: exit ${exitCode}${permissionRejected ? `, permission rejected: ${permissionRejected}` : ''}; files kept: ${files.join(', ')}`);
  return {
    output: `${stdout.trimEnd()}\n${stderr.trimEnd()}`.trim(),
    stdout, stderr, exitCode, sessionId: session.id, title,
    agentFallback, sessionAgent: recordedAgent, permissionRejected, permissionHint,
    files: exitCode === 0 && !permissionRejected ? [] : files,
    seconds: Math.round(elapsed() / 1000),
  };
}
