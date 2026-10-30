// @vitest-environment node
// PDA derivation is realm-sensitive under jsdom (see cpswap/program.test.ts), and this file
// reads the Rust source off disk: node is the right environment for both.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';

import * as IX from './ix';
import * as P from './program';
import { getArrayStartIndex } from './bitmap';
import { ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../cpswap/ix';

/**
 * THE ACCOUNT LISTS ARE CHECKED AGAINST THE PROGRAM, NOT AGAINST THEMSELVES.
 *
 * Each `#[derive(Accounts)]` struct is parsed out of solana/tegridy-clmm and held equal to
 * ours: names, order, signer and writable flags. Then each builder's keys are checked one by
 * one against the address the program's own constraints demand.
 */

const SRC = resolve(__dirname, '../../../../..', 'solana/tegridy-clmm/programs/amm/src/instructions');

function rust(rel: string): string {
  const p = resolve(SRC, rel);
  if (!existsSync(p)) throw new Error(`tegridy-clmm source not found at ${p}: fix the path rather than deleting this guard.`);
  return readFileSync(p, 'utf8');
}

/** Anchor: writable on `mut` or `init`, a signer when the type is `Signer<'info>`. */
function parseAccounts(src: string, structName: string): IX.AccountSpec[] {
  const m = new RegExp(`pub struct ${structName}<'info>\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (!m) throw new Error(`Accounts struct ${structName} not found`);
  const out: IX.AccountSpec[] = [];
  let buf = '';
  for (const line of m[1]!.split('\n')) {
    buf += line + '\n';
    const field = /^\s{4}pub ([a-z_0-9]+)\s*:\s*(.+?),\s*$/.exec(line);
    if (!field) continue;
    const attrs = buf.replace(/\/\/[^\n]*/g, '');
    out.push({ name: field[1]!, s: /\bSigner<'info>/.test(field[2]!), w: /#\[account\([\s\S]*?\b(mut|init)\b/.test(attrs) });
    buf = '';
  }
  return out;
}

describe.each([
  ['CreatePool', 'create_pool.rs', IX.CREATE_POOL_ACCOUNTS],
  ['OpenPositionWithToken22Nft', 'open_position_with_token22_nft.rs', IX.OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS],
  ['IncreaseLiquidityV2', 'increase_liquidity_v2.rs', IX.INCREASE_LIQUIDITY_V2_ACCOUNTS],
  ['DecreaseLiquidityV2', 'decrease_liquidity_v2.rs', IX.DECREASE_LIQUIDITY_V2_ACCOUNTS],
  ['ClosePosition', 'close_position.rs', IX.CLOSE_POSITION_ACCOUNTS],
  ['SwapSingleV2', 'swap_v2.rs', IX.SWAP_V2_ACCOUNTS],
] as const)('%s account list matches the program', (structName, file, ours) => {
  const theirs = parseAccounts(rust(file), structName);
  it('has the same accounts, in the same order, with the same flags', () => {
    expect(theirs.length).toBeGreaterThan(5);
    expect(ours.map((a) => `${a.name}:s=${a.s}:w=${a.w}`)).toEqual(theirs.map((a) => `${a.name}:s=${a.s}:w=${a.w}`));
  });
});

describe('the Metaplex path is never built', () => {
  it('no builder for open_position or open_position_v2, and no Metaplex program anywhere in the client', () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of files) {
      const text = readFileSync(resolve(__dirname, f), 'utf8');
      expect(text, f).not.toMatch(/metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s/);
      expect(text, f).not.toMatch(/global:open_position(_v2)?["'`]/);
    }
    expect(Object.keys(IX).filter((k) => /open/i.test(k)).sort()).toEqual(['OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS', 'openPositionWithToken22NftIx']);
  });

  it('every position opened here writes its NFT’s own name and link (with_metadata = true)', () => {
    const ix = IX.openPositionWithToken22NftIx(openArgs());
    // disc 8 + four i32 + u128 + two u64 = 56; then with_metadata, then Option<bool>.
    expect(ix.data[56]).toBe(1);
  });
});

/* ─────────────────────────────── builders ──────────────────────────────── */

const pid = new PublicKey('11111111111111111111111111111112');
const key = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));
const mintA = key(1);
const mintB = key(2);
const poolKey = key(9);
const POOL: IX.PoolRef & Pick<P.PoolStateView, 'status' | 'rewardInfos' | 'ammConfig' | 'observationKey'> = {
  address: poolKey.toBase58(),
  tokenMint0: mintA.toBase58(),
  tokenMint1: mintB.toBase58(),
  tokenVault0: key(10).toBase58(),
  tokenVault1: key(11).toBase58(),
  tickSpacing: 120,
  status: 0,
  rewardInfos: [],
  ammConfig: key(12).toBase58(),
  observationKey: key(13).toBase58(),
};
const payer = key(20);
const nftMint = Keypair.generate().publicKey;

