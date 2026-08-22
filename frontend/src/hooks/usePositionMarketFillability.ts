// Buyer pre-check for the escrowed staking-position market.
//
// TegridyStaking refuses to let a second position land on an EOA
// (`AlreadyHasPosition`), and it rate-limits any position to one transfer per
// hour. Both fire on the market's release hop, i.e. underneath a buyer's
// payment. `TegridyPositionMarket.fillability` reports those conditions so a
// buyer learns about them before they sign rather than after.
//
// The part that matters here is the third return value, `certain`.
//
// For a CONTRACT recipient the staking per-holder cap of 50 positions still
// applies, and `userPositionCount` is `internal` on TegridyStaking — there is no
// way to read it. The contract therefore answers "I found nothing blocking" with
// `certain == false`, which is a statement about what it could read, not a
// prediction that the fill will land. Collapsing that into the same verdict as a
// fully-checked EOA would put a green "Buy" button on a check that was never
// completed. So the verdict type below keeps `clear` and `unverified` as
// separate cases, and `canOfferOneClickFill` is true for exactly one of them.
//
// A read that did not happen at all — market not deployed, wrong chain, RPC
// error — is `unavailable`, never `clear`.

import { useMemo } from 'react';
import { useReadContract, useChainId } from 'wagmi';
import { POSITION_MARKET_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import { POSITION_MARKET_ABI } from './usePositionMarket';

/** Mirrors `TegridyPositionMarket.Blocker`. Order is load-bearing — it is the
 *  on-chain enum's encoding, not a UI ordering. */
export const BLOCKER = {
  None: 0,
  OrderNotOpen: 1,
  ZeroRecipient: 2,
  RateLimited: 3,
  RecipientAlreadyHoldsPosition: 4,
} as const;

export type BlockerCode = (typeof BLOCKER)[keyof typeof BLOCKER];

export type FillVerdict =
  /** Nothing was read. Not a refusal and not a green light. */
  | { kind: 'unavailable'; reason: string }
  /** The chain says this fill will fail, and why. */
  | { kind: 'blocked'; code: BlockerCode; message: string; releasableAt: number | null }
  /** Every applicable condition was read and none of them blocks. */
  | { kind: 'clear'; releasableAt: number }
  /** Nothing blocking was found, but the check could not be completed. */
  | { kind: 'unverified'; message: string; releasableAt: number };

const BLOCKER_MESSAGE: Record<BlockerCode, string> = {
  [BLOCKER.None]: '',
  [BLOCKER.OrderNotOpen]:
    'This listing is no longer open — it was filled or cancelled.',
  [BLOCKER.ZeroRecipient]: 'Choose an address to receive the position.',
  [BLOCKER.RateLimited]:
    'The staking contract limits a position to one transfer per hour, and escrowing it counted as one. This listing cannot be bought yet.',
  [BLOCKER.RecipientAlreadyHoldsPosition]:
    'That wallet already holds a staking position, and the staking contract allows an address only one. Send the purchase to a wallet with no position, or to a contract wallet.',
};

const UNVERIFIED_MESSAGE =
  'The recipient is a contract. The staking contract caps any holder at 50 positions and does not expose a way to read that count, so this purchase could not be fully pre-checked. Nothing blocking was found; that is not the same as confirmed.';

/**
 * Turn the raw `fillability` tuple into a verdict.
 *
 * Exported separately from the hook so the branch that must never collapse —
 * `certain === false` staying out of `clear` — is testable without a chain.
 */
export function toFillVerdict(
  raw: readonly [number, boolean, bigint] | undefined,
  ctx: { deployed: boolean; onExpectedChain: boolean; isError: boolean; isLoading: boolean },
): FillVerdict {
  if (!ctx.deployed) {
    return { kind: 'unavailable', reason: 'The position market is not deployed yet.' };
  }
  if (!ctx.onExpectedChain) {
    return { kind: 'unavailable', reason: 'Switch to Ethereum mainnet to check this listing.' };
  }
  if (ctx.isError) {
    return {
      kind: 'unavailable',
      reason: 'The eligibility check could not be read from the chain, so it is unknown.',
    };
  }
  if (ctx.isLoading || raw === undefined) {
    return { kind: 'unavailable', reason: 'Checking eligibility…' };
  }

  const [blockerRaw, certain, releasableAtRaw] = raw;
  const releasableAt = Number(releasableAtRaw);
  const code = (Object.values(BLOCKER) as number[]).includes(blockerRaw)
    ? (blockerRaw as BlockerCode)
    : undefined;

  // An enum value this build does not know about means the deployed contract is
  // ahead of this client. Reporting it as "clear" would be inventing a reading.
  if (code === undefined) {
    return {
      kind: 'unavailable',
      reason: 'The market returned an eligibility code this app does not recognise.',
    };
  }

  if (code !== BLOCKER.None) {
    return {
      kind: 'blocked',
      code,
      message: BLOCKER_MESSAGE[code],
      releasableAt: releasableAt > 0 ? releasableAt : null,
    };
  }
  if (!certain) {
    return { kind: 'unverified', message: UNVERIFIED_MESSAGE, releasableAt };
  }
  return { kind: 'clear', releasableAt };
}

/**
 * True only when the chain confirmed every applicable condition. An `unverified`
 * verdict deliberately returns false: the buyer may still proceed, but they do it
 * from a screen that says the check was incomplete, not from a button that
 * implies it passed.
 */
export function canOfferOneClickFill(verdict: FillVerdict): boolean {
  return verdict.kind === 'clear';
}

/** Seconds until the staking rate limit clears, or 0 once it has. */
export function secondsUntilReleasable(verdict: FillVerdict, nowSeconds: number): number {
  const at =
    verdict.kind === 'clear' || verdict.kind === 'unverified'
      ? verdict.releasableAt
      : verdict.kind === 'blocked'
        ? verdict.releasableAt
        : null;
  if (at === null || at === undefined) return 0;
  return Math.max(0, at - nowSeconds);
}

export function usePositionMarketFillability(
  orderId: bigint | undefined,
  recipient: `0x${string}` | undefined,
): FillVerdict {
  const chainId = useChainId();
  const deployed = isDeployed(POSITION_MARKET_ADDRESS);
  const onExpectedChain = chainId === CHAIN_ID;
  const enabled = deployed && onExpectedChain && orderId !== undefined && recipient !== undefined;

  const { data, isError, isLoading } = useReadContract({
    address: POSITION_MARKET_ADDRESS,
    abi: POSITION_MARKET_ABI,
    functionName: 'fillability',
    args: enabled ? [orderId as bigint, recipient as `0x${string}`] : undefined,
    chainId: CHAIN_ID,
    query: { enabled, refetchInterval: 15_000 },
  });

  return useMemo(
    () =>
      toFillVerdict(data as readonly [number, boolean, bigint] | undefined, {
        deployed,
        onExpectedChain,
        isError,
        // Before a recipient is chosen there is nothing to check; that reads as
        // "not asked yet", which is an unavailable, not a pass.
        isLoading: isLoading || !enabled,
      }),
    [data, deployed, onExpectedChain, isError, isLoading, enabled],
  );
}
