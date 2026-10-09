// Against the real OpenCode, when it is installed (CI installs the pinned 1.18 line). No model key
// is needed: the run fails at the provider, but the session, its record and the agent it ran on are
// what the runner depends on, and they exist before the model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOpenCodeWatched, resolveOpenCode, openCodeVersion, versionProblem, scratchAllow, withScratchAllow } from '../template/tools/harness/lib/opencode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let opencode = null;
try { opencode = resolveOpenCode(); } catch { /* not installed: skipped */ }
const skip = !opencode && 'opencode is not installed';

async function probe(withAgent) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-real-')));
  execFileSync('git', ['init', '-q', dir]);
  if (withAgent) {
    fs.mkdirSync(path.join(dir, '.opencode', 'agents'), { recursive: true });
    fs.copyFileSync(path.join(here, '../template/.opencode/agents/reviewer.md'), path.join(dir, '.opencode/agents/reviewer.md'));
  }
  return runOpenCodeWatched({
    args: ['run', '--dir', dir, '--agent', 'reviewer', '--model', 'opencode-go/no-such-model-for-tests'],
    prompt: 'line one\nline two', workDir: dir, title: 'harness-real', opencode,
    pollMs: 1000, startupTimeoutMs: 90_000, idleTimeoutMs: 90_000, totalTimeoutMs: 150_000,
    env: clean({ ...process.env, OPENCODE_API_KEY: '', OPENROUTER_API_KEY: '' }),
  });
}
// These tests read the project's own .opencode/: drop the reviewer's settings (review.mjs, L34) a
// review run may have left in the environment, which made one of them fail inside a review.
function clean(env) {
  const { OPENCODE_CONFIG_DIR: _dir, OPENCODE_DISABLE_PROJECT_CONFIG: _off, ...rest } = env;
  return rest;
}

test('real OpenCode: the session is found, and the agent it ran on is read from its record', { skip }, async () => {
  const r = await probe(true);
  assert.match(r.sessionId, /^ses_/);
  assert.equal(r.sessionAgent, 'reviewer');
  assert.equal(r.agentFallback, false);
});

test('real OpenCode: a missing agent file is caught as the silent fallback', { skip }, async () => {
  const r = await probe(false);
  assert.match(r.sessionId, /^ses_/);
  assert.notEqual(r.sessionAgent, 'reviewer');
  assert.equal(r.agentFallback, true);
});

// review.mjs runs the reviewer with OPENCODE_CONFIG_DIR at the main checkout's .opencode and the
// project's config disabled, so a PR's own reviewer.md is never the one loaded (#10, L34).
function configDirs() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cfg-')));
  const wt = path.join(base, 'wt');
  const main = path.join(base, 'main', '.opencode');
  for (const d of [path.join(wt, '.opencode', 'agents'), path.join(main, 'agents')]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', wt]);
  const agent = fs.readFileSync(path.join(here, '../template/.opencode/agents/reviewer.md'), 'utf8');
  fs.writeFileSync(path.join(main, 'agents', 'reviewer.md'), agent.replace(/^description: .*$/m, 'description: MAIN CHECKOUT'));
  fs.writeFileSync(path.join(wt, '.opencode', 'agents', 'reviewer.md'), agent.replace(/^description: .*$/m, 'description: PR WORKTREE'));
  const xdg = { XDG_DATA_HOME: path.join(base, 'data'), XDG_CACHE_HOME: path.join(base, 'cache'), XDG_STATE_HOME: path.join(base, 'state') };
  return { wt, main, env: { ...process.env, ...xdg, OPENCODE_CONFIG_DIR: main, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_API_KEY: '', OPENROUTER_API_KEY: '' } };
}

