#!/usr/bin/env node
// A stand-in for `opencode` that reproduces the failures the runner guards against.
// FAKE_OC_STATE: the file that names OpenCode's session store (fake-state.mjs).
// FAKE_OC_MODE (for `run`): ok | read-stdin | no-session | idle | exit-no-session | exit2 |
//   fallback | quote | slow | utf8 | implement | commit-fail | stop-report | permission | permission-dirty | invalid-key |
//   permission-review | permission-quoted | permission-plain | review-ok | review-cut |
//   provider-error | provider-stderr | provider-dirty | provider-auth | idle-tool | commit-provider | pr-provider (L69, L70)
// FAKE_OC_MODES: a JSON map of model id -> mode, which wins over FAKE_OC_MODE.
// FAKE_GH_STATE: the fake gh's PR list, which `implement` adds to.
// FAKE_OC_MODELS (for `models <provider>`): a JSON list of the ids OpenCode lists; by default the
//   ids harness.json names. A provider with none fails like OpenCode 1.18.34 ("Provider not
//   found"). FAKE_OC_MODELS_ERROR: stderr for a `models` that fails for another reason.
//   FAKE_OC_VARIANTS: a JSON map of id -> efforts for `models --verbose` (default low, high, max).
//   Each session records the XDG_DATA_HOME it ran with, the prompt it was given, and the agent file
//   OpenCode 1.18.34 would load (checked by hand): OPENCODE_CONFIG_DIR's agents/ over the
//   project's .opencode/agents/; with OPENCODE_DISABLE_PROJECT_CONFIG=1 never the project's.
// FAKE_OC_SESSION_OUTPUT (for `session list`): what it prints instead of the state, with
//   FAKE_OC_SESSION_STDERR on stderr; FAKE_OC_SESSION_SLEEP_MS: a delay before it answers.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readSessions, writeSession } from './fake-state.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const stateFile = process.env.FAKE_OC_STATE;
let mode = process.env.FAKE_OC_MODE || 'ok';
const load = () => readSessions(stateFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const forever = () => setInterval(() => {}, 1 << 30);

if (cmd === '--version') {
  // FAKE_OC_VERSION: what `--version` prints (default 1.18.34); "none" makes it fail.
  if (process.env.FAKE_OC_VERSION === 'none') process.exit(1);
  process.stdout.write(`${process.env.FAKE_OC_VERSION ?? '1.18.34'}\n`);
  process.exit(0);
}
if (cmd === 'session') {
  if (process.env.FAKE_OC_SESSION_SLEEP_MS) await sleep(Number(process.env.FAKE_OC_SESSION_SLEEP_MS));
  if (process.env.FAKE_OC_SESSION_STDERR) process.stderr.write(process.env.FAKE_OC_SESSION_STDERR);
  process.stdout.write(process.env.FAKE_OC_SESSION_OUTPUT ?? JSON.stringify(load()));
  process.exit(process.env.FAKE_OC_SESSION_OUTPUT === undefined ? 0 : 1);
}
if (cmd === 'models') {
  const ids = JSON.parse(process.env.FAKE_OC_MODELS
    || '["opencode-go/mimo-v2.6-flash", "openai/gpt-5.6-luna", "openai/gpt-6-luna", "opencode-go/spare-model"]');
  // FAKE_OC_MODELS_ERROR_PROVIDER: only that provider's listing fails.
  if (process.env.FAKE_OC_MODELS_ERROR && (!process.env.FAKE_OC_MODELS_ERROR_PROVIDER || process.env.FAKE_OC_MODELS_ERROR_PROVIDER === rest[0])) {
    process.stderr.write(`${process.env.FAKE_OC_MODELS_ERROR}\n`); process.exit(1);
  }
  const mine = ids.filter((id) => !rest[0] || id.startsWith(`${rest[0]}/`));
  if (!mine.length) { process.stderr.write(`Error: Provider not found: ${rest[0]}\n`); process.exit(1); }
  // --verbose: each id, then its JSON with the efforts FAKE_OC_VARIANTS (id -> list) gives it.
  const variants = JSON.parse(process.env.FAKE_OC_VARIANTS || '{}');
  process.stdout.write(mine.map((id) => (rest.includes('--verbose')
    ? `${id}\n${JSON.stringify({ id, variants: Object.fromEntries((variants[id] ?? ['low', 'high', 'max']).map((v) => [v, {}])) }, null, 2)}\n`
    : `${id}\n`)).join(''));
  process.exit(0);
}
if (cmd === 'export') {
  const s = load().find((x) => x.id === rest[0]);
  if (!s || process.env.FAKE_OC_EXPORT_FAIL) process.exit(1);
  // A long session's export is large; the real OpenCode exits before a pipe has taken all of it.
  // So does Node: process.exit() drops what a pipe has not yet taken, but a file is written at once.
  const messages = process.env.FAKE_OC_BIG_EXPORT ? [{ text: 'x'.repeat(4 << 20) }] : [];
  if (s.parts) messages.push({ info: { role: 'user' }, parts: [{ type: 'text', text: 'the brief' }] }, { info: { role: 'assistant' }, parts: s.parts });
  // A rejected tool call, as OpenCode 1.18.34 records it.
  if (s.rejected) messages.push({ parts: [{ type: 'tool', tool: 'read', state: { status: 'error', error: 'The user rejected permission to use this specific tool call.' } }] });
  // Denied calls (#146), each as OpenCode 1.18.34 records it, then the model's own text unless the
  // run stopped at the last one.
  for (const d of s.denials ?? []) {
    const error = d.kind === 'denied' ? 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []'
      : 'The user rejected permission to use this specific tool call.';
    const input = d.inputObject ?? (d.tool === 'bash' ? { command: d.input } : { filePath: d.input });
    messages.push({ info: { role: 'assistant' }, parts: [{ type: 'tool', tool: d.tool, state: { status: 'error', input, error } }] });
  }
  // FAKE_OC_DENY_AFTER: what follows the last denial instead of the model's own text (Sol's R1 on PR 155).
  const after = process.env.FAKE_OC_DENY_AFTER ? JSON.parse(process.env.FAKE_OC_DENY_AFTER) : [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'went on' }] }];
  if (s.denials?.length && s.recovered) messages.push(...after);
  // What the session was doing when it stopped (L69), as OpenCode 1.18.34 records it: an assistant
  // message not yet completed with a tool still running, or the provider's error on the last one.
  if (s.running) messages.push({ info: { role: 'assistant', time: { created: s.created } }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'running', input: { command: s.running } } }] });
  if (s.apiError) messages.push({ info: { role: 'assistant', time: { created: s.created, completed: s.created }, error: s.apiError }, parts: [] });
  // FAKE_OC_EXPORT_STALE: the first export, the live one, holds no denials yet (Sol's R3 on PR 155).
  if (process.env.FAKE_OC_EXPORT_STALE) {
    const flag = `${process.env.FAKE_OC_STATE}.stale-served`;
    if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.stdout.write(JSON.stringify({ messages: [], info: { agent: s.agent } })); process.exit(0); }
  }
  process.stdout.write(JSON.stringify({ messages, info: { agent: s.agent } }));
  process.exit(0);
}
if (cmd !== 'run') process.exit(64);

