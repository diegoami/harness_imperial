// Multi-machine task claims (H4, #120): one GitHub ref per task, and every change to it
// compare-and-set, so two machines never both hold a task.
//
// The ref refs/heads/claim/T<nn> is the claim's whole state: the commit it points at says who holds
// the task and since when (GitHub dates no ref). Its message is one of
//   claim T<nn> machine=<id> at=<iso> issue=<n> nonce=<hex>                    held, claimed at <iso>
//   renew T<nn> machine=<id> at=<iso> issue=<n> claimed=<iso> id=<hex> nonce=<hex>   lease renewed
//   release T<nn> machine=<id> at=<iso> issue=<n> reason=<word> nonce=<hex>   free (the branch is the state)
//   merged T<nn> machine=<id> at=<iso> issue=<n> nonce=<hex>                   done; the ref is then deleted
// The nonce keeps two commits apart even with equal text (a commit is its content); a claim's nonce
// is its id, which its claim comment and its renewals carry, so no other claim's comment can stand
// in for it. `issue` binds the claim to its issue: a call naming another is refused.
// The first claim is `POST git/refs`, which GitHub answers 422 "Reference already exists" for all
// but one caller. Every later change (claim of a released ref, renew, release, takeover, merge)
// is a non-forced PATCH to a child of the commit the caller read, which GitHub refuses (422 "not a
// fast forward") once anyone else moved the ref. Nothing ever deletes a ref another machine might
// hold: only `merged`, which nothing claims, is deleted.
//
// The lease: 24h from the claim comment (or the renewal), extended by each comment on the issue
// and each commit on the task branch made before it ran out. Once run out it stays out (activity
// after that revives nothing), so a takeover's stale read cannot be undone by a late comment; only
// `renew`, which moves the ref, can beat the taker. A task branch that cannot be read leaves the
// lease unknown, which no takeover but the user's --force acts on. A claim whose claim comment is missing
// 10 minutes after its time is stale at once; a claimer that took 5 minutes to comment gives up.
// A holder re-runs `status` before it acts on the claim (a merge, a push): a forced takeover by the
// user can displace it at any time.
//
// Every ref write prints one line to stdout, `claim-api op=<op> status=<http> ref=<ref>
// machine=<id> at=<iso>`, for a drill's log (game-archaeologist T14); all else goes to stderr.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { toolCommand } from './common.mjs';

export const LEASE_MS = 24 * 3600 * 1000;
export const NO_COMMENT_MS = 10 * 60 * 1000;
export const GIVE_UP_MS = 5 * 60 * 1000;
const TASK = /^T\d+$/;
const MACHINE = /^[A-Za-z0-9._-]+$/;
const WORD = /^[A-Za-z0-9._:,-]+$/;

export function usage(msg) { const e = new Error(msg); e.code = 2; return e; }

export function checkIds({ task, machine, branch, reason, preflight }) {
  if (!TASK.test(task ?? '')) throw usage(`--task must be T<nn>; got ${task}`);
  if (machine !== undefined && !MACHINE.test(machine)) throw usage(`--machine must be letters, digits, '.', '_' or '-'; got ${machine}`);
  for (const [k, v] of Object.entries({ branch, reason, preflight })) {
    if (v !== undefined && !(k === 'branch' ? /^[A-Za-z0-9._/-]+$/ : WORD).test(v)) throw usage(`--${k} has a character it may not carry: ${v}`);
  }
}

export const refName = (task) => `refs/heads/claim/${task}`;
const refRoute = (task) => `repos/{owner}/{repo}/git/refs/heads/claim/${task}`;
const now = (env) => (env.HARNESS_NOW ? new Date(env.HARNESS_NOW) : new Date());
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nonce = () => crypto.randomBytes(6).toString('hex');

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
const refExists = (r) => r.status === 422 && r.body?.message === 'Reference already exists';
const notFastForward = (r) => r.status === 422 && r.body?.message === 'Update is not a fast forward';

