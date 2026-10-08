# Process

`CLAUDE.md` holds the rules, this file how they run, `/run-task` the procedure; each rule cites its lesson.

## 0. Order of work

1. **Evidence first** (for a rebuild): decode, decompile, and write the design with every claim tagged `[confirmed]`, `[derived]` or `[designed]`.
2. **A walking skeleton before the fan-out**: scaffolding, the seams the rules plug into, one rule end to end, a CLI, and a thin screen a person can use. (L1)
3. **The fan-out**: rules behind the seams, best-evidenced first.
4. **The first playable build**: once the skeleton exists, the UI chain goes before more rules. Until it ships, only a bug that breaks play is scheduled (crash, stall, unwinnable game, save that will not load, order that can never succeed). (L1)

Tag capability jumps, not phases. Release notes come from GitHub when the tag is cut.

## 1. Roles

| Role | Who | Does |
| --- | --- | --- |
| Main session | Claude, the session the user talks to | Plans, writes task files, runs `/run-task`, triages, merges, reports |
| Implementer | OpenCode GLM-5.3 Flash, then DeepSeek V4.1 Flash, via `tools/harness/implement.mjs`, then a Claude Sonnet agent (L42); a heavier model only with the reason in the task file (L46) | One task, one branch, one PR, in its own worktree |
| Reviewer | OpenCode GPT-5.6 Luna (direct OpenAI, L51) via `tools/harness/review.mjs`, then a Claude Opus agent; never the implementer's family (L27). Exit 3: Opus reviews; exit 4: the main session reads the flagged review and decides (L28) | Re-runs the Done-when, audits scope and evidence, posts one PR comment, applies the label |
| Decider | Jev via `tools/harness/jev.mjs` (the `/jev` skill) | Repeated yes/no decisions over many items, at the confident ends only (§12) |
| Generator | Models on OpenRouter (images, other families) and ElevenLabs (speech, sound, music) | Assets, each committed with a sidecar naming provider, model, prompt, date and cost |

`/delegate` picks the delegate; model ids come from `models.mjs` or `opencode models`, never memory
(L25), after a look at the provider's quota: skip an exhausted one for the next with quota, saying so (L50).
The main session runs `implement.mjs` itself: a wrapper agent would spend tokens watching it.
It watches each background job (start, end, no output for 10 min), never with `pgrep -f`. (L48), and checks quota with `docs/environment.md`'s quota-tracker.

## 2. Task files

`docs/tasks/T<nn>.md`, 150–400 words, from `docs/tasks/TEMPLATE.md`: Kind, Evidence, Owns,
Scope, Done when, Hazards, Implementer, Reviewer, Merge after. Rules:
- **Owns** names directories or files. Go finer only when two tasks run at once in one file: function-level Owns made one project open 27 PRs that only widened a list. (L5)
- **Done when**: each line is one check a command can run. The main session runs each line before dispatch: it fails on `main` and passes on a mock fix. (L45)
- **Milestones**: a task likely to outlast one implementer run (about an hour), or whose Done-when is
  all or nothing (an exact match, a whole model), is split into tasks that each merge on their own:
  the static reading, any tool that produces ground truth, then the deliverable piece by piece. A
  milestone's Done-when measures progress as a number (records matched, first divergent minute),
  committed with each push, so a resumed run starts from it; the boundary sits where the evidence
  already has a number, not at an arbitrary half of the scope. (L58)
- The main session edits task files directly on `main`, the reason in the commit; the reviewer sees it. (L6)

## 3. The loop

`ready → implement → review → approved + green CI → squash merge → follow-up → unblock → report`.
Rework sends the full review back to the same branch, at most two rounds (one for a fix), then
escalates. The implementer script resumes a pushed branch; it never starts over. Before a merge the
main session re-runs the check the approval rests on most; a different result is rework. (L46)

What the implementer script guarantees, and why:
- OpenCode starts with stdin closed; without it a run hangs before it starts. (L10)
- No session in 180 s, no progress in 900 s, or no exit in 3 h kills the run's process tree. (L10)
- The agent is checked on OpenCode's session record (L11); a rejected tool call fails the run. (L26)
- Each OpenCode model runs at effort high, in the scripts' own data directory (L27, L29). The chain moves on only after an infrastructure failure that left no work. (L12)
- Exit 0: a PR is open. 1: the main session reads the log (a stop and report, or an early end).
  3: OpenCode unavailable, its model not listed, or not logged in; Claude Sonnet takes the task.

## 4. The implementer brief

