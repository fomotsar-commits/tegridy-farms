// Recurring billing, generalised out of the premium tier into a pull-payment
// primitive — and forced to say out loud what it cannot do.
//
// ─── THE VENUE RUNS NO KEEPER ───────────────────────────────────────────────
//
// There is no cron, no relayer and no bot on this deployment. A serverless
// function runs only when something calls it, so nothing here can fire a charge
// while every relevant tab is shut. That is not a gap to be papered over with a
// scheduled job later; it is the fact every surface built on this module has to
// carry, because a subscription that silently never renews is worse than no
// subscription — the merchant thinks they are being paid and the payer thinks
// they are being charged, and neither finds out until something else breaks.
//
// So `Subscription.initiator` is a REQUIRED field with no default, and
// `chargeVerdict` returns `due` — never `charged`. Something with a signer has
// to act. This module says when a charge is legitimate; it never claims one
// happened.
//
// ─── WHAT GENERALISES OUT OF PremiumAccess ──────────────────────────────────
//
// `PremiumAccess.subscribe(months, maxCost)` is a PUSH: the payer pays N months
// up front and access lapses on its own if they never come back. That shape is
// preserved here as `payer-push`, because its failure mode — a payer who forgets
// — costs the payer nothing they did not choose.
//
// The pull shape is `merchant-pull`, and it needs no new contract: the payer
// grants a plain ERC-20 allowance to the merchant's own address and the merchant
// calls `transferFrom` each period. That deliberately adds NO on-chain machinery
// (see the DELETE-before-ADD rule), and the price of adding none is stated by
// `pullTrustNotice` below and must be rendered wherever a pull subscription is
// offered:
//
//   NOTHING ON CHAIN ENFORCES THE SCHEDULE. The allowance is the entire cap. A
//   merchant holding an allowance for twelve months can take all twelve today.
//   The period, the amount and the count in this module are the payer's record
//   of what was agreed — not a constraint any contract will apply.
//
// If that trade is unacceptable for some merchant, the answer is a real
// subscription contract with a per-period cap, deployed and audited. It is not a
// friendlier sentence over this arrangement.

/** Who has to hold the pen for a charge to happen at all. No default exists. */
export type ChargeInitiator =
  /** The payer signs each period's payment themselves. */
  | 'payer-push'
  /** The merchant calls `transferFrom` against a standing allowance. */
  | 'merchant-pull';

export interface Subscription {
  id: string;
  payer: `0x${string}`;
  merchant: `0x${string}`;
  chainId: number;
  token: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Charged per period, in the token's smallest unit. */
  amountPerPeriod: bigint;
  /** Seconds between charges. */
  periodSeconds: number;
  /** Unix seconds of the first period's start. */
  startedAt: number;
  /**
   * Periods already paid. The payer's own count — see the header: no contract
   * increments this, so it is a record, not an enforcement.
   */
  periodsCharged: number;
  /** Null runs until cancelled. A number caps the agreement at N periods. */
  periodsAgreed: number | null;
  initiator: ChargeInitiator;
  /** Unix seconds the payer cancelled, or null. */
  cancelledAt: number | null;
}

/** Shortest period this module will describe as a subscription. */
export const MIN_PERIOD_SECONDS = 24 * 60 * 60;

export type ChargeVerdict =
  /** A charge for this period is legitimate now. Nothing has fired it. */
  | 'due'
  /** The current period is already paid. */
  | 'not-due'
  /** Cancelled by the payer. */
  | 'cancelled'
  /** Every agreed period has been charged. */
  | 'completed'
  /** Due, but the standing allowance does not cover it. */
  | 'allowance-short'
  /** Due and allowed, but the payer cannot fund it. */
  | 'balance-short'
  /** The subscription itself is malformed. */
  | 'invalid';

