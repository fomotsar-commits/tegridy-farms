// The read plan and its refusals, with no network anywhere.
//
// `assembleReadings` is the only place a failed contract call turns into a
// sentence a reader sees, so the branch that matters most here is the failing
// one. A hand-written results array is the only way to exercise it — a live read
// succeeds, which is precisely the case that needs no test.

import { describe, it, expect } from 'vitest';
import {
  PLAN_A,
  ROCKET_STORAGE_KEYS,
  assembleReadings,
  readPlanA,
  readPlanB,
  type CallResult,
} from './reads';
import { MULTICALL3_ADDRESS, YIELD_ADDRESSES } from './protocols';

const BLOCK = 25_888_268n;
const TS = 1_788_335_951n;

const okResult = (result: unknown): CallResult => ({ status: 'success', result });
const failResult = (): CallResult => ({ status: 'failure' });

const round = (answer: bigint, updatedAt: bigint, low = 820n): unknown[] => [
  (2n << 64n) | low,
  answer,
  updatedAt - 10n,
  updatedAt,
  (2n << 64n) | low,
];

/** A phase-A results array where every leg answered plausibly. */
function healthyA(over: Record<number, CallResult> = {}): CallResult[] {
  const out: CallResult[] = readPlanA().map(() => failResult());
  out[PLAN_A.blockNumber] = okResult(BLOCK);
  out[PLAN_A.blockTimestamp] = okResult(TS);
  out[PLAN_A.aaveReserve] = okResult({ currentLiquidityRate: 33_810_757_545_313_917_493_098_710n, aTokenAddress: YIELD_ADDRESSES.aEthUSDC });
  out[PLAN_A.cometUtilisation] = okResult(907_020_376_745_481_946n);
  out[PLAN_A.susdsSsr] = okResult(1_000_000_001_096_988_989_836_188_433n);
  out[PLAN_A.susdsConvert] = okResult(1_108_204_577_538_302_915n);
  out[PLAN_A.rethRate] = okResult(1_170_882_039_540_397_800n);
  out[PLAN_A.cbethRate] = okResult(1_138_511_180_554_454_300n);
  out[PLAN_A.weethRate] = okResult(1_102_757_984_781_941_300n);
  out[PLAN_A.feedSteth] = okResult(round(999_416_369_099_818_200n, TS - 11_616n));
  out[PLAN_A.feedReth] = okResult(round(1_170_216_685_446_728_000n, TS - 44_412n));
  out[PLAN_A.feedCbeth] = okResult(round(1_137_992_813_082_469_000n, TS - 43_968n));
  out[PLAN_A.feedWeeth] = okResult(round(1_102_580_930_735_330_000n, TS - 12_888n));
  out[PLAN_A.feedEzeth] = okResult(round(1_081_546_937_469_586_650n, TS - 12_972n, 819n));
  out[PLAN_A.feedUsdc] = okResult(round(99_980_711n, TS - 3_504n));
  out[PLAN_A.feedUsds] = okResult(round(99_994_824n, TS - 12_300n));
  out[PLAN_A.lidoBacklog] = okResult(6_402_666_615_466_025_748_478n);
  out[PLAN_A.rocketExcess] = okResult(0n);
  out[PLAN_A.aaveUsdcHeld] = okResult(164_381_298_444_148n);
  out[PLAN_A.cometUsdcHeld] = okResult(120_000_000_000_000n);
  out[PLAN_A.rocketResolvedPool] = okResult(YIELD_ADDRESSES.rocketDepositPool);
  out[PLAN_A.rocketResolvedSettings] = okResult(YIELD_ADDRESSES.rocketSettingsDeposit);
  out[PLAN_A.rocketDepositEnabled] = okResult(true);
  out[PLAN_A.rocketMinimum] = okResult(10n ** 16n);
  out[PLAN_A.rocketMaxPool] = okResult(6_000_000n * 10n ** 18n);
  out[PLAN_A.rocketPoolBalance] = okResult(15_739_140_722_506_135_779n);
  out[PLAN_A.rocketDepositFee] = okResult(500_000_000_000_000n);
  return Object.entries(over).reduce((acc, [i, v]) => {
    acc[Number(i)] = v;
    return acc;
  }, out);
}

