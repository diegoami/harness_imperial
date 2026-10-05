#!/usr/bin/env node
// Runs one task's (or one fix's) implementer on OpenCode, in a worktree this script creates.
//
//   node tools/harness/implement.mjs --task T07 --slug calendar --issue 12 --brief brief.md [--model NAME]
//   node tools/harness/implement.mjs --fix 34 --slug save-path --brief brief.md
//     [--copy local.ini]...  untracked files copied from the main checkout into the worktree
//     [--env KEY=VALUE]...   environment for the run
//   node tools/harness/implement.mjs --self-test   (the reset's save, on a throwaway repository)
//
// The main session fills the brief (the task file pasted in full, plus review URLs on a rework
// round). This script creates or resumes the branch and worktree, runs OpenCode watched, and checks
// the handover: a PR exists, the worktree is clean, pushed and detached.
//
// The model is harness.json's implementer.chain (one model, by the user's decision of 2026-10-02:
// DeepSeek V4.1 Flash, then Claude Sonnet); --model runs another alone. Runs use the scripts' own
// OpenCode data directory, and a model OpenCode does not list there exits 3 before anything is
// billed. With a longer chain, the next model runs
// only on an infrastructure failure, and only when the failed run left nothing behind (no new
// commit locally or on origin, no new PR), judged against the state before the first attempt, so a
// resumed rework branch can still fall back. An implementer that stops and reports has NOT failed:
// its run exits 0 and is never retried; this script then exits 1 at "no open PR".
//
// When an attempt fails and left nothing behind, the reset between attempts first saves the
// worktree's uncommitted changes (staged, unstaged and untracked) to
// <workRoot>/<name>.<model key>.<UTC time>.unsaved.patch, created exclusively (lib/unsaved.mjs,
// #87). The exit 1 and exit 3 messages name every patch the run saved.
//
// Exit 0: PR open. Exit 1: the main session decides (read the log). Exit 3: OpenCode unavailable;
// fall back to a Claude implementer.

import fs from 'node:fs';
import path from 'node:path';
import { runOpenCodeWatched, resolveOpenCode, OpenCodeInfraError } from './lib/opencode.mjs';
import { runChain } from './lib/chain.mjs';
import { resetWorktree, selfTest as unsavedSelfTest } from './lib/unsaved.mjs';
import {
  sh, requireTools, repoPaths, loadConfig, parseArgs, envWith, ensureAgent, ocArgs, prepareOpenCode, watchLine,
} from './lib/common.mjs';

const say = (s) => console.log(s);
const die = (code, s) => { console.error(s); process.exit(code); };

const a = parseArgs(process.argv.slice(2), { flags: ['self-test'], repeatable: ['copy', 'env'] });
// --self-test: the reset's save on a throwaway repository (lib/unsaved.mjs), with no OpenCode or gh.
if (a['self-test']) {
  const failures = unsavedSelfTest();
  for (const f of failures) console.error(`FAIL ${f}`);
  say(`self-test: ${failures.length ? `${failures.length} checks failed` : 'all checks passed'}`);
  process.exit(failures.length ? 1 : 0);
}
if (!a.task === !a.fix) die(2, 'Give exactly one of --task T<nn> or --fix <issue>.');
if (a.task && !/^T\d{2,3}$/.test(a.task)) die(2, `--task must look like T07; got ${a.task}`);
if (!a.slug || !a.brief) die(2, '--slug and --brief are required.');
if (!fs.existsSync(a.brief)) die(2, `Brief not found: ${a.brief}`);

let opencode;
try { opencode = resolveOpenCode(); } catch (e) {
  if (e instanceof OpenCodeInfraError) die(3, `OpenCode unavailable: ${e.message} Fall back to a Claude implementer (see harness.json).`);
  throw e;
}
requireTools('git', 'gh');