function attempt(io, op, r, task, machine, at) {
  io.out(`claim-api op=${op} status=${r.status ?? 'none'} ref=${refName(task)} machine=${machine} at=${at}`);
}

// A commit with main's tree and `message`; its parent is the commit the ref points at (a PATCH's
// compare), or main's head for the first create.
function stateCommit(env, message, parent) {
  const head = need(api(env, 'GET', 'repos/{owner}/{repo}/git/ref/heads/main'), 'read main', 200).object.sha;
  const tree = need(api(env, 'GET', `repos/{owner}/{repo}/git/commits/${head}`), 'read main\'s commit', 200).tree.sha;
  return need(api(env, 'POST', 'repos/{owner}/{repo}/git/commits', { message, tree, parents: [parent ?? head] }), 'create the claim commit', 201).sha;
}

// Moves the ref from `from` (the commit read) to a new child commit; { r, sha }. 422 not-a-fast-
// forward means someone else moved it first.
function move(env, io, op, task, machine, at, from, message, id = nonce()) {
  const sha = stateCommit(env, `${message} nonce=${id}`, from);
  const r = api(env, 'PATCH', refRoute(task), { sha, force: 'false' });
  attempt(io, op, r, task, machine, at);
  if (r.status !== 200 && !notFastForward(r)) need(r, `move ${refName(task)}`, 200);
  return { r, sha, id, moved: r.status === 200 };
}

export function parseState(message) {
  const m = /^(claim|renew|release|merged) (T\d+) machine=(\S+) at=(\S+)(.*)$/.exec((message ?? '').split('\n')[0]);
  if (!m) return null;
  const field = (k) => new RegExp(` ${k}=(\\S+)`).exec(m[5])?.[1];
  return { kind: m[1], task: m[2], machine: m[3], at: m[4], issue: field('issue'), reason: field('reason'),
    claimed: m[1] === 'renew' ? field('claimed') : m[1] === 'claim' ? m[4] : undefined,
    id: m[1] === 'renew' ? field('id') : field('nonce') };
}

function comments(env, issue) {
  const out = gh(env, ['api', '--paginate', `repos/{owner}/{repo}/issues/${issue}/comments`, '--jq', '.[] | {body, created_at}']).stdout;
  return out ? out.split('\n').map((l) => JSON.parse(l)) : [];
}

// The task branch's commit times since `since`; [] when the branch was never pushed (404), null
// when GitHub could not be read: an unknown, never proof of no activity (Sol's round-2 R3).
function branchDates(env, branch, since) {
  const route = `repos/{owner}/{repo}/commits?sha=${encodeURIComponent(branch)}&since=${since}`;
  const probe = api(env, 'GET', `${route}&per_page=1`);
  if (probe.status === 404) return [];
  if (probe.status !== 200) return null;
  const out = gh(env, ['api', '--paginate', route, '--jq', '.[].commit.committer.date'], { allowFail: true });
  if (!out.ok) return null;
  return out.stdout ? out.stdout.split('\n').map((d) => Date.parse(d)) : [];
}

// A comment through the API, so its time is GitHub's: { created_at }.
function comment(env, issue, body) {
  const r = api(env, 'POST', `repos/{owner}/{repo}/issues/${issue}/comments`, { body });
  return need(r, 'post the comment', 201);
}

const parseLease = (s) => {
  const m = /^(\d+)([hm])$/.exec(s ?? '');
  return m ? Number(m[1]) * (m[2] === 'h' ? 3600e3 : 60e3) : LEASE_MS;
};

