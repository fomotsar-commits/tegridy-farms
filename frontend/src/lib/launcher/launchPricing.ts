// LAUNCH PRICING — the two operator dials that move the VENUE's line of a launch's fee
// constitution, and nothing else.
//
// ## What is actually movable here, and what is not
//
// A launch's constitution sums to exactly 10000 bps of the migration pool's trade fee and
// is fixed on-chain at creation by the StreamableFeesLocker's beneficiary set. Two of its
// lines are NOT ours to move: Doppler's >= 500 bps (a hard protocol floor enforced in
// airlock.ts) and the total. So every price this module can express is one boundary:
// how much of the venue's own line the venue keeps, and how much crosses to the creator.
// That boundary is the ONLY thing the two features below touch — the creator+attention
// pool, the Doppler line and the 10000 total are arithmetic identities either way.
//
//   creatorBonusBps === STANDARD_VENUE_LINE_BPS - venueBps      (always, by construction)
//
// ## The two dials
//
// HEAT-TIER PRICING (docs/YEAR_PLAN_2026_2027.md; WORKORDER_V2.md §7A.4 — "the EVM fee
// constitution is client-passed per launch (flex the 1500-bps stakers line by gate tier;
// sum=10000; Doppler line stays)"). Warmer wallets keep more of their own token's fees.
// The tier is READ from the existing Heat gate (lib/heat/launchGate.ts + heatOracle.ts) —
// this module never fetches, never re-tiers, and never computes a degree. It consumes the
// gate's own decision and nothing else.
//
// CREATOR REVENUE SHARE (BATTLE_PLAN #6). A share of the venue's retained line is routed
// to the launch's creator as ongoing income. Battle-plan band is 30-50% of the venue take;
// the default here is 0 and an out-of-band override is IGNORED rather than obeyed.
//
// ## Constraints this file exists to hold
//
// 1. A tier price may never exceed STANDARD_VENUE_LINE_BPS. Enabling the feature can only
//    ever make a launch CHEAPER — there is no configuration of these dials that raises the
//    venue's take above what it charges today.
// 2. A colder tier may never be cheaper than a warmer one. "Warmer wallets launch cheaper"
//    is the product; a table that inverts it is a misconfiguration, not a price.
// 3. A tier the island did not report FRESHLY earns no discount and is never named. A
//    STALE or unreachable instrument prices at the standard rate and says so. An outage
//    must not read as a Drifter, and must not read as a free launch.
// 4. A malformed operator override is ignored WHOLE, never applied in part. A half-parsed
//    price table is a silent re-pricing.
// 5. Both features are OFF by default and the default table is flat at today's rate, so a
//    deploy that changes no env var deploys today's economics byte-for-byte.
//
// ## Immutability
//
// The split is published before the signature and fixed by the locker after it. There is
// no setter anywhere in this path and none may be added: a creator share that can be
// changed after launch is a rug with extra steps, so the disclosure below is a permanent
// claim about a permanent fact.

import type { GateDecision, GateState, HeatTier } from '../heat/heatOracle';
import { TIER_FLOORS } from '../heat/heatOracle';
import type { GateAuditRow } from '../heat/gateAudit';
import type { FeeConstitutionLine, LaunchPricingDisclosure } from './factSheet';
import { DEFAULT_FEE_CONSTITUTION } from './config';

/** bps denominator of a fee constitution. */
const BPS_TOTAL = 10_000;

/**
 * The venue's line at TODAY's rate, derived from the shipped constitution rather than
 * typed again. If DEFAULT_FEE_CONSTITUTION ever moves, "today's rate" moves with it and
 * the flat default table below stays a genuine no-op.
 */
export const STANDARD_VENUE_LINE_BPS = DEFAULT_FEE_CONSTITUTION.filter(
  (l) => l.role === 'protocol-stakers',
).reduce((n, l) => n + l.shareBps, 0);

