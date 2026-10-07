// Posting a review, for review.mjs (an OpenCode reviewer) and post-review.mjs (a Claude reviewer):
// one writer of reviews to GitHub, whichever model reviewed (#3).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { accountDoneWhen } from './chain.mjs';
import { sh } from './common.mjs';

/**
 * What to post for a review that readReview (lib/chain.mjs) read as 'ok' or 'flagged': the body,
 * the label and the exit code. Pure, so it can be tested directly.
 * - A flagged review is posted whole under a note, unlabelled: exit 4 (L28).
 * - An approve that does not account for every Done-when line is posted under a note, unlabelled:
 *   exit 4 (L32).
 * - Otherwise the verdict's label: approve -> status:approved; rework or approve after named fixes
 *   -> status:rework; user decision -> none. Exit 0.
 * `reasons` (earlier models' failures) go into the header of a readable review, or into a flagged
 * review's note, never over its first line.
 */
export function planPost({ read, header, reasons = '', doneWhen = 0, source, signature }) {
  const { kind, review, verdict, note, rewrites = [] } = read;
  const lines = review.split('\n');
  if (reasons && kind === 'ok') lines[0] = header.replace(/\)\s*$/, `; ${reasons})`);
  const dw = kind === 'ok' && doneWhen ? accountDoneWhen(review, doneWhen)
    : { missing: [], notRun: [], malformed: [], repeated: [] };
  const unaccounted = kind === 'ok' && verdict === 'approve'
    ? [dw.missing.length && `no DW line for Done-when ${dw.missing.join(', ')}`,
      dw.repeated.length && `more than one DW line for Done-when ${dw.repeated.join(', ')}`,
      dw.malformed.length && `the DW line for Done-when ${dw.malformed.join(', ')} is neither "ran <command> → <result>" nor "not run — <reason>"`,
      dw.notRun.length && `Done-when ${dw.notRun.join(', ')} not run`].filter(Boolean).join('; ') || null
    : null;
  const flagNote = kind === 'flagged'
    ? `> Note from ${source}: ${note}; no label applied${reasons ? ` (${reasons})` : ''}. `
      + 'The main session reads this review and decides.\n\n' : '';
  const dwNote = unaccounted
    ? `> Note from ${source}: approve not applied: ${unaccounted} (L32). The main session decides: `
      + 'a supplementary review of those lines, or a rework.\n\n' : '';
  const label = kind === 'flagged' || unaccounted ? null
    : verdict === 'approve' ? 'status:approved' : verdict === 'user decision' ? null : 'status:rework';
  return {
    kind, verdict, note, rewrites, unaccounted, label, first: lines[0],
    body: `${flagNote}${dwNote}${lines.join('\n')}\n\n— ${signature}`,
    code: kind === 'flagged' || unaccounted ? 4 : 0,
  };
}

// Two reviews of one PR (a second opinion, #39): the stricter decides. Either one posted but not
// acted on (a flagged review, an unaccounted approve) holds both: exit 4, no label. A "user decision"
// applies no label; either rework applies rework; approved needs both.
export function combinePlans(plans) {
  const held = plans.filter((p) => p.code === 4);
  if (held.length) return { label: null, code: 4, why: held.map((p) => `${p.first}: ${p.unaccounted ?? p.note}`).join('; ') };
  if (plans.some((p) => p.verdict === 'user decision')) return { label: null, code: 0, why: 'a "user decision" verdict; the main session decides' };
  if (plans.some((p) => p.label === 'status:rework')) return { label: 'status:rework', code: 0, why: null };
  return { label: 'status:approved', code: 0, why: null };
}

export function postComment({ plan, pr, top }) {
  const bodyFile = path.join(os.tmpdir(), `harness-review-${pr}-${randomBytes(3).toString('hex')}.md`);
  fs.writeFileSync(bodyFile, plan.body);
  try { sh('gh', ['pr', 'comment', String(pr), '--body-file', bodyFile], { cwd: top }); } finally { fs.rmSync(bodyFile, { force: true }); }
}

// A verdict's label replaces the other verdict's and status:in-review, so an issue never carries
// both approved and rework (Sol's R3 on PR 41).
export function applyLabel({ label, issue, top, say }) {
  if (!label) { say('verdict "user decision" applies no label; the main session decides.'); return; }
  const stale = ['status:in-review', ...['status:approved', 'status:rework'].filter((l) => l !== label)].join(',');
  try {
    sh('gh', ['issue', 'edit', String(issue), '--add-label', label, '--remove-label', stale], { cwd: top });
  } catch (err) {
    say(`label error: ${err.message}; the review is posted as ${label}, but no label was applied. ` +
      'Read the verdict and apply it manually if needed.');
  }
}

export function withdrawApproval({ issue, top, say }) {
  try {
    sh('gh', ['issue', 'edit', String(issue), '--remove-label', 'status:approved']);
  } catch (err) {
    // A repository without status:approved is the same case as applyLabel's label failure: the
    // earlier approval, if any, is not removed, and the next applyLabel can still overwrite
    // it. The warning names the failed label so the caller can read the verdict and decide
    // (#108, Luna's R1 on PR 121).
    if (say) say(`label error: ${err.message}; status:approved was not removed, and the next applyLabel can still overwrite it.`);
  }
}

// Posts a planned review as one PR comment and applies its label; or, with dryRun, prints both.
// Exits through `die` with 4 when the review was posted but not acted on.
export function publish({ plan, pr, issue, applyLabel: apply, dryRun, top, say, die }) {
  for (const r of plan.rewrites) say(`rewrote a closing keyword: ${r}`);
  if (dryRun) {
    say(plan.body);
    say(`dry run: would post the above${apply && plan.label ? `, label ${plan.label}` : ', no label'}, and exit ${plan.code}.`);
    process.exit(0);
  }
  postComment({ plan, pr, top });
  if (plan.unaccounted) die(4, `posted: ${plan.first} / approve, not applied: ${plan.unaccounted}. Decide on PR ${pr}: a supplementary review of those lines, or a rework.`);
  if (plan.kind === 'flagged') die(4, `posted: ${plan.first}, flagged (${plan.note}); no label. Read the review on PR ${pr} and decide.`);
  say(`posted: ${plan.first} / ${plan.verdict}`);
  if (apply) applyLabel({ label: plan.label, issue, top, say });
}
