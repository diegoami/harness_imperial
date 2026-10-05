// A fake quota-tracker for the tests (HARNESS_QUOTA_URL): serves FAKE_QUOTA (JSON, the /quota
// body) on a free port, prints the port, and runs until killed. Its own process, so it answers
// while a test blocks on spawnSync.
import http from 'node:http';

const body = process.env.FAKE_QUOTA ?? '[]';
const server = http.createServer((req, res) => {
  if (req.url !== '/quota') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
