import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  WETH_MAINNET,
  NATIVE_ETH,
  feeConstitutionToBeneficiaries,
  buildTegridyLaunchParams,
  dopplerBeneficiaryLine,
  tickToMarketCapUsd,
  type DopplerAuctionBuilder,
  type DopplerEvmSdkLike,
  type TegridyLaunchConfig,
} from './airlock';
import type { FeeConstitutionLine } from './factSheet';
import { LAUNCH_TIERS } from './config';

const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const ATTENTION = '0x2222222222222222222222222222222222222222' as Address;
const STAKERS = '0x3333333333333333333333333333333333333333' as Address;

function constitution(): (FeeConstitutionLine & { address: Address })[] {
  return [
    { recipient: 'creator', role: 'creator', shareBps: 6000, address: CREATOR },
    { recipient: 'attention', role: 'attention-beneficiary', shareBps: 1500, address: ATTENTION },
    { recipient: 'stakers/POL', role: 'protocol-stakers', shareBps: 2000, address: STAKERS },
    dopplerBeneficiaryLine(500),
  ];
}

describe('feeConstitutionToBeneficiaries', () => {
  it('converts bps to WAD shares summing to exactly 1e18', () => {
    const b = feeConstitutionToBeneficiaries(constitution());
    const sum = b.reduce((n, x) => n + x.shares, 0n);
    expect(sum).toBe(10n ** 18n);
  });

  it('maps each bps line to bps*1e14 WAD', () => {
    const b = feeConstitutionToBeneficiaries(constitution());
    const creator = b.find((x) => x.beneficiary === CREATOR)!;
    expect(creator.shares).toBe(6000n * 10n ** 14n); // 0.6e18
  });

  it('returns beneficiaries sorted ascending by address', () => {
    const b = feeConstitutionToBeneficiaries(constitution());
    const addrs = b.map((x) => x.beneficiary.toLowerCase());
    expect([...addrs].sort()).toEqual(addrs);
  });

  it('rejects a constitution that does not sum to 10000 bps', () => {
    const bad = constitution();
    bad[0].shareBps = 5000; // now sums to 9000
    expect(() => feeConstitutionToBeneficiaries(bad)).toThrow(/10000 bps/);
  });

  it('rejects a Doppler share below the 5% floor', () => {
    const bad: (FeeConstitutionLine & { address: Address })[] = [
      { recipient: 'creator', role: 'creator', shareBps: 6500, address: CREATOR },
      { recipient: 'attention', role: 'attention-beneficiary', shareBps: 1500, address: ATTENTION },
      { recipient: 'stakers', role: 'protocol-stakers', shareBps: 1900, address: STAKERS },
      dopplerBeneficiaryLine(100), // only 1% — below floor
    ];
    expect(() => feeConstitutionToBeneficiaries(bad)).toThrow(/>= 500 bps/);
  });
});

/**
 * The tick that encodes `marketCapUsd` — the exact inverse of `tickToMarketCapUsd`.
 * Used by the mock builder to emit a params shape that ROUND-TRIPS, i.e. to stand in for
 * "the SDK converted our request correctly". Tests that want the broken conversion pass
 * `tickOverride` instead.
 */
function tickForMarketCap(marketCapUsd: number, supply: bigint, numerairePriceUsd: number): number {
  const supplyNum = Number(supply) / 1e18;
  const ratio = (numerairePriceUsd * supplyNum) / marketCapUsd;
  return Math.round(Math.log(ratio) / Math.log(1.0001));
}

/**
 * Recording mock of the SDK builder — captures every call for assertion.
 *
 * `build()` returns a REALISTIC `CreateDynamicAuctionParams` shape (specifically
 * `auction.startTick` / `auction.endTick`), because that is what the real SDK returns and
 * what `buildTegridyLaunchParams` now verifies before handing params back. The previous
 * `{ ok: true }` stub meant this whole file asserted policy wiring against a shape the SDK
 * never produces — see reference_interface_selector_drift: a mock that does not match the
 * real surface cannot catch a real defect.
 *
 * `tickOverride` lets a test emit the MANGLED band the SDK's `Math.abs()` bug produces.
 */
