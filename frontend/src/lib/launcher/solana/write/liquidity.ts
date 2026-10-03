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
//   2. the pool is checked to be the pool: owned by our pool program, TOKEN/SOL, and
//      each vault, the LP mint and the price record equal to BOTH the derivation from
//      its address and its own record (`poolPins`);
//   3. a deposit runs stage 1's own deposit check again (`assessPool`, with a fresh
//      outside price) and must hear 'allowed'; a withdrawal never does (the leave
//      rule, spec 3.7: only the pool program's own rules, the network's, and "the
//      money must go to your own account" may refuse it);
//   4. the wallet's accounts are checked (`accountCheck`);
//   5. the bounds come from liquidityMath.ts: a deposit's maxima are never 0 and never
//      u64::MAX, a withdrawal's minima never below 1;
//   6. the transaction goes through `buildAndSimulate` like every other kind: decoded
//      back out of its bytes against the pins, simulated twice, and its balance
//      changes compared with what the review says.
//
// The pool instructions are built from `PoolPins` only (`depositIx` / `withdrawIx`),
// so a caller cannot hand-type a vault. Nothing here signs or sends.

import { Buffer } from 'buffer';
import {
  ExtensionType,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccountLen,
  getAccountTypeOfMintType,
  getCpiGuard,
  getMemoTransfer,
  unpackAccount,
} from '@solana/spl-token';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
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
import { isPlanProblem, planDeposit, planWithdraw, spendableSol, type PlanProblem } from '../../../solana/lp/liquidityMath';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { CLOCK_SYSVAR, chainTimeOf, poolViewFrom, type PoolView } from '../../../solana/lp/poolFinder';
import { assessPool, formatWhen } from '../../../solana/lp/poolHealth';
import { EXTENSION, SITE_ALLOWED_EXTENSIONS, classifyToken, decodeMintAccount, extensionPlain } from '../../../solana/lp/tokenSafety';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { metadataPda } from './metaplex';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import { slippageProblem } from './trade';
import type { CurveWriteConfig, IntentStep, LpOpenGate, PoolPins, Prepared, TxSummary, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, opened, syncCredit, wrapIxs, wsolPlanFrom } from './wsol';

// ── copy (spec 3.9) ──────────────────────────────────────────────────────────

const sol = (lamports: bigint) => `${formatSol(lamports, 9)} SOL`;
const tokens = (raw: bigint, decimals: number) => `${formatTokenAmount(raw, decimals, decimals).text} tokens`;
const shares = (raw: bigint, decimals: number) => formatTokenAmount(raw, decimals, decimals).text;

