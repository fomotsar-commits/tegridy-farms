// @vitest-environment node
// PDA derivation is realm-sensitive under jsdom (see cpswap/program.test.ts), and this file
// reads the Rust source and the recorded accounts off disk: node is the right environment.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';

import * as P from './program';
import { initializedTickArrayStarts } from './bitmap';
import { addDelta, calculateLatestTokenFees, getDeltaAmountsSigned, getFeeGrowthInside, getTickAtSqrtPrice } from './math';
import { accountsOf, mainnetRecording, tokenAmount, type RecordedPool } from './mainnetAccounts.fixture';

/**
 * THE LAYOUTS ARE HAND-ENCODED, SO THIS FILE RE-DERIVES THEM FROM THE PROGRAM, THEN READS
 * REAL ACCOUNTS WITH THEM.
 *
 * Nothing here restates an offset: each struct is parsed out of solana/tegridy-clmm and its
 * offsets recomputed from the field types, the discriminators are re-hashed, and the seeds
 * read from the source. Then every decoder meets accounts of the live program whose layout
 * the venue's copy shares (scripts/record-clmm-fixture.mjs), and the decoded numbers must
 * agree with each other the way the program keeps them: a pool's liquidity is the sum of
 * the positions in range, each price's net is the sum of the positions that end there,
 * the vaults hold what the positions are owed. A misread offset breaks one of those.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const CLMM_SRC = resolve(REPO_ROOT, 'solana/tegridy-clmm/programs/amm/src');

function rust(rel: string): string {
  const p = resolve(CLMM_SRC, rel);
  if (!existsSync(p)) throw new Error(`tegridy-clmm source not found at ${p}: fix the path rather than deleting this guard.`);
  return readFileSync(p, 'utf8');
}

const CONSTS: Record<string, number> = { REWARD_NUM: 3, TICK_ARRAY_SIZE_USIZE: 60, OBSERVATION_NUM: 100, EXTENSION_TICKARRAY_BITMAP_SIZE: 14 };

const STRUCT_FILES: Record<string, string> = {
  AmmConfig: 'states/config.rs',
  PoolState: 'states/pool.rs',
  RewardInfo: 'states/pool.rs',
  DynamicFeeInfo: 'states/pool_fee.rs',
  TickArrayState: 'states/tick_array.rs',
  TickState: 'states/tick_array.rs',
  PersonalPositionState: 'states/personal_position.rs',
  PositionRewardInfo: 'states/personal_position.rs',
  ObservationState: 'states/oracle.rs',
  Observation: 'states/oracle.rs',
  TickArrayBitmapExtension: 'states/tickarray_bitmap_extension.rs',
};

function structBody(name: string): string {
  const src = rust(STRUCT_FILES[name]!);
  const m = new RegExp(`pub struct ${name}(?:<'info>)?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (!m) throw new Error(`struct ${name} not found`);
  return m[1]!.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Byte width of a Rust field type as the program lays it out (packed or Borsh: no padding). */
function widthOf(ty: string): number {
  const t = ty.trim();
  const prim: Record<string, number> = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, Pubkey: 32 };
  if (t in prim) return prim[t]!;
  const arr = /^\[(.+);\s*([A-Z_0-9]+)\s*\]$/.exec(t);
  if (arr) {
    const n = /^\d+$/.test(arr[2]!) ? Number(arr[2]) : CONSTS[arr[2]!];
    if (n === undefined) throw new Error(`unknown array length ${arr[2]}`);
    return widthOf(arr[1]!) * n;
  }
  if (t in STRUCT_FILES) return layoutOf(t, 0).total;
  throw new Error(`unhandled Rust type in layout parse: "${t}"`);
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function layoutOf(name: string, start: number) {
  const fields = [...structBody(name).matchAll(/pub\s+([a-z_0-9]+)\s*:\s*([^,]+),/g)];
  const offsets: Record<string, number> = {};
  let o = start;
  for (const f of fields) {
    offsets[camel(f[1]!)] = o;
    o += widthOf(f[2]!);
  }
  return { offsets, total: o };
}

