// claim.mjs (H4, #120): the claim is the compare-and-set creation of a ref, against the fake gh,
// which serves the git refs API as GitHub does (one 201, then 422 "Reference already exists").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.resolve(here, '../template/tools/harness/claim.mjs');
const T0 = '2026-10-08T12:00:00Z';
const at = (min) => new Date(Date.parse(T0) + min * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

function repo(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  const file = path.join(dir, 'gh.json');
  fs.writeFileSync(file, JSON.stringify({
    prs: [], refs: { 'refs/heads/main': 'm0' }, commits: { m0: { message: 'main', tree: 'tree0', parents: [] } },
    issueLabels: { 39: ['task', 'status:ready'] }, ...extra,
  }));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = (args, env = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, FAKE_GH_STATE: file, HARNESS_GH_EXE: path.join(here, 'fake-gh.mjs'), HARNESS_NOW: T0, HARNESS_MACHINE: '', ...env },
    });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  return { file, read, run, done };
}

const claimArgs = (machine, ...more) => ['claim', '--task', 'T14', '--issue', '39', '--machine', machine, ...more];

test('claim: a 201 wins; the ref points at a claim commit on main; comment, labels and the attempt line follow', async () => {
  const r = repo();
  try {
    const x = await r.run(claimArgs('box-a', '--preflight', 'gh:ok'));
    assert.equal(x.code, 0, x.err);
    assert.equal(x.out, `claim-api op=create status=201 ref=refs/heads/claim/T14 machine=box-a at=${T0}\n`);
    const s = r.read();
    const c = s.commits[s.refs['refs/heads/claim/T14']];
    assert.match(c.message, new RegExp(`^claim T14 machine=box-a at=${T0} issue=39 nonce=[0-9a-f]{12}$`));
    const id = /nonce=(\S+)/.exec(c.message)[1];
    assert.equal(c.tree, 'tree0');
    assert.deepEqual(c.parents, ['m0']);
    assert.deepEqual(s.issueComments[39].map((k) => k.body), [`claim T14 machine=box-a at=${T0} lease=24h preflight=gh:ok id=${id}`]);
    assert.deepEqual(s.issueLabels[39].sort(), ['machine:box-a', 'status:in-progress', 'task']);
    assert.ok(s.labelsCreated.includes('machine:box-a'));
  } finally { r.done(); }
});

test('claim: a 422 "Reference already exists" is held, exit 3, and writes nothing else; another 422 is an error', async () => {
  const r = repo();
  try {
    assert.equal((await r.run(claimArgs('box-a'))).code, 0);
    const before = r.read();
    const y = await r.run(claimArgs('box-b'));
    assert.equal(y.code, 3, y.err);
    assert.match(y.out, /^claim-api op=create status=422 ref=refs\/heads\/claim\/T14 machine=box-b /);
    assert.match(y.err, /held/);
    const after = r.read();
    assert.deepEqual(after.issueComments, before.issueComments);
    assert.deepEqual(after.issueLabels, before.issueLabels);
    assert.equal(after.refs['refs/heads/claim/T14'], before.refs['refs/heads/claim/T14']);
  } finally { r.done(); }
  // A 422 for another reason ("Object does not exist") is an error, never "held".
  const bad = repo();
  try {
    const z = await bad.run(claimArgs('box-c'), { FAKE_GH_REF_422: 'Object does not exist' });
    assert.equal(z.code, 1, z.err);
    assert.match(z.err, /Object does not exist/);
    assert.equal(bad.read().issueComments[39], undefined);
    // A near match is not "Reference already exists" either (Sol's R7).
    const n = await bad.run(claimArgs('box-c'), { FAKE_GH_REF_422: 'Object already exists' });
    assert.equal(n.code, 1, n.err);
  } finally { bad.done(); }
});

