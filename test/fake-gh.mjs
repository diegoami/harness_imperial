#!/usr/bin/env node
// A stand-in for `gh`: only what implement.mjs, review.mjs and post-review.mjs call.
// FAKE_GH_STATE holds { prs: [{ number, head, url, sha, labels }], comments: [], issueLabels: {} },
// and for claim.mjs the git data { refs: { name: sha }, commits: { sha: { message, tree, parents,
// date } } }, issueComments: { issue: [{ body, created_at }] } and variables: {}.
// Every call holds a lock across its read-modify-write, so parallel calls see the ref create as
// GitHub serves it: compare-and-set, one 201 (the claim race test).
import fs from 'node:fs';
import crypto from 'node:crypto';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh fake'); process.exit(0); }
const file = process.env.FAKE_GH_STATE;
const lock = `${file}.lock`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const acquire = () => {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); return; } catch (e) { if (e.code !== 'EEXIST' || i > 4000) throw e; sleep(5); }
  }
};
const unlock = () => { try { fs.rmdirSync(lock); } catch { /* gone */ } };
acquire();
process.on('exit', unlock);
let state = { comments: [], issueLabels: {}, refs: {}, commits: {}, issueComments: {}, variables: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const nowIso = () => (process.env.HARNESS_NOW ? new Date(process.env.HARNESS_NOW) : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
} else if (noun === 'api') {
  api();
} else if (noun === 'label' && verb === 'create') {
  state.labelsCreated = [...(state.labelsCreated ?? []), id];
  save();
} else if (noun === 'variable' && verb === 'get') {
  if (state.variables[id] === undefined) { console.error(`variable ${id} was not found`); process.exit(1); }
  console.log(state.variables[id]);
} else if (noun === 'issue' && verb === 'comment') {
  if (process.env.FAKE_GH_FAIL_COMMENT) { console.error('fake gh: comment failed (FAKE_GH_FAIL_COMMENT)'); process.exit(1); }
  (state.issueComments[id] ??= []).push({ body: opt('--body'), created_at: nowIso() });
  if (process.env.FAKE_GH_SEQ && /^claim /.test(opt('--body')) && state.seq?.started.includes(process.ppid)) state.seq.turn++;
  save();
} else if (noun === 'issue' && verb === 'view') {
  for (const l of state.issueLabels[id] ?? []) console.log(l);
} else if (noun === 'pr' && verb === 'comment') {
  state.comments.push({ pr: id, body: fs.readFileSync(opt('--body-file'), 'utf8') });
  save();
} else if (noun === 'issue' && verb === 'edit') {
  // FAKE_GH_FAIL_LABELS simulates a repository that does not have status:* labels (the #108
  // case): every label edit fails with a 1, the way `gh` does on an unknown label. The harness's
  // applyLabel must catch it and warn, not exit 1 as if nothing was posted.
  if (process.env.FAKE_GH_FAIL_LABELS) {
    console.error(`fake gh: ${args.join(' ')} failed (1): label not found (FAKE_GH_FAIL_LABELS)`);
    process.exit(1);
  }
  const removed = (opt('--remove-label') ?? '').split(',');
  const added = opt('--add-label') ? opt('--add-label').split(',') : [];
  state.issueLabels[id] = [...(state.issueLabels[id] ?? []).filter((l) => !removed.includes(l) && !added.includes(l)), ...added];
  save();
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(1);
}

// The REST calls claim.mjs makes, with --include's status line and GitHub's 422 messages.
function api() {
  const method = opt('--method') ?? 'GET';
  const route = args.find((a, i) => i > 0 && !a.startsWith('-') && !['--method', '--jq', '-f', '-F'].includes(args[i - 1]));
  const fields = {};
  args.forEach((a, i) => {
    if ((a === '-f' || a === '-F') && args[i + 1]) {
      const [k, ...v] = args[i + 1].split('='); const val = v.join('=');
      if (k.endsWith('[]')) (fields[k.slice(0, -2)] ??= []).push(val); else fields[k] = a === '-F' && (val === 'true' || val === 'false') ? val === 'true' : val;
    }
  });
  const reply = (status, body) => {
    if (process.env.FAKE_GH_SEQ && status === 422 && state.seq?.started.includes(process.ppid)) { state.seq.turn++; save(); }
    if (args.includes('--include')) console.log(`HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n`);
    console.log(JSON.stringify(body));
    if (status >= 400) { console.error(`gh: ${body.message} (HTTP ${status})`); process.exit(1); }
    process.exit(0);
  };
  const r = route.replace(/^repos\/\{owner\}\/\{repo\}\//, '');
  let m;
  // FAKE_GH_SEQ=N (the takeover race): N callers (claim.mjs processes, told apart by ppid) all read
  // the claim ref first, then write to it one at a time in the order they read, each finishing (a
  // claim comment or a 422) before the next starts. So every later taker acts on a stale view: the
  // case where a delete and re-create would let it delete the first taker's new ref.
  const claimRef = /^git\/ref\/heads\/claim\//.test(r) || /^git\/refs\/heads\/claim\//.test(r) || (r === 'git/refs' && /^refs\/heads\/claim\//.test(fields.ref ?? ''));
  if (process.env.FAKE_GH_SEQ && claimRef) {
    const seq = (state.seq ??= { readers: [], turn: 0, started: [] });
    const me = process.ppid;
    if (method === 'GET') { if (!seq.readers.includes(me)) seq.readers.push(me); save(); }
    else if (!seq.started.includes(me)) {
      for (let i = 0; ; i++) {
        const q = state.seq;
        if (q.readers.length >= Number(process.env.FAKE_GH_SEQ) && q.readers[q.turn] === me) break;
        if (i > 2000) { console.error('fake gh: FAKE_GH_SEQ never got its turn'); process.exit(1); }
        unlock(); sleep(10); acquire();
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      state.seq.started.push(me); save();
    }
  }
  if (r === 'git/commits' && method === 'POST') {
    const sha = crypto.createHash('sha1').update(JSON.stringify([fields, Math.random()])).digest('hex');
    state.commits[sha] = { message: fields.message, tree: fields.tree, parents: fields.parents ?? [], date: nowIso() };
    save(); return reply(201, { sha });
  }
  if ((m = /^git\/commits\/([0-9a-z]+)$/.exec(r))) {
    const c = state.commits[m[1]];
    return c ? reply(200, { sha: m[1], message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : reply(404, { message: 'Not Found' });
  }
  if ((m = /^git\/ref\/(.+)$/.exec(r)) && method === 'GET') {
    const sha = state.refs[`refs/${m[1]}`];
    return sha ? reply(200, { ref: `refs/${m[1]}`, object: { sha } }) : reply(404, { message: 'Not Found' });
  }
  if (r === 'git/refs' && method === 'POST') {
    if (process.env.FAKE_GH_REF_422) return reply(422, { message: process.env.FAKE_GH_REF_422 });
    if (state.refs[fields.ref]) return reply(422, { message: 'Reference already exists' });
    if (!state.commits[fields.sha]) return reply(422, { message: 'Object does not exist' });
    state.refs[fields.ref] = fields.sha; save();
    return reply(201, { ref: fields.ref, object: { sha: fields.sha } });
  }
  if ((m = /^git\/refs\/(.+)$/.exec(r))) {
    const name = `refs/${m[1]}`;
    if (!state.refs[name]) return reply(422, { message: 'Reference does not exist' });
    if (method === 'DELETE') { delete state.refs[name]; save(); return reply(204, {}); }
    if (method === 'PATCH') {
      const ancestors = new Set(); const walk = (s) => { if (!s || ancestors.has(s)) return; ancestors.add(s); for (const p of state.commits[s]?.parents ?? []) walk(p); };
      walk(fields.sha);
      if (fields.force !== true && !ancestors.has(state.refs[name])) return reply(422, { message: 'Update is not a fast forward' });
      state.refs[name] = fields.sha; save(); return reply(200, { ref: name, object: { sha: fields.sha } });
    }
  }
  if ((m = /^issues\/(\d+)\/comments$/.exec(r))) {
    for (const c of state.issueComments[m[1]] ?? []) console.log(JSON.stringify(c));
    process.exit(0);
  }
  if ((m = /^commits\/(.+)$/.exec(r))) {
    const date = state.branchDates?.[decodeURIComponent(m[1])];
    return date ? reply(200, { commit: { committer: { date } } }) : reply(404, { message: 'Not Found' });
  }
  reply(404, { message: `fake gh: no route ${method} ${route}` });
}
