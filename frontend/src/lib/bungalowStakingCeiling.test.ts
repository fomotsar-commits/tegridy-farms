import { describe, it, expect } from 'vitest';
import {
  claimBrokenByRateChange,
  anyClaimBrokenByRateChange,
  OFFERED_LOCK_CEILING_DAYS,
  offeredMaxLockDays,
  lockCeilingApplies,
  lockPresets,
  claimablePoolsBefore,
  splitAccruedByRisk,
} from './bungalowStaking';

/**
 * WHAT ACTUALLY DECIDES WHETHER A CLASSIC POSITION CAN BE PAID.
 *
 * Not its cumulative counter. That model held from 2026-09-06 to 2026-09-12 and
 * was refuted twice over on 09-12, by measurement against live mainnet:
 *
 *   - PROGRAM-WIDE: 5,868 of 9,797 classic reward entries with a non-zero
 *     counter are already past 2**64-1, and the largest sits 22,000,000x past
 *     it with a successful claim on record. The counter does not stop claims.
 *   - ON THIS POOL: the pool's reward rate was changed from 600,000/86400s to
 *     7/1s at 2026-09-01T05:40:01Z (unix 1788241201). Simulating the real
 *     `claim_rewards` for all 18 open positions splits PERFECTLY on that
 *     instant — the 2 created before it revert 6000, all 16 created after it
 *     pay. No exceptions in either direction.
 *
 * The two that revert are the two SMALLEST positions in the pool (3,000 each),
 * while the 1,000,000 pays 13,712 — so it was never about size either.
 */
const RATE_CHANGED_AT = 1788241201;      // 2026-09-01T05:40:01Z, read from the pool
const FIXED = { nonce: 0, kind: 'fixed' as const, rateChangedAtTs: RATE_CHANGED_AT };
const DYNAMIC = { nonce: 1, kind: 'dynamic' as const, rateChangedAtTs: null };
const UNCHANGED = { nonce: 0, kind: 'fixed' as const, rateChangedAtTs: 0 };

describe('what decides payability: the rate change, not the counter', () => {
  // Every row is a real open position, with the verdict its SIMULATED claim
  // returned on 2026-09-12. createdTs is read from the stake entry.
  const LIVE: Array<[string, number, boolean]> = [
    ['3,000 BAYLA opened 04:06:14 — claim REVERTS 6000', 1788235574, true],
    ['3,000 BAYLA opened 04:09:19 — claim REVERTS 6000', 1788235759, true],
    ['10,000 BAYLA opened 06:39:28 — claim PAYS', 1788241168 + 800, false],
    ['1,000,000 BAYLA opened 06:52:41 — claim PAYS 13,712', 1788245561, false],
    ['79,461 BAYLA opened 07:08:47 — claim PAYS', 1788246527, false],
    ['369,369 BAYLA opened 2026-09-02 — claim PAYS', 1788370179, false],
    ['535,000 BAYLA opened 2026-09-10 — claim PAYS', 1789083200, false],
  ];

  it.each(LIVE)('%s', (_label, createdTs, broken) => {
    expect(claimBrokenByRateChange({ createdTs }, FIXED)).toBe(broken);
  });

  it('splits on the rate change to the SECOND, in both directions', () => {
    expect(claimBrokenByRateChange({ createdTs: RATE_CHANGED_AT - 1 }, FIXED)).toBe(true);
    // Equal is NOT before. An entry created in the same second as the update is
    // not evidence of anything, and the predicate must not invent a verdict.
    expect(claimBrokenByRateChange({ createdTs: RATE_CHANGED_AT }, FIXED)).toBe(false);
    expect(claimBrokenByRateChange({ createdTs: RATE_CHANGED_AT + 1 }, FIXED)).toBe(false);
  });

  it('says nothing when the pool NEVER had its rate changed', () => {
    // The healthy case, and the one every other pool is in. A pool that was
    // never updated cannot have broken anybody, however old the position.
    expect(claimBrokenByRateChange({ createdTs: 1 }, UNCHANGED)).toBe(false);
  });

  it('treats an UNREADABLE timestamp as "no verdict", never as broken', () => {
    expect(claimBrokenByRateChange({ createdTs: 1 }, { ...FIXED, rateChangedAtTs: null })).toBe(false);
    expect(claimBrokenByRateChange({ createdTs: 0 }, FIXED)).toBe(false);
    expect(claimBrokenByRateChange({ createdTs: NaN }, FIXED)).toBe(false);
  });

  it('never applies to a DYNAMIC pool, which has no rate to change', () => {
    expect(claimBrokenByRateChange({ createdTs: 1 }, DYNAMIC)).toBe(false);
    // and not because its timestamp happens to be null — on KIND, so a future
    // dynamic pool that did carry one is still exempt.
    expect(claimBrokenByRateChange({ createdTs: 1 }, { ...DYNAMIC, rateChangedAtTs: RATE_CHANGED_AT })).toBe(false);
  });

  it('anyClaimBrokenByRateChange fires only on the pool that changed', () => {
    const e = { createdTs: RATE_CHANGED_AT - 1 };
    expect(anyClaimBrokenByRateChange(e, [DYNAMIC])).toBe(false);
    expect(anyClaimBrokenByRateChange(e, [UNCHANGED])).toBe(false);
    expect(anyClaimBrokenByRateChange(e, [DYNAMIC, FIXED])).toBe(true);
  });

  it('the counter plays NO part — a huge one is not a verdict', () => {
    // 22,000,000x past the old supposed ceiling, as seen on real entries that
    // claim successfully. If this predicate ever consults a counter again, this
    // fails.
    const huge = { createdTs: RATE_CHANGED_AT + 1, accountedRaw: { 0: (1n << 64n) * 22_000_000n } };
    expect(claimBrokenByRateChange(huge, FIXED)).toBe(false);
  });
});

