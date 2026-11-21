import { CurrencyAmount, NativeCurrency, Percent, Price, Token, type Currency } from '@uniswap/sdk-core';
import { NonfungiblePositionManager, Pool, Position, TickMath, nearestUsableTick, priceToClosestTick, tickToPrice } from '@uniswap/v3-sdk';
import JSBI from 'jsbi';
import { HYPEREVM_CHAIN_ID, HYPEREVM_TOKENS, WHYPE, type HyperEvmToken, type HyperEvmVenue } from '../chains/hyperEvm';
import type { HyperEvmReader, ReadResult, V3Pool } from './pools';

/**
 * LP positions on our HyperEVM pools: read from our NonfungiblePositionManager (each position
 * is an NFT), and every add, collect and remove built by Uniswap's own SDK (@uniswap/v3-sdk),
 * which also does the position maths. Nothing here signs or sends.
 */
export const POSITION_MANAGER_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'function', name: 'positions', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
  {
    type: 'function', name: 'collect', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' }] }],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }],
  },
] as const;

const MAX_UINT128 = (1n << 128n) - 1n;
/** A wallet with more positions than this sees the first ones and a line saying so. */
export const POSITIONS_SHOWN = 30;

/** HYPE as Uniswap's SDK needs it: the chain's own coin, wrapped as WHYPE. */
class Hype extends NativeCurrency {
  constructor() {
    super(HYPEREVM_CHAIN_ID, 18, 'HYPE', 'HYPE');
  }
  get wrapped(): Token {
    return sdkToken(HYPEREVM_TOKENS.find((t) => t.address === WHYPE)!);
  }
  equals(other: Currency): boolean {
    return other.isNative && other.chainId === this.chainId;
  }
}
export const HYPE_CURRENCY: NativeCurrency = new Hype();

export function sdkToken(t: HyperEvmToken): Token {
  return new Token(HYPEREVM_CHAIN_ID, t.isNative ? WHYPE : t.address, t.decimals, t.isNative ? 'WHYPE' : t.symbol, t.name);
}

export function sdkPool(p: V3Pool): Pool {
  return new Pool(sdkToken(p.token0), sdkToken(p.token1), p.fee, p.sqrtPriceX96.toString(), p.liquidity.toString(), p.tick);
}

export interface V3PositionView {
  tokenId: bigint;
  pool: V3Pool;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** What the position holds at the pool's price now (Uniswap's SDK). */
  amount0: bigint;
  amount1: bigint;
  /** Fees earned and not collected yet, as collect() would pay them now. Null: not read. */
  owed0: bigint | null;
  owed1: bigint | null;
  inRange: boolean;
}

export type PositionsRead =
  | {
      ok: true;
      /** Newest first. */
      positions: V3PositionView[];
      /** Positions in pools of coins the site does not list. */
      unlisted: number;
      /** Emptied positions (no liquidity, nothing owed): the NFT is kept, there is nothing in it. */
      closed: number;
      /** Positions past POSITIONS_SHOWN. */
      more: number;
    }
  | { ok: false };

const ok = (r: ReadResult | undefined): r is { status: 'success'; result: unknown } => r?.status === 'success';

type RawPosition = readonly [bigint, string, `0x${string}`, `0x${string}`, number, number, number, bigint, bigint, bigint, bigint, bigint];

