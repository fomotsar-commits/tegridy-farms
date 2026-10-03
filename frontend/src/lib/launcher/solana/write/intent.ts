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
// Adding and removing liquidity (`PoolIntent`) are judged against `PoolPins`, the
// pool as it was read and checked while preparing: every account of the pool's
// deposit or withdraw instruction must equal its pin, and the transaction must hold
// exactly one of them. Opening a pool (`lp-create`) is a third PoolIntent kind: its
// one `initialize` is pinned slot by slot, always on the public fee tier (tier 1),
// derived here from the constant. The launch-program kinds (`CurveIntent`) are judged
// exactly as before; their branches below did not change.
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
  IX_DEPOSIT,
  IX_INITIALIZE,
  IX_SWAP_BASE_INPUT,
  IX_WITHDRAW,
  deriveAmmConfig,
  deriveAuthority,
  deriveLpMint,
  deriveObservation,
  derivePool,
  deriveVault,
  publicTierConfig,
  sortMints,
} from '../../../solana/cpswap/program';
import { openingProblem } from '../../../solana/lp/liquidityMath';
import { MEMO_PROGRAM_ID } from '../../../solana/cpswap/ix';
import { CP_CREATE_POOL_FEE_RECEIVER, launchIndexAddress } from './config';
import {
  METAPLEX_TOKEN_METADATA_ID,
  decodeCreateMetadataV3,
  metadataPda,
} from './metaplex';
import { isLpKind } from './lpKinds';
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
import type { CurveIntent, IntentContext, IntentStep, LpKind, PoolIntent, TxKind } from './types';
import { canPair, quoteCoin, type QuoteCoin } from '../../../solana/lp/quotes';

/** Phantom's Lighthouse guard program: assertion-only instructions a wallet may append. */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

/** Solana's fixed legacy mint size. */
const MINT_SPACE = 82n;

export type IntentResult = { ok: true; steps: IntentStep[] } | { ok: false; reason: string };

class Refuse extends Error {}

const refuse = (reason: string): never => {
  throw new Refuse(reason);
};

/** Adding or removing liquidity, or opening a pool, as opposed to a launch-program transaction. */
export function isPoolIntent(c: IntentContext): c is PoolIntent {
  return isLpKind(c.kind);
}

/**
 * The launch-program families take a `CurveIntent` only. `PROGRAMS_BY_KIND` already
 * keeps them out of a liquidity transaction; this makes it a type, too.
 */
function asCurve(c: IntentContext): CurveIntent {
  return isPoolIntent(c) ? refuse('a liquidity transaction reaches a program it never uses') : c;
}

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
    if (isPoolIntent(ctx)) return refuse('this kind of transaction never creates an account');
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
    // A pool paired with USDC or BAYLA takes no SOL, so its transactions wrap none.
    if (isPoolIntent(ctx) && !pinnedQuote(ctx).native) refuse('it wraps SOL, and this pool is not paired with SOL');
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
      if (isPoolIntent(ctx)) return refuse('this kind of transaction never creates a token');
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
      if (isPoolIntent(ctx) && !pinnedQuote(ctx).native) refuse('it wraps SOL, and this pool is not paired with SOL');
      expectKeyCount(ix, 1, 'sync wrapped SOL');
      if (d.length !== 1) refuse('sync wrapped SOL of the wrong size');
      if (!key(ix, 0).equals(wsolAta)) refuse('syncs an account that is not your wrapped-SOL account');
      return { kind: 'sync-wsol' };
    case 9:
      // CloseAccount: only the signer's own WSOL account, paid back to the signer.
      if (isPoolIntent(ctx) && !pinnedQuote(ctx).native) refuse('it unwraps SOL, and this pool is not paired with SOL');
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
  if (isPoolIntent(ctx)) {
    if (ctx.kind === 'lp-create') openingAtaRule(ctx, mint);
    return poolAta(ctx, { address, owner, mint, sys, tok });
  }
  if (!(mint.equals(ctx.mint) || mint.equals(WSOL_MINT))) refuse('creates a token account for an unrelated token');
  if (!sys.equals(SYSTEM_PROGRAM_ID) || !tok.equals(TOKEN_PROGRAM_ID)) refuse('creates a token account under the wrong programs');
  if (!address.equals(associatedTokenAddress(mint, owner))) refuse('creates a token account at the wrong address');
  return { kind: 'create-token-account', owner, mint, address };
}

