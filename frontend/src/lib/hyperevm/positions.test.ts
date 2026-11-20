// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NonfungiblePositionManager, TickMath, encodeSqrtRatioX96 } from '@uniswap/v3-sdk';
import { HYPEREVM_TOKENS, WHYPE, hyperEvmVenueFrom, type HyperEvmVenue } from '../chains/hyperEvm';
import type { HyperEvmReader, ReadCall, V3Pool } from './pools';
import { addTx, collectTx, pairedAmount, poolPriceText, rangeTicks, readPositions, removeTx, tickPriceText, type V3PositionView } from './positions';

const VENUE: HyperEvmVenue = hyperEvmVenueFrom({
  factory: '0x1000000000000000000000000000000000000001',
  positionManager: '0x1000000000000000000000000000000000000002',
  quoterV2: '0x1000000000000000000000000000000000000003',
  universalRouter: '0x1000000000000000000000000000000000000004',
  feeAdapter: '0x1000000000000000000000000000000000000005',
  treasury: '0x1000000000000000000000000000000000000006',
  siteFeeBps: 30,
})!;
const WHYPE_T = HYPEREVM_TOKENS[1]!;
const USDT0 = HYPEREVM_TOKENS[2]!;
const WALLET = '0x7000000000000000000000000000000000000007';

// WHYPE / USD₮0 at 40 dollars a HYPE: 40e6 raw USD₮0 per 1e18 raw WHYPE.
const sqrt = encodeSqrtRatioX96('40000000', '1000000000000000000');
const POOL: V3Pool = {
  address: '0x2000000000000000000000000000000000000002', token0: WHYPE_T, token1: USDT0, fee: 3000, tickSpacing: 60,
  sqrtPriceX96: BigInt(sqrt.toString()), tick: TickMath.getTickAtSqrtRatio(sqrt), liquidity: 10n ** 20n,
  reserve0: 0n, reserve1: 0n, venueShare0: 6, venueShare1: 6,
};

/** The position manager calls inside a multicall, by name, with their arguments. */
function calls(data: `0x${string}`) {
  const I = NonfungiblePositionManager.INTERFACE;
  // A single call is sent bare, not wrapped in multicall (the SDK's Multicall.encodeMulticall).
  const inner = data.startsWith(I.getSighash('multicall')) ? (I.decodeFunctionData('multicall', data) as unknown as [string[]])[0] : [data];
  return inner.map((d) => {
    const f = I.getFunction(d.slice(0, 10));
    return { name: f.name, args: I.decodeFunctionData(f, d) };
  });
}

describe('ranges', () => {
  it('reads the price the pool is at', () => {
    expect(Number(poolPriceText(POOL))).toBeCloseTo(40, 3);
  });

  it('a price at an extreme tick is written short, never as forty digits', () => {
    expect(tickPriceText(POOL, 880000)).toMatch(/^\d\.\d+e\+\d+$/);
    expect(tickPriceText(POOL, -880000)).toMatch(/^\d\.\d+e-\d+$/);
    expect(tickPriceText(POOL, 880000).length).toBeLessThan(12);
    // An ordinary price keeps the SDK's six digits (the tick's own price, a hair under 40).
    expect(Number(tickPriceText(POOL, POOL.tick))).toBeCloseTo(40, 1);
  });

  it('every price: the widest ticks the tick spacing allows', () => {
    expect(rangeTicks(POOL, 'full')).toEqual({ tickLower: -887220, tickUpper: 887220 });
    expect(tickPriceText(POOL, -887220)).toBe('0');
    expect(tickPriceText(POOL, 887220)).toBe('∞');
  });

  it('a preset sits either side of the price, on usable ticks', () => {
    const r = rangeTicks(POOL, 'wide')!;
    expect(Math.abs(r.tickLower % 60)).toBe(0);
    expect(Math.abs(r.tickUpper % 60)).toBe(0);
    expect(r.tickLower).toBeLessThan(POOL.tick);
    expect(r.tickUpper).toBeGreaterThan(POOL.tick);
    expect(Number(tickPriceText(POOL, r.tickLower))).toBeCloseTo(20, 0);
    expect(Number(tickPriceText(POOL, r.tickUpper))).toBeCloseTo(60, 0);
  });

  it('typed prices become the nearest usable ticks; nonsense is no range', () => {
    const r = rangeTicks(POOL, { lower: '30', upper: '50' })!;
    expect(Number(tickPriceText(POOL, r.tickLower))).toBeCloseTo(30, 0);
    expect(Number(tickPriceText(POOL, r.tickUpper))).toBeCloseTo(50, 0);
    expect(rangeTicks(POOL, { lower: '50', upper: '30' })).toEqual(r);
    expect(rangeTicks(POOL, { lower: '', upper: '50' })).toBeNull();
    expect(rangeTicks(POOL, { lower: '0', upper: '50' })).toBeNull();
    expect(rangeTicks(POOL, { lower: 'abc', upper: '50' })).toBeNull();
  });
});

