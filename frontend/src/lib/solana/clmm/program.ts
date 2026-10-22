import { PublicKey } from '@solana/web3.js';
import { PLACEHOLDER_PROGRAM_ADDRESS, RANGE_PROGRAM_ADDRESS } from './programId';

/**
 * The range-pool program: identity, PDAs, account layouts and decoders.
 *
 * WHAT THIS PROGRAM IS: the venue's own copy of Raydium's concentrated-liquidity program
 * (Apache-2.0) at ed1eb415, in solana/tegridy-clmm, with every role held by the venue's
 * Squads vault (docs/RANGE_POOLS_PLAN.md). Only identity changed, so every layout, seed and
 * discriminator below is the program's own, encoded BY HAND from its source and re-derived
 * from that source by program.test.ts. Raydium's SDK is GPL-3.0 and is never used here.
 *
 * There is no React here and there must not be.
 */

/* ─────────────────────────────── identity ───────────────────────────────── */

/**
 * The id the program source declared before the deploy: nobody holds its key and no release
 * build accepts it, so nothing can ever run there.
 */
export const PLACEHOLDER_PROGRAM_ID = new PublicKey(PLACEHOLDER_PROGRAM_ADDRESS);

/**
 * Every range-pool read and write goes through this key, made from the one constant in
 * programId.ts: the program deployed 2026-10-21 and held by the vault. program.test.ts holds
 * it equal to the source's declare_id!.
 */
export const RANGE_PROGRAM_ID: PublicKey = new PublicKey(RANGE_PROGRAM_ADDRESS);

/** True once RANGE_PROGRAM_ID names a real program. Not proof it is deployed: reads ask the chain. */
export function rangeProgramNamed(programId: PublicKey = RANGE_PROGRAM_ID): boolean {
  return !programId.equals(PLACEHOLDER_PROGRAM_ID);
}

/* ──────────────────────────────── seeds ─────────────────────────────────── */

const enc = new TextEncoder();
export const AMM_CONFIG_SEED = enc.encode('amm_config');
export const POOL_SEED = enc.encode('pool');
export const POOL_VAULT_SEED = enc.encode('pool_vault');
export const POOL_REWARD_VAULT_SEED = enc.encode('pool_reward_vault');
export const POOL_TICK_ARRAY_BITMAP_SEED = enc.encode('pool_tick_array_bitmap_extension');
export const OBSERVATION_SEED = enc.encode('observation');
export const TICK_ARRAY_SEED = enc.encode('tick_array');
export const POSITION_SEED = enc.encode('position');

/* ───────────────────────────────── PDAs ─────────────────────────────────── */

function derive(programId: PublicKey, seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function i32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}

/** `[AMM_CONFIG_SEED, index.to_be_bytes()]`: a fee tier. Big-endian u16. */
export function deriveAmmConfig(programId: PublicKey, index: number): PublicKey {
  const be = new Uint8Array(2);
  new DataView(be.buffer).setUint16(0, index, false);
  return derive(programId, [AMM_CONFIG_SEED, be]);
}

/**
 * `[POOL_SEED, amm_config, token_mint_0, token_mint_1]`. create_pool carries
 * `token_mint_0.key() < token_mint_1.key()`: pass the mints through `sortMints`.
 */
export function derivePool(programId: PublicKey, ammConfig: PublicKey, mint0: PublicKey, mint1: PublicKey): PublicKey {
  return derive(programId, [POOL_SEED, ammConfig.toBytes(), mint0.toBytes(), mint1.toBytes()]);
}

export function deriveVault(programId: PublicKey, pool: PublicKey, mint: PublicKey): PublicKey {
  return derive(programId, [POOL_VAULT_SEED, pool.toBytes(), mint.toBytes()]);
}

export function deriveObservation(programId: PublicKey, pool: PublicKey): PublicKey {
  return derive(programId, [OBSERVATION_SEED, pool.toBytes()]);
}