function healthyB(resultsA: CallResult[]): { plan: ReturnType<typeof readPlanB>; results: CallResult[] } {
  const plan = readPlanB(resultsA);
  if (plan === null) return { plan, results: [] };
  const results: CallResult[] = plan.calls.map(() => failResult());
  results[0] = okResult(BLOCK);
  results[1] = okResult(TS);
  if (plan.cometRateIndex !== null) results[plan.cometRateIndex] = okResult(1_738_873_796n);
  for (const w of plan.roundWindows) {
    // Eight prior rounds, one a day apart, the last of them eight days back.
    w.ids.forEach((id, i) => {
      const daysBack = BigInt(i + 1) * 86_400n;
      const base = w.key === 'weethEth' ? 1_102_084_452_111_205_600n : 1_081_940_564_243_566_500n;
      results[w.start + i] = okResult([id, base, TS - daysBack - 20n, TS - 12_888n - daysBack, id]);
    });
  }
  return { plan, results };
}

describe('the plan asks the clock in the same call as the values', () => {
  it('puts getBlockNumber and getCurrentBlockTimestamp first, on Multicall3', () => {
    const plan = readPlanA();
    expect(plan[0]).toMatchObject({ address: MULTICALL3_ADDRESS, functionName: 'getBlockNumber' });
    expect(plan[1]).toMatchObject({ address: MULTICALL3_ADDRESS, functionName: 'getCurrentBlockTimestamp' });
  });

  it('hashes the Rocket Pool storage keys from their strings', () => {
    // A wrong key resolves to the zero address, and the equality gate would then
    // read that as "Rocket Pool has moved" for ever.
    expect(ROCKET_STORAGE_KEYS.depositPool).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ROCKET_STORAGE_KEYS.depositPool).not.toBe(ROCKET_STORAGE_KEYS.settingsDeposit);
    const plan = readPlanA();
    expect(plan[PLAN_A.rocketResolvedPool]).toMatchObject({
      address: YIELD_ADDRESSES.rocketStorage,
      functionName: 'getAddress',
      args: [ROCKET_STORAGE_KEYS.depositPool],
    });
  });
});

describe('phase B only asks what phase A made askable', () => {
  it('feeds the read utilisation straight into getSupplyRate', () => {
    const plan = readPlanB(healthyA());
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error('unreachable');
    expect(plan.cometRateIndex).not.toBeNull();
    expect(plan.calls[plan.cometRateIndex!]).toMatchObject({
      address: YIELD_ADDRESSES.cUSDCv3,
      functionName: 'getSupplyRate',
      args: [907_020_376_745_481_946n],
    });
  });

  it('asks for round history only for the exchange-rate feeds', () => {
    const plan = readPlanB(healthyA());
    expect(plan?.roundWindows.map((w) => w.key).sort()).toEqual(['ezethEth', 'weethEth']);
  });

  it('is null when nothing dependent could be asked', () => {
    const dead = healthyA({
      [PLAN_A.cometUtilisation]: failResult(),
      [PLAN_A.feedWeeth]: failResult(),
      [PLAN_A.feedEzeth]: failResult(),
    });
    expect(readPlanB(dead)).toBeNull();
  });
});

