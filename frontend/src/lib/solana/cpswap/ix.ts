import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import {
  IX_INITIALIZE,
  IX_DEPOSIT,
  IX_WITHDRAW,
  IX_SWAP_BASE_INPUT,
  deriveAuthority,
  deriveLpMint,
  deriveObservation,
  derivePool,
  deriveVault,
  sortMints,
} from './program';

/**
 * Hand-encoded instruction builders for the venue's AMM.
 *
 * THE FAILURE MODE THIS FILE IS BUILT AGAINST: the audit ledger carries the
 * same defect twice — `tradeKeys` omitted the `creator` account, so every
 * buy/sell the client could build had 9 of the program's 10 accounts and could
 * not succeed; `migrateToAmmIx` omitted `fee_recipient`, shifting all 21
 * remaining accounts by one. Both shipped with green unit tests, because those
 * tests pinned the client's own account count back to itself.
 *
 * So the account lists live here as DATA (`*_ACCOUNTS` below), in program
 * order, with their signer/writable flags — and `ix.test.ts` parses the
 * `#[derive(Accounts)]` structs out of the Rust and asserts these match name
 * for name, flag for flag. Adding an account upstream fails the test; it does
 * not ship a transaction that reverts.
 *
 * NOTHING HERE HAS EVER EXECUTED. The program is not deployed (see program.ts),
 * so these builders are unexercised by construction until it is. The
 * source-derived test is what stands in for that until a validator can run them
 * — CI's `migration-rehearsal` job is where they get their first real execution.
 *
 * Pure: no connection, no signing, no fetch.
 */

/** One account in a program-ordered list. `s` = signer, `w` = writable. */
export interface AccountSpec {
  name: string;
  s: boolean;
  w: boolean;
}

const A = (name: string, s = false, w = false): AccountSpec => ({ name, s, w });

/** `Swap` — swap_base_input.rs. */
export const SWAP_ACCOUNTS: AccountSpec[] = [
  A('payer', true), A('authority'), A('amm_config'), A('pool_state', false, true),
  A('input_token_account', false, true), A('output_token_account', false, true),
  A('input_vault', false, true), A('output_vault', false, true),
  A('input_token_program'), A('output_token_program'),
  A('input_token_mint'), A('output_token_mint'),
  A('observation_state', false, true),
];

/** `Deposit` — deposit.rs. */
export const DEPOSIT_ACCOUNTS: AccountSpec[] = [
  A('owner', true), A('authority'), A('pool_state', false, true),
  A('owner_lp_token', false, true),
  A('token_0_account', false, true), A('token_1_account', false, true),
  A('token_0_vault', false, true), A('token_1_vault', false, true),
  A('token_program'), A('token_program_2022'),
  A('vault_0_mint'), A('vault_1_mint'),
  A('lp_mint', false, true),
];

/** `Withdraw` — withdraw.rs. Same as Deposit plus the memo program at the end. */
export const WITHDRAW_ACCOUNTS: AccountSpec[] = [
  ...DEPOSIT_ACCOUNTS,
  A('memo_program'),
];

/** `Initialize` — initialize.rs. */
export const INITIALIZE_ACCOUNTS: AccountSpec[] = [
  A('creator', true, true), A('amm_config'), A('authority'), A('pool_state', false, true),
  A('token_0_mint'), A('token_1_mint'), A('lp_mint', false, true),
  A('creator_token_0', false, true), A('creator_token_1', false, true),
  A('creator_lp_token', false, true),
  A('token_0_vault', false, true), A('token_1_vault', false, true),
  A('create_pool_fee', false, true), A('observation_state', false, true),
  A('token_program'), A('token_0_program'), A('token_1_program'),
  A('associated_token_program'), A('system_program'), A('rent'),
];

/* ───────────────────────────── encoding ─────────────────────────────────── */

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new RangeError('u64 out of range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function encode(discriminator: Uint8Array, args: bigint[]): Buffer {
  const parts = [discriminator, ...args.map(u64le)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}

/**
 * Zip a spec list with its addresses. Throws — loudly, at build time — when the
 * two lengths disagree, because a silently short account list is exactly the
 * defect this module exists to prevent.
 */
function keys(spec: AccountSpec[], addresses: PublicKey[]) {
  if (spec.length !== addresses.length) {
    throw new Error(`account count mismatch: program wants ${spec.length}, builder supplied ${addresses.length}`);
  }
  return spec.map((a, i) => ({
    pubkey: addresses[i]!,
    isSigner: a.s,
    isWritable: a.w,
  }));
}

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/* ──────────────────────────── the builders ──────────────────────────────── */

export interface SwapBaseInputArgs {
  programId: PublicKey;
  payer: PublicKey;
  ammConfig: PublicKey;
  poolState: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  inputTokenMint: PublicKey;
  outputTokenMint: PublicKey;
  observationState: PublicKey;
  amountIn: bigint;
  /**
   * The floor the program enforces (`ExceededSlippage`). Callers must derive it
   * from a quote and a slippage tolerance — never pass 0, which authorises the
   * trade to fill at any price.
   */
  minimumAmountOut: bigint;
}

export function swapBaseInputIx(a: SwapBaseInputArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId,
    keys: keys(SWAP_ACCOUNTS, [
      a.payer, deriveAuthority(a.programId), a.ammConfig, a.poolState,
      a.inputTokenAccount, a.outputTokenAccount, a.inputVault, a.outputVault,
      a.inputTokenProgram, a.outputTokenProgram, a.inputTokenMint, a.outputTokenMint,
      a.observationState,
    ]),
    data: encode(IX_SWAP_BASE_INPUT, [a.amountIn, a.minimumAmountOut]),
  });
}

