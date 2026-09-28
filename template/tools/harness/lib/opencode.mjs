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
//   6. Output is read back as UTF-8.
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
  if (/cut off|no header line|no verdict/.test(r)) return 'cut-off';
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

// The command that runs OpenCode: { exe, prefix } (prefix = arguments before OpenCode's own).
// Never the npm shim on Windows: opencode.cmd cannot carry a multi-line prompt through cmd.exe,
// and killing the shim leaves opencode.exe running.
export function resolveOpenCode(env = process.env) {
  if (env.HARNESS_OPENCODE_EXE) {
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
      if (fs.existsSync(exe)) return { exe, prefix: [] };
    }
  }
  throw new OpenCodeInfraError('opencode not found', 'opencode is not on PATH (set HARNESS_OPENCODE_EXE to the real executable).');
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

// A short OpenCode command (`session list`, `export`), bounded and killed if it overruns.
// Resolves { code, stdout } or null on a timeout or a spawn error.
function execBounded(cmd, args, { cwd, timeoutMs, env }) {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnDetached(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve(null); return; }
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.resume();
    const timer = setTimeout(() => { killTree(child); resolve(null); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString('utf8') }); });
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
// is scoped to the project of its working directory, so it runs in workDir.
export async function findSession(cmd, { workDir, title, startedMs, timeoutMs, env }) {
  const res = await execBounded(cmd, ['session', 'list', '--format', 'json', '-n', '20'], { cwd: workDir, timeoutMs, env });
  if (!res || !res.stdout.trim()) return null;
  let sessions;
  try { sessions = JSON.parse(res.stdout); } catch { return null; }
  if (!Array.isArray(sessions)) sessions = [sessions];
  return sessions.find((s) => s && s.title === title && s.directory && sameDir(s.directory, workDir)
    && Number(s.created) >= startedMs - 1000) || null;
}

// The agent OpenCode recorded for the session (`opencode export <id>`: .info.agent), or null.
export async function sessionAgent(cmd, { workDir, sessionId, timeoutMs = 30000, env }) {
  const res = await execBounded(cmd, ['export', sessionId], { cwd: workDir, timeoutMs, env });
  if (!res || res.code !== 0) return null;
  try { return JSON.parse(res.stdout)?.info?.agent ?? null; } catch { return null; }
}

function tail(file, lines = 30) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text.split(/\r?\n/).slice(-lines).join('\n') : '(empty)';
  } catch { return '(no output file)'; }
}

/**
 * Runs `opencode <args...> --title <title-token> <prompt>` in workDir, watched.
 * Returns { output, stdout, stderr, exitCode, sessionId, title, agentFallback, sessionAgent, files, seconds }.
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
      session = await findSession(cmd, { workDir, title, startedMs, env, timeoutMs: Math.max(0, startupMs - elapsed()) });
    }
    if (!session && !hasExited()) {
      killTree(child);
      const secs = Math.round(startupMs / 1000);
      throw fail(`no session in ${secs} s`, `OpenCode created no session within ${secs} s (is stdin closed?); killed pid ${child.pid}`);
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
      const seen = await findSession(cmd, { workDir, title, startedMs, env, timeoutMs: Math.max(0, Math.min(30_000, totalTimeoutMs - elapsed())) });
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
      session = await findSession(cmd, { workDir, title, startedMs, env, timeoutMs: Math.max(0, Math.min(15_000, totalTimeoutMs - elapsed())) });
      if (!session) throw fail(`exited without a session (exit ${exitCode})`, `OpenCode exited with ${exitCode} without creating a session`);
    }
  } catch (e) {
    killTree(child);
    throw e;
  }

  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  const agentIdx = args.indexOf('--agent');
  const requestedAgent = agentIdx >= 0 ? args[agentIdx + 1] : null;
  const recordedAgent = requestedAgent ? await sessionAgent(cmd, { workDir, sessionId: session.id, env }) : null;
  const agentFallback = !requestedAgent ? false
    : recordedAgent ? recordedAgent !== requestedAgent
    : agentWarning(stderr, requestedAgent);
  if (exitCode === 0) for (const f of files) fs.rmSync(f, { force: true });
  else log(`opencode: exit ${exitCode}; files kept: ${files.join(', ')}`);
  return {
    output: `${stdout.trimEnd()}\n${stderr.trimEnd()}`.trim(),
    stdout, stderr, exitCode, sessionId: session.id, title,
    agentFallback, sessionAgent: recordedAgent,
    files: exitCode === 0 ? [] : files,
    seconds: Math.round(elapsed() / 1000),
  };
}