describe('an unread clock takes the whole table down, by design', () => {
  it('marks EVERY cell unavailable and says why', () => {
    const out = assembleReadings(healthyA({ [PLAN_A.blockNumber]: failResult() }), null, null);
    expect(out.block).toBeNull();
    expect(out.asOf).toBeNull();
    for (const row of out.rows) {
      for (const cell of [row.rate, row.nav, row.market, row.vsNav, row.exit]) {
        expect(cell.state).toBe('unavailable');
        expect(cell.state === 'unavailable' && cell.reason).toMatch(/block clock/);
      }
    }
    // The catalogue is still fully rendered — the counterparty and loss-mode
    // lines do not depend on the chain.
    expect(out.rows).toHaveLength(8);
  });

  it('takes the timestamp leg just as seriously as the block number', () => {
    const out = assembleReadings(healthyA({ [PLAN_A.blockTimestamp]: failResult() }), null, null);
    expect(out.block).toBeNull();
  });
});

describe('a healthy read produces sourced, dated, unit-carrying cells', () => {
  const resultsA = healthyA();
  const { plan, results } = healthyB(resultsA);
  const out = assembleReadings(resultsA, results, plan);
  const row = (id: string) => out.rows.find((r) => r.venue.id === id)!;

  it('dates every cell from the clock leg, not from a wall clock', () => {
    expect(out.block).toBe(Number(BLOCK));
    expect(out.asOf).toBe(Number(TS));
    for (const r of out.rows) {
      expect(r.block).toBe(Number(BLOCK));
      expect(r.asOf).toBe(Number(TS));
    }
  });

  it('names the function in every read source string', () => {
    expect(row('aave-v3-usdc').rate.state === 'read' && row('aave-v3-usdc').rate).toMatchObject({
      unit: 'pct',
      block: Number(BLOCK),
    });
    const aave = row('aave-v3-usdc').rate;
    expect(aave.state === 'read' && aave.source).toContain('getReserveData');
    const comp = row('compound-v3-usdc').rate;
    expect(comp.state === 'read' && comp.source).toContain('getSupplyRate');
    // Compound's own headline is an APR; keeping it in the source is what stops
    // the page from looking like it disagrees with Compound's UI.
    expect(comp.state === 'read' && comp.source).toContain('APR');
    const sky = row('sky-susds').rate;
    expect(sky.state === 'read' && sky.source).toContain('ssr()');
  });

  it('computes vs-NAV from a market feed divided by the protocol\'s own rate', () => {
    const reth = row('rocketpool-reth');
    expect(reth.vsNav.state).toBe('read');
    if (reth.vsNav.state !== 'read') throw new Error('unreachable');
    expect(reth.vsNav.unit).toBe('ratio');
    expect(reth.vsNav.value).toBeCloseTo(1.170216685446728 / 1.1708820395403978, 5);
    expect(reth.vsNav.source).toContain('÷');
  });

  it('marks Lido\'s exit as a BACKLOG, not as liquidity', () => {
    const exit = row('lido-steth').exit;
    expect(exit.state === 'read' && exit.meaning).toBe('queued-ahead');
    expect(exit.state === 'read' && exit.unit).toBe('stETH');
  });

  it('files the structural absences as not-applicable, not as failures', () => {
    // These four are properties of the position, not outages. Filing them as
    // "unavailable" would invite an operator to go and wire a source that
    // cannot exist.
    expect(row('lido-steth').nav.state).toBe('not-applicable');
    expect(row('aave-v3-usdc').nav.state).toBe('not-applicable');
    expect(row('compound-v3-usdc').nav.state).toBe('not-applicable');
    expect(row('sky-susds').exit.state).toBe('not-applicable');
    expect(row('coinbase-cbeth').exit.state).toBe('not-applicable');
  });

  it('refuses a market price for the rows whose only feed republishes a protocol rate', () => {
    for (const id of ['etherfi-weeth', 'renzo-ezeth']) {
      const r = row(id);
      expect(r.market.state).toBe('unavailable');
      expect(r.market.state === 'unavailable' && r.market.reason).toMatch(/can never show a discount/);
      expect(r.vsNav.state).toBe('unavailable');
      expect(r.vsNav.state === 'unavailable' && r.vsNav.reason).toMatch(/NOT assumed to be 1\.00/);
    }
  });

  it('gives the exchange-rate rows a trailing rate from their round history', () => {
    const weeth = row('etherfi-weeth').rate;
    expect(weeth.state).toBe('read');
    expect(weeth.state === 'read' && weeth.source).toContain('getRoundData');
    expect(weeth.state === 'read' && weeth.basis).toMatch(/trailing/);
  });

  it('refuses a rate for Lido, rETH and cbETH with a reason naming the obstacle', () => {
    // Each of these three is a DIFFERENT obstacle and they must not collapse
    // into one generic sentence.
    const lido = row('lido-steth').rate;
    expect(lido.state).toBe('unavailable');
    expect(lido.state === 'unavailable' && lido.reason).toMatch(/settles withdrawals/);
    expect(lido.state === 'unavailable' && lido.reason).toMatch(/not a rate of zero/);
    const reth = row('rocketpool-reth').rate;
    expect(reth.state === 'unavailable' && reth.reason).toMatch(/MARKET price/);
    const cbeth = row('coinbase-cbeth').rate;
    expect(cbeth.state === 'unavailable' && cbeth.reason).toMatch(/off-chain/);
  });

  it('hands the Rocket Pool gates through without ever letting them pick an address', () => {
    expect(out.rocket).toMatchObject({
      resolvedPool: YIELD_ADDRESSES.rocketDepositPool,
      depositEnabled: true,
      depositFee1e18: 500_000_000_000_000n,
      block: Number(BLOCK),
    });
  });
});