/** The program's own `LEN` expression for a type, evaluated. */
function declaredLen(name: string): number {
  const src = rust(STRUCT_FILES[name]!);
  const impl = new RegExp(`impl ${name} \\{[\\s\\S]*?pub const LEN: usize =([^;]+);`).exec(src);
  if (!impl) throw new Error(`${name}::LEN not found`);
  let expr = impl[1]!.replace(/\/\/[^\n]*/g, ' ');
  expr = expr.replace(/([A-Za-z]+)::LEN/g, (_, t: string) => String(declaredLen(t)));
  expr = expr.replace(/\b([A-Z_]+)\b/g, (_, c: string) => String(CONSTS[c] ?? NaN));
  if (!/^[\d\s+*()]+$/.test(expr)) throw new Error(`${name}::LEN is not plain arithmetic: ${expr}`);
  return eval(expr) as number;
}

describe('identity', () => {
  it('the one program-id constant is the id the program source declares: the program deployed 2026-10-21', () => {
    const lib = rust('lib.rs');
    const declared = /#\[cfg\(not\(feature = "devnet"\)\)\]\s*declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(lib);
    expect(declared?.[1]).toBe(P.RANGE_PROGRAM_ID.toBase58());
    expect(P.RANGE_PROGRAM_ID.toBase58()).toBe('7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso');
    expect(P.rangeProgramNamed()).toBe(true);
    expect(P.rangeProgramNamed(P.PLACEHOLDER_PROGRAM_ID)).toBe(false);
    expect(P.rangeProgramNamed(new PublicKey('11111111111111111111111111111112'))).toBe(true);
  });
});

describe('discriminators are re-hashed, never trusted', () => {
  const disc = (preimage: string) => [...createHash('sha256').update(preimage).digest().subarray(0, 8)];
  it.each([
    ['global:create_pool', P.IX_CREATE_POOL],
    ['global:open_position_with_token22_nft', P.IX_OPEN_POSITION_WITH_TOKEN22_NFT],
    ['global:increase_liquidity_v2', P.IX_INCREASE_LIQUIDITY_V2],
    ['global:decrease_liquidity_v2', P.IX_DECREASE_LIQUIDITY_V2],
    ['global:close_position', P.IX_CLOSE_POSITION],
    ['global:swap_v2', P.IX_SWAP_V2],
    ['account:AmmConfig', P.ACCOUNT_AMM_CONFIG],
    ['account:PoolState', P.ACCOUNT_POOL_STATE],
    ['account:TickArrayState', P.ACCOUNT_TICK_ARRAY_STATE],
    ['account:PersonalPositionState', P.ACCOUNT_PERSONAL_POSITION_STATE],
    ['account:ObservationState', P.ACCOUNT_OBSERVATION_STATE],
    ['account:TickArrayBitmapExtension', P.ACCOUNT_TICK_ARRAY_BITMAP_EXTENSION],
  ])('%s', (preimage, pinned) => {
    expect([...(pinned as Uint8Array)]).toEqual(disc(preimage as string));
  });

  it('every instruction encoded here still exists in the program', () => {
    const lib = rust('lib.rs');
    // One name a line: gitleaks' generic-api-key rule read "token22_nft', '<name>'" as a key.
    const names = [
      'create_pool',
      'open_position_with_token22_nft',
      'increase_liquidity_v2',
      'decrease_liquidity_v2',
      'close_position',
      'swap_v2',
    ];
    for (const name of names) {
      expect(lib, `${name} missing from the #[program] module`).toContain(`pub fn ${name}`);
    }
  });
});