function recordingSdk(
  tickOverride?: { startTick: number; endTick: number },
): { sdk: DopplerEvmSdkLike; calls: Record<string, unknown> } {
  const calls: Record<string, unknown> = {};
  const builder: DopplerAuctionBuilder = {
    tokenConfig(c) { calls.tokenConfig = c; return builder; },
    saleConfig(c) { calls.saleConfig = c; return builder; },
    withVesting(c) { calls.vesting = c; return builder; },
    withMarketCapRange(c) { calls.marketCap = c; return builder; },
    withTime(c) { calls.time = c; return builder; },
    withMigration(c) { calls.migration = c; return builder; },
    withGovernance(c) { calls.governance = c; return builder; },
    // The own-venue graduation call. It was MISSING from this mock: the mock
    // claimed to be a `DopplerAuctionBuilder` and was not one, and every test in
    // this file passed only because `TEGRIDY_V4_MIGRATOR_ADDRESS` is still zero,
    // so `buildTegridyLaunchParams` never reaches
    // `withMigrator.withV4Migrator(...)`. The day that constant is set, this file
    // would have died on `builder.withV4Migrator is not a function` — the mock
    // did not match the surface it stands in for.
    withV4Migrator(a) { calls.v4Migrator = a; return builder; },
    withIntegrator(a) { calls.integrator = a; return builder; },
    withUserAddress(a) { calls.userAddress = a; return builder; },
    build() {
      calls.built = true;
      if (tickOverride) return { ok: true, auction: { ...tickOverride } };
      const mc = calls.marketCap as { marketCap: { start: number; min: number }; numerairePrice: number };
      const supply = (calls.saleConfig as { initialSupply: bigint }).initialSupply;
      return {
        ok: true,
        auction: {
          startTick: tickForMarketCap(mc.marketCap.start, supply, mc.numerairePrice),
          endTick: tickForMarketCap(mc.marketCap.min, supply, mc.numerairePrice),
        },
      };
    },
  };
  const sdk: DopplerEvmSdkLike = {
    buildDynamicAuction: () => builder,
    factory: { createDynamicAuction: async () => ({ hookAddress: CREATOR, tokenAddress: CREATOR, poolId: '0x', transactionHash: CREATOR }) },
  };
  return { sdk, calls };
}

function config(tier: TegridyLaunchConfig['tier']): TegridyLaunchConfig {
  return {
    tier,
    token: { name: 'Tegridy Launch', symbol: 'TGL', tokenURI: 'ipfs://x' },
    // 18-decimal base units, as a real ERC20 supply is. The previous whole-token values
    // (1e9 raw) imply a supply of 1e-9 tokens, which puts the auction's true ticks BELOW
    // zero — the exact region where the SDK's Math.abs() mangles the band. Realistic
    // values keep these policy tests testing policy; the mangled case has its own test.
    initialSupply: 1_000_000_000n * 10n ** 18n,
    numTokensToSell: 900_000_000n * 10n ** 18n,
    marketCap: { start: 300_000, min: 30_000 },
    numerairePriceUsd: 1881,
    minProceeds: 5n * 10n ** 18n,
    maxProceeds: 100n * 10n ** 18n,
    feeConstitution: constitution(),
    integrator: STAKERS,
    lockDurationSeconds: 365 * 24 * 60 * 60,
    userAddress: CREATOR,
  };
}

