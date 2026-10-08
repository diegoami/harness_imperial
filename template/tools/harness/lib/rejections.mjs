// The rejection log's lines, grouped and classified for triage (L66). Pure: tests drive it directly.

// One JSON object per line; a line that does not parse, or lacks `at` and `permission`, is skipped.
export function readRejections(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.at === 'string' && typeof e.permission === 'string') out.push(e);
    } catch { /* skipped */ }
  }
  return out;
}

const norm = (p) => p.replace(/\\/g, '/');
const under = (p, dir) => { const d = norm(dir).replace(/\/$/, ''); return p === `${d}/*` || p.startsWith(`${d}/`); };

// What to do about one requested pattern ("/tmp/*", "/home/u/.local/share/repo/*", …):
// { action: allow|brief|owner, why }.
export function classify(permission, { mainRoot, home, repo }) {
  const m = /^external_directory \((.*)\)$/.exec(permission);
  if (!m) return { action: 'owner', why: 'not an external_directory request; read the run log' };
  const p = norm(m[1]);
  if (/\/harness-run-[^/]*\/\*$/.test(p) || /\/harness-run-/.test(p)) {
    return { action: 'allow', why: "the run's own scratch folder: these agent files lack the L66 allows; adopt the template's" };
  }
  if (p === '/dev/*' || /^\/\/\.\/NUL/i.test(p) || /\/dev\/null/.test(p)) {
    return { action: 'allow', why: 'the null device: the template allows /dev/* and ??.?NUL* (L66)' };
  }
  if (mainRoot && under(p, mainRoot)) return { action: 'brief', why: 'the main checkout: a path or brief mistake (L31, L36, L57); allow nothing' };
  if (p === '/tmp/*' || p.startsWith('/tmp/') || /\/(Temp|tmp)\//i.test(p)) {
    return { action: 'brief', why: "scratch outside the run's own folder: the brief must say $TMPDIR (L66); allow nothing" };
  }
  if (home && repo && ['.local/share', '.cache', '.config'].some((d) => under(p, `${home}/${d}/${repo}`))) {
    return { action: 'allow', why: "this project's own data: allow the pattern in this project's agent files" };
  }
  return { action: 'owner', why: 'outside the project (another repository, the home directory, a system folder): the user decides' };
}

// Grouped by the permission asked for, most frequent first: { permission, count, last, action,
// why, samples: up to three distinct rejected calls }.
export function summarize(entries, ctx) {
  const by = new Map();
  for (const e of entries) {
    const g = by.get(e.permission) ?? { permission: e.permission, count: 0, last: e.at, samples: [] };
    g.count++;
    if (e.at > g.last) g.last = e.at;
    for (const c of e.calls ?? []) {
      const s = `${c.tool ?? '?'}: ${c.input ?? ''}`.slice(0, 200);
      if (g.samples.length < 3 && !g.samples.includes(s)) g.samples.push(s);
    }
    by.set(e.permission, g);
  }
  return [...by.values()].map((g) => ({ ...g, ...classify(g.permission, ctx) }))
    .sort((x, y) => y.count - x.count || (y.last > x.last ? 1 : -1));
}
