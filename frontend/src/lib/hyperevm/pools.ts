import { erc20Abi } from 'viem';
import { HYPEREVM_TOKENS, V3_FEE_TIERS, type HyperEvmToken, type HyperEvmVenue } from '../chains/hyperEvm';
import { V3_POOL_SLOT0_ABI } from '../evm/islandV3Route';
import { listedCoin, readCoins } from './coins';
import { readUnits } from './reads';

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

/** A pool found, before its state is read. */
export interface PoolSlot {
  address: `0x${string}`;
  token0: HyperEvmToken;
  token1: HyperEvmToken;
  fee: number;
  tickSpacing: number;
}

/**
 * Every pool the venue has for the listed coins, then every pool anyone opened through our
 * opener (opener.ts), each with its price, liquidity and holdings. A failed read of our own
 * contracts is `ok: false`, never an empty or shorter list: "no pools" and "could not read"
 * differ. A pool opened through the opener whose coin does not answer is left out alone
 * (reads.ts): one bad coin must never blank the list, the swap or the positions for everyone.
 */
export async function readPools(reader: HyperEvmReader, venue: HyperEvmVenue, tokens: readonly HyperEvmToken[] = HYPEREVM_TOKENS): Promise<PoolsRead> {
  try {
    const slots = coinPairs(poolCoins(tokens)).flatMap(([token0, token1]) => V3_FEE_TIERS.map((tier) => ({ token0, token1, ...tier })));
    const found = await reader.multicall({
      allowFailure: true,
      contracts: slots.map((s) => ({ address: venue.factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [s.token0.address, s.token1.address, s.fee] })),
    });
    if (found.some((r) => !ok(r))) return { ok: false };
    const listed = slots
      .map((s, i) => ({ ...s, address: (found[i] as { result: unknown }).result as `0x${string}` }))
      .filter((s) => typeof s.address === 'string' && s.address.toLowerCase() !== ZERO);
    let opened: PoolSlot[] = [];
    if (venue.poolOpener) {
      const r = await readOpenedSlots(reader, venue.poolOpener);
      if (!r) return { ok: false };
      opened = r;
    }
    const seen = new Set(listed.map((p) => p.address.toLowerCase()));
    const ours = await readPoolStates(reader, listed);
    if (!ours.ok) return ours;
    const others = await readOpenedStates(reader, opened.filter((p) => !seen.has(p.address.toLowerCase())));
    return { ok: true, pools: [...ours.pools, ...others] };
  } catch {
    return { ok: false };
  }
}

const stateCalls = (p: PoolSlot): ReadCall[] => [
  { address: p.address, abi: V3_POOL_SLOT0_ABI, functionName: 'slot0' },
  { address: p.address, abi: V3_POOL_LIQUIDITY_ABI, functionName: 'liquidity' },
  { address: p.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
  { address: p.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
];

function poolFrom(p: PoolSlot, state: readonly ReadResult[]): V3Pool {
  const [slot0, liquidity, reserve0, reserve1] = state.map((r) => (r as { result: unknown }).result);
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
}

/** The pools these slots name, with their state; `ok: false` if any read fails (our own listed coins and pools). */
export async function readPoolStates(reader: HyperEvmReader, live: readonly PoolSlot[]): Promise<PoolsRead> {
  try {
    if (live.length === 0) return { ok: true, pools: [] };
    const state = await reader.multicall({ allowFailure: true, contracts: live.flatMap(stateCalls) });
    if (state.some((r) => !ok(r))) return { ok: false };
    return { ok: true, pools: live.map((p, i) => poolFrom(p, state.slice(i * 4, i * 4 + 4))) };
  } catch {
    return { ok: false };
  }
}

/** The same for pools of coins anyone could have written: each pool read on its own terms, a failed one left out. */
export async function readOpenedStates(reader: HyperEvmReader, live: readonly PoolSlot[]): Promise<V3Pool[]> {
  const res = await readUnits(reader, live.map(stateCalls));
  return live.flatMap((p, i) => {
    const r = res[i];
    return r && r.length === 4 && r.every(ok) ? [poolFrom(p, r)] : [];
  });
}

export const POOL_OPENER_READ_ABI = [
  { type: 'function', name: 'poolCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'pools', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
] as const;

export const V3_POOL_KEY_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }] },
] as const;

/** The newest pools opened through the opener that the site reads; older ones past this are not shown. */
export const OPENED_POOLS_READ = 300;

/**
 * The pools opened through our opener, newest first, each with its two coins read from their
 * own contracts (coins.ts). Only a pool with one listed coin (HYPE, USDC or USD₮0) shows, as the
 * open form offers; a pool whose other coin does not answer as a coin is left out. Null if the
 * list itself (our opener and Uniswap's pools) could not be read.
 */
export async function readOpenedSlots(reader: HyperEvmReader, opener: `0x${string}`): Promise<PoolSlot[] | null> {
  const [count] = await reader.multicall({ allowFailure: true, contracts: [{ address: opener, abi: POOL_OPENER_READ_ABI, functionName: 'poolCount' }] });
  if (!ok(count)) return null;
  const n = Number(count.result as bigint);
  if (n === 0) return [];
  const from = Math.max(0, n - OPENED_POOLS_READ);
  const idx = Array.from({ length: n - from }, (_, i) => BigInt(n - 1 - i));
  const addrs = await reader.multicall({ allowFailure: true, contracts: idx.map((i) => ({ address: opener, abi: POOL_OPENER_READ_ABI, functionName: 'pools', args: [i] })) });
  if (addrs.some((r) => !ok(r))) return null;
  const pools = addrs.map((r) => (r as { result: unknown }).result as `0x${string}`);
  const keys = await reader.multicall({
    allowFailure: true,
    contracts: pools.flatMap((address) => [
      { address, abi: V3_POOL_KEY_ABI, functionName: 'token0' },
      { address, abi: V3_POOL_KEY_ABI, functionName: 'token1' },
      { address, abi: V3_POOL_KEY_ABI, functionName: 'fee' },
    ]),
  });
  if (keys.some((r) => !ok(r))) return null;
  const raw = pools
    .map((address, i) => {
      const [t0, t1, fee] = keys.slice(i * 3, i * 3 + 3).map((r) => (r as { result: unknown }).result);
      return { address, t0: t0 as `0x${string}`, t1: t1 as `0x${string}`, fee: Number(fee) };
    })
    .filter((p) => listedCoin(p.t0) !== null || listedCoin(p.t1) !== null);
  const coins = await readCoins(reader, raw.flatMap((p) => [p.t0, p.t1]));
  const out: PoolSlot[] = [];
  for (const p of raw) {
    const token0 = coins.get(p.t0.toLowerCase());
    const token1 = coins.get(p.t1.toLowerCase());
    const tier = V3_FEE_TIERS.find((t) => t.fee === p.fee);
    if (token0 && token1 && tier) out.push({ address: p.address, token0, token1, fee: p.fee, tickSpacing: tier.tickSpacing });
  }
  return out;
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
