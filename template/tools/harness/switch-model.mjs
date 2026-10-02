#!/usr/bin/env node
// Switches the implementer's or the reviewer's OpenCode model in harness.json, with the checks a
// hand edit skips. The /switch-model skill says when and how.
//
//   node tools/harness/switch-model.mjs --show
//   node tools/harness/switch-model.mjs --role implementer|reviewer --model PROVIDER/ID
//     [--variant high] [--name NAME] [--family FAMILY] [--fallback sonnet|opus]
//     [--probe] [--dry-run] [--force]
//
// 1. OpenCode must list the id in the scripts' own data directory (as implement.mjs and review.mjs
//    check before every run): an unknown id or a missing login exits 3 with the command that fixes
//    it.
// 2. The variant is high unless given; max is refused (L27). The family comes from the id unless
//    given, and a model of the other role's family is refused unless --force (the family rule).
// 3. --probe sends a one-word prompt through the watched runner at that variant, in a throwaway
//    git directory under the work root. It is one small billed call, and a failure stops the switch.
// 4. The role's chain becomes this one model, then its Claude fallback (L27); other models stay for
//    an explicit --model. --dry-run prints the change and writes nothing.
//
// Exit 0: switched (or shown, or a dry run). Exit 1: refused. Exit 2: usage. Exit 3: OpenCode, the
// login or the probe failed; nothing written.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runOpenCodeWatched, resolveOpenCode, OpenCodeInfraError } from './lib/opencode.mjs';
import { planSwitch, showRoles } from './lib/switch.mjs';
import { sh, repoPaths, loadConfig, parseArgs, prepareOpenCode } from './lib/common.mjs';

const say = (s) => console.log(s);
const die = (code, s) => { console.error(s); process.exit(code); };

const a = parseArgs(process.argv.slice(2), { flags: ['show', 'probe', 'dry-run', 'force'] });
const top = sh('git', ['rev-parse', '--show-toplevel']);
const file = path.join(top, 'harness.json');
const config = loadConfig(top);
if (a.show) { say(showRoles(config)); process.exit(0); }
if (!a.role || !a.model) die(2, 'Usage: switch-model.mjs --role implementer|reviewer --model PROVIDER/ID [--probe] [--dry-run] (or --show)');

let plan;
try {
  plan = planSwitch(config, {
    role: a.role, id: a.model, variant: a.variant ?? 'high', name: a.name, family: a.family, fallback: a.fallback, force: a.force,
  });
} catch (e) { die(/^Refused/.test(e.message) ? 1 : 2, e.message); }
if (plan.conflict) say(`warning (--force): ${plan.conflict}`);
say(`${a.role}: ${plan.name} = ${plan.entry.id} (${plan.entry.variant ?? 'no variant'}, family ${plan.entry.family})`);

let opencode;
try { opencode = resolveOpenCode(); } catch (e) {
  if (e instanceof OpenCodeInfraError) die(3, `OpenCode unavailable: ${e.message} Nothing written.`);
  throw e;
}
const models = { [plan.name]: plan.entry };
const pre = await prepareOpenCode({ opencode, chain: [plan.name], models, env: process.env, cwd: top, log: say });
if (!pre.usable.length) die(3, `${pre.problems.join('; ')}. Nothing written.`);
say(`listed: ${plan.entry.id}`);

if (a.probe) {
  const { workRoot } = repoPaths(config);
  const dir = path.join(workRoot, `probe-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  sh('git', ['init', '-q', dir]);
  let failure = null;
  try {
    const args = ['run', '--dir', dir, '--model', plan.entry.id, ...(plan.entry.variant ? ['--variant', plan.entry.variant] : [])];
    const run = await runOpenCodeWatched({
      args, prompt: 'Reply with the single word PONG and nothing else.', workDir: dir, title: `probe-${plan.name}`,
      startupTimeoutMs: 120_000, idleTimeoutMs: 120_000, totalTimeoutMs: 300_000, pollMs: 2_000,
      opencode, env: pre.env, log: () => {},
    });
    if (run.exitCode !== 0 || !/PONG/i.test(run.stdout)) {
      failure = `probe failed (exit ${run.exitCode}): ${run.output.split(/\r?\n/).slice(-5).join(' | ')}`;
    } else say(`probe: ${plan.entry.id} answered PONG in ${run.seconds} s`);
  } catch (e) {
    if (!(e instanceof OpenCodeInfraError)) throw e;
    failure = `probe failed: ${e.reason}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });       // before any exit: process.exit skips finally
  }
  if (failure) die(3, `${failure}. Nothing written.`);
}

say(`before: ${plan.before}`);
say(`after:  ${plan.after}`);
if (a['dry-run']) { say('dry run: harness.json not written.'); process.exit(0); }
fs.writeFileSync(file, `${JSON.stringify(plan.config, null, 2)}\n`);
say(`written: ${path.relative(process.cwd(), file) || file}. Commit it on main with the reason for the switch (L25), and watch the next run.`);
