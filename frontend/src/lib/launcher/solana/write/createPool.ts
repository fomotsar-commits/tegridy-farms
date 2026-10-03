// Opening a new pool on the public fee tier (`lp-create`).
//
// An opening has no pool to read yet, so its pins come from DERIVATION only: the tier
// from the constant (`publicTierConfig`), the pool's vaults, share token and price
// record from the pool address prepare chose, and the opener's pool-share account from
// that share token. The decoder (intent.ts `poolInitialize`) derives the same things
// again from the same address, so a pin can never point an opening anywhere else.
//
// The address is either the pool's STANDARD address for tier 1, or a fresh key made in
// this browser (when anything at all sits at the standard address or its accounts).
//
// Every press of Review builds from scratch, in a fixed order (SPEC_S2_CREATE 3.1):
//
//   1. the inputs: the LP switch is 'on', both amounts are between 1 and u64::MAX;
//   2. a fresh one-off key, in memory only (it is just a random number until it signs);
//   3. ONE read of 18 accounts, all derivable before anything is read: tier 1, the fee
//      account, the token and its name record, the wallet and its three accounts, and
//      the five accounts of BOTH possible pool addresses (the standard one and the
//      fresh key's), so whichever path is taken was read in the same slot;
//   4-5. tier 1 and the fee account, judged by the same two functions the panel used,
//      and tier 1's terms equal to what the panel showed;
//   6. the token, judged again (the deposit gate's token rules, plus create's own);
//   7. where the pool goes: the standard address only when it and its four derived
//      accounts are all empty; otherwise the fresh key, whose own accounts must be;
//   8-9. a fresh market price, and the opening price within 3% of it;
//   10. the wallet's accounts (`accountCheck`, `wsolPlanFrom`);
//   11-12. the rents, read live, and what this wallet can put in (the rent band);
//   13-15. the pins, the body, and the shared simulate-and-compare path, whose balance
//      check lets nothing more leave than the review says: exactly isqrt − 100 pool
//      shares arrive, at most the tokens typed leave, the fee account receives at least
//      the fee on screen, and the wallet pays at most the sum on screen, to the lamport
//      (so a fee above the one shown is blocked, whatever a stranger sends the fee
//      account in the meantime);
//   16. the one-off key is the only extra signer, and only on the one-off path.
//
// THE PAIRING COIN (quotes.ts). A pool opens paired with SOL, USDC or BAYLA. SOL goes in
// through the signer's wrapped-SOL account, as above. USDC and BAYLA are plain tokens:
// nothing is wrapped and no account is opened, the coin is spent from the signer's own
// account for it (which must hold it), and the single read also takes that account and
// the coin's own mint (20 accounts). The fee to open is paid in SOL whatever the coin.
//
// The one-off key lives only in `PreparedTx.extraSigners`: never in the summary, the
// check, a note, storage, the URL or a log. It signs after the wallet (submit.ts), and
// is dropped with the prepared transaction. Nothing here signs or sends.

import {
  ExtensionType,
  getAccountLen,
  getAccountTypeOfMintType,
} from '@solana/spl-token';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatSol, formatTokenAmount } from '../curve/format';
import { clipDetail } from '../curve/read';
import {
  POOL_STATE_LEN,
  deriveLpMint,
  deriveObservation,
  derivePool,
  deriveVault,
  publicTierConfig,
  sortMints,
} from '../../../solana/cpswap/program';
import { initializeIx } from '../../../solana/cpswap/ix';
import { ratePercent } from '../../../solana/cpswap/math';
import type { RawAccount } from '../../../solana/lp/accounts';
import { LOCKED_LP, LOCKED_SHARES_TEXT, U64_MAX, feeReserveFor, isqrt, planCreate, solSetAside, spendableSol, type CreateProblem } from '../../../solana/lp/liquidityMath';
import { TOKEN_2022_NATIVE_MINT, assessOpening } from '../../../solana/lp/opening';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { PRICE_TOLERANCE, tokenReasons } from '../../../solana/lp/poolHealth';
import { QUOTE_COINS_OR, canPair, quoteCoin, type QuoteCoin } from '../../../solana/lp/quotes';
import { SITE_ALLOWED_EXTENSIONS, classifyToken, decodeMintAccount, extensionPlain } from '../../../solana/lp/tokenSafety';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { CP_CREATE_POOL_FEE_RECEIVER, MAX_CREATE_FEE_LAMPORTS, feeAccountStateOf, tierStateOf } from './config';
import { LP_COPY, accountCheck, rentOf, toRaw, type LpPrepareReads } from './liquidity';
import { metadataPda } from './metaplex';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import type { CurveWriteConfig, IntentStep, LpCreateSummary, LpOpenGate, PoolPins, Prepared, TierTerms, TxSummary, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, opened, syncCredit, wrapIxs, wsolPlanFrom } from './wsol';

// ── copy (SPEC_S2_CREATE 3.5) ────────────────────────────────────────────────

const solText = (lamports: bigint) => `${formatSol(lamports, 9)} SOL`;
const tokensText = (raw: bigint, decimals: number) => `${formatTokenAmount(raw, decimals, decimals).text} tokens`;
/** An amount of the pool's pairing coin, exact, in that coin's own decimals. SOL is `solText`, to the character. */
const coinText = (raw: bigint, q: QuoteCoin) => (q.native ? solText(raw) : `${formatTokenAmount(raw, q.decimals, q.decimals).text} ${q.symbol}`);

