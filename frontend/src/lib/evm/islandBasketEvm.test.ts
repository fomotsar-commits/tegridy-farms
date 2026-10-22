// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress } from 'viem';
import { SWAP_FEE_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI } from '../contracts';
import type { SwapVenue } from '../chains/swapVenue';
import { EVM_BASKET, minOut, type EvmBasketCoin, type EvmPool } from '../islandBasket';
import { MAX_FEE_BPS, SWAP_ROUTER02_ABI, buildEvmOrder, quoteEvmLegs, routeEvmLeg, uniswapOn, type EvmLegQuote, type QuoteClient } from './islandBasketEvm';

const BASE: SwapVenue = {
  chainId: 8453, name: 'Base', weth: '0x4200000000000000000000000000000000000006',
  factory: '0x12a249A027AA7DdF184E824b4bb63ba031A39fEC', router: '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3',
  swapFeeRouter: '0xa24C7287eC56A7DEFDc70033803451240e267a52',
  uniswapV2Router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', uniswapV2Factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  feeSink: 'remittance',
} as SwapVenue;
const ETH: SwapVenue = { ...BASE, chainId: 1, name: 'Ethereum', weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', uniswapV2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' } as SwapVenue;
const ME = getAddress('0x00000000000000000000000000000000000000aa');
const DEADLINE = 1_800_000_000n;

const qr = EVM_BASKET.base.find((c) => c.symbol === 'QR')!;
const mfer = EVM_BASKET.base.find((c) => c.symbol === '$mfer')!;
const v2 = mfer.pools.find((p) => p.dex === 'uniswap-v2')!;
const v3 = mfer.pools.find((p) => p.dex === 'uniswap-v3')!;
const q = (coin: EvmBasketCoin, outside: { pool: EvmPool; out: bigint }[], ours: bigint | null = null, unread = false): EvmLegQuote =>
  ({ coin, amountIn: 1_000n, outside, ours: ours === null ? null : { out: ours, feeBps: 50n }, unread });

describe('routeEvmLeg: the swap’s rule, per coin', () => {
  it('takes our pool on a tie or better, net of its fee', () => {
    expect(routeEvmLeg(q(mfer, [{ pool: v2, out: 500n }], 500n), 8453)).toEqual({ via: 'ours', out: 500n });
    expect(routeEvmLeg(q(mfer, [{ pool: v2, out: 500n }], 501n), 8453)).toEqual({ via: 'ours', out: 501n });
    expect(routeEvmLeg(q(mfer, [], 7n), 8453)).toEqual({ via: 'ours', out: 7n });
  });

  it('takes the outside pool that pays most when ours pays less', () => {
    expect(routeEvmLeg(q(mfer, [{ pool: v2, out: 500n }, { pool: v3, out: 600n }], 599n), 8453)).toEqual({ via: 'batch', pool: v3, out: 600n });
  });

  it('a V2 winner on Base is its own transaction (Uniswap’s router there cannot reach V2); on Ethereum it rides the batch', () => {
    expect(routeEvmLeg(q(mfer, [{ pool: v2, out: 600n }, { pool: v3, out: 500n }]), 8453).via).toBe('v2-router');
    expect(routeEvmLeg(q(mfer, [{ pool: v2, out: 600n }]), 1).via).toBe('batch');
  });

  it('never guesses: an unread leg, or one nothing quoted, has no route', () => {
    expect(routeEvmLeg(q(mfer, [{ pool: v2, out: 600n }], 900n, true), 8453)).toEqual({ via: 'none', why: 'unread' });
    expect(routeEvmLeg(q(mfer, []), 8453)).toEqual({ via: 'none', why: 'no-pool' });
    expect(routeEvmLeg(q(mfer, [], 0n), 8453)).toEqual({ via: 'none', why: 'no-pool' });
  });
});

