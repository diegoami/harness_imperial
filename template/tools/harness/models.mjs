#!/usr/bin/env node
// Lists the models a provider offers now, so a delegate is chosen from the live list, not memory.
//
//   node tools/harness/models.mjs openrouter [--output image] [--input audio] [--search flux] [--json]
//   node tools/harness/models.mjs elevenlabs [--search multilingual] [--json]
//   (OpenCode's own list: `opencode models`, which includes openrouter/* when its key is set.)
//
// Exit 0: listed. Exit 1: the request failed. Exit 3: the provider's key is not set.

import { loadConfig, parseArgs, sh } from './lib/common.mjs';
import { openrouterModels, elevenlabsModels, filterModels, formatModels } from './lib/models.mjs';

const die = (code, s) => { console.error(s); process.exit(code); };
const [provider, ...rest] = process.argv.slice(2);
const a = parseArgs(rest, { flags: ['json'] });

let providers = {};
try { providers = loadConfig(sh('git', ['rev-parse', '--show-toplevel'])).providers ?? {}; } catch { /* defaults */ }
const defaults = {
  openrouter: { baseUrl: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY' },
  elevenlabs: { baseUrl: 'https://api.elevenlabs.io', apiKeyEnv: 'ELEVENLABS_API_KEY' },
};
if (!defaults[provider]) die(2, 'Usage: models.mjs openrouter|elevenlabs [--output TYPE] [--input TYPE] [--search TEXT] [--json]');
const p = { ...defaults[provider], ...providers[provider] };
const key = process.env[p.apiKeyEnv];
if (!key && provider === 'elevenlabs') die(3, `${p.apiKeyEnv} is not set, so ElevenLabs is off.`);

const request = provider === 'openrouter'
  ? { url: `${p.baseUrl.replace(/\/+$/, '')}/v1/models`, headers: key ? { Authorization: `Bearer ${key}` } : {} }
  : { url: `${p.baseUrl.replace(/\/+$/, '')}/v1/models`, headers: { 'xi-api-key': key } };
let json;
try {
  const res = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) die(1, `${provider}: HTTP ${res.status} from ${request.url}: ${(await res.text()).slice(0, 300)}`);
  json = await res.json();
} catch (e) {
  die(1, `${provider}: ${e.message} (${request.url}). Is the host allowed by the network policy?`);
}
const all = provider === 'openrouter' ? openrouterModels(json) : elevenlabsModels(json);
const shown = filterModels(all, { input: a.input, output: a.output, search: a.search });
if (a.json) console.log(JSON.stringify(shown, null, 2));
else console.log(formatModels(shown) || '(no model matches)');
console.error(`${provider}: ${shown.length} of ${all.length} models, listed ${new Date().toISOString().slice(0, 10)}`);
