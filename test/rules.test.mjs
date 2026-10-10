// The rule files' own limits and references: CLAUDE.md's 40 lines and process.md's 150 (this
// repository's CLAUDE.md), every lesson they cite exists, and L38 sits where it is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
const lines = (rel) => read(rel).trimEnd().split('\n').length;
const RULES = ['template/CLAUDE.md', 'template/docs/process.md', 'template/.claude/skills/run-task/SKILL.md',
  'profiles/review/CLAUDE.md', 'profiles/review/docs/review.md'];

test('template/CLAUDE.md keeps to 40 lines and process.md to 150', () => {
  assert.ok(lines('template/CLAUDE.md') <= 40, `template/CLAUDE.md has ${lines('template/CLAUDE.md')} lines`);
  assert.ok(lines('template/docs/process.md') <= 150, `process.md has ${lines('template/docs/process.md')} lines`);
  assert.ok(lines('profiles/review/CLAUDE.md') <= 40);
});

test('every lesson a rule file cites is in template/docs/lessons.md', () => {
  const known = new Set([...read('template/docs/lessons.md').matchAll(/^\| (L\d+) \|/gm)].map((m) => m[1]));
  for (const f of RULES) for (const [l] of read(f).matchAll(/\bL\d+\b/g)) assert.ok(known.has(l), `${f} cites ${l}, which lessons.md lacks`);
});

test('a heavy review moves the implementer up, in both profiles (L38)', () => {
  assert.match(read('template/CLAUDE.md'), /After a heavy\n {3}review, the next round's implementer moves one step up, never down/);
  const step = read('template/.claude/skills/run-task/SKILL.md');
  assert.match(step, /three or more blocking\n\s+findings, or when it brings new blocking findings of a class the previous round raised:\n\s+the same kind of defect again, in new or unchanged code/);
  // Decided before the round that returns to step 1 (Sol's R1 on PR 44).
  assert.ok(step.indexOf('A heavy review moves the implementer up') < step.indexOf('Set the next round and return to step 1'));
  assert.match(step, /the class and the finding ids of\n\s+both rounds/);
  assert.match(step, /a light OpenCode model → a\s+heavy one → a Claude Opus agent/);
  assert.match(step, /The round count does not reset/);
  assert.match(step, /to weigh, never to apply blindly/);
  assert.match(read('profiles/review/CLAUDE.md'), /there is no stronger implementer than Opus/);
  // At the top, every place says the same: fix the class, and change the approach when the class needs it (Sol's R2 on PR 44).
  for (const f of ['profiles/review/CLAUDE.md', 'profiles/review/docs/review.md', 'docs/models.md', 'template/docs/lessons.md', 'template/.claude/skills/run-task/SKILL.md']) {
    assert.match(read(f).replace(/\s+/g, ' '), /changes? the approach when the class needs it/, f);
    assert.doesNotMatch(read(f).replace(/\s+/g, ' '), /, or changes? the approach/, f);
  }
});

test('Sol runs at low or medium effort, never high, and only by --sol: the hard chain starts with GLM-5.3 (L39, L41)', () => {
  const c = JSON.parse(read('template/harness.json'));
  for (const m of ['sol', 'sol-6.1']) assert.ok(['low', 'medium'].includes(c.models[m].variant), `${m} at ${c.models[m].variant}`);
  assert.deepEqual(c.reviewer.hard, ['glm', 'mm-m3', 'mimo-pro', 'luna']);   // mm-m3 second since 2026-10-06, the owner's call
  assert.equal(c.reviewer.sol, 'sol-6.1');
});

test('measurements are committed and pushed as made, never deleted, in every brief that measures (L40)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  const line = /If you measure: every output a finding or the PR may cite goes under a tracked path the task owns, pushed per batch and every 30 min, never deleted or overwritten; originals out, hashes recorded\. \(L40\)/;
  assert.match(flat('template/docs/process.md'), line);                     // §4, the brief every task gets
  assert.match(flat('template/.claude/agents/implementer.md'), line);
  assert.match(flat('template/CLAUDE.md'), /\[research repo, or any task that measures\] Commit and push without asking\. Measurements go to a tracked path the task owns, per batch and every 30 min, never deleted or overwritten; originals out, hashed\. \(L40\)/);
  assert.match(flat('template/CLAUDE.md'), /a `\[designed\]` value says what search came up empty/);
  assert.match(flat('template/docs/tasks/TEMPLATE.md'), /A task that measures owns a tracked path for its outputs/);
});

