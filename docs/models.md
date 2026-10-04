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
| `sol-6.1` | GPT-6.1 Sol, `openai/gpt-6.1-sol`, effort `low` | OpenAI | **guard reviewer**: `--hard --sol`, for a guard task and a hard task's last round (L41); still on watch (L35) |
| `glm-flash` | GLM-5.3 Flash, `zai-coding-plan/glm-5.3-flash` | GLM | **easy implementer** of real runs in the scratch project; first in the `harness.json` default chain (L42); on watch |
| `deepseek-flash` | DeepSeek V4.1 Flash, `opencode-go/deepseek-v4.1-flash` | DeepSeek | **hard implementer** of real runs in the scratch project (`--model deepseek-flash`); second in the default chain |
| `sol` | GPT-6 Sol, `openai/gpt-6-sol`, effort `low` | OpenAI | on watch; the hard reviewer at Isle Wars before 6.1 |
| `deepseek-pro` | DeepSeek V4 Pro, `opencode-go/deepseek-v4-pro` | DeepSeek | on watch; not in a pair |
| `glm` | GLM-5.3, `zai-coding-plan/glm-5.3` | GLM | **hard reviewer**, first in `--hard` (L41); on watch |
| (Claude) Opus | the main session | Claude | writes every PR here, so it never reviews one (the family rule) |
| (Claude) Sonnet | `claudeFallback` of the implementer | Claude | the fallback when OpenCode cannot implement |

Every model runs at effort `high`, never `max` (L27), except Sol: it runs sparingly, at effort `low`,
`medium` at most and never `high` (the owner, 2026-10-03, L39).
- Light first: both Sol entries (`sol-6.1`, `sol`) are at `low` in `harness.json`. Going to
  `medium` is a switch through `/switch-model`, with the owner's reason in the commit message.
- OpenAI credit being restored (2026-10-03) is not a reason to raise it: Sol stays sparing (L39).

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
| Hard | Claude, the main session | `--hard`: GLM-5.3; `--hard --sol`: GPT-6.1 Sol, for a guard task and the last round (L41) | the rest of `reviewer.hard`: DeepSeek V4 Pro, then Luna, by itself (L39) |

The review always runs through `review.mjs` from the root, with `--exclude claude`.

**Speedups: a hard review never waits for one provider (L39).** `--hard` runs `reviewer.hard`:
GLM-5.3 (Z.AI), then DeepSeek V4 Pro (Go), then Luna. `--hard --sol` puts GPT-6.1 Sol
(`reviewer.sol`) before them. The next model runs only when one produced no review, such as when
the OpenAI quota is used up (Isle Wars T08 lost Sol and Luna together that way). The implementer's
family is skipped; the posted header names each model that failed or could not run before the one
that reviewed, so a light substitute on a hard review is visible; with no reviewer left, the script
exits 3, and since Claude implements here, the owner decides.

**Sol is used sparingly (L41).** It reviews only a guard task (the first item of the list below)
and a hard task's last round (`review-round:2`, `review-round:1` for a fix), at effort `low`.
Every other hard review goes to GLM-5.3. The owner adopted this from games_revival_framework on
2026-10-04, where GLM-5.3's first hard review (goal2 T04) re-ran every Done-when line, regenerated
the listing, made five mutations and checked the data bytes.

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
DeepSeek V4.1 Flash implements and GLM-5.3 reviews (`--hard`), GPT-6.1 Sol for a guard task and the
last round (`--hard --sol`). GLM-5.3 Flash is on watch (L27, L35): a stall is diagnosed before any
fallback.

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

## Faster game cycles

Not about models, but the time one game cycle takes sets how long every research run lasts, and so
how much implementer and reviewer time a driver costs. isle-wars-archaeology measured Isle Wars Pro
under Wine (its `docs/models.md`, T08's control runs): a cycle of about 25 s fell to about 10 s.
Its lessons, for any driver that a project of this harness builds:

- **Measure each step once** (environment ready, window or screen up, first stable screen, one
  action, terminate, processes gone), so the slow step is known before optimising.
- **Do not patch the game to skip what is slow.** A title or registration screen that is the main
  menu stays; stripping an unregistered notice would be a crack.
- **Terminate by killing, not through the game's menus** (Wine: Alt+F4 or `wineserver -k`). The
  full quit path is tested once, not in every cycle.
- **Relaunch less often.** A driver keeps the game running between trials and starts each one from
  a known state: a new game or a loaded save. The launch is paid once per session.
- **Run in parallel.** Each run gets its own display (Xvfb) and its own copy of the game's files,
  so runs side by side cannot interfere.

The step timings are in isle-wars-archaeology's `docs/models.md`, "Faster game cycles (Isle Wars
Pro)". A number measured for another game is a target to measure, not a promise.

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
    own code for it and lists the sweep in the PR body, and changes the approach when the class
    needs it. PR 42's rounds
    (a half-written install, then a half-written file) are the case.
  - Exit 3: no review came back. Escalate, because no Claude reviewer may review here.
  - Exit 4: the review is posted under a note. Read it on the PR.