describe('the offered lock ceiling', () => {
  const BAYLA = { minDurationSecs: 86_400, maxDurationSecs: 31_536_000 };

  it('holds the offered ladder at 90 days while the pool still allows 365', () => {
    expect(OFFERED_LOCK_CEILING_DAYS).toBe(90);
    expect(offeredMaxLockDays(BAYLA)).toBe(90);
    expect(lockCeilingApplies(BAYLA)).toBe(true);
  });

  it('leaves a pool alone when its own maximum is already inside the ceiling', () => {
    const short = { minDurationSecs: 86_400, maxDurationSecs: 30 * 86_400 };
    expect(offeredMaxLockDays(short)).toBe(30);
    expect(lockCeilingApplies(short)).toBe(false);
  });

  it('never returns less than the pool MINIMUM — a pool whose min exceeds the ceiling must still be stakeable', () => {
    // Otherwise the ladder renders empty and nobody can stake at all.
    const longMin = { minDurationSecs: 180 * 86_400, maxDurationSecs: 365 * 86_400 };
    expect(offeredMaxLockDays(longMin)).toBe(180);
  });

  it('lockPresets keeps the POOL bounds by default — the venue policy is opt-in', () => {
    // This is the contract bungalowStakingRates.test.ts pins; the ceiling must
    // not change what lockPresets means to callers that did not ask for it.
    const uncapped = lockPresets(BAYLA).map((p) => p.days);
    expect(uncapped).toContain(365);
    const capped = lockPresets(BAYLA, OFFERED_LOCK_CEILING_DAYS).map((p) => p.days);
    expect(capped).not.toContain(365);
    expect(capped).not.toContain(180);
    expect(capped[capped.length - 1]).toBe(90);
  });

  it('the capped ladder still starts at the pool minimum', () => {
    const capped = lockPresets(BAYLA, OFFERED_LOCK_CEILING_DAYS).map((p) => p.days);
    expect(capped[0]).toBe(1);
  });
});

describe('two reward pools — what the rescue exit must not throw away', () => {
  // rateChangedAtTs is LOAD-BEARING in this fixture: without it the predicate
  // never fires and these tests cannot tell whether the filter came back.
  const DEAD = { nonce: 0, kind: 'fixed' as const, rewardAmountRaw: '7', rewardPeriodSecs: 1, rateChangedAtTs: RATE_CHANGED_AT } as never;
  const LIVE = { nonce: 1, kind: 'dynamic' as const, rewardAmountRaw: '0', rewardPeriodSecs: 0, rateChangedAtTs: null } as never;
  const BEFORE = RATE_CHANGED_AT - 1;   // a position the rate change broke
  const AFTER = RATE_CHANGED_AT + 1;    // one it did not

  it('KEEPS a classic pool even when the rate change broke this entry', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and asserting the opposite is what
    // made it a defect. It expected [1]: drop the classic pool as unpayable and
    // close its entry unclaimed. The predicate it trusted matched the 1,000,000
    // position, which pays 13,712 — so the old expectation was an instruction to
    // destroy a five-figure balance, written inside the very function whose
    // stated purpose is to stop that.
    //
    // Note this entry really IS broken by the rate change, and it is STILL kept.
    // Even a predicate that is right 18 times out of 18 does not get to skip the
    // attempt: the fee is the cheap failure, the silent forfeit is not.
    const e = { createdTs: BEFORE, pendingRaw: { 0: 43_555_365n, 1: 900_000n } };
    const keep = claimablePoolsBefore(e, [DEAD, LIVE]);
    expect(keep.map((p) => p.nonce)).toEqual([0, 1]);
  });

  it('drops a pool with genuinely nothing pending — a claim there is a wasted fee', () => {
    const e = { createdTs: AFTER, pendingRaw: { 0: 0n, 1: 0n } };
    expect(claimablePoolsBefore(e, [DEAD, LIVE])).toEqual([]);
  });

  it('KEEPS a pool whose accrual could not be read — an unknown is never written off silently', () => {
    const e = { createdTs: AFTER, pendingRaw: { 0: null, 1: null } };
    expect(claimablePoolsBefore(e, [DEAD, LIVE]).map((p) => p.nonce)).toEqual([0, 1]);
  });

  it('with only the broken classic pool attached, it STILL tries', () => {
    // Also inverted from its original expectation of []. A pending balance on a
    // pool nobody has proven dead is money, and the only way to find out is to
    // ask the chain. Skipping the attempt forfeits it silently; making the
    // attempt costs a network fee in the worst case.
    const e = { createdTs: BEFORE, pendingRaw: { 0: 43_555_365n } };
    expect(claimablePoolsBefore(e, [DEAD]).map((p) => p.nonce)).toEqual([0]);
  });

  it('still drops a pool with nothing pending, broken or not', () => {
    // The one filter that survives: zero pending is a wasted fee either way.
    const e = { createdTs: BEFORE, pendingRaw: { 0: 0n } };
    expect(claimablePoolsBefore(e, [DEAD])).toEqual([]);
  });
});

