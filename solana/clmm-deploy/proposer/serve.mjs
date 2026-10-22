#!/usr/bin/env node
// The local page for the fee-tier proposal: http://127.0.0.1:<port>/ . It serves the page, relays a
// short list of calls to the one network this folder is for (and reads only to a second, separate
// RPC, so the page can check one against the other), serves the recorded fee notice, and asks the
// website whether the position link answers for this program. It holds no key and signs nothing:
// your wallet signs in the browser.
//
//   node serve.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG, PACK, web3 } from '../scripts/lib/pack.mjs'; // checks the folder against SHA256SUMS
import { allowedUrl } from '../scripts/lib/hosts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NET = { rehearsal: 'local', mainnet: 'mainnet' }[CFG.kind];
if (!NET) { console.log('STOPPED: this folder has no fee-tier page (it is not the mainnet folder).'); process.exit(2); }
const RPC = CFG.rpc[NET];
const CHECK_RPC = CFG.rpc.check;
const PORT = CFG.page.port;
const ALLOWED = new Set(['getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'simulateTransaction', 'sendTransaction',
  'getSignatureStatuses', 'getGenesisHash', 'getSlot', 'getBalance', 'getEpochInfo', 'getVersion', 'getMinimumBalanceForRentExemption', 'getBlockHeight']);
const READS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getGenesisHash', 'getSlot']);
// What the browser may see of config.json: no file paths.
const PUBLIC = { ...CFG, keyFiles: undefined, packages: undefined, solanaExe: undefined, poolPack: undefined };
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.bundle.js': ['app.bundle.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

/** The position link, asked at a fresh random address: a 404 naming this program. */
async function positionLink() {
  const url = `${CFG.positionLink.base}${web3.Keypair.generate().publicKey.toBase58()}.json`;
  try {
    const r = await fetch(allowedUrl(url, { loopback: NET === 'local' }), { redirect: 'manual', headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (r.status === 404 && j?.error === CFG.positionLink.expect && j?.program === CFG.programId) return { ok: true, why: `the position link is live on the website for this program (${url})` };
    return { ok: false, why: `the position link at ${url} answers ${r.status} ${JSON.stringify(j)?.slice(0, 140) ?? 'not JSON'}, not a 404 for this program: the website must serve range positions for ${CFG.programId} before any pool can be opened` };
  } catch (e) { return { ok: null, why: `the position link could not be read (${e.message}): check again` }; }
}

async function relay(res, send, body, to, allowed) {
  let msg;
  try { msg = JSON.parse(body); } catch { return send(400, 'text/plain', 'not JSON'); }
  const calls = Array.isArray(msg) ? msg : [msg];
  const bad = calls.find((c) => !allowed.has(c?.method));
  if (bad) return send(403, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: bad?.id ?? null, error: { code: -32601, message: `this page does not relay ${bad?.method}` } }));
  for (const c of calls) if (c.method === 'sendTransaction') console.log(`${new Date().toISOString()}  relaying a signed transaction to ${NET}`);
  try {
    // What was checked is what is sent: the parsed calls, written out again.
    const r = await fetch(allowedUrl(to, { loopback: NET === 'local' }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) });
    return send(r.status, 'application/json', await r.text());
  } catch (e) { return send(502, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: calls[0]?.id ?? null, error: { code: -32000, message: `the network could not be reached: ${e.message}` } })); }
}

const server = http.createServer(async (req, res) => {
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(body);
  };
  // Only this machine's own page may call the relay.
  if (req.headers.host !== `127.0.0.1:${PORT}`) return send(403, 'text/plain', 'open the page at http://127.0.0.1:' + PORT + '/');
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && FILES[url.pathname]) {
    const [f, type] = FILES[url.pathname];
    return send(200, type, fs.readFileSync(path.join(HERE, f)));
  }
  if (req.method === 'GET' && url.pathname === '/config.json') return send(200, 'application/json', JSON.stringify(PUBLIC));
  if (req.method === 'GET' && url.pathname === '/notice') {
    const f = path.join(PACK, 'owner-run', 'notice.json');
    let rec = null;
    try { rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null; } catch { rec = { unreadable: true }; }
    return send(200, 'application/json', JSON.stringify({ record: rec }));
  }
  if (req.method === 'GET' && url.pathname === '/position-link') return send(200, 'application/json', JSON.stringify(await positionLink()));
  if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/rpc-check')) {
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${PORT}`) return send(403, 'text/plain', 'not from this page');
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) return send(413, 'text/plain', 'too large'); }
    return url.pathname === '/rpc' ? relay(res, send, body, RPC, ALLOWED) : relay(res, send, body, CHECK_RPC, READS);
  }
  send(404, 'text/plain', 'not here');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`STOPPED: something already uses port ${PORT}. If it is this page in another window, use that window (one page at a time). Otherwise close that program and run this again.`);
  else console.log(`STOPPED: ${e.message}`);
  process.exitCode = 2;
});
server.listen(PORT, '127.0.0.1', () => console.log(`Fee-tier page (${NET === 'mainnet' ? 'MAINNET: real money' : 'LOCAL rehearsal chain'}): http://127.0.0.1:${PORT}/   (Ctrl+C to stop)`));
