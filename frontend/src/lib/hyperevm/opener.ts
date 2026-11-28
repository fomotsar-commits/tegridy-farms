import { TickMath, encodeSqrtRatioX96 } from '@uniswap/v3-sdk';
import { encodeFunctionData } from 'viem';
import { poolSide, type HyperEvmToken, type HyperEvmVenue } from '../chains/hyperEvm';
import { V3_POOL_SLOT0_ABI } from '../evm/islandV3Route';
import { V3_FACTORY_ABI, type HyperEvmReader, type ReadResult } from './pools';

/**
 * Opening a pool through our HyperEVMPoolOpener (contracts/hyperevm/src): the wallet pays the
 * opener's own POOL_OPENING_FEE (0.23 HYPE, read from the contract, never assumed), and the
 * opener opens the pool at the price the wallet sets, switches the venue's cut on and pays the
 * fee to the treasury Safe, all in one transaction. Nothing here signs or sends.
 *
 * An opening costs about 4.6M gas. HyperEVM's fast blocks hold 3M, so a wallet can open a pool
 * only once it has Hyperliquid's big-block setting on: the site reads it (eth_usingBigBlocks)
 * and says so, and never asks for a key to switch it.
 */
export const POOL_OPENER_ABI = [
  { type: 'function', name: 'POOL_OPENING_FEE', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'TREASURY', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'function', name: 'open', stateMutability: 'payable',
    inputs: [{ name: 'token0', type: 'address' }, { name: 'token1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceX96', type: 'uint160' }],
    outputs: [{ name: 'pool', type: 'address' }],
  },
  { type: 'function', name: 'list', stateMutability: 'payable', inputs: [{ name: 'pool', type: 'address' }], outputs: [] },
  { type: 'function', name: 'listed', stateMutability: 'view', inputs: [{ name: 'pool', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

/** The two coins of a pool in the order the pool holds them (by address), each as the pool holds it (HYPE as WHYPE). */
export function sortedPair(coin: HyperEvmToken, partner: HyperEvmToken): [HyperEvmToken, HyperEvmToken] {
  const a = { ...coin, address: poolSide(coin) };
  const b = { ...partner, address: poolSide(partner) };
  return a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];
}

/** The most digits a typed price may have after its point: enough for a coin worth 1e-30 of a dollar. */
export const PRICE_DECIMALS = 36;

export type PriceRead =
  | { ok: true; num: bigint; den: bigint; shown: string }
  | { ok: false; why: 'empty' | 'grouped' | 'bad' };

/**
 * A typed price as an exact fraction. A point or a comma marks the decimals, but never both,
 * and "1,000" (a comma before exactly three digits, as a thousands mark reads) is refused rather
 * than read as 1: the price is the one figure the opener cannot take back.
 */
export function parsePrice(text: string): PriceRead {
  const t = text.trim();
  if (t === '') return { ok: false, why: 'empty' };
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(t) || (t.includes(',') && t.includes('.'))) return { ok: false, why: 'grouped' };
  const m = /^(\d*)(?:[.,](\d*))?$/.exec(t);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, why: 'bad' };
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > PRICE_DECIMALS) return { ok: false, why: 'bad' };
  const num = BigInt(`${m[1] || '0'}${frac}`);
  if (num === 0n) return { ok: false, why: 'bad' };
  const whole = (m[1] || '0').replace(/^0+(?=\d)/, '');
  return { ok: true, num, den: 10n ** BigInt(frac.length), shown: frac ? `${whole}.${frac}` : whole };
}

/**
 * The pool's opening price from "1 `coin` = `text` `partner`", in Uniswap's encoding (token1
 * per token0, both in their smallest units). Null for no price, zero, or a price outside the
 * range a Uniswap pool can hold.
 */
