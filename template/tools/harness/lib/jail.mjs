import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The reviewer's credential jail (#68). The guard (lib/guard.mjs) reads a reviewer's commands and
// refuses a push or a gh write, but no reading of shell text is complete (Sol's five rounds on PR 66).
// So a reviewer's command also runs where the user's GitHub credentials do not exist: bubblewrap
// (bwrap) puts an empty directory over each place they are kept, removes the variables that carry a
// token, and gives the command its own process namespace, so that no /proc/<pid>/root of a process
// outside it leads back to them. Whatever the command types, a script file or HOME=… included, a
// push finds no SSH key and gh finds no login. A public repository is still fetched over HTTPS.
//
// Hidden: ~/.ssh, gh's config directory (~/.config/gh, $XDG_CONFIG_HOME/gh, $GH_CONFIG_DIR),
// /run/user (the session bus, so a keyring, and agents' sockets), the ssh agent's socket, and git's
// stored credentials (~/.git-credentials, $XDG_CONFIG_HOME/git/credentials, ~/.netrc). A token the
// user copied somewhere else is not found; the jail closes where the tools keep them.
//
// Linux only, and only where bwrap runs (a probe runs `true` in the jail). Elsewhere the reviewer
// runs without it, and the hook and review.mjs say so loudly: the guard still applies.
// HARNESS_BWRAP names the bwrap to use (tests use a fake one).

export const UNSET = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'GIT_ASKPASS', 'SSH_ASKPASS'];

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const kind = (p) => { try { return fs.statSync(p); } catch { return null; } };

// bwrap's arguments, before `--` and the command, for this environment.
export function jailArgs(env = process.env) {
  const home = env.HOME || os.homedir();
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const places = [path.join(home, '.ssh'), path.join(config, 'gh'), env.GH_CONFIG_DIR, '/run/user',
    env.SSH_AUTH_SOCK, path.join(home, '.git-credentials'), path.join(config, 'git', 'credentials'),
    path.join(home, '.netrc')];
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
  + 'GitHub credentials, and only the guard stops a push or a gh write (#68).';
