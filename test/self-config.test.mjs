// harness_imperial reviews its own PRs with its own tools (review.mjs, run from the root). Those
// read harness.json and .opencode/agents/ at the repository's root, which are copies of the
// template's: copies, not symlinks, so a Windows checkout gets real files. This keeps them equal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const same = (rel) => assert.equal(
  fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n'),
  fs.readFileSync(path.join(repo, 'template', rel), 'utf8').replace(/\r\n/g, '\n'),
  `${rel} at the root differs from template/${rel}: copy the template's over it`,
);

for (const rel of ['harness.json', '.opencode/agents/reviewer.md', '.opencode/agents/implementer.md']) {
  test(`the root ${rel} is the template's`, () => same(rel));
}

// The agents' working rules that came from real failures stay in both agent files.
const body = (rel) => fs.readFileSync(path.join(repo, 'template', rel), 'utf8').split(/^---$/m).slice(2).join('').replace(/\s+/g, ' ');
for (const agent of ['implementer', 'reviewer']) {
  test(`the ${agent} runs commands from the worktree root, never with cd or .. (L31)`, () => {
    const text = body(`.opencode/agents/${agent}.md`);
    assert.match(text, /Run every shell command from the worktree root with paths relative to it/);
    assert.match(text, /Never `cd`, and never write `\.\.` in a command/);
  });
}