- **A run that measures** (a real run timing the runner, a probe of a model) writes every output
  a finding or a PR may cite under a tracked path the task owns, never only under scratch or a
  cache; commits and pushes after each batch and at least every 30 minutes; never deletes or
  overwrites one (a re-run writes beside it, and the finding names which it cites); keeps
  originals out and records their hashes (L40).
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
  the root (L31). It answered a probe on 2026-10-03. In the PR 29 replay (below) it gave no review:
  OpenCode rejected its access to `/tmp` (`external_directory`), as in L31.
- **GLM-5.3**: in IC2 it ended long implementer runs early (L27). Here, as a read-only reviewer, it
  chained `cd` commands, and the run was rejected (L31, #14). At Isle Wars (T06) it finished every run, but
  added scope nobody asked for, and the bypasses were there. At games_revival_framework (goal2 T04)
  its first hard review re-ran every Done-when line and made five mutations (L41). In the PR 29
  replay (below) it found the most bypasses, each proven live, and still approved: it rated them
  not blocking. In game-archaeologist's replay it approved every head. With L47's prompt it asked
  for rework on that head, and found real bypasses on the head Luna had approved (#62).
- **GLM-5.3 Flash**: it went 900 s without a step in the first real run (harness_imperial#1, on
  OpenCode Go; its runs on Z.AI since have had no stall, L42), and
  elsewhere it was the weakest reviewer, missing a must-fix (L27). At Isle Wars (malpaco T02) it
  followed an amended contract, but missed stale counts in its own doc.
- **GPT-6 Sol**: at Isle Wars it was the adversary, finding bypasses in T06 and
  in each round of malpaco T02.
- **GPT-6.1 Sol**: it answered a one-word probe on 2026-10-03 (L35). In the PR 29 replay (below) it
  asked for rework with two blocking bypasses, the correct verdict.

**The PR 29 replay (2026-10-04).** PR 29's first commit (36abb20, the PreToolUse guard) had blocking
bypasses that Luna found in the real round 1: escaped quotes and nested shells let a `git push`
through. It was recreated as a draft PR (55) and each reviewer ran on it with `--dry-run`, so
nothing was posted:

| Reviewer | Verdict | What it found |
| --- | --- | --- |
| GPT-6.1 Sol (`low`) | rework (correct) | 2 blocking: `$( )` inside double quotes; `gh pr`/`gh issue` writes missing from the deny list |
| GPT-6 Luna | rework (correct) | 2 blocking: escaped quotes and `env git push`; hook JSON with no command fails open |
| GLM-5.3 | approve (wrong) | 3 findings rated not blocking, though proven live: `$( )` in quotes, `env`/`nice` prefixes, `gh --repo` and `gh api` writes |
| DeepSeek V4 Pro | no review | rejected `external_directory (/tmp/*)` (L31) |

One head is one sample. With game-archaeologist's replay (GLM-5.3 approved every head there too), it
said GLM-5.3 finds defects but under-rates them on a guard. The prompt never said what blocking
meant, so L47 now says so to every reviewer. Re-run with it (same dry runs):

| GLM-5.3 run | Head | Verdict |
| --- | --- | --- |
| 1, 2 | 36abb20 (known bad) | lost: a rejected `/tmp/err` redirect, and an `index.lock` deleted under `.git` (then the scratch rule) |
| 3 | 36abb20 | rework (correct): wrapper and quoting bypasses, `gh` writes missing, both blocking |
| 4 | 36abb20 | rework (correct): wrapper bypasses blocking; the `gh` writes rated not blocking |
| 5 | b68e905 (Luna approved) | rework: 8 bypasses (`timeout`, `nice`, `sudo -u`, `bash -o pipefail -c` …), real on `main` (#62) |

So the miss was the prompt's. With L47 GLM-5.3 caught what Luna's approval let through.

## Keeping this page current

The main session updates this page in the same commit as any of these:
- the owner switches a model, or adds or removes a `harness.json` entry;
- a run teaches a new adjustment;
- a review changes what a model is known to do well or badly.
