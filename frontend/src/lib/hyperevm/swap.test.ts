// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodePacked } from 'viem';
import { HYPEREVM_TOKENS, WHYPE, hyperEvmVenueFrom, type HyperEvmVenue } from '../chains/hyperEvm';
import { UNIVERSAL_ROUTER_ABI } from '../evm/universalRouter';
import { coinPairs, feeSplitText, feeTierText, poolCoins, readPools, type HyperEvmReader, type ReadCall, type V3Pool } from './pools';
import { buildSwapTx, minReceived, priceImpactBps, quoteSwap } from './swap';

const VENUE: HyperEvmVenue = hyperEvmVenueFrom({
  factory: '0x1000000000000000000000000000000000000001',
  positionManager: '0x1000000000000000000000000000000000000002',
  quoterV2: '0x1000000000000000000000000000000000000003',
  universalRouter: '0x1000000000000000000000000000000000000004',
  feeAdapter: '0x1000000000000000000000000000000000000005',
  treasury: '0x1000000000000000000000000000000000000006',
  siteFeeBps: 30,
})!;
const [HYPE, WHYPE_T, USDT0, USDC] = HYPEREVM_TOKENS as [typeof HYPEREVM_TOKENS[0], typeof HYPEREVM_TOKENS[0], typeof HYPEREVM_TOKENS[0], typeof HYPEREVM_TOKENS[0]];
const Q96 = 1n << 96n;

function pool(fee: number, address: `0x${string}`, extra: Partial<V3Pool> = {}): V3Pool {
  return { address, token0: WHYPE_T, token1: USDT0, fee, tickSpacing: 60, sqrtPriceX96: Q96, tick: 0, liquidity: 10n ** 18n, reserve0: 0n, reserve1: 0n, venueShare0: 6, venueShare1: 6, ...extra };
}

/** A quoter that pays `rate[fee]` out per unit in, and refuses a fee tier it has no rate for. */
function quoter(rate: Record<number, bigint>, asked: unknown[] = []): HyperEvmReader {
  return {
    multicall: async () => [],
    simulateContract: async (c: ReadCall) => {
      const [p] = c.args as [{ amountIn: bigint; fee: number; tokenIn: string; tokenOut: string }];
      asked.push(p);
      const r = rate[p.fee];
      if (r === undefined) throw new Error('reverted');
      return { result: [p.amountIn * r, 0n, 0, 0n] };
    },
  };
}

describe('the swap quote', () => {
  const pools = [pool(500, '0x2000000000000000000000000000000000000001'), pool(3000, '0x2000000000000000000000000000000000000002')];

  it('paying in HYPE: the site fee leaves the HYPE first, so the pool is quoted on what reaches it', async () => {
    const asked: { amountIn: bigint; tokenIn: string }[] = [];
    const q = await quoteSwap(quoter({ 500: 2n, 3000: 3n }, asked), VENUE, pools, HYPE, USDT0, 10_000n);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(asked.every((a) => a.amountIn === 9_970n && a.tokenIn === WHYPE)).toBe(true);
    expect(q.best.pool.fee).toBe(3000);
    expect(q.best.out).toBe(29_910n);
    expect(q.best.siteFee).toEqual({ amount: 30n, token: HYPE });
  });

  it('paying in a coin: the whole amount is quoted and the site fee is taken from the coin out', async () => {
    const q = await quoteSwap(quoter({ 500: 2n, 3000: 3n }), VENUE, pools, USDT0, HYPE, 10_000n);
    if (!q.ok) throw new Error('no quote');
    expect(q.best.out).toBe(30_000n - 90n);
    expect(q.best.siteFee).toEqual({ amount: 90n, token: HYPE });
  });

  it('leaves out a pool whose quote fails, and is unread, never zero, when all fail', async () => {
    const one = await quoteSwap(quoter({ 500: 2n }), VENUE, pools, USDT0, WHYPE_T, 100n);
    expect(one.ok && one.all.map((x) => x.pool.fee)).toEqual([500]);
    expect(await quoteSwap(quoter({}), VENUE, pools, USDT0, WHYPE_T, 100n)).toEqual({ ok: false, why: 'unread' });
  });

  it('refuses what is not a swap in our pools', async () => {
    const r = quoter({ 500: 2n });
    expect(await quoteSwap(r, VENUE, pools, HYPE, WHYPE_T, 1n)).toEqual({ ok: false, why: 'wrap' });
    expect(await quoteSwap(r, VENUE, pools, USDT0, USDT0, 1n)).toEqual({ ok: false, why: 'same-coin' });
    expect(await quoteSwap(r, VENUE, pools, USDT0, USDC, 1n)).toEqual({ ok: false, why: 'no-pool' });
    expect(await quoteSwap(r, VENUE, [pool(500, '0x2000000000000000000000000000000000000001', { liquidity: 0n })], USDT0, HYPE, 1n)).toEqual({ ok: false, why: 'no-pool' });
  });

  it('min received floors, and price impact counts every fee against the pool price', async () => {
    expect(minReceived(10_000n, 50)).toBe(9_950n);
    expect(minReceived(999n, 50)).toBe(994n);
    expect(() => minReceived(1n, 10_000)).toThrow();
    const q = await quoteSwap(quoter({ 500: 1n }), VENUE, [pool(500, '0x2000000000000000000000000000000000000001')], HYPE, USDT0, 10_000n);
    if (!q.ok) throw new Error('no quote');
    // Price 1:1, 10,000 in, 9,970 out: 0.3% below the pool's price.
    expect(priceImpactBps(q.best)).toBe(30);
  });
});

