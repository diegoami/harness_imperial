#!/usr/bin/env node
// What OpenCode's permission guard rejected in this project's runs, and what to do about each (L66).
// implement.mjs and review.mjs append every rejection to <workRoot>/permission-rejections.jsonl
// (lib/opencode.mjs); this groups them by the permission OpenCode asked for, newest first, with the
// rejected commands and a suggested action. The main session reads it at triage and acts:
//   allow      the project's own data or a harmless system path: add the pattern to the
//              external_directory block of .opencode/agents/*.md, in a reviewed PR;
//   brief      scratch outside the run's folder, or a path into the main checkout: the brief or the
//              agent was wrong (L31, L36, L57, L66); fix the brief template, allow nothing;
//   owner      anything else (another repository, the home directory): the user decides.
//
//   node tools/harness/rejections.mjs [--since 7d] [--json]
//
// Exit 0: listed (also when there is nothing). Exit 2: usage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, loadConfig, repoPaths } from './lib/common.mjs';
import { readRejections, summarize } from './lib/rejections.mjs';

const die = (code, s) => { console.error(s); process.exit(code); };
let a;
try { a = parseArgs(process.argv.slice(2), { flags: ['json'] }); } catch (e) { die(2, e.message); }
const units = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
const m = /^(\d+)([mhdw])$/.exec(a.since ?? '30d');
if (!m) die(2, `--since takes <n>m|h|d|w; got ${a.since}`);
const since = Date.now() - Number(m[1]) * units[m[2]];

const config = loadConfig(repoPaths({}).top);
const { mainRoot, workRoot } = repoPaths(config);
const file = path.join(workRoot, 'permission-rejections.jsonl');
const entries = readRejections(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').filter((e) => Date.parse(e.at) >= since);
const groups = summarize(entries, { mainRoot, home: os.homedir(), repo: path.basename(mainRoot) });

if (a.json) {
  console.log(JSON.stringify({ file, groups }, null, 2));
} else if (!groups.length) {
  console.log(`No rejections since ${new Date(since).toISOString().slice(0, 10)} (${file}).`);
} else {
  console.log(`${entries.length} rejection${entries.length === 1 ? '' : 's'} since ${new Date(since).toISOString().slice(0, 10)} (${file}):`);
  for (const g of groups) {
    console.log(`\n${g.count}× ${g.permission} — last ${g.last.slice(0, 16)} — ${g.action}: ${g.why}`);
    for (const c of g.samples) console.log(`   ${c}`);
  }
}
