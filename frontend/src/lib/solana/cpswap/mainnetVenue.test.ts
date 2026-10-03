// @vitest-environment node
// (PDA derivation needs the Node realm; see program.test.ts.)
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { browserCurveRpc } from '../../launcher/solana/curve/rpc';
import { readFeeTiers } from '../lp/poolFinder';
import { tradeCostText } from '../lp/format';
import { quoteOwnPool, readVenue } from './read';
import type { PoolStateView } from './program';
import { CREATOR_FEE_SWITCH, chargedCreatorFeeRate, feeSplit, tradeCost } from './venue';
import { RECORDING, recordedFeeTiers, recordedRpc, recordedTier } from './mainnetVenueReplay.fixture';

// The two fee tiers mainnet holds, as /pools read them (scripts/record-pools-venue-fixture.mjs),
// read back through the repo's own read path. Tier 0 is where launches graduate; it charges
// a creator fee, and only on the pools the launch program opens. Tier 1 is the public tier
// this site opens pools on.

const PROGRAM = new PublicKey(RECORDING.program);

describe('the recorded mainnet venue, through the read path', () => {
  it('readVenue reads tier 0 live, the same tier the recording decodes to', async () => {
    const calls: string[] = [];
    const v = await readVenue(browserCurveRpc(recordedRpc(calls)), PROGRAM, 0);
    expect(v.kind).toBe('live');
    if (v.kind !== 'live') return;
    expect(v.config).toEqual(recordedTier(0));
    // The probe followed the program stub to its ProgramData, then read the tier.
    expect(calls).toEqual([
      `getAccountInfo:${RECORDING.program}`,
      `getAccountInfo:${RECORDING.programData}`,
      `getAccountInfo:${RECORDING.tier0}`,
    ]);
  });

  it('readFeeTiers reads both tiers, and the rents it quotes for opening one', async () => {
    const r = await readFeeTiers(recordedRpc(), PROGRAM);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.tiers.map((t) => t.state)).toEqual(['live', 'live']);
    expect(r.tiers[0]!.config).toEqual(recordedTier(0));
    expect(r.tiers[1]!.config).toEqual(recordedTier(1));
    expect(r.openingDeposits).not.toBeNull();
    // What the jsdom component tests hand the fee-tier card instead of reading it.
    expect(r).toEqual(recordedFeeTiers());
  });

  it('holds the rates the bug was found on (2026-10-03)', () => {
    const t0 = recordedTier(0);
    const t1 = recordedTier(1);
    expect([t0.index, t0.tradeFeeRate, t0.protocolFeeRate, t0.fundFeeRate, t0.createPoolFee, t0.creatorFeeRate]).toEqual([0, 2_500n, 200_000n, 0n, 0n, 500n]);
    expect([t1.index, t1.tradeFeeRate, t1.protocolFeeRate, t1.fundFeeRate, t1.createPoolFee, t1.creatorFeeRate]).toEqual([1, 10_000n, 160_000n, 0n, 150_000_000n, 0n]);
  });
});

describe('what a trade costs: the tier sets the creator rate, the pool decides whether it is charged', () => {
  it('cp-swap adjust_creator_fee_rate: the rate when the pool switch is on, nothing when it is off', () => {
    const t0 = recordedTier(0);
    expect(chargedCreatorFeeRate(t0, true)).toBe(500n);
    expect(chargedCreatorFeeRate(t0, false)).toBe(0n);
    // The launch program opens through initialize_with_permission (switch on); anyone
    // else, and this site's Open a pool, through initialize (switch off).
    expect(CREATOR_FEE_SWITCH).toEqual({ launchPool: true, publicOpen: false });
  });

  it('a launch pool on tier 0 costs 0.3% a trade: 0.25% trade fee plus the 0.05% creator fee', () => {
    const t0 = recordedTier(0);
    const c = tradeCost(t0, chargedCreatorFeeRate(t0, CREATOR_FEE_SWITCH.launchPool));
    expect(c).toEqual({ tradeFeeRate: 2_500n, creatorFeeRate: 500n, totalRate: 3_000n });
    expect(tradeCostText(t0, CREATOR_FEE_SWITCH.launchPool)).toBe('0.3% a trade (0.25% trade fee, 0.05% creator fee)');
  });

  it('a pool opened any other way on tier 0 costs the trade fee alone, and says it charges no creator fee', () => {
    const t0 = recordedTier(0);
    expect(tradeCost(t0, chargedCreatorFeeRate(t0, CREATOR_FEE_SWITCH.publicOpen)).totalRate).toBe(2_500n);
    expect(tradeCostText(t0, CREATOR_FEE_SWITCH.publicOpen)).toBe('0.25% a trade (no creator fee)');
  });

  it('tier 1 has no creator rate, so a trade costs its 1% whatever the pool switch says', () => {
    const t1 = recordedTier(1);
    for (const on of [true, false]) {
      expect(tradeCost(t1, chargedCreatorFeeRate(t1, on)).totalRate).toBe(10_000n);
      expect(tradeCostText(t1, on)).toBe('1% a trade');
    }
  });

  // The swap route quotes our tier-0 pool for a pair with quoteOwnPool and the tier readVenue
  // returned (SolanaRouteLine.tsx). Its quote must cost what the program charges.
  it("the swap route's quote on a launch pool takes the 0.3% a buy pays, creator fee included", () => {
    const t0 = recordedTier(0);
    const WSOL = 'So11111111111111111111111111111111111111112';
    const TOKEN = 'TokenMint1111111111111111111111111111111111';
    const snapshot = (enableCreatorFee: boolean) => ({
      // The launch program's mode: the creator is paid in SOL, which is token 0 here.
      pool: { address: 'Pool', status: 0, openTime: 0n, token0Mint: WSOL, token1Mint: TOKEN, creatorFeeOn: 1, enableCreatorFee } as PoolStateView,
      vault0Amount: 100n * 10n ** 9n, vault1Amount: 10n ** 15n, reserve0: 100n * 10n ** 9n, reserve1: 10n ** 15n,
    });
    const amountIn = 10n ** 9n; // 1 SOL in
    const launch = quoteOwnPool(snapshot(true), t0, WSOL, amountIn, 1)!;
    const plain = quoteOwnPool(snapshot(false), t0, WSOL, amountIn, 1)!;
    // On the input: the program charges 0.3% of it in all, and splits 0.05% back out to the creator.
    expect(launch.creatorFeeOnInput).toBe(true);
    expect(launch.result.tradeFee + launch.result.creatorFee).toBe(3_000_000n);
    expect(launch.result.creatorFee).toBe(500_000n);
    expect(plain.result.tradeFee).toBe(2_500_000n);
    expect(plain.result.creatorFee).toBe(0n);
    expect(launch.outAmount).toBeLessThan(plain.outAmount);
  });

  it('every basis point a trader pays is accounted for: LPs + venue + creator', () => {
    for (const t of [recordedTier(0), recordedTier(1)]) {
      for (const on of [true, false]) {
        const creator = chargedCreatorFeeRate(t, on);
        const s = feeSplit(t);
        const c = tradeCost(t, creator);
        // In hundredths of a bip (1% = 10,000), the unit the tier itself uses, so the sum
        // is compared as an integer.
        const parts = Math.round((s.lpKeepsPct + s.venueTakesPct) * 1e4) + Number(creator);
        expect(parts).toBe(Number(c.totalRate));
      }
    }
  });
});