describe('the swap transaction', () => {
  const p = pool(3000, '0x2000000000000000000000000000000000000002');
  const decode = (data: `0x${string}`) => decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data }).args as readonly [`0x${string}`, readonly `0x${string}`[], bigint];

  it('goes to our Universal Router, pays the treasury, and sends the HYPE as value when HYPE is spent', () => {
    const tx = buildSwapTx({ venue: VENUE, quote: { pool: p, from: HYPE, to: USDT0, amountIn: 10_000n, out: 29_910n, siteFee: { amount: 30n, token: HYPE }, midOut: 0n }, minOut: 29_000n, deadline: 99n });
    expect(tx.to).toBe(VENUE.universalRouter);
    expect(tx.value).toBe(10_000n);
    const [commands, inputs, deadline] = decode(tx.data);
    expect(commands).toBe('0x060b00');
    expect(deadline).toBe(99n);
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], inputs[0]!)).toEqual(['0x0000000000000000000000000000000000000000', VENUE.treasury, 30n]);
    const swap = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }], inputs[2]!);
    expect(swap[2]).toBe(29_000n);
    expect(swap[3]).toBe(encodePacked(['address', 'uint24', 'address'], [WHYPE, 3000, USDT0.address]));
  });

  it('a sale for HYPE unwraps; a coin for a coin sweeps; neither sends value', () => {
    const quote = { pool: p, from: USDT0, to: HYPE, amountIn: 5n, out: 4n, siteFee: { amount: 0n, token: HYPE }, midOut: 0n };
    const sale = buildSwapTx({ venue: VENUE, quote, minOut: 4n, deadline: 1n });
    expect(sale.value).toBe(0n);
    expect(decode(sale.data)[0]).toBe('0x00060c');
    const coin = buildSwapTx({ venue: VENUE, quote: { ...quote, to: WHYPE_T }, minOut: 4n, deadline: 1n });
    expect(decode(coin.data)[0]).toBe('0x000604');
  });
});

describe('the pools read', () => {
  it('pairs every listed pool coin once, sorted as Uniswap sorts a pool', () => {
    const pairs = coinPairs(poolCoins()).map(([a, b]) => `${a.symbol}/${b.symbol}`);
    expect(pairs).toEqual(['WHYPE/USD₮0', 'WHYPE/USDC', 'USDC/USD₮0']);
  });

  it('asks our factory for each pair at each tier, and reads only the pools that exist', async () => {
    const calls: ReadCall[][] = [];
    const POOL = '0x3000000000000000000000000000000000000001';
    const reader: HyperEvmReader = {
      simulateContract: async () => ({ result: [] }),
      multicall: async ({ contracts }) => {
        calls.push([...contracts]);
        if (calls.length === 1) return contracts.map((_, i) => ({ status: 'success' as const, result: i === 2 ? POOL : '0x0000000000000000000000000000000000000000' }));
        return [
          { status: 'success' as const, result: [Q96, -5, 0, 1, 1, 6 + (6 << 4), true] },
          { status: 'success' as const, result: 7n },
          { status: 'success' as const, result: 11n },
          { status: 'success' as const, result: 13n },
        ];
      },
    };
    const r = await readPools(reader, VENUE);
    expect(calls[0]!.length).toBe(12);
    expect(calls[0]!.every((c) => c.address === VENUE.factory && c.functionName === 'getPool')).toBe(true);
    expect(r).toEqual({ ok: true, pools: [{ address: POOL, token0: WHYPE_T, token1: USDT0, fee: 3000, tickSpacing: 60, sqrtPriceX96: Q96, tick: -5, liquidity: 7n, reserve0: 11n, reserve1: 13n, venueShare0: 6, venueShare1: 6 }] });
  });

  it('a read that fails is "could not read", never "no pools"', async () => {
    const reader: HyperEvmReader = { simulateContract: async () => ({ result: [] }), multicall: async ({ contracts }) => contracts.map(() => ({ status: 'failure' as const })) };
    expect(await readPools(reader, VENUE)).toEqual({ ok: false });
  });

  it('says how a fee is split, from the share the pool stores', () => {
    expect(feeTierText(3000)).toBe('0.3%');
    expect(feeSplitText(3000, 6)).toEqual({ lps: '0.25%', venue: '0.05%' });
    expect(feeSplitText(500, 0)).toEqual({ lps: '0.05%', venue: null });
  });
});
