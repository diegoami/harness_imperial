// The reviewer's credential jail (lib/jail.mjs, #68): what it keeps and hides, when it is off, and,
// where bwrap runs, that a command inside it cannot reach a credential however it asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jailArgs, credentialJail, jailCommand, hiddenTarget, keptEnv } from '../template/tools/harness/lib/jail.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Listed here, not taken from the module, so that keeping one there fails a test (Sol's R7, round 1).
const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_API_KEY'];
const DROPPED = [...TOKENS, 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'VSCODE_GIT_IPC_HANDLE', 'FOO_TOKEN'];

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const put = (file, text = 'SECRET\n', mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
};

// A home (h) and a place outside it (o), with every kind of credential store, each holding SECRET:
// the default ones in home, and round 2's (Sol, R1–R4): a custom store file, an askpass script, a
// transport command, and includes deeper than any limit, outside home.
function setup() {
  const h = tmp('jail-home-');
  const o = tmp('jail-out-');
  for (const rel of ['.ssh/id_ed25519', '.config/gh/hosts.yml', '.git-credentials', '.netrc', 'custom/store',
    '.cache/git/credential/socket']) put(path.join(h, rel));
  put(path.join(h, '.gitconfig'), '[user]\n\tname = Probe\n[credential]\n\thelper = store --file=' + path.join(h, 'custom/store') + '\n');
  put(path.join(h, 'askpass'), '#!/bin/sh\necho SECRET\n', 0o755);
  put(path.join(h, 'tools/bin/hello'), '#!/bin/sh\necho hello-tool\n', 0o755);
  put(path.join(h, 'keepme/file'), 'kept\n');
  for (const rel of ['xdg/gh/hosts.yml', 'ghdir/hosts.yml', 'agent.sock', 'vscode.sock', 'bus']) put(path.join(o, rel));
  // 120 includes, each including a leaf with an auth header.
  for (let i = 0; i < 120; i++) {
    put(path.join(o, `inc/mid${i}.cfg`), `[include]\n\tpath = ${path.join(o, `inc/leaf${i}.cfg`)}\n`);
    put(path.join(o, `inc/leaf${i}.cfg`), '[http]\n\textraheader = Authorization: Bearer SECRET\n');
  }
  const repo = path.join(h, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://user:SECRET@github.com/o/r.git']);
  spawnSync('git', ['-C', repo, 'config', 'http.extraheader', 'AUTHORIZATION: basic SECRET']);
  spawnSync('git', ['-C', repo, 'config', 'core.note', 'ghp_SECRETSECRETSECRETSECRET1234']);
  for (let i = 0; i < 120; i++) spawnSync('git', ['-C', repo, 'config', '--add', 'include.path', path.join(o, `inc/mid${i}.cfg`)]);
  // What the harness runs and decides by, and a worktree, where a reviewer works.
  for (const f of ['harness.json', 'tools/harness/guard.mjs', '.claude/agents/reviewer.md', 'README.md']) put(path.join(repo, f), 'policy\n');
  spawnSync('git', ['-C', repo, 'add', '-A']);
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(repo, '.git/hooks'), { recursive: true });
  const wt = path.join(h, 'wt');
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', wt]);
  const env = {
    ...process.env, HOME: h, PATH: `${path.join(h, 'tools/bin')}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(o, 'xdg'),
    GH_CONFIG_DIR: path.join(o, 'ghdir'), SSH_AUTH_SOCK: path.join(o, 'agent.sock'), VSCODE_GIT_IPC_HANDLE: path.join(o, 'vscode.sock'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(o, 'bus')}`, GIT_ASKPASS: path.join(h, 'askpass'),
    GIT_SSH_COMMAND: 'env GH_TOKEN=SECRET ssh', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'SECRET',
    FOO_TOKEN: 'SECRET', HARNESS_PROBE: 'kept', ZHIPU_API_KEY: 'model-key', LC_ALL: 'C',
    ...Object.fromEntries(TOKENS.map((t) => [t, 'SECRET'])),
  };
  return { h, o, repo, wt, env };
}

test('only listed variables are kept: never a token, a git or ssh override, a socket, or anything unlisted', () => {
  const { env } = setup();
  const kept = keptEnv(env);
  for (const v of ['PATH', 'HOME', 'HARNESS_PROBE', 'ZHIPU_API_KEY', 'LC_ALL', 'XDG_CONFIG_HOME']) assert.ok(kept.includes(v), v);
  for (const v of DROPPED) assert.ok(!kept.includes(v), v);
});

