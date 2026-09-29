// models.mjs: the parsing, and the CLI against a local fake of each provider's model list.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModality, openrouterModels, elevenlabsModels, filterModels } from '../template/tools/harness/lib/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.resolve(here, '../template/tools/harness/models.mjs');

const OR = {
  data: [
    { id: 'img/gen-1', name: 'Gen 1', architecture: { input_modalities: ['text'], output_modalities: ['image'] }, pricing: { prompt: '0.000001', completion: '0.000004', image: '0.04' } },
    { id: 'txt/coder', name: 'Coder', architecture: { modality: 'text->text' }, pricing: { prompt: '0.0000003', completion: '0.0000012' } },
    { id: 'aud/listen', name: 'Listen', architecture: { modality: 'text+audio->text' }, pricing: {} },
    { id: 'odd/shape' },
  ],
};
const EL = [
  { model_id: 'eleven_multilingual_v9', name: 'Multilingual v9', can_do_text_to_speech: true, can_do_voice_conversion: false, languages: [{ language_id: 'it' }, { language_id: 'en' }] },
  { model_id: 'eleven_sfx', name: 'Sound effects', can_do_text_to_speech: false },
];

test('modalities come from the arrays, or from the "in->out" string', () => {
  assert.deepEqual(parseModality('text+image->text'), { input: ['text', 'image'], output: ['text'] });
  const m = openrouterModels(OR);
  assert.deepEqual(m.map((x) => x.output), [['image'], ['text'], ['text'], []]);
  assert.deepEqual(m[2].input, ['text', 'audio']);
});

test('prices are per million tokens; an unexpected shape is kept, not dropped', () => {
  const m = openrouterModels(OR);
  assert.equal(m[1].price.inputPerM.toFixed(2), '0.30');
  assert.equal(m[0].price.image, 0.04);
  assert.equal(m[3].id, 'odd/shape');
});

test('ElevenLabs models carry their capabilities and languages', () => {
  const m = elevenlabsModels(EL);
  assert.deepEqual(m[0].capabilities, ['do_text_to_speech']);
  assert.deepEqual(m[0].languages, ['it', 'en']);
  assert.deepEqual(m[0].output, ['audio']);
});

test('filters by input, output and search', () => {
  const m = openrouterModels(OR);
  assert.deepEqual(filterModels(m, { output: 'image' }).map((x) => x.id), ['img/gen-1']);
  assert.deepEqual(filterModels(m, { input: 'audio' }).map((x) => x.id), ['aud/listen']);
  assert.deepEqual(filterModels(m, { search: 'CODER' }).map((x) => x.id), ['txt/coder']);
});

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url.startsWith('/el/') ? EL : OR));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// The CLI reads providers from harness.json; outside a repo it uses defaults, so the tests point
// it at the fake with a harness.json in a throwaway repository.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'harness.json'), JSON.stringify({ providers: {
    openrouter: { baseUrl: `${base}/or`, apiKeyEnv: 'T_OR_KEY' }, elevenlabs: { baseUrl: `${base}/el`, apiKeyEnv: 'T_EL_KEY' },
  } }));
  return dir;
}
const run = (cwd, env, ...args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [tool, ...args], { cwd, env: { ...process.env, ...env } });
  let stdout = ''; let stderr = '';
  c.stdout.on('data', (d) => { stdout += d; });
  c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('openrouter lists image models from the live list, with the key when set', async () => {
  const r = await run(repo(), { T_OR_KEY: 'k' }, 'openrouter', '--output', 'image');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^img\/gen-1\ttext->image\tin \$1\.00\/M out \$4\.00\/M image \$0\.04$/m);
  assert.doesNotMatch(r.stdout, /coder/);
  assert.match(r.stderr, /1 of 4 models/);
  assert.equal(seen.at(-1).url, '/or/v1/models');
  assert.equal(seen.at(-1).headers.authorization, 'Bearer k');
});

test('elevenlabs sends its own header, and is off without its key', async () => {
  const ok = await run(repo(), { T_EL_KEY: 'x' }, 'elevenlabs', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout)[0].id, 'eleven_multilingual_v9');
  assert.equal(seen.at(-1).headers['xi-api-key'], 'x');
  const off = await run(repo(), { T_EL_KEY: '' }, 'elevenlabs');
  assert.equal(off.status, 3);
  assert.match(off.stderr, /T_EL_KEY is not set/);
});
