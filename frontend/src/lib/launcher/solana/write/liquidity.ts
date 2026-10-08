// Adding and removing liquidity in one of our cp-swap pools (spec sections 3.1-3.10).
//
// Every press of Review builds from scratch, in a fixed order:
//
//   1. ONE fresh read of the 13 accounts the maths needs (the pool, both vaults, the
//      LP mint, the price record, the clock, the token mint and its name record, the
//      wallet, its token account under each token program, its wrapped-SOL account
//      and its pool-share account), so the pool's lp_supply, its fee counters and
//      its vault balances all come from ONE slot. Re-running the finder would read
//      the pool and then its vaults in two rounds, and a deposit landing between
//      them would loosen the bounds (spec D5);
//   2. the pool is checked to be the pool: owned by our pool program, this token paired
//      with the pairing coin the caller named (SOL, USDC or BAYLA: quotes.ts), and
//      each vault, the LP mint and the price record equal to BOTH the derivation from
//      its address and its own record (`poolPins`);
//   3. a deposit runs stage 1's own deposit check again (`assessPool`, with a fresh
//      outside price and, when Jupiter has no route, a fresh read of the token's launch
//      pool) and must hear 'allowed'. 'allowed' may carry warnings (a price
//      off the market, no market price at all, a token that copies a name or can be
//      frozen): they go on the summary, with the estimated loss, for the review to
//      say. A withdrawal never runs that check (the leave rule, spec 3.7: only the
//      pool program's own rules, the network's, and "the money must go to your own
//      account" may refuse it);
//   4. the wallet's accounts are checked (`accountCheck`);
//   5. the bounds come from liquidityMath.ts: a deposit's maxima are never 0 and never
//      u64::MAX, a withdrawal's minima never below 1;
//   6. the transaction goes through `buildAndSimulate` like every other kind: decoded
//      back out of its bytes against the pins, simulated twice, and its balance
//      changes compared with what the review says.
//
// The pool instructions are built from `PoolPins` only (`depositIx` / `withdrawIx`),
// so a caller cannot hand-type a vault. Nothing here signs or sends.
//
// THE PAIRING COIN'S SIDE. SOL goes through the signer's wrapped-SOL account, opened,
// funded and closed around the pool instruction (wsol.ts), exactly as it always has.
// USDC and BAYLA are plain token accounts: nothing is wrapped, a deposit spends from the
// signer's own account for the coin (which must exist and hold it), and a withdrawal
// pays into it (opened with create-if-missing, under the coin's own token program).

import { Buffer } from 'buffer';
import { createAssociatedTokenAccountIdempotentInstruction, getCpiGuard, getMemoTransfer, unpackAccount } from '@solana/spl-token';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, poolStatePda } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatSol, formatTokenAmount } from '../curve/format';
import {
  decodePoolState,
  deriveLpMint,
  deriveObservation,
  deriveVault,
  sortMints,
  swapEnabled,
  withdrawEnabled,
  type PoolStateView,
} from '../../../solana/cpswap/program';
import { depositIx, withdrawIx } from '../../../solana/cpswap/ix';
import type { RawAccount } from '../../../solana/lp/accounts';
import { isPlanProblem, planDeposit, planWithdraw, solSetAside, spendableSol, type PlanProblem } from '../../../solana/lp/liquidityMath';
import { estimatedLoss } from '../../../solana/lp/opening';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { CLOCK_SYSVAR, chainTimeOf, poolViewFrom, type PoolView } from '../../../solana/lp/poolFinder';
import { REFERENCE_NAME, assessPool, formatWhen, type PriceCheck } from '../../../solana/lp/poolHealth';
import { QUOTE_COINS_OR, canPair, quoteCoin, type QuoteCoin } from '../../../solana/lp/quotes';
import { tokenAccountSize } from '../../../solana/lp/tokenAccountSize';
import { BUILDABLE_EXTENSIONS, classifyToken, decodeMintAccount, extensionPlain, type TokenSafety } from '../../../solana/lp/tokenSafety';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { metadataPda } from './metaplex';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import { slippageProblem } from './trade';
import type { CurveWriteConfig, IntentStep, LpOpenGate, PoolPins, Prepared, PriceGap, TxSummary, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, opened, syncCredit, wrapIxs, wsolPlanFrom } from './wsol';

// ── copy (spec 3.9) ──────────────────────────────────────────────────────────

const sol = (lamports: bigint) => `${formatSol(lamports, 9)} SOL`;
const tokens = (raw: bigint, decimals: number) => `${formatTokenAmount(raw, decimals, decimals).text} tokens`;
const shares = (raw: bigint, decimals: number) => formatTokenAmount(raw, decimals, decimals).text;
/** An amount of a pool's pairing coin, exact, in that coin's own decimals. SOL is `sol`, to the character. */
const coin = (raw: bigint, q: QuoteCoin) => (q.native ? sol(raw) : `${formatTokenAmount(raw, q.decimals, q.decimals).text} ${q.symbol}`);

export const LP_COPY = {
  depositPaused: 'Adding liquidity from this site is paused right now. Removing it still works.',
  depositPoolUnread: 'We could not read the pool just now, so nothing was built. Try again in a moment.',
  withdrawPoolUnread: 'We could not read the pool just now, so we could not build the withdrawal. Your pool shares are safe in your wallet. Try again.',
  poolChanged: (field: string) => `This pool no longer matches what the page read (${field}). Read the pools again.`,
  notThisPair: (symbol: string) => `This pool does not pair this token with ${symbol}.`,
  notAPairingCoin: `This site builds for pools paired with ${QUOTE_COINS_OR} only.`,
  coinChanged: (symbol: string, what: string) => `${symbol}'s own token no longer matches what this site knows (${what}), so nothing was built.`,
  noCoinAccount: (symbol: string, address: string) => `You hold no ${symbol} in your main account for it (${address}).`,
  needSol: (need: string, have: string) =>
    `Your wallet needs about ${need} for the network fee and the account deposits, and has ${have}. Nothing was built.`,
  // What this site does not do, and why: never that the token is "blocked" (owner ruling 2026-10-07).
  tokenBlocked: (reason: string) => `This site does not add to pools for this token: ${reason}`,
  tokenUnread: 'We could not read the token just now, so we did not build the deposit. Try again in a moment.',
  gateSaysNo: (reasons: string[]) => `We did not build this deposit: ${reasons.join(' ')}`,
  noTokenAccount: (address: string) => `You hold none of this token in your main account for it (${address}).`,
  overBalance: (need: string, have: string) => `This needs up to ${need} and your wallet has ${have}.`,
  rentBand: (most: string) => `That would leave your wallet with too little SOL to stay open on the network. The most you can add from this wallet is ${most}.`,
  tooSmallDeposit: (atLeast: string | null) =>
    atLeast ? `Too small: at this pool's size one side would round to zero. Add at least ${atLeast}.` : "Too small: at this pool's size one side would round to zero. Add a larger amount.",
  moved: (now: string, shown: string) =>
    `The pool's price moved since these amounts were worked out: this now needs up to ${now} on the other side, not ${shown}. Check the new amounts and press Review again.`,
  foreignOwner: (address: string, owner: string) => `Your account at ${address} now belongs to another wallet (${owner}). Using it would hand the tokens over.`,
  // `issuer`: who froze it. The token's issuer for the token's account; a pairing coin's own
  // issuer for the visitor's account for that coin (USDC's, not the token's).
  frozenSource: (what: string, issuer = "the token's issuer") => `Your ${what} account is frozen by ${issuer}, so nothing can move out of it.`,
  frozenDestination: (what: string, issuer = "the token's issuer") => `Your ${what} account is frozen by ${issuer}, so nothing can be paid into it.`,
  cpiGuard: 'Your account for this token has CPI Guard switched on, which stops a pool taking tokens from it. Switch it off in your wallet, then try again.',
  memosRequired: 'Your account for this token only accepts transfers that carry a memo, and the pool cannot add one. Switch off required memos in your wallet, then try again.',
  // The same two rules, said of the visitor's own account for a pairing coin (BAYLA sits
  // under Token-2022): the coin is named, because "this token" there means the other side.
  cpiGuardCoin: (symbol: string) =>
    `Your ${symbol} account has CPI Guard switched on, which stops a pool taking ${symbol} from it. Switch it off in your wallet, then try again.`,
  memosRequiredCoin: (symbol: string) =>
    `Your ${symbol} account only accepts transfers that carry a memo, and the pool cannot add one. Switch off required memos in your wallet, then try again.`,
  delegatedDestination: (spender: string, amount: string, what: string, address: string) =>
    `An approved spender (${spender}) can move up to ${amount} out of your ${what} account (${address}), and this would pay into it. Revoke that approval in your wallet, then try again.`,
  // The same account on the way IN (a deposit or an opening spends from it). Nothing is
  // refused: a spender on a source does not endanger what goes into the pool. But the way
  // out pays into this account and is refused while the approval stands, so it is said now.
  delegatedSource: (spender: string, amount: string, what: string, address: string) =>
    `An approved spender (${spender}) can move up to ${amount} out of your ${what} account (${address}). This site will not pay a withdrawal into that account until you revoke that approval.`,
  closeAuthorityNotice: (authority: string, what: string) => `${authority} can close your ${what} account once it is empty.`,
  notUsable: (what: string, address: string) => `The account at ${address} is not a ${what} account this site can use, so nothing was built.`,
  withdrawBit:
    "Withdrawals are switched off on this pool by the pool program's admin (the team's vault). Only the vault can switch them back on. Your pool shares stay in your wallet.",
  // `who`: on a pool paired with a coin whose issuer can freeze (USDC), the frozen vault may be the coin's.
  vaultFrozen: (who = "The token's issuer") =>
    `${who} has frozen one of this pool's vaults, so nothing can move in or out, for anyone. That is the issuer's doing, not the pool program's.`,
  cannotBuild: (why: string) =>
    `This site cannot build a withdrawal for this token yet (${why}). The pool program still lets you withdraw with any other tool that can build its withdrawals. Your pool shares stay in your wallet.`,
  shareChanged: 'Your pool-share account now holds fewer shares than this would take out, or is no longer yours. Read your positions again.',
  tooSmallWithdraw: 'Too small: one side would round to zero. Take out a larger share, or all of it.',
  dustRemainder: (n: string) => `That would leave ${n} pool shares, too few to ever take out at this pool's size. Take out all of it, or less.`,
  badPercent: 'Enter a percent from 0.01 to 100.',
  swapsOff: 'Swaps on this pool are switched off. That does not stop you taking your liquidity out.',
  swapsBlocked: (when: string) => `Swaps on this pool are blocked until ${when}. That does not stop you taking your liquidity out.`,
  tokenBlockedInform: (reason: string) => `This site does not take new deposits of this token (${reason}). You can still take your liquidity out.`,
  // The estimated loss when a price is off, for a deposit and for an opening. `back` is
  // what the price would move back to. It is an upper bound and an estimate, and says so.
  priceGapLoss: (loss: string | null, back: string) =>
    loss === null
      ? `What a move back to ${back} would cost you at these amounts could not be worked out.`
      : `At these amounts, a move back to ${back} would take up to about ${loss} of what you put in. That is an estimate.`,
} as const;

