import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The reviewer's credential jail (#68). The guard (lib/guard.mjs) reads a reviewer's commands and
// refuses a push or a gh write, but no reading of shell text is complete (Sol's five rounds on PR 66).
// So a reviewer's command also runs where the user's GitHub credentials do not exist: bubblewrap
// (bwrap), in its own process namespace, so that no /proc/<pid>/root of a process outside leads
// back to them. Whatever the command types, a script file or HOME=… included, a push finds no SSH
// key and gh finds no login. A public repository is still fetched over HTTPS.
//
// It keeps what is listed, not hides what is found (the owner's choice after Sol's R1–R4 of round
// 2 on PR 74: each round found another credential that config or a variable points to):
// - The home directory is an empty tmpfs. Bound back: the reviewer's worktree and the git
//   directory (read-write); the main checkout, the folders of the tools on PATH under home, and
//   harness.json's `jail.keep` (read-only); what the caller adds. In every working tree, PROTECTED
//   and git's hooks stay read-only (Sol's R1 of round 3).
// - The command inherits no descriptor above 2, and reads stdin from /dev/null (R2 of round 3).
// - The environment is cleared. Kept: KEEP_ENV, names starting with KEEP_PREFIX, and *_API_KEY
//   (model providers), never a GH_ or GITHUB name.
// Outside home, the standard places are still masked (an empty directory, or /dev/null over a file
// or socket): /run/user and $XDG_RUNTIME_DIR (the session bus, so a keyring, and agents' sockets);
// the session bus, the ssh agent named and every ssh-* agent directory in /tmp and $TMPDIR (R3),
// VS Code's askpass socket; git's credential cache at $XDG_CACHE_HOME (R4); gh's store at $GH_CONFIG_DIR and $XDG_CONFIG_HOME/gh. Git's
// config files (system, this repository's, any a GIT_CONFIG_* named) are bound to copies without
// what can authenticate (http.*, credential.*, url.*, include*, push URLs, a URL's user:password@,
// a GitHub-token-shaped value), and every file they include, followed to the end, is masked.
// A reviewer's Read, Grep and Glob are refused wherever the jail hides something, and on /proc
// (hiddenTarget, used by the guard hook: Sol's R1 of round 1).
// Not hidden: a credential outside home in a place no standard tool keeps one, one inside a kept
// folder or the repository's files, and a session bus on an abstract socket (reported as a gap).
//
// Linux only, and only where bwrap runs (a probe runs `true` in the jail). Elsewhere the reviewer
// runs without it, and the hook and review.mjs say so loudly: the guard still applies.
// HARNESS_BWRAP names the bwrap to use (tests use a fake one).

export const KEEP_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM',
  'TZ', 'TMPDIR', 'TMP', 'TEMP', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'NODE_OPTIONS', 'NODE_PATH'];
export const KEEP_PREFIX = ['LC_', 'XDG_', 'HARNESS_', 'OPENCODE_', 'NVM_'];

// The names of `env` the jail keeps.
export function keptEnv(env) {
  return Object.keys(env).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !/^(GH_|GITHUB)/i.test(n)
    && (KEEP_ENV.includes(n) || KEEP_PREFIX.some((p) => n.startsWith(p)) || /_API_KEY$/.test(n)));
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const kind = (p) => { try { return fs.statSync(p); } catch { return null; } };
const within = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);

// The session bus's socket paths; an abstract one cannot be masked.
function busPaths(address = '') {
  const paths = [];
  let abstract = false;
  for (const part of address.split(';')) {
    const m = part.match(/^unix:(.*)$/);
    if (!m) continue;
    for (const kv of m[1].split(',')) {
      const [k, v] = kv.split('=');
      if (k === 'path') paths.push(decodeURIComponent(v));
      if (k === 'abstract' || k === 'tmpdir') abstract = true;
    }
  }
  return { paths, abstract };
}