const top0 = sh('git', ['rev-parse', '--show-toplevel']);
const config = loadConfig(top0);
const { top, commonDir, mainRoot, workRoot } = repoPaths(config);
const impl = config.implementer;
const chain = a.model ? [a.model] : impl.chain;
for (const m of chain) if (!config.models[m]) die(2, `Unknown model ${m}; harness.json lists ${Object.keys(config.models).join(', ')}.`);
const fallback = `Fall back to a Claude implementer (${impl.claudeFallback ?? 'sonnet'}).`;
const pre = await prepareOpenCode({ opencode, chain, models: config.models, env: envWith(a.env), cwd: top, log: say });
for (const p of pre.problems) say(p);
if (!pre.usable.length) die(3, `OpenCode unavailable: ${pre.problems.join('; ')}. ${fallback}`);

const name = a.task ?? `fix-${a.fix}`;
const branch = a.task ? `task/${a.task}-${a.slug}` : `fix/${a.fix}-${a.slug}`;
const issue = a.issue ?? a.fix;
const worktree = path.join(workRoot, name);
const logFile = path.join(workRoot, `${name}.implementer.log`);
fs.mkdirSync(workRoot, { recursive: true });

// 1. The worktree and branch: resume a pushed branch, otherwise start from origin/main and push.
sh('git', ['-C', top, 'fetch', '-q', 'origin']);
const remoteHas = sh('git', ['-C', top, 'ls-remote', '--heads', 'origin', branch]);
if (fs.existsSync(worktree)) {
  if (sh('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']) !== branch) sh('git', ['-C', worktree, 'checkout', '-q', branch]);
} else if (remoteHas) {
  sh('git', ['-C', top, 'worktree', 'add', worktree, branch]);
} else {
  sh('git', ['-C', top, 'worktree', 'add', '-b', branch, worktree, 'origin/main']);
  sh('git', ['-C', worktree, 'push', '-q', '-u', 'origin', branch]);
}
if (remoteHas) sh('git', ['-C', worktree, 'merge', '-q', '--ff-only', `origin/${branch}`]);
for (const f of a.copy) fs.copyFileSync(path.join(mainRoot, f), path.join(worktree, f));
ensureAgent({ top, commonDir, worktree, agent: impl.agent });
say(`worktree: ${worktree} on ${branch}`);

// 2. The run.
const prompt = `${fs.readFileSync(a.brief, 'utf8')}

---
RUN RULES (from tools/harness/implement.mjs; they override the brief where they conflict):
- Your worktree is ${worktree} on branch ${branch}, already created and pushed. Never run
  git worktree. Pass git -C "${worktree}" explicitly.
- Everything else in the brief is binding: Owns, Done when, the PR body, the detach, the report.
- The PR body's "Closes #${issue}" is the only place a closing keyword may precede #<n>.
- Never read, write or redirect to any path outside your worktree: no /tmp, no home directory, no
  git internals (in a worktree, .git points into the main checkout). Scratch files and any TMPDIR go
  in a folder inside the worktree, which you never commit (add files by name, never git add -A), and
  which you delete before your last commit. A test that needs a TMPDIR outside every checkout is
  run by the main session, not by you. (L57)
- Commit and push after each step, so a run that ends early keeps its work. (L57)
`;
const openPr = () => sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number'], { cwd: top, allowFail: true });
const originSha = () => sh('git', ['-C', top, 'rev-parse', `origin/${branch}`], { allowFail: true });
const startSha = sh('git', ['-C', worktree, 'rev-parse', 'HEAD']);
const startRemote = originSha();
const startPr = openPr();
fs.writeFileSync(logFile, '');

// The implementer runs on the agent copied into its worktree, so it must not inherit the reviewer's
// settings (review.mjs, L34) from a session that ran a review: OPENCODE_DISABLE_PROJECT_CONFIG would
// hide that agent, and OPENCODE_CONFIG_DIR would put another in its place.
const { OPENCODE_CONFIG_DIR: _dir, OPENCODE_DISABLE_PROJECT_CONFIG: _off, ...implementEnv } = pre.env;

