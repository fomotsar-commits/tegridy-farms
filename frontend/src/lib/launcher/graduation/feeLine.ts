// The launcher's own fee line, read rather than claimed.
//
// `LockerClaimer` (0xD2Ac…E6C7) has been deployed and Etherscan-verified since 2026-08-01
// and is already named as the protocol beneficiary by `launchService.protocolFeeSink()`.
// Nothing in the app has ever READ it, so the 15% line existed as a number on a fact
// sheet with no surface able to say whether a single wei had ever been credited to it.
// This module is that read.
//
// ## What is readable and what is not
//
// The locker is PULL-based and self-addressed: `distributeFees(tokenId)` CREDITS
// `beneficiariesClaims[beneficiary][currency]`, and the money moves only when the
// beneficiary itself calls `releaseFees(tokenId)`. Two consequences shape this module:
//
//  1. The credit is a per-(beneficiary, currency) TOTAL, not per-position. Reading it for
//     the LockerClaimer tells you what is owed to the protocol across every position —
//     which is the number that matters — but it cannot be attributed to a launch here.
//  2. Releasing needs a tokenId, and no token -> position-tokenId index exists (see the
//     lockerStream header: the locker's own Lock event shape cannot be verified today).
//     So this module is READ-ONLY BY CONSTRUCTION. It exposes no claim path, and the
//     surface above it must not offer one it cannot honestly build.
//
// ## Why a zero here is not "no revenue"
//
// A credit appears only after someone calls `distributeFees` for a position. Zero
// therefore means "nothing has been distributed to us yet", which is also what an
// un-graduated rail reads as. Callers must render that sentence, not "no fees earned" —
// {@link feeLineStatement} produces it so the wording cannot drift per surface.

import type { Address } from 'viem';
import { LOCKER_CLAIMER_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, TREASURY_ADDRESS, isDeployed } from '../../constants';
import { DOPPLER_MAINNET } from '../doppler.constants';
import { LOCKER_V1_ABI, readBeneficiaryClaim, type LockerReadClient } from '../lockerStream';

/**
 * The three immutable destinations `LockerClaimer` was constructed with.
 *
 * Read from the contract, never assumed: the whole trust argument for this sink is
 * "check the constructor args once, because there is no setter". A surface that prints
 * the destinations from repo constants is printing what we believe, not what is deployed.
 */
