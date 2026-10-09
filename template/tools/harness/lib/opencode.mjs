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
//      Since #146 the run sets OpenCode's experimental.continue_loop_on_deny, so a denied call (an
//      auto-rejection, or a rule's deny) no longer ends the run: the model sees the error and goes
//      on. A denial counts as recovered only when the record shows the model working after it; the
//      same call denied twice, or a third different denial, fails the run, killed as soon as the
//      record shows it (denialVerdict). A record that ends on a denial is a run that stopped there.
//   8. The run gets a scratch folder of its own outside every checkout, harness-run-<title> under
//      /tmp (the user's TEMP on Windows), as TMPDIR, TEMP and TMP, and the pointer names it. The
//      agent files allow no harness-run path: the run's own OPENCODE_CONFIG_DIR carries a copy of
//      its agent file with one more external_directory allow, this folder exactly, so another
//      run's folder is rejected like any outside path (Sol's R1 on PR 137). The folder is removed
//      after a clean run and kept after a failed one, which runFailure decides for the runner as
//      for its callers (an agent fallback is failed, Sol's R8); a thrown failure names it as
//      `e.scratch`, from its first step on (L66, #139).
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

// A failed run on Alibaba's Token Plan whose stderr (OpenCode's own, not the model's output) says the
// key was refused: an auth.json entry in the data
// directory overrides ALIBABA_TOKEN_PLAN_API_KEY, and a stale one breaks the provider there (the
// owner, 2026-10-05). The reason names the directory so the owner can clear it; null otherwise.
export function keyProblem(text, modelId, dataHome) {
  if (!String(modelId).startsWith('alibaba-token-plan/') || !/invalid api[- ]?key/i.test(String(text))) return null;
  return `invalid API key for alibaba-token-plan: the auth.json in ${dataHome} may hold a stale Alibaba entry, which `
    + 'overrides ALIBABA_TOKEN_PLAN_API_KEY. Tell the owner which XDG_DATA_HOME this was; never print, copy or edit the key or auth.json';
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

// The efforts (variants) OpenCode offers for a model, from `opencode models <provider> --verbose`,
// which prints each id followed by its JSON; null when they cannot be read.
export async function modelVariants(cmd, id, { env, cwd, timeoutMs = 60_000 }) {
  const r = await execBounded(cmd, ['models', id.split('/')[0], '--verbose'], { cwd, env, timeoutMs });
  if (!r || r.code !== 0) return null;
  const at = r.stdout.indexOf(`${id}\n`);
  const start = at < 0 ? -1 : r.stdout.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < r.stdout.length; i++) {
    if (r.stdout[i] === '{') depth++;
    else if (r.stdout[i] === '}' && --depth === 0) {
      try { return Object.keys(JSON.parse(r.stdout.slice(start, i + 1)).variants ?? {}); } catch { return null; }
    }
  }
  return null;
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
  // Its key comes only from ALIBABA_TOKEN_PLAN_API_KEY; an auth.json entry would override it (the owner, 2026-10-05).
  if (provider === 'alibaba-token-plan') {
    return 'Alibaba Token Plan lists no models: ALIBABA_TOKEN_PLAN_API_KEY is not in this environment (in WSL it comes from '
      + '~/.config/ai-keys.env, loaded by ~/.bashrc and ~/.profile). Restart the session or shell; if it is still missing, '
      + `tell the owner. Do not retry; never add the key with \`opencode auth login\` (data directory ${dataHome})`;
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

// A denied tool call as OpenCode 1.18.34 records it: auto-rejected (an "ask" in a non-interactive
// run) or denied by a rule.
const DENIED = /rejected permission to use this specific tool call|rule which prevents you from using this specific tool call/i;

// Why a returned run failed, in the order that names the real cause (#146), or null: a run the watch
// stopped on its denials (killed, so its exit code says nothing), OpenCode's own exit, the agent
// falling back, then a denial. keyProblem is the caller's reading of a failed exit.
export function runFailure(run, keyProblem = () => null) {
  const denied = () => `permission rejected: ${run.permissionRejected}${run.permissionHint ? `; ${run.permissionHint}` : ''}`;
  if (run.stopped) return denied();
  if (run.exitCode !== 0) return keyProblem(run.stderr) ?? `exit ${run.exitCode}`;
  if (run.agentFallback) {
    return run.agentLoad === 'load-failure'
      ? 'agent-load-failure: OpenCode ran its default agent although the run gave it the agent file'
      : 'fell back to the default agent';
  }
  if (run.permissionRejected) return denied();
  return null;
}

// The denied calls a run went past, for its log (#146), or null.
export function deniedNote(run) {
  const d = run.permissionsDenied ?? [];
  return d.length ? `${d.length} denied call${d.length > 1 ? 's' : ''}, the model went on: ${d.map((x) => `${x.tool} ${x.input}`).join('; ')}` : null;
}

// The verdict on a run's denied calls (#146), or null when the model may go on: the same call
// (tool and input) denied twice means it retried what it had been refused; three different ones
// are a pattern, not a slip.
export function denialVerdict(denials) {
  const counts = new Map();
  for (const d of denials) {
    const key = `${d.tool}\u0000${d.key ?? d.input}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ([...counts.values()].some((n) => n >= 2)) return 'permission-rejected-after-retry';
  if (counts.size >= 3) return 'permission-rejected-x3-distinct';
  return null;
}

// A call's whole input as one string, keys sorted at every level: the same call written with its
// keys in another order is the same call, and nothing is cut, so two calls that differ only past
// the shown part are two (Sol's R2, R5 on PR 155).
export function canonicalInput(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalInput(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// How many denial marks OpenCode has printed so far: its rejection line, or a rule's error. A rise
// only tells the watch to read the record; a quoted line costs one export, nothing more.
function denialMarks(text) {
  return (String(text).match(/permission requested: [^\r\n]*?; auto-rejecting|rule which prevents you from using this specific tool call/g) ?? []).length;
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
    const parts = (j.messages ?? []).flatMap((m) => (m.parts ?? []).map((p) => ({ ...p, role: m.info?.role ?? m.role ?? null })));
    const isDenial = (p) => p.type === 'tool' && p.state?.status === 'error' && DENIED.test(String(p.state.error ?? ''));
    // The model working: its own tool call that ran (or was denied), or its own text. Not a user's
    // or a synthetic message, not a call that never ran (Sol's R1 on PR 155).
    const worked = (q) => q.role === 'assistant' && !q.synthetic
      && ((q.type === 'tool' && ['running', 'completed', 'error'].includes(q.state?.status))
        || (q.type === 'text' && String(q.text ?? '').trim()));
    // Each denied call, and whether the model went on after it.
    const denials = parts.flatMap((p, i) => {
      if (!isDenial(p)) return [];
      const input = p.state?.input ?? {};
      return [{
        tool: p.tool ?? null,
        input: String(input.command ?? input.filePath ?? input.path ?? JSON.stringify(input)).slice(0, 300),
        key: canonicalInput(input),
        kind: /rejected permission/i.test(String(p.state.error)) ? 'rejected' : 'denied',
        recovered: parts.slice(i + 1).some(worked),
      }];
    });
    return { agent: j.info?.agent ?? null, rejected: denials.some((d) => d.kind === 'rejected'), denials };
  } catch { return null; }
}

function tail(file, lines = 30) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text.split(/\r?\n/).slice(-lines).join('\n') : '(empty)';
  } catch { return '(no output file)'; }
}

// Windows caps a process command line at 32767 characters; Linux a single argument at 128 KiB
// (L60). The brief never rides the command line, so this is a tripwire, not a delivery path.
export function commandLineTooLong(parts, platform = process.platform) {
  return platform === 'win32' && parts.join(' ').length > 32000;
}

// The brief file every run's pointer prompt names: inside the worktree (the agent's tools reach
// only there, L36/#501), deleted with the run's log files on success, kept and named on failure.
export function briefFileName(title) {
  return `.harness-brief-${title}.md`;
}

// The external_directory pattern for exactly this run's scratch folder (L66). OpenCode 1.18.34's
// matcher turns every `\` into `/`, in the path asked about and in the pattern alike, then matches
// the whole path; so the folder's own path, with `/`, and `/*` match it and its subfolders and
// nothing else: not another run's folder, not one whose name only starts with this one's (probed
// 2026-10-09). No `?` stands in for a separator: `?` matches any character (Sol's R1, PR 137 r2).
export function scratchAllow(scratch) {
  return `${scratch.replace(/\\/g, '/')}/*`;
}

// The agent file with one more external_directory rule, `"<pattern>": allow`: last in the block,
// because OpenCode 1.18.34 applies the last rule that matches, in file order (probed 2026-10-09:
// an allow above `"*": deny` is overridden), or as a block under `permission:`. A leading BOM, CRLF line ends and trailing blanks on the
// `---` lines are read as such, and the file keeps its own line ends (Sol's R5, PR 137 r2). Null
// when there is no front matter or permission block, when external_directory is not a block, or
// when the pattern cannot be written inside double quotes.
export function withScratchAllow(text, pattern) {
  if (/["\\\r\n]/.test(pattern)) return null;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.slice(bom.length).split(/\r?\n/);
  const fence = (l) => /^---[ \t]*$/.test(l);
  if (!fence(lines[0])) return null;
  const end = lines.findIndex((l, i) => i > 0 && fence(l));
  if (end < 0) return null;
  const at = (re) => lines.findIndex((l, i) => i < end && re.test(l));
  const rule = `    "${pattern}": allow`;
  const ed = at(/^  external_directory:/);
  if (ed >= 0) {
    if (!/^  external_directory:[ \t]*$/.test(lines[ed])) return null;
    // The block runs to the next line indented less, past blank and comment lines (Sol's R2, PR 152).
    let last = ed;
    for (let i = ed + 1; i < end && (/^ {4}/.test(lines[i]) || /^[ \t]*(#.*)?$/.test(lines[i])); i += 1) {
      if (/^ {4}/.test(lines[i]) && !/^[ \t]*#/.test(lines[i])) last = i;
    }
    lines.splice(last + 1, 0, rule);
  } else {
    const perm = at(/^permission:[ \t]*$/);
    if (perm < 0) return null;
    lines.splice(perm + 1, 0, '  external_directory:', rule);
  }
  return bom + lines.join(eol);
}

// The run's own OPENCODE_CONFIG_DIR (L66), or null (and logged) when its agent file cannot carry
// the scratch allow. Where the agent comes from decides what is copied: an inherited
// OPENCODE_CONFIG_DIR (the reviewer's, L34) is replaced by this one, so all of it is copied but
// OpenCode's own node_modules; the worktree's .opencode is still read as the project's, and the
// agent file in this directory applies over it (probed on OpenCode 1.18.34), so only that is.
function perRunConfig({ agent, scratch, workDir, env, dir, log }) {
  const inherited = env.OPENCODE_CONFIG_DIR || null;
  const base = inherited ?? (env.OPENCODE_DISABLE_PROJECT_CONFIG === '1' ? null : path.join(workDir, '.opencode'));
  const source = base ? path.join(base, 'agents', `${agent}.md`) : null;
  if (!source || !fs.existsSync(source)) {
    log(`opencode: no agent file ${source ?? `for ${agent}`} to allow the scratch folder in; writes there will be rejected`);
    return { dir: null, given: false };
  }
  const text = withScratchAllow(fs.readFileSync(source, 'utf8'), scratchAllow(scratch));
  if (!text) {
    log(`opencode: ${source} has no permission block the scratch allow can go in; writes to the scratch folder will be rejected`);
    return { dir: null, given: true };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (inherited) fs.cpSync(inherited, dir, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', `${agent}.md`), text);
  return { dir, given: true };
}

// The run's OPENCODE_CONFIG_CONTENT: the caller's, if any, with experimental.continue_loop_on_deny
// set (#146). OpenCode reads it as local config, over the files.
// OpenCode reads its config as JSONC: comments and trailing commas, never inside a string (Sol's
// R4 on PR 155). Content that still does not parse is returned as it is, flag unset, and logged by
// the caller: a denial then ends the run, which fails as before.
export function withContinueOnDeny(content) {
  if (!content || !String(content).trim()) return JSON.stringify({ experimental: { continue_loop_on_deny: true } });
  let config;
  try { config = JSON.parse(stripJsonc(String(content))); } catch { return null; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const experimental = config.experimental && typeof config.experimental === 'object' ? config.experimental : {};
  return JSON.stringify({ ...config, experimental: { ...experimental, continue_loop_on_deny: true } });
}

function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else if (c === ',' && /^\s*[}\]]/.test(stripComments(text.slice(i + 1)))) {
      // A trailing comma, outside any string: dropped (Sol's R1 on PR 155, round 2).
    } else out += c;
  }
  return out;
}

// The text with its comments blanked, strings untouched: what follows a comma, for stripJsonc.
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') return out + text.slice(i);              // what follows is a value, not a } or ]
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += ' '; }
    else if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; out += ' '; }
    else out += c;
  }
  return out;
}

/**
 * Runs `opencode <args...> --title <title-token> <pointer prompt>` in workDir, watched. The
 * prompt is written to `<workDir>/.harness-brief-<title>.md` and the command line carries only
 * a short pointer to it (L60): the whole brief never passes through argv, which Windows caps at
 * 32767 characters (IC2's T146/T148 were blocked by it) and Linux per argument at 128 KiB.
 * Returns { output, stdout, stderr, exitCode, sessionId, title, agentFallback, sessionAgent,
 *   agentLoad, permissionRejected, permissionHint, permissionsDenied, stopped, files, briefFile, scratch, seconds }.
 * agentLoad, when the agent fell back: 'load-failure' if the run was given its agent file,
 * 'fallback' if there was none. permissionsDenied: the denied calls the model went past. stopped:
 * the denial verdict the watch killed the run on (its exit code is then the kill's), or null.
 * A non-zero exit is returned, not thrown: the caller decides.
 */
export async function runOpenCodeWatched({
  args, prompt, workDir, title,
  startupTimeoutMs = 180_000, totalTimeoutMs = 3_600_000, idleTimeoutMs = 600_000, pollMs = 10_000,
  logDir = path.join(os.tmpdir(), 'harness-opencode'), opencode, env = process.env, log = () => {},
  // Not os.tmpdir() on POSIX: a caller's TMPDIR (a Claude session's scratchpad) is not where
  // scratch belongs.
  scratchRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp',
}) {
  if (args[0] !== 'run') throw new Error(`runOpenCodeWatched runs 'opencode run'; got '${args[0]}'.`);
  const cmd = opencode ?? resolveOpenCode(env);
  workDir = fs.realpathSync(workDir);
  title = `${title}-${randomBytes(6).toString('hex')}`;
  fs.mkdirSync(logDir, { recursive: true });
  const outFile = path.join(logDir, `${title}.out.txt`);
  const errFile = path.join(logDir, `${title}.err.txt`);
  // Before the brief is written: a failure here leaves nothing in the worktree. Its real path (a Windows TEMP may be an 8.3 short name), the one OpenCode asks about.
  fs.mkdirSync(path.join(scratchRoot, `harness-run-${title}`), { recursive: true });
  const scratch = fs.realpathSync.native(path.join(scratchRoot, `harness-run-${title}`));
  // From here on, a thrown failure names the folder it leaves behind (#139).
  const keptScratch = (e) => {
    if (e && typeof e === 'object') e.scratch = fs.existsSync(scratch) ? scratch : null;
    if (e?.scratch) log(`opencode: scratch kept: ${e.scratch}`);
    return e;
  };
  const agentIdx = args.indexOf('--agent');
  const requestedAgent = agentIdx >= 0 ? args[agentIdx + 1] : null;
  let agentConfig;
  try {
    agentConfig = requestedAgent
      ? perRunConfig({ agent: requestedAgent, scratch, workDir, env, dir: path.join(logDir, `${title}.config`), log }) : { dir: null, given: false };
  } catch (e) { throw keptScratch(e); }
  const runConfig = agentConfig.dir;
  const runEnv = { ...env, TMPDIR: scratch, TEMP: scratch, TMP: scratch, ...(runConfig ? { OPENCODE_CONFIG_DIR: runConfig } : {}),
    OPENCODE_CONFIG_CONTENT: withContinueOnDeny(env.OPENCODE_CONFIG_CONTENT) ?? env.OPENCODE_CONFIG_CONTENT };
  if (runEnv.OPENCODE_CONFIG_CONTENT === env.OPENCODE_CONFIG_CONTENT) {
    log('opencode: OPENCODE_CONFIG_CONTENT does not parse; passed on as it is, without continue_loop_on_deny: a denial will end the run');
  }
  const briefFile = path.join(workDir, briefFileName(title));
  try { fs.writeFileSync(briefFile, prompt); } catch (e) {
    if (runConfig) fs.rmSync(runConfig, { recursive: true, force: true });
    throw keptScratch(e);
  }
  const files = [outFile, errFile, briefFile];
  const pointer = `Your complete brief for this run is the file ${briefFileName(title)} at the root of this worktree.`
    + ' Read that file first and follow it exactly; never edit, commit or delete it.'
    + ` Your scratch folder for this run is ${scratch} (also $TMPDIR): temporary files go there, never anywhere else outside this worktree.`;
  const all = [...args, '--title', title, pointer];
  // The brief leaves the worktree when the run is not clean (L60): kept for diagnosis with the
  // log files, but never left as untracked work a reset would save as the implementer's (#87).
  // A cross-device logDir makes rename fail (EXDEV), so a failed rename falls back to copy+delete;
  // if nothing works the source is still removed — the worktree is never left holding it — and
  // the kept-files list never names a path that does not exist.
  const keptBrief = path.join(logDir, `${title}.brief.md`);
  let briefKeptPath = null;
  const shelveBrief = () => {
    if (briefKeptPath !== null) return;                                  // already shelved or given up
    let ok = false;
    try {
      fs.renameSync(briefFile, keptBrief);
      ok = true;
    } catch {
      try {
        fs.copyFileSync(briefFile, keptBrief);
        fs.rmSync(briefFile, { force: true });
        ok = true;
      } catch { /* neither rename nor copy worked */ }
    }
    if (!ok) fs.rmSync(briefFile, { force: true });
    const i = files.indexOf(briefFile);
    if (ok) { files[i] = keptBrief; briefKeptPath = keptBrief; }
    else if (i >= 0) files.splice(i, 1);
  };
  let child = null;
  try {
    if (commandLineTooLong(all)) {
      throw new Error('The opencode command line exceeds what Windows allows (32767 characters). Shorten the brief.');
    }

    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const startedMs = Date.now();
    try {
      child = spawnDetached(cmd, all, { cwd: workDir, env: runEnv, stdio: ['ignore', outFd, errFd] });
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
    let stoppedFor = null;
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
      let recorded = 0;
      while (!hasExited()) {
        const remaining = Math.max(0, totalTimeoutMs - elapsed());
        const wait = session ? Math.min(idleTimeoutMs > 0 ? idlePollMs : pollMs, remaining) : remaining;
        if (await waitExit(wait)) break;
        if (elapsed() >= totalTimeoutMs) {
          killTree(child);
          const secs = Math.round(totalTimeoutMs / 1000);
          throw fail(`no exit in ${secs} s`, `OpenCode did not finish within ${secs} s; killed pid ${child.pid}`);
        }
        // A new denial mark: read the record, and stop the run at once when it is past saving (#146).
        // A mark stays unaccounted until the record holds as many denials, so a stale or failed
        // export is read again at the next poll (Sol's R3 on PR 155).
        const marks = session ? denialMarks(`${fs.readFileSync(outFile, 'utf8')}\n${fs.readFileSync(errFile, 'utf8')}`) : 0;
        if (marks > recorded) {
          const seen = await sessionRecord(cmd, { workDir, sessionId: session.id, outFile: path.join(logDir, `${title}.export.json`), env, timeoutMs: 30_000 });
          fs.rmSync(path.join(logDir, `${title}.export.json`), { force: true });
          if (seen) recorded = Math.max(recorded, seen.denials.length);
          const verdict = seen ? denialVerdict(seen.denials) : null;
          if (verdict && !hasExited()) {
            stoppedFor = verdict;
            killTree(child);
            log(`opencode: ${verdict}; killed pid ${child.pid}`);
            break;
          }
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
      shelveBrief();
      throw e;
    }

    const stdout = fs.readFileSync(outFile, 'utf8');
    const stderr = fs.readFileSync(errFile, 'utf8');
    const exportFile = path.join(logDir, `${title}.export.json`);
    const record = await sessionRecord(cmd, { workDir, sessionId: session.id, outFile: exportFile, env });
    const recordedAgent = requestedAgent ? record?.agent ?? null : null;
    fs.rmSync(exportFile, { force: true });
    const agentFallback = !requestedAgent ? false
      : recordedAgent ? recordedAgent !== requestedAgent
      : agentWarning(stderr, requestedAgent);
    const agentLoad = !agentFallback ? null : agentConfig.given ? 'load-failure' : 'fallback';
    const said = permissionRejection(`${stdout}\n${stderr}`);
    // The record decides (#146): past a threshold, or ended on a denial, the run failed; denials the
    // model went past are reported. Without a record, OpenCode's own line decides alone, as before.
    const denials = record?.denials ?? [];
    const last = denials.at(-1);
    const verdict = stoppedFor ?? (record ? denialVerdict(denials) : null);
    const lastDenied = said ?? (last ? `${last.tool} ${last.input}` : 'a tool call (in the session record)');
    const permissionRejected = verdict ? `${verdict}: ${lastDenied}`
      : !record ? said
      : last && !last.recovered ? lastDenied : null;
    const permissionsDenied = permissionRejected ? [] : denials;
    const permissionHint = permissionRejected ? rejectionHint(`${stdout}\n${stderr}`) : null;
    if (runConfig) fs.rmSync(runConfig, { recursive: true, force: true });
    const run = {
      output: `${stdout.trimEnd()}\n${stderr.trimEnd()}`.trim(),
      stdout, stderr, exitCode, sessionId: session.id, title,
      agentFallback, agentLoad, sessionAgent: recordedAgent, permissionRejected, permissionHint, permissionsDenied, stopped: stoppedFor,
    };
    // One predicate for what failed, the callers' own (#139): what they will not accept keeps its
    // files, its brief and its scratch folder.
    const failure = runFailure(run);
    if (!failure) {
      for (const f of files) fs.rmSync(f, { force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    } else {
      shelveBrief();
      log(`opencode: ${failure}; files kept: ${files.join(', ')}; scratch kept: ${scratch}`);
    }
    return {
      ...run,
      files: failure ? files : [],
      briefFile: failure ? briefKeptPath : briefFile,
      scratch: failure ? scratch : null,
      seconds: Math.round(elapsed() / 1000),
    };
  } catch (e) {
    shelveBrief();
    if (child) { try { killTree(child); } catch { /* already dead */ } }
    if (runConfig) fs.rmSync(runConfig, { recursive: true, force: true });
    keptScratch(e);
    // The failure was worded before shelving moved or dropped the brief: name where it actually is.
    if (briefKeptPath && e.message && e.message.includes(briefFile)) e.message = e.message.split(briefFile).join(briefKeptPath);
    // ...and rebuild the kept-files list itself, which the hopeless fallback shortens (round-2 R1).
    const seg = /files kept: (.*?)\. stderr tail:/s.exec(e.message ?? '');
    if (seg && seg[1] !== files.join(', ')) {
      e.message = e.message.replace(`files kept: ${seg[1]}.`, () => `files kept: ${files.join(', ')}.`);
    }
    throw e;
}
}
