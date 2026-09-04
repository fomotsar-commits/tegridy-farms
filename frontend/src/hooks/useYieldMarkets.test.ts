// The hook's four states, and the two rules that keep them honest.
//
// The rules are `batchSize: 0` — which is what keeps the clock legs in the same
// aggregate3 as the values they date — and a Date.now() call count of exactly
// zero for the whole hook lifecycle. Both are asserted at RUNTIME rather than by
// reading the source, because both would still read correctly in a file that had
// stopped behaving that way.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PLAN_A, readPlanA, readPlanB, type CallResult } from '../lib/yield/reads';
import { yieldVenues } from '../lib/yield/venues';

const multicall = vi.fn();

// ONE stable client object. wagmi memoises the real one per chain id, and a
// fresh identity each render would re-run the read effect for ever — which is
// what a naive mock does, and what it would look like if wagmi ever stopped
// memoising.
const client = { multicall };
vi.mock('wagmi', () => ({
  usePublicClient: () => client,
}));

const { useYieldMarkets, marketsForKind } = await import('./useYieldMarkets');

const BLOCK = 25_888_268n;
const TS = 1_788_335_951n;

const ok = (result: unknown): CallResult => ({ status: 'success', result });
const bad = (): CallResult => ({ status: 'failure' });

const round = (answer: bigint, updatedAt: bigint, low = 820n): unknown[] => [
  (2n << 64n) | low,
  answer,
  updatedAt - 10n,
  updatedAt,
  (2n << 64n) | low,
];

function phaseA(over: Record<number, CallResult> = {}): CallResult[] {
  const out: CallResult[] = readPlanA().map(() => bad());
  out[PLAN_A.blockNumber] = ok(BLOCK);
  out[PLAN_A.blockTimestamp] = ok(TS);
  out[PLAN_A.aaveReserve] = ok({ currentLiquidityRate: 33_810_757_545_313_917_493_098_710n });
  out[PLAN_A.cometUtilisation] = ok(907_020_376_745_481_946n);
  out[PLAN_A.susdsSsr] = ok(1_000_000_001_096_988_989_836_188_433n);
  out[PLAN_A.susdsConvert] = ok(1_108_204_577_538_302_915n);
  out[PLAN_A.rethRate] = ok(1_170_882_039_540_397_800n);
  out[PLAN_A.cbethRate] = ok(1_138_511_180_554_454_300n);
  out[PLAN_A.weethRate] = ok(1_102_757_984_781_941_300n);
  out[PLAN_A.feedSteth] = ok(round(999_416_369_099_818_200n, TS - 11_616n));
  out[PLAN_A.feedReth] = ok(round(1_170_216_685_446_728_000n, TS - 44_412n));
  out[PLAN_A.feedCbeth] = ok(round(1_137_992_813_082_469_000n, TS - 43_968n));
  out[PLAN_A.feedWeeth] = ok(round(1_102_580_930_735_330_000n, TS - 12_888n));
  out[PLAN_A.feedEzeth] = ok(round(1_081_546_937_469_586_650n, TS - 12_972n, 819n));
  out[PLAN_A.feedUsdc] = ok(round(99_980_711n, TS - 3_504n));
  out[PLAN_A.feedUsds] = ok(round(99_994_824n, TS - 12_300n));
  out[PLAN_A.lidoBacklog] = ok(6_402_666_615_466_025_748_478n);
  out[PLAN_A.rocketExcess] = ok(0n);
  out[PLAN_A.aaveUsdcHeld] = ok(164_381_298_444_148n);
  out[PLAN_A.cometUsdcHeld] = ok(120_000_000_000_000n);
  out[PLAN_A.rocketResolvedPool] = ok('0xCE15294273CFb9D9b628F4D61636623decDF4fdC');
  out[PLAN_A.rocketResolvedSettings] = ok('0x227BE8dD01DF8ad9BED0178e4F8cEC2996C5c365');
  out[PLAN_A.rocketDepositEnabled] = ok(true);
  out[PLAN_A.rocketMinimum] = ok(10n ** 16n);
  out[PLAN_A.rocketMaxPool] = ok(6_000_000n * 10n ** 18n);
  out[PLAN_A.rocketPoolBalance] = ok(15_739_140_722_506_135_779n);
  out[PLAN_A.rocketDepositFee] = ok(500_000_000_000_000n);
  for (const [i, v] of Object.entries(over)) out[Number(i)] = v;
  return out;
}

function phaseB(a: CallResult[]): CallResult[] {
  const plan = readPlanB(a);
  if (plan === null) return [];
  const out: CallResult[] = plan.calls.map(() => bad());
  out[0] = ok(BLOCK);
  out[1] = ok(TS);
  if (plan.cometRateIndex !== null) out[plan.cometRateIndex] = ok(1_738_873_796n);
  for (const w of plan.roundWindows) {
    w.ids.forEach((id, i) => {
      const back = BigInt(i + 1) * 86_400n;
      const base = w.key === 'weethEth' ? 1_102_084_452_111_205_600n : 1_081_940_564_243_566_500n;
      out[w.start + i] = ok([id, base, TS - back - 20n, TS - 12_888n - back, id]);
    });
  }
  return out;
}

