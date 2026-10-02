// What a transaction will do, read back out of its own bytes — and a refusal for
// anything this site would never build.
//
// WHY NOT A PROGRAM ALLOWLIST: allowing "the System program" allows a SOL transfer
// to anyone, and allowing "the Token program" allows a transfer, an approve or an
// authority change to anyone. And cp-swap does not check who owns the swap's
// output account (swap_base_input.rs declares it only `mut`), so a wrong output
// account sends the proceeds to a stranger. So every instruction must match one
// SHAPE this site builds, down to its accounts and arguments, and every account
// that decides where value goes must be the signer's own or read off chain state.
//
// And each KIND of transaction may call only its own programs (PROGRAMS_BY_KIND):
// a launch never reaches the pool program, a pool swap never reaches Token
// Metadata or the launch program, and only a launch reaches Token-2022, for the
// two exact instructions of its $BAYLA plant.
//
// This runs twice: on the transaction before any wallet sees it, and again on
// whatever the wallet hands back. The review screen is built from the steps it
// returns, so what a person reads is what the bytes say.

import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  IX_DISCRIMINATOR,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  poolStatePda,
} from '../curve/program';
import {
  associatedTokenAddress,
  buyIx,
  createLaunchIx,
  migrateToAmmIx,
} from '../curve/ix';
import {
  IX_SWAP_BASE_INPUT,
  deriveAuthority,
  deriveObservation,
  deriveVault,
} from '../../../solana/cpswap/program';
import { CP_CREATE_POOL_FEE_RECEIVER, launchIndexAddress } from './config';
import {
  METAPLEX_TOKEN_METADATA_ID,
  decodeCreateMetadataV3,
  metadataPda,
} from './metaplex';
import {
  BAYLA_DECIMALS,
  BAYLA_MINT,
  PLANT_BURN_RAW,
  PLANT_WORKSHOP_RAW,
  TOKEN_IX_BURN_CHECKED,
  TOKEN_IX_TRANSFER_CHECKED,
  WORKSHOP_BAYLA_ACCOUNT,
  baylaAccountOf,
} from './plant';
import type { IntentContext, IntentStep, TxKind } from './types';

/** Phantom's Lighthouse guard program: assertion-only instructions a wallet may append. */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

/** Solana's fixed legacy mint size. */
const MINT_SPACE = 82n;

export type IntentResult = { ok: true; steps: IntentStep[] } | { ok: false; reason: string };

class Refuse extends Error {}

const refuse = (reason: string): never => {
  throw new Refuse(reason);
};

function u32(d: Uint8Array, o: number): number {
  if (o + 4 > d.length) refuse('an instruction is shorter than its own format');
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
}