// The claim as the ref has it. { state: free|released|merged|held, sha, holder, kind, at, stale,
// pending, expires, lastActivity, branch }. `branch` overrides the one the claim comment names.
export function readClaim({ env, task, issue, branch }) {
  const r = api(env, 'GET', `repos/{owner}/{repo}/git/ref/heads/claim/${task}`);
  if (r.status === 404) return { state: 'free', held: false };
  const sha = need(r, 'read the claim ref', 200).object.sha;
  const commit = need(api(env, 'GET', `repos/{owner}/{repo}/git/commits/${sha}`), 'read the claim commit', 200);
  const s = parseState(commit.message);
  if (!s || s.task !== task) return { state: 'held', held: true, sha, holder: null, stale: 'the claim ref points at a commit that is not a claim' };
  if (s.issue && s.issue !== String(issue)) throw usage(`${task}'s claim is on issue #${s.issue}, not #${issue}`);
  if (s.kind === 'release') return { state: 'released', held: false, sha, by: s.machine, at: s.at, reason: s.reason };
  if (s.kind === 'merged') return { state: 'merged', held: false, sha, by: s.machine, at: s.at };
  const base = { state: 'held', held: true, sha, holder: s.machine, kind: s.kind, at: s.at, claimed: s.claimed, id: s.id, established: false };
  const t = now(env).getTime();
  const list = comments(env, issue);
  const i = list.findIndex((c) => c.body.startsWith(`claim ${task} machine=${s.machine} at=${s.claimed} `) && c.body.split(' ').includes(`id=${s.id}`));
  if (i < 0) {
    const age = t - Date.parse(s.claimed);
    return { ...base, stale: age >= NO_COMMENT_MS ? `no claim comment ${Math.floor(age / 60e3)} min after the claim` : null, pending: age < NO_COMMENT_MS };
  }
  const lease = parseLease(/ lease=(\S+)/.exec(list[i].body)?.[1]);
  const b = branch ?? / branch=(\S+)/.exec(list[i].body)?.[1];
  const start = Math.max(Date.parse(list[i].created_at), s.kind === 'renew' ? Date.parse(s.at) : 0);
  const pushes = b ? branchDates(env, b, iso(start)) : [];
  const events = [...list.slice(i + 1).map((c) => Date.parse(c.created_at)), ...(pushes ?? [])].filter((e) => e > start).sort((x, y) => x - y);
  let expires = start + lease;
  let last = start;
  for (const e of events) if (e < expires) { expires = e + lease; last = e; }
  const out = { ...base, established: true, branch: b, lastActivity: iso(last), expires: iso(expires) };
  if (pushes === null) return { ...out, stale: null, unknown: `the task branch ${b} could not be read, so the lease is unknown` };
  return { ...out, stale: t >= expires ? `the lease ran out at ${iso(expires)} with no push and no comment before it` : null };
}

function labels(env, issue) {
  const r = gh(env, ['issue', 'view', String(issue), '--json', 'labels', '--jq', '.labels[].name'], { allowFail: true });
  return r.ok && r.stdout ? r.stdout.split('\n') : [];
}

// Labels are the visible status, not the claim: a failure warns and never undoes a claim (L62).
function setLabels(env, io, issue, add, remove) {
  try {
    for (const l of add.filter((x) => x.startsWith('machine:'))) gh(env, ['label', 'create', l, '--color', 'bfd4f2', '--force']);
    const args = ['issue', 'edit', String(issue)];
    if (add.length) args.push('--add-label', add.join(','));
    if (remove.length) args.push('--remove-label', remove.join(','));
    if (add.length || remove.length) gh(env, args);
  } catch (err) {
    io.err(`label error: ${err.message}; the claim is unchanged, fix the labels by hand.`);
  }
}

const holderLabels = (env, issue, machine) => labels(env, issue).filter((l) =>
  (l.startsWith('status:') && l !== 'status:in-progress') || (l.startsWith('machine:') && l !== `machine:${machine}`));