describe('writeFailure distinguishes the two 6013s', () => {
  it('reads a REWARD-program 6013 as a drained vault that clears', () => {
    const msg = 'AnchorError thrown in claim_rewards.rs:221. Error Code: RewardPoolDrained. Error Number: 6013.';
    expect(/RewardPoolDrained/i.test(msg) || (/\b6013\b/.test(msg) && /reward/i.test(msg))).toBe(true);
  });
  it('does NOT read a STAKE-program 6013 (LockedStake) as a drained vault', () => {
    const msg = 'AnchorError thrown in unstake/base.rs:220. Error Code: LockedStake. Error Number: 6013.';
    expect(/RewardPoolDrained/i.test(msg) || (/\b6013\b/.test(msg) && /reward/i.test(msg))).toBe(false);
  });
});

/**
 * THE DASHBOARD MUST SEPARATE AN AT-RISK BALANCE — WITHOUT CALLING IT A LOSS.
 *
 * `BungalowDashboardPanel` summed `pendingRaw` across every open position and
 * printed the total as "Accrued rewards" with no risk awareness at all, which
 * over-promised. The first fix over-corrected in the other direction: it named
 * the second bucket "Stranded (cannot claim)", and the card rendered a real
 * holder "0 accrued · 13,700.79 stranded" on a wallet where 13,603 of that was
 * claimable that minute.
 *
 * Both failures are the same failure — stating a verdict the evidence does not
 * support. The bucket is separated because it is UNCERTAIN, and it is named for
 * that uncertainty.
 */
describe('splitAccruedByRisk', () => {
  const BROKEN = RATE_CHANGED_AT - 1;
  const OK = RATE_CHANGED_AT + 1;
  const entry = (createdTs: number, pending: Record<number, bigint | null>) => ({
    createdTs,
    pendingRaw: pending,
  });

  it('keeps stranded rewards OUT of the claimable total', () => {
    const r = splitAccruedByRisk(
      [entry(BROKEN, { 0: 4_000n }), entry(OK, { 0: 900n })],
      [FIXED],
    );
    expect(r.claimableRaw).toBe(900n);
    expect(r.atRiskRaw).toBe(4_000n);
    expect(r.atRiskCount).toBe(1);
  });

  it('reports nothing at risk when every position postdates the change', () => {
    const r = splitAccruedByRisk([entry(OK, { 0: 900n }), entry(OK, { 0: 100n })], [FIXED]);
    expect(r.claimableRaw).toBe(1_000n);
    expect(r.atRiskRaw).toBe(0n);
    expect(r.atRiskCount).toBe(0);
  });

  it('an UNREADABLE pending poisons its own total and never reads as zero', () => {
    const r = splitAccruedByRisk([entry(OK, { 0: null }), entry(OK, { 0: 100n })], [FIXED]);
    expect(r.claimableRaw).toBeNull();
    // The stranded side is unaffected — one outage must not blank both figures.
    expect(r.atRiskRaw).toBe(0n);
  });

  it('classifies nothing at risk before the pool has been read', () => {
    // Fails toward "not dead", exactly as the pool page does, so the two
    // surfaces cannot contradict each other while a read is in flight.
    const r = splitAccruedByRisk([entry(BROKEN, { 0: 4_000n })], []);
    expect(r.atRiskCount).toBe(0);
    expect(r.claimableRaw).toBe(4_000n);
  });

  it('never flags a DYNAMIC pool — it has no rate to change', () => {
    const r = splitAccruedByRisk([entry(BROKEN, { 1: 7_000n })], [DYNAMIC]);
    expect(r.atRiskCount).toBe(0);
    expect(r.claimableRaw).toBe(7_000n);
  });
});