describe('buildTegridyLaunchParams — policy encoding', () => {
  it('wires native-ETH numeraire, integrator, V4 migration, start-time buffer, and beneficiaries', () => {
    const { sdk, calls } = recordingSdk();
    const params = buildTegridyLaunchParams(sdk, config('flagship'));
    expect((params as { ok: boolean }).ok).toBe(true);
    // Pins the verified-safe DopplerERC20V1 template (else SDK defaults to CloneERC20,
    // which our gate does not whitelist).
    expect((calls.tokenConfig as { type: string }).type).toBe('dopplerERC20V1');
    // Native ETH, NOT WETH (WETH reverts InvalidTokenOrder on a real fork).
    expect((calls.saleConfig as { numeraire: Address }).numeraire).toBe(NATIVE_ETH);
    expect((calls.saleConfig as { numeraire: Address }).numeraire).not.toBe(WETH_MAINNET);
    expect(calls.integrator).toBe(STAKERS);
    // Start-time buffer present (defends against InvalidStartTime on slow confirmation).
    expect((calls.time as { startTimeOffset: number }).startTimeOffset).toBeGreaterThanOrEqual(600);
    // withMarketCapRange carries the fee tier; poolConfig is NOT called (would revert >30 tickSpacing).
    expect((calls.marketCap as { fee: number }).fee).toBe(10_000);
    expect(calls.poolConfig).toBeUndefined();
    const mig = calls.migration as { type: string; tickSpacing: number; streamableFees: { lockDuration: number; beneficiaries: unknown[] } };
    expect(mig.type).toBe('uniswapV4');
    expect(mig.tickSpacing).toBe(60);
    expect(mig.streamableFees.lockDuration).toBe(365 * 24 * 60 * 60);
    expect(mig.streamableFees.beneficiaries).toHaveLength(4);
  });

  it('flagship uses default governance; listable uses noOp', () => {
    const flag = recordingSdk();
    buildTegridyLaunchParams(flag.sdk, config('flagship'));
    expect((flag.calls.governance as { type: string }).type).toBe('default');

    const list = recordingSdk();
    buildTegridyLaunchParams(list.sdk, config('listable'));
    expect((list.calls.governance as { type: string }).type).toBe('noOp');
  });

  it('propagates the market-cap band and proceeds bounds', () => {
    const { sdk, calls } = recordingSdk();
    buildTegridyLaunchParams(sdk, config('flagship'));
    const mc = calls.marketCap as { marketCap: { start: number; min: number }; minProceeds: bigint };
    expect(mc.marketCap).toEqual({ start: 300_000, min: 30_000 });
    expect(mc.minProceeds).toBe(5n * 10n ** 18n);
  });
});

