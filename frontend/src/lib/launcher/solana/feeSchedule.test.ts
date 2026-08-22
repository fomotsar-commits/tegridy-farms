// The anti-snipe schedule an operator ceremony actually signs.
//
// `create-config` took market-cap flags and nothing else, so a v2 signing session
// would have silently reproduced DEFAULT_ANTI_SNIPE's 9,900 bps opening fee on a
// config that can never be edited. These tests pin the two properties that make
// that impossible to do by accident: the schedule is resolved from stated flags,
// and a high opening fee is refused rather than defaulted into.

import { describe, it, expect } from 'vitest';
import {
  ACKNOWLEDGE_FLAG,
  MAX_UNACKNOWLEDGED_OPENING_FEE_BPS,
  assertOpeningFeeAcknowledged,
  describeAntiSnipeSchedule,
  exceedsOpeningFeeCeiling,
  resolveAntiSnipeSchedule,
} from './feeSchedule';
import { DEFAULT_ANTI_SNIPE, buildDbcPartnerConfig, asSquadsVault } from './dbc';

const VAULT = asSquadsVault('GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd');
const CONFIG_KEY = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYER = 'Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7';

describe('resolveAntiSnipeSchedule', () => {
  it('takes each term from its flag', () => {
    const s = resolveAntiSnipeSchedule({
      openingFeeBps: 2_000,
      restingFeeBps: 50,
      decaySeconds: 3_600,
    });
    expect(s.startingFeeBps).toBe(2_000);
    expect(s.endingFeeBps).toBe(50);
    expect(s.totalDuration).toBe(3_600);
  });

  it('falls back to DEFAULT_ANTI_SNIPE per-term, so omitting one does not reset the others', () => {
    const s = resolveAntiSnipeSchedule({ openingFeeBps: 2_000 });
    expect(s.startingFeeBps).toBe(2_000);
    expect(s.endingFeeBps).toBe(DEFAULT_ANTI_SNIPE.endingFeeBps);
    expect(s.totalDuration).toBe(DEFAULT_ANTI_SNIPE.totalDuration);
  });

  it('reproduces DEFAULT_ANTI_SNIPE exactly when nothing is supplied', () => {
    // This is the state that shipped: no flags, so a 99% opening fee. It is still
    // reachable — but only past the guardrail below, never silently.
    expect(resolveAntiSnipeSchedule()).toEqual(DEFAULT_ANTI_SNIPE);
    expect(resolveAntiSnipeSchedule().startingFeeBps).toBe(9_900);
  });

  it('holds the period COUNT fixed, so --decay-seconds changes speed and not shape', () => {
    const fast = resolveAntiSnipeSchedule({ decaySeconds: 3_600 });
    expect(fast.numberOfPeriod).toBe(DEFAULT_ANTI_SNIPE.numberOfPeriod);
    expect(fast.totalDuration / fast.numberOfPeriod).toBe(30);
  });

  it('refuses a non-integer or negative value rather than truncating it', () => {
    // A truncated bps figure is not a smaller fee, it is a different one — and it
    // would be baked into an immutable account.
    expect(() => resolveAntiSnipeSchedule({ openingFeeBps: 20.5 })).toThrow(/opening-fee-bps/);
    expect(() => resolveAntiSnipeSchedule({ restingFeeBps: -1 })).toThrow(/resting-fee-bps/);
    expect(() => resolveAntiSnipeSchedule({ decaySeconds: Number.NaN })).toThrow(/decay-seconds/);
  });
});

