// switch-model.mjs: the plan (lib/switch.mjs) directly, and the command end to end against the fake
// opencode, in a throwaway repository with the template's harness.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessions } from './fake-state.mjs';
import { familyOf, nameOf, planSwitch, showRoles, isHeavy, defaultVariant } from '../template/tools/harness/lib/switch.mjs';

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
  assert.equal(nameOf(template(), 'openai/gpt-5.6-luna'), 'luna');
  assert.equal(nameOf(template(), 'opencode-go/kimi-k3'), 'kimi-k3');
});

test('a switch makes the model the role\'s one model, at high, and keeps every other model', () => {
  const p = planSwitch(template(), { role: 'reviewer', id: 'opencode-go/kimi-k3' });
  assert.deepEqual(p.config.reviewer.chain, ['kimi-k3']);
  assert.deepEqual(p.config.models['kimi-k3'], { id: 'opencode-go/kimi-k3', variant: 'high', family: 'kimi' });
  assert.equal(p.config.reviewer.claudeFallback, 'opus');
  assert.ok(p.config.models.luna);
  assert.deepEqual(p.config.implementer, template().implementer);
  assert.match(p.before, /^luna \(openai\/gpt-5\.6-luna, high\) then Claude opus$/);
  assert.match(p.after, /^kimi-k3 \(opencode-go\/kimi-k3, high\) then Claude opus$/);
  assert.equal(planSwitch(template(), { role: 'implementer', id: 'opencode-go/kimi-k3', fallback: 'opus' }).config.implementer.claudeFallback, 'opus');
});

test('refused: max effort, the other role\'s family (unless forced), a taken name, a bad role or id', () => {
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'opencode-go/kimi-k3', variant: 'max' }), /max is never used/);
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'opencode-go/deepseek-v4-pro' }), /^Error: Refused: deepseek is also the implementer's family/);
  const forced = planSwitch(template(), { role: 'reviewer', id: 'opencode-go/deepseek-v4-pro', force: true });
  assert.match(forced.conflict, /every review would exit 3/);
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'opencode-go/kimi-k3', name: 'luna' }), /already holds openai\/gpt-5\.6-luna/);
  assert.throws(() => planSwitch(template(), { role: 'tester', id: 'opencode-go/kimi-k3' }), /--role must be/);
  // --family cannot carry a model past the family rule (Luna's R1 on PR 17).
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'opencode-go/deepseek-v4-pro', family: 'kimi' }),
    /^Error: Refused: --family kimi contradicts opencode-go\/deepseek-v4-pro, whose vendor is deepseek/);
  assert.match(planSwitch(template(), { role: 'reviewer', id: 'opencode-go/deepseek-v4-pro', family: 'kimi', force: true }).conflict,
    /^deepseek is also the implementer's family/);
  assert.equal(planSwitch(template(), { role: 'reviewer', id: 'opencode-go/space-bunny-free', family: 'bunny' }).entry.family, 'bunny');
  assert.throws(() => planSwitch(template(), { role: 'reviewer', id: 'kimi-k3' }), /provider\/model id/);
});

test('a heavy model\'s default effort is low, else medium, else its lowest; a light one\'s is high (L54, #83)', () => {
  for (const id of ['openai/gpt-6.1-sol', 'openai/gpt-6-sol-fast', 'zai-coding-plan/glm-5.3', 'opencode-go/deepseek-v4-pro',
    'openrouter/deepseek/deepseek-v4-pro', 'anthropic/claude-opus-5-5']) assert.ok(isHeavy(id), id);
  for (const id of ['openai/gpt-5.6-luna', 'zai-coding-plan/glm-5.3-flash', 'opencode-go/deepseek-v4.1-flash', 'anthropic/claude-sonnet-5-5']) {
    assert.ok(!isHeavy(id), id);
    assert.equal(defaultVariant(id, ['low', 'high']), 'high', id);
  }
  assert.equal(defaultVariant('openai/gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max']), 'low');
  assert.equal(defaultVariant('zai-coding-plan/glm-5.3', ['low', 'high', 'max']), 'low');
  assert.equal(defaultVariant('openai/gpt-6.1-sol', ['medium', 'high']), 'medium');
  assert.equal(defaultVariant('opencode-go/deepseek-v4-pro', ['high', 'max']), 'high');      // its lowest
  assert.equal(defaultVariant('opencode-go/deepseek-v4-pro', ['xhigh', 'high', 'max']), 'high');  // by rank, not order
  for (const id of ['zai-coding-plan/glm-4.7', 'zai-coding-plan/glm-6', 'opencode-go/deepseek-v5-pro']) {
    assert.ok(!isHeavy(id), id);                                                             // only the models named
  }
  assert.equal(defaultVariant('openai/gpt-6.1-sol', ['none', 'high', 'max']), 'high');        // never none, never max
  assert.equal(defaultVariant('openai/gpt-6.1-sol', null), 'low');                          // not known
});

test('showRoles says what runs now', () => {
  assert.equal(showRoles(template()), [
    'implementer: glm-flash = zai-coding-plan/glm-5.3-flash (high, family glm), deepseek-flash = opencode-go/deepseek-v4.1-flash (high, family deepseek), then Claude sonnet',
    'reviewer: luna = openai/gpt-5.6-luna (high, family openai), then Claude opus',
    'on watch: sol = openai/gpt-6-sol, sol-6.1 = openai/gpt-6.1-sol, deepseek-pro = opencode-go/deepseek-v4-pro, glm = zai-coding-plan/glm-5.3, glm-flash = zai-coding-plan/glm-5.3-flash',
  ].join('\n'));
});

