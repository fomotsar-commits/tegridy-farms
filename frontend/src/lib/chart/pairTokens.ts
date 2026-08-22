// Which leg of an indexed pair is the money, and how many decimals each has.
//
// This is the gate that stops the chart from drawing a confident axis over a
// price it cannot compute. Two separate facts have to be established before a
// single candle is legitimate, and neither of them is indexed:
//
//   1. DECIMALS. `pair_event` stores raw uint256 legs. A pair whose counter
//      token has 6 decimals, priced as though it had 18, produces a chart that
//      is wrong by 1e12 and looks entirely normal. There is no on-chain read on
//      this path to fall back to, so an unknown token is a refusal.
//   2. ORIENTATION. token0/token1 are the pool's own ordering, not a statement
//      about which side is the quote. Reading them the wrong way round yields
//      the reciprocal — again a plausible chart of a price that is not the price.
//
// The venue side is the quote because that is the number a trader is actually
// asking for ("what is this worth in ETH"), and WETH outranks TOWELI when a
// pool holds both, for the same reason.

import { DEFAULT_TOKENS, type TokenInfo } from '../tokenList';
import { TOWELI_ADDRESS, WETH_ADDRESS } from '../constants';
import type { PairPricing } from './pairSwaps';

/**
 * Quote candidates in preference order.
 *
 * Mirrors VENUE_TOKENS in pages/TerminalPage.tsx, which is the same question
 * asked of the same indexer allowlist — the indexer only tracks pairs with one
 * of these on a leg (indexer/ponder.schema.ts `indexed_pair`).
 */
export const QUOTE_PREFERENCE: readonly string[] = [WETH_ADDRESS, TOWELI_ADDRESS];

const BY_ADDRESS = new Map<string, TokenInfo>(
  DEFAULT_TOKENS.filter((t) => !t.isNative).map((t) => [t.address.toLowerCase(), t]),
);

export interface ResolvedPairTokens {
  ok: true;
  pricing: PairPricing;
  base: { address: string; symbol: string; decimals: number };
  quote: { address: string; symbol: string; decimals: number };
}

export interface UnresolvedPairTokens {
  ok: false;
  /** Written for a reader, not a log: it names the address and the consequence. */
  reason: string;
}

export type PairTokenResolution = ResolvedPairTokens | UnresolvedPairTokens;

function lookup(address: string): TokenInfo | null {
  return BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

export function resolvePairTokens(token0: string, token1: string): PairTokenResolution {
  const info0 = lookup(token0);
  const info1 = lookup(token1);

  const unknown: string[] = [];
  if (!info0) unknown.push(token0);
  if (!info1) unknown.push(token1);
  if (unknown.length > 0) {
    return {
      ok: false,
      reason:
        `This build has no decimals for ${unknown.join(' and ')}, and the indexer does not store them. ` +
        'A price computed from raw amounts without them would be wrong by an unknown power of ten, so no chart is drawn.',
    };
  }

  const preference = QUOTE_PREFERENCE.map((a) => a.toLowerCase());
  const rank0 = preference.indexOf(info0!.address.toLowerCase());
  const rank1 = preference.indexOf(info1!.address.toLowerCase());

  if (rank0 === -1 && rank1 === -1) {
    return {
      ok: false,
      reason:
        'Neither leg of this pair is a venue quote token, so there is no side to price the other in. ' +
        'The indexer should not be tracking it at all — see the allowlist in indexer/ponder.schema.ts.',
    };
  }

  // Both legs are venue tokens (a TOWELI/WETH pool): the earlier entry in
  // QUOTE_PREFERENCE wins, so the pool is always read the same way round rather
  // than flipping with whatever order the factory happened to assign.
  const quoteIsToken1 = rank1 !== -1 && (rank0 === -1 || rank1 < rank0);

  const quoteInfo = quoteIsToken1 ? info1! : info0!;
  const baseInfo = quoteIsToken1 ? info0! : info1!;

  return {
    ok: true,
    pricing: {
      base: quoteIsToken1 ? 'token0' : 'token1',
      token0Decimals: info0!.decimals,
      token1Decimals: info1!.decimals,
    },
    base: { address: baseInfo.address, symbol: baseInfo.symbol, decimals: baseInfo.decimals },
    quote: { address: quoteInfo.address, symbol: quoteInfo.symbol, decimals: quoteInfo.decimals },
  };
}
