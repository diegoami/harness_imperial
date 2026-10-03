# Models: who writes, who reviews, and how

This page is the main session's working strategy for routing harness_imperial's own work to
models. It follows the page that isle-wars-archaeology and malpaco keep as `docs/models.md`, but
covers only this repository.

- **No status.** The record of each run is the PR's review comment, plus the measurement line for
  a model on watch (L35).
- **The binding rules** are this repository's `CLAUDE.md` and `template/docs/lessons.md`,
  especially L27 and L35. Where this page and those differ, the rules win, and this page gets fixed.

**Who decides.** The owner chooses the models. The main session keeps a switch cheap:
- every candidate stays probed and registered in `harness.json`, with a `watch` note (L35);
- a switch goes through `/switch-model`, with the owner's reason in the commit message.

## The roster

The names are `harness.json`'s. Both copies, the template's and the root's, are equal.

| Name | Model and route | Family | Used for, here |
| --- | --- | --- | --- |
| `luna` | GPT-6 Luna, `openai/gpt-6-luna`, the direct OpenAI route | OpenAI | **easy reviewer**, the `harness.json` default |
| `sol-6.1` | GPT-6.1 Sol, `openai/gpt-6.1-sol` | OpenAI | **hard reviewer** (`--reviewer sol-6.1`); still on watch (L35) |
| `glm-flash` | GLM-5.3 Flash, `zai-coding-plan/glm-5.3-flash` | GLM | **easy implementer** of real runs in the scratch project (`--model glm-flash`); on watch |
| `deepseek-flash` | DeepSeek V4.1 Flash, `opencode-go/deepseek-v4.1-flash` | DeepSeek | **hard implementer** of real runs in the scratch project; the `harness.json` default chain |
| `sol` | GPT-6 Sol, `openai/gpt-6-sol` | OpenAI | on watch; the hard reviewer at Isle Wars before 6.1 |
| `deepseek-pro` | DeepSeek V4 Pro, `opencode-go/deepseek-v4-pro` | DeepSeek | on watch; not in a pair |
| `glm` | GLM-5.3, `zai-coding-plan/glm-5.3` | GLM | on watch; not in a pair |
| (Claude) Opus | the main session | Claude | writes every PR here, so it never reviews one (the family rule) |
| (Claude) Sonnet | `claudeFallback` of the implementer | Claude | the fallback when OpenCode cannot implement |

Every model runs at effort `high`, never `max` (L27).

**Not used:**
- OpenCode Zen's `opencode/…` models;
- Go's own GPT-6 Luna, whose proxy returned `400 Bad Request` in long agent loops (L27);
- GLM-5.3-highspeed, which the Z.AI plan refuses.

**Routes:**
- GLM runs only on the Z.AI Coding Plan (`zai-coding-plan/…`).
- DeepSeek runs on OpenCode Go.
- Luna and Sol run on the direct OpenAI route.

## Routing: easy or hard

The owner decided on 2026-10-03, for this repository as for Isle Wars and malpaco, that the pair
follows the work's difficulty. Claude writes every PR here, so here only the reviewer changes:

| Difficulty | Writes | Reviews | If the reviewer is unavailable |
| --- | --- | --- | --- |
| Easy, the default | Claude, the main session | GPT-6 Luna (`luna`) | escalate: no Claude reviewer may review here |
| Hard | Claude, the main session | GPT-6.1 Sol (`--reviewer sol-6.1`) | Luna, and say so on the PR |

The review always runs through `review.mjs` from the root, with `--exclude claude`.

**When work is hard.** A PR is hard if any of these holds:
- it is a guard, a gate or a check whose failure lets a wrong result through: the runner's
  rejection, agent and family checks, `guard.mjs`, the review reader (`readReview`,
  `accountDoneWhen`), `briefTargets`;
- it adds a new mechanism across several files, or a new external dependency;
- an earlier round found blocking bypasses.

Everything else is easy: docs, lessons, config, and single-mechanism code with clear tests. The
main session decides, and the PR body says `Difficulty: easy` or `Difficulty: hard`, with the
reason. Luna's blocking findings on PRs 17, 22 and 29 were bypasses of exactly such checks; at Isle
Wars, Sol found bypasses that the implementer's own tests missed.

**Real runs in the scratch project** (`~/projects/harness-scratch`, never this repository) use
Isle Wars' full pairs: easy, GLM-5.3 Flash implements (`--model glm-flash`) and Luna reviews; hard,
DeepSeek V4.1 Flash implements and GPT-6.1 Sol reviews. GLM-5.3 Flash is on watch (L27, L35): a
stall is diagnosed before any fallback.

**Jev, for easy or hard (planned).** The owner cleared sending this text to OpenRouter for a Jev
trial (2026-10-03). A trial needs about 60 labelled items, and labels that the main session makes
itself measure Jev against the main session, not against the truth. So the outcome is the label:
- a hard PR whose review found nothing blocking says the call was too cautious;
- an easy PR whose review found blocking bypasses says the call was wrong;
- otherwise the call stands.

Each PR body records the call and its reason, and the outcome adds the label after the review. The
PRs already merged here can be labelled from their outcomes alone, since their reviews are on
GitHub. At about 60 items, the decision `task-hard` is defined, in the same words as Isle Wars' if
the two are to share items, and trialled (`/jev`). Until then, the main session decides. Jev would
give only the decision, so the main session still writes the reason. Its key loads from
`~/.openrouter_env`, which this machine's sessions do not read on their own.

## How a run is made