function openArgs(over: Partial<IX.OpenPositionArgs> = {}): IX.OpenPositionArgs {
  return {
    programId: pid, payer, owner: payer, positionNftMint: nftMint, pool: POOL,
    tokenAccount0: key(21), tokenAccount1: key(22), tickLower: -7200, tickUpper: 14400,
    liquidity: 0n, amount0Max: 1_000_000n, amount1Max: 0n, baseFlag: true, ...over,
  };
}

const named = (spec: IX.AccountSpec[], keys: { pubkey: PublicKey }[]) => Object.fromEntries(spec.map((a, i) => [a.name, keys[i]!.pubkey.toBase58()]));
const dv = (b: Buffer) => new DataView(b.buffer, b.byteOffset, b.byteLength);

describe('createPoolIx', () => {
  const ix = IX.createPoolIx({ programId: pid, poolCreator: payer, ammConfig: key(12), mint0: mintA, mint1: mintB, tokenProgram0: TOKEN_PROGRAM_ID, tokenProgram1: TOKEN_2022_PROGRAM_ID, sqrtPriceX64: 1n << 64n });
  it('derives every account the program seeds, and encodes the price with open time 0', () => {
    const k = named(IX.CREATE_POOL_ACCOUNTS, ix.keys);
    const pool = P.derivePool(pid, key(12), mintA, mintB);
    expect(k.pool_state).toBe(pool.toBase58());
    expect(k.token_vault_0).toBe(P.deriveVault(pid, pool, mintA).toBase58());
    expect(k.token_vault_1).toBe(P.deriveVault(pid, pool, mintB).toBase58());
    expect(k.observation_state).toBe(P.deriveObservation(pid, pool).toBase58());
    expect(k.tick_array_bitmap).toBe(P.deriveBitmapExtension(pid, pool).toBase58());
    expect(k.system_program).toBe(SystemProgram.programId.toBase58());
    expect(k.rent).toBe(SYSVAR_RENT_PUBKEY.toBase58());
    expect([...ix.data.subarray(0, 8)]).toEqual([...P.IX_CREATE_POOL]);
    expect(ix.data.length).toBe(8 + 16 + 8);
    expect(dv(ix.data).getBigUint64(8, true)).toBe(0n);
    expect(dv(ix.data).getBigUint64(16, true)).toBe(1n);
    expect(dv(ix.data).getBigUint64(24, true)).toBe(0n);
  });
  it('pays the opening fee the program charges to the wallet it fixes, its release arm (lib.rs), and nowhere else', () => {
    const lib = readFileSync(resolve(SRC, '..', 'lib.rs'), 'utf8');
    const mod = /pub mod create_pool_fee_reveiver \{([\s\S]*?)\n\}/.exec(lib)?.[1] ?? '';
    const release = /#\[cfg\(not\(feature = "devnet"\)\)\]\s*pub const ID: Pubkey = pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\);/.exec(mod)?.[1];
    expect(release).toBe(IX.CREATE_POOL_FEE_RECEIVER.toBase58());
    expect(/^pub const CREATE_POOL_FEE: u64 = ([0-9_]+);$/m.exec(lib)?.[1]?.replace(/_/g, '')).toBe(String(IX.CREATE_POOL_FEE_LAMPORTS));
    const k = ix.keys[IX.CREATE_POOL_ACCOUNTS.findIndex((a) => a.name === 'create_pool_fee')]!;
    expect(k).toEqual({ pubkey: IX.CREATE_POOL_FEE_RECEIVER, isSigner: false, isWritable: true });
    expect(ix.keys).toHaveLength(IX.CREATE_POOL_ACCOUNTS.length);
  });
  it('refuses unsorted mints before anyone pays for a revert', () => {
    expect(() => IX.createPoolIx({ programId: pid, poolCreator: payer, ammConfig: key(12), mint0: mintB, mint1: mintA, tokenProgram0: TOKEN_PROGRAM_ID, tokenProgram1: TOKEN_PROGRAM_ID, sqrtPriceX64: 1n << 64n })).toThrow(/byte-sorted/);
  });
});

