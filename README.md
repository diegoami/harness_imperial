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
| `template/tools/harness/review.mjs` | Runs a review on OpenCode, never on the implementer's model family, and posts it. |
| `template/tools/harness/lib/opencode.mjs` | The watched runner that both use. |
| `template/.opencode/agents/` | The OpenCode agents, with the permission deny-lists. |
| `template/tools/harness/jev.mjs`, `lib/jev.mjs` | Delegates repeated decisions to Jev: `trial` against labels, then `route` the confident ends. |
| `template/.claude/skills/jev/SKILL.md` | `/jev`: when a decision fits Jev, and the define, label, trial, route procedure. |
| `template/.claude/skills/delegate/SKILL.md` | `/delegate`: which delegate fits the work (Claude, OpenCode, Jev, OpenRouter, ElevenLabs), and picking its model from a live list. |
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
  0, so the run looks clean (IC2 #501). The runner reads OpenCode's own rejection line.
- **The export is read from a file.** Through a pipe, a large export arrives truncated, and the agent
  check loses its evidence (ic2-conquest's WSL reviewer).
- **The real binary.** Under WSL, the `opencode` on PATH is often the Windows npm shim under
  `/mnt/c`. It cannot use Linux paths and survives a kill, so the runner skips it for
  `~/.opencode/bin/opencode`.

`implement.mjs` and `review.mjs` add three more guards. They fall back to the next model only on an
infrastructure failure that left no commit, push or PR. They stop after the same failure twice.
And the review never runs on the implementer's model family.

Exit codes, for both scripts: 0 done; 1 the main session decides; 3 OpenCode unavailable, so use
Claude.

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

The models are OpenCode Go's (`opencode-go/…`), which needs `opencode console login`, not a key.
`harness.json` follows IC2's experience (#551, #554). The implementers are GLM-5.3 Flash, then
DeepSeek V4.1 Flash. GPT-6 Luna is left out of the chains: on Go she returned `Bad Request` once a
run's context grew. The reviewers are DeepSeek, then GLM-5.3 Flash, because an implementer's
family never reviews its work. Add models to a `chain` when a real failure shows you need them, not before
(L14).

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
- a cut-off review, and a review requested from the implementer's family;
- a tool call OpenCode rejected (in the runner, the implementer and the review), a large export, and
  the Windows shim under WSL.

The stdin, process-tree, left-work, family, rejection, export and shim guards were also checked by breaking each one and
watching its test fail.

**Against a real OpenCode** (1.18.33, and 1.18.34 under WSL, with no model key, so each run fails
at the provider), the following were checked:
- the `run` flags exist;
- the runner finds the session in `session list --format json`;
- `export`'s `info.agent` reads `reviewer` when the agent file is present, and `build` (the silent
  fallback, which the runner flags) when it is missing.

Under WSL with the Go login, `glm-5.3-flash`, `deepseek-v4.1-flash` and `glm-5.3`, each with
`--variant max`, answered a one-word prompt. A full run through `implement.mjs` has not happened yet:
watch the first one.
