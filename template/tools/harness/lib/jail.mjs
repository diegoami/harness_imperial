import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The reviewer's credential jail (#68), against mistakes. The guard (lib/guard.mjs) reads a
// reviewer's commands and refuses a push or a gh write, but a script or a tool that pushes on its
// own goes past any reading of shell text (Sol's five rounds on PR 66). So a reviewer's command
// also runs where the user's standard GitHub credentials are not: bubblewrap (bwrap) puts an empty
// directory or /dev/null over each place git, gh and ssh keep them by default, removes the variables
// that carry a token, and gives the command its own process namespace. A push by mistake, through
// a script included, finds no SSH key, and gh finds no login. A public repository is still fetched
// over HTTPS.
//
// Hidden: ~/.ssh, gh's config directory (~/.config/gh, $XDG_CONFIG_HOME/gh, $GH_CONFIG_DIR),
// /run/user (the session bus, so a keyring, and agents' sockets), the ssh agent's socket, and git's
// stored credentials (~/.git-credentials, both XDG places' git/credentials, ~/.netrc). The guard
// hook refuses a reviewer's Read, Grep and Glob there too (hiddenTarget), so a token is never read
// into a review.
//
// Not a sandbox against an agent that hunts for credentials: a same-user jail never closes every
// path (PR 74's rounds 2 to 4 found agent sockets elsewhere, git config pointing at other stores,
// inherited descriptors, writable files that run later). That needs a separate OS user; the owner
// chose mistakes-only (2026-10-05).
//
// Off unless harness.json says `"jail": { "enabled": true }` (the owner's decision of 2026-10-05: an
// adopting project starts without it); off by choice says nothing. When enabled: Linux only, and only where bwrap runs (a probe runs `true` in the jail). Elsewhere the reviewer
// runs without it, and the hook and review.mjs say so loudly: the guard still applies.
// HARNESS_BWRAP names the bwrap to use (tests use a fake one).

export const UNSET = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'GIT_ASKPASS', 'SSH_ASKPASS'];

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const kind = (p) => { try { return fs.statSync(p); } catch { return null; } };

// Where git, gh and ssh keep the user's credentials by default (both config homes, so unsetting
// XDG_CONFIG_HOME finds none: Sol's R5 of round 1).
function hiddenPlaces(env) {
  const home = env.HOME || os.homedir();
  const configs = [...new Set([env.XDG_CONFIG_HOME, path.join(home, '.config')].filter(Boolean))];
  return [path.join(home, '.ssh'), ...configs.map((c) => path.join(c, 'gh')), env.GH_CONFIG_DIR, '/run/user',
    env.SSH_AUTH_SOCK, path.join(home, '.git-credentials'), ...configs.map((c) => path.join(c, 'git', 'credentials')),
    path.join(home, '.netrc')].filter(Boolean);
}

// Why a reviewer may not Read, Grep or Glob `target`, or null: it is, holds or lies in a hidden place.
export function hiddenTarget(target, { env = process.env, cwd = process.cwd() } = {}) {
  const t = real(path.resolve(cwd, target)) ?? path.resolve(cwd, target);
  const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  for (const h of hiddenPlaces(env).map((p) => real(p) ?? p)) {
    if (inside(t, h) || inside(h, t)) return `${target} is or holds ${h}, where credentials are kept (#68)`;
  }
  return null;
}

// bwrap's arguments, before `--` and the command, for this environment.
export function jailArgs(env = process.env) {
  const home = env.HOME || os.homedir();
  const places = hiddenPlaces(env);
  const args = ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent'];
  const seen = new Set();
  for (const p of places.filter(Boolean)) {
    const r = real(p);
    const st = r && kind(r);
    if (!st || seen.has(r)) continue;
    seen.add(r);
    args.push(...(st.isDirectory() ? ['--tmpfs', r] : ['--ro-bind', '/dev/null', r]));
  }
  for (const v of UNSET) args.push('--unsetenv', v);
  return args;
}

function findBwrap(env) {
  if (env.HARNESS_BWRAP) return fs.existsSync(env.HARNESS_BWRAP) ? env.HARNESS_BWRAP : null;
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, 'bwrap');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// { exe, args } when the jail works here, else { off: why }.
export function credentialJail({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'linux') return { off: `bwrap runs on Linux only, and this is ${platform}` };
  const exe = findBwrap(env);
  if (!exe) return { off: env.HARNESS_BWRAP ? `HARNESS_BWRAP points at a missing file: ${env.HARNESS_BWRAP}` : 'bwrap is not installed (apt install bubblewrap)' };
  const args = jailArgs(env);
  const probe = spawnSync(exe, [...args, '--', 'true'], { env, encoding: 'utf8', timeout: 10_000 });
  if (probe.status !== 0) return { off: `bwrap does not run here: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim()}` };
  return { exe, args };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The command line that runs `command` in the jail, for the Bash tool.
export function jailCommand(command, jail) {
  return [jail.exe, ...jail.args, '--', 'bash', '-c', command].map(quote).join(' ');
}

export const OFF_WARNING = (why) => `WARNING: the reviewer's credential jail is off (${why}). It keeps the user's `
  + 'GitHub credentials, and only its agent rules stop a push or a gh write (#68).';

// Whether the project turned the jail on (harness.json's jail.enabled), from a checkout's top.
export function jailEnabled(top) {
  try { return JSON.parse(fs.readFileSync(path.join(top, 'harness.json'), 'utf8')).jail?.enabled === true; } catch { return false; }
}
