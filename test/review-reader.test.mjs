// The review reader: the self-test's samples (lib/review-selftest.mjs), each its own test here, and
// the `--self-test` switch of review.mjs. A review is never thrown away; only output with no review
// at all is a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReview, rewriteClosingKeywords, doneWhenCount, accountDoneWhen, briefTargets } from '../template/tools/harness/lib/chain.mjs';
import { SAMPLES, H } from '../template/tools/harness/lib/review-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const s of SAMPLES) {
  test(`${s.kind}: ${s.name}`, () => {
    const r = readReview(s.out, s.header ?? H);
    assert.equal(r.kind, s.kind, JSON.stringify(r));
    if (s.kind === 'ok') assert.equal(r.review, s.review);
    if (s.kind === 'flagged') {
      assert.equal(r.note, s.note);
      assert.equal(r.review, s.out.trim());                           // posted whole, as it arrived
    }
    if (s.kind === 'none') assert.equal(r.reason, 'no review in its output');
  });
}

test('a brief headed `#<issue> review (model)` is read; the leading # is a GitHub issue number, not Markdown (#108, PR 107 round 1)', () => {
  // PR 107 round 1: the brief's first line was `#105 review (luna)`. readReview must find that
  // header in the model's output; the issue number is the part that decides which PR the review
  // is for, so it must not be stripped.
  const out = `#105 review (luna)\nrework\n\nR1: a.js:1 is wrong (blocking).\n\nrework`;
  const r = readReview(out, '#105 review (luna)');
  assert.equal(r.kind, 'ok', JSON.stringify(r));
  assert.equal(r.review, `#105 review (luna)\nrework\n\nR1: a.js:1 is wrong (blocking).\n\nrework`);
  assert.equal(r.verdict, 'rework');
  // The previous bug: with `/#*\\s*/`, undecorate stripped the leading `#` from `#105`, the line
  // was `105 review (luna)`, and the regex (built from the brief) wanted `#105 review (luna)` —
  // no match, kind 'none'. The test below is the regression check: a heading-shaped header is
  // still read as one (existing samples cover that).
  const h = readReview('## T07 review (luna)\nrework\n\nR1: x.\n\nrework', '#105 review (luna)');
  assert.equal(h.kind, 'none');     // different header, different brief: no match
});

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

test('the Done-when lines are counted from the task file in the brief, or a heading (L32)', () => {
  const task = '- **Owns**: `src/`\n- **Done when**:\n  1. `a` prints 1.\n  2. `b`\n     goes on.\n  3. `npm test` is green.\n- **Hazards**: x\n4. not a Done-when line';
  assert.equal(doneWhenCount(`T07 review (luna)\nReview PR #7.\n\n${task}`), 3);
  assert.equal(doneWhenCount('## Done when\n\n1. a\n2. b\n\n## Also affected\n1. c'), 2);
  assert.equal(doneWhenCount('Review PR #7.'), 0);
  // A mention of the field in prose is not the field (found reviewing PR 22's own body).
  assert.equal(doneWhenCount('- **Counts** from a `**Done when**` field.\n- **Other**: x\n\n**Done when**\n1. a\n2. b\n3. c\n\n**Overlap**'), 3);
  assert.equal(doneWhenCount('**Done when:** the table is posted.'), 0);
  // An indented bold sub-bullet under a Done-when line does not end the list (PR 27's own body).
  assert.equal(doneWhenCount('**Done when**\n1. `npm test` passes, including:\n   - **against the real OpenCode:** x\n2. the self-test passes.\n\n🤖 Generated'), 2);
});

test('a review accounts for each Done-when line, or says which it did not (L32)', () => {
  const none = { missing: [], repeated: [], notRun: [], malformed: [] };
  assert.deepEqual(accountDoneWhen('DW1: ran a → ok\n- **DW2:** not run — no key\nDW4: ran d -> 3 pass', 4), { ...none, missing: [3], notRun: [2] });
  assert.deepEqual(accountDoneWhen('DW1: ran `a` → ok\nDW2. ran b -> ok', 2), none);
  assert.deepEqual(accountDoneWhen('R1: fine', 0), none);
  // Luna's R1 on PR 22: any other text, or the same number twice, does not account for a line.
  assert.deepEqual(accountDoneWhen('DW1: nonsense\nDW2: ran it\nDW3: not run', 3), { ...none, malformed: [1, 2, 3] });
  assert.deepEqual(accountDoneWhen('DW1: not run — no key\nDW1: ran a → ok', 1), { ...none, repeated: [1] });
});

test('the commits a brief names as the one to review: after "at", "HEAD is" or "HEAD:" (#23)', () => {
  const h = (c) => c.repeat(40);
  assert.deepEqual(briefTargets(`You review PR #4 at ${h('a')}.\n0. HEAD is \`${h('B')}\`\nHEAD: ${h('c')}`), [h('a'), h('b'), h('c')]);
  assert.deepEqual(briefTargets(`Merged as ${h('d')}; see ${h('e')}. At 7 lines, abc1234 is short.`), []);
  // Only the reviewer's block: the pasted task file, from its first heading on, may cite "at <sha>" (#32).
  assert.deepEqual(briefTargets(`You review PR #4 at ${h('a')}.\n# T03 Port\nmalpaco-godot-poc at \`${h('f')}\`, the merge of PR #9.\n## Done when\nHEAD is ${h('9')}`), [h('a')]);
  // Another heading inside the reviewer's block does not end it (Luna's R1 on PR 34).
  assert.deepEqual(briefTargets(`T03 review (luna)\n## Notes\nYou review PR #4 at ${h('a')}.\n# T03 Port\nsee ${h('f')}`), [h('a')]);
});
