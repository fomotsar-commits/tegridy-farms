import { formatSol, formatTokenAmount } from '../../launcher/solana/curve/format';
import { ratePercent } from '../cpswap/math';
import { chargedCreatorFeeRate, tradeCost } from '../cpswap/venue';
import type { QuoteCoin } from './quotes';

/** Display helpers for the LP pages. Numbers that ride a transaction never pass through here. */

/**
 * A price written out (never scientific notation), four significant digits. The unit is
 * the caller's: SOL per token for a SOL pool, the pool's own pairing coin otherwise
 * (`priceText` adds it).
 */
export function formatSolPrice(v: number): string {
  if (!Number.isFinite(v) || v < 0) return 'unreadable';
  if (v === 0) return '0';
  if (v >= 1e9) return Math.round(v).toString();
  if (v < 0.000001) {
    const digits = Math.min(100, 3 - Math.floor(Math.log10(v)));
    return v.toFixed(digits).replace(/0+$/, '');
  }
  const s = v.toPrecision(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** A fee rate (hundredths of a bip) as a percentage: 2500 → "0.25%". */
export function feeRateText(rate: bigint): string {
  return `${Number(ratePercent(rate).toFixed(4))}%`;
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

/** "1 token = 0.025 USDC": a pool's price, or its reference, in the pool's own coin. */
export function priceText(perToken: number, quote: QuoteCoin): string {
  return `1 token = ${formatSolPrice(perToken)} ${quote.symbol}`;
}

/** Token amount with its decimals, or raw base units said as such. */
export function tokenText(raw: bigint, decimals: number | null, unit = 'tokens'): string {
  const t = formatTokenAmount(raw, decimals, 4);
  return t.isBaseUnits ? `${t.text} base units` : `${t.text} ${unit}`;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