/** Warmest first — the order constraint 2 above is checked in. Mirrors the island's floors. */
export const TIERS_WARMEST_FIRST: readonly HeatTier[] = TIER_FLOORS.map((t) => t.tier);

/**
 * THE PRICE TABLE: bps of the pool trade fee the venue keeps, per Heat tier.
 *
 * FLAT AT TODAY'S RATE ON PURPOSE. Shipping the table already priced would re-price every
 * launch the moment the flag was flipped, which is the failure this default exists to
 * prevent. An operator sets real prices through `VITE_LAUNCH_TIER_VENUE_BPS`, so the
 * decision is a config change with a record, not a code change nobody reviews.
 */
export const HEAT_TIER_VENUE_LINE_BPS: Readonly<Record<HeatTier, number>> = Object.freeze({
  Elder: STANDARD_VENUE_LINE_BPS,
  Builder: STANDARD_VENUE_LINE_BPS,
  Resident: STANDARD_VENUE_LINE_BPS,
  Observer: STANDARD_VENUE_LINE_BPS,
  Drifter: STANDARD_VENUE_LINE_BPS,
});

/**
 * Ceiling on the creator revenue share, as a fraction of the venue's line. The battle
 * plan's band is 30-50%; this caps the dial at the top of it so a mistyped extra zero
 * cannot hand over a line the venue still has obligations against.
 */
export const MAX_CREATOR_FEE_SHARE_BPS = 5_000;

/** A price table with the fault that disqualifies it, or null when it may be used. */
export function tierTableFault(table: Readonly<Record<HeatTier, number>>): string | null {
  let previous = -1;
  // Walked warmest -> coldest so the monotonicity check reads in the direction of the claim.
  for (const tier of TIERS_WARMEST_FIRST) {
    const bps = table[tier];
    if (!Number.isInteger(bps) || bps < 0) return `${tier}: price must be a whole number of bps`;
    if (bps > STANDARD_VENUE_LINE_BPS) {
      // Constraint 1. These dials are a discount mechanism; they are not a fee raise.
      return `${tier}: ${bps} bps exceeds the standard ${STANDARD_VENUE_LINE_BPS} bps venue line`;
    }
    if (bps < previous) return `${tier}: ${bps} bps prices a colder tier below a warmer one`;
    previous = bps;
  }
  return null;
}

/**
 * Parse `VITE_LAUNCH_TIER_VENUE_BPS` — "Elder:900,Builder:1100,Resident:1300,Observer:1500,Drifter:1500".
 *
 * ALL FIVE tiers must be named and the result must pass `tierTableFault`, or the whole
 * override is discarded and the flat default stands (constraint 4). Returning a partial
 * table would leave the unnamed tiers at today's rate while the named ones moved — a
 * price nobody wrote down.
 */
export function parseTierTable(raw: string | undefined): Readonly<Record<HeatTier, number>> | null {
  const text = raw?.trim();
  if (!text) return null;
  const out: Partial<Record<HeatTier, number>> = {};
  for (const part of text.split(',')) {
    const [name, value] = part.split(':').map((s) => s?.trim());
    if (!name || !value) return null;
    if (!(TIERS_WARMEST_FIRST as readonly string[]).includes(name)) return null;
    const bps = Number(value);
    if (!Number.isInteger(bps)) return null;
    if (out[name as HeatTier] !== undefined) return null; // a duplicate key is an unreadable intent
    out[name as HeatTier] = bps;
  }
  for (const tier of TIERS_WARMEST_FIRST) if (out[tier] === undefined) return null;
  const table = Object.freeze(out as Record<HeatTier, number>);
  return tierTableFault(table) === null ? table : null;
}

/** The table in force. Falls back to the flat default whenever the override is unusable. */
export function heatTierVenueTable(): Readonly<Record<HeatTier, number>> {
  return (
    parseTierTable(import.meta.env.VITE_LAUNCH_TIER_VENUE_BPS as string | undefined) ??
    HEAT_TIER_VENUE_LINE_BPS
  );
}

