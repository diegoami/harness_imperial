// implement.mjs end to end: a local bare repository as origin, a main checkout, and fakes for
// opencode and gh. Nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessions } from './fake-state.mjs';
import { resetWorktree } from '../template/tools/harness/lib/unsaved.mjs';
import { quotaServer, entry } from './quota-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../template');
const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function project(harness = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-impl-')));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'proj');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['clone', '-q', origin, main]);
  fs.mkdirSync(path.join(main, '.opencode', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(root, '.opencode/agents/implementer.md'), path.join(main, '.opencode/agents/implementer.md'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8'));
  config.models.spare = { id: 'opencode-go/spare-model', variant: 'high', family: 'spare' };   // a third model, tests only
  // The tests' own chain: the template's first model (GLM-5.3 Flash) needs a Z.AI login the fake does
  // not list by default, and a model not logged in now stops the run (L69).
  config.implementer = { ...config.implementer, chain: ['mimo-flash'], startupTimeoutSec: 2, idleTimeoutSec: 5, totalTimeoutSec: 20, ...harness };
  fs.writeFileSync(path.join(main, 'harness.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(main, 'README.md'), 'project\n');
  git(main, 'add', '.');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  git(main, 'push', '-q', 'origin', 'main');
  // Agents' commits in the worktree need an identity.
  git(main, 'config', 'user.name', 't');
  git(main, 'config', 'user.email', 't@example.com');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const ghState = path.join(base, 'gh.json');
  fs.writeFileSync(ghState, JSON.stringify({ prs: [] }));
  fs.writeFileSync(path.join(base, 'brief.md'), 'Implement T07.\n');
  return { base, main, origin, ghState };
}

function implement(p, env, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'tools/harness/implement.mjs'),
    '--task', 'T07', '--slug', 'calendar', '--issue', '12', '--brief', path.join(p.base, 'brief.md'), ...args], {
    cwd: p.main, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${path.join(p.base, 'bin')}${path.delimiter}${process.env.PATH}`,
      HARNESS_OPENCODE_EXE: path.join(here, 'fake-opencode.mjs'), HARNESS_QUOTA_URL: 'http://127.0.0.1:9',
      FAKE_OC_STATE: path.join(p.base, 'oc.json'), FAKE_GH_STATE: p.ghState, HARNESS_GH_EXE: path.join(here, 'fake-gh.mjs'),
      HARNESS_OPENCODE_HOME: path.join(p.base, 'oc-home'), HARNESS_OPENCODE_AUTH_SOURCE: path.join(p.base, 'auth.json'),
      ...env,
    },
  });
}

// The fakes run through Node (HARNESS_GH_EXE, HARNESS_OPENCODE_EXE), so these tests run on Windows too (#2).
const posix = {};

test('the implementer does not inherit the reviewer\'s OpenCode settings (L34)', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_DIR: path.join(p.base, 'elsewhere') });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  assert.equal(session.projectConfig, 'read');
  // Both sides through realpathSync.native: Windows may give the temp directory as an 8.3 short name.
  const long = (f) => fs.realpathSync.native(f);
  // The run loads a per-run copy (L66) of the worktree's own agent file, plus its one scratch allow.
  const own = fs.readFileSync(path.join(p.base, 'proj-work', 'T07', '.opencode', 'agents', 'implementer.md'), 'utf8');
  assert.equal(session.agentText.replace(/^    "[^"]*harness-run-[^"]*": allow\r?\n/m, ''), own);
  assert.match(session.agentText, /^    "[^"]*\/harness-run-T07-[^"]*\/\*": allow$/m);
  assert.match(session.configDir ?? '', /harness-opencode[\\/]T07-[\w.-]+\.config$/);   // the run's own, not the inherited one
});

test('--copy brings an untracked file into the worktree, its folders created (#90)', posix, async () => {
  const p = project();
  fs.mkdirSync(path.join(p.main, '.cache/kept/E005'), { recursive: true });
  fs.writeFileSync(path.join(p.main, '.cache/kept/E005/save.sav'), 'kept\n');
  const r = implement(p, { FAKE_OC_MODE: 'implement' }, '--copy', '.cache/kept/E005/save.sav');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(p.base, 'proj-work', 'T07', '.cache/kept/E005/save.sav'), 'utf8'), 'kept\n');
  // A path that leaves the checkout is refused, and nothing is written outside the worktree.
  for (const bad of ['../newdir/escaped.sav', path.join(p.base, 'abs.sav')]) {
    const q = project();
    fs.writeFileSync(path.join(q.base, 'abs.sav'), 'x\n');
    const s = implement(q, { FAKE_OC_MODE: 'implement' }, '--copy', bad === '../newdir/escaped.sav' ? bad : path.join(q.base, 'abs.sav'));
    assert.equal(s.status, 2, s.stderr + s.stdout);
    assert.match(s.stderr, /--copy takes a path inside the checkout/);
    assert.ok(!fs.existsSync(path.join(q.base, 'proj-work', 'newdir')));
  }
});

test('--copy refuses a path whose source-side realpath resolves outside the checkout (PR 91 R2: source-side symlink escape)', posix, async () => {
  // PR 91 round 2: a tracked symlink whose target is outside the checkout passed the lexical
  // check; mkdirSync and copyFileSync follow symlinks, so the script wrote a real file at
  // the external target. The source-side realpath gate catches this. The worktree does
  // NOT have the symlink (we don't push a symlink commit to origin/task/T07-calendar) so
  // only the source-side gate can fire — the test exercises it uniquely (Luna's R2 on
  // PR 91 round 5).
  const p = project();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-symlink-'));
  fs.writeFileSync(path.join(ext, 'leaked.sav'), 'leaked\n');
  // Source: a local symlink in mainRoot pointing outside. The lexical gate lets it pass;
  // the source-side realpath gate must refuse.
  fs.symlinkSync(ext, path.join(p.main, 'link'));
  const r = implement(p, { FAKE_OC_MODE: 'implement' }, '--copy', 'link/leaked.sav');
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /--copy takes a path inside the checkout/);
});

test('--copy refuses a destination whose parent is a tracked symlink that lands outside the worktree (PR 91 R4)', posix, async () => {
  // PR 91 round 4 (Luna's R1): the source-side realpath gate alone is not enough — the
  // destination's parent in the worktree can itself be a tracked symlink to outside, and
  // mkdirSync (recursive) + copyFileSync follow it. Here the source is a regular file in
  // mainRoot (no source-side escape), but the worktree has `sub` as a tracked symlink
  // pointing outside. The destination-side walk must refuse.
  const p = project();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dest-symlink-'));
  fs.mkdirSync(path.join(ext, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'sub', 'file.txt'), 'leaked\n');
  // Source: a regular file inside mainRoot (no symlinks involved on the source side).
  fs.mkdirSync(path.join(p.main, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(p.main, 'sub', 'file.txt'), 'kept\n');
  // Destination: push a commit to origin/task/T07-calendar that adds `sub` as a symlink to ext.
  // (The destination-side walk hits worktree/sub as an existing symlink and refuses.)
  git(p.main, 'checkout', '-q', '-b', 'task/T07-calendar');
  fs.rmSync(path.join(p.main, 'sub'), { recursive: true, force: true });
  fs.symlinkSync(ext, path.join(p.main, 'sub'));
  git(p.main, 'add', 'sub');
  spawnSync('git', ['-C', p.main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'sub-symlink'], { stdio: 'ignore' });
  git(p.main, 'push', '-q', 'origin', 'task/T07-calendar');
  git(p.main, 'checkout', '-q', 'main');
  fs.mkdirSync(path.join(p.main, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(p.main, 'sub', 'file.txt'), 'kept\n');
  const r = implement(p, { FAKE_OC_MODE: 'implement' }, '--copy', 'sub/file.txt');
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /--copy: destination path escapes the worktree via a symlink/);
  // The script rejected before mkdirSync / copyFileSync ran; nothing was written outside
  // the worktree through the symlink.
  assert.ok(!fs.existsSync(path.join(ext, 'sub', 'proj-work', 'T07-calendar', 'sub', 'file.txt')));
});

test('a task runs to an open PR, in its own worktree, with the agent kept out of git', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /implemented by: mimo-flash \(opencode-go\/mimo-v2.6-flash\)/);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
  assert.equal(session.dataHome, path.join(p.base, 'oc-home', 'data'));                // its own data directory
  assert.match(r.stdout, /PR: https:\/\/example.com\/pr\/100/);
  const wt = path.join(p.base, 'proj-work', 'T07');
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');           // detached for the reviewer
  assert.equal(git(p.origin, 'rev-parse', 'task/T07-calendar'), git(wt, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(path.join(wt, '.opencode/agents/implementer.md')));
  assert.equal(git(wt, 'status', '--porcelain'), '');                           // the copy is excluded
  assert.equal(git(p.main, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');       // main checkout untouched
});

test('an implementer whose provider is out of quota is skipped before it runs; the next one implements (L50)', posix, async () => {
  const s = await quotaServer([entry('zai', 'exhausted', [], { available_in: '41m' }), entry('opencode_go', 'ok')]);
  try {
    const p = project({ chain: ['glm-flash', 'mimo-flash'] });
    const models = '["zai-coding-plan/glm-5.3-flash", "opencode-go/mimo-v2.6-flash"]';
    const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS: models, HARNESS_QUOTA_URL: s.url });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /glm-flash: skipped, out of quota: zai is exhausted until it is usable again in 41m \(quota-tracker, L50\)/);
    assert.doesNotMatch(r.stdout, /attempt: glm-flash/);
    assert.match(r.stdout, /attempt: mimo-flash/);
  } finally { s.stop(); }
});

test('a model on watch says what to look for, on the console and in the run log; others say nothing (L35)', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS: '["zai-coding-plan/glm-5.3"]' }, '--model', 'glm');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const line = /watch: glm \(zai-coding-plan\/glm-5\.3\) is on watch: .*exit 0 with no commit/;
  assert.match(r.stdout, line);
  assert.match(fs.readFileSync(path.join(p.base, 'proj-work', 'T07.implementer.log'), 'utf8'), line);
  const q = project();
  const plain = implement(q, { FAKE_OC_MODE: 'implement' }, '--model', 'luna');   // not on watch (mimo-flash, second in the chain, is)
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  assert.doesNotMatch(plain.stdout, /watch:/);
});

test('a run that went on after a denied call implements; the denial is in the log, not a failure (#146)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_DENIALS: JSON.stringify([{ tool: 'read', input: '/etc/hostname', kind: 'rejected' }]) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /implemented by: mimo-flash/);
  assert.match(r.stdout, /mimo-flash: 1 denied call, the model went on: read \/etc\/hostname/);
  assert.match(fs.readFileSync(path.join(p.base, 'proj-work', 'T07.implementer.log'), 'utf8'), /=== mimo-flash .*: ran ===\n(?:watch: .*\n)?1 denied call, the model went on: read \/etc\/hostname\n/);
});

test('the same call denied twice fails the run through our process: exit 5, the next model never runs (#146, L69)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/mimo-v2.6-flash': 'deny', 'openai/gpt-5.6-luna': 'implement' }),
    FAKE_OC_DENIALS_MODEL: 'opencode-go/mimo-v2.6-flash',
    FAKE_OC_DENIALS: JSON.stringify([{ tool: 'bash', input: 'git stash list', kind: 'denied' }, { tool: 'bash', input: 'git stash list', kind: 'denied' }]) });
  assert.equal(r.status, 5, r.stderr + r.stdout);
  assert.match(r.stderr, /failed through our process \(mimo-flash: permission rejected: permission-rejected-after-retry: bash git stash list\)/);
  assert.match(r.stderr, /No fallback to another model \(L69\)/);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
});

test('an implementer that stops and reports is not retried, and exits 1', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'stop-report' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
  assert.match(r.stdout, /Done-when 2 cannot be met/);
  assert.match(r.stderr, /No open PR/);
});

test('a failure that left a commit is not retried on the next model: exit 1 after a provider failure, 5 after ours', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'commit-provider' });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
  assert.match(r.stderr, /provider error: 503: Service Unavailable\) after committing, pushing or opening a PR .*not retrying/);
  const q = project({ chain: ['mimo-flash', 'luna'] });
  const own = implement(q, { FAKE_OC_MODE: 'commit-fail' });
  assert.equal(own.status, 5, own.stderr + own.stdout);
  assert.doesNotMatch(own.stdout, /attempt: luna/);
  assert.match(own.stderr, /failed through our process \(mimo-flash: exit 1\)\. It committed, pushed or opened a PR on task\/T07-calendar; the worktree/);
});

test('a provider that did not respond, by its record or by OpenCode\'s stderr, falls back to the next model (L69)', posix, async () => {
  for (const mode of ['provider-error', 'provider-stderr']) {
    const p = project({ chain: ['mimo-flash', 'luna'] });
    const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/mimo-v2.6-flash': mode, 'openai/gpt-5.6-luna': 'implement' }) });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, mode === 'provider-error' ? /fell back: mimo-flash: provider error: 503: Service Unavailable/
      : /fell back: mimo-flash: provider error: Error: APICallError: 429 Too Many Requests/);
    assert.match(r.stdout, /mimo-flash failed \(the provider did not respond\)/);
    assert.match(r.stdout, /implemented by: luna/);
  }
});

test('a provider that does not answer `opencode models` is skipped, not a setup failure; the next model implements (L69, Luna\'s R1 on PR 164)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS_ERROR: 'Error: 503 Service Unavailable', FAKE_OC_MODELS_ERROR_PROVIDER: 'opencode-go' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /mimo-flash: skipped, the provider did not respond to `opencode models`: Error: 503 Service Unavailable \(L69\)/);
  assert.match(r.stdout, /implemented by: luna/);
  // Every provider down: exit 3, the fallback, never exit 5.
  const q = project({ chain: ['mimo-flash'] });
  const all = implement(q, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS_ERROR: 'Error: 503 Service Unavailable' });
  assert.equal(all.status, 3, all.stderr + all.stdout);
  assert.match(all.stderr, /^No provider available: /m);
  // A listing that fails for another reason is still OpenCode failing here: setup, exit 5.
  const w = project({ chain: ['mimo-flash'] });
  const other = implement(w, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS_ERROR: 'Error: database is locked' });
  assert.equal(other.status, 5, other.stderr + other.stdout);
});

test('a failure through our process never falls back: a session that never started, a 401, a rejected call (L69, IC2 #501)', posix, async () => {
  for (const [mode, reason] of [['exit-no-session', /exited without a session/], ['provider-auth', /exit 1/],
    ['permission', /permission rejected: external_directory \(\/tmp\/\*\)/]]) {
    const p = project({ chain: ['mimo-flash', 'luna'] });
    const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/mimo-v2.6-flash': mode, 'openai/gpt-5.6-luna': 'implement' }) });
    assert.equal(r.status, 5, `${mode}: ${r.stderr}${r.stdout}`);
    assert.match(r.stdout, /mimo-flash failed \(our process\)/);
    assert.match(r.stderr, reason);
    assert.doesNotMatch(r.stdout, /attempt: luna/);
  }
});

test('a process failure keeps the worktree as the run left it: no reset, no patch, the exit names it (L69)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'permission-dirty' });
  assert.equal(r.status, 5, r.stderr + r.stdout);
  const wt = path.join(p.base, 'proj-work', 'T07');
  // git names the worktree its own way on Windows (/ and maybe a short name): match its tail.
  assert.match(r.stderr, /the worktree \S+[\\/]proj-work[\\/]T07 is kept as the run left it/);
  assert.match(r.stderr, /the rerun resumes task\/T07-calendar/);
  assert.match(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), /edited, not committed/);
  assert.ok(fs.existsSync(path.join(wt, 'new-file.txt')));
  assert.doesNotMatch(r.stderr, /unsaved\.patch/);
});

// The reset's save (#87, L56): unit checks on a throwaway repository, then a run end to end.
function throwaway() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unsaved-')));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => git(repo, ...a);
  g('init', '-q');
  g('config', 'core.autocrlf', 'false');                           // Windows CI converts line endings
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'start');
  return { repo, saves: path.join(dir, 'saves'), start: g('rev-parse', 'HEAD'), g };
}
const stamp = new Date('2026-10-05T12:00:00Z');
const at = (t) => ({ name: 'T07', model: 'mimo-flash', stamp, worktree: t.repo, startSha: t.start, workRoot: t.saves });

test('the reset saves a tracked change and an untracked file in one patch that applies cleanly (#87, L56)', () => {
  const t = throwaway();
  fs.writeFileSync(path.join(t.repo, 'tracked.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(t.repo, 'untracked.txt'), 'fresh\n');
  const [patch, more] = resetWorktree(at(t));
  assert.equal(patch, path.join(t.saves, 'T07.mimo-flash.2026-10-05T12-00-00.000Z.unsaved.patch'));
  assert.equal(more, undefined);                                                    // one patch
  assert.equal(t.g('status', '--porcelain'), '');                                   // reset as before
  t.g('apply', '--check', patch);
  t.g('apply', patch);
  assert.equal(fs.readFileSync(path.join(t.repo, 'tracked.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(fs.readFileSync(path.join(t.repo, 'untracked.txt'), 'utf8'), 'fresh\n');
});

test('a clean worktree writes no patch, and a second save never overwrites the first (#87)', () => {
  const t = throwaway();
  assert.deepEqual(resetWorktree(at(t)), []);
  assert.ok(!fs.existsSync(t.saves) || fs.readdirSync(t.saves).length === 0);
  fs.writeFileSync(path.join(t.repo, 'tracked.txt'), 'first\n');
  const [first] = resetWorktree(at(t));
  fs.writeFileSync(path.join(t.repo, 'tracked.txt'), 'second\n');
  const [second] = resetWorktree(at(t));                                             // the same stamp
  assert.equal(second, first.replace('.unsaved.patch', '.1.unsaved.patch'));
  assert.match(fs.readFileSync(first, 'utf8'), /\+first/);
  assert.match(fs.readFileSync(second, 'utf8'), /\+second/);
});

test('a staged version that differs from the working copy is saved on its own first, and no empty patch is written (Sol\'s R1-R2 on PR 100)', () => {
  const t = throwaway();
  fs.writeFileSync(path.join(t.repo, 'tracked.txt'), 'staged-only\n');
  t.g('add', 'tracked.txt');
  fs.writeFileSync(path.join(t.repo, 'tracked.txt'), 'one\n');                    // the working copy is back at the start
  const patches = resetWorktree(at(t));
  assert.deepEqual(patches, [path.join(t.saves, 'T07.mimo-flash.2026-10-05T12-00-00.000Z.staged.unsaved.patch')]);
  t.g('apply', '--check', patches[0]);
  t.g('apply', patches[0]);
  assert.equal(fs.readFileSync(path.join(t.repo, 'tracked.txt'), 'utf8'), 'staged-only\n');
  for (const f of fs.readdirSync(t.saves)) assert.ok(fs.statSync(path.join(t.saves, f)).size > 0, f);
  // Staged and unstaged both differ from the start: two patches, each applying to the start commit.
  t.g('checkout', '--', '.');
  fs.writeFileSync(path.join(t.repo, 'tracked.txt'), 'staged\n');
  t.g('add', 'tracked.txt');
  fs.writeFileSync(path.join(t.repo, 'tracked.txt'), 'working\n');
  const both = resetWorktree({ ...at(t), stamp: new Date('2026-10-05T13:00:00Z') });
  assert.equal(both.length, 2);
  assert.match(fs.readFileSync(both[0], 'utf8'), /\+staged/);
  assert.match(fs.readFileSync(both[1], 'utf8'), /\+working/);
  for (const p of both) t.g('apply', '--check', p);
});

test('a run that edited without committing and lost its provider keeps its work in a patch the exit names (#87)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/mimo-v2.6-flash': 'provider-dirty', 'openai/gpt-5.6-luna': 'provider-error' }) });
  assert.equal(r.status, 3, r.stderr + r.stdout);
  const m = r.stderr.match(/Unsaved work was saved before the reset: (\S+\.unsaved\.patch)\./);
  assert.ok(m, r.stderr);
  assert.match(path.basename(m[1]), /^T07\.mimo-flash\.\d{4}-\d\d-\d\dT[\d-]+\.\d{3}Z\.unsaved\.patch$/);
  const text = fs.readFileSync(m[1], 'utf8');
  assert.match(text, /\+edited, not committed/);
  assert.match(text, /\+untracked work/);
  assert.match(r.stdout, /unsaved work saved to: /);
  // Every brief's run rules keep the implementer inside its worktree and committing as it goes (L57).
  const prompt = readSessions(path.join(p.base, "oc.json"))[0].brief.replace(/\s+/g, " ");
  assert.match(prompt, /Never read, write or redirect to any path outside your worktree but your scratch folder: no other \/tmp path, no home directory, no git internals/);
  assert.match(prompt, /Scratch files go in your scratch folder \(\$TMPDIR, named at the top of this brief\), which is outside every checkout, so a test that needs a TMPDIR outside git uses it too\. .*\(L57, L66\)/);
  assert.match(prompt, /Commit and push after each step, so a run that ends early keeps its work\. \(L57\)/);
});

test('an exit 1 after a later attempt committed still names the earlier attempt\'s patch (#87)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/mimo-v2.6-flash': 'provider-dirty', 'openai/gpt-5.6-luna': 'commit-provider' }) });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /after committing, pushing or opening a PR .* Unsaved work was saved before the reset: \S+T07\.mimo-flash\.\S+\.unsaved\.patch\./);
});

test('the no-PR exit 1 names the patch a failed attempt saved (Sol\'s R3 on PR 100)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'luna'] });
  const r = implement(p, { FAKE_OC_MODES: JSON.stringify({ 'opencode-go/mimo-v2.6-flash': 'provider-dirty', 'openai/gpt-5.6-luna': 'stop-report' }) });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /No open PR .* Unsaved work was saved before the reset: \S+T07\.mimo-flash\.\S+\.unsaved\.patch\./);
});

test('implement.mjs --self-test checks the reset\'s save on a throwaway repository (#87)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/harness/implement.mjs'), '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /self-test: all checks passed/);
});

test('an Alibaba implementer refused for its key says which data directory\'s auth.json to check', posix, async () => {
  const p = project({ chain: ['qwen'] });
  const file = path.join(p.main, 'harness.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.models.qwen = { id: 'alibaba-token-plan/qwen3.8-flash', variant: 'high', family: 'qwen' };
  fs.writeFileSync(file, JSON.stringify(config));
  const r = implement(p, { FAKE_OC_MODE: 'invalid-key', FAKE_OC_MODELS: JSON.stringify(['alibaba-token-plan/qwen3.8-flash']) });
  assert.equal(r.status, 5, r.stderr + r.stdout);
  assert.match(r.stderr, /qwen: invalid API key for alibaba-token-plan: the auth\.json in \S+ may hold a stale Alibaba entry/);
});

test('a rejection from cd or .. says so in the failure, naming L31 (#14)', posix, async () => {
  const p = project({ chain: ['mimo-flash'] });
  const r = implement(p, { FAKE_OC_MODE: 'permission-cd' });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /permission rejected: external_directory \(\/tmp\/\*\); the rejected command used cd or \.\.: run commands from the worktree root.*\(L31\)/);
});

test('the same provider failure twice stops the chain with exit 3', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'spare', 'luna'] });
  const r = implement(p, { FAKE_OC_MODE: 'provider-error' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /The providers did not respond: same failure twice: provider-503/);
  assert.match(r.stderr, /Fall back to a Claude implementer \(sonnet\)/);
  assert.doesNotMatch(r.stdout, /attempt: luna/);
});

test('a model OpenCode does not list exits 5, no fallback, before any worktree or run, even with another model usable (L69)', posix, async () => {
  const p = project({ chain: ['mimo-flash', 'spare'] });
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS: '["opencode-go/spare-model"]' });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /^Setup: mimo-flash: opencode-go\/mimo-v2.6-flash is not in `opencode models opencode-go`/m);
  assert.match(r.stderr, /Fix it and rerun; no fallback \(L69\)\. Nothing ran\./);
  assert.doesNotMatch(r.stderr, /Claude implementer/);
  assert.equal(fs.existsSync(path.join(p.base, 'proj-work', 'T07')), false);
});

test('OpenCode Go not logged in: exit 5 with the login command for the scripts\' data directory', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_MODELS: '["openai/gpt-5.6-luna"]' });
  assert.equal(r.status, 5);
  const home = path.join(p.base, 'oc-home', 'data');
  assert.ok(r.stderr.includes(`OpenCode Go is not logged in for ${home}. Run \`opencode console login\` with XDG_DATA_HOME=${home}`));
  assert.match(r.stderr, /no fallback \(L69\)/);
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
});

test('a 2.x OpenCode (the desktop app\'s CLI) exits 5, before any worktree or run (#26, L69)', posix, async () => {
  const p = project();
  const r = implement(p, { FAKE_OC_MODE: 'implement', FAKE_OC_VERSION: '2.0.18' });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /Setup: OpenCode 2\.0\.18 at .* is not supported.*no fallback \(L69\)/);
  assert.equal(readSessions(path.join(p.base, 'oc.json')).length, 0);
  assert.equal(fs.existsSync(path.join(p.base, 'proj-work', 'T07')), false);
  const ok = implement(project(), { FAKE_OC_MODE: 'implement' });
  assert.match(ok.stdout, /^opencode: 1\.18\.34 \(/m);                             // the version is logged
});

test('OpenCode missing exits 5 before touching anything (L69)', posix, async () => {
  const p = project();
  const r = implement(p, { HARNESS_OPENCODE_EXE: '/no/such/opencode' });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /^Setup: .*no fallback \(L69\)/m);
  assert.equal(fs.existsSync(path.join(p.base, 'proj-work')), false);
});