// Git config, without what can authenticate.
const DROP = /^(http|credential|url|include|includeif)\./i;
const TOKEN = /\b(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;
function cleanEntry(key, value) {
  if (DROP.test(key) || /^remote\..*\.pushurl$/i.test(key)) return null;
  if (value !== null && TOKEN.test(value)) return null;
  return value === null ? [key, null] : [key, value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1')];
}
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
function configText(entries) {
  let out = '';
  let head = null;
  for (const [key, value] of entries) {
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    const h = first === last ? `[${key.slice(0, first)}]` : `[${key.slice(0, first)} "${esc(key.slice(first + 1, last))}"]`;
    if (h !== head) { out += `${h}\n`; head = h; }
    out += value === null ? `\t${key.slice(last + 1)}\n` : `\t${key.slice(last + 1)} = "${esc(value)}"\n`;
  }
  return out;
}

const git = (args, { cwd, env }) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
};

// The repository's top level and main checkout, and each config file git may read here, by
// default or once a variable is unset, with its clean entries; and the files they include.
function gitPlaces(env, cwd, home) {
  const plain = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));
  const at = (args) => git(args, { cwd, env: plain }).split('\0')[0].trim();
  const system = at(['config', '--system', '--list', '--show-origin', '--null']);
  const top = at(['rev-parse', '--show-toplevel']);
  const common = at(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = at(['rev-parse', '--path-format=absolute', '--git-dir']);
  const main = common && path.basename(common) === '.git' ? path.dirname(common) : null;
  const candidates = [path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config'),
    env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, 'git', 'config'),
    system.startsWith('file:') ? system.slice(5) : '/etc/gitconfig',
    common && path.join(common, 'config'), gitDir && path.join(gitDir, 'config.worktree'),
    env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_SYSTEM, env.GIT_CONFIG];
  const configs = new Map();
  for (const c of candidates.filter(Boolean)) {
    const f = real(path.resolve(cwd, c));
    if (!f || configs.has(f) || !kind(f)?.isFile()) continue;
    const entries = git(['config', '--file', f, '--no-includes', '--list', '--null'], { cwd, env: plain })
      .split('\0').filter(Boolean).map((kv) => {
        const nl = kv.indexOf('\n');
        return cleanEntry(nl < 0 ? kv : kv.slice(0, nl), nl < 0 ? null : kv.slice(nl + 1));
      });
    configs.set(f, entries.filter(Boolean));
  }
  // Includes, followed to the end whether or not they apply here (each file once, so a cycle ends):
  // the copies drop them, so mask them all (Sol's R4 of round 2: a limit left the deeper ones).
  const included = new Set();
  const work = [...configs.keys()];
  while (work.length) {
    const f = work.shift();
    const out = git(['config', '--file', f, '--no-includes', '--null', '--get-regexp', '^include(if\\..*)?\\.path$'], { cwd, env: plain });
    for (const kv of out.split('\0').filter(Boolean)) {
      const v = kv.slice(kv.indexOf('\n') + 1).replace(/^~(?=\/)/, home);
      const r = real(path.resolve(path.dirname(f), v));
      if (r && !configs.has(r) && !included.has(r)) { included.add(r); work.push(r); }
    }
  }
  return { top: top && real(top), main: main && real(main), common: common && real(common), configs, included: [...included] };
}

// The folders of the tools on PATH under home: a bin directory's parent (node under nvm, OpenCode
// in ~/.opencode), or, for one directly in home or ~/.local, the directory and each link's target.
function toolDirs(env, home) {
  const out = [];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const d = real(dir);
    if (!d || !within(d, home) || d === home) continue;
    const parent = path.dirname(d);
    if (path.basename(d) === 'bin' && parent !== home && parent !== path.join(home, '.local')) { out.push(parent); continue; }
    out.push(d);
    for (const e of fs.readdirSync(d)) {
      const t = real(path.join(d, e));
      if (t && t !== path.join(d, e) && within(t, home)) out.push(kind(t)?.isDirectory() ? t : path.dirname(t));
    }
  }
  return out;
}

const expand = (p, home) => p.replace(/^~(?=\/|$)/, home);
// In each working tree the jail keeps: what the harness runs and decides by, never written there.
export const PROTECTED = ['harness.json', 'tools/harness', '.claude', '.opencode'];

