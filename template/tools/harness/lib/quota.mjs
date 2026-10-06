// The providers' quota, from quota-tracker where the machine runs it (L50, docs/environment.md):
// before a chain runs, a model whose provider is exhausted is skipped, with the reason, instead of
// being tried and failing. A model with a pool of its own (a window named after it, such as
// `gpt-5.6-luna:7d`) is judged by that window: it stays usable while it is under 95%, even when its
// provider's main window is exhausted.
//
// HARNESS_QUOTA_URL names the service (default http://localhost:8765). A service that does not
// answer within a few seconds, or answers with something unreadable, checks nothing: every model
// stays usable, and the caller says so. A provider in `error` or `not_configured` stays usable too.
// A free OpenRouter model (`…:free`) is judged by the shared daily allowance of free requests alone.

export const EXHAUSTED_PCT = 95;

// quota-tracker's provider for a model id ("zai-coding-plan/glm-5.3-flash" → "zai").
const PROVIDERS = {
  openai: 'openai', 'zai-coding-plan': 'zai', 'opencode-go': 'opencode_go', openrouter: 'openrouter', anthropic: 'claude',
  'alibaba-token-plan': 'alibaba',   // one monthly pool shared by every model on the plan
  minimax: 'minimax',                // the MiniMax Token Plan: a 5-hour and a weekly window
};
export const providerOf = (id) => PROVIDERS[id.split('/')[0]] ?? null;

// { providers: Map(name → entry) } or { off: why }.
export async function readQuota(env = process.env, { timeoutMs = 3000 } = {}) {
  const url = `${(env.HARNESS_QUOTA_URL || 'http://localhost:8765').replace(/\/$/, '')}/quota`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { off: `${url} answered ${res.status}` };
    const body = await res.json();
    const list = Array.isArray(body) ? body : Object.values(body);
    // Every entry readable, windows included, or none is used (Sol's R1 on PR 77: a malformed window
    // crashed the run instead of checking nothing).
    // The optional texts a reason quotes are strings or absent (Sol's R1-R2 of round 2).
    const text = (v) => v === undefined || v === null || typeof v === 'string';
    const window = (w) => w && typeof w.name === 'string' && typeof w.used_pct === 'number' && text(w.resets_in);
    const num = (v) => typeof v === 'number';
    const free = (f) => f === undefined || f === null || (typeof f === 'object' && num(f.remaining) && num(f.limit));
    const readable = (p) => p && typeof p.provider === 'string' && typeof p.status === 'string' && text(p.available_in)
      && free(p.free_model_daily_requests)
      && (p.windows === undefined || (Array.isArray(p.windows) && p.windows.every(window)));
    if (!list.every(readable)) return { off: `${url} answered something unreadable` };
    return { providers: new Map(list.map((p) => [p.provider, p])) };
  } catch (e) {
    return { off: `${url} did not answer (${e.cause?.code ?? e.name})` };
  }
}

// Why a model may not run now, or null.
export function quotaBlock(id, quota) {
  const p = quota.providers?.get(providerOf(id));
  // A provider that could not be checked blocks nothing, its windows included (Sol's R2 on PR 77).
  if (!p || p.status === 'error' || p.status === 'not_configured') return null;
  // A free OpenRouter model draws on the shared daily allowance of free requests, not on the
  // credit: it runs while requests remain, even with the credit spent (the owner, 2026-10-06).
  if (id.endsWith(':free')) {
    const f = p.free_model_daily_requests;
    if (!f) return null;
    return f.remaining > 0 ? null : `the free models' daily allowance is used up (${f.used ?? f.limit} of ${f.limit} requests)`;
  }
  const own = (p.windows ?? []).find((w) => w.name.split(':')[0] === id.split('/').slice(1).join('/'));
  if (own) return own.used_pct >= EXHAUSTED_PCT ? `its own ${own.name} window is ${own.used_pct}% used${own.resets_in ? `, resets in ${own.resets_in}` : ''}` : null;
  if (p.status !== 'exhausted') return null;
  return `${p.provider} is exhausted${p.available_in ? ` until it is usable again in ${p.available_in}` : ''}`;
}
