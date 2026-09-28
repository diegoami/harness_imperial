#!/usr/bin/env node
// A stand-in for `gh`: only what implement.mjs and review.mjs call.
// FAKE_GH_STATE holds { prs: [{ number, head, url, sha, labels }], comments: [], issueLabels: {} }.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh fake'); process.exit(0); }
const file = process.env.FAKE_GH_STATE;
const state = { comments: [], issueLabels: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const jq = opt('--jq');
const [noun, verb, id] = args;
if (noun === 'pr' && verb === 'list') {
  const pr = state.prs.find((p) => p.head === opt('--head'));
  if (pr && jq === '.[0].number') console.log(pr.number);
  if (pr && jq === '.[0].url') console.log(pr.url);
} else if (noun === 'pr' && verb === 'view') {
  const pr = state.prs.find((p) => String(p.number) === id);
  if (!pr) process.exit(1);
  if (jq === '.headRefOid') console.log(pr.sha);
  if (jq === '.labels[].name') for (const l of pr.labels ?? []) console.log(l);
} else if (noun === 'issue' && verb === 'view') {
  for (const l of state.issueLabels[id] ?? []) console.log(l);
} else if (noun === 'pr' && verb === 'comment') {
  state.comments.push({ pr: id, body: fs.readFileSync(opt('--body-file'), 'utf8') });
  save();
} else if (noun === 'issue' && verb === 'edit') {
  state.issueLabels[id] = [...(state.issueLabels[id] ?? []).filter((l) => l !== opt('--remove-label')), opt('--add-label')];
  save();
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(1);
}
