#!/usr/bin/env node
/**
 * Arbitrage scanner (owner 2026-11-05: "a proper scanner ... where you can actively see all of
 * the arb across robinhood and solana tokens"). A page on this computer that lists, for every
 * busy token on Solana and Robinhood Chain, its cheapest and dearest pool and what a round trip
 * between them would make after both pools' fees. It refreshes on its own clock.
 *
 * READ-ONLY: it holds no key, signs nothing and sends nothing. Every figure is an ESTIMATE from
 * listed prices (scripts/lib/arb-scan.mjs says how); a row is real only once a quote confirms it.
 *
 * Sources, both public and keyless:
 *   GeckoTerminal  which pools are busiest on each chain, and their fee from the pool's name.
 *                  It turns a caller away after ~10 quick reads, so: one read every 7 s, a
 *                  minute's pause on a refusal, and the list renewed every UNIVERSE_MIN.
 *   DexScreener    every pool of those tokens with its price, one token a read, 4 reads a second
 *                  at most (its limit is 300 a minute).
 *
 *   node scripts/arb-scanner.mjs           the page, http://127.0.0.1:8791 (Ctrl+C stops it)
 *   node scripts/arb-scanner.mjs --once    one scan, printed here
 *
 * Settings (environment): ARB_PORT (8791), ARB_PAGES (GeckoTerminal pages a chain, 20 pools each, 5)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS, addrKey, parseDexPair, parsePool, scan } from './lib/arb-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ARB_PORT || 8791);
const PAGES = Math.min(10, Math.max(1, Number(process.env.ARB_PAGES || 5)));
const UNIVERSE_MIN = 10;
const GECKO_GAP_MS = 7_000;
const DEX_GAP_MS = 250;
const MAX_ROWS = 300;
const ONCE = process.argv.includes('--once');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (e) => (e instanceof Error ? e.message : String(e));
const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) throw Object.assign(new Error('rate limited'), { busy: true });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

/** A read of `url` no sooner than `gap` after the last read through the same gate, whichever chain asks. */
function gate(gap) {
  let next = 0;
  return async (url) => {
    const wait = next - Date.now();
    next = Math.max(Date.now(), next) + gap;
    if (wait > 0) await sleep(wait);
    return getJson(url);
  };
}
const geckoRead = gate(GECKO_GAP_MS);
const dexRead = gate(DEX_GAP_MS);

/** One chain's state: the busy pools (GeckoTerminal) and every pool of their tokens (DexScreener). */
function chainState(id) {
  return { id, name: CHAINS[id].name, gecko: [], fees: new Map(), tokens: [], dex: new Map(), universeAt: 0, pricesAt: 0, rows: [], pools: 0, note: 'reading…' };
}
const chains = Object.fromEntries(Object.keys(CHAINS).map((id) => [id, chainState(id)]));

async function readUniverse(c) {
  const { network, refs } = CHAINS[c.id];
  const gecko = [];
  for (let page = 1; page <= PAGES; page++) {
    try {
      const j = await geckoRead(`https://api.geckoterminal.com/api/v2/networks/${network}/pools?sort=h24_volume_usd_desc&page=${page}`);
      for (const raw of j.data ?? []) {
        const p = parsePool(raw, network);
        if (p) gecko.push(p);
      }
    } catch (e) {
      if (!e.busy) throw e;
      log(`${c.name}: GeckoTerminal is busy, page ${page} again in a minute`);
      await sleep(60_000);
      page--;
    }
  }
  if (!gecko.length) throw new Error('GeckoTerminal listed no pools');
  c.gecko = gecko;
  c.fees = new Map(gecko.filter((p) => p.feeKnown).map((p) => [addrKey(p.address), p.fee]));
  // The tokens to follow: every one in a busy pool but the chain's own coins (whose pools number thousands).
  const isRef = (a) => Object.keys(refs).some((r) => addrKey(r) === addrKey(a));
  c.tokens = [...new Set(gecko.flatMap((p) => [p.base, p.quote]).filter((a) => !isRef(a)))];
  c.universeAt = Date.now();
  log(`${c.name}: ${gecko.length} busy pools, ${c.tokens.length} tokens to follow`);
}

