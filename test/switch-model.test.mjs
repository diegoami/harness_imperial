// switch-model.mjs: the plan (lib/switch.mjs) directly, and the command end to end against the fake
// opencode, in a throwaway repository with the template's harness.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyOf, nameOf, planSwitch, showRoles } from '../template/tools/harness/lib/switch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../template');
const template = () => JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8'));

test('the family comes from the vendor in the id, not the route', () => {
  assert.equal(familyOf('opencode-go/deepseek-v4.1-flash'), 'deepseek');
  assert.equal(familyOf('openai/gpt-6-luna'), 'openai');
  assert.equal(familyOf('opencode-go/gpt-6-luna'), 'openai');
  assert.equal(familyOf('opencode-go/glm-5.3-flash'), 'glm');
  assert.equal(familyOf('opencode-go/kimi-k3'), 'kimi');
  assert.equal(familyOf('opencode-go/qwen3.8-max'), 'qwen');
  assert.equal(familyOf('opencode-go/grok-4.7'), 'xai');
  assert.equal(familyOf('anthropic/claude-opus-5-5'), 'anthropic');
  assert.equal(familyOf('opencode-go/space-bunny-free'), 'space');
});

test('the name is the existing entry\'s for a known id, else the id\'s model part', () => {
  assert.equal(nameOf(template(), 'openai/gpt-6-luna'), 'luna');
  assert.equal(nameOf(template(), 'opencode-go/kimi-k3'), 'kimi-k3');
});

test('a switch makes the model the role\'s one model, at high, and keeps every other model', () => {
  const p = planSwitch(template(), { role: 'reviewer', id: 'opencode-go/kimi-k3' });
  assert.deepEqual(p.config.reviewer.chain, ['kimi-k3']);
  assert.deepEqual(p.config.models['kimi-k3'], { id: 'opencode-go/kimi-k3', variant: 'high', family: 'kimi' });
  assert.equal(p.config.reviewer.claudeFallback, 'opus');
  assert.ok(p.config.models.luna);
  assert.deepEqual(p.config.implementer, template().implementer);
  assert.match(p.before, /^luna \(openai\/gpt-6-luna, high\) then Claude opus$/);
  assert.match(p.after, /^kimi-k3 \(opencode-go\/kimi-k3, high\) then Claude opus$/);
  assert.equal(planSwitch(template(), { role: 'implementer', id: 'opencode-go/kimi-k3', fallback: 'opus' }).config.implementer.claudeFallback, 'opus');
});

test('refused: max effort, the other role\'s family (unless forced), a taken name, a bad role or id', () => {
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'opencode-go/kimi-k3', variant: 'max' }), /max is never used/);
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'opencode-go/deepseek-v4-pro' }), /^Error: Refused: deepseek is also the implementer's family/);
  const forced = planSwitch(template(), { role: 'reviewer', id: 'opencode-go/deepseek-v4-pro', force: true });
  assert.match(forced.conflict, /every review would exit 3/);
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'opencode-go/kimi-k3', name: 'luna' }), /already holds openai\/gpt-6-luna/);
  assert.throws(() => planSwitch(template(), { role: 'tester', id: 'opencode-go/kimi-k3' }), /--role must be/);
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'kimi-k3' }), /provider\/model id/);
});

test('showRoles says what runs now', () => {
  assert.equal(showRoles(template()), [
    'implementer: deepseek-flash = opencode-go/deepseek-v4.1-flash (high, family deepseek), then Claude sonnet',
    'reviewer: luna = openai/gpt-6-luna (high, family openai), then Claude opus',
  ].join('\n'));
});