test('the race: of 8 machines claiming at once exactly one wins, and only the winner comments', async () => {
  const r = repo();
  try {
    const names = Array.from({ length: 8 }, (_, i) => `m${i}`);
    const res = await Promise.all(names.map((n) => r.run(claimArgs(n))));
    assert.equal(res.filter((x) => x.code === 0).length, 1, res.map((x) => x.err).join('\n'));
    assert.equal(res.filter((x) => x.code === 3).length, 7);
    const lines = res.map((x) => x.out.trim().split('\n'));
    for (const l of lines) assert.equal(l.length, 1);
    assert.equal(lines.flat().filter((l) => / status=201 /.test(l)).length, 1);
    const winner = names[res.findIndex((x) => x.code === 0)];
    const s = r.read();
    assert.equal(s.issueComments[39].length, 1);
    assert.match(s.issueComments[39][0].body, new RegExp(`^claim T14 machine=${winner} `));
    assert.match(s.commits[s.refs['refs/heads/claim/T14']].message, new RegExp(`machine=${winner} `));
  } finally { r.done(); }
});

test('claim: a failed claim comment gives the claim back (released); a label failure keeps it', async () => {
  const r = repo();
  try {
    const x = await r.run(claimArgs('box-a'), { FAKE_GH_FAIL_COMMENT: '1' });
    assert.equal(x.code, 1);
    assert.match(x.out, /op=create status=201/);
    assert.match(x.out, /op=release status=200/);
    const s = r.read();
    assert.match(s.commits[s.refs['refs/heads/claim/T14']].message, /^release T14 machine=box-a \S+ issue=39 reason=claim-comment-failed /);
    assert.equal((await status(r)).state, 'released');
    // A released ref is claimed by a compare-and-set move, not a create.
    const y = await r.run(claimArgs('box-a'), { FAKE_GH_FAIL_LABELS: '1' });
    assert.equal(y.code, 0, y.err);
    assert.match(y.out, /^claim-api op=claim status=200 /);
    assert.match(y.err, /label error/);
    assert.equal((await status(r)).holder, 'box-a');
  } finally { r.done(); }
});

const status = async (r, env, ...more) => JSON.parse((await r.run(['status', '--task', 'T14', '--issue', '39', '--json', ...more], env)).out);

test('status: free, held under lease, renewed by a comment or a push, stale when the lease expires', async () => {
  const r = repo({ branchDates: { 'task/T14-x': [at(30 * 60)] } });
  try {
    assert.deepEqual(await status(r), { state: 'free', held: false });
    await r.run(claimArgs('box-a'));
    let s = await status(r, { HARNESS_NOW: at(60) });
    assert.equal(s.holder, 'box-a'); assert.equal(s.stale, null); assert.equal(s.expires, at(24 * 60));
    s = await status(r, { HARNESS_NOW: at(24 * 60) });
    assert.match(s.stale, /lease ran out/);
    // A comment at +20h renews to +44h.
    await r.run(['renew', '--task', 'T14', '--issue', '39', '--machine', 'box-a'], { HARNESS_NOW: at(20 * 60) });
    s = await status(r, { HARNESS_NOW: at(24 * 60) });
    assert.equal(s.stale, null); assert.equal(s.expires, at(44 * 60));
    // A push to the task branch (head commit at +30h) renews to +54h.
    s = await status(r, { HARNESS_NOW: at(50 * 60) }, '--branch', 'task/T14-x');
    assert.equal(s.stale, null); assert.equal(s.expires, at(54 * 60));
    s = await status(r, { HARNESS_NOW: at(50 * 60) });
    assert.match(s.stale, /lease ran out/);
  } finally { r.done(); }
});

test('status: a claim ref with no claim comment is pending for 10 min, then stale at once', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    const st = r.read(); st.issueComments = {}; fs.writeFileSync(r.file, JSON.stringify(st));
    let s = await status(r, { HARNESS_NOW: at(9) });
    assert.equal(s.stale, null); assert.equal(s.pending, true);
    s = await status(r, { HARNESS_NOW: at(10) });
    assert.match(s.stale, /no claim comment 10 min/);
    // A comment that merely mentions the machine is not the claim comment: the at= must match.
    st.issueComments = { 39: [{ body: `claim T14 machine=box-a at=${at(-5)} lease=24h preflight=x`, created_at: at(0) }] };
    fs.writeFileSync(r.file, JSON.stringify(st));
    s = await status(r, { HARNESS_NOW: at(10) });
    assert.match(s.stale, /no claim comment/);
  } finally { r.done(); }
});

