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
    /** One NFT bought (or, in shadow mode, one the bot would have bought). */
    trade(fill) {
      let exists;
      try {
        exists = fs.existsSync(paths.trades);
      } catch {
        exists = false;
      }
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