// ── the single read ──────────────────────────────────────────────────────────

/** What prepare needs that the outside world answers: the outside price. `LpReaders` satisfies it. */
export interface LpPrepareReads {
  outsidePrice(mint: string, decimals: number): Promise<OutsidePrice>;
}

export interface WriteSnapshot {
  /** Stage 1's shape, so `assessPool` runs unchanged. */
  view: PoolView;
  chainNow: bigint | null;
  mint: RawAccount;
  metaplex: RawAccount | null;
  signerLamports: bigint;
  /** The signer's associated account for the token, under the pool's token program. */
  tokenAccount: { address: PublicKey; account: RawAccount | null };
  /** The pool's pairing coin, as the caller named it and the pool confirmed it. */
  quote: QuoteCoin;
  /**
   * The signer's account for the pairing coin: the wrapped-SOL account for SOL, else the
   * associated account under the coin's own token program.
   */
  quoteAccount: { address: PublicKey; account: RawAccount | null };
  /** The pairing coin's mint, read in the same slot. Null for SOL (the native mint is not read). */
  quoteMint: RawAccount | null;
  /** Deposit: the signer's LP associated account. Withdraw: the pool-share account given. */
  lp: { address: PublicKey; account: RawAccount | null };
  /**
   * Read in the second round, with the pool's own config account. `tokenAccountForMint`
   * is the rent of a token account for this mint (D20); null when this site cannot
   * size one (a Token-2022 extension it does not know), which only a withdrawal into
   * a missing account needs, and D21 refuses that first. `quoteAccount` is the same for
   * the pairing coin's account (165 for SOL and USDC, 170 for BAYLA).
   */
  rents: { walletFloor: bigint; tokenAccount165: bigint; tokenAccountForMint: bigint | null; quoteAccount: bigint | null };
}

/** The answer when the network could not be read: each prepare says it in its own words. */
export const POOL_READ_FAILED = 'the pool could not be read';

export function toRaw(keys: PublicKey[], infos: unknown): (RawAccount | null)[] {
  if (!Array.isArray(infos) || infos.length !== keys.length) throw new Error('the account read returned the wrong number of accounts');
  return infos.map((info, i) => {
    if (info === null || info === undefined) return null;
    const a = info as { owner?: unknown; data?: unknown; lamports?: unknown };
    if (!(a.owner instanceof PublicKey) || !(a.data instanceof Uint8Array) || typeof a.lamports !== 'number') {
      throw new Error('the account read returned an account of the wrong shape');
    }
    return { address: keys[i]!.toBase58(), owner: a.owner.toBase58(), data: new Uint8Array(a.data), lamports: a.lamports };
  });
}

export function rentOf(v: unknown): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error('the rent read was not a number');
  return BigInt(v);
}

/**
 * Is this decoded pool the pool at `address` it must be: `tokenMint` paired with
 * `quote`? Its mints exactly {the coin's mint, `tokenMint`}, read the way round this
 * site reads every pool (`canPair`: BAYLA/SOL is BAYLA priced in SOL, never the other
 * way); the coin's side under the coin's own token program with the coin's own decimals
 * (so the Token-2022 native mint is never "SOL", and a look-alike USDC under another
 * program is never USDC); the token under the classic program or Token-2022; and each
 * vault, the LP mint and the price record equal to the derivation from `address`. A
 * string says what differs.
 */
function poolProblem(cp: PublicKey, address: PublicKey, pool: PoolStateView, tokenMint: PublicKey, quote: QuoteCoin): string | null {
  const tok = tokenMint.toBase58();
  if (!canPair(tok, quote)) return LP_COPY.notThisPair(quote.symbol);
  const solIs0 = pool.token0Mint === quote.mint;
  if (!((solIs0 && pool.token1Mint === tok) || (pool.token1Mint === quote.mint && pool.token0Mint === tok))) return LP_COPY.notThisPair(quote.symbol);
  const solProgram = solIs0 ? pool.token0Program : pool.token1Program;
  const tokProgram = solIs0 ? pool.token1Program : pool.token0Program;
  if (solProgram !== quote.program) {
    return LP_COPY.poolChanged(quote.native ? 'its SOL side is not under the classic token program' : `its ${quote.symbol} side is not under ${quote.symbol}'s own token program`);
  }
  if ((solIs0 ? pool.mint0Decimals : pool.mint1Decimals) !== quote.decimals) return LP_COPY.poolChanged(`its ${quote.symbol} side does not have ${quote.symbol}'s decimals`);
  if (tokProgram !== TOKEN_PROGRAM_ID.toBase58() && tokProgram !== TOKEN_2022_PROGRAM_ID.toBase58()) {
    return LP_COPY.poolChanged('its token sits under a program this site does not know');
  }
  const derived: Array<[string, PublicKey, string]> = [
    [pool.token0Vault, deriveVault(cp, address, new PublicKey(pool.token0Mint)), 'a pool vault'],
    [pool.token1Vault, deriveVault(cp, address, new PublicKey(pool.token1Mint)), 'a pool vault'],
    [pool.lpMint, deriveLpMint(cp, address), 'its pool-share token'],
    [pool.observationKey, deriveObservation(cp, address), 'its price record'],
  ];
  for (const [recorded, want, what] of derived) if (recorded !== want.toBase58()) return LP_COPY.poolChanged(`${what} is not the one its address gives`);
  return null;
}

// The size of a token account for a mint (D20) lives in solana/lp/tokenAccountSize.ts:
// the page's wallet read sizes the pairing coin's account by the same rule, and the page
// does not import this file.
export { tokenAccountSize };

