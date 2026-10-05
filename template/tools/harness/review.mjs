#!/usr/bin/env node
// Hands one pull request to OpenCode for a review, and posts the result as one PR comment.
//
//   node tools/harness/review.mjs --pr 42 --brief brief.md [--reviewer NAME] [--exclude NAME,...]
//     [--issue 12 --apply-label] [--done-when K] [--hard [--sol]] [--second-opinion] [--dry-run] [--env KEY=VALUE]...
//   node tools/harness/review.mjs --self-test   (the reader's samples; no model is called)
//
// The brief's first line is the review header the model prints, e.g. "T07 review (Luna)"; with the
// chain, the text in its final parentheses becomes each attempt's model. The model never writes to
// GitHub (the agent file denies it); this script is the only writer.
//
// The models are harness.json's reviewer.chain, then its claudeFallback (the full profile: GPT-5.6
// Luna on the direct OpenAI route, then Claude Opus; the review profile: GLM-5.3 Flash, Luna and
// DeepSeek V4.1 Flash, then the owner). It is never the implementer's model family: --exclude
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
// anything runs (#23). Only the lines before the pasted task file's title (`# T<nn>`) are read (#32).
//
// --hard (a hard task, L39) runs reviewer.hard instead of reviewer.chain: GLM-5.3 (Z.AI), then
// DeepSeek V4 Pro (Go) and Luna, so that one provider's quota cannot block a hard review. --sol adds
// reviewer.sol (GPT-6.1 Sol) before them, for a guard task and a hard task's last round only (L41).
// The review's header names each model that failed before it, so a light substitute is visible.
// --second-opinion (for a critical PR, #39): after the first review, reviewer.secondOpinion reviews the
// same head (else the chain's other models), never the model that wrote the first review or one that
// failed in this run. Both are posted; the stricter verdict decides the label. Without a second
// review, the first is posted unlabelled and the script exits 3: the owner decides.
// harness.json's claudeFallback: null names no Claude reviewer: an exit 3 then says to escalate to
// the owner, as it does when Claude implemented the PR.
//
// Exit 0: posted, and labelled with --apply-label. Exit 1: refused or a defect. Exit 3: OpenCode
// unavailable or no review, nothing posted; the caller runs the Claude reviewer (harness.json's
// claudeFallback), unless Claude implemented the PR or claudeFallback is null: then the caller
// escalates to the owner, as the message says. With --second-opinion, exit 3 also means the first
// review was posted but no second one came back: no label, and the owner decides. Exit 4: posted under a note, no label; the caller reads it on the PR and decides,
// and never pays for a second review because of it. --dry-run prints
// what would be posted and the exit code it would use, and exits 0; it still runs, and bills, the
// model.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runOpenCodeWatched, resolveOpenCode, OpenCodeInfraError } from './lib/opencode.mjs';
import { credentialJail, OFF_WARNING } from './lib/jail.mjs';
import { runChain, excludeImplementers, readReview, doneWhenCount, briefTargets } from './lib/chain.mjs';
import { planPost, publish, postComment, applyLabel, withdrawApproval, combinePlans } from './lib/post.mjs';
import { selfTest, SAMPLES } from './lib/review-selftest.mjs';
import {
  sh, requireTools, repoPaths, loadConfig, parseArgs, envWith, ocArgs, prepareOpenCode, watchLine,
} from './lib/common.mjs';

const say = (s) => console.log(s);
const die = (code, s) => { console.error(s); process.exit(code); };

const a = parseArgs(process.argv.slice(2), { flags: ['apply-label', 'dry-run', 'self-test', 'second-opinion', 'hard', 'sol'], repeatable: ['env'] });
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

requireTools('git', 'gh');

const top0 = sh('git', ['rev-parse', '--show-toplevel']);
const config = loadConfig(top0);
const { top, workRoot } = repoPaths(config);
const rev = config.reviewer;

