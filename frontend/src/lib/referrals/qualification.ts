// Can this wallet actually earn a referral fee, and can it claim what it has?
//
// ─── WHY THIS EXISTS AS A SEPARATE, PURE MODULE ──────────────────────────────
//
// ReferralSplitter has a threshold nobody sees until it has already cost them.
// `recordFee` credits a referrer only when their voting power clears
// MIN_REFERRAL_STAKE_POWER; below it, the referrer's share is added to
// `accumulatedTreasuryETH` and an `UnclaimableSentToTreasury` event is emitted.
// The referred user still pays. The referrer earns nothing. Nothing on-chain
// tells the referrer this happened, and `getReferralInfo` reports the same
// zeroes it would report for someone with no referrals at all.
//
// So the honest place to say it is BEFORE the link is shared, and the verdict
// has to be computed from reads that were actually performed. Every input below
// is `bigint | boolean | null`, where **null means the read did not succeed**,
// and any null collapses the verdict to `unknown`. There is no "assume
// qualified" and no "assume zero power" — a wallet told it is disqualified
// because an RPC hiccuped would unstake for no reason, and a wallet told it
// qualifies when the read failed would share a link that earns nothing.
//
// ─── WHAT IS AND IS NOT COMPUTED HERE ────────────────────────────────────────
//
// Qualification is a PREDICATE over on-chain state, evaluated with the same
// arithmetic the contract uses (`stakingPower + restakingPower >= threshold`,
// both read from the chain, threshold read from the chain). That is a mirror,
// not an estimate.
//
// Claimable ETH is NOT computed here in any form. It is read from
// `pendingETH(address)` and passed through untouched. There is deliberately no
// "you have earned about X" projection anywhere in this slice: a referral fee
// depends on trade volume that has not happened, and a number on a claim screen
// is read as an entitlement no matter how it is hedged.

/** ReferralSplitter.MIN_REFERRAL_AGE — 7 days, in seconds. */
export const MIN_REFERRAL_AGE_SECONDS = 7n * 24n * 60n * 60n;

export interface StandingInputs {
  /** `MIN_REFERRAL_STAKE_POWER()`. Read, never hardcoded — it is a constant in
   *  the deployed bytecode, but reading it means a redeploy cannot desync us. */
  threshold: bigint | null;
  /** `stakingContract.votingPowerOf(wallet)`. */
  stakingPower: bigint | null;
  /**
   * `restakingContract.votingPowerOf(wallet)`, or 0n when the splitter's
   * `restakingContract` is the zero address.
   *
   * Zero-address is NOT a failed read: the contract's own `_votingPowerOf`
   * skips the call entirely in that case, so 0n is the correct contribution and
   * the verdict stays determinate. Null is reserved for a restaking pointer
   * that IS set and whose read failed — where the true power is only bounded
   * below, and a "below threshold" verdict could be wrong.
   */
  restakingPower: bigint | null;
  /** `bannedReferrers(wallet)`. */
  banned: boolean | null;
  /** `setupComplete()`. False makes both `recordFee` and `claimReferralRewards`
   *  revert, so the whole engine is inert regardless of stake. */
  setupComplete: boolean | null;
  /** `pendingETH(wallet)` — claimable now, in wei. */
  pending: bigint | null;
  /** `referrerRegisteredAt(wallet)`. 0n means no referee has ever linked. */
  registeredAt: bigint | null;
  /** Chain time in seconds. Block timestamp preferred; wall clock acceptable. */
  nowSeconds: bigint | null;
}

export type EarnVerdict =
  /** A read failed. Nothing is claimed about this wallet in either direction. */
  | { kind: 'unknown'; reason: string }
  /** The splitter's `setupComplete` is false — nobody earns, nobody claims. */
  | { kind: 'engine-inert'; reason: string }
  /** Owner-banned. New fees route to treasury and pre-ban balance is frozen. */
  | { kind: 'banned'; reason: string }
  /** Below MIN_REFERRAL_STAKE_POWER. Fees earned by referees go to treasury. */
  | { kind: 'below-threshold'; power: bigint; threshold: bigint; shortfall: bigint }
  /** Clears the threshold. Referee fees credit `pendingETH`. */
  | { kind: 'qualified'; power: bigint; threshold: bigint };

export type ClaimVerdict =
  | { kind: 'unknown'; reason: string }
  | { kind: 'engine-inert'; reason: string }
  | { kind: 'banned'; reason: string }
  /** No referee has ever linked this wallet, so the 7-day clock has not started. */
  | { kind: 'never-registered' }
  /** Registered, but inside MIN_REFERRAL_AGE. `unlocksAt` is a chain timestamp. */
  | { kind: 'too-recent'; unlocksAt: bigint }
  /** Claimable now is exactly zero. Distinct from every failure above. */
  | { kind: 'nothing-pending' }
  | { kind: 'claimable'; pendingWei: bigint };

