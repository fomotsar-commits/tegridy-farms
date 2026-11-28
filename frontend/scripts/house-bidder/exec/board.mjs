// `house-bidder board`: a read-only page on this computer showing status.json, as the price
// keeper's dashboard does. It reads the file the running bot rewrites every tick; it sends
// nothing, signs nothing and holds no key. Only this computer, by its own names: a web page
// elsewhere that points a name of its own at 127.0.0.1 is turned away (DNS rebinding).

import nodeFs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BOARD_PORT = 8796;

const CSP = ["default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const COMMON = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };

/** The request handler, apart from the server, so it can be tested without a port. */
export function boardHandler({ statusPath, port, fs = nodeFs }) {
  const page = fs.readFileSync(path.join(HERE, 'board.html'), 'utf8');
  const app = fs.readFileSync(path.join(HERE, 'board.js'), 'utf8');
  return (req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return res.writeHead(421, COMMON).end();
    if (req.method !== 'GET') return res.writeHead(405, COMMON).end();
    if (req.url === '/') return res.writeHead(200, { ...COMMON, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP }).end(page);
    if (req.url === '/app.js') return res.writeHead(200, { ...COMMON, 'content-type': 'text/javascript; charset=utf-8' }).end(app);
    if (req.url === '/status.json') {
      let body;
      try {
        body = fs.readFileSync(statusPath, 'utf8');
        JSON.parse(body);
      } catch {
        body = JSON.stringify({ missing: true, note: 'no status yet: the bot has not run a tick in this keys folder' });
      }
      return res.writeHead(200, { ...COMMON, 'content-type': 'application/json' }).end(body);
    }
    return res.writeHead(404, COMMON).end();
  };
}

export function serveBoard({ statusPath, port = DEFAULT_BOARD_PORT, log = console.log }) {
  const server = http.createServer(boardHandler({ statusPath, port }));
  server.on('error', (e) => {
    log(e.code === 'EADDRINUSE' ? `A board already runs at http://127.0.0.1:${port}: open that one (or pass --port)` : `Board stopped: ${e.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    log(`House bidder board: http://127.0.0.1:${port}`);
    log('  read-only, on this computer only; Ctrl+C stops it (the bot keeps running)');
  });
  return server;
}