const patches = [];        // the unsaved-work patches this run's resets wrote (#87)
let attemptModel = null;   // the chain key of the attempt whose work a reset saves
const result = await runChain({
  chain: pre.usable,
  log: say,
  attempt: async (m) => {
    attemptModel = m;
    const model = config.models[m];
    const watch = watchLine(m, model);
    if (watch) say(watch);
    let reason = null;
    let output;
    try {
      const run = await runOpenCodeWatched({
        args: ocArgs(worktree, impl.agent, model), prompt, workDir: worktree, title: `${name}-${m}`,
        startupTimeoutMs: impl.startupTimeoutSec * 1000, idleTimeoutMs: impl.idleTimeoutSec * 1000,
        totalTimeoutMs: impl.totalTimeoutSec * 1000, opencode, env: implementEnv, log: say,
      });
      output = run.output;
      if (run.exitCode !== 0) reason = `exit ${run.exitCode}`;
      else if (run.agentFallback) reason = 'fell back to the default agent';
      else if (run.permissionRejected) reason = `permission rejected: ${run.permissionRejected}${run.permissionHint ? `; ${run.permissionHint}` : ''}`;
    } catch (e) {
      if (!(e instanceof OpenCodeInfraError)) throw e;
      reason = e.reason;
      output = e.message;
    }
    fs.appendFileSync(logFile, `=== ${m} (${model.id}): ${reason ? `failed: ${reason}` : 'ran'} ===\n${watch ? `${watch}\n` : ''}${output}\n`);
    return reason ? { ok: false, reason } : { ok: true, value: output };
  },
  leftWork: async () => {
    sh('git', ['-C', top, 'fetch', '-q', 'origin']);
    const pr = openPr();
    return sh('git', ['-C', worktree, 'rev-parse', 'HEAD']) !== startSha
      || originSha() !== startRemote || (pr && pr !== startPr);
  },
  // Before the hard reset destroys it, the failed attempt's uncommitted work goes to a patch
  // (lib/unsaved.mjs, #87), so a run that a rejected tool call ended is not lost.
  reset: async () => {
    patches.push(...resetWorktree({ worktree, startSha, workRoot, name, model: attemptModel, log: say }));
  },
});

say(`run log: ${logFile}`);
// Every exit after the chain names the patches its resets saved (#87; Sol's R3 on PR 100).
const saved = patches.length ? ` Unsaved work was saved before the reset: ${patches.join(', ')}.` : '';
const reasons = result.failures.map((f) => `${f.name}: ${f.reason}`).join('; ');
if (!result.ok) {
  if (result.leftWork) die(1, `The run failed (${reasons}) after committing, pushing or opening a PR on ${branch}; not retrying. The main session decides.${saved}`);
  die(3, `OpenCode unavailable: ${result.sameCause ? `same failure twice: ${result.sameCause} (${reasons})` : reasons}. ${fallback}${saved}`);
}
if (reasons) say(`fell back: ${reasons}`);
// The reviewer must not be this model's family: pass it to review.mjs as --exclude.
say(`implemented by: ${result.name} (${config.models[result.name].id})`);

// 3. The handover: a PR, and a clean, pushed, detached worktree.
sh('git', ['-C', top, 'fetch', '-q', 'origin']);
const pr = sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--jq', '.[0].url'], { cwd: top, allowFail: true });
if (sh('git', ['-C', worktree, 'status', '--porcelain'])) console.warn(`warning: uncommitted changes remain in ${worktree}`);
if (sh('git', ['-C', worktree, 'rev-parse', 'HEAD']) !== originSha()) console.warn(`warning: ${worktree}'s HEAD is not pushed to origin/${branch}`);
sh('git', ['-C', worktree, 'checkout', '-q', '--detach']);
say('--- tail of the run ---');
say(result.value.split(/\r?\n/).slice(-40).join('\n'));
if (!pr) die(1, `No open PR for ${branch}. Read ${logFile}: an implementer that stopped and reported is not a failure.${saved}`);
say(`PR: ${pr}`);
