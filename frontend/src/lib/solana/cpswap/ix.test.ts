// @vitest-environment node
// PDA derivation is realm-sensitive under jsdom (see program.test.ts), and this
// file reads the Rust source off disk — node is the right environment for both.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';

import {
  SWAP_ACCOUNTS,
  DEPOSIT_ACCOUNTS,
  WITHDRAW_ACCOUNTS,
  INITIALIZE_ACCOUNTS,
  swapBaseInputIx,
  depositIx,
  withdrawIx,
  initializeIx,
  minimumOutFor,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type AccountSpec,
} from './ix';
import {
  IX_SWAP_BASE_INPUT,
  IX_DEPOSIT,
  IX_WITHDRAW,
  IX_INITIALIZE,
  sortMints,
} from './program';

/**
 * THE ACCOUNT LISTS ARE CHECKED AGAINST THE PROGRAM, NOT AGAINST THEMSELVES.
 *
 * Two entries in the audit ledger are the same bug: a client builder missing
 * one account, shipped green because its test asserted the builder's own count.
 * `tradeKeys` had 9 of 10 accounts; `migrateToAmmIx` omitted `fee_recipient`
 * and shifted the 21 after it.
 *
 * This parses `#[derive(Accounts)]` out of the cp-swap source and compares
 * NAME, ORDER and the signer/writable FLAGS. An account added, removed,
 * reordered, or flipped from read-only to `mut` upstream fails here.
 */

const CP_SWAP_SRC = resolve(__dirname, '../../../../..', 'solana/tegridy-amm/programs/cp-swap/src');

function rust(rel: string): string {
  const p = resolve(CP_SWAP_SRC, rel);
  if (!existsSync(p)) {
    throw new Error(`cp-swap source not found at ${p} — fix the path rather than deleting this guard.`);
  }
  return readFileSync(p, 'utf8');
}

/**
 * Parse an Accounts struct into the same shape as our specs.
 *
 * Anchor makes an account writable when its constraint block carries `mut` or
 * `init` (init implies mut), and a signer when its type is `Signer<'info>`.
 */