function u64(d: Uint8Array, o: number): bigint {
  if (o + 8 > d.length) refuse('an instruction is shorter than its own format');
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function startsWith(d: Uint8Array, disc: Uint8Array): boolean {
  return d.length >= disc.length && sameBytes(d.subarray(0, disc.length), disc);
}

/** Accounts are compared by ADDRESS only: flags are the message header's business, and change on a round trip. */
function sameKeys(ix: TransactionInstruction, ref: TransactionInstruction, allowTrailing?: PublicKey): boolean {
  const extra = ix.keys.length - ref.keys.length;
  if (extra !== 0 && !(extra === 1 && allowTrailing)) return false;
  for (let i = 0; i < ref.keys.length; i++) {
    if (!ix.keys[i]!.pubkey.equals(ref.keys[i]!.pubkey)) return false;
  }
  if (extra === 1) return ix.keys[ix.keys.length - 1]!.pubkey.equals(allowTrailing!);
  return true;
}

function key(ix: TransactionInstruction, i: number): PublicKey {
  const k = ix.keys[i];
  if (!k) return refuse('an instruction is missing an account');
  return k.pubkey;
}

function expectKeyCount(ix: TransactionInstruction, n: number, what: string): void {
  if (ix.keys.length !== n) refuse(`${what} has ${ix.keys.length} accounts, expected ${n}`);
}

// ── per program ──────────────────────────────────────────────────────────────

function computeBudget(ix: TransactionInstruction): IntentStep {
  const d = ix.data;
  if (ix.keys.length !== 0) refuse('a compute-budget instruction names accounts');
  if (d[0] === 2 && d.length === 5) return { kind: 'compute-limit', units: u32(d, 1) };
  if (d[0] === 3 && d.length === 9) return { kind: 'compute-price', microLamports: u64(d, 1) };
  return refuse('a compute-budget instruction other than a unit limit or a unit price');
}

function system(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  const d = ix.data;
  const tag = u32(d, 0);
  if (tag === 0) {
    // CreateAccount { lamports u64, space u64, owner Pubkey }
    if (d.length !== 4 + 8 + 8 + 32) refuse('a create-account instruction of the wrong size');
    expectKeyCount(ix, 2, 'create-account');
    if (!key(ix, 0).equals(ctx.signer)) refuse('an account is created with someone else paying');
    if (!key(ix, 1).equals(ctx.mint)) refuse('an account other than the new token is created');
    if (u64(d, 12) !== MINT_SPACE) refuse('the new token account has the wrong size');
    if (!new PublicKey(d.subarray(20, 52)).equals(TOKEN_PROGRAM_ID)) {
      refuse('the new token account is not owned by the standard token program');
    }
    return { kind: 'create-mint-account', mint: ctx.mint, lamports: u64(d, 4) };
  }
  if (tag === 2) {
    // Transfer { lamports u64 }: ONLY the signer wrapping SOL into their own WSOL account.
    if (d.length !== 12) refuse('a SOL transfer of the wrong size');
    expectKeyCount(ix, 2, 'SOL transfer');
    if (!key(ix, 0).equals(ctx.signer)) refuse('a SOL transfer from someone other than you');
    if (!key(ix, 1).equals(associatedTokenAddress(WSOL_MINT, ctx.signer))) {
      refuse('a SOL transfer to an account that is not your own wrapped-SOL account');
    }
    return { kind: 'wrap-sol', lamports: u64(d, 4) };
  }
  return refuse('a System program instruction this page never builds');
}

function token(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  const d = ix.data;
  const wsolAta = associatedTokenAddress(WSOL_MINT, ctx.signer);
  switch (d[0]) {
    case 20: {
      // InitializeMint2 { decimals u8, mint_authority Pubkey, freeze_authority COption<Pubkey> }
      expectKeyCount(ix, 1, 'initialize-mint');
      if (!key(ix, 0).equals(ctx.mint)) refuse('a different token is initialized');
      if (d.length !== 1 + 1 + 32 + 1 && d.length !== 1 + 1 + 32 + 1 + 32) refuse('initialize-mint of the wrong size');
      if (d[1] !== 6) refuse('the new token does not have 6 decimals');
      if (!new PublicKey(d.subarray(2, 34)).equals(ctx.signer)) refuse('the new token is minted by someone else');
      if (d[34] !== 0) refuse('the new token keeps a freeze authority');
      return { kind: 'init-mint', mint: ctx.mint, decimals: 6 };
    }
    case 17:
      // SyncNative
      expectKeyCount(ix, 1, 'sync wrapped SOL');
      if (d.length !== 1) refuse('sync wrapped SOL of the wrong size');
      if (!key(ix, 0).equals(wsolAta)) refuse('syncs an account that is not your wrapped-SOL account');
      return { kind: 'sync-wsol' };
    case 9:
      // CloseAccount: only the signer's own WSOL account, paid back to the signer.
      expectKeyCount(ix, 3, 'close account');
      if (d.length !== 1) refuse('close-account of the wrong size');
      if (!key(ix, 0).equals(wsolAta)) refuse('closes an account that is not your wrapped-SOL account');
      if (!key(ix, 1).equals(ctx.signer)) refuse('closes an account and pays someone else');
      if (!key(ix, 2).equals(ctx.signer)) refuse('closes an account under someone else’s authority');
      return { kind: 'close-wsol' };
    default:
      // Transfer, Approve, SetAuthority, MintTo, Burn, … — never built here.
      return refuse('a token instruction this page never builds (such as a transfer or an approval)');
  }
}

function ata(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  if (!(ix.data.length === 1 && ix.data[0] === 1)) refuse('an associated-account instruction other than create-if-missing');
  expectKeyCount(ix, 6, 'create token account');
  const [payer, address, owner, mint, sys, tok] = [0, 1, 2, 3, 4, 5].map((i) => key(ix, i)) as [
    PublicKey, PublicKey, PublicKey, PublicKey, PublicKey, PublicKey,
  ];
  if (!payer.equals(ctx.signer) || !owner.equals(ctx.signer)) refuse('creates a token account for someone else');
  if (!(mint.equals(ctx.mint) || mint.equals(WSOL_MINT))) refuse('creates a token account for an unrelated token');
  if (!sys.equals(SYSTEM_PROGRAM_ID) || !tok.equals(TOKEN_PROGRAM_ID)) refuse('creates a token account under the wrong programs');
  if (!address.equals(associatedTokenAddress(mint, owner))) refuse('creates a token account at the wrong address');
  return { kind: 'create-token-account', owner, mint, address };
}

/**
 * Token-2022: the plant, and nothing else. Burn 50,000 $BAYLA from the signer's own
 * $BAYLA account, and send 50,000 from it to the island's Workshop; every account and
 * number pinned, the source derived from the signer. Any other Token-2022 instruction
 * (transfer, approve, authority change, mint, close, ...) is refused.
 */
function t22(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  const d = ix.data;
  const tag = d[0];
  if (tag !== TOKEN_IX_BURN_CHECKED && tag !== TOKEN_IX_TRANSFER_CHECKED) {
    return refuse("a Token-2022 instruction other than the plant's own burn and transfer (such as an approval or another transfer)");
  }
  if (d.length !== 1 + 8 + 1) refuse('a Token-2022 instruction of the wrong size');
  const burn = tag === TOKEN_IX_BURN_CHECKED;
  expectKeyCount(ix, burn ? 3 : 4, burn ? 'the $BAYLA burn' : 'the $BAYLA transfer');
  const from = baylaAccountOf(ctx.signer);
  if (!key(ix, 0).equals(from)) refuse('the plant spends from an account that is not your $BAYLA account');
  if (!key(ix, 1).equals(BAYLA_MINT)) refuse('the plant moves a token other than $BAYLA');
  if (!burn && !key(ix, 2).equals(WORKSHOP_BAYLA_ACCOUNT)) refuse("the plant sends $BAYLA somewhere other than the island's Workshop");
  if (!key(ix, burn ? 2 : 3).equals(ctx.signer)) refuse('the plant is signed by someone other than you');
  const amount = u64(d, 1);
  if (burn && amount !== PLANT_BURN_RAW) refuse('the plant burns a different amount than 50,000 $BAYLA');
  if (!burn && amount !== PLANT_WORKSHOP_RAW) refuse("the plant sends a different amount than 50,000 $BAYLA to the island's Workshop");
  if (d[9] !== BAYLA_DECIMALS) refuse('the plant names the wrong decimals for $BAYLA');
  return burn
    ? { kind: 'plant-burn', account: from, mint: BAYLA_MINT, amount }
    : { kind: 'plant-transfer', from, to: WORKSHOP_BAYLA_ACCOUNT, mint: BAYLA_MINT, amount };
}

function metaplex(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  const args = decodeCreateMetadataV3(ix.data);
  if (!args) refuse('a token-details instruction this page never builds');
  if (args!.isMutable) refuse('the token details could be changed later');
  if (args!.sellerFeeBasisPoints !== 0) refuse('the token details carry a royalty');
  if (ix.keys.length !== 6 && ix.keys.length !== 7) refuse('token details with the wrong accounts');
  if (!key(ix, 0).equals(metadataPda(ctx.mint))) refuse('token details at the wrong address');
  if (!key(ix, 1).equals(ctx.mint)) refuse('token details for a different token');
  for (const i of [2, 3, 4]) if (!key(ix, i).equals(ctx.signer)) refuse('token details controlled by someone else');
  if (!key(ix, 5).equals(SYSTEM_PROGRAM_ID)) refuse('token details with the wrong system program');
  // The optional seventh account is the rent sysvar (metaplex.ts puts it there). Any
  // other account in that slot is not a shape this site builds.
  if (ix.keys.length === 7 && !key(ix, 6).equals(SYSVAR_RENT_PUBKEY)) refuse('token details with an unexpected extra account');
  return { kind: 'create-metadata', mint: ctx.mint, name: args!.name, symbol: args!.symbol, uri: args!.uri };
}

function launch(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  const d = ix.data;
  const ids = { programId: ctx.cfg.programId, cpSwapProgram: ctx.cfg.cpSwapProgram };
  if (sameBytes(d, IX_DISCRIMINATOR.createLaunch)) {
    // The platform reserve is paid inside create_launch to ATA(mint, fee_recipient).
    // `ctx.feeRecipient` is global.fee_recipient as read from chain while preparing,
    // so the treasury token account below is derived from chain state, never taken
    // from the transaction: a transaction naming any other receiver is refused.
    const ref = createLaunchIx({ creator: ctx.signer, mint: ctx.mint, feeRecipient: ctx.feeRecipient }, ids);
    if (!sameKeys(ix, ref, launchIndexAddress(ctx.cfg.programId))) {
      refuse('the launch instruction names the wrong accounts (such as a platform reserve receiver other than the treasury)');
    }
    return {
      kind: 'create-launch',
      mint: ctx.mint,
      feeRecipient: ctx.feeRecipient,
      treasuryToken: associatedTokenAddress(ctx.mint, ctx.feeRecipient),
    };
  }
  const isBuy = startsWith(d, IX_DISCRIMINATOR.buy);
  const isSell = startsWith(d, IX_DISCRIMINATOR.sell);
  if (isBuy || isSell) {
    if (d.length !== 24) refuse('a trade instruction of the wrong size');
    if (!ctx.creator) return refuse('a trade with no creator read off the launch');
    const ref = buyIx(
      { trader: ctx.signer, mint: ctx.mint, feeRecipient: ctx.feeRecipient, creator: ctx.creator },
      0n,
      0n,
      ids,
    );
    if (!sameKeys(ix, ref)) refuse('the trade names the wrong accounts (fee receiver, creator or your token account)');
    const a = u64(d, 8);
    const b = u64(d, 16);
    if (b === 0n) refuse('the trade accepts any price (no minimum)');
    if (a === 0n) refuse('the trade amount is zero');
    return isBuy
      ? { kind: 'curve-buy', mint: ctx.mint, maxLamportsIn: a, minTokensOut: b, creator: ctx.creator, feeRecipient: ctx.feeRecipient }
      : { kind: 'curve-sell', mint: ctx.mint, tokensIn: a, minLamportsOut: b, creator: ctx.creator, feeRecipient: ctx.feeRecipient };
  }
  if (sameBytes(d, IX_DISCRIMINATOR.migrateToAmm)) {
    if (!ctx.creator) return refuse('graduation with no creator read off the launch');
    const ref = migrateToAmmIx(
      {
        payer: ctx.signer,
        creator: ctx.creator,
        feeRecipient: ctx.feeRecipient,
        launchMint: ctx.mint,
        ammConfig: ctx.ammConfig,
        createPoolFee: CP_CREATE_POOL_FEE_RECEIVER,
      },
      ids,
    );
    if (!sameKeys(ix, ref)) refuse('the graduation names the wrong accounts');
    return {
      kind: 'migrate',
      mint: ctx.mint,
      pool: poolStatePda(ctx.mint, ctx.cfg.programId),
      creator: ctx.creator,
      feeRecipient: ctx.feeRecipient,
    };
  }
  // initialize_global, update_global and anything unknown.
  return refuse('a launch-program instruction this page never builds');
}

function cpswap(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  const d = ix.data;
  if (!startsWith(d, IX_SWAP_BASE_INPUT) || d.length !== 24) refuse('a pool instruction other than a swap');
  expectKeyCount(ix, 13, 'pool swap');
  const cp = ctx.cfg.cpSwapProgram;
  const pool = poolStatePda(ctx.mint, ctx.cfg.programId);
  const inMint = key(ix, 10);
  const outMint = key(ix, 11);
  const pair = (m: PublicKey) => m.equals(WSOL_MINT) || m.equals(ctx.mint);
  if (!pair(inMint) || !pair(outMint) || inMint.equals(outMint)) refuse('the swap is not between SOL and this token');
  const checks: Array<[number, PublicKey, string]> = [
    [0, ctx.signer, 'the swap is paid by someone else'],
    [1, deriveAuthority(cp), 'the swap names the wrong pool authority'],
    [2, ctx.ammConfig, 'the swap names the wrong fee settings'],
    [3, pool, 'the swap is against a different pool than this launch graduated into'],
    [4, associatedTokenAddress(inMint, ctx.signer), 'the swap spends from an account that is not yours'],
    [5, associatedTokenAddress(outMint, ctx.signer), 'the swap pays out to an account that is not yours'],
    [6, deriveVault(cp, pool, inMint), 'the swap names the wrong pool vault'],
    [7, deriveVault(cp, pool, outMint), 'the swap names the wrong pool vault'],
    [8, TOKEN_PROGRAM_ID, 'the swap names the wrong token program'],
    [9, TOKEN_PROGRAM_ID, 'the swap names the wrong token program'],
    [12, deriveObservation(cp, pool), 'the swap names the wrong price record'],
  ];
  for (const [i, want, why] of checks) if (!key(ix, i).equals(want)) refuse(why);
  const amountIn = u64(d, 8);
  const minimumAmountOut = u64(d, 16);
  if (amountIn === 0n) refuse('the swap amount is zero');
  if (minimumAmountOut === 0n) refuse('the swap accepts any price (no minimum)');
  return { kind: 'pool-swap', pool, inputMint: inMint, outputMint: outMint, amountIn, minimumAmountOut };
}

// ── the whole transaction ────────────────────────────────────────────────────

type ProgramFamily = 'compute' | 'system' | 'token' | 't22' | 'ata' | 'metadata' | 'launch' | 'pool';

/**
 * The programs each kind of transaction may call at the top level, and nothing else.
 * Inner calls are the called program's business: create_launch itself calls the
 * Associated Token program to open the treasury's token account. Token-2022 (`t22`)
 * is the $BAYLA plant, so only a create may call it.
 */
export const PROGRAMS_BY_KIND: Readonly<Record<TxKind, ReadonlySet<ProgramFamily>>> = {
  create: new Set<ProgramFamily>(['compute', 'system', 'token', 't22', 'ata', 'metadata', 'launch']),
  buy: new Set<ProgramFamily>(['compute', 'ata', 'launch']),
  sell: new Set<ProgramFamily>(['compute', 'ata', 'launch']),
  migrate: new Set<ProgramFamily>(['compute', 'launch']),
  'pool-buy': new Set<ProgramFamily>(['compute', 'system', 'token', 'ata', 'pool']),
  'pool-sell': new Set<ProgramFamily>(['compute', 'system', 'token', 'ata', 'pool']),
};

function familyOf(p: PublicKey, ctx: IntentContext): ProgramFamily | null {
  if (p.equals(ComputeBudgetProgram.programId)) return 'compute';
  if (p.equals(SYSTEM_PROGRAM_ID)) return 'system';
  if (p.equals(TOKEN_PROGRAM_ID)) return 'token';
  if (p.equals(TOKEN_2022_PROGRAM_ID)) return 't22';
  if (p.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return 'ata';
  if (p.equals(METAPLEX_TOKEN_METADATA_ID)) return 'metadata';
  if (p.equals(ctx.cfg.programId)) return 'launch';
  if (p.equals(ctx.cfg.cpSwapProgram)) return 'pool';
  return null;
}

export interface DecodeOptions {
  /**
   * Accept assertion-only instructions a wallet appends (Phantom's Lighthouse). Only
   * for the transaction a wallet HANDS BACK; never for one we built.
   */
  allowWalletGuards?: boolean;
}

/**
 * Decode every instruction into a step, or refuse the transaction with a reason a
 * person can read. Also enforces: at most one unit limit and one unit price, and
 * the priority fee they imply is within `ctx.maxPriorityLamports`.
 */
export function decodeIntent(
  instructions: readonly TransactionInstruction[],
  ctx: IntentContext,
  opts: DecodeOptions = {},
): IntentResult {
  try {
    const steps: IntentStep[] = [];
    const allowed = PROGRAMS_BY_KIND[ctx.kind];
    if (!allowed) refuse('it is not a kind of transaction this page builds');
    for (const ix of instructions) {
      const p = ix.programId;
      const family = familyOf(p, ctx);
      if (family === null) {
        if (opts.allowWalletGuards && p.equals(LIGHTHOUSE_PROGRAM_ID)) continue;
        refuse(`it calls a program this page never uses (${p.toBase58()})`);
      }
      if (!allowed.has(family!)) refuse(`it calls a program this kind of transaction never uses (${p.toBase58()})`);
      if (family === 'compute') steps.push(computeBudget(ix));
      else if (family === 'system') steps.push(system(ix, ctx));
      else if (family === 'token') steps.push(token(ix, ctx));
      else if (family === 't22') steps.push(t22(ix, ctx));
      else if (family === 'ata') steps.push(ata(ix, ctx));
      else if (family === 'metadata') steps.push(metaplex(ix, ctx));
      else if (family === 'launch') steps.push(launch(ix, ctx));
      else steps.push(cpswap(ix, ctx));
    }
    const limits = steps.filter((s) => s.kind === 'compute-limit');
    const prices = steps.filter((s) => s.kind === 'compute-price');
    if (limits.length > 1 || prices.length > 1) refuse('it sets the network fee more than once');
    // Here, not only in the review's summary: a wallet's returned version is re-decoded
    // with this function, and never summarized again.
    const burns = steps.filter((s) => s.kind === 'plant-burn');
    const gives = steps.filter((s) => s.kind === 'plant-transfer');
    if (burns.length > 1 || gives.length > 1) refuse('it plants more than once');
    const limit = computeUnitLimit(instructions, steps);
    const price = prices[0]?.kind === 'compute-price' ? prices[0].microLamports : 0n;
    if (priorityLamports(price, limit) > ctx.maxPriorityLamports) refuse('its priority fee is above this page’s limit');
    return { ok: true, steps };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, reason: `This transaction was blocked because ${e.message}.` };
    return { ok: false, reason: 'This transaction could not be checked, so it was blocked.' };
  }
}

/** The runtime's default unit limit per instruction when a transaction sets none. */
export const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
/** The runtime's per-transaction ceiling. */
export const MAX_UNITS_PER_TRANSACTION = 1_400_000;

/**
 * The unit limit the priority fee is charged on. With a compute-limit instruction,
 * its value. Without one, the runtime's default: 200,000 per instruction (every
 * instruction but the compute-budget ones, counted the old, larger way, so the
 * bound never runs short), capped at 1,400,000. A wallet that strips our limit
 * instruction therefore cannot slip a price past the cap at 200,000 units when the
 * transaction would really pay for up to seven times that.
 */
export function computeUnitLimit(instructions: readonly TransactionInstruction[], steps: readonly IntentStep[]): number {
  const set = steps.find((s) => s.kind === 'compute-limit');
  if (set && set.kind === 'compute-limit') return set.units;
  const counted = instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)).length;
  return Math.min(MAX_UNITS_PER_TRANSACTION, DEFAULT_UNITS_PER_INSTRUCTION * counted);
}

/** Priority fee in lamports: `ceil(price µ-lamports × limit / 1,000,000)`. */
export function priorityLamports(microLamportsPerUnit: bigint, units: number): bigint {
  const n = microLamportsPerUnit * BigInt(units);
  return (n + 999_999n) / 1_000_000n;
}