/**
 * The one fresh read (3.1 step 2-4, 3.2 step 2-4). Round 1: ONE getMultipleAccountsInfo
 * of the 13 maths keys (14 for a pool paired with USDC or BAYLA: the coin's own mint is
 * read too, and must be the mint this site knows). Round 2, together: the pool's own
 * config account (display, and assessPool's "fee settings unread" rule; never the
 * maths) and the rents.
 *
 * `quote` is the pairing coin the CALLER says the pool has (the page's copy). It only
 * decides which addresses are read; the pool as read must then pair `tokenMint` with
 * exactly that coin (`poolProblem`), or nothing is built.
 */
export async function readPoolForWrite(
  rpc: WriteRpc,
  cfg: CurveWriteConfig,
  a: { pool: PublicKey; tokenMint: PublicKey; quote: QuoteCoin; owner: PublicKey; lpAccount?: PublicKey },
): Promise<WriteSnapshot | string> {
  const cp = cfg.cpSwapProgram;
  const quote = a.quote;
  const quoteMintKey = new PublicKey(quote.mint);
  const { token0, token1 } = sortMints(quoteMintKey, a.tokenMint);
  const lpMintKey = deriveLpMint(cp, a.pool);
  const ata = (m: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID) => associatedTokenAddress(m, a.owner, program);
  // SOL: the wrapped-SOL account (the same address as ever). Any other coin: the
  // signer's account for it, under the coin's own program.
  const wsolAddress = ata(quoteMintKey, new PublicKey(quote.program));
  const lpAddress = a.lpAccount ?? ata(lpMintKey);
  const keys = [
    a.pool,
    deriveVault(cp, a.pool, token0),
    deriveVault(cp, a.pool, token1),
    lpMintKey,
    deriveObservation(cp, a.pool),
    new PublicKey(CLOCK_SYSVAR),
    a.tokenMint,
    metadataPda(a.tokenMint),
    a.owner,
    ata(a.tokenMint, TOKEN_PROGRAM_ID),
    ata(a.tokenMint, TOKEN_2022_PROGRAM_ID),
    wsolAddress,
    lpAddress,
    // The coin's own mint, for a coin that is not SOL. Last, so the 13 before it are the
    // keys a SOL pool has always read, in the same order.
    ...(quote.native ? [] : [quoteMintKey]),
  ];
  let accs: (RawAccount | null)[];
  try {
    accs = toRaw(keys, await rpc.getMultipleAccountsInfo(keys, 'confirmed'));
  } catch {
    return POOL_READ_FAILED;
  }
  const [poolAcc, v0, v1, , obsAcc, clockAcc, mintAcc, metaAcc, ownerAcc, ataClassic, ata2022, wsolAcc, lpAcc, quoteMintAcc] = accs;

  // The pool is the pool.
  if (!poolAcc) return LP_COPY.poolChanged('the pool account is gone');
  if (poolAcc.owner !== cp.toBase58()) return LP_COPY.poolChanged('the pool account is not owned by the pool program');
  const pool = decodePoolState(a.pool.toBase58(), poolAcc.data);
  if (!pool) return LP_COPY.poolChanged('the pool account does not decode');
  const structural = poolProblem(cp, a.pool, pool, a.tokenMint, quote);
  if (structural) return structural;
  if (!mintAcc) return LP_COPY.poolChanged('its token mint is missing');
  const solIs0 = pool.token0Mint === quote.mint;
  const tokenProgram = solIs0 ? pool.token1Program : pool.token0Program;

  // The coin's own mint is the one this site knows: its program and its decimals, read
  // now. (For SOL the pool's own record was checked above; the native mint is not read.)
  const quoteMint = quote.native ? null : quoteMintAcc ?? null;
  if (!quote.native) {
    if (!quoteMint) return LP_COPY.coinChanged(quote.symbol, 'its mint is missing');
    if (quoteMint.owner !== quote.program) return LP_COPY.coinChanged(quote.symbol, 'it sits under another token program');
    if (quoteMint.data.length < 82 || quoteMint.data[44] !== quote.decimals) return LP_COPY.coinChanged(quote.symbol, 'its decimals differ');
  }

  // Round 2.
  const size = tokenAccountSize(mintAcc);
  // SOL's account is a classic one (165). Another coin's is sized from its own mint.
  const quoteSize = quoteMint ? tokenAccountSize(quoteMint) : 165;
  let config: RawAccount | null;
  let rents: WriteSnapshot['rents'];
  try {
    const [cfgInfo, r0, r165, rMint, rQuote] = await Promise.all([
      // Display only, and "unread" is an answer here: a failed read is no account.
      rpc.getAccountInfo(new PublicKey(pool.ammConfig), 'confirmed').catch(() => null),
      rpc.getMinimumBalanceForRentExemption(0),
      rpc.getMinimumBalanceForRentExemption(165),
      typeof size === 'number' ? rpc.getMinimumBalanceForRentExemption(size) : Promise.resolve(null),
      // 165 is already read above; only a coin with a larger account costs another read.
      typeof quoteSize === 'number' && quoteSize !== 165 ? rpc.getMinimumBalanceForRentExemption(quoteSize) : Promise.resolve(null),
    ]);
    config = cfgInfo ? toRaw([new PublicKey(pool.ammConfig)], [cfgInfo])[0]! : null;
    const quoteAccountRent = typeof quoteSize !== 'number' ? null : quoteSize === 165 ? rentOf(r165) : rQuote === null ? null : rentOf(rQuote);
    rents = { walletFloor: rentOf(r0), tokenAccount165: rentOf(r165), tokenAccountForMint: rMint === null ? null : rentOf(rMint), quoteAccount: quoteAccountRent };
  } catch {
    return POOL_READ_FAILED;
  }

  const entry = poolViewFrom({
    address: a.pool.toBase58(),
    pool: poolAcc,
    vault0: v0 ?? null,
    vault1: v1 ?? null,
    config,
    observation: obsAcc ?? null,
    opts: { programId: cp, launchProgramId: cfg.programId },
  });
  if (entry.kind === 'other-pair') return LP_COPY.notThisPair(quote.symbol);
  if (entry.kind !== 'pool') return LP_COPY.poolChanged('detail' in entry ? entry.detail : 'the pool account is gone');
  // The finder's own reading of the pool must be the one this was asked to build for.
  if (entry.view.quote !== quote || entry.view.tokenMint !== a.tokenMint.toBase58()) return LP_COPY.notThisPair(quote.symbol);

  const tokenAddress = ata(a.tokenMint, new PublicKey(tokenProgram));
  return {
    view: entry.view,
    chainNow: chainTimeOf(clockAcc ?? null),
    mint: mintAcc,
    metaplex: metaAcc ?? null,
    signerLamports: BigInt(ownerAcc?.lamports ?? 0),
    // The wallet's own three: an address that only holds SOL someone sent it is no account (`opened`).
    tokenAccount: { address: tokenAddress, account: opened(tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? ata2022 : ataClassic) },
    quote,
    quoteAccount: { address: wsolAddress, account: opened(wsolAcc) },
    quoteMint,
    lp: { address: lpAddress, account: opened(lpAcc) },
    rents,
  };
}

/**
 * The price check of `tokenMint`'s launch pool, from ONE fresh read of the pool, its two
 * vaults, its price record and the clock: what a deposit into the token's OTHER pools is
 * compared with when Jupiter has no route (poolHealth.ts `launchReference`). Null is "no
 * reference": no launch pool, a failed read, or accounts that are not the ones its
 * address gives. Never a guess, and never a refusal: the deposit is then "no market".
 */
async function readLaunchPoolPrice(
  rpc: WriteRpc,
  cfg: CurveWriteConfig,
  a: { tokenMint: PublicKey; decimals: number; outside: OutsidePrice; safety: TokenSafety },
): Promise<PriceCheck | null> {
  const cp = cfg.cpSwapProgram;
  const address = poolStatePda(a.tokenMint, cfg.programId);
  // A launch pool pairs its token with SOL: the launch program opens no other kind.
  const { token0, token1 } = sortMints(WSOL_MINT, a.tokenMint);
  const keys = [address, deriveVault(cp, address, token0), deriveVault(cp, address, token1), deriveObservation(cp, address), new PublicKey(CLOCK_SYSVAR)];
  let accs: (RawAccount | null)[];
  try {
    accs = toRaw(keys, await rpc.getMultipleAccountsInfo(keys, 'confirmed'));
  } catch {
    return null;
  }
  const [pool, vault0, vault1, observation, clock] = accs;
  // Its fee settings are not read: they decide nothing about its price.
  const entry = poolViewFrom({
    address: address.toBase58(),
    pool: pool ?? null,
    vault0: vault0 ?? null,
    vault1: vault1 ?? null,
    config: null,
    observation: observation ?? null,
    opts: { programId: cp, launchProgramId: cfg.programId },
  });
  if (entry.kind !== 'pool' || entry.view.origin !== 'launch-pool' || entry.view.tokenMint !== a.tokenMint.toBase58()) return null;
  // The vaults and the record read above are the ones the pool itself names.
  if (poolProblem(cp, address, entry.view.snapshot.pool, a.tokenMint, entry.view.quote) !== null) return null;
  return assessPool({ view: entry.view, tokenDecimals: a.decimals, chainNow: chainTimeOf(clock ?? null), outside: a.outside, safety: a.safety }).price;
}

