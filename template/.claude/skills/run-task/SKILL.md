---
name: run-task
description: Run tasks or fixes end to end. OpenCode (or Claude) implements, a reviewer of another model family reviews, the main session merges and reports. Main session only.
---

# /run-task [T<nn> | #<issue> ...]

Read `docs/process.md` §3–§6 first. Given ids, run them in order; given none, take the first
`status:ready` task in `docs/tasks/README.md`. Report after each task; stop at any escalation.
For `#<issue>` of a bug labelled `fix`, the bug body replaces the task file, the branch is
`fix/<issue>-<slug>` (`--fix <issue>` in the scripts), and there is one review round.

0. **Check.** The issue is `status:ready` and every Merge-after task is merged. Run
   `gh issue list --label triage:needed --state open`; triage anything that names this task first.
   If `harness.json` has cutoffs for `breaks-play`, route those issues through Jev first (`/jev`
   step 4). Act on its confident ends and triage the middle yourself; exit 3 means triage it all.

1. **Brief.** Write it to a temp file: the task file **pasted in full**, then `docs/process.md` §4's
   block, then (on rework) the review comment's URL. Never a pointer to the task file.

2. **Implement.** Label `status:in-progress`. Use the task file's Implementer:
   - `opencode` (the default): run
     `node tools/harness/implement.mjs --task T<nn> --slug <slug> --issue <n> --brief <file>`
     with `run_in_background`, then wait for its completion notice; never poll with sleep.
     - Exit 0: a PR is open. Note the `implemented by:` line.
     - Exit 1: read the log it names. An implementer that stopped and reported goes to step 5,
       or to a task-file amendment on `main` and a re-run.
     - Exit 3: OpenCode unavailable, its model not listed, or Go not logged in (the message gives
       the login command). Use the task file's Claude fallback (Sonnet by default), and say so in
       a comment on the issue.
   - `claude`: `Agent(model = the task file's, isolation: "worktree")`, with the brief plus:
     create `task/T<nn>-<slug>` from `origin/main`, push it, open the PR with `Closes #<n>`.

3. **Review.** Label `status:in-review`. Use the task file's Reviewer, never the implementer's
   family:
   - `opencode` (the default, GPT-6 Luna on the direct OpenAI route): `node tools/harness/review.mjs
     --pr <pr> --brief <file> --exclude <implemented by> --issue <n> --apply-label`, in the
     background.
     - Exit 0: posted and labelled.
     - Exit 3: no review came back, or OpenCode or its login is unavailable. Nothing was posted:
       run the Claude reviewer (Opus). If a Claude agent implemented the PR, Claude may not
       review it either (the family rule): escalate (step 5).
     - Exit 4: a review was posted whole under a note (it may be cut off, its verdict is
       unreadable, its verdicts differ, or a finding follows its closing verdict), with no label. Read it on the PR
       and decide: apply the label it supports, or escalate. Never pay for a second review just
       because the first was flagged.
   - `claude` (the fallback): `Agent(model = opus; isolation: "worktree")`, with §5's brief filled
     in. It checks out the PR head with `git fetch origin pull/<pr>/head && git checkout --detach
     FETCH_HEAD`, posts one PR comment and applies the label.
   - Architecture task: also `/code-review <pr>`, always with the number.

4. **Decide** on the label the reviewer applied.
   - `status:approved`:
     1. Wait for green CI.
     2. `gh pr merge <pr> --squash --delete-branch`, then label `status:merged`.
     3. File one `T<nn> follow-up` issue (`triage:needed`) for the non-blocking findings.
     4. Unblock the tasks whose Merge-after are now all merged.
     5. Remove the task's worktrees.
     6. Post §9's measurement comment on the PR.
     7. Report the merge, the findings, the follow-ups and what is ready next.
   - `status:rework`:
     1. Check that every finding names a file in `gh pr diff <pr> --name-only`. A review that
        does not reviewed the wrong tree: discard it, say so, and re-review.
     2. At `review-round:2` (at `review-round:1` for a fix), go to step 5.
     3. Otherwise set the next round and return to step 1, with the full review's URL in the
        brief. The implementer script resumes the branch.

5. **Escalate** (`docs/process.md` §7): label `status:escalated`, comment the evidence on the issue,
   and bring the user the decision with options and a recommendation. Stop.
   A defect found in merged code outside the task is filed as a bug (`triage:needed`). If it
   blocks the task: a one-file mechanical fix may ride this PR, declared under Scope; otherwise
   label the task `status:blocked` and stop.

Never:
- merge without an approving review and green CI;
- weaken a Done-when;
- let the implementer's model family review its PR;
- relay part of a review;
- force-push or rewrite `main`.