// After the ref is ours: the claim comment, the time check, the labels, and a last read that the
// ref is still ours. A failed comment or a slow one gives the claim back (compare-and-set).
function establish({ env, io, task, issue, machine, at, sha, id, preflight, branch }) {
  const body = `claim ${task} machine=${machine} at=${at} lease=24h preflight=${preflight} id=${id}${branch ? ` branch=${branch}` : ''}`;
  let posted;
  try { posted = comment(env, issue, body); } catch (err) { return giveBack(env, io, task, issue, machine, sha, 'claim-comment-failed', `the claim comment failed (${err.message})`); }
  const took = Date.parse(posted.created_at) - Date.parse(at);
  if (took >= GIVE_UP_MS) return giveBack(env, io, task, issue, machine, sha, 'claim-too-slow', `the claim comment came ${Math.floor(took / 60e3)} min after the claim`);
  setLabels(env, io, issue, [`machine:${machine}`, 'status:in-progress'], holderLabels(env, issue, machine));
  if (!stillOurs(env, task, sha)) { io.err(`lost: ${refName(task)} moved away from this claim before it was established (a takeover). Stop.`); return 3; }
  return 0;
}

const stillOurs = (env, task, sha) => api(env, 'GET', `repos/{owner}/{repo}/git/ref/heads/claim/${task}`).body?.object?.sha === sha;

function giveBack(env, io, task, issue, machine, sha, reason, why) {
  const at = iso(now(env));
  const m = move(env, io, 'release', task, machine, at, sha, `release ${task} machine=${machine} at=${at} issue=${issue} reason=${reason}`);
  io.err(`${why}; the claim was ${m.moved ? 'given back (released)' : 'already moved by another machine, which holds it now'}.`);
  return 1;
}

// Exit codes: 0 done, 1 defect or GitHub error, 2 usage, 3 held / lost / refused: the caller stops.
export function claim({ env, io, task, issue, machine, preflight = 'not-run', branch }) {
  const at = iso(now(env));
  const message = `claim ${task} machine=${machine} at=${at} issue=${issue}`;
  let c = readClaim({ env, task, issue });
  if (c.state === 'merged') { io.err(`refused: ${task} is merged.`); return 3; }
  let sha;
  let id = nonce();
  if (c.state !== 'released') {
    sha = stateCommit(env, `${message} nonce=${id}`);
    const r = api(env, 'POST', 'repos/{owner}/{repo}/git/refs', { ref: refName(task), sha });
    attempt(io, 'create', r, task, machine, at);
    if (refExists(r)) {
      c = readClaim({ env, task, issue });
      if (c.state !== 'released') { io.err(`held: ${refName(task)} is ${c.holder ? `held by ${c.holder}` : c.state}. Stop (or, when it is stale, take it over).`); return 3; }
    } else {
      need(r, 'create the claim ref', 201);
    }
  }
  if (c.state === 'released') {
    const m = move(env, io, 'claim', task, machine, at, c.sha, message);
    if (!m.moved) { io.err(`held: another machine claimed ${task} first. Stop.`); return 3; }
    ({ sha, id } = m);
  }
  const code = establish({ env, io, task, issue, machine, at, sha, id, preflight, branch });
  if (code === 0) io.err(`won: ${task} is claimed by ${machine} at ${at}.`);
  return code;
}

const notHolder = (io, c, machine, task) => {
  if (c.held && c.holder === machine) return false;
  io.err(`refused: ${machine} does not hold ${task} (${c.held ? `held by ${c.holder ?? 'nobody'}` : c.state}).`);
  return true;
};

export function renew({ env, io, task, issue, machine }) {
  const c = readClaim({ env, task, issue });
  if (notHolder(io, c, machine, task)) return 3;
  // A claim not yet established (its claim comment pending) has nothing to renew (round-2 R2).
  if (!c.established) { io.err(`refused: ${task}'s claim by ${machine} has no claim comment yet; nothing to renew.`); return 3; }
  const at = iso(now(env));
  const m = move(env, io, 'renew', task, machine, at, c.sha, `renew ${task} machine=${machine} at=${at} issue=${issue} claimed=${c.claimed} id=${c.id}`);
  if (!m.moved) { io.err(`lost: ${refName(task)} was moved by another machine. Stop.`); return 3; }
  try { comment(env, issue, `renew ${task} machine=${machine} at=${at}`); } catch (err) { io.err(`renewed, but the renew comment failed (${err.message}).`); }
  if (!stillOurs(env, task, m.sha)) { io.err(`lost: ${refName(task)} was taken over while renewing. Stop.`); return 3; }
  io.err(`renewed: ${task} by ${machine}${c.stale ? ` (it was stale: ${c.stale})` : ''}.`);
  return 0;
}