test('release: only the holder; the ref moves to a release commit, never deleted; --merged keeps the label and deletes', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    const no = await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-b']);
    assert.equal(no.code, 3);
    assert.equal((await status(r)).holder, 'box-a');
    const x = await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a', '--reason', 'escalated']);
    assert.equal(x.code, 0, x.err);
    assert.match(x.out, /^claim-api op=release status=200 /);
    const s = r.read();
    assert.match(s.commits[s.refs['refs/heads/claim/T14']].message, /^release T14 machine=box-a at=\S+ issue=39 reason=escalated nonce=/);
    assert.ok(!s.issueLabels[39].includes('machine:box-a'));
    assert.match(s.issueComments[39].at(-1).body, /^release T14 machine=box-a at=\S+ reason=escalated$/);
    assert.equal((await status(r)).state, 'released');
    await r.run(claimArgs('box-a'));
    const m = await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a', '--merged']);
    assert.equal(m.code, 0, m.err);
    assert.match(m.out, /op=merged status=200 .*\n.*op=delete status=204 /);
    assert.equal(r.read().refs['refs/heads/claim/T14'], undefined);
    assert.ok(r.read().issueLabels[39].includes('machine:box-a'));
    assert.match(r.read().issueComments[39].at(-1).body, /reason=merged$/);
  } finally { r.done(); }
});

test('a merged ref is never claimed or taken over (when its delete failed)', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a', '--merged']);
    const st = r.read();
    const merged = Object.entries(st.commits).find(([, c]) => /^merged T14 /.test(c.message))[0];
    st.refs['refs/heads/claim/T14'] = merged; fs.writeFileSync(r.file, JSON.stringify(st));
    const c = await r.run(claimArgs('box-b'));
    assert.equal(c.code, 3); assert.equal(c.out, '');        // refused before any ref write
    assert.match(c.err, /merged/);
    assert.equal((await r.run(take('box-b', '--by-user', '--force'))).code, 3);
    assert.equal(r.read().refs['refs/heads/claim/T14'], merged);
  } finally { r.done(); }
});

const take = (machine, ...more) => ['takeover', '--task', 'T14', '--issue', '39', '--machine', machine, ...more];

test('takeover: refused when not stale or without authority; the primary takes a stale claim, labels swapped', async () => {
  const r = repo({ variables: { HARNESS_PRIMARY: 'box-p' } });
  try {
    await r.run(claimArgs('box-a'));
    const late = { HARNESS_NOW: at(25 * 60) };
    assert.equal((await r.run(take('box-p'), { HARNESS_NOW: at(60) })).code, 3);     // not stale
    assert.equal((await r.run(take('box-b'), late)).code, 3);                         // not the primary
    assert.equal((await r.run(take('box-b', '--force'), late)).code, 2);              // --force needs --by-user
    const old = r.read().refs['refs/heads/claim/T14'];
    const x = await r.run(take('box-p', '--preflight', 'gh:ok'), late);
    assert.equal(x.code, 0, x.err);
    assert.match(x.out, /^claim-api op=takeover status=200 ref=refs\/heads\/claim\/T14 machine=box-p /);
    const s = r.read();
    const c = s.commits[s.refs['refs/heads/claim/T14']];
    assert.deepEqual(c.parents, [old]);
    assert.match(c.message, /^claim T14 machine=box-p /);
    assert.deepEqual(s.issueLabels[39].sort(), ['machine:box-p', 'status:in-progress', 'task']);
    const bodies = s.issueComments[39].map((k) => k.body);
    assert.match(bodies.at(-2), /^takeover T14 from=box-a by=box-p /);
    assert.match(bodies.at(-1), /^claim T14 machine=box-p at=\S+ lease=24h preflight=gh:ok id=[0-9a-f]{12}$/);
    const st = await status(r, late);
    assert.equal(st.holder, 'box-p'); assert.equal(st.stale, null);
  } finally { r.done(); }
});