// The implementer's family never reviews.
const labelsOf = (kind, n) => sh('gh', [kind, 'view', String(n), '--json', 'labels', '--jq', '.labels[].name'], { cwd: top, allowFail: true }).split('\n');
const implementedBy = a.exclude ? a.exclude.split(',').map((s) => s.trim()).filter(Boolean)
  : [...labelsOf('pr', a.pr), ...(a.issue ? labelsOf('issue', a.issue) : [])]
    .filter((l) => l.startsWith('model:')).map((l) => l.slice(6));
if (a.reviewer && !config.models[a.reviewer]) die(2, `Unknown reviewer ${a.reviewer}.`);
// --hard (L39): reviewer.hard, a heavy reviewer first, then reviewers on other providers and
// families, so that one account's quota cannot block a hard review; the implementer's family is
// skipped as in any chain. --sol (L41) puts reviewer.sol first, Sol being used sparingly.
if (a.hard && a.reviewer) die(2, '--hard runs reviewer.hard; it does not take --reviewer.');
if (a.hard && !rev.hard?.length) die(2, '--hard needs reviewer.hard in harness.json.');
if (a.sol && !a.hard) die(2, '--sol goes with --hard: it puts reviewer.sol before reviewer.hard.');
if (a.sol && !rev.sol) die(2, '--sol needs reviewer.sol in harness.json.');
if (a.sol && !config.models[rev.sol]) die(2, `Unknown reviewer ${rev.sol} in reviewer.sol.`);
for (const m of a.hard ? rev.hard : []) if (!config.models[m]) die(2, `Unknown reviewer ${m} in reviewer.hard.`);
const base = !a.hard ? rev.chain : a.sol ? [...new Set([rev.sol, ...rev.hard])] : rev.hard;
const wanted = a.reviewer ? [a.reviewer] : base;
const chain = excludeImplementers(wanted, config.models, implementedBy);
if (implementedBy.length) say(`implemented by: ${implementedBy.join(', ')}`);
if (a.reviewer && !chain.length) die(1, `Refused: ${a.reviewer} is the implementer's model family. Nothing posted.`);
// harness.json's claudeFallback: null means no Claude reviewer, so a failure goes to the owner (#39).
// So does a PR Claude implemented: a Claude reviewer would be its own family.
const fallback = rev.claudeFallback === null ? 'Nothing posted; escalate to the owner (harness.json names no Claude reviewer).'
  : implementedBy.includes('claude') ? 'Nothing posted; escalate to the owner: Claude implemented this PR, so no Claude reviewer may review it.'
    : `Nothing posted; use a Claude reviewer (${rev.claudeFallback ?? 'opus'}).`;
// OpenCode is looked for only now, so that its absence is reported with the same fallback (Sol's R1 on PR 41).
let opencode;
try { opencode = resolveOpenCode(); } catch (e) {
  if (e instanceof OpenCodeInfraError) die(3, `OpenCode unavailable: ${e.message} ${fallback}`);
  throw e;
}
// OpenCode, and every command it runs, in the credential jail (lib/jail.mjs, #68): the reviewer
// reads and tests, and this script posts. Only where harness.json turns it on (jail.enabled); where
// it is on but cannot run, the log says so first.
const jail = config.jail?.enabled === true ? credentialJail() : { off: 'harness.json does not enable it', quiet: true };
if (jail.off && !jail.quiet) say(OFF_WARNING(jail.off));
else if (!jail.off) opencode = { exe: jail.exe, prefix: [...jail.args, '--', opencode.exe, ...opencode.prefix] };
if (!chain.length) die(3, `OpenCode unavailable: no reviewer left after excluding ${implementedBy.join(', ')}. ${fallback}`);
// A second opinion (--second-opinion, for a critical PR): reviewer.secondOpinion, else the chain's
// other models, never the model that wrote the first review (#39).
if (a['second-opinion'] && !rev.secondOpinion) die(2, '--second-opinion needs reviewer.secondOpinion in harness.json.');
if (a['second-opinion'] && !config.models[rev.secondOpinion]) die(2, `Unknown second-opinion reviewer ${rev.secondOpinion}.`);
const seconds = a['second-opinion'] ? excludeImplementers([...new Set([rev.secondOpinion, ...base])], config.models, implementedBy) : [];
const pre = await prepareOpenCode({ opencode, chain: [...new Set([...chain, ...seconds])], models: config.models, env: envWith(a.env), cwd: top, log: say });
for (const p of pre.problems) say(p);
const usable = chain.filter((m) => pre.usable.includes(m));
if (!usable.length) die(3, `OpenCode unavailable: ${pre.problems.join('; ')}. ${fallback}`);

