# harness_imperial

This repository is the harness itself, not a project that uses it. `template/` is what a project
copies; `test/` tests the tools against fakes of `opencode` and `gh`.

- Read `README.md` first. `template/docs/lessons.md` is the admission list: a rule enters
  `template/CLAUDE.md` or `template/docs/process.md` only with a lesson (a failure from a real run).
- Keep `template/CLAUDE.md` at 40 lines or fewer and `template/docs/process.md` at 150 or fewer.
- Every behaviour of the runner has a test in `test/`, and each test was checked by breaking the
  behaviour and watching it fail. Do the same for any new one.
- PRs here are reviewed by the harness itself, as in any project: `node template/tools/harness/review.mjs`
  from the root, on Luna, never by a Claude agent (Claude writes them: the family rule). The root
  `harness.json` and `.opencode/agents/` are copies of the template's; a test keeps them equal.
- `npm test` before every push. Commits and PRs as usual; no status in any document.
- A cloud session here runs `template/.claude/hooks/session-start.sh` (see `.claude/settings.json`):
  it installs OpenCode and `gh` and reports which keys are set (`template/docs/environment.md`).
- `docs/models.md` is the main session's model strategy here: the roster, which pair for which work,
  and what each model has shown. Update it in the same commit as a model change or a lesson from a run.
- The backlog is this repository's open GitHub issues; the issue titled "Start here" orders them.
- Before you retry a delegated run (an OpenCode review here), re-route it, or call it a failure, read
  what it returned: its final message in the session record (`/run-task`, *Read before you retry*;
  L55). Never retry blind.
