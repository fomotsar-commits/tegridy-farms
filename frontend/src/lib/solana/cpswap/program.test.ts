// @vitest-environment node
// PDA derivation goes through web3.js's sync sha256 (`@noble/hashes`), whose
// Uint8Array guard is realm-sensitive: under jsdom, web3.js's Node-realm `Buffer`
// fails `instanceof Uint8Array` and every derivation throws "Unable to find a
// viable program address nonce". A real browser uses the `buffer` polyfill, which
// subclasses the page's own Uint8Array, so this is a jsdom artifact — the same
// remedy the curve client's program.test.ts already carries. This file also reads
// the Rust source off disk, which node is the right environment for anyway.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';

import {
  SPENT_PROGRAM_ID,
  LIVE_PROGRAM_ID,
  hasProgramId,
  AMM_CONFIG_OFFSETS,
  AMM_CONFIG_LEN,
  POOL_STATE_OFFSETS,
  POOL_STATE_LEN,
  IX_INITIALIZE,
  IX_DEPOSIT,
  IX_WITHDRAW,
  IX_SWAP_BASE_INPUT,
  IX_SWAP_BASE_OUTPUT,
  ACCOUNT_POOL_STATE,
  ACCOUNT_AMM_CONFIG,
  deriveAmmConfig,
  deriveAuthority,
  derivePool,
  deriveLpMint,
  deriveVault,
  deriveObservation,
  sortMints,
  decodeAmmConfig,
  decodePoolState,
  swapEnabled,
  depositEnabled,
  withdrawEnabled,
  isCreatorFeeOnInput,
} from './program';

/**
 * THE LAYOUTS ARE HAND-ENCODED, SO THIS FILE RE-DERIVES THEM FROM THE PROGRAM.
 *
 * The audit ledger records exactly how a hand-encoded client rots: the curve
 * client's `decodeBondingCurve` used `BONDING_CURVE_SIZE = 162` against a
 * program writing 716-byte accounts, so every launch read back as `bad-length`
 * — and its unit tests passed the whole time, because they pinned the client's
 * own constant back to itself.
 *
 * So nothing here restates an offset. The struct definitions are PARSED out of
 * `solana/tegridy-amm/programs/cp-swap/src/states/*.rs` and the offsets are
 * recomputed from the field types; the discriminators are re-hashed. A field
 * inserted upstream, a type widened, or `#[repr(C, packed)]` dropped fails here
 * instead of silently misreading a pool's reserves.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const CP_SWAP_SRC = resolve(REPO_ROOT, 'solana/tegridy-amm/programs/cp-swap/src');

/** The Rust tree ships with the repo; if it ever moves, fail loudly, not silently. */
function rust(rel: string): string {
  const p = resolve(CP_SWAP_SRC, rel);
  if (!existsSync(p)) {
    throw new Error(
      `cp-swap source not found at ${p}. This guard is worthless without it — ` +
      'fix the path rather than deleting the test.',
    );
  }
  return readFileSync(p, 'utf8');
}

/** Byte width of a Rust field type as the program lays it out. */
function widthOf(ty: string): number {
  const t = ty.trim();
  if (t === 'u8' || t === 'bool') return 1;
  if (t === 'u16') return 2;
  if (t === 'u32') return 4;
  if (t === 'u64') return 8;
  if (t === 'u128') return 16;
  if (t === 'Pubkey') return 32;
  const arr = /^\[\s*([a-z0-9]+)\s*;\s*(\d+)\s*\]$/.exec(t);
  if (arr) return widthOf(arr[1]!) * Number(arr[2]);
  throw new Error(`unhandled Rust type in layout parse: "${t}"`);
}

const snakeToCamel = (s: string) =>
  s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Parse `pub struct <name> { … }` and return each field's byte offset, laid out
 * sequentially from `start` (Borsh, and `repr(C, packed)` for the zero-copy
 * one — neither inserts padding).
 */
