// Multi-machine task claims (H4, #120): one GitHub ref per task, created compare-and-set.
//
// `POST git/refs` fails with 422 "Reference already exists" when the ref is there, so of N
// machines creating refs/heads/claim/T<nn> at once exactly one gets 201: the claim is that
// create, never a label or a re-read. The ref points at a claim commit (main's tree, parent
// main's head) whose message `claim T<nn> machine=<id> at=<iso>` dates the ref, which GitHub does
// not do: a ref with no matching claim comment 10 minutes after that time is stale at once.
// Takeover moves the ref with a non-forced update to a commit whose parent is the stale claim
// commit, so a second taker's update is not a fast-forward and fails: the takeover is
// compare-and-set too, where a delete and re-create would let a slow taker delete the winner's ref.
//
// Every ref write prints one line to stdout, `claim-api op=<op> status=<http> ref=<ref>
// machine=<id> at=<iso>`, for a drill's log to capture unedited (game-archaeologist T14); all
// else goes to stderr.

import { spawnSync } from 'node:child_process';
import { toolCommand } from './common.mjs';

export const LEASE_MS = 24 * 3600 * 1000;
export const NO_COMMENT_MS = 10 * 60 * 1000;
const TASK = /^T\d+$/;
const MACHINE = /^[A-Za-z0-9._-]+$/;

export function checkIds({ task, machine }) {
  if (!TASK.test(task ?? '')) throw usage(`--task must be T<nn>; got ${task}`);
  if (machine !== undefined && !MACHINE.test(machine)) throw usage(`--machine must be letters, digits, '.', '_' or '-'; got ${machine}`);
}

export function usage(msg) { const e = new Error(msg); e.code = 2; return e; }

