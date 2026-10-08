// rejections.mjs (L66): the runs' permission rejections, grouped and classified for triage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRejections, classify, summarize } from '../template/tools/harness/lib/rejections.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.resolve(here, '../template/tools/harness/rejections.mjs');
const ctx = { mainRoot: '/home/u/projects/game', home: '/home/u', repo: 'game' };
const ed = (p) => `external_directory (${p})`;

test('classify: allow the run folder, the null device and the project\'s own data; fix the brief for scratch and the main checkout; the rest is the user\'s', () => {
  const act = (p, titles = []) => classify(ed(p), ctx, titles).action;
  assert.equal(act('/tmp/harness-run-T07-glm-ab12/*', ['T07-glm-ab12']), 'allow');
  assert.equal(act('C:\\Users\\u\\AppData\\Local\\Temp\\harness-run-x\\*', ['x']), 'allow');
  // Sol's R2-R4 on PR 137: another run's folder, look-alikes and `..` are never "allow".
  assert.equal(act('/tmp/harness-run-other-session/*', ['T07-glm-ab12']), 'brief');
  assert.equal(act('/tmp/harness-run-x/*'), 'brief');                                   // no run named
  assert.equal(act('/home/u/projects/other/harness-run-x/*', ['x']), 'owner');
  assert.equal(act('/home/u/projects/other/dev/null/*'), 'owner');
  assert.equal(act('/home/u/.config/game/../../other/*'), 'owner');
  assert.equal(act('/dev/null'), 'allow');
  assert.equal(act('/dev/*'), 'allow');
  assert.equal(act('\\\\.\\NUL\\*'), 'allow');
  assert.equal(act('/home/u/.local/share/game/static/*'), 'allow');
  assert.equal(act('/tmp/*'), 'brief');
  assert.equal(act('/tmp/t44/*'), 'brief');
  assert.equal(act('C:\\Users\\u\\AppData\\Local\\Temp\\*'), 'brief');
  assert.equal(act('/home/u/projects/game/.git/info/*'), 'brief');
  assert.equal(act('/home/u/projects/game/*'), 'brief');
  assert.equal(act('/home/u/projects/other-repo/*'), 'owner');
  assert.equal(act('/home/u/.local/share/other/*'), 'owner');
  assert.equal(act('/home/u/*'), 'owner');
  assert.equal(act('/etc/*'), 'owner');
  assert.equal(act('/home/u/projects/game-work/T07/*'), 'owner');   // a sibling, not the main checkout
  assert.equal(classify('a tool call (in the session record)', ctx).action, 'owner');
});

test('summarize groups by permission, most frequent first, with up to three distinct calls; readRejections skips bad lines', () => {
  const line = (at, p, input) => JSON.stringify({ at, title: 'T1-a', permission: ed(p), calls: [{ tool: 'bash', input }] });
  const text = [line('2026-10-07T10:00:00Z', '/tmp/*', 'rm /tmp/a'), 'not json', '{"at":3}', '',
    line('2026-10-08T10:00:00Z', '/tmp/*', 'cp x /tmp/b'), line('2026-10-08T11:00:00Z', '/tmp/*', 'rm /tmp/a'),
    line('2026-10-08T09:00:00Z', '/tmp/*', 'ls /tmp/c'), line('2026-10-08T08:00:00Z', '/tmp/*', 'cat /tmp/d'),
    line('2026-10-06T09:00:00Z', '/dev/*', 'cp x /dev/null')].join('\n');
  const entries = readRejections(text);
  assert.equal(entries.length, 6);
  const g = summarize(entries, ctx);
  assert.deepEqual(g.map((x) => [x.permission, x.count, x.action]), [[ed('/tmp/*'), 5, 'brief'], [ed('/dev/*'), 1, 'allow']]);
  assert.equal(g[0].last, '2026-10-08T11:00:00Z');
  assert.deepEqual(g[0].samples, ['bash: rm /tmp/a', 'bash: cp x /tmp/b', 'bash: ls /tmp/c']);   // three at most, distinct
  assert.deepEqual(g[0].titles, ['T1-a']);
  // The run's own folder is "allow" only for the run that asked.
  const own = summarize(readRejections(JSON.stringify({ at: 'x', title: 'T9-q', permission: ed('/tmp/harness-run-T9-q/*'), calls: [] })), ctx);
  assert.equal(own[0].action, 'allow');
});

test('the CLI reads <workRoot>/permission-rejections.jsonl, filters by --since, and says when there is nothing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rej-'));
  const repo = path.join(base, 'game');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'harness.json'), JSON.stringify({ models: {} }));
  const run = (...args) => spawnSync(process.execPath, [tool, ...args], { cwd: repo, encoding: 'utf8' });
  try {
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No rejections since/);
    fs.mkdirSync(path.join(base, 'game-work'));
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(base, 'game-work', 'permission-rejections.jsonl'), [
      JSON.stringify({ at: now, permission: ed('/tmp/*'), calls: [{ tool: 'bash', input: 'rm /tmp/x' }] }),
      JSON.stringify({ at: '2020-01-01T00:00:00Z', permission: ed('/dev/*'), calls: [] }),
    ].join('\n'));
    r = run('--since', '7d');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 rejection since/);
    assert.match(r.stdout, /1× external_directory \(\/tmp\/\*\) — last .* — brief: scratch outside/);
    assert.match(r.stdout, /bash: rm \/tmp\/x/);
    assert.doesNotMatch(r.stdout, /\/dev/);
    const j = JSON.parse(run('--json', '--since', '400w').stdout);
    assert.deepEqual(j.groups.map((x) => x.action), ['brief', 'allow']);
    assert.equal(run('--since', 'soon').status, 2);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