describe('buildEvmOrder', () => {
  const quotes = [q(qr, [{ pool: qr.pools[0]!, out: 1_000_000n }]), q(mfer, [{ pool: v2, out: 2_000n }]), { ...q(mfer, [], 3_000n), amountIn: 2_000n }];
  const routes = quotes.map((x) => routeEvmLeg(x, 8453));

  it('puts the Uniswap coins in ONE SwapRouter02 multicall, paid by the ETH sent, then each other coin alone', () => {
    const order = buildEvmOrder({ venue: BASE, quotes, routes, recipient: ME, slippageBps: 100, deadline: DEADLINE })!;
    expect(order.map((t) => t.kind)).toEqual(['batch', 'v2-router', 'ours']);
    const [batch, viaV2, ours] = order as [typeof order[0], typeof order[0], typeof order[0]];

    expect(batch.to).toBe(uniswapOn(8453)!.swapRouter02);
    expect(batch.value).toBe(1_000n);
    expect(batch.legs).toEqual([0]);
    const multi = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: batch.data });
    expect(multi.functionName).toBe('multicall');
    const [deadline, calls] = multi.args as [bigint, `0x${string}`[]];
    expect(deadline).toBe(DEADLINE);
    expect(calls).toHaveLength(2);
    const leg = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: calls[0]! });
    expect(leg.functionName).toBe('exactInputSingle');
    expect(leg.args![0]).toEqual({
      tokenIn: BASE.weth, tokenOut: qr.token, fee: 10000, recipient: ME, amountIn: 1_000n, amountOutMinimum: minOut(1_000_000n, 100), sqrtPriceLimitX96: 0n,
    });
    // Anything the legs did not spend goes back to the buyer.
    expect(decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: calls[1]! }).functionName).toBe('refundETH');

    expect(viaV2.to).toBe(BASE.uniswapV2Router);
    expect(viaV2.value).toBe(1_000n);
    const v2call = decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data: viaV2.data });
    expect(v2call.functionName).toBe('swapExactETHForTokens');
    expect(v2call.args).toEqual([minOut(2_000n, 100), [BASE.weth, mfer.token], ME, DEADLINE]);

    expect(ours.to).toBe(BASE.swapFeeRouter);
    expect(ours.value).toBe(2_000n);
    const sfr = decodeFunctionData({ abi: SWAP_FEE_ROUTER_ABI, data: ours.data });
    expect(sfr.functionName).toBe('swapExactETHForTokens');
    expect(sfr.args).toEqual([minOut(3_000n, 100), [BASE.weth, mfer.token], ME, DEADLINE, MAX_FEE_BPS]);
  });

  it('rides V2 coins in the batch on Ethereum, through SwapRouter02’s V2 swap', () => {
    const toweli = EVM_BASKET.ethereum[0]!;
    const pepe = EVM_BASKET.ethereum[1]!;
    const eq = [q(toweli, [{ pool: toweli.pools[0]!, out: 9_000n }]), q(pepe, [{ pool: pepe.pools[0]!, out: 8_000n }])];
    const order = buildEvmOrder({ venue: ETH, quotes: eq, routes: eq.map((x) => routeEvmLeg(x, 1)), recipient: ME, slippageBps: 50, deadline: DEADLINE })!;
    expect(order).toHaveLength(1);
    expect(order[0]!.value).toBe(2_000n);
    const [, calls] = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: order[0]!.data }).args as [bigint, `0x${string}`[]];
    const first = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: calls[0]! });
    expect(first.functionName).toBe('swapExactTokensForTokens');
    expect(first.args).toEqual([1_000n, minOut(9_000n, 50), [ETH.weth, toweli.token], ME]);
  });

  it('builds nothing in part: a coin with no route, a bad slippage or a chain without Uniswap here', () => {
    const none = routes.map((r, i) => (i === 1 ? { via: 'none' as const, why: 'unread' as const } : r));
    expect(buildEvmOrder({ venue: BASE, quotes, routes: none, recipient: ME, slippageBps: 100, deadline: DEADLINE })).toBeNull();
    expect(buildEvmOrder({ venue: BASE, quotes, routes, recipient: ME, slippageBps: 10_000, deadline: DEADLINE })).toBeNull();
    expect(buildEvmOrder({ venue: { ...BASE, chainId: 4663 }, quotes, routes, recipient: ME, slippageBps: 100, deadline: DEADLINE })).toBeNull();
    expect(buildEvmOrder({ venue: BASE, quotes: [], routes: [], recipient: ME, slippageBps: 100, deadline: DEADLINE })).toBeNull();
  });
});

describe('quoteEvmLegs', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const PAIR = '0x00000000000000000000000000000000000000bb';
  /** A chain in a box: answers by function name; `fail` names reads that throw. */
  const box = (o: { pair?: string; fee?: bigint; fail?: string[] } = {}): QuoteClient => ({
    readContract: async ({ functionName, args }) => {
      if (o.fail?.includes(functionName)) throw new Error('rpc down');
      if (functionName === 'getPair') return o.pair ?? ZERO;
      if (functionName === 'feeBps') return o.fee ?? 50n;
      if (functionName === 'getAmountsOut') return [args![0] as bigint, (args![0] as bigint) * 3n];
      throw new Error(`unexpected ${functionName}`);
    },
    simulateContract: async ({ functionName }) => {
      if (o.fail?.includes(functionName)) throw new Error('rpc down');
      return { result: [7_777n, 0n, 0, 0n] };
    },
  });
  const legs = [{ coin: mfer, amountIn: 1_000n }];

  it('quotes every pool a coin lists, in the list’s order, and our pool net of its fee', async () => {
    const [leg] = await quoteEvmLegs(box({ pair: PAIR, fee: 50n }), BASE, legs);
    expect(leg!.unread).toBe(false);
    expect(leg!.outside).toEqual([{ pool: v2, out: 3_000n }, { pool: v3, out: 7_777n }]);
    expect(leg!.ours).toEqual({ out: (3_000n * 9_950n) / 10_000n, feeBps: 50n });
  });

  it('no pair of ours is no pool, not a failure', async () => {
    const [leg] = await quoteEvmLegs(box(), BASE, legs);
    expect(leg!.ours).toBeNull();
    expect(leg!.unread).toBe(false);
  });

  it('a read that fails, or a fee outside 0–10%, marks the coin unread', async () => {
    expect((await quoteEvmLegs(box({ fail: ['quoteExactInputSingle'] }), BASE, legs))[0]!.unread).toBe(true);
    expect((await quoteEvmLegs(box({ fail: ['getPair'] }), BASE, legs))[0]!.unread).toBe(true);
    expect((await quoteEvmLegs(box({ pair: PAIR, fee: 5_000n }), BASE, legs))[0]!.unread).toBe(true);
  });

  it('a read that never answers marks the coin unread in time: a stalled RPC never leaves the order spinning', async () => {
    const stalled: QuoteClient = { readContract: () => new Promise(() => {}), simulateContract: () => new Promise(() => {}) };
    const [leg] = await quoteEvmLegs(stalled, BASE, legs, 20);
    expect(leg!.unread).toBe(true);
  });

  it('a chain without Uniswap here quotes nothing', async () => {
    const out = await quoteEvmLegs(box(), { ...BASE, chainId: 4663 }, legs);
    expect(out[0]!.unread).toBe(true);
    expect(out[0]!.outside).toEqual([]);
  });
});
