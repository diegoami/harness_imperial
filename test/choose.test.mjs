// The chooser: ranking harness.json's models for a role and difficulty by quota-tracker's
// /recommend band over the owner's preference order (#128, the owner 2026-10-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecommend } from '../template/tools/harness/lib/quota.mjs';
import { chooserOrder, rankCandidates } from '../template/tools/harness/lib/choose.mjs';
import { quotaServer, entry } from './quota-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.resolve(here, '../template/tools/harness/choose.mjs');

const config = () => ({
  models: {
    'glm-flash': { id: 'zai-coding-plan/glm-5.3-flash', variant: 'high', family: 'glm' },
    'deepseek-flash': { id: 'opencode-go/deepseek-v4.1-flash', variant: 'high', family: 'deepseek' },
    'ali-qwen-flash': { id: 'alibaba-token-plan/qwen3.8-flash', variant: 'medium', family: 'qwen' },
    luna: { id: 'openai/gpt-5.6-luna', variant: 'high', family: 'openai' },
    glm: { id: 'zai-coding-plan/glm-5.3', variant: 'low', family: 'glm' },
  },
  implementer: { chain: ['glm-flash', 'deepseek-flash'] },
  reviewer: { chain: ['luna'], hard: ['glm', 'luna'] },
});

const of = (...entries) => ({ providers: new Map(entries.map((p) => [p.provider, p])) });
const rec = (...rows) => ({ rows: rows.map((r) => ({ usable: true, skipped: false, limiting_window: '7d', ...r })) });
const row = (provider, model, score, extra = {}) => ({ provider, model, score, ...extra });

