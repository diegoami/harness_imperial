#!/usr/bin/env node
// Delegates a decision to Jev. The decision is defined in harness.json's jev.decisions: its
// question type and an instructions file; after a trial, its two cutoffs.
//
//   node tools/harness/jev.mjs trial --decision breaks-play --in labels.jsonl
//       labels.jsonl: {"id", "state": {...}, "label": true|false} per line. Asks Jev every item,
//       picks the cutoffs on one half, reports them on the other. Writes nothing to the config:
//       the main session records the cutoffs in harness.json, with the trial's numbers.
//   node tools/harness/jev.mjs route --decision breaks-play --in items.jsonl [--out routed.jsonl]
//       items.jsonl: {"id", "state"} per line. Only for a trialled decision. Each item comes back
//       yes, no or middle; the middle is the main session's to decide.
//   node tools/harness/jev.mjs ask --decision NAME --in items.jsonl [--out answers.jsonl]
//       The raw answers, for any question type.
//
// Exit 0: done. Exit 1: refused, or stopped by a provider failure (the answers so far are
// written). Exit 3: Jev unavailable (no key, no config); the main session decides everything.

import fs from 'node:fs';
import path from 'node:path';
import { sh, repoPaths, loadConfig, parseArgs } from './lib/common.mjs';
import { JevUnavailable, askAll, httpPost, jevSettings, questionFor, route, trial } from './lib/jev.mjs';

const die = (code, s) => { console.error(s); process.exit(code); };
const [cmd, ...rest] = process.argv.slice(2);
if (!['ask', 'trial', 'route'].includes(cmd)) die(2, 'Usage: jev.mjs ask|trial|route --decision NAME --in FILE.jsonl [--out FILE.jsonl]');
const a = parseArgs(rest);
if (!a.decision || !a.in) die(2, '--decision and --in are required.');

const top0 = sh('git', ['rev-parse', '--show-toplevel']);
const config = loadConfig(top0);
const { top, workRoot } = repoPaths(config);
const decision = config.jev?.decisions?.[a.decision];
if (!decision) die(2, `harness.json has no jev.decisions.${a.decision}`);
if (cmd === 'route' && decision.autoYesAt == null && decision.autoNoBelow == null) {
  die(1, `${a.decision} has no cutoffs: run "jev.mjs trial" first and record them in harness.json with the trial's numbers.`);
}
if (cmd !== 'ask' && (decision.type ?? 'noul') !== 'noul') die(2, `${cmd} supports noul decisions only; use ask for ${decision.type}.`);

let settings;
try { settings = jevSettings(config); } catch (e) {
  if (e instanceof JevUnavailable) die(3, `Jev unavailable: ${e.message}. The main session decides every item itself.`);
  throw e;
}

const items = fs.readFileSync(a.in, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
  const x = JSON.parse(l);
  if (x.id == null || x.state == null) die(2, `${a.in} line ${i + 1}: every item needs "id" and "state"`);
  if (cmd === 'trial' && typeof x.label !== 'boolean') die(2, `${a.in} line ${i + 1}: a trial item needs a boolean "label"`);
  return x;
});
const instructions = fs.readFileSync(path.join(top, decision.instructionsFile), 'utf8');
const question = questionFor(decision, instructions);
const { answers, error, cost } = await askAll({
  items, name: a.decision, question, model: settings.model,
  post: httpPost({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, timeoutSec: settings.timeoutSec }),
  cacheDir: path.join(workRoot, '.jev-cache', a.decision),
});
const write = (rows) => { if (a.out) fs.writeFileSync(a.out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); };
const spent = `$${cost.toFixed(4)} (${answers.filter((x) => x.cached).length} cached)`;

if (cmd === 'ask') {
  write(answers);
  console.log(`asked ${answers.length} of ${items.length}, ${spent}`);
} else if (cmd === 'route') {
  const rows = answers.map((x) => ({ id: x.id, p: x.p, route: route(x.p, decision) }));
  write(rows);
  const count = (r) => rows.filter((x) => x.route === r).length;
  console.log(`${a.decision}: ${count('yes')} yes, ${count('no')} no, ${count('middle')} for the main session, of ${items.length}; ${spent}`);
} else {
  const labelOf = new Map(items.map((x) => [String(x.id), x.label]));
  const result = trial(answers.map((x) => ({ id: x.id, p: x.p, label: labelOf.get(String(x.id)) })), {
    targetPrecision: decision.targetPrecision ?? settings.targetPrecision ?? 0.95,
  });
  console.log(JSON.stringify({ decision: a.decision, model: settings.model, asked: answers.length, cost, ...result }, null, 2));
  const pct = (s) => (s.precision == null ? '-' : `${(s.precision * 100).toFixed(1)}% of ${s.n}`);
  console.log(`\n${a.decision}: yes at >= ${result.autoYesAt ?? 'none'} (held out ${pct(result.heldOut.yes)}), `
    + `no below ${result.autoNoBelow ?? 'none'} (held out ${pct(result.heldOut.no)}); `
    + `Jev would settle ${(result.heldOut.coverage * 100).toFixed(0)}% of items; ${spent}`);
  for (const w of result.warnings) console.log(`warning: ${w}`);
}
if (error) die(1, `stopped early: ${error}. The answers before it were kept (and cached).`);
