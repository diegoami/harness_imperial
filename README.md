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
| `template/harness.json` | Models, chains and timeouts. |
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

`implement.mjs` and `review.mjs` add three more guards. They fall back to the next model only on an
infrastructure failure that left no commit, push or PR. They stop after the same failure twice.
And the review never runs on the implementer's model family.

Exit codes, for both scripts: 0 done; 1 the main session decides; 3 OpenCode unavailable, so use
Claude.

## Adopt it

In a project (Node 20 or later, `gh` logged in, OpenCode installed):

```sh
cp -r /path/to/harness_imperial/template/. .
# Fill in CLAUDE.md's first lines, and delete the conditional rules that do not apply.
# Check the model ids against `opencode models` and edit harness.json.
for l in task bug fix triage:needed post-playable review-round:1 review-round:2 \
  status:ready status:in-progress status:in-review status:rework status:approved \
  status:blocked status:escalated status:merged; do gh label create "$l" --force; done
```

`harness.json` starts with one implementer model and one reviewer model. Add models to a `chain`
when a real failure shows you need them, not before (L14).

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
- a cut-off review, and a review requested from the implementer's family.

The stdin, process-tree, left-work and family guards were also checked by breaking each one and
watching its test fail.

**They have not been run against a real OpenCode.** The OpenCode behaviour is copied from IC2's
PowerShell runner, which has run there. Watch the first real run: `session list`'s JSON, the
`export` format and the exact flags are what that runner used on OpenCode 1.18.