export function deriveBitmapExtension(programId: PublicKey, pool: PublicKey): PublicKey {
  return derive(programId, [POOL_TICK_ARRAY_BITMAP_SEED, pool.toBytes()]);
}

/** `[TICK_ARRAY_SEED, pool, start_tick_index.to_be_bytes()]`: a big-endian i32. */
export function deriveTickArray(programId: PublicKey, pool: PublicKey, startTickIndex: number): PublicKey {
  return derive(programId, [TICK_ARRAY_SEED, pool.toBytes(), i32be(startTickIndex)]);
}

/** `[POSITION_SEED, nft_mint]`: a position's record, and the `<id>` in its NFT's link. */
export function derivePersonalPosition(programId: PublicKey, nftMint: PublicKey): PublicKey {
  return derive(programId, [POSITION_SEED, nftMint.toBytes()]);
}

/**
 * `[POSITION_SEED, pool, tick_lower.to_be_bytes(), tick_upper.to_be_bytes()]`. The
 * instructions still take a `protocol_position` slot the program no longer checks
 * ("Deprecated ... kept for compatibility"); this is the address it used to be.
 */
export function deriveProtocolPosition(programId: PublicKey, pool: PublicKey, tickLower: number, tickUpper: number): PublicKey {
  return derive(programId, [POSITION_SEED, pool.toBytes(), i32be(tickLower), i32be(tickUpper)]);
}

/** The program's mint order: raw bytes, as Rust's `Pubkey` `Ord`. */
export { sortMints } from '../cpswap/program';

/* ─────────────────────────── discriminators ─────────────────────────────── */

// Anchor: the first 8 bytes of sha256("global:<name>") and sha256("account:<Name>").
// program.test.ts re-hashes each, so a rename upstream fails there.
export const IX_CREATE_POOL = Uint8Array.from([233, 146, 209, 142, 207, 104, 64, 188]);
export const IX_OPEN_POSITION_WITH_TOKEN22_NFT = Uint8Array.from([77, 255, 174, 82, 125, 29, 201, 46]);
export const IX_INCREASE_LIQUIDITY_V2 = Uint8Array.from([133, 29, 89, 223, 69, 238, 176, 10]);
export const IX_DECREASE_LIQUIDITY_V2 = Uint8Array.from([58, 127, 188, 62, 79, 82, 196, 96]);
export const IX_CLOSE_POSITION = Uint8Array.from([123, 134, 81, 0, 49, 68, 98, 98]);
export const IX_SWAP_V2 = Uint8Array.from([43, 4, 237, 11, 26, 201, 30, 98]);

export const ACCOUNT_AMM_CONFIG = Uint8Array.from([218, 244, 33, 104, 203, 203, 43, 111]);
export const ACCOUNT_POOL_STATE = Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]);
export const ACCOUNT_TICK_ARRAY_STATE = Uint8Array.from([192, 155, 85, 205, 49, 249, 129, 42]);
export const ACCOUNT_PERSONAL_POSITION_STATE = Uint8Array.from([70, 111, 150, 126, 230, 15, 25, 117]);
export const ACCOUNT_OBSERVATION_STATE = Uint8Array.from([122, 174, 197, 53, 129, 9, 165, 132]);
export const ACCOUNT_TICK_ARRAY_BITMAP_EXTENSION = Uint8Array.from([60, 150, 36, 219, 97, 128, 139, 153]);

/* ──────────────────────────────── layouts ───────────────────────────────── */

// Every struct is either Borsh (`#[account]`) or `#[repr(C, packed)]` zero-copy: both
// sequential with no padding, so an offset is the sum of the widths before it.
// program.test.ts recomputes each table below from the Rust struct definitions.

/** `AmmConfig`: a fee tier. Borsh. */
export const AMM_CONFIG_OFFSETS = {
  bump: 8,
  index: 9,
  owner: 11,
  protocolFeeRate: 43,
  tradeFeeRate: 47,
  tickSpacing: 51,
  fundFeeRate: 53,
  paddingU32: 57,
  fundOwner: 61,
  padding: 93,
} as const;
export const AMM_CONFIG_LEN = 117;

