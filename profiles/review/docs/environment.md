# Environment

What `tools/harness/review.mjs` needs on this machine. A reviewer that cannot run makes the script
exit 3, and the main session tells the user: there is no Claude reviewer here.

## The tools

- Node 20 or later.
- `gh`, logged in (`gh auth login`).
- OpenCode 1.x (`opencode --version`); the script refuses 2.x, the desktop app's CLI, before
  anything is billed. In WSL, use OpenCode's Linux binary in `~/.opencode/bin` (its own installer
  puts it there): the `opencode` WSL finds on PATH is often the Windows npm shim under `/mnt/c`,
  which the script skips. `HARNESS_OPENCODE_EXE` names another. Avoid `opencode upgrade`.

## The scripts' own data directory

`review.mjs` runs OpenCode with a data directory of its own, `~/.local/share/harness-opencode`
(`HARNESS_OPENCODE_HOME` moves it), so the desktop app can never migrate its database. API-key
logins (`auth.json`) are copied in from `~/.local/share/opencode` when the copy is missing or
older; Go's login is not, and is made for this directory. Check each provider with that directory's
variables set:

```bash
export XDG_DATA_HOME="$HOME/.local/share/harness-opencode/data" XDG_CACHE_HOME="$HOME/.local/share/harness-opencode/cache" XDG_STATE_HOME="$HOME/.local/share/harness-opencode/state"
opencode models zai-coding-plan; opencode models openai; opencode models opencode-go
```

## Quota: quota-tracker

Where the machine runs quota-tracker, a local service, it reports how much subscription quota is
left on each provider: `claude` (the main session), `openai` (Sol and Luna, via
OpenCode), `zai` (GLM-5.3 and GLM-5.3 Flash), `opencode_go` (DeepSeek) and `openrouter` (prepaid
credit). Check it before choosing, recommending or delegating to a model (L50). It is read-only, on
localhost, with no auth; results are cached 60 s, and `?refresh` bypasses the cache:
- `curl -s localhost:8765/quota`, or `/quota/<provider>` for one;
- `curl -s localhost:8765/best`: the providers with quota left, most headroom first;
- `curl -s localhost:8765/avoid`: the providers out of quota, with when each is usable again.

Each provider has a `status`: `ok` (under 80% used), `low` (80% or more), `exhausted` (95% or
more: do not use it until `available_at` / `available_in`), `error` (it could not be checked;
`error` says why) or `not_configured`. `headroom_pct` is the percent left on its most-used window;
`windows[]` lists every limit with `used_pct` and when it resets. OpenRouter is prepaid: its
windows never reset, and `remaining_usd` is the balance. A model with a pool of its own has its
own window, named after it: today GPT-5.6 Luna (`gpt-5.6-luna:7d`), which can be usable while
OpenAI's main `7d` window, the one GPT-6 Luna and Sol draw on, is exhausted. Read which pools exist
from the windows the endpoint returns, not from this page.

The models per provider, heavy and light:

| Provider | Heavy | Light |
| --- | --- | --- |
| claude | `claude --model opus` | `claude --model sonnet` |
| openai | `opencode -m openai/gpt-6.1-sol` | `opencode -m openai/gpt-5.6-luna` |
| zai | `opencode -m zai-coding-plan/glm-5.3` | `opencode -m zai-coding-plan/glm-5.3-flash` |
| opencode_go | `opencode -m opencode-go/deepseek-v4-pro` | `opencode -m opencode-go/deepseek-v4.1-flash` |
| openrouter | `opencode -m openrouter/deepseek/deepseek-v4-pro` | `opencode -m openrouter/deepseek/deepseek-v4.1-flash` |

GPT-5.6 Luna, the reviewer (L51), has its own weekly limit: for light work OpenAI is usable while
the `gpt-5.6-luna:7d` window in `/quota/openai` is under 95%, even when OpenAI's main window is
exhausted.

If `curl -sf localhost:8765/health` fails where the service is installed:
1. `systemctl --user restart quota-tracker`, wait a few seconds, and check `/health` again.
2. If systemctl says `Failed to connect to bus`, the user's systemd instance is not running: ask
   the user to run `sudo loginctl enable-linger $USER`, then retry step 1.
3. If it still fails, read `journalctl --user -u quota-tracker -n 50` and tell the user what it says.
4. To run it without the service: `cd ~/projects/models_quota_tracker && uv run quota-tracker serve`
   in the background (it stops when the session ends).

`implement.mjs` and `review.mjs` ask the service themselves before their chain runs (`lib/quota.mjs`,
L52): a model with a window of its own (GPT-5.6 Luna's `gpt-5.6-luna:7d`) is judged by that window
alone, skipped at 95% or more even when its provider is not exhausted, and run under 95% even when
it is; any other model is skipped when its provider is `exhausted`. A provider in `error` or
`not_configured` skips nothing. Each skip is logged with its reason, and with none left the script
exits 3. `HARNESS_QUOTA_URL` names another
address. Where the service does not answer, they skip nothing and log `quota: not checked`.

Never read or edit `~/.config/quota-tracker/config.toml`: it holds account tokens. A provider in
`error` over an expired cookie or token goes to the user, since renewing it needs their browser or
login. Where the service is not installed, go on without it, and count a usage-limit error as
`exhausted`.



| Reviewer | Login | Check |
| --- | --- | --- |
| GLM-5.3 Flash, first | `opencode auth login`, then Z.AI Coding Plan (an API key; OpenCode also reads `ZHIPU_API_KEY`) | `opencode models zai-coding-plan` lists `zai-coding-plan/glm-5.3-flash` |
| GPT-5.6 Luna, second and the second opinion | `opencode auth login`, then OpenAI (a ChatGPT login or an API key) | `opencode models openai` lists `openai/gpt-5.6-luna` |
| DeepSeek V4.1 Flash, third | `XDG_DATA_HOME="$HOME/.local/share/harness-opencode/data" opencode console login` (OpenCode Go) | `opencode models opencode-go` lists `opencode-go/deepseek-v4.1-flash` |

Before any run the script checks that OpenCode lists each reviewer it may use; one that is not
listed is skipped, with the command that fixes it, and nothing is billed for it. Never paste a key
into a chat, and never commit one.

## First check

From the main checkout: `node tools/harness/review.mjs --self-test` (no model is called), then
`node tools/harness/switch-model.mjs --show`.
