// What models a provider offers now. Model ids change faster than any document (IC2 #482 changed
// its implementer default three times in one day because `opencode models` listed different ids
// than the plan assumed), so the main session looks them up rather than remembering them.
//
// Parsing is tolerant: each provider's list is read for the fields that exist, and a model whose
// shape is unexpected is kept with what could be read, never dropped silently.

const arr = (x) => (Array.isArray(x) ? x : []);

// "text+image->text" -> { input: ['text', 'image'], output: ['text'] }
export function parseModality(s) {
  const [inp = '', out = ''] = String(s ?? '').split('->');
  const split = (t) => t.split('+').map((x) => x.trim()).filter(Boolean);
  return { input: split(inp), output: split(out) };
}

// OpenRouter's GET /api/v1/models: { data: [{ id, name, architecture, pricing, context_length }] }.
export function openrouterModels(json) {
  return arr(json?.data).map((m) => {
    const a = m.architecture ?? {};
    const fromString = parseModality(a.modality);
    const input = arr(a.input_modalities).length ? a.input_modalities : fromString.input;
    const output = arr(a.output_modalities).length ? a.output_modalities : fromString.output;
    const p = m.pricing ?? {};
    const perM = (v) => (v == null || v === '' ? null : Number(v) * 1e6);
    return {
      provider: 'openrouter', id: m.id, name: m.name ?? m.id, input, output,
      price: { inputPerM: perM(p.prompt), outputPerM: perM(p.completion), image: p.image != null ? Number(p.image) : null },
      context: m.context_length ?? null,
    };
  });
}

// ElevenLabs' GET /v1/models: [{ model_id, name, can_do_text_to_speech, ..., languages }].
export function elevenlabsModels(json) {
  return arr(Array.isArray(json) ? json : json?.models).map((m) => {
    const can = Object.entries(m).filter(([k, v]) => k.startsWith('can_') && v === true).map(([k]) => k.slice(4));
    return {
      provider: 'elevenlabs', id: m.model_id ?? m.id, name: m.name ?? m.model_id,
      input: ['text'], output: ['audio'], capabilities: can,
      languages: arr(m.languages).map((l) => l.language_id ?? l.name ?? l).filter(Boolean),
    };
  });
}

export function filterModels(models, { input, output, search } = {}) {
  const has = (list, want) => !want || list.map((x) => String(x).toLowerCase()).includes(want.toLowerCase());
  const q = search?.toLowerCase();
  return models.filter((m) => has(m.input, input) && has(m.output, output)
    && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q)));
}

export function formatModels(models) {
  const price = (m) => {
    if (!m.price) return m.capabilities?.length ? m.capabilities.join(', ') : '';
    const f = (v) => (v == null ? '-' : `$${v.toFixed(2)}`);
    return `in ${f(m.price.inputPerM)}/M out ${f(m.price.outputPerM)}/M${m.price.image ? ` image $${m.price.image}` : ''}`;
  };
  return models.map((m) => `${m.id}\t${m.input.join('+')}->${m.output.join('+')}\t${price(m)}`).join('\n');
}