export const CREATE_COPY = {
  paused: 'Opening pools from this site is paused right now. Removing liquidity still works.',
  emptySide: 'Enter an amount above zero on both sides.',
  tooLarge: 'The amounts are too large for one transaction.',
  readFailed: 'We could not read the network just now, so nothing was built. Try again in a moment.',
  tierNotOpen: 'New pools from this site go on the public fee tier (tier 1), and that tier has not been created on the network yet.',
  tierOff: "Opening new pools on the public fee tier is switched off right now by the pool program's admin (the team's vault).",
  tierFeeTooHigh: (fee: string, limit: string) =>
    `The fee to open a pool is set to ${fee} SOL, above this site's limit of ${limit} SOL, so this site will not open one.`,
  tierUnread: (detail: string) => `We could not confirm the public fee tier just now (${detail}), so nothing was built. Try again in a moment.`,
  termsChanged: (what: string) =>
    `The public fee tier's terms changed since this page read them (${what}). Check the new terms and press Review again.`,
  feeAccount: (detail: string) =>
    `The account that receives the fee to open a pool is not set up (${detail}), so opening a pool would fail. Nothing was built.`,
  tokenUnread: 'We could not read the token just now, so we did not build the opening. Try again in a moment.',
  tokenRefused: (reason: string) => `This site does not open pools for this token: ${reason}`,
  native2022: `This is SOL under the newer token program. Pools here pair a token with ${QUOTE_COINS_OR}.`,
  notAPairingCoin: `Pools opened from this site pair a token with ${QUOTE_COINS_OR} only.`,
  cannotPair: (symbol: string) => `This site does not open a pool that prices this token in ${symbol}.`,
  coinPriceUnread: (symbol: string, detail: string) =>
    `We could not get the price of ${symbol} from Jupiter just now (${detail}), so we could not check the opening price. Try again in a moment.`,
  cannotSizeVault: (why: string) => `This site cannot work out the deposit for this token's pool vault (${why}), so nothing was built.`,
  justOpened:
    'Someone opened a pool for this token at the standard address since this page read it. Read the pools again: you may be able to add to it instead.',
  freshTaken: "Something is already at the new pool's address. Press Review again for a fresh one.",
  priceDisagrees: (gap: string) =>
    `Your opening price is now ${gap} the market price (Jupiter, read just now). Pools opened from this site must start within ${PRICE_TOLERANCE * 100}% of it. Press Match the market price, then Review again.`,
  noRoute: 'Jupiter has no market price for this token, so this site does not open a pool for it.',
  priceUnread: (detail: string) =>
    `We could not get a market price from Jupiter just now (${detail}), so we did not build the opening. Try again in a moment.`,
  notBuilt: (reasons: string[]) => `We did not build this opening: ${reasons.join(' ')}`,
  tooSmall: `Too small: the pool program keeps ${LOCKED_SHARES_TEXT} in every new pool forever, and this opening would not cover them. Put in more of either side.`,
  lockTooLarge: (pct: string) =>
    `Too small to be worth it: the ${LOCKED_SHARES_TEXT} the pool program keeps forever would be ${pct}% of this pool. Put in more, so that part is 0.1% or less.`,
  rentBand: (most: string) =>
    `That would leave your wallet with too little SOL to pay the fee to open, the account deposits and stay open on the network. The most you can put in from this wallet is ${most}.`,
  signerMismatch: "Internal check failed: the pool's signer does not match the review.",
} as const;

// ── pins ─────────────────────────────────────────────────────────────────────

/**
 * The pins for an opening at `address`, by derivation only: there is no pool to read
 * yet. `origin` is 'standard' exactly when `address` is the standard tier-1 address for
 * this pair, and 'other' otherwise. A string says why no pins can be made.
 */
export function createPins(
  cfg: CurveWriteConfig,
  a: { address: PublicKey; tokenMint: PublicKey; tokenProgram: PublicKey; signer: PublicKey; quote: QuoteCoin },
): PoolPins | string {
  if (a.tokenMint.equals(WSOL_MINT)) return 'a pool here pairs a token with SOL, not SOL with itself';
  // A coin is only priced in the coins that outrank it (quotes.ts): BAYLA in SOL or USDC, never SOL in BAYLA.
  if (!canPair(a.tokenMint.toBase58(), a.quote)) return `this site does not open a pool that prices this token in ${a.quote.symbol}`;
  if (!a.tokenProgram.equals(TOKEN_PROGRAM_ID) && !a.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    return 'the token is not owned by either token program';
  }
  const cp = cfg.cpSwapProgram;
  const ammConfig = publicTierConfig(cp);
  const quoteMint = new PublicKey(a.quote.mint);
  const { token0, token1 } = sortMints(quoteMint, a.tokenMint);
  const quoteIsToken0 = token0.equals(quoteMint);
  const programOf = (m: PublicKey): PublicKey => (m.equals(quoteMint) ? new PublicKey(a.quote.program) : a.tokenProgram);
  const lpMint = deriveLpMint(cp, a.address);
  return {
    address: a.address,
    ammConfig,
    origin: a.address.equals(derivePool(cp, ammConfig, token0, token1)) ? 'standard' : 'other',
    token0Mint: token0,
    token1Mint: token1,
    token0Program: programOf(token0),
    token1Program: programOf(token1),
    vault0: deriveVault(cp, a.address, token0),
    vault1: deriveVault(cp, a.address, token1),
    lpMint,
    observation: deriveObservation(cp, a.address),
    tokenMint: a.tokenMint,
    tokenProgram: a.tokenProgram,
    quote: a.quote,
    quoteIsToken0,
    lpAccount: associatedTokenAddress(lpMint, a.signer, TOKEN_PROGRAM_ID),
  };
}