/** `RewardInfo`, three of them inside PoolState. */
export const REWARD_INFO_OFFSETS = {
  rewardState: 0,
  openTime: 1,
  endTime: 9,
  lastUpdateTime: 17,
  emissionsPerSecondX64: 25,
  rewardTotalEmitted: 41,
  rewardClaimed: 49,
  tokenMint: 57,
  tokenVault: 89,
  authority: 121,
  rewardGrowthGlobalX64: 153,
} as const;
export const REWARD_INFO_LEN = 169;
export const REWARD_NUM = 3;

/** `DynamicFeeInfo`, inside PoolState. All zero = no dynamic fee on this pool. */
export const DYNAMIC_FEE_INFO_OFFSETS = {
  filterPeriod: 0,
  decayPeriod: 2,
  reductionFactor: 4,
  dynamicFeeControl: 6,
  maxVolatilityAccumulator: 10,
  tickSpacingIndexReference: 14,
  volatilityReference: 18,
  volatilityAccumulator: 22,
  lastUpdateTimestamp: 26,
  padding: 34,
} as const;
export const DYNAMIC_FEE_INFO_LEN = 80;

/** `PoolState`: zero-copy, `#[repr(C, packed)]`. */
export const POOL_STATE_OFFSETS = {
  bump: 8,
  ammConfig: 9,
  owner: 41,
  tokenMint0: 73,
  tokenMint1: 105,
  tokenVault0: 137,
  tokenVault1: 169,
  observationKey: 201,
  mintDecimals0: 233,
  mintDecimals1: 234,
  tickSpacing: 235,
  liquidity: 237,
  sqrtPriceX64: 253,
  tickCurrent: 269,
  padding3: 273,
  padding4: 275,
  feeGrowthGlobal0X64: 277,
  feeGrowthGlobal1X64: 293,
  protocolFeesToken0: 309,
  protocolFeesToken1: 317,
  padding5: 325,
  status: 389,
  feeOn: 390,
  seedIndex: 391,
  padding: 393,
  rewardInfos: 397,
  tickArrayBitmap: 904,
  padding6: 1032,
  fundFeesToken0: 1064,
  fundFeesToken1: 1072,
  openTime: 1080,
  recentEpoch: 1088,
  dynamicFeeInfo: 1096,
  padding1: 1176,
  padding2: 1288,
} as const;
export const POOL_STATE_LEN = 1544;

/** `TickState`, sixty of them inside a TickArrayState. */
export const TICK_STATE_OFFSETS = {
  tick: 0,
  liquidityNet: 4,
  liquidityGross: 20,
  feeGrowthOutside0X64: 36,
  feeGrowthOutside1X64: 52,
  rewardGrowthsOutsideX64: 68,
  orderPhase: 116,
  ordersAmount: 124,
  partFilledOrdersRemaining: 132,
  unfilledRatioX64: 140,
  padding: 156,
} as const;
export const TICK_STATE_LEN = 168;
export const TICK_ARRAY_SIZE = 60;

/** `TickArrayState`: zero-copy, packed. A band of 60 usable prices. */
export const TICK_ARRAY_STATE_OFFSETS = {
  poolId: 8,
  startTickIndex: 40,
  ticks: 44,
  initializedTickCount: 10124,
  recentEpoch: 10125,
  padding: 10133,
} as const;
export const TICK_ARRAY_STATE_LEN = 10240;

/** `PositionRewardInfo`, three of them inside a position. */
export const POSITION_REWARD_INFO_OFFSETS = { growthInsideLastX64: 0, rewardAmountOwed: 16 } as const;
export const POSITION_REWARD_INFO_LEN = 24;