describe('one failed leg costs one cell, not the table', () => {
  it('leaves the rate read while the market leg goes unavailable', () => {
    const resultsA = healthyA({ [PLAN_A.feedReth]: failResult() });
    const { plan, results } = healthyB(resultsA);
    const out = assembleReadings(resultsA, results, plan);
    const reth = out.rows.find((r) => r.venue.id === 'rocketpool-reth')!;
    expect(reth.nav.state).toBe('read');
    expect(reth.market.state).toBe('unavailable');
    expect(reth.vsNav.state).toBe('unavailable');
    expect(reth.vsNav.state === 'unavailable' && reth.vsNav.reason).toMatch(/NOT assumed to be 1\.00/);
    // And the other rows are untouched.
    expect(out.rows.find((r) => r.venue.id === 'aave-v3-usdc')!.rate.state).toBe('read');
    expect(out.unreadCells).toBeGreaterThan(0);
  });

  it('does the same when it is the NAV leg that failed', () => {
    const resultsA = healthyA({ [PLAN_A.rethRate]: failResult() });
    const { plan, results } = healthyB(resultsA);
    const out = assembleReadings(resultsA, results, plan);
    const reth = out.rows.find((r) => r.venue.id === 'rocketpool-reth')!;
    expect(reth.market.state).toBe('read');
    expect(reth.nav.state).toBe('unavailable');
    expect(reth.nav.state === 'unavailable' && reth.nav.reason).toContain('getExchangeRate');
    expect(reth.vsNav.state).toBe('unavailable');
  });

  it('refuses the weETH NAV outright when the feed has stopped tracking the protocol', () => {
    // The runtime half of the classification guard: a pinned exchange-rate feed
    // that has drifted 2% from the contract it republishes is not shown.
    const resultsA = healthyA({ [PLAN_A.feedWeeth]: okResult(round(1_080_000_000_000_000_000n, TS - 12_888n)) });
    const { plan, results } = healthyB(resultsA);
    const out = assembleReadings(resultsA, results, plan);
    const weeth = out.rows.find((r) => r.venue.id === 'etherfi-weeth')!;
    expect(weeth.nav.state).toBe('unavailable');
    expect(weeth.nav.state === 'unavailable' && weeth.nav.reason).toMatch(/no longer tracking/);
  });
});
