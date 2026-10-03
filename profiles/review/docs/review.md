# Review

How a PR is reviewed in a repository on harness_imperial's review profile. `CLAUDE.md` holds the
rules; `docs/environment.md` holds the logins.

## The reviewers

`harness.json` names them; `node tools/harness/switch-model.mjs --show` prints them.

| Order | Model | Route |
| --- | --- | --- |
| 1 | GLM-5.3 Flash (`glm-flash`) | Z.AI Coding Plan, `zai-coding-plan/glm-5.3-flash` |
| 2, on failure | GPT-6 Luna (`luna`) | the direct OpenAI route, `openai/gpt-6-luna` |
| 3, on failure | DeepSeek V4.1 Flash (`deepseek-flash`) | OpenCode Go, `opencode-go/deepseek-v4.1-flash` |
| then | the user | no Claude reviewer (`claudeFallback: null`) |

The next model runs only when one produced no review at all; the same failure twice stops the
chain (L12). A critical PR's second opinion is Luna, or, when Luna wrote the first review, the
chain's next model. Each reviewer works read-only in a detached worktree of the PR's head.

## Running a review

1. Push, then take the head from the local branch: `git rev-parse <branch>` (L33).
2. Write the brief (below) to a file outside the repository.
3. From the main checkout, on `main`, in the background:
   `node tools/harness/review.mjs --pr <n> --brief <file> --exclude claude`, adding
   `--second-opinion` for a critical PR. The reviewer's agent comes from this checkout, never from
   the PR (L34).
4. Read the outcome:
   - exit 0: the review is posted. `approve`: merge. `approve after named fixes` or `rework`: fix,
     push, review again. With a second opinion, the stricter verdict counts.
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

# T<n> <the PR's title>

<the PR body: Scope, Done when, Critical>
```

The head is named only above the `# T<n>` line, so the contract may cite other commits (#32).
List only Done-when lines a read-only reviewer can run: it cannot commit, push or write outside
its worktree. The main session runs any mutation check itself and says so above the contract.
