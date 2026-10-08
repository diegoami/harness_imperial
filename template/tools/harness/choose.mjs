#!/usr/bin/env node
// Which model should run this, right now? Ranks harness.json's models for a role and difficulty
// by quota-tracker's /recommend over the owner's preference order (the `chooser` block;
// absent: the chains). Advisory: it prints a ranking, `--pick` names the top one for
// --model/--reviewer, and it never edits harness.json — a switch goes through /switch-model.
//
//   node tools/harness/choose.mjs --role implementer --difficulty easy
//   node tools/harness/choose.mjs --role reviewer --difficulty hard --implemented-by claude
//   node tools/harness/choose.mjs --role implementer --difficulty easy --pick
//
// Order: the /recommend band first (#128, the owner 2026-10-08): 0, spare calls before the pool
// resets; 1, none (it runs out first at the current demand, OpenRouter's prepaid 0, or nearly
// full); 2, not ranked (Alibaba, or the tracker off). Then the preference index. Headroom
// percentages are not compared: pools differ in size and period. Pricing is in /recommend's score
// already. A reviewer never shares the implementer's family; an exhausted model ranks last with
// the reason. A tracker that does not answer ranks by preference alone and says so; it never blocks.
//
// Exit 0: ranked. Exit 2: usage, or a chooser name models does not list. Exit 3: --pick with
// nothing usable (the table still prints on stderr).

import { parseArgs, sh, loadConfig } from './lib/common.mjs';
import { readQuota, readRecommend } from './lib/quota.mjs';
import { rankCandidates } from './lib/choose.mjs';

const die = (code, s) => { console.error(s); process.exit(code); };

const a = parseArgs(process.argv.slice(2), { flags: ['pick', 'json'] });
if (!a.role || !a.difficulty) die(2, 'Usage: node tools/harness/choose.mjs --role implementer|reviewer --difficulty easy|hard [--implemented-by NAME] [--pick] [--json]');
if (!['implementer', 'reviewer'].includes(a.role)) die(2, `--role must be implementer or reviewer; got ${a.role}`);
if (!['easy', 'hard'].includes(a.difficulty)) die(2, `--difficulty must be easy or hard; got ${a.difficulty}`);
if (a.implementedBy && a.role !== 'reviewer') die(2, '--implemented-by is a reviewer concern: the reviewer never shares the implementer\'s family');

let top;
try {
  top = sh('git', ['rev-parse', '--show-toplevel']);
} catch (e) {
  die(2, `not run from a repository: ${e.message}`);
}
if (!top) die(2, 'not run from a repository: harness.json is found with git rev-parse --show-toplevel');
const config = loadConfig(top);

const quota = await readQuota();
// Quota off means ranking by preference alone (Sol's R2, PR 117): a recommendation that still
// answers must not reorder when the quota that blocks is missing.
const recommend = quota.off ? { off: 'quota not checked' } : await readRecommend();
let ranked;
try {
  ranked = rankCandidates({ config, role: a.role, difficulty: a.difficulty, quota, recommend, implementedBy: a.implementedBy });
} catch (e) {
  die(2, e.message);
}

const line = (r) => `${r.name}\t${r.id}\t${r.provider ?? 'unknown'} ${r.status}, band ${r.band}`
  + (r.note ? ` — ${r.note}` : '')
  + (r.blocked ? ` — BLOCKED: ${r.blocked}` : '');

if (a.json) {
  console.log(JSON.stringify({ quotaOff: quota.off ?? null, recommendOff: recommend.off ?? null, ranked: ranked.map(({ index, ...r }) => r) }, null, 2));
} else {
  if (quota.off) console.error(`quota: not checked: ${quota.off} (L50); ranking by preference alone`);
  else if (recommend.off) console.error(`recommend: not read: ${recommend.off}; every model is band 2, by preference`);
  ranked.forEach((r, i) => console.log(`${i + 1}. ${line(r)}`));
}

const first = ranked.find((r) => !r.blocked);
if (a.pick) {
  if (!first) { ranked.forEach((r, i) => console.error(`${i + 1}. ${line(r)}`)); die(3, 'nothing is usable now'); }
  console.log(first.name);
}
