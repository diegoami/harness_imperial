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
    assert.equal(c.message, `claim T14 machine=box-a at=${T0}`);
    assert.equal(c.tree, 'tree0');
    assert.deepEqual(c.parents, ['m0']);
    assert.deepEqual(s.issueComments[39].map((k) => k.body), [`claim T14 machine=box-a at=${T0} lease=24h preflight=gh:ok`]);
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

test('claim: a failed claim comment deletes the ref (no comment, no lease); a label failure keeps the claim', async () => {
  const r = repo();
  try {
    const x = await r.run(claimArgs('box-a'), { FAKE_GH_FAIL_COMMENT: '1' });
    assert.equal(x.code, 1);
    assert.match(x.out, /op=create status=201/);
    assert.match(x.out, /op=delete status=204/);
    assert.equal(r.read().refs['refs/heads/claim/T14'], undefined);
    const y = await r.run(claimArgs('box-a'), { FAKE_GH_FAIL_LABELS: '1' });
    assert.equal(y.code, 0, y.err);
    assert.match(y.err, /label error/);
    assert.ok(r.read().refs['refs/heads/claim/T14']);
  } finally { r.done(); }
});

const status = async (r, env, ...more) => JSON.parse((await r.run(['status', '--task', 'T14', '--issue', '39', '--json', ...more], env)).out);

test('status: free, held under lease, renewed by a comment or a push, stale when the lease expires', async () => {
  const r = repo({ branchDates: { 'task/T14-x': at(30 * 60) } });
  try {
    assert.deepEqual(await status(r), { held: false });
    await r.run(claimArgs('box-a'));
    let s = await status(r, { HARNESS_NOW: at(60) });
    assert.equal(s.holder, 'box-a'); assert.equal(s.stale, null); assert.equal(s.expires, at(24 * 60));
    s = await status(r, { HARNESS_NOW: at(24 * 60) });
    assert.match(s.stale, /lease expired/);
    // A comment at +20h renews to +44h.
    await r.run(['renew', '--task', 'T14', '--issue', '39', '--machine', 'box-a'], { HARNESS_NOW: at(20 * 60) });
    s = await status(r, { HARNESS_NOW: at(24 * 60) });
    assert.equal(s.stale, null); assert.equal(s.expires, at(44 * 60));
    // A push to the task branch (head commit at +30h) renews to +54h.
    s = await status(r, { HARNESS_NOW: at(50 * 60) }, '--branch', 'task/T14-x');
    assert.equal(s.stale, null); assert.equal(s.expires, at(54 * 60));
    s = await status(r, { HARNESS_NOW: at(50 * 60) });
    assert.match(s.stale, /lease expired/);
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

test('release: only the holder; comment, machine label off, ref deleted; --merged keeps the label', async () => {
  const r = repo();
  try {
    await r.run(claimArgs('box-a'));
    const no = await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-b']);
    assert.equal(no.code, 3);
    assert.ok(r.read().refs['refs/heads/claim/T14']);
    const x = await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a', '--reason', 'escalated']);
    assert.equal(x.code, 0, x.err);
    assert.match(x.out, /^claim-api op=delete status=204 /);
    const s = r.read();
    assert.equal(s.refs['refs/heads/claim/T14'], undefined);
    assert.ok(!s.issueLabels[39].includes('machine:box-a'));
    assert.match(s.issueComments[39].at(-1).body, /^release T14 machine=box-a at=\S+ reason=escalated$/);
    await r.run(claimArgs('box-a'));
    assert.equal((await r.run(['release', '--task', 'T14', '--issue', '39', '--machine', 'box-a', '--merged'])).code, 0);
    assert.ok(r.read().issueLabels[39].includes('machine:box-a'));
    assert.match(r.read().issueComments[39].at(-1).body, /reason=merged$/);
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
    assert.match(bodies.at(-1), /^claim T14 machine=box-p at=\S+ lease=24h preflight=gh:ok$/);
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