describe('openPositionWithToken22NftIx', () => {
  it('puts the NFT in the owner’s Token-2022 account, the record at its PDA, and the bands at their starts', () => {
    const ix = IX.openPositionWithToken22NftIx(openArgs());
    const k = named(IX.OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS, ix.keys);
    expect(ix.keys).toHaveLength(IX.OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS.length); // spacing 120: no far-band map needed
    expect(k.position_nft_account).toBe(PublicKey.findProgramAddressSync([payer.toBytes(), TOKEN_2022_PROGRAM_ID.toBytes(), nftMint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0].toBase58());
    expect(k.personal_position).toBe(P.derivePersonalPosition(pid, nftMint).toBase58());
    expect(k.tick_array_lower).toBe(P.deriveTickArray(pid, poolKey, -7200).toBase58());
    expect(k.tick_array_upper).toBe(P.deriveTickArray(pid, poolKey, 14400).toBase58());
    expect(k.token_vault_0).toBe(POOL.tokenVault0);
    expect(k.vault_1_mint).toBe(POOL.tokenMint1);
    expect(k.token_program).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(k.token_program_2022).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(k.associated_token_program).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(ix.keys.filter((x) => x.isSigner).map((x) => x.pubkey.toBase58()).sort()).toEqual([payer.toBase58(), nftMint.toBase58()].sort());
  });

  it('encodes ticks, band starts, liquidity, ceilings and the base flag as Borsh', () => {
    const ix = IX.openPositionWithToken22NftIx(openArgs({ tickLower: -7201 + 1, tickUpper: 120, liquidity: 5n, amount1Max: 9n, baseFlag: null }));
    const d = dv(ix.data);
    expect([...ix.data.subarray(0, 8)]).toEqual([...P.IX_OPEN_POSITION_WITH_TOKEN22_NFT]);
    expect([d.getInt32(8, true), d.getInt32(12, true), d.getInt32(16, true), d.getInt32(20, true)]).toEqual([-7200, 120, -7200, 0]);
    expect(d.getBigUint64(24, true)).toBe(5n);
    expect(d.getBigUint64(32, true)).toBe(0n);
    expect(d.getBigUint64(40, true)).toBe(1_000_000n);
    expect(d.getBigUint64(48, true)).toBe(9n);
    expect([...ix.data.subarray(56)]).toEqual([1, 0]);
    const some = IX.openPositionWithToken22NftIx(openArgs({ baseFlag: false }));
    expect([...some.data.subarray(56)]).toEqual([1, 1, 0]);
  });

  it('adds the far-band map, writable, only when a band lies past the pool’s own map', () => {
    const narrow = { ...POOL, tickSpacing: 1 };
    const near = IX.openPositionWithToken22NftIx(openArgs({ pool: narrow, tickLower: -60, tickUpper: 60 }));
    expect(near.keys).toHaveLength(IX.OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS.length);
    const far = IX.openPositionWithToken22NftIx(openArgs({ pool: narrow, tickLower: 40_000, tickUpper: 40_060 }));
    expect(far.keys).toHaveLength(IX.OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS.length + 1);
    expect(far.keys.at(-1)).toEqual({ pubkey: P.deriveBitmapExtension(pid, poolKey), isSigner: false, isWritable: true });
    expect(getArrayStartIndex(40_000, 1)).toBe(39_960);
  });
});

describe('increase, decrease, collect and close', () => {
  const position = { nftMint: nftMint.toBase58(), tickLowerIndex: -7200, tickUpperIndex: 14400 };

  it('increaseLiquidityV2Ix: the owner signs, the record and bands are derived, the base flag is required at 0', () => {
    const ix = IX.increaseLiquidityV2Ix({ programId: pid, nftOwner: payer, position, pool: POOL, tokenAccount0: key(21), tokenAccount1: key(22), liquidity: 7n, amount0Max: 1n, amount1Max: 2n, baseFlag: null });
    const k = named(IX.INCREASE_LIQUIDITY_V2_ACCOUNTS, ix.keys);
    expect(k.personal_position).toBe(P.derivePersonalPosition(pid, nftMint).toBase58());
    expect(k.nft_account).toBe(IX.positionNftAccount(payer, nftMint).toBase58());
    expect(k.protocol_position).toBe(P.deriveProtocolPosition(pid, poolKey, -7200, 14400).toBase58());
    expect([...ix.data.subarray(0, 8)]).toEqual([...P.IX_INCREASE_LIQUIDITY_V2]);
    expect(ix.data.length).toBe(8 + 16 + 8 + 8 + 1);
    expect(() => IX.increaseLiquidityV2Ix({ programId: pid, nftOwner: payer, position, pool: POOL, tokenAccount0: key(21), tokenAccount1: key(22), liquidity: 0n, amount0Max: 1n, amount1Max: 2n, baseFlag: null })).toThrow(/MissingBaseFlag/);
  });

  it('collectFeesIx is a decrease of zero with zero floors, and pays to the given accounts', () => {
    const ix = IX.collectFeesIx({ programId: pid, nftOwner: payer, position, pool: POOL, recipientTokenAccount0: key(31), recipientTokenAccount1: key(32), rewards: [] });
    const k = named(IX.DECREASE_LIQUIDITY_V2_ACCOUNTS, ix.keys);
    expect(k.recipient_token_account_0).toBe(key(31).toBase58());
    expect(k.memo_program).toBe(MEMO_PROGRAM_ID.toBase58());
    expect([...ix.data.subarray(0, 8)]).toEqual([...P.IX_DECREASE_LIQUIDITY_V2]);
    expect([...ix.data.subarray(8)]).toEqual(new Array(32).fill(0));
  });

  it('decreaseLiquidityV2Ix wants one reward group per reward the pool pays, and appends them', () => {
    const reward = { initialized: true, tokenMint: key(40).toBase58(), tokenVault: key(41).toBase58() } as P.RewardInfoView;
    const withReward = { ...POOL, rewardInfos: [reward, { ...reward, initialized: false }] };
    const args = { programId: pid, nftOwner: payer, position, pool: withReward, recipientTokenAccount0: key(31), recipientTokenAccount1: key(32), liquidity: 3n, amount0Min: 1n, amount1Min: 1n };
    expect(() => IX.decreaseLiquidityV2Ix({ ...args, rewards: [] })).toThrow(/wants 1 groups/);
    const ix = IX.decreaseLiquidityV2Ix({ ...args, rewards: [{ vault: key(41), recipient: key(42), mint: key(40) }] });
    expect(ix.keys.slice(-3).map((x) => [x.pubkey.toBase58(), x.isWritable])).toEqual([[key(41).toBase58(), true], [key(42).toBase58(), true], [key(40).toBase58(), false]]);
    // With reward collection switched off, the program reads none.
    expect(() => IX.decreaseLiquidityV2Ix({ ...args, pool: { ...withReward, status: 1 << P.POOL_STATUS_BIT.collectReward }, rewards: [] })).not.toThrow();
  });

  it('closePositionIx burns through Token-2022 and returns the record’s rent to the owner', () => {
    const ix = IX.closePositionIx({ programId: pid, nftOwner: payer, nftMint });
    const k = named(IX.CLOSE_POSITION_ACCOUNTS, ix.keys);
    expect(k.token_program).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(k.personal_position).toBe(P.derivePersonalPosition(pid, nftMint).toBase58());
    expect(ix.data.length).toBe(8);
  });
});

describe('swapV2Ix', () => {
  const base = { programId: pid, payer, pool: POOL, inputTokenAccount: key(51), outputTokenAccount: key(52), tickArrays: [key(60), key(61)], bitmapExtension: null, amount: 100n, otherAmountThreshold: 90n, sqrtPriceLimitX64: 0n, isBaseInput: true };
  it('orders vaults and mints by direction, and passes the bands writable after the far-band map', () => {
    const one = IX.swapV2Ix({ ...base, zeroForOne: false, bitmapExtension: key(59) });
    const k = named(IX.SWAP_V2_ACCOUNTS, one.keys);
    expect([k.input_vault, k.output_vault, k.input_vault_mint, k.output_vault_mint]).toEqual([POOL.tokenVault1, POOL.tokenVault0, POOL.tokenMint1, POOL.tokenMint0]);
    expect(one.keys.slice(IX.SWAP_V2_ACCOUNTS.length).map((x) => [x.pubkey.toBase58(), x.isWritable])).toEqual([[key(59).toBase58(), true], [key(60).toBase58(), true], [key(61).toBase58(), true]]);
    const zero = IX.swapV2Ix({ ...base, zeroForOne: true });
    expect(named(IX.SWAP_V2_ACCOUNTS, zero.keys).input_vault).toBe(POOL.tokenVault0);
    expect(zero.data.length).toBe(8 + 8 + 8 + 16 + 1);
    expect(dv(zero.data).getBigUint64(8, true)).toBe(100n);
    expect(dv(zero.data).getBigUint64(16, true)).toBe(90n);
    expect(zero.data[40]).toBe(1);
  });
  it('refuses a swap with no band', () => {
    expect(() => IX.swapV2Ix({ ...base, zeroForOne: true, tickArrays: [] })).toThrow(/NotEnoughTickArrayAccount/);
  });
});