// The reviewer's agent and OpenCode config come from this checkout, the main session's, never from
// the PR under review: OpenCode reads a project's .opencode/ by default, so a PR's own reviewer.md
// (or anything else it puts there) would decide what its reviewer may do. Checked on OpenCode
// 1.18.34: without these two variables a PR's reviewer.md with `git push *: allow` was the one
// loaded (#10, L34; ic2-conquest's reviewer does the same).
const agentFile = path.join(top, '.opencode', 'agents', `${rev.agent}.md`);
if (!fs.existsSync(agentFile)) die(2, `The reviewer agent is missing from this checkout: ${agentFile}. Nothing run.`);
const reviewEnv = { ...pre.env, OPENCODE_CONFIG_DIR: path.join(top, '.opencode'), OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
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
  say(`worktree: ${worktree} at ${headSha}`);
};

// One review: the chain's models in turn, each in a fresh worktree; a second opinion says so in its header.
const runReview = async (names, second) => {
  try {
    return await runChain({ chain: names, log: say, reset: async () => {}, attempt: (m) => attempt(m, second) });
  } finally {
    removeTree();
  }
};
const attempt = async (m, second) => {
      const model = config.models[m];
      const header = second ? briefHeader.replace(/\([^()]*\)\s*$/, `(${m}, second opinion)`)
        : a.reviewer ? briefHeader : briefHeader.replace(/\([^()]*\)\s*$/, `(${m})`);
      const prompt = `${header}\n${brief.slice(1).join('\n')}

---
OUTPUT RULES (from tools/harness/review.mjs; they override anything above that conflicts):
- Do not post to GitHub, edit, commit, push, label or merge anything. The script posts your review.
- Your final message is the review and nothing else. Line 1 is exactly: ${header}
  Line 2 is the verdict, alone on its line: approve, approve after named fixes, rework, or user
  decision. Then any where-I-worked lines (worktree, HEAD, diff, the commands you ran), then the
  findings (R1, R2, ... with file and line, blocking or not), then the verdict again as the very
  last line. Nothing comes after it.
- A finding you proved that lets a forbidden action or a wrong result past what the task protects
  is blocking, and blocks an approve: never "follow-up hardening" or "outside the threat model"
  unless the task's text says so (L47).
- Report every blocking finding in this one review, not one per round: read the whole diff, then
  make a final pass and write "Final pass done" as the line before the closing verdict. Name any
  part you did not cover, and do not approve then (L49).${doneWhen ? `
- The task has ${doneWhen} Done-when line${doneWhen > 1 ? 's' : ''}. Right after the verdict line, account for each, one
  line per Done-when line, DW1 to DW${doneWhen}: "DW<k>: ran <command> → <result>", or
  "DW<k>: not run — <reason>". An approve with one missing, or one not run, is not applied.` : ''} A review that does not end with its verdict, or that has a
  finding after it, is posted flagged and acted on by no one until the main session reads it.
- Your worktree is ${worktree} at ${headSha}, and it is already your working directory. Run git
  there without -C, and never type that path: a mistyped path ends the run.
`;
      newTree();
      const watch = watchLine(m, model);
      if (watch) say(watch);
      let run;
      try {
        run = await runOpenCodeWatched({
          args: ocArgs(worktree, rev.agent, model), prompt, workDir: worktree, title: `pr${a.pr}-${m}`,
          startupTimeoutMs: rev.startupTimeoutSec * 1000, idleTimeoutMs: rev.idleTimeoutSec * 1000,
          totalTimeoutMs: rev.totalTimeoutSec * 1000, opencode, env: reviewEnv, log: say,
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
};

const failed = (r) => r.failures.map((f) => `${f.name} failed: ${f.reason}`).join('; ');
const why = (r) => (r.sameCause ? `same failure twice: ${r.sameCause} (${failed(r)})` : failed(r));
// The models of `list` ahead of the one that reviewed that could not run at all (not listed, or not
// logged in): the header names them too, so a substitute is always visible (Sol's R2 on PR 47).
const unavailable = (list, name) => list.slice(0, Math.max(0, list.indexOf(name)))
  .filter((m) => !pre.usable.includes(m)).map((m) => `${m} not available`);
const planOf = (r, list) => planPost({
  read: r.value, header: r.value.header, reasons: [...unavailable(list, r.name), failed(r)].filter(Boolean).join('; '),
  doneWhen, source: 'tools/harness/review.mjs',
  signature: `${r.name}, via tools/harness/review.mjs (${r.value.model.id})`,
});

const result = await runReview(usable, false);
if (!result.ok) die(3, `OpenCode unavailable: ${why(result)}. ${fallback}`);
const plan = planOf(result, chain);
if (!a['second-opinion']) {
  publish({ plan, pr: a.pr, issue: a.issue, applyLabel: a['apply-label'], dryRun: a['dry-run'], top, say, die });
  process.exit(0);
}

// The second opinion: another model reviews the same head. Both reviews are posted; the stricter
// decides the label (lib/post.mjs combinePlans). Without one, the first is posted and the owner decides.
// Neither the first review's model nor one that failed in this run is tried again, compared by the
// model's id, so that two names for one model never count as two opinions (Sol's R2 on PR 41).
const idOf = (m) => config.models[m].id;
const spent = new Set([result.name, ...result.failures.map((f) => f.name)].map(idOf));
const others = [...new Map(seconds.filter((m) => !spent.has(idOf(m)) && pre.usable.includes(m)).map((m) => [idOf(m), m])).values()];
say(`second opinion: ${others.join(', ') || 'no other reviewer left'}`);
const second = others.length ? await runReview(others, true) : { ok: false, failures: [], sameCause: null };
const plans = second.ok ? [plan, planOf(second, seconds.filter((m) => !spent.has(idOf(m)) || m === second.name))] : [plan];
const outcome = second.ok ? combinePlans(plans)
  : { label: null, code: 3, why: `no second opinion (${why(second) || `only ${result.name} could review`}): escalate to the owner` };
for (const p of plans) for (const r of p.rewrites) say(`rewrote a closing keyword: ${r}`);
if (a['dry-run']) {
  for (const p of plans) say(p.body);
  say(`dry run: would post ${plans.length} review(s), ${a['apply-label'] && outcome.label ? `label ${outcome.label}` : 'no label'}, and exit ${outcome.code}${outcome.why ? ` (${outcome.why})` : ''}.`);
  process.exit(0);
}
for (const p of plans) {
  postComment({ plan: p, pr: a.pr, top });
  say(`posted: ${p.first} / ${p.kind === 'flagged' ? `flagged (${p.note})` : p.verdict}`);
}
// An approval from an earlier round never outlives two reviews that did not both approve (Sol's R3 on PR 41).
if (a['apply-label'] && outcome.label !== 'status:approved') withdrawApproval({ issue: a.issue, top });
if (outcome.code) die(outcome.code, `No label applied: ${outcome.why}. Read the reviews on PR ${a.pr} and decide.`);
if (a['apply-label']) applyLabel({ label: outcome.label, issue: a.issue, top, say });
say(`second opinion: ${outcome.label ?? 'no label'}${outcome.why ? ` (${outcome.why})` : ''}`);
