// A fake quota-tracker for the tests (HARNESS_QUOTA_URL): serves FAKE_QUOTA (the /quota body,
// verbatim — it may be garbage, to test an unreadable payload) on a free port, prints the port,
// and runs until killed. Its own process, so it answers while a test blocks on spawnSync.
// A /quota/<provider> request answers that provider's entry from FAKE_QUOTA_PROVIDERS (falling
// back to FAKE_QUOTA when it parses), so readPricing's per-provider fetch is testable even when
// /quota is broken; a provider the list does not name is a 404.
import http from 'node:http';

const body = process.env.FAKE_QUOTA ?? '[]';
let providers = [];
try { providers = JSON.parse(process.env.FAKE_QUOTA_PROVIDERS ?? body); } catch { /* none */ }
const server = http.createServer((req, res) => {
  const one = /^\/quota\/([\w-]+)$/.exec(req.url);
  if (one) {
    const p = providers.find((e) => e.provider === one[1]);
    if (!p) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(p));
    return;
  }
  if (req.url !== '/quota') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