test('real OpenCode: with the reviewer\'s settings, the main checkout\'s agent loads, not the PR\'s', { skip }, () => {
  const { wt, env } = configDirs();
  const out = execFileSync(opencode.exe, [...opencode.prefix, 'debug', 'agent', 'reviewer'], { cwd: wt, env, encoding: 'utf8', timeout: 90_000 });
  assert.match(out, /MAIN CHECKOUT/);
  assert.doesNotMatch(out, /PR WORKTREE/);
});

test('real OpenCode: with the reviewer\'s settings, the runner still finds the session and its agent', { skip }, async () => {
  const { wt, env } = configDirs();
  const r = await runOpenCodeWatched({
    args: ['run', '--dir', wt, '--agent', 'reviewer', '--model', 'opencode-go/no-such-model-for-tests'],
    prompt: 'line one', workDir: wt, title: 'harness-real-cfg', opencode,
    pollMs: 1000, startupTimeoutMs: 90_000, idleTimeoutMs: 90_000, totalTimeoutMs: 150_000, env,
  });
  assert.match(r.sessionId, /^ses_/);
  assert.equal(r.sessionAgent, 'reviewer');
  assert.equal(r.agentFallback, false);
});

test('real OpenCode: --version gives a supported 1.x version (#26)', { skip }, async () => {
  const v = await openCodeVersion(opencode, { env: process.env, cwd: os.tmpdir() });
  assert.match(v, /^1\.\d+\.\d+$/);
  assert.equal(versionProblem(v, opencode.exe), null);
});