function offsetsOf(src: string, structName: string, start: number) {
  const m = new RegExp(`pub struct ${structName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (!m) throw new Error(`struct ${structName} not found`);
  const body = m[1]!.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const fields = [...body.matchAll(/pub\s+([a-z_0-9]+)\s*:\s*([^,]+),/g)];
  const out: Record<string, number> = {};
  let offset = start;
  for (const f of fields) {
    out[snakeToCamel(f[1]!)] = offset;
    offset += widthOf(f[2]!);
  }
  return { offsets: out, total: offset, count: fields.length };
}

describe('identity', () => {
  it('records the SPENT id and refuses to make it a target', () => {
    // A closed upgradeable program id can never hold a program again. Defaulting
    // to it is how a surface ends up quoting against something that cannot run.
    expect(SPENT_PROGRAM_ID.toBase58()).toBe('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y');
    expect(LIVE_PROGRAM_ID).toBe(null);
    expect(hasProgramId()).toBe(false);
  });

  it('the spent id matches the one the program source declares', () => {
    const lib = rust('lib.rs');
    const declared = /#\[cfg\(not\(feature = "devnet"\)\)\]\s*declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(lib);
    expect(declared?.[1]).toBe(SPENT_PROGRAM_ID.toBase58());
  });
});

describe('discriminators are re-hashed, never trusted', () => {
  const disc = (preimage: string) =>
    Uint8Array.from(createHash('sha256').update(preimage).digest().subarray(0, 8));

  it.each([
    ['global:initialize', IX_INITIALIZE],
    ['global:deposit', IX_DEPOSIT],
    ['global:withdraw', IX_WITHDRAW],
    ['global:swap_base_input', IX_SWAP_BASE_INPUT],
    ['global:swap_base_output', IX_SWAP_BASE_OUTPUT],
    ['account:PoolState', ACCOUNT_POOL_STATE],
    ['account:AmmConfig', ACCOUNT_AMM_CONFIG],
  ])('%s', (preimage, pinned) => {
    expect([...pinned]).toEqual([...disc(preimage as string)]);
  });

  it('every instruction we encode still exists in the program', () => {
    const lib = rust('lib.rs');
    for (const name of ['initialize', 'deposit', 'withdraw', 'swap_base_input', 'swap_base_output']) {
      expect(lib, `${name} missing from the #[program] module`).toContain(`pub fn ${name}`);
    }
  });
});

describe('AmmConfig layout, recomputed from states/config.rs', () => {
  const src = rust('states/config.rs');
  const parsed = offsetsOf(src, 'AmmConfig', 8);

  it('matches field for field', () => {
    for (const [name, offset] of Object.entries(AMM_CONFIG_OFFSETS)) {
      expect(parsed.offsets[name], `AmmConfig.${name}`).toBe(offset);
    }
  });

  it('is the length the program itself declares', () => {
    expect(parsed.total).toBe(AMM_CONFIG_LEN);
    // AmmConfig::LEN = 8 + 1 + 1 + 2 + 4 * 8 + 32 * 2 + 8 + 8 * 15
    const len = /pub const LEN: usize = ([^;]+);/.exec(src)?.[1];
    expect(len).toBeTruthy();
    expect(eval(len!)).toBe(AMM_CONFIG_LEN);
  });
});