export const LOCKER_CLAIMER_ABI = [
  { type: 'function', name: 'locker', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'function',
    name: 'revenueDistributor',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

export interface SinkDestinations {
  locker: Address;
  /** Where a claimed native-ETH leg goes. */
  revenueDistributor: Address;
  /** Where a claimed ERC20 leg goes — RevenueDistributor distributes ETH only. */
  treasury: Address;
}

export interface FeeCredit {
  currency: Address;
  amount: bigint;
}

export interface FeeLineRead {
  /** The beneficiary address the protocol's share is named to. */
  sink: Address;
  /** False when the sink constant is the zero address — the fee line has no holder at all. */
  sinkConfigured: boolean;
  /** Read back from the deployed contract. Null when the read did not land. */
  destinations: SinkDestinations | null;
  /**
   * True when the destination read failed. Distinct from `destinations: null` meaning
   * "there is nothing there" — this surface has no such case, but keeping the flag makes
   * the distinction explicit for consumers that pattern-match on null.
   */
  destinationsUnreadable: boolean;
  /**
   * True iff the deployed `locker()` equals the locker our launches actually graduate
   * into. Null when destinations could not be read. A false here means the fee line
   * points at a locker no launch of ours funds — a silent zero forever.
   */
  pointsAtOurLocker: boolean | null;
  /** Non-zero credits only. An empty array with an empty `unreadable` is a genuine zero. */
  credits: FeeCredit[];
  /** How many currencies were queried, so an empty state can say what it checked. */
  checkedCount: number;
  /** Currencies whose credit could not be read. Any entry makes `credits` incomplete. */
  unreadable: Address[];
}

/**
 * Read what the protocol's fee sink has been credited on the graduated-pool locker.
 *
 * `currencies` is caller-supplied because a locker position carries two of them and the
 * asset side is per-launch: the caller (the hook) enumerates base pairs plus known launch
 * assets exactly as the integrator-fee path does. Passing an empty list is legal and
 * yields `checkedCount: 0`, which callers must render as "nothing was checked".
 *
 * Never throws. A failed credit read lands in `unreadable`; a failed destination read
 * leaves `destinations` null with `destinationsUnreadable` set.
 */
export async function readFeeLine(
  client: LockerReadClient,
  currencies: readonly Address[],
  sink: Address = LOCKER_CLAIMER_ADDRESS,
): Promise<FeeLineRead> {
  const sinkConfigured = isDeployed(sink);

  let destinations: SinkDestinations | null = null;
  if (sinkConfigured) {
    try {
      const [locker, revenueDistributor, treasury] = await Promise.all([
        client.readContract({ address: sink, abi: LOCKER_CLAIMER_ABI, functionName: 'locker' }),
        client.readContract({ address: sink, abi: LOCKER_CLAIMER_ABI, functionName: 'revenueDistributor' }),
        client.readContract({ address: sink, abi: LOCKER_CLAIMER_ABI, functionName: 'treasury' }),
      ]);
      if (isAddressLike(locker) && isAddressLike(revenueDistributor) && isAddressLike(treasury)) {
        destinations = {
          locker: locker as Address,
          revenueDistributor: revenueDistributor as Address,
          treasury: treasury as Address,
        };
      }
    } catch {
      destinations = null;
    }
  }

  const credits: FeeCredit[] = [];
  const unreadable: Address[] = [];
  if (sinkConfigured) {
    for (const currency of currencies) {
      // Reads `beneficiariesClaims[sink][currency]` — an auto-generated mapping getter, so
      // an unknown key returns zero rather than reverting. Null is transport failure only.
      const amount = await readBeneficiaryClaim(client, sink, currency, lockerFor(destinations));
      if (amount === null) unreadable.push(currency);
      else if (amount > 0n) credits.push({ currency, amount });
    }
  }

  return {
    sink,
    sinkConfigured,
    destinations,
    destinationsUnreadable: sinkConfigured && destinations === null,
    pointsAtOurLocker: destinations
      ? destinations.locker.toLowerCase() === DOPPLER_MAINNET.support.streamableFeesLocker.toLowerCase()
      : null,
    credits,
    checkedCount: sinkConfigured ? currencies.length : 0,
    unreadable,
  };
}

/**
 * The locker to query credits on: the one the sink itself names when we could read it,
 * falling back to the locker our launches graduate into. Querying a locker the sink is
 * NOT a beneficiary of would read a truthful zero about the wrong contract.
 */
function lockerFor(destinations: SinkDestinations | null): Address {
  return destinations?.locker ?? DOPPLER_MAINNET.support.streamableFeesLocker;
}

function isAddressLike(v: unknown): v is Address {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * Who is able to move this fee line, stated as contract facts rather than as policy.
 *
 * Pure and exported so the wording is asserted once in tests instead of being retyped
 * into every surface. Note the second sentence: the read side is live and the release
 * side is not, and conflating them is how a "claimable" number becomes a promise.
 */
export function claimAuthorityStatement(): string {
  return (
    'Releasing is permissionless — LockerClaimer.claim(tokenId) can be called by anyone, and the proceeds go only to the addresses fixed in its constructor. ' +
    'No claim is offered here: releasing requires the locker position id, and no token-to-position index exists in this app, so this surface is read-only.'
  );
}

/**
 * The honest one-line summary of a fee-line read. Centralised so "we could not look" and
 * "we looked and it was zero" cannot be collapsed into one sentence by a careless surface.
 */
export function feeLineStatement(read: FeeLineRead): string {
  if (!read.sinkConfigured) {
    return 'No protocol fee sink is configured, so the launcher’s share of graduated-pool fees has no holder.';
  }
  if (read.unreadable.length > 0 && read.credits.length === 0) {
    return `Could not read ${read.unreadable.length === read.checkedCount ? 'any' : `${read.unreadable.length} of ${read.checkedCount}`} credited balance${read.unreadable.length === 1 ? '' : 's'}. This is an unknown, not a zero.`;
  }
  if (read.credits.length === 0) {
    return `Checked ${read.checkedCount} ${read.checkedCount === 1 ? 'currency' : 'currencies'}; every one read back zero. Credits appear only after a graduated position’s fees are distributed, so zero here means nothing has been distributed to this sink yet — not that no fee is owed.`;
  }
  const partial =
    read.unreadable.length > 0
      ? ` ${read.unreadable.length} of ${read.checkedCount} balances could not be read, so this list is incomplete.`
      : '';
  return `${read.credits.length} credited ${read.credits.length === 1 ? 'balance' : 'balances'} on the locker, awaiting release.${partial}`;
}

/** The repo's expectation for the sink's destinations, for a read-back comparison. */
export const EXPECTED_SINK_DESTINATIONS = {
  locker: DOPPLER_MAINNET.support.streamableFeesLocker as Address,
  revenueDistributor: REVENUE_DISTRIBUTOR_ADDRESS as Address,
  treasury: TREASURY_ADDRESS as Address,
} as const;

/** The ABI a caller needs if it wants to read the locker directly. Re-exported so a
 *  consumer of this module never has to reach into lockerStream for it. */
export { LOCKER_V1_ABI };
