import { describe, it, expect } from 'vitest';
import {
  previewBuy,
  previewSell,
  splitFee,
  graduationProgressBps,
  listingRatioBps,
  saleSupplyForReserveBps,
  withSlippage,
  curveLauncherOn,
  buyCall,
  sellCall,
  createLaunchCall,
  mcapWei,
  latestLaunchWindow,
  CURVE_TOTAL_SUPPLY,
  CURVE_LAUNCHER_ABI,
} from './curve';

// The economics the deploy script defaults to (docs/CURVE_ECONOMICS.md) and the
// Solidity test fixture uses — so the numbers below are the SAME numbers the
// contract's own tests assert, which is what makes this a cross-contract mirror
// rather than a self-consistency check.
const VIRTUAL_ETH = 200000000000000000n; // 0.2 ETH
const GRADUATION_ETH = 3800000000000000000n; // 3.8 ETH (19 * virtual)
const FEE_BPS = 100; // 1%
const CREATOR_SHARE_BPS = 4000; // 40%
const TREASURY_SHARE_BPS = 2500; // 25%
const RESERVE_BPS = 500; // 5% (the Solidity fixture; production default is 369)
const SALE_SUPPLY = saleSupplyForReserveBps(RESERVE_BPS);

const freshLaunch = {
  virtualEth: VIRTUAL_ETH,
  graduationEth: GRADUATION_ETH,
  feeBps: FEE_BPS,
  ethReserve: 0n,
  tokenReserve: SALE_SUPPLY,
};

describe('curve math mirror — agrees with TegridyCurveLauncher to the wei', () => {
  it('previewBuy reproduces the contract EXACTLY (the pinned first-buy output)', () => {
    // This literal is the value TegridyCurveLauncher._buy produces for a 1-ETH
    // first buy at these params — the same number its Solidity test pins (and
    // the mutation that rounds UP produced ...017, which this would catch).
    const q = previewBuy(freshLaunch, 1_000000000000000000n);
    expect(q.fee).toBe(10000000000000000n); // 1e18 * 100 / 10000
    expect(q.ethIn).toBe(990000000000000000n);
    expect(q.tokensOut).toBe(790336134453781512605042016n);
    expect(q.wouldGraduate).toBe(false);
  });

  it('previewBuy rounds tokens-out DOWN (curve-favoring)', () => {
    // A gross value whose exact division has a remainder — the quote must be the
    // floor, so the on-chain buy never delivers less than quoted.
    const q = previewBuy(freshLaunch, 333333n);
    const feeBps = BigInt(FEE_BPS);
    const fee = (333333n * feeBps) / 10000n;
    const ethIn = 333333n - fee;
    const x = VIRTUAL_ETH;
    expect(q.tokensOut).toBe((SALE_SUPPLY * ethIn) / (x + ethIn));
  });

  it('previewBuy flags the graduating buy', () => {
    const q = previewBuy(freshLaunch, 4_000000000000000000n); // 4 ETH gross > 3.8 target
    expect(q.wouldGraduate).toBe(true);
  });

  it('a buy→sell round-trip strictly loses (two 1% fees + rounding)', () => {
    const buy = previewBuy(freshLaunch, 1_000000000000000000n);
    const afterBuy = {
      virtualEth: VIRTUAL_ETH,
      ethReserve: buy.ethIn,
      tokenReserve: SALE_SUPPLY - buy.tokensOut,
      feeBps: FEE_BPS,
    };
    const sell = previewSell(afterBuy, buy.tokensOut);
    expect(sell.ethOut).toBeLessThan(1_000000000000000000n);
    // Conservation on the ETH side: the curve keeps ethIn, and grossOut it
    // released cannot exceed what the buy put in.
    expect(sell.grossOut).toBeLessThanOrEqual(buy.ethIn);
  });

  it('splitFee is a 3-way exact-sum split, creator + treasury round DOWN', () => {
    const fee = 30001n; // odd, so the split can't be symmetric
    const s = splitFee(fee, CREATOR_SHARE_BPS, TREASURY_SHARE_BPS);
    expect(s.creatorCut).toBe(12000n); // 30001 * 4000 / 10000 (floor)
    expect(s.treasuryCut).toBe(7500n); // 30001 * 2500 / 10000 (floor)
    expect(s.protocolCut).toBe(10501n); // the remainder
    expect(s.creatorCut + s.treasuryCut + s.protocolCut).toBe(fee);
  });

  it('splitFee never overpays: the three cuts sum to the fee for many shares', () => {
    for (const fee of [0n, 1n, 999n, 1_000000n, 123456789n]) {
      for (const c of [0, 1, 4000, 6000, 10000]) {
        for (const t of [0, 2500, 4000]) {
          if (c + t > 10000) continue;
          const s = splitFee(fee, c, t);
          expect(s.creatorCut + s.treasuryCut + s.protocolCut).toBe(fee);
          expect(s.protocolCut).toBeGreaterThanOrEqual(0n);
        }
      }
    }
  });

  it('graduationProgressBps tracks the raise and clamps at 100%', () => {
    expect(graduationProgressBps(0n, GRADUATION_ETH)).toBe(0);
    expect(graduationProgressBps(1_900000000000000000n, GRADUATION_ETH)).toBe(5000); // 1.9/3.8
    expect(graduationProgressBps(GRADUATION_ETH, GRADUATION_ETH)).toBe(10000);
    expect(graduationProgressBps(9_000000000000000000n, GRADUATION_ETH)).toBe(10000); // overshoot clamps
  });

  it('listingRatioBps hits the 5% band edge at the continuity target', () => {
    // At ethReserve == graduationEth (19 * virtualEth), listing = 3.8/4.0 = 95%.
    expect(listingRatioBps(VIRTUAL_ETH, GRADUATION_ETH)).toBe(9500);
    // Below target it is worse (further under the curve price).
    expect(listingRatioBps(VIRTUAL_ETH, 0n)).toBe(0);
  });

  it('saleSupplyForReserveBps carves the reserve off the fixed supply', () => {
    expect(saleSupplyForReserveBps(0)).toBe(CURVE_TOTAL_SUPPLY);
    expect(saleSupplyForReserveBps(369)).toBe(
      CURVE_TOTAL_SUPPLY - (CURVE_TOTAL_SUPPLY * 369n) / 10000n,
    );
    expect(saleSupplyForReserveBps(500)).toBe(SALE_SUPPLY);
  });

  it('withSlippage floors the minOut below the quote', () => {
    expect(withSlippage(1000n, 100)).toBe(990n); // 1% tolerance
    expect(withSlippage(1000n, 0)).toBe(1000n);
    expect(withSlippage(790336134453781512605042016n, 50)).toBeLessThan(790336134453781512605042016n);
  });
});

