#!/usr/bin/env node
// Posts a review that a Claude reviewer agent (.claude/agents/reviewer.md) returned, through the same
// reader and writer as review.mjs, so only one component writes reviews to GitHub (#3).
//
//   node tools/harness/post-review.mjs --pr 42 --brief brief.md --review review.md --by "claude (opus)"
//     [--issue 12 --apply-label] [--done-when K] [--dry-run]
//
// The brief is the one the reviewer was given: its first line is the review header, and the task
// file in it gives the Done-when count (or --done-when K). The review file is the agent's final
// message, as it returned it. It is read like an OpenCode review (lib/chain.mjs readReview):
//   - readable: posted normalised, labelled by its verdict; an approve that does not account for
//     every Done-when line is posted under a note, unlabelled (L32);
//   - flagged (may be cut off, verdict unreadable, verdicts differ, a finding after the closing
//     verdict): posted whole under a note, unlabelled (L28);
//   - no review at all: nothing posted.
// Closing keywords before #<n> lose their '#'.
//
// Exit 0: posted, and labelled with --apply-label. Exit 1: no review in the file, nothing posted;
// the main session decides (re-run the reviewer, or escalate). Exit 2: usage. Exit 4: posted under
// a note, no label; the main session reads it and decides.

import fs from 'node:fs';
import { readReview, doneWhenCount } from './lib/chain.mjs';
import { planPost, publish } from './lib/post.mjs';
import { sh, requireTools, parseArgs } from './lib/common.mjs';

const say = (s) => console.log(s);
const die = (code, s) => { console.error(s); process.exit(code); };

const a = parseArgs(process.argv.slice(2), { flags: ['apply-label', 'dry-run'] });
if (!a.pr || !a.brief || !a.review || !a.by) die(2, '--pr, --brief, --review and --by are required.');
if (a['apply-label'] && !a.issue) die(2, '--apply-label needs --issue.');
for (const f of [a.brief, a.review]) if (!fs.existsSync(f)) die(2, `Not found: ${f}`);
const brief = fs.readFileSync(a.brief, 'utf8');
const header = brief.split(/\r?\n/)[0].trim();
if (!/review \(/.test(header)) die(2, `The brief's first line must be the review header, e.g. "T07 review (opus)"; got: ${header}`);
const doneWhen = a['done-when'] !== undefined ? Number(a['done-when']) : doneWhenCount(brief);
if (!Number.isInteger(doneWhen) || doneWhen < 0) die(2, `--done-when takes a count; got ${a['done-when']}`);
requireTools('git', 'gh');
const top = sh('git', ['rev-parse', '--show-toplevel']);

const read = readReview(fs.readFileSync(a.review, 'utf8'), header);
if (read.kind === 'none') die(1, `No review in ${a.review} (no "${header}" line). Nothing posted: re-run the reviewer, or escalate.`);
const plan = planPost({
  read, header, doneWhen, source: 'tools/harness/post-review.mjs',
  signature: `${a.by}, via tools/harness/post-review.mjs`,
});
publish({ plan, pr: a.pr, issue: a.issue, applyLabel: a['apply-label'], dryRun: a['dry-run'], top, say, die });
