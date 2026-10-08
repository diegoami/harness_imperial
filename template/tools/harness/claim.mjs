#!/usr/bin/env node
// Claims a task for this machine, so that two machines never work one task (H4, #120; ADR-005 in
// game-archaeologist). The claim is the compare-and-set creation of refs/heads/claim/T<nn> through
// the GitHub API: 201 won, 422 held. lib/claim.mjs has the mechanism.
//
//   node tools/harness/claim.mjs claim    --task T14 --issue 39 --machine <id> [--preflight <summary>]
//   node tools/harness/claim.mjs status   --task T14 --issue 39 [--branch task/T14-x] [--json]
//   node tools/harness/claim.mjs renew    --task T14 --issue 39 --machine <id>
//   node tools/harness/claim.mjs release  --task T14 --issue 39 --machine <id> [--reason <word>] [--merged]
//   node tools/harness/claim.mjs takeover --task T14 --issue 39 --machine <id> [--by-user [--force]] [--preflight <summary>]
//
// --machine defaults to HARNESS_MACHINE. A push to the task branch or any comment on the issue renews
// the lease (24h); `renew` posts such a comment. A claim is stale when its lease expired, or at once
// when its ref has no claim comment 10 minutes after the claim. Takeover needs the primary machine
// (the repository variable HARNESS_PRIMARY) or the user (--by-user); --force, the user only, takes
// over a claim that is not stale. A release keeps the task branch: it is the resumable state.
//
// stdout carries only one line per ref write, `claim-api op=create|delete|takeover status=<http>
// ref=<ref> machine=<id> at=<iso>` (status: the JSON); everything else is on stderr.
//
// Exit 0: done. Exit 1: a GitHub error or a defect. Exit 2: usage. Exit 3: held, lost a takeover
// race, or refused (not the holder, not stale, no authority): the caller stops.

import { parseArgs } from './lib/common.mjs';
import { checkIds, claim, readClaim, renew, release, takeover } from './lib/claim.mjs';

const io = { out: (s) => console.log(s), err: (s) => console.error(s) };
const USAGE = 'Usage: node tools/harness/claim.mjs claim|status|renew|release|takeover --task T<nn> --issue <n> [--machine <id>] (see the header)';

function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest, { flags: ['json', 'merged', 'by-user', 'force'] });
  if (!['claim', 'status', 'renew', 'release', 'takeover'].includes(verb)) { io.err(USAGE); return 2; }
  if (!/^\d+$/.test(a.issue ?? '')) { io.err(`--issue must be the task's issue number; got ${a.issue}\n${USAGE}`); return 2; }
  const env = process.env;
  const machine = verb === 'status' ? undefined : (a.machine ?? env.HARNESS_MACHINE);
  if (verb !== 'status' && !machine) { io.err(`--machine (or HARNESS_MACHINE) is required for ${verb}`); return 2; }
  checkIds({ task: a.task, machine });
  const base = { env, io, task: a.task, issue: a.issue, machine };
  if (verb === 'claim') return claim({ ...base, preflight: a.preflight });
  if (verb === 'renew') return renew(base);
  if (verb === 'release') return release({ ...base, reason: a.reason, merged: !!a.merged });
  if (verb === 'takeover') return takeover({ ...base, byUser: !!a['by-user'], force: !!a.force, preflight: a.preflight });
  const c = readClaim({ env, task: a.task, issue: a.issue, branch: a.branch });
  const { commit, ...shown } = c;
  if (a.json) io.out(JSON.stringify(shown));
  else if (!c.held) io.err(`${a.task}: not claimed.`);
  else io.err(`${a.task}: held by ${c.holder ?? 'nobody'}${c.at ? ` since ${c.at}` : ''}${c.expires ? `, lease until ${c.expires}` : ''}${c.pending ? ', claim comment pending' : ''}${c.stale ? `; STALE: ${c.stale}` : ''}.`);
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  io.err(err.message);
  process.exitCode = err.code === 2 ? 2 : 1;
}
