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
// A run's scratch folder, anchored: /tmp/harness-run-<title>/… or <drive>:/Users/<u>/AppData/Local/Temp/harness-run-<title>/….
const SCRATCH = /^(?:\/tmp|[A-Za-z]:\/Users\/[^/]+\/AppData\/Local\/Temp)\/harness-run-([^/]+)\/(?:\*|.*)$/;
// The null device, exactly: /dev/* (what OpenCode asks for /dev/null), /dev/null, or Windows' \\.\NUL.
const NULLDEV = /^(?:\/dev\/\*|\/dev\/null|\/\/\.\/NUL(?:\/\*)?)$/i;

// What to do about one requested pattern ("/tmp/*", "/home/u/.local/share/repo/*", …):
// { action: allow|brief|owner, why }. `titles` are the runs that asked (the log's titles).
export function classify(permission, { mainRoot, home, repo }, titles = []) {
  const m = /^external_directory \((.*)\)$/.exec(permission);
  if (!m) return { action: 'owner', why: 'not an external_directory request; read the run log' };
  const p = norm(m[1]);
  // A `..` segment is never trusted: what it reaches is not what it says (Sol's R4 on PR 137).
  if (p.split('/').includes('..')) return { action: 'owner', why: 'a path with `..`: where it leads is not what it names; the user decides' };
  const run = SCRATCH.exec(p);
  if (run) {
    return titles.length && titles.every((t) => t === run[1])
      ? { action: 'allow', why: "the run's own scratch folder was refused: its per-run agent file was missing (the runner logs why); fix that, allow nothing broader" }
      : { action: 'brief', why: "another run's scratch folder: a path mistake; allow nothing" };
  }
  if (NULLDEV.test(p)) return { action: 'allow', why: 'the null device: the template allows /dev/* and ??.?NUL* (L66)' };
  if (mainRoot && under(p, mainRoot)) return { action: 'brief', why: 'the main checkout: a path or brief mistake (L31, L36, L57); allow nothing' };
  if (p === '/tmp/*' || p.startsWith('/tmp/') || /^[A-Za-z]:\/Users\/[^/]+\/AppData\/Local\/Temp\//.test(p)) {
    return { action: 'brief', why: "scratch outside the run's own folder: the brief must say $TMPDIR (L66); allow nothing" };
  }
  if (home && repo && ['.local/share', '.cache', '.config'].some((d) => under(p, `${norm(home)}/${d}/${repo}`))) {
    return { action: 'allow', why: "this project's own data: allow the pattern in this project's agent files" };
  }
  return { action: 'owner', why: 'outside the project (another repository, the home directory, a system folder): the user decides' };
}

// Grouped by the permission asked for, most frequent first: { permission, count, last, action,
// why, samples: up to three distinct rejected calls }.
export function summarize(entries, ctx) {
  const by = new Map();
  for (const e of entries) {
    const g = by.get(e.permission) ?? { permission: e.permission, count: 0, last: e.at, samples: [], titles: [] };
    g.count++;
    if (e.title && !g.titles.includes(e.title)) g.titles.push(e.title);
    if (e.at > g.last) g.last = e.at;
    for (const c of e.calls ?? []) {
      const s = `${c.tool ?? '?'}: ${c.input ?? ''}`.slice(0, 200);
      if (g.samples.length < 3 && !g.samples.includes(s)) g.samples.push(s);
    }
    by.set(e.permission, g);
  }
  return [...by.values()].map((g) => ({ ...g, ...classify(g.permission, ctx, g.titles) }))
    .sort((x, y) => y.count - x.count || (y.last > x.last ? 1 : -1));
}
