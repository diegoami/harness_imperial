// The job record every watched OpenCode run keeps next to its logs (#148, L71), and what the
// owner reads from it: which runs are going, on which task and model, what the brief asks, what
// the agent did last, and how each run ended. The runner writes `<logDir>/<title>.job.json` when
// it starts, adds the session when OpenCode creates it, and writes the outcome when it ends; a
// finished record stays a day, so a watch that polls after the end still reports it.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const jobFile = (logDir, title) => path.join(logDir, `${title}.job.json`);

// Written through a temporary file, so a reader never sees half a record.
export function writeJob(file, job) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(job, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

export function updateJob(file, fields) {
  try {
    writeJob(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fields });
  } catch { /* a record that cannot be updated never fails the run */ }
}

// The brief's first paragraph, in one line: front matter and blank lines skipped, and a short
// header line (a review's "PR 7 review (luna)") joined with the paragraph after it. At most 160
// characters. A header is a short line that does not end a sentence.
export function briefSummary(text) {
  let lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) lines = lines.slice(end + 1);
  }
  const paragraphs = lines.join('\n').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '')).filter(Boolean);
  if (!paragraphs.length) return '(no brief)';
  const first = paragraphs[0].length < 60 && !/[.!?:;]$/.test(paragraphs[0]) && paragraphs[1] ? `${paragraphs[0]}: ${paragraphs[1]}` : paragraphs[0];
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

// One step of the session record in a few words: a tool and its main argument, or the agent's text.
function stepText(p) {
  if (p.type === 'tool') {
    const i = p.state?.input ?? {};
    const arg = String(i.command ?? i.filePath ?? i.path ?? i.pattern ?? i.url ?? '').replace(/\s+/g, ' ').trim();
    const status = p.state?.status === 'error' ? ' (failed)' : p.state?.status === 'running' ? ' (running)' : '';
    return `${p.tool ?? 'tool'}${arg ? ` ${arg.length > 60 ? `${arg.slice(0, 59)}…` : arg}` : ''}${status}`;
  }
  const t = String(p.text ?? '').replace(/\s+/g, ' ').trim();
  return `says "${t.length > 60 ? `${t.slice(0, 59)}…` : t}"`;
}

// The last `n` steps of an `opencode export`, most recent first: the agent's own tool calls and
// text, never the user's brief or a step that never ran.
export function lastSteps(exported, n = 3) {
  const parts = (exported?.messages ?? []).flatMap((m) => ((m.info?.role ?? m.role) === 'assistant' ? m.parts ?? [] : []));
  const steps = parts.filter((p) => (p.type === 'tool' && ['running', 'completed', 'error'].includes(p.state?.status))
    || (p.type === 'text' && String(p.text ?? '').trim() && !p.synthetic));
  return steps.slice(-n).reverse().map(stepText);
}

// The session record of a running job, read with the job's own OpenCode and data directory, or null.
export function exportSession(job, timeoutMs = 20_000) {
  if (!job.sessionId || !job.opencode) return null;
  const r = spawnSync(job.opencode.exe, [...(job.opencode.prefix ?? []), 'export', job.sessionId], {
    cwd: fs.existsSync(job.workDir ?? '') ? job.workDir : undefined, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 << 20,
    env: { ...process.env, ...(job.dataHome ? { XDG_DATA_HOME: job.dataHome } : {}) }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { return null; }
}

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Every job record in logDir: running ones, and those that ended within `keepMs`. A record whose
// runner died without writing an outcome is reported as stopped. Older finished records are removed.
export function listJobs(logDir, { now = Date.now(), keepMs = 24 * 3600_000 } = {}) {
  let names = [];
  try { names = fs.readdirSync(logDir).filter((n) => n.endsWith('.job.json')); } catch { return []; }
  const jobs = [];
  for (const n of names) {
    const file = path.join(logDir, n);
    let job;
    try { job = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!job.ended && !alive(job.runnerPid)) job = { ...job, ended: job.updated ?? job.started, outcome: 'stopped: its runner is gone' };
    if (job.ended && now - job.ended > keepMs) { fs.rmSync(file, { force: true }); continue; }
    jobs.push({ ...job, file });
  }
  return jobs.sort((a, b) => a.started - b.started);
}

const minutes = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
const home = (p) => (process.env.HOME && String(p ?? '').startsWith(process.env.HOME) ? `~${String(p).slice(process.env.HOME.length)}` : p);

// One job in plain words, for the owner: what it is, how long it has run, what the brief asks, and
// what the agent did last (or how it ended).
export function describeJob(job, steps, now = Date.now()) {
  const head = `${job.kind ?? 'run'} ${job.task ?? job.title} on ${job.model ?? '?'}`;
  if (job.ended) return `${head}: finished after ${minutes(job.ended - job.started)}, ${job.outcome ?? 'no outcome recorded'}. Task: ${job.about}`;
  const doing = !job.sessionId ? 'starting (no session yet)'
    : steps === null ? 'running (its session record could not be read)'
      : steps.length ? `last steps, newest first: ${steps.join('; ')}` : 'running, no step yet';
  return `${head}, running ${minutes(now - job.started)} in ${home(job.workDir)}. Task: ${String(job.about).replace(/\.$/, '')}. Now: ${doing}`;
}