test('takeover is compare-and-set: of two takers of one stale claim, one moves the ref and the other loses', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    const late = { HARNESS_NOW: at(25 * 60) };
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => r.run(take(`t${i}`, '--by-user'), late)));
    assert.equal(res.filter((x) => x.code === 0).length, 1, res.map((x) => x.err).join('\n'));
    for (const x of res.filter((y) => y.code !== 0)) assert.equal(x.code, 3, x.err);
    const winner = `t${res.findIndex((x) => x.code === 0)}`;
    const s = r.read();
    assert.match(s.commits[s.refs['refs/heads/claim/T14']].message, new RegExp(`machine=${winner} `));
    assert.equal(s.issueComments[39].filter((k) => k.body.startsWith('claim T14 machine=t')).length, 1);
  } finally { r.done(); }
  // The slow taker, deterministically: all three read the stale claim, then write one after another
  // (FAKE_GH_SEQ). The first wins; the later ones must lose, never replace the winner's ref.
  const q = repo();
  try {
    await q.run(claimArgs('box-a'));
    const late = { HARNESS_NOW: at(25 * 60), FAKE_GH_SEQ: '3' };
    const res = await Promise.all(['s0', 's1', 's2'].map((n) => q.run(take(n, '--by-user'), late)));
    assert.deepEqual(res.map((x) => x.code).sort(), [0, 3, 3], res.map((x) => x.err).join('\n'));
    const s = q.read();
    const winner = ['s0', 's1', 's2'][res.findIndex((x) => x.code === 0)];
    assert.equal(winner, ['s0', 's1', 's2'][res.findIndex((x) => /claim-api op=takeover status=200/.test(x.out))]);
    assert.match(s.commits[s.refs['refs/heads/claim/T14']].message, new RegExp(`machine=${winner} `));
  } finally { q.done(); }
});

test('usage: a bad task id, issue or machine is exit 2; --machine falls back to HARNESS_MACHINE', async () => {
  const r = repo();
  try {
    assert.equal((await r.run(['claim', '--task', '14', '--issue', '39', '--machine', 'a'])).code, 2);
    assert.equal((await r.run(['claim', '--task', 'T14', '--issue', 'x', '--machine', 'a'])).code, 2);
    assert.equal((await r.run(['claim', '--task', 'T14', '--issue', '39', '--machine', 'a b'])).code, 2);
    assert.equal((await r.run(['claim', '--task', 'T14', '--issue', '39'])).code, 2);
    assert.equal((await r.run(['frob', '--task', 'T14', '--issue', '39'])).code, 2);
    const x = await r.run(['claim', '--task', 'T14', '--issue', '39'], { HARNESS_MACHINE: 'box-env' });
    assert.equal(x.code, 0, x.err);
    assert.match(x.out, /machine=box-env /);
  } finally { r.done(); }
});

const hook = (match, run, env = {}) => ({ FAKE_GH_HOOK: JSON.stringify({ match, run: [tool, ...run], env }) });
const hookLog = (r) => fs.readFileSync(`${r.file}.hook.log`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const holderOf = (r) => { const s = r.read(); return /machine=(\S+)/.exec(s.commits[s.refs['refs/heads/claim/T14']]?.message ?? '')?.[1]; };

test('a claimer displaced before its claim comment does not report a win (Sol\'s R1)', async () => {
  const r = repo();
  try {
    const x = await r.run(claimArgs('box-a'), hook('POST issues/39/comments', take('box-u', '--by-user', '--force')));
    assert.equal(hookLog(r)[0].code, 0, hookLog(r)[0].err);
    assert.equal(x.code, 3, x.err);
    assert.match(x.err, /lost/);
    assert.equal(holderOf(r), 'box-u');
  } finally { r.done(); }
});

test('a release after a takeover moved the ref fails and leaves the new holder\'s ref (Sol\'s R2)', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    const x = await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a'], hook('PATCH git/refs/heads/claim/T14', take('box-u', '--by-user', '--force')));
    assert.equal(hookLog(r)[0].code, 0, hookLog(r)[0].err);
    assert.equal(x.code, 3, x.err);
    assert.equal(holderOf(r), 'box-u');
    assert.equal((await status(r)).holder, 'box-u');
  } finally { r.done(); }
});

test('a failed-comment give-back after a takeover leaves the new holder\'s ref (Sol\'s R3)', async () => {
  const r = repo();
  try {
    const x = await r.run(claimArgs('box-a'), { FAKE_GH_FAIL_COMMENT: '1', ...hook('POST issues/39/comments', take('box-u', '--by-user', '--force')) });
    assert.equal(hookLog(r)[0].code, 0, hookLog(r)[0].err);
    assert.equal(x.code, 1, x.err);
    assert.equal(holderOf(r), 'box-u');
    assert.equal((await status(r)).holder, 'box-u');
  } finally { r.done(); }
});