describe('curve rail wiring', () => {
  it('is deployed on mainnet — the live launcher address (2026-08-24)', () => {
    expect(curveLauncherOn(1)).toEqual({
      status: 'deployed',
      address: '0xF4Dfa741aD63B3D95dC3Fc10D311caE507CE34dE',
    });
  });

  it('is chain-unconfigured on a chain we do not serve', () => {
    expect(curveLauncherOn(999999)).toEqual({ status: 'chain-unconfigured' });
  });

  it('write descriptors carry the right function, args, and payability', () => {
    const L = '0x1111111111111111111111111111111111111111' as const;
    const T = '0x2222222222222222222222222222222222222222' as const;
    const create = createLaunchCall(L, 'Towelie', 'TWL', 5n);
    expect(create.functionName).toBe('create');
    expect(create.args).toEqual(['Towelie', 'TWL']);
    expect(create.value).toBe(5n);

    const buy = buyCall(L, T, 1_000000000000000000n, 900n);
    expect(buy.functionName).toBe('buy');
    expect(buy.args).toEqual([T, 900n]);
    expect(buy.value).toBe(1_000000000000000000n); // buy is payable

    const sell = sellCall(L, T, 42n, 7n);
    expect(sell.functionName).toBe('sell');
    expect(sell.args).toEqual([T, 42n, 7n]);
    expect(sell.value).toBeUndefined(); // sell is NOT payable
  });

  it('the ABI exposes the 3-way fee-share fields on getLaunch + launchConfig', () => {
    const getLaunch = CURVE_LAUNCHER_ABI.find((f) => f.type === 'function' && f.name === 'getLaunch');
    // `find` narrows to a union member | undefined; the double cast is the
    // documented TS idiom for reshaping a const-asserted ABI entry in a test.
    const tuple = (getLaunch as unknown as { outputs: { components: { name: string }[] }[] }).outputs[0].components.map((c) => c.name);
    expect(tuple).toContain('creatorFeeShareBps');
    expect(tuple).toContain('treasuryFeeShareBps');
    const cfg = CURVE_LAUNCHER_ABI.find((f) => f.type === 'function' && f.name === 'launchConfig');
    const cfgOut = (cfg as unknown as { outputs: { name: string }[] }).outputs.map((o) => o.name);
    expect(cfgOut).toContain('treasuryFeeShareBps');
  });
});

describe('explorer helpers — mcap + newest-first window', () => {
  it('mcapWei is spot × total supply, exact bigint', () => {
    // spot = (virtualEth + ethReserve) / tokenReserve; pick numbers where the
    // division is exact so any rounding drift in the helper shows as a red.
    const launch = {
      virtualEth: 2n * 10n ** 17n, //   0.2 ETH
      ethReserve: 8n * 10n ** 17n, //   0.8 ETH → x = 1 ETH
      tokenReserve: CURVE_TOTAL_SUPPLY / 2n, // half the supply left on the curve
    };
    // mcap = 1 ETH * TOTAL / (TOTAL/2) = 2 ETH exactly.
    expect(mcapWei(launch)).toBe(2n * 10n ** 18n);
  });

  it('mcapWei declines a spot price where none exists (empty tokenReserve)', () => {
    expect(mcapWei({ virtualEth: 1n, ethReserve: 1n, tokenReserve: 0n })).toBeNull();
  });

  it('latestLaunchWindow returns the exact tail slice, off-by-one pinned', () => {
    // More launches than the page: start = count - size, count = size.
    expect(latestLaunchWindow(100n, 12)).toEqual({ start: 88n, count: 12n });
    // Exactly one page: the whole array, from zero.
    expect(latestLaunchWindow(12n, 12)).toEqual({ start: 0n, count: 12n });
    // Fewer than a page: the whole array, count is what exists — never padded.
    expect(latestLaunchWindow(3n, 12)).toEqual({ start: 0n, count: 3n });
    // One single launch.
    expect(latestLaunchWindow(1n, 12)).toEqual({ start: 0n, count: 1n });
    // Empty chain: a zero-count window the caller must not fetch.
    expect(latestLaunchWindow(0n, 12)).toEqual({ start: 0n, count: 0n });
  });

  it('latestLaunchWindow never asks the contract for more than exists', () => {
    for (const [count, size] of [[5n, 12], [13n, 12], [24n, 12], [25n, 24]] as const) {
      const w = latestLaunchWindow(count, size);
      expect(w.start + w.count).toBe(count); // window ends exactly at the array tail
      expect(w.count <= BigInt(size)).toBe(true);
    }
  });
});
