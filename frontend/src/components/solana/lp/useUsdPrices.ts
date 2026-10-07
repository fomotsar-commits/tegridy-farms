import { useEffect, useState } from 'react';
import { getUsdPrices } from '../../../lib/jupiter';
import { QUOTE_COINS, type QuoteSymbol } from '../../../lib/solana/lp/quotes';
import { READ_TIMEOUT_MS } from '../../../lib/solana/lp/readFetch';
import { NO_USD_PRICES, USD_LINES, type UsdPerCoin } from '../../../lib/solana/lp/usd';

/**
 * Jupiter's dollar price of each pairing coin, for the "about $" lines (usd.ts). With
 * USD_LINES off: every coin null and NO call, ever. On: one `price/v3` call for the three
 * coins through our proxy (`/api/jupiter`, 60 a minute per IP), kept 60 s for every mount
 * and Read again inside that window. A price that was not read, or is not a price (0,
 * negative, not finite), is null for that coin, never 0. `readAt` is when the read
 * landed, in ms, for the line's "read {s} s ago"; null until one has.
 */

export interface UsdPricesRead {
  prices: UsdPerCoin;
  readAt: number | null;
}

/** How long one read is kept: the proxy allows 60 calls a minute per IP. */
export const USD_PRICES_TTL_MS = 60_000;

const NONE: UsdPricesRead = { prices: NO_USD_PRICES, readAt: null };

let cached: { at: number; read: UsdPricesRead } | null = null;
let inFlight: Promise<UsdPricesRead> | null = null;

/** Tests only: forget the kept read. */
export function __resetUsdPrices(): void {
  cached = null;
  inFlight = null;
}

function pricesFrom(got: Record<string, number>): UsdPerCoin {
  const out: Record<QuoteSymbol, number | null> = { ...NO_USD_PRICES };
  for (const q of QUOTE_COINS) {
    const p = got[q.mint];
    out[q.symbol] = typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
  }
  return out;
}

/** One read, ended by READ_TIMEOUT_MS (readFetch.ts rule: every read ends); a failure is "not read". */
async function readPrices(): Promise<UsdPricesRead> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
  try {
    const got = await getUsdPrices(QUOTE_COINS.map((q) => q.mint), ctrl.signal);
    return { prices: pricesFrom(got), readAt: Date.now() };
  } catch {
    return NONE;
  } finally {
    clearTimeout(timer);
  }
}

function readOnce(): Promise<UsdPricesRead> {
  if (cached && Date.now() - cached.at < USD_PRICES_TTL_MS) return Promise.resolve(cached.read);
  if (!inFlight) {
    inFlight = readPrices().then((read) => {
      cached = { at: Date.now(), read };
      inFlight = null;
      return read;
    });
  }
  return inFlight;
}

/**
 * The prices behind the dollar lines. `lines` is a parameter only so the off rule stays
 * testable (lpWriteFlag.ts pattern); every caller uses the default, the committed switch.
 */
export function useUsdPrices(reloadKey: number, lines: typeof USD_LINES = USD_LINES): UsdPricesRead {
  const [read, setRead] = useState<UsdPricesRead>(NONE);
  useEffect(() => {
    if (lines !== 'on') return;
    let live = true;
    readOnce().then((r) => {
      if (live) setRead(r);
    });
    return () => {
      live = false;
    };
  }, [reloadKey, lines]);
  return read;
}
