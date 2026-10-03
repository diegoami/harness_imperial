# harness_imperial

A small harness for building software with Claude Code and OpenCode together. Claude plans,
reviews and merges; OpenCode implements through one watched runner. It is distilled from
[imperial_conquest_2](https://github.com/diegoami/imperial_conquest_2), a reverse-engineer-and-rebuild
project, and from the field reports collected in
[harness_template](https://github.com/diegoami/harness_template).

## What it keeps, and what it leaves to Claude Code

Claude Code already provides worktree isolation for agents, `/code-review`, `/security-review`,
skills and hooks, so none of that is re-described here. What it does not provide is a safe way to
hand work to OpenCode, and the rules that catch model mistakes. Those are the harness:

| File | What it is |
| --- | --- |
| `template/CLAUDE.md` | The rules, in 39 lines. |
| `template/docs/process.md` | How they run: order of work, roles, task files, briefs, bugs, labels, measuring. |
| `template/docs/lessons.md` | The failure behind every rule. A rule without one does not get in. |
| `template/.claude/skills/run-task/SKILL.md` | `/run-task`: implement, review, merge, report. |
| `template/tools/harness/implement.mjs` | Runs a task's implementer on OpenCode in its own worktree, and checks the handover. |
| `template/.claude/agents/reviewer.md`, `implementer.md` | The Claude reviewer and fallback implementer. Each carries its brief's fixed text from `process.md` §4/§5, and a `PreToolUse` hook (`tools/harness/guard.mjs`) that refuses the commands the role may not run: every write for the reviewer; `git stash`, `git worktree`, force-push and `gh pr merge` for the implementer. |
| `template/tools/harness/post-review.mjs` | Posts a Claude reviewer's returned review through the same reader and writer as `review.mjs` (`lib/post.mjs`), so only one component writes reviews to GitHub. |
| `template/tools/harness/review.mjs` | Runs a review on OpenCode, never on the implementer's model family, and posts it. `--second-opinion` adds a review by another model for a critical PR; the stricter verdict decides the label. |
| `template/tools/harness/lib/opencode.mjs` | The watched runner that both use. |
| `template/.opencode/agents/` | The OpenCode agents, with the permission deny-lists. |
| `template/tools/harness/jev.mjs`, `lib/jev.mjs` | Delegates repeated decisions to Jev: `trial` against labels, then `route` the confident ends. |
| `template/.claude/skills/jev/SKILL.md` | `/jev`: when a decision fits Jev, and the define, label, trial, route procedure. |
| `template/.claude/skills/delegate/SKILL.md` | `/delegate`: which delegate fits the work (Claude, OpenCode, Jev, OpenRouter, ElevenLabs), and picking its model from a live list. |
| `template/tools/harness/switch-model.mjs`, `lib/switch.mjs` | Switches the implementer's or reviewer's model in `harness.json`. It checks the live id and the login, keeps effort `high`, enforces the family rule, and can run a one-word probe first. |
| `template/.claude/skills/switch-model/SKILL.md` | `/switch-model`: why, the candidates (live), a dry run with a probe, the user's yes, the switch and its commit. |
| `template/tools/harness/models.mjs` | Lists the models OpenRouter or ElevenLabs offer now, filtered by input and output (text, image, audio). |
| `template/harness.json` | Models, chains, timeouts, providers, and the Jev decisions with their cutoffs. |
| `template/docs/tasks/`, `template/.github/pull_request_template.md` | The task-file and PR formats. |

## The runner

`lib/opencode.mjs` is a Node port of IC2's `Invoke-OpenCodeWatched.ps1`, including what IC2 #482
added. Each behaviour exists because a run failed without it:

- **stdin closed.** Otherwise OpenCode waits for stdin's end-of-file and hangs before creating a
  session.
- **A startup timeout**, if no session appears.
- **An idle timeout.** A session's `updated` time only moves between steps, so the limit must
  exceed the longest step.
- **A total deadline.** Hitting any of the timeouts kills the whole process tree.
- **The agent check.** Whether OpenCode loaded the requested agent is read from the session record,
  not from the output.
- **UTF-8 output.**
- **A rejected tool call is a failure.** OpenCode auto-rejects a path outside the worktree and exits
  0, so the run looks clean (IC2 #501). Whether a call was rejected is read from the
  session record, where the tool ends in "The user rejected permission…": a tool's output can quote
  OpenCode's rejection line (PR 35's review printed issue #14). The line says what was rejected, and
  decides alone only when the record cannot be read.
  - A `cd` or `..` in an agent's command can trip the same check with nothing leaving the worktree,
    because OpenCode resolves the path against `--dir`, not the `cd` before it (#14). The agent
    files forbid both (L31), and when the rejected command used one, the failure says so.
- **The export is read from a file.** Through a pipe, a large export arrives truncated, and the agent
  check loses its evidence (ic2-conquest's WSL reviewer).
- **Its own data directory.** OpenCode's desktop app (2.x) can migrate the default database to a
  schema the 1.x CLI cannot read (IC2 #540). The scripts' runs use `~/.local/share/harness-opencode`,
  with `auth.json` copied in, and Go's console login made there once.
- **The real binary.** Under WSL, the `opencode` on PATH is often the Windows npm shim under
  `/mnt/c`. It cannot use Linux paths and survives a kill, so the runner skips it for
  `~/.opencode/bin/opencode`.

`implement.mjs` and `review.mjs` add more guards:
- Before anything is billed, they check that OpenCode lists their model in that data directory.
  An unknown id or a missing Go login exits 3, with the command that fixes it.
- With a longer chain, they move on only after an infrastructure failure that left no commit, push
  or PR, and stop after the same failure twice.
- The review never runs on the implementer's model family.
- The reviewer's agent and OpenCode config come from the main session's checkout, never from the
  PR under review: `OPENCODE_CONFIG_DIR` points there, and `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps
  OpenCode from reading the PR's own `.opencode/`. Without them, a PR's own `reviewer.md` is the
  one loaded (checked on 1.18.34), so a PR could loosen its reviewer's permissions (L34).
- A review is never thrown away (L28). Only output with no review at all falls back.
  - A readable review is posted normalised and acted on. It may come through Markdown decoration, a
    `Verdict:` prefix, punctuation, a where-I-worked block before the verdict, a sign-off after the
    closing verdict (kept), or a single line.
  - A review that may be cut off, has no readable verdict, opens and closes with different
    verdicts, or has a finding after its closing verdict is posted whole, exactly as it arrived,
    under a note, with no label. Only the last header in the output is read, so an earlier draft
    can never approve a flagged review.
  - Closing keywords lose their `#` (`Fixes: #5` becomes `Fixes: 5`).
  - A review accounts for each Done-when line of the task in its brief, one `DW<k>` line each
    (L32). An approve with a line missing or not run is posted under a note, unlabelled: exit 4.
  - `review.mjs --self-test` runs the reader's samples with no model call.

Exit codes, for both scripts:
- 0: done;
- 1: the main session decides;
- 3: OpenCode unavailable, a login missing, or no review, so the caller runs Claude (Sonnet
  implements, Opus reviews). Except for `review.mjs` when Claude implemented the PR or
  `claudeFallback` is null: then the caller escalates to the owner, as the message says. With
  `--second-opinion`, exit 3 also means the first review was posted but no second one came back: no
  label, and the owner decides;
- 4 (`review.mjs` and `post-review.mjs`): a review was posted under a note; read it and decide.

The Claude agents' guard blocks a refused command with exit 2, which Claude Code shows the agent as
the tool's error. The hook runs `node "$CLAUDE_PROJECT_DIR/tools/harness/guard.mjs" <role>`, from the
main checkout, never the worktree. The documentation does not say which shell runs hooks on Windows:
check it there on first use (#1).

## Jev: the third delegate

The main session delegates code to OpenCode and reviews to another model family. It sends
decisions to [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe AI's
System One model, which returns a calibrated probability for a typed question instead of text.
Only decisions that recur over many items, with answers known up front, go there: triage,
routing, gating, labelling.

The pattern is the one that works in
[newscollection2027](https://github.com/diegoami/newscollection2027) (#85, #87):
- **Trial first.** Cutoffs are picked on half the labels and reported on the other half.
- **A three-way split.** Jev answers the confident ends, and Claude answers the middle.
- **Off without a key**, so nothing changes until someone adds one.
- **A pinned model**, with cached answers.

`breaks-play`, the playability gate asked of a GitHub issue, is the example decision. It has no
cutoffs until someone runs its trial, so `/run-task` does not use it yet. `trial` and `route` handle
yes/no (`noul`) questions. `ask` passes Choice and Score through unparsed, until their response
format is confirmed.

## Environment

Each delegate needs a key or a login. [`template/docs/environment.md`](template/docs/environment.md)
has the details: an OpenCode Go console login for OpenCode, `OPENROUTER_API_KEY` for Jev and OpenRouter models
(images too), `ELEVENLABS_API_KEY` for audio, `GH_TOKEN` for `gh`, and the hosts a cloud
environment's network policy must allow. A session-start hook installs OpenCode and
`gh` in cloud sessions and reports which keys are set. This repository uses the same hook
(`.claude/settings.json`), so a cloud session here can run the tools for real.

## Adopt it

In a project (Node 20 or later, `gh` logged in, OpenCode installed):

```sh
cp -r /path/to/harness_imperial/template/. .
# If the project already had .claude/settings.json, merge its SessionStart hook back in by hand.
# Fill in CLAUDE.md's first lines, and delete the conditional rules that do not apply.
# Check the model ids against `opencode models` and edit harness.json.
for l in task bug fix triage:needed post-playable review-round:1 review-round:2 \
  status:ready status:in-progress status:in-review status:rework status:approved \
  status:blocked status:escalated status:merged; do gh label create "$l" --force; done
```

There is one OpenCode model per role, then Claude, by the owner's decision of 2026-10-02 (L27):
- DeepSeek V4.1 Flash on OpenCode Go (`opencode-go/deepseek-v4.1-flash`) implements, then Claude
  Sonnet. Go needs `opencode console login`.
- GPT-6 Luna on the direct OpenAI route (`openai/gpt-6-luna`) reviews, then Claude Opus. OpenAI
  needs `opencode auth login`.

Each runs at effort `high`, never `max`.
- Candidates are registered on watch, outside the chains (L35): GPT-6 Sol and GPT-6.1 Sol
  (`openai/`), DeepSeek V4 Pro (`opencode-go/`), and GLM-5.3 and GLM-5.3 Flash on Z.AI's plan
  (`zai-coding-plan/`). They run by an explicit `--model` or `--reviewer`, and each prints its
  `watch` note: GLM ended long implementer runs early before (L27), so that is what to look for.
- Go's own GPT-6 Luna is out too. A third-party proxy behind it returned `Bad Request` in long agent
  loops, which the direct route did not.

Add models to a `chain` when a real failure shows you need them, not before (L14).

## Reviewing this repository's PRs

harness_imperial reviews its own PRs with its own tool, like any project that adopts it. The root
`harness.json` and `.opencode/agents/` are copies of the template's (`test/self-config.test.mjs`
keeps them equal), so from the root:

```sh
node template/tools/harness/review.mjs --pr <n> --brief <brief> --exclude claude
```

Claude writes this repository's PRs, so a Claude agent never reviews them (the family rule): Luna
does, on the direct OpenAI route.

## Tests

```sh
npm test
```

The tests run the runner and both scripts against a fake `opencode` and a fake `gh` that
reproduce each failure above. The cases are:
- a run that waits for stdin, no session, an idle session, a missing agent, and a model quoting
  the warning;
- a failed run that left a commit, an implementer that stops and reports, and the same failure
  twice;
- the review reader's self-test (`lib/review-selftest.mjs`, run by `review.mjs --self-test` and by
  `test/review-reader.test.mjs`). Its 34 samples assert the outcome and the text kept: decorated,
  prefixed, punctuated, where-I-worked, signed-off and one-line reviews; closing keywords; findings
  after the closing verdict; cut-off and unreadable reviews, also on one line; and tool chatter
  only;
- a flagged review posted with no label and exit 4, a dry run, and a review requested from the
  implementer's family;
- the scripts' own data directory, the copied `auth.json`, and a model OpenCode does not list;
- a second opinion: both reviews posted and the stricter label applied, never by the first review's
  model or one that failed, and without one an exit 3 to the owner; with no Claude reviewer, a
  failure escalates to the owner;
- a model on watch printing its note, on the console and in the run log, and keeping it through a
  switch;
- a tool call OpenCode rejected (in the runner, the implementer and the review), a large export, and
  the Windows shim under WSL.

Every guard was also checked by breaking it and watching its test fail: stdin, the process tree,
left work, family, rejection, export, the shim, the reader, the data directory, the model check and
the watch note.

**Against a real OpenCode** (1.18.33, and 1.18.34 under WSL, with no model key, so each run fails
at the provider), the following were checked:
- the `run` flags exist;
- the runner finds the session in `session list --format json`;
- `export`'s `info.agent` reads `reviewer` when the agent file is present, and `build` (the silent
  fallback, which the runner flags) when it is missing.

Under WSL, Go's models answered a one-word prompt. The first real run through `implement.mjs`
(harness_imperial#1) failed over correctly, with nothing left behind. GLM-5.3 Flash went 900 s
without a step, and DeepSeek created no session while WSL was short of memory.
