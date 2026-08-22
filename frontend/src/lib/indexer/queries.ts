// GraphQL documents and response schemas for the Ponder indexer.
//
// Ground truth is indexer/ponder.schema.ts — the table names, column names and
// the generated `<table>Filter` input names all come from there, and nothing in
// this file may invent a field the schema does not define. A query naming a
// column that does not exist comes back as a GraphQL error, which this client
// correctly reports as "indexer unavailable"; that is safe but it is also a
// silent, permanent outage of a surface, so the field lists are pinned by the
// tests next to this file.
//
// Only two consumers exist so far and both read a single page. Cursor
// pagination (`after`/`before` + `pageInfo.endCursor`) is available on every
// Ponder page type and is deliberately left to whoever needs the second page.

import { z } from 'zod';
import {
  INDEXER_META_SELECTION,
  addressSchema,
  bigIntStringSchema,
  clampPageLimit,
  pageInfoSchema,
  txHashSchema,
} from './client';

/**
 * `totalCount` is omitted from every document on purpose.
 *
 * Selecting it makes Ponder run a second `count(*)` over the filtered table on
 * every request (verified in ponder 0.8's executePluralQuery). Behind a
 * rate-limited proxy that doubles the cost of a page nobody has asked to count,
 * and `pageInfo.hasNextPage` already answers the only question the UI has:
 * whether there is more.
 */
const PAGE_TAIL = 'pageInfo { hasNextPage endCursor }';

// ─── Swaps (SwapFeeRouter.SwapExecuted) ──────────────────────────────────────

export const indexedSwapSchema = z.object({
  id: z.string(),
  user: addressSchema,
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  amountIn: bigIntStringSchema,
  fee: bigIntStringSchema,
  timestamp: bigIntStringSchema,
  txHash: txHashSchema,
});

export type IndexedSwap = z.infer<typeof indexedSwapSchema>;

export const indexedSwapsDataSchema = z.object({
  swaps: z.object({
    items: z.array(indexedSwapSchema),
    pageInfo: pageInfoSchema,
  }),
});

/**
 * `$where` is non-null on the variable even though the argument is nullable.
 *
 * Ponder's where-builder does `Object.entries(where)` after an
 * `=== undefined` guard, so an explicit `null` throws inside the server and
 * comes back as a 500 — an unfiltered query must send `{}`, never null. The
 * non-null variable type makes that a build-time property of the document
 * rather than a convention someone has to remember.
 */
export const INDEXED_SWAPS_QUERY = `query IndexedSwaps($limit: Int!, $where: swapFilter!) {
  swaps(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: $limit) {
    items { id user tokenIn tokenOut amountIn fee timestamp txHash }
    ${PAGE_TAIL}
  }
  ${INDEXER_META_SELECTION}
}`;

export interface IndexedSwapsFilter {
  /** Restrict to one trader. Omit for the venue-wide feed. */
  user?: string;
}

export function indexedSwapsVariables(
  filter: IndexedSwapsFilter,
  limit: number,
): { limit: number; where: Record<string, unknown> } {
  const where: Record<string, unknown> = {};
  // Ponder's `t.hex()` columns are stored lowercased and drizzle lowercases
  // bound parameters through the same column type, so a checksummed address
  // would in fact match. Lowercasing here anyway: the failure mode if that ever
  // changes is an empty page, which reads as "this wallet has never traded" —
  // a false statement about somebody's wallet, produced by a casing detail.
  if (filter.user) where.user = filter.user.toLowerCase();
  return { limit: clampPageLimit(limit), where };
}

// ─── Staking history (TegridyStaking position lifecycle) ─────────────────────

/**
 * Every `type` value src/index.ts writes, as of 2026-08-18.
 *
 * The row schema does NOT enforce this list. A strict enum would reject the
 * whole page the first time the indexer learns a new action type, taking a
 * working history offline over an unknown string; an unrecognised type is not
 * corrupt data, it is data this build has not been taught to label. Addresses
 * and amounts stay strict because a malformed one of those IS corrupt.
 */
export const STAKING_ACTION_TYPES = [
  'stake',
  'withdraw',
  'earlyWithdraw',
  'transfer',
  'claim',
  'extend',
  'increase',
] as const;

export type StakingActionType = (typeof STAKING_ACTION_TYPES)[number];

export function isKnownStakingActionType(type: string): type is StakingActionType {
  return (STAKING_ACTION_TYPES as readonly string[]).includes(type);
}

/**
 * `transfer` rows record the position NFT changing wallets and carry
 * `amount: 0`. They are custody changes, not flows — summing `amount` across
 * types is safe, but counting rows as "actions taken" is not.
 */
export function isStakingFlowAction(type: string): boolean {
  return type !== 'transfer';
}

export const indexedStakingActionSchema = z.object({
  id: z.string(),
  user: addressSchema,
  tokenId: bigIntStringSchema,
  type: z.string(),
  amount: bigIntStringSchema,
  /** Set only on `earlyWithdraw` rows — the slashing penalty actually charged. */
  penalty: bigIntStringSchema.nullable(),
  timestamp: bigIntStringSchema,
  txHash: txHashSchema,
});

export type IndexedStakingAction = z.infer<typeof indexedStakingActionSchema>;

export const indexedStakingHistoryDataSchema = z.object({
  stakingActions: z.object({
    items: z.array(indexedStakingActionSchema),
    pageInfo: pageInfoSchema,
  }),
});

export const INDEXED_STAKING_HISTORY_QUERY = `query IndexedStakingHistory($limit: Int!, $where: stakingActionFilter!) {
  stakingActions(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: $limit) {
    items { id user tokenId type amount penalty timestamp txHash }
    ${PAGE_TAIL}
  }
  ${INDEXER_META_SELECTION}
}`;

export interface IndexedStakingHistoryFilter {
  /** Restrict to one staker. Omit for the protocol-wide history. */
  user?: string;
  /** Restrict to one position NFT. */
  tokenId?: bigint;
}

export function indexedStakingHistoryVariables(
  filter: IndexedStakingHistoryFilter,
  limit: number,
): { limit: number; where: Record<string, unknown> } {
  const where: Record<string, unknown> = {};
  if (filter.user) where.user = filter.user.toLowerCase();
  // Ponder's BigInt scalar coerces a variable with `BigInt(value)`, so a JSON
  // number would be accepted and would silently lose precision above 2^53.
  // uint256 travels as a decimal string.
  if (filter.tokenId !== undefined) where.tokenId = filter.tokenId.toString();
  return { limit: clampPageLimit(limit), where };
}