export function startSqrtPrice(text: string, coin: HyperEvmToken, partner: HyperEvmToken): bigint | null {
  const p = parsePrice(text);
  if (!p.ok) return null;
  const [t0] = sortedPair(coin, partner);
  const coinIsToken0 = t0.address.toLowerCase() === poolSide(coin).toLowerCase();
  const unitsCoin = 10n ** BigInt(coin.decimals);
  const unitsPartner = 10n ** BigInt(partner.decimals);
  // One whole coin is worth num/den whole partners. In smallest units, token1 per token0 is
  // (num * unitsPartner) / (den * unitsCoin) when the coin is token0, and the inverse otherwise.
  const [amount1, amount0] = coinIsToken0 ? [p.num * unitsPartner, p.den * unitsCoin] : [p.den * unitsCoin, p.num * unitsPartner];
  const sqrt = BigInt(encodeSqrtRatioX96(amount1.toString(), amount0.toString()).toString());
  const min = BigInt(TickMath.MIN_SQRT_RATIO.toString());
  const max = BigInt(TickMath.MAX_SQRT_RATIO.toString());
  return sqrt >= min && sqrt < max ? sqrt : null;
}

/** The opening transaction: the opener's call, paying exactly its fee. */
export function openTx(opener: `0x${string}`, coin: HyperEvmToken, partner: HyperEvmToken, fee: number, sqrtPriceX96: bigint, openingFee: bigint) {
  const [t0, t1] = sortedPair(coin, partner);
  return {
    to: opener,
    value: openingFee,
    data: encodeFunctionData({ abi: POOL_OPENER_ABI, functionName: 'open', args: [t0.address, t1.address, fee, sqrtPriceX96] }),
  };
}

export type PoolAt = { kind: 'none' } | { kind: 'unpriced'; address: `0x${string}` } | { kind: 'open'; address: `0x${string}` };

const ok = (r: ReadResult | undefined): r is { status: 'success'; result: unknown } => r?.status === 'success';
const ZERO = /^0x0{40}$/i;

/** Whether our factory already has this pool, and whether it has a price yet. Null if unread. */
export async function poolAt(reader: HyperEvmReader, venue: HyperEvmVenue, coin: HyperEvmToken, partner: HyperEvmToken, fee: number): Promise<PoolAt | null> {
  const [t0, t1] = sortedPair(coin, partner);
  const [found] = await reader.multicall({ allowFailure: true, contracts: [{ address: venue.factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [t0.address, t1.address, fee] }] });
  if (!ok(found)) return null;
  const address = found.result as `0x${string}`;
  if (ZERO.test(address)) return { kind: 'none' };
  const [slot0] = await reader.multicall({ allowFailure: true, contracts: [{ address, abi: V3_POOL_SLOT0_ABI, functionName: 'slot0' }] });
  if (!ok(slot0)) return null;
  return (slot0.result as readonly [bigint])[0] === 0n ? { kind: 'unpriced', address } : { kind: 'open', address };
}

/** The listing transaction: a pool opened straight on the factory joins the list for the same fee. */
export function listTx(opener: `0x${string}`, pool: `0x${string}`, openingFee: bigint) {
  return { to: opener, value: openingFee, data: encodeFunctionData({ abi: POOL_OPENER_ABI, functionName: 'list', args: [pool] }) };
}

/**
 * The opener's fee and the treasury it pays, both read from the contract itself (never
 * assumed), so the review names where the money really goes. Null if unread.
 */
export async function openerTerms(reader: HyperEvmReader, opener: `0x${string}`): Promise<{ fee: bigint; treasury: `0x${string}` } | null> {
  const [fee, treasury] = await reader.multicall({
    allowFailure: true,
    contracts: [
      { address: opener, abi: POOL_OPENER_ABI, functionName: 'POOL_OPENING_FEE' },
      { address: opener, abi: POOL_OPENER_ABI, functionName: 'TREASURY' },
    ],
  });
  return ok(fee) && ok(treasury) ? { fee: fee.result as bigint, treasury: treasury.result as `0x${string}` } : null;
}

/** The opener's fee alone. Null if unread. */
export async function openingFee(reader: HyperEvmReader, opener: `0x${string}`): Promise<bigint | null> {
  return (await openerTerms(reader, opener))?.fee ?? null;
}

/** Hyperliquid's big-block setting for this wallet, through any HyperEVM RPC that answers it. Null if unread. */
export async function usingBigBlocks(request: (args: { method: string; params: unknown[] }) => Promise<unknown>, wallet: `0x${string}`): Promise<boolean | null> {
  try {
    const r = await request({ method: 'eth_usingBigBlocks', params: [wallet] });
    return typeof r === 'boolean' ? r : null;
  } catch {
    return null;
  }
}