/** The wallet's positions on our position manager, with what each holds and has earned. */
export async function readPositions(reader: HyperEvmReader, venue: HyperEvmVenue, owner: `0x${string}`, pools: readonly V3Pool[]): Promise<PositionsRead> {
  try {
    const [count] = await reader.multicall({ allowFailure: true, contracts: [{ address: venue.positionManager, abi: POSITION_MANAGER_ABI, functionName: 'balanceOf', args: [owner] }] });
    if (!ok(count)) return { ok: false };
    const n = Number(count.result as bigint);
    const shown = Math.min(n, POSITIONS_SHOWN);
    if (shown === 0) return { ok: true, positions: [], unlisted: 0, closed: 0, more: 0 };
    const ids = await reader.multicall({
      allowFailure: true,
      contracts: Array.from({ length: shown }, (_, i) => ({ address: venue.positionManager, abi: POSITION_MANAGER_ABI, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] })),
    });
    if (ids.some((r) => !ok(r))) return { ok: false };
    const tokenIds = ids.map((r) => (r as { result: unknown }).result as bigint);
    const raw = await reader.multicall({
      allowFailure: true,
      contracts: tokenIds.map((id) => ({ address: venue.positionManager, abi: POSITION_MANAGER_ABI, functionName: 'positions', args: [id] })),
    });
    if (raw.some((r) => !ok(r))) return { ok: false };
    let unlisted = 0;
    const found: { tokenId: bigint; pool: V3Pool; p: RawPosition }[] = [];
    raw.forEach((r, i) => {
      const p = (r as { result: unknown }).result as RawPosition;
      const pool = pools.find((x) => x.token0.address.toLowerCase() === p[2].toLowerCase() && x.token1.address.toLowerCase() === p[3].toLowerCase() && x.fee === Number(p[4]));
      if (!pool) unlisted++;
      else found.push({ tokenId: tokenIds[i]!, pool, p });
    });
    const positions = await Promise.all(found.map(async ({ tokenId, pool, p }): Promise<V3PositionView> => {
      const tickLower = Number(p[5]);
      const tickUpper = Number(p[6]);
      const liquidity = p[7];
      const position = new Position({ pool: sdkPool(pool), liquidity: liquidity.toString(), tickLower, tickUpper });
      let owed0: bigint | null = null;
      let owed1: bigint | null = null;
      try {
        // What collect() would pay now, fees accrued since the last touch included: an eth_call, nothing sent.
        const { result } = await reader.simulateContract({
          address: venue.positionManager, abi: POSITION_MANAGER_ABI, functionName: 'collect', account: owner,
          args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        });
        [owed0, owed1] = result as readonly [bigint, bigint];
      } catch {
        // Left null: the row says the fees could not be read, never that they are zero.
      }
      return {
        tokenId, pool, tickLower, tickUpper, liquidity,
        amount0: BigInt(position.amount0.quotient.toString()),
        amount1: BigInt(position.amount1.quotient.toString()),
        owed0, owed1,
        // A position with no liquidity earns nothing, wherever the price is.
        inRange: liquidity > 0n && pool.tick >= tickLower && pool.tick < tickUpper,
      };
    }));
    const isClosed = (p: V3PositionView) => p.liquidity === 0n && p.owed0 === 0n && p.owed1 === 0n;
    const open = positions.filter((p) => !isClosed(p)).sort((a, b) => (a.tokenId < b.tokenId ? 1 : a.tokenId > b.tokenId ? -1 : 0));
    return { ok: true, positions: open, unlisted, closed: positions.length - open.length, more: n - shown };
  } catch {
    return { ok: false };
  }
}

export type RangePreset = 'full' | 'wide' | 'narrow';
/** The presets' width around the price now, in percent either way. */
export const PRESET_PCT: Record<Exclude<RangePreset, 'full'>, number> = { wide: 50, narrow: 10 };