// Release (stop, escalation, the user): the ref moves to a release commit, then the comment and the
// machine label. Merged: the ref moves to `merged`, the label stays as history, and the ref is
// deleted. The task branch stays either way: it is the resumable state.
export function release({ env, io, task, issue, machine, reason = 'released', merged = false }) {
  const c = readClaim({ env, task, issue });
  if (notHolder(io, c, machine, task)) return 3;
  const at = iso(now(env));
  const msg = merged ? `merged ${task} machine=${machine} at=${at} issue=${issue}` : `release ${task} machine=${machine} at=${at} issue=${issue} reason=${reason}`;
  const m = move(env, io, merged ? 'merged' : 'release', task, machine, at, c.sha, msg);
  if (!m.moved) { io.err(`lost: ${refName(task)} was moved by another machine, which holds it now. Stop.`); return 3; }
  comment(env, issue, `release ${task} machine=${machine} at=${at} reason=${merged ? 'merged' : reason}`);
  if (!merged) setLabels(env, io, issue, [], [`machine:${machine}`]);
  if (merged) {
    // Nothing claims, renews or takes over a merged ref, so this delete can only remove our own.
    const d = api(env, 'DELETE', refRoute(task));
    attempt(io, 'delete', d, task, machine, at);
    if (d.status !== 204) io.err(`the merged claim ref was not deleted (HTTP ${d.status}); it blocks nothing.`);
  }
  io.err(`${merged ? 'merged' : 'released'}: ${task} by ${machine}.`);
  return 0;
}

// Takeover, by the primary (the repository variable HARNESS_PRIMARY) or the user (--by-user), of a
// stale claim; --force, the user only, of one that is not stale.
export function takeover({ env, io, task, issue, machine, byUser = false, force = false, preflight = 'not-run', branch }) {
  if (force && !byUser) throw usage('--force needs --by-user: only the user takes over a claim that is not stale');
  if (!byUser) {
    const p = gh(env, ['variable', 'get', 'HARNESS_PRIMARY'], { allowFail: true });
    if (!p.ok || p.stdout !== machine) {
      io.err(`refused: takeover needs the primary machine (HARNESS_PRIMARY${p.ok ? ` is ${p.stdout}` : ' is not set'}) or the user (--by-user).`);
      return 3;
    }
  }
  const c = readClaim({ env, task, issue, branch });
  if (!c.held) { io.err(`${task} is ${c.state}, not held: ${c.state === 'merged' ? 'nothing to take' : 'claim it instead'}.`); return 3; }
  if (!c.stale && !force) { io.err(`refused: ${task}'s claim by ${c.holder} is not stale (${c.unknown ?? (c.pending ? 'its claim comment is pending' : `lease until ${c.expires}`)}).`); return 3; }
  if (c.holder === machine && !force) { io.err(`${machine} already holds ${task}: renew it instead.`); return 3; }
  const at = iso(now(env));
  const old = c.holder ?? 'unknown';
  comment(env, issue, `takeover ${task} from=${old} by=${machine} at=${at} ${c.stale ? `stale=${JSON.stringify(c.stale)}` : 'forced-by-user'}`);
  const m = move(env, io, 'takeover', task, machine, at, c.sha, `claim ${task} machine=${machine} at=${at} issue=${issue}`);
  if (!m.moved) { io.err(`lost: another machine moved ${refName(task)} first (a taker, or the holder renewing). Stop.`); return 3; }
  const code = establish({ env, io, task, issue, machine, at, sha: m.sha, id: m.id, preflight, branch: branch ?? c.branch });
  if (code === 0) io.err(`taken over: ${task} from ${old} by ${machine} at ${at}. Resume the pushed task branch; never recreate it.`);
  return code;
}