/** OFF unless the operator says otherwise. */
function isOn(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'on';
}

/** Heat-tier launch pricing. `VITE_LAUNCH_TIER_PRICING=on`. Default OFF. */
export function isHeatTierPricingEnabled(): boolean {
  return isOn(import.meta.env.VITE_LAUNCH_TIER_PRICING as string | undefined);
}

/** Creator revenue share. `VITE_CREATOR_FEE_SHARE=on`. Default OFF. */
export function isCreatorFeeShareEnabled(): boolean {
  return isOn(import.meta.env.VITE_CREATOR_FEE_SHARE as string | undefined);
}

/**
 * The creator's share OF THE VENUE'S LINE, in bps. `VITE_CREATOR_FEE_SHARE_BPS`.
 *
 * Default 0: turning the flag on without naming a number must not move money, because a
 * flag and a price are two decisions and only one of them was made. Out-of-range or
 * non-integer overrides fall back to 0 for the same reason a bad floor is ignored in
 * heatGateConfig — a typo may never re-price a launch.
 */
export function creatorFeeShareOfVenueBps(): number {
  const raw = (import.meta.env.VITE_CREATOR_FEE_SHARE_BPS as string | undefined)?.trim();
  if (!raw) return 0;
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_CREATOR_FEE_SHARE_BPS) return 0;
  return bps;
}

/**
 * The minimum a pricing decision needs from the Heat gate: the tier word the island gave,
 * and the state that says whether it may be acted on. Deliberately structural so BOTH the
 * pre-launch decision (`GateDecision`) and the launch-time audit row (`GateAuditRow`) can
 * be priced from, without this module learning how to fetch anything.
 */
export interface TierReading {
  tier: HeatTier | null;
  state: GateState;
}

export function tierReadingFromDecision(d: GateDecision): TierReading {
  return { tier: d.tier, state: d.state };
}

export function tierReadingFromAudit(row: GateAuditRow): TierReading {
  return { tier: row.tier, state: row.verdict };
}

/**
 * May this reading set a price?
 *
 * WARM and COLD are both FRESH readings the island actually gave — a wallet below the
 * launch floor still has a real, current tier, and pricing it at that tier is honest.
 * STALE is the state the gate uses for BOTH "too old to judge on" and "we could not ask",
 * and neither may buy a discount. Null tier likewise: there is no word to price at.
 */
export function isPriceableReading(reading: TierReading | null | undefined): boolean {
  return !!reading && reading.tier !== null && reading.state !== 'STALE';
}

/** Overrides for tests and for a caller that has already resolved the dials. */
export interface PricingOptions {
  tierPricingEnabled?: boolean;
  creatorShareEnabled?: boolean;
  creatorShareOfVenueBps?: number;
  table?: Readonly<Record<HeatTier, number>>;
}

/** The resolved price of one launch. Immutable once the launch tx mines. */
export interface ResolvedLaunchPricing {
  /** bps of the pool trade fee the venue keeps under this launch's constitution. */
  venueBps: number;
  /** The venue's line at the standard rate, for comparison. */
  standardVenueBps: number;
  /** bps the Heat tier moved off the venue's line. */
  tierDiscountBps: number;
  /** bps the creator revenue share moved off the venue's line. */
  creatorShareBps: number;
  /** Total bps the creator receives ABOVE the standard creator+attention pool. */
  creatorBonusBps: number;
  /** The tier this price was resolved at. NULL whenever no fresh tier was available. */
  pricedAtTier: HeatTier | null;
  /** FALSE when tier pricing was in force but no fresh tier reading existed. */
  tierReadable: boolean;
  tierPricingEnabled: boolean;
  creatorShareEnabled: boolean;
}

/** bps -> "15.00%". Shares are of the pool's trade fee, never of trade volume. */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Price one launch from the Heat gate's own reading.
 *
 * Pure and synchronous: the reading is passed in, never fetched, so the venue reads the
 * island's judgement and never recomputes it. Pass `null` when no read happened at all —
 * that is the same as an unreachable instrument and prices at the standard rate.
 */