/**
 * The pool, pinned. Built ONLY from a prepare-time read: each vault, the LP mint and
 * the price record must equal both the derivation from the pool address and the
 * pool's own record. A string = the pool is not one this site writes to.
 */
export function poolPins(cfg: CurveWriteConfig, view: PoolView, a: { tokenMint: PublicKey; lpAccount: PublicKey }): PoolPins | string {
  const address = new PublicKey(view.address);
  const p = view.snapshot.pool;
  const problem = poolProblem(cfg.cpSwapProgram, address, p, a.tokenMint, view.quote);
  if (problem) return problem;
  const quoteIsToken0 = p.token0Mint === view.quote.mint;
  return {
    address,
    ammConfig: new PublicKey(p.ammConfig),
    origin: view.origin,
    token0Mint: new PublicKey(p.token0Mint),
    token1Mint: new PublicKey(p.token1Mint),
    token0Program: new PublicKey(p.token0Program),
    token1Program: new PublicKey(p.token1Program),
    vault0: new PublicKey(p.token0Vault),
    vault1: new PublicKey(p.token1Vault),
    lpMint: new PublicKey(p.lpMint),
    observation: new PublicKey(p.observationKey),
    tokenMint: a.tokenMint,
    tokenProgram: new PublicKey(quoteIsToken0 ? p.token1Program : p.token0Program),
    quote: view.quote,
    quoteIsToken0,
    lpAccount: a.lpAccount,
  };
}

// ── the account rules (3.10) ─────────────────────────────────────────────────

/** SPL token account (both programs): mint 0, owner 32, amount 64, delegate 72, state 108, delegated 121, close authority 129. */
function baseAccount(data: Uint8Array) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opt = (at: number) => (v.getUint32(at, true) === 1 ? new PublicKey(data.subarray(at + 4, at + 36)) : null);
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: v.getBigUint64(64, true),
    delegate: opt(72),
    state: data[108],
    delegatedAmount: v.getBigUint64(121, true),
    closeAuthority: opt(129),
  };
}

function amountOf(acc: RawAccount | null): bigint {
  return acc && acc.data.length >= 72 ? new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigUint64(64, true) : 0n;
}

/**
 * A wallet account a transaction spends from (`source`) or pays into (`destination`).
 * It must be owned by the expected token program, hold the expected mint, belong to
 * the signer (or the refusal names its owner: an associated account's owner can be
 * reassigned, which is how drainers work), and not be frozen. Token-2022: a source
 * must not have CPI Guard locking transfers, and a destination must not require
 * memos. A destination with an approved spender who can still move something is
 * refused (what arrives would not be only yours); one a stranger can close once it
 * is empty is a notice. Wrapped SOL's spender and close authority: see wsolPlanFrom.
 * An absent account is not refused here; the caller decides what absence means. An
 * address that only holds SOL someone sent it is absent too (`opened`, wsol.ts).
 *
 * A SOURCE with an approved spender is not refused, and is a notice: a deposit and an
 * opening spend from the same accounts a withdrawal later pays into, so the wallet is
 * told on the way in what will refuse it on the way out (review, 2026-10-04).
 *
 * `coin`: the account is the visitor's own account for a pairing coin that is not SOL
 * (`coinAccount`). Its refusals name that coin and its issuer, never "this token".
 */
export interface AccountWant {
  owner: PublicKey;
  mint: PublicKey;
  program: PublicKey;
  use: 'source' | 'destination';
  what: string;
  decimals?: number;
  coin?: boolean;
}

/**
 * What `accountCheck` is asked about the signer's own account for a pool's pairing coin:
 * the wrapped-SOL account for SOL, else the coin's own account, named by its symbol. One
 * place, so the deposit, the opening and the withdrawal ask the same question.
 */
export function coinAccount(owner: PublicKey, quote: QuoteCoin, use: AccountWant['use']): AccountWant {
  return {
    owner,
    mint: new PublicKey(quote.mint),
    program: new PublicKey(quote.program),
    use,
    what: quote.native ? 'wrapped SOL' : quote.symbol,
    decimals: quote.decimals,
    coin: !quote.native,
  };
}

export function accountCheck(read: RawAccount | null, want: AccountWant): { refuse?: string; notices: string[] } {
  const acc = opened(read);
  if (!acc) return { notices: [] };
  if (acc.owner !== want.program.toBase58() || acc.data.length < 165) return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
  const b = baseAccount(acc.data);
  if (!b.mint.equals(want.mint)) return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
  if (!b.owner.equals(want.owner)) return { refuse: LP_COPY.foreignOwner(acc.address, b.owner.toBase58()), notices: [] };
  if (b.state === 2) {
    // A coin's account is frozen by the coin's own issuer (USDC's), not by the token's.
    const issuer = want.coin ? 'its issuer' : undefined;
    return { refuse: want.use === 'source' ? LP_COPY.frozenSource(want.what, issuer) : LP_COPY.frozenDestination(want.what, issuer), notices: [] };
  }
  if (b.state !== 1) return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
  if (want.program.equals(TOKEN_2022_PROGRAM_ID)) {
    let unpacked;
    try {
      unpacked = unpackAccount(new PublicKey(acc.address), { data: Buffer.from(acc.data), owner: TOKEN_2022_PROGRAM_ID, lamports: acc.lamports, executable: false }, TOKEN_2022_PROGRAM_ID);
    } catch {
      return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
    }
    if (want.use === 'source' && getCpiGuard(unpacked)?.lockCpi) return { refuse: want.coin ? LP_COPY.cpiGuardCoin(want.what) : LP_COPY.cpiGuard, notices: [] };
    if (want.use === 'destination' && getMemoTransfer(unpacked)?.requireIncomingTransferMemos) {
      return { refuse: want.coin ? LP_COPY.memosRequiredCoin(want.what) : LP_COPY.memosRequired, notices: [] };
    }
  }
  // Wrapped SOL's delegate and close authority decide whether that account is used at
  // all, so wsolPlanFrom (wsol.ts) rules on them, for every builder that uses it.
  if (want.mint.equals(WSOL_MINT)) return { notices: [] };
  const notices: string[] = [];
  if (b.delegate && b.delegatedAmount > 0n) {
    const amt = want.decimals === undefined ? `${b.delegatedAmount} of its smallest units` : formatTokenAmount(b.delegatedAmount, want.decimals, want.decimals).text;
    // A spender approved on an account this pays into can move what arrives: the
    // payout would not be only yours. Revoking is one step in the wallet.
    if (want.use === 'destination') return { refuse: LP_COPY.delegatedDestination(b.delegate.toBase58(), amt, want.what, acc.address), notices: [] };
    // Spent from, not paid into: nothing is refused, and the way out's refusal is said now.
    notices.push(LP_COPY.delegatedSource(b.delegate.toBase58(), amt, want.what, acc.address));
  }
  if (want.use === 'destination' && b.closeAuthority && !b.closeAuthority.equals(want.owner)) {
    // Not native SOL: the token program lets a close authority close it only when it is empty.
    notices.push(LP_COPY.closeAuthorityNotice(b.closeAuthority.toBase58(), want.what));
  }
  return { notices };
}

// ── deposit (3.1) ────────────────────────────────────────────────────────────

export interface LpDepositArgs {
  owner: PublicKey;
  pool: PublicKey;
  tokenMint: PublicKey;
  /**
   * The pool's pairing coin as the page read it: wrapped SOL's mint, USDC's or BAYLA's.
   * It decides which accounts are read; the pool as read must then agree.
   */
  quoteMint: PublicKey;
  /** The side typed in last: its number is the most that can leave on that side. `quote` is the pairing coin's side. */
  driving: 'quote' | 'token';
  maxIn: bigint;
  slippageBps: bigint;
  /** The other side's maximum the preview showed; null when nothing was shown. */
  shownOtherMax: bigint | null;
}