test('showRoles in the review profile: no implementer line, and the owner after the reviewers (#43)', () => {
  const t = template();
  const p = JSON.parse(fs.readFileSync(path.resolve(here, '../profiles/review/profile.json'), 'utf8'));
  const config = { models: Object.fromEntries(p.harness.models.map((m) => [m, t.models[m]])), reviewer: { ...t.reviewer, ...p.harness.reviewer } };
  const shown = showRoles(config).split('\n');
  assert.equal(shown.filter((l) => l.startsWith('implementer')).length, 0);
  assert.match(shown[0], /^reviewer: glm-flash = zai-coding-plan\/glm-5\.3-flash .*, deepseek-flash = opencode-go\/deepseek-v4\.1-flash \(high, family deepseek\), then the owner$/);
  assert.match(planSwitch(config, { role: 'reviewer', id: 'openai/gpt-5.6-luna' }).after, /then the owner$/);
  assert.match(showRoles({ reviewer: { chain: [] } }), /then Claude \?$/);       // unsaid stays visible
});

test('a switch to a model on watch keeps its watch (L35)', () => {
  const p = planSwitch(template(), { role: 'implementer', id: 'zai-coding-plan/glm-5.3' });
  assert.equal(p.name, 'glm');
  assert.equal(p.entry.watch, template().models.glm.watch);
  assert.deepEqual(p.config.implementer.chain, ['glm']);
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
const MODELS = JSON.stringify(['opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4-pro', 'opencode-go/kimi-k3', 'openai/gpt-5.6-luna']);
function sw(p, env, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'tools/harness/switch-model.mjs'), ...args], {
    cwd: p.repo, encoding: 'utf8',
    env: {
      ...process.env, HARNESS_OPENCODE_EXE: path.join(here, 'fake-opencode.mjs'), HARNESS_QUOTA_URL: 'http://127.0.0.1:9', FAKE_OC_STATE: path.join(p.base, 'oc.json'),
      HARNESS_OPENCODE_HOME: path.join(p.base, 'oc-home'), HARNESS_OPENCODE_AUTH_SOURCE: path.join(p.base, 'auth.json'),
      FAKE_OC_MODELS: MODELS, ...env,
    },
  });
}
// The fakes run through Node (HARNESS_GH_EXE, HARNESS_OPENCODE_EXE), so these tests run on Windows too (#2).
const posix = {};

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

test('without --variant, a switch writes the lowest effort OpenCode offers for a heavy model, and high for a light one (L54)', posix, () => {
  const p = project();
  const variants = JSON.stringify({ 'opencode-go/deepseek-v4-pro': ['high', 'max'], 'opencode-go/kimi-k3': ['low', 'high', 'max'] });
  const heavy = sw(p, { FAKE_OC_VARIANTS: variants }, '--role', 'implementer', '--model', 'opencode-go/deepseek-v4-pro', '--dry-run');
  assert.equal(heavy.status, 0, heavy.stderr);
  assert.match(heavy.stdout, /after: {2}deepseek-pro \(opencode-go\/deepseek-v4-pro, high\)/);
  const sol = sw(p, { FAKE_OC_MODELS: JSON.stringify(['openai/gpt-6.1-sol']), FAKE_OC_VARIANTS: JSON.stringify({ 'openai/gpt-6.1-sol': ['low', 'medium', 'high'] }) },
    '--role', 'reviewer', '--model', 'openai/gpt-6.1-sol', '--dry-run');
  assert.match(sol.stdout, /after: {2}sol-6\.1 \(openai\/gpt-6\.1-sol, low\)/);
  const given = sw(p, { FAKE_OC_MODELS: JSON.stringify(['openai/gpt-6.1-sol']) }, '--role', 'reviewer', '--model', 'openai/gpt-6.1-sol', '--variant', 'medium', '--dry-run');
  assert.match(given.stdout, /after: {2}sol-6\.1 \(openai\/gpt-6\.1-sol, medium\)/);                       // --variant wins
  const light = sw(p, { FAKE_OC_VARIANTS: variants }, '--role', 'reviewer', '--model', 'opencode-go/kimi-k3', '--dry-run');
  assert.match(light.stdout, /after: {2}kimi-k3 \(opencode-go\/kimi-k3, high\)/);
});

test('a model OpenCode does not list exits 3, with the login command, and writes nothing', posix, () => {
  const p = project();
  const unknown = sw(p, {}, '--role', 'reviewer', '--model', 'opencode-go/no-such-model');
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /is not in `opencode models opencode-go`: check the id/);
  const noLogin = sw(p, { FAKE_OC_MODELS: '["openai/gpt-5.6-luna"]' }, '--role', 'implementer', '--model', 'opencode-go/kimi-k3');
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
  assert.deepEqual(p.config().reviewer.chain, ['deepseek-pro']);
});

test('--probe asks for one word through the runner; a failed probe writes nothing, and no probe directory stays', posix, () => {
  const p = project();
  const ok = sw(p, { FAKE_OC_OUTPUT: 'PONG\n' }, '--role', 'reviewer', '--model', 'opencode-go/kimi-k3', '--probe');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /probe: opencode-go\/kimi-k3 answered PONG in \d+ s/);
  const [session] = readSessions(path.join(p.base, 'oc.json'));
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

test('a 2.x OpenCode exits 3 and writes nothing (#26)', posix, () => {
  const p = project();
  const r = sw(p, { FAKE_OC_VERSION: '2.0.18' }, '--role', 'reviewer', '--model', 'opencode-go/kimi-k3');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /OpenCode 2\.0\.18 at .* is not supported/);
  assert.deepEqual(p.config().reviewer.chain, ['luna']);
});
