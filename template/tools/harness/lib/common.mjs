// git, gh, the config and argument parsing, for implement.mjs and review.mjs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openCodeHome, listedModels, loginHint, openCodeVersion, versionProblem } from './opencode.mjs';

export function sh(cmd, args, { cwd, allowFail = false, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw new Error(`${cmd} could not run: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stderr}`);
  return r.status === 0 ? r.stdout.trim() : '';
}

export function requireTools(...tools) {
  for (const t of tools) {
    const r = spawnSync(t, ['--version'], { stdio: 'ignore' });
    if (r.error) throw new Error(`${t} is not on PATH.`);
  }
}

// The main checkout, even when run from a worktree, and the directory agents' worktrees live in.
export function repoPaths(config) {
  const top = sh('git', ['rev-parse', '--show-toplevel']);
  const commonDir = sh('git', ['-C', top, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainRoot = path.dirname(commonDir);
  const rel = (config.worktreeRoot ?? '../{repo}-work').replaceAll('{repo}', path.basename(mainRoot));
  return { top, commonDir, mainRoot, workRoot: path.resolve(mainRoot, rel) };
}

export function loadConfig(top) {
  const file = path.join(top, 'harness.json');
  if (!fs.existsSync(file)) throw new Error(`harness.json not found at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A model on watch (L35) says what to look for each time it runs: its `watch` text, else nothing.
export function watchLine(name, model) {
  return model.watch ? `watch: ${name} (${model.id}) is on watch: ${model.watch}` : null;
}

// --name value, --flag, and repeatable --env KEY=VALUE / --copy path.
export function parseArgs(argv, { flags = [], repeatable = [] } = {}) {
  const out = {};
  for (const r of repeatable) out[r] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (flags.includes(key)) { out[key] = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new Error(`${a} needs a value`);
    if (repeatable.includes(key)) out[key].push(val); else out[key] = val;
  }
  return out;
}

export function envWith(pairs) {
  const env = { ...process.env };
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) throw new Error(`--env takes KEY=VALUE; got ${p}`);
    env[p.slice(0, i)] = p.slice(i + 1);
  }
  return env;
}

// OpenCode silently falls back to its default, full-permission agent when --agent names one it
// cannot find, and a branch cut before the agent file existed does not carry it (IC2 #480). Copy
// the agent into the worktree, and keep the copy out of git so the model cannot commit it.
export function ensureAgent({ top, commonDir, worktree, agent }) {
  const rel = `.opencode/agents/${agent}.md`;
  const src = path.join(top, rel);
  if (!fs.existsSync(src)) throw new Error(`Agent file not found: ${src}`);
  if (sh('git', ['-C', worktree, 'ls-files', '--', rel], { allowFail: true })) return;
  fs.mkdirSync(path.join(worktree, '.opencode', 'agents'), { recursive: true });
  fs.copyFileSync(src, path.join(worktree, rel));
  const exclude = path.join(commonDir, 'info', 'exclude');
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!text.split(/\r?\n/).includes(rel)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${rel}\n`);
  }
}

// Before anything is billed: the scripts' own data directory, the OpenCode version (any major but
// the supported one is refused, #26), and which models of the chain OpenCode lists there. A model it does not list (an unknown id, or a provider not logged in in
// that directory) is dropped, with the command that fixes it. Returns { env, usable, problems }.
export async function prepareOpenCode({ opencode, chain, models, env, cwd, log }) {
  const oc = openCodeHome(env, { log });
  const version = await openCodeVersion(opencode, { env: oc.env, cwd });
  log(`opencode: ${version ?? 'unknown version'} (${opencode.exe})`);
  const bad = versionProblem(version, opencode.exe);
  if (bad) return { env: oc.env, usable: [], problems: [bad], version };
  const { listed, errors } = await listedModels(opencode, chain.map((m) => models[m].id.split('/')[0]), { env: oc.env, cwd });
  const problems = [];
  const usable = chain.filter((m) => {
    if (listed.has(models[m].id)) return true;
    problems.push(`${m}: ${loginHint(models[m].id, listed, oc.dataHome, errors)}`);
    return false;
  });
  return { env: oc.env, usable, problems, version };
}

export const ocArgs = (worktree, agent, model) =>
  ['run', '--dir', worktree, '--agent', agent, '--model', model.id, ...(model.variant ? ['--variant', model.variant] : [])];