describe('layouts, recomputed from the program source', () => {
  it.each([
    ['AmmConfig', 8, P.AMM_CONFIG_OFFSETS, P.AMM_CONFIG_LEN],
    ['PoolState', 8, P.POOL_STATE_OFFSETS, P.POOL_STATE_LEN],
    ['RewardInfo', 0, P.REWARD_INFO_OFFSETS, P.REWARD_INFO_LEN],
    ['DynamicFeeInfo', 0, P.DYNAMIC_FEE_INFO_OFFSETS, P.DYNAMIC_FEE_INFO_LEN],
    ['TickArrayState', 8, P.TICK_ARRAY_STATE_OFFSETS, P.TICK_ARRAY_STATE_LEN],
    ['TickState', 0, P.TICK_STATE_OFFSETS, P.TICK_STATE_LEN],
    ['PersonalPositionState', 8, P.PERSONAL_POSITION_OFFSETS, P.PERSONAL_POSITION_LEN],
    ['PositionRewardInfo', 0, P.POSITION_REWARD_INFO_OFFSETS, P.POSITION_REWARD_INFO_LEN],
    ['ObservationState', 8, P.OBSERVATION_STATE_OFFSETS, P.OBSERVATION_STATE_LEN],
    ['Observation', 0, P.OBSERVATION_OFFSETS, P.OBSERVATION_LEN],
    ['TickArrayBitmapExtension', 8, P.BITMAP_EXTENSION_OFFSETS, P.BITMAP_EXTENSION_LEN],
  ] as const)('%s: field for field, and the length the program declares', (name, start, ours, len) => {
    const parsed = layoutOf(name, start);
    expect(ours).toEqual(parsed.offsets);
    expect(parsed.total).toBe(len);
    expect(declaredLen(name)).toBe(len);
  });

  it('the zero-copy accounts are #[repr(C, packed)], which the offsets depend on', () => {
    for (const [name, file] of [['PoolState', 'states/pool.rs'], ['TickArrayState', 'states/tick_array.rs'], ['ObservationState', 'states/oracle.rs'], ['TickArrayBitmapExtension', 'states/tickarray_bitmap_extension.rs']]) {
      expect(rust(file!)).toMatch(new RegExp(`#\\[account\\(zero_copy\\(unsafe\\)\\)\\]\\s*#\\[repr\\(C, packed\\)\\][\\s\\S]{0,80}pub struct ${name}`));
    }
  });

  it('array sizes match the program constants', () => {
    expect(rust('states/tick_array.rs')).toContain('pub const TICK_ARRAY_SIZE_USIZE: usize = 60;');
    expect(rust('states/pool.rs')).toContain('pub const REWARD_NUM: usize = 3;');
    expect(rust('states/oracle.rs')).toContain('pub const OBSERVATION_NUM: usize = 100;');
    expect(rust('states/tickarray_bitmap_extension.rs')).toContain('const EXTENSION_TICKARRAY_BITMAP_SIZE: usize = 14;');
    expect(P.TICK_ARRAY_SIZE).toBe(60);
    expect(P.REWARD_NUM).toBe(3);
  });

  it('status bits and fee-on modes are the program enums, in order', () => {
    const pool = rust('states/pool.rs');
    const bits = /pub enum PoolStatusBitIndex \{([^}]*)\}/.exec(pool)![1]!.split(',').map((s) => s.trim()).filter(Boolean);
    expect(bits.map((b) => b.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase())).toEqual([
      'open_position_or_increase_liquidity', 'decrease_liquidity', 'collect_fee', 'collect_reward', 'swap', 'limit_order',
    ]);
    expect(Object.values(P.POOL_STATUS_BIT)).toEqual([0, 1, 2, 3, 4, 5]);
    const fee = rust('states/pool_fee.rs');
    expect(fee).toMatch(/CollectFeeOn::FromInput => 0u8,\s*CollectFeeOn::Token0Only => 1u8,\s*CollectFeeOn::Token1Only => 2u8,/);
  });
});

