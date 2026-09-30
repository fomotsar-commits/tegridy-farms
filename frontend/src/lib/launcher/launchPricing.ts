// LAUNCH PRICING: the creator revenue share, the one dial on the venue's line of a launch's
// fee constitution. The island rules "Same price for everyone." (2026-09-28), so nothing here
// reads a wallet or its heat: every launch under one config resolves to the same split.
// Doppler's >= 500 bps and the 10000 total are identities either way, and
// `STANDARD_VENUE_LINE_BPS - venueBps` is always what crosses to the creator.
// The locker fixes the split at creation. There is no setter here and none may be added.

import type { LaunchPricingDisclosure } from './factSheet';
import { DEFAULT_FEE_CONSTITUTION } from './config';

/** bps denominator of a fee constitution. */
const BPS_TOTAL = 10_000;

/** The venue's line at today's rate, derived from the shipped constitution, never typed twice. */
export const STANDARD_VENUE_LINE_BPS = DEFAULT_FEE_CONSTITUTION.filter(
  (l) => l.role === 'protocol-stakers',
).reduce((n, l) => n + l.shareBps, 0);

/**
 * Ceiling on the creator revenue share, as a fraction of the venue's line: the top of the
 * battle plan's 30-50% band, so a mistyped extra zero cannot hand over the whole line.
 */
export const MAX_CREATOR_FEE_SHARE_BPS = 5_000;

/** Creator revenue share. `VITE_CREATOR_FEE_SHARE=on`, the literal `on` only. Default OFF. */
export function isCreatorFeeShareEnabled(): boolean {
  return (import.meta.env.VITE_CREATOR_FEE_SHARE as string | undefined)?.trim().toLowerCase() === 'on';
}

/**
 * The creator's share OF THE VENUE'S LINE, in bps. `VITE_CREATOR_FEE_SHARE_BPS`.
 * Unset, out of range or not a whole number reads 0: a flag and a price are two decisions,
 * and a typo may never re-price a launch.
 */
export function creatorFeeShareOfVenueBps(): number {
  const raw = (import.meta.env.VITE_CREATOR_FEE_SHARE_BPS as string | undefined)?.trim();
  if (!raw) return 0;
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_CREATOR_FEE_SHARE_BPS) return 0;
  return bps;
}

/** Overrides for tests. The page passes none, so the env vars are the only input. */
export interface PricingOptions {
  creatorShareEnabled?: boolean;
  creatorShareOfVenueBps?: number;
}

/** The resolved price of a launch. Immutable once the launch tx mines. */
export interface ResolvedLaunchPricing {
  /** bps of the pool trade fee the venue keeps under this launch's constitution. */
  venueBps: number;
  /** The venue's line at the standard rate, for comparison. */
  standardVenueBps: number;
  /** bps the creator revenue share moved off the venue's line to the creator. */
  creatorShareBps: number;
  creatorShareEnabled: boolean;
}

/** bps -> "15.00%". Shares are of the pool's trade fee, never of trade volume. */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Price a launch. Pure: it takes no wallet and no reading, so it is the same for everyone. */
export function resolveLaunchPricing(opts: PricingOptions = {}): ResolvedLaunchPricing {
  const creatorShareEnabled = opts.creatorShareEnabled ?? isCreatorFeeShareEnabled();
  const rawShare = opts.creatorShareOfVenueBps ?? creatorFeeShareOfVenueBps();
  const shareOfVenueBps =
    creatorShareEnabled && Number.isInteger(rawShare) && rawShare > 0 && rawShare <= MAX_CREATOR_FEE_SHARE_BPS
      ? rawShare
      : 0;
  // Floored, so rounding leaves the odd basis point with the venue and never over-credits
  // a creator line the constitution then has to find bps for.
  const creatorShareBps = Math.floor((STANDARD_VENUE_LINE_BPS * shareOfVenueBps) / BPS_TOTAL);
  return {
    venueBps: STANDARD_VENUE_LINE_BPS - creatorShareBps,
    standardVenueBps: STANDARD_VENUE_LINE_BPS,
    creatorShareBps,
    creatorShareEnabled,
  };
}

/** Today's economics: the dial off, standard venue line, nothing claimed. */
export function standardLaunchPricing(): ResolvedLaunchPricing {
  return resolveLaunchPricing({ creatorShareEnabled: false, creatorShareOfVenueBps: 0 });
}

/**
 * The price every launch already pays, with the dial off? Then the Fact Sheet carries no
 * pricing disclosure, and `disclosuresDigest` stays byte-identical to a sheet without one.
 */
export function isStandardPricing(p: ResolvedLaunchPricing): boolean {
  return !p.creatorShareEnabled && p.creatorShareBps === 0;
}

/** The buyer-facing sentences. Each states something applied; none projects earnings. */
export function pricingNote(p: ResolvedLaunchPricing): string {
  const parts: string[] = [
    `The venue's share of this launch's pool trade fee is ${pct(p.venueBps)}, against a standard rate of ${pct(p.standardVenueBps)}.`,
  ];
  if (p.creatorShareEnabled) {
    parts.push(
      p.creatorShareBps > 0
        ? `A further ${pct(p.creatorShareBps)} of the pool trade fee is routed from the venue's line to the creator as ongoing revenue share.`
        : 'No creator revenue share is routed on this launch.',
    );
  }
  parts.push(
    'This split is fixed at creation by the streaming locker and cannot be changed afterwards by the creator, the venue, or anyone else.',
  );
  return parts.join(' ');
}

/** The Fact Sheet disclosure, or undefined when there is nothing beyond the constitution to disclose. */
export function toPricingDisclosure(p: ResolvedLaunchPricing): LaunchPricingDisclosure | undefined {
  if (isStandardPricing(p)) return undefined;
  return {
    venueShareBps: p.venueBps,
    standardVenueShareBps: p.standardVenueBps,
    creatorRevenueShareBps: p.creatorShareBps,
    note: pricingNote(p),
  };
}