/** A range's two usable ticks, for a preset or a price pair (token1 per token0, as typed). */
export function rangeTicks(pool: V3Pool, range: RangePreset | { lower: string; upper: string }): { tickLower: number; tickUpper: number } | null {
  const spacing = pool.tickSpacing;
  if (range === 'full') return { tickLower: nearestUsableTick(TickMath.MIN_TICK, spacing), tickUpper: nearestUsableTick(TickMath.MAX_TICK, spacing) };
  const sp = sdkPool(pool);
  let lower: Price<Token, Token> | null;
  let upper: Price<Token, Token> | null;
  if (typeof range === 'string') {
    const pct = PRESET_PCT[range];
    const now = sp.token0Price;
    lower = new Price(sp.token0, sp.token1, JSBI.multiply(now.denominator, JSBI.BigInt(100)), JSBI.multiply(now.numerator, JSBI.BigInt(100 - pct)));
    upper = new Price(sp.token0, sp.token1, JSBI.multiply(now.denominator, JSBI.BigInt(100)), JSBI.multiply(now.numerator, JSBI.BigInt(100 + pct)));
  } else {
    lower = typedPrice(sp.token0, sp.token1, range.lower);
    upper = typedPrice(sp.token0, sp.token1, range.upper);
  }
  if (!lower || !upper) return null;
  const clamp = (t: number) => Math.min(Math.max(t, TickMath.MIN_TICK), TickMath.MAX_TICK);
  let tickLower = nearestUsableTick(clamp(priceToClosestTick(lower)), spacing);
  let tickUpper = nearestUsableTick(clamp(priceToClosestTick(upper)), spacing);
  if (tickLower > tickUpper) [tickLower, tickUpper] = [tickUpper, tickLower];
  if (tickLower === tickUpper) tickUpper = tickLower + spacing;
  if (tickLower < TickMath.MIN_TICK || tickUpper > TickMath.MAX_TICK) return null;
  return { tickLower, tickUpper };
}

/** A typed price (how much token1 one whole token0 is worth) as Uniswap's Price, or null. */
function typedPrice(base: Token, quote: Token, text: string): Price<Token, Token> | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text.replace(',', '.'));
  if (!m) return null;
  const digits = `${m[1]}${m[2] ?? ''}`.replace(/^0+(?=\d)/, '');
  const scale = (m[2] ?? '').length;
  if (/^0+$/.test(digits)) return null;
  // raw quote per raw base = typed × 10^quote.decimals / 10^base.decimals
  const numerator = JSBI.multiply(JSBI.BigInt(digits), JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(quote.decimals)));
  const denominator = JSBI.multiply(JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(scale)), JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(base.decimals)));
  return new Price(base, quote, denominator, numerator);
}

/**
 * A price as the SDK writes it (six significant digits), or in short form past a million
 * million either way: a near-empty pool's price can sit at an extreme tick, and forty digits
 * would break the line.
 */
function priceText(sdkText: string): string {
  const n = Number(sdkText);
  return Number.isFinite(n) && n !== 0 && (n >= 1e12 || n < 1e-12) ? n.toExponential(3) : sdkText;
}

/** A tick's price, token1 per token0, for the range lines. */
export function tickPriceText(pool: V3Pool, tick: number): string {
  if (tick <= nearestUsableTick(TickMath.MIN_TICK, pool.tickSpacing)) return '0';
  if (tick >= nearestUsableTick(TickMath.MAX_TICK, pool.tickSpacing)) return '∞';
  return priceText(tickToPrice(sdkToken(pool.token0), sdkToken(pool.token1), tick).toSignificant(6));
}

/** The pool's price now, token1 per token0. */
export function poolPriceText(pool: V3Pool): string {
  return priceText(sdkPool(pool).token0Price.toSignificant(6));
}

/**
 * The other side of a deposit: given how much of one coin goes in, how much of the other the
 * range needs at the price now (Uniswap's SDK, full precision). Null when the range cannot take
 * that coin at all (the price is past that edge of it).
 */
export function pairedAmount(pool: V3Pool, ticks: { tickLower: number; tickUpper: number }, side: 0 | 1, amount: bigint): { amount0: bigint; amount1: bigint } | null {
  if (amount <= 0n) return null;
  // Past an edge the range holds one coin only, and the SDK would ignore the amount typed and
  // ask for an unlimited amount of the other: a range above the price takes only token0, below only token1.
  if (side === 0 && pool.tick >= ticks.tickUpper) return null;
  if (side === 1 && pool.tick < ticks.tickLower) return null;
  const args = { pool: sdkPool(pool), ...ticks, useFullPrecision: true };
  const position = side === 0 ? Position.fromAmount0({ ...args, amount0: amount.toString() }) : Position.fromAmount1({ ...args, amount1: amount.toString() });
  if (JSBI.equal(position.liquidity, JSBI.BigInt(0))) return null;
  const { amount0, amount1 } = position.mintAmounts;
  return { amount0: BigInt(amount0.toString()), amount1: BigInt(amount1.toString()) };
}