describe('buildTegridyLaunchParams — ecosystem reserve (5% survival allocation)', () => {
  const CUSTODY = '0x00000000000000000000000000000000000C0FEE' as Address;

  it('switches to the allocations variant carrying creator + reserve lines', () => {
    const { sdk, calls } = recordingSdk();
    const cfg = config('flagship');
    const unsold = cfg.initialSupply - cfg.numTokensToSell;
    const reserveAmt = unsold / 4n;
    const premine = unsold - reserveAmt;
    cfg.vesting = { amount: premine, durationSeconds: 180 * 24 * 60 * 60, cliffSeconds: 30 * 24 * 60 * 60 };
    cfg.ecosystemReserve = { recipient: CUSTODY, amount: reserveAmt, durationSeconds: 0 };
    buildTegridyLaunchParams(sdk, cfg);
    const v = calls.vesting as {
      allocations: { recipient: Address; amount: bigint; schedule: { duration: bigint; cliffDuration: number } }[];
      recipients?: Address[];
    };
    expect(v.recipients).toBeUndefined();
    expect(v.allocations).toHaveLength(2);
    expect(v.allocations[0]).toEqual({
      recipient: cfg.userAddress,
      amount: premine,
      schedule: { duration: BigInt(180 * 24 * 60 * 60), cliffDuration: 30 * 24 * 60 * 60 },
    });
    expect(v.allocations[1]).toEqual({
      recipient: CUSTODY,
      amount: reserveAmt,
      schedule: { duration: 0n, cliffDuration: 0 },
    });
  });

  it('a reserve with no creator premine is a single allocation to custody', () => {
    const { sdk, calls } = recordingSdk();
    const cfg = config('flagship');
    const unsold = cfg.initialSupply - cfg.numTokensToSell;
    cfg.ecosystemReserve = { recipient: CUSTODY, amount: unsold, durationSeconds: 365 * 24 * 60 * 60 };
    buildTegridyLaunchParams(sdk, cfg);
    const v = calls.vesting as { allocations: { recipient: Address; amount: bigint }[] };
    expect(v.allocations).toHaveLength(1);
    expect(v.allocations[0].recipient).toBe(CUSTODY);
    expect(v.allocations[0].amount).toBe(unsold);
  });

  it('REFUSES a zero-address custody — a reserve routed to 0x0 is a mislabeled burn', () => {
    const { sdk } = recordingSdk();
    const cfg = config('flagship');
    cfg.ecosystemReserve = {
      recipient: '0x0000000000000000000000000000000000000000' as Address,
      amount: 1n,
      durationSeconds: 0,
    };
    expect(() => buildTegridyLaunchParams(sdk, cfg)).toThrow(/refusing to burn/i);
  });

  it('REFUSES allocations exceeding the unsold remainder before the SDK sees them', () => {
    const { sdk } = recordingSdk();
    const cfg = config('flagship');
    const unsold = cfg.initialSupply - cfg.numTokensToSell;
    cfg.vesting = { amount: unsold, durationSeconds: 365 * 24 * 60 * 60 };
    cfg.ecosystemReserve = { recipient: CUSTODY, amount: 1n, durationSeconds: 0 };
    expect(() => buildTegridyLaunchParams(sdk, cfg)).toThrow(/exceed the unsold remainder/i);
  });

  it('a zero-amount reserve leaves the legacy single-recipient path byte-identical', () => {
    const withReserveOff = recordingSdk();
    const cfg = config('flagship');
    cfg.vesting = { amount: 100_000_000n, durationSeconds: 365 * 24 * 60 * 60 };
    cfg.ecosystemReserve = { recipient: CUSTODY, amount: 0n, durationSeconds: 0 };
    buildTegridyLaunchParams(withReserveOff.sdk, cfg);

    const legacy = recordingSdk();
    const cfg2 = config('flagship');
    cfg2.vesting = { amount: 100_000_000n, durationSeconds: 365 * 24 * 60 * 60 };
    buildTegridyLaunchParams(legacy.sdk, cfg2);

    expect(withReserveOff.calls.vesting).toEqual(legacy.calls.vesting);
    expect((withReserveOff.calls.vesting as { recipients?: Address[] }).recipients).toBeDefined();
  });
});

describe('buildTegridyLaunchParams — on-chain vesting (premine)', () => {
  it('does NOT call withVesting on a fair launch (no vesting config)', () => {
    const { sdk, calls } = recordingSdk();
    buildTegridyLaunchParams(sdk, config('flagship'));
    expect(calls.vesting).toBeUndefined();
  });

  it('does NOT call withVesting when a vesting amount is 0', () => {
    const { sdk, calls } = recordingSdk();
    const cfg = config('flagship');
    cfg.vesting = { amount: 0n, durationSeconds: 180 * 24 * 60 * 60 };
    buildTegridyLaunchParams(sdk, cfg);
    expect(calls.vesting).toBeUndefined();
  });

  it('vests the reserved premine to the creator with the mapped schedule', () => {
    const { sdk, calls } = recordingSdk();
    const cfg = config('flagship');
    // Reserved premine = initialSupply - numTokensToSell = 100_000_000.
    const premine = cfg.initialSupply - cfg.numTokensToSell;
    cfg.vesting = { amount: premine, durationSeconds: 180 * 24 * 60 * 60, cliffSeconds: 30 * 24 * 60 * 60 };
    buildTegridyLaunchParams(sdk, cfg);
    const v = calls.vesting as { recipients: Address[]; amounts: bigint[]; duration: bigint; cliffDuration: number };
    expect(v.recipients).toEqual([cfg.userAddress]);
    expect(v.amounts).toEqual([premine]);
    // duration is a bigint of seconds; cliff maps through.
    expect(v.duration).toBe(BigInt(180 * 24 * 60 * 60));
    expect(v.cliffDuration).toBe(30 * 24 * 60 * 60);
  });

  it('defaults the cliff to 0 when cliffSeconds is omitted', () => {
    const { sdk, calls } = recordingSdk();
    const cfg = config('flagship');
    cfg.vesting = { amount: 100_000_000n, durationSeconds: 365 * 24 * 60 * 60 };
    buildTegridyLaunchParams(sdk, cfg);
    const v = calls.vesting as { cliffDuration: number };
    expect(v.cliffDuration).toBe(0);
  });

  it('leaves the sale/market-cap/migration wiring unchanged when vesting is added', () => {
    const withV = recordingSdk();
    const cfg = config('flagship');
    cfg.vesting = { amount: 100_000_000n, durationSeconds: 365 * 24 * 60 * 60 };
    buildTegridyLaunchParams(withV.sdk, cfg);

    const without = recordingSdk();
    buildTegridyLaunchParams(without.sdk, config('flagship'));

    expect(withV.calls.saleConfig).toEqual(without.calls.saleConfig);
    expect(withV.calls.marketCap).toEqual(without.calls.marketCap);
    expect(withV.calls.migration).toEqual(without.calls.migration);
    expect(withV.calls.integrator).toEqual(without.calls.integrator);
  });
});

