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
import { runOpenCodeWatched, resolveOpenCode } from '../template/tools/harness/lib/opencode.mjs';

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