// OpenCode 1.18 lets every agent write to /tmp/opencode/ unasked; the agent files *allow* it
// (L43 correction, 2026-10-09) — OpenCode's tool-output flows there, and rejecting those writes
// kills the run. The L66a per-run scratch at /tmp/harness-run-<title> is the implementer's
// safety net, not a deny on OpenCode's namespace. This test pins the *new* allow shape: bash `>`
// writes succeed for the implementer; the reviewer stays read-only (edit: deny) for file-tools.
test('real OpenCode: /tmp/opencode/* is allowed for the implementer (L43 correction 2026-10-09)', { skip: skip || (process.platform === 'win32' && 'a POSIX path') }, () => {
  for (const role of ['implementer', 'reviewer']) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-allow-')));
    execFileSync('git', ['init', '-q', dir]);
    fs.mkdirSync(path.join(dir, '.opencode', 'agents'), { recursive: true });
    fs.copyFileSync(path.join(here, `../template/.opencode/agents/${role}.md`), path.join(dir, `.opencode/agents/${role}.md`));
    const target = `/tmp/opencode/harness-allow-${process.pid}-${role}`;
    const agent = (...extra) => {
      try {
        return execFileSync(opencode.exe, [...opencode.prefix, 'debug', 'agent', role, ...extra],
          { cwd: dir, env: clean(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
      } catch (e) { return `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    };
    // The file-writing tool depends on the model OpenCode would use: apply_patch for OpenAI's, write
    // otherwise (CI has no model configured).
    const shown = agent();
    const has = JSON.parse(shown.slice(shown.indexOf('{'))).tools ?? {};
    // bash write: implementer allowed, reviewer allowed too (bash `*`: allow per the rule) — but
    // the file-write tools (`apply_patch` / `write`) are denied for the reviewer (`edit: deny`).
    // Pin both: bash writes succeed regardless of role; file-tools behave per their rule.
    const bashCmd = `mkdir -p /tmp/opencode && echo x > ${target}-bash.txt`;
    const outBash = agent('--tool', 'bash', '--params', JSON.stringify({ command: bashCmd, description: 'probe' }));
    const bashWritten = fs.existsSync(`${target}-bash.txt`);
    fs.rmSync(`${target}-bash.txt`, { force: true });
    assert.equal(bashWritten, true, `${role} bash did not write ${target}-bash.txt: ${outBash.slice(-300)}`);
    if (role === 'reviewer') {
      // Reviewer's `edit: deny` covers the file-tools; bash is the meaningful check. Skip the
      // file-tools for the reviewer — the existing 'Tool apply_patch|write is disabled for agent
      // reviewer' assertion lives in the rules-pinning elsewhere.
      continue;
    }
    const fileTools = 'apply_patch' in has
      ? [['apply_patch', { patchText: `*** Begin Patch\n*** Add File: ${target}-file.txt\n+x\n*** End Patch` }, 'file']]
      : [['write', { filePath: `${target}-file.txt`, content: 'x' }, 'file']];
    for (const [tool, params, kind] of fileTools) {
      const out = agent('--tool', tool, '--params', JSON.stringify(params));
      const file = `${target}-${kind}.txt`;
      const written = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      assert.equal(written, true, `implementer file-tool did not write ${file} by ${tool}: ${out.slice(-300)}`);
    }
  }
});

// L66a (#138), on the real matcher. The project's implementer file gets `"*": deny` first in its
// external_directory block, so only an explicit allow lets a path through (`debug agent` lets an
// "ask" pass); the run's own config dir holds the per-run copy, as the runner writes it. OpenCode
// applies the last matching rule in file order, which is why the copy's allow comes last.
test('real OpenCode: the per-run allow admits this run\'s folder only, and the null device by identity (L66, #138)', { skip }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scratch-')));
  execFileSync('git', ['init', '-q', dir]);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scratch-root-')));
  const folder = (n) => { const d = path.join(root, `harness-run-${n}`); fs.mkdirSync(path.join(d, 'sub'), { recursive: true }); fs.writeFileSync(path.join(d, 'f'), 'x'); fs.writeFileSync(path.join(d, 'sub', 'f'), 'x'); return d; };
  const own = folder('T07-a1');
  folder('T07-b2');
  folder('T07-a1x');
  const template = fs.readFileSync(path.join(here, '../template/.opencode/agents/implementer.md'), 'utf8');
  const project = template.replace('  external_directory:\n', '  external_directory:\n    "*": deny\n');
  fs.mkdirSync(path.join(dir, '.opencode', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.opencode', 'agents', 'implementer.md'), project);
  const config = path.join(root, 'config');
  fs.mkdirSync(path.join(config, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(config, 'agents', 'implementer.md'), withScratchAllow(project, scratchAllow(own)));
  const read = (file, withConfig = true) => {
    const env = clean(process.env);
    if (withConfig) env.OPENCODE_CONFIG_DIR = config;
    try {
      return execFileSync(opencode.exe, [...opencode.prefix, 'debug', 'agent', 'implementer', '--tool', 'read', '--params', JSON.stringify({ filePath: file })],
        { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
    } catch (e) { return `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  };
  const denied = (out) => /prevents you from using this specific tool call/.test(out);
  const win = process.platform === 'win32';
  const cases = [
    [path.join(own, 'f'), false, 'its own folder'],
    [path.join(own, 'sub', 'f'), false, 'a subfolder of its own'],
    [path.join(root, 'harness-run-T07-b2', 'f'), true, 'another run\'s folder'],
    [path.join(root, 'harness-run-T07-a1x', 'f'), true, 'a folder whose name only starts with its own'],
    [win ? '\\\\.\\NUL' : '/dev/null', false, 'the null device'],
    [win ? 'C:\\a.bNUL-other\\f' : '/a.bNUL-other/f', true, 'a directory named like the null device'],
    // Below /dev is not the null device: /dev/shm is a writable tmpfs (Sol's R1, PR 152).
    ...(win ? [] : [['/dev/shm', true, 'a directory under /dev'], ['/dev/shm/harness-none', true, 'a file below /dev']]),
  ];
  for (const [file, deny, what] of cases) {
    const out = read(file);
    assert.equal(denied(out), deny, `${what} (${file}): ${out.slice(-300)}`);
  }
  // Without the run's config dir, its own folder is rejected too: the per-run copy is what allows it.
  assert.equal(denied(read(path.join(own, 'f'), false)), true, 'its own folder, without the per-run copy');
});
