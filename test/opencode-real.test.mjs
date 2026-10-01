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
    env: { ...process.env, OPENCODE_API_KEY: '', OPENROUTER_API_KEY: '' },
  });
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