/** The fee reserve a deposit holds back: one signature and the most priority fee we ever set. */
export const LP_FEE_RESERVE = 5_000n + MAX_OWN_PRIORITY_LAMPORTS;

/**
 * The decoded steps of a deposit must be exactly the plan. A string says what differs.
 * A SOL pool wraps exactly its SOL limit into the signer's wrapped-SOL account, opened
 * before and closed after when the plan says so. A pool paired with any other coin
 * (`quoteNative: false`) wraps nothing at all and opens only the pool-share account.
 */
export function depositStepsProblem(
  steps: IntentStep[],
  want: { pool: PublicKey; lp: bigint; max0: bigint; max1: bigint; lpAta: PublicKey } & (
    | { quoteNative?: true; maxSol: bigint; closeAfter: boolean; wsolAta: PublicKey }
    | { quoteNative: false }
  ),
): string | null {
  const body = bodySteps(steps);
  const deposits = body.filter((s) => s.kind === 'pool-deposit');
  const d = deposits[0];
  if (deposits.length !== 1 || !d || d.kind !== 'pool-deposit') return 'The deposit is missing from the transaction.';
  if (!d.pool.equals(want.pool) || d.lpAmount !== want.lp || d.max0 !== want.max0 || d.max1 !== want.max1) return 'The deposit in the transaction does not match the amounts worked out.';
  const wraps = body.filter((s) => s.kind === 'wrap-sol');
  const syncs = body.filter((s) => s.kind === 'sync-wsol').length;
  const creates = body.filter((s) => s.kind === 'create-token-account');
  const opens = (k: PublicKey) => creates.filter((s) => s.kind === 'create-token-account' && s.address.equals(k)).length === 1;
  const closes = body.filter((s) => s.kind === 'close-wsol').length;
  if (want.quoteNative === false) {
    if (wraps.length !== 0 || syncs !== 0 || closes !== 0) return 'The transaction wraps or unwraps SOL, and this pool is not paired with SOL.';
    if (creates.length !== 1 || !opens(want.lpAta)) return 'The transaction does not open exactly your pool-share account.';
    return null;
  }
  if (wraps.length !== 1 || wraps[0]?.kind !== 'wrap-sol' || wraps[0].lamports !== want.maxSol) return 'The SOL wrapped for the deposit does not match its limit.';
  if (syncs !== 1) return 'The wrapped SOL is not synced exactly once.';
  if (creates.length !== 2 || !opens(want.wsolAta) || !opens(want.lpAta)) return 'The transaction does not open exactly your wrapped-SOL and pool-share accounts.';
  if (closes > 1 || (closes === 1) !== want.closeAfter) return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  return null;
}

function depositProblemCopy(p: PlanProblem, ctx: { driving: 'quote' | 'token'; decimals: number; s: PoolView; bps: bigint }): string {
  const q = ctx.s.quote;
  const unit = (side: 'quote' | 'token', v: bigint) => (side === 'quote' ? coin(v, q) : tokens(v, ctx.decimals));
  switch (p.problem) {
    case 'no-price':
      return LP_COPY.gateSaysNo(['The pool is empty on one side, so it has no price.']);
    case 'too-small': {
      if (p.minLp === null) return LP_COPY.tooSmallDeposit(null);
      const S = ctx.s.snapshot.pool.lpSupply;
      const R = ctx.driving === 'quote' ? ctx.s.quoteReserve : ctx.s.tokenReserve;
      // The least typed amount whose shares reach the minimum: lpForMaxIn(x) ≥ minLp.
      const num = p.minLp * R * (10_000n + ctx.bps);
      const den = S * 10_000n;
      return LP_COPY.tooSmallDeposit(unit(ctx.driving, (num + den - 1n) / den));
    }
    case 'over-balance':
      // On the SOL side `have` is spendableSol: the balance less the fee reserve, the
      // account deposits and the wallet's rent floor. It is never "what your wallet
      // has", whichever box was typed in, so it is named as the most you can add.
      // Any other coin's `have` IS the wallet's balance of it.
      if (p.side === 'quote' && q.native) return LP_COPY.rentBand(sol(p.have));
      return LP_COPY.overBalance(unit(p.side, p.need), unit(p.side, p.have));
    case 'overflow':
      return LP_COPY.gateSaysNo(['The amounts are too large for one transaction.']);
    default:
      return LP_COPY.gateSaysNo(['The amounts could not be worked out.']);
  }
}