- **The review of a PR here.** Run it from the root, on `main`, in the background:
  `node template/tools/harness/review.mjs --pr <n> --brief <file> --exclude claude`.
  - The reviewer's agent and config come from the main checkout (L34). While a review runs, do
    other work in a separate worktree, never by switching the main checkout's branch.
- **The brief.**
  - First comes `process.md` §5's block, naming the head taken from the local branch after the
    push has landed (L33).
  - Then the contract with its Done-when list, under a title of the form `# T<nn> …` (here, the
    PR's number). Only the block before that title is checked for the head (#32), so the contract
    may cite other commits; a brief without one is checked whole.
  - List only the Done-when lines that a read-only reviewer can run. The main session runs the
    mutation checks itself and says so in the brief (#24; DW2 on PR 33 came back "not run").
- **Reading the verdict.**
  - `approve`: the owner says when to merge.
  - `approve after named fixes`: fix and push, then ask the owner to merge, without paying for a
    second review (PR 33).
  - `rework`: fix, push, and review again, as on PRs 17, 21, 22 and 29.
  - A heavy review (three or more blocking findings, or new ones of the last round's class, L38):
    Claude Opus writes here, the top of the ladder, so the next round fixes the class, sweeps its
    own code for it and lists the sweep in the PR body, or changes the approach. PR 42's rounds
    (a half-written install, then a half-written file) are the case.
  - Exit 3: no review came back. Escalate, because no Claude reviewer may review here.
  - Exit 4: the review is posted under a note. Read it on the PR.
- **A model on watch** prints its note each time it runs. Its outcome goes in the measurement
  line (L35, `process.md` §9).

## Adjustments that keep runs working

| Adjustment | Why | Learned |
| --- | --- | --- |
| OpenCode runs only through the scripts, in their own data directory, with Go's login made there | the desktop app's 2.x migrated the shared database; Go's login lives in that database | L29 |
| OpenCode 1.x only: the runner refuses 2.x before anything is billed | 2.x drops `run --dir` and `--variant`, which the runner passes | #26, PR 31 |
| Name the head after the push has landed, from the local branch | GitHub had not updated, so the brief named the old commit | L33 |
| Only the reviewer's block names the head; a task file may cite commits freely | malpaco PR 4 was refused for citing its source "at `<sha>`" | #32 |
| The reviewer runs `git` in its worktree and never types the path | Luna mistyped a 90-character path, and the run ended | L30, #15 |
| Commands run from the worktree root: no `cd`, no `..` | a GLM-5.3 review was rejected as `external_directory` after about 25 minutes | L31, #14 |
| OpenCode's file tools get paths relative to the worktree root, never absolute ones | Luna read `/home/diegoami/CLAUDE.md`, a home directory guessed from the repository's owner, and the run ended with no review | L36, PR 35 |
| Keep the scratch project at a short path (`~/projects/harness-scratch`) | the long path was what Luna mistyped | #15 |
| Done-when lines a read-only reviewer can run; mutation checks run by the main session | a reviewer cannot edit files to break a behaviour | #24, PR 33 |

## What each model has shown so far

Each observation has a source. The PRs hold the full record. "At Isle Wars" means
[isle-wars-archaeology's `docs/models.md`](https://github.com/diegoami/isle-wars-archaeology/blob/main/docs/models.md)
and the trials issue it names.

- **GPT-6 Luna** (reviewer of every PR here since PR 18):
  - Its blocking findings were real:
    - PR 17: `--family` bypassed the family rule.
    - PR 21: an agent instruction had no regression test.
    - PR 22: `accountDoneWhen` accepted any text after a DW number.
    - PR 29, twice: the guard's quote handling, and `echo "$(git push …)"` passing the reviewer
      guard.
  - It catches docs that drift from the code: the sample count on PR 22, the skill's wording on
    PR 33.
  - Its misses: it approved game-archaeologist PR 2 with no evidence for one Done-when line
    (L32). It mistyped a long path (L30), and guessed a home directory for a file
    read (L36). Being read-only, it cannot run a mutation check.
- **Claude Opus, as an agent reviewer** (PRs 12 and 13, before PR 18 handed this repository's
  reviews to Luna): approved after named fixes both times.
- **DeepSeek V4.1 Flash** (implementer): it created no session while WSL was short of memory, in
  the first real run (harness_imperial#1). At Isle Wars it stops correctly on a Done-when it cannot
  meet.
- **DeepSeek V4 Pro**: it ran a read-only review brief with no rejection, always giving paths from
  the root (L31). It answered a probe on 2026-10-03.
- **GLM-5.3**: in IC2 it ended long implementer runs early (L27). Here, as a read-only reviewer, it
  chained `cd` commands, and the run was rejected (L31, #14). At Isle Wars (T06) it finished every run, but
  added scope nobody asked for, and the bypasses were there.
- **GLM-5.3 Flash**: it went 900 s without a step in the first real run (harness_imperial#1), and
  elsewhere it was the weakest reviewer, missing a must-fix (L27). At Isle Wars (malpaco T02) it
  followed an amended contract, but missed stale counts in its own doc.
- **GPT-6 Sol**: at Isle Wars it was the adversary, finding bypasses in T06 and
  in each round of malpaco T02.
- **GPT-6.1 Sol**: it answered a one-word probe on 2026-10-03 (L35).

## Keeping this page current

The main session updates this page in the same commit as any of these:
- the owner switches a model, or adds or removes a `harness.json` entry;
- a run teaches a new adjustment;
- a review changes what a model is known to do well or badly.