export interface PositionTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

const percent = (bps: number) => new Percent(bps, 10_000);
const isWhype = (t: HyperEvmToken) => t.address.toLowerCase() === WHYPE.toLowerCase();

/**
 * Add to a range: a new position (mint) or more in one the wallet holds (increase). With
 * `useHype`, the WHYPE side is paid in HYPE sent with the call and any HYPE left is refunded.
 * The amounts actually deposited are the SDK's mint amounts for the liquidity they buy.
 */
export function addTx(a: {
  venue: HyperEvmVenue; pool: V3Pool; tickLower: number; tickUpper: number; amount0: bigint; amount1: bigint;
  recipient: `0x${string}`; slippageBps: number; deadline: bigint; tokenId?: bigint; useHype: boolean;
}): PositionTx & { amount0: bigint; amount1: bigint } {
  const position = Position.fromAmounts({ pool: sdkPool(a.pool), tickLower: a.tickLower, tickUpper: a.tickUpper, amount0: a.amount0.toString(), amount1: a.amount1.toString(), useFullPrecision: true });
  const common = { slippageTolerance: percent(a.slippageBps), deadline: a.deadline.toString(), useNative: a.useHype ? HYPE_CURRENCY : undefined };
  const { calldata, value } = a.tokenId !== undefined
    ? NonfungiblePositionManager.addCallParameters(position, { ...common, tokenId: a.tokenId.toString() })
    : NonfungiblePositionManager.addCallParameters(position, { ...common, recipient: a.recipient });
  const { amount0, amount1 } = position.mintAmounts;
  return { to: a.venue.positionManager, data: calldata as `0x${string}`, value: BigInt(value), amount0: BigInt(amount0.toString()), amount1: BigInt(amount1.toString()) };
}

/** The currency a side is paid out in: HYPE for the WHYPE side when the wallet asked for HYPE. */
function payoutCurrency(t: HyperEvmToken, hype: boolean): Currency {
  return hype && isWhype(t) ? HYPE_CURRENCY : sdkToken(t);
}

/** Collect a position's fees to the wallet (as HYPE for a WHYPE side when `hype`). */
export function collectTx(a: { venue: HyperEvmVenue; position: V3PositionView; recipient: `0x${string}`; hype: boolean }): PositionTx {
  const { position: p } = a;
  const { calldata, value } = NonfungiblePositionManager.collectCallParameters({
    tokenId: p.tokenId.toString(),
    expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(payoutCurrency(p.pool.token0, a.hype), (p.owed0 ?? 0n).toString()),
    expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(payoutCurrency(p.pool.token1, a.hype), (p.owed1 ?? 0n).toString()),
    recipient: a.recipient,
  });
  return { to: a.venue.positionManager, data: calldata as `0x${string}`, value: BigInt(value) };
}

/** Take `pct` percent of a position out, with its fees, to the wallet. The NFT is kept. */
export function removeTx(a: { venue: HyperEvmVenue; position: V3PositionView; pct: number; recipient: `0x${string}`; slippageBps: number; deadline: bigint; hype: boolean }): PositionTx {
  const { position: p } = a;
  if (!Number.isInteger(a.pct) || a.pct < 1 || a.pct > 100) throw new Error('percent out of range');
  const position = new Position({ pool: sdkPool(p.pool), liquidity: p.liquidity.toString(), tickLower: p.tickLower, tickUpper: p.tickUpper });
  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(position, {
    tokenId: p.tokenId.toString(),
    liquidityPercentage: new Percent(a.pct, 100),
    slippageTolerance: percent(a.slippageBps),
    deadline: a.deadline.toString(),
    burnToken: false,
    collectOptions: {
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(payoutCurrency(p.pool.token0, a.hype), (p.owed0 ?? 0n).toString()),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(payoutCurrency(p.pool.token1, a.hype), (p.owed1 ?? 0n).toString()),
      recipient: a.recipient,
    },
  });
  return { to: a.venue.positionManager, data: calldata as `0x${string}`, value: BigInt(value) };
}
