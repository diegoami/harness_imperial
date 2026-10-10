// The job records and agents.mjs (#148, L71): what the owner is told about the delegated runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOpenCodeWatched } from '../template/tools/harness/lib/opencode.mjs';
import { briefSummary, lastSteps, describeJob, listJobs, writeJob, jobFile } from '../template/tools/harness/lib/jobs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-opencode.mjs');
const opencode = { exe: process.execPath, prefix: [fake] };
const agents = path.join(here, '../template/tools/harness/agents.mjs');
const PARTS = [
  { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'src/calendar.js' } } },
  { type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: 'src/calendar.js' } } },
  { type: 'text', text: 'Running the tests now.' },
  { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'npm test' } } },
];

function setup(mode, extra = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agents-')));
  const env = { ...process.env, FAKE_OC_STATE: path.join(dir, 'state.json'), FAKE_OC_MODE: mode, ...extra };
  return { dir, env, logDir: path.join(dir, 'logs') };
}
const run = (s, opts = {}) => runOpenCodeWatched({
  args: ['run', '--model', 'opencode-go/x'], prompt: 'T07: build the calendar screen.\n\nMore detail.\n',
  workDir: s.dir, title: 'T07-mimo', opencode, env: s.env, logDir: s.logDir, scratchRoot: path.join(s.dir, 'tmp'),
  pollMs: 50, startupTimeoutMs: 3000, idleTimeoutMs: 5000, totalTimeoutMs: 20000,
  job: { kind: 'implement', task: 'T07', model: 'mimo-flash' }, ...opts,
});
// The fake answers `export` from its state file; the real OpenCode from the job's data directory.
const status = (s) => spawnSync(process.execPath, [agents, '--status', '--all', '--dir', s.logDir], { encoding: 'utf8', env: s.env });
const until = async (cond, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (cond()) return true;
  return false;
};

test('briefSummary: the first paragraph in one line, past front matter, a short header joined to the next, at most 120 characters', () => {
  assert.equal(briefSummary('T07: build the calendar.\r\nIt shows a month.\r\n\r\nMore.'), 'T07: build the calendar. It shows a month.');
  assert.equal(briefSummary('---\ntitle: x\n---\n\n# T07\n\nBuild the calendar.'), 'T07: Build the calendar.');
  assert.equal(briefSummary('PR 7 review (luna)\n\nReview PR 7 at head abc: the calendar.'), 'PR 7 review (luna): Review PR 7 at head abc: the calendar.');
  assert.equal(briefSummary('x'.repeat(200)).length, 120);
  assert.equal(briefSummary('x'.repeat(121)).length, 120);                     // Luna's R4 on PR 166
  assert.equal(briefSummary('x'.repeat(120)), 'x'.repeat(120));
  assert.match(briefSummary('x'.repeat(200)), /…$/);
  assert.equal(briefSummary(''), '(no brief)');
});

test('lastSteps: the agent\'s own steps, newest first, never the user\'s brief or a step that never ran', () => {
  const exported = { messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'the brief' }] },
    { info: { role: 'assistant' }, parts: [...PARTS, { type: 'tool', tool: 'write', state: { status: 'pending', input: { filePath: 'x' } } }] },
  ] };
  assert.deepEqual(lastSteps(exported), ['bash npm test (running)', 'says "Running the tests now."', 'edit src/calendar.js']);
  assert.deepEqual(lastSteps({ messages: [] }), []);
  // A run with one step so far: the user's brief is never counted as one.
  assert.deepEqual(lastSteps({ messages: [exported.messages[0], { info: { role: 'assistant' }, parts: [PARTS[0]] }] }), ['read src/calendar.js']);
});

test('describeJob: a running job and an ended one, in plain words', () => {
  const job = { kind: 'implement', task: 'T07', model: 'mimo-flash', about: 'T07: build it', workDir: '/w', started: 0, sessionId: 's' };
  assert.equal(describeJob(job, ['bash npm test (running)'], 12 * 60_000),
    'implement T07 on mimo-flash, running 12m in /w. Task: T07: build it. Now: last steps, newest first: bash npm test (running)');
  assert.match(describeJob({ ...job, sessionId: null }, [], 0), /Now: starting \(no session yet\)$/);
  assert.match(describeJob(job, null, 0), /Now: running \(its session record could not be read\)$/);
  // A record without its brief (another version, or damaged) still reads as a sentence (Luna's R3 on PR 166).
  assert.match(describeJob({ ...job, about: undefined }, [], 0), /\. Task: \(no brief recorded\)\. Now: /);
  assert.equal(describeJob({ ...job, ended: 75 * 60_000, outcome: 'ran to the end (exit 0)' }, [], 0),
    'implement T07 on mimo-flash: finished after 1h15m, ran to the end (exit 0). Task: T07: build it.');
});

test('listJobs: a runner that died without an outcome is reported stopped; a record ended over a day ago is removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-jobs-'));
  const now = Date.now();
  writeJob(jobFile(dir, 'dead'), { title: 'dead', runnerPid: 2 ** 22 + 12345, started: now - 1000, updated: now - 500 });
  writeJob(jobFile(dir, 'old'), { title: 'old', runnerPid: process.pid, started: now - 3 * 86_400_000, ended: now - 2 * 86_400_000, outcome: 'x' });
  writeJob(jobFile(dir, 'live'), { title: 'live', runnerPid: process.pid, started: now });
  const jobs = listJobs(dir, { now });
  assert.deepEqual(jobs.map((j) => j.title), ['dead', 'live']);
  assert.equal(jobs[0].outcome, 'stopped: its runner is gone');
  assert.equal(fs.existsSync(jobFile(dir, 'old')), false);
});

