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

// A line without its Markdown decoration (a quote mark, heading marks, emphasis, backticks).
const undecorate = (line) => line.replace(/[*`]/g, '').replace(/^\s*(?:>\s*)*#*\s*/, '').trim();
const key = (line) => undecorate(line).replace(/[.:!]+$/, '').replace(/\s+/g, ' ').toLowerCase();
// The verdict a line states, or null: decoration, a "Verdict:" prefix and trailing punctuation
// are allowed, and nothing else.
function verdictOf(line) {
  const s = key(line.replace(/_/g, '')).replace(/^verdict\s*[:\-–—]\s*/, '');
  return VERDICTS.includes(s) ? s : null;
}
const VERDICT_RE = VERDICTS.map(esc).join('|');

// "fixes #551" becomes "fixes 551". GitHub closes issues only from PR bodies and commits, but a
// review is quoted into both. Returns { text, rewrites }.
export function rewriteClosingKeywords(text) {
  const rewrites = [];
  const out = text.replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:?\s+)#(\d+)/gi, (m, kw, sp, n) => {
    rewrites.push(`${m} -> ${kw}${sp}${n}`);
    return `${kw}${sp}${n}`;
  });
  return { text: out, rewrites };
}

/**
 * Reads a review out of a model's output. A review is never thrown away: only one with no header
 * at all (tool chatter, or nothing: a model that ended its turn early) is a failure.
 * - The header is found case-insensitively, through Markdown decoration, after any preamble; the
 *   last such line wins. Blank lines may precede the verdict, which may be decorated, prefixed with
 *   "Verdict:" or punctuated. The closing verdict is looked for among the last three non-empty
 *   lines, so a sign-off may follow it. A review flattened onto one line (seen from one model) is
 *   read too, its paragraphs restored from runs of spaces.
 * - A readable review comes back normalised: header, verdict, findings, verdict.
 * - A review whose verdict cannot be read, or that may be cut off (IC2 #370: cut off at about 400
 *   characters), comes back as it was, with a note; the caller posts it and applies no label.
 * Closing keywords before #<n> are rewritten in every case.
 * Returns { kind: 'ok', review, verdict, rewrites } | { kind: 'flagged', review, note, rewrites }
 *   | { kind: 'none', reason }.
 */
export function readReview(stdout, header) {
  const lines = String(stdout).split(/\r?\n/);
  const hk = key(header);
  let at = -1;
  let flat = null;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) {
    const k = key(lines[i]);
    if (k === hk) at = i;
    else if (k.startsWith(hk) && /^[\s:.\-–—]/.test(k.slice(hk.length))) {
      at = i;
      const plain = undecorate(lines[i]);
      const h = plain.toLowerCase().indexOf(header.toLowerCase());
      const after = h >= 0 ? plain.slice(h + header.length) : plain;
      flat = [after.replace(/^[\s:.\-–—]+/, ''), ...lines.slice(i + 1)].join(' ').trim();
    }
  }
  if (at < 0) return { kind: 'none', reason: 'no review in its output' };

  const done = (r) => {
    const { text, rewrites } = rewriteClosingKeywords(r.review);
    return { ...r, review: text, rewrites };
  };
  const flagged = (note, body) => done({ kind: 'flagged', note, review: [header, '', body.trim()].join('\n').trimEnd() });
  const normal = (verdict, body) => done({
    kind: 'ok', verdict,
    review: [header, verdict, ...(body.trim() ? ['', body.trim()] : []), '', verdict].join('\n'),
  });

  if (flat !== null) {
    const start = flat.match(new RegExp(`^(?:verdict\\s*[:\\-–—]\\s*)?(${VERDICT_RE})[.!:]*(?:\\s|$)`, 'i'));
    if (!start) return flagged('verdict unreadable', flat);
    const verdict = start[1].toLowerCase();
    const middle = flat.slice(start[0].length).trim();
    const end = middle.match(new RegExp(`(?:^|\\s)(${VERDICT_RE})[.!]*\\s*$`, 'i'));
    if (!end) return flagged('may be cut off', flat);
    if (end[1].toLowerCase() !== verdict) return flagged('verdict unreadable', flat);
    return normal(verdict, middle.slice(0, end.index).trim().split(/ {2,}/).join('\n\n'));
  }

  const rest = lines.slice(at + 1);
  const v = rest.findIndex((l) => l.trim());
  if (v < 0) return flagged('may be cut off', '');
  const verdict = verdictOf(rest[v]);
  if (!verdict) return flagged('verdict unreadable', rest.slice(v).join('\n'));
  const tail = rest.map((l, i) => i).filter((i) => i > v && rest[i].trim()).slice(-3);
  const close = tail.filter((i) => verdictOf(rest[i])).at(-1);
  if (close === undefined) return flagged('may be cut off', rest.slice(v).join('\n'));
  if (verdictOf(rest[close]) !== verdict) return flagged('verdict unreadable', rest.slice(v).join('\n'));
  return normal(verdict, rest.slice(v + 1, close).join('\n'));
}