describe('PoolState layout, recomputed from states/pool.rs', () => {
  const src = rust('states/pool.rs');
  const parsed = offsetsOf(src, 'PoolState', 8);

  it('is #[repr(C, packed)] — the whole layout depends on it', () => {
    // With plain repr(C), every u64 after the five u8s would be aligned to an
    // 8-byte boundary and half these offsets would be silently wrong.
    expect(src).toMatch(/#\[repr\(C,\s*packed\)\]/);
    expect(src).toMatch(/#\[account\(zero_copy\(unsafe\)\)\]/);
  });

  it('matches field for field', () => {
    for (const [name, offset] of Object.entries(POOL_STATE_OFFSETS)) {
      expect(parsed.offsets[name], `PoolState.${name}`).toBe(offset);
    }
  });

  it('is the length the program itself declares', () => {
    expect(parsed.total).toBe(POOL_STATE_LEN);
    const len = /pub const LEN: usize = ([^;]+);/.exec(src)?.[1];
    expect(eval(len!)).toBe(POOL_STATE_LEN);
  });

  it('accrued-fee fields are all present — a quote that misses one overstates reserves', () => {
    for (const f of ['protocolFeesToken0', 'protocolFeesToken1', 'fundFeesToken0',
      'fundFeesToken1', 'creatorFeesToken0', 'creatorFeesToken1']) {
      expect(POOL_STATE_OFFSETS).toHaveProperty(f);
    }
  });
});

describe('PDA seeds match the program source', () => {
  const pool = rust('states/pool.rs');
  const config = rust('states/config.rs');
  const oracle = rust('states/oracle.rs');
  const lib = rust('lib.rs');

  it.each([
    [config, 'AMM_CONFIG_SEED', 'amm_config'],
    [pool, 'POOL_SEED', 'pool'],
    [pool, 'POOL_LP_MINT_SEED', 'pool_lp_mint'],
    [pool, 'POOL_VAULT_SEED', 'pool_vault'],
    [oracle, 'OBSERVATION_SEED', 'observation'],
    [lib, 'AUTH_SEED', 'vault_and_lp_mint_auth_seed'],
  ])('%#: %s', (src, constName, value) => {
    expect(src as string).toContain(`pub const ${constName}: &str = "${value}"`);
  });
});

describe('PDA derivation', () => {
  // A stand-in program id: derivation is pure, so it does not need a live one.
  const pid = new PublicKey('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y');
  const mintA = new PublicKey('So11111111111111111111111111111111111111112');
  const mintB = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  it('is deterministic and distinct per role', () => {
    const cfg = deriveAmmConfig(pid, 0);
    const pool = derivePool(pid, cfg, mintA, mintB);
    const all = [
      cfg.toBase58(), deriveAuthority(pid).toBase58(), pool.toBase58(),
      deriveLpMint(pid, pool).toBase58(),
      deriveVault(pid, pool, mintA).toBase58(),
      deriveVault(pid, pool, mintB).toBase58(),
      deriveObservation(pid, pool).toBase58(),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(deriveAmmConfig(pid, 0).toBase58()).toBe(cfg.toBase58());
  });

  it('indexes the AmmConfig BIG-endian, as `index.to_be_bytes()` does', () => {
    // Little-endian would collide 1 with 256 in the low byte and derive the
    // wrong config for every index above 255.
    expect(deriveAmmConfig(pid, 1).toBase58()).not.toBe(deriveAmmConfig(pid, 256).toBase58());
    const cfgSrc = rust('instructions/admin/create_config.rs');
    expect(cfgSrc).toContain('index.to_be_bytes()');
  });

  it('sorts mints the way the program constrains them', () => {
    const src = rust('instructions/initialize.rs');
    expect(src).toContain('token_0_mint.key() < token_1_mint.key()');
    const { token0, token1, flipped } = sortMints(mintA, mintB);
    // Whatever the order in, token0 must come out byte-less-than token1.
    const cmp = Buffer.compare(Buffer.from(token0.toBytes()), Buffer.from(token1.toBytes()));
    expect(cmp).toBeLessThan(0);
    // …and the reverse call must produce the same pair with `flipped` inverted.
    const back = sortMints(mintB, mintA);
    expect(back.token0.toBase58()).toBe(token0.toBase58());
    expect(back.flipped).toBe(!flipped);
  });

  it('derives the same pool address whichever way the caller names the pair', () => {
    const cfg = deriveAmmConfig(pid, 0);
    const a = sortMints(mintA, mintB);
    const b = sortMints(mintB, mintA);
    expect(derivePool(pid, cfg, a.token0, a.token1).toBase58())
      .toBe(derivePool(pid, cfg, b.token0, b.token1).toBase58());
  });
});

describe('decoders refuse rather than misread', () => {
  it('rejects a wrong discriminator, a short buffer, and garbage', () => {
    const good = new Uint8Array(POOL_STATE_LEN);
    good.set(ACCOUNT_POOL_STATE, 0);
    expect(decodePoolState('P', good)).not.toBe(null);

    const wrongDisc = new Uint8Array(POOL_STATE_LEN);
    wrongDisc.set(ACCOUNT_AMM_CONFIG, 0);
    expect(decodePoolState('P', wrongDisc)).toBe(null);

    expect(decodePoolState('P', new Uint8Array(10))).toBe(null);
    expect(decodeAmmConfig('C', new Uint8Array(0))).toBe(null);
  });

  it('reads the fields it claims to read', () => {
    const d = new Uint8Array(AMM_CONFIG_LEN);
    d.set(ACCOUNT_AMM_CONFIG, 0);
    const dv = new DataView(d.buffer);
    dv.setUint16(AMM_CONFIG_OFFSETS.index, 7, true);
    dv.setBigUint64(AMM_CONFIG_OFFSETS.tradeFeeRate, 2500n, true);
    dv.setBigUint64(AMM_CONFIG_OFFSETS.protocolFeeRate, 120_000n, true);
    dv.setBigUint64(AMM_CONFIG_OFFSETS.createPoolFee, 150_000_000n, true);
    const c = decodeAmmConfig('C', d)!;
    expect(c.index).toBe(7);
    expect(c.tradeFeeRate).toBe(2500n);
    expect(c.protocolFeeRate).toBe(120_000n);
    expect(c.createPoolFee).toBe(150_000_000n);
  });
});

describe('pool status bits', () => {
  it('a SET bit disables the action', () => {
    expect(swapEnabled({ status: 0 })).toBe(true);
    expect(swapEnabled({ status: 4 })).toBe(false);
    expect(depositEnabled({ status: 1 })).toBe(false);
    expect(withdrawEnabled({ status: 2 })).toBe(false);
    // Bits are independent — a swap-disabled pool can still allow withdrawals,
    // which is exactly the state an LP needs to be able to exit.
    expect(withdrawEnabled({ status: 4 })).toBe(true);
  });
});

describe('isCreatorFeeOnInput', () => {
  it('matches pool.rs branch for branch', () => {
    expect(isCreatorFeeOnInput(0, true)).toBe(true);   // BothToken
    expect(isCreatorFeeOnInput(0, false)).toBe(true);
    expect(isCreatorFeeOnInput(1, true)).toBe(true);   // OnlyToken0, paying token0
    expect(isCreatorFeeOnInput(1, false)).toBe(false);
    expect(isCreatorFeeOnInput(2, false)).toBe(true);  // OnlyToken1, paying token1
    expect(isCreatorFeeOnInput(2, true)).toBe(false);
  });

  it('refuses an out-of-range mode instead of defaulting', () => {
    // The program returns InvalidFeeModel here; a client that guessed `true`
    // would misquote every trade on such a pool.
    expect(isCreatorFeeOnInput(3, true)).toBe(null);
    expect(isCreatorFeeOnInput(255, false)).toBe(null);
  });
});