/**
 * The pool's pairing coin, looked up AGAIN in the site's own list (quotes.ts) by the
 * mint the pins name, and checked against the pins: it must be the row itself, and it
 * must sit on the side the pins say, under the program the pins say. So a pin can never
 * name a coin of its own, and nothing below trusts `pins.quote` for a program or a flag.
 */
function pinnedQuote(ctx: PoolIntent): QuoteCoin {
  const p = ctx.pins;
  const q = quoteCoin(p.quote.mint);
  if (!q || q.program !== p.quote.program || q.native !== p.quote.native || q.decimals !== p.quote.decimals) {
    return refuse('the pool is paired with a coin this site does not build for');
  }
  const [mint, program] = p.quoteIsToken0 ? [p.token0Mint, p.token0Program] : [p.token1Mint, p.token1Program];
  if (mint.toBase58() !== q.mint || program.toBase58() !== q.program) refuse('the pool’s pairing coin is not where the review says it is');
  const [otherMint, otherProgram] = p.quoteIsToken0 ? [p.token1Mint, p.token1Program] : [p.token0Mint, p.token0Program];
  if (!otherMint.equals(p.tokenMint) || !otherProgram.equals(p.tokenProgram)) refuse('the pool’s token is not where the review says it is');
  return q;
}

/**
 * An opening of a SOL pool creates ONLY the signer's wrapped-SOL account. The pool
 * program opens the pool-share account itself (`initialize` creates it, so one made
 * first would make it fail), and the token account must already hold the tokens going
 * in. An opening of a pool paired with USDC or BAYLA creates nothing: the coin's
 * account must already hold the coin going in, too.
 */
function openingAtaRule(ctx: PoolIntent, mint: PublicKey): void {
  const quote = pinnedQuote(ctx);
  if (quote.native && mint.equals(WSOL_MINT)) return;
  if (mint.equals(deriveLpMint(ctx.cfg.cpSwapProgram, ctx.pins.address))) refuse('the pool program opens your pool-share account itself');
  refuse(quote.native ? 'an opening creates only your wrapped-SOL account' : 'an opening of a pool that is not paired with SOL creates no account of yours');
}

/**
 * A liquidity transaction opens the signer's account for the pool's pairing coin (the
 * wrapped-SOL account for a SOL pool), for the pool's shares, or for the pool's token,
 * and nothing else. Each under THAT mint's program: the classic one for the pool
 * shares, the coin's own for the coin (classic for wrapped SOL and USDC, Token-2022 for
 * BAYLA), the pool's recorded program for the token. The program is one of the
 * address's seeds, so an account seeded under the other program is a different address
 * and is refused. A pool not paired with SOL never opens a wrapped-SOL account.
 */
function poolAta(
  ctx: PoolIntent,
  a: { address: PublicKey; owner: PublicKey; mint: PublicKey; sys: PublicKey; tok: PublicKey },
): IntentStep {
  const p = ctx.pins;
  const quote = pinnedQuote(ctx);
  const program = a.mint.equals(p.lpMint)
    ? TOKEN_PROGRAM_ID
    : a.mint.toBase58() === quote.mint
      ? new PublicKey(quote.program)
      : a.mint.equals(p.tokenMint)
        ? p.tokenProgram
        : refuse('creates a token account for an unrelated token');
  if (!a.sys.equals(SYSTEM_PROGRAM_ID) || !a.tok.equals(program)) refuse('creates a token account under the wrong programs');
  if (!a.address.equals(associatedTokenAddress(a.mint, a.owner, program))) refuse('creates a token account at the wrong address');
  return { kind: 'create-token-account', owner: a.owner, mint: a.mint, address: a.address };
}

/**
 * Token-2022: the plant, and nothing else. Burn 50,000 $BAYLA from the signer's own
 * $BAYLA account, and send 50,000 from it to the island's Workshop; every account and
 * number pinned, the source derived from the signer. Any other Token-2022 instruction
 * (transfer, approve, authority change, mint, close, ...) is refused. Takes a
 * `CurveIntent`: no liquidity kind may reach Token-2022 (PROGRAMS_BY_KIND), and the
 * type says so too.
 */
