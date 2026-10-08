// Ranking the registered models for a run, by quota-tracker's recommendation over the owner's
// preference order (harness.json's `chooser` block; an absent block falls back to the chains).
// Pure: no IO, so tests drive it directly.
//
// The order is (blocked, band, preference index). The band comes from `/recommend` (the owner,
// 2026-10-08, #128): headroom percentages are not comparable between providers, whose pools
// differ in size and period and are partly used by Claude sessions; `/recommend`'s score, spare
// calls per day until the reset, is. Time-of-day pricing is in that score already (zai's peak
// multiplier), so it is no tier of its own here. A reviewer never shares the implementer's family.

import { providerOf, quotaBlock } from './quota.mjs';
import { excludeImplementers } from './chain.mjs';

// The preference names for a role and difficulty: the `chooser` block when it has them, else the
// committed chains (implementer easy: implementer.chain; implementer hard: the chain with
// deepseek first, as docs/models.md pairs it; reviewer easy: reviewer.chain; reviewer hard:
// reviewer.hard). Unknown names are the caller's usage error, caught here so the block cannot
// silently rot.
export function chooserOrder(config, { role, difficulty }) {
  const own = config.chooser?.[role]?.[difficulty];
  if (own) {
    for (const n of own) {
      if (!config.models?.[n]) throw new Error(`chooser.${role}.${difficulty} names ${n}, which harness.json's models does not list`);
    }
    return [...own];
  }
  if (role === 'implementer') {
    const chain = [...(config.implementer?.chain ?? [])];
    return difficulty === 'easy' ? chain : [...new Set(['deepseek-flash', ...chain])];
  }
  const rev = config.reviewer ?? {};
  return difficulty === 'easy' ? [...(rev.chain ?? [])] : [...(rev.hard ?? rev.chain ?? [])];
}

// The `/recommend` row for a model id: the row naming that model, else (a model it does not list,
// such as an older Sol) the provider's shared pool, i.e. its rows not limited by a model's own
// window (`name:period`), the lowest score of them. null when the provider has no row.
export function recommendRow(id, rec) {
  const provider = providerOf(id);
  const model = id.split('/').slice(1).join('/');
  const rows = (rec?.rows ?? []).filter((r) => r.provider === provider);
  const exact = rows.find((r) => r.model === model);
  if (exact) return { row: exact, estimate: false };
  const shared = rows.filter((r) => !String(r.limiting_window ?? '').includes(':') && r.model !== model);
  if (!shared.length) return null;
  const low = shared.reduce((x, y) => ((y.score ?? Infinity) < (x.score ?? Infinity) ? y : x));
  return { row: low, estimate: true };
}

// Band 0: spare calls before the reset (score > 0, or a pool not yet sized that is usable with
// spare left). Band 1: none (score <= 0: it runs out before its reset at the current demand, or
// OpenRouter's prepaid 0), or skipped as nearly full. Band 2: not ranked at all (Alibaba, or the
// tracker off), so it never outranks a ranked pool (#125).
export function bandOf(id, rec) {
  const found = recommendRow(id, rec);
  if (!found) return { band: 2, score: null, note: rec?.off ? null : 'not ranked by /recommend' };
  const { row, estimate } = found;
  const via = estimate ? ` (its provider's ${row.model} row)` : '';
  if (row.skipped) return { band: 1, score: row.score, note: `skipped by /recommend${via}: ${row.why || 'nearly full'}` };
  if (typeof row.score === 'number') return { band: row.score > 0 ? 0 : 1, score: row.score, note: `${row.score} spare calls/day${via}` };
  const spare = row.usable !== false && typeof row.spare_pct === 'number' && row.spare_pct > 0;
  return { band: spare ? 0 : 1, score: null, note: `pool not yet sized, ${row.spare_pct ?? '?'}% spare${via}` };
}

/**
 * Rank the candidates for a run. `quota` is readQuota's result ({ providers: Map }, for blocking)
 * and `recommend` readRecommend's ({ rows } or { off }, for the band); `implementedBy` (optional,
 * reviewer only) names who implemented, for the family rule. Returns the ranked list, most
 * runnable first: { name, id, family, blocked, band, score, provider, status, note } — blocked
 * candidates last, each with its reason.
 */
export function rankCandidates({ config, role, difficulty, quota, recommend, implementedBy }) {
  let order = chooserOrder(config, { role, difficulty });
  let excluded = [];
  if (role === 'reviewer' && implementedBy) {
    const keep = new Set(excludeImplementers(order, config.models ?? {}, [implementedBy]));
    excluded = order.filter((n) => !keep.has(n));
    order = order.filter((n) => keep.has(n));
  }
  const ranked = order.map((name, i) => {
    const entry = config.models[name];
    const provider = providerOf(entry.id);
    const p = quota?.providers?.get(provider);
    const { band, score, note } = bandOf(entry.id, recommend);
    return {
      name, id: entry.id, family: entry.family, blocked: quota?.providers ? quotaBlock(entry.id, quota) : null,
      band, score, provider, status: p?.status ?? 'unknown', note, index: i,
    };
  });
  for (const n of excluded) {
    ranked.push({ name: n, id: config.models[n].id, family: config.models[n].family,
      blocked: `the implementer's family (${config.models[n].family ?? n}); the reviewer never shares it`,
      band: 9, score: null, provider: providerOf(config.models[n].id), status: 'excluded', note: null,
      index: order.length + excluded.indexOf(n) });
  }
  return ranked.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || a.band - b.band || a.index - b.index);
}
