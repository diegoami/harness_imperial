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
// GLM-5.3 Flash, then MiMo V2.6 Flash, then Claude Sonnet); --model runs another alone. Runs use the scripts' own
// OpenCode data directory, and a model OpenCode does not list there exits 5 before anything is
// billed. A failed attempt never loses its work (L70): what it left uncommitted becomes a `wip:`
// commit, pushed to the branch with the model's own commits (lib/unsaved.mjs saveProgress; a patch
// under <workRoot> only when that commit fails). With a longer chain, the next model runs only when
// the provider did not respond (L69: a provider error, or an idle session with no tool running) and
// the failed run opened no PR, and it resumes the saved work. A failure through our process (a
// denied call, the agent, a hung tool, a timeout, the setup) stops at once with exit 5: the main
// session fixes the cause and reruns, which resumes the branch. Every attempt on a branch that
// already holds commits is told so in its brief (the RESUME block): their subjects, oldest first,
// and to continue from the last `next:`. An implementer that stops and reports has NOT failed: its
// run exits 0 and is never retried; this script then exits 1 at "no open PR".
//
// Exit 0: PR open. Exit 1: the main session decides (read the log). Exit 3: every provider failed
// to respond; fall back to a Claude implementer. Exit 5: our process or setup failed; fix the
// cause and rerun, no fallback (the owner, 2026-10-10, L69).

import fs from 'node:fs';
import path from 'node:path';
import { runOpenCodeWatched, resolveOpenCode, OpenCodeInfraError, keyProblem, runFailure, deniedNote, failureClass } from './lib/opencode.mjs';
import { runChain } from './lib/chain.mjs';
import { saveProgress, selfTest as unsavedSelfTest } from './lib/unsaved.mjs';
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
  if (e instanceof OpenCodeInfraError) die(5, `Setup: ${e.message} Fix it and rerun; no fallback (L69).`);
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
if (pre.setup.length) die(5, `Setup: ${pre.setup.join('; ')}. Fix it and rerun; no fallback (L69). Nothing ran.`);
if (!pre.usable.length) die(3, `No provider available: ${pre.problems.join('; ')}. ${fallback}`);

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
// A copied file's folder may be untracked or ignored, so absent from a fresh worktree (#90). A
// path that leaves the main checkout or the worktree is refused (Luna's R1 on PR 91). A
// symlinked path component on the source or the destination side that escapes either root is
// refused too: the lexical check above is fooled by a tracked symlink whose target is outside,
// but mkdirSync and copyFileSync follow symlinks, so the script would otherwise create the
// destination outside the worktree (Luna's R2 on PR 91, both sides).
const copied = [];   // the worktree paths --copy wrote: local files no wip commit takes (L70)
for (const f of a.copy) {
  // 1. Lexical gate (cheap, no I/O): the path leaves the checkout or the worktree lexically.
  // Required (not best-effort) so a swap with the realpath gate changes the error text on
  // the path-escape tests: `../newdir/escaped.sav` would otherwise hit ENOENT and emit
  // "cannot resolve" instead of the lexical "inside the checkout" — Luna's R3 on round 5.
  const lexInside = (root) => { const r = path.relative(root, path.resolve(root, f)); return r && !r.startsWith('..') && !path.isAbsolute(r); };
  if (!lexInside(mainRoot) || !lexInside(worktree)) die(2, `--copy takes a path inside the checkout; got ${f}`);
  // 2. Source-side realpath: a tracked symlink whose target escapes the checkout would
  // otherwise let copyFileSync read or write outside (the file's path through the symlink).
  // Required so the source-side gate is provably exercised by the source-side test —
  // removing it leaves the dest-side walk to catch, which is not what the test claims to prove.
  let realF;
  try { realF = fs.realpathSync(path.resolve(mainRoot, f)); }
  catch (e) { die(2, `--copy: cannot resolve ${f}: ${e.code ?? e.message}`); }
  const rel = path.relative(mainRoot, realF);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) die(2, `--copy takes a path inside the checkout; got ${f}`);
  // 3. Destination-side realpath: walk up from dest (not just dirname(dest), because dest
  // itself can be a tracked symlink to outside — copyFileSync would write to it) and refuse
  // if any existing component is a symlink whose target lands outside the worktree. Walk
  // past non-existent intermediates — mkdirSync's recursive option would otherwise follow an
  // ancestor's symlink and create the directory outside the worktree (Luna's R1 on round 4
  // and R1 on round 5).
  const dest = path.join(worktree, rel);
  for (let cur = dest; cur !== worktree; cur = path.dirname(cur)) {
    if (!cur.startsWith(worktree + path.sep)) break;
    let lstat;
    try { lstat = fs.lstatSync(cur); } catch { continue; }   // cur doesn't exist yet, walk up
    if (!lstat.isSymbolicLink()) break;                     // regular file/dir; safe
    const realCur = (() => { try { return fs.realpathSync(cur); } catch { return cur; } })();
    const r = path.relative(worktree, realCur);
    if (r === '' || r.startsWith('..') || path.isAbsolute(r)) die(2, `--copy: destination path escapes the worktree via a symlink; got ${f}`);
    break;                                                  // symlink inside worktree; safe
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(realF, dest);
  copied.push(rel);   // where the file landed: the resolved path, not the one asked for (Luna's R1 on PR 165)
  // ...and, when that path is itself a symlink inside the worktree, the file the copy wrote through it (Luna's R1, round 2).
  const landed = path.relative(fs.realpathSync(worktree), fs.realpathSync(dest));
  if (landed !== rel) copied.push(landed);
}
ensureAgent({ top, commonDir, worktree, agent: impl.agent });
say(`worktree: ${worktree} on ${branch}`);