test('the default implementer is GLM-5.3 Flash, then MiMo V2.6 Flash, then Sonnet; GLM-5.3 Flash stays on watch (L42)', () => {
  const c = JSON.parse(read('template/harness.json'));
  assert.deepEqual(c.implementer.chain, ['glm-flash', 'mimo-flash']);
  assert.equal(c.implementer.claudeFallback, 'sonnet');
  assert.equal(c.models['glm-flash'].id, 'zai-coding-plan/glm-5.3-flash');
  assert.ok(c.models['glm-flash'].watch, 'glm-flash keeps its watch note');
  // The documents name no default model any more: /recommend gives it (L72 corrects L42).
  assert.match(read('template/docs/lessons.md'), /^\| L42 \| [^|]*\(corrected by L72: /m);
});

test('DeepSeek is named by no harness.json, profile or default doc; MiMo takes its places (L67)', () => {
  const c = JSON.parse(read('template/harness.json'));
  const p = JSON.parse(read('profiles/review/profile.json'));
  for (const [f, text] of [['template/harness.json', read('template/harness.json')], ['harness.json', read('harness.json')],
    ['profiles/review/profile.json', read('profiles/review/profile.json')]]) {
    for (const [name, m] of Object.entries(JSON.parse(text).models ?? {})) assert.doesNotMatch(`${name} ${m.id}`, /deepseek/i, f);
    assert.doesNotMatch(JSON.stringify([JSON.parse(text).implementer, JSON.parse(text).reviewer, JSON.parse(text).chooser, JSON.parse(text).harness]), /deepseek/i, f);
  }
  assert.deepEqual(c.models['mimo-flash'], { ...c.models['mimo-flash'], id: 'opencode-go/mimo-v2.6-flash', family: 'mimo' });
  assert.deepEqual(c.models['mimo-pro'], { ...c.models['mimo-pro'], id: 'opencode-go/mimo-v2.6-pro', family: 'mimo' });
  assert.ok(!('variant' in c.models['mimo-flash']) && !('variant' in c.models['mimo-pro']), 'MiMo offers no variants');
  assert.deepEqual(c.reviewer.hard, ['glm', 'mm-m3', 'mimo-pro', 'luna']);
  assert.deepEqual(p.harness.reviewer.chain, ['glm-flash', 'luna', 'mimo-flash']);
  for (const f of ['template/docs/process.md', 'template/docs/environment.md', 'template/docs/tasks/TEMPLATE.md', 'profiles/review/docs/review.md',
    'template/.claude/skills/delegate/SKILL.md', 'template/.claude/skills/run-task/SKILL.md', 'template/.claude/skills/switch-model/SKILL.md']) {
    assert.doesNotMatch(read(f), /deepseek/i, f);
  }
  assert.match(read('template/docs/lessons.md'), /^\| L67 \| DeepSeek \(V4 Pro, V4\.1 Flash\) is not used on any route/m);
});

test('Isle Wars\' process rules are in every copy that carries them (L44, L45, L46)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  const brief = /Build only what the task asks for, even inside a file it requires; say why for each changed file\. \(L44\)/;
  for (const f of ['template/docs/process.md', 'template/.claude/agents/implementer.md']) assert.match(flat(f), brief, f);
  const check = /Every changed file and behaviour is one the task asks for \(L44\)/;
  for (const f of ['template/docs/process.md', 'template/.claude/agents/reviewer.md']) assert.match(flat(f), check, f);
  const p = flat('template/docs/process.md');
  assert.match(p, /The main session runs each line before dispatch: it fails on `main` and passes on a mock fix\. \(L45\)/);
  assert.match(p, /Before a merge the main session re-runs the check the approval rests on most; a different result is rework\. \(L46\)/);
  assert.match(p, /a heavier tier only with the reason in the task file \(L46\)/);
  assert.match(p, /a failure in a real run, or the owner's decision with its basis/);
  const s = flat('template/.claude/skills/run-task/SKILL.md');
  assert.match(s, /it must fail on `main` and pass on a mock fix .* \(L45\)/);
  assert.match(s, /Re-run the check the approval rests on most .* A different result is rework, not a merge \(L46\)\. 3\. `gh pr merge/);
  assert.match(flat('template/docs/tasks/TEMPLATE.md'), /A heavier tier than the task needs: the reason here \(L46\)/);
});

test('the main session watches background work, and never waits on pgrep -f (L48)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/docs/process.md'), /It watches each background job \(start, end, no output for 10 min\), never with `pgrep -f`\. \(L48\)/);
  const s = flat('template/.claude/skills/run-task/SKILL.md');
  assert.match(s, /\*\*Watching background work \(L48\)\.\*\* .* flags a job whose log or output file has not grown for 10 minutes/);
  assert.match(s, /Never wait with `while pgrep -f '<pattern>'`: the waiting shell's command line contains the pattern, so it matches itself/);
  assert.match(s, /wait on the PID with `while kill -0 <pid>`/);
  assert.match(s, /with `run_in_background`, and watch it \(below\); never poll with sleep/);
});

test('a model is chosen after a look at its provider\'s quota, and an exhausted one skipped (L50)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  for (const f of ['template/docs/environment.md', 'profiles/review/docs/environment.md']) {
    const e = flat(f);
    assert.match(e, /## Quota: quota-tracker/, f);
    assert.match(e, /`curl -s 'localhost:8765\/recommend\?tier=heavy'` \(or `tier=light`\): which model to use\..*`curl -s localhost:8765\/avoid`/, f);
    assert.doesNotMatch(e, /`curl -s localhost:8765\/best`/, f);   // the owner, 2026-10-08: headroom ranks mislead
    assert.match(e, /Never read or edit `~\/\.config\/quota-tracker\/config\.toml`: it holds account tokens\./, f);
    assert.match(e, /Read which pools exist from the windows the endpoint returns, not from this page\./, f);
  }
  // The review profile's logins table keeps its header after the quota section (PR 75 dropped it).
  assert.match(read('profiles/review/docs/environment.md'), /\n## The logins, one per reviewer\n\n\| Reviewer \| Login \| Check \|/);
  assert.match(read('template/docs/lessons.md'), /^\| L50 \| Before choosing, recommending or delegating to a model, the main session checks the providers' quota/m);
});

test('the scripts skip an exhausted provider themselves, and no chain is edited to pause one (L52)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  for (const f of ['template/docs/environment.md', 'profiles/review/docs/environment.md']) {
    assert.match(flat(f), /`implement\.mjs` and `review\.mjs` ask the service themselves before their chain runs \(`lib\/quota\.mjs`, L52\)/, f);
  }
  assert.match(read('template/docs/lessons.md'), /^\| L52 \| `implement\.mjs` and `review\.mjs` check quota themselves/m);
});

test('Luna draws on OpenAI\'s main quota; the guides leave quota to /recommend (L65, corrected by L72)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  for (const f of ['template/docs/environment.md', 'profiles/review/docs/environment.md']) {
    assert.match(flat(f), /These are for reading, never for choosing: `\/recommend` weighs them\. GPT-5\.6 Luna has no window of its own: it draws on OpenAI's main quota, like Sol\./, f);
    assert.doesNotMatch(read(f), /gpt-5\.6-luna:7d|headroom_pct|negative means/, f);
  }
  assert.match(read('template/docs/lessons.md'), /^\| L65 \| Every model is judged on its provider's main quota, GPT-5\.6 Luna included\./m);
});

test('a guard\'s tests are pushed to the task branch before dispatch, one Done-when line per constraint (L64)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/docs/process.md'), /For a guard \(a gate, check or tool whose failure lets a protected rule be bypassed\), each constraint it enforces is its own numbered line, and the main session pushes the guard's tests to the task branch before dispatch, one mutation test per bypass class the design predicts, failing until the guard lands\. \(L64\)/);
  assert.match(read('template/docs/lessons.md'), /^\| L64 \| For a guard \(a gate, check or tool whose failure lets a protected rule be bypassed\)/m);
});

test('a delegated run\'s final message is read before it is retried, re-routed or called a failure (L55)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/CLAUDE.md'), /8\. Relay review findings in full\. Read a run's final message before you retry or re-route it \(L55\)\./);
  const s = flat('template/.claude/skills/run-task/SKILL.md');
  assert.match(s, /\*\*Read before you retry \(L55\)\.\*\* Before a retry, a re-route to another model, or calling a run a failure, read what it returned; never retry blind\./);
  assert.match(s, /\?mode=ro'/);
  assert.match(s, /os\.environ\.get\('HARNESS_OPENCODE_HOME'\)/);                       // where the runner put it (Luna's R1)
  assert.match(s, /select data from part where session_id=\? order by time_created/);
  assert.match(s, /A run that stopped and reported gets an answer to its report \(amend the task, decide, or escalate\), and the report is posted on the task's issue/);
  assert.match(read('template/docs/lessons.md'), /^\| L55 \| Before a delegated run is retried, re-routed to another model, or called a failure, its final message is read/m);
});

test('a task that would outlast one run, or whose Done-when is all or nothing, is split into milestones (L58)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  const p = flat('template/docs/process.md');
  assert.match(p, /a task likely to outlast one implementer run \(about an hour\), or whose Done-when is all or nothing \(an exact match, a whole model\), is split into tasks that each merge on their own: the static reading, any tool that produces ground truth, then the deliverable piece by piece\. A milestone's Done-when measures progress as a number \(records matched, first divergent minute\), committed with each push, so a resumed run starts from it; the boundary sits where the evidence already has a number, not at an arbitrary half of the scope\. \(L58\)/);
  assert.match(flat('template/docs/tasks/TEMPLATE.md'), /A task likely to outlast one implementer run \(about an hour\), or whose Done-when is all or nothing \(an exact match, a whole model\), is split into milestone tasks first, each merging on its own with a Done-when that measures a number \(L58\)/);
  const l = read('template/docs/lessons.md');
  assert.match(l, /^\| L58 \| A task likely to outlast one implementer run \(about an hour\), or whose Done-when is all or nothing \(an exact match, a whole model\), is split into tasks that each merge on their own: the static reading \(a finding's first part\), any tool that produces ground truth, then the deliverable piece by piece\./m);
  assert.match(l, /A milestone's Done-when measures progress as a number \(the records matched, the first divergent minute\), committed with each push, so a resumed run starts from it\. The boundary sits where the evidence already has a number \(a count of matching records, a minute index\), not at an arbitrary half of the scope/m);
});

test('the git run rule is scoped to the reviewer\'s own worktree; a pinned outside repo is git -C exactly as written (L61)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  for (const f of ['template/.opencode/agents/reviewer.md']) {
    assert.match(flat(f), /That rule governs your own worktree only \(L61\): a brief may send git at a pinned repository outside it \(`git -C <path> show <pin>:<file>`\) — run that exactly as written, for OpenCode does not path-check `git -C`/);
  }
  assert.match(read('template/docs/lessons.md'), /^\| L61 \| A reviewer's "run git without -C, and never type that path" rule governs its own worktree only/m);
  assert.match(read('template/.opencode/agents/reviewer.md'), /A pinned outside repository in\s+the brief/);
  // The contradiction Luna flagged (round 2 R2): the worktree rule no longer says "no ... other
  // worktree" without the git-C exception — the L61 clause must be the same scope, with a
  // explicit reference to a pinned outside repository as the exception.
  const flatR = read("template/.opencode/agents/reviewer.md").replace(/\s+/g, " ");
  assert.match(flatR, /The git rule above .no -C, never type that path. is the same scope \(L61\)/);
  // .gitignore must hide .bak files: a plain status of a real .claude/*.bak shows nothing.
  // .gitignore must hide .bak files: a plain status of a real .claude/*.bak shows nothing.
  const gi = fs.existsSync(path.join(repo, ".gitignore")) ? fs.readFileSync(path.join(repo, ".gitignore"), "utf8") : "";
  assert.match(gi, /^\.claude\/\*\.bak$/m);
  assert.match(read('template/docs/lessons.md'), /external_directory` is a coarse guard, not a sandbox/m);
});

test('a brief passes by file in the worktree, never the command line (L60)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  const line = /When the run's first message names a `\.harness-brief-\*\.md` file at the worktree root, that file is your whole brief: read it in full before anything else and follow it exactly; never edit, commit or delete it \(L60\)\./;
  for (const f of ['template/.opencode/agents/implementer.md', 'template/.opencode/agents/reviewer.md']) assert.match(flat(f), line, f);
  assert.match(read('template/docs/lessons.md'), /^\| L60 \| A brief passes by file, never the command line: the runner writes the whole prompt to `\.harness-brief-<title>\.md` at the run worktree's root/m);
  assert.match(read('template/docs/lessons.md'), /on failure moved into the log directory as `<title>\.brief\.md` and named among the kept files — discarded, never left in the worktree, if neither rename nor copy can keep it/m);
  // environment.md keeps Alibaba's pool and the MiniMax Token Plan's apart (Luna's round-2 R2, PR 115;
  // 2026-10-07: Alibaba's pool is unmonitored, but the two are still described separately, and the
  // section actually says so — otherwise reverting the new sentence to the old "one credit pool …"
  // one would still pass).
  assert.match(read('template/docs/environment.md'), /Alibaba's Token Plan \(Qwen and GLM;\s+its Kimi and MiniMax models are Team-edition only and unused\)/);
  assert.match(read('template/docs/environment.md'), /Alibaba's Token Plan is no longer in quota-tracker/);
  assert.match(read('template/docs/environment.md'), /`minimax` \(the MiniMax Token Plan's own pool\)/);
});

// The owner's section, verbatim (2026-10-04); every brief carries it in full (L49).
const ONE_PASS = `## Report every blocking finding in this one review

This review is your only pass before the author fixes. Do not stop at the first blocking
finding: finish reading the whole diff and the task file, check every Done-when line and
every item under "Blocking means", and report all blocking findings together.

- Before you write the verdict, make one last pass over the full diff for anything you have
  not yet rated, and say "Final pass done" as the last line before the verdict.
- Number the findings R1, R2, … in order of severity. A finding you held back because an
  earlier one was already blocking is a review defect: if two problems share a cause, list
  both and say so.
- Do not rely on a later round. The author fixes everything you list, and the next review
  checks those fixes and new code only, not anything you saw but did not report.
- If you ran out of time or context before covering the whole diff, say which files or
  sections you did not cover. Do not approve in that case.`;
const OPENCODE_BULLET = `- Report every blocking finding in this one review (L49). It is your only pass before the author
  fixes: do not stop at the first blocking finding; read the whole diff and the task file, check
  every Done-when line and every item under "Blocking means", and report all blocking findings
  together, numbered R1, R2, … in order of severity. A finding held back because an earlier one
  was already blocking is a review defect; if two share a cause, list both and say so. Do not rely
  on a later round: it checks the fixes and new code only. Before the verdict, make one last pass
  over the full diff and write "Final pass done" as the last line before it. If you did not cover
  the whole diff, name what you left out, and do not approve.`;
const OUTPUT_RULE = `- Report every blocking finding in this one review, not one per round: read the whole diff, then
  make a final pass and write "Final pass done" as the line before the closing verdict. Name any
  part you did not cover, and do not approve then (L49).`;
const STOP_RULE = `A reviewer that reports one blocking finding per round despite the brief's one-pass
        section (L49): after the second such round, stop. Request no further review until you
        have gone through the whole diff yourself for that class and fixed what you found, and
        recorded the pattern in the model-trials record. The review after that is the task's last
        before escalation (step 5).`;
const flatten = (s) => s.replace(/\s+/g, ' ');
const holds = (f, text) => assert.ok(flatten(read(f)).includes(flatten(text)), `${f} lacks: ${flatten(text).slice(0, 80)}…`);

test('every review brief and reviewer is told to report every blocking finding in one review, in full (L49)', () => {
  for (const f of ['template/docs/review-brief.md', 'profiles/review/docs/review.md']) {
    holds(f, ONE_PASS);
    holds(f, '## Blocking means\n\nAny one is enough; a blocking finding means rework, never approve.');
  }
  holds('template/.claude/agents/reviewer.md', ONE_PASS.replace('## Report every blocking finding in this one review', '**Report every blocking finding in this one review** (L49).'));
  holds('template/.opencode/agents/reviewer.md', OPENCODE_BULLET);
  holds('template/tools/harness/review.mjs', OUTPUT_RULE);
  holds('template/.claude/skills/run-task/SKILL.md', STOP_RULE);
  for (const f of ['template/docs/process.md', 'template/.claude/agents/reviewer.md']) {
    holds(f, '6. <docs/review-brief.md in full: "Blocking means" for this task, then its one-pass section (L47, L49)>');
    holds(f, '2. [evidence-driven] Every constant traces to a fixture, report or investigation; a [designed] one says what was searched.');
  }
});

test('the review profile stops a review cycle after a second one-blocker round, and its prose lines fit the page (L49, #71)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('profiles/review/CLAUDE.md'), /A reviewer that reports one blocking finding per round despite the brief's one-pass section: after the second such round, stop\. No further review until you have swept the whole diff for that class, fixed what you found, and recorded the pattern in the model-trials record \(create one if there is none\); the review after that is the last before escalation\. \(L49\)/);
  assert.match(flat('profiles/review/docs/review.md'), /reviewer that still reports one blocking finding per round: after the second such round, stop, sweep the whole diff for that class yourself, fix it and record the pattern in the model-trials record \(create one if there is none\) before the next review, which is the last before escalation \(`CLAUDE\.md` rule 5, L49\)/);
  for (const f of ['profiles/review/CLAUDE.md', 'profiles/review/docs/review.md']) {
    const long = read(f).split('\n').filter((l) => l.length > 105 && !l.startsWith('|'));
    assert.deepEqual(long, [], `${f}: lines past 105 characters`);
  }
});

// The two agent roles have different rules (edit: allow vs. deny, etc.), so the four agent
// files form two mirror pairs, not one set. Each role's template + root mirror must be byte-equal;
// every one of the four matches the current rule set: `/tmp/opencode/*: allow`. OpenCode 1.18.34
// forces tool-output writes there; the deny was killing runs and losing work (#144). The test pins
// both halves so a future drift (L66a's per-run allow landing on top, a reviewer rewriting just
// one mirror, etc.) cannot reintroduce the deny or break byte-equality without tripping the pin.
test('each role\'s two mirror agent files are byte-equal and every agent carries /tmp/opencode/*: allow (L43 correction, #144)', () => {
  const pairs = [
    ['template/.opencode/agents/implementer.md', '.opencode/agents/implementer.md'],
    ['template/.opencode/agents/reviewer.md',   '.opencode/agents/reviewer.md'],
  ];
  for (const [a, b] of pairs) {
    const ta = read(a), tb = read(b);
    assert.equal(tb, ta, `${b} drifted from ${a}`);
    assert.match(ta, /^\s*"\/tmp\/opencode\/\*": allow/m, `${a}: the opencode rule is : allow`);
    assert.doesNotMatch(ta, /^\s*"\/tmp\/opencode\/\*": deny/m, `${a}: the opencode rule is not : deny`);
    assert.match(tb, /^\s*"\/tmp\/opencode\/\*": allow/m, `${b}: the opencode rule is : allow`);
    assert.doesNotMatch(tb, /^\s*"\/tmp\/opencode\/\*": deny/m, `${b}: the opencode rule is not : deny`);
  }
});

// L66a (#138): the agent files allow exactly OpenCode's tool output and the null device, and no
// harness-run path: each run's own folder is allowed in its per-run copy only (lib/opencode.mjs). The
// null device by identity: `cp a /dev/null` asks for `/dev/*` (an exact `/dev/null` never matches), and
// `/dev/*` alone also admitted `/dev/shm`, a writable tmpfs, so `/dev/*/*` is denied after it (Sol's R1,
// PR 152): a device node directly in /dev passes, nothing below it does;
// Windows' NUL is `\\.\NUL`, which OpenCode matches as `//./NUL`; `??.?NUL*` also matched the
// directory `/a.bNUL-other/*` (Sol's R1, PR 137 round 2). Probed on OpenCode 1.18.34, 2026-10-09.
test('the agent files allow exactly /tmp/opencode, /dev (not below it) and //./NUL outside the worktree, and send scratch to the run\'s folder (L66)', () => {
  for (const f of ['template/.opencode/agents/implementer.md', '.opencode/agents/implementer.md',
    'template/.opencode/agents/reviewer.md', '.opencode/agents/reviewer.md']) {
    const text = read(f);
    const block = /\n  external_directory:\n((?: {4}.*\n)*)/.exec(text)?.[1];
    assert.equal(block, '    "/tmp/opencode/*": allow\n    "/dev/*": allow\n    "/dev/*/*": deny\n    "//./NUL*": allow\n', f);
    assert.equal(text.match(/^  external_directory:/gm).length, 1, `${f}: one external_directory block`);
    assert.match(text.replace(/\s+/g, ' '), /Stay inside your worktree and your scratch folder: no other temp directory/, f);
  }
  assert.match(read('template/.opencode/agents/implementer.md').replace(/\s+/g, ' '), /Scratch files go in the scratch folder the brief's pointer names \(also \$TMPDIR\), never in another \/tmp path \(L66\)/);
});

test('a denied call fails a run only past a threshold, and every text says so (L68, #146)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/docs/process.md'), /A denied tool call fails the run only when it ends the run, recurs, or is the third \(L26, L68\)/);
  assert.match(read('template/docs/lessons.md'), /^\| L68 \| A denied tool call \(an auto-rejection or a rule's deny\) fails a run only when/m);
  assert.match(read('template/docs/lessons.md'), /^\| L26 \| .*Correction 2026-10-09 \(L68\)/m);
  for (const f of ['template/.opencode/agents/implementer.md', 'template/.opencode/agents/reviewer.md']) {
    assert.match(flat(f), /You see the denial and may correct that call once, but the same call denied twice, or a third denied call, (fails the run|discards the review) \(L68\)/, f);
  }
  assert.doesNotMatch(flat('README.md'), /A rejected tool call is a failure\./);
});

// Implementer git denies are narrowed to the patterns OpenCode 1.18.34's matcher actually
// honours (#145): trailing-space-star (`"git push --force *"`) catches `--force` bare, with
// args, and with `--dry-run`, but NOT `--force-with-lease` (single token, no space). Bare-form
// `"git push --force"` was bypassed by any args. Broad patterns `"--force*"` and `"stash*"`
// were catching safe alternatives. `task: "*": deny` was dropped: chain models don't use OpenCode's
// `Task` tool. The deny set keeps the safety net without killing safe probes.
test('implementer agent-file denies are narrowed: trailing-space-star with-args, no broad pattern, no task deny (#145)', () => {
  const files = ['template/.opencode/agents/implementer.md', '.opencode/agents/implementer.md'];
  for (const f of files) {
    const text = read(f);
    // Force-push denies use trailing-space-star: matches `git push --force` bare, with args,
    // and with `--dry-run`, but not `--force-with-lease` (probed on OpenCode 1.18.34).
    assert.match(text, /^ {4}"git push --force \*": deny$/m, `${f}: trailing-space-star deny on git push --force *`);
    assert.match(text, /^ {4}"git push -f \*": deny$/m, `${f}: trailing-space-star deny on git push -f *`);
    // The OLD broad patterns (`--force*` no-space, `-f *` no-space, `stash*`) are gone. Each
    // old rule has the same ASCII form as the new one for adjacent lines; the test asserts on
    // exact-form strict (`deny$`) where no trailing-space was the bug, on the row that
    // proved fatal under probing.
    assert.doesNotMatch(text, /^ {4}"git stash\*": deny$/m, `${f}: no "git stash*" (matches reads)`);
    assert.doesNotMatch(text, /^ {4}"git -C \* stash\*": deny$/m, `${f}: dead-weight proxy dropped`);
    // Stash denies: bare `git stash` (aliases to push) and trailing-space-star on `git stash push`.
    assert.match(text, /^ {4}"git stash": deny$/m, `${f}: deny git stash (bare — equivalent to push)`);
    assert.match(text, /^ {4}"git stash push \*": deny$/m, `${f}: deny git stash push * (bare + args)`);
    // Force-push with `-C` keeps the same trailing-space-star narrowing.
    assert.match(text, /^ {4}"git -C \* push --force \*": deny$/m, `${f}: deny git -C * push --force *`);
    assert.match(text, /^ {4}"git -C \* push -f \*": deny$/m, `${f}: deny git -C * push -f *`);
    // `task: "*": deny` dropped.
    assert.doesNotMatch(text, /^ {2}task:\n {4}"\*": deny$/m, `${f}: task deny dropped — chain models do not use OpenCode's Task tool`);
  }
});

test('a failed run is fixed, never routed around: only a provider that did not respond moves on (L69)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/CLAUDE.md'), /A failed run is fixed, never routed around: only a provider that did not respond moves on \(L69\)\./);
  const p = flat('template/docs/process.md');
  assert.match(p, /The chain moves on only when the provider did not respond and the run opened no PR\. \(L12, L69\)/);
  assert.match(p, /3: no provider responded; Claude Sonnet takes it\. 5: our process or setup failed; fix, rerun\. \(L69\)/);
  assert.match(flat('template/.claude/skills/run-task/SKILL.md'), /Exit 5: our process or setup failed: .* Never a fallback: find the cause .* then rerun; the rerun resumes the branch the run left\. \(L69\)/);
  assert.match(read('template/docs/lessons.md'), /^\| L69 \| A failed run moves to the next model only when its provider did not respond/m);
  assert.doesNotMatch(flat('template/.claude/skills/run-task/SKILL.md'), /Exit 3: OpenCode unavailable/);
});

