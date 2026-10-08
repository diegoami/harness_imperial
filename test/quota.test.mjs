// lib/quota.mjs: which models quota-tracker's answer rules out before a chain runs (L50).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerOf, quotaBlock, readQuota } from '../template/tools/harness/lib/quota.mjs';
import { quotaServer, entry } from './quota-server.mjs';

const of = (...entries) => ({ providers: new Map(entries.map((e) => [e.provider, e])) });

test('each model id maps to its quota-tracker provider', () => {
  assert.equal(providerOf('openai/gpt-6.1-sol'), 'openai');
  assert.equal(providerOf('zai-coding-plan/glm-5.3-flash'), 'zai');
  assert.equal(providerOf('minimax/MiniMax-M3'), 'minimax');                       // the gate must know it (Luna's R1, PR 115)
  assert.equal(providerOf('alibaba-token-plan/qwen3.8-max'), 'alibaba');
  assert.equal(providerOf('opencode-go/deepseek-v4.1-flash'), 'opencode_go');
  assert.equal(providerOf('openrouter/deepseek/deepseek-v4-pro'), 'openrouter');
  assert.equal(providerOf('alibaba-token-plan/qwen3.8-max'), 'alibaba');
  assert.equal(providerOf('someone/else'), null);
});

test('an exhausted provider blocks its models, saying until when; ok, low, error and not_configured do not', () => {
  assert.equal(quotaBlock('zai-coding-plan/glm-5.3', of(entry('zai', 'exhausted', [], { available_in: '2h08m' }))),
    'zai is exhausted until it is usable again in 2h08m');
  for (const status of ['ok', 'low', 'error', 'not_configured']) assert.equal(quotaBlock('zai-coding-plan/glm-5.3', of(entry('zai', status))), null, status);
  assert.equal(quotaBlock('zai-coding-plan/glm-5.3', of(entry('openai', 'exhausted'))), null);       // another provider
  assert.equal(quotaBlock('someone/else', of(entry('openai', 'exhausted'))), null);
});

test('every model is judged on the main quota; an exhausted provider still runs only what when_exhausted.usable_models names (L65)', () => {
  const out = (extra) => of(entry('openai', 'exhausted', [{ name: '7d', used_pct: 100, resets_in: '5d' }], { available_in: '5d', ...extra }));
  // OpenAI exhausted and naming Luna: Luna alone runs; Sol does not.
  const named = out({ when_exhausted: { usable_models: ['gpt-5.6-luna'] } });
  assert.equal(quotaBlock('openai/gpt-5.6-luna', named), null);
  assert.match(quotaBlock('openai/gpt-6.1-sol', named), /openai is exhausted/);
  // Exhausted without the field (or naming nothing): Luna is blocked like Sol.
  for (const extra of [{}, { when_exhausted: null }, { when_exhausted: { usable_models: [] } }]) {
    assert.match(quotaBlock('openai/gpt-5.6-luna', out(extra)), /openai is exhausted until it is usable again in 5d/, JSON.stringify(extra));
  }
  // Not exhausted: Luna runs, judged on the main window; a stale model window no longer counts.
  assert.equal(quotaBlock('openai/gpt-5.6-luna', of(entry('openai', 'ok', [{ name: '7d', used_pct: 40 }, { name: 'gpt-5.6-luna:7d', used_pct: 99 }]))), null);
  // error and not_configured block nothing (Sol's R2 on PR 77).
  for (const status of ['error', 'not_configured']) assert.equal(quotaBlock('openai/gpt-5.6-luna', of(entry('openai', status))), null, status);
});

test('a free OpenRouter model is judged by the daily allowance of free requests, not the credit', () => {
  const or = (status, remaining) => of(entry('openrouter', status, [{ name: 'credits', used_pct: 100 }],
    { free_model_daily_requests: { used: 1000 - remaining, limit: 1000, remaining } }));
  const free = 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free';
  assert.equal(quotaBlock(free, or('exhausted', 995)), null);                         // credit spent, requests left
  assert.match(quotaBlock(free, or('ok', 0)), /free models' daily allowance is used up \(1000 of 1000 requests\)/);
  assert.match(quotaBlock('openrouter/deepseek/deepseek-v4-pro', or('exhausted', 995)), /openrouter is exhausted/);   // a paid model
  assert.equal(quotaBlock(free, of(entry('openrouter', 'ok'))), null);                 // no allowance reported
});

test('readQuota reads the service, and is off, saying why, when it does not answer or answers nonsense', async () => {
  const s = await quotaServer([entry('zai', 'exhausted'), entry('openai', 'ok')]);
  try {
    const q = await readQuota({ HARNESS_QUOTA_URL: s.url });
    assert.deepEqual([...q.providers.keys()], ['zai', 'openai']);
  } finally { s.stop(); }
  assert.match((await readQuota({ HARNESS_QUOTA_URL: 'http://127.0.0.1:9' })).off, /did not answer/);
  // Nonsense, or a malformed window, checks nothing rather than crash (Sol's R1 on PR 77).
  for (const body of [{ nonsense: 1 }, [entry('openai', 'ok', {})], [entry('openai', 'ok', [null])],
    [entry('openai', 'ok', [{ used_pct: 97 }])], [entry('openai', 'ok', [{ name: 'x', used_pct: '97' }])], [{ provider: 'openai' }],
    [entry('openai', 'ok', [{ name: 'gpt-5.6-luna:7d', used_pct: 97, resets_in: { toString: null } }])],
    [entry('zai', 'exhausted', [], { available_in: { toString: null } })],
    [entry('openrouter', 'ok', [], { free_model_daily_requests: { remaining: '5', limit: 1000 } })],
    [entry('openai', 'exhausted', [], { when_exhausted: { usable_models: 'gpt-5.6-luna' } })],
    [entry('openai', 'exhausted', [], { when_exhausted: { usable_models: [7] } })],
    [entry('openai', 'exhausted', [], { when_exhausted: 'gpt-5.6-luna' })],
    [entry('openai', 'exhausted', [], { when_exhausted: {} })],
    [entry('openai', 'exhausted', [], { when_exhausted: [] })],
    [entry('openai', 'exhausted', [], { when_exhausted: ['gpt-5.6-luna'] })]]) {
    const bad = await quotaServer(body);
    try {
      assert.match((await readQuota({ HARNESS_QUOTA_URL: bad.url })).off, /unreadable/, JSON.stringify(body));
    } finally { bad.stop(); }
  }
});
