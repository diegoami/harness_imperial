// The providers' quota, from quota-tracker where the machine runs it (L50, docs/environment.md):
// before a chain runs, a model whose provider is exhausted is skipped, with the reason, instead of
// being tried and failing. A model with a pool of its own (a window named after it, such as
// `gpt-5.6-luna:7d`) is judged by that window: it stays usable while it is under 95%, even when its
// provider's main window is exhausted.
//
// HARNESS_QUOTA_URL names the service (default http://localhost:8765). A service that does not
// answer within a few seconds, or answers with something unreadable, checks nothing: every model
// stays usable, and the caller says so. A provider in `error` or `not_configured` stays usable too.

export const EXHAUSTED_PCT = 95;

// quota-tracker's provider for a model id ("zai-coding-plan/glm-5.3-flash" → "zai").
const PROVIDERS = { openai: 'openai', 'zai-coding-plan': 'zai', 'opencode-go': 'opencode_go', openrouter: 'openrouter', anthropic: 'claude' };
export const providerOf = (id) => PROVIDERS[id.split('/')[0]] ?? null;

// { providers: Map(name → entry) } or { off: why }.
export async function readQuota(env = process.env, { timeoutMs = 3000 } = {}) {
  const url = `${(env.HARNESS_QUOTA_URL || 'http://localhost:8765').replace(/\/$/, '')}/quota`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { off: `${url} answered ${res.status}` };
    const body = await res.json();
    const list = Array.isArray(body) ? body : Object.values(body);
    if (!list.every((p) => p && typeof p.provider === 'string')) return { off: `${url} answered something unreadable` };
    return { providers: new Map(list.map((p) => [p.provider, p])) };
  } catch (e) {
    return { off: `${url} did not answer (${e.cause?.code ?? e.name})` };
  }
}

// Why a model may not run now, or null.
export function quotaBlock(id, quota) {
  const p = quota.providers?.get(providerOf(id));
  if (!p) return null;
  const own = (p.windows ?? []).find((w) => w.name.split(':')[0] === id.split('/').slice(1).join('/'));
  if (own) return own.used_pct >= EXHAUSTED_PCT ? `its own ${own.name} window is ${own.used_pct}% used${own.resets_in ? `, resets in ${own.resets_in}` : ''}` : null;
  if (p.status !== 'exhausted') return null;
  return `${p.provider} is exhausted${p.available_in ? ` until it is usable again in ${p.available_in}` : ''}`;
}
