#!/usr/bin/env node
// A stand-in for `opencode` that reproduces the failures the runner guards against.
// FAKE_OC_STATE: the JSON file that plays OpenCode's session store.
// FAKE_OC_MODE (for `run`): ok | read-stdin | no-session | idle | exit-no-session | exit2 |
//   fallback | quote | slow | utf8 | implement | commit-fail | stop-report | permission |
//   permission-review | review-ok | review-cut
// FAKE_OC_MODES: a JSON map of model id -> mode, which wins over FAKE_OC_MODE.
// FAKE_GH_STATE: the fake gh's PR list, which `implement` adds to.
// FAKE_OC_MODELS (for `models <provider>`): a JSON list of the ids OpenCode lists; by default the
//   ids harness.json names. Each session records the XDG_DATA_HOME it ran with.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [cmd, ...rest] = process.argv.slice(2);
const stateFile = process.env.FAKE_OC_STATE;
let mode = process.env.FAKE_OC_MODE || 'ok';
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return []; } };
const save = (s) => { fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(s)); fs.renameSync(`${stateFile}.tmp`, stateFile); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const forever = () => setInterval(() => {}, 1 << 30);

if (cmd === 'session') {
  process.stdout.write(JSON.stringify(load()));
  process.exit(0);
}
if (cmd === 'models') {
  const ids = JSON.parse(process.env.FAKE_OC_MODELS
    || '["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash", "opencode-go/gpt-6-luna"]');
  process.stdout.write(ids.filter((id) => !rest[0] || id.startsWith(`${rest[0]}/`)).map((id) => `${id}\n`).join(''));
  process.exit(0);
}
if (cmd === 'export') {
  const s = load().find((x) => x.id === rest[0]);
  if (!s) process.exit(1);
  // A long session's export is large; the real OpenCode exits before a pipe has taken all of it.
  // So does Node: process.exit() drops what a pipe has not yet taken, but a file is written at once.
  const messages = process.env.FAKE_OC_BIG_EXPORT ? [{ text: 'x'.repeat(4 << 20) }] : [];
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
const createSession = (recordedAgent = agent) => {
  const s = load();
  s.push({ id, title, directory: process.cwd(), created: Date.now(), updated: Date.now(), agent: recordedAgent,
    dataHome: process.env.XDG_DATA_HOME ?? null });
  save(s);
};
const touch = () => { const s = load(); const x = s.find((y) => y.id === id); if (x) { x.updated = Date.now(); save(s); } };
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
    const header = rest.at(-1).split('\n')[0];
    process.stdout.write({
      'review-ok': `reading the diff\n${header}\napprove\n\nR1: fine (not blocking)\n\napprove\n`,
      'review-cut': `${header}\nrework\n\nR1: the loop in`,
      'review-fixes': `${header}\nrework\n\nR1: this fixes #12 only in part.\n\nrework\n`,
      'review-decorated': `Here is my review.\n\n**${header.toUpperCase()}**\n\n**Verdict:** Rework.\n\nR1: x.\n\n**rework**\n\n— signed, the reviewer\n`,
    }[mode]);
    process.exit(0);
    break;
  }
  case 'permission':
  case 'permission-review': {
    // OpenCode 1.18 auto-rejects a path outside --dir in a non-interactive run, and exits 0.
    createSession();
    process.stderr.write('\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (/tmp/*); auto-rejecting\n');
    const header = rest.at(-1).split('\n')[0];
    process.stdout.write(mode === 'permission' ? 'report: built nothing\n' : `${header}\napprove\n\nR1: fine\n\napprove\n`);
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