test('a run never loses its work: wip commits, steps that name the next one, and a brief that resumes (L70)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/docs/process.md'), /A stopped run's work is a pushed `wip:` commit, never reset; the next run's brief lists the branch's commits to resume from\. \(L70\)/);
  assert.match(read('template/docs/lessons.md'), /^\| L70 \| A run never loses its work when it stops\./m);
});

test('the lessons L69 and L70 narrow or replace say so on their own rows (Luna\'s R3 on PR 165)', () => {
  const l = read('template/docs/lessons.md');
  assert.match(l, /^\| L12 \| [^|]*\(narrowed by L69 and L70: only a provider that did not respond moves on/m);
  assert.match(l, /^\| L28 \| [^|]*\(narrowed by L69: no review at all is our failure, exit 5\)/m);
  assert.match(l, /^\| L56 \| [^|]*\(replaced by L70: a pushed `wip:` commit, never a reset\)/m);
});

test('the main session tells the owner what the delegated runs are doing (L71)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/.claude/skills/run-task/SKILL.md'), /\*\*Telling the owner \(L71\)\.\*\* For implement and review runs, the watch is `node tools\/harness\/agents\.mjs --watch --until-done` under Monitor/);
  assert.match(read('template/docs/lessons.md'), /^\| L71 \| The owner is told what the delegated runs are doing\./m);
});

