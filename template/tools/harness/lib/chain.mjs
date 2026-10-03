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

// Closing keywords lose their '#': "fixes #551", "Fixes: #12", "fixes#12", "closes owner/repo#3",
// in any case. GitHub closes issues only from PR bodies and commits, but a review is quoted into
// both. Returns { text, rewrites }.
export function rewriteClosingKeywords(text) {
  const rewrites = [];
  const re = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s*)([\w.-]+\/[\w.-]+)?#(\d+)/gi;
  const out = text.replace(re, (m, kw, sp, repo, n) => {
    const to = `${kw}${sp || ' '}${repo ? `${repo} ` : ''}${n}`;
    rewrites.push(`${m} -> ${to}`);
    return to;
  });
  return { text: out, rewrites };
}

// A line that looks like a finding, through its decoration: "R2: …", "- **R2.** …", "### R3 …",
// "**Finding R3**: …", "3. …", "1) …". A date or "1.0 release" is not one.
const isFinding = (line) => {
  const u = undecorate(line.replace(/_/g, '')).replace(/^[-*+]\s+/, '');
  return /^(?:finding\s+)?R\d+\b/i.test(u) || /^\d+[.)]\s/.test(u);
};

/**
 * Reads a review out of a model's output. A review is never thrown away; only output with no
 * header at all (tool chatter, or nothing: a model that ended its turn early) is a failure.
 * The owner's rules of 2026-10-02 (L28):
 * - The header is found case-insensitively, through Markdown decoration (**…**, a leading #,
 *   backticks), with a trailing ':' or '.', anywhere on its line, after any preamble. The last
 *   line carrying it is the review: an earlier draft or an echoed brief never decides the verdict,
 *   so a review that is flagged can never be approved through an earlier header.
 * - The verdict is the first verdict-shaped line among the first five non-empty lines after the
 *   header (decoration, a "Verdict:" prefix and trailing punctuation allowed). Lines before it, a
 *   short where-I-worked block, are kept.
 * - The closing verdict is found among the last three non-empty lines. Only that line (and a
 *   repeat of the same verdict just before it) is removed; every line after it (a sign-off) is
 *   kept, and one canonical closing verdict is appended.
 * - A review flattened onto one line is read when it starts and ends with the same verdict, also
 *   on the line after the header or before a sign-off; its paragraphs are restored from runs of
 *   spaces.
 * - Otherwise the review is flagged, and posted whole, exactly as it arrived: no closing verdict
 *   ("may be cut off", IC2 #370), no readable verdict, opening and closing verdicts that differ, or
 *   a finding-like line after the closing verdict. The caller applies no label.
 * Closing keywords lose their '#' in every case.
 * Returns { kind: 'ok', review, verdict, rewrites } | { kind: 'flagged', review, note, rewrites }
 *   | { kind: 'none', reason }.
 */
export function readReview(stdout, header) {
  const whole = String(stdout).trim();
  const lines = String(stdout).split(/\r?\n/);
  const headerRe = new RegExp(esc(header.trim()).replace(/\s+/g, '\\s+'), 'i');
  const done = (r) => {
    const { text, rewrites } = rewriteClosingKeywords(r.review);
    return { ...r, review: text, rewrites };
  };
  const flagged = (note) => ({ kind: 'flagged', note });
  const normal = (verdict, content) => {
    const c = content.join('\n').replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, '\n\n').trim();
    return { kind: 'ok', verdict, review: [header, verdict, ...(c ? ['', c] : []), '', verdict].join('\n') };
  };

  // One line, then any sign-off lines.
  const readFlat = (flat, after = []) => {
    const start = flat.match(new RegExp(`^(?:verdict\\s*[:\\-–—]\\s*)?(${VERDICT_RE})[.!:]*(?:\\s|$)`, 'i'));
    if (!start) return flagged('verdict unreadable');
    const verdict = start[1].toLowerCase();
    const middle = flat.slice(start[0].length).trim();
    const end = middle.match(new RegExp(`(?:^|\\s)(${VERDICT_RE})[.!]*\\s*$`, 'i'));
    if (!end) return flagged('may be cut off');
    if (end[1].toLowerCase() !== verdict) return flagged(`verdicts differ: opens "${verdict}", closes "${end[1].toLowerCase()}"`);
    if (after.some(isFinding)) return flagged('a finding after the closing verdict');
    return normal(verdict, [middle.slice(0, end.index).trim().split(/ {2,}/).join('\n\n'), '', ...after]);
  };
  // Lines: an optional where-I-worked block, the verdict, findings, the closing verdict, a sign-off.
  const readLines = (rest) => {
    const filled = rest.map((l, i) => i).filter((i) => rest[i].trim());
    const v = filled.slice(0, 5).find((i) => verdictOf(rest[i]));
    if (v === undefined) {
      // A flattened review on the first line, perhaps with a sign-off after it.
      const flat = filled.length ? readFlat(undecorate(rest[filled[0]]), rest.slice(filled[0] + 1)) : null;
      return flat ?? flagged('verdict unreadable');
    }
    const verdict = verdictOf(rest[v]);
    const close = filled.filter((i) => i > v).slice(-3).filter((i) => verdictOf(rest[i])).at(-1);
    // The only verdict found is the review's last line, after other text: its opening is missing.
    if (close === undefined) return flagged(v === filled.at(-1) && v > filled[0] ? 'verdict unreadable' : 'may be cut off');
    if (verdictOf(rest[close]) !== verdict) return flagged(`verdicts differ: opens "${verdict}", closes "${verdictOf(rest[close])}"`);
    const after = rest.slice(close + 1);
    if (after.some(isFinding)) return flagged('a finding after the closing verdict');
    // The same verdict repeated just before the closing one ("rework", then "Rework.") goes too.
    let end = close;
    for (let j = close - 1; j > v && (!rest[j].trim() || verdictOf(rest[j]) === verdict); j--) if (rest[j].trim()) end = j;
    return normal(verdict, [...rest.slice(0, v), '', ...rest.slice(v + 1, end), ...after]);
  };
  const readAt = (i) => {
    const plain = undecorate(lines[i]);
    const m = plain.match(headerRe);
    const onLine = plain.slice(m.index + m[0].length).replace(/^[\s:.)\-–—]+/, '').trim();
    const following = lines.slice(i + 1);
    if (onLine && !following.some((l) => l.trim())) return readFlat(onLine);
    return readLines(onLine ? [onLine, ...following] : following);
  };

  const last = lines.findLastIndex((l) => headerRe.test(undecorate(l)));
  if (last < 0) return { kind: 'none', reason: 'no review in its output' };
  const r = readAt(last);
  return done(r.kind === 'ok' ? r : { ...r, review: whole });
}

