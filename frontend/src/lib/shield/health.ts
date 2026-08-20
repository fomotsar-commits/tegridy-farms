// What "health" means for a loan on the venue's own lending contracts.
//
// It means TIME, not price. `TegridyNFTLending` has no oracle, no LTV and no
// liquidation ratio: the loan is a fixed-term escrow, and the lender may call
// `claimDefault` once `effectiveDeadline + grace` has passed. Nothing about the
// collateral's market value moves that moment either earlier or later.
//
// So this module refuses to produce a health factor. A "1.42" next to one of
// these loans would be a number the contract does not compute, cannot be
// liquidated against, and which a borrower who has seen one on Aave would read as
// distance-to-liquidation. See NO_HEALTH_FACTOR_DETAIL — the refusal is exported
// and rendered, because a blank where a familiar number should be is itself
// confusing.
//
// The band is derived from ONE fact — `effectiveDeadline`, read from the contract
// — plus the grace constant, and it is never derived from the raw `deadline` on
// the loan struct. The two differ whenever the contract has been paused
// (`effectiveDeadline = deadline + pause extension`), and quoting the raw one as
// if it were the operative deadline would tell a borrower they have less time
// than they do, in the one direction where being wrong is embarrassing rather
// than dangerous — but it would still be a number nobody read.
//
// Everything here is pure. If a read failed, the caller passes null and gets
// `unreadable` back with the reason; there is no band for "we could not look".

export type ShieldHealthBand = 'safe' | 'watch' | 'urgent' | 'grace' | 'defaulted';

/** Inside this much time to the deadline, the loan is `urgent`. */
export const URGENT_SECONDS = 24 * 60 * 60;
/** Inside this much time to the deadline, the loan is `watch`. */
export const WATCH_SECONDS = 72 * 60 * 60;

export const BAND_LABEL: Record<ShieldHealthBand, string> = {
  safe: 'On schedule',
  watch: 'Deadline approaching',
  urgent: 'Deadline imminent',
  grace: 'In grace period',
  defaulted: 'Repayment window closed',
};

/** Ordering for surfacing the worst position first. Higher is more urgent. */
export const BAND_SEVERITY: Record<ShieldHealthBand, number> = {
  safe: 0,
  watch: 1,
  urgent: 2,
  grace: 3,
  defaulted: 4,
};

export const NO_HEALTH_FACTOR_DETAIL =
  'This loan has no health factor. It is a fixed-term loan with no price oracle and no collateral ratio — nothing liquidates it when prices move, and the lender may claim the collateral the moment the deadline and its grace period pass. Time is the only variable.';

export interface DeadlineHealthInput {
  /**
   * `effectiveDeadline(loanId)` as read from the lending contract — the
   * pause-adjusted value the claim path acts on. Null when the read failed.
   */
  effectiveDeadlineUnix: number | null;
  /** `GRACE_PERIOD` as read from the contract. Null when the read failed. */
  graceSeconds: number | null;
  nowUnix: number;
  /** Named in the refusal so a user can tell which read went missing. */
  unreadableDetail?: string;
}

export interface DeadlineHealth {
  status: 'read';
  mechanism: 'deadline-default';
  band: ShieldHealthBand;
  /** Seconds until the deadline. Negative once it has passed. */
  secondsToDeadline: number;
  /** Seconds until repayment closes for good. Negative once it has. */
  secondsToGraceEnd: number;
  deadlineUnix: number;
  graceEndsUnix: number;
  /** True only while `repayLoan` would still be inside its window. */
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

export interface UnreadableHealth {
  status: 'unreadable';
  /** Plain language, rendered verbatim. Never empty. */
  detail: string;
}

export type ShieldHealth = DeadlineHealth | UnreadableHealth;

const DEFAULT_UNREADABLE_DETAIL =
  'The loan’s deadline could not be read from the lending contract, so its health is unknown. This is a failed read, not a loan that is fine.';

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

function bandFor(secondsToDeadline: number, secondsToGraceEnd: number): ShieldHealthBand {
  if (secondsToGraceEnd <= 0) return 'defaulted';
  if (secondsToDeadline <= 0) return 'grace';
  if (secondsToDeadline <= URGENT_SECONDS) return 'urgent';
  if (secondsToDeadline <= WATCH_SECONDS) return 'watch';
  return 'safe';
}

function consequenceFor(band: ShieldHealthBand, secondsToDeadline: number, secondsToGraceEnd: number): string {
  switch (band) {
    case 'defaulted':
      return 'The repayment window has closed. The lender can claim the collateral NFT now, and it is not returned by repaying afterwards.';
    case 'grace':
      return `The deadline has passed. Repayment still settles for another ${formatDuration(secondsToGraceEnd)}; after that the lender can claim the collateral NFT and keep it.`;
    case 'urgent':
      return `Repay within ${formatDuration(secondsToDeadline)} or the loan enters its grace period, after which the lender can claim the collateral NFT and keep it.`;
    case 'watch':
      return `Repayment is due in ${formatDuration(secondsToDeadline)}. Missing it costs the whole collateral NFT, not a percentage of it.`;
    case 'safe':
      return `Repayment is due in ${formatDuration(secondsToDeadline)}. Missing it costs the whole collateral NFT, not a percentage of it.`;
  }
}

/**
 * Assess one loan. Returns `unreadable` rather than a band whenever either input
 * read failed — the two must not collapse, because a band is a claim about the
 * loan and "we could not read it" is a claim about us.
 */
export function assessDeadlineHealth(input: DeadlineHealthInput): ShieldHealth {
  const { effectiveDeadlineUnix, graceSeconds, nowUnix } = input;
  if (
    effectiveDeadlineUnix == null ||
    graceSeconds == null ||
    !Number.isFinite(effectiveDeadlineUnix) ||
    !Number.isFinite(graceSeconds)
  ) {
    return { status: 'unreadable', detail: input.unreadableDetail || DEFAULT_UNREADABLE_DETAIL };
  }

  const graceEndsUnix = effectiveDeadlineUnix + graceSeconds;
  const secondsToDeadline = effectiveDeadlineUnix - nowUnix;
  const secondsToGraceEnd = graceEndsUnix - nowUnix;
  const band = bandFor(secondsToDeadline, secondsToGraceEnd);

  return {
    status: 'read',
    mechanism: 'deadline-default',
    band,
    secondsToDeadline,
    secondsToGraceEnd,
    deadlineUnix: effectiveDeadlineUnix,
    graceEndsUnix,
    repayable: secondsToGraceEnd > 0,
    healthFactor: null,
    healthFactorDetail: NO_HEALTH_FACTOR_DETAIL,
    headline:
      band === 'defaulted'
        ? BAND_LABEL[band]
        : band === 'grace'
          ? `${BAND_LABEL[band]} — ${formatDuration(secondsToGraceEnd)} left to repay`
          : `${BAND_LABEL[band]} — ${formatDuration(secondsToDeadline)} left`,
    consequence: consequenceFor(band, secondsToDeadline, secondsToGraceEnd),
  };
}

/**
 * Sort key so the worst position renders first. Unreadable positions sort ABOVE
 * every readable one: a loan whose health nobody could read is the one most
 * likely to be the problem, and burying it under green rows is how it gets
 * missed.
 */
export function healthSeverity(health: ShieldHealth): number {
  if (health.status === 'unreadable') return 100;
  return BAND_SEVERITY[health.band];
}
