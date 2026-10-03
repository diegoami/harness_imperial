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
