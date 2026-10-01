// The review reader: the self-test's samples (lib/review-selftest.mjs), each its own test here, and
// the `--self-test` switch of review.mjs. A review is never thrown away; only output with no review
// at all is a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReview, rewriteClosingKeywords } from '../template/tools/harness/lib/chain.mjs';
import { SAMPLES, H } from '../template/tools/harness/lib/review-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const s of SAMPLES) {
  test(`${s.kind}: ${s.name}`, () => {
    const r = readReview(s.out, H);
    assert.equal(r.kind, s.kind, JSON.stringify(r));
    if (s.kind === 'ok') assert.equal(r.review, s.review);
    if (s.kind === 'flagged') {
      assert.equal(r.note, s.note);
      assert.equal(r.review, s.out.trim());                           // posted whole, as it arrived
    }
    if (s.kind === 'none') assert.equal(r.reason, 'no review in its output');
  });
}

test('closing keywords lose their #, in a flagged review too, and every rewrite is listed', () => {
  const ok = readReview(`${H}\napprove\n\nR1: this fixes #551, Closes #3.\n\napprove`, H);
  assert.deepEqual(ok.rewrites, ['fixes #551 -> fixes 551', 'Closes #3 -> Closes 3']);
  assert.match(readReview(`${H}\nrework\nresolved #9 in`, H).review, /resolved 9 in/);
  assert.deepEqual(rewriteClosingKeywords('see #4, PR #5, issue#6').rewrites, []);
});

test('review.mjs --self-test runs every sample without a model, and passes', () => {
  const r = spawnSync(process.execPath, [path.join(here, '../template/tools/harness/review.mjs'), '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`self-test: ${SAMPLES.length} of ${SAMPLES.length} samples read as expected`));
});