// How many Done-when lines the task file in a brief has: the numbered lines under its
// "**Done when**" field (the task template) or a "Done when" heading (an issue body), each at the
// start of its line, so a mention of the field in prose is not taken for it. 0 when there is none,
// and then nothing is counted (L32).
export function doneWhenCount(brief) {
  const lines = String(brief).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*(?:[-*+]\s+)?\*\*Done when\b[^*]*\*\*|^#{1,6}\s*Done when\b/i.test(l));
  if (start < 0) return 0;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    // The next field (an unindented "- **Field**", as in the task template), heading or rule. An
    // indented bold sub-bullet under a Done-when line is part of it (found on PR 27's own body).
    if (/^[-*+]\s+\*\*|^#{1,6}\s|^-{3,}\s*$/.test(l)) break;
    if (/^\s*\d+\.\s/.test(l)) n++;
  }
  return n;
}

// Whether a review accounts for each of `count` Done-when lines: exactly one line each, either
// "DW<k>: ran <command> → <result>" or "DW<k>: not run — <reason>" (L32). Anything else on a DW
// line, or the same number twice, does not account for it (Luna's R1 on PR 22). An approval with a
// line missing, malformed, repeated or not run is not an approval.
// Returns { missing: [k], notRun: [k], malformed: [k], repeated: [k] }.
export function accountDoneWhen(review, count) {
  const seen = new Map();
  for (const l of String(review).split(/\r?\n/)) {
    const m = l.replace(/[*_]/g, '').match(/^\s*(?:[-+]\s+)?`?DW\s*(\d+)`?\s*[:.)\-–—]\s*(.*)$/i);
    if (m) seen.set(Number(m[1]), [...(seen.get(Number(m[1])) ?? []), m[2].trim()]);
  }
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const one = (k) => (seen.get(k)?.length === 1 ? seen.get(k)[0] : null);
  const ran = (t) => /^ran\s+\S.*\s(?:→|->)\s*\S/i.test(t);
  const notRun = (t) => /^not\s+run\s*(?:—|–|-|:)\s*\S/i.test(t);
  return {
    missing: all.filter((k) => !seen.has(k)),
    repeated: all.filter((k) => seen.get(k)?.length > 1),
    notRun: all.filter((k) => one(k) !== null && notRun(one(k))),
    malformed: all.filter((k) => one(k) !== null && !ran(one(k)) && !notRun(one(k))),
  };
}

// The commits a brief names as the one to review: a full 40-hex hash after "at", "HEAD is" or
// "HEAD:", as process.md §5's brief writes them ("You review PR #<n> at <sha>", "HEAD is <sha>").
// Other hashes (a PR body citing another commit) are not targets and are left alone (#23). Only the
// reviewer's block is read, the lines before the pasted task file's title (`# T<nn> …`, as
// docs/tasks/TEMPLATE.md opens): a task file may cite its evidence "at <sha>" too (#32). Any other
// heading stays in the block, so it cannot hide a stale head (Luna's R1 on PR 34).
export function briefTargets(brief) {
  const block = String(brief).split(/^#\s+T\d+\b/m)[0];
  return [...block.matchAll(/\b(?:at|HEAD\s+is|HEAD:)\s+`?([0-9a-fA-F]{40})\b/g)].map((m) => m[1].toLowerCase());
}