export async function prepareLpDeposit(rpc: WriteRpc, gate: LpOpenGate, reads: LpPrepareReads, a: LpDepositArgs): Promise<Prepared> {
  // 1. Inputs.
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  if (a.maxIn <= 0n) return notSent('build', 'Enter an amount above zero.');
  if (gate.kind !== 'open' || gate.mode !== 'on') return notSent('build', LP_COPY.depositPaused);
  const quote = quoteCoin(a.quoteMint.toBase58());
  if (!quote) return notSent('build', LP_COPY.notAPairingCoin);
  const cfg = gate.cfg;

  // 2-4. One fresh read; the pool is the pool.
  const snap = await readPoolForWrite(rpc, cfg, { pool: a.pool, tokenMint: a.tokenMint, quote, owner: a.owner });
  if (snap === POOL_READ_FAILED) return notSent('build', LP_COPY.depositPoolUnread);
  if (typeof snap === 'string') return notSent('build', snap);
  const { view } = snap;
  const p = view.snapshot.pool;
  const quoteIsToken0 = view.quoteIsToken0;
  const tokenProgram = new PublicKey(quoteIsToken0 ? p.token1Program : p.token0Program);
  const quoteMintKey = new PublicKey(quote.mint);

  // 5. The token, read again.
  const safety = classifyToken(a.tokenMint.toBase58(), snap.mint, snap.metaplex);
  if (safety.kind !== 'read') return notSent('build', LP_COPY.tokenUnread);
  if (safety.verdict === 'blocked') return notSent('build', LP_COPY.tokenBlocked(safety.blocks[0]?.text ?? 'see the token check'));
  const facts = safety.facts;
  if (!facts) return notSent('build', LP_COPY.tokenUnread);
  if (snap.mint.owner !== tokenProgram.toBase58()) return notSent('build', LP_COPY.poolChanged("the token's program"));
  const decimals = facts.decimals;
  if (decimals !== (quoteIsToken0 ? p.mint1Decimals : p.mint0Decimals)) return notSent('build', LP_COPY.poolChanged("the token's decimals"));
  // A second guard, on purpose, against the ONE set of extensions this site builds for
  // (the same set the withdrawal below reads): a verdict loosened by mistake still cannot
  // let in a token this site could not let back out.
  const outsideSet = facts.extensions.find((e) => !BUILDABLE_EXTENSIONS.has(e));
  if (outsideSet !== undefined) return notSent('build', LP_COPY.tokenBlocked(`It uses ${extensionPlain(outsideSet)}.`));

  // 6. The outside price, read again: the token's, and the pairing coin's own when the
  // pool is not paired with SOL (its price is checked in that coin: poolHealth.ts).
  const readPrice = async (mint: string, d: number): Promise<OutsidePrice> => {
    try {
      return await reads.outsidePrice(mint, d);
    } catch (e) {
      return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
    }
  };
  const [outside, coinOutside] = await Promise.all([readPrice(a.tokenMint.toBase58(), decimals), quote.native ? null : readPrice(quote.mint, quote.decimals)]);

  // 6b. With no route, a pool anyone could open is checked against the token's launch
  // pool (poolHealth.ts). That pool is read here too, so the review's gap comes from
  // fresh reads like every other number on it. Only then: no other deposit needs it.
  const launchPrice =
    outside.kind === 'no-route' && view.origin !== 'launch-pool' ? await readLaunchPoolPrice(rpc, cfg, { tokenMint: a.tokenMint, decimals, outside, safety }) : null;

  // 7. The gate: stage 1's own check, on reads seconds old. 'allowed' may carry warnings
  // (a price that is off, no market price, a copied name, a freezable token): they do not
  // stop the build, and go on the summary below for the review to say.
  const health = assessPool({ view, tokenDecimals: decimals, chainNow: snap.chainNow, outside, coinOutside, launchPrice, safety });
  if (health.deposits.verdict !== 'allowed') return notSent('build', LP_COPY.gateSaysNo(health.deposits.reasons));

  // 8. The wallet's accounts.
  if (!snap.tokenAccount.account) return notSent('build', LP_COPY.noTokenAccount(snap.tokenAccount.address.toBase58()));
  const lpMint = new PublicKey(p.lpMint);
  const source = accountCheck(snap.tokenAccount.account, { owner: a.owner, mint: a.tokenMint, program: tokenProgram, use: 'source', what: 'token', decimals });
  if (source.refuse) return notSent('build', source.refuse);
  // A coin that is not SOL is spent from the signer's own account for it, which must exist.
  if (!quote.native && !snap.quoteAccount.account) return notSent('build', LP_COPY.noCoinAccount(quote.symbol, snap.quoteAccount.address.toBase58()));
  const wsolCheck = accountCheck(snap.quoteAccount.account, coinAccount(a.owner, quote, 'source'));
  if (wsolCheck.refuse) return notSent('build', wsolCheck.refuse);
  const lpCheck = accountCheck(snap.lp.account, { owner: a.owner, mint: lpMint, program: TOKEN_PROGRAM_ID, use: 'destination', what: 'pool-share', decimals: p.lpMintDecimals });
  if (lpCheck.refuse) return notSent('build', lpCheck.refuse);

  // 9. Wrapped SOL: only a SOL pool has a plan for it. `null` = nothing is wrapped.
  const plan = quote.native ? wsolPlanFrom(a.owner, snap.quoteAccount.account) : null;
  if (typeof plan === 'string') return notSent('build', plan);
  // Said on the review: an approved spender on an account this spends from (the way out
  // pays into it, and is refused while the approval stands), and what the pool-share account's check found.
  const notices = [...source.notices, ...wsolCheck.notices, ...lpCheck.notices];

  // 10. What can go in.
  const availableToken = amountOf(snap.tokenAccount.account);
  const lpAccountRent = snap.lp.account ? 0n : snap.rents.tokenAccount165;
  let availableQuote: bigint;
  if (plan) {
    availableQuote = spendableSol({
      lamports: snap.signerLamports,
      walletFloor: snap.rents.walletFloor,
      feeReserve: LP_FEE_RESERVE,
      lpAccountRent,
      wsolCreateRent: snap.quoteAccount.account ? 0n : snap.rents.tokenAccount165,
    });
  } else {
    // Any other coin: what the wallet holds of it. Its SOL only has to cover the network
    // fee, the pool-share account's deposit and the wallet's own floor.
    const setAside = solSetAside({ walletFloor: snap.rents.walletFloor, feeReserve: LP_FEE_RESERVE, lpAccountRent, wsolCreateRent: 0n });
    if (snap.signerLamports < setAside) return notSent('build', LP_COPY.needSol(sol(setAside), sol(snap.signerLamports)));
    availableQuote = amountOf(snap.quoteAccount.account);
  }

  // 11. The plan.
  const planned = planDeposit(view.snapshot, { quoteIsToken0, driving: a.driving, maxIn: a.maxIn, bps: a.slippageBps, availableQuote, availableToken });
  if (isPlanProblem(planned)) return notSent('build', depositProblemCopy(planned, { driving: a.driving, decimals, s: view, bps: a.slippageBps }));
  const maxSol = quoteIsToken0 ? planned.max0 : planned.max1;
  const maxTok = quoteIsToken0 ? planned.max1 : planned.max0;
  const quoted = { quote: quoteIsToken0 ? planned.cost0 : planned.cost1, token: quoteIsToken0 ? planned.cost1 : planned.cost0 };

  // 11b. What the review must say. A price that is off gets its estimated loss at the
  // amounts that go in, in the pool's own coin. Display only: it decides nothing.
  const off = health.price.state === 'disagrees' ? health.price : null;
  const priceGap: PriceGap | null = off && {
    diff: off.diff,
    lossQuote: estimatedLoss({ quoteAmount: quoted.quote, token: quoted.token, tokenDecimals: decimals, marketPricePerToken: off.reference, quote }),
  };
  const warnings = [...health.deposits.warnings];
  if (off && priceGap) {
    warnings.push(LP_COPY.priceGapLoss(priceGap.lossQuote === null ? null : coin(priceGap.lossQuote, quote), REFERENCE_NAME[off.against]));
  }

  // 12. Moved since shown.
  const otherMax = a.driving === 'quote' ? maxTok : maxSol;
  if (a.shownOtherMax !== null && otherMax > a.shownOtherMax + (a.shownOtherMax * a.slippageBps) / 10_000n) {
    const fmt = (v: bigint) => (a.driving === 'quote' ? tokens(v, decimals) : coin(v, quote));
    return notSent('build', LP_COPY.moved(fmt(otherMax), fmt(a.shownOtherMax)));
  }

  // 13. Pins.
  const lpAta = associatedTokenAddress(lpMint, a.owner, TOKEN_PROGRAM_ID);
  const pins = poolPins(cfg, view, { tokenMint: a.tokenMint, lpAccount: lpAta });
  if (typeof pins === 'string') return notSent('build', pins);

  // 14. The body. The token account is not created: the deposit spends from it. Neither
  // is a coin's account that is not SOL: the deposit spends from that too.
  const deposit = depositIx({
    programId: cfg.cpSwapProgram,
    owner: a.owner,
    poolState: pins.address,
    ownerLpToken: pins.lpAccount,
    token0Account: associatedTokenAddress(pins.token0Mint, a.owner, pins.token0Program),
    token1Account: associatedTokenAddress(pins.token1Mint, a.owner, pins.token1Program),
    token0Vault: pins.vault0,
    token1Vault: pins.vault1,
    vault0Mint: pins.token0Mint,
    vault1Mint: pins.token1Mint,
    lpMint: pins.lpMint,
    lpTokenAmount: planned.lp,
    maximumToken0Amount: planned.max0,
    maximumToken1Amount: planned.max1,
  });
  const openLp = createAssociatedTokenAccountIdempotentInstruction(a.owner, lpAta, a.owner, lpMint, TOKEN_PROGRAM_ID);
  const body: TransactionInstruction[] = plan
    ? [openWsolIx(a.owner), ...wrapIxs(a.owner, maxSol), openLp, deposit, ...closeWsolIxs(plan, a.owner)]
    : [openLp, deposit];

  const tokenAddress = snap.tokenAccount.address;
  const quoteAddress = snap.quoteAccount.address;
  const lpHeldBefore = amountOf(snap.lp.account);
  const S = p.lpSupply;
  const pct = (n: bigint, d: bigint) => (d > 0n ? (Number(n) / Number(d)) * 100 : 0);

  // 15. Simulate twice and compare.
  return buildAndSimulate(rpc, {
    kind: 'lp-deposit',
    body,
    extraSigners: [],
    intent: { kind: 'lp-deposit', signer: a.owner, cfg, maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS, pins },
    watch: {
      signer: a.owner,
      tokenAccounts: [
        { account: tokenAddress, mint: a.tokenMint, role: 'token', decimals },
        { account: lpAta, mint: lpMint, role: 'lp', decimals: p.lpMintDecimals },
        { account: quoteAddress, mint: quoteMintKey, role: plan ? 'wsol' : 'quote', decimals: quote.decimals },
      ],
    },
    expect: (pre, rents) => {
      const lpExists = pre.tokens.get(lpAta.toBase58())?.exists ?? false;
      // At least the shares the deposit names (the bytes pin the exact number). No upper
      // bound: shares a stranger sends in after the balance read must not block it.
      const lpRow = { account: lpAta, mint: lpMint, minDelta: planned.lp, maxDelta: 2n ** 64n };
      const tokRow = { account: tokenAddress, mint: a.tokenMint, minDelta: -maxTok, maxDelta: -1n };
      if (!plan) {
        // Nothing is wrapped. The only SOL that leaves is the pool-share account's
        // deposit, and the coin leaves its own account: at most its limit. No upper bound,
        // as on the opening's row for this account (createPool.ts): the balance is read a
        // slot or more before the test run, and a payment of the coin arriving in between
        // cannot hurt the signer. A row that had to FALL let it block an honest deposit.
        return {
          maxSolOut: lpExists ? 0n : rents.tokenAccount,
          tokens: [lpRow, tokRow, { account: quoteAddress, mint: quoteMintKey, minDelta: -maxSol, maxDelta: 2n ** 64n }],
        };
      }
      const kept = plan.closeAfter ? 0n : syncCredit(pre.tokens.get(plan.ata.toBase58()), rents.tokenAccount);
      return {
        maxSolOut: maxSol + (lpExists ? 0n : rents.tokenAccount),
        tokens: [
          lpRow,
          tokRow,
          // Closed: it ends where it began. Kept: only what the pool did not use stays,
          // plus what the wrap's sync credits, and the person's own wrapped SOL is never spent.
          { account: plan.ata, mint: WSOL_MINT, minDelta: kept, maxDelta: plan.closeAfter ? 0n : maxSol - 1n + kept },
        ],
      };
    },
    newAccountRent: (pre, rents) => ((pre.tokens.get(lpAta.toBase58())?.exists ?? false) ? 0n : rents.tokenAccount),
    summarize: (steps): TxSummary | string => {
      const problem = depositStepsProblem(
        steps,
        plan
          ? { pool: pins.address, lp: planned.lp, max0: planned.max0, max1: planned.max1, maxSol, closeAfter: plan.closeAfter, wsolAta: plan.ata, lpAta }
          : { pool: pins.address, lp: planned.lp, max0: planned.max0, max1: planned.max1, lpAta, quoteNative: false },
      );
      if (problem) return problem;
      const d = bodySteps(steps).find((s) => s.kind === 'pool-deposit');
      if (!d || d.kind !== 'pool-deposit') return 'The deposit is missing from the transaction.';
      return {
        kind: 'lp-deposit',
        pool: pins.address,
        origin: pins.origin,
        config: view.config,
        enableCreatorFee: p.enableCreatorFee,
        tokenMint: a.tokenMint,
        tokenDecimals: decimals,
        quote,
        quoteIsToken0,
        lpAmount: d.lpAmount,
        lpDecimals: p.lpMintDecimals,
        quoted,
        max: { quote: quoteIsToken0 ? d.max0 : d.max1, token: quoteIsToken0 ? d.max1 : d.max0 },
        limitedByBalance: planned.limitedByBalance,
        sharePct: { before: pct(lpHeldBefore, S), after: pct(lpHeldBefore + d.lpAmount, S + d.lpAmount) },
        price: health.price,
        tokenWarnings: safety.warnings,
        warnings,
        priceGap,
        unwrapsWsol: bodySteps(steps).some((s) => s.kind === 'close-wsol'),
        wsolHeldBefore: plan ? plan.heldBefore : 0n,
        notices,
      };
    },
  });
}