/** `PersonalPositionState`: one LP's position. Borsh. */
export const PERSONAL_POSITION_OFFSETS = {
  bump: 8,
  nftMint: 9,
  poolId: 41,
  tickLowerIndex: 73,
  tickUpperIndex: 77,
  liquidity: 81,
  feeGrowthInside0LastX64: 97,
  feeGrowthInside1LastX64: 113,
  tokenFeesOwed0: 129,
  tokenFeesOwed1: 137,
  rewardInfos: 145,
  recentEpoch: 217,
  padding: 225,
} as const;
export const PERSONAL_POSITION_LEN = 281;

/** `Observation`, a hundred of them inside an ObservationState. */
export const OBSERVATION_OFFSETS = { blockTimestamp: 0, tickCumulative: 4, padding: 12 } as const;
export const OBSERVATION_LEN = 44;
export const OBSERVATION_NUM = 100;

/** `ObservationState`: a pool's price history. Zero-copy, packed. */
export const OBSERVATION_STATE_OFFSETS = {
  initialized: 8,
  recentEpoch: 9,
  observationIndex: 17,
  poolId: 19,
  observations: 51,
  padding: 4451,
} as const;
export const OBSERVATION_STATE_LEN = 4483;

/** `TickArrayBitmapExtension`: which bands exist beyond the pool's own bitmap. Zero-copy, packed. */
export const BITMAP_EXTENSION_OFFSETS = {
  poolId: 8,
  positiveTickArrayBitmap: 40,
  negativeTickArrayBitmap: 936,
} as const;
export const BITMAP_EXTENSION_LEN = 1832;
export const EXTENSION_TICKARRAY_BITMAP_SIZE = 14;

/**
 * Pool status bits, `PoolStatusBitIndex`. A set bit DISABLES the action:
 * 0 open position or add, 1 remove, 2 collect fees, 3 collect rewards, 4 swap, 5 limit orders.
 */
export const POOL_STATUS_BIT = {
  openPositionOrIncreaseLiquidity: 0,
  decreaseLiquidity: 1,
  collectFee: 2,
  collectReward: 3,
  swap: 4,
  limitOrder: 5,
} as const;

/** `fee_on`: which coin a swap's fee is taken in. 0 = the coin paid in. */
export const FEE_ON_FROM_INPUT = 0;
export const FEE_ON_TOKEN_0_ONLY = 1;
export const FEE_ON_TOKEN_1_ONLY = 2;

/* ──────────────────────────────── decoders ──────────────────────────────── */

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u8At = (d: Uint8Array, o: number) => d[o]!;
const u16At = (d: Uint8Array, o: number) => view(d).getUint16(o, true);
const u32At = (d: Uint8Array, o: number) => view(d).getUint32(o, true);
const i32At = (d: Uint8Array, o: number) => view(d).getInt32(o, true);
const u64At = (d: Uint8Array, o: number) => view(d).getBigUint64(o, true);
const i64At = (d: Uint8Array, o: number) => view(d).getBigInt64(o, true);
const u128At = (d: Uint8Array, o: number) => u64At(d, o) | (u64At(d, o + 8) << 64n);
const i128At = (d: Uint8Array, o: number) => BigInt.asIntN(128, u128At(d, o));
const pkAt = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
const DEFAULT_PUBKEY = PublicKey.default.toBase58();

function discriminatorMatches(d: Uint8Array, want: Uint8Array): boolean {
  if (d.length < 8) return false;
  for (let i = 0; i < 8; i++) if (d[i] !== want[i]) return false;
  return true;
}

/** Bytes that are exactly one account of this kind: the right discriminator and size. */
function isAccount(d: Uint8Array, disc: Uint8Array, len: number): boolean {
  return d.length === len && discriminatorMatches(d, disc);
}

export interface AmmConfigView {
  address: string;
  index: number;
  owner: string;
  /** Per million of each swap. */
  tradeFeeRate: number;
  /** Per million OF THE TRADE FEE, to the protocol-fee owner. */
  protocolFeeRate: number;
  /** Per million OF THE TRADE FEE, to the fund-fee owner. */
  fundFeeRate: number;
  tickSpacing: number;
  fundOwner: string;
}