test('takeover counts pushes to the task branch the claim names (Sol\'s R4)', async () => {
  const r = repo({ variables: { HARNESS_PRIMARY: 'box-p' }, branchDates: { 'task/T14-x': [at(23 * 60)] } });
  try {
    await r.run(claimArgs('box-a', '--branch', 'task/T14-x'));
    assert.match(r.read().issueComments[39][0].body, / branch=task\/T14-x$/);
    const x = await r.run(take('box-p'), { HARNESS_NOW: at(25 * 60) });
    assert.equal(x.code, 3, x.err);
    assert.equal(holderOf(r), 'box-a');
    // Past the renewed lease it is stale, and the primary takes it.
    assert.equal((await r.run(take('box-p'), { HARNESS_NOW: at(49 * 60) })).code, 0);
  } finally { r.done(); }
});

test('a renew between a taker\'s stale read and its move beats the taker (Sol\'s R5); late activity revives nothing', async () => {
  const r = repo({ variables: { HARNESS_PRIMARY: 'box-p' } });
  try {
    await r.run(claimArgs('box-a'));
    const late = { HARNESS_NOW: at(25 * 60) };
    const x = await r.run(take('box-p'), { ...late, ...hook('PATCH git/refs/heads/claim/T14', ['renew', '--task', 'T14', '--issue', '39', '--machine', 'box-a'], late) });
    assert.equal(hookLog(r)[0].code, 0, hookLog(r)[0].err);
    assert.equal(x.code, 3, x.err);
    assert.equal(holderOf(r), 'box-a');
    assert.match(r.read().commits[r.read().refs['refs/heads/claim/T14']].message, /^renew T14 machine=box-a /);
  } finally { r.done(); }
  // A comment after the lease ran out does not make it live again.
  const q = repo();
  try {
    await q.run(claimArgs('box-a'));
    const st = q.read(); st.issueComments[39].push({ body: 'late note', created_at: at(25 * 60) }); fs.writeFileSync(q.file, JSON.stringify(st));
    assert.match((await status(q, { HARNESS_NOW: at(26 * 60) })).stale, /lease ran out/);
  } finally { q.done(); }
});

test('one machine racing itself, same second: exactly one claim and one takeover win (Sol\'s R6)', async () => {
  const r = repo();
  try {
    const res = await Promise.all([0, 1, 2, 3].map(() => r.run(claimArgs('box-a'))));
    assert.deepEqual(res.map((x) => x.code).sort(), [0, 3, 3, 3], res.map((x) => x.err).join('\n'));
    const late = { HARNESS_NOW: at(25 * 60), FAKE_GH_SEQ: '3' };
    const t = await Promise.all([0, 1, 2].map(() => r.run(take('box-u', '--by-user'), late)));
    assert.deepEqual(t.map((x) => x.code).sort(), [0, 3, 3], t.map((x) => x.err).join('\n'));
  } finally { r.done(); }
});

test('a claimer whose claim comment lands 5 min late gives the claim back', async () => {
  const r = repo();
  try {
    const x = await r.run(claimArgs('box-a'), { FAKE_GH_COMMENT_DELAY_MIN: '6' });
    assert.equal(x.code, 1, x.err);
    assert.match(x.err, /6 min after the claim/);
    assert.equal((await status(r)).state, 'released');
  } finally { r.done(); }
});

test('of several machines claiming a released task at once, exactly one wins', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a']);
    const res = await Promise.all(['b', 'c', 'd', 'e'].map((n) => r.run(claimArgs(n))));
    assert.deepEqual(res.map((x) => x.code).sort(), [0, 3, 3, 3], res.map((x) => x.err).join('\n'));
    assert.equal(holderOf(r), ['b', 'c', 'd', 'e'][res.findIndex((x) => x.code === 0)]);
  } finally { r.done(); }
});

test('a renewer displaced while renewing does not report success (round 2, R1)', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    const x = await r.run(['renew', '--task', 'T14', '--issue', '39', '--machine', 'box-a'], hook('POST issues/39/comments', take('box-u', '--by-user', '--force')));
    assert.equal(hookLog(r)[0].code, 0, hookLog(r)[0].err);
    assert.equal(x.code, 3, x.err);
    assert.match(x.err, /taken over while renewing/);
    assert.equal(holderOf(r), 'box-u');
  } finally { r.done(); }
});

