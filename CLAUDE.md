# harness_imperial

This repository is the harness itself, not a project that uses it. `template/` is what a project
copies; `test/` tests the tools against fakes of `opencode` and `gh`.

- Read `README.md` first. `template/docs/lessons.md` is the admission list: a rule enters
  `template/CLAUDE.md` or `template/docs/process.md` only with a lesson (a failure from a real run).
- Keep `template/CLAUDE.md` at 40 lines or fewer and `template/docs/process.md` at 150 or fewer.
- Every behaviour of the runner has a test in `test/`, and each test was checked by breaking the
  behaviour and watching it fail. Do the same for any new one.
- PRs here are reviewed by the harness itself, as in any project: `node template/tools/harness/review.mjs`
  from the root, never by a Claude agent (Claude writes them: the family rule), on the model the
  rules under *Choosing models* below give (a review on its own: rule 3). The root
  `harness.json` and `.opencode/agents/` are copies of the template's; a test keeps them equal.
- `npm test` before every push. Commits and PRs as usual; no status in any document.
- A cloud session here runs `template/.claude/hooks/session-start.sh` (see `.claude/settings.json`):
  it installs OpenCode and `gh` and reports which keys are set (`template/docs/environment.md`).
- `docs/models.md` records the roster (the aliases harness.json maps) and what each model has shown; it decides no model (*Choosing models* below decides),
  and what each model has shown. Update it in the same commit as a model change or a lesson from a run.
- The backlog is this repository's open GitHub issues; the open issue titled "Start here" orders
  them and holds the handover between sessions (status lives on GitHub, never in a file).
- Merge without asking once another family approved the PR's head and every check is SUCCESS.
  There is no branch protection, and `gh pr checks` exits 0 when the test jobs were CANCELLED (PR 99
  merged untested; PR 57 merged red), so gate on
  `gh pr checks <n> --json name,state -q '.[] | select(.state != "SUCCESS")'` printing nothing. Ask the owner for design decisions and for any escalation:
  a third rework round, a weaker Done-when, anything destructive.
- Every review brief carries a "Blocking means" section written for the PR and, pasted in full,
  the "Report every blocking finding in this one review" section of `template/docs/review-brief.md`.
- A message to another project's session carries the owner's words with their force: "the owner
  approved relaying this recommendation" is not "the owner decided". A session's own earlier
  answer from the owner wins until the owner supersedes it.
- Before you retry a delegated run (an OpenCode review here), re-route it, or call it a failure, read
  what it returned: its final message in the session record (`/run-task`, *Read before you retry*;
  L55). Never retry blind.
- The owner's rules for delegated runs, above every other (2026-10-10): a failed run is never
  normal; fix its cause (brief, permissions, runner, process) before running again, and fall back
  to another model only when a provider's API does not respond. A run never loses its work when it
  dies: progress is kept where it survives (pushed commits, a progress log) and the next run resumes
  from it. Monitor every run you start and tell the owner, in plain words, its task, current step
  and progress, on each state change and at least every 30 minutes.
- A run never takes the machine down: delegated runs, and any test run on unreviewed code, go under
  `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 --` (not `ulimit -v`, which breaks
  OpenCode). A kill by the cap is a process flaw to fix, as above (#151).

## Choosing models

1. Ask the quota service with the tier the work needs:
   - `tier=heavy`: implementation work, and hard reviews
   - `tier=light`: small tasks, and simple reviews
   e.g. `curl -s "http://localhost:8765/recommend?tier=heavy"`
2. A task that needs an implementer and a reviewer: one call. The implementer is
   `pair.implementer` and the reviewer is `pair.reviewer` (same tier as the call; for a simple
   review of heavy work, add `&review_tier=light`). Run each one's `command`.
3. A review on its own (the implementation was done earlier): add
   `&exclude_family=<the implementer's family>` and use `pick`.
4. Any other single model: use `pick`.
5. If a chosen model can't run, use the next row of `ranking` (in `rank` order). For a
   reviewer chosen in rule 2, skip rows with the same `family` as the implementer.
6. Nothing else decides which model to use: no lists, chains, exclusions, score thresholds
   or percentages of your own. Every row in `ranking` is usable; rows in `skipped` are not.
7. Record the rows you used and their `reasons` with the run.
8. If the service doesn't answer: run `systemctl --user restart quota-tracker` in WSL and
   retry. If it still doesn't answer, tell the owner; don't choose a model yourself.
