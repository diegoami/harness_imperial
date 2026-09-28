// The decisions shared by implement.mjs and review.mjs, kept free of git and gh so they can be
// tested directly.

import { failureClass } from './opencode.mjs';

/**
 * Tries each model once. The next model runs only after an infrastructure failure, and only when
 * the failed attempt left nothing behind (leftWork() is false). Two consecutive failures with the
 * same cause stop the chain: then OpenCode itself is the problem, not the model.
 *
 * attempt(name) resolves { ok: true, value } or { ok: false, reason, detail }.
 * Resolves { ok: true, name, value, failures }, or { ok: false, failures, sameCause, leftWork }.
 */
export async function runChain({ chain, attempt, leftWork = async () => false, reset = async () => {}, log = () => {} }) {
  const failures = [];
  for (const name of chain) {
    log(`attempt: ${name}`);
    const r = await attempt(name);
    if (r.ok) return { ok: true, name, value: r.value, failures };
    log(`${name} failed: ${r.reason}`);
    failures.push({ name, reason: r.reason, detail: r.detail });
    if (await leftWork()) return { ok: false, failures, sameCause: null, leftWork: true };
    await reset();
    const n = failures.length;
    if (n >= 2 && failureClass(failures[n - 1].reason) === failureClass(failures[n - 2].reason)) {
      return { ok: false, failures, sameCause: failureClass(r.reason), leftWork: false };
    }
  }
  return { ok: false, failures, sameCause: null, leftWork: false };
}

/**
 * The reviewer is never the implementer's model family. `implementedBy` holds model names from
 * harness.json, or bare family names such as "claude". Returns the chain without those families.
 */
export function excludeImplementers(chain, models, implementedBy) {
  const familyOf = (name) => models[name]?.family ?? name;
  const banned = new Set(implementedBy.map(familyOf));
  return chain.filter((name) => !banned.has(familyOf(name)));
}

export const VERDICTS = ['approve after named fixes', 'approve', 'rework', 'user decision'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A review is complete when it starts with the header line, has a verdict on line 2, and repeats
 * that verdict as its last line; anything else is cut off and never posted (IC2's first external
 * review, #370, was cut off at about 400 characters). A review flattened onto one line (seen from
 * one model) is accepted when it starts and ends with the same verdict; its paragraph breaks are
 * restored from runs of spaces. A closing keyword before #<n> throws: nothing is posted.
 * Returns { ok: true, review, verdict } or { ok: false, reason }.
 */
export function checkReview(stdout, header) {
  const idx = stdout.indexOf(header);
  if (idx < 0) return { ok: false, reason: 'no header line in its output' };
  let review = stdout.slice(idx).trimEnd();
  let lines = review.split(/\r?\n/);
  if (lines[0].trim() !== header) {
    const flat = review.slice(header.length).trim();
    const verdict = VERDICTS.find((v) => new RegExp(`^${esc(v)}(\\s|$)`, 'i').test(flat));
    if (!verdict) return { ok: false, reason: 'no verdict after the header' };
    let middle = flat.slice(verdict.length).trim();
    if (middle.length < verdict.length || !new RegExp(`(^|\\s)${esc(verdict)}\\s*$`, 'i').test(middle)) {
      return { ok: false, reason: 'review cut off' };
    }
    middle = middle.slice(0, middle.length - verdict.length).trim();
    review = [header, verdict, '', middle.split(/ {2,}/).join('\n\n'), '', verdict].join('\n');
    lines = review.split('\n');
  }
  const verdict = (lines[1] ?? '').trim().toLowerCase();
  if (!VERDICTS.includes(verdict)) return { ok: false, reason: 'no verdict on line 2' };
  const last = lines.filter((l) => l.trim()).at(-1).trim().toLowerCase();
  if (last !== verdict) return { ok: false, reason: 'review cut off' };
  if (/\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#\d+/i.test(review)) {
    throw new Error('The review contains a closing keyword before #<n>. Nothing posted.');
  }
  return { ok: true, review, verdict };
}