describe('seeds come from the program source', () => {
  it.each([
    ['states/config.rs', 'AMM_CONFIG_SEED', P.AMM_CONFIG_SEED],
    ['states/pool.rs', 'POOL_SEED', P.POOL_SEED],
    ['states/pool.rs', 'POOL_VAULT_SEED', P.POOL_VAULT_SEED],
    ['states/pool.rs', 'POOL_REWARD_VAULT_SEED', P.POOL_REWARD_VAULT_SEED],
    ['states/pool.rs', 'POOL_TICK_ARRAY_BITMAP_SEED', P.POOL_TICK_ARRAY_BITMAP_SEED],
    ['states/oracle.rs', 'OBSERVATION_SEED', P.OBSERVATION_SEED],
    ['states/tick_array.rs', 'TICK_ARRAY_SEED', P.TICK_ARRAY_SEED],
    ['states/protocol_position.rs', 'POSITION_SEED', P.POSITION_SEED],
  ])('%s %s', (file, name, ours) => {
    const value = new RegExp(`pub const ${name}: &str = "([^"]+)"`).exec(rust(file))?.[1];
    expect(value).toBeTruthy();
    expect(new TextDecoder().decode(ours)).toBe(value);
  });

  it('a band is keyed by its start as a BIG-endian i32, a fee tier by a big-endian u16', () => {
    expect(rust('states/tick_array.rs')).toContain('&tick_array_start_index.to_be_bytes(),');
    expect(rust('instructions/admin/create_amm_config.rs')).toContain('&index.to_be_bytes()');
  });
});

/* ───────────────────────── the recorded live accounts ───────────────────── */

const REC = mainnetRecording();
const LIVE = new PublicKey(REC.program);

function decoded(p: RecordedPool) {
  const pool = P.decodePoolState(p.pool, p.accounts[p.pool]!.data)!;
  const [configAddress, configData] = accountsOf(p, 'config')[0]!;
  const config = P.decodeAmmConfig(configAddress, configData)!;
  const ext = accountsOf(p, 'extension').map(([a, d]) => P.decodeBitmapExtension(a, d)!)[0] ?? null;
  const observation = accountsOf(p, 'observation').map(([a, d]) => P.decodeObservationState(a, d)!)[0]!;
  const arrays = accountsOf(p, 'tickArray').map(([a, d]) => P.decodeTickArray(a, d)!);
  const positions = accountsOf(p, 'position').map(([a, d]) => P.decodePersonalPosition(a, d)!);
  const vaults = Object.fromEntries(accountsOf(p, 'vault').map(([a, d]) => [a, tokenAmount(d)]));
  const ticks = arrays.flatMap((t) => t.ticks.filter(P.tickIsInitialized));
  return { pool, config, ext, observation, arrays, positions, vaults, ticks };
}

describe('the recording', () => {
  it('holds the pools the tests rely on, each feature present at least once', () => {
    expect(REC.pools.length).toBeGreaterThanOrEqual(4);
    const all = REC.pools.map(decoded);
    expect(all.some((d) => d.pool.tickSpacing === 120)).toBe(true);
    expect(all.some((d) => d.pool.tickSpacing === 60)).toBe(true);
    expect(all.some((d) => d.pool.feeOn === P.FEE_ON_TOKEN_1_ONLY)).toBe(true);
    expect(all.some((d) => d.pool.rewardInfos.some((r) => r.initialized))).toBe(true);
    // Bands past the pool's own map: the far-band map in use.
    expect(all.some((d) => d.ext && initializedTickArrayStarts(d.pool, d.ext).length > initializedTickArrayStarts(d.pool, null).length)).toBe(true);
    expect(REC.pools.some((p) => p.allBandsInFull && p.allPositions)).toBe(true);
  });

  it('a pool made by today’s create_pool keeps its price history at the address the program derives', () => {
    // create_pool.rs makes it at [OBSERVATION_SEED, pool]; pools from older versions of the
    // live program keep a keypair account, which is why the pool records the key.
    expect(rust('instructions/create_pool.rs')).toMatch(/seeds = \[\s*OBSERVATION_SEED\.as_bytes\(\),\s*pool_state\.key\(\)\.as_ref\(\),\s*\]/);
    const atPda = REC.pools.map(decoded).filter((d) => P.deriveObservation(LIVE, new PublicKey(d.pool.address)).toBase58() === d.pool.observationKey);
    expect(atPda.length).toBeGreaterThan(0);
  });
});