const arg = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const title = arg('--title');
const modes = JSON.parse(process.env.FAKE_OC_MODES || '{}');
if (modes[arg('--model')]) mode = modes[arg('--model')];
const git = (...a) => spawnSync('git', ['-C', arg('--dir'), ...a], { encoding: 'utf8' });
const commit = () => {
  fs.writeFileSync(path.join(arg('--dir'), 'feature.txt'), `built by ${arg('--model')}\n`);
  git('add', 'feature.txt');
  git('-c', 'user.name=fake', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', 'feature');
};
const agent = arg('--agent');
const id = `ses_${Math.random().toString(36).slice(2, 10)}`;
const agentFile = (() => {
  if (!agent) return null;
  const dirs = [
    ...(process.env.OPENCODE_DISABLE_PROJECT_CONFIG === '1' ? [] : [path.join(process.cwd(), '.opencode')]),
    ...(process.env.OPENCODE_CONFIG_DIR ? [process.env.OPENCODE_CONFIG_DIR] : []),
  ];
  return dirs.map((d) => path.join(d, 'agents', `${agent}.md`)).filter((f) => fs.existsSync(f)).at(-1) ?? null;
})();
let mine = null;
// The pointer prompt names the brief file (L60); read its content so the session record and the
// review modes below carry what the agent actually receives, not only the pointer.
const pointer = rest.at(-1);
const named = pointer.match(/\.harness-brief-([\w.-]+)\.md/);
const briefFile = named ? path.join(arg('--dir') ?? '.', `.harness-brief-${named[1]}.md`) : null;
const brief = briefFile && fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : null;
// FAKE_OC_DENIALS gives any mode's session denied calls (#146); FAKE_OC_DENIALS_MODEL, one model's only.
const deniedHere = process.env.FAKE_OC_DENIALS && (!process.env.FAKE_OC_DENIALS_MODEL || process.env.FAKE_OC_DENIALS_MODEL === arg('--model'))
  ? { denials: JSON.parse(process.env.FAKE_OC_DENIALS), recovered: !process.env.FAKE_OC_DENY_STOPPED } : {};
const createSession = (recordedAgent = agent, extra = {}) => {
  // FAKE_OC_PARTS: the agent's steps in the session record, as OpenCode 1.18.34 exports parts (#148).
  mine = { ...deniedHere, ...(process.env.FAKE_OC_PARTS ? { parts: JSON.parse(process.env.FAKE_OC_PARTS) } : {}), ...extra, id, title, directory: process.cwd(), created: Date.now(), updated: Date.now(), agent: recordedAgent,
    dataHome: process.env.XDG_DATA_HOME ?? null, prompt: pointer, agentFile, brief,
    tmpdir: process.env.TMPDIR ?? null, temp: process.env.TEMP ?? null, tmp: process.env.TMP ?? null,
    configDir: process.env.OPENCODE_CONFIG_DIR ?? null, configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null,
    agentText: (() => { try { return agentFile ? fs.readFileSync(agentFile, 'utf8') : null; } catch { return null; } })(),
    projectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG === '1' ? 'disabled' : 'read',
    agentDescription: agentFile ? fs.readFileSync(agentFile, 'utf8').match(/^description: (.*)$/m)?.[1] ?? null : null };
  writeSession(stateFile, mine);
};
const touch = () => { if (mine) { mine.updated = Date.now(); writeSession(stateFile, mine); } };
if (process.env.FAKE_OC_PIDFILE) {
  // A grandchild, to prove the whole tree is killed.
  const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_OC_PIDFILE, String(g.pid));
}

