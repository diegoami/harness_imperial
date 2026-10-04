// The reviewer's credential jail (lib/jail.mjs, #68): what it hides, when it is off, and, where
// bwrap runs, that a command inside it cannot reach the credentials however it asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jailArgs, credentialJail, jailCommand, hiddenTarget } from '../template/tools/harness/lib/jail.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Listed here, not taken from the module, so that deleting one there fails a test (Sol's R7 on PR 74).
const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

// A home and a repository with every kind of credential store, each holding SECRET.
function setup() {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jail-home-')));
  const put = (rel, text = 'SECRET\n') => {
    fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true });
    fs.writeFileSync(path.join(h, rel), text);
  };
  for (const rel of ['.ssh/id_ed25519', '.config/gh/hosts.yml', 'xdg/gh/hosts.yml', 'ghdir/hosts.yml',
    '.git-credentials', '.config/git/credentials', '.netrc', '.cache/git/credential/socket', 'agent.sock',
    'vscode.sock', 'bus', 'inc/secret.cfg']) put(rel);
  put('.gitconfig', [
    '[user]', '\tname = Probe', '[http "https://github.com/"]', '\textraheader = Authorization: Bearer SECRET',
    '[credential]', '\thelper = !echo password=SECRET', '[url "https://x:SECRET@github.com/"]', '\tinsteadOf = https://github.com/',
    '[includeIf "gitdir:/nowhere/"]', `\tpath = ${h}/inc/secret.cfg`, '[alias]', '\tlg = log --oneline', ''].join('\n'));
  put('xdg/git/config', '[http]\n\textraheader = SECRET\n');
  put('.config/git/config', '[http]\n\textraheader = SECRET\n');
  const repo = path.join(h, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://user:SECRET@github.com/o/r.git']);
  spawnSync('git', ['-C', repo, 'config', 'http.extraheader', 'AUTHORIZATION: basic SECRET']);
  spawnSync('git', ['-C', repo, 'config', 'core.note', 'ghp_SECRETSECRETSECRETSECRET1234']);
  const env = {
    ...process.env, HOME: h, XDG_CONFIG_HOME: path.join(h, 'xdg'), GH_CONFIG_DIR: path.join(h, 'ghdir'),
    SSH_AUTH_SOCK: path.join(h, 'agent.sock'), VSCODE_GIT_IPC_HANDLE: path.join(h, 'vscode.sock'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(h, 'bus')}`,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'SECRET',
    ...Object.fromEntries(TOKENS.map((t) => [t, 'SECRET'])),
  };
  return { h, repo, env };
}

test('jailArgs hides every credential store, replaces git config with copies that cannot authenticate, and unsets the variables', () => {
  const { h, repo, env } = setup();
  const args = jailArgs(env, repo);
  const after = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  assert.deepEqual(args.slice(0, 7), ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent']);
  for (const d of ['.ssh', '.config/gh', 'xdg/gh', 'ghdir', '.cache/git/credential']) assert.ok(after('--tmpfs').includes(path.join(h, d)), d);
  const nulled = args.flatMap((a, i) => (a === '/dev/null' && args[i - 1] === '--ro-bind' ? [args[i + 1]] : []));
  for (const f of ['.git-credentials', '.config/git/credentials', '.netrc', 'agent.sock', 'vscode.sock', 'bus', 'inc/secret.cfg']) {
    assert.ok(nulled.includes(path.join(h, f)), f);
  }
  if (fs.existsSync('/run/user')) assert.ok(after('--tmpfs').includes(fs.realpathSync('/run/user')));
  // Each git config file is bound to a clean copy.
  const copies = new Map(args.flatMap((a, i) => (a === '--ro-bind' && args[i + 1] !== '/dev/null' ? [[args[i + 2], args[i + 1]]] : [])));
  for (const f of ['.gitconfig', 'xdg/git/config', '.config/git/config', 'repo/.git/config']) {
    const copy = copies.get(path.join(h, f));
    assert.ok(copy, f);
    assert.doesNotMatch(fs.readFileSync(copy, 'utf8'), /SECRET|extraheader|credential|insteadof|include/i, f);
  }
  const global = fs.readFileSync(copies.get(path.join(h, '.gitconfig')), 'utf8');
  assert.match(global, /name = "Probe"/);
  assert.match(global, /\[alias\]\n\tlg = "log --oneline"/);
  assert.match(fs.readFileSync(copies.get(path.join(h, 'repo/.git/config')), 'utf8'), /url = "https:\/\/github.com\/o\/r.git"/);
  const unset = after('--unsetenv');
  for (const v of [...TOKENS, 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'GIT_ASKPASS', 'VSCODE_GIT_IPC_HANDLE',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) assert.ok(unset.includes(v), v);
});

test('a reviewer\'s Read, Grep or Glob of a hidden place, a folder holding one, or /proc is refused; the worktree is not', () => {
  const { h, repo, env } = setup();
  fs.symlinkSync(path.join(h, '.config/gh/hosts.yml'), path.join(repo, 'link'));
  const no = (t) => hiddenTarget(t, { env, cwd: repo });
  for (const t of [path.join(h, '.config/gh/hosts.yml'), path.join(h, 'xdg/gh'), path.join(h, '.ssh/missing'), h, '/',
    'link', '.git/config', path.join(h, '.gitconfig'), '/proc/self/environ', '/dev/fd/0', path.join(h, 'inc/secret.cfg')]) {
    assert.match(no(t) ?? 'allowed', /may not read/, t);
  }
  // The reviewer works in a linked worktree, whose root holds no git config; a plain repository's root does.
  assert.match(no('.'), /\.git\/config/);
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const wt = path.join(h, 'wt');
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', wt]);
  for (const t of ['.', 'src/a.js', path.join(wt, 'README.md')]) assert.equal(hiddenTarget(t, { env, cwd: wt }), null, t);
  assert.match(hiddenTarget(path.join(repo, '.git/config'), { env, cwd: wt }), /may not read/);
});

test('the jail is off, saying why, off Linux, without bwrap, or where bwrap does not run; an abstract bus is named as a gap', () => {
  assert.match(credentialJail({ platform: 'darwin' }).off, /Linux only, and this is darwin/);
  assert.match(credentialJail({ env: { PATH: '' }, platform: 'linux' }).off, /bwrap is not installed/);
  assert.match(credentialJail({ env: { HARNESS_BWRAP: '/no/bwrap' }, platform: 'linux' }).off, /missing file/);
  if (process.platform === 'win32') return;
  assert.match(credentialJail({ env: { HARNESS_BWRAP: '/bin/false' }, platform: 'linux' }).off, /does not run here/);
  const env = { ...process.env, HARNESS_BWRAP: path.join(here, 'fake-bwrap.sh'), DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x' };
  assert.deepEqual(credentialJail({ env, platform: 'linux' }).gaps, ['the session bus is on an abstract socket, which no mount hides']);
});

// The real bwrap, where it runs (not on CI's Ubuntu without it, nor Windows).
const real = setup();
const jail = process.platform === 'linux' ? credentialJail({ env: real.env, cwd: real.repo }) : { off: 'not Linux' };

test('in the real jail, nothing reaches a credential: files, a script, HOME=, unset variables, /proc, sockets, git config', { skip: jail.off }, async () => {
  const { h, repo, env } = real;
  // A live agent socket that answers with the secret, as an ssh agent or a credential cache would.
  const sock = path.join(h, 'live.sock');
  const server = net.createServer((c) => c.end('SECRET\n')).listen(sock);
  await new Promise((r) => server.once('listening', r));
  const liveEnv = { ...env, SSH_AUTH_SOCK: sock };
  const live = credentialJail({ env: liveEnv, cwd: repo });
  fs.writeFileSync(path.join(repo, 'leak.sh'), [
    `cat ${['.ssh/id_ed25519', '.config/gh/hosts.yml', 'xdg/gh/hosts.yml', 'ghdir/hosts.yml', '.git-credentials',
      '.config/git/credentials', '.netrc', 'inc/secret.cfg'].map((f) => `${h}/${f}`).join(' ')}`,
    `HOME=${h} cat "$HOME/.ssh/id_ed25519"`,
    `unset XDG_CONFIG_HOME GH_CONFIG_DIR; cat ${h}/.config/gh/hosts.yml; git config --global --list`,
    `cat /proc/${process.pid}/root${h}/.ssh/id_ed25519 /proc/${process.pid}/environ`,
    `node -e "require('net').connect('${sock}').on('data', (d) => process.stdout.write(d)).on('error', () => {})"`,
    'git config --list; git config --file .git/config --list; git remote get-url origin',
    `for v in ${TOKENS.join(' ')} GIT_CONFIG_COUNT; do eval echo "$v=\\$$v"; done`,
    'git status --short >/dev/null && echo git-works',
    'echo written > out.txt',
    'exit 7',
  ].join('\n'));
  // Outside the jail each secret is there, so the test tells hidden from missing.
  assert.equal(fs.readFileSync(`/proc/${process.pid}/root${h}/.ssh/id_ed25519`, 'utf8'), 'SECRET\n');
  // Async, so that the socket server keeps answering while a command runs.
  const run = (cmd, args) => new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: repo, env: liveEnv });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (status) => resolve({ status, out }));
  });
  assert.equal((await run('node', ['-e', `require('net').connect('${sock}').on('data', (d) => process.stdout.write(d))`])).out, 'SECRET\n');
  const r = await run('bash', ['-c', jailCommand('sh ./leak.sh', live)]);
  server.close();
  assert.equal(r.status, 7, r.out);                                      // the exit code comes through
  assert.doesNotMatch(r.out, /SECRET/);
  for (const t of TOKENS) assert.match(r.out, new RegExp(`^${t}=$`, 'm'));
  assert.match(r.out, /^git-works$/m);
  assert.equal(fs.readFileSync(path.join(repo, 'out.txt'), 'utf8'), 'written\n');   // the worktree stays writable
});