test('a run keeps a job record: what it is, its session, and how it ended (#148)', async () => {
  const s = setup('ok', { FAKE_OC_STEPS: '3' });
  const r = await run(s);
  const job = JSON.parse(fs.readFileSync(jobFile(s.logDir, r.title), 'utf8'));
  assert.equal(job.kind, 'implement');
  assert.equal(job.task, 'T07');
  assert.equal(job.model, 'mimo-flash');
  assert.equal(job.about, 'T07: build the calendar screen.');
  assert.equal(job.sessionId, r.sessionId);
  assert.equal(job.runnerPid, process.pid);
  assert.equal(job.outcome, 'ran to the end (exit 0)');
  assert.ok(job.ended >= job.started);
  // A thrown failure records its reason.
  const t = setup('idle');
  await assert.rejects(run(t, { idleTimeoutMs: 300 }));
  const [name] = fs.readdirSync(t.logDir).filter((n) => n.endsWith('.job.json'));
  assert.match(JSON.parse(fs.readFileSync(path.join(t.logDir, name), 'utf8')).outcome, /^failed: session idle for 0 s waiting on the provider$/);
});

test('agents.mjs --status: a running job with its brief and last steps, then the same job ended; none says so (#148)', async () => {
  // A large export, as a long session's is: OpenCode exits before a pipe has taken it all (the fake too).
  const s = setup('ok', { FAKE_OC_STEPS: '60', FAKE_OC_STEP_MS: '100', FAKE_OC_PARTS: JSON.stringify(PARTS), FAKE_OC_BIG_EXPORT: '1' });
  assert.equal(status(s).stdout, 'no in-flight jobs.\n');
  const going = run(s);
  assert.ok(await until(() => fs.existsSync(s.logDir) && fs.readdirSync(s.logDir).some((n) => n.endsWith('.job.json')
    && JSON.parse(fs.readFileSync(path.join(s.logDir, n), 'utf8')).sessionId)), 'the record has its session');
  const live = status(s);
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, /^- implement T07 on mimo-flash, running 0m in \S+\. Task: T07: build the calendar screen\. Now: last steps, newest first: bash npm test \(running\); says "Running the tests now\."; edit src\/calendar\.js\n$/);
  await going;
  const done = status(s);
  assert.match(done.stdout, /^no in-flight jobs\.\nended in the last hour:\n- implement T07 on mimo-flash: finished after 0m, ran to the end \(exit 0\)\. Task: T07: build the calendar screen\.\n$/);
});

test('agents.mjs --watch --until-done: a line when a job starts, every --every while it runs, and when it ends, then it exits (#148)', async () => {
  const s = setup('ok', { FAKE_OC_STEPS: '45', FAKE_OC_STEP_MS: '100', FAKE_OC_PARTS: JSON.stringify(PARTS) });
  fs.mkdirSync(s.logDir, { recursive: true });
  // A job that ended before the watch began is not reported.
  writeJob(jobFile(s.logDir, 'earlier'), { title: 'earlier', task: 'T01', runnerPid: process.pid, started: Date.now() - 5000, ended: Date.now() - 4000, outcome: 'x' });
  const w = spawn(process.execPath, [agents, '--watch', '--until-done', '--all', '--poll', '1s', '--every', '1s', '--dir', s.logDir], { stdio: ['ignore', 'pipe', 'pipe'], env: s.env });
  let out = '';
  w.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((r) => w.on('exit', r));
  await run(s);
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
  if (code === 'timeout') w.kill();
  assert.equal(code, 0, out);
  const lines = out.trim().split('\n');
  assert.match(lines[0], /^\d\d:\d\d (started|started and ended): implement T07 on mimo-flash/);
  assert.match(out, /^\d\d:\d\d (ended|started and ended): implement T07 on mimo-flash: finished after 0m, ran to the end \(exit 0\)/m);
  assert.match(lines.at(-1), /^\d\d:\d\d every watched job has ended\.$/);
  assert.match(out, /^\d\d:\d\d still running: implement T07 on mimo-flash, running 0m in \S+\. Task: T07: build the calendar screen\. Now: last steps, newest first: bash npm test \(running\)/m);
  assert.doesNotMatch(out, /T01/);
});

test('agents.mjs shows this repository\'s jobs by default, every project\'s with --all (Luna\'s R2 on PR 166)', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agents-repo-')));
  const repo = path.join(base, 'proj');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  const logDir = path.join(base, 'logs');
  fs.mkdirSync(logDir);
  const now = Date.now();
  const rec = (title, workDir) => writeJob(jobFile(logDir, title), { title, kind: 'implement', task: title, model: 'm', about: 'x', workDir, runnerPid: process.pid, started: now });
  rec('T07', path.join(base, 'proj-work', 'T07'));                              // this repository's work root
  rec('T99', path.join(base, 'other-work', 'T99'));                             // another project's
  const mine = spawnSync(process.execPath, [agents, '--status', '--dir', logDir], { encoding: 'utf8', cwd: repo });
  assert.equal(mine.status, 0, mine.stderr);
  assert.match(mine.stdout, /implement T07 on m/);
  assert.doesNotMatch(mine.stdout, /T99/);
  const all = spawnSync(process.execPath, [agents, '--status', '--all', '--dir', logDir], { encoding: 'utf8', cwd: repo });
  assert.match(all.stdout, /T07[\s\S]*T99/);
  // Outside a repository, without --all: refused.
  assert.equal(spawnSync(process.execPath, [agents, '--status', '--dir', logDir], { encoding: 'utf8', cwd: base }).status, 2);
});

test('agents.mjs refuses a bad call with exit 2', () => {
  assert.equal(spawnSync(process.execPath, [agents], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [agents, '--status', '--watch'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [agents, '--watch', '--every', '10'], { encoding: 'utf8' }).status, 2);
});
