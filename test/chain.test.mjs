import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChain, excludeImplementers } from '../template/tools/harness/lib/chain.mjs';

const script = (outcomes) => {
  const tried = [];
  return { tried, attempt: async (m) => { tried.push(m); return outcomes[m]; } };
};

test('the chain stops at the first success', async () => {
  const s = script({ a: { ok: false, reason: 'provider error: 503: x' }, b: { ok: true, value: 'v' }, c: { ok: true } });
  const r = await runChain({ chain: ['a', 'b', 'c'], attempt: s.attempt });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'b');
  assert.deepEqual(s.tried, ['a', 'b']);
});

test('a failed attempt that handed the task over stops the chain, its work saved first (L70)', async () => {
  const s = script({ a: { ok: false, reason: 'provider error: 503: x' }, b: { ok: true } });
  const saves = [];
  const r = await runChain({ chain: ['a', 'b'], attempt: s.attempt, leftWork: async () => true, save: async (f, kind) => { saves.push([f.reason, kind]); } });
  assert.equal(r.ok, false);
  assert.equal(r.leftWork, true);
  assert.equal(r.process, false);
  assert.deepEqual(s.tried, ['a']);
  assert.deepEqual(saves, [['provider error: 503: x', 'provider']]);
});

test('every failed attempt is saved before the next one runs, and a success is not (L70)', async () => {
  const s = script({ a: { ok: false, reason: 'provider error: 503: x' }, b: { ok: false, reason: 'provider error: 429: y' }, c: { ok: true, value: 1 } });
  const order = [];
  const attempt = async (m) => { order.push(`run ${m}`); return s.attempt(m); };
  const r = await runChain({ chain: ['a', 'b', 'c'], attempt, save: async (f) => { order.push(`save ${f.reason}`); } });
  assert.equal(r.name, 'c');
  assert.deepEqual(order, ['run a', 'save provider error: 503: x', 'run b', 'save provider error: 429: y', 'run c']);
});

test('two consecutive provider failures with the same cause stop the chain', async () => {
  const s = script({ a: { ok: false, reason: 'provider error: 503: x' }, b: { ok: false, reason: 'provider error: 503: y' }, c: { ok: true } });
  const r = await runChain({ chain: ['a', 'b', 'c'], attempt: s.attempt });
  assert.equal(r.ok, false);
  assert.equal(r.process, false);
  assert.equal(r.sameCause, 'provider-503');
  assert.deepEqual(s.tried, ['a', 'b']);
});

test('different causes keep the chain going', async () => {
  const s = script({ a: { ok: false, reason: 'provider error: 503: x' }, b: { ok: false, reason: 'provider error: 429: y' }, c: { ok: true, value: 1 } });
  const r = await runChain({ chain: ['a', 'b', 'c'], attempt: s.attempt });
  assert.equal(r.name, 'c');
});

test('a failure through our process stops the chain at once, its work saved (L69, L70)', async () => {
  for (const reason of ['no session in 180 s', 'permission rejected: x', 'session idle for 600 s while a tool ran: bash npm test', 'exit 1', 'no review in its output']) {
    const s = script({ a: { ok: false, reason }, b: { ok: true } });
    const saves = [];
    const r = await runChain({ chain: ['a', 'b'], attempt: s.attempt, save: async (f, kind) => { saves.push(kind); } });
    assert.equal(r.ok, false, reason);
    assert.equal(r.process, true, reason);
    assert.equal(r.leftWork, false, reason);
    assert.equal(r.failures[0].kind, 'process', reason);
    assert.deepEqual(s.tried, ['a'], reason);
    assert.deepEqual(saves, ['process'], reason);
  }
  // It still says whether the failed run left work behind.
  const s = script({ a: { ok: false, reason: 'exit 1' }, b: { ok: true } });
  assert.equal((await runChain({ chain: ['a', 'b'], attempt: s.attempt, leftWork: async () => true })).leftWork, true);
});

const models = {
  'mimo-flash': { family: 'mimo' }, mimo: { family: 'mimo' }, glm: { family: 'glm' }, luna: { family: 'openai' },
};

test('the reviewer is never the implementer\'s family', () => {
  assert.deepEqual(excludeImplementers(['glm', 'luna', 'mimo'], models, ['mimo-flash']), ['glm', 'luna']);
  assert.deepEqual(excludeImplementers(['glm', 'luna'], models, ['claude']), ['glm', 'luna']);
  assert.deepEqual(excludeImplementers(['glm'], models, ['glm']), []);
});