test('jailArgs empties home, keeps the worktree, the tools and jail.keep, masks the stores outside home, and cleans git config', () => {
  const { h, o, repo, wt, env } = setup();
  const args = jailArgs(env, wt, { ro: ['~/keepme'] });
  const after = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  assert.deepEqual(args.slice(0, 9), ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', h]);
  assert.equal(args.at(-1), '--clearenv');
  // The worktree and the git directory writable; the main checkout, the policy and git's hooks not
  // (Sol's R1 of round 3), each after the folder it lies in.
  assert.ok(after('--bind').includes(wt) && after('--bind').includes(path.join(repo, '.git')));
  const ro = after('--ro-bind');
  for (const d of [repo, ...['harness.json', 'tools/harness', '.claude'].flatMap((f) => [path.join(repo, f), path.join(wt, f)]), path.join(repo, '.git/hooks')]) {
    assert.ok(ro.includes(d), d);
  }
  const at = (d, how) => args.findIndex((a, i) => a === d && args[i - 1] === how);
  assert.ok(at(repo, '--ro-bind') < at(path.join(repo, '.git'), '--bind') && at(path.join(repo, '.git'), '--bind') < at(path.join(repo, '.git/hooks'), '--ro-bind'));
  assert.ok(after('--ro-bind').includes(path.join(h, 'tools')));           // the bin directory's parent
  assert.ok(after('--ro-bind').includes(path.join(h, 'keepme')));
  for (const gone of ['.ssh', '.config', 'custom', 'askpass', '.gitconfig']) {
    assert.ok(!args.some((a) => a.startsWith(path.join(h, gone))), `${gone} is gone with home, not bound`);
  }
  for (const d of ['xdg/gh', 'ghdir']) assert.ok(after('--tmpfs').includes(path.join(o, d)), d);
  const nulled = args.flatMap((a, i) => (a === '/dev/null' && args[i - 1] === '--ro-bind' ? [args[i + 1]] : []));
  for (const f of ['agent.sock', 'vscode.sock', 'bus']) assert.ok(nulled.includes(path.join(o, f)), f);
  for (let i = 0; i < 120; i++) for (const f of [`mid${i}`, `leaf${i}`]) assert.ok(nulled.includes(path.join(o, `inc/${f}.cfg`)), f);
  if (fs.existsSync('/run/user')) assert.ok(after('--tmpfs').includes(fs.realpathSync('/run/user')));
  // A store inside a kept folder comes back with it, so it is masked there.
  put(path.join(h, 'keepme/gh/hosts.yml'));
  const inKept = jailArgs({ ...env, GH_CONFIG_DIR: path.join(h, 'keepme/gh') }, repo, { ro: ['~/keepme'] });
  assert.ok(inKept.some((a, i) => a === path.join(h, 'keepme/gh') && inKept[i - 1] === '--tmpfs'));
  const copy = args[args.indexOf(path.join(repo, '.git/config')) - 1];
  const text = fs.readFileSync(copy, 'utf8');
  assert.doesNotMatch(text, /SECRET|extraheader|include|user:/i);
  assert.match(text, /url = "https:\/\/github.com\/o\/r.git"/);
});

test('a reviewer\'s Read, Grep or Glob of home outside what is kept, a hidden place, or /proc is refused; the repository and tools are not', () => {
  const { h, o, repo, wt, env } = setup();
  fs.symlinkSync(path.join(h, '.config/gh/hosts.yml'), path.join(wt, 'link'));
  const no = (t) => hiddenTarget(t, { env, cwd: wt, keep: { ro: ['~/keepme'] } });
  for (const t of [path.join(h, '.config/gh/hosts.yml'), path.join(h, 'custom/store'), path.join(h, 'askpass'), h, '/',
    path.dirname(h), 'link', path.join(o, 'xdg/gh/hosts.yml'), path.join(o, 'inc/leaf99.cfg'), path.join(repo, '.git/config'),
    '/proc/self/environ', '/dev/fd/0']) {
    assert.match(no(t) ?? 'allowed', /may not read/, t);
  }
  for (const t of ['.', 'src/a.js', path.join(repo, 'README.md'), path.join(h, 'tools/bin/hello'), path.join(h, 'keepme/file'),
    path.join(o, 'agent')]) {
    assert.equal(no(t), null, t);
  }
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
const jail = process.platform === 'linux' ? credentialJail({ env: real.env, cwd: real.wt }) : { off: 'not Linux' };

test('in the real jail, nothing reaches a credential: home, custom stores, askpass, transport commands, includes, sockets, /proc', { skip: jail.off }, async () => {
  const { h, o, repo, wt, env } = real;
  // Live sockets outside home that answer with the secret: the ssh agent named, another agent in
  // $TMPDIR (R3 of round 3), and git's credential cache under $XDG_CACHE_HOME (R4).
  const socks = [path.join(o, 'live.sock'), path.join(o, 'ssh-other/agent.1'), path.join(o, 'cache/git/credential/socket')];
  const servers = [];
  for (const sock of socks) {
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    const server = net.createServer((c) => c.end('SECRET\n')).listen(sock);
    await new Promise((r) => server.once('listening', r));
    servers.push(server);
  }
  const liveEnv = { ...env, SSH_AUTH_SOCK: socks[0], TMPDIR: o, XDG_CACHE_HOME: path.join(o, 'cache') };
  const live = credentialJail({ env: liveEnv, cwd: wt });
  assert.equal(live.off, undefined);
  const connect = (sock) => `node -e "require('net').connect('${sock}').on('data', (d) => process.stdout.write(d)).on('error', () => {})"`;
  fs.writeFileSync(path.join(wt, 'leak.sh'), [
    `cat ${['.ssh/id_ed25519', '.config/gh/hosts.yml', '.git-credentials', '.netrc', 'custom/store', 'askpass', '.gitconfig']
      .map((f) => `${h}/${f}`).join(' ')}`,
    `cat ${o}/xdg/gh/hosts.yml ${o}/ghdir/hosts.yml ${o}/inc/leaf119.cfg ${o}/inc/mid0.cfg`,
    `HOME=${o} cat ${h}/.ssh/id_ed25519; unset XDG_CONFIG_HOME GH_CONFIG_DIR; gh auth token`,
    `printf 'protocol=https\\nhost=github.com\\n\\n' | git -c credential.helper='store --file=${h}/custom/store' credential fill`,
    'git config --list --show-origin; git config --file .git/config --list; git remote get-url origin',
    `cat /proc/${process.pid}/root${h}/.ssh/id_ed25519 /proc/${process.pid}/environ`,
    ...socks.map(connect),
    // A descriptor the caller had open, and stdin (R2 of round 3).
    'cat /proc/self/fd/3; cat <&3; cat',
    // The policy, the code that enforces it, git's hooks and the main checkout stay as they are (R1).
    `for f in ${repo}/harness.json harness.json tools/harness/guard.mjs .claude/agents/reviewer.md ${repo}/README.md ${repo}/.git/hooks/post-checkout; do echo pwned >> "$f" 2>/dev/null && echo "WROTE $f"; done`,
    `for v in ${DROPPED.join(' ')}; do eval echo "$v=\\$$v"; done`,
    'echo "keep=$HARNESS_PROBE $ZHIPU_API_KEY"; hello; ls -A "$HOME"',
    'git status --short >/dev/null && echo git-works',
    'echo written > out.txt',
    'exit 7',
  ].join('\n'));
  // Async, so that the socket server keeps answering while a command runs.
  const run = (cmd, args, stdio = 'pipe') => new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: wt, env: liveEnv, stdio });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (status) => resolve({ status, out }));
  });
  // Outside the jail the secrets are there, so the test tells hidden from missing.
  for (const sock of socks) assert.equal((await run('sh', ['-c', connect(sock)])).out, 'SECRET\n', sock);
  assert.match((await run('sh', ['-c', `cat ${h}/custom/store ${o}/inc/leaf119.cfg; echo $GIT_SSH_COMMAND`])).out, /SECRET[\s\S]*SECRET[\s\S]*SECRET/);
  const secret = fs.openSync(path.join(h, '.ssh/id_ed25519'), 'r');
  const r = await run('bash', ['-c', `exec 3<'${h}/.ssh/id_ed25519'; ${jailCommand('sh ./leak.sh', live)}`], [secret, 'pipe', 'pipe']);
  for (const server of servers) server.close();
  assert.equal(r.status, 7, r.out);                                      // the exit code comes through
  assert.doesNotMatch(r.out, /SECRET|WROTE/);
  for (const f of ['harness.json', 'README.md']) assert.equal(fs.readFileSync(path.join(repo, f), 'utf8'), 'policy\n');
  assert.ok(!fs.existsSync(path.join(repo, '.git/hooks/post-checkout')));
  for (const v of DROPPED) assert.match(r.out, new RegExp(`^${v}=$`, 'm'));
  assert.match(r.out, /^keep=kept model-key$/m);
  assert.match(r.out, /^hello-tool$/m);                                 // a tool under home still runs
  assert.match(r.out, /^git-works$/m);
  assert.equal(fs.readFileSync(path.join(wt, 'out.txt'), 'utf8'), 'written\n');   // the worktree stays writable
});
