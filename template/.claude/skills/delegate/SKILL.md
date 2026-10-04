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
| Code: implement a task or a fix | OpenCode GLM-5.3 Flash, then DeepSeek V4.1 Flash, then a Claude Sonnet agent | `/run-task` → `tools/harness/implement.mjs` | Z.AI's login (`opencode auth login`) and OpenCode Go's (`opencode console login`) to implement; OpenAI's (`opencode auth login`) to review |
| Review a PR | GPT-5.6 Luna on OpenAI, through OpenCode (default), then a Claude Opus agent; never the implementer's family | `/run-task` → `tools/harness/review.mjs`, or Agent | as above |
| Repeated decisions with known answers (triage, routing, gating, labelling) | Jev | `/jev` → `tools/harness/jev.mjs` | `OPENROUTER_API_KEY` |
| Images: sprites, icons, maps, mockups, illustrations | An image model on OpenRouter | pick one with `models.mjs openrouter --output image` | `OPENROUTER_API_KEY` |
| A second opinion from another model family, or reading audio or images | A model on OpenRouter | `models.mjs openrouter --input image` (or `audio`) | `OPENROUTER_API_KEY` |
| Speech, voices, sound effects, music | ElevenLabs | `models.mjs elevenlabs` | `ELEVENLABS_API_KEY` |
| Judgment that needs a written reason, design, planning | You, or a Claude agent | — | — |

The session-start report says which keys are set. A delegate without its key is off; do the work
another way, or tell the user what is missing (`docs/environment.md`).

## Picking a model

1. **Never from memory.** Model ids and prices change faster than any document. List them live:
   - `node tools/harness/models.mjs openrouter --output image`;
   - `node tools/harness/models.mjs elevenlabs`;
   - `opencode models opencode-go` for implementers (OpenCode Go), `opencode models openai` for the
     reviewer.

   Do the same when you are unsure a model still exists. (L25)
   To change the implementer's or reviewer's model itself, use `/switch-model`.
2. **Check the quota first** (L50). Where quota-tracker runs (`curl -sf localhost:8765/health`),
   `curl -s localhost:8765/avoid` lists the providers out of quota and when each is usable again,
   and `curl -s localhost:8765/best` those with quota, most headroom first (`docs/environment.md`).
   Skip a model whose provider is `exhausted`: name the next model of its chain that has quota
   (`--model` for `implement.mjs`, `--reviewer` for `review.mjs`) and say so in the run's report.
3. **Choose on the evidence you have.** In order of preference:
   - this project's own measurements (review rounds and tokens per task, from the merge comments);
   - a small trial;
   - the listed price and capabilities.

   Vendor benchmarks come last.
4. **Record the choice where it is used.** Implementer and reviewer models go in `harness.json`,
   and a task's own choice goes in its task file, with the date and the reason in the commit
   message. A generated asset gets a sidecar next to it, `<asset>.json`, with the provider, the
   model id, the prompt, the date and the cost. That records where it came from, and lets it be
   made again.
5. **Say the cost first.** Before a batch (many images, a long narration), tell the user the
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