test('model choice follows /recommend and nothing else: the owner\'s rules word for word wherever agents read them (L72, #168)', () => {
  // The rules as the owner wrote them in #168: the root CLAUDE.md's "## Choosing models" section.
  const root = read('CLAUDE.md');
  const rules = root.slice(root.indexOf('## Choosing models\n'));
  assert.match(rules, /^## Choosing models\n\n1\. Ask the quota service with the tier the work needs:/);
  assert.match(rules, /3\. A review on its own \(the implementation was done earlier\): add\n {3}`&exclude_family=<the implementer's family>` and use `pick`\./);
  assert.match(rules, /6\. Nothing else decides which model to use: no lists, chains, exclusions, score thresholds\n {3}or percentages of your own\./);
  assert.match(rules, /8\. If the service doesn't answer: run `systemctl --user restart quota-tracker` in WSL and\n {3}retry\. If it still doesn't answer, tell the owner; don't choose a model yourself\.\n$/);
  const body = rules.split('\n').slice(2).join('\n');
  assert.match(body, /^1\. Ask the quota service/);
  // Each copy is exactly the rules: from "1. Ask" to the end of rule 8, then nothing but the end of
  // the file (AGENTS.md) or the next section (the skill), so no rule can be added or changed there (Luna's R1 on PR 169).
  const copy = (text, until) => { const i = text.indexOf('1. Ask the quota service'); const j = until ? text.indexOf(until, i) : text.length; return i < 0 || j < 0 ? null : text.slice(i, j).trimEnd() + '\n'; };
  for (const f of ['AGENTS.md', 'template/AGENTS.md']) assert.equal(copy(read(f)), body, `${f} carries the rules word for word, and nothing after them`);
  assert.equal(copy(read('template/.claude/skills/delegate/SKILL.md'), '\n## Picking a media model'), body, 'the delegate skill carries the rules word for word');
  assert.equal(copy(root), body, 'the root CLAUDE.md ends with the rules');
  assert.match(read('template/CLAUDE.md'), /on the models `\/recommend` gives, nothing else \(L72\)/);
  assert.match(read('template/docs/lessons.md'), /^\| L72 \| Model choice follows quota-tracker's `\/recommend`, and nothing else/m);
  for (const n of ['L39', 'L41', 'L50', 'L51', 'L52', 'L65']) assert.match(read('template/docs/lessons.md'), new RegExp(`^\\| ${n} \\| [^|]*\\(corrected by L72: `, 'm'), n);
  for (const f of ['template/.claude/skills/delegate/SKILL.md', 'template/docs/process.md', 'template/docs/tasks/TEMPLATE.md']) {
    assert.doesNotMatch(read(f), /next model of its chain|GLM-5\.3 Flash, then MiMo|GPT-5\.6 Luna on OpenAI, through OpenCode \(default\)|`glm-flash`, then `mimo-flash`/, f);   // Luna's R2, R3
  }
  assert.doesNotMatch(read('CLAUDE.md'), /which pair for which work/);   // Luna's R4
});
