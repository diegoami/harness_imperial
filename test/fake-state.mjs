// The fake opencode's session store: one file per session under <FAKE_OC_STATE>.d/, written whole by
// the one process that runs that session. Concurrent runs share no file, so none needs a lock that a
// slow holder could lose (#45). A test may seed FAKE_OC_STATE itself with a JSON list; the fake
// never writes it.
import fs from 'node:fs';
import path from 'node:path';

const dirOf = (stateFile) => `${stateFile}.d`;

export function readSessions(stateFile) {
  let seeded = [];
  try { seeded = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* none */ }
  let names = [];
  try { names = fs.readdirSync(dirOf(stateFile)).filter((n) => n.endsWith('.json')); } catch { /* none */ }
  const own = names.flatMap((n) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dirOf(stateFile), n), 'utf8'))]; } catch { return []; }
  });
  return [...seeded, ...own.sort((a, b) => a.created - b.created)];
}

// Through a temporary file of this process, so a reader never sees half a session.
export function writeSession(stateFile, session) {
  fs.mkdirSync(dirOf(stateFile), { recursive: true });
  const file = path.join(dirOf(stateFile), `${session.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session));
  fs.renameSync(tmp, file);
}
