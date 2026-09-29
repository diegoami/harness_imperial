// Jev: the decision math, the client against a local fake of the endpoint, and the CLI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  trial, route, parseAnswer, askAll, httpPost, inTuningHalf, questionFor,
} from '../template/tools/harness/lib/jev.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../template');

// A fake /v1/systemone: answers state.p for the one question asked; state.fail429 fails that many
// times first; state.bad returns an out-of-range probability.
const calls = [];
const failures = new Map();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const b = JSON.parse(body);
    calls.push({ auth: req.headers.authorization, body: b });
    const [name] = Object.keys(b.questions);
    const key = JSON.stringify(b.state);
    const left = failures.get(key) ?? b.state.fail429 ?? 0;
    if (left > 0) { failures.set(key, left - 1); res.writeHead(429); res.end('slow down'); return; }
    if (b.state.status) { res.writeHead(b.state.status); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: b.model, answers: { [name]: { noul: b.state.bad ? 1.5 : b.state.p } }, usage: { input_tokens: 10, cost: 0.0001 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('route is a three-way split, and an end without a cutoff stays with Claude', () => {
  const t = { autoYesAt: 0.9, autoNoBelow: 0.1 };
  assert.equal(route(0.95, t), 'yes');
  assert.equal(route(0.9, t), 'yes');
  assert.equal(route(0.5, t), 'middle');
  assert.equal(route(0.05, t), 'no');
  assert.equal(route(0.05, { autoYesAt: 0.9 }), 'middle');
});

test('a missing answer or a probability outside [0, 1] is refused, never read as a no', () => {
  assert.throws(() => parseAnswer({ answers: {} }, 'q', 'noul'), /no answer/);
  assert.throws(() => parseAnswer({ answers: { q: { noul: 1.5 } } }, 'q', 'noul'), /not a probability/);
  assert.equal(parseAnswer({ answers: { q: { noul: 0.3 } } }, 'q', 'noul').p, 0.3);
  assert.deepEqual(parseAnswer({ answers: { q: { choice: 'b' } } }, 'q', 'choice').raw, { choice: 'b' });
});

test('the question carries the type and extra fields, never the cutoffs or the trial record', () => {
  const q = questionFor({ type: 'choice', options: ['a', 'b'], autoYesAt: 0.9, trial: {}, instructionsFile: 'x' }, 'pick');
  assert.deepEqual(q, { type: 'choice', instructions: 'pick', options: ['a', 'b'] });
});

// Synthetic labels: positives near 1, negatives near 0, and an ambiguous middle.
function labels(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = i % 10;
    const p = r < 4 ? 0.97 : r < 8 ? 0.03 : 0.5;
    out.push({ id: `i${i}`, p, label: r < 4 ? true : r < 8 ? false : i % 2 === 0 });
  }
  return out;
}

test('the trial picks the cutoffs on one half and reports them on the other', () => {
  const t = trial(labels(200), { targetPrecision: 0.95 });
  assert.equal(t.autoYesAt, 0.6);
  assert.equal(t.autoNoBelow, 0.3);
  assert.equal(t.heldOut.yes.precision, 1);
  assert.equal(t.heldOut.no.precision, 1);
  assert.ok(t.heldOut.coverage > 0.7 && t.heldOut.coverage < 0.9);
  assert.deepEqual(t.warnings, []);
  assert.equal(t.tuning.n + t.heldOut.n, 200);
});

test('an end that never reaches the target stays with Claude, and few labels are flagged', () => {
  const noisy = labels(20).map((x, i) => ({ ...x, label: i % 3 === 0 }));
  const t = trial(noisy, { targetPrecision: 0.95 });
  assert.equal(t.autoYesAt, null);
  assert.ok(t.warnings.some((w) => /too few to trust/.test(w)));
});

test('the split is fixed per id', () => {
  assert.equal(inTuningHalf('abc'), inTuningHalf('abc'));
  const share = labels(400).filter((x) => inTuningHalf(x.id)).length / 400;
  assert.ok(share > 0.4 && share < 0.6);
});

test('the client sends the key, retries a 429, and caches so a rerun is free', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cache-'));
  const post = httpPost({ baseUrl, apiKey: 'k1', backoffMs: 5 });
  const items = [{ id: 'a', state: { p: 0.9, fail429: 2 } }, { id: 'b', state: { p: 0.2 } }];
  const q = { type: 'noul', instructions: 'same?' };
  const before = calls.length;
  const r1 = await askAll({ items, name: 'q', question: q, model: 'jev-1.13', post, cacheDir });
  assert.equal(r1.error, null);
  assert.deepEqual(r1.answers.map((x) => x.p), [0.9, 0.2]);
  assert.equal(calls.length - before, 4); // two 429s, then two answers
  assert.equal(calls.at(-1).auth, 'Bearer k1');
  assert.equal(calls.at(-1).body.model, 'jev-1.13');
  const r2 = await askAll({ items, name: 'q', question: q, model: 'jev-1.13', post, cacheDir });
  assert.equal(calls.length - before, 4); // nothing new asked
  assert.ok(r2.answers.every((x) => x.cached));
  assert.equal(r2.cost, 0);
});

