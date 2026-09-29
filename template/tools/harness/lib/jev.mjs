// Jev, TypeSafe AI's "System One" model: it returns a calibrated probability (or a choice, or a
// score) for a typed question asked of a state, instead of generating text. Here it takes
// decisions the main session would otherwise spend Claude tokens on, one at a time, over many
// items: triage, routing, gating, classification.
//
// The pattern is newscollection2027's (PRs #85 and #87):
//   1. A decision is TRIALLED against labels before it is used: the cutoffs are picked on one half
//      of the labels and reported on the other, so the result is not flattered.
//   2. It is used as a THREE-WAY SPLIT: Jev answers the confident ends, and the main session (or a
//      Claude agent) answers the middle, where an explanation is needed.
//   3. It is OFF WITHOUT A KEY, and a provider failure keeps the answers so far and stops.
//   4. The model is PINNED, and answers are cached, so a rerun is free and comparable.
//
// Wire format (as newscollection2027 uses it, through OpenRouter or TypeSafe direct):
//   POST <baseUrl>/v1/systemone  {model, state, questions: {<name>: {type, instructions, ...}}}
//   ->  {answers: {<name>: {noul: p}}, model, usage: {input_tokens, cost}}
// Only the `noul` (yes/no) answer is parsed. Other question types are passed through verbatim,
// and their raw answer is returned, until their response format is confirmed.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class JevUnavailable extends Error {}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// The question as sent: the decision's type and instructions, plus any extra fields for types
// other than noul (options, for example), verbatim.
export function questionFor(decision, instructions) {
  const { type = 'noul', autoYesAt, autoNoBelow, trial, instructionsFile, ...extra } = decision;
  return { type, instructions, ...extra };
}

export function requestBody({ model, state, name, question }) {
  return { model, state, questions: { [name]: question } };
}

// One response, or a throw. A missing answer or a probability outside [0, 1] is refused, never
// read as a no: a trial that quietly counted failures as negatives would report a recall that
// was never measured.
export function parseAnswer(raw, name, type) {
  const ans = raw?.answers?.[name];
  if (!ans || typeof ans !== 'object') throw new Error(`response has no answer for "${name}": ${JSON.stringify(raw).slice(0, 300)}`);
  const usage = raw.usage ?? {};
  const base = { model: String(raw.model ?? ''), inputTokens: Number(usage.input_tokens ?? 0), cost: Number(usage.cost ?? 0) };
  if (type !== 'noul') return { ...base, raw: ans };
  const p = ans.noul;
  if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error(`noul ${JSON.stringify(p)} is not a probability`);
  return { ...base, p };
}

// A fixed split: the same id is always on the same side, so a new label never reshuffles which
// half picked the cutoffs.
export const inTuningHalf = (id) => parseInt(sha(String(id)).slice(0, 2), 16) % 2 === 0;

// The three-way split. null means: not Jev's to answer.
export function route(p, { autoYesAt, autoNoBelow }) {
  if (autoYesAt != null && p >= autoYesAt) return 'yes';
  if (autoNoBelow != null && p < autoNoBelow) return 'no';
  return 'middle';
}

function stats(items, pick, want) {
  const picked = items.filter(pick);
  const right = picked.filter((x) => x.label === want).length;
  return { n: picked.length, precision: picked.length ? right / picked.length : null };
}

/**
 * Picks the two cutoffs on the tuning half and reports them on the held-out half.
 * items: [{ id, label: boolean, p }]. The yes end is the lowest cutoff whose yes answers reach
 * targetPrecision on the tuning half; the no end is the highest cutoff whose no answers do. An end
 * with no such cutoff stays with Claude (null).
 */
export function trial(items, {
  targetPrecision = 0.95, yesCutoffs = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95],
  noCutoffs = [0.02, 0.05, 0.1, 0.2, 0.3], minPicked = 5,
} = {}) {
  const tuning = items.filter((x) => inTuningHalf(x.id));
  const heldOut = items.filter((x) => !inTuningHalf(x.id));
  const ok = (s) => s.n >= minPicked && s.precision >= targetPrecision;
  const autoYesAt = [...yesCutoffs].sort((a, b) => a - b).find((c) => ok(stats(tuning, (x) => x.p >= c, true))) ?? null;
  const autoNoBelow = [...noCutoffs].sort((a, b) => b - a).find((c) => ok(stats(tuning, (x) => x.p < c, false))) ?? null;
  const report = (set) => {
    const yes = autoYesAt == null ? { n: 0, precision: null } : stats(set, (x) => x.p >= autoYesAt, true);
    const no = autoNoBelow == null ? { n: 0, precision: null } : stats(set, (x) => x.p < autoNoBelow, false);
    return { n: set.length, yes, no, coverage: set.length ? (yes.n + no.n) / set.length : 0 };
  };
  const held = report(heldOut);
  const warnings = [];
  if (heldOut.length < 30) warnings.push(`only ${heldOut.length} held-out labels: too few to trust`);
  if (held.yes.precision != null && held.yes.precision < targetPrecision) warnings.push(`the yes end missed the target on the held-out half (${held.yes.precision.toFixed(3)})`);
  if (held.no.precision != null && held.no.precision < targetPrecision) warnings.push(`the no end missed the target on the held-out half (${held.no.precision.toFixed(3)})`);
  return { autoYesAt, autoNoBelow, targetPrecision, tuning: report(tuning), heldOut: held, warnings };
}

/**
 * Asks Jev one question of each state. Cached by (model, question, state), so a rerun is free
 * and an interrupted run resumes. A failure keeps the answers so far and stops, with `error`.
 * post(body) -> response JSON; inject it in tests.
 */
export async function askAll({ items, name, question, model, post, cacheDir }) {
  const answers = [];
  let error = null;
  for (const { id, state } of items) {
    const key = sha(JSON.stringify([model, name, question, state]));
    const file = path.join(cacheDir, `${key}.json`);
    let raw;
    let cached = false;
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cached = true;
    } else {
      try {
        raw = await post(requestBody({ model, state, name, question }));
        parseAnswer(raw, name, question.type); // refuse before caching
      } catch (e) {
        error = `${id}: ${e.message}`;
        break;
      }
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(raw));
    }
    answers.push({ id, cached, ...parseAnswer(raw, name, question.type) });
  }
  return { answers, error, cost: answers.filter((a) => !a.cached).reduce((s, a) => s + a.cost, 0) };
}

// The one function that touches the network. Retries 429, 5xx and timeouts with backoff; any other
// HTTP error is the caller's to see.
export function httpPost({ baseUrl, apiKey, timeoutSec = 30, retries = 3, backoffMs = 500 }) {
  return async (body) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutSec * 1000),
        });
        if (res.ok) return await res.json();
        if ((res.status !== 429 && res.status < 500) || attempt >= retries) {
          throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { final: true });
        }
      } catch (e) {
        if (e.final || attempt >= retries) throw e;
      }
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  };
}

export function jevSettings(config, env = process.env) {
  const jev = config.jev;
  if (!jev) throw new JevUnavailable('harness.json has no "jev" section');
  const apiKey = env[jev.apiKeyEnv];
  if (!apiKey) throw new JevUnavailable(`${jev.apiKeyEnv} is not set, so Jev is off`);
  return { ...jev, apiKey };
}