/**
 * Does this wallet earn on its referees' fees right now?
 *
 * Order matters and is the contract's order: `setupComplete` gates everything,
 * then the ban flag (which `recordFee` treats as unqualified regardless of
 * power), then the stake threshold.
 */
export function evaluateEarn(i: StandingInputs): EarnVerdict {
  if (i.setupComplete === null) {
    return {
      kind: 'unknown',
      reason: 'The splitter’s setup flag could not be read, so whether referral fees are being recorded at all is unknown.',
    };
  }
  if (i.setupComplete === false) {
    return {
      kind: 'engine-inert',
      reason: 'The referral splitter has not been marked set-up on-chain, so it records no fees and pays no claims. This is a deployment state, not something about your wallet.',
    };
  }
  if (i.banned === null) {
    return { kind: 'unknown', reason: 'The referrer ban flag could not be read.' };
  }
  if (i.banned) {
    return {
      kind: 'banned',
      reason: 'This address is on the splitter’s banned-referrer list. New referee fees route to the treasury and any pre-ban balance cannot be claimed.',
    };
  }
  if (i.threshold === null || i.stakingPower === null || i.restakingPower === null) {
    return {
      kind: 'unknown',
      reason: 'Voting power could not be read, so whether this wallet clears the referral threshold is unknown. Do not read this as "not qualified".',
    };
  }

  const power = i.stakingPower + i.restakingPower;
  if (power >= i.threshold) return { kind: 'qualified', power, threshold: i.threshold };
  return {
    kind: 'below-threshold',
    power,
    threshold: i.threshold,
    shortfall: i.threshold - power,
  };
}

/**
 * Can this wallet claim, and what exactly is claimable?
 *
 * `pendingWei` is only ever the value read from `pendingETH`. The 7-day
 * MIN_REFERRAL_AGE gate is evaluated separately from the balance because the
 * two produce very different screens: "you have nothing" and "you have
 * something you cannot touch until Tuesday" must not share a state.
 */
export function evaluateClaim(i: StandingInputs): ClaimVerdict {
  if (i.setupComplete === null) {
    return { kind: 'unknown', reason: 'The splitter’s setup flag could not be read.' };
  }
  if (i.setupComplete === false) {
    return {
      kind: 'engine-inert',
      reason: 'The referral splitter has not been marked set-up on-chain, so claiming reverts.',
    };
  }
  if (i.banned === null) {
    return { kind: 'unknown', reason: 'The referrer ban flag could not be read.' };
  }
  if (i.banned) {
    return {
      kind: 'banned',
      reason: 'Banned referrers cannot claim, including balances accrued before the ban.',
    };
  }
  if (i.registeredAt === null || i.pending === null) {
    return {
      kind: 'unknown',
      reason: 'The on-chain referral balance could not be read, so no amount is shown. This is a failed read, not a zero balance.',
    };
  }
  if (i.registeredAt === 0n) return { kind: 'never-registered' };
  if (i.nowSeconds === null) {
    return {
      kind: 'unknown',
      reason: 'The chain’s current time could not be read, so the 7-day claim lock cannot be evaluated.',
    };
  }

  const unlocksAt = i.registeredAt + MIN_REFERRAL_AGE_SECONDS;
  if (i.nowSeconds < unlocksAt) return { kind: 'too-recent', unlocksAt };
  if (i.pending === 0n) return { kind: 'nothing-pending' };
  return { kind: 'claimable', pendingWei: i.pending };
}

/**
 * True when the wallet should be warned before it shares a link.
 *
 * `unknown` warns as loudly as `below-threshold`. Sharing a link on the strength
 * of a read that did not happen is the same mistake as sharing one while
 * disqualified, and the warning is cheap either way.
 */
export function shouldWarnBeforeSharing(v: EarnVerdict): boolean {
  return v.kind !== 'qualified';
}

/**
 * Where a referee's carve actually lands, given the referrer's verdict.
 *
 * Named as a destination rather than a boolean because that is the fact a
 * prospective referrer needs: their referee pays the same fee either way, and
 * the only variable is who receives it.
 */
export function carveDestination(v: EarnVerdict): 'referrer' | 'treasury' | 'unknown' {
  switch (v.kind) {
    case 'qualified':
      return 'referrer';
    case 'below-threshold':
    case 'banned':
      return 'treasury';
    case 'engine-inert':
    case 'unknown':
      return 'unknown';
  }
}