export interface ChargeState {
  verdict: ChargeVerdict;
  /** Unix seconds the next uncharged period opens. Null when none will. */
  nextChargeAt: number | null;
  /**
   * Periods that have opened and were never charged.
   *
   * The number that makes the missing keeper visible. A payer-push subscription
   * nobody returned to shows this climbing, and a surface that renders "active"
   * beside a non-zero arrears count is lying by adjacency.
   */
  missedPeriods: number;
  /**
   * Whole periods the CURRENT allowance still covers, for `merchant-pull`.
   * Null for `payer-push`, where no allowance is involved at all.
   */
  periodsCoveredByAllowance: number | null;
  /** Plain-language reason, always set. */
  detail: string;
}

function invalidReasons(sub: Subscription): string[] {
  const out: string[] = [];
  if (sub.amountPerPeriod <= 0n) out.push('the amount per period is zero');
  if (!Number.isInteger(sub.periodSeconds) || sub.periodSeconds < MIN_PERIOD_SECONDS) {
    out.push('the period is shorter than a day');
  }
  if (!Number.isInteger(sub.startedAt) || sub.startedAt <= 0) out.push('there is no start time');
  if (sub.periodsCharged < 0) out.push('the charged-period count is negative');
  if (sub.periodsAgreed !== null && sub.periodsAgreed <= 0) out.push('the agreed period count is not positive');
  return out;
}

/**
 * When the Nth period opens, counting from zero.
 *
 * Fixed-interval from `startedAt` rather than "one period after the last
 * charge". Anchoring to the last charge lets a late charge push every future one
 * later, so a payer who is a week late every month is charged eleven times a
 * year while reading "monthly" — the drift is silent and always in the payer's
 * disfavour on a pull, and the merchant's on a push.
 */
export function periodStart(sub: Subscription, index: number): number {
  return sub.startedAt + index * sub.periodSeconds;
}

/**
 * Decide whether a charge is legitimate right now, and say what it would cost.
 *
 * Pure, and deliberately given the on-chain figures rather than reading them:
 * the caller holds the wagmi reads, and a verdict computed from numbers the
 * caller can see is a verdict the caller can be held to.
 *
 * `allowance` is ignored entirely for `payer-push` — there is no allowance in
 * that shape and accepting one would invite a surface to display a cap that
 * governs nothing.
 */
export function chargeVerdict(
  sub: Subscription,
  now: number,
  onChain: { allowance: bigint; balance: bigint },
): ChargeState {
  const problems = invalidReasons(sub);
  if (problems.length > 0) {
    return {
      verdict: 'invalid',
      nextChargeAt: null,
      missedPeriods: 0,
      periodsCoveredByAllowance: null,
      detail: `This subscription cannot be evaluated because ${problems.join(', ')}.`,
    };
  }

  const isPull = sub.initiator === 'merchant-pull';
  const coverage = isPull
    ? Number(onChain.allowance / sub.amountPerPeriod)
    : null;

  if (sub.cancelledAt !== null) {
    return {
      verdict: 'cancelled',
      nextChargeAt: null,
      missedPeriods: 0,
      periodsCoveredByAllowance: coverage,
      detail:
        isPull
          ? 'The payer cancelled this subscription. Cancelling here is a record only — until the ' +
            'allowance is revoked on chain, the merchant can still call transferFrom.'
          : 'The payer cancelled this subscription. Nothing further is owed.',
    };
  }

  if (sub.periodsAgreed !== null && sub.periodsCharged >= sub.periodsAgreed) {
    return {
      verdict: 'completed',
      nextChargeAt: null,
      missedPeriods: 0,
      periodsCoveredByAllowance: coverage,
      detail: `All ${sub.periodsAgreed} agreed periods have been charged.`,
    };
  }

  // The next period that has not been paid for.
  const nextIndex = sub.periodsCharged;
  const nextChargeAt = periodStart(sub, nextIndex);

  // How many periods have opened in total, capped by the agreement.
  const elapsed = now - sub.startedAt;
  const openedRaw = elapsed < 0 ? 0 : Math.floor(elapsed / sub.periodSeconds) + 1;
  const opened = sub.periodsAgreed === null ? openedRaw : Math.min(openedRaw, sub.periodsAgreed);
  const missedPeriods = Math.max(0, opened - sub.periodsCharged - 1);

  if (now < nextChargeAt) {
    return {
      verdict: 'not-due',
      nextChargeAt,
      missedPeriods: 0,
      periodsCoveredByAllowance: coverage,
      detail:
        'The current period is paid. Nothing will fire on its own when the next one opens — this venue ' +
        'runs no keeper.',
    };
  }

  if (isPull && onChain.allowance < sub.amountPerPeriod) {
    return {
      verdict: 'allowance-short',
      nextChargeAt,
      missedPeriods,
      periodsCoveredByAllowance: coverage,
      detail:
        'A period is due and the standing allowance no longer covers one charge, so the merchant cannot ' +
        'take it. The payer has to raise the allowance before this can be collected.',
    };
  }

  if (onChain.balance < sub.amountPerPeriod) {
    return {
      verdict: 'balance-short',
      nextChargeAt,
      missedPeriods,
      periodsCoveredByAllowance: coverage,
      detail:
        'A period is due and the payer wallet cannot fund one charge. Whoever initiates it would spend ' +
        'gas on a revert.',
    };
  }

  return {
    verdict: 'due',
    nextChargeAt,
    missedPeriods,
    periodsCoveredByAllowance: coverage,
    detail:
      sub.initiator === 'payer-push'
        ? 'A period is due and the payer has to sign it. Nothing charges this automatically.'
        : 'A period is due and the merchant has to call transferFrom. Nothing charges this automatically.',
  };
}