describe('the deposit the SDK works out', () => {
  const ticks = rangeTicks(POOL, 'wide')!;

  it('one HYPE in a range around the price needs dollars too, about its worth here', () => {
    const a = pairedAmount(POOL, ticks, 0, 10n ** 18n)!;
    expect(a.amount0).toBeLessThanOrEqual(10n ** 18n);
    expect(a.amount0).toBeGreaterThan(99n * 10n ** 16n);
    // Wide range, ±50%: the dollar side is of the same order as the HYPE's 40 dollars.
    expect(a.amount1).toBeGreaterThan(10_000_000n);
    expect(a.amount1).toBeLessThan(80_000_000n);
  });

  it('a range wholly below the price takes only dollars, so a HYPE amount buys nothing', () => {
    const below = rangeTicks(POOL, { lower: '10', upper: '20' })!;
    expect(pairedAmount(POOL, below, 0, 10n ** 18n)).toBeNull();
    expect(pairedAmount(POOL, below, 1, 1_000_000n)).toMatchObject({ amount0: 0n });
    // And above the price, only HYPE: a dollar amount buys nothing.
    const above = rangeTicks(POOL, { lower: '60', upper: '80' })!;
    expect(pairedAmount(POOL, above, 1, 1_000_000n)).toBeNull();
    expect(pairedAmount(POOL, above, 0, 10n ** 18n)).toMatchObject({ amount1: 0n });
  });

  it('opening a position pays the WHYPE side in HYPE, refunds what is left, and mints to the wallet', () => {
    const a = pairedAmount(POOL, ticks, 0, 10n ** 18n)!;
    const tx = addTx({ venue: VENUE, pool: POOL, ...ticks, ...a, recipient: WALLET, slippageBps: 50, deadline: 1_000n, useHype: true });
    expect(tx.to).toBe(VENUE.positionManager);
    expect(tx.value).toBe(tx.amount0);
    const c = calls(tx.data);
    expect(c.map((x) => x.name)).toEqual(['mint', 'refundETH']);
    const [p] = c[0]!.args as unknown as [{ token0: string; token1: string; fee: number; recipient: string; tickLower: number; tickUpper: number }];
    expect([p.token0, p.token1, Number(p.fee), p.recipient, Number(p.tickLower), Number(p.tickUpper)]).toEqual([WHYPE, USDT0.address, 3000, WALLET, ticks.tickLower, ticks.tickUpper]);
  });

  it('paid in WHYPE it sends no value; into a position the wallet holds it increases that one', () => {
    const a = pairedAmount(POOL, ticks, 0, 10n ** 18n)!;
    const plain = addTx({ venue: VENUE, pool: POOL, ...ticks, ...a, recipient: WALLET, slippageBps: 50, deadline: 1_000n, useHype: false });
    expect(plain.value).toBe(0n);
    expect(calls(plain.data).map((x) => x.name)).toEqual(['mint']);
    const more = addTx({ venue: VENUE, pool: POOL, ...ticks, ...a, recipient: WALLET, slippageBps: 50, deadline: 1_000n, useHype: false, tokenId: 42n });
    expect(calls(more.data).map((x) => x.name)).toEqual(['increaseLiquidity']);
  });
});

describe('collect and take out', () => {
  const ticks = rangeTicks(POOL, 'wide')!;
  const position: V3PositionView = { tokenId: 7n, pool: POOL, ...ticks, liquidity: 10n ** 15n, amount0: 1n, amount1: 1n, owed0: 5n, owed1: 9n, inRange: true };

  it('collect as HYPE: collected to the manager, unwrapped and the dollars swept to the wallet', () => {
    const tx = collectTx({ venue: VENUE, position, recipient: WALLET, hype: true });
    const c = calls(tx.data);
    expect(c.map((x) => x.name)).toEqual(['collect', 'unwrapWETH9', 'sweepToken']);
    expect((c[0]!.args[0] as { recipient: string }).recipient).toBe('0x0000000000000000000000000000000000000000');
    expect(c[1]!.args[1]).toBe(WALLET);
  });

  it('collect as WHYPE: one call, straight to the wallet', () => {
    const c = calls(collectTx({ venue: VENUE, position, recipient: WALLET, hype: false }).data);
    expect(c.map((x) => x.name)).toEqual(['collect']);
    expect((c[0]!.args[0] as { recipient: string }).recipient).toBe(WALLET);
  });

  it('take out half: decrease by half the liquidity, then collect it and the fees; the NFT stays', () => {
    const c = calls(removeTx({ venue: VENUE, position, pct: 50, recipient: WALLET, slippageBps: 50, deadline: 1_000n, hype: false }).data);
    expect(c.map((x) => x.name)).toEqual(['decreaseLiquidity', 'collect']);
    expect(BigInt((c[0]!.args[0] as { liquidity: { toString(): string } }).liquidity.toString())).toBe(5n * 10n ** 14n);
    expect(() => removeTx({ venue: VENUE, position, pct: 0, recipient: WALLET, slippageBps: 50, deadline: 1n, hype: false })).toThrow();
  });
});