// ── withdraw (3.2) ───────────────────────────────────────────────────────────

export interface LpWithdrawArgs {
  owner: PublicKey;
  pool: PublicKey;
  tokenMint: PublicKey;
  /** The pool's pairing coin as the page read it (see `LpDepositArgs.quoteMint`). */
  quoteMint: PublicKey;
  /** The exact pool-share account the positions list found, associated or not (D10). */
  lpAccount: PublicKey;
  /** 1 to 10000; 10000 is exactly the balance read at prepare. */
  pctBps: bigint;
  slippageBps: bigint;
}

/**
 * Why this site cannot build a withdrawal that pays out this Token-2022 mint, or null
 * (D21). It reads the SAME set the deposit and the opening are guarded by
 * (`BUILDABLE_EXTENSIONS`), so whatever this site lets in, it can let out.
 */
function unbuildable(mint: RawAccount): string | null {
  const m = decodeMintAccount(mint.owner, mint.data);
  if (!m.ok) return m.reason;
  const other = m.value.extensions.find((e) => !BUILDABLE_EXTENSIONS.has(e));
  return other === undefined ? null : `it uses ${extensionPlain(other)}`;
}

/**
 * The decoded steps of a withdrawal must be exactly the plan. A string says what differs.
 * A SOL pool opens the token account and the wrapped-SOL account, and closes the latter
 * when the plan says so. A pool paired with any other coin (`quoteNative: false`) opens
 * the token account and the coin's account, and never touches wrapped SOL.
 */
export function withdrawStepsProblem(
  steps: IntentStep[],
  want: { pool: PublicKey; lpAccount: PublicKey; lp: bigint; min0: bigint; min1: bigint; tokenAta: PublicKey } & (
    | { quoteNative?: true; closeAfter: boolean; wsolAta: PublicKey }
    | { quoteNative: false; quoteAta: PublicKey }
  ),
): string | null {
  const body = bodySteps(steps);
  const withdrawals = body.filter((s) => s.kind === 'pool-withdraw');
  const w = withdrawals[0];
  if (withdrawals.length !== 1 || !w || w.kind !== 'pool-withdraw') return 'The withdrawal is missing from the transaction.';
  if (!w.pool.equals(want.pool) || !w.lpAccount.equals(want.lpAccount) || w.lpAmount !== want.lp || w.min0 !== want.min0 || w.min1 !== want.min1) {
    return 'The withdrawal in the transaction does not match the amounts worked out.';
  }
  const creates = body.filter((s) => s.kind === 'create-token-account');
  const opens = (k: PublicKey) => creates.filter((s) => s.kind === 'create-token-account' && s.address.equals(k)).length === 1;
  const closes = body.filter((s) => s.kind === 'close-wsol').length;
  if (want.quoteNative === false) {
    if (closes !== 0) return 'The transaction unwraps SOL, and this pool is not paired with SOL.';
    if (creates.length !== 2 || !opens(want.tokenAta) || !opens(want.quoteAta)) return 'The transaction does not open exactly your two payout accounts.';
    return null;
  }
  if (creates.length !== 2 || !opens(want.tokenAta) || !opens(want.wsolAta)) return 'The transaction does not open exactly your token and wrapped-SOL accounts.';
  if (closes > 1 || (closes === 1) !== want.closeAfter) return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  return null;
}