describe.each(REC.pools.map((p) => [p.pool, p] as const))('live pool %s', (_, rec) => {
  const d = decoded(rec);

  it('every account decodes as its own kind and as no other', () => {
    const decoders = {
      pool: P.decodePoolState, config: P.decodeAmmConfig, observation: P.decodeObservationState,
      extension: P.decodeBitmapExtension, tickArray: P.decodeTickArray, position: P.decodePersonalPosition,
    } as const;
    for (const [address, a] of Object.entries(rec.accounts)) {
      if (a.kind === 'vault') continue;
      expect(a.owner).toBe(REC.program);
      for (const [kind, decode] of Object.entries(decoders)) {
        const got = (decode as (x: string, y: Uint8Array) => unknown)(address, a.data);
        expect(got === null, `${address} as ${kind}`).toBe(kind !== a.kind);
      }
      // A byte short, or any discriminator byte off, is refused.
      const decode = decoders[a.kind as keyof typeof decoders] as (x: string, y: Uint8Array) => unknown;
      expect(decode(address, a.data.subarray(0, a.data.length - 1))).toBeNull();
      const bent = Uint8Array.from(a.data);
      bent[3] ^= 1;
      expect(decode(address, bent)).toBeNull();
    }
  });

  it('the pool sits at the address its tier and mints derive, with its vaults, history and far-band map', () => {
    expect(d.pool.seedIndex).toBe(0);
    expect(P.derivePool(LIVE, new PublicKey(d.pool.ammConfig), new PublicKey(d.pool.tokenMint0), new PublicKey(d.pool.tokenMint1)).toBase58()).toBe(d.pool.address);
    expect(P.sortMints(new PublicKey(d.pool.tokenMint1), new PublicKey(d.pool.tokenMint0)).token0.toBase58()).toBe(d.pool.tokenMint0);
    expect(P.deriveVault(LIVE, new PublicKey(d.pool.address), new PublicKey(d.pool.tokenMint0)).toBase58()).toBe(d.pool.tokenVault0);
    expect(P.deriveVault(LIVE, new PublicKey(d.pool.address), new PublicKey(d.pool.tokenMint1)).toBase58()).toBe(d.pool.tokenVault1);
    expect(d.observation.address).toBe(d.pool.observationKey);
    expect(d.observation.poolId).toBe(d.pool.address);
    expect(d.observation.observationIndex).toBeLessThan(P.OBSERVATION_NUM);
    if (d.ext) {
      expect(P.deriveBitmapExtension(LIVE, new PublicKey(d.pool.address)).toBase58()).toBe(d.ext.address);
      expect(d.ext.poolId).toBe(d.pool.address);
    }
    expect(Object.keys(d.vaults).sort()).toEqual([d.pool.tokenVault0, d.pool.tokenVault1].sort());
  });

  it('the fee tier is at the address its index derives, and its spacing is the pool’s', () => {
    expect(d.config.address).toBe(d.pool.ammConfig);
    expect(P.deriveAmmConfig(LIVE, d.config.index).toBase58()).toBe(d.config.address);
    expect(d.config.tickSpacing).toBe(d.pool.tickSpacing);
    expect(d.config.tradeFeeRate).toBeGreaterThan(0);
    expect(d.config.tradeFeeRate).toBeLessThan(1_000_000);
    expect(d.config.protocolFeeRate + d.config.fundFeeRate).toBeLessThanOrEqual(1_000_000);
  });

  it('the price and the tick agree, as the program keeps them', () => {
    const t = getTickAtSqrtPrice(d.pool.sqrtPriceX64);
    expect([t, t - 1]).toContain(d.pool.tickCurrent);
  });

  it('a reward’s vault is at the address the program derives for it', () => {
    for (const r of d.pool.rewardInfos) {
      if (!r.initialized) continue;
      const want = PublicKey.findProgramAddressSync([P.POOL_REWARD_VAULT_SEED, new PublicKey(d.pool.address).toBytes(), new PublicKey(r.tokenMint).toBytes()], LIVE)[0];
      expect(r.tokenVault).toBe(want.toBase58());
    }
  });

  it('each band sits at the address its start derives, and counts its used prices right', () => {
    for (const [address, start] of rec.tickArrays) {
      expect(P.deriveTickArray(LIVE, new PublicKey(d.pool.address), start).toBase58()).toBe(address);
    }
    expect(d.arrays.length).toBeGreaterThan(0);
    for (const a of d.arrays) {
      expect(a.poolId).toBe(d.pool.address);
      expect(rec.tickArrays.find(([x]) => x === a.address)?.[1]).toBe(a.startTickIndex);
      const used = a.ticks.map((t, i) => [t, i] as const).filter(([t]) => P.tickIsInitialized(t));
      expect(used.length).toBe(a.initializedTickCount);
      for (const [t, i] of used) expect(t.tick).toBe(a.startTickIndex + i * d.pool.tickSpacing);
    }
  });

  it('the bands the pool’s maps mark are exactly the bands that hold a used price', () => {
    const marked = initializedTickArrayStarts(d.pool, d.ext);
    const used = rec.tickArrays.filter(([, , count]) => count > 0).map(([, start]) => start);
    expect(marked).toEqual(used);
  });

  it('each position sits at the address its NFT derives, in this pool, on usable prices', () => {
    expect(d.positions.length).toBeGreaterThan(0);
    for (const p of d.positions) {
      expect(P.derivePersonalPosition(LIVE, new PublicKey(p.nftMint)).toBase58()).toBe(p.address);
      expect(p.poolId).toBe(d.pool.address);
      expect(p.tickLowerIndex).toBeLessThan(p.tickUpperIndex);
      expect(Math.abs(p.tickLowerIndex % d.pool.tickSpacing)).toBe(0);
      expect(Math.abs(p.tickUpperIndex % d.pool.tickSpacing)).toBe(0);
    }
  });

  it.runIf(rec.allBandsInFull)('every used price nets to zero, and the nets up to the price are the pool’s liquidity', () => {
    expect(d.ticks.reduce((n, t) => n + t.liquidityNet, 0n)).toBe(0n);
    let live = 0n;
    for (const t of d.ticks) if (t.tick <= d.pool.tickCurrent) live = addDelta(live, t.liquidityNet);
    expect(live).toBe(d.pool.liquidity);
  });

  it.runIf(rec.allBandsInFull && rec.allPositions)('the positions add up to the pool, price by price', () => {
    expect(d.positions.length).toBe(rec.positionsInPool);
    const inRange = d.positions.filter((p) => p.tickLowerIndex <= d.pool.tickCurrent && d.pool.tickCurrent < p.tickUpperIndex);
    expect(inRange.reduce((n, p) => n + p.liquidity, 0n)).toBe(d.pool.liquidity);
    for (const t of d.ticks) {
      if (P.tickHasLimitOrders(t)) continue;
      const lower = d.positions.filter((p) => p.tickLowerIndex === t.tick).reduce((n, p) => n + p.liquidity, 0n);
      const upper = d.positions.filter((p) => p.tickUpperIndex === t.tick).reduce((n, p) => n + p.liquidity, 0n);
      expect(t.liquidityGross, `gross at ${t.tick}`).toBe(lower + upper);
      expect(t.liquidityNet, `net at ${t.tick}`).toBe(lower - upper);
    }
  });

  it.runIf(rec.allBandsInFull && rec.allPositions)('the vaults hold what every position could take out now, fees included', () => {
    const tickAt = (i: number) => d.ticks.find((t) => t.tick === i);
    let owed0 = d.pool.protocolFeesToken0 + d.pool.fundFeesToken0;
    let owed1 = d.pool.protocolFeesToken1 + d.pool.fundFeesToken1;
    for (const p of d.positions) {
      const [a0, a1] = getDeltaAmountsSigned(d.pool.tickCurrent, d.pool.sqrtPriceX64, p.tickLowerIndex, p.tickUpperIndex, -p.liquidity);
      let fee0 = p.tokenFeesOwed0;
      let fee1 = p.tokenFeesOwed1;
      const lower = tickAt(p.tickLowerIndex);
      const upper = tickAt(p.tickUpperIndex);
      if (p.liquidity > 0n) {
        expect(lower && upper, `ticks of ${p.address}`).toBeTruthy();
        const [g0, g1] = getFeeGrowthInside(lower!, upper!, d.pool.tickCurrent, d.pool.feeGrowthGlobal0X64, d.pool.feeGrowthGlobal1X64);
        fee0 = calculateLatestTokenFees(fee0, p.feeGrowthInside0LastX64, g0, p.liquidity);
        fee1 = calculateLatestTokenFees(fee1, p.feeGrowthInside1LastX64, g1, p.liquidity);
      }
      expect(fee0).toBeGreaterThanOrEqual(p.tokenFeesOwed0);
      expect(fee1).toBeGreaterThanOrEqual(p.tokenFeesOwed1);
      owed0 += a0 + fee0;
      owed1 += a1 + fee1;
    }
    const v0 = d.vaults[d.pool.tokenVault0]!;
    const v1 = d.vaults[d.pool.tokenVault1]!;
    // Never more owed than held.
    expect(owed0).toBeLessThanOrEqual(v0);
    expect(owed1).toBeLessThanOrEqual(v1);
    // The rest is the dust every swap and fee split rounds toward the pool, credited to no
    // one: measured 2026-10-20 at under 0.002% of a vault. A misread offset is not that close.
    expect((v0 - owed0) * 10_000n).toBeLessThanOrEqual(v0);
    expect((v1 - owed1) * 10_000n).toBeLessThanOrEqual(v1);
  });
});

