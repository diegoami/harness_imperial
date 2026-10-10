#!/usr/bin/env node
// What the delegated runs are doing, in plain words for the owner (#148, L71). Every run that
// implement.mjs, review.mjs or switch-model.mjs starts keeps a job record next to its logs
// (lib/jobs.mjs); this reads them.
//
//   node tools/harness/agents.mjs --status          each running job: task, model, time, the brief's
//                                                   first paragraph, the agent's last three steps;
//                                                   then the jobs that ended in the last hour
//   node tools/harness/agents.mjs --watch [--every 30m] [--poll 15s] [--until-done]
//                                                   one line when a job starts, one when it ends (with
//                                                   its outcome), and one per running job every
//                                                   --every; --until-done exits once every job it saw
//                                                   has ended and none runs. The main session runs it
//                                                   under Monitor, so each line reaches the owner.
//   [--dir <logDir>]                                default: <tmpdir>/harness-opencode, the runner's
//
// Exit 0; 2 on a bad argument.

import os from 'node:os';
import path from 'node:path';
import { listJobs, exportSession, lastSteps, describeJob } from './lib/jobs.mjs';
import { parseArgs } from './lib/common.mjs';

const die = (code, s) => { console.error(s); process.exit(code); };
let a;
try { a = parseArgs(process.argv.slice(2), { flags: ['status', 'watch', 'until-done'] }); } catch (e) { die(2, e.message); }
if (!a.status === !a.watch) die(2, 'Give exactly one of --status or --watch.');
const duration = (text, fallback) => {
  if (text === undefined) return fallback;
  const m = /^(\d+)(s|m|h)$/.exec(String(text));
  if (!m) die(2, `A duration looks like 15s, 30m or 1h; got ${text}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
};
const dir = a.dir ?? path.join(os.tmpdir(), 'harness-opencode');
const every = duration(a.every, 30 * 60_000);
const poll = duration(a.poll, 15_000);

const stepsOf = (job) => (job.ended || !job.sessionId ? [] : (() => { const e = exportSession(job); return e ? lastSteps(e) : null; })());
const line = (job) => describeJob(job, stepsOf(job));

if (a.status) {
  const now = Date.now();
  const jobs = listJobs(dir, { now });
  const running = jobs.filter((j) => !j.ended);
  const recent = jobs.filter((j) => j.ended && now - j.ended < 3_600_000);
  if (!running.length) console.log('no in-flight jobs.');
  for (const j of running) console.log(`- ${line(j)}`);
  if (recent.length) console.log('ended in the last hour:');
  for (const j of recent) console.log(`- ${line(j)}`);
  process.exit(0);
}

// --watch: the records it has seen, and when it last reported each running one.
const stamp = () => new Date().toTimeString().slice(0, 5);
const say = (s) => console.log(`${stamp()} ${s}`);
const seen = new Map();          // title -> { ended, reported }
const startedAt = Date.now();
for (;;) {
  const now = Date.now();
  const jobs = listJobs(dir, { now });
  for (const j of jobs) {
    const was = seen.get(j.title);
    if (!was) {
      // A job that had ended before the watch began is not news.
      if (j.ended && j.ended < startedAt) { seen.set(j.title, { ended: true, reported: now, old: true }); continue; }
      say(`${j.ended ? 'started and ended' : 'started'}: ${line(j)}`);
      seen.set(j.title, { ended: Boolean(j.ended), reported: now });
      continue;
    }
    if (was.ended) continue;
    if (j.ended) { say(`ended: ${line(j)}`); seen.set(j.title, { ended: true, reported: now }); continue; }
    if (now - was.reported >= every) { say(`still running: ${line(j)}`); was.reported = now; }
  }
  const mine = [...seen.values()].filter((s) => !s.old);
  if (a['until-done'] && mine.length && mine.every((s) => s.ended)) { say('every watched job has ended.'); process.exit(0); }
  await new Promise((r) => setTimeout(r, poll));
}