function parseAccounts(src: string, structName: string): AccountSpec[] {
  const m = new RegExp(`pub struct ${structName}<'info>\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (!m) throw new Error(`Accounts struct ${structName} not found`);
  const out: AccountSpec[] = [];
  let buf = '';
  for (const line of m[1]!.split('\n')) {
    buf += line + '\n';
    const field = /^\s{4}pub ([a-z_0-9]+)\s*:\s*(.+?),\s*$/.exec(line);
    if (!field) continue;
    const name = field[1]!;
    const ty = field[2]!;
    // Only the attribute block belongs to this field — strip doc comments so a
    // stray "mut" in prose cannot flip a flag.
    const attrs = buf.replace(/\/\/[^\n]*/g, '');
    const writable = /#\[account\([\s\S]*?\b(mut|init)\b/.test(attrs);
    out.push({ name, s: /\bSigner<'info>/.test(ty), w: writable });
    buf = '';
  }
  return out;
}

describe.each([
  ['Swap', 'swap_base_input.rs', SWAP_ACCOUNTS],
  ['Deposit', 'deposit.rs', DEPOSIT_ACCOUNTS],
  ['Withdraw', 'withdraw.rs', WITHDRAW_ACCOUNTS],
  ['Initialize', 'initialize.rs', INITIALIZE_ACCOUNTS],
] as const)('%s account list matches the program', (structName, file, ours) => {
  const theirs = parseAccounts(rust(`instructions/${file}`), structName);

  it('has the same accounts, in the same order', () => {
    expect(ours.map((a) => a.name)).toEqual(theirs.map((a) => a.name));
  });

  it('has the same signer flags', () => {
    expect(ours.map((a) => `${a.name}:${a.s}`)).toEqual(theirs.map((a) => `${a.name}:${a.s}`));
  });

  it('has the same writable flags', () => {
    // A read-only account passed as writable is merely wasteful; a writable one
    // passed read-only reverts the whole transaction.
    expect(ours.map((a) => `${a.name}:${a.w}`)).toEqual(theirs.map((a) => `${a.name}:${a.w}`));
  });
});

/* ─────────────────────────── the builders ───────────────────────────────── */

const pid = new PublicKey('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y');
const pk = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed || 1));
const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

describe('swapBaseInputIx', () => {
  const built = swapBaseInputIx({
    programId: pid, payer: pk(2), ammConfig: pk(3), poolState: pk(4),
    inputTokenAccount: pk(5), outputTokenAccount: pk(6),
    inputVault: pk(7), outputVault: pk(8),
    inputTokenProgram: TOKEN_PROGRAM_ID, outputTokenProgram: TOKEN_2022_PROGRAM_ID,
    inputTokenMint: SOL, outputTokenMint: USDC, observationState: pk(9),
    amountIn: 1_000_000_000n, minimumAmountOut: 990_000_000n,
  });

  it('emits every account the program declares', () => {
    expect(built.keys).toHaveLength(SWAP_ACCOUNTS.length);
    expect(built.programId.toBase58()).toBe(pid.toBase58());
  });

  it('encodes discriminator + two little-endian u64 args', () => {
    expect([...built.data.subarray(0, 8)]).toEqual([...IX_SWAP_BASE_INPUT]);
    expect(built.data).toHaveLength(8 + 16);
    const dv = new DataView(built.data.buffer, built.data.byteOffset, built.data.byteLength);
    expect(dv.getBigUint64(8, true)).toBe(1_000_000_000n);
    expect(dv.getBigUint64(16, true)).toBe(990_000_000n);
  });

  it('marks exactly the payer as signer and the six mutated accounts as writable', () => {
    expect(built.keys.filter((k) => k.isSigner)).toHaveLength(1);
    expect(built.keys[0]!.isSigner).toBe(true);
    expect(built.keys.filter((k) => k.isWritable)).toHaveLength(6);
  });
});

describe('depositIx / withdrawIx', () => {
  const common = {
    programId: pid, owner: pk(2), poolState: pk(3), ownerLpToken: pk(4),
    token0Account: pk(5), token1Account: pk(6), token0Vault: pk(7), token1Vault: pk(8),
    vault0Mint: SOL, vault1Mint: USDC, lpMint: pk(9), lpTokenAmount: 500n,
  };

  it('deposit encodes three u64s and passes BOTH token programs', () => {
    const ix = depositIx({ ...common, maximumToken0Amount: 100n, maximumToken1Amount: 200n });
    expect([...ix.data.subarray(0, 8)]).toEqual([...IX_DEPOSIT]);
    expect(ix.data).toHaveLength(8 + 24);
    expect(ix.keys).toHaveLength(DEPOSIT_ACCOUNTS.length);
    const names = ix.keys.map((k) => k.pubkey.toBase58());
    expect(names).toContain(TOKEN_PROGRAM_ID.toBase58());
    expect(names).toContain(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it('withdraw is deposit plus the memo program, and the args are FLOORS', () => {
    const ix = withdrawIx({ ...common, minimumToken0Amount: 90n, minimumToken1Amount: 180n });
    expect([...ix.data.subarray(0, 8)]).toEqual([...IX_WITHDRAW]);
    expect(ix.keys).toHaveLength(DEPOSIT_ACCOUNTS.length + 1);
    expect(ix.keys[ix.keys.length - 1]!.pubkey.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    expect(dv.getBigUint64(8, true)).toBe(500n);
    expect(dv.getBigUint64(16, true)).toBe(90n);
    expect(dv.getBigUint64(24, true)).toBe(180n);
  });
});

describe('initializeIx', () => {
  const { token0, token1 } = sortMints(SOL, USDC);
  const args = {
    programId: pid, creator: pk(2), ammConfig: pk(3),
    token0Mint: token0, token1Mint: token1,
    creatorToken0: pk(5), creatorToken1: pk(6), creatorLpToken: pk(7),
    token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID,
    createPoolFee: pk(8),
    initAmount0: 1_000n, initAmount1: 2_000n, openTime: 0n,
  };

  it('emits all twenty accounts and three u64 args', () => {
    const ix = initializeIx(args);
    expect(ix.keys).toHaveLength(20);
    expect([...ix.data.subarray(0, 8)]).toEqual([...IX_INITIALIZE]);
    expect(ix.data).toHaveLength(8 + 24);
  });

  it('REFUSES unsorted mints rather than letting the constraint revert', () => {
    // `initialize` carries `constraint = token_0_mint.key() < token_1_mint.key()`.
    // A revert here costs the user a fee for a mistake the client can see.
    expect(() => initializeIx({ ...args, token0Mint: token1, token1Mint: token0 }))
      .toThrow(/byte-sorted/);
  });

  it('derives the pool, LP mint, vaults and observation rather than trusting a caller', () => {
    const ix = initializeIx(args);
    const supplied = new Set([
      args.creator, args.ammConfig, token0, token1,
      args.creatorToken0, args.creatorToken1, args.creatorLpToken, args.createPoolFee,
    ].map((k) => k.toBase58()));
    // pool_state(3), lp_mint(6), vaults(10,11), observation(13) are all derived,
    // so none of them can be a caller-supplied address.
    for (const i of [3, 6, 10, 11, 13]) {
      expect(supplied.has(ix.keys[i]!.pubkey.toBase58()), `account ${i} must be derived`).toBe(false);
    }
    // Every derived account is distinct.
    const derived = [3, 6, 10, 11, 13].map((i) => ix.keys[i]!.pubkey.toBase58());
    expect(new Set(derived).size).toBe(derived.length);
  });
});

describe('minimumOutFor', () => {
  it('always rounds the floor DOWN, so tolerance is never exceeded', () => {
    expect(minimumOutFor(1_000_000n, 50)).toBe(995_000n);   // 0.5%
    expect(minimumOutFor(1_000_000n, 100)).toBe(990_000n);  // 1%
    expect(minimumOutFor(0n, 100)).toBe(0n);
    // 999 * 9950 / 10000 = 994.005 → 994, not 995.
    expect(minimumOutFor(999n, 50)).toBe(994n);
  });

  it('accepts zero slippage and refuses nonsense', () => {
    expect(minimumOutFor(1_000n, 0)).toBe(1_000n);
    expect(() => minimumOutFor(1_000n, -1)).toThrow(RangeError);
    expect(() => minimumOutFor(1_000n, 10_001)).toThrow(RangeError);
    expect(() => minimumOutFor(1_000n, Number.NaN)).toThrow(RangeError);
  });
});