// ── the pool's own accounts ──────────────────────────────────────────────────

/** Account sizes `initialize` pays for that can never be closed: the pool, its price record and its share token. */
const POOL_ACCOUNT_SIZE = POOL_STATE_LEN; // 637, states/pool.rs:132
const PRICE_RECORD_SIZE = 4_075; // ObservationState::LEN, states/oracle.rs:61
const MINT_SIZE = 82;
const TOKEN_ACCOUNT_SIZE = 165;

/**
 * The size of a pool VAULT for this mint: what the pool program allocates, by
 * `get_required_init_account_extensions` (utils/token.rs:248-263), which adds no
 * ImmutableOwner. So 165 for a classic mint, for a Token-2022 mint with no extensions,
 * and for one whose only extensions are a name and picture, while that mint's
 * ASSOCIATED account is 170 (`tokenAccountSize`, D20). A string = this site cannot
 * size it: a token program it does not know, or an extension outside the site's set.
 */
export function vaultAccountSize(mint: RawAccount): number | string {
  if (mint.owner === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_ACCOUNT_SIZE;
  if (mint.owner !== TOKEN_2022_PROGRAM_ID.toBase58()) return 'the token is not owned by a token program';
  const d = decodeMintAccount(mint.owner, mint.data);
  if (!d.ok) return d.reason;
  const types = new Set<ExtensionType>();
  for (const e of d.value.extensions) {
    if (!SITE_ALLOWED_EXTENSIONS.has(e)) return `it uses ${extensionPlain(e)}`;
    const t = getAccountTypeOfMintType(e as ExtensionType) as ExtensionType | undefined;
    if (t === undefined) return `it uses ${extensionPlain(e)}`;
    if (t !== ExtensionType.Uninitialized) types.add(t);
  }
  return getAccountLen([...types]);
}

// ── the single read ──────────────────────────────────────────────────────────

/** A pool address's five accounts: the pool, its LP mint, vault 0, vault 1, its price record. */
export type Five = [RawAccount | null, RawAccount | null, RawAccount | null, RawAccount | null, RawAccount | null];

export interface CreateSnapshot {
  tier: RawAccount | null;
  feeAccount: RawAccount | null;
  mint: RawAccount | null;
  metaplex: RawAccount | null;
  signerLamports: bigint;
  /** The signer's associated account for the token, under each token program. */
  tokenAccounts: { classic: RawAccount | null; token2022: RawAccount | null };
  /**
   * The signer's account for the pairing coin: the wrapped-SOL account for SOL, else the
   * associated account under the coin's own token program.
   */
  quoteAccount: { address: PublicKey; account: RawAccount | null };
  /** The pairing coin's mint, read in the same slot. Null for SOL (the native mint is not read). */
  quoteMint: RawAccount | null;
  standard: { address: PublicKey; accounts: Five };
  fresh: { address: PublicKey; accounts: Five };
}

function fiveKeys(cp: PublicKey, pool: PublicKey, token0: PublicKey, token1: PublicKey): PublicKey[] {
  return [pool, deriveLpMint(cp, pool), deriveVault(cp, pool, token0), deriveVault(cp, pool, token1), deriveObservation(cp, pool)];
}

/**
 * The one fresh read (3.1 step 3): ONE getMultipleAccountsInfo of the 18 keys, in this
 * order: tier 1, the fee account, the token mint, its name record, the wallet, its token
 * account under the classic program and under Token-2022, its account for the pairing
 * coin (the wrapped-SOL account for SOL), the standard pool's five accounts, then the
 * fresh key's five. For a coin that is not SOL a 19th follows: the coin's own mint. A
 * string = the read failed (its detail); nothing else is a string.
 */
export async function readCreateSnapshot(
  rpc: WriteRpc,
  cfg: CurveWriteConfig,
  a: { tokenMint: PublicKey; owner: PublicKey; fresh: PublicKey; quote: QuoteCoin },
): Promise<CreateSnapshot | string> {
  const cp = cfg.cpSwapProgram;
  const tier1 = publicTierConfig(cp);
  const quoteMintKey = new PublicKey(a.quote.mint);
  const { token0, token1 } = sortMints(quoteMintKey, a.tokenMint);
  const standard = derivePool(cp, tier1, token0, token1);
  // SOL: the wrapped-SOL account (the same address as ever). Any other coin: the
  // signer's account for it, under the coin's own program.
  const wsolAddress = associatedTokenAddress(quoteMintKey, a.owner, new PublicKey(a.quote.program));
  const keys = [
    tier1,
    CP_CREATE_POOL_FEE_RECEIVER,
    a.tokenMint,
    metadataPda(a.tokenMint),
    a.owner,
    associatedTokenAddress(a.tokenMint, a.owner, TOKEN_PROGRAM_ID),
    associatedTokenAddress(a.tokenMint, a.owner, TOKEN_2022_PROGRAM_ID),
    wsolAddress,
    ...fiveKeys(cp, standard, token0, token1),
    ...fiveKeys(cp, a.fresh, token0, token1),
    // Last, so the 18 before it are the keys a SOL opening has always read, in order.
    ...(a.quote.native ? [] : [quoteMintKey]),
  ];
  let accs: (RawAccount | null)[];
  try {
    accs = toRaw(keys, await rpc.getMultipleAccountsInfo(keys, 'confirmed'));
  } catch (e) {
    return clipDetail(e);
  }
  const [tier, feeAccount, mint, metaplex, ownerAcc, classic, token2022, wsol] = accs;
  return {
    tier: tier ?? null,
    feeAccount: feeAccount ?? null,
    mint: mint ?? null,
    metaplex: metaplex ?? null,
    signerLamports: BigInt(ownerAcc?.lamports ?? 0),
    // The wallet's own three: an address that only holds SOL someone sent it is no account (`opened`).
    tokenAccounts: { classic: opened(classic), token2022: opened(token2022) },
    quoteAccount: { address: wsolAddress, account: opened(wsol) },
    quoteMint: a.quote.native ? null : accs[18] ?? null,
    standard: { address: standard, accounts: accs.slice(8, 13) as Five },
    fresh: { address: a.fresh, accounts: accs.slice(13, 18) as Five },
  };
}

// ── the plan, checked against the decoded transaction ────────────────────────

/**
 * The decoded steps of an opening must be exactly the plan. A string says what differs.
 * A SOL opening wraps exactly the SOL going in, through the signer's wrapped-SOL account.
 * An opening paired with any other coin (`quoteNative: false`) wraps nothing and opens
 * no account at all: it is the pool instruction alone.
 */
export function createStepsProblem(
  steps: IntentStep[],
  want: { pool: PublicKey; ammConfig: PublicKey; init0: bigint; init1: bigint } & (
    | { quoteNative?: true; sol: bigint; closeAfter: boolean; wsolAta: PublicKey }
    | { quoteNative: false }
  ),
): string | null {
  const body = bodySteps(steps);
  const openings = body.filter((s) => s.kind === 'pool-create');
  const c = openings[0];
  if (openings.length !== 1 || !c || c.kind !== 'pool-create') return 'The opening is missing from the transaction.';
  if (!c.pool.equals(want.pool) || !c.ammConfig.equals(want.ammConfig) || c.init0 !== want.init0 || c.init1 !== want.init1) {
    return 'The opening in the transaction does not match the amounts worked out.';
  }
  const wraps = body.filter((s) => s.kind === 'wrap-sol');
  const syncs = body.filter((s) => s.kind === 'sync-wsol').length;
  const creates = body.filter((s) => s.kind === 'create-token-account');
  if (want.quoteNative === false) {
    if (wraps.length !== 0 || syncs !== 0 || body.some((s) => s.kind === 'close-wsol')) return 'The transaction wraps or unwraps SOL, and this pool is not paired with SOL.';
    if (creates.length !== 0) return 'The transaction opens an account, and this opening opens none.';
    return null;
  }
  if (wraps.length !== 1 || wraps[0]?.kind !== 'wrap-sol' || wraps[0].lamports !== want.sol) return 'The SOL wrapped for the opening does not match the amount to put in.';
  if (syncs !== 1) return 'The wrapped SOL is not synced exactly once.';
  if (creates.length !== 1 || creates[0]?.kind !== 'create-token-account' || !creates[0].address.equals(want.wsolAta)) {
    return 'The transaction does not open exactly your wrapped-SOL account.';
  }
  const closes = body.filter((s) => s.kind === 'close-wsol').length;
  if (closes > 1 || (closes === 1) !== want.closeAfter) return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  return null;
}

// ── prepare (3.1) ────────────────────────────────────────────────────────────

export interface LpCreateArgs {
  owner: PublicKey;
  tokenMint: PublicKey;
  /** The coin the pool pairs the token with: wrapped SOL's mint, USDC's or BAYLA's. */
  quoteMint: PublicKey;
  /**
   * Exactly what goes in, on each side: `quote` of the pairing coin, in its own base
   * units (lamports for SOL). There is no slippage: an opening sets the price.
   */
  quote: bigint;
  token: bigint;
  /** What the panel showed: tier 1's terms as read, and whether the standard pool address held anything. */
  shown: { terms: TierTerms; standard: 'empty' | 'taken' };
}

/** Each tier-1 term that differs from what the panel showed, in plain words. */
function termChanges(shown: TierTerms, now: TierTerms): string[] {
  const pct = (r: bigint) => `${ratePercent(r)}%`;
  const rows: Array<[keyof TierTerms, string, (v: bigint) => string]> = [
    ['createPoolFee', 'fee to open', (v) => formatSol(v, 9)],
    ['tradeFeeRate', 'trade fee', pct],
    ['protocolFeeRate', 'protocol fee', pct],
    ['fundFeeRate', 'fund fee', pct],
    ['creatorFeeRate', 'creator fee', pct],
  ];
  const out: string[] = [];
  for (const [k, label, fmt] of rows) {
    if (shown[k] !== now[k]) out.push(`${label} ${fmt(shown[k])} → ${fmt(now[k])}${k === 'createPoolFee' ? ' SOL' : ''}`);
  }
  return out;
}

/**
 * The locked 100 shares as a percent of the pool, to three significant digits ("0.2"),
 * with more digits when three would read as 0.1 or less: this copy is only shown for a
 * part ABOVE 0.1%, and must never say 0.1.
 */
function lockPct(supply: bigint): string {
  const x = (Number(LOCKED_LP) / Number(supply)) * 100;
  let digits = 3;
  let shown = Number(x.toPrecision(digits));
  while (shown <= 0.1 && digits < 15) shown = Number(x.toPrecision(++digits));
  return String(shown);
}

function createProblemCopy(p: CreateProblem, decimals: number, quote: QuoteCoin): string {
  switch (p.problem) {
    case 'empty-side':
      return CREATE_COPY.emptySide;
    case 'overflow':
      return CREATE_COPY.tooLarge;
    case 'too-small':
      return CREATE_COPY.tooSmall;
    case 'lock-too-large':
      return CREATE_COPY.lockTooLarge(lockPct(p.supply));
    case 'over-balance':
      // SOL: `have` is what the wallet can put in after the fee, the deposits and its own
      // floor, so it is named as the most it can put in. Any other coin's is its balance.
      if (p.side === 'quote') return quote.native ? CREATE_COPY.rentBand(solText(p.have)) : LP_COPY.overBalance(coinText(p.need, quote), coinText(p.have, quote));
      return LP_COPY.overBalance(tokensText(p.need, decimals), tokensText(p.have, decimals));
  }
}

function amountOf(acc: RawAccount): bigint {
  return acc.data.length >= 72 ? new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigUint64(64, true) : 0n;
}

const allEmpty = (five: Five): boolean => five.every((acc) => acc === null);

export async function prepareLpCreate(rpc: WriteRpc, gate: LpOpenGate, reads: LpPrepareReads, a: LpCreateArgs): Promise<Prepared> {
  // 1. Inputs.
  if (gate.kind !== 'open' || gate.mode !== 'on') return notSent('build', CREATE_COPY.paused);
  if (a.quote < 1n || a.token < 1n) return notSent('build', CREATE_COPY.emptySide);
  if (a.quote > U64_MAX || a.token > U64_MAX) return notSent('build', CREATE_COPY.tooLarge);
  const quote = quoteCoin(a.quoteMint.toBase58());
  if (!quote) return notSent('build', CREATE_COPY.notAPairingCoin);
  if (!canPair(a.tokenMint.toBase58(), quote) && !a.tokenMint.equals(WSOL_MINT)) return notSent('build', CREATE_COPY.cannotPair(quote.symbol));
  const quoteMintKey = new PublicKey(quote.mint);
  const quoteProgram = new PublicKey(quote.program);
  const cfg = gate.cfg;
  const cp = cfg.cpSwapProgram;

  // 2. The fresh key: in memory only. Unused, it is just a random number.
  const kp = Keypair.generate();

  // 3. One fresh read covering both possible addresses.
  const snap = await readCreateSnapshot(rpc, cfg, { tokenMint: a.tokenMint, owner: a.owner, fresh: kp.publicKey, quote });
  if (typeof snap === 'string') return notSent('build', CREATE_COPY.readFailed);

  // 4. Tier 1, again, and the terms the panel showed.
  const tier = tierStateOf(publicTierConfig(cp), snap.tier, cp);
  switch (tier.kind) {
    case 'ready':
      break;
    case 'not-open':
      return notSent('build', CREATE_COPY.tierNotOpen);
    case 'switched-off':
      return notSent('build', CREATE_COPY.tierOff);
    case 'fee-too-high':
      return notSent('build', CREATE_COPY.tierFeeTooHigh(formatSol(tier.config.createPoolFee, 9), formatSol(MAX_CREATE_FEE_LAMPORTS, 9)));
    case 'not-a-tier':
    case 'unread':
      return notSent('build', CREATE_COPY.tierUnread(tier.detail));
  }
  const config = tier.config;
  const changed = termChanges(a.shown.terms, config);
  if (changed.length) return notSent('build', CREATE_COPY.termsChanged(changed.join('; ')));
  const createFee = config.createPoolFee;

  // 5. The fee account, again.
  const feeAccount = feeAccountStateOf(snap.feeAccount);
  if (feeAccount.kind === 'missing') return notSent('build', CREATE_COPY.feeAccount('there is no account at its address'));
  if (feeAccount.kind !== 'ready') return notSent('build', CREATE_COPY.feeAccount(feeAccount.detail));

  // 6. The token, read again: the deposit gate's rules, then create's own.
  const mintText = a.tokenMint.toBase58();
  const safety = classifyToken(mintText, snap.mint, snap.metaplex);
  if (safety.kind === 'absent') return notSent('build', CREATE_COPY.tokenRefused('The token does not exist.'));
  if (safety.kind !== 'read') return notSent('build', CREATE_COPY.tokenUnread);
  if (safety.verdict === 'blocked') return notSent('build', CREATE_COPY.tokenRefused(safety.blocks[0]?.text ?? 'see the token check'));
  const reasons = tokenReasons(safety, 'pools');
  if (reasons.refused.length) return notSent('build', CREATE_COPY.tokenRefused(reasons.refused[0]!));
  if (reasons.unchecked.length) return notSent('build', CREATE_COPY.tokenUnread);
  const facts = safety.facts;
  const mint = snap.mint;
  if (!facts || !mint) return notSent('build', CREATE_COPY.tokenUnread);
  const tokenProgram =
    mint.owner === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID : mint.owner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : null;
  if (!tokenProgram) return notSent('build', CREATE_COPY.tokenRefused('It is not owned by either token program.'));
  // Repeats the verdict on purpose: a future loosening of classifyToken cannot loosen openings.
  const outsideSet = facts.extensions.find((e) => !SITE_ALLOWED_EXTENSIONS.has(e));
  if (outsideSet !== undefined) return notSent('build', CREATE_COPY.tokenRefused(`It uses ${extensionPlain(outsideSet)}.`));
  if (mintText === TOKEN_2022_NATIVE_MINT) return notSent('build', CREATE_COPY.native2022);
  const vaultSize = vaultAccountSize(mint);
  if (typeof vaultSize === 'string') return notSent('build', CREATE_COPY.cannotSizeVault(vaultSize));
  const decimals = facts.decimals;

  // 7. Where the pool goes. Anything at all at the standard address or one of its four
  // accounts (a pool, a lamport gift, a wrapped-SOL vault someone pre-funded) sends the
  // opening to the fresh key: a gift above rent to the standard wrapped-SOL vault would
  // become wrapped SOL inside it and break the exact share count.
  let origin: 'standard' | 'other';
  let address: PublicKey;
  if (allEmpty(snap.standard.accounts)) {
    origin = 'standard';
    address = snap.standard.address;
  } else if (a.shown.standard === 'empty' && snap.standard.accounts[0]?.owner === cp.toBase58()) {
    return notSent('build', CREATE_COPY.justOpened);
  } else if (allEmpty(snap.fresh.accounts)) {
    origin = 'other';
    address = kp.publicKey;
  } else {
    return notSent('build', CREATE_COPY.freshTaken);
  }

  // 7b. The pairing coin's own mint, for a coin that is not SOL: it must be the mint this
  // site knows (its program and its decimals, read now), and its pool vault is sized from it.
  let quoteVaultSize: number = TOKEN_ACCOUNT_SIZE;
  if (!quote.native) {
    const qm = snap.quoteMint;
    if (!qm) return notSent('build', LP_COPY.coinChanged(quote.symbol, 'its mint is missing'));
    if (qm.owner !== quote.program) return notSent('build', LP_COPY.coinChanged(quote.symbol, 'it sits under another token program'));
    if (qm.data.length < 82 || qm.data[44] !== quote.decimals) return notSent('build', LP_COPY.coinChanged(quote.symbol, 'its decimals differ'));
    const size = vaultAccountSize(qm);
    if (typeof size === 'string') return notSent('build', CREATE_COPY.cannotSizeVault(`${quote.symbol}: ${size}`));
    quoteVaultSize = size;
  }

  // 8. The market price, read again: the token's, and the pairing coin's own when the
  // pool is not paired with SOL (the opening price is checked in that coin).
  const readPrice = async (mint: string, d: number): Promise<OutsidePrice> => {
    try {
      return await reads.outsidePrice(mint, d);
    } catch (e) {
      return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
    }
  };
  const [outside, coinOutside] = await Promise.all([readPrice(mintText, decimals), quote.native ? null : readPrice(quote.mint, quote.decimals)]);

  // 9. The opening check.
  const opening = assessOpening({ tokenMint: mintText, quote, quoteAmount: a.quote, token: a.token, tokenDecimals: decimals, outside, coinOutside, safety });
  const price = opening.price;
  if (opening.verdict !== 'allowed' || price.state !== 'agrees') {
    if (price.state === 'disagrees') return notSent('build', CREATE_COPY.priceDisagrees(`${(Math.abs(price.diff) * 100).toFixed(1)}% ${price.diff > 0 ? 'above' : 'below'}`));
    if (outside.kind === 'no-route') return notSent('build', CREATE_COPY.noRoute);
    if (outside.kind === 'unread') return notSent('build', CREATE_COPY.priceUnread(outside.detail));
    if (coinOutside && coinOutside.kind !== 'ok') return notSent('build', CREATE_COPY.coinPriceUnread(quote.symbol, coinOutside.detail));
    return notSent('build', CREATE_COPY.notBuilt(opening.reasons));
  }

  // 10. The wallet's accounts. The tokens leave by CPI inside `initialize`, so CPI Guard
  // on the source refuses (accountCheck). A source's notices are not shown.
  const tokenAddress = associatedTokenAddress(a.tokenMint, a.owner, tokenProgram);
  const tokenAccount = tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? snap.tokenAccounts.token2022 : snap.tokenAccounts.classic;
  if (!tokenAccount) return notSent('build', LP_COPY.noTokenAccount(tokenAddress.toBase58()));
  const source = accountCheck(tokenAccount, { owner: a.owner, mint: a.tokenMint, program: tokenProgram, use: 'source', what: 'token', decimals });
  if (source.refuse) return notSent('build', source.refuse);
  const availableToken = amountOf(tokenAccount);
  if (availableToken < a.token) return notSent('build', LP_COPY.overBalance(tokensText(a.token, decimals), tokensText(availableToken, decimals)));
  // A coin that is not SOL is spent from the signer's own account for it, which must exist.
  if (!quote.native && !snap.quoteAccount.account) return notSent('build', LP_COPY.noCoinAccount(quote.symbol, snap.quoteAccount.address.toBase58()));
  const wsolCheck = accountCheck(snap.quoteAccount.account, {
    owner: a.owner, mint: quoteMintKey, program: quoteProgram, use: 'source', what: quote.native ? 'wrapped SOL' : quote.symbol, decimals: quote.decimals,
  });
  if (wsolCheck.refuse) return notSent('build', wsolCheck.refuse);
  // A stranger's close authority, or a spender on a kept account, is refused here (wsol.ts).
  // Only a SOL opening has a plan for wrapped SOL: `null` = nothing is wrapped.
  const plan = quote.native ? wsolPlanFrom(a.owner, snap.quoteAccount.account) : null;
  if (typeof plan === 'string') return notSent('build', plan);

  // 11. Rents, read live.
  let r0: bigint;
  let r82: bigint;
  let r165: bigint;
  let r637: bigint;
  let r4075: bigint;
  let rVault: bigint;
  let rQuoteVault: bigint;
  try {
    const got = await Promise.all([
      rpc.getMinimumBalanceForRentExemption(0),
      rpc.getMinimumBalanceForRentExemption(MINT_SIZE),
      rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
      rpc.getMinimumBalanceForRentExemption(POOL_ACCOUNT_SIZE),
      rpc.getMinimumBalanceForRentExemption(PRICE_RECORD_SIZE),
      vaultSize === TOKEN_ACCOUNT_SIZE ? Promise.resolve(null) : rpc.getMinimumBalanceForRentExemption(vaultSize),
      quoteVaultSize === TOKEN_ACCOUNT_SIZE ? Promise.resolve(null) : rpc.getMinimumBalanceForRentExemption(quoteVaultSize),
    ]);
    [r0, r82, r165, r637, r4075] = got.slice(0, 5).map(rentOf) as [bigint, bigint, bigint, bigint, bigint];
    rVault = got[5] === null ? r165 : rentOf(got[5]);
    rQuoteVault = got[6] === null ? r165 : rentOf(got[6]);
  } catch {
    return notSent('build', CREATE_COPY.readFailed);
  }
  // The pool, its price record, its share token, the pairing coin's vault (the
  // wrapped-SOL vault for SOL) and the token vault.
  const neverRefunded = r637 + r4075 + r82 + rQuoteVault + rVault;
  const lpAccountRent = r165;

  // 12. The plan. Two signatures' worth of fees whichever path it takes. SOL: inside the
  // rent band (3.4). Any other coin: what the wallet holds of it, and its SOL must cover
  // the fee to open, the deposits, the network fee and its own floor.
  const { token0, token1 } = sortMints(quoteMintKey, a.tokenMint);
  const quoteIsToken0 = token0.equals(quoteMintKey);
  let availableQuote: bigint;
  if (plan) {
    availableQuote = spendableSol({
      lamports: snap.signerLamports,
      walletFloor: r0,
      feeReserve: feeReserveFor(2),
      lpAccountRent,
      wsolCreateRent: snap.quoteAccount.account ? 0n : r165,
      alsoPaid: createFee + neverRefunded,
    });
  } else {
    const setAside = solSetAside({ walletFloor: r0, feeReserve: feeReserveFor(2), lpAccountRent, wsolCreateRent: 0n, alsoPaid: createFee + neverRefunded });
    if (snap.signerLamports < setAside) return notSent('build', LP_COPY.needSol(solText(setAside), solText(snap.signerLamports)));
    availableQuote = snap.quoteAccount.account ? amountOf(snap.quoteAccount.account) : 0n;
  }
  const planned = planCreate({ quoteIsToken0, quote: a.quote, token: a.token, availableQuote, availableToken });
  if ('problem' in planned) return notSent('build', createProblemCopy(planned, decimals, quote));

  // 13. Pins.
  const pins = createPins(cfg, { address, tokenMint: a.tokenMint, tokenProgram, signer: a.owner, quote });
  if (typeof pins === 'string') return notSent('build', CREATE_COPY.tokenRefused(pins));
  if (pins.origin !== origin) return notSent('build', CREATE_COPY.signerMismatch);
  const extraSigners = origin === 'other' ? [kp] : [];

  // 14. The body. No account is opened for the pool shares (`initialize` opens it; one
  // made first would make it fail) or for the token (it must already hold the tokens).
  const open = initializeIx({
    programId: cp,
    creator: a.owner,
    ammConfig: pins.ammConfig,
    token0Mint: token0,
    token1Mint: token1,
    creatorToken0: associatedTokenAddress(token0, a.owner, pins.token0Program),
    creatorToken1: associatedTokenAddress(token1, a.owner, pins.token1Program),
    creatorLpToken: pins.lpAccount,
    token0Program: pins.token0Program,
    token1Program: pins.token1Program,
    createPoolFee: CP_CREATE_POOL_FEE_RECEIVER,
    initAmount0: planned.init0,
    initAmount1: planned.init1,
    openTime: 0n,
    poolState: origin === 'other' ? address : undefined,
  });
  // A coin that is not SOL: the pool instruction alone. Nothing is wrapped or opened.
  const body: TransactionInstruction[] = plan ? [openWsolIx(a.owner), ...wrapIxs(a.owner, a.quote), open, ...closeWsolIxs(plan, a.owner)] : [open];
  const quoteAddress = snap.quoteAccount.address;

  // 15. Simulate twice and compare (3.3). The balances are read a slot or more before the
  // test run, and anyone can send a lamport to the fee account, a token to the wallet or
  // wrapped SOL to a kept account in between. So those three rows have no upper bound:
  // more arriving cannot hurt the signer, and an exact row let dust block every opening.
  // What a fee above the one on screen would take comes out of the wallet, so the SOL row
  // is what catches it, and it is exact.
  // The fee to open is paid in SOL whatever the pool is paired with; only a SOL opening
  // also puts SOL into the pool.
  const maxSolOut = (plan ? a.quote : 0n) + createFee + neverRefunded + lpAccountRent;
  const r = await buildAndSimulate(rpc, {
    kind: 'lp-create',
    body,
    extraSigners,
    intent: { kind: 'lp-create', signer: a.owner, cfg, maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS, pins },
    watch: {
      signer: a.owner,
      tokenAccounts: [
        { account: tokenAddress, mint: a.tokenMint, role: 'token', decimals },
        { account: quoteAddress, mint: quoteMintKey, role: plan ? 'wsol' : 'quote', decimals: quote.decimals },
        { account: pins.lpAccount, mint: pins.lpMint, role: 'lp', decimals: 9 },
        { account: CP_CREATE_POOL_FEE_RECEIVER, mint: WSOL_MINT, role: 'treasury', decimals: 9 },
      ],
    },
    expect: (pre, rents) => {
      // Both wrapped-SOL accounts are synced by this transaction, which also turns
      // lamports they already held into balance (syncCredit). Mainnet's fee account,
      // set up under the old rent, gains 550,840 that way on its first opening. The pool
      // program moves and syncs the fee account only when there is a fee to open.
      const feeCredit = createFee === 0n ? 0n : syncCredit(pre.tokens.get(CP_CREATE_POOL_FEE_RECEIVER.toBase58()), rents.tokenAccount);
      const wsolPre = plan ? pre.tokens.get(plan.ata.toBase58()) : undefined;
      const keptCredit = !plan || plan.closeAfter ? 0n : syncCredit(wsolPre, rents.tokenAccount);
      // Lamports already at the wallet's own two addresses come off what it pays: the
      // close hands back every lamport the wrapped-SOL address held, and a pool-share
      // address that already holds SOL needs only the rest of its deposit.
      const wsolBack = plan?.closeAfter ? (wsolPre?.lamports ?? 0n) : 0n;
      const lpThere = pre.tokens.get(pins.lpAccount.toBase58())?.lamports ?? 0n;
      return {
        maxSolOut: maxSolOut - wsolBack - (lpThere < lpAccountRent ? lpThere : lpAccountRent),
        tokens: [
          { account: pins.lpAccount, mint: pins.lpMint, minDelta: planned.lp, maxDelta: planned.lp },
          // At most the tokens typed leave (the bytes pin the exact number).
          { account: tokenAddress, mint: a.tokenMint, minDelta: -a.token, maxDelta: 2n ** 64n },
          plan
            ? // Wrapped in and spent by the opening. Closed: it ends where it began. Kept: at
              // least what its own sync credits, so the person's own wrapped SOL is never spent.
              { account: plan.ata, mint: WSOL_MINT, minDelta: keptCredit, maxDelta: plan.closeAfter ? 0n : 2n ** 64n }
            : // Any other coin leaves its own account: at most the amount typed (the bytes
              // pin the exact number), and more arriving meanwhile cannot hurt the signer.
              { account: quoteAddress, mint: quoteMintKey, minDelta: -a.quote, maxDelta: 2n ** 64n },
          // At least the fee on screen plus what the account already held: a tier read that
          // shows more than the program takes is blocked here, before any signature.
          { account: CP_CREATE_POOL_FEE_RECEIVER, mint: WSOL_MINT, minDelta: createFee + feeCredit, maxDelta: 2n ** 64n },
        ],
      };
    },
    newAccountRent: () => neverRefunded + lpAccountRent,
    summarize: (steps): TxSummary | string => {
      const base = { pool: address, ammConfig: pins.ammConfig, init0: planned.init0, init1: planned.init1 };
      const problem = createStepsProblem(steps, plan ? { ...base, sol: a.quote, closeAfter: plan.closeAfter, wsolAta: plan.ata } : { ...base, quoteNative: false });
      if (problem) return problem;
      const c = bodySteps(steps).find((s) => s.kind === 'pool-create');
      if (!c || c.kind !== 'pool-create') return 'The opening is missing from the transaction.';
      const put = { quote: quoteIsToken0 ? c.init0 : c.init1, token: quoteIsToken0 ? c.init1 : c.init0 };
      const supply = isqrt(c.init0 * c.init1);
      const summary: LpCreateSummary = {
        kind: 'lp-create',
        pool: c.pool,
        origin,
        config,
        tokenMint: a.tokenMint,
        tokenDecimals: decimals,
        quote,
        quoteIsToken0,
        put,
        supply,
        lpAmount: supply - LOCKED_LP,
        lpDecimals: 9,
        locked: { quote: (LOCKED_LP * put.quote) / supply, token: (LOCKED_LP * put.token) / supply },
        createFee,
        feeReceiver: CP_CREATE_POOL_FEE_RECEIVER,
        rents: { neverRefunded, lpAccount: lpAccountRent },
        price,
        tokenWarnings: safety.warnings,
        unwrapsWsol: bodySteps(steps).some((s) => s.kind === 'close-wsol'),
        wsolHeldBefore: plan ? plan.heldBefore : 0n,
        notices: [],
      };
      return summary;
    },
  });
  if (!r.ok) return r;

  // 16. The fresh key signs only on the one-off path, and it is the pool's address.
  const signers = r.prepared.extraSigners.map((k) => k.publicKey);
  const want = origin === 'other' ? [pins.address] : [];
  if (signers.length !== want.length || signers.some((k, i) => !k.equals(want[i]!))) return notSent('build', CREATE_COPY.signerMismatch);
  return r;
}
