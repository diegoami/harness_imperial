// A fake quota-tracker for the tests (HARNESS_QUOTA_URL): serves FAKE_QUOTA (JSON, the /quota
// body) on a free port, prints the port, and runs until killed. Its own process, so it answers
// while a test blocks on spawnSync. A /quota/<provider> request answers that provider's entry
// from the same list, so readPricing's per-provider fetch is testable (a pricing object rides in
// the entry like any other field); a provider the list does not name is a 404.
import http from 'node:http';

const body = process.env.FAKE_QUOTA ?? '[]';
const list = JSON.parse(body);
const server = http.createServer((req, res) => {
  const one = /^\/quota\/([\w-]+)$/.exec(req.url);
  const payload = one ? list.find((p) => p.provider === one[1]) : req.url === '/quota' ? list : null;
  if (!payload && !(one && list.some((p) => p.provider === one[1]))) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