/**
 * The allowance a `merchant-pull` payer is being asked to grant, and what it
 * actually authorises.
 *
 * Returns the exact figure for N periods. There is deliberately no "unlimited"
 * option: an infinite allowance to a merchant address is an unbounded claim on
 * the payer's balance for as long as the token exists, and offering it beside
 * the word "monthly" invites a reader to believe the month is the cap.
 */
export function allowanceForPeriods(sub: Subscription, periods: number): bigint | null {
  if (!Number.isInteger(periods) || periods < 1 || periods > 120) return null;
  if (sub.amountPerPeriod <= 0n) return null;
  return sub.amountPerPeriod * BigInt(periods);
}

/**
 * The sentence a pull subscription must carry, wherever it is offered.
 *
 * A function rather than a constant so the periods being authorised appear in
 * it: "you are granting 12 charges" is read; "you are granting an allowance" is
 * not.
 */
export function pullTrustNotice(sub: Subscription, periods: number): string {
  return (
    `Granting this allowance lets ${sub.merchant} move up to ${periods} × ${sub.amountPerPeriod} ` +
    `${sub.tokenSymbol} (smallest units) out of your wallet. No contract enforces the schedule: nothing ` +
    'on chain stops all of it being taken at once, or early. The allowance is the only cap, and revoking ' +
    'it is the only cancellation that binds.'
  );
}

/** The equivalent sentence for the push shape. Different risk, stated as such. */
export function pushLapseNotice(sub: Subscription): string {
  return (
    `You pay each period yourself. This venue runs no keeper, so nothing will remind or charge you when ` +
    `a period opens — if you do not return, the subscription simply lapses and ${sub.merchant} is not ` +
    'paid. Nothing can be taken from your wallet without you signing for it.'
  );
}

/**
 * The one-line renewal truth for a status surface.
 *
 * Both branches say the same thing in the end and that is the point: neither
 * shape renews on its own, and a surface must not let the pull shape read as
 * "automatic" simply because the merchant is the one who acts.
 */
export function renewalNotice(sub: Subscription): string {
  return sub.initiator === 'merchant-pull'
    ? 'This does not renew on its own. The merchant has to collect each period; if they do not, nothing is charged.'
    : 'This does not renew on its own. You have to pay each period; if you do not, it lapses.';
}