function t22(ix: TransactionInstruction, ctx: CurveIntent): IntentStep {
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

function metaplex(ix: TransactionInstruction, ctx: CurveIntent): IntentStep {
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

function launch(ix: TransactionInstruction, ctx: CurveIntent): IntentStep {
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

/** Takes `never`, so a liquidity kind with no pool instruction below does not compile. */
function noPoolInstructionFor(_ctx: never): never {
  return refuse('it is a liquidity kind this page has no pool instruction for');
}

function cpswap(ix: TransactionInstruction, ctx: IntentContext): IntentStep {
  if (isPoolIntent(ctx)) {
    switch (ctx.kind) {
      case 'lp-deposit':
        return poolDeposit(ix, ctx);
      case 'lp-withdraw':
        return poolWithdraw(ix, ctx);
      case 'lp-create':
        return poolInitialize(ix, ctx);
      default:
        return noPoolInstructionFor(ctx);
    }
  }
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

/** The largest maximum a deposit may carry: u64::MAX itself means "no limit". */
const MAX_DEPOSIT_LIMIT = 0xffff_ffff_ffff_fffen;

/**
 * The slots cp-swap's deposit and withdraw share (deposit.rs, withdraw.rs: the same
 * first 13 accounts). Slot 3, the pool-share account, differs and is checked by each.
 * Slots 4 and 5 are the signer's own accounts under each mint's program: withdraw.rs
 * checks only their MINT, so these pins are all that stops a payout to a stranger.
 */
function poolSlots(ctx: PoolIntent, what: 'deposit' | 'withdrawal'): Array<[number, PublicKey, string]> {
  const p = ctx.pins;
  const mine = (mint: PublicKey, program: PublicKey) => associatedTokenAddress(mint, ctx.signer, program);
  const own = what === 'deposit' ? 'the deposit spends from an account that is not yours' : 'the withdrawal pays out to an account that is not yours';
  return [
    [0, ctx.signer, what === 'deposit' ? 'the deposit is paid by someone else' : 'the withdrawal is signed for by someone else'],
    [1, deriveAuthority(ctx.cfg.cpSwapProgram), `the ${what} names the wrong pool authority`],
    [2, p.address, what === 'deposit' ? 'the deposit goes into a different pool than the one checked' : 'the withdrawal comes out of a different pool than the one checked'],
    [4, mine(p.token0Mint, p.token0Program), own],
    [5, mine(p.token1Mint, p.token1Program), own],
    [6, p.vault0, `the ${what} names the wrong pool vault`],
    [7, p.vault1, `the ${what} names the wrong pool vault`],
    [8, TOKEN_PROGRAM_ID, `the ${what} names the wrong token program`],
    [9, TOKEN_2022_PROGRAM_ID, `the ${what} names the wrong token program`],
    [10, p.token0Mint, `the ${what} names the wrong token`],
    [11, p.token1Mint, `the ${what} names the wrong token`],
    [12, p.lpMint, `the ${what} names the wrong pool-share token`],
  ];
}

/** cp-swap `deposit`: `IX_DEPOSIT ‖ lp u64 ‖ max0 u64 ‖ max1 u64`, 13 accounts. */
function poolDeposit(ix: TransactionInstruction, ctx: PoolIntent): IntentStep {
  const d = ix.data;
  if (!startsWith(d, IX_DEPOSIT) || d.length !== 32) refuse('a pool instruction other than a deposit');
  expectKeyCount(ix, 13, 'pool deposit');
  const p = ctx.pins;
  pinnedQuote(ctx);
  const checks = poolSlots(ctx, 'deposit');
  checks.push([3, associatedTokenAddress(p.lpMint, ctx.signer, TOKEN_PROGRAM_ID), 'the pool shares go to an account that is not yours']);
  for (const [i, want, why] of checks) if (!key(ix, i).equals(want)) refuse(why);
  const lpAmount = u64(d, 8);
  const max0 = u64(d, 16);
  const max1 = u64(d, 24);
  if (lpAmount === 0n) refuse('the deposit asks for zero pool shares');
  if (max0 === 0n || max1 === 0n) refuse('the deposit has a zero limit on one side');
  if (max0 > MAX_DEPOSIT_LIMIT || max1 > MAX_DEPOSIT_LIMIT) refuse('the deposit accepts any price (no limit)');
  return { kind: 'pool-deposit', pool: p.address, lpAmount, max0, max1 };
}

/** cp-swap `withdraw`: `IX_WITHDRAW ‖ lp u64 ‖ min0 u64 ‖ min1 u64`, 14 accounts (the memo program last). */
function poolWithdraw(ix: TransactionInstruction, ctx: PoolIntent): IntentStep {
  const d = ix.data;
  if (!startsWith(d, IX_WITHDRAW) || d.length !== 32) refuse('a pool instruction other than a withdrawal');
  expectKeyCount(ix, 14, 'pool withdrawal');
  const p = ctx.pins;
  pinnedQuote(ctx);
  const checks = poolSlots(ctx, 'withdrawal');
  checks.push(
    [3, p.lpAccount, 'it takes pool shares from an account that is not the one checked'],
    [13, MEMO_PROGRAM_ID, 'the withdrawal names the wrong memo program'],
  );
  for (const [i, want, why] of checks) if (!key(ix, i).equals(want)) refuse(why);
  const lpAmount = u64(d, 8);
  const min0 = u64(d, 16);
  const min1 = u64(d, 24);
  if (lpAmount === 0n) refuse('the withdrawal asks for zero pool shares');
  if (min0 === 0n || min1 === 0n) refuse('the withdrawal accepts any payout (no minimum)');
  return { kind: 'pool-withdraw', pool: p.address, lpAccount: p.lpAccount, lpAmount, min0, min1 };
}

/** cp-swap `initialize`: `IX_INITIALIZE ‖ init_amount_0 u64 ‖ init_amount_1 u64 ‖ open_time u64`. */
const INITIALIZE_DATA_LEN = 32;
/** initialize.rs reads any account past these 20 as a support-mint record, so a 21st is refused. */
const INITIALIZE_KEY_COUNT = 20;

/**
 * cp-swap `initialize`: opening a pool, always on the public fee tier (tier 1).
 *
 * Every one of the 20 accounts is pinned. The tier is derived here from the constant,
 * never from a read or a caller; the pool, its vaults, its share token and its price
 * record are derived from the pool address prepare chose; the creator's accounts are
 * the signer's own under each mint's program. The amounts must clear the site's
 * share rule (`openingProblem`), and the pool must open for trading at once.
 */
function poolInitialize(ix: TransactionInstruction, ctx: PoolIntent): IntentStep {
  const d = ix.data;
  if (!startsWith(d, IX_INITIALIZE) || d.length !== INITIALIZE_DATA_LEN) refuse('a pool instruction other than opening a pool');
  expectKeyCount(ix, INITIALIZE_KEY_COUNT, 'opening a pool');
  const cp = ctx.cfg.cpSwapProgram;
  const p = ctx.pins;
  const tier1 = publicTierConfig(cp);
  // The pair: the token and the pool's pairing coin, the coin under its own program.
  // Only a pair this site reads that way round (BAYLA/SOL is BAYLA priced in SOL).
  const quote = pinnedQuote(ctx);
  const quoteMint = new PublicKey(quote.mint);
  if (!canPair(p.tokenMint.toBase58(), quote)) refuse('the opening pairs this token with a coin this site does not pair it with');
  const { token0: t0, token1: t1 } = sortMints(quoteMint, p.tokenMint);
  const prog = (m: PublicKey) => (m.equals(quoteMint) ? new PublicKey(quote.program) : p.tokenProgram);

  // The launch tier by name, before the generic fee-tier refusal below.
  if (key(ix, 1).equals(deriveAmmConfig(cp, 0))) refuse('the pool would open on the launch tier (fee tier 0), which this site never does');
  // Only the launch program opens a launch pool; this site opens a pool at the standard
  // address or at a fresh key of its own, and the pins must say which, truthfully.
  if (p.origin !== 'standard' && p.origin !== 'other') refuse("the pool's address does not match the review");
  if ((p.origin === 'standard') !== p.address.equals(derivePool(cp, tier1, t0, t1))) refuse("the pool's address does not match the review");

  const lpMint = deriveLpMint(cp, p.address);
  const checks: Array<[number, PublicKey, string]> = [
    [0, ctx.signer, 'the pool is opened and paid for by someone else'],
    [1, tier1, 'the pool would open on a fee tier this site does not use'],
    [2, deriveAuthority(cp), 'the opening names the wrong pool authority'],
    [3, p.address, 'the opening creates a different pool than the one checked'],
    [4, t0, 'the opening pairs different tokens than the review names'],
    [5, t1, 'the opening pairs different tokens than the review names'],
    [6, lpMint, 'the opening names the wrong pool-share token'],
    [7, associatedTokenAddress(t0, ctx.signer, prog(t0)), 'the opening spends from an account that is not yours'],
    [8, associatedTokenAddress(t1, ctx.signer, prog(t1)), 'the opening spends from an account that is not yours'],
    [9, associatedTokenAddress(lpMint, ctx.signer, TOKEN_PROGRAM_ID), 'the pool shares go to an account that is not yours'],
    [10, deriveVault(cp, p.address, t0), 'the opening names the wrong pool vault'],
    [11, deriveVault(cp, p.address, t1), 'the opening names the wrong pool vault'],
    [12, CP_CREATE_POOL_FEE_RECEIVER, "the fee to open a pool goes somewhere other than the pool program's fee account"],
    [13, deriveObservation(cp, p.address), 'the opening names the wrong price record'],
    [14, TOKEN_PROGRAM_ID, 'the opening names the wrong token program'],
    [15, prog(t0), 'the opening names the wrong token program'],
    [16, prog(t1), 'the opening names the wrong token program'],
    [17, ASSOCIATED_TOKEN_PROGRAM_ID, 'the opening names the wrong system program'],
    [18, SYSTEM_PROGRAM_ID, 'the opening names the wrong system program'],
    [19, SYSVAR_RENT_PUBKEY, 'the opening names the wrong system program'],
  ];
  for (const [i, want, why] of checks) if (!key(ix, i).equals(want)) refuse(why);

  const init0 = u64(d, 8);
  const init1 = u64(d, 16);
  const openTime = u64(d, 24);
  const problem = openingProblem(init0, init1);
  if (problem?.problem === 'empty-side') refuse('the pool would open with an empty side');
  if (problem) refuse('the pool would keep more than 0.1% of what you put in forever');
  if (openTime !== 0n) refuse('the pool would open for trading later, not now');
  return { kind: 'pool-create', pool: p.address, ammConfig: tier1, init0, init1 };
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
  // Adding liquidity wraps SOL (System transfer, Token sync and close); taking it out
  // only unwraps, so it never reaches the System program.
  'lp-deposit': new Set<ProgramFamily>(['compute', 'system', 'token', 'ata', 'pool']),
  'lp-withdraw': new Set<ProgramFamily>(['compute', 'token', 'ata', 'pool']),
  // Opening a pool wraps SOL exactly like adding liquidity, and nothing more: the pool
  // program creates the pool's own accounts and the pool-share account itself.
  'lp-create': new Set<ProgramFamily>(['compute', 'system', 'token', 'ata', 'pool']),
};

/**
 * The one pool step each liquidity kind must hold exactly once, and what to say when it
 * does not. A Record, so a new kind cannot fall into another kind's rule.
 */
const OWN_STEP: Readonly<Record<LpKind, { step: IntentStep['kind']; refuse: string }>> = {
  'lp-deposit': { step: 'pool-deposit', refuse: 'it does not hold exactly one deposit into the pool' },
  'lp-withdraw': { step: 'pool-withdraw', refuse: 'it does not hold exactly one withdrawal from the pool' },
  'lp-create': { step: 'pool-create', refuse: 'it does not open exactly one pool' },
};

function familyOf(p: PublicKey, ctx: IntentContext): ProgramFamily | null {
  if (p.equals(ComputeBudgetProgram.programId)) return 'compute';
  if (p.equals(SYSTEM_PROGRAM_ID)) return 'system';
  if (p.equals(TOKEN_PROGRAM_ID)) return 'token';
  // Token-2022 is a family only for the launch-program kinds (it is the create's plant,
  // and PROGRAMS_BY_KIND refuses it in every other curve kind). A liquidity transaction
  // never calls it at the top level, so to one it is a program this page never uses.
  if (p.equals(TOKEN_2022_PROGRAM_ID)) return isPoolIntent(ctx) ? null : 't22';
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
      else if (family === 't22') steps.push(t22(ix, asCurve(ctx)));
      else if (family === 'ata') steps.push(ata(ix, ctx));
      else if (family === 'metadata') steps.push(metaplex(ix, asCurve(ctx)));
      else if (family === 'launch') steps.push(launch(ix, asCurve(ctx)));
      else steps.push(cpswap(ix, ctx));
    }
    if (isPoolIntent(ctx)) {
      // One liquidity change per transaction, of the kind's own type: the review
      // shows one, and the balance check is sized for one.
      const own = OWN_STEP[ctx.kind];
      if (steps.filter((s) => s.kind === own.step).length !== 1) refuse(own.refuse);
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
