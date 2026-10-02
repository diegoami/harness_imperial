#!/usr/bin/env node
// The PreToolUse hook of the Claude agents (.claude/agents/reviewer.md, implementer.md):
//
//   node "$CLAUDE_PROJECT_DIR/tools/harness/guard.mjs" reviewer|implementer
//
// Reads the hook's JSON on stdin. A Bash command that the role may not run (lib/guard.mjs) is
// blocked: exit 2, with the reason on stderr, which the agent sees as the tool's error. Anything else
// exits 0. Input it cannot read is blocked too: a guard that fails open guards nothing.

import { refusal } from './lib/guard.mjs';

const role = process.argv[2];
let input = '';
for await (const chunk of process.stdin) input += chunk;
let event;
try { event = JSON.parse(input); } catch {
  console.error(`guard (${role}): the hook input is not JSON, so the command is refused.`);
  process.exit(2);
}
if (event?.tool_name !== 'Bash') process.exit(0);
// A Bash call whose command cannot be read is refused too (Luna's R2, round 2).
if (typeof event?.tool_input?.command !== 'string') {
  console.error(`guard (${role}): the Bash call has no command string, so it is refused.`);
  process.exit(2);
}
const reason = refusal(event.tool_input.command, role);
if (reason) {
  console.error(`guard: ${reason}. The harness forbids it for this agent (tools/harness/lib/guard.mjs).`);
  process.exit(2);
}
process.exit(0);