async function readPrices(c) {
  for (const token of c.tokens) {
    try {
      const pairs = await dexRead(`https://api.dexscreener.com/token-pairs/v1/${c.id}/${token}`);
      const pools = (Array.isArray(pairs) ? pairs : []).filter((p) => p?.chainId === c.id).map((p) => parseDexPair(p, c.fees)).filter(Boolean);
      c.dex.set(addrKey(token), pools);
    } catch (e) {
      if (e.busy) await sleep(30_000);
    }
  }
  for (const key of [...c.dex.keys()]) if (!c.tokens.some((t) => addrKey(t) === key)) c.dex.delete(key);
  rescan(c);
  c.pricesAt = Date.now();
}

/** Busy pools and DexScreener's pools together, one entry a pool (DexScreener's when both list it). */
function rescan(c) {
  const byAddress = new Map();
  for (const p of c.gecko) byAddress.set(addrKey(p.address), p);
  for (const pools of c.dex.values()) for (const p of pools) byAddress.set(addrKey(p.address), p);
  c.pools = byAddress.size;
  c.rows = scan([...byAddress.values()], CHAINS[c.id].refs).slice(0, MAX_ROWS);
  c.note = null;
}

async function runChain(c) {
  for (;;) {
    try {
      if (Date.now() - c.universeAt > UNIVERSE_MIN * 60_000) {
        await readUniverse(c);
        rescan(c); // the busy pools alone, while every token's pools are read
      }
      await readPrices(c);
    } catch (e) {
      c.note = `not read: ${said(e)}`;
      log(`${c.name}: ${c.note}`);
      await sleep(30_000);
    }
    if (ONCE) return;
  }
}

function snapshot() {
  return JSON.stringify({
    at: Date.now(),
    chains: Object.values(chains).map((c) => ({ id: c.id, name: c.name, universeAt: c.universeAt, pricesAt: c.pricesAt, tokens: c.tokens.length, pools: c.pools, rows: c.rows, note: c.note })),
  });
}

if (ONCE) {
  await Promise.all(Object.values(chains).map(runChain));
  for (const c of Object.values(chains)) {
    log(`${c.name}: ${c.pools} pools, ${c.rows.length} tokens in two or more${c.note ? ` (${c.note})` : ''}`);
    for (const r of c.rows.slice(0, 15)) {
      log(`  ${r.label} (${r.token}): gap ${r.gapPct.toFixed(3)}%, costs ${r.costPct.toFixed(3)}%, est. $${r.profitUsd.toFixed(2)} on $${r.sizeUsd.toFixed(0)} · buy ${r.buy.dex} ${r.buy.pool} · sell ${r.sell.dex} ${r.sell.pool}${r.quiet ? ' · quiet' : ''}${r.suspect ? ' · suspect' : ''}`);
    }
  }
  process.exit(0);
}

const page = fs.readFileSync(path.join(HERE, 'arb-scanner-page.html'), 'utf8');
const app = fs.readFileSync(path.join(HERE, 'arb-scanner-page.js'), 'utf8');
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const css = fs.readFileSync(path.join(HERE, 'arb-scanner-page.css'), 'utf8');

const server = http.createServer((req, res) => {
  // Only this computer, by its own names: a web page elsewhere that points a name of its own at
  // 127.0.0.1 is turned away.
  if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return res.writeHead(421, common).end();
  if (req.method !== 'GET') return res.writeHead(405, common).end();
  if (req.url === '/') return res.writeHead(200, { ...common, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }).end(page);
  if (req.url === '/app.js') return res.writeHead(200, { ...common, 'content-type': 'text/javascript; charset=utf-8' }).end(app);
  if (req.url === '/app.css') return res.writeHead(200, { ...common, 'content-type': 'text/css; charset=utf-8' }).end(css);
  if (req.url === '/state.json') return res.writeHead(200, { ...common, 'content-type': 'application/json' }).end(snapshot());
  return res.writeHead(404, common).end();
});
server.on('error', (e) => {
  log(e.code === 'EADDRINUSE' ? `A scanner already runs at http://127.0.0.1:${PORT}: open that one (or set ARB_PORT)` : `Scanner stopped: ${said(e)}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  log(`Arbitrage scanner: http://127.0.0.1:${PORT}`);
  log('  read-only, on this computer only; Ctrl+C stops it');
});
await Promise.all(Object.values(chains).map(runChain));
