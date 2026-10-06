// Starts test/fake-quota.mjs with a /quota body; resolves { url, stop }. `raw` (optional)
// overrides the /quota body verbatim — garbage there tests an unreadable payload while
// FAKE_QUOTA_PROVIDERS can still serve per-provider entries.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function quotaServer(providers, raw) {
  const child = spawn(process.execPath, [path.join(here, 'fake-quota.mjs')], { env: { ...process.env, FAKE_QUOTA: raw ?? JSON.stringify(providers) } });
  return new Promise((resolve) => {
    child.stdout.once('data', (d) => resolve({ url: `http://127.0.0.1:${String(d).trim()}`, stop: () => child.kill() }));
  });
}

// One provider's entry as quota-tracker gives it.
export const entry = (provider, status, windows = [], extra = {}) => ({ provider, status, windows, ...extra });
