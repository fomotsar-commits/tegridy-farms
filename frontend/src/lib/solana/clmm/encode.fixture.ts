// Test-only: range-program accounts as bytes, written at the offsets program.ts decodes
// (which program.test.ts holds to the program's own structs). Each encoder writes what the
// tests set and leaves the rest zero, as a freshly made account of the program would.
import { PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_AMM_CONFIG,
  ACCOUNT_PERSONAL_POSITION_STATE,
  ACCOUNT_POOL_STATE,
  ACCOUNT_TICK_ARRAY_STATE,
  AMM_CONFIG_LEN,
  AMM_CONFIG_OFFSETS,
  PERSONAL_POSITION_LEN,
  PERSONAL_POSITION_OFFSETS,
  POOL_STATE_LEN,
  POOL_STATE_OFFSETS,
  POSITION_REWARD_INFO_LEN,
  POSITION_REWARD_INFO_OFFSETS,
  REWARD_INFO_LEN,
  REWARD_INFO_OFFSETS,
  TICK_ARRAY_SIZE,
  TICK_ARRAY_STATE_LEN,
  TICK_ARRAY_STATE_OFFSETS,
  TICK_STATE_LEN,
  TICK_STATE_OFFSETS,
} from './program';

class W {
  readonly d: Uint8Array;
  private v: DataView;
  constructor(len: number, disc: Uint8Array) {
    this.d = new Uint8Array(len);
    this.d.set(disc, 0);
    this.v = new DataView(this.d.buffer);
  }
  u8(o: number, x: number) { this.d[o] = x; }
  u16(o: number, x: number) { this.v.setUint16(o, x, true); }
  u32(o: number, x: number) { this.v.setUint32(o, x, true); }
  i32(o: number, x: number) { this.v.setInt32(o, x, true); }
  u64(o: number, x: bigint) { this.v.setBigUint64(o, BigInt.asUintN(64, x), true); }
  u128(o: number, x: bigint) {
    const u = BigInt.asUintN(128, x);
    this.u64(o, u & ((1n << 64n) - 1n));
    this.u64(o + 8, u >> 64n);
  }
  key(o: number, k: PublicKey | string) { this.d.set((typeof k === 'string' ? new PublicKey(k) : k).toBytes(), o); }
}

export function encodeAmmConfig(c: { index: number; tradeFeeRate: number; protocolFeeRate: number; fundFeeRate: number; tickSpacing: number; owner?: PublicKey; fundOwner?: PublicKey }): Uint8Array {
  const w = new W(AMM_CONFIG_LEN, ACCOUNT_AMM_CONFIG);
  const o = AMM_CONFIG_OFFSETS;
  w.u16(o.index, c.index);
  if (c.owner) w.key(o.owner, c.owner);
  w.u32(o.tradeFeeRate, c.tradeFeeRate);
  w.u32(o.protocolFeeRate, c.protocolFeeRate);
  w.u32(o.fundFeeRate, c.fundFeeRate);
  w.u16(o.tickSpacing, c.tickSpacing);
  if (c.fundOwner) w.key(o.fundOwner, c.fundOwner);
  return w.d;
}

export interface PoolFields {
  ammConfig: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  observation: PublicKey;
  decimals0: number;
  decimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  status?: number;
  feeOn?: number;
  feeGrowth0?: bigint;
  feeGrowth1?: bigint;
  /** Set bits of the 1024-bit band map. */
  bitmapBits?: number[];
  rewards?: RewardFields[];
}

/** One reward slot of a pool. Unset counters are zero, as `initialize_reward` leaves them. */
export interface RewardFields {
  mint: PublicKey;
  vault: PublicKey;
  state?: number;
  openTime?: bigint;
  endTime?: bigint;
  lastUpdateTime?: bigint;
  emissionsPerSecondX64?: bigint;
  totalEmitted?: bigint;
  claimed?: bigint;
  authority?: PublicKey;
  growthGlobalX64?: bigint;
}

