// Everything ReferralSplitter knows about one wallet as a REFERRER.
//
// This hook exists because `useRevenueStats` answers the easy half. It reads
// `getReferralInfo` and `pendingETH` and renders them, which is correct as far
// as it goes — but the three facts that decide whether those numbers will ever
// be non-zero are not read anywhere in the app:
//
//   1. `setupComplete` — false makes recordFee and claimReferralRewards revert.
//   2. voting power vs `MIN_REFERRAL_STAKE_POWER` — below it, a referee's carve
//      is added to `accumulatedTreasuryETH` and the referrer gets nothing, with
//      no on-chain signal to the referrer that it happened.
//   3. `referrerRegisteredAt + MIN_REFERRAL_AGE` — a 7-day lock during which
//      `claimReferralRewards` reverts `ReferralAgeTooRecent` even with a
//      non-zero balance.
//
// Without those, a disqualified referrer and a referrer with no referees render
// identically: three zeroes and a Claim button. One of them is being told the
// truth.
//
// ─── FAILED READS ARE NULL, NEVER ZERO ───────────────────────────────────────
//
// `useReadContracts` reports per-entry `status`, and every extraction below maps
// `failure` to `null` rather than to a default. `lib/referrals/qualification.ts`
// turns any null into an `unknown` verdict. That is the whole honesty chain: an
// RPC failure must not be able to produce the sentence "you do not qualify".

