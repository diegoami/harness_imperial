// The reviewer's credential jail (lib/jail.mjs, #68): what it hides, when it is off, and, where
// bwrap runs, that a command inside it cannot reach the credentials however it asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jailArgs, credentialJail, jailCommand, UNSET } from '../template/tools/harness/lib/jail.mjs';

// A home with every kind of credential store, each holding SECRET.
function home() {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jail-home-')));
  const put = (rel) => { fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true }); fs.writeFileSync(path.join(h, rel), 'SECRET\n'); };
  for (const rel of ['.ssh/id_ed25519', '.config/gh/hosts.yml', '.git-credentials', 'ghdir/hosts.yml', 'agent.sock']) put(rel);
  return h;
}

test('jailArgs hides each credential store that exists, a directory under tmpfs and a file under /dev/null', () => {
  const h = home();
  const args = jailArgs({ HOME: h, GH_CONFIG_DIR: path.join(h, 'ghdir'), SSH_AUTH_SOCK: path.join(h, 'agent.sock') });
  const pairs = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  assert.deepEqual(args.slice(0, 7), ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent']);
  for (const d of ['.ssh', '.config/gh', 'ghdir']) assert.ok(pairs('--tmpfs').includes(path.join(h, d)), d);
  for (const f of ['.git-credentials', 'agent.sock']) {
    const i = args.indexOf(path.join(h, f));
    assert.deepEqual(args.slice(i - 2, i + 1), ['--ro-bind', '/dev/null', path.join(h, f)], f);
  }
  assert.ok(!args.includes(path.join(h, '.netrc')), 'a store that does not exist is not named');
  // The session bus (a keyring) and agents' sockets, where this machine has them.
  if (fs.existsSync('/run/user')) assert.ok(pairs('--tmpfs').includes(fs.realpathSync('/run/user')));
  assert.deepEqual(pairs('--unsetenv'), UNSET);
  for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS']) assert.ok(UNSET.includes(v));
  // XDG_CONFIG_HOME moves gh's and git's stores.
  const x = jailArgs({ HOME: h, XDG_CONFIG_HOME: path.join(h, 'ghdir', '..', '.config') });
  assert.ok(x.includes(path.join(h, '.config', 'gh')));
});

test('the jail is off, saying why, off Linux, without bwrap, or where bwrap does not run', () => {
  assert.match(credentialJail({ platform: 'darwin' }).off, /Linux only, and this is darwin/);
  assert.match(credentialJail({ env: { PATH: '' }, platform: 'linux' }).off, /bwrap is not installed/);
  assert.match(credentialJail({ env: { HARNESS_BWRAP: '/no/bwrap' }, platform: 'linux' }).off, /missing file/);
  if (process.platform !== 'win32') assert.match(credentialJail({ env: { HARNESS_BWRAP: '/bin/false' }, platform: 'linux' }).off, /does not run here/);
});

// The real bwrap, where it runs (not on CI's Ubuntu without it, nor Windows).
const h = home();
const env = { ...process.env, HOME: h, GH_CONFIG_DIR: path.join(h, 'ghdir'), SSH_AUTH_SOCK: path.join(h, 'agent.sock'), GH_TOKEN: 'SECRET' };
const jail = process.platform === 'linux' ? credentialJail({ env }) : { off: 'not Linux' };

test('in the real jail, no command reaches a credential: a script file, HOME=…, /proc of a process outside, the token variable', { skip: jail.off }, () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jail-work-')));
  fs.writeFileSync(path.join(work, 'leak.sh'), [
    `cat ${h}/.ssh/id_ed25519 ${h}/.config/gh/hosts.yml ${h}/.git-credentials ${h}/ghdir/hosts.yml ${h}/agent.sock`,
    `HOME=${h} cat "$HOME/.ssh/id_ed25519"`,
    `cat /proc/${process.pid}/root${h}/.ssh/id_ed25519`,
    'echo "token=$GH_TOKEN"',
    'echo written > out.txt',
    'exit 7',
  ].join('\n'));
  // The outside still sees the secret, so the test can tell hidden from missing.
  assert.equal(fs.readFileSync(`/proc/${process.pid}/root${h}/.ssh/id_ed25519`, 'utf8'), 'SECRET\n');
  const r = spawnSync('bash', ['-c', jailCommand('sh ./leak.sh', jail)], { cwd: work, env, encoding: 'utf8' });
  assert.equal(r.status, 7, r.stderr);                                   // the exit code comes through
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  assert.match(r.stdout, /^token=$/m);
  assert.equal(fs.readFileSync(path.join(work, 'out.txt'), 'utf8'), 'written\n');   // the worktree stays writable
});
