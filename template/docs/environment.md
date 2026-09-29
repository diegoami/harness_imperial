# Environment

What a session needs so the main session can delegate. Everything here is optional: each missing
piece turns one delegate off, and the main session falls back to Claude (the scripts exit 3).

## Keys

In **Claude Code on the web**, set these in the environment's settings: the cloud environment menu
in the session's title bar, then **Edit**, then the environment variables (or API credentials, where
that section is offered). A new session picks them up. On **your machine**, set them in your shell.
Never paste a key into a chat, and never commit one.

| Variable | Used by | Without it |
| --- | --- | --- |
| `OPENCODE_API_KEY` | OpenCode's `opencode/*` models (OpenCode Zen and Go): the implementer and reviewer models in `harness.json` | `implement.mjs` and `review.mjs` fail over and exit 3; use Claude agents |
| `OPENROUTER_API_KEY` | Jev, through OpenRouter (`jev.mjs`); also OpenCode's `openrouter/*` models, if `harness.json` names any | `jev.mjs` exits 3; the main session decides every item itself |
| `ELEVENLABS_API_KEY` | ElevenLabs: speech, voices, sound effects, music (`/delegate`, `models.mjs elevenlabs`) | no generated audio; the main session says so |
| `GH_TOKEN` | `gh`, inside the tools and inside OpenCode's runs: finding the PR, `gh pr create`, posting a review, labels | the scripts cannot find or post to PRs |

For `GH_TOKEN`, use a fine-grained token limited to the project's repository, with read and write on
Contents, Pull requests and Issues.

OpenCode reads both `OPENCODE_API_KEY` and `OPENROUTER_API_KEY` from the environment (checked with
`opencode auth list` on 1.18.33), so it needs no `opencode auth login`.

## Network

A cloud environment's network policy must allow:

| Host | For |
| --- | --- |
| `opencode.ai` | OpenCode's own providers (Zen, Go) |
| `openrouter.ai` | Jev, OpenRouter models, image generation |
| `api.elevenlabs.io` | ElevenLabs |
| `registry.npmjs.org` | installing OpenCode |
| `api.github.com`, `github.com` | `gh` and git |
| the Ubuntu package archive | installing `gh` with apt |
| `models.dev` | OpenCode's model list. Optional: runs worked without it, but allow it if `opencode models` shows stale ids. |

## The session-start hook

`.claude/hooks/session-start.sh`, registered in `.claude/settings.json`, runs at the start of every
session on the web (and does nothing locally). It:
- installs `opencode-ai@1.18` with npm and `gh` with apt, if they are missing;
- reports which keys are set, as the session's first context.

It never fails the session. OpenCode is pinned to the 1.18 line because the runner's assumptions were
checked against it:
- the `run` flags;
- `session list --format json`, with `id`, `title`, `directory`, `created` and `updated`;
- `export`, whose `info.agent` names the agent that actually ran.

Change the pin only after running the tools against the new version.

On your machine, install the same things yourself: `npm install -g opencode-ai@1.18`, `gh`, and
Node 20 or later.

## First session: check it works

1. The hook's report shows every key `set`, and no setup notes.
2. `opencode models opencode | head` lists the ids in `harness.json`. If an id differs, edit
   `harness.json`.
3. Jev: put two lines such as `{"id": 1, "state": {"title": "Game crashes on load"}}` in
   `items.jsonl`, then run `node tools/harness/jev.mjs ask --decision breaks-play --in items.jsonl`.
   It should print `asked 2 of 2`.
4. OpenCode: run `/run-task` on a small `fix`, and watch the first run: the tail of its log and the
   `implemented by:` line.