export const refName = (task) => `refs/heads/claim/${task}`;
const now = (env) => (env.HARNESS_NOW ? new Date(env.HARNESS_NOW) : new Date());
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// One `gh api` call with --include: { status, body } (status null when gh got no response).
export function api(env, method, route, fields = {}) {
  const [exe, pre] = toolCommand('gh', env);
  const args = ['api', '--method', method, '--include', route];
  for (const [k, v] of Object.entries(fields)) {
    for (const one of [].concat(v)) args.push(k === 'force' ? '-F' : '-f', `${k}${Array.isArray(v) ? '[]' : ''}=${one}`);
  }
  const r = spawnSync(exe, [...pre, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw new Error(`gh could not run: ${r.error.message}`);
  const out = r.stdout ?? '';
  const m = /^HTTP\/[\d.]+ (\d{3})/.exec(out);
  const split = out.search(/\r?\n\r?\n/);
  let body = null;
  if (split >= 0) { try { body = JSON.parse(out.slice(split).trim() || 'null'); } catch { body = null; } }
  return { status: m ? Number(m[1]) : null, body, stderr: r.stderr ?? '' };
}

function gh(env, args, { allowFail = false } = {}) {
  const [exe, pre] = toolCommand('gh', env);
  const r = spawnSync(exe, [...pre, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw new Error(`gh could not run: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`gh ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`);
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

const need = (r, what, ...ok) => {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status ?? 'none'}${r.body?.message ? ` (${r.body.message})` : ''} ${r.stderr.trim()}`.trim());
  return r.body;
};

function attempt(io, op, r, task, machine, at) {
  io.out(`claim-api op=${op} status=${r.status ?? 'none'} ref=${refName(task)} machine=${machine} at=${at}`);
}

// A commit carrying the claim's message, with main's tree; its parent is main's head, or for a
// takeover the claim commit it replaces.
function claimCommit(env, message, parent) {
  const head = need(api(env, 'GET', 'repos/{owner}/{repo}/git/ref/heads/main'), 'read main', 200).object.sha;
  const tree = need(api(env, 'GET', `repos/{owner}/{repo}/git/commits/${head}`), 'read main\'s commit', 200).tree.sha;
  return need(api(env, 'POST', 'repos/{owner}/{repo}/git/commits', { message, tree, parents: [parent ?? head] }), 'create the claim commit', 201).sha;
}

const parseClaimMessage = (msg) => {
  const m = /^claim (T\d+) machine=(\S+) at=(\S+)/.exec(msg ?? '');
  return m ? { task: m[1], machine: m[2], at: m[3] } : null;
};

function comments(env, issue) {
  const out = gh(env, ['api', '--paginate', `repos/{owner}/{repo}/issues/${issue}/comments`, '--jq', '.[] | {body, created_at}']).stdout;
  return out ? out.split('\n').map((l) => JSON.parse(l)) : [];
}

const parseLease = (s) => {
  const m = /^(\d+)([hm])$/.exec(s ?? '');
  return m ? Number(m[1]) * (m[2] === 'h' ? 3600e3 : 60e3) : LEASE_MS;
};

// Who holds the task, since when, and whether the claim is stale. `branch` (optional) is the task
// branch, whose head commit's date renews the lease like a comment does.
export function readClaim({ env, task, issue, branch }) {
  const r = api(env, 'GET', `repos/{owner}/{repo}/git/ref/heads/claim/${task}`);
  if (r.status === 404) return { held: false };
  const sha = need(r, 'read the claim ref', 200).object.sha;
  const commit = need(api(env, 'GET', `repos/{owner}/{repo}/git/commits/${sha}`), 'read the claim commit', 200);
  const claim = parseClaimMessage(commit.message);
  const t = now(env).getTime();
  if (!claim || claim.task !== task) {
    return { held: true, sha, holder: null, stale: 'the claim ref points at a commit that is not a claim', commit };
  }
  const list = comments(env, issue);
  const i = list.findIndex((c) => c.body.startsWith(`claim ${task} machine=${claim.machine} at=${claim.at} `) || c.body === `claim ${task} machine=${claim.machine} at=${claim.at}`);
  const base = { held: true, sha, holder: claim.machine, at: claim.at, commit };
  if (i < 0) {
    const age = t - Date.parse(claim.at);
    return { ...base, stale: age >= NO_COMMENT_MS ? `no claim comment ${Math.floor(age / 60e3)} min after the claim` : null, pending: age < NO_COMMENT_MS };
  }
  const lease = parseLease(/ lease=(\S+)/.exec(list[i].body)?.[1]);
  let last = Date.parse(list[i].created_at);
  for (const c of list.slice(i + 1)) last = Math.max(last, Date.parse(c.created_at));
  if (branch) {
    const b = api(env, 'GET', `repos/{owner}/{repo}/commits/${encodeURIComponent(branch)}`);
    if (b.status === 200) last = Math.max(last, Date.parse(b.body.commit.committer.date));
  }
  const expires = last + lease;
  return { ...base, lastActivity: iso(new Date(last)), expires: iso(new Date(expires)), stale: t >= expires ? `the lease expired at ${iso(new Date(expires))} with no push and no comment` : null };
}

function labels(env, issue) {
  const r = gh(env, ['issue', 'view', String(issue), '--json', 'labels', '--jq', '.labels[].name'], { allowFail: true });
  return r.ok && r.stdout ? r.stdout.split('\n') : [];
}

// Labels are the visible status, not the claim: a failure warns and never undoes a won claim (L62).
function setLabels(env, io, issue, add, remove) {
  try {
    for (const l of add.filter((x) => x.startsWith('machine:'))) gh(env, ['label', 'create', l, '--color', 'bfd4f2', '--force']);
    const args = ['issue', 'edit', String(issue)];
    if (add.length) args.push('--add-label', add.join(','));
    if (remove.length) args.push('--remove-label', remove.join(','));
    gh(env, args);
  } catch (err) {
    io.err(`label error: ${err.message}; the claim stands, fix the labels by hand.`);
  }
}

function comment(env, issue, body) { gh(env, ['issue', 'comment', String(issue), '--body', body]); }

// Exit codes: 0 done, 1 defect or GitHub error, 2 usage, 3 held / lost / refused by the rules.
export function claim({ env, io, task, issue, machine, preflight = 'not-run' }) {
  const at = iso(now(env));
  const sha = claimCommit(env, `claim ${task} machine=${machine} at=${at}`);
  const r = api(env, 'POST', 'repos/{owner}/{repo}/git/refs', { ref: refName(task), sha });
  attempt(io, 'create', r, task, machine, at);
  if (r.status === 422 && /already exists/i.test(r.body?.message ?? '')) {
    io.err(`held: ${refName(task)} exists; another machine holds ${task}. Stop (or, when it is stale, take it over).`);
    return 3;
  }
  need(r, 'create the claim ref', 201);
  try {
    comment(env, issue, `claim ${task} machine=${machine} at=${at} lease=24h preflight=${preflight}`);
  } catch (err) {
    // No claim comment means no lease: undo the ref rather than leave a claim others must wait out.
    const d = api(env, 'DELETE', `repos/{owner}/{repo}/git/refs/heads/claim/${task}`);
    attempt(io, 'delete', d, task, machine, at);
    io.err(`the claim comment failed (${err.message}); the claim ref was ${d.status === 204 ? 'deleted' : `not deleted (HTTP ${d.status}): it goes stale in 10 min`}.`);
    return 1;
  }
  const stale = labels(env, issue).filter((l) => l.startsWith('status:') && l !== 'status:in-progress');
  setLabels(env, io, issue, [`machine:${machine}`, 'status:in-progress'], stale);
  io.err(`won: ${task} is claimed by ${machine} at ${at}.`);
  return 0;
}

export function renew({ env, io, task, issue, machine }) {
  const c = readClaim({ env, task, issue });
  if (!c.held || c.holder !== machine) { io.err(`refused: ${machine} does not hold ${task} (${c.held ? `held by ${c.holder ?? 'nobody'}` : 'not claimed'}).`); return 3; }
  comment(env, issue, `renew ${task} machine=${machine} at=${iso(now(env))}`);
  io.err(`renewed: ${task} by ${machine}.`);
  return 0;
}

// Release (stop, escalation, the user) or merge: comment, drop the machine label (merged: keep it
// as history), delete the ref. The task branch stays: it is the resumable state.
export function release({ env, io, task, issue, machine, reason = 'released', merged = false }) {
  const c = readClaim({ env, task, issue });
  if (!c.held || c.holder !== machine) { io.err(`refused: ${machine} does not hold ${task} (${c.held ? `held by ${c.holder ?? 'nobody'}` : 'not claimed'}).`); return 3; }
  const at = iso(now(env));
  comment(env, issue, `release ${task} machine=${machine} at=${at} reason=${merged ? 'merged' : reason}`);
  if (!merged) setLabels(env, io, issue, [], [`machine:${machine}`]);
  const d = api(env, 'DELETE', `repos/{owner}/{repo}/git/refs/heads/claim/${task}`);
  attempt(io, 'delete', d, task, machine, at);
  need(d, 'delete the claim ref', 204);
  io.err(`released: ${task} by ${machine}.`);
  return 0;
}

// Takeover of a stale claim, by the primary (the repository variable HARNESS_PRIMARY) or the user
// (--by-user). --force takes over a claim that is not stale, and only with --by-user.
export function takeover({ env, io, task, issue, machine, byUser = false, force = false, preflight = 'not-run' }) {
  if (force && !byUser) throw usage('--force needs --by-user: only the user takes over a claim that is not stale');
  if (!byUser) {
    const p = gh(env, ['variable', 'get', 'HARNESS_PRIMARY'], { allowFail: true });
    if (!p.ok || p.stdout !== machine) {
      io.err(`refused: takeover needs the primary machine (HARNESS_PRIMARY${p.ok ? ` is ${p.stdout}` : ' is not set'}) or the user (--by-user).`);
      return 3;
    }
  }
  const c = readClaim({ env, task, issue });
  if (!c.held) { io.err(`${task} is not claimed: claim it instead.`); return 3; }
  if (!c.stale && !force) { io.err(`refused: ${task}'s claim by ${c.holder} is not stale (lease until ${c.expires ?? 'its claim comment'}).`); return 3; }
  if (c.holder === machine && !force) { io.err(`${machine} already holds ${task}.`); return 3; }
  const at = iso(now(env));
  const old = c.holder ?? 'unknown';
  comment(env, issue, `takeover ${task} from=${old} by=${machine} at=${at}${c.stale ? ` stale=${JSON.stringify(c.stale)}` : ' forced-by-user'}`);
  // Parent: the stale claim commit, so a non-forced update is compare-and-set on it.
  const sha = claimCommit(env, `claim ${task} machine=${machine} at=${at}`, c.sha);
  const r = api(env, 'PATCH', `repos/{owner}/{repo}/git/refs/heads/claim/${task}`, { sha, force: 'false' });
  attempt(io, 'takeover', r, task, machine, at);
  if (r.status === 422) { io.err(`lost: another taker moved ${refName(task)} first. Stop.`); return 3; }
  need(r, 'move the claim ref', 200);
  comment(env, issue, `claim ${task} machine=${machine} at=${at} lease=24h preflight=${preflight}`);
  const stale = labels(env, issue).filter((l) => (l.startsWith('status:') && l !== 'status:in-progress') || (l.startsWith('machine:') && l !== `machine:${machine}`));
  setLabels(env, io, issue, [`machine:${machine}`, 'status:in-progress'], stale);
  io.err(`taken over: ${task} from ${old} by ${machine} at ${at}. Resume the pushed task branch; never recreate it.`);
  return 0;
}
