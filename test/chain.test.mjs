import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChain, excludeImplementers, checkReview } from '../template/tools/harness/lib/chain.mjs';

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
  'deepseek-flash': { family: 'deepseek' }, deepseek: { family: 'deepseek' }, glm: { family: 'glm' }, luna: { family: 'openai' },
};

test('the reviewer is never the implementer\'s family', () => {
  assert.deepEqual(excludeImplementers(['glm', 'luna', 'deepseek'], models, ['deepseek-flash']), ['glm', 'luna']);
  assert.deepEqual(excludeImplementers(['glm', 'luna'], models, ['claude']), ['glm', 'luna']);
  assert.deepEqual(excludeImplementers(['glm'], models, ['glm']), []);
});

const H = 'T07 review (glm)';

test('a complete review passes, from after any tool chatter', () => {
  const r = checkReview(`tool chatter\n${H}\napprove\n\nR1: fine\n\napprove\n`, H);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'approve');
  assert.ok(r.review.startsWith(H));
});

test('a review that does not end with its verdict is cut off (IC2 #370)', () => {
  assert.equal(checkReview(`${H}\nrework\n\nR1: the loop in`, H).reason, 'review cut off');
});

test('no header, or no verdict on line 2, is not a review', () => {
  assert.equal(checkReview('approve', H).reason, 'no header line in its output');
  assert.equal(checkReview(`${H}\nlooks good\napprove`, H).reason, 'no verdict on line 2');
});

test('a flattened review is accepted and its paragraphs restored', () => {
  const r = checkReview(`${H} approve after named fixes  R1: rename x.  R2: add a test.  approve after named fixes`, H);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'approve after named fixes');
  assert.match(r.review, /R1: rename x\.\n\nR2: add a test\./);
});

test('a flattened review with one verdict only is cut off', () => {
  assert.equal(checkReview(`${H} approve R1: fine`, H).reason, 'review cut off');
});

test('a closing keyword before #<n> is refused', () => {
  assert.throws(() => checkReview(`${H}\napprove\nthis fixes #12\napprove`, H), /closing keyword/);
});