// What the jail keeps and hides here. keep: { rw: [dirs], ro: [dirs] } from the caller.
function plan(env, cwd, keep = {}) {
  const home = real(env.HOME || os.homedir()) ?? (env.HOME || os.homedir());
  const configHome = env.XDG_CONFIG_HOME;
  const bus = busPaths(env.DBUS_SESSION_BUS_ADDRESS);
  const { top, main, common, configs, included } = gitPlaces(env, cwd, home);
  // Writable: the working tree the reviewer works in, and the git directory (its worktree's HEAD
  // and index live there). The main checkout's files are read-only when the reviewer works in a
  // worktree, so nothing it writes there runs later outside the jail.
  const rw = [...new Set([top !== main && top, common, ...(keep.rw ?? []).map((p) => real(expand(p, home)))].filter(Boolean))];
  const ro = [...new Set([main, ...toolDirs(env, home), ...(keep.ro ?? []).map((p) => real(expand(p, home)))].filter(Boolean))]
    .filter((d) => !rw.includes(d));
  // Read-only in every working tree, writable or not: the harness's policy and the code that
  // enforces it, and git's hooks, which run outside the jail when the main session uses git
  // (Sol's R1 of round 3: a reviewer that rewrote harness.json's jail.keep kept ~ for itself).
  const protect = [...new Set([top, main].filter(Boolean).flatMap((d) => PROTECTED.map((f) => path.join(d, f)))
    .concat(common ? [path.join(common, 'hooks')] : []).filter((p) => fs.existsSync(p)))];
  const kept = [...rw, ...ro];
  const tmpDirs = [...new Set(['/tmp', env.TMPDIR].filter(Boolean).map(real).filter(Boolean))];
  const agentDirs = tmpDirs.flatMap((t) => { try { return fs.readdirSync(t).filter((n) => /^ssh-/.test(n)).map((n) => path.join(t, n)); } catch { return []; } });
  const places = [env.GH_CONFIG_DIR, configHome && path.join(configHome, 'gh'), configHome && path.join(configHome, 'git', 'credentials'),
    env.XDG_CACHE_HOME && path.join(env.XDG_CACHE_HOME, 'git', 'credential'), '/run/user', env.XDG_RUNTIME_DIR,
    env.SSH_AUTH_SOCK, ...agentDirs, env.VSCODE_GIT_IPC_HANDLE, ...bus.paths, ...included];
  // Under home only what a kept folder brings back needs a mask; the rest is gone with home.
  const mask = [...new Set(places.filter(Boolean).map(real).filter(Boolean))]
    .filter((p) => !within(p, home) || kept.some((k) => within(p, k)));
  return { home, rw, ro, protect, kept, mask, configs, gaps: bus.abstract ? ['the session bus is on an abstract socket, which no mount hides'] : [] };
}

