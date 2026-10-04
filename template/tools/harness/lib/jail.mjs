import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The reviewer's credential jail (#68). The guard (lib/guard.mjs) reads a reviewer's commands and
// refuses a push or a gh write, but no reading of shell text is complete (Sol's five rounds on PR 66).
// So a reviewer's command also runs where the user's GitHub credentials do not exist: bubblewrap
// (bwrap) puts an empty directory over each place they are kept, removes the variables that carry a
// token, and gives the command its own process namespace, so that no /proc/<pid>/root of a process
// outside it leads back to them. Whatever the command types, a script file or HOME=… included, a
// push finds no SSH key and gh finds no login. A public repository is still fetched over HTTPS.
//
// Hidden (masked: an empty directory, or /dev/null over a file or a socket): ~/.ssh; gh's config
// directory wherever gh may look for it ($GH_CONFIG_DIR, $XDG_CONFIG_HOME/gh and ~/.config/gh,
// all three, so unsetting a variable finds none: Sol's R5 on PR 74); /run/user (the session bus,
// so a keyring, and agents' sockets); the session bus at any other path; the ssh agent's and VS
// Code's git askpass sockets; git's credential cache sockets and stored credentials;
// ~/.netrc. Unset: the variables that carry a token, an askpass or a socket, and every GIT_CONFIG_*
// (git config given in the environment). Git's config files, global (~/.gitconfig and both XDG
// places), system, this repository's, and any a GIT_CONFIG_* variable named, are replaced by copies without what can authenticate (http.*, credential.*, url.*, remote push
// URLs, a URL's user:password@, anything shaped like a GitHub token), and the files they include
// are masked. A reviewer's Read, Grep and Glob are refused on all of these and on /proc
// (hiddenTarget, used by the guard hook: Sol's R1 on PR 74).
// Not hidden: a token the user copied somewhere no tool reads from; another repository's
// .git/config; a session bus on an abstract socket, which no mount can hide (the jail says so).

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
export const UNSET = [...TOKEN_VARS, 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'GIT_ASKPASS', 'SSH_ASKPASS',
  'VSCODE_GIT_IPC_HANDLE', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN', 'VSCODE_GIT_ASKPASS_EXTRA_ARGS'];

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const kind = (p) => { try { return fs.statSync(p); } catch { return null; } };

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

// Each config file git may read here, by default or once a variable is unset, with its clean
// entries; and the files they include, to mask.
function gitConfigs(env, cwd) {
  const home = env.HOME || os.homedir();
  const plain = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_CONFIG')));
  const at = (args) => git(args, { cwd, env: plain }).split('\0')[0].trim();
  const system = at(['config', '--system', '--list', '--show-origin', '--null']);
  const common = at(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = at(['rev-parse', '--path-format=absolute', '--git-dir']);
  const candidates = [path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config'),
    env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, 'git', 'config'),
    system.startsWith('file:') ? system.slice(5) : '/etc/gitconfig',
    common && path.join(common, 'config'), gitDir && path.join(gitDir, 'config.worktree'),
    env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_SYSTEM, env.GIT_CONFIG];
  const files = new Map();
  for (const c of candidates.filter(Boolean)) {
    const f = real(path.resolve(cwd, c));
    if (!f || files.has(f) || !kind(f)?.isFile()) continue;
    const entries = git(['config', '--file', f, '--no-includes', '--list', '--null'], { cwd, env: plain })
      .split('\0').filter(Boolean).map((kv) => {
        const nl = kv.indexOf('\n');
        return cleanEntry(nl < 0 ? kv : kv.slice(0, nl), nl < 0 ? null : kv.slice(nl + 1));
      });
    files.set(f, entries.filter(Boolean));
  }
  // Includes, followed whether or not they apply here: the copies drop them, so mask them all.
  const included = new Set();
  const work = [...files.keys()];
  while (work.length && included.size < 100) {
    const f = work.shift();
    const out = git(['config', '--file', f, '--no-includes', '--null', '--get-regexp', '^include(if\\..*)?\\.path$'], { cwd, env: plain });
    for (const kv of out.split('\0').filter(Boolean)) {
      const v = kv.slice(kv.indexOf('\n') + 1).replace(/^~(?=\/)/, home);
      const r = real(path.resolve(path.dirname(f), v));
      if (r && !files.has(r) && !included.has(r)) { included.add(r); work.push(r); }
    }
  }
  return { files, included: [...included] };
}

function cleanCopy(text) {
  const dir = path.join(os.tmpdir(), `harness-jail-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 32)}.gitconfig`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// What the jail hides here: { mask: [paths], configs: Map(file -> entries), gaps: [why] }.
function hidden(env, cwd) {
  const home = env.HOME || os.homedir();
  const configHomes = [env.XDG_CONFIG_HOME, path.join(home, '.config')].filter(Boolean);
  const cacheHomes = [env.XDG_CACHE_HOME, path.join(home, '.cache')].filter(Boolean);
  const bus = busPaths(env.DBUS_SESSION_BUS_ADDRESS);
  const places = [path.join(home, '.ssh'), env.GH_CONFIG_DIR, ...configHomes.map((c) => path.join(c, 'gh')),
    '/run/user', env.SSH_AUTH_SOCK, env.VSCODE_GIT_IPC_HANDLE, ...bus.paths,
    path.join(home, '.git-credentials'), ...configHomes.map((c) => path.join(c, 'git', 'credentials')),
    ...cacheHomes.map((c) => path.join(c, 'git', 'credential')), path.join(home, '.git-credential-cache'),
    path.join(home, '.netrc')];
  const { files: configs, included } = gitConfigs(env, cwd);
  const mask = [...new Set([...places, ...included].filter(Boolean).map(real).filter(Boolean))];
  return { mask, configs, gaps: bus.abstract ? ['the session bus is on an abstract socket, which no mount hides'] : [] };
}

// bwrap's arguments, before `--` and the command, for this environment and working directory.
export function jailArgs(env = process.env, cwd = process.cwd()) {
  const { mask, configs } = hidden(env, cwd);
  const args = ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent'];
  for (const [file, entries] of configs) args.push('--ro-bind', cleanCopy(configText(entries)), file);
  for (const r of mask) args.push(...(kind(r)?.isDirectory() ? ['--tmpfs', r] : ['--ro-bind', '/dev/null', r]));
  const unset = [...UNSET, ...Object.keys(env).filter((v) => v.startsWith('GIT_CONFIG'))];
  for (const v of unset) args.push('--unsetenv', v);
  return args;
}

// Why a reviewer may not read `target` (a Read, Grep or Glob path), or null: it is, holds, or lies
// under a place the jail hides, or /proc (another process's environment).
export function hiddenTarget(target, { env = process.env, cwd = process.cwd() } = {}) {
  let t = path.resolve(cwd, target);
  // The nearest existing ancestor, resolved, then the rest: a link cannot lead around the check.
  let rest = '';
  while (!real(t) && path.dirname(t) !== t) { rest = path.join(path.basename(t), rest); t = path.dirname(t); }
  t = path.join(real(t) ?? t, rest);
  const { mask, configs } = hidden(env, cwd);
  for (const h of ['/proc', ...mask, ...configs.keys()]) {
    if (t === h || t.startsWith(`${h}/`) || h.startsWith(t === '/' ? '/' : `${t}/`)) return `${target} is or holds ${h}, which the reviewer may not read (#68)`;
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

// { exe, args, gaps } when the jail works here (gaps: what it cannot hide), else { off: why }.
export function credentialJail({ env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  if (platform !== 'linux') return { off: `bwrap runs on Linux only, and this is ${platform}` };
  const exe = findBwrap(env);
  if (!exe) return { off: env.HARNESS_BWRAP ? `HARNESS_BWRAP points at a missing file: ${env.HARNESS_BWRAP}` : 'bwrap is not installed (apt install bubblewrap)' };
  const args = jailArgs(env, cwd);
  const probe = spawnSync(exe, [...args, '--', 'true'], { env, encoding: 'utf8', timeout: 10_000 });
  if (probe.status !== 0) return { off: `bwrap does not run here: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim()}` };
  return { exe, args, gaps: hidden(env, cwd).gaps };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The command line that runs `command` in the jail, for the Bash tool.
export function jailCommand(command, jail) {
  return [jail.exe, ...jail.args, '--', 'bash', '-c', command].map(quote).join(' ');
}

export const OFF_WARNING = (why) => `WARNING: the reviewer's credential jail is off (${why}). It keeps the user's `
  + 'GitHub credentials, and only the guard stops a push or a gh write (#68).';