import { useMemo } from 'react';
import { useAccount, useBlock, useReadContracts } from 'wagmi';
import { REFERRAL_SPLITTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { REFERRAL_SPLITTER_FULL_ABI, VOTING_POWER_ABI } from '../lib/referrals/splitterAbi';
import {
  evaluateClaim,
  evaluateEarn,
  type ClaimVerdict,
  type EarnVerdict,
  type StandingInputs,
} from '../lib/referrals/qualification';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Matches the cadence of useRevenueStats so the two panels do not disagree. */
const REFETCH_MS = 30_000;

export interface ReferralStanding {
  /** True while the first round of reads is in flight and no verdict exists. */
  isLoading: boolean;
  /** Can this wallet earn on its referees' fees right now? */
  earn: EarnVerdict;
  /** Can it claim, and how much exactly? */
  claim: ClaimVerdict;
  /**
   * Referee count from `getReferralInfo`, or null when that read failed.
   *
   * Null and 0 are separate on purpose all the way to the render: "no-one has
   * used your link" is a fact about the wallet, and "we could not ask" is not.
   */
  referredCount: number | null;
  /** Lifetime `totalEarned`, in wei. Null when the read failed. */
  lifetimeEarnedWei: bigint | null;
  /** Lifetime `totalForfeited`, in wei — credits routed to treasury after a
   *  ban or an inactivity forfeit. Null when the read failed. */
  forfeitedWei: bigint | null;
  /** Current `referralFeeBps`, timelock-changeable. Null when the read failed. */
  referralFeeBps: number | null;
  /** The raw predicate inputs, exposed so a test can pin the mapping. */
  inputs: StandingInputs;
  refetch: () => void;
}

export function useReferralStanding(): ReferralStanding {
  const { address } = useAccount();
  const wallet = address ?? ZERO_ADDRESS;
  const enabled = !!address;

  const splitter = {
    address: REFERRAL_SPLITTER_ADDRESS,
    abi: REFERRAL_SPLITTER_FULL_ABI,
    chainId: CHAIN_ID,
  } as const;

  // Round 1: everything readable without knowing which staking contracts the
  // splitter points at. `stakingContract` / `restakingContract` come back here
  // and feed round 2 — the splitter's own pointers are the authority, not the
  // frontend's address constants, because a one-shot `setRestakingContract`
  // can land on the live deployment without a frontend release.
  const {
    data: base,
    refetch: refetchBase,
    isLoading: baseLoading,
  } = useReadContracts({
    contracts: [
      { ...splitter, functionName: 'setupComplete' },
      { ...splitter, functionName: 'MIN_REFERRAL_STAKE_POWER' },
      { ...splitter, functionName: 'referralFeeBps' },
      { ...splitter, functionName: 'stakingContract' },
      { ...splitter, functionName: 'restakingContract' },
      { ...splitter, functionName: 'bannedReferrers', args: [wallet] },
      { ...splitter, functionName: 'referrerRegisteredAt', args: [wallet] },
      { ...splitter, functionName: 'pendingETH', args: [wallet] },
      { ...splitter, functionName: 'getReferralInfo', args: [wallet] },
      { ...splitter, functionName: 'totalForfeited', args: [wallet] },
    ],
    query: { enabled, refetchInterval: REFETCH_MS, refetchOnWindowFocus: true },
  });

  function big(i: number): bigint | null {
    const entry = base?.[i];
    return entry?.status === 'success' ? (entry.result as bigint) : null;
  }
  function bool(i: number): boolean | null {
    const entry = base?.[i];
    return entry?.status === 'success' ? (entry.result as boolean) : null;
  }
  function addr(i: number): `0x${string}` | null {
    const entry = base?.[i];
    return entry?.status === 'success' ? (entry.result as `0x${string}`) : null;
  }

  const setupComplete = bool(0);
  const threshold = big(1);
  const feeBpsRaw = big(2);
  const stakingContract = addr(3);
  const restakingContract = addr(4);
  const banned = bool(5);
  const registeredAt = big(6);
  const pending = big(7);
  const info = base?.[8]?.status === 'success' ? (base[8].result as readonly [bigint, bigint, bigint]) : null;
  const forfeitedWei = big(9);

  // Round 2. Two separate reads rather than a sum computed anywhere else: the
  // contract adds staking-side and restaking-side power, and this mirrors that
  // addition with both operands read from chain.
  const hasStaking = !!stakingContract && stakingContract !== ZERO_ADDRESS;
  const hasRestaking = !!restakingContract && restakingContract !== ZERO_ADDRESS;

  const { data: powerData, refetch: refetchPower } = useReadContracts({
    contracts: [
      ...(hasStaking
        ? [{ address: stakingContract, abi: VOTING_POWER_ABI, functionName: 'votingPowerOf', args: [wallet], chainId: CHAIN_ID } as const]
        : []),
      ...(hasRestaking
        ? [{ address: restakingContract, abi: VOTING_POWER_ABI, functionName: 'votingPowerOf', args: [wallet], chainId: CHAIN_ID } as const]
        : []),
    ],
    query: { enabled: enabled && (hasStaking || hasRestaking), refetchInterval: REFETCH_MS },
  });

  // `stakingContract` is `immutable` and can never be the zero address (the
  // constructor reverts ZeroAddress), so a zero here means the pointer read
  // failed — which is not a claim that this wallet has no staking power.
  let stakingPower: bigint | null;
  if (stakingContract === null) {
    stakingPower = null;
  } else if (!hasStaking) {
    stakingPower = null;
  } else {
    const e = powerData?.[0];
    stakingPower = e?.status === 'success' ? (e.result as bigint) : null;
  }

  // The restaking pointer being unset IS a determinate answer: the contract's
  // `_votingPowerOf` skips the call entirely, so the restaking contribution is
  // exactly zero and the verdict stays computable.
  let restakingPower: bigint | null;
  if (restakingContract === null) {
    restakingPower = null;
  } else if (!hasRestaking) {
    restakingPower = 0n;
  } else {
    const e = powerData?.[hasStaking ? 1 : 0];
    restakingPower = e?.status === 'success' ? (e.result as bigint) : null;
  }

  // Chain time, not wall clock. The 7-day claim lock is evaluated against
  // `block.timestamp` inside the contract, and a client clock that is minutes
  // fast would render "claim now" onto a call that still reverts.
  const { data: block, refetch: refetchBlock } = useBlock({
    chainId: CHAIN_ID,
    query: { enabled, refetchInterval: REFETCH_MS },
  });
  const nowSeconds = typeof block?.timestamp === 'bigint' ? block.timestamp : null;

  const inputs = useMemo<StandingInputs>(
    () => ({
      threshold,
      stakingPower,
      restakingPower,
      banned,
      setupComplete,
      pending,
      registeredAt,
      nowSeconds,
    }),
    [threshold, stakingPower, restakingPower, banned, setupComplete, pending, registeredAt, nowSeconds],
  );

  const earn = useMemo(() => evaluateEarn(inputs), [inputs]);
  const claim = useMemo(() => evaluateClaim(inputs), [inputs]);

  return {
    isLoading: enabled && baseLoading,
    earn,
    claim,
    referredCount: info ? Number(info[0]) : null,
    lifetimeEarnedWei: info ? info[1] : null,
    forfeitedWei,
    referralFeeBps: feeBpsRaw === null ? null : Number(feeBpsRaw),
    inputs,
    refetch: () => {
      void refetchBase();
      void refetchPower();
      void refetchBlock();
    },
  };
}