/** Decode a fee tier, or null if the bytes are not one. Never throws. */
export function decodeAmmConfig(address: string, data: Uint8Array): AmmConfigView | null {
  try {
    if (!isAccount(data, ACCOUNT_AMM_CONFIG, AMM_CONFIG_LEN)) return null;
    const o = AMM_CONFIG_OFFSETS;
    return {
      address,
      index: u16At(data, o.index),
      owner: pkAt(data, o.owner),
      tradeFeeRate: u32At(data, o.tradeFeeRate),
      protocolFeeRate: u32At(data, o.protocolFeeRate),
      fundFeeRate: u32At(data, o.fundFeeRate),
      tickSpacing: u16At(data, o.tickSpacing),
      fundOwner: pkAt(data, o.fundOwner),
    };
  } catch {
    return null;
  }
}

export interface RewardInfoView {
  rewardState: number;
  openTime: bigint;
  endTime: bigint;
  lastUpdateTime: bigint;
  emissionsPerSecondX64: bigint;
  rewardTotalEmitted: bigint;
  rewardClaimed: bigint;
  tokenMint: string;
  tokenVault: string;
  authority: string;
  rewardGrowthGlobalX64: bigint;
  /** `RewardInfo::initialized`: a reward mint is set. */
  initialized: boolean;
}

function decodeRewardInfo(d: Uint8Array, at: number): RewardInfoView {
  const o = REWARD_INFO_OFFSETS;
  const tokenMint = pkAt(d, at + o.tokenMint);
  return {
    rewardState: u8At(d, at + o.rewardState),
    openTime: u64At(d, at + o.openTime),
    endTime: u64At(d, at + o.endTime),
    lastUpdateTime: u64At(d, at + o.lastUpdateTime),
    emissionsPerSecondX64: u128At(d, at + o.emissionsPerSecondX64),
    rewardTotalEmitted: u64At(d, at + o.rewardTotalEmitted),
    rewardClaimed: u64At(d, at + o.rewardClaimed),
    tokenMint,
    tokenVault: pkAt(d, at + o.tokenVault),
    authority: pkAt(d, at + o.authority),
    rewardGrowthGlobalX64: u128At(d, at + o.rewardGrowthGlobalX64),
    initialized: tokenMint !== DEFAULT_PUBKEY,
  };
}

export interface DynamicFeeInfoView {
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  dynamicFeeControl: number;
  maxVolatilityAccumulator: number;
  tickSpacingIndexReference: number;
  volatilityReference: number;
  volatilityAccumulator: number;
  lastUpdateTimestamp: bigint;
}

export interface PoolStateView {
  address: string;
  ammConfig: string;
  owner: string;
  tokenMint0: string;
  tokenMint1: string;
  tokenVault0: string;
  tokenVault1: string;
  observationKey: string;
  mintDecimals0: number;
  mintDecimals1: number;
  tickSpacing: number;
  /** The liquidity in use at the current price. */
  liquidity: bigint;
  /** sqrt(token_1 / token_0) in raw units, Q64.64. */
  sqrtPriceX64: bigint;
  tickCurrent: number;
  feeGrowthGlobal0X64: bigint;
  feeGrowthGlobal1X64: bigint;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  status: number;
  feeOn: number;
  /** Little-endian u16; 0 = a pool at the standard address. */
  seedIndex: number;
  rewardInfos: RewardInfoView[];
  /** The 1024-bit map of which bands hold a used price, word 0 first. */
  tickArrayBitmap: bigint[];
  openTime: bigint;
  recentEpoch: bigint;
  /** null when every field is zero, which is how the program reads "no dynamic fee". */
  dynamicFeeInfo: DynamicFeeInfoView | null;
}