export async function prepareLpWithdraw(rpc: WriteRpc, gate: LpOpenGate, a: LpWithdrawArgs): Promise<Prepared> {
  // 1. Inputs.
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  if (a.pctBps < 1n || a.pctBps > 10_000n) return notSent('build', LP_COPY.badPercent);
  // 'on' or 'withdraw-only': removing works in both.
  if (gate.kind !== 'open') return notSent('build', 'Removing liquidity needs this page to reach the pool program, and it cannot right now.');
  const quote = quoteCoin(a.quoteMint.toBase58());
  if (!quote) return notSent('build', LP_COPY.cannotBuild(`its pool is not paired with ${QUOTE_COINS_OR}`));
  const cfg = gate.cfg;

  // 2-4. One fresh read, from the pool-share account given.
  const snap = await readPoolForWrite(rpc, cfg, { pool: a.pool, tokenMint: a.tokenMint, quote, owner: a.owner, lpAccount: a.lpAccount });
  if (snap === POOL_READ_FAILED) return notSent('build', LP_COPY.withdrawPoolUnread);
  if (typeof snap === 'string') return notSent('build', snap);
  const { view } = snap;
  const p = view.snapshot.pool;
  const quoteIsToken0 = view.quoteIsToken0;
  const tokenProgram = new PublicKey(quoteIsToken0 ? p.token1Program : p.token0Program);
  const decimals = quoteIsToken0 ? p.mint1Decimals : p.mint0Decimals;
  const quoteMintKey = new PublicKey(quote.mint);
  const quoteProgram = new PublicKey(quote.program);

  // 5. The pool program's own rules, and only those.
  if (!withdrawEnabled(p)) return notSent('build', LP_COPY.withdrawBit);
  if (view.vaultsFrozen) return notSent('build', LP_COPY.vaultFrozen(quote.risk === null ? undefined : `The token's issuer, or ${quote.symbol}'s,`));

  // 6. Can this site build it (D21)? The token's side, and the pairing coin's when that
  // coin sits under Token-2022 (BAYLA): each payout's raw amount must be exact.
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const why = unbuildable(snap.mint);
    if (why) return notSent('build', LP_COPY.cannotBuild(why));
  }
  if (snap.quoteMint && quoteProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const why = unbuildable(snap.quoteMint);
    if (why) return notSent('build', LP_COPY.cannotBuild(`${quote.symbol}: ${why}`));
  }

  // 7. The pool-share account: classic, this pool's share mint, the signer's, working.
  // withdraw.rs checks only its authority, so this is where it is pinned.
  const lpMint = new PublicKey(p.lpMint);
  const share = snap.lp.account;
  if (!share || share.owner !== TOKEN_PROGRAM_ID.toBase58() || share.data.length < 165) return notSent('build', LP_COPY.shareChanged);
  const shareFacts = baseAccount(share.data);
  if (!shareFacts.mint.equals(lpMint) || !shareFacts.owner.equals(a.owner)) return notSent('build', LP_COPY.shareChanged);
  if (shareFacts.state === 2) return notSent('build', LP_COPY.frozenSource('pool-share'));
  if (shareFacts.state !== 1) return notSent('build', LP_COPY.shareChanged);
  const held = shareFacts.amount;

  // 8. The plan.
  const planned = planWithdraw(view.snapshot, { held, pctBps: a.pctBps, bps: a.slippageBps });
  if (isPlanProblem(planned)) {
    const copy =
      planned.problem === 'dust-remainder'
        ? LP_COPY.dustRemainder(shares(planned.keep, p.lpMintDecimals))
        : planned.problem === 'bad-percent'
          ? LP_COPY.badPercent
          : planned.problem === 'nothing-held'
            ? LP_COPY.shareChanged
            : LP_COPY.tooSmallWithdraw;
    return notSent('build', copy);
  }

  // 9. Where the money goes: the signer's own accounts.
  const tokenAta = snap.tokenAccount.address;
  const quoteAta = snap.quoteAccount.address;
  const dest = accountCheck(snap.tokenAccount.account, { owner: a.owner, mint: a.tokenMint, program: tokenProgram, use: 'destination', what: 'token', decimals });
  if (dest.refuse) return notSent('build', dest.refuse);
  const wsolCheck = accountCheck(snap.quoteAccount.account, coinAccount(a.owner, quote, 'destination'));
  if (wsolCheck.refuse) return notSent('build', wsolCheck.refuse);
  // Wrapped SOL: only a SOL pool has a plan for it. `null` = the coin is paid into its own account.
  const plan = quote.native ? wsolPlanFrom(a.owner, snap.quoteAccount.account) : null;
  if (typeof plan === 'string') return notSent('build', plan);
  const tokRent = snap.rents.tokenAccountForMint;
  if (!snap.tokenAccount.account && tokRent === null) return notSent('build', LP_COPY.cannotBuild('its token account size is not one this site knows'));
  const quoteRent = snap.rents.quoteAccount;
  if (!plan && !snap.quoteAccount.account && quoteRent === null) {
    return notSent('build', LP_COPY.cannotBuild(`${quote.symbol}'s account size is not one this site knows`));
  }

  // 10. Said, never refused.
  const notices = [...dest.notices, ...wsolCheck.notices];
  if (!swapEnabled(p)) notices.push(LP_COPY.swapsOff);
  else if (snap.chainNow !== null && snap.chainNow < p.openTime) notices.push(LP_COPY.swapsBlocked(formatWhen(p.openTime)));
  const safety = classifyToken(a.tokenMint.toBase58(), snap.mint, snap.metaplex);
  if (safety.kind === 'read' && safety.verdict === 'blocked') notices.push(LP_COPY.tokenBlockedInform(safety.blocks[0]?.text ?? 'see the token check'));

  // 11. Pins.
  const pins = poolPins(cfg, view, { tokenMint: a.tokenMint, lpAccount: a.lpAccount });
  if (typeof pins === 'string') return notSent('build', pins);

  // 12. The body. Both payout accounts are always opened with create-if-missing, which
  // fails on chain for an existing account owned by another wallet (D18).
  const withdraw = withdrawIx({
    programId: cfg.cpSwapProgram,
    owner: a.owner,
    poolState: pins.address,
    ownerLpToken: pins.lpAccount,
    token0Account: associatedTokenAddress(pins.token0Mint, a.owner, pins.token0Program),
    token1Account: associatedTokenAddress(pins.token1Mint, a.owner, pins.token1Program),
    token0Vault: pins.vault0,
    token1Vault: pins.vault1,
    vault0Mint: pins.token0Mint,
    vault1Mint: pins.token1Mint,
    lpMint: pins.lpMint,
    lpTokenAmount: planned.lp,
    minimumToken0Amount: planned.min0,
    minimumToken1Amount: planned.min1,
  });
  const openToken = createAssociatedTokenAccountIdempotentInstruction(a.owner, tokenAta, a.owner, a.tokenMint, pins.tokenProgram);
  const body: TransactionInstruction[] = plan
    ? [openToken, openWsolIx(a.owner), withdraw, ...closeWsolIxs(plan, a.owner)]
    : [openToken, createAssociatedTokenAccountIdempotentInstruction(a.owner, quoteAta, a.owner, quoteMintKey, quoteProgram), withdraw];
  const minSol = quoteIsToken0 ? planned.min0 : planned.min1;
  const minTok = quoteIsToken0 ? planned.min1 : planned.min0;
  const rentIfOpened = (exists: boolean) => (exists ? 0n : (tokRent ?? 0n));
  // The coin's own account, when the pool is not paired with SOL and the account is opened here.
  const quoteRentIfOpened = (exists: boolean) => (plan || exists ? 0n : (quoteRent ?? 0n));
  const existsIn = (pre: { tokens: Map<string, { exists: boolean }> }, k: PublicKey) => pre.tokens.get(k.toBase58())?.exists ?? false;

  // 13. Simulate twice and compare. No upper bound on what arrives: a donation to the
  // pool must never block a withdrawal. The same for the shares: at most the ones this
  // names may leave (the bytes pin the exact number), and shares a stranger sends in
  // after the balance read must not block it either.
  return buildAndSimulate(rpc, {
    kind: 'lp-withdraw',
    body,
    extraSigners: [],
    intent: { kind: 'lp-withdraw', signer: a.owner, cfg, maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS, pins },
    watch: {
      signer: a.owner,
      tokenAccounts: [
        { account: a.lpAccount, mint: lpMint, role: 'lp', decimals: p.lpMintDecimals },
        { account: tokenAta, mint: a.tokenMint, role: 'token', decimals },
        { account: quoteAta, mint: quoteMintKey, role: plan ? 'wsol' : 'quote', decimals: quote.decimals },
      ],
    },
    expect: (pre) => {
      const rentPaid = rentIfOpened(existsIn(pre, tokenAta));
      const lpRow = { account: a.lpAccount, mint: lpMint, minDelta: -planned.lp, maxDelta: 2n ** 64n };
      const tokRow = { account: tokenAta, mint: a.tokenMint, minDelta: minTok, maxDelta: 2n ** 64n };
      if (!plan) {
        // The coin arrives in its own account; the only SOL that leaves is the deposit
        // of whichever payout account this opens.
        return {
          maxSolOut: rentPaid + quoteRentIfOpened(existsIn(pre, quoteAta)),
          tokens: [lpRow, tokRow, { account: quoteAta, mint: quoteMintKey, minDelta: minSol, maxDelta: 2n ** 64n }],
        };
      }
      const tokens = [
        lpRow,
        tokRow,
        plan.closeAfter
          ? { account: plan.ata, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n }
          : { account: plan.ata, mint: WSOL_MINT, minDelta: minSol, maxDelta: 2n ** 64n },
      ];
      return plan.closeAfter ? { maxSolOut: rentPaid, minSolIn: minSol - rentPaid, tokens } : { maxSolOut: rentPaid, tokens };
    },
    newAccountRent: (pre) => rentIfOpened(existsIn(pre, tokenAta)) + quoteRentIfOpened(existsIn(pre, quoteAta)),
    summarize: (steps): TxSummary | string => {
      const base = { pool: pins.address, lpAccount: a.lpAccount, lp: planned.lp, min0: planned.min0, min1: planned.min1, tokenAta };
      const problem = withdrawStepsProblem(steps, plan ? { ...base, closeAfter: plan.closeAfter, wsolAta: plan.ata } : { ...base, quoteNative: false, quoteAta });
      if (problem) return problem;
      const w = bodySteps(steps).find((s) => s.kind === 'pool-withdraw');
      if (!w || w.kind !== 'pool-withdraw') return 'The withdrawal is missing from the transaction.';
      return {
        kind: 'lp-withdraw',
        pool: pins.address,
        origin: pins.origin,
        config: view.config,
        tokenMint: a.tokenMint,
        tokenDecimals: decimals,
        quote,
        quoteIsToken0,
        lpAccount: a.lpAccount,
        lpAmount: w.lpAmount,
        lpDecimals: p.lpMintDecimals,
        heldBefore: held,
        all: planned.all,
        keep: planned.keep,
        quoted: { quote: quoteIsToken0 ? planned.out0 : planned.out1, token: quoteIsToken0 ? planned.out1 : planned.out0 },
        min: { quote: quoteIsToken0 ? w.min0 : w.min1, token: quoteIsToken0 ? w.min1 : w.min0 },
        tokenAccount: tokenAta,
        tokenAccountRent: rentIfOpened(snap.tokenAccount.account !== null),
        quoteAccount: plan ? null : { address: quoteAta, rent: quoteRentIfOpened(snap.quoteAccount.account !== null) },
        unwrapsWsol: bodySteps(steps).some((s) => s.kind === 'close-wsol'),
        notices,
      };
    },
  });
}
