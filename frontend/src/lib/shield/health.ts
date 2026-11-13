// What "health" means for an NFT loan on Gondi's v3.2 loan contract.
//
// It means TIME, not price. The loan has no oracle, no LTV and no liquidation ratio: it is a
// fixed-term escrow. Nothing about the collateral's market value moves its deadline.
//
// So this module refuses to produce a health factor. A "1.42" next to one of these loans
// would be a number the contract does not compute, cannot be liquidated against, and which a
// borrower who has seen one on Aave would read as distance-to-liquidation. See
// NO_HEALTH_FACTOR_DETAIL: the refusal is exported and rendered, because a blank where a
// familiar number should be is itself confusing.
//
// The deadline is `startTime + duration` of the loan whose hash `getLoanHash` confirmed
// (useMyLoans), so it is the chain's own number. Gondi has NO grace period, and both of its
// gates key on that one second (MultiSourceLoan.sol): `repayLoan` reverts with
// LoanExpiredError once `startTime + duration <= block.timestamp`, and `liquidateLoan` opens at
// the same moment. So from the deadline on, repaying is refused and the lender can claim.
//
// Everything here is pure.

export type ShieldHealthBand = 'safe' | 'watch' | 'urgent' | 'defaulted';

/** Inside this much time to the deadline, the loan is `urgent`. */
export const URGENT_SECONDS = 24 * 60 * 60;
/** Inside this much time to the deadline, the loan is `watch`. */
export const WATCH_SECONDS = 72 * 60 * 60;

export const BAND_LABEL: Record<ShieldHealthBand, string> = {
  safe: 'On schedule',
  watch: 'Deadline approaching',
  urgent: 'Deadline imminent',
  defaulted: 'Repayment window closed',
};

/** Ordering for surfacing the worst position first. Higher is more urgent. */
export const BAND_SEVERITY: Record<ShieldHealthBand, number> = {
  safe: 0,
  watch: 1,
  urgent: 2,
  defaulted: 3,
};

export const NO_HEALTH_FACTOR_DETAIL =
  'This loan has no health factor. It is a fixed-term loan with no price oracle and no collateral ratio, so nothing liquidates it when prices move. There is no grace period either: from the deadline on, the loan contract refuses repayment and the lender can claim the collateral NFT. Time is the only variable.';

export interface DeadlineHealthInput {
  /** `startTime + duration` of the hash-checked loan, unix seconds. */
  deadlineUnix: number;
  nowUnix: number;
}

export interface DeadlineHealth {
  mechanism: 'deadline-default';
  band: ShieldHealthBand;
  /** Seconds until the deadline. Zero or negative once it has passed. */
  secondsToDeadline: number;
  deadlineUnix: number;
  /** False from the deadline second on, when Gondi's `repayLoan` reverts. */
  repayable: boolean;
  /**
   * Always null. Present so a consumer that expects the familiar field reads the
   * refusal rather than reaching for a number that does not exist.
   */
  healthFactor: null;
  healthFactorDetail: string;
  /** Short line for the row. */
  headline: string;
  /** One sentence: what happens if nothing is signed. */
  consequence: string;
}

export type ShieldHealth = DeadlineHealth;

export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function bandFor(secondsToDeadline: number): ShieldHealthBand {
  if (secondsToDeadline <= 0) return 'defaulted';
  if (secondsToDeadline <= URGENT_SECONDS) return 'urgent';
  if (secondsToDeadline <= WATCH_SECONDS) return 'watch';
  return 'safe';
}

function consequenceFor(band: ShieldHealthBand, secondsToDeadline: number): string {
  switch (band) {
    case 'defaulted':
      return 'The deadline has passed. The loan contract no longer accepts repayment, and the lender can claim the collateral NFT at any moment and keep it.';
    case 'urgent':
      return `Repay within ${formatDuration(secondsToDeadline)}. A repayment that lands after the deadline is refused, and the lender can then claim the collateral NFT and keep it. There is no grace period.`;
    case 'watch':
    case 'safe':
      return `Repayment is due in ${formatDuration(secondsToDeadline)}. Missing it costs the whole collateral NFT, not a percentage of it.`;
  }
}

export function assessDeadlineHealth(input: DeadlineHealthInput): ShieldHealth {
  const { deadlineUnix, nowUnix } = input;
  const secondsToDeadline = deadlineUnix - nowUnix;
  const band = bandFor(secondsToDeadline);
  return {
    mechanism: 'deadline-default',
    band,
    secondsToDeadline,
    deadlineUnix,
    repayable: band !== 'defaulted',
    healthFactor: null,
    healthFactorDetail: NO_HEALTH_FACTOR_DETAIL,
    headline: band === 'defaulted' ? BAND_LABEL[band] : `${BAND_LABEL[band]} — ${formatDuration(secondsToDeadline)} left`,
    consequence: consequenceFor(band, secondsToDeadline),
  };
}

/** Sort key so the worst position renders first. */
export function healthSeverity(health: ShieldHealth): number {
  return BAND_SEVERITY[health.band];
}
