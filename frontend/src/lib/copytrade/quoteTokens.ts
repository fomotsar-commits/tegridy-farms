// The tokens a follow may be denominated in, and why the list is closed.
//
// A cap like "at most 0.25 of this token per mirror" has to be converted to the
// token's smallest unit, and that conversion needs the token's decimals. There
// is no decimals column on any indexed row, so the only honest sources are a
// live `decimals()` read or a table of tokens whose value is already known here.
// Guessing 18 is the third option and it is the one that silently sizes a mirror
// a million times too large on a 6-decimal token.
//
// This build takes the table. It is short because the venue's own router pairs
// are short, and a wallet that wants to follow a leader on some other quote asset
// gets a surface that says so rather than a control that quietly mis-sizes.
//
// lib/competitions reads this table too — a season is denominated in one of these
// tokens for the same reason a follow is, and two tables would be two chances for
// a decimals value to be wrong in only one place.

import { TOWELI_ADDRESS, TOWELI_DECIMALS, WETH_ADDRESS } from '../constants';

export interface QuoteToken {
  /** Lowercased address — the form every comparison in this slice uses. */
  address: string;
  symbol: string;
  decimals: number;
}

export const QUOTE_TOKENS: readonly QuoteToken[] = [
  { address: WETH_ADDRESS.toLowerCase(), symbol: 'WETH', decimals: 18 },
  { address: TOWELI_ADDRESS.toLowerCase(), symbol: 'TOWELI', decimals: TOWELI_DECIMALS },
];

export const DEFAULT_QUOTE_TOKEN = QUOTE_TOKENS[0]!;

export function findQuoteToken(address: string): QuoteToken | null {
  const key = address.toLowerCase();
  return QUOTE_TOKENS.find((t) => t.address === key) ?? null;
}

/**
 * Render an amount in a quote token, or say it cannot be rendered.
 *
 * Returns the raw smallest-unit integer plus the token's own address when the
 * token is not in the table. That is deliberately ugly: an unlabelled number is
 * useless to read but it is not WRONG, whereas the same digits with an assumed
 * decimal point are a different quantity presented as this one.
 */
export function formatQuoteAmount(amount: bigint, address: string): string {
  const token = findQuoteToken(address);
  if (!token) return `${amount.toString()} (smallest unit of ${address})`;
  return `${trimTrailingZeros(fixedPoint(amount, token.decimals))} ${token.symbol}`;
}

/**
 * Integer → fixed-point string, without going through Number.
 *
 * `Number(wei) / 1e18` is the usual shortcut and it loses precision above 2^53,
 * which for an 18-decimal token starts at about 9 units — well inside the range
 * of a real trade.
 */
function fixedPoint(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed.length === 0 ? '0' : trimmed;
}

/**
 * A decimal string typed by a user → smallest units, or null.
 *
 * Null on anything that is not a plain non-negative decimal, including a value
 * with more fractional digits than the token has. Rounding that off would accept
 * "0.1234567890123456789" for an 18-decimal token and silently place a cap the
 * user did not type.
 */
export function parseQuoteAmount(input: string, address: string): bigint | null {
  const token = findQuoteToken(address);
  if (!token) return null;
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > token.decimals) return null;
  const padded = fraction.padEnd(token.decimals, '0');
  const value = BigInt(`${whole}${padded}`);
  return value;
}