describe('the opening-fee guardrail', () => {
  const high = resolveAntiSnipeSchedule({ openingFeeBps: MAX_UNACKNOWLEDGED_OPENING_FEE_BPS + 1 });
  const atCeiling = resolveAntiSnipeSchedule({
    openingFeeBps: MAX_UNACKNOWLEDGED_OPENING_FEE_BPS,
  });

  it('is below the default, or it would gate nothing', () => {
    // The whole point is to catch the inherited 9,900. A guardrail at or above it
    // would pass the exact command this exists to stop.
    expect(MAX_UNACKNOWLEDGED_OPENING_FEE_BPS).toBeLessThan(DEFAULT_ANTI_SNIPE.startingFeeBps);
  });

  it('REFUSES the inherited default when no acknowledgement is given', () => {
    expect(() => assertOpeningFeeAcknowledged(resolveAntiSnipeSchedule(), false)).toThrow(
      /guardrail/,
    );
  });

  it('names the flag and the immutability in the refusal, so the operator can act on it', () => {
    const err = (() => {
      try {
        assertOpeningFeeAcknowledged(high, false);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain(ACKNOWLEDGE_FLAG);
    expect(err!.message).toContain('IMMUTABLE');
    expect(err!.message).toContain(String(high.startingFeeBps));
  });

  it('allows it once acknowledged — the escape exists, it is just never implicit', () => {
    expect(() => assertOpeningFeeAcknowledged(high, true)).not.toThrow();
  });

  it('the ceiling itself is allowed; only ABOVE it is gated', () => {
    expect(exceedsOpeningFeeCeiling(atCeiling)).toBe(false);
    expect(exceedsOpeningFeeCeiling(high)).toBe(true);
    expect(() => assertOpeningFeeAcknowledged(atCeiling, false)).not.toThrow();
  });
});

describe('the dry-run disclosure', () => {
  const schedule = resolveAntiSnipeSchedule({ openingFeeBps: 2_000, decaySeconds: 3_600 });
  const lines = describeAntiSnipeSchedule(schedule, 60);
  const text = lines.join('\n');

  it('prints both endpoints and the window, in bps and in percent', () => {
    expect(text).toContain('2000 bps');
    expect(text).toContain('20.00%');
    expect(text).toContain('100 bps');
    expect(text).toContain('3600s');
  });

  it('prints the resting-fee split the vault actually receives', () => {
    // 1% resting → meteora 20 bps, creator 48 bps, partner 32 bps.
    expect(text).toContain('meteora=20');
    expect(text).toContain('partner=32');
    expect(text).toContain('creator=48');
  });

  it('says the intermediate fees are the chain’s, not a curve modelled here', () => {
    // Honesty gate: the DBC scheduler computes the decay. A table printed here
    // would be this repo's arithmetic read as the venue's published terms.
    expect(text).toMatch(/computed on chain/i);
    expect(text).toMatch(/fetchLivePoolConfig/);
  });
});

describe('the resolved schedule is the one that reaches the config builder', () => {
  const build = (antiSnipe: ReturnType<typeof resolveAntiSnipeSchedule>) =>
    buildDbcPartnerConfig({
      feeClaimer: VAULT,
      config: CONFIG_KEY,
      payer: PAYER,
      antiSnipe,
      initialMarketCap: 5_000,
      migrationMarketCap: 50_000,
    });

  it('carries the flagged fees through to the curve params', () => {
    const cfg = build(resolveAntiSnipeSchedule({ openingFeeBps: 2_000, restingFeeBps: 50 }));
    expect(cfg.curve.fee.baseFeeParams.feeSchedulerParam).toMatchObject({
      startingFeeBps: 2_000,
      endingFeeBps: 50,
    });
    // The disclosed split is taken from the RESTING fee, so it moves with the flag.
    expect(cfg.feeSplit.meteoraBps).toBe(10);
  });

  it('leaves dbc.ts to enforce the program-level bounds, unduplicated', () => {
    // A decay window that does not divide evenly into the period count would make
    // the on-chain window shorter than the disclosed one. That rule lives in
    // `toBaseFeeParams`; this module must not grow a second copy of it.
    expect(() => build(resolveAntiSnipeSchedule({ decaySeconds: 3_601 }))).toThrow(/divisible/);
    // Same for the decay-direction rule.
    expect(() => build(resolveAntiSnipeSchedule({ openingFeeBps: 50, restingFeeBps: 100 }))).toThrow(
      /DECAY/,
    );
  });
});