export function encodePool(p: PoolFields): Uint8Array {
  const w = new W(POOL_STATE_LEN, ACCOUNT_POOL_STATE);
  const o = POOL_STATE_OFFSETS;
  w.key(o.ammConfig, p.ammConfig);
  w.key(o.tokenMint0, p.mint0);
  w.key(o.tokenMint1, p.mint1);
  w.key(o.tokenVault0, p.vault0);
  w.key(o.tokenVault1, p.vault1);
  w.key(o.observationKey, p.observation);
  w.u8(o.mintDecimals0, p.decimals0);
  w.u8(o.mintDecimals1, p.decimals1);
  w.u16(o.tickSpacing, p.tickSpacing);
  w.u128(o.liquidity, p.liquidity);
  w.u128(o.sqrtPriceX64, p.sqrtPriceX64);
  w.i32(o.tickCurrent, p.tickCurrent);
  w.u128(o.feeGrowthGlobal0X64, p.feeGrowth0 ?? 0n);
  w.u128(o.feeGrowthGlobal1X64, p.feeGrowth1 ?? 0n);
  w.u8(o.status, p.status ?? 0);
  w.u8(o.feeOn, p.feeOn ?? 0);
  (p.rewards ?? []).forEach((r, i) => {
    const at = o.rewardInfos + i * REWARD_INFO_LEN;
    const ro = REWARD_INFO_OFFSETS;
    w.key(at + ro.tokenMint, r.mint);
    w.key(at + ro.tokenVault, r.vault);
    w.u8(at + ro.rewardState, r.state ?? 0);
    w.u64(at + ro.openTime, r.openTime ?? 0n);
    w.u64(at + ro.endTime, r.endTime ?? 0n);
    w.u64(at + ro.lastUpdateTime, r.lastUpdateTime ?? 0n);
    w.u128(at + ro.emissionsPerSecondX64, r.emissionsPerSecondX64 ?? 0n);
    w.u64(at + ro.rewardTotalEmitted, r.totalEmitted ?? 0n);
    w.u64(at + ro.rewardClaimed, r.claimed ?? 0n);
    if (r.authority) w.key(at + ro.authority, r.authority);
    w.u128(at + ro.rewardGrowthGlobalX64, r.growthGlobalX64 ?? 0n);
  });
  for (const bit of p.bitmapBits ?? []) w.d[o.tickArrayBitmap + (bit >> 3)]! |= 1 << (bit & 7);
  return w.d;
}

export interface TickFields {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  feeGrowthOutside0?: bigint;
  feeGrowthOutside1?: bigint;
  rewardGrowthsOutside?: bigint[];
  ordersAmount?: bigint;
}

export function encodeTickArray(pool: PublicKey, start: number, spacing: number, ticks: TickFields[]): Uint8Array {
  const w = new W(TICK_ARRAY_STATE_LEN, ACCOUNT_TICK_ARRAY_STATE);
  const o = TICK_ARRAY_STATE_OFFSETS;
  w.key(o.poolId, pool);
  w.i32(o.startTickIndex, start);
  let used = 0;
  for (const t of ticks) {
    const i = (t.tick - start) / spacing;
    if (!Number.isInteger(i) || i < 0 || i >= TICK_ARRAY_SIZE) throw new Error(`tick ${t.tick} is not in band ${start}`);
    const at = o.ticks + i * TICK_STATE_LEN;
    const s = TICK_STATE_OFFSETS;
    w.i32(at + s.tick, t.tick);
    w.u128(at + s.liquidityNet, t.liquidityNet);
    w.u128(at + s.liquidityGross, t.liquidityGross);
    w.u128(at + s.feeGrowthOutside0X64, t.feeGrowthOutside0 ?? 0n);
    w.u128(at + s.feeGrowthOutside1X64, t.feeGrowthOutside1 ?? 0n);
    (t.rewardGrowthsOutside ?? []).forEach((g, j) => w.u128(at + s.rewardGrowthsOutsideX64 + j * 16, g));
    w.u64(at + s.ordersAmount, t.ordersAmount ?? 0n);
    if (t.liquidityGross > 0n || (t.ordersAmount ?? 0n) > 0n) used++;
  }
  w.u8(o.initializedTickCount, used);
  return w.d;
}

export function encodePosition(p: {
  nftMint: PublicKey;
  pool: PublicKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0Last?: bigint;
  feeGrowthInside1Last?: bigint;
  feesOwed0?: bigint;
  feesOwed1?: bigint;
  /** Per reward slot: growth inside as of its last change, and what it was owed then. */
  rewards?: { growthInsideLast?: bigint; owed?: bigint }[];
}): Uint8Array {
  const w = new W(PERSONAL_POSITION_LEN, ACCOUNT_PERSONAL_POSITION_STATE);
  const o = PERSONAL_POSITION_OFFSETS;
  w.key(o.nftMint, p.nftMint);
  w.key(o.poolId, p.pool);
  w.i32(o.tickLowerIndex, p.tickLower);
  w.i32(o.tickUpperIndex, p.tickUpper);
  w.u128(o.liquidity, p.liquidity);
  w.u128(o.feeGrowthInside0LastX64, p.feeGrowthInside0Last ?? 0n);
  w.u128(o.feeGrowthInside1LastX64, p.feeGrowthInside1Last ?? 0n);
  w.u64(o.tokenFeesOwed0, p.feesOwed0 ?? 0n);
  w.u64(o.tokenFeesOwed1, p.feesOwed1 ?? 0n);
  (p.rewards ?? []).forEach((r, i) => {
    const at = o.rewardInfos + i * POSITION_REWARD_INFO_LEN;
    w.u128(at + POSITION_REWARD_INFO_OFFSETS.growthInsideLastX64, r.growthInsideLast ?? 0n);
    w.u64(at + POSITION_REWARD_INFO_OFFSETS.rewardAmountOwed, r.owed ?? 0n);
  });
  return w.d;
}