test('a provider failure keeps the answers so far and stops; a bad answer is not cached', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cache-'));
  const post = httpPost({ baseUrl, apiKey: 'k', backoffMs: 5, retries: 1 });
  const q = { type: 'noul', instructions: 'x' };
  const r = await askAll({ items: [{ id: 'a', state: { p: 0.4 } }, { id: 'b', state: { status: 400 } }, { id: 'c', state: { p: 0.1 } }], name: 'q', question: q, model: 'm', post, cacheDir });
  assert.deepEqual(r.answers.map((x) => x.id), ['a']);
  assert.match(r.error, /^b: HTTP 400/);
  const bad = await askAll({ items: [{ id: 'z', state: { bad: true } }], name: 'q', question: q, model: 'm', post, cacheDir });
  assert.match(bad.error, /not a probability/);
  assert.equal(fs.readdirSync(cacheDir).length, 1); // only a's answer
});

// The CLI, in a throwaway git repository with a harness.json pointing at the fake endpoint.
function project(decision) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cli-')));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(path.join(proj, 'docs', 'jev'), { recursive: true });
  execFileSync('git', ['init', '-q', proj]);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8'));
  config.jev = { ...config.jev, baseUrl, apiKeyEnv: 'TEST_JEV_KEY', decisions: { 'breaks-play': { type: 'noul', instructionsFile: 'docs/jev/breaks-play.md', ...decision } } };
  fs.writeFileSync(path.join(proj, 'harness.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(proj, 'docs/jev/breaks-play.md'), 'Does this issue break play?\n');
  return { base, proj };
}
// Async, not spawnSync: the fake endpoint lives in this process and must keep answering.
const cli = (p, env, ...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'tools/harness/jev.mjs'), ...args], {
    cwd: p.proj, env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('without the key Jev is off: exit 3, and the main session decides', async () => {
  const p = project({});
  fs.writeFileSync(path.join(p.base, 'in.jsonl'), '{"id":1,"state":{"p":0.5}}\n');
  const r = await cli(p, { TEST_JEV_KEY: '' }, 'ask', '--decision', 'breaks-play', '--in', path.join(p.base, 'in.jsonl'));
  assert.equal(r.status, 3);
  assert.match(r.stderr, /TEST_JEV_KEY is not set/);
});

test('an untrialled decision cannot be routed', async () => {
  const p = project({});
  fs.writeFileSync(path.join(p.base, 'in.jsonl'), '{"id":1,"state":{"p":0.5}}\n');
  const r = await cli(p, { TEST_JEV_KEY: 'k' }, 'route', '--decision', 'breaks-play', '--in', path.join(p.base, 'in.jsonl'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run "jev.mjs trial" first/);
});

test('trial, then route with the recorded cutoffs, end to end', async () => {
  const p = project({});
  const lab = labels(120).map((x) => JSON.stringify({ id: x.id, state: { p: x.p }, label: x.label })).join('\n');
  fs.writeFileSync(path.join(p.base, 'labels.jsonl'), lab);
  const t = await cli(p, { TEST_JEV_KEY: 'k' }, 'trial', '--decision', 'breaks-play', '--in', path.join(p.base, 'labels.jsonl'));
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /breaks-play: yes at >= 0\.6 .* no below 0\.3/);

  const q = project({ autoYesAt: 0.9, autoNoBelow: 0.1 });
  fs.writeFileSync(path.join(q.base, 'in.jsonl'), ['{"id":1,"state":{"p":0.95}}', '{"id":2,"state":{"p":0.5}}', '{"id":3,"state":{"p":0.02}}'].join('\n'));
  const out = path.join(q.base, 'routed.jsonl');
  const r = await cli(q, { TEST_JEV_KEY: 'k' }, 'route', '--decision', 'breaks-play', '--in', path.join(q.base, 'in.jsonl'), '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 yes, 1 no, 1 for the main session, of 3/);
  assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l).route), ['yes', 'middle', 'no']);
});
