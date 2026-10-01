// The review reader's self-test: `node tools/harness/review.mjs --self-test`, and npm test in the
// harness repository. No model is called. Each sample asserts what review.mjs does with it (post
// and act, post flagged with no label, or fail) and the text it keeps.

import { readReview } from './chain.mjs';

export const H = 'T07 review (luna)';
const FINDINGS = 'R1: a.js:10 skips the last item (blocking).\nR2: b.js:4 has no test (not blocking).';

// kind 'ok': the posted review is `review` exactly. kind 'flagged': it is the whole input, trimmed,
// with closing keywords rewritten. kind 'none': nothing is posted.
export const SAMPLES = [
  {
    name: 'a bold header after tool chatter',
    out: `reading a.js\nrunning npm test\n**${H}**\nrework\n\n${FINDINGS}\n\nrework\n`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'a heading header with a colon, in another case',
    out: `## ${H.toUpperCase()}:\nrework\n\n${FINDINGS}\n\nrework`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'a header in backticks with a full stop, after a preamble',
    out: `I checked the whole diff.\n\n\`${H}\`.\napprove\n\nR1: fine.\n\napprove`,
    kind: 'ok', review: `${H}\napprove\n\nR1: fine.\n\napprove`,
  },
  {
    name: 'blank lines before the verdict',
    out: `${H}\n\n\nrework\n\n${FINDINGS}\n\nrework`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'bold verdicts',
    out: `${H}\n**rework**\n\n${FINDINGS}\n\n**rework**`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'a "Verdict:" prefix, with the longest verdict matched first',
    out: `${H}\n**Verdict:** Approve after named fixes\n\nR1: rename x.\n\nVerdict: approve after named fixes`,
    kind: 'ok', review: `${H}\napprove after named fixes\n\nR1: rename x.\n\napprove after named fixes`,
  },
  {
    name: 'punctuated verdicts',
    out: `${H}\nRework.\n\n${FINDINGS}\n\nRework!`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'a four-line where-I-worked block before the verdict, kept',
    out: `${H}\nWorktree: /w/T07\nHEAD: abc1234\nDiff: a.js, b.js\nTests: npm test, 12 pass\nrework\n\n${FINDINGS}\n\nrework`,
    kind: 'ok',
    review: `${H}\nrework\n\nWorktree: /w/T07\nHEAD: abc1234\nDiff: a.js, b.js\nTests: npm test, 12 pass\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'a sign-off after the closing verdict: kept, the verdict not duplicated',
    out: `${H}\nrework\n\n${FINDINGS}\n\nrework\n\n— GPT-6 Luna, reviewing for T07`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\n— GPT-6 Luna, reviewing for T07\n\nrework`,
  },
  {
    name: 'closing keywords, rewritten',
    out: `${H}\napprove\n\nR1: fixes #551, Fixes: #12, fixes#13, CLOSES owner/repo#3.\n\napprove`,
    kind: 'ok', review: `${H}\napprove\n\nR1: fixes 551, Fixes: 12, fixes 13, CLOSES owner/repo 3.\n\napprove`,
  },
  {
    name: 'a review flattened onto one line',
    out: `${H} rework  R1: a.js:10 skips the last item.  R2: b.js:4 has no test.  rework`,
    kind: 'ok', review: `${H}\nrework\n\nR1: a.js:10 skips the last item.\n\nR2: b.js:4 has no test.\n\nrework`,
  },
  {
    name: 'the header in the middle of a line, the verdict on it',
    out: `Here is the ${H} — Rework\n\n${FINDINGS}\n\nrework`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'an echoed brief, then the review',
    out: `${H}\nReview PR #7.\n\n${H}\nrework\n\n${FINDINGS}\n\nrework`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'the header on its own line, then the review flattened onto one line',
    out: `${H}\nrework  R1: a.js:10 skips the last item.  rework`,
    kind: 'ok', review: `${H}\nrework\n\nR1: a.js:10 skips the last item.\n\nrework`,
  },
  {
    name: 'a flattened review with a sign-off',
    out: `${H} rework  R1: a.js:10 skips the last item.  rework\n— GPT-6 Luna`,
    kind: 'ok', review: `${H}\nrework\n\nR1: a.js:10 skips the last item.\n\n— GPT-6 Luna\n\nrework`,
  },
  {
    name: 'the closing verdict repeated: one verdict is kept',
    out: `${H}\nrework\n\n${FINDINGS}\n\nrework\n\nRework.`,
    kind: 'ok', review: `${H}\nrework\n\n${FINDINGS}\n\nrework`,
  },
  {
    name: 'a finding after the closing verdict',
    out: `${H}\nrework\n\nR1: a.\n\nrework\n- **R2.** b.js:4 has no test.`,
    kind: 'flagged', note: 'a finding after the closing verdict',
  },
  {
    name: 'a heading finding after the closing verdict',
    out: `${H}\napprove\n\nR1: fine.\n\napprove\n### R3 (blocking) c.js:1 crashes`,
    kind: 'flagged', note: 'a finding after the closing verdict',
  },
  {
    name: 'a "Finding R3" after the closing verdict',
    out: `${H}\napprove\n\nR1: fine.\n\napprove\n**Finding R3**: c.js:1 crashes`,
    kind: 'flagged', note: 'a finding after the closing verdict',
  },
  {
    name: 'a "1)" finding after the closing verdict',
    out: `${H}\napprove\n\nR1: fine.\n\napprove\n1) c.js:1 crashes`,
    kind: 'flagged', note: 'a finding after the closing verdict',
  },
  {
    name: 'a draft that approves, then the final review whose verdicts differ: never approved',
    out: `${H}\napprove\nLooks fine.\n\nWait, checking the tests.\n${H}\nrework\nR1 (blocking): the tests fail\napprove`,
    kind: 'flagged', note: 'verdicts differ: opens "rework", closes "approve"',
  },
  {
    name: 'a finding that quotes the header: posted whole, never read past it',
    out: `${H}\nrework\n\nR1: the line "${H}" is fine.\n\nrework`,
    kind: 'flagged', note: 'verdict unreadable',
  },
  {
    name: 'a sign-off with a date and a version is not a finding',
    out: `${H}\napprove\n\nR1: fine.\n\napprove\n2026-10-02, 1.0 release`,
    kind: 'ok', review: `${H}\napprove\n\nR1: fine.\n\n2026-10-02, 1.0 release\n\napprove`,
  },
  {
    name: 'a flattened review followed by a finding',
    out: `${H} approve  R1: fine.  approve\nR2: c.js:1 crashes`,
    kind: 'flagged', note: 'a finding after the closing verdict',
  },
  {
    name: 'a numbered finding after the closing verdict',
    out: `${H}\napprove\n\nR1: fine.\n\napprove\n2. one more thing`,
    kind: 'flagged', note: 'a finding after the closing verdict',
  },
  {
    name: 'no closing verdict, after a preamble that is kept',
    out: `Some notes first.\n${H}\nrework\n\nR1: the loop in`,
    kind: 'flagged', note: 'may be cut off',
  },
  {
    name: 'a where-I-worked block, then a review that is cut off',
    out: `${H}\nWorktree: /w/T07\nHEAD: abc1234\nrework\n\nR1: the loop in`,
    kind: 'flagged', note: 'may be cut off',
  },
  {
    name: 'an unreadable verdict',
    out: `${H}\nlooks good to me\n\nR1: fine\n\napprove`,
    kind: 'flagged', note: 'verdict unreadable',
  },
  {
    name: 'opening and closing verdicts that differ',
    out: `${H}\napprove\n\nR1: fine\n\nrework`,
    kind: 'flagged', note: 'verdicts differ: opens "approve", closes "rework"',
  },
  {
    name: 'a flattened review that is cut off',
    out: `${H} approve R1: fine and`,
    kind: 'flagged', note: 'may be cut off',
  },
  {
    name: 'a flattened review with an unreadable verdict',
    out: `${H} fine by me R1: ok. approve`,
    kind: 'flagged', note: 'verdict unreadable',
  },
  { name: 'tool chatter only', out: 'reading a.js\nrunning npm test\n', kind: 'none' },
  { name: 'nothing', out: '', kind: 'none' },
];

// Returns one line per failed sample (empty when all pass).
export function selfTest() {
  const failures = [];
  for (const s of SAMPLES) {
    const r = readReview(s.out, H);
    const fail = (why) => failures.push(`${s.name}: ${why}\n  got ${JSON.stringify(r)}`);
    if (r.kind !== s.kind) { fail(`kind ${r.kind}, expected ${s.kind}`); continue; }
    if (s.kind === 'ok' && r.review !== s.review) fail('the posted text differs');
    if (s.kind === 'flagged') {
      if (r.note !== s.note) fail(`note "${r.note}", expected "${s.note}"`);
      if (r.review !== s.out.trim()) fail('the flagged review is not the whole input');
    }
  }
  return failures;
}
