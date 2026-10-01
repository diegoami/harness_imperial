// The review reader's self-test: sample outputs, each with what review.mjs does with it.
// A review is never thrown away; only output with no review at all is a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReview, rewriteClosingKeywords } from '../template/tools/harness/lib/chain.mjs';

const H = 'T07 review (glm-flash)';
const NORMAL = `${H}\nrework\n\nR1: the loop in a.js skips the last item.\n\nrework`;

// [name, output, expected kind, expected verdict or note]
const samples = [
  ['a plain review after tool chatter', `reading a.js\n${NORMAL}\n`, 'ok', 'rework'],
  ['a bold header, a bold "Verdict:" with punctuation, a bold closing verdict', `**${H}**\n**Verdict:** Rework.\n\nR1: the loop in a.js skips the last item.\n\n**rework**`, 'ok', 'rework'],
  ['a heading header in another case, in backticks', `## \`${H.toUpperCase()}\`\nrework\n\nR1: the loop in a.js skips the last item.\n\nrework`, 'ok', 'rework'],
  ['blank lines before the verdict', `${H}\n\n\nrework\n\nR1: the loop in a.js skips the last item.\n\nrework`, 'ok', 'rework'],
  ['a preamble, and a sign-off after the closing verdict', `I have checked everything.\n\n${NORMAL}\n\n— GLM-5.3 Flash\n`, 'ok', 'rework'],
  ['a quoted header and an underlined verdict', `> ${H}\n__Approve after named fixes__:\n\nR1: rename x.\n\napprove after named fixes!`, 'ok', 'approve after named fixes'],
  ["the brief's header echoed before the review: the last header wins", `${H}\nReview PR #7.\n\n${NORMAL}`, 'ok', 'rework'],
  ['a review flattened onto one line', `${H} rework  R1: the loop in a.js skips the last item.  rework`, 'ok', 'rework'],
  ['a closing keyword', `${H}\napprove\n\nR1: this fixes #551.\n\napprove`, 'ok', 'approve'],
  ['no closing verdict', `${H}\nrework\n\nR1: the loop in`, 'flagged', 'may be cut off'],
  ['a verdict that is not one of the four', `${H}\nlooks good to me\n\nR1: fine\n\napprove`, 'flagged', 'verdict unreadable'],
  ['two different verdicts', `${H}\napprove\n\nR1: fine\n\nrework`, 'flagged', 'verdict unreadable'],
  ['a flattened review with one verdict', `${H} approve R1: fine`, 'flagged', 'may be cut off'],
  ['tool chatter only', 'reading a.js\nrunning npm test\n', 'none', null],
  ['nothing', '', 'none', null],
];

for (const [name, out, kind, detail] of samples) {
  test(`${kind}: ${name}`, () => {
    const r = readReview(out, H);
    assert.equal(r.kind, kind, JSON.stringify(r));
    if (kind === 'ok') {
      assert.equal(r.verdict, detail);
      const lines = r.review.split('\n');
      assert.equal(lines[0], H);
      assert.equal(lines[1], detail);
      assert.equal(lines.at(-1), detail);
      assert.doesNotMatch(r.review, /\*\*|signed|GLM-5\.3 Flash$/);
    }
    if (kind === 'flagged') {
      assert.equal(r.note, detail);
      assert.ok(r.review.startsWith(`${H}\n`));
    }
    if (kind === 'none') assert.equal(r.reason, 'no review in its output');
  });
}

test('a readable review keeps its findings, paragraphs restored when flattened', () => {
  assert.match(readReview(`${H} rework  R1: a.  R2: b.  rework`, H).review, /R1: a\.\n\nR2: b\./);
  assert.match(readReview(NORMAL, H).review, /R1: the loop in a\.js skips the last item\./);
});

test('closing keywords are rewritten, in every outcome, and listed', () => {
  const ok = readReview(`${H}\napprove\n\nR1: this fixes #551, Closes #3.\n\napprove`, H);
  assert.match(ok.review, /this fixes 551, Closes 3\./);
  assert.deepEqual(ok.rewrites, ['fixes #551 -> fixes 551', 'Closes #3 -> Closes 3']);
  assert.match(readReview(`${H}\nrework\nresolved #9 in`, H).review, /resolved 9 in/);
  assert.deepEqual(rewriteClosingKeywords('see #4, PR #5').rewrites, []);
});
