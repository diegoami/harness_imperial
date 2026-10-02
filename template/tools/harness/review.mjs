#!/usr/bin/env node
// Hands one pull request to OpenCode for a review, and posts the result as one PR comment.
//
//   node tools/harness/review.mjs --pr 42 --brief brief.md [--reviewer NAME] [--exclude NAME,...]
//     [--issue 12 --apply-label] [--done-when K] [--dry-run] [--env KEY=VALUE]...
//   node tools/harness/review.mjs --self-test   (the reader's samples; no model is called)
//
// The brief's first line is the review header the model prints, e.g. "T07 review (Luna)"; with the
// chain, the text in its final parentheses becomes each attempt's model. The model never writes to
// GitHub (the agent file denies it); this script is the only writer.
//
// The model is harness.json's reviewer.chain (one model, by the user's decision of 2026-10-02:
// GPT-6 Luna on the direct OpenAI route, openai/gpt-6-luna, then Claude Opus). It is never the implementer's model family: --exclude
// (implement.mjs prints the name on its "implemented by:" line, or "claude"), else a model:<name>
// label on the PR or --issue. Runs use the scripts' own OpenCode data directory.
//
// A review is never thrown away (lib/chain.mjs readReview). Only output with no review at all
// falls back. A readable review is posted normalised and acted on. One that may be cut off, has no
// readable verdict, opens and closes with different verdicts, or has a finding after its closing
// verdict is posted whole, exactly as it arrived, under a note, with no label. Closing keywords lose their '#', and the rewrite is logged.
//
// The review accounts for each Done-when line of the task file pasted in the brief (or --done-when
// K): one "DW<k>:" line each, after the verdict (L32). An approve with a line missing, or one not
// run, is posted under a note and not labelled approved (exit 4).
//
// A brief naming a commit other than the PR's head as the one to review is refused, exit 2, before
// anything runs (#23).
//
// Exit 0: posted, and labelled with --apply-label. Exit 1: refused or a defect. Exit 3: OpenCode
// unavailable or no review, nothing posted; the caller runs the Claude reviewer (harness.json's
// claudeFallback), unless Claude implemented the PR: then no reviewer of another family is left,
// and the caller escalates. Exit 4: posted under a note, no label; the caller reads it on the PR and decides,
// and never pays for a second review because of it. --dry-run prints
// what would be posted and the exit code it would use, and exits 0; it still runs, and bills, the
// model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runOpenCodeWatched, resolveOpenCode, OpenCodeInfraError } from './lib/opencode.mjs';
import { runChain, excludeImplementers, readReview, doneWhenCount, accountDoneWhen, briefTargets } from './lib/chain.mjs';
import { selfTest, SAMPLES } from './lib/review-selftest.mjs';
import {
  sh, requireTools, repoPaths, loadConfig, parseArgs, envWith, ensureAgent, ocArgs, prepareOpenCode,
} from './lib/common.mjs';

const say = (s) => console.log(s);
const die = (code, s) => { console.error(s); process.exit(code); };

