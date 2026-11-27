import { erc20Abi } from 'viem';
import { HYPEREVM_TOKENS, V3_FEE_TIERS, type HyperEvmToken, type HyperEvmVenue } from '../chains/hyperEvm';
import { V3_POOL_SLOT0_ABI } from '../evm/islandV3Route';

/**
 * Our HyperEVM pools, found the one way a copy cannot fake: the factory's own getPool for every
 * pair of listed coins at each fee tier. Uniswap's factory keeps one pool per pair and tier, so a
 * pool of two listed coins is ours and nobody else's. Reads only, through the reader handed in.
 */
export const V3_FACTORY_ABI = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }], outputs: [{ name: 'pool', type: 'address' }] },
] as const;

export const V3_POOL_LIQUIDITY_ABI = [
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
] as const;

/** One read in a batch: the shape viem's multicall takes. */
export interface ReadCall {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}
export type ReadResult = { status: 'success'; result: unknown } | { status: 'failure'; error?: unknown };

/** What the HyperEVM forms read through: viem's public client fits it. */
export interface HyperEvmReader {
  multicall(args: { contracts: readonly ReadCall[]; allowFailure: true }): Promise<readonly ReadResult[]>;
  simulateContract(args: ReadCall & { account?: `0x${string}` }): Promise<{ result: unknown }>;
}

export interface V3Pool {
  address: `0x${string}`;
  /** Sorted by address, as the pool holds them. */
  token0: HyperEvmToken;
  token1: HyperEvmToken;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** What the pool holds of each coin. */
  reserve0: bigint;
  reserve1: bigint;
  /**
   * The venue's share of the pool fee on each side, as slot0.feeProtocol stores it: 1/n of the
   * fee, 0 = not switched on for this pool yet. Read, never assumed.
   */
  venueShare0: number;
  venueShare1: number;
}

/** The coins a pool can hold: every listed coin but HYPE, which pools hold as WHYPE. */
export function poolCoins(tokens: readonly HyperEvmToken[] = HYPEREVM_TOKENS): HyperEvmToken[] {
  return tokens.filter((t) => !t.isNative);
}

/** Every pair of pool coins, each sorted by address as Uniswap sorts a pool's two tokens. */
export function coinPairs(coins: readonly HyperEvmToken[]): [HyperEvmToken, HyperEvmToken][] {
  const out: [HyperEvmToken, HyperEvmToken][] = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      const a = coins[i]!;
      const b = coins[j]!;
      out.push(a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a]);
    }
  }
  return out;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const ok = (r: ReadResult | undefined): r is { status: 'success'; result: unknown } => r?.status === 'success';

export type PoolsRead = { ok: true; pools: V3Pool[] } | { ok: false };

/**
 * Every pool the venue has for the listed coins, with its price, liquidity and holdings. A
 * failed read is `ok: false`, never an empty list: "no pools" and "could not read" differ.
 */
export async function readPools(reader: HyperEvmReader, venue: HyperEvmVenue, tokens: readonly HyperEvmToken[] = HYPEREVM_TOKENS): Promise<PoolsRead> {
  try {
    const slots = coinPairs(poolCoins(tokens)).flatMap(([token0, token1]) => V3_FEE_TIERS.map((tier) => ({ token0, token1, ...tier })));
    const found = await reader.multicall({
      allowFailure: true,
      contracts: slots.map((s) => ({ address: venue.factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [s.token0.address, s.token1.address, s.fee] })),
    });
    if (found.some((r) => !ok(r))) return { ok: false };
    const live = slots
      .map((s, i) => ({ ...s, address: (found[i] as { result: unknown }).result as `0x${string}` }))
      .filter((s) => typeof s.address === 'string' && s.address.toLowerCase() !== ZERO);
    if (live.length === 0) return { ok: true, pools: [] };
    const state = await reader.multicall({
      allowFailure: true,
      contracts: live.flatMap((p) => [
        { address: p.address, abi: V3_POOL_SLOT0_ABI, functionName: 'slot0' },
        { address: p.address, abi: V3_POOL_LIQUIDITY_ABI, functionName: 'liquidity' },
        { address: p.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
        { address: p.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
      ]),
    });
    if (state.some((r) => !ok(r))) return { ok: false };
    const pools = live.map((p, i): V3Pool => {
      const [slot0, liquidity, reserve0, reserve1] = state.slice(i * 4, i * 4 + 4).map((r) => (r as { result: unknown }).result);
      const [sqrtPriceX96, tick, , , , feeProtocol] = slot0 as readonly [bigint, number, number, number, number, number, boolean];
      return {
        address: p.address,
        token0: p.token0,
        token1: p.token1,
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        sqrtPriceX96,
        tick: Number(tick),
        liquidity: liquidity as bigint,
        reserve0: reserve0 as bigint,
        reserve1: reserve1 as bigint,
        venueShare0: Number(feeProtocol) % 16,
        venueShare1: Number(feeProtocol) >> 4,
      };
    });
    return { ok: true, pools };
  } catch {
    return { ok: false };
  }
}

/** A pool fee in percent, as Uniswap prints it: 3000 is 0.3%. */
export function feeTierText(fee: number): string {
  return `${(fee / 10_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/**
 * How one pool's fee is split, in percent of each trade: the LPs' part and the venue's.
 * `share` is the 1/n the pool stores; 0 means the venue's cut is not on for it yet.
 */
export function feeSplitText(fee: number, share: number): { lps: string; venue: string | null } {
  if (share === 0) return { lps: feeTierText(fee), venue: null };
  const venue = fee / share;
  const pct = (bp100: number) => `${(bp100 / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;
  return { lps: pct(fee - venue), venue: pct(venue) };
}
