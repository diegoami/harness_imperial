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
  assert.deepEqual(c.reviewer.hard, ['glm', 'deepseek-pro', 'luna']);
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

test('the default implementer is GLM-5.3 Flash, then DeepSeek V4.1 Flash, then Sonnet; GLM-5.3 Flash stays on watch (L42)', () => {
  const c = JSON.parse(read('template/harness.json'));
  assert.deepEqual(c.implementer.chain, ['glm-flash', 'deepseek-flash']);
  assert.equal(c.implementer.claudeFallback, 'sonnet');
  assert.equal(c.models['glm-flash'].id, 'zai-coding-plan/glm-5.3-flash');
  assert.ok(c.models['glm-flash'].watch, 'glm-flash keeps its watch note');
  for (const f of ['template/docs/process.md', 'template/docs/tasks/TEMPLATE.md', 'README.md']) {
    assert.match(read(f).replace(/\s+/g, ' '), /GLM-5\.3 Flash|`glm-flash`, then `deepseek-flash`/, f);
  }
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
  assert.match(p, /a heavier model only with the reason in the task file \(L46\)/);
  assert.match(p, /a failure in a real run, or the owner's decision with its basis/);
  const s = flat('template/.claude/skills/run-task/SKILL.md');
  assert.match(s, /it must fail on `main` and pass on a mock fix .* \(L45\)/);
  assert.match(s, /Re-run the check the approval rests on most .* A different result is rework, not a merge \(L46\)\. 3\. `gh pr merge/);
  assert.match(flat('template/docs/tasks/TEMPLATE.md'), /A model heavier than the default: the reason here \(L46\)/);
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
  assert.match(flat('template/docs/process.md'), /after a look at the provider's quota: skip an exhausted one for the next with quota, saying so \(L50\)/);
  assert.match(flat('template/.claude/skills/delegate/SKILL.md'), /\*\*Check the quota first\*\* \(L50\)\. .*`curl -s localhost:8765\/avoid` .* Skip a model whose provider is `exhausted`: name the next model of its chain that has quota/);
  assert.match(flat('profiles/review/CLAUDE.md'), /Check the quota first \(`docs\/environment\.md`\): skip an exhausted reviewer with `--reviewer` on the next one of the chain that has quota, and say so in the PR\. \(L50\)/);
  for (const f of ['template/docs/environment.md', 'profiles/review/docs/environment.md']) {
    const e = flat(f);
    assert.match(e, /## Quota: quota-tracker/, f);
    assert.match(e, /`curl -s localhost:8765\/best`.*`curl -s localhost:8765\/avoid`/, f);
    assert.match(e, /Never read or edit `~\/\.config\/quota-tracker\/config\.toml`: it holds account tokens\./, f);
    assert.match(e, /Read which pools exist from the windows the endpoint returns, not from this page\./, f);
  }
  // The review profile's logins table keeps its header after the quota section (PR 75 dropped it).
  assert.match(read('profiles/review/docs/environment.md'), /\n## The logins, one per reviewer\n\n\| Reviewer \| Login \| Check \|/);
  assert.match(read('template/docs/lessons.md'), /^\| L50 \| Before choosing, recommending or delegating to a model, the main session checks the providers' quota/m);
});

test('the scripts skip an exhausted provider themselves, and no chain is edited to pause one (L52)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  assert.match(flat('template/.claude/skills/delegate/SKILL.md'), /Both scripts also skip such a model themselves and log why \(L52\); never pause a provider by editing `harness\.json` for quota\./);
  for (const f of ['template/docs/environment.md', 'profiles/review/docs/environment.md']) {
    assert.match(flat(f), /`implement\.mjs` and `review\.mjs` ask the service themselves before their chain runs \(`lib\/quota\.mjs`, L52\)/, f);
  }
  assert.match(read('template/docs/lessons.md'), /^\| L52 \| `implement\.mjs` and `review\.mjs` check quota themselves/m);
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
  assert.match(flat('template/docs/tasks/TEMPLATE.md'), /is split into milestone tasks first, each merging on its own with a Done-when that measures a number \(L58\)/);
  assert.match(read('template/docs/lessons.md'), /^\| L58 \| A task likely to outlast one implementer run/m);
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