export const LP_COPY = {
  depositPaused: 'Adding liquidity from this site is paused right now. Removing it still works.',
  depositPoolUnread: 'We could not read the pool just now, so nothing was built. Try again in a moment.',
  withdrawPoolUnread: 'We could not read the pool just now, so we could not build the withdrawal. Your pool shares are safe in your wallet. Try again.',
  poolChanged: (field: string) => `This pool no longer matches what the page read (${field}). Read the pools again.`,
  notThisPair: 'This pool does not pair this token with SOL.',
  tokenBlocked: (reason: string) => `This token is now blocked on this site: ${reason}`,
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
  frozenSource: (what: string) => `Your ${what} account is frozen by the token's issuer, so nothing can move out of it.`,
  frozenDestination: (what: string) => `Your ${what} account is frozen by the token's issuer, so nothing can be paid into it.`,
  cpiGuard: 'Your account for this token has CPI Guard switched on, which stops a pool taking tokens from it. Switch it off in your wallet, then try again.',
  memosRequired: 'Your account for this token only accepts transfers that carry a memo, and the pool cannot add one. Switch off required memos in your wallet, then try again.',
  delegatedDestination: (spender: string, amount: string, what: string, address: string) =>
    `An approved spender (${spender}) can move up to ${amount} out of your ${what} account (${address}), and this would pay into it. Revoke that approval in your wallet, then try again.`,
  closeAuthorityNotice: (authority: string, what: string) => `${authority} can close your ${what} account once it is empty.`,
  notUsable: (what: string, address: string) => `The account at ${address} is not a ${what} account this site can use, so nothing was built.`,
  withdrawBit:
    "Withdrawals are switched off on this pool by the pool program's admin (the team's vault). Only the vault can switch them back on. Your pool shares stay in your wallet.",
  vaultFrozen: "The token's issuer has frozen one of this pool's vaults, so nothing can move in or out, for anyone. That is the issuer's doing, not the pool program's.",
  cannotBuild: (why: string) =>
    `This site cannot build a withdrawal for this token yet (${why}). The pool program still lets you withdraw with any other tool that can build its withdrawals. Your pool shares stay in your wallet.`,
  shareChanged: 'Your pool-share account now holds fewer shares than this would take out, or is no longer yours. Read your positions again.',
  tooSmallWithdraw: 'Too small: one side would round to zero. Take out a larger share, or all of it.',
  dustRemainder: (n: string) => `That would leave ${n} pool shares, too few to ever take out at this pool's size. Take out all of it, or less.`,
  badPercent: 'Enter a percent from 0.01 to 100.',
  swapsOff: 'Swaps on this pool are switched off. That does not stop you taking your liquidity out.',
  swapsBlocked: (when: string) => `Swaps on this pool are blocked until ${when}. That does not stop you taking your liquidity out.`,
  tokenBlockedInform: (reason: string) => `This token is blocked on this site for new deposits (${reason}). You can still take your liquidity out.`,
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
  wsol: { address: PublicKey; account: RawAccount | null };
  /** Deposit: the signer's LP associated account. Withdraw: the pool-share account given. */
  lp: { address: PublicKey; account: RawAccount | null };
  /**
   * Read in the second round, with the pool's own config account. `tokenAccountForMint`
   * is the rent of a token account for this mint (D20); null when this site cannot
   * size one (a Token-2022 extension it does not know), which only a withdrawal into
   * a missing account needs, and D21 refuses that first.
   */
  rents: { walletFloor: bigint; tokenAccount165: bigint; tokenAccountForMint: bigint | null };
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
 * Is this decoded pool the TOKEN/SOL pool at `address` it must be? Its mints exactly
 * {wrapped SOL, `tokenMint`}; wrapped SOL under the classic program (so the
 * Token-2022 native mint is never "SOL"); the token under the classic program or
 * Token-2022; and each vault, the LP mint and the price record equal to the
 * derivation from `address`. A string says what differs.
 */
function poolProblem(cp: PublicKey, address: PublicKey, pool: PoolStateView, tokenMint: PublicKey): string | null {
  const wsol = WSOL_MINT.toBase58();
  const tok = tokenMint.toBase58();
  const solIs0 = pool.token0Mint === wsol;
  if (!((solIs0 && pool.token1Mint === tok) || (pool.token1Mint === wsol && pool.token0Mint === tok))) return LP_COPY.notThisPair;
  const solProgram = solIs0 ? pool.token0Program : pool.token1Program;
  const tokProgram = solIs0 ? pool.token1Program : pool.token0Program;
  if (solProgram !== TOKEN_PROGRAM_ID.toBase58()) return LP_COPY.poolChanged('its SOL side is not under the classic token program');
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

/**
 * The size of a token account for this mint (D20). Classic: 165. Token-2022: the
 * account extensions the mint's own extensions require, plus ImmutableOwner, which
 * the associated-token program always adds. NOT `getAccountLenForMint`, which leaves
 * ImmutableOwner out and answers 165 for a Token-2022 mint with no extensions, where
 * the real account is 170. A string = this site cannot size it.
 */
export function tokenAccountSize(mint: RawAccount): number | string {
  if (mint.owner === TOKEN_PROGRAM_ID.toBase58()) return 165;
  if (mint.owner !== TOKEN_2022_PROGRAM_ID.toBase58()) return 'the token is not owned by a token program';
  const d = decodeMintAccount(mint.owner, mint.data);
  if (!d.ok) return d.reason;
  const types = new Set<ExtensionType>([ExtensionType.ImmutableOwner]);
  for (const e of d.value.extensions) {
    const t = getAccountTypeOfMintType(e as ExtensionType) as ExtensionType | undefined;
    if (t === undefined) return `it uses ${extensionPlain(e)}`;
    if (t !== ExtensionType.Uninitialized) types.add(t);
  }
  return getAccountLen([...types]);
}

/**
 * The one fresh read (3.1 step 2-4, 3.2 step 2-4). Round 1: ONE getMultipleAccountsInfo
 * of the 13 maths keys. Round 2, together: the pool's own config account (display, and
 * assessPool's "fee settings unread" rule; never the maths) and three rents.
 */
export async function readPoolForWrite(
  rpc: WriteRpc,
  cfg: CurveWriteConfig,
  a: { pool: PublicKey; tokenMint: PublicKey; owner: PublicKey; lpAccount?: PublicKey },
): Promise<WriteSnapshot | string> {
  const cp = cfg.cpSwapProgram;
  const { token0, token1 } = sortMints(WSOL_MINT, a.tokenMint);
  const lpMintKey = deriveLpMint(cp, a.pool);
  const ata = (m: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID) => associatedTokenAddress(m, a.owner, program);
  const wsolAddress = ata(WSOL_MINT);
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
  ];
  let accs: (RawAccount | null)[];
  try {
    accs = toRaw(keys, await rpc.getMultipleAccountsInfo(keys, 'confirmed'));
  } catch {
    return POOL_READ_FAILED;
  }
  const [poolAcc, v0, v1, , obsAcc, clockAcc, mintAcc, metaAcc, ownerAcc, ataClassic, ata2022, wsolAcc, lpAcc] = accs;

  // The pool is the pool.
  if (!poolAcc) return LP_COPY.poolChanged('the pool account is gone');
  if (poolAcc.owner !== cp.toBase58()) return LP_COPY.poolChanged('the pool account is not owned by the pool program');
  const pool = decodePoolState(a.pool.toBase58(), poolAcc.data);
  if (!pool) return LP_COPY.poolChanged('the pool account does not decode');
  const structural = poolProblem(cp, a.pool, pool, a.tokenMint);
  if (structural) return structural;
  if (!mintAcc) return LP_COPY.poolChanged('its token mint is missing');
  const solIs0 = pool.token0Mint === WSOL_MINT.toBase58();
  const tokenProgram = solIs0 ? pool.token1Program : pool.token0Program;

  // Round 2.
  const size = tokenAccountSize(mintAcc);
  let config: RawAccount | null;
  let rents: WriteSnapshot['rents'];
  try {
    const [cfgInfo, r0, r165, rMint] = await Promise.all([
      // Display only, and "unread" is an answer here: a failed read is no account.
      rpc.getAccountInfo(new PublicKey(pool.ammConfig), 'confirmed').catch(() => null),
      rpc.getMinimumBalanceForRentExemption(0),
      rpc.getMinimumBalanceForRentExemption(165),
      typeof size === 'number' ? rpc.getMinimumBalanceForRentExemption(size) : Promise.resolve(null),
    ]);
    config = cfgInfo ? toRaw([new PublicKey(pool.ammConfig)], [cfgInfo])[0]! : null;
    rents = { walletFloor: rentOf(r0), tokenAccount165: rentOf(r165), tokenAccountForMint: rMint === null ? null : rentOf(rMint) };
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
  if (entry.kind === 'other-pair') return LP_COPY.notThisPair;
  if (entry.kind !== 'pool') return LP_COPY.poolChanged('detail' in entry ? entry.detail : 'the pool account is gone');

  const tokenAddress = ata(a.tokenMint, new PublicKey(tokenProgram));
  return {
    view: entry.view,
    chainNow: chainTimeOf(clockAcc ?? null),
    mint: mintAcc,
    metaplex: metaAcc ?? null,
    signerLamports: BigInt(ownerAcc?.lamports ?? 0),
    // The wallet's own three: an address that only holds SOL someone sent it is no account (`opened`).
    tokenAccount: { address: tokenAddress, account: opened(tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? ata2022 : ataClassic) },
    wsol: { address: wsolAddress, account: opened(wsolAcc) },
    lp: { address: lpAddress, account: opened(lpAcc) },
    rents,
  };
}

/**
 * The pool, pinned. Built ONLY from a prepare-time read: each vault, the LP mint and
 * the price record must equal both the derivation from the pool address and the
 * pool's own record. A string = the pool is not one this site writes to.
 */
export function poolPins(cfg: CurveWriteConfig, view: PoolView, a: { tokenMint: PublicKey; lpAccount: PublicKey }): PoolPins | string {
  const address = new PublicKey(view.address);
  const p = view.snapshot.pool;
  const problem = poolProblem(cfg.cpSwapProgram, address, p, a.tokenMint);
  if (problem) return problem;
  const quoteIsToken0 = p.token0Mint === WSOL_MINT.toBase58();
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
 */
export function accountCheck(
  read: RawAccount | null,
  want: { owner: PublicKey; mint: PublicKey; program: PublicKey; use: 'source' | 'destination'; what: string; decimals?: number },
): { refuse?: string; notices: string[] } {
  const acc = opened(read);
  if (!acc) return { notices: [] };
  if (acc.owner !== want.program.toBase58() || acc.data.length < 165) return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
  const b = baseAccount(acc.data);
  if (!b.mint.equals(want.mint)) return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
  if (!b.owner.equals(want.owner)) return { refuse: LP_COPY.foreignOwner(acc.address, b.owner.toBase58()), notices: [] };
  if (b.state === 2) return { refuse: want.use === 'source' ? LP_COPY.frozenSource(want.what) : LP_COPY.frozenDestination(want.what), notices: [] };
  if (b.state !== 1) return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
  if (want.program.equals(TOKEN_2022_PROGRAM_ID)) {
    let unpacked;
    try {
      unpacked = unpackAccount(new PublicKey(acc.address), { data: Buffer.from(acc.data), owner: TOKEN_2022_PROGRAM_ID, lamports: acc.lamports, executable: false }, TOKEN_2022_PROGRAM_ID);
    } catch {
      return { refuse: LP_COPY.notUsable(want.what, acc.address), notices: [] };
    }
    if (want.use === 'source' && getCpiGuard(unpacked)?.lockCpi) return { refuse: LP_COPY.cpiGuard, notices: [] };
    if (want.use === 'destination' && getMemoTransfer(unpacked)?.requireIncomingTransferMemos) return { refuse: LP_COPY.memosRequired, notices: [] };
  }
  // Wrapped SOL's delegate and close authority decide whether that account is used at
  // all, so wsolPlanFrom (wsol.ts) rules on them, for every builder that uses it.
  if (want.mint.equals(WSOL_MINT)) return { notices: [] };
  if (want.use === 'destination' && b.delegate && b.delegatedAmount > 0n) {
    // A spender approved on an account this pays into can move what arrives: the
    // payout would not be only yours. Revoking is one step in the wallet.
    const amt = want.decimals === undefined ? `${b.delegatedAmount} of its smallest units` : formatTokenAmount(b.delegatedAmount, want.decimals, want.decimals).text;
    return { refuse: LP_COPY.delegatedDestination(b.delegate.toBase58(), amt, want.what, acc.address), notices: [] };
  }
  const notices: string[] = [];
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
  /** The side typed in last: its number is the most that can leave on that side. */
  driving: 'sol' | 'token';
  maxIn: bigint;
  slippageBps: bigint;
  /** The other side's maximum the preview showed; null when nothing was shown. */
  shownOtherMax: bigint | null;
}

/** The fee reserve a deposit holds back: one signature and the most priority fee we ever set. */
export const LP_FEE_RESERVE = 5_000n + MAX_OWN_PRIORITY_LAMPORTS;

/** The decoded steps of a deposit must be exactly the plan. A string says what differs. */
export function depositStepsProblem(
  steps: IntentStep[],
  want: { pool: PublicKey; lp: bigint; max0: bigint; max1: bigint; maxSol: bigint; closeAfter: boolean; wsolAta: PublicKey; lpAta: PublicKey },
): string | null {
  const body = bodySteps(steps);
  const deposits = body.filter((s) => s.kind === 'pool-deposit');
  const d = deposits[0];
  if (deposits.length !== 1 || !d || d.kind !== 'pool-deposit') return 'The deposit is missing from the transaction.';
  if (!d.pool.equals(want.pool) || d.lpAmount !== want.lp || d.max0 !== want.max0 || d.max1 !== want.max1) return 'The deposit in the transaction does not match the amounts worked out.';
  const wraps = body.filter((s) => s.kind === 'wrap-sol');
  if (wraps.length !== 1 || wraps[0]?.kind !== 'wrap-sol' || wraps[0].lamports !== want.maxSol) return 'The SOL wrapped for the deposit does not match its limit.';
  if (body.filter((s) => s.kind === 'sync-wsol').length !== 1) return 'The wrapped SOL is not synced exactly once.';
  const creates = body.filter((s) => s.kind === 'create-token-account');
  const opens = (k: PublicKey) => creates.filter((s) => s.kind === 'create-token-account' && s.address.equals(k)).length === 1;
  if (creates.length !== 2 || !opens(want.wsolAta) || !opens(want.lpAta)) return 'The transaction does not open exactly your wrapped-SOL and pool-share accounts.';
  const closes = body.filter((s) => s.kind === 'close-wsol').length;
  if (closes > 1 || (closes === 1) !== want.closeAfter) return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  return null;
}

function depositProblemCopy(p: PlanProblem, ctx: { driving: 'sol' | 'token'; decimals: number; s: PoolView; bps: bigint }): string {
  const unit = (side: 'sol' | 'token', v: bigint) => (side === 'sol' ? sol(v) : tokens(v, ctx.decimals));
  switch (p.problem) {
    case 'no-price':
      return LP_COPY.gateSaysNo(['The pool is empty on one side, so it has no price.']);
    case 'too-small': {
      if (p.minLp === null) return LP_COPY.tooSmallDeposit(null);
      const S = ctx.s.snapshot.pool.lpSupply;
      const R = ctx.driving === 'sol' ? ctx.s.quoteReserve : ctx.s.tokenReserve;
      // The least typed amount whose shares reach the minimum: lpForMaxIn(x) ≥ minLp.
      const num = p.minLp * R * (10_000n + ctx.bps);
      const den = S * 10_000n;
      return LP_COPY.tooSmallDeposit(unit(ctx.driving, (num + den - 1n) / den));
    }
    case 'over-balance':
      // On the SOL side `have` is spendableSol: the balance less the fee reserve, the
      // account deposits and the wallet's rent floor. It is never "what your wallet
      // has", whichever box was typed in, so it is named as the most you can add.
      if (p.side === 'sol') return LP_COPY.rentBand(sol(p.have));
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
  const cfg = gate.cfg;

  // 2-4. One fresh read; the pool is the pool.
  const snap = await readPoolForWrite(rpc, cfg, { pool: a.pool, tokenMint: a.tokenMint, owner: a.owner });
  if (snap === POOL_READ_FAILED) return notSent('build', LP_COPY.depositPoolUnread);
  if (typeof snap === 'string') return notSent('build', snap);
  const { view } = snap;
  const p = view.snapshot.pool;
  const quoteIsToken0 = view.quoteIsToken0;
  const tokenProgram = new PublicKey(quoteIsToken0 ? p.token1Program : p.token0Program);

  // 5. The token, read again.
  const safety = classifyToken(a.tokenMint.toBase58(), snap.mint, snap.metaplex);
  if (safety.kind !== 'read') return notSent('build', LP_COPY.tokenUnread);
  if (safety.verdict === 'blocked') return notSent('build', LP_COPY.tokenBlocked(safety.blocks[0]?.text ?? 'see the token check'));
  const facts = safety.facts;
  if (!facts) return notSent('build', LP_COPY.tokenUnread);
  if (snap.mint.owner !== tokenProgram.toBase58()) return notSent('build', LP_COPY.poolChanged("the token's program"));
  const decimals = facts.decimals;
  if (decimals !== (quoteIsToken0 ? p.mint1Decimals : p.mint0Decimals)) return notSent('build', LP_COPY.poolChanged("the token's decimals"));
  // Repeats the verdict on purpose: a future loosening of classifyToken cannot loosen deposits.
  const outsideSet = facts.extensions.find((e) => !SITE_ALLOWED_EXTENSIONS.has(e));
  if (outsideSet !== undefined) return notSent('build', LP_COPY.tokenBlocked(`It uses ${extensionPlain(outsideSet)}.`));

  // 6. The outside price, read again.
  let outside: OutsidePrice;
  try {
    outside = await reads.outsidePrice(a.tokenMint.toBase58(), decimals);
  } catch (e) {
    outside = { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
  }

  // 7. The gate: stage 1's own check, on reads seconds old.
  const health = assessPool({ view, tokenDecimals: decimals, chainNow: snap.chainNow, outside, safety });
  if (health.deposits.verdict !== 'allowed') return notSent('build', LP_COPY.gateSaysNo(health.deposits.reasons));

  // 8. The wallet's accounts.
  if (!snap.tokenAccount.account) return notSent('build', LP_COPY.noTokenAccount(snap.tokenAccount.address.toBase58()));
  const lpMint = new PublicKey(p.lpMint);
  const source = accountCheck(snap.tokenAccount.account, { owner: a.owner, mint: a.tokenMint, program: tokenProgram, use: 'source', what: 'token', decimals });
  if (source.refuse) return notSent('build', source.refuse);
  const wsolCheck = accountCheck(snap.wsol.account, { owner: a.owner, mint: WSOL_MINT, program: TOKEN_PROGRAM_ID, use: 'source', what: 'wrapped SOL', decimals: 9 });
  if (wsolCheck.refuse) return notSent('build', wsolCheck.refuse);
  const lpCheck = accountCheck(snap.lp.account, { owner: a.owner, mint: lpMint, program: TOKEN_PROGRAM_ID, use: 'destination', what: 'pool-share', decimals: p.lpMintDecimals });
  if (lpCheck.refuse) return notSent('build', lpCheck.refuse);

  // 9. Wrapped SOL.
  const plan = wsolPlanFrom(a.owner, snap.wsol.account);
  if (typeof plan === 'string') return notSent('build', plan);
  const notices = [...lpCheck.notices];

  // 10. What can go in.
  const availableToken = amountOf(snap.tokenAccount.account);
  const availableSol = spendableSol({
    lamports: snap.signerLamports,
    walletFloor: snap.rents.walletFloor,
    feeReserve: LP_FEE_RESERVE,
    lpAccountRent: snap.lp.account ? 0n : snap.rents.tokenAccount165,
    wsolCreateRent: snap.wsol.account ? 0n : snap.rents.tokenAccount165,
  });

  // 11. The plan.
  const planned = planDeposit(view.snapshot, { quoteIsToken0, driving: a.driving, maxIn: a.maxIn, bps: a.slippageBps, availableSol, availableToken });
  if (isPlanProblem(planned)) return notSent('build', depositProblemCopy(planned, { driving: a.driving, decimals, s: view, bps: a.slippageBps }));
  const maxSol = quoteIsToken0 ? planned.max0 : planned.max1;
  const maxTok = quoteIsToken0 ? planned.max1 : planned.max0;

  // 12. Moved since shown.
  const otherMax = a.driving === 'sol' ? maxTok : maxSol;
  if (a.shownOtherMax !== null && otherMax > a.shownOtherMax + (a.shownOtherMax * a.slippageBps) / 10_000n) {
    const fmt = (v: bigint) => (a.driving === 'sol' ? tokens(v, decimals) : sol(v));
    return notSent('build', LP_COPY.moved(fmt(otherMax), fmt(a.shownOtherMax)));
  }

  // 13. Pins.
  const lpAta = associatedTokenAddress(lpMint, a.owner, TOKEN_PROGRAM_ID);
  const pins = poolPins(cfg, view, { tokenMint: a.tokenMint, lpAccount: lpAta });
  if (typeof pins === 'string') return notSent('build', pins);

  // 14. The body. The token account is not created: the deposit spends from it.
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
  const body: TransactionInstruction[] = [
    openWsolIx(a.owner),
    ...wrapIxs(a.owner, maxSol),
    createAssociatedTokenAccountIdempotentInstruction(a.owner, lpAta, a.owner, lpMint, TOKEN_PROGRAM_ID),
    deposit,
    ...closeWsolIxs(plan, a.owner),
  ];

  const tokenAddress = snap.tokenAccount.address;
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
        { account: plan.ata, mint: WSOL_MINT, role: 'wsol', decimals: 9 },
      ],
    },
    expect: (pre, rents) => {
      const lpExists = pre.tokens.get(lpAta.toBase58())?.exists ?? false;
      const kept = plan.closeAfter ? 0n : syncCredit(pre.tokens.get(plan.ata.toBase58()), rents.tokenAccount);
      return {
        maxSolOut: maxSol + (lpExists ? 0n : rents.tokenAccount),
        tokens: [
          // At least the shares the deposit names (the bytes pin the exact number). No upper
          // bound: shares a stranger sends in after the balance read must not block it.
          { account: lpAta, mint: lpMint, minDelta: planned.lp, maxDelta: 2n ** 64n },
          { account: tokenAddress, mint: a.tokenMint, minDelta: -maxTok, maxDelta: -1n },
          // Closed: it ends where it began. Kept: only what the pool did not use stays,
          // plus what the wrap's sync credits, and the person's own wrapped SOL is never spent.
          { account: plan.ata, mint: WSOL_MINT, minDelta: kept, maxDelta: plan.closeAfter ? 0n : maxSol - 1n + kept },
        ],
      };
    },
    newAccountRent: (pre, rents) => ((pre.tokens.get(lpAta.toBase58())?.exists ?? false) ? 0n : rents.tokenAccount),
    summarize: (steps): TxSummary | string => {
      const problem = depositStepsProblem(steps, { pool: pins.address, lp: planned.lp, max0: planned.max0, max1: planned.max1, maxSol, closeAfter: plan.closeAfter, wsolAta: plan.ata, lpAta });
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
        quoteIsToken0,
        lpAmount: d.lpAmount,
        lpDecimals: p.lpMintDecimals,
        quoted: { sol: quoteIsToken0 ? planned.cost0 : planned.cost1, token: quoteIsToken0 ? planned.cost1 : planned.cost0 },
        max: { sol: quoteIsToken0 ? d.max0 : d.max1, token: quoteIsToken0 ? d.max1 : d.max0 },
        limitedByBalance: planned.limitedByBalance,
        sharePct: { before: pct(lpHeldBefore, S), after: pct(lpHeldBefore + d.lpAmount, S + d.lpAmount) },
        price: health.price,
        tokenWarnings: safety.warnings,
        unwrapsWsol: bodySteps(steps).some((s) => s.kind === 'close-wsol'),
        wsolHeldBefore: plan.heldBefore,
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
  /** The exact pool-share account the positions list found, associated or not (D10). */
  lpAccount: PublicKey;
  /** 1 to 10000; 10000 is exactly the balance read at prepare. */
  pctBps: bigint;
  slippageBps: bigint;
}

/** The Token-2022 extensions whose raw amounts are exact, so this site builds their withdrawals (D21). */
const WITHDRAW_BUILDABLE_EXTENSIONS: ReadonlySet<number> = new Set([
  EXTENSION.MetadataPointer,
  EXTENSION.TokenMetadata,
  EXTENSION.InterestBearingConfig,
  EXTENSION.ScaledUiAmountConfig,
]);

/** The decoded steps of a withdrawal must be exactly the plan. A string says what differs. */
export function withdrawStepsProblem(
  steps: IntentStep[],
  want: { pool: PublicKey; lpAccount: PublicKey; lp: bigint; min0: bigint; min1: bigint; closeAfter: boolean; wsolAta: PublicKey; tokenAta: PublicKey },
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
  if (creates.length !== 2 || !opens(want.tokenAta) || !opens(want.wsolAta)) return 'The transaction does not open exactly your token and wrapped-SOL accounts.';
  const closes = body.filter((s) => s.kind === 'close-wsol').length;
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
  const cfg = gate.cfg;

  // 2-4. One fresh read, from the pool-share account given.
  const snap = await readPoolForWrite(rpc, cfg, { pool: a.pool, tokenMint: a.tokenMint, owner: a.owner, lpAccount: a.lpAccount });
  if (snap === POOL_READ_FAILED) return notSent('build', LP_COPY.withdrawPoolUnread);
  if (typeof snap === 'string') return notSent('build', snap);
  const { view } = snap;
  const p = view.snapshot.pool;
  const quoteIsToken0 = view.quoteIsToken0;
  const tokenProgram = new PublicKey(quoteIsToken0 ? p.token1Program : p.token0Program);
  const decimals = quoteIsToken0 ? p.mint1Decimals : p.mint0Decimals;

  // 5. The pool program's own rules, and only those.
  if (!withdrawEnabled(p)) return notSent('build', LP_COPY.withdrawBit);
  if (view.vaultsFrozen) return notSent('build', LP_COPY.vaultFrozen);

  // 6. Can this site build it (D21)?
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const m = decodeMintAccount(snap.mint.owner, snap.mint.data);
    if (!m.ok) return notSent('build', LP_COPY.cannotBuild(m.reason));
    const other = m.value.extensions.find((e) => !WITHDRAW_BUILDABLE_EXTENSIONS.has(e));
    if (other !== undefined) return notSent('build', LP_COPY.cannotBuild(`it uses ${extensionPlain(other)}`));
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
  const dest = accountCheck(snap.tokenAccount.account, { owner: a.owner, mint: a.tokenMint, program: tokenProgram, use: 'destination', what: 'token', decimals });
  if (dest.refuse) return notSent('build', dest.refuse);
  const wsolCheck = accountCheck(snap.wsol.account, { owner: a.owner, mint: WSOL_MINT, program: TOKEN_PROGRAM_ID, use: 'destination', what: 'wrapped SOL', decimals: 9 });
  if (wsolCheck.refuse) return notSent('build', wsolCheck.refuse);
  const plan = wsolPlanFrom(a.owner, snap.wsol.account);
  if (typeof plan === 'string') return notSent('build', plan);
  const tokRent = snap.rents.tokenAccountForMint;
  if (!snap.tokenAccount.account && tokRent === null) return notSent('build', LP_COPY.cannotBuild('its token account size is not one this site knows'));

  // 10. Said, never refused.
  const notices = [...dest.notices];
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
  const body: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(a.owner, tokenAta, a.owner, a.tokenMint, pins.tokenProgram),
    openWsolIx(a.owner),
    withdraw,
    ...closeWsolIxs(plan, a.owner),
  ];
  const minSol = quoteIsToken0 ? planned.min0 : planned.min1;
  const minTok = quoteIsToken0 ? planned.min1 : planned.min0;
  const rentIfOpened = (exists: boolean) => (exists ? 0n : (tokRent ?? 0n));

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
        { account: plan.ata, mint: WSOL_MINT, role: 'wsol', decimals: 9 },
      ],
    },
    expect: (pre) => {
      const rentPaid = rentIfOpened(pre.tokens.get(tokenAta.toBase58())?.exists ?? false);
      const tokens = [
        { account: a.lpAccount, mint: lpMint, minDelta: -planned.lp, maxDelta: 2n ** 64n },
        { account: tokenAta, mint: a.tokenMint, minDelta: minTok, maxDelta: 2n ** 64n },
        plan.closeAfter
          ? { account: plan.ata, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n }
          : { account: plan.ata, mint: WSOL_MINT, minDelta: minSol, maxDelta: 2n ** 64n },
      ];
      return plan.closeAfter ? { maxSolOut: rentPaid, minSolIn: minSol - rentPaid, tokens } : { maxSolOut: rentPaid, tokens };
    },
    newAccountRent: (pre) => rentIfOpened(pre.tokens.get(tokenAta.toBase58())?.exists ?? false),
    summarize: (steps): TxSummary | string => {
      const problem = withdrawStepsProblem(steps, {
        pool: pins.address, lpAccount: a.lpAccount, lp: planned.lp, min0: planned.min0, min1: planned.min1,
        closeAfter: plan.closeAfter, wsolAta: plan.ata, tokenAta,
      });
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
        quoteIsToken0,
        lpAccount: a.lpAccount,
        lpAmount: w.lpAmount,
        lpDecimals: p.lpMintDecimals,
        heldBefore: held,
        all: planned.all,
        keep: planned.keep,
        quoted: { sol: quoteIsToken0 ? planned.out0 : planned.out1, token: quoteIsToken0 ? planned.out1 : planned.out0 },
        min: { sol: quoteIsToken0 ? w.min0 : w.min1, token: quoteIsToken0 ? w.min1 : w.min0 },
        tokenAccount: tokenAta,
        tokenAccountRent: rentIfOpened(snap.tokenAccount.account !== null),
        unwrapsWsol: bodySteps(steps).some((s) => s.kind === 'close-wsol'),
        notices,
      };
    },
  });
}
