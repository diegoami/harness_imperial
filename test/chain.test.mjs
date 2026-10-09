import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChain, excludeImplementers } from '../template/tools/harness/lib/chain.mjs';

const script = (outcomes) => {
  const tried = [];
  return { tried, attempt: async (m) => { tried.push(m); return outcomes[m]; } };
};

test('the chain stops at the first success', async () => {
  const s = script({ a: { ok: false, reason: 'no session in 180 s' }, b: { ok: true, value: 'v' }, c: { ok: true } });
  const r = await runChain({ chain: ['a', 'b', 'c'], attempt: s.attempt });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'b');
  assert.deepEqual(s.tried, ['a', 'b']);
});

test('a failed attempt that left work behind stops the chain', async () => {
  const s = script({ a: { ok: false, reason: 'exit 1' }, b: { ok: true } });
  let resets = 0;
  const r = await runChain({ chain: ['a', 'b'], attempt: s.attempt, leftWork: async () => true, reset: async () => { resets++; } });
  assert.equal(r.ok, false);
  assert.equal(r.leftWork, true);
  assert.deepEqual(s.tried, ['a']);
  assert.equal(resets, 0);
});

test('two consecutive failures with the same cause stop the chain', async () => {
  const s = script({ a: { ok: false, reason: 'no session in 180 s' }, b: { ok: false, reason: 'no session in 90 s' }, c: { ok: true } });
  const r = await runChain({ chain: ['a', 'b', 'c'], attempt: s.attempt });
  assert.equal(r.ok, false);
  assert.equal(r.sameCause, 'no-session');
  assert.deepEqual(s.tried, ['a', 'b']);
});

test('different causes keep the chain going', async () => {
  const s = script({ a: { ok: false, reason: 'no session in 180 s' }, b: { ok: false, reason: 'session idle for 600 s' }, c: { ok: true, value: 1 } });
  const r = await runChain({ chain: ['a', 'b', 'c'], attempt: s.attempt });
  assert.equal(r.name, 'c');
});

const models = {
  'mimo-flash': { family: 'mimo' }, mimo: { family: 'mimo' }, glm: { family: 'glm' }, luna: { family: 'openai' },
};

test('the reviewer is never the implementer\'s family', () => {
  assert.deepEqual(excludeImplementers(['glm', 'luna', 'mimo'], models, ['mimo-flash']), ['glm', 'luna']);
  assert.deepEqual(excludeImplementers(['glm', 'luna'], models, ['claude']), ['glm', 'luna']);
  assert.deepEqual(excludeImplementers(['glm'], models, ['glm']), []);
});