/** Decode a pool, or null if the bytes are not one. Never throws. */
export function decodePoolState(address: string, data: Uint8Array): PoolStateView | null {
  try {
    if (!isAccount(data, ACCOUNT_POOL_STATE, POOL_STATE_LEN)) return null;
    const o = POOL_STATE_OFFSETS;
    const rewardInfos: RewardInfoView[] = [];
    for (let i = 0; i < REWARD_NUM; i++) rewardInfos.push(decodeRewardInfo(data, o.rewardInfos + i * REWARD_INFO_LEN));
    const tickArrayBitmap: bigint[] = [];
    for (let i = 0; i < 16; i++) tickArrayBitmap.push(u64At(data, o.tickArrayBitmap + i * 8));
    // `get_dynamic_fee_info`: `None` when the struct equals Default, padding included.
    const dyn = data.subarray(o.dynamicFeeInfo, o.dynamicFeeInfo + DYNAMIC_FEE_INFO_LEN);
    const df = DYNAMIC_FEE_INFO_OFFSETS;
    const dynamicFeeInfo = dyn.every((b) => b === 0)
      ? null
      : {
          filterPeriod: u16At(dyn, df.filterPeriod),
          decayPeriod: u16At(dyn, df.decayPeriod),
          reductionFactor: u16At(dyn, df.reductionFactor),
          dynamicFeeControl: u32At(dyn, df.dynamicFeeControl),
          maxVolatilityAccumulator: u32At(dyn, df.maxVolatilityAccumulator),
          tickSpacingIndexReference: i32At(dyn, df.tickSpacingIndexReference),
          volatilityReference: u32At(dyn, df.volatilityReference),
          volatilityAccumulator: u32At(dyn, df.volatilityAccumulator),
          lastUpdateTimestamp: u64At(dyn, df.lastUpdateTimestamp),
        };
    return {
      address,
      ammConfig: pkAt(data, o.ammConfig),
      owner: pkAt(data, o.owner),
      tokenMint0: pkAt(data, o.tokenMint0),
      tokenMint1: pkAt(data, o.tokenMint1),
      tokenVault0: pkAt(data, o.tokenVault0),
      tokenVault1: pkAt(data, o.tokenVault1),
      observationKey: pkAt(data, o.observationKey),
      mintDecimals0: u8At(data, o.mintDecimals0),
      mintDecimals1: u8At(data, o.mintDecimals1),
      tickSpacing: u16At(data, o.tickSpacing),
      liquidity: u128At(data, o.liquidity),
      sqrtPriceX64: u128At(data, o.sqrtPriceX64),
      tickCurrent: i32At(data, o.tickCurrent),
      feeGrowthGlobal0X64: u128At(data, o.feeGrowthGlobal0X64),
      feeGrowthGlobal1X64: u128At(data, o.feeGrowthGlobal1X64),
      protocolFeesToken0: u64At(data, o.protocolFeesToken0),
      protocolFeesToken1: u64At(data, o.protocolFeesToken1),
      fundFeesToken0: u64At(data, o.fundFeesToken0),
      fundFeesToken1: u64At(data, o.fundFeesToken1),
      status: u8At(data, o.status),
      feeOn: u8At(data, o.feeOn),
      seedIndex: u16At(data, o.seedIndex),
      rewardInfos,
      tickArrayBitmap,
      openTime: u64At(data, o.openTime),
      recentEpoch: u64At(data, o.recentEpoch),
      dynamicFeeInfo,
    };
  } catch {
    return null;
  }
}

export interface TickStateView {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  feeGrowthOutside0X64: bigint;
  feeGrowthOutside1X64: bigint;
  rewardGrowthsOutsideX64: bigint[];
  orderPhase: bigint;
  ordersAmount: bigint;
  partFilledOrdersRemaining: bigint;
  unfilledRatioX64: bigint;
}

