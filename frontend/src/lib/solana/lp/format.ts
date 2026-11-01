import { formatSol, formatTokenAmount } from '../../launcher/solana/curve/format';
import { ratePercent } from '../cpswap/math';
import { chargedCreatorFeeRate, tradeCost } from '../cpswap/venue';
import type { QuoteCoin } from './quotes';

/** Display helpers for the LP pages. Numbers that ride a transaction never pass through here. */

/** A rate over a span of time, caught by its shape ("a year", "per month", "each week", "daily"), not word by word. */
export const RATE_WORDS = /annual|\b(?:a|per|each|every)\s+(?:year|month|week|day)\b|\b(?:yearly|monthly|weekly|daily)\b|rate of return/i;

/**
 * Words that promise a return. No LP copy carries one; every pin uses this regex and no
 * other, so a word added here is caught everywhere at once.
 */
export const FORECAST_WORDS = new RegExp(`\\bAPR\\b|\\bAPY\\b|yield of|earn fees on every trade|${RATE_WORDS.source}`, 'i');

/** A chain time to the minute, in UTC ("2026-10-03 22:30 UTC"); a time the node did not record says so. */
export function minuteText(unixSecs: number | null): string {
  if (unixSecs === null || !Number.isFinite(unixSecs)) return 'a time the chain did not record';
  return `${new Date(unixSecs * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A price written out (never scientific notation), four significant digits. The unit is
 * the caller's: SOL per token for a SOL pool, the pool's own pairing coin otherwise
 * (`priceText` adds it).
 *
 * From 10,000 up it is a whole number with its thousands grouped: "104,000". Four
 * significant digits there would be "1.040e+5", which nobody reads as a price. No token
 * costs 10,000 SOL, but one worth 10,000 USDC or 10,000 BAYLA is ordinary. The line is at
 * 9,999.5, the first value that rounds to five digits.
 */
export function formatSolPrice(v: number): string {
  if (!Number.isFinite(v) || v < 0) return 'unreadable';
  if (v === 0) return '0';
  if (v >= 9999.5) return Math.round(v).toLocaleString('en-US');
  if (v < 0.000001) {
    const digits = Math.min(100, 3 - Math.floor(Math.log10(v)));
    return v.toFixed(digits).replace(/0+$/, '');
  }
  const s = v.toPrecision(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** A percent as a sentence prints it, four decimals at most and no padding: 0.84 → "0.84%", 1 → "1%". */
export function pctText(pct: number): string {
  return `${Number(pct.toFixed(4))}%`;
}

/** A fee rate (hundredths of a bip) as a percentage: 2500 → "0.25%". */
export function feeRateText(rate: bigint): string {
  return pctText(ratePercent(rate));
}

/**
 * What a trade on a pool costs, in the one form every surface uses: the pool's tier and
 * the pool's own creator-fee switch (`enable_creator_fee`, or `CREATOR_FEE_SWITCH` for a
 * kind of pool).
 *   - It charges a creator fee: "0.3% a trade (0.25% trade fee, 0.05% creator fee)".
 *   - The tier has a creator rate this pool does not charge: "0.25% a trade (no creator fee)".
 *   - The tier has none: "1% a trade".
 */
export function tradeCostText(config: { tradeFeeRate: bigint; creatorFeeRate: bigint }, enableCreatorFee: boolean): string {
  const cost = tradeCost(config, chargedCreatorFeeRate(config, enableCreatorFee));
  if (cost.creatorFeeRate > 0n) {
    return `${feeRateText(cost.totalRate)} a trade (${feeRateText(cost.tradeFeeRate)} trade fee, ${feeRateText(cost.creatorFeeRate)} creator fee)`;
  }
  return config.creatorFeeRate > 0n ? `${feeRateText(cost.totalRate)} a trade (no creator fee)` : `${feeRateText(cost.totalRate)} a trade`;
}

export function solText(lamports: bigint): string {
  return `${formatSol(lamports, 4)} SOL`;
}

/**
 * An amount of a pool's pairing coin, in that coin's own decimals: "1.5 SOL",
 * "250 USDC". SOL is `solText`, to the character.
 */
export function quoteText(raw: bigint, quote: QuoteCoin): string {
  return quote.native ? solText(raw) : `${formatTokenAmount(raw, quote.decimals, 4).text} ${quote.symbol}`;
}

/** "1 token = 0.025 USDC": a pool's price, or its reference, in the pool's own coin. `unit` names a listed token ("1 BAYLA"). */
export function priceText(perToken: number, quote: QuoteCoin, unit = 'token'): string {
  return `1 ${unit} = ${formatSolPrice(perToken)} ${quote.symbol}`;
}

/**
 * The same price the other way round: "1 SOL = 157,381 BAYLA", what one pairing coin buys
 * at it. `null` for a price that cannot be turned round (zero or unreadable): say it as
 * `priceText` does then.
 */
export function perCoinText(perToken: number, quote: QuoteCoin, units = 'tokens'): string | null {
  if (!Number.isFinite(perToken) || perToken <= 0) return null;
  // Thousands grouped from 1,000 up ("1,661"), so a list of them reads alike; below, as formatSolPrice.
  const amount = 1 / perToken >= 999.5 ? Math.round(1 / perToken).toLocaleString('en-US') : formatSolPrice(1 / perToken);
  return `1 ${quote.symbol} = ${amount} ${units}`;
}

/**
 * A price difference (`pool / reference - 1`) for the prices said the other way round
 * (`reference / pool - 1`): a token 1.3% below its reference buys 1.3% more of it per coin.
 */
export function turnedDiff(diff: number): number {
  return 1 / (1 + diff) - 1;
}

/**
 * How long ago a read landed, for a stamp: "just now" under 5 seconds, then "12 s ago",
 * "3 min ago", "2 h ago", "1 day ago". Cut, never rounded up: a read 59 seconds old is
 * "59 s ago", not "1 min ago", so the stamp never claims a figure is fresher than it is.
 */
export function agoText(ms: number): string {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs} s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** Dollars: whole from $1,000, cents below, "<$0.01" under a cent (the wallet's rule, lib/wallet/walletRows.ts `fmtUsd`). */
export function usdText(v: number): string {
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (v >= 0.01) return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return '<$0.01';
}

/** Token amount with its decimals, or raw base units said as such. */
export function tokenText(raw: bigint, decimals: number | null, unit = 'tokens'): string {
  const t = formatTokenAmount(raw, decimals, 4);
  return t.isBaseUnits ? `${t.text} base units` : `${t.text} ${unit}`;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