describe('reading a wallet\'s positions', () => {
  it('reads each NFT, keeps those in our listed pools, counts the rest, and reads fees by a simulated collect', async () => {
    const OTHER = '0x9000000000000000000000000000000000000009';
    const ticks = rangeTicks(POOL, 'wide')!;
    const raw = (token0: string, liquidity: bigint) => [0n, '0x0', token0, USDT0.address, 3000, ticks.tickLower, ticks.tickUpper, liquidity, 0n, 0n, 0n, 0n];
    const reader: HyperEvmReader = {
      multicall: async ({ contracts }) => contracts.map((c: ReadCall) => {
        if (c.functionName === 'balanceOf') return { status: 'success' as const, result: 2n };
        if (c.functionName === 'tokenOfOwnerByIndex') return { status: 'success' as const, result: 100n + (c.args![1] as bigint) };
        const id = c.args![0] as bigint;
        return { status: 'success' as const, result: id === 100n ? raw(WHYPE, 10n ** 15n) : raw(OTHER, 1n) };
      }),
      simulateContract: async (c) => {
        expect(c.account).toBe(WALLET);
        return { result: [3n, 4n] };
      },
    };
    const r = await readPositions(reader, VENUE, WALLET, [POOL]);
    if (!r.ok) throw new Error('unread');
    expect(r.unlisted).toBe(1);
    expect(r.more).toBe(0);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ tokenId: 100n, owed0: 3n, owed1: 4n, inRange: true });
    expect(r.positions[0]!.amount0).toBeGreaterThan(0n);
  });

  it('a closed position (no liquidity, nothing owed) is counted, not listed; the newest comes first', async () => {
    const ticks = rangeTicks(POOL, 'wide')!;
    const liq: Record<string, bigint> = { '10': 10n ** 15n, '11': 0n, '12': 0n, '13': 10n ** 15n };
    const owed: Record<string, bigint> = { '10': 0n, '11': 0n, '12': 5n, '13': 0n };
    const reader: HyperEvmReader = {
      multicall: async ({ contracts }) => contracts.map((c: ReadCall) => {
        if (c.functionName === 'balanceOf') return { status: 'success' as const, result: 4n };
        if (c.functionName === 'tokenOfOwnerByIndex') return { status: 'success' as const, result: 10n + (c.args![1] as bigint) };
        const id = String(c.args![0]);
        return { status: 'success' as const, result: [0n, '0x0', WHYPE, USDT0.address, 3000, ticks.tickLower, ticks.tickUpper, liq[id]!, 0n, 0n, 0n, 0n] };
      }),
      simulateContract: async (c) => {
        const id = String((c.args![0] as { tokenId: bigint }).tokenId);
        return { result: [owed[id]!, 0n] };
      },
    };
    const r = await readPositions(reader, VENUE, WALLET, [POOL]);
    if (!r.ok) throw new Error('unread');
    // #11 is closed; #12 has no liquidity but fees still to collect, so it stays, and is not "in range".
    expect(r.positions.map((x) => x.tokenId)).toEqual([13n, 12n, 10n]);
    expect(r.closed).toBe(1);
    expect(r.positions.find((x) => x.tokenId === 12n)!.inRange).toBe(false);
  });

  it('fees that cannot be read stay unread, never zero', async () => {
    const ticks = rangeTicks(POOL, 'wide')!;
    const reader: HyperEvmReader = {
      multicall: async ({ contracts }) => contracts.map((c: ReadCall) => ({ status: 'success' as const, result: c.functionName === 'balanceOf' ? 1n : c.functionName === 'tokenOfOwnerByIndex' ? 1n : [0n, '0x0', WHYPE, USDT0.address, 3000, ticks.tickLower, ticks.tickUpper, 1n, 0n, 0n, 0n, 0n] })),
      simulateContract: async () => { throw new Error('rpc down'); },
    };
    const r = await readPositions(reader, VENUE, WALLET, [POOL]);
    expect(r.ok && r.positions[0]).toMatchObject({ owed0: null, owed1: null });
  });
});
