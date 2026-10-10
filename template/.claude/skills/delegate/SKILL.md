---
name: delegate
description: Choose who does a piece of work, and on which model. Claude agents review and judge; OpenCode implements and reviews code; Jev takes repeated decisions; models on OpenRouter make images and give other model families; ElevenLabs makes speech, sound effects and music. Use before doing work yourself that a cheaper or better-suited model could do, whenever a task needs an image, a sound or a voice, and whenever you are about to name a model id.
---

# /delegate: who does the work, and on which model

You are the main session. Your time and tokens are the scarce resource. Before doing work
yourself, check whether a delegate below does it better or cheaper.

## The delegates

| Work | Delegate | How | Key |
| --- | --- | --- | --- |
| Code: implement a task or a fix | The model `/recommend` gives (*Choosing models* below): an OpenCode model, or a Claude agent when it ranks Claude | `/run-task` → `tools/harness/implement.mjs` | each provider's login in the scripts' data directory (`docs/environment.md`) |
| Review a PR | The model `/recommend` gives, never the implementer's family (rules 2 and 3 below) | `/run-task` → `tools/harness/review.mjs`, or Agent | as above |
| Repeated decisions with known answers (triage, routing, gating, labelling) | Jev | `/jev` → `tools/harness/jev.mjs` | `OPENROUTER_API_KEY` |
| Images: sprites, icons, maps, mockups, illustrations | An image model on OpenRouter | pick one with `models.mjs openrouter --output image` | `OPENROUTER_API_KEY` |
| A second opinion from another model family, or reading audio or images | A model on OpenRouter | `models.mjs openrouter --input image` (or `audio`) | `OPENROUTER_API_KEY` |
| Speech, voices, sound effects, music | ElevenLabs | `models.mjs elevenlabs` | `ELEVENLABS_API_KEY` |
| Judgment that needs a written reason, design, planning | You, or a Claude agent | — | — |

The session-start report says which keys are set. A delegate without its key is off; do the work
another way, or tell the user what is missing (`docs/environment.md`).

## Choosing models

For every implementer, reviewer and any other coding model, these rules (the owner's, #168, L72),
word for word; nothing else decides:

1. Ask the quota service with the tier the work needs:
   - `tier=heavy`: implementation work, and hard reviews
   - `tier=light`: small tasks, and simple reviews
   e.g. `curl -s "http://localhost:8765/recommend?tier=heavy"`
2. A task that needs an implementer and a reviewer: one call. The implementer is
   `pair.implementer` and the reviewer is `pair.reviewer` (same tier as the call; for a simple
   review of heavy work, add `&review_tier=light`). Run each one's `command`.
3. A review on its own (the implementation was done earlier): add
   `&exclude_family=<the implementer's family>` and use `pick`.
4. Any other single model: use `pick`.
5. If a chosen model can't run, use the next row of `ranking` (in `rank` order). For a
   reviewer chosen in rule 2, skip rows with the same `family` as the implementer.
6. Nothing else decides which model to use: no lists, chains, exclusions, score thresholds
   or percentages of your own. Every row in `ranking` is usable; rows in `skipped` are not.
7. Record the rows you used and their `reasons` with the run.
8. If the service doesn't answer: run `systemctl --user restart quota-tracker` in WSL and
   retry. If it still doesn't answer, tell the owner; don't choose a model yourself.

## Picking a media model

For images, audio and the other OpenRouter and ElevenLabs models `/recommend` does not rank:

1. **Never from memory.** Model ids and prices change faster than any document. List them live:
   - `node tools/harness/models.mjs openrouter --output image`;
   - `node tools/harness/models.mjs elevenlabs`.

   Do the same when you are unsure a model still exists. (L25)
2. **Choose on the evidence you have.** In order of preference:
   - this project's own measurements;
   - a small trial;
   - the listed price and capabilities.

   Vendor benchmarks come last.
3. **Record the choice where it is used.** A generated asset gets a sidecar next to it,
   `<asset>.json`, with the provider, the model id, the prompt, the date and the cost. That records
   where it came from, and lets it be made again.
4. **Say the cost first.** Before a batch (many images, a long narration), tell the user the
   estimated cost from the listed prices, and ask when it is more than a few dollars.

## Making media

Call the provider's API directly, with `fetch` from Node. Read the API reference for the endpoint
before the first call in a project, because request shapes change. Then keep the working call in a
small script under `tools/`, so the next asset is one command. Starting points (check them first):
- **OpenRouter images:** `POST https://openrouter.ai/api/v1/chat/completions`, with an image-output
  model and `"modalities": ["image", "text"]`. The image comes back in the assistant message.
- **ElevenLabs:** `POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id>` for speech, and
  `POST https://api.elevenlabs.io/v1/sound-generation` for sound effects. Both use the `xi-api-key`
  header and return audio bytes.

Generated assets are project content: commit them with their sidecar, and review them the way the
project reviews its UI (a person looks at the screen).

## Never

- Name a model id you have not just seen in a live list.
- Send private repository content or personal data to a provider the user has not cleared for it.
- Spend on a batch without saying the cost first.

## A rule's carve-out (process.md §10)

When a project's `CLAUDE.md` loosens a rule by carve-out, three changes merge before the first
task that uses it: the known-good table in a finding, the gate in `tools/` that checks every
record against it, and the task file for the first run, which names the carve-out's lettered
preconditions as Done-when lines. Delegate a `model-driven` task only once the gate accepts the
implementer's run records; such a run corroborates the owner's runs, never replaces them, and its
results amend the wording one claim at a time, never in bulk. (L63)