switch (mode) {
  case 'read-stdin': {
    // Like the real `opencode run`: nothing happens until stdin reaches end-of-file.
    for await (const _ of process.stdin) { /* drain */ }
    createSession();
    process.stdout.write('done after stdin EOF\n');
    process.exit(0);
    break;
  }
  case 'no-session': forever(); break;
  case 'idle': createSession(); forever(); break;
  case 'idle-tool': createSession(agent, { running: 'npm test' }); forever(); break;
  case 'provider-dirty':
    // A provider that stopped answering after the implementer edited without committing (#87, L69).
    fs.appendFileSync('README.md', 'edited, not committed\n');
    fs.writeFileSync('new-file.txt', 'untracked work\n');
    // falls through
  case 'provider-error':
    createSession(agent, { apiError: { name: 'APIError', data: { message: 'Service Unavailable', statusCode: 503, isRetryable: true } } });
    process.stderr.write('\x1b[91m\x1b[1mError: \x1b[0mService Unavailable\n');
    process.exit(1);
    break;
  case 'provider-stderr':
    // No error in the record; OpenCode's own stderr names the rate limit.
    createSession();
    process.stderr.write('\x1b[91m\x1b[1mError: \x1b[0mAPICallError: 429 Too Many Requests: rate limit exceeded\n');
    process.exit(1);
    break;
  case 'provider-auth':
    // A 401 is our setup (a stale key), not a provider that did not answer.
    createSession(agent, { apiError: { name: 'APIError', data: { message: 'Unauthorized', statusCode: 401, isRetryable: false } } });
    process.stderr.write('Error: Unauthorized\n');
    process.exit(1);
    break;
  case 'exit-no-session': process.exit(1); break;
  case 'exit2': createSession(); process.exit(2); break;
  case 'fallback':
    process.stderr.write(`\x1b[93m\x1b[1m! \x1b[0m agent "${agent}" not found. Falling back to default agent\n`);
    createSession('build');
    process.stdout.write('ran on the default agent\n');
    process.exit(0);
    break;
  case 'quote':
    createSession();
    process.stdout.write(`R1: the guard matches '! agent "${agent}" not found. Falling back to default agent' anywhere\n`);
    process.stderr.write(`tool output:\n  grep: ! agent "${agent}" not found. Falling back to default agent\n`);
    process.exit(0);
    break;
  case 'slow':
    createSession();
    setInterval(touch, 50);
    break;
  case 'implement': {
    createSession();
    commit();
    git('push', '-q', 'origin', 'HEAD');
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const gh = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
    gh.prs.push({ number: 100 + gh.prs.length, head: branch, url: `https://example.com/pr/${100 + gh.prs.length}` });
    fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(gh));
    git('checkout', '-q', '--detach');
    process.stdout.write('report: built feature.txt\n');
    process.exit(0);
    break;
  }
  case 'commit-fail': createSession(); commit(); process.exit(1); break;
  case 'pr-provider': {                                // opened its PR, then the provider stopped answering
    createSession(agent, { apiError: { name: 'APIError', data: { message: 'Service Unavailable', statusCode: 503, isRetryable: true } } });
    commit();
    git('push', '-q', 'origin', 'HEAD');
    const head = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
    state.prs.push({ number: 100 + state.prs.length, head, url: `https://example.com/pr/${100 + state.prs.length}` });
    fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
    process.exit(1);
    break;
  }
  case 'detach-provider':                              // committed and detached, then the provider stopped answering
    createSession(agent, { apiError: { name: 'APIError', data: { message: 'Service Unavailable', statusCode: 503, isRetryable: true } } });
    commit();
    git('checkout', '-q', '--detach');
    process.exit(1);
    break;
  case 'commit-provider':                              // committed, then the provider stopped answering
    createSession(agent, { apiError: { name: 'APIError', data: { message: 'Service Unavailable', statusCode: 503, isRetryable: true } } });
    commit();
    process.exit(1);
    break;
  case 'invalid-key':                                  // a provider that refused the key
    createSession();
    process.stderr.write('Error: Invalid API-key provided.\n');
    process.exit(1);
    break;
  case 'stop-report':
    createSession();
    process.stdout.write('STOP: Done-when 2 cannot be met: the fixture has no such city.\n');
    process.exit(0);
    break;
  case 'review-ok':
  case 'review-cut':
  case 'review-fixes':
  case 'review-decorated': {
    createSession();
    const header = (brief ?? pointer).split('\n')[0];
    process.stdout.write({
      'review-ok': `reading the diff\n${header}\napprove\n\nR1: fine (not blocking)${process.env.FAKE_OC_REVIEW_EXTRA ? `\n${process.env.FAKE_OC_REVIEW_EXTRA}` : ''}\n\napprove\n`,
      'review-cut': `${header}\nrework\n\nR1: the loop in`,
      'review-fixes': `${header}\nrework\n\nR1: this fixes #12 only in part.\n\nrework\n`,
      'review-decorated': `Here is my review.\n\n**${header.toUpperCase()}**\n\n**Verdict:** Rework.\n\nR1: x.\n\n**rework**\n\n— signed, the reviewer\n`,
    }[mode]);
    process.exit(0);
    break;
  }
  case 'permission-dirty':
    // An implementer that edited files without committing, then was rejected (#87).
    fs.appendFileSync('README.md', 'edited, not committed\n');
    fs.writeFileSync('new-file.txt', 'untracked work\n');
    // falls through
  case 'permission':
  case 'permission-cd':
  case 'permission-review': {
    // OpenCode 1.18 auto-rejects a path outside --dir in a non-interactive run, and exits 0. It then
    // prints the rejected command; permission-cd's chains cd and .. (#14).
    createSession(agent, { rejected: true });
    process.stderr.write('\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (/tmp/*); auto-rejecting\n');
    process.stderr.write(mode === 'permission-cd'
      ? '\x1b[31m✗\x1b[0m cd evidence/a && grep -n x README.md; cd ../b && ls failed\n'
      : '\x1b[31m✗\x1b[0m cat /tmp/notes.txt failed\n');
    const header = (brief ?? pointer).split('\n')[0];
    process.stdout.write(mode !== 'permission-review' ? 'report: built nothing\n' : `${header}\napprove\n\nR1: fine\n\napprove\n`);
    process.exit(0);
    break;
  }
  case 'permission-quoted': {
    // A clean review whose tool printed an issue quoting a rejection line: plain text inside
    // OpenCode's coloured output, not OpenCode's own line (PR 35).
    createSession();
    process.stderr.write('\x1b[0m$ \x1b[0mgh issue view 14\n');
    process.stderr.write('! permission requested: external_directory (<review-dir>/*); auto-rejecting\n✗ cd evidence/a && ls failed\n');
    const header = (brief ?? pointer).split('\n')[0];
    process.stdout.write(`${header}\napprove\n\nR1: fine\n\napprove\n`);
    process.exit(0);
    break;
  }
  case 'permission-plain': {
    // A real rejection whose line came out without colour, in otherwise coloured output: the
    // session record has it (Luna's R1 on PR 37).
    createSession(agent, { rejected: true });
    process.stderr.write('\x1b[0m$ \x1b[0mcat /tmp/notes.txt\n! permission requested: external_directory (/tmp/*); auto-rejecting\n');
    process.stdout.write('report: built nothing\n');
    process.exit(0);
    break;
  }
  case 'deny':
  case 'deny-review': {
    // Denied calls the model saw (#146): FAKE_OC_DENIALS lists them ({tool, input, kind}); the model
    // goes on after the last unless FAKE_OC_DENY_STOPPED; FAKE_OC_DENY_HANG keeps the run going.
    const denials = JSON.parse(process.env.FAKE_OC_DENIALS || '[]');
    createSession(agent, { denials, recovered: !process.env.FAKE_OC_DENY_STOPPED });
    for (const d of denials) {
      process.stderr.write(d.kind === 'denied'
        ? '\x1b[91m\x1b[1mError: \x1b[0mThe user has specified a rule which prevents you from using this specific tool call.\n'
        : `\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (${path.dirname(d.input)}/*); auto-rejecting\n`);
    }
    if (process.env.FAKE_OC_DENY_HANG) { forever(); break; }
    const header = (brief ?? pointer).split('\n')[0];
    process.stdout.write(mode === 'deny-review' ? `${header}\napprove\n\nR1: fine\n\napprove\n` : 'report: built it\n');
    process.exit(0);
    break;
  }
  case 'utf8':
    createSession();
    process.stdout.write('em — dash, ü, “quotes”\n');
    process.exit(0);
    break;
  default: {
    createSession();
    const steps = Number(process.env.FAKE_OC_STEPS || 0);
    for (let i = 0; i < steps; i++) { await sleep(Number(process.env.FAKE_OC_STEP_MS || 100)); touch(); }
    process.stdout.write(process.env.FAKE_OC_OUTPUT ?? 'done\n');
    process.exit(Number(process.env.FAKE_OC_EXIT || 0));
  }
}
