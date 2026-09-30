import { formatSol, formatTokenAmount } from '../../launcher/solana/curve/format';
import { ratePercent } from '../cpswap/math';

/** Display helpers for the LP pages. Numbers that ride a transaction never pass through here. */

/** A SOL-per-token price written out (never scientific notation), four significant digits. */
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

export function solText(lamports: bigint): string {
  return `${formatSol(lamports, 4)} SOL`;
}

/** Token amount with its decimals, or raw base units said as such. */
export function tokenText(raw: bigint, decimals: number | null, unit = 'tokens'): string {
  const t = formatTokenAmount(raw, decimals, 4);
  return t.isBaseUnits ? `${t.text} base units` : `${t.text} ${unit}`;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
