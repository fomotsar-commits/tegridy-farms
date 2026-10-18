import { encodeFunctionData } from 'viem';
import { SWAP_FEE_ROUTER_ABI, TEGRIDY_FACTORY_ABI, TEGRIDY_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI } from '../contracts';
import type { SwapVenue } from '../chains/swapVenue';
import { minOut, type EvmBasketCoin, type EvmPool } from '../islandBasket';

/**
 * The island order on Ethereum and Base: quote every pool each coin has, take the one
 * that pays most (ours on a tie or better, net of its fee, as the swap does), and send
 * as few transactions as that allows. No fetch and no wallet here: the reads go through
 * the client handed in, and the order is calldata the page sends.
 *
 * UNISWAP'S OWN ROUTER CARRIES THE ORDER. SwapRouter02's `multicall(deadline, calls)` runs
 * every leg in ONE transaction: each leg is paid from the ETH sent with it (the router
 * wraps exactly that leg's amount: PeripheryPayments.pay), so the order needs no approval,
 * and if one leg would get less than its minimum the whole transaction reverts and no
 * coin is bought. A trailing refundETH() returns anything left. Read on chain 2026-10-18:
 *   Ethereum 0x68b3…Fc45: factory = Uniswap V3's, factoryV2 = Uniswap V2's, WETH9 = WETH.
 *   Base     0x2626…1e481: factory = Uniswap V3's, WETH9 = 0x4200…0006, and factoryV2 = 0x0:
 *            it cannot reach a V2 pair, so a Base V2 leg is its own transaction through
 *            Uniswap's V2 router (the address the swap already uses).
 * QuoterV2 (same reads: its factory() is Uniswap V3's on both) prices the V3 legs.
 *
 * A leg our own pool wins goes through SwapFeeRouter, the swap's own path, as its own
 * transaction: the venue fee is taken there and nowhere else. Uniswap legs pay the venue
 * nothing, exactly like a Uniswap-routed swap on the form.
 */

const UNISWAP: Readonly<Record<number, { swapRouter02: `0x${string}`; quoterV2: `0x${string}`; v2InBatch: boolean }>> = {
  1: { swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', v2InBatch: true },
  8453: { swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481', quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', v2InBatch: false },
};

export function uniswapOn(chainId: number): { swapRouter02: `0x${string}`; quoterV2: `0x${string}`; v2InBatch: boolean } | null {
  return UNISWAP[chainId] ?? null;
}

/** SwapRouter02, only what the order calls. The multicall is the (deadline, data) overload. */
export const SWAP_ROUTER02_ABI = [
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ name: '', type: 'bytes[]' }] },
  {
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  { type: 'function', name: 'swapExactTokensForTokens', stateMutability: 'payable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { type: 'function', name: 'refundETH', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

/** QuoterV2.quoteExactInputSingle. Not a view (it runs the swap and reverts inside), so it is simulated. */
export const QUOTER_V2_ABI = [
  {
    type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
        { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' }, { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' }],
  },
] as const;

const ZERO = '0x0000000000000000000000000000000000000000';
/** SwapFeeRouter refuses a fee above this, as the swap form sends it. */
export const MAX_FEE_BPS = 100n;

/** The reads the quote needs, so a test can hand in its own. */
export interface QuoteClient {
  readContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  simulateContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<{ result: unknown }>;
}

/** One coin's quotes for its share. `null` = asked and not answered; a pool with no quote is absent from `outside`. */
export interface EvmLegQuote {
  coin: EvmBasketCoin;
  amountIn: bigint;
  /** Every outside pool that answered, with what it pays. */
  outside: { pool: EvmPool; out: bigint }[];
  /** Our pool, NET of the venue fee (`feeBps`, read live); null when we have no pair for the coin. */
  ours: { out: bigint; feeBps: bigint } | null;
  /** A read that was asked did not come back: the leg cannot be decided, so the order waits. */
  unread: boolean;
}

/** Where a leg goes. `out` is what it is quoted to pay the buyer. */
export type EvmLegRoute =
  | { via: 'batch'; pool: EvmPool; out: bigint }
  | { via: 'v2-router'; pool: EvmPool & { dex: 'uniswap-v2' }; out: bigint }
  | { via: 'ours'; out: bigint }
  | { via: 'none'; why: 'unread' | 'no-pool' };

async function quoteOutside(client: QuoteClient, venue: SwapVenue, quoter: `0x${string}`, coin: EvmBasketCoin, pool: EvmPool, amountIn: bigint): Promise<bigint> {
  if (pool.dex === 'uniswap-v2') {
    const amounts = (await client.readContract({
      address: venue.uniswapV2Router, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, [venue.weth, coin.token]],
    })) as readonly bigint[];
    return amounts[amounts.length - 1] ?? 0n;
  }
  const { result } = await client.simulateContract({
    address: quoter, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: venue.weth, tokenOut: coin.token, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
  });
  return (result as readonly [bigint, ...unknown[]])[0];
}

