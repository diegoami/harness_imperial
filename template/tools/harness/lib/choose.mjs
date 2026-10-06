// Ranking the registered models for a run, by live quota and time-of-day pricing over the
// owner's preference order (harness.json's `chooser` block; an absent block falls back to the
// chains). Pure: no IO, so tests drive it directly.
//
// The order is (blocked, band, tier, preference index) — headroom outranks pricing, per the
// owner (2026-10-06): a discounted pool that is nearly burnt loses to a fresh one; pricing only
// reorders peers with comparable headroom. A reviewer never shares the implementer's family.

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

// Headroom band: 0 means half the window or more is left, 1 a fifth to a half (or low, or a
// provider the tracker could not check), 2 under a fifth. A provider the tracker could not
// check blocks nothing (quotaBlock) and lands in band 1, noted.
function bandOf(p) {
  if (!p || p.status === 'error' || p.status === 'not_configured') return { band: 1, unknown: true };
  const h = typeof p.headroom_pct === 'number' ? p.headroom_pct : null;
  if (h === null) return { band: p.status === 'low' ? 1 : 0, unknown: false };
  return { band: h >= 50 ? 0 : h >= 20 ? 1 : 2, unknown: false };
}

// Pricing tier within a band, from the owner's standing rule (docs/models.md, Pricing by time of
// day): a discount that is on now promotes (−1); a peak that is on now demotes (+1); anything
// else is neutral. Providers without pricing are neutral.
function tierOf(provider, pricing) {
  const p = pricing?.get?.(provider);
  if (!p) return { tier: 0, note: null };
  const until = typeof p.next_change_at === 'number' ? new Date(p.next_change_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'the next change';
  if (p.discount_now === true) return { tier: -1, note: `discount on until ${until}` };
  if (p.peak_now === true) return { tier: 1, note: `peak now until ${until}` };
  return { tier: 0, note: null };
}

/**
 * Rank the candidates for a run. `quota` and `pricing` are readQuota's and readPricing's
 * results ({ providers: Map } / { pricing: Map }); `implementedBy` (optional, reviewer only)
 * names who implemented, for the family rule. Returns the ranked list, most runnable first:
 * { name, id, family, blocked, band, tier, provider, status, headroom, limiting, note } —
 * blocked candidates last, each with its reason.
 */
export function rankCandidates({ config, role, difficulty, quota, pricing, implementedBy }) {
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
    const { band, unknown } = bandOf(p);
    const { tier, note } = tierOf(provider, pricing?.pricing);
    const limiting = p?.limiting_window ?? (p?.windows ?? [])[0]?.name ?? null;
    return {
      name, id: entry.id, family: entry.family, blocked: quotaBlock(entry.id, quota),
      band, tier, provider, status: p?.status ?? 'unknown', headroom: p?.headroom_pct ?? null,
      limiting, resetsIn: p?.windows?.find((w) => w.name === p.limiting_window)?.resets_in ?? null,
      note, index: i,
    };
  });
  for (const n of excluded) {
    ranked.push({ name: n, id: config.models[n].id, family: config.models[n].family,
      blocked: `the implementer's family (${config.models[n].family ?? n}); the reviewer never shares it`,
      band: 9, tier: 0, provider: providerOf(config.models[n].id), status: 'excluded', headroom: null,
      limiting: null, resetsIn: null, note: null, index: order.length + excluded.indexOf(n) });
  }
  return ranked.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || a.band - b.band || a.tier - b.tier || a.index - b.index);
}
