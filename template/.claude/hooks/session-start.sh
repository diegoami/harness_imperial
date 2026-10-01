#!/bin/bash
# SessionStart, Claude Code on the web only: install what the harness's tools call, then tell the
# session which delegates are on. It never fails the session: a missing tool or key only turns a
# delegate off, and the main session falls back as docs/process.md says.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# OpenCode's CLI surface (run flags, `session list --format json`, `export`) was checked on 1.18.
# Bump this deliberately, after running tools/harness against the new version.
OPENCODE_VERSION="1.18"
notes=()

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 20 ]; then
  notes+=("Node $node_major is too old for tools/harness (needs 20+).")
fi

if ! opencode --version 2>/dev/null | grep -q "^${OPENCODE_VERSION}\."; then
  npm install -g "opencode-ai@${OPENCODE_VERSION}" >/dev/null 2>&1 \
    || notes+=("Could not install opencode-ai@${OPENCODE_VERSION} from npm.")
fi

if ! command -v gh >/dev/null 2>&1; then
  { apt-get install -y -qq gh || { apt-get update -qq && apt-get install -y -qq gh; }; } >/dev/null 2>&1 \
    || notes+=("Could not install gh with apt-get.")
fi

on_off() { if [ -n "${!1:-}" ]; then echo "set"; else echo "MISSING"; fi; }

# What the session reads at start (stdout of a SessionStart hook goes into its context).
echo "Harness environment:"
echo "- node $(node --version 2>/dev/null || echo none), opencode $(opencode --version 2>/dev/null || echo none), gh $(gh --version 2>/dev/null | head -1 | awk '{print $3}' || echo none)"
oc_data="${HARNESS_OPENCODE_HOME:-$HOME/.local/share/harness-opencode}/data"
echo "- OpenCode Go (implementer and reviewer, opencode-go/* models): $(XDG_DATA_HOME="$oc_data" opencode models opencode-go 2>/dev/null | grep -q . && echo "logged in" || echo "NOT logged in for the scripts' data directory: XDG_DATA_HOME=$oc_data opencode console login")"
echo "- OpenAI (reviewer, openai/gpt-6-luna): $(opencode models openai 2>/dev/null | grep -q . && echo "logged in" || echo "NOT logged in: opencode auth login, then choose OpenAI")"
echo "- OPENCODE_API_KEY: $(on_off OPENCODE_API_KEY) (OpenCode Zen's opencode/* models, only if harness.json names any)"
echo "- OPENROUTER_API_KEY: $(on_off OPENROUTER_API_KEY) (Jev decisions, image models, and OpenCode's openrouter/* models)"
echo "- ELEVENLABS_API_KEY: $(on_off ELEVENLABS_API_KEY) (speech, sound effects, music; /delegate)"
echo "- GH_TOKEN: $(on_off GH_TOKEN) (gh in tools/harness: PR lookup, comments, labels)"
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "  Jev is off: jev.mjs exits 3, so decide every item yourself."
fi
for n in "${notes[@]}"; do echo "  Setup: $n"; done
echo "Delegates and how to pick their models (live lists, never memory): the /delegate skill."
echo "See docs/environment.md for what each key needs and which hosts the network policy must allow."
exit 0