The brief is the task file pasted in full, then this block, then on a rework round the review's URL. The
OpenCode agent file repeats the run mechanics; this block is the contract. A brief never asks an OpenCode
implementer for anything outside its worktree: a line that needs it (a TMPDIR outside every checkout, the
user's install, `.git/info`) is one the main session runs itself (L57).

```text
You implement <T<nn>>. The task file above is the contract.
- Build only what the task asks for, even inside a file it requires; say why for each changed file. (L44)
- A Done-when you cannot meet: stop and report. Never weaken an assertion, skip a test or edit the task file.
- Every new test fails before your change and passes after it; say how you checked.
- If you measure: every output a finding or the PR may cite goes under a tracked path the task owns,
  pushed per batch and every 30 min, never deleted or overwritten; originals out, hashes recorded. (L40)
- A comment that asserts behaviour at an edge comes with the test that visits that edge.
- A defect you find outside the task: report it. A one-file mechanical fix that blocks you may
  ride this PR, declared under Scope in the PR body.
- Update any document your change makes wrong, in this PR. Never write status into a document.
- PR body: Closes #<issue>; Scope (files and why); a fenced block with each Done-when command and
  the tail of its output; Docs changed.
```

## 5. The reviewer brief

```text
<T<nn>> review (<model>)
You review PR #<n> at <sha>. You did not write it. The task file follows.
0. Prove the tree: HEAD is <sha> and the diff against origin/main is the PR's; findings name its files.
1. Re-run every Done-when line yourself, and account for each (L32). The PR's evidence is no proof.
2. [evidence-driven] Every constant traces to a fixture, report or investigation; a [designed] one says what was searched.
3. [seeded] No wall clock, unseeded random or order-dependent iteration in rule code.
4. Every changed file and behaviour is one the task asks for (L44); docs it makes wrong are updated.
5. Sweep the diff: tests that pass with the behaviour deleted (mutate, rebuild clean, re-take any
   negative result), branches no input reaches, edge comments without a test, <project classes>.
6. <docs/review-brief.md in full: "Blocking means" for this task, then its one-pass section (L47, L49)>
Prove each finding (run it, or delete the behaviour and name the test that fails) or label it
unverified. Your final message is the review: the header; the verdict (approve | approve after
named fixes | rework | user decision); per Done-when line `DW<k>: ran <command> → <result>` or
`DW<k>: not run — <reason>`; the findings R1..Rn (file:line, blocking or not); the verdict again
last. Never post it: the script posts it and applies the label.
```

For a Claude reviewer, the main session also runs `/code-review <pr>` on architecture tasks,
always with the PR number: a bare invocation from an agent reviews the wrong tree. (L8)

## 6. Bugs, fixes, triage

Bugs and non-blocking review findings are filed with `triage:needed`: one `T<nn> follow-up` issue
per merge. Triage decides one of:
- **fix**: no ruleset value, fixture value, seeded measurement or golden line changes outside the
  bug's own reproduction. The bug issue is the contract; its Done-when is its reproduction as a
  failing-then-passing test; one review round. (L4)
- **correction task**: anything that changes an outcome.
- **fold** into a task not yet ready, or **close**, with the reason.

Once `breaks-play` is trialled (§12), Jev settles the gate's confident ends; the main session the middle.

## 7. Escalate to the user when

A design question; a Done-when would have to weaken; a third rework round; anything destructive
(force-push, rewriting `main`, deleting an issue); a new external dependency.

## 8. Labels

`task`, `bug`, `fix`, `triage:needed`, `post-playable`,
`status:{ready,in-progress,in-review,rework,approved,blocked,escalated,merged}`,
`review-round:{1,2}`, and `model:<name>` on a PR whose implementer was not the default.

## 9. Measure

After each merge, one PR comment records each Claude agent's token total (from its completion
notice), each OpenCode run's model and duration, and the review rounds. After 10–20 tasks, compare
the rework rate with the baseline in `docs/lessons.md` before changing models. (L13)

## 10. Adding a rule

A rule enters `CLAUDE.md` or this file only with a lesson in `docs/lessons.md`: a failure in a real
run, or the owner's decision with its basis. Plausible rules without either stay out. (L14) A rule may carry a **carve-out**: an addendum that loosens it under named conditions, its wording unchanged, with lettered preconditions (A, B, …) a reviewer checks one by one, a gate in `tools/` that enforces them, and what stays forbidden; a project's `CLAUDE.md` holds the instance. (L63)

## 11. For a reverse-engineering project

- Transcribe every number from the research into one fixtures corpus with provenance, and assert against it: each re-read of a report is another chance to misread it. (L15)
- New evidence runs in two stages: findings to the research repository, then a check of every
  document claim it touches. Each finding is a doc fix, a bug, a task-file edit, or a question for the user; research never decides design. (L16)
- The original files never enter the repository. CI fetches them from a private fixtures
  repository holding the whole corpus; tests find fixtures by name; local tests skip without them. (L17) A *model-driven run* of the original is a carve-out of this (§10): a known-good hash table in a finding, a gate that refuses any run record off that table, then a `model-driven` task (`docs/tasks/TEMPLATE.md`); it corroborates the owner's runs, never replaces them, and what it shows amends `spec/` and `findings/` one claim at a time, never in bulk. (L63)

## 12. Delegating decisions to Jev

Jev takes a decision only when it recurs over many items, its answers are known up front, and a
trial against labels has set its cutoffs, recorded in `harness.json` with the numbers. It answers
the confident ends and the main session the middle; a person's decision outranks both. Without its
key it is off. `/jev` has the procedure. (L24)