test('chooserOrder: the block when it names it, the chains when it does not, and a rotting name refuses', () => {
  const c = config();
  c.chooser = { implementer: { easy: ['deepseek-flash'], hard: ['ali-qwen-flash'] } };
  assert.deepEqual(chooserOrder(c, { role: 'implementer', difficulty: 'easy' }), ['deepseek-flash']);
  assert.deepEqual(chooserOrder(c, { role: 'implementer', difficulty: 'hard' }), ['ali-qwen-flash']);
  // No block: the chains. Reviewer hard is reviewer.hard; implementer hard puts deepseek first.
  assert.deepEqual(chooserOrder(config(), { role: 'reviewer', difficulty: 'hard' }), ['glm', 'luna']);
  assert.deepEqual(chooserOrder(config(), { role: 'implementer', difficulty: 'hard' })[0], 'deepseek-flash');
  const rotted = config();
  rotted.chooser = { reviewer: { easy: ['nobody'] } };
  assert.throws(() => chooserOrder(rotted, { role: 'reviewer', difficulty: 'easy' }), /names nobody, which harness\.json's models does not list/);
});


test('a pool with spare calls outranks one that runs out before its reset, whatever the preference order (#128)', () => {
  const c = config();
  c.chooser = { implementer: { easy: ['deepseek-flash', 'glm-flash'] } };
  // opencode_go has the bigger headroom percentage but would run out before its monthly reset;
  // zai has spare calls/day: the comparable measure decides, not the percentage.
  const quota = of(entry('opencode_go', 'ok', [], { headroom_pct: 70 }), entry('zai', 'ok', [], { headroom_pct: 25 }));
  const recommend = rec(row('opencode_go', 'deepseek-v4.1-flash', -742, { limiting_window: '30d' }), row('zai', 'glm-5.3-flash', 14, { limiting_window: '1w' }));
  const ranked = rankCandidates({ config: c, role: 'implementer', difficulty: 'easy', quota, recommend });
  assert.deepEqual(ranked.map((r) => [r.name, r.band, r.score]), [['glm-flash', 0, 14], ['deepseek-flash', 1, -742]]);
  assert.match(ranked[0].note, /14 spare calls\/day/);
});

test('within a band the owner\'s preference order decides, not the score', () => {
  const c = config();
  c.chooser = { reviewer: { hard: ['glm', 'luna'] } };
  const recommend = rec(row('zai', 'glm-5.3', 6, { limiting_window: '1w' }), row('openai', 'gpt-5.6-luna', 449));
  const ranked = rankCandidates({ config: c, role: 'reviewer', difficulty: 'hard', quota: of(), recommend });
  assert.deepEqual(ranked.map((r) => r.name), ['glm', 'luna']);
});

test('a pool not yet sized (score null) is band 0 while usable with spare, band 1 without', () => {
  const c = config();
  c.chooser = { reviewer: { easy: ['glm', 'luna'] } };
  const sized = rec(row('zai', 'glm-5.3', -5), row('openai', 'gpt-5.6-luna', null, { spare_pct: 95, limiting_window: 'gpt-5.6-luna:7d' }));
  let ranked = rankCandidates({ config: c, role: 'reviewer', difficulty: 'easy', quota: of(), recommend: sized });
  assert.deepEqual(ranked.map((r) => [r.name, r.band]), [['luna', 0], ['glm', 1]]);
  assert.match(ranked[0].note, /not yet sized, 95% spare/);
  const none = rec(row('zai', 'glm-5.3', -5), row('openai', 'gpt-5.6-luna', null, { spare_pct: 0, limiting_window: 'gpt-5.6-luna:7d' }));
  ranked = rankCandidates({ config: c, role: 'reviewer', difficulty: 'easy', quota: of(), recommend: none });
  assert.deepEqual(ranked.map((r) => [r.name, r.band]), [['glm', 1], ['luna', 1]]);
  const unusable = rec(row('openai', 'gpt-5.6-luna', null, { spare_pct: 40, usable: false }));
  assert.equal(rankCandidates({ config: c, role: 'reviewer', difficulty: 'easy', quota: of(), recommend: unusable }).find((r) => r.name === 'luna').band, 1);
});

test('OpenRouter\'s prepaid 0 and a skipped (nearly full) pool are band 1; an unranked one is band 2 (#125)', () => {
  const c = config();
  c.models.or = { id: 'openrouter/deepseek/deepseek-v4.1-flash', variant: 'high', family: 'deepseek' };
  c.chooser = { implementer: { easy: ['ali-qwen-flash', 'or', 'glm-flash', 'deepseek-flash'] } };
  const recommend = { rows: [
    { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', score: 0, usable: true, skipped: false },
    { provider: 'zai', model: 'glm-5.3-flash', score: null, skipped: true, why: '1w: 96% used' },
    { provider: 'opencode_go', model: 'deepseek-v4.1-flash', score: 3, usable: true, skipped: false, limiting_window: '30d' },
  ] };
  const ranked = rankCandidates({ config: c, role: 'implementer', difficulty: 'easy', quota: of(), recommend });
  assert.deepEqual(ranked.map((r) => [r.name, r.band]), [['deepseek-flash', 0], ['or', 1], ['glm-flash', 1], ['ali-qwen-flash', 2]]);
  assert.match(ranked.find((r) => r.name === 'glm-flash').note, /skipped by \/recommend: 1w: 96% used/);
  assert.match(ranked.find((r) => r.name === 'ali-qwen-flash').note, /not ranked/);
  assert.equal(ranked.find((r) => r.name === 'ali-qwen-flash').blocked, null);
});

test('a model /recommend does not list takes its provider\'s shared pool, never a model\'s own window', () => {
  const c = config();
  c.models.sol = { id: 'openai/gpt-6-sol', variant: 'low', family: 'openai' };
  c.chooser = { reviewer: { easy: ['sol', 'glm'] } };
  // Sol draws on openai's shared 7d pool (sol-6.1's row), never on Luna's own window: shared
  // runs out, Luna's is fresh -> band 1; then shared is fresh, Luna's runs out -> band 0.
  let recommend = rec(
    row('openai', 'gpt-5.6-luna', 900, { limiting_window: 'gpt-5.6-luna:7d' }),
    row('openai', 'gpt-6.1-sol', -20, { limiting_window: '7d' }),
    row('zai', 'glm-5.3', 6, { limiting_window: '1w' }),
  );
  let ranked = rankCandidates({ config: c, role: 'reviewer', difficulty: 'easy', quota: of(), recommend });
  assert.deepEqual(ranked.map((r) => [r.name, r.band]), [['glm', 0], ['sol', 1]]);
  assert.match(ranked.find((r) => r.name === 'sol').note, /its provider's gpt-6\.1-sol row/);
  recommend = rec(
    row('openai', 'gpt-5.6-luna', -50, { limiting_window: 'gpt-5.6-luna:7d' }),
    row('openai', 'gpt-6.1-sol', 300, { limiting_window: '7d' }),
  );
  ranked = rankCandidates({ config: c, role: 'reviewer', difficulty: 'easy', quota: of(), recommend });
  assert.equal(ranked.find((r) => r.name === 'sol').band, 0);
});

test('an exhausted provider ranks last with the reason; a reviewer never shares the implementer\'s family', () => {
  const quota = of(
    entry('zai', 'exhausted', [], { available_in: '41m', headroom_pct: 0 }),
    entry('openai', 'ok', [], { headroom_pct: 70 }),
  );
  const ranked = rankCandidates({ config: config(), role: 'reviewer', difficulty: 'hard', quota,
    recommend: { rows: [] }, implementedBy: 'glm-flash' });
  // glm is excluded (the implementer's family) and ranks last with the reason; luna reviews.
  assert.equal(ranked[0].name, 'luna');
  assert.equal(ranked[ranked.length - 1].name, 'glm');
  assert.match(ranked.find((r) => r.name === 'glm').blocked, /implementer's family/);
});

test('a model whose own window is exhausted ranks last on fresh provider headroom (quota blocking, Sol\'s R1)', () => {
  const c = config();
  c.models.sol = { id: 'openai/gpt-6.1-sol', variant: 'low', family: 'openai' };
  c.chooser = { reviewer: { easy: ['luna', 'sol'] } };
  // openai is fresh (70% left) but luna's own gpt-5.6-luna:7d window is exhausted: band sorting
  // alone would put both in band 0 — only the blocked-first comparator separates them.
  const quota = of(entry('openai', 'ok', [
    { name: 'gpt-5.6-luna:7d', used_pct: 97, resets_in: '6d' },
    { name: '7d', used_pct: 30, resets_in: '4d' },
  ], { headroom_pct: 70 }));
  const ranked = rankCandidates({ config: c, role: 'reviewer', difficulty: 'easy', quota, recommend: { rows: [] } });
  assert.equal(ranked[0].name, 'sol');
  assert.equal(ranked[ranked.length - 1].name, 'luna');
  assert.match(ranked.find((r) => r.name === 'luna').blocked, /own gpt-5\.6-luna:7d window is 97% used/);
});

test('readRecommend: both tiers, a loading note with nothing ranked adds nothing, off when neither answers', async () => {
  const heavy = { ranking: [{ provider: 'openai', model: 'gpt-6.1-sol', score: 449 }], skipped: [{ provider: 'opencode_go', model: 'deepseek-v4-pro', score: null, reasons: ['30d: 99% used'] }] };
  const light = { ranking: [], skipped: [], note: 'statistics are loading' };
  const s = await quotaServer([], undefined, { FAKE_RECOMMEND_HEAVY: JSON.stringify(heavy), FAKE_RECOMMEND_LIGHT: JSON.stringify(light) });
  try {
    const got = await readRecommend({ HARNESS_QUOTA_URL: s.url });
    assert.deepEqual(got.rows.map((r) => [r.model, r.tier, r.skipped]), [['gpt-6.1-sol', 'heavy', false], ['deepseek-v4-pro', 'heavy', true]]);
    assert.equal(got.rows[1].why, '30d: 99% used');
  } finally { s.stop(); }
  const loading = await quotaServer([], undefined, { FAKE_RECOMMEND_HEAVY: JSON.stringify(light), FAKE_RECOMMEND_LIGHT: JSON.stringify(light) });
  try { assert.match((await readRecommend({ HARNESS_QUOTA_URL: loading.url })).off, /loading/); } finally { loading.stop(); }
  const garbage = await quotaServer([], undefined, { FAKE_RECOMMEND_HEAVY: JSON.stringify({ ranking: [{ model: 3 }] }) });
  try { assert.match((await readRecommend({ HARNESS_QUOTA_URL: garbage.url })).off, /unreadable/); } finally { garbage.stop(); }
  assert.match((await readRecommend({ HARNESS_QUOTA_URL: 'http://127.0.0.1:9' })).off, /gave nothing/);
});

test('quota off means preference alone, even with /recommend reachable (Sol\'s R2)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choose2-'));
  const c = config();
  c.chooser = { implementer: { hard: ['deepseek-flash', 'ali-qwen-flash'] } };
  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify(c));
  await new Promise((r) => spawn(process.execPath, ['-e', 'require("child_process").execSync("git init -q")'], { cwd: dir }).on('exit', r));
  // /quota is garbage; /recommend would put ali-qwen-flash first. It must not reorder.
  const s2 = await quotaServer([], 'not json', { FAKE_RECOMMEND_LIGHT: JSON.stringify({ ranking: [
    { provider: 'alibaba', model: 'qwen3.8-flash', score: 99, usable: true }, { provider: 'opencode_go', model: 'deepseek-v4.1-flash', score: -9, usable: true }] }) });
  try {
    const run = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [tool, ...args], { cwd: dir, env: { ...process.env, HARNESS_QUOTA_URL: s2.url }, encoding: 'utf8' });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, out, err }));
    });
    const r = await run(['--role', 'implementer', '--difficulty', 'hard']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /quota: not checked/);
    assert.match(r.out, /1\. deepseek-flash/);
    assert.match(r.out, /2\. ali-qwen-flash/);
  } finally {
    s2.stop();
    delete process.env.FAKE_QUOTA; delete process.env.FAKE_QUOTA_PROVIDERS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI ranks, picks, and exits 3 when nothing is usable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choose-'));
  const run = (args, env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [tool, ...args], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
  const c = config();
  c.chooser = { implementer: { easy: ['deepseek-flash', 'ali-qwen-flash'] } };
  const git = (a) => spawn(process.execPath, ['-e', `require("child_process").execSync("git ${a.join(' ')}")`], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify(c));
  await new Promise((r) => git(['init', '-q']).on('exit', r));
  const s = await quotaServer([
    entry('opencode_go', 'ok', [{ name: '30d', used_pct: 20, resets_in: '5d' }], { headroom_pct: 80 }),
  ], undefined, { FAKE_RECOMMEND_LIGHT: JSON.stringify({ ranking: [{ provider: 'opencode_go', model: 'deepseek-v4.1-flash', score: 120, usable: true }] }) });
  try {
    const table = await run(['--role', 'implementer', '--difficulty', 'easy'], { HARNESS_QUOTA_URL: s.url });
    assert.equal(table.code, 0, table.err);
    assert.match(table.out, /1\. deepseek-flash/);
    assert.match(table.out, /2\. ali-qwen-flash/);
    assert.match(table.out, /1\. deepseek-flash.*band 0 — 120 spare calls\/day/);
    assert.match(table.out, /2\. ali-qwen-flash.*band 2 — not ranked by \/recommend/);
    const pick = await run(['--role', 'implementer', '--difficulty', 'easy', '--pick'], { HARNESS_QUOTA_URL: s.url });
    assert.equal(pick.code, 0);
    assert.match(pick.out.trim().split('\n').at(-1), /^deepseek-flash$/);
    const json = await run(['--role', 'implementer', '--difficulty', 'easy', '--json'], { HARNESS_QUOTA_URL: s.url });
    assert.deepEqual(JSON.parse(json.out).ranked.map((r) => r.name), ['deepseek-flash', 'ali-qwen-flash']);
  } finally { s.stop(); }
  const dead = await run(['--role', 'implementer', '--difficulty', 'easy', '--pick'], { HARNESS_QUOTA_URL: 'http://127.0.0.1:9' });
  assert.equal(dead.code, 0);            // tracker off: ranks by preference alone, never blocks
  const blocked = await quotaServer([
    entry('opencode_go', 'exhausted', [], { available_in: '41m' }),
    entry('alibaba', 'exhausted', [], { available_in: '9h' }),
  ]);
  try {
    const none = await run(['--role', 'implementer', '--difficulty', 'easy', '--pick'], { HARNESS_QUOTA_URL: blocked.url });
    assert.equal(none.code, 3);
    assert.match(none.err, /nothing is usable now/);
  } finally { blocked.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