const a = parseArgs(process.argv.slice(2), { flags: ['apply-label', 'dry-run', 'self-test'], repeatable: ['env'] });
if (a['self-test']) {
  const failures = selfTest();
  for (const f of failures) console.error(`FAIL ${f}`);
  say(`self-test: ${SAMPLES.length - failures.length} of ${SAMPLES.length} samples read as expected`);
  process.exit(failures.length ? 1 : 0);
}
if (!a.pr || !a.brief) die(2, '--pr and --brief are required.');
if (a['apply-label'] && !a.issue) die(2, '--apply-label needs --issue.');
const brief = fs.readFileSync(a.brief, 'utf8').split(/\r?\n/);
const briefHeader = brief[0].trim();
const doneWhen = a['done-when'] !== undefined ? Number(a['done-when']) : doneWhenCount(brief.join('\n'));
if (!Number.isInteger(doneWhen) || doneWhen < 0) die(2, `--done-when takes a count; got ${a['done-when']}`);
if (!/review \(/.test(briefHeader)) die(2, `The brief's first line must be the review header, e.g. "T07 review (Luna)"; got: ${briefHeader}`);

let opencode;
try { opencode = resolveOpenCode(); } catch (e) {
  if (e instanceof OpenCodeInfraError) die(3, `OpenCode unavailable: ${e.message} Nothing posted; use a Claude reviewer (see harness.json).`);
  throw e;
}
requireTools('git', 'gh');

const top0 = sh('git', ['rev-parse', '--show-toplevel']);
const config = loadConfig(top0);
const { top, commonDir, workRoot } = repoPaths(config);
const rev = config.reviewer;

// The implementer's family never reviews.
const labelsOf = (kind, n) => sh('gh', [kind, 'view', String(n), '--json', 'labels', '--jq', '.labels[].name'], { cwd: top, allowFail: true }).split('\n');
const implementedBy = a.exclude ? a.exclude.split(',').map((s) => s.trim()).filter(Boolean)
  : [...labelsOf('pr', a.pr), ...(a.issue ? labelsOf('issue', a.issue) : [])]
    .filter((l) => l.startsWith('model:')).map((l) => l.slice(6));
if (a.reviewer && !config.models[a.reviewer]) die(2, `Unknown reviewer ${a.reviewer}.`);
const wanted = a.reviewer ? [a.reviewer] : rev.chain;
const chain = excludeImplementers(wanted, config.models, implementedBy);
if (implementedBy.length) say(`implemented by: ${implementedBy.join(', ')}`);
if (a.reviewer && !chain.length) die(1, `Refused: ${a.reviewer} is the implementer's model family. Nothing posted.`);
const fallback = `Nothing posted; use a Claude reviewer (${rev.claudeFallback ?? 'opus'}).`;
if (!chain.length) die(3, `OpenCode unavailable: no reviewer left after excluding ${implementedBy.join(', ')}. ${fallback}`);
const pre = await prepareOpenCode({ opencode, chain, models: config.models, env: envWith(a.env), cwd: top, log: say });
for (const p of pre.problems) say(p);
if (!pre.usable.length) die(3, `OpenCode unavailable: ${pre.problems.join('; ')}. ${fallback}`);

const headSha = sh('gh', ['pr', 'view', String(a.pr), '--json', 'headRefOid', '--jq', '.headRefOid'], { cwd: top });
// A brief that names another commit as the one to review would make the reviewer's tree proof stop
// it after a billed run (#23): refuse it before any worktree or model run.
const stale = [...new Set(briefTargets(brief.join('\n')))].filter((c) => c !== headSha.toLowerCase());
if (stale.length) {
  die(2, `The brief names ${stale.join(', ')} as the commit to review, but PR ${a.pr}'s head is ${headSha}. `
    + 'Nothing was run or posted. The brief was written before the latest push, or the head was read before '
    + 'GitHub updated: take it from the local branch (git rev-parse <branch>), or rerun once GitHub shows it.');
}
sh('git', ['-C', top, 'fetch', '-q', 'origin', `pull/${a.pr}/head`]);
// A path of this invocation's own, recreated for each attempt; only this tree is ever removed.
const worktree = path.join(workRoot, `${a.pr}-review-${randomBytes(4).toString('hex')}`);
let created = false;
const removeTree = () => {
  if (!created) return;
  sh('git', ['-C', top, 'worktree', 'remove', '--force', worktree], { allowFail: true });
  fs.rmSync(worktree, { recursive: true, force: true });
  sh('git', ['-C', top, 'worktree', 'prune'], { allowFail: true });
  created = false;
};
const newTree = () => {
  removeTree();
  fs.mkdirSync(workRoot, { recursive: true });
  sh('git', ['-C', top, 'worktree', 'add', '--detach', worktree, headSha]);
  created = true;
  ensureAgent({ top, commonDir, worktree, agent: rev.agent });
  say(`worktree: ${worktree} at ${headSha}`);
};

let result;
try {
  result = await runChain({
    chain: pre.usable,
    log: say,
    reset: async () => {},
    attempt: async (m) => {
      const model = config.models[m];
      const header = a.reviewer ? briefHeader : briefHeader.replace(/\([^()]*\)\s*$/, `(${m})`);
      const prompt = `${header}\n${brief.slice(1).join('\n')}

---
OUTPUT RULES (from tools/harness/review.mjs; they override anything above that conflicts):
- Do not post to GitHub, edit, commit, push, label or merge anything. The script posts your review.
- Your final message is the review and nothing else. Line 1 is exactly: ${header}
  Line 2 is the verdict, alone on its line: approve, approve after named fixes, rework, or user
  decision. Then any where-I-worked lines (worktree, HEAD, diff, the commands you ran), then the
  findings (R1, R2, ... with file and line, blocking or not), then the verdict again as the very
  last line. Nothing comes after it.${doneWhen ? `
- The task has ${doneWhen} Done-when line${doneWhen > 1 ? 's' : ''}. Right after the verdict line, account for each, one
  line per Done-when line, DW1 to DW${doneWhen}: "DW<k>: ran <command> → <result>", or
  "DW<k>: not run — <reason>". An approve with one missing, or one not run, is not applied.` : ''} A review that does not end with its verdict, or that has a
  finding after it, is posted flagged and acted on by no one until the main session reads it.
- Your worktree is ${worktree} at ${headSha}, and it is already your working directory. Run git
  there without -C, and never type that path: a mistyped path ends the run.
`;
      newTree();
      let run;
      try {
        run = await runOpenCodeWatched({
          args: ocArgs(worktree, rev.agent, model), prompt, workDir: worktree, title: `pr${a.pr}-${m}`,
          startupTimeoutMs: rev.startupTimeoutSec * 1000, idleTimeoutMs: rev.idleTimeoutSec * 1000,
          totalTimeoutMs: rev.totalTimeoutSec * 1000, opencode, env: pre.env, log: say,
        });
      } catch (e) {
        if (!(e instanceof OpenCodeInfraError)) throw e;
        return { ok: false, reason: e.reason, detail: e.message };
      }
      if (run.exitCode !== 0) return { ok: false, reason: `exit ${run.exitCode}`, detail: run.output };
      if (run.agentFallback) return { ok: false, reason: 'fell back to the default agent', detail: run.output };
      if (run.permissionRejected) {
        return { ok: false, reason: `permission rejected: ${run.permissionRejected}${run.permissionHint ? `; ${run.permissionHint}` : ''}`, detail: run.output };
      }
      const read = readReview(run.stdout, header);
      if (read.kind === 'none') return { ok: false, reason: read.reason, detail: run.output };
      return { ok: true, value: { ...read, header, model } };
    },
  });
} finally {
  removeTree();
}

const reasons = result.failures.map((f) => `${f.name} failed: ${f.reason}`).join('; ');
if (!result.ok) die(3, `OpenCode unavailable: ${result.sameCause ? `same failure twice: ${result.sameCause} (${reasons})` : reasons}. ${fallback}`);

const { kind, review, verdict, note, rewrites, header, model } = result.value;
for (const r of rewrites) say(`rewrote a closing keyword: ${r}`);
const lines = review.split('\n');
if (reasons && kind === 'ok') lines[0] = header.replace(/\)\s*$/, `; ${reasons})`);
// An approve that does not account for every Done-when line is not an approval (L32).
const dw = kind === 'ok' && doneWhen ? accountDoneWhen(review, doneWhen)
  : { missing: [], notRun: [], malformed: [], repeated: [] };
