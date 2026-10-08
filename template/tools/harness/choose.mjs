#!/usr/bin/env node
// Which model should run this, right now? Ranks harness.json's models for a role and difficulty
// by live quota and time-of-day pricing over the owner's preference order (the `chooser` block;
// absent: the chains). Advisory: it prints a ranking, `--pick` names the top one for
// --model/--reviewer, and it never edits harness.json — a switch goes through /switch-model.
//
//   node tools/harness/choose.mjs --role implementer --difficulty easy
//   node tools/harness/choose.mjs --role reviewer --difficulty hard --implemented-by claude
//   node tools/harness/choose.mjs --role implementer --difficulty easy --pick
//
// Order: headroom band first (≥50% left, 20–49%, <20%, then quota unknown: unchecked or not
// monitored, #125), then the pricing tier within the band (a discount on now promotes, a peak on
// now demotes — the owner's rule, docs/models.md), then the preference index. Headroom outranks pricing: a discounted pool that is nearly burnt loses
// to a fresh one (the owner, 2026-10-06). A reviewer never shares the implementer's family; an
// exhausted provider's models rank last with the reason. A tracker that does not answer ranks
// by preference alone and says so; it never blocks.
//
// Exit 0: ranked. Exit 2: usage, or a chooser name models does not list. Exit 3: --pick with
// nothing usable (the table still prints on stderr).

import { parseArgs, sh, loadConfig } from './lib/common.mjs';
import { readQuota, readPricing } from './lib/quota.mjs';
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
const pricing = await readPricing();
// Quota off means ranking by preference alone (Sol's R2, PR 117): reachable pricing must not
// still reorder when the quota it would rank against is missing.
const effective = quota.off ? { pricing: new Map() } : pricing;
let ranked;
try {
  ranked = rankCandidates({ config, role: a.role, difficulty: a.difficulty, quota, pricing: effective, implementedBy: a.implementedBy });
} catch (e) {
  die(2, e.message);
}

const line = (r) => `${r.name}\t${r.id}\t${r.provider ?? 'unknown'} ${r.status}${r.headroom !== null ? `, ${r.headroom}% left` : ''}`
  + `${r.limiting ? ` (${r.limiting}${r.resetsIn ? `, resets in ${r.resetsIn}` : ''})` : ''}`
  + (r.note ? ` — ${r.note} (tier ${r.tier > 0 ? '+' : ''}${r.tier})` : '')
  + (r.blocked ? ` — BLOCKED: ${r.blocked}` : '');

if (a.json) {
  console.log(JSON.stringify({ quotaOff: quota.off ?? null, pricingOff: pricing.off ?? null, ranked: ranked.map(({ index, ...r }) => r) }, null, 2));
} else {
  if (quota.off) console.error(`quota: not checked: ${quota.off} (L50); ranking by preference alone`);
  if (pricing.off) console.error(`pricing: not checked: ${pricing.off}; tiers are neutral`);
  ranked.forEach((r, i) => console.log(`${i + 1}. ${line(r)}`));
}

const first = ranked.find((r) => !r.blocked);
if (a.pick) {
  if (!first) { ranked.forEach((r, i) => console.error(`${i + 1}. ${line(r)}`)); die(3, 'nothing is usable now'); }
  console.log(first.name);
}