// End to end.
function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-switch-')));
  const repo = path.join(base, 'proj');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  fs.copyFileSync(path.join(root, 'harness.json'), path.join(repo, 'harness.json'));
  return { base, repo, config: () => JSON.parse(fs.readFileSync(path.join(repo, 'harness.json'), 'utf8')) };
}
const MODELS = JSON.stringify(['opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4-pro', 'opencode-go/kimi-k3', 'openai/gpt-6-luna']);
function sw(p, env, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'tools/harness/switch-model.mjs'), ...args], {
    cwd: p.repo, encoding: 'utf8',
    env: {
      ...process.env, HARNESS_OPENCODE_EXE: path.join(here, 'fake-opencode.mjs'), FAKE_OC_STATE: path.join(p.base, 'oc.json'),
      HARNESS_OPENCODE_HOME: path.join(p.base, 'oc-home'), HARNESS_OPENCODE_AUTH_SOURCE: path.join(p.base, 'auth.json'),
      FAKE_OC_MODELS: MODELS, ...env,
    },
  });
}
const posix = { skip: process.platform === 'win32' };

test('a switch writes harness.json; a dry run writes nothing', posix, () => {
  const p = project();
  const dry = sw(p, {}, '--role', 'reviewer', '--model', 'opencode-go/kimi-k3', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /after: {2}kimi-k3 \(opencode-go\/kimi-k3, high\) then Claude opus/);
  assert.deepEqual(p.config().reviewer.chain, ['luna']);
  const r = sw(p, {}, '--role', 'reviewer', '--model', 'opencode-go/kimi-k3');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(p.config().reviewer.chain, ['kimi-k3']);
  assert.match(r.stdout, /Commit it on main with the reason/);
  assert.match(sw(p, {}, '--show').stdout, /^reviewer: kimi-k3 = opencode-go\/kimi-k3 \(high, family kimi\), then Claude opus$/m);
});

test('a model OpenCode does not list exits 3, with the login command, and writes nothing', posix, () => {
  const p = project();
  const unknown = sw(p, {}, '--role', 'reviewer', '--model', 'opencode-go/no-such-model');
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /is not in `opencode models opencode-go`: check the id/);
  const noLogin = sw(p, { FAKE_OC_MODELS: '["openai/gpt-6-luna"]' }, '--role', 'implementer', '--model', 'opencode-go/kimi-k3');
  assert.equal(noLogin.status, 3);
  assert.match(noLogin.stderr, /OpenCode Go is not logged in for .*opencode console login/);
  assert.deepEqual(p.config(), JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8')));
});

test('the other role\'s family is refused with exit 1, and written with --force and a warning', posix, () => {
  const p = project();
  const refused = sw(p, {}, '--role', 'reviewer', '--model', 'opencode-go/deepseek-v4-pro');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refused: deepseek is also the implementer's family/);
  assert.deepEqual(p.config().reviewer.chain, ['luna']);
  const forced = sw(p, {}, '--role', 'reviewer', '--model', 'opencode-go/deepseek-v4-pro', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /warning \(--force\)/);
  assert.deepEqual(p.config().reviewer.chain, ['deepseek-v4-pro']);
});

test('--probe asks for one word through the runner; a failed probe writes nothing, and no probe directory stays', posix, () => {
  const p = project();
  const ok = sw(p, { FAKE_OC_OUTPUT: 'PONG\n' }, '--role', 'reviewer', '--model', 'opencode-go/kimi-k3', '--probe');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /probe: opencode-go\/kimi-k3 answered PONG in \d+ s/);
  const [session] = JSON.parse(fs.readFileSync(path.join(p.base, 'oc.json'), 'utf8'));
  assert.equal(session.dataHome, path.join(p.base, 'oc-home', 'data'));           // the scripts' data directory
  const q = project();
  const bad = sw(q, { FAKE_OC_MODE: 'exit2' }, '--role', 'reviewer', '--model', 'opencode-go/kimi-k3', '--probe');
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /probe failed \(exit 2\)/);
  assert.deepEqual(q.config().reviewer.chain, ['luna']);
  for (const x of [p, q]) {
    const work = path.join(x.base, 'proj-work');
    assert.deepEqual(fs.existsSync(work) ? fs.readdirSync(work).filter((f) => f.startsWith('probe-')) : [], []);
  }
});
