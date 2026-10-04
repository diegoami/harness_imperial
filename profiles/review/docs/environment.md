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
- On Linux and WSL, bubblewrap (`sudo apt install bubblewrap`): the reviewer runs in it without your
  GitHub credentials (`tools/harness/lib/jail.mjs`, #68). Without it, the script warns first. In the
  jail, home is empty but for the repository and the tools on PATH; add any other folder the
  checks need to `harness.json`'s `jail.keep` (read-only, e.g. `"~/.dotnet"`).

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

## The logins, one per reviewer

| Reviewer | Login | Check |
| --- | --- | --- |
| GLM-5.3 Flash, first | `opencode auth login`, then Z.AI Coding Plan (an API key; OpenCode also reads `ZHIPU_API_KEY`) | `opencode models zai-coding-plan` lists `zai-coding-plan/glm-5.3-flash` |
| GPT-6 Luna, second and the second opinion | `opencode auth login`, then OpenAI (a ChatGPT login or an API key) | `opencode models openai` lists `openai/gpt-6-luna` |
| DeepSeek V4.1 Flash, third | `XDG_DATA_HOME="$HOME/.local/share/harness-opencode/data" opencode console login` (OpenCode Go) | `opencode models opencode-go` lists `opencode-go/deepseek-v4.1-flash` |

Before any run the script checks that OpenCode lists each reviewer it may use; one that is not
listed is skipped, with the command that fixes it, and nothing is billed for it. Never paste a key
into a chat, and never commit one.

## First check

From the main checkout: `node tools/harness/review.mjs --self-test` (no model is called), then
`node tools/harness/switch-model.mjs --show`.
