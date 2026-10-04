// The rule files' own limits and references: CLAUDE.md's 40 lines and process.md's 150 (this
// repository's CLAUDE.md), every lesson they cite exists, and L38 sits where it is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
const lines = (rel) => read(rel).trimEnd().split('\n').length;
const RULES = ['template/CLAUDE.md', 'template/docs/process.md', 'template/.claude/skills/run-task/SKILL.md',
  'profiles/review/CLAUDE.md', 'profiles/review/docs/review.md'];

test('template/CLAUDE.md keeps to 40 lines and process.md to 150', () => {
  assert.ok(lines('template/CLAUDE.md') <= 40, `template/CLAUDE.md has ${lines('template/CLAUDE.md')} lines`);
  assert.ok(lines('template/docs/process.md') <= 150, `process.md has ${lines('template/docs/process.md')} lines`);
  assert.ok(lines('profiles/review/CLAUDE.md') <= 40);
});

test('every lesson a rule file cites is in template/docs/lessons.md', () => {
  const known = new Set([...read('template/docs/lessons.md').matchAll(/^\| (L\d+) \|/gm)].map((m) => m[1]));
  for (const f of RULES) for (const [l] of read(f).matchAll(/\bL\d+\b/g)) assert.ok(known.has(l), `${f} cites ${l}, which lessons.md lacks`);
});

test('a heavy review moves the implementer up, in both profiles (L38)', () => {
  assert.match(read('template/CLAUDE.md'), /After a heavy\n {3}review, the next round's implementer moves one step up, never down/);
  const step = read('template/.claude/skills/run-task/SKILL.md');
  assert.match(step, /three or more blocking\n\s+findings, or when it brings new blocking findings of a class the previous round raised:\n\s+the same kind of defect again, in new or unchanged code/);
  // Decided before the round that returns to step 1 (Sol's R1 on PR 44).
  assert.ok(step.indexOf('A heavy review moves the implementer up') < step.indexOf('Set the next round and return to step 1'));
  assert.match(step, /the class and the finding ids of\n\s+both rounds/);
  assert.match(step, /a light OpenCode model → a\s+heavy one → a Claude Opus agent/);
  assert.match(step, /The round count does not reset/);
  assert.match(step, /to weigh, never to apply blindly/);
  assert.match(read('profiles/review/CLAUDE.md'), /there is no stronger implementer than Opus/);
  // At the top, every place says the same: fix the class, and change the approach when the class needs it (Sol's R2 on PR 44).
  for (const f of ['profiles/review/CLAUDE.md', 'profiles/review/docs/review.md', 'docs/models.md', 'template/docs/lessons.md', 'template/.claude/skills/run-task/SKILL.md']) {
    assert.match(read(f).replace(/\s+/g, ' '), /changes? the approach when the class needs it/, f);
    assert.doesNotMatch(read(f).replace(/\s+/g, ' '), /, or changes? the approach/, f);
  }
});

test('Sol runs at low or medium effort, never high, and only by --sol: the hard chain starts with GLM-5.3 (L39, L41)', () => {
  const c = JSON.parse(read('template/harness.json'));
  for (const m of ['sol', 'sol-6.1']) assert.ok(['low', 'medium'].includes(c.models[m].variant), `${m} at ${c.models[m].variant}`);
  assert.deepEqual(c.reviewer.hard, ['glm', 'deepseek-pro', 'luna']);
  assert.equal(c.reviewer.sol, 'sol-6.1');
});

test('measurements are committed and pushed as made, never deleted, in every brief that measures (L40)', () => {
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  const line = /If you measure: every output a finding or the PR may cite goes under a tracked path the task owns, pushed per batch and every 30 min, never deleted or overwritten; originals out, hashes recorded\. \(L40\)/;
  assert.match(flat('template/docs/process.md'), line);                     // §4, the brief every task gets
  assert.match(flat('template/.claude/agents/implementer.md'), line);
  assert.match(flat('template/CLAUDE.md'), /\[research repo, or any task that measures\] Commit and push without asking\. Measurements go to a tracked path the task owns, per batch and every 30 min, never deleted or overwritten; originals out, hashed\. \(L40\)/);
  assert.match(flat('template/CLAUDE.md'), /a `\[designed\]` value says what search came up empty/);
  assert.match(flat('template/docs/tasks/TEMPLATE.md'), /A task that measures owns a tracked path for its outputs/);
});

test('the default implementer is GLM-5.3 Flash, then DeepSeek V4.1 Flash, then Sonnet; GLM-5.3 Flash stays on watch (L42)', () => {
  const c = JSON.parse(read('template/harness.json'));
  assert.deepEqual(c.implementer.chain, ['glm-flash', 'deepseek-flash']);
  assert.equal(c.implementer.claudeFallback, 'sonnet');
  assert.equal(c.models['glm-flash'].id, 'zai-coding-plan/glm-5.3-flash');
  assert.ok(c.models['glm-flash'].watch, 'glm-flash keeps its watch note');
  for (const f of ['template/docs/process.md', 'template/docs/tasks/TEMPLATE.md', 'README.md']) {
    assert.match(read(f).replace(/\s+/g, ' '), /GLM-5\.3 Flash|`glm-flash`, then `deepseek-flash`/, f);
  }
});
