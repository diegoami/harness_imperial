# <Project>

<One line: what is being built, from what evidence.> The process is `docs/process.md`; read it
before running a task. Tasks are `docs/tasks/T<nn>.md`, indexed in `docs/tasks/README.md`.

## Rules
1. The main session plans, runs `/run-task`, triages and talks to the user. It delegates (`/delegate`):
   code to OpenCode, review to another model family, repeated decisions to Jev after a trial, and
   images and audio to OpenRouter or ElevenLabs models, whose ids come from live lists, never memory.
2. Nobody works in the main checkout but the main session: OpenCode runs in the worktree the script
   makes, Claude agents run with worktree isolation. Never `git stash`.
3. Status lives in GitHub labels. No document carries a status snapshot.
4. A question is not a request to edit files. Answer it; propose any fix and wait.
5. The Done-when is not negotiable by the implementer. It stops and reports; it never weakens an
   assertion, skips a test or edits its task file. The main session amends a Done-when on `main`
   with the reason in the commit message.
6. The reviewer is never the implementer's model family. It re-runs every Done-when line itself.
7. Merge only with an approving review and green CI. Two rework rounds, then escalate. After a heavy
   review, the next round's implementer moves one step up, never down (`/run-task`). (L38)
8. Relay review findings in full, never a subset.
9. A test proves behaviour only if it fails when the behaviour is removed; a claim that nothing
   failed is re-taken before it is believed.
10. A comment asserting behaviour at an edge arrives with the test that visits that edge.
11. Until the first playable build, schedule only bugs that break play; the rest are `post-playable`.
12. A bug whose fix stays in the files it names and changes no outcome is a `fix`; a blocking
    one-file mechanical fix may ride the PR that found it, declared under Scope.
13. Design decisions go to the user; nothing else waits for the user.
14. At session start: `gh issue list --label triage:needed --state open`, and any task in flight.

## Token economy
15. A brief carries the task file pasted in full, never a pointer to it.
16. Keep every file an agent must read under ~20k tokens. Scope searches to the source and test
    directories; keep terminal output quiet; show diffs, not files.

## Conditional (delete what does not apply)
17. [evidence-driven] Every constant traces to evidence; a `[designed]` value says what was searched.
18. [seeded] No wall clock or unseeded random in rule code; a seeded test proves it.
19. [files outside CI] Tests that need them skip explicitly; CI fetches a private fixtures repo.
20. [research repo, or a task that measures] Commit and push without asking. Measurements a finding
    may cite go under a tracked path, pushed per batch and every 30 minutes, never deleted. (L40)