function cleanCopy(text) {
  const dir = path.join(os.tmpdir(), `harness-jail-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 32)}.gitconfig`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// bwrap's arguments, up to and including --clearenv: the caller sets the kept variables (keptEnv).
export function jailArgs(env = process.env, cwd = process.cwd(), keep = {}) {
  const p = plan(env, cwd, keep);
  const args = ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', p.home];
  // Outer folders first, so that a folder kept inside another keeps its own mode (a worktree
  // under the main checkout's .claude/ is writable, its own .claude/ read-only again).
  const binds = [...p.rw.map((d) => [d, '--bind']), ...p.ro.map((d) => [d, '--ro-bind']), ...p.protect.map((d) => [d, '--ro-bind'])]
    .sort((a, b) => a[0].length - b[0].length || (a[1] === '--bind' ? -1 : 1));
  for (const [d, how] of binds) args.push(how, d, d);
  for (const [file, entries] of p.configs) {
    if (!within(file, p.home) || p.kept.some((k) => within(file, k))) args.push('--ro-bind', cleanCopy(configText(entries)), file);
  }
  for (const r of p.mask) args.push(...(kind(r)?.isDirectory() ? ['--tmpfs', r] : ['--ro-bind', '/dev/null', r]));
  args.push('--clearenv');
  return args;
}

// Why a reviewer may not read `target` (a Read, Grep or Glob path), or null: it is, holds, or lies
// in a place the jail hides, or /proc (another process's environment).
export function hiddenTarget(target, { env = process.env, cwd = process.cwd(), keep = {} } = {}) {
  let t = path.resolve(cwd, target);
  // The nearest existing ancestor, resolved, then the rest: a link cannot lead around the check.
  let rest = '';
  while (!real(t) && path.dirname(t) !== t) { rest = path.join(path.basename(t), rest); t = path.dirname(t); }
  t = path.join(real(t) ?? t, rest);
  const p = plan(env, cwd, keep);
  for (const h of ['/proc', ...p.mask, ...p.configs.keys()]) {
    if (within(t, h) || within(h, t)) return `${target} is or holds ${h}, which the reviewer may not read (#68)`;
  }
  if (within(p.home, t) || (within(t, p.home) && !p.kept.some((k) => within(t, k)))) {
    return `${target} is in or holds the home directory outside the repository and the tools, which the reviewer may not read (#68)`;
  }
  return null;
}

function findBwrap(env) {
  if (env.HARNESS_BWRAP) return fs.existsSync(env.HARNESS_BWRAP) ? env.HARNESS_BWRAP : null;
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, 'bwrap');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// { exe, args, env: [kept names], gaps } when the jail works here (gaps: what it cannot hide), else
// { off: why }.
export function credentialJail({ env = process.env, platform = process.platform, cwd = process.cwd(), keep = {} } = {}) {
  if (platform !== 'linux') return { off: `bwrap runs on Linux only, and this is ${platform}` };
  const exe = findBwrap(env);
  if (!exe) return { off: env.HARNESS_BWRAP ? `HARNESS_BWRAP points at a missing file: ${env.HARNESS_BWRAP}` : 'bwrap is not installed (apt install bubblewrap)' };
  const args = jailArgs(env, cwd, keep);
  const probe = spawnSync(exe, [...args, '--', '/bin/sh', '-c', 'true'], { env, encoding: 'utf8', timeout: 30_000 });
  if (probe.status !== 0) return { off: `bwrap does not run here: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim()}` };
  return { exe, args, env: keptEnv(env), gaps: plan(env, cwd, keep).gaps };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The command line that runs `command` in the jail, for the Bash tool. Each kept variable is set
// from the shell's own ("$NAME"), so no value is written into the command.
// The subshell closes every descriptor above 2 it inherited and reads stdin from /dev/null, so no
// file the caller had open reaches the jail (Sol's R2 of round 3: /proc/self/fd/3 read a credential
// opened outside).
export function jailCommand(command, jail) {
  const run = [[jail.exe, ...jail.args].map(quote).join(' '), ...jail.env.map((n) => `--setenv ${n} "$${n}"`),
    ['--', 'bash', '-c', command].map(quote).join(' ')].join(' ');
  return `( for f in /proc/self/fd/*; do n=\${f##*/}; case $n in 0|1|2) ;; *) eval "exec $n>&-" 2>/dev/null ;; esac; done; exec ${run} ) </dev/null`;
}

// The arguments that run `exe` in the jail with `env`'s kept variables, for a spawn.
export function jailSpawn(jail, env, exe) {
  return [...jail.args, ...keptEnv(env).flatMap((n) => ['--setenv', n, env[n]]), '--', exe];
}

// harness.json's jail.keep (read-only folders under home to bring back), from a checkout's top.
export function keepFrom(top) {
  try { return JSON.parse(fs.readFileSync(path.join(top, 'harness.json'), 'utf8')).jail?.keep ?? []; } catch { return []; }
}

export const OFF_WARNING = (why) => `WARNING: the reviewer's credential jail is off (${why}). It keeps the user's `
  + 'GitHub credentials, and only the guard stops a push or a gh write (#68).';