function decodeTickState(d: Uint8Array, at: number): TickStateView {
  const o = TICK_STATE_OFFSETS;
  const rewards: bigint[] = [];
  for (let i = 0; i < REWARD_NUM; i++) rewards.push(u128At(d, at + o.rewardGrowthsOutsideX64 + i * 16));
  return {
    tick: i32At(d, at + o.tick),
    liquidityNet: i128At(d, at + o.liquidityNet),
    liquidityGross: u128At(d, at + o.liquidityGross),
    feeGrowthOutside0X64: u128At(d, at + o.feeGrowthOutside0X64),
    feeGrowthOutside1X64: u128At(d, at + o.feeGrowthOutside1X64),
    rewardGrowthsOutsideX64: rewards,
    orderPhase: u64At(d, at + o.orderPhase),
    ordersAmount: u64At(d, at + o.ordersAmount),
    partFilledOrdersRemaining: u64At(d, at + o.partFilledOrdersRemaining),
    unfilledRatioX64: u128At(d, at + o.unfilledRatioX64),
  };
}

/** `TickState::has_liquidity`. */
export const tickHasLiquidity = (t: Pick<TickStateView, 'liquidityGross'>) => t.liquidityGross > 0n;
/** `TickState::has_limit_orders`. */
export const tickHasLimitOrders = (t: Pick<TickStateView, 'ordersAmount' | 'partFilledOrdersRemaining'>) =>
  t.ordersAmount > 0n || t.partFilledOrdersRemaining > 0n;
/** `TickState::is_initialized`: a price a swap stops at. */
export const tickIsInitialized = (t: TickStateView) => tickHasLiquidity(t) || tickHasLimitOrders(t);

export interface TickArrayView {
  address: string;
  poolId: string;
  startTickIndex: number;
  ticks: TickStateView[];
  initializedTickCount: number;
}

/** Decode a band of prices, or null if the bytes are not one. Never throws. */
export function decodeTickArray(address: string, data: Uint8Array): TickArrayView | null {
  try {
    if (!isAccount(data, ACCOUNT_TICK_ARRAY_STATE, TICK_ARRAY_STATE_LEN)) return null;
    const o = TICK_ARRAY_STATE_OFFSETS;
    const ticks: TickStateView[] = [];
    for (let i = 0; i < TICK_ARRAY_SIZE; i++) ticks.push(decodeTickState(data, o.ticks + i * TICK_STATE_LEN));
    return {
      address,
      poolId: pkAt(data, o.poolId),
      startTickIndex: i32At(data, o.startTickIndex),
      ticks,
      initializedTickCount: u8At(data, o.initializedTickCount),
    };
  } catch {
    return null;
  }
}

export interface PersonalPositionView {
  address: string;
  nftMint: string;
  poolId: string;
  tickLowerIndex: number;
  tickUpperIndex: number;
  liquidity: bigint;
  feeGrowthInside0LastX64: bigint;
  feeGrowthInside1LastX64: bigint;
  /** Fees owed as of the position's last update; more may have built up since. */
  tokenFeesOwed0: bigint;
  tokenFeesOwed1: bigint;
  rewardInfos: { growthInsideLastX64: bigint; rewardAmountOwed: bigint }[];
  recentEpoch: bigint;
}

/** Decode a position, or null if the bytes are not one. Never throws. */
export function decodePersonalPosition(address: string, data: Uint8Array): PersonalPositionView | null {
  try {
    if (!isAccount(data, ACCOUNT_PERSONAL_POSITION_STATE, PERSONAL_POSITION_LEN)) return null;
    const o = PERSONAL_POSITION_OFFSETS;
    const r = POSITION_REWARD_INFO_OFFSETS;
    const rewardInfos = [];
    for (let i = 0; i < REWARD_NUM; i++) {
      const at = o.rewardInfos + i * POSITION_REWARD_INFO_LEN;
      rewardInfos.push({ growthInsideLastX64: u128At(data, at + r.growthInsideLastX64), rewardAmountOwed: u64At(data, at + r.rewardAmountOwed) });
    }
    return {
      address,
      nftMint: pkAt(data, o.nftMint),
      poolId: pkAt(data, o.poolId),
      tickLowerIndex: i32At(data, o.tickLowerIndex),
      tickUpperIndex: i32At(data, o.tickUpperIndex),
      liquidity: u128At(data, o.liquidity),
      feeGrowthInside0LastX64: u128At(data, o.feeGrowthInside0LastX64),
      feeGrowthInside1LastX64: u128At(data, o.feeGrowthInside1LastX64),
      tokenFeesOwed0: u64At(data, o.tokenFeesOwed0),
      tokenFeesOwed1: u64At(data, o.tokenFeesOwed1),
      rewardInfos,
      recentEpoch: u64At(data, o.recentEpoch),
    };
  } catch {
    return null;
  }
}