// 2. The run.
const brief = `${fs.readFileSync(a.brief, 'utf8')}

---
RUN RULES (from tools/harness/implement.mjs; they override the brief where they conflict):
- Your worktree is ${worktree} on branch ${branch}, already created and pushed. Never run
  git worktree. Pass git -C "${worktree}" explicitly.
- Everything else in the brief is binding: Owns, Done when, the PR body, the detach, the report.
- The PR body's "Closes #${issue}" is the only place a closing keyword may precede #<n>.
- Never read, write or redirect to any path outside your worktree but your scratch folder: no other
  /tmp path, no home directory, no git internals (in a worktree, .git points into the main
  checkout). Scratch files go in your scratch folder ($TMPDIR, named at the top of this brief),
  which is outside every checkout, so a test that needs a TMPDIR outside git uses it too. Add files
  to commits by name, never git add -A. (L57, L66)
- Commit and push after each step, so a run that ends early keeps its work, with the message
  "step <k>: done <what>; next: <what>", so the next run knows where to start. (L57, L70)
`;
// The branch's own commits, oldest first: what an earlier run (or round) already did (L70).
const resumeBlock = () => {
  const log = sh('git', ['-C', worktree, 'log', '--reverse', '--format=%h %s', 'origin/main..HEAD'], { allowFail: true });
  if (!log) return '';
  const lines = log.split('\n');
  return `
RESUME (from tools/harness/implement.mjs; L70): branch ${branch} already holds work, oldest first:
${(lines.length > 40 ? ['…', ...lines.slice(-40)] : lines).map((l) => `  ${l}`).join('\n')}
Continue from it, never from the start: the last "step <k>: …; next: …" commit names what comes
next, and a "wip:" commit is what a run left when it stopped (git show --stat HEAD shows it).
Check what it did before you build on it; do not redo a step that is done.
`;
};
const openPr = () => sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number'], { cwd: top, allowFail: true });
const originSha = () => sh('git', ['-C', top, 'rev-parse', `origin/${branch}`], { allowFail: true });
const startSha = sh('git', ['-C', worktree, 'rev-parse', 'HEAD']);
const startPr = openPr();
fs.writeFileSync(logFile, '');

