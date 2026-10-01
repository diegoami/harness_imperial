#!/usr/bin/env node
// Hands one pull request to OpenCode for a review, and posts the result as one PR comment.
//
//   node tools/harness/review.mjs --pr 42 --brief brief.md [--reviewer NAME] [--exclude NAME,...]
//     [--issue 12 --apply-label] [--dry-run] [--env KEY=VALUE]...
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
import { runChain, excludeImplementers, readReview } from './lib/chain.mjs';
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
  last line. Nothing comes after it. A review that does not end with its verdict, or that has a
  finding after it, is posted flagged and acted on by no one until the main session reads it.
- Your worktree is ${worktree} at ${headSha}. Pass git -C "${worktree}" explicitly.
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
      if (run.permissionRejected) return { ok: false, reason: `permission rejected: ${run.permissionRejected}`, detail: run.output };
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
const flagNote = kind === 'flagged'
  ? `> Note from tools/harness/review.mjs: ${note}; no label applied${reasons ? ` (${reasons})` : ''}. `
    + 'The main session reads this review and decides.\n\n' : '';
const body = `${flagNote}${lines.join('\n')}\n\n— ${result.name}, via tools/harness/review.mjs (${model.id})`;
const label = kind === 'flagged' ? null
  : verdict === 'approve' ? 'status:approved' : verdict === 'user decision' ? null : 'status:rework';
const code = kind === 'flagged' ? 4 : 0;
if (a['dry-run']) {
  say(body);
  say(`dry run: would post the above${a['apply-label'] && label ? `, label ${label}` : ', no label'}, and exit ${code}.`);
  process.exit(0);
}

const bodyFile = path.join(os.tmpdir(), `harness-review-${a.pr}-${randomBytes(3).toString('hex')}.md`);
fs.writeFileSync(bodyFile, body);
sh('gh', ['pr', 'comment', String(a.pr), '--body-file', bodyFile], { cwd: top });
fs.rmSync(bodyFile, { force: true });
if (kind === 'flagged') die(4, `posted: ${lines[0]}, flagged (${note}); no label. Read the review on PR ${a.pr} and decide.`);
say(`posted: ${lines[0]} / ${verdict}`);
if (a['apply-label']) {
  if (label) sh('gh', ['issue', 'edit', String(a.issue), '--add-label', label, '--remove-label', 'status:in-review'], { cwd: top });
  else say('verdict "user decision" applies no label; the main session decides.');
}
