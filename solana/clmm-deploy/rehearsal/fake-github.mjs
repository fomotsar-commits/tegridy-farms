#!/usr/bin/env node
// The rehearsal's stand-in for GitHub and for the website: it answers the few requests the deploy
// folder makes, from a state file the rehearsal rewrites as it goes.
//
//   node fake-github.mjs <state.json> <port>
//   state: { head, commits: [{ sha, date, parent, files: { path: text } }] (oldest first), program }
//
//   GET /api/commits/<branch>                         { sha: head }
//   GET /api/commits?sha=&since=&per_page=&page=      commits since `since`, newest first (GitHub's shape)
//   GET /raw/<sha>/<path>                             the file at that commit, or 404
//   GET /position/<id>.json                           404 { error, program }: the website's answer
import http from 'node:http';
import fs from 'node:fs';

const [file, port] = process.argv.slice(2);
const state = () => JSON.parse(fs.readFileSync(file, 'utf-8'));
http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  const json = (code, o) => { s.writeHead(code, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
  const st = state();
  let m;
  if ((m = /^\/api\/commits\/([\w-]+)$/.exec(u.pathname))) return json(200, { sha: st.head });
  if (u.pathname === '/api/commits') {
    const since = Date.parse(u.searchParams.get('since') ?? '1970-01-01T00:00:00Z');
    const per = Number(u.searchParams.get('per_page') ?? 30); const page = Number(u.searchParams.get('page') ?? 1);
    const list = st.commits.filter((c) => Date.parse(c.date) >= since).reverse().slice((page - 1) * per, page * per);
    return json(200, list.map((c) => ({ sha: c.sha, parents: c.parent ? [{ sha: c.parent }] : [], commit: { committer: { date: c.date } } })));
  }
  if ((m = /^\/raw\/(\w+)\/(.+)$/.exec(u.pathname))) {
    const c = st.commits.find((x) => x.sha === m[1]);
    const t = c?.files?.[m[2]];
    if (t === undefined) { s.writeHead(404); return s.end('404: Not Found'); }
    s.writeHead(200, { 'content-type': 'text/plain' }); return s.end(t);
  }
  if (/^\/position\/\w+\.json$/.test(u.pathname)) return json(404, { error: 'No range position at this address.', program: st.program });
  json(404, { message: 'Not Found' });
}).listen(Number(port), '127.0.0.1');
