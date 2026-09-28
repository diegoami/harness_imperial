#!/usr/bin/env node
// Hands one pull request to OpenCode for a review, and posts the result as one PR comment.
//
//   node tools/harness/review.mjs --pr 42 --brief brief.md [--reviewer NAME] [--exclude NAME,...]
//     [--issue 12 --apply-label] [--dry-run] [--env KEY=VALUE]...
//
// The brief's first line is the review header the model prints, e.g. "T07 review (GLM)"; with the
// chain, the text in its final parentheses becomes each attempt's model. The model never writes to
// GitHub (the agent file denies it); this script is the only writer, so a cut-off review never
// reaches the PR.
//
// The reviewer is never the implementer's model family: --exclude (implement.mjs prints the name on
// its "implemented by:" line, or "claude"), else a model:<name> label on the PR or --issue.
//
// Exit 0: posted (or printed with --dry-run). Exit 1: refused or a defect. Exit 3: OpenCode
// unavailable, nothing posted; use a Claude reviewer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runOpenCodeWatched, resolveOpenCode, OpenCodeInfraError } from './lib/opencode.mjs';
import { runChain, excludeImplementers, checkReview } from './lib/chain.mjs';
import { sh, requireTools, repoPaths, loadConfig, parseArgs, envWith, ensureAgent, ocArgs } from './lib/common.mjs';

const say = (s) => console.log(s);
const die = (code, s) => { console.error(s); process.exit(code); };

const a = parseArgs(process.argv.slice(2), { flags: ['apply-label', 'dry-run'], repeatable: ['env'] });
if (!a.pr || !a.brief) die(2, '--pr and --brief are required.');
if (a['apply-label'] && !a.issue) die(2, '--apply-label needs --issue.');
const brief = fs.readFileSync(a.brief, 'utf8').split(/\r?\n/);
const briefHeader = brief[0].trim();
if (!/review \(/.test(briefHeader)) die(2, `The brief's first line must be the review header, e.g. "T07 review (GLM)"; got: ${briefHeader}`);

let opencode;
try { opencode = resolveOpenCode(); } catch (e) {
  if (e instanceof OpenCodeInfraError) die(3, `OpenCode unavailable: ${e.message} Nothing posted.`);
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
if (!chain.length) die(3, `OpenCode unavailable: no reviewer left after excluding ${implementedBy.join(', ')}. Nothing posted; use a Claude reviewer.`);

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
    chain,
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
  Line 2 is the verdict: approve, approve after named fixes, rework, or user decision.
  Then the findings (R1, R2, ... with file and line, blocking or not), then the verdict again as
  the very last line. A review that does not end with its verdict is treated as cut off.
- Your worktree is ${worktree} at ${headSha}. Pass git -C "${worktree}" explicitly.
`;
      newTree();
      let run;
      try {
        run = await runOpenCodeWatched({
          args: ocArgs(worktree, rev.agent, model), prompt, workDir: worktree, title: `pr${a.pr}-${m}`,
          startupTimeoutMs: rev.startupTimeoutSec * 1000, idleTimeoutMs: rev.idleTimeoutSec * 1000,
          totalTimeoutMs: rev.totalTimeoutSec * 1000, opencode, env: envWith(a.env), log: say,
        });
      } catch (e) {
        if (!(e instanceof OpenCodeInfraError)) throw e;
        return { ok: false, reason: e.reason, detail: e.message };
      }
      if (run.exitCode !== 0) return { ok: false, reason: `exit ${run.exitCode}`, detail: run.output };
      if (run.agentFallback) return { ok: false, reason: 'fell back to the default agent', detail: run.output };
      const checked = checkReview(run.stdout, header);
      if (!checked.ok) return { ok: false, reason: checked.reason, detail: run.output };
      return { ok: true, value: { ...checked, header, model } };
    },
  });
} finally {
  removeTree();
}

const reasons = result.failures.map((f) => `${f.name} failed: ${f.reason}`).join('; ');
if (!result.ok) die(3, `OpenCode unavailable: ${result.sameCause ? `same failure twice: ${result.sameCause} (${reasons})` : reasons}. Nothing posted; use a Claude reviewer.`);

const { review, verdict, header, model } = result.value;
const lines = review.split('\n');
if (reasons) lines[0] = header.replace(/\)\s*$/, `; ${reasons})`);
const body = `${lines.join('\n')}\n\n— ${result.name}, via tools/harness/review.mjs (${model.id})`;
if (a['dry-run']) { say(body); process.exit(0); }

const bodyFile = path.join(os.tmpdir(), `harness-review-${a.pr}-${randomBytes(3).toString('hex')}.md`);
fs.writeFileSync(bodyFile, body);
sh('gh', ['pr', 'comment', String(a.pr), '--body-file', bodyFile], { cwd: top });
fs.rmSync(bodyFile, { force: true });
say(`posted: ${lines[0]} / ${verdict}`);
if (a['apply-label']) {
  const label = verdict === 'approve' ? 'status:approved' : verdict === 'user decision' ? null : 'status:rework';
  if (label) sh('gh', ['issue', 'edit', String(a.issue), '--add-label', label, '--remove-label', 'status:in-review'], { cwd: top });
  else say('verdict "user decision" applies no label; the main session decides.');
}
