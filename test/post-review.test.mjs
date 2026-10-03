// post-review.mjs end to end: a Claude reviewer's returned review, posted through the same reader and
// writer as review.mjs, against the fake gh (#3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.resolve(here, '../template/tools/harness/post-review.mjs');
const H = 'T07 review (opus)';
const TASK = '# T07 Thing\n\n- **Done when**:\n  1. `node a.js` prints 1.\n  2. `npm test` is green.\n- **Hazards**: none.\n';

function project(brief = `${H}\nYou review PR #7 at ${'a'.repeat(40)}. The task file follows.\n\n${TASK}`) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-post-')));
  const repo = path.join(base, 'proj');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(here, 'fake-gh.mjs'), path.join(bin, 'gh'));
  const ghState = path.join(base, 'gh.json');
  fs.writeFileSync(ghState, JSON.stringify({ prs: [{ number: 7, head: 'task/T07-x', sha: 'a'.repeat(40), labels: [] }] }));
  fs.writeFileSync(path.join(base, 'brief.md'), brief);
  return { base, repo, ghState };
}
function post(p, review, ...args) {
  fs.writeFileSync(path.join(p.base, 'review.md'), review);
  return spawnSync(process.execPath, [tool, '--pr', '7', '--brief', path.join(p.base, 'brief.md'),
    '--review', path.join(p.base, 'review.md'), '--by', 'claude (opus)', ...args], {
    cwd: p.repo, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(p.base, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: p.ghState },
  });
}
const gh = (p) => ({ comments: [], issueLabels: {}, ...JSON.parse(fs.readFileSync(p.ghState, 'utf8')) });
const posix = { skip: process.platform === 'win32' };
const DW = 'DW1: ran node a.js → 1\nDW2: ran npm test → 9 pass';

test('a readable approve is posted normalised, signed, and labelled', posix, () => {
  const p = project();
  const r = post(p, `I checked it all.\n**${H}**\nApprove.\n\n${DW}\n\nR1: fine (not blocking).\n\napprove\n`, '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = gh(p);
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0].body, `${H}\napprove\n\n${DW}\n\nR1: fine (not blocking).\n\napprove\n\n— claude (opus), via tools/harness/post-review.mjs`);
  assert.deepEqual(s.issueLabels['12'], ['status:approved']);
});

test('a rework is labelled status:rework; closing keywords lose their #', posix, () => {
  const p = project();
  const r = post(p, `${H}\nrework\n\n${DW}\n\nR1: this fixes #12 only in part.\n\nrework\n`, '--issue', '12', '--apply-label');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /rewrote a closing keyword: fixes #12 -> fixes 12/);
  assert.match(gh(p).comments[0].body, /this fixes 12 only in part/);
  assert.deepEqual(gh(p).issueLabels['12'], ['status:rework']);
});

test('a review that may be cut off is posted whole under a note, unlabelled, exit 4', posix, () => {
  const p = project();
  const r = post(p, `Notes first.\n${H}\nrework\n\nR1: the loop in`, '--issue', '12', '--apply-label');
  assert.equal(r.status, 4);
  const body = gh(p).comments[0].body;
  assert.match(body, /^> Note from tools\/harness\/post-review\.mjs: may be cut off; no label applied\./);
  assert.ok(body.includes('\n\nNotes first.\nT07 review (opus)\nrework\n\nR1: the loop in\n\n— claude (opus)'));
  assert.equal(gh(p).issueLabels['12'], undefined);
});

test('an approve that leaves a Done-when line unaccounted is posted, not applied, exit 4 (L32)', posix, () => {
  const p = project();
  const r = post(p, `${H}\napprove\n\nDW1: ran node a.js → 1\n\napprove\n`, '--issue', '12', '--apply-label');
  assert.equal(r.status, 4);
  assert.match(r.stderr, /approve, not applied: no DW line for Done-when 2/);
  assert.equal(gh(p).issueLabels['12'], undefined);
});

test('a file with no review posts nothing and exits 1; a dry run posts nothing and says what it would do', posix, () => {
  const p = project();
  const none = post(p, 'I ran out of time before writing the review.\n');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No review in .*review\.md .*Nothing posted/);
  const dry = post(p, `${H}\napprove\n\n${DW}\n\napprove\n`, '--dry-run', '--issue', '12', '--apply-label');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: would post the above, label status:approved, and exit 0\./);
  assert.equal(gh(p).comments.length, 0);
});

test('usage: the four required options, and a brief whose first line is the header', posix, () => {
  const p = project('Review PR 7.\n');
  assert.equal(post(p, 'x').status, 2);
  const q = project();
  const r = spawnSync(process.execPath, [tool, '--pr', '7'], { cwd: q.repo, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pr, --brief, --review and --by are required/);
});

test('combinePlans: of two reviews, the stricter decides the label (#39)', async () => {
  const { combinePlans } = await import('../template/tools/harness/lib/post.mjs');
  const p = (verdict, label, code = 0, extra = {}) => ({ verdict, label, code, first: `T07 review (${verdict})`, ...extra });
  assert.deepEqual(combinePlans([p('approve', 'status:approved'), p('approve', 'status:approved')]), { label: 'status:approved', code: 0, why: null });
  assert.equal(combinePlans([p('approve', 'status:approved'), p('rework', 'status:rework')]).label, 'status:rework');
  assert.equal(combinePlans([p('approve after named fixes', 'status:rework'), p('approve', 'status:approved')]).label, 'status:rework');
  const ud = combinePlans([p('rework', 'status:rework'), p('user decision', null)]);
  assert.equal(ud.label, null);
  assert.equal(ud.code, 0);
  const held = combinePlans([p('approve', null, 4, { unaccounted: 'Done-when 2 not run' }), p('rework', 'status:rework')]);
  assert.deepEqual([held.label, held.code], [null, 4]);
  assert.match(held.why, /Done-when 2 not run/);
});
