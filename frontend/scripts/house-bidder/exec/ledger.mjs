// The bot's records, all in the keys folder (outside OneDrive):
//   ledger.jsonl  append-only: every decision, post, cancel (with its reason), expiry, fill,
//                 breaker trip, re-seed and transaction. Never rewritten, never truncated.
//   trades.csv    one row per NFT bought, for the monthly report and the public record.
//   status.json   rewritten every loop, for `status` and the board.
// Shadow mode writes the same lines with shadow: true; a live run never reads them as its own.
//
// The daily caps are re-seeded from the CHAIN's house fills as well as the ledger: a cap that
// lived only in a file could be reset by restoring an older copy of the file.

import nodeFs from 'node:fs';
import { eth, jsonLine, toSec, toWei, utcDay, utcMonth } from '../brain/util.mjs';

export const TRADES_HEADER = 'time_utc,slug,token_id,unit_price_eth,unit_price_wei,seller,fulfiller,order_hash,tx_hash,shadow';

/** Every line of the ledger that parses. A torn last line (a crash mid-write) is skipped, not fatal. */
export function readLedger(fs, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn line: the rest of the file is still the record
    }
  }
  return out;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function createLedger({ paths, fs = nodeFs, now = Date.now, shadow = false }) {
  // The file is read once; after that, what this run appends is kept beside it in memory, so a
  // tick never re-parses a month of lines. The file stays the record.
  let cache = null;
  return {
    shadow,
    /** One line, appended. Returns the entry as written (bigints as decimal strings, as in the file). */
    append(kind, fields = {}) {
      // A field named like the line's own keys would silently rewrite what kind of line it is.
      for (const k of ['t', 'at', 'kind', 'shadow']) if (k in fields) throw new Error(`a ledger line cannot carry its own "${k}"`);
      const at = now();
      const entry = { t: new Date(at).toISOString(), at, kind, ...(shadow ? { shadow: true } : {}), ...fields };
      const line = jsonLine(entry);
      fs.appendFileSync(paths.ledger, `${line}\n`);
      if (cache) cache.push(JSON.parse(line));
      return entry;
    },
    /** One NFT bought (or, in shadow mode, one the bot would have bought), once: a fill already in the file is not written again. */
    trade(fill) {
      let exists;
      try {
        exists = fs.existsSync(paths.trades);
      } catch {
        exists = false;
      }
      if (exists && tradeKeys(fs.readFileSync(paths.trades, 'utf8')).has(fillKey(fill))) return;
      const price = toWei(fill.unitPriceWei, 'fill price');
      const row = [
        new Date((toSec(fill.time) ?? Math.floor(now() / 1000)) * 1000).toISOString(),
        fill.slug,
        fill.tokenId,
        eth(price, 18),
        price.toString(),
        fill.seller,
        fill.fulfiller,
        fill.orderHash,
        fill.txHash,
        shadow ? 'yes' : 'no',
      ].map(csvCell).join(',');
      fs.appendFileSync(paths.trades, `${exists ? '' : `${TRADES_HEADER}\n`}${row}\n`);
    },
    /** The status file, replaced whole (written beside it, then renamed over it). */
    writeStatus(status) {
      const tmp = `${paths.status}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(status, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
      fs.renameSync(tmp, paths.status);
    },
    read() {
      if (!cache) cache = readLedger(fs, paths.ledger);
      return cache;
    },
  };
}

const fillKey = (f) => `${String(f.txHash).toLowerCase()}:${String(f.orderHash).toLowerCase()}:${f.tokenId}`;

/** The fill keys already in trades.csv (token_id, order_hash and tx_hash: columns 3, 8 and 9). */
function tradeKeys(text) {
  const keys = new Set();
  for (const row of String(text).split('\n').slice(1)) {
    const c = row.split(',');
    if (c.length >= 9) keys.add(fillKey({ txHash: c[8], orderHash: c[7], tokenId: c[2] }));
  }
  return keys;
}

/**
 * What the house holds, per collection (sets of token ids): every NFT it bought, from the ledger
 * and the chain, once each, less every one it sent back to the funding wallet ('nft-returned',
 * once per return transaction). What the owner does with a returned NFT is no longer the house's.
 */
export function holdingsFrom({ entries, chainFills = [], shadow = false }) {
  const count = new Map();
  const bump = (slug, tokenId, by) => {
    const k = `${slug}:${tokenId}`;
    const c = count.get(k) ?? { slug, tokenId: String(tokenId), n: 0 };
    c.n += by;
    count.set(k, c);
  };
  for (const f of knownFills({ entries, chainFills, shadow })) bump(f.slug, f.tokenId, 1);
  const returns = new Set();
  for (const e of entries) {
    if (e.kind !== 'nft-returned' || Boolean(e.shadow) !== shadow) continue;
    const k = `${e.slug}:${e.tokenId}:${String(e.txHash).toLowerCase()}`;
    if (returns.has(k)) continue;
    returns.add(k);
    bump(e.slug, e.tokenId, -1);
  }
  const out = {};
  for (const c of count.values()) if (c.n > 0) (out[c.slug] ??= new Set()).add(c.tokenId);
  return out;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * The house transactions the signer counts against its daily budget (tools/house-signer: 20
 * transactions and 0.05 ETH of gas in any 24 hours unless policy.daily says otherwise): every one
 * the bot asked for in the last 24 hours, except the kill's, which the signer never counts. A
 * send that failed on the way ('tx-failed') counts too: the signer may have signed it first.
 */
export function txsInLastDay({ entries, nowMs, shadow = false }) {
  return entries.filter((e) => (e.kind === 'tx' || e.kind === 'tx-failed') && Boolean(e.shadow) === shadow && nowMs - e.at < DAY_MS && !String(e.why ?? '').startsWith('kill')).length;
}

/**
 * Null when the keys folder's drive has room for the ledger, else why not, in plain words. A
 * disk check that cannot be read counts as no room. No check wired (a test) is no answer.
 */
export function diskRoom(diskFree, minBytes) {
  if (typeof diskFree !== 'function') return null;
  let free;
  try {
    free = Number(diskFree());
  } catch (e) {
    return `the free space on the keys folder's drive could not be read (${e?.message ?? e})`;
  }
  if (!Number.isFinite(free)) return "the free space on the keys folder's drive could not be read";
  if (free >= minBytes) return null;
  return `only ${(free / 1e9).toFixed(2)} GB is free on the keys folder's drive; the bot needs ${minBytes / 1e9} GB free so that every cancel, fill and kill it makes can still be written down`;
}

/**
 * Every house fill known from the ledger and the chain, each once. The chain's list wins on
 * conflicts: it is the record that cannot be rolled back.
 */
export function knownFills({ entries, chainFills = [], shadow = false }) {
  const seen = new Map();
  for (const f of chainFills) seen.set(fillKey(f), { ...f, source: 'chain' });
  for (const e of entries) {
    if (e.kind !== 'fill' || Boolean(e.shadow) !== shadow) continue;
    const k = fillKey(e);
    if (!seen.has(k)) seen.set(k, { ...e, source: 'ledger' });
  }
  return [...seen.values()];
}

/**
 * The UTC day's totals for the caps: WETH spent and units bought (ledger and chain fills,
 * once each) and gas (each of the house's transactions at what the signer said it cost, or at
 * the policy's most it could cost when the signer did not say).
 */
export function dailyTotals({ entries, chainFills = [], dayMs, shadow = false, gasPerTxWei }) {
  const day = utcDay(dayMs);
  let wethSpent = 0n;
  let units = 0;
  for (const f of knownFills({ entries, chainFills, shadow })) {
    const t = toSec(f.time ?? f.at);
    if (t === null || utcDay(t * 1000) !== day) continue;
    wethSpent += toWei(f.unitPriceWei, 'fill price');
    units += 1;
  }
  let gasSpent = 0n;
  let txs = 0;
  for (const e of entries) {
    if (e.kind !== 'tx' || Boolean(e.shadow) !== shadow || utcDay(e.at) !== day) continue;
    txs += 1;
    gasSpent += e.gasCostWei !== undefined && e.gasCostWei !== null ? toWei(e.gasCostWei, 'gas cost') : gasPerTxWei;
  }
  return { wethSpent, units, gasSpent, txs };
}

/** Flagged (stolen) items bought in the month of `atMs`. */
export function stolenInMonth(entries, atMs, shadow = false) {
  const month = utcMonth(atMs);
  return entries.filter((e) => e.kind === 'quarantine' && Boolean(e.shadow) === shadow && utcMonth(e.at) === month).length;
}

/** The most one house transaction can cost under the policy: its gas limit at its fee cap. */
export function maxTxCostWei(policy) {
  const gwei = BigInt(Math.ceil(policy.gas.maxFeeGwei * 1e9));
  return BigInt(policy.gas.maxGasLimit) * gwei;
}
