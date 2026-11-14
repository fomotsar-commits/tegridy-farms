// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, getAddress } from 'viem';
import { SWAP_FEE_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI } from '../contracts';
import type { SwapVenue } from '../chains/swapVenue';
import { EVM_BASKET, minOut, type EvmBasketCoin, type EvmPool } from '../islandBasket';
import { MAX_FEE_BPS, SWAP_ROUTER02_ABI, buildEvmOrder, quoteEvmLegs, routeEvmLeg, type EvmLegQuote, type QuoteClient, type VenueFee } from './islandBasketEvm';
import { UNIVERSAL_ROUTER_ABI, universalRouterOn, v3Path } from './universalRouter';

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
const SAFE = getAddress('0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1');
const FEE: VenueFee = { bps: 50n, recipient: SAFE };
const q = (coin: EvmBasketCoin, outside: { pool: EvmPool; out: bigint }[], ours: bigint | null = null, unread = false, venueFee: VenueFee | null = null): EvmLegQuote =>
  ({ coin, amountIn: 1_000n, outside, ours: ours === null ? null : { out: ours, feeBps: 50n }, venueFee, unread });
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const CONTRACT_BALANCE = 1n << 255n;
/** The Universal Router call a batch carries, every input decoded. */
const decodeBatch = (data: `0x${string}`) => {
  const call = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
  const [commands, inputs, deadline] = call.args as [`0x${string}`, `0x${string}`[], bigint];
  const swap = (hex: `0x${string}`) => decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], hex);
  return {
    commands, deadline,
    transfer: decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], inputs[0]!),
    wrap: decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], inputs[1]!),
    swaps: inputs.slice(2).map(swap),
  };
};

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
  const quotes = [q(qr, [{ pool: qr.pools[0]!, out: 1_000_000n }], null, false, FEE), q(mfer, [{ pool: v2, out: 2_000n }], null, false, FEE), { ...q(mfer, [], 3_000n, false, FEE), amountIn: 2_000n }];
  const routes = quotes.map((x) => routeEvmLeg(x, 8453));

  it('on Base, puts the V3 coins in ONE Universal Router call that pays the venue first, then each other coin alone', () => {
    const order = buildEvmOrder({ venue: BASE, quotes, routes, recipient: ME, slippageBps: 100, deadline: DEADLINE })!;
    expect(order.map((t) => t.kind)).toEqual(['batch', 'v2-router', 'ours']);
    const [batch, viaV2, ours] = order as [typeof order[0], typeof order[0], typeof order[0]];

    expect(batch.to).toBe(universalRouterOn(8453));
    expect(batch.value).toBe(1_000n);
    expect(batch.legs).toEqual([0]);
    const b = decodeBatch(batch.data);
    expect(b.deadline).toBe(DEADLINE);
    // TRANSFER the fee in ETH, WRAP_ETH the rest, one V3_SWAP_EXACT_IN.
    expect(b.commands).toBe('0x050b00');
    expect(b.transfer).toEqual(['0x0000000000000000000000000000000000000000', SAFE, 5n]);
    expect(b.wrap).toEqual([ADDRESS_THIS, CONTRACT_BALANCE]);
    // The only V3 coin spends all that is left, straight to the buyer, at its floor.
    expect(b.swaps).toEqual([[MSG_SENDER, CONTRACT_BALANCE, minOut(1_000_000n, 100), v3Path(BASE.weth, 10000, qr.token), false]]);

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

  it('pays the venue exactly each coin’s own fee, and each coin swaps exactly its share less that fee', () => {
    const coins = EVM_BASKET.base.filter((c) => c.pools.every((p) => p.dex === 'uniswap-v3')).slice(0, 3);
    // 1,999 and 2,001 wei floor to fees of 9 and 10; the whole 5,999 would floor to 29, not 28.
    const amounts = [1_999n, 1_999n, 2_001n];
    const many = coins.map((c, i) => ({ ...q(c, [{ pool: c.pools[0]!, out: 100n * BigInt(i + 1) }], null, false, FEE), amountIn: amounts[i]! }));
    const order = buildEvmOrder({ venue: BASE, quotes: many, routes: many.map((x) => routeEvmLeg(x, 8453)), recipient: ME, slippageBps: 100, deadline: DEADLINE })!;
    expect(order).toHaveLength(1);
    expect(order[0]!.value).toBe(5_999n);
    const b = decodeBatch(order[0]!.data);
    expect(b.commands).toBe('0x050b000000');
    expect(b.transfer[2]).toBe(9n + 9n + 10n);
    expect(b.swaps.map((s) => s[1])).toEqual([1_990n, 1_990n, CONTRACT_BALANCE]);
    // What is wrapped is exactly what the coins spend: 5,999 − 28 = 1,990 + 1,990 + 1,991.
    expect(5_999n - b.transfer[2]).toBe(1_990n + 1_990n + (2_001n - 10n));
    expect(b.swaps.map((s) => s[2])).toEqual([minOut(100n, 100), minOut(200n, 100), minOut(300n, 100)]);
    expect(b.swaps.map((s) => s[3])).toEqual(coins.map((c) => v3Path(BASE.weth, (c.pools[0] as Extract<EvmPool, { dex: 'uniswap-v3' }>).fee, c.token)));
  });

  it('on Base, builds no batch without a fee read for it: no coin is sent to Uniswap fee-free by mistake', () => {
    const unpaid = quotes.map((x, i) => (i === 0 ? { ...x, venueFee: null } : x));
    expect(buildEvmOrder({ venue: BASE, quotes: unpaid, routes, recipient: ME, slippageBps: 100, deadline: DEADLINE })).toBeNull();
    const coins = EVM_BASKET.base.filter((c) => c.pools.every((p) => p.dex === 'uniswap-v3')).slice(0, 2);
    const split = coins.map((c, i) => q(c, [{ pool: c.pools[0]!, out: 100n }], null, false, i === 0 ? FEE : { ...FEE, bps: 60n }));
    expect(buildEvmOrder({ venue: BASE, quotes: split, routes: split.map((x) => routeEvmLeg(x, 8453)), recipient: ME, slippageBps: 100, deadline: DEADLINE })).toBeNull();
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
  /** A chain in a box: answers by function name; `fail` names reads that throw; `quoted` keeps what V3 was asked to price. */
  const box = (o: { pair?: string; fee?: bigint; payee?: string; fail?: string[]; quoted?: bigint[] } = {}): QuoteClient => ({
    readContract: async ({ functionName, args }) => {
      if (o.fail?.includes(functionName)) throw new Error('rpc down');
      if (functionName === 'getPair') return o.pair ?? ZERO;
      if (functionName === 'feeBps') return o.fee ?? 50n;
      if (functionName === 'revenueDistributor') return o.payee ?? SAFE;
      if (functionName === 'getAmountsOut') return [args![0] as bigint, (args![0] as bigint) * 3n];
      throw new Error(`unexpected ${functionName}`);
    },
    simulateContract: async ({ functionName, args }) => {
      if (o.fail?.includes(functionName)) throw new Error('rpc down');
      o.quoted?.push((args![0] as { amountIn: bigint }).amountIn);
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

  it('on Base, reads the venue fee first and prices V3 on the ETH left after it; V2 on the whole amount', async () => {
    const quoted: bigint[] = [];
    const [leg] = await quoteEvmLegs(box({ quoted }), BASE, legs);
    expect(leg!.venueFee).toEqual({ bps: 50n, recipient: SAFE });
    expect(quoted).toEqual([1_000n - 5n]);
    expect(leg!.outside[0]).toEqual({ pool: v2, out: 3_000n });
  });

  it('on Ethereum (no Universal Router here), reads no venue fee and prices a V3 pool on the whole amount', async () => {
    const quoted: bigint[] = [];
    const [leg] = await quoteEvmLegs(box({ quoted, fail: ['revenueDistributor'] }), ETH, [{ coin: qr, amountIn: 1_000n }]);
    expect(leg!.venueFee).toBeNull();
    expect(leg!.unread).toBe(false);
    expect(quoted).toEqual([1_000n]);
  });

  it('on Base, a fee or payee that cannot be read holds every coin: nothing is priced as if fee-free', async () => {
    for (const o of [{ fail: ['revenueDistributor'] }, { fail: ['feeBps'] }, { payee: ZERO }, { payee: 'not an address' }, { fee: 1_001n }]) {
      const quoted: bigint[] = [];
      const out = await quoteEvmLegs(box({ ...o, quoted }), BASE, [{ coin: mfer, amountIn: 1_000n }, { coin: qr, amountIn: 1_000n }]);
      expect(out.map((l) => l.unread)).toEqual([true, true]);
      expect(out.map((l) => l.venueFee)).toEqual([null, null]);
      expect(quoted).toEqual([]);
    }
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