describe('flags', () => {
  it('fee-on modes, as pool_fee.rs reads them', () => {
    for (const z of [true, false]) {
      expect(P.isFeeOnInput(P.FEE_ON_FROM_INPUT, z)).toBe(true);
      expect(P.isFeeOnToken0(P.FEE_ON_FROM_INPUT, z)).toBe(z);
      expect(P.isFeeOnInput(P.FEE_ON_TOKEN_0_ONLY, z)).toBe(z);
      expect(P.isFeeOnToken0(P.FEE_ON_TOKEN_0_ONLY, z)).toBe(true);
      expect(P.isFeeOnInput(P.FEE_ON_TOKEN_1_ONLY, z)).toBe(!z);
      expect(P.isFeeOnToken0(P.FEE_ON_TOKEN_1_ONLY, z)).toBe(false);
      // An unknown mode reads as the default, as the program's `_` arm does.
      expect(P.isFeeOnInput(7, z)).toBe(true);
      expect(P.isFeeOnToken0(7, z)).toBe(z);
    }
  });

  it('a set status bit disables its action', () => {
    expect(P.poolAllows({ status: 0 }, P.POOL_STATUS_BIT.swap)).toBe(true);
    expect(P.poolAllows({ status: 1 << 4 }, P.POOL_STATUS_BIT.swap)).toBe(false);
    expect(P.poolAllows({ status: 1 << 4 }, P.POOL_STATUS_BIT.collectFee)).toBe(true);
  });
});