export function resolveLaunchPricing(
  reading: TierReading | null | undefined,
  opts: PricingOptions = {},
): ResolvedLaunchPricing {
  const tierPricingEnabled = opts.tierPricingEnabled ?? isHeatTierPricingEnabled();
  const creatorShareEnabled = opts.creatorShareEnabled ?? isCreatorFeeShareEnabled();
  const table = opts.table ?? heatTierVenueTable();

  const priceable = isPriceableReading(reading);
  // Named ONLY when the island freshly said it. Constraint 3: no tier word is ever
  // inferred, defaulted, or carried over from an earlier screen.
  const pricedAtTier = priceable ? (reading as TierReading).tier : null;

  // A faulty table is not applied at all. Belt-and-braces over `heatTierVenueTable`,
  // which already discards a faulty override — an explicitly injected table gets the
  // same treatment rather than being trusted because a caller passed it.
  const tableUsable = tierTableFault(table) === null;
  const tieredVenueBps =
    tierPricingEnabled && tableUsable && pricedAtTier !== null
      ? table[pricedAtTier]
      : STANDARD_VENUE_LINE_BPS;

  const rawShare = opts.creatorShareOfVenueBps ?? creatorFeeShareOfVenueBps();
  const shareOfVenueBps =
    creatorShareEnabled && Number.isInteger(rawShare) && rawShare > 0 && rawShare <= MAX_CREATOR_FEE_SHARE_BPS
      ? rawShare
      : 0;
  // Floor, so rounding can only ever leave the venue holding the odd basis point rather
  // than over-crediting a creator line the constitution then has to find bps for.
  const creatorShareBps = Math.floor((tieredVenueBps * shareOfVenueBps) / BPS_TOTAL);
  const venueBps = tieredVenueBps - creatorShareBps;

  return {
    venueBps,
    standardVenueBps: STANDARD_VENUE_LINE_BPS,
    tierDiscountBps: STANDARD_VENUE_LINE_BPS - tieredVenueBps,
    creatorShareBps,
    creatorBonusBps: STANDARD_VENUE_LINE_BPS - venueBps,
    pricedAtTier,
    tierReadable: priceable,
    tierPricingEnabled,
    creatorShareEnabled,
  };
}

/** Today's economics: both dials off, standard venue line, nothing claimed. */
export function standardLaunchPricing(): ResolvedLaunchPricing {
  return resolveLaunchPricing(null, {
    tierPricingEnabled: false,
    creatorShareEnabled: false,
    creatorShareOfVenueBps: 0,
  });
}

/**
 * Is this the price every launch already pays, with neither feature in force?
 *
 * Used to decide whether the Fact Sheet carries a pricing disclosure at all. When both
 * dials are off there is nothing to disclose beyond the constitution itself, and omitting
 * the field keeps `disclosuresDigest` byte-identical to every sheet computed before this
 * module existed.
 */
export function isStandardPricing(p: ResolvedLaunchPricing): boolean {
  return !p.tierPricingEnabled && !p.creatorShareEnabled && p.creatorBonusBps === 0;
}

/**
 * The buyer-facing sentences. Every clause below is a statement about something that was
 * actually read or actually applied — there is no branch that names a tier without one,
 * and no branch that claims a discount that is not in the numbers beside it.
 */
