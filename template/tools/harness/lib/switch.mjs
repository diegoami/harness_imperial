// Switching the implementer's or the reviewer's model in harness.json, kept free of OpenCode and
// git so it can be tested directly. switch-model.mjs runs the checks that need OpenCode.

export const ROLES = ['implementer', 'reviewer'];

// A model's family, from its id: the family rule (L3) compares these. "opencode-go/gpt-6-luna" and
// "openai/gpt-6-luna" are both openai: the vendor, not the route.
const FAMILIES = [
  [/^deepseek/, 'deepseek'], [/^glm/, 'glm'], [/^(gpt|o\d|codex|chatgpt)/, 'openai'],
  [/^claude/, 'anthropic'], [/^kimi/, 'kimi'], [/^qwen/, 'qwen'], [/^minimax/, 'minimax'],
  [/^mimo/, 'mimo'], [/^grok/, 'xai'], [/^gemini/, 'google'], [/^longcat/, 'longcat'],
  [/^hy\d/, 'hunyuan'], [/^(llama|muse)/, 'meta'], [/^mistral|^devstral|^codestral/, 'mistral'],
];
const modelPart = (id) => String(id).split('/').slice(1).join('/').toLowerCase();
// The vendor's family when the id names a known vendor, else null: only then may --family name it.
export function knownFamilyOf(id) {
  return FAMILIES.find(([re]) => re.test(modelPart(id)))?.[1] ?? null;
}
export function familyOf(id) {
  const model = modelPart(id);
  return knownFamilyOf(id) ?? (model.match(/^[a-z]+/)?.[0] ?? model);
}

// Heavy models run at `low`, or `medium` at most; light ones at `high` (L54, #83). Heavy: Sol, GLM-5.3
// (not Flash), DeepSeek V4 Pro, Opus, wherever they are served from.
// Exactly the models the rule names (Sol's R2 on PR 94): another GLM or DeepSeek release is not heavy.
// Qwen 3.8 Max is the heavy model of Alibaba's Token Plan (the owner, 2026-10-05).
const HEAVY = [/(^|\/)gpt-[\d.]+-sol(-fast)?$/, /(^|\/)glm-5\.3$/, /(^|\/)deepseek-v4-pro$/, /(^|\/)qwen3\.8-max$/, /(^|\/)claude-opus/, /(^|\/)opus$/];
export const isHeavy = (id) => HEAVY.some((re) => re.test(modelPart(id)));
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// The effort a switch writes when --variant is not given, from the efforts OpenCode offers for the
// model (`offered`, from `opencode models --verbose`; null when unknown): a light model `high`; a
// heavy one `low`, else `medium`, else its lowest effort (DeepSeek V4 Pro offers only high and max).
export function defaultVariant(id, offered) {
  if (!isHeavy(id)) return 'high';
  if (!offered) return 'low';
  // Ranked, not in the order OpenCode lists them (Sol's R1 on PR 94).
  const usable = EFFORTS.filter((v) => offered.includes(v) && v !== 'none' && v !== 'max');
  return ['low', 'medium'].find((v) => usable.includes(v)) ?? usable[0] ?? 'high';
}

// The harness.json name for an id: the existing entry's, else the id's model part.
export function nameOf(config, id) {
  const found = Object.entries(config.models ?? {}).find(([, m]) => m.id === id);
  return found ? found[0] : String(id).split('/').slice(1).join('/').toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
}

/**
 * The new harness.json for making `id` the role's one model (L27): the entry is added or updated,
 * the role's chain becomes [name], and every other model stays for an explicit --model. Refuses a
 * model of the other role's family unless `force`: the reviewer is never the implementer's family,
 * so every review would exit 3. A `family` that contradicts a known vendor in the id is refused
 * too, so --family can never carry a model past the family rule (Luna's R1 on PR 17); the vendor's
 * family is checked either way.
 * Returns { config, name, entry, before, after, conflict } or throws with the reason.
 */
export function planSwitch(config, { role, id, variant = 'high', name, family, fallback, force = false }) {
  if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}; got ${role}`);
  if (!/^[\w.-]+\/[\w./-]+$/.test(String(id ?? ''))) throw new Error(`--model must be a provider/model id, e.g. opencode-go/deepseek-v4.1-flash; got ${id}`);
  if (variant === 'max') throw new Error('Effort max is never used: it was slower with no gain (L27). Use high.');
  if (fallback && !['sonnet', 'opus'].includes(fallback)) throw new Error(`--fallback must be sonnet or opus; got ${fallback}`);
  const n = name ?? nameOf(config, id);
  const existing = config.models?.[n];
  if (existing && existing.id !== id) throw new Error(`The name ${n} already holds ${existing.id}; pass --name for ${id}.`);
  const known = knownFamilyOf(id);
  if (family && known && family !== known && !force) {
    throw new Error(`Refused: --family ${family} contradicts ${id}, whose vendor is ${known}; the family rule compares vendors. Drop --family, or pass --force.`);
  }
  const entry = { id, ...(variant ? { variant } : {}), family: family ?? existing?.family ?? familyOf(id), ...(existing?.watch ? { watch: existing.watch } : {}) };
  const other = ROLES.find((r) => r !== role);
  const otherFamilies = (config[other]?.chain ?? []).map((m) => config.models?.[m]?.family ?? m);
  const clash = [entry.family, known].find((f) => f && otherFamilies.includes(f));
  const conflict = clash
    ? `${clash} is also the ${other}'s family: the reviewer is never the implementer's family, so every review would exit 3 to Claude`
    : null;
  if (conflict && !force) throw new Error(`Refused: ${conflict}. Switch the ${other} too, or pass --force.`);
  const describe = (c) => (c[role]?.chain ?? []).map((m) => `${m} (${c.models?.[m]?.id ?? '?'}, ${c.models?.[m]?.variant ?? 'no variant'})`).join(', ')
    + ` then ${afterChain(c[role])}`;
  const next = structuredClone(config);
  next.models = { ...next.models, [n]: entry };
  next[role] = { ...next[role], chain: [n], ...(fallback ? { claudeFallback: fallback } : {}) };
  return { config: next, name: n, entry, before: describe(config), after: describe(next), conflict };
}

// What follows a role's chain: its Claude fallback, or the owner when claudeFallback is null (the
// review profile, #39); "?" when harness.json does not say (#43).
const afterChain = (c) => (c?.claudeFallback === null ? 'the owner' : `Claude ${c?.claudeFallback ?? '?'}`);

// One line per role harness.json has (the review profile has no implementer, #43): what runs now.
// Then the models on watch (L35), if any.
export function showRoles(config) {
  const roles = ROLES.filter((r) => config[r]).map((r) => {
    const c = config[r] ?? {};
    const models = (c.chain ?? []).map((m) => {
      const e = config.models?.[m] ?? {};
      return `${m} = ${e.id ?? '?'} (${e.variant ?? 'no variant'}, family ${e.family ?? '?'})`;
    });
    return `${r}: ${models.join(', ') || '(none)'}, then ${afterChain(c)}`;
  });
  const watched = Object.entries(config.models ?? {}).filter(([, e]) => e.watch).map(([m, e]) => `${m} = ${e.id}`);
  return [...roles, ...(watched.length ? [`on watch: ${watched.join(', ')}`] : [])].join('\n');
}