const unaccounted = verdict === 'approve'
  ? [dw.missing.length && `no DW line for Done-when ${dw.missing.join(', ')}`,
    dw.repeated.length && `more than one DW line for Done-when ${dw.repeated.join(', ')}`,
    dw.malformed.length && `the DW line for Done-when ${dw.malformed.join(', ')} is neither "ran <command> → <result>" nor "not run — <reason>"`,
    dw.notRun.length && `Done-when ${dw.notRun.join(', ')} not run`].filter(Boolean).join('; ') || null
  : null;
const flagNote = kind === 'flagged'
  ? `> Note from tools/harness/review.mjs: ${note}; no label applied${reasons ? ` (${reasons})` : ''}. `
    + 'The main session reads this review and decides.\n\n' : '';
const dwNote = unaccounted
  ? `> Note from tools/harness/review.mjs: approve not applied: ${unaccounted} (L32). The main session decides: `
    + 'a supplementary review of those lines, or a rework.\n\n' : '';
const body = `${flagNote}${dwNote}${lines.join('\n')}\n\n— ${result.name}, via tools/harness/review.mjs (${model.id})`;
const label = kind === 'flagged' || unaccounted ? null
  : verdict === 'approve' ? 'status:approved' : verdict === 'user decision' ? null : 'status:rework';
const code = kind === 'flagged' || unaccounted ? 4 : 0;
if (a['dry-run']) {
  say(body);
  say(`dry run: would post the above${a['apply-label'] && label ? `, label ${label}` : ', no label'}, and exit ${code}.`);
  process.exit(0);
}

const bodyFile = path.join(os.tmpdir(), `harness-review-${a.pr}-${randomBytes(3).toString('hex')}.md`);
fs.writeFileSync(bodyFile, body);
sh('gh', ['pr', 'comment', String(a.pr), '--body-file', bodyFile], { cwd: top });
fs.rmSync(bodyFile, { force: true });
if (unaccounted) die(4, `posted: ${lines[0]} / approve, not applied: ${unaccounted}. Decide on PR ${a.pr}: a supplementary review of those lines, or a rework.`);
if (kind === 'flagged') die(4, `posted: ${lines[0]}, flagged (${note}); no label. Read the review on PR ${a.pr} and decide.`);
say(`posted: ${lines[0]} / ${verdict}`);
if (a['apply-label']) {
  if (label) sh('gh', ['issue', 'edit', String(a.issue), '--add-label', label, '--remove-label', 'status:in-review'], { cwd: top });
  else say('verdict "user decision" applies no label; the main session decides.');
}