// The implementer runs on the agent copied into its worktree, so it must not inherit the reviewer's
// settings (review.mjs, L34) from a session that ran a review: OPENCODE_DISABLE_PROJECT_CONFIG would
// hide that agent, and OPENCODE_CONFIG_DIR would put another in its place.
const { OPENCODE_CONFIG_DIR: _dir, OPENCODE_DISABLE_PROJECT_CONFIG: _off, ...implementEnv } = pre.env;

const patches = [];        // the patches a failed wip commit left instead (#87)
const wips = [];           // the wip commits this run's failed attempts left (L70)
let unpushed = false;      // a save whose push failed: the work is in the worktree only
let attemptModel = null;   // the chain key of the attempt whose work a save keeps
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
        args: ocArgs(worktree, impl.agent, model), prompt: brief + resumeBlock(), workDir: worktree, title: `${name}-${m}`,
        startupTimeoutMs: impl.startupTimeoutSec * 1000, idleTimeoutMs: impl.idleTimeoutSec * 1000,
        totalTimeoutMs: impl.totalTimeoutSec * 1000, opencode, env: implementEnv, log: say,
      });
      output = run.output;
      // OpenCode's own error stream on a failed run, never the model's output (Luna's R1, round 2).
      reason = runFailure(run, (stderr) => keyProblem(stderr, model.id, implementEnv.XDG_DATA_HOME));
      const note = deniedNote(run);
      if (note) { say(`${m}: ${note}`); output = `${note}\n${output}`; }
    } catch (e) {
      if (!(e instanceof OpenCodeInfraError)) throw e;
      reason = e.reason;
      output = e.message;
    }
    fs.appendFileSync(logFile, `=== ${m} (${model.id}): ${reason ? `failed: ${reason}` : 'ran'} ===\n${watch ? `${watch}\n` : ''}${output}\n`);
    return reason ? { ok: false, reason } : { ok: true, value: output };
  },
  // A run that opened a PR handed the task over: no other model works on top of it (L12).
  leftWork: async () => {
    const pr = openPr();
    return Boolean(pr && pr !== startPr);
  },
  // Every failed attempt's work is committed and pushed, never reset (L70; #87 before it).
  save: async (r) => {
    const s = saveProgress({ worktree, branch, model: attemptModel, cause: failureClass(r.reason), reason: r.reason, startSha, workRoot, name, keepOut: copied, log: say });
    if (s.commit) wips.push(s.commit.slice(0, 12));
    unpushed = !s.pushed;   // a later push carries the earlier commits
    patches.push(...s.patches);
  },
});

say(`run log: ${logFile}`);
// Every exit after the chain names the wip commits and any patch its saves left (L70, #87; Sol's R3 on PR 100).
// A refused push is named even without a wip commit: the model's own commits are then local only (Luna's R2 on PR 165).
const saved = `${wips.length ? ` The stopped runs' work is on ${branch}: wip commit${wips.length > 1 ? 's' : ''} ${wips.join(', ')}${unpushed ? ', not pushed: it is in the worktree only' : ''}.` : ''}`
  + `${unpushed && !wips.length ? ` ${branch} could not be pushed: the run's commits are in the worktree ${worktree} only.` : ''}`
  + `${patches.length ? ` Uncommitted work was saved as a patch: ${patches.join(', ')}.` : ''}`;
const reasons = result.failures.map((f) => `${f.name}: ${f.reason}`).join('; ');
if (!result.ok) {
  if (result.process) {
    die(5, `The run failed through our process (${reasons}).${saved} Read ${logFile}, fix the cause (brief, permissions, agent, runner) and rerun: the rerun resumes ${branch} from the worktree ${worktree}. No fallback to another model (L69).`);
  }
  if (result.leftWork) die(1, `The run failed (${reasons}) after opening a PR for ${branch}; not retrying. The main session decides.${saved}`);
  die(3, `The providers did not respond: ${result.sameCause ? `same failure twice: ${result.sameCause} (${reasons})` : reasons}. ${fallback} It resumes ${branch}.${saved}`);
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
