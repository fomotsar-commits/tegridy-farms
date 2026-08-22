// The anti-snipe fee schedule, resolved from operator CLI flags.
//
// WHY THIS EXISTS
// ---------------
// `create-config` used to take market-cap flags and nothing else, so every config
// a signing ceremony produced silently inherited `DEFAULT_ANTI_SNIPE` — a 99%
// opening fee decaying to 1% over six hours. DBC configs are IMMUTABLE: the only
// way to change those terms is to mint a new config and re-run the ceremony. So a
// v2 signing session that meant to adjust the market caps would have reproduced a
// fee that makes the token untradeable for most of its first day, discovered after
// the multisig had already signed.
//
// A number that expensive must be TYPED, not defaulted. These flags exist so the
// operator states the fee schedule out loud, sees it printed back before signing,
// and is refused outright if the opening fee is above the guardrail without saying
// so explicitly.
//
// WHAT THIS MODULE DOES NOT DO
// ----------------------------
// It does not re-validate the schedule. `dbc.ts` (`toBaseFeeParams`) already
// enforces the bounds the DBC program imposes — fee range, decay direction, the
// duration cap, and the divisibility rule that keeps the on-chain window equal to
// the disclosed one — and a second copy of those rules here would be a second
// source of truth for the same constraints. This module resolves flags into a
// schedule and applies the ONE rule that is ours rather than the program's: the
// opening-fee guardrail.
//
// It also does not model the decay curve. The intermediate fee at any moment is
// computed on chain by the DBC fee scheduler from these parameters; printing an
// interpolated table here would be this repo's own arithmetic presented as the
// venue's terms. `liveConfig.ts` reads the real curve back off the chain, which is
// the checkable version.

import {
  DEFAULT_ANTI_SNIPE,
  splitTradingFee,
  type AntiSnipeSchedule,
} from './dbc';

/**
 * The opening fee above which `create-config` refuses without an explicit
 * acknowledgement.
 *
 * 5,000 bps is where a trade pays more in fee than it keeps. That is a guardrail
 * against reproducing the 9,900 default by omission, NOT a recommendation about
 * the right anti-snipe fee — the venue's own live v1 config opens at 9,900 on
 * purpose. An operator who wants that passes the acknowledgement flag and it is
 * recorded in the shell history of the ceremony.
 */
export const MAX_UNACKNOWLEDGED_OPENING_FEE_BPS = 5_000;

/** The flag name an operator must pass to exceed the guardrail. */
export const ACKNOWLEDGE_FLAG = 'i-understand-anti-snipe';

/**
 * How long one decay period lasts is derived, not configured: the number of
 * periods is held at the default so that changing `--decay-seconds` changes how
 * FAST the fee decays and not the SHAPE of the decay. Both are legitimate dials;
 * exposing only one keeps a two-dial change from looking like a one-dial change.
 */
const NUMBER_OF_PERIOD = DEFAULT_ANTI_SNIPE.numberOfPeriod;

export interface AntiSnipeFlags {
  /** `--opening-fee-bps`. Omitted → the `DEFAULT_ANTI_SNIPE` opening fee. */
  openingFeeBps?: number | undefined;
  /** `--resting-fee-bps`. Omitted → the `DEFAULT_ANTI_SNIPE` resting fee. */
  restingFeeBps?: number | undefined;
  /** `--decay-seconds`. Omitted → the `DEFAULT_ANTI_SNIPE` window. */
  decaySeconds?: number | undefined;
}

/**
 * Turn the three flags into a schedule, leaving each unsupplied term at its
 * default. Throws on a value that is not a non-negative integer — a truncating
 * parse here would configure a fee nobody chose.
 */
export function resolveAntiSnipeSchedule(flags: AntiSnipeFlags = {}): AntiSnipeSchedule {
  const int = (v: number | undefined, name: string, fallback: number): number => {
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`--${name} must be a non-negative integer, got ${v}`);
    }
    return v;
  };

  return {
    startingFeeBps: int(flags.openingFeeBps, 'opening-fee-bps', DEFAULT_ANTI_SNIPE.startingFeeBps),
    endingFeeBps: int(flags.restingFeeBps, 'resting-fee-bps', DEFAULT_ANTI_SNIPE.endingFeeBps),
    numberOfPeriod: NUMBER_OF_PERIOD,
    totalDuration: int(flags.decaySeconds, 'decay-seconds', DEFAULT_ANTI_SNIPE.totalDuration),
    mode: DEFAULT_ANTI_SNIPE.mode,
  };
}

/**
 * True when the schedule opens above the guardrail. Separate from the throw below
 * so a caller can warn on a schedule it is not about to submit.
 */
export function exceedsOpeningFeeCeiling(schedule: AntiSnipeSchedule): boolean {
  return schedule.startingFeeBps > MAX_UNACKNOWLEDGED_OPENING_FEE_BPS;
}

/**
 * Refuse a high opening fee unless the operator said so in the command.
 *
 * The default path is the dangerous one here — an omitted flag means 99%, and the
 * cost of getting it wrong is a new config plus a new multisig ceremony. So the
 * refusal is unconditional and the escape is a flag nobody types by accident.
 */
export function assertOpeningFeeAcknowledged(
  schedule: AntiSnipeSchedule,
  acknowledged: boolean,
): void {
  if (!exceedsOpeningFeeCeiling(schedule) || acknowledged) return;
  throw new Error(
    `resolved opening fee is ${schedule.startingFeeBps} bps (${(schedule.startingFeeBps / 100).toFixed(2)}%), ` +
      `above the ${MAX_UNACKNOWLEDGED_OPENING_FEE_BPS} bps guardrail. A DBC config is IMMUTABLE: this fee ` +
      `cannot be lowered afterwards, only replaced by a new config and a new signing ceremony. ` +
      `Set --opening-fee-bps explicitly, or pass --${ACKNOWLEDGE_FLAG} to proceed at this fee.`,
  );
}

/**
 * The schedule as printed lines, for the dry-run output.
 *
 * Endpoints and window only. The fee between them is the DBC scheduler's to
 * compute, and a modelled curve printed here would be read as the terms rather
 * than as this repo's arithmetic about them.
 */
export function describeAntiSnipeSchedule(
  schedule: AntiSnipeSchedule,
  creatorTradingFeePercentage: number,
): string[] {
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const periodSeconds = schedule.totalDuration / schedule.numberOfPeriod;
  const split = splitTradingFee(schedule.endingFeeBps, creatorTradingFeePercentage);
  return [
    `  opening fee   : ${schedule.startingFeeBps} bps (${pct(schedule.startingFeeBps)}) at activation`,
    `  resting fee   : ${schedule.endingFeeBps} bps (${pct(schedule.endingFeeBps)}) after the window`,
    `  decay         : ${schedule.mode ?? 'exponential'}, ${schedule.numberOfPeriod} periods over ` +
      `${schedule.totalDuration}s (${(schedule.totalDuration / 3600).toFixed(2)}h, ${periodSeconds}s per period)`,
    `  resting split : meteora=${split.meteoraBps} partner=${split.partnerBps} creator=${split.creatorBps} bps`,
    '  (intermediate fees are computed on chain by the DBC scheduler from these terms;',
    '   read them back with liveConfig.fetchLivePoolConfig once the config exists)',
  ];
}
