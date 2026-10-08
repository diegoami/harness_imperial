# Review

How a PR is reviewed in a repository on harness_imperial's review profile. `CLAUDE.md` holds the
rules; `docs/environment.md` holds the logins.

## The reviewers

`harness.json` names them; `node tools/harness/switch-model.mjs --show` prints them.

| Order | Model | Route |
| --- | --- | --- |
| 1 | GLM-5.3 Flash (`glm-flash`) | Z.AI Coding Plan, `zai-coding-plan/glm-5.3-flash` |
| 2, on failure | GPT-5.6 Luna (`luna`) | the direct OpenAI route, `openai/gpt-5.6-luna` (OpenAI's main quota; alone when OpenAI is exhausted, L51, L65) |
| 3, on failure | DeepSeek V4.1 Flash (`deepseek-flash`) | OpenCode Go, `opencode-go/deepseek-v4.1-flash` |
| then | the user | no Claude reviewer (`claudeFallback: null`) |

There is no `--hard` chain here (`reviewer.hard` and `reviewer.sol` are null): a critical PR gets a
second opinion instead. The next model runs only when one produced no review at all; the same
failure twice stops the chain (L12). A critical PR's second opinion is Luna, or, when Luna wrote the
first review, the chain's next model. Each reviewer works read-only in a detached worktree of the
PR's head.

## Running a review

1. Push, then take the head from the local branch: `git rev-parse <branch>` (L33).
2. Write the brief (below) to a file outside the repository.
3. From the main checkout, on `main`, in the background:
   `node tools/harness/review.mjs --pr <n> --brief <file> --exclude claude`, adding
   `--second-opinion` for a critical PR. The reviewer's agent comes from this checkout, never from
   the PR (L34).
4. Read the outcome:
   - exit 0: the review is posted. `approve`: merge. `approve after named fixes` or `rework`: fix,
     push, review again. With a second opinion, the stricter verdict counts. A heavy review (three
     or more blocking findings, or new ones of the last round's class) changes how the next round
     works, not who does it: fix the class, sweep the PR's own code for it, list the sweep in the
     PR body, and change the approach when the class needs it (`CLAUDE.md` rule 5, L38). A
     reviewer that still reports one blocking finding per round: after the second such round,
     stop, sweep the whole diff for that class yourself, fix it and record the pattern in the
     model-trials record (create one if there is none) before the next review, which is the last
     before escalation (`CLAUDE.md` rule 5, L49).
   - exit 3: no review, or no second opinion. Tell the user.
   - exit 4: a review posted but not acted on (cut off, unreadable, an approve that skipped a
     Done-when line). Read it on the PR and tell the user.

## The brief

```text
PR<n> review (<model>)
You review PR #<n> at <sha>. You did not write it. The contract follows.
0. Prove the tree: HEAD is <sha> and the diff against origin/main is the PR's.
1. Re-run every Done-when line yourself, and account for each.
2. Every changed file is needed; docs the change makes wrong are updated.
3. Sweep the diff: tests that pass with the behaviour deleted, branches no input reaches.
Read files only by paths relative to your worktree root.

## Blocking means

Any one is enough; a blocking finding means rework, never approve.
1. A Done-when line fails, or cannot be run as written.
2. What this task protects can be got past: <name it: the guard, check, permission, invariant,
   rule value or file this task exists to protect>. A bypass you proved is blocking, even when it
   looks like an edge case. Never "follow-up hardening" or "outside the threat model" unless the
   task says so; if it does, quote the line. (L47)
3. Behaviour the task forbids, or behaviour nobody asked for, inside a file the task requires. (L44)
4. <project-specific items: a constant with no evidence, a test that passes with the behaviour
   deleted, a status written into a document>
Not blocking: wording, style, and defects in code the PR did not change: file those as follow-ups.
When unsure, say how likely the problem is. Rate it blocking only if it is likely and would get
past what the task protects; otherwise it is a follow-up. (L53)

## Report every blocking finding in this one review

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
  sections you did not cover. Do not approve in that case.

# T<n> <the PR's title>

<the PR body: Scope, Done when, Critical>
```

Both sections above the contract are pasted in full in every brief, "Blocking means" written for
the PR (L47, L49). The head is named only above the `# T<n>` line, so the contract may cite other
commits (#32).
List only Done-when lines a read-only reviewer can run: it cannot commit, push or write outside
its worktree. The main session runs any mutation check itself and says so above the contract.