/** Answers phase A then phase B, in call order. */
function serve(a: CallResult[]) {
  let call = 0;
  multicall.mockImplementation(() => {
    call += 1;
    return Promise.resolve(call === 1 ? a : phaseB(a));
  });
}

let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  multicall.mockReset();
  nowSpy = vi.spyOn(Date, 'now');
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe('the read is one aggregate3 that carries its own clock', () => {
  it('asks with batchSize 0 and allowFailure, so the clock legs stay atomic with the values', async () => {
    serve(phaseA());
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(multicall).toHaveBeenCalled();
    const args = multicall.mock.calls[0]![0] as { batchSize?: number; allowFailure?: boolean };
    // Dropping batchSize lets viem split the array across several requests, and
    // the block number could then belong to a different block than the figures.
    expect(args.batchSize).toBe(0);
    expect(args.allowFailure).toBe(true);
  });

  it('stamps asOf with the chain timestamp the multicall returned', async () => {
    serve(phaseA());
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.asOf).toBe(Number(TS));
    expect(result.current.block).toBe(Number(BLOCK));
  });

  it('NEVER calls Date.now across the whole lifecycle', async () => {
    // The browser clock belongs to the visitor. A laptop a day fast would mark
    // every Chainlink feed on this page stale; one a day slow would mark a dead
    // feed fresh. Neither failure is the chain's.
    serve(phaseA());
    const { result, unmount } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    unmount();
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it('runs phase B only once phase A answered the legs it depends on', async () => {
    serve(phaseA());
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(multicall).toHaveBeenCalledTimes(2);

    multicall.mockReset();
    const noDeps = phaseA({
      [PLAN_A.cometUtilisation]: bad(),
      [PLAN_A.feedWeeth]: bad(),
      [PLAN_A.feedEzeth]: bad(),
    });
    multicall.mockResolvedValue(noDeps);
    const second = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(second.result.current.status).toBe('partial'));
    // Nothing dependent was askable, so no second request was issued.
    expect(multicall).toHaveBeenCalledTimes(1);
  });
});

describe('the table survives what it could not read', () => {
  it('reports partial and marks only the failed cell, leaving the others read', async () => {
    serve(phaseA({ [PLAN_A.feedReth]: bad() }));
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('partial'));
    const reth = result.current.rows.find((r) => r.venue.id === 'rocketpool-reth')!;
    expect(reth.market.state).toBe('unavailable');
    expect(reth.nav.state).toBe('read');
    expect(result.current.rows.find((r) => r.venue.id === 'aave-v3-usdc')!.rate.state).toBe('read');
    expect(result.current.unreadCells).toBeGreaterThan(0);
  });

  it('goes unavailable when the clock leg fails, not merely partial', async () => {
    serve(phaseA({ [PLAN_A.blockNumber]: bad() }));
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.block).toBeNull();
    expect(result.current.detail).toMatch(/block clock/);
  });

  it('goes unavailable with a reason when the RPC throws', async () => {
    multicall.mockRejectedValue(new Error('all providers failed'));
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.detail).toMatch(/could not be reached/);
  });

  it('keeps the FULL catalogue in every state, including total failure', async () => {
    // The counterparty and loss-mode lines are static local knowledge and do not
    // depend on the chain. Hiding those rows during an outage would delete the
    // honest half of the page to protect the unread half.
    const expected = yieldVenues().length;
    multicall.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.rows).toHaveLength(expected);
    for (const row of result.current.rows) {
      expect(row.venue.counterparty.length).toBeGreaterThan(30);
      expect(row.rate.state).toBe('unavailable');
    }
  });
});

describe('both panels rank through one code path', () => {
  it('scopes to the requested kinds and ranks what it could read', async () => {
    serve(phaseA());
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const stables = marketsForKind(result.current.rows, ['stable-lending']);
    expect(stables.rows.map((r) => r.venue.id).sort()).toEqual([
      'aave-v3-usdc',
      'compound-v3-usdc',
      'sky-susds',
    ]);
    // Compound was the highest of the three at block 25888268.
    expect(stables.ranking.best?.venue.id).toBe('compound-v3-usdc');
    const staking = marketsForKind(result.current.rows, ['lst', 'lrt']);
    expect(staking.rows).toHaveLength(5);
    // Three of the five staking rows have no readable rate and are UNRANKED
    // rather than ranked last.
    expect(staking.ranking.unranked.map((u) => u.venue.id).sort()).toEqual([
      'coinbase-cbeth',
      'lido-steth',
      'rocketpool-reth',
    ]);
  });
});
