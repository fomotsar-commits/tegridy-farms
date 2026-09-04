// The tokens a follow may be denominated in, and why the list is closed.
//
// A cap like "at most 0.25 of this token per mirror" has to be converted to the
// token's smallest unit, and that conversion needs the token's decimals. There
// is no decimals column on any indexed row and none on a GeckoTerminal trade, so
// the only honest sources are a live `decimals()` read or a table of tokens whose
// value is already known here. Guessing 18 is the third option and it is the one
// that silently sizes a mirror a million times too large on a 6-decimal token.
//
// This build takes the table. It is short because the venue's own router pairs
// are short, and a wallet that wants to follow a leader on some other quote asset
// gets a surface that says so rather than a control that quietly mis-sizes.
//
// lib/competitions reads this table too — a season is denominated in one of these
// tokens for the same reason a follow is, and two tables would be two chances for
// a decimals value to be wrong in only one place.
//
// ─── THE TABLE IS PER NETWORK, NOT PER SYMBOL ────────────────────────────────
//
// WETH on Ethereum and WETH on Base are two different contracts with one symbol.
// A table keyed on the symbol would let a cap entered against one chain size a
// trade on the other, which is the failure this whole module exists to prevent —
// so every entry carries its own network, every label says which chain it means,
// and a follow is refused when its quote token and the pool's are not the same
// entry. The Base row comes from the chain registry rather than a literal, so
// there is one place in this app that decides what Base's WETH9 is; when the
// registry has none, THERE IS NO BASE ROW and a Base follow simply cannot be
// created. That is the fail-closed direction.

import { TOWELI_ADDRESS, TOWELI_DECIMALS, WETH_ADDRESS } from '../constants';
import { contractOn } from '../chains/registry';
import { SOL_MINT } from '../solana';
import type { GeckoNetwork } from '../geckoTerminal/pools';
import type { PoolFamily } from './tape';

export interface QuoteToken {
  /** Lowercased address on EVM; the exact base58 mint on Solana. */
  address: string;
  symbol: string;
  decimals: number;
  network: GeckoNetwork;
  family: PoolFamily;
  /** What a control prints. Chain-qualified wherever the symbol alone is ambiguous. */
  label: string;
}

/** Base mainnet. The chain registry owns the WETH9 address; this never hardcodes it. */
const BASE_CHAIN_ID = 8453;

function baseWethRow(): QuoteToken | null {
  const weth = contractOn(BASE_CHAIN_ID, 'weth');
  if (weth.status !== 'deployed') return null;
  return {
    address: weth.address.toLowerCase(),
    symbol: 'WETH',
    decimals: 18,
    network: 'base',
    family: 'evm',
    label: 'WETH (Base)',
  };
}

export const QUOTE_TOKENS: readonly QuoteToken[] = [
  {
    address: WETH_ADDRESS.toLowerCase(),
    symbol: 'WETH',
    decimals: 18,
    network: 'eth',
    family: 'evm',
    label: 'WETH (Ethereum)',
  },
  {
    address: TOWELI_ADDRESS.toLowerCase(),
    symbol: 'TOWELI',
    decimals: TOWELI_DECIMALS,
    network: 'eth',
    family: 'evm',
    label: 'TOWELI (Ethereum)',
  },
  ...(baseWethRow() === null ? [] : [baseWethRow()!]),
  {
    // Wrapped SOL. 9 decimals, like native SOL.
    address: SOL_MINT,
    symbol: 'SOL',
    decimals: 9,
    network: 'solana',
    family: 'solana',
    label: 'SOL (Solana)',
  },
];

export const DEFAULT_QUOTE_TOKEN = QUOTE_TOKENS[0]!;

/** The quote tokens usable on one venue family. Drives the form's own filtering. */
export function quoteTokensForFamily(family: PoolFamily): QuoteToken[] {
  return QUOTE_TOKENS.filter((t) => t.family === family);
}

/**
 * Look up a quote token by address.
 *
 * EVM addresses compare case-insensitively; base58 compares EXACTLY, because a
 * lowercased mint is a different, valid-looking, wrong address. Doing both with
 * one `.toLowerCase()` is the bug that would make SOL un-findable.
 */
export function findQuoteToken(address: string): QuoteToken | null {
  const raw = address.trim();
  const lower = raw.toLowerCase();
  return (
    QUOTE_TOKENS.find((t) => (t.family === 'solana' ? t.address === raw : t.address === lower)) ?? null
  );
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
  return `${trimTrailingZeros(fixedPoint(amount, token.decimals))} ${token.label}`;
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

/**
 * Drop fractional digits past `decimals`. NEVER rounds, never rounds up.
 *
 * FOR UPSTREAM AMOUNTS ONLY. GeckoTerminal returns a leader's leg with more
 * precision than the token has — "0.500000000000000000123" — and
 * `parseQuoteAmount` correctly refuses it, because a USER who types too many
 * digits must be told rather than silently corrected. A leader's amount is not
 * the user's typing: refusing it would drop a real fill out of the queue over an
 * upstream formatting detail. Truncation (not rounding) means the sized mirror
 * is never larger than the leg it was derived from.
 */
export function truncateToDecimals(input: string, decimals: number): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const dot = trimmed.indexOf('.');
  if (dot < 0) return trimmed;
  if (decimals <= 0) return trimmed.slice(0, dot);
  const kept = trimmed.slice(dot + 1, dot + 1 + decimals);
  return kept.length === 0 ? trimmed.slice(0, dot) : `${trimmed.slice(0, dot)}.${kept}`;
}
