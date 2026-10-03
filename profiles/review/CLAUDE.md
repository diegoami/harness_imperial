# <Project>

<One line: what this project is.> Work runs through harness_imperial's review profile
(`harness.lock`): the main session plans and implements, and another model family reviews every
PR. How a review is run is `docs/review.md`; the L-numbers are harness_imperial's
`template/docs/lessons.md`.

## Rules
1. The main session plans and implements, on a branch, never on `main`. One PR per change, or per
   group of related changes: a PR is as large as one review round can cover, and no larger. (L37)
2. The PR body is the contract: Scope, Done when (each line one command a read-only reviewer can
   run), and `Critical: yes|no` with the reason. (L32, L37)
3. Every PR is reviewed by `tools/harness/review.mjs --exclude claude`, never by a Claude agent:
   Claude implements here, and the reviewer is never the implementer's family. (L3)
4. A critical PR gets a second opinion: `--second-opinion`. Critical means a guard, a gate, or
   anything that handles secrets, credentials or access; a new mechanism across several files; or
   an earlier round that found blocking findings. (L37)
5. Merge only on an approving review, and green CI where there is one. Fix and re-review a rework;
   after two rework rounds, escalate to the user.
6. Any failure escalates to the user: a review that did not run (exit 3), one posted but not acted
   on (exit 4), a reviewer that cannot run a Done-when line. Never fall back to a Claude reviewer.
7. Relay review findings in full, never a subset.
8. A test proves behaviour only if it fails when the behaviour is removed. (L9)
9. Never `git stash`; never force-push or rewrite `main` without the user. (L19)
10. A question is not a request to edit files. Answer it; propose any fix and wait.
11. No document carries a status snapshot: status lives on the PRs. (L2)