export interface DepositArgs {
  programId: PublicKey;
  owner: PublicKey;
  poolState: PublicKey;
  ownerLpToken: PublicKey;
  token0Account: PublicKey;
  token1Account: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  vault0Mint: PublicKey;
  vault1Mint: PublicKey;
  lpMint: PublicKey;
  lpTokenAmount: bigint;
  /** Ceilings, from `lpDepositCost` plus tolerance. The program refuses above them. */
  maximumToken0Amount: bigint;
  maximumToken1Amount: bigint;
}

export function depositIx(a: DepositArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId,
    keys: keys(DEPOSIT_ACCOUNTS, [
      a.owner, deriveAuthority(a.programId), a.poolState, a.ownerLpToken,
      a.token0Account, a.token1Account, a.token0Vault, a.token1Vault,
      // Both token programs are passed unconditionally — the program picks per
      // mint, so this is not a place to guess which one the pair uses.
      TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
      a.vault0Mint, a.vault1Mint, a.lpMint,
    ]),
    data: encode(IX_DEPOSIT, [a.lpTokenAmount, a.maximumToken0Amount, a.maximumToken1Amount]),
  });
}

export interface WithdrawArgs extends Omit<DepositArgs, 'maximumToken0Amount' | 'maximumToken1Amount'> {
  /** Floors, from `lpWithdrawValue` minus tolerance. */
  minimumToken0Amount: bigint;
  minimumToken1Amount: bigint;
}

export function withdrawIx(a: WithdrawArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId,
    keys: keys(WITHDRAW_ACCOUNTS, [
      a.owner, deriveAuthority(a.programId), a.poolState, a.ownerLpToken,
      a.token0Account, a.token1Account, a.token0Vault, a.token1Vault,
      TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
      a.vault0Mint, a.vault1Mint, a.lpMint,
      MEMO_PROGRAM_ID,
    ]),
    data: encode(IX_WITHDRAW, [a.lpTokenAmount, a.minimumToken0Amount, a.minimumToken1Amount]),
  });
}

export interface InitializeArgs {
  programId: PublicKey;
  creator: PublicKey;
  ammConfig: PublicKey;
  /** MUST already be byte-sorted — use `sortMints`. */
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  creatorToken0: PublicKey;
  creatorToken1: PublicKey;
  creatorLpToken: PublicKey;
  token0Program: PublicKey;
  token1Program: PublicKey;
  /**
   * The flat pool-creation fee recipient. It is consumed as a WSOL TOKEN
   * ACCOUNT (`sync_native` is called on it), not a wallet — the program pins it
   * by `address = crate::create_pool_fee_reveiver::ID`, so this must be the
   * exact account that constant names.
   */
  createPoolFee: PublicKey;
  initAmount0: bigint;
  initAmount1: bigint;
  /** Unix seconds. 0 = open immediately. */
  openTime: bigint;
}

export function initializeIx(a: InitializeArgs): TransactionInstruction {
  const { token0, token1 } = sortMints(a.token0Mint, a.token1Mint);
  if (!token0.equals(a.token0Mint)) {
    // `initialize` carries `constraint = token_0_mint.key() < token_1_mint.key()`.
    // Refusing here beats a revert the user pays for.
    throw new Error('token0Mint/token1Mint are not byte-sorted — pass them through sortMints first');
  }
  const pool = derivePool(a.programId, a.ammConfig, token0, token1);
  return new TransactionInstruction({
    programId: a.programId,
    keys: keys(INITIALIZE_ACCOUNTS, [
      a.creator, a.ammConfig, deriveAuthority(a.programId), pool,
      token0, token1, deriveLpMint(a.programId, pool),
      a.creatorToken0, a.creatorToken1, a.creatorLpToken,
      deriveVault(a.programId, pool, token0), deriveVault(a.programId, pool, token1),
      a.createPoolFee, deriveObservation(a.programId, pool),
      TOKEN_PROGRAM_ID, a.token0Program, a.token1Program,
      ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY,
    ]),
    data: encode(IX_INITIALIZE, [a.initAmount0, a.initAmount1, a.openTime]),
  });
}

/**
 * The floor to pass as `minimumAmountOut` for a quoted swap.
 *
 * Kept here rather than in a component so there is exactly one place slippage
 * is applied to a number that rides a transaction. `bps` is basis points of
 * tolerance; the result always rounds DOWN, so the floor can only ever be
 * stricter than the tolerance asked for, never looser.
 */
export function minimumOutFor(quotedOut: bigint, slippageBps: number): bigint {
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError('slippageBps must be within [0, 10000]');
  }
  return (quotedOut * BigInt(10_000 - Math.floor(slippageBps))) / 10_000n;
}