/**
 * Our pool's quote, net of SwapFeeRouter's fee read live (the same linear haircut the
 * swap uses: it never over-promises). A fee outside 0–10% is no reading. Null: no pair.
 */
async function quoteOurs(client: QuoteClient, venue: SwapVenue, coin: EvmBasketCoin, amountIn: bigint): Promise<{ out: bigint; feeBps: bigint } | null> {
  const pair = (await client.readContract({ address: venue.factory, abi: TEGRIDY_FACTORY_ABI, functionName: 'getPair', args: [coin.token, venue.weth] })) as string;
  if (!pair || pair.toLowerCase() === ZERO) return null;
  const [amounts, feeBps] = await Promise.all([
    client.readContract({ address: venue.router, abi: TEGRIDY_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, [venue.weth, coin.token]] }) as Promise<readonly bigint[]>,
    client.readContract({ address: venue.swapFeeRouter, abi: SWAP_FEE_ROUTER_ABI, functionName: 'feeBps' }) as Promise<bigint>,
  ]);
  if (typeof feeBps !== 'bigint' || feeBps < 0n || feeBps > 1000n) throw new Error('fee unread');
  const gross = amounts[amounts.length - 1] ?? 0n;
  return { out: (gross * (10_000n - feeBps)) / 10_000n, feeBps };
}

/** How long one pool's quote may take before its coin counts as unread (a public RPC can stall). */
export const QUOTE_TIMEOUT_MS = 12_000;

/** `p`, or a rejection after `ms`. */
function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

/** Quote every leg. Never throws: a read that fails, or does not answer in time, marks its leg unread. */
export async function quoteEvmLegs(
  client: QuoteClient,
  venue: SwapVenue,
  legs: readonly { coin: EvmBasketCoin; amountIn: bigint }[],
  timeoutMs: number = QUOTE_TIMEOUT_MS,
): Promise<EvmLegQuote[]> {
  const uni = uniswapOn(venue.chainId);
  if (!uni) return legs.map((l) => ({ ...l, outside: [], ours: null, unread: true }));
  return Promise.all(legs.map(async ({ coin, amountIn }) => {
    let unread = false;
    const outside: EvmLegQuote['outside'] = [];
    await Promise.all(coin.pools.map(async (pool) => {
      try {
        const out = await timed(quoteOutside(client, venue, uni.quoterV2, coin, pool, amountIn), timeoutMs);
        if (out > 0n) outside.push({ pool, out });
      } catch {
        unread = true;
      }
    }));
    let ours: EvmLegQuote['ours'] = null;
    try {
      ours = await timed(quoteOurs(client, venue, coin, amountIn), timeoutMs);
    } catch {
      unread = true;
    }
    // Registry order, whatever order the reads answered in.
    outside.sort((a, b) => coin.pools.indexOf(a.pool) - coin.pools.indexOf(b.pool));
    return { coin, amountIn, outside, ours, unread };
  }));
}