test('renew refuses a claim whose claim comment is not there yet (round 2, R2)', async () => {
  const r = repo();
  try {
    const x = await r.run(claimArgs('box-a'), { FAKE_GH_FAIL_COMMENT: '1', ...hook('POST issues/39/comments', ['renew', '--task', 'T14', '--issue', '39', '--machine', 'box-a']) });
    assert.equal(hookLog(r)[0].code, 3, hookLog(r)[0].err);
    assert.match(hookLog(r)[0].err, /no claim comment yet/);
    assert.equal(x.code, 1, x.err);
    assert.equal((await status(r)).state, 'released');      // the claimer's give-back went through
  } finally { r.done(); }
});

test('a task branch that cannot be read makes the lease unknown, and no takeover acts on it (round 2, R3)', async () => {
  const r = repo({ variables: { HARNESS_PRIMARY: 'box-p' }, branchDates: { 'task/T14-x': [at(23 * 60)] } });
  try {
    await r.run(claimArgs('box-a', '--branch', 'task/T14-x'));
    const down = { HARNESS_NOW: at(25 * 60), FAKE_GH_FAIL_COMMITS: '1' };
    const s = await status(r, down);
    assert.equal(s.stale, null); assert.match(s.unknown, /could not be read/);
    assert.equal((await r.run(take('box-p'), down)).code, 3);
    assert.equal(holderOf(r), 'box-a');
    // A branch never pushed (GitHub's 404) is no activity, not unknown.
    const n = repo({ variables: { HARNESS_PRIMARY: 'box-p' } });
    try {
      await n.run(claimArgs('box-a', '--branch', 'task/T14-new'));
      assert.equal((await status(n, { HARNESS_NOW: at(25 * 60) })).unknown, undefined);
      assert.equal((await n.run(take('box-p'), { HARNESS_NOW: at(25 * 60) })).code, 0);
    } finally { n.done(); }
  } finally { r.done(); }
});

test('a claim is bound to its issue: naming another issue is refused before anything is written (round 2, R4)', async () => {
  const r = repo({ variables: { HARNESS_PRIMARY: 'box-p' } });
  try {
    await r.run(claimArgs('box-a'));
    const before = r.read();
    const x = await r.run(['takeover', '--task', 'T14', '--issue', '40', '--machine', 'box-p'], { HARNESS_NOW: at(11) });
    assert.equal(x.code, 2, x.err);
    assert.match(x.err, /claim is on issue #39, not #40/);
    assert.equal(x.out, '');
    assert.deepEqual(r.read().refs, before.refs);
    assert.deepEqual(r.read().issueComments, before.issueComments);
  } finally { r.done(); }
});

test('an earlier claim\'s comment never stands in for a later claim in the same second (round 2, R5)', async () => {
  const r = repo({ variables: { HARNESS_PRIMARY: 'box-p' }, branchDates: { 'task/new': [at(23 * 60)] } });
  try {
    assert.equal((await r.run(claimArgs('box-a', '--branch', 'task/old'))).code, 0);
    assert.equal((await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a'])).code, 0);
    assert.equal((await r.run(claimArgs('box-a', '--branch', 'task/new'))).code, 0);
    const s = await status(r, { HARNESS_NOW: at(25 * 60) });
    assert.equal(s.branch, 'task/new'); assert.equal(s.stale, null);
    assert.equal((await r.run(take('box-p'), { HARNESS_NOW: at(25 * 60) })).code, 3);
  } finally { r.done(); }
});

test('a plain comment on the issue extends the lease, and a takeover in the extended lease is refused (round 2, R6)', async () => {
  const r = repo({ variables: { HARNESS_PRIMARY: 'box-p' } });
  try {
    await r.run(claimArgs('box-a'));
    const st = r.read(); st.issueComments[39].push({ body: 'progress note', created_at: at(20 * 60) }); fs.writeFileSync(r.file, JSON.stringify(st));
    const s = await status(r, { HARNESS_NOW: at(25 * 60) });
    assert.equal(s.stale, null); assert.equal(s.expires, at(44 * 60));
    assert.equal((await r.run(take('box-p'), { HARNESS_NOW: at(25 * 60) })).code, 3);
    assert.equal((await r.run(take('box-p'), { HARNESS_NOW: at(45 * 60) })).code, 0);
  } finally { r.done(); }
});