describe('buildTegridyLaunchParams — auction-band round-trip guard', () => {
  // The defect: the SDK's marketCapToTicksForDynamicAuction takes Math.abs() of both raw
  // ticks then min/maxes them. When the raw ticks straddle zero the ordering is destroyed
  // and the submitted band is unrelated to the request — and Airlock.create SIMULATES
  // SUCCESSFULLY, so nothing downstream catches it. Measured on the shipped wizard
  // defaults against a live TOWELI price: a declared $300k -> $30k went on-chain as
  // ~$30.1k -> $8.3k. These tests pin the pre-signature refusal.

  it('accepts a band whose built ticks encode what was declared', () => {
    const { sdk } = recordingSdk();
    expect(() => buildTegridyLaunchParams(sdk, config('flagship'))).not.toThrow();
  });

  it('REFUSES when the built ticks encode a materially different band', () => {
    const cfg = config('flagship');
    // The mangled band the abs() bug produces: ticks that decode to ~$30k -> ~$8.3k
    // while the config still declares $300k -> $30k.
    const mangled = {
      startTick: tickForMarketCap(30_100, cfg.initialSupply, cfg.numerairePriceUsd),
      endTick: tickForMarketCap(8_303, cfg.initialSupply, cfg.numerairePriceUsd),
    };
    const { sdk } = recordingSdk(mangled);
    expect(() => buildTegridyLaunchParams(sdk, cfg)).toThrow(/does not match what was configured/);
  });

  it('names both the declared and the actual band so the creator can act on it', () => {
    const cfg = config('flagship');
    const mangled = {
      startTick: tickForMarketCap(30_100, cfg.initialSupply, cfg.numerairePriceUsd),
      endTick: tickForMarketCap(8_303, cfg.initialSupply, cfg.numerairePriceUsd),
    };
    const { sdk } = recordingSdk(mangled);
    expect(() => buildTegridyLaunchParams(sdk, cfg)).toThrow(/\$300,000 -> \$30,000/);
    expect(() => buildTegridyLaunchParams(sdk, cfg)).toThrow(/on-chain as \$30,1\d\d -> \$8,30\d/);
  });

  it('tolerates tick-spacing rounding without false-positiving', () => {
    const cfg = config('flagship');
    // ~1% off in each direction — inside MARKET_CAP_ROUND_TRIP_TOLERANCE (2%).
    const nudged = {
      startTick: tickForMarketCap(300_000 * 1.01, cfg.initialSupply, cfg.numerairePriceUsd),
      endTick: tickForMarketCap(30_000 * 0.99, cfg.initialSupply, cfg.numerairePriceUsd),
    };
    const { sdk } = recordingSdk(nudged);
    expect(() => buildTegridyLaunchParams(sdk, cfg)).not.toThrow();
  });

  it('fails LOUD rather than skipping the check when ticks are unreadable', () => {
    // If the SDK ever stops exposing auction.startTick/endTick, the guard must not
    // silently pass — that would be the 10x mispricing shipping unnoticed.
    const { sdk } = recordingSdk();
    const inner = sdk.buildDynamicAuction();
    // Chainable proxy that forwards every builder call but returns a tick-less build(),
    // i.e. the shape the SDK would produce if it stopped exposing auction ticks. NOTE the
    // builder methods return the PROXY, not `inner` — a plain object spread would hand the
    // chain straight back to the real builder and the override would never be reached.
    const stripped: DopplerAuctionBuilder = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'build') return () => ({ ok: true });
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (...args: unknown[]) => { (v as (...a: unknown[]) => unknown).apply(target, args); return stripped; } : v;
      },
    }) as DopplerAuctionBuilder;
    const noTicks: DopplerEvmSdkLike = { ...sdk, buildDynamicAuction: () => stripped };
    expect(() => buildTegridyLaunchParams(noTicks, config('flagship'))).toThrow(/Refusing to launch unverified/);
  });

  it('mirrors the SDK tickToMarketCap exactly (drift guard)', async () => {
    // The local mirror exists to keep the heavy SDK out of this module's chunk. Tests may
    // import the SDK freely — they do not ship — so pin the two against each other. If the
    // SDK changes its formula, this fails instead of the guard silently going wrong.
    const { tickToMarketCap } = await import('@whetstone-research/doppler-sdk/evm');
    const supply = 1_000_000_000n * 10n ** 18n;
    for (const tick of [-179536, -156523, -1, 0, 1, 60, 156523, 179536]) {
      const mine = tickToMarketCapUsd(tick, supply, 1881);
      const theirs = tickToMarketCap({ tick, tokenSupply: supply, numerairePriceUSD: 1881 });
      expect(Math.abs(mine - theirs) / Math.max(theirs, 1e-9)).toBeLessThan(1e-9);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ADVERTISED CURVE MUST BE THE CURVE WE BUILD
//
// The wizard's tier card and its final Review step — the screen directly above the
// signature button — print `LAUNCH_TIERS[].curve`. That string is a claim about an
// IRREVERSIBLE action, and it drifted: the Community tier advertised "Static /
// multicurve (Doppler V4)" while `buildTegridyLaunchParams` called
// `.buildDynamicAuction()` for every tier. Two rows further down the same Review
// panel said "Market cap (Dutch) … (descends)".
//
// These tests pin the RELATIONSHIP, not the wording, so a future copy edit is free
// but a copy/builder divergence is not.
// ─────────────────────────────────────────────────────────────────────────────
describe('tier labels describe the auction that is actually built', () => {
  it('builds a DYNAMIC auction for every offered tier', () => {
    // The mock SDK exposes ONLY buildDynamicAuction. If any tier ever routed to
    // buildStaticAuction this throws "is not a function" rather than silently passing.
    for (const tier of LAUNCH_TIERS) {
      const { sdk, calls } = recordingSdk();
      expect(() => buildTegridyLaunchParams(sdk, config(tier.id))).not.toThrow();
      expect(calls.built).toBe(true);
    }
  });

  it('never advertises a static curve while the builder is dynamic', () => {
    for (const tier of LAUNCH_TIERS) {
      expect(tier.curve.toLowerCase()).not.toMatch(/static|multicurve/);
    }
  });

  it('gives every tier the SAME curve, because the builder is tier-independent', () => {
    // Nothing in buildTegridyLaunchParams varies the auction shape by tier, so two
    // different curve strings can only be a lie about one of them.
    const curves = new Set(LAUNCH_TIERS.map((t) => t.curve));
    expect(curves.size).toBe(1);
  });

  it('varies governance by tier — the one thing the tier really does select', () => {
    const flagship = recordingSdk();
    buildTegridyLaunchParams(flagship.sdk, config('flagship'));
    const community = recordingSdk();
    buildTegridyLaunchParams(community.sdk, config('listable'));
    expect(flagship.calls.governance).toEqual({ type: 'default' });
    expect(community.calls.governance).toEqual({ type: 'noOp' });
    expect(flagship.calls.governance).not.toEqual(community.calls.governance);
  });
});