/**
 * The swap's rule, per leg: our pool when it pays at least as much as the best outside
 * pool, net of its fee; otherwise the outside pool that pays most (the first listed on a
 * tie). An unread leg is not guessed.
 */
export function routeEvmLeg(q: EvmLegQuote, chainId: number): EvmLegRoute {
  if (q.unread) return { via: 'none', why: 'unread' };
  const best = q.outside.reduce<EvmLegQuote['outside'][number] | null>((b, c) => (b === null || c.out > b.out ? c : b), null);
  if (q.ours && q.ours.out > 0n && (best === null || q.ours.out >= best.out)) return { via: 'ours', out: q.ours.out };
  if (!best) return { via: 'none', why: 'no-pool' };
  if (best.pool.dex === 'uniswap-v2' && !uniswapOn(chainId)?.v2InBatch) return { via: 'v2-router', pool: best.pool, out: best.out };
  return { via: 'batch', pool: best.pool, out: best.out };
}

/** One transaction the wallet is asked to sign. `legs` are the coins it buys, by index. */
export interface EvmOrderTx {
  kind: 'batch' | 'v2-router' | 'ours';
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  legs: number[];
}

/**
 * The order's transactions, Uniswap's batch first. Null when a leg has no route, a floor
 * cannot be set, or the chain has no Uniswap router here: the order is not built in part.
 */
export function buildEvmOrder(a: {
  venue: SwapVenue;
  quotes: readonly EvmLegQuote[];
  routes: readonly EvmLegRoute[];
  recipient: `0x${string}`;
  slippageBps: number;
  deadline: bigint;
}): EvmOrderTx[] | null {
  const uni = uniswapOn(a.venue.chainId);
  if (!uni || a.quotes.length === 0 || a.quotes.length !== a.routes.length) return null;
  const calls: `0x${string}`[] = [];
  const batchLegs: number[] = [];
  let batchValue = 0n;
  const singles: EvmOrderTx[] = [];
  for (let i = 0; i < a.quotes.length; i++) {
    const q = a.quotes[i]!;
    const r = a.routes[i]!;
    if (r.via === 'none') return null;
    const floor = minOut(r.out, a.slippageBps);
    if (floor === null || q.amountIn <= 0n) return null;
    const path = [a.venue.weth, q.coin.token] as const;
    if (r.via === 'ours') {
      singles.push({
        kind: 'ours', to: a.venue.swapFeeRouter, value: q.amountIn, legs: [i],
        data: encodeFunctionData({ abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [floor, [...path], a.recipient, a.deadline, MAX_FEE_BPS] }),
      });
    } else if (r.via === 'v2-router') {
      singles.push({
        kind: 'v2-router', to: a.venue.uniswapV2Router, value: q.amountIn, legs: [i],
        data: encodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [floor, [...path], a.recipient, a.deadline] }),
      });
    } else {
      calls.push(r.pool.dex === 'uniswap-v3'
        ? encodeFunctionData({
            abi: SWAP_ROUTER02_ABI, functionName: 'exactInputSingle',
            args: [{ tokenIn: a.venue.weth, tokenOut: q.coin.token, fee: r.pool.fee, recipient: a.recipient, amountIn: q.amountIn, amountOutMinimum: floor, sqrtPriceLimitX96: 0n }],
          })
        : encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: 'swapExactTokensForTokens', args: [q.amountIn, floor, [...path], a.recipient] }));
      batchLegs.push(i);
      batchValue += q.amountIn;
    }
  }
  const txs: EvmOrderTx[] = [];
  if (calls.length > 0) {
    calls.push(encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: 'refundETH' }));
    txs.push({
      kind: 'batch', to: uni.swapRouter02, value: batchValue, legs: batchLegs,
      data: encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: 'multicall', args: [a.deadline, calls] }),
    });
  }
  return [...txs, ...singles];
}
