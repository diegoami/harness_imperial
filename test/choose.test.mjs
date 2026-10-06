// The chooser: ranking harness.json's models for a role and difficulty by live quota and
// pricing over the owner's preference order (headroom outranks pricing — the owner, 2026-10-06).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPricing } from '../template/tools/harness/lib/quota.mjs';
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
const pricing = (map) => ({ pricing: new Map(Object.entries(map)) });

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

test('headroom outranks pricing: a discounted nearly-burnt pool loses to a fresh one (the owner, 2026-10-06)', () => {
  const c = config();
  c.chooser = { implementer: { easy: ['ali-qwen-flash', 'deepseek-flash'] } };
  const quota = of(
    entry('alibaba', 'low', [{ name: 'month', used_pct: 92, resets_in: '12d' }], { headroom_pct: 8 }),
    entry('opencode_go', 'ok', [{ name: '7d', used_pct: 20, resets_in: '5d' }], { headroom_pct: 80 }),
  );
  const ranked = rankCandidates({ config: c, role: 'implementer', difficulty: 'easy', quota, pricing: pricing({ alibaba: { discount_now: true, next_change_at: 1791295200 } }) });
  assert.equal(ranked[0].name, 'deepseek-flash');
  assert.equal(ranked[1].name, 'ali-qwen-flash');
  assert.equal(ranked[1].band, 2);
  assert.equal(ranked[1].tier, -1);
  assert.match(ranked[1].note, /discount on/);
});

test('pricing reorders peers within a band: a discount promotes, a peak demotes', () => {
  const c = config();
  c.chooser = { implementer: { easy: ['glm-flash', 'ali-qwen-flash', 'deepseek-flash'] } };
  const quota = of(
    entry('zai', 'ok', [], { headroom_pct: 60 }),
    entry('alibaba', 'ok', [], { headroom_pct: 60 }),
    entry('opencode_go', 'ok', [], { headroom_pct: 60 }),
  );
  const ranked = rankCandidates({ config: c, role: 'implementer', difficulty: 'easy', quota,
    pricing: pricing({ alibaba: { discount_now: true }, zai: { peak_now: true } }) });
  assert.deepEqual(ranked.map((r) => r.name), ['ali-qwen-flash', 'deepseek-flash', 'glm-flash']);
  assert.equal(ranked.find((r) => r.name === 'glm-flash').tier, 1);
});

test('an exhausted provider ranks last with the reason; a reviewer never shares the implementer\'s family', () => {
  const quota = of(
    entry('zai', 'exhausted', [], { available_in: '41m', headroom_pct: 0 }),
    entry('openai', 'ok', [], { headroom_pct: 70 }),
  );
  const ranked = rankCandidates({ config: config(), role: 'reviewer', difficulty: 'hard', quota,
    pricing: { pricing: new Map() }, implementedBy: 'glm-flash' });
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
  const ranked = rankCandidates({ config: c, role: 'reviewer', difficulty: 'easy', quota, pricing: { pricing: new Map() } });
  assert.equal(ranked[0].name, 'sol');
  assert.equal(ranked[ranked.length - 1].name, 'luna');
  assert.match(ranked.find((r) => r.name === 'luna').blocked, /own gpt-5\.6-luna:7d window is 97% used/);
});

test('quota off means preference alone, even with pricing reachable (Sol\'s R2)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choose2-'));
  const c = config();
  c.chooser = { implementer: { hard: ['deepseek-flash', 'ali-qwen-flash'] } };
  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify(c));
  await new Promise((r) => spawn(process.execPath, ['-e', 'require("child_process").execSync("git init -q")'], { cwd: dir }).on('exit', r));
  // /quota is garbage; /quota/alibaba answers a discount. The discount must not reorder.
  process.env.FAKE_QUOTA_PROVIDERS = JSON.stringify([entry('alibaba', 'ok', [], { pricing: { discount_now: true } })]);
  const s2 = await quotaServer([], 'not json');
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

test('a provider the tracker could not check is band 1, unknown, blocking nothing', () => {
  const quota = of(entry('openai', 'error', [], { headroom_pct: null }));
  const c = config();
  c.chooser = { implementer: { easy: ['deepseek-flash', 'ali-qwen-flash'] } };
  const ranked = rankCandidates({ config: c, role: 'implementer', difficulty: 'easy', quota,
    pricing: { pricing: new Map() } });
  const ds = ranked.find((r) => r.name === 'deepseek-flash');
  assert.equal(ds.band, 1);            // opencode_go absent from the tracker: unknown, not blocked
  assert.equal(ds.blocked, null);
  assert.equal(ds.status, 'unknown');
});

test('readPricing: present, absent without blocking, and off when the service is down', async () => {
  const s = await quotaServer([
    entry('alibaba', 'ok', [], { pricing: { discount_now: false, next_change_at: 1 } }),
    entry('zai', 'ok', [], { pricing: { peak_now: true, next_change_at: 2 } }),
  ]);
  try {
    const got = await readPricing({ HARNESS_QUOTA_URL: s.url });
    assert.equal(got.pricing.get('alibaba').discount_now, false);
    assert.equal(got.pricing.get('zai').peak_now, true);
  } finally { s.stop(); }
  const none = await quotaServer([entry('alibaba', 'ok', []), entry('zai', 'ok', [])]);
  try {
    const got = await readPricing({ HARNESS_QUOTA_URL: none.url });
    assert.equal(got.pricing.size, 0);   // no pricing anywhere: not off, just empty
  } finally { none.stop(); }
  const down = await readPricing({ HARNESS_QUOTA_URL: 'http://127.0.0.1:9' });
  assert.match(down.off, /did not answer/);
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
    entry('opencode_go', 'ok', [{ name: '7d', used_pct: 20, resets_in: '5d' }], { headroom_pct: 80 }),
    entry('alibaba', 'low', [{ name: 'month', used_pct: 92, resets_in: '12d' }], { headroom_pct: 8, pricing: { discount_now: true } }),
  ]);
  try {
    const table = await run(['--role', 'implementer', '--difficulty', 'easy'], { HARNESS_QUOTA_URL: s.url });
    assert.equal(table.code, 0, table.err);
    assert.match(table.out, /1\. deepseek-flash/);
    assert.match(table.out, /2\. ali-qwen-flash/);
    assert.match(table.out, /discount on/);
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