export interface ObservationStateView {
  address: string;
  initialized: boolean;
  observationIndex: number;
  poolId: string;
  observations: { blockTimestamp: number; tickCumulative: bigint }[];
}

/** Decode a pool's price history, or null if the bytes are not one. Never throws. */
export function decodeObservationState(address: string, data: Uint8Array): ObservationStateView | null {
  try {
    if (!isAccount(data, ACCOUNT_OBSERVATION_STATE, OBSERVATION_STATE_LEN)) return null;
    const o = OBSERVATION_STATE_OFFSETS;
    const observations = [];
    for (let i = 0; i < OBSERVATION_NUM; i++) {
      const at = o.observations + i * OBSERVATION_LEN;
      observations.push({ blockTimestamp: u32At(data, at + OBSERVATION_OFFSETS.blockTimestamp), tickCumulative: i64At(data, at + OBSERVATION_OFFSETS.tickCumulative) });
    }
    return {
      address,
      initialized: u8At(data, o.initialized) !== 0,
      observationIndex: u16At(data, o.observationIndex),
      poolId: pkAt(data, o.poolId),
      observations,
    };
  } catch {
    return null;
  }
}

export interface BitmapExtensionView {
  address: string;
  poolId: string;
  /** 14 maps of 512 bits each, as 8 little-endian words. */
  positiveTickArrayBitmap: bigint[][];
  negativeTickArrayBitmap: bigint[][];
}

/** Decode a pool's far-band map, or null if the bytes are not one. Never throws. */
export function decodeBitmapExtension(address: string, data: Uint8Array): BitmapExtensionView | null {
  try {
    if (!isAccount(data, ACCOUNT_TICK_ARRAY_BITMAP_EXTENSION, BITMAP_EXTENSION_LEN)) return null;
    const o = BITMAP_EXTENSION_OFFSETS;
    const maps = (start: number) => {
      const out: bigint[][] = [];
      for (let i = 0; i < EXTENSION_TICKARRAY_BITMAP_SIZE; i++) {
        const words: bigint[] = [];
        for (let w = 0; w < 8; w++) words.push(u64At(data, start + (i * 8 + w) * 8));
        out.push(words);
      }
      return out;
    };
    return {
      address,
      poolId: pkAt(data, o.poolId),
      positiveTickArrayBitmap: maps(o.positiveTickArrayBitmap),
      negativeTickArrayBitmap: maps(o.negativeTickArrayBitmap),
    };
  } catch {
    return null;
  }
}

/* ──────────────────────────────── flags ─────────────────────────────────── */

/** `get_status_by_bit`: true when the action is allowed. */
export function poolAllows(pool: Pick<PoolStateView, 'status'>, bit: number): boolean {
  return (pool.status & (1 << bit)) === 0;
}

/** `is_fee_on_input`: the swap fee is taken in the coin paid in. */
export function isFeeOnInput(feeOn: number, zeroForOne: boolean): boolean {
  if (feeOn === FEE_ON_TOKEN_0_ONLY) return zeroForOne;
  if (feeOn === FEE_ON_TOKEN_1_ONLY) return !zeroForOne;
  return true;
}

/** `is_fee_on_token0`: the swap fee is counted in token 0. */
export function isFeeOnToken0(feeOn: number, zeroForOne: boolean): boolean {
  if (feeOn === FEE_ON_TOKEN_0_ONLY) return true;
  if (feeOn === FEE_ON_TOKEN_1_ONLY) return false;
  return zeroForOne;
}