export function pricingNote(p: ResolvedLaunchPricing): string {
  const parts: string[] = [];
  parts.push(
    `The venue's share of this launch's pool trade fee is ${pct(p.venueBps)}, against a standard rate of ${pct(p.standardVenueBps)}.`,
  );

  if (p.tierPricingEnabled) {
    if (p.pricedAtTier === null) {
      // The outage sentence. It states the absence, states the consequence, and claims
      // nothing about the wallet — an unread instrument is not a cold one.
      parts.push(
        'The island gave no fresh Heat reading for the launching wallet, so this launch was priced at the standard rate. No tier discount was applied and no tier is claimed.',
      );
    } else if (p.tierDiscountBps > 0) {
      parts.push(
        `Heat tier ${p.pricedAtTier} priced the venue's line ${pct(p.tierDiscountBps)} below the standard rate; that difference is paid to the creator.`,
      );
    } else {
      parts.push(`Heat tier ${p.pricedAtTier} carries no discount off the standard rate.`);
    }
  }

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

/**
 * The Fact Sheet disclosure, or undefined when there is nothing to disclose.
 *
 * `tierReadable` is emitted ONLY in the negative and ONLY when tier pricing was actually
 * in force — matching the third-state convention the rest of the sheet uses, so a sheet
 * that priced off a real reading digests exactly as it would without the field.
 */
export function toPricingDisclosure(p: ResolvedLaunchPricing): LaunchPricingDisclosure | undefined {
  if (isStandardPricing(p)) return undefined;
  return {
    venueShareBps: p.venueBps,
    standardVenueShareBps: p.standardVenueBps,
    tierDiscountBps: p.tierDiscountBps,
    creatorRevenueShareBps: p.creatorShareBps,
    pricedAtTier: p.pricedAtTier,
    ...(p.tierPricingEnabled && !p.tierReadable ? { tierReadable: false as const } : {}),
    note: pricingNote(p),
  };
}

/**
 * Price a launch for `address` by asking THE DOOR — the one gate primitive in the repo.
 *
 * The single async entry point, so a wizard wires pricing in one call and has no reason to
 * grow its own oracle read. `meetsHeatFloor` never throws for an unreachable instrument;
 * it returns the STALE decision, which prices at the standard rate through the same path
 * as every other unreadable state. `skipAudit` mirrors the door's own preview reads — the
 * enforcing read at submit is what belongs in the audit ring, and a wizard that re-renders
 * would otherwise fill it with duplicates of one reading.
 *
 * The result must be resolved ONCE and handed to BOTH the projected Fact Sheet and the
 * launch config. Calling this twice can legitimately return two different prices, and the
 * split shown must be the split signed.
 */
export async function readLaunchPricing(
  address: string,
  opts: PricingOptions & { signal?: AbortSignal } = {},
): Promise<ResolvedLaunchPricing> {
  const { meetsHeatFloor } = await import('../heat/launchGate');
  const { decision } = await meetsHeatFloor(address, { skipAudit: true, signal: opts.signal });
  return resolveLaunchPricing(tierReadingFromDecision(decision), opts);
}

/** The venue's line as it stands in a resolved constitution. Absent line means zero kept. */
export function venueLineBps(lines: readonly Pick<FeeConstitutionLine, 'role' | 'shareBps'>[]): number {
  return lines.filter((l) => l.role === 'protocol-stakers').reduce((n, l) => n + l.shareBps, 0);
}

/**
 * Why a built launch config may NOT be submitted against the live reading, or null.
 *
 * ASYMMETRIC ON PURPOSE. A config that keeps AT LEAST what the live price says the venue
 * keeps is fine — the creator gets exactly the split they were shown, and being shown a
 * worse-than-optimal price is not a reason to refuse someone's launch. The refusal is for
 * the other direction only: a config claiming a DEEPER discount than the live instrument
 * currently justifies would mint a permanent price off a reading that has since gone
 * stale or cooled. With both dials off this is unreachable — live and deployed are both
 * the standard line — so today's path is untouched.
 */
export function pricingRefusal(deployedVenueBps: number, live: ResolvedLaunchPricing): string | null {
  if (deployedVenueBps >= live.venueBps) return null;
  return `This launch was priced at a ${pct(STANDARD_VENUE_LINE_BPS - deployedVenueBps)} venue discount, but the island's current reading supports ${pct(live.creatorBonusBps)}. Re-review the fee constitution before launching.`;
}
