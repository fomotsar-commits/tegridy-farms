// What "What you are signing" and "Worked out by this site" read: the prepared transaction
// alone (its bytes, its decoded steps, the network's test run and the figures it was built
// on). No read, no send. A figure that cannot be worked out is said as that, never as 0.

import { Transaction, type PublicKey } from '@solana/web3.js';
import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { CLOSE_POSITION_ACCOUNTS, DECREASE_LIQUIDITY_V2_ACCOUNTS, OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS, SWAP_V2_ACCOUNTS, type AccountSpec } from '../../../lib/solana/clmm/ix';
import { quoteCoin, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { PreparedTx, SimulatedEffect, TxSummary } from './ports';

/** Solana's packet limit: prepare.ts `TX_SIZE_LIMIT` (the write layer is not imported here; a test pins the two). */
export const SOLANA_TX_BYTES = 1_232;

type Step = PreparedTx['steps'][number];
type Delta = SimulatedEffect['tokenDeltas'][number];

const n = (v: bigint | number) => v.toLocaleString('en-US');
const sol = (l: bigint) => `${formatSol(l, 9)} SOL`;

// ── ours and the network's ──────────────────────────────────────────────────

/** One coin the transaction moves for the signer, signed in base units (minus = it leaves the wallet). */
export interface Leg {
  name: string;
  decimals: number | null;
  /** What this site worked out when it built the transaction. */
  site: bigint;
  /** What the network's test run moved; null when it reported no account of the signer's for it. */
  network: bigint | null;
}

export interface SiteAndNetwork {
  legs: Leg[];
  /** Set when the site's own figure could not be worked out: the part that did not read. */
  unread?: string;
  /** SOL is one of the legs, counted on both lines without the fees and deposits the review lists. */
  solNetted: boolean;
  /** Why SOL is left out of this kind's comparison, when it is. */
  solLeftOut?: string;
}

/** Accounts the watch list marks as someone else's: never counted as the signer's own coins. */
const NOT_THE_SIGNERS: ReadonlySet<string> = new Set(['treasury', 'workshop']);

function ownChange(p: PreparedTx, match: (d: Delta) => boolean): bigint | null {
  const own = p.simulated.tokenDeltas.filter((d) => !(d.role && NOT_THE_SIGNERS.has(d.role)) && match(d));
  return own.length === 0 ? null : own.reduce((a, d) => a + d.delta, 0n);
}
const ofMint = (mint: string) => (d: Delta) => d.mint.toBase58() === mint;

/**
 * The signer's SOL and wrapped-SOL account, every lamport, as the test run moved them, without
 * the network fee, the priority fee, the deposits the review lists and `listed` (a fee to open
 * the pool). Whole lamports, not the wrapped balance: closing an old account hands back its
 * deposit, and a sync turns lamports it held into balance. The network charges both fees in
 * its test run (measured on mainnet, 2026-10-24).
 */
function testRunSol(p: PreparedTx, listed = 0n): bigint {
  const f = p.fees;
  const wrapped = p.simulation.wsolLamportsDelta ?? 0n;
  return p.simulated.signerLamportsDelta + wrapped + f.baseLamports + f.priorityLamports + f.newAccountRentLamports + listed;
}

const solLeg = (p: PreparedTx, site: bigint, listed = 0n): Leg => ({ name: 'SOL', decimals: 9, site, network: testRunSol(p, listed) });
const tokenName = (mint: PublicKey) => quoteCoin(mint.toBase58())?.symbol ?? 'tokens';

function mintLeg(p: PreparedTx, mint: PublicKey, decimals: number | null, site: bigint, name = tokenName(mint)): Leg {
  return { name, decimals, site, network: ownChange(p, ofMint(mint.toBase58())) };
}

function coinLeg(p: PreparedTx, q: QuoteCoin, site: bigint, listed = 0n): Leg {
  return q.native ? solLeg(p, site, listed) : { name: q.symbol, decimals: q.decimals, site, network: ownChange(p, ofMint(q.mint)) };
}

const sharesLeg = (p: PreparedTx, decimals: number, site: bigint): Leg => ({ name: 'pool shares', decimals, site, network: ownChange(p, (d) => d.role === 'lp') });

const CLOSE_SOL = "SOL is not compared here: closing also gives back your position's deposits, and this review does not list them.";
const LAUNCH_SOL = 'SOL is not compared for a launch: the token details program takes a fee of its own that this review does not list.';

/**
 * Why a take-out's own figure cannot be worked out: a reward paid in one of its coins lands in
 * the same account, and the summary holds no reward amounts. Each reward's mint rides in the
 * take-out's accounts past the ones the program names.
 */
function rewardInSameCoin(p: PreparedTx, coins: Array<{ mint: string; name: string }>): string | undefined {
  const ixs = p.tx.instructions;
  if (ixs.length !== p.steps.length) return 'its steps could not be lined up with its instructions';
  const past = new Set<string>();
  p.steps.forEach((s, i) => {
    if (s.kind === 'range-decrease') for (const k of ixs[i]!.keys.slice(DECREASE_LIQUIDITY_V2_ACCOUNTS.length)) past.add(k.pubkey.toBase58());
  });
  const hit = coins.find((c) => past.has(c.mint));
  return hit && `it also pays a reward in ${hit.name} into the same account, and this review does not count it`;
}

/** Takes `never`, so a kind of transaction with no comparison below does not compile. */
function noComparisonFor(_s: never): null {
  return null;
}

/**
 * This site's figures beside the network's test run, per coin. `decimals` is the page's for a
 * launch token. Null for a kind that moves no coins of the signer's but fees (graduation).
 */
export function siteAndNetwork(p: PreparedTx, decimals: number | null): SiteAndNetwork | null {
  const s = p.summary;
  const swap = (pays: Leg, gets: Leg, native: boolean): SiteAndNetwork => ({ legs: [pays, gets], solNetted: native });
  switch (s.kind) {
    case 'migrate':
      return null;
    case 'create': {
      const legs: Leg[] = [];
      if (s.openingBuy) legs.push(mintLeg(p, s.mint, 6, s.openingBuy.quote.tokensOut, 'tokens'));
      legs.push(mintLeg(p, s.plant.mint, s.plant.decimals, -s.plant.total, '$BAYLA'));
      return { legs, solNetted: false, solLeftOut: LAUNCH_SOL };
    }
    case 'buy':
      return swap(solLeg(p, -s.quote.lamportsIn), mintLeg(p, s.mint, decimals, s.quote.tokensOut, 'tokens'), true);
    case 'sell':
      return swap(mintLeg(p, s.mint, decimals, -s.tokensIn, 'tokens'), solLeg(p, s.quote.lamportsOut), true);
    case 'pool-buy':
      return swap(solLeg(p, -s.amountIn), mintLeg(p, s.mint, decimals, s.quote.outAmount, 'tokens'), true);
    case 'pool-sell':
      return swap(mintLeg(p, s.mint, decimals, -s.amountIn, 'tokens'), solLeg(p, s.quote.outAmount), true);
    case 'venue-swap':
      return s.paysCoin
        ? swap(coinLeg(p, s.coin, -s.amountIn), mintLeg(p, s.tokenMint, s.tokenDecimals, s.quoted.outAmount), s.coin.native)
        : swap(mintLeg(p, s.tokenMint, s.tokenDecimals, -s.amountIn), coinLeg(p, s.coin, s.quoted.outAmount), s.coin.native);
    case 'range-swap': {
      const l = s.poolLine;
      return s.paysCoin
        ? swap(coinLeg(p, l.quote, -s.amountIn), mintLeg(p, l.tokenMint, l.tokenDecimals, s.quotedOut), l.quote.native)
        : swap(mintLeg(p, l.tokenMint, l.tokenDecimals, -s.amountIn), coinLeg(p, l.quote, s.quotedOut), l.quote.native);
    }
    case 'lp-deposit':
      return {
        legs: [mintLeg(p, s.tokenMint, s.tokenDecimals, -s.quoted.token), coinLeg(p, s.quote, -s.quoted.quote), sharesLeg(p, s.lpDecimals, s.lpAmount)],
        solNetted: s.quote.native,
      };
    case 'lp-withdraw':
      return {
        legs: [sharesLeg(p, s.lpDecimals, -s.lpAmount), mintLeg(p, s.tokenMint, s.tokenDecimals, s.quoted.token), coinLeg(p, s.quote, s.quoted.quote)],
        solNetted: s.quote.native,
      };
    case 'lp-create':
      return {
        legs: [mintLeg(p, s.tokenMint, s.tokenDecimals, -s.put.token), coinLeg(p, s.quote, -s.put.quote, s.createFee), sharesLeg(p, s.lpDecimals, s.lpAmount)],
        solNetted: s.quote.native,
      };
    case 'range-open': {
      const l = s.poolLine;
      return { legs: [mintLeg(p, l.tokenMint, l.tokenDecimals, -s.quoted.token), coinLeg(p, l.quote, -s.quoted.quote)], solNetted: l.quote.native };
    }
    case 'range-remove':
    case 'range-close': {
      const l = s.poolLine;
      const fees = s.fees ?? { token: 0n, quote: 0n };
      const token = mintLeg(p, l.tokenMint, l.tokenDecimals, s.quoted.token + fees.token);
      const closeSol = s.kind === 'range-close' && l.quote.native;
      const legs = closeSol ? [token] : [token, coinLeg(p, l.quote, s.quoted.quote + fees.quote)];
      const coins = [{ mint: l.tokenMint.toBase58(), name: token.name }, ...(closeSol ? [] : [{ mint: l.quote.mint, name: l.quote.symbol }])];
      const unread = s.fees ? rewardInSameCoin(p, coins) : 'the fees owed did not read';
      return {
        legs,
        solNetted: l.quote.native && !closeSol,
        ...(unread ? { unread } : {}),
        ...(closeSol ? { solLeftOut: CLOSE_SOL } : {}),
      };
    }
    default:
      return noComparisonFor(s);
  }
}

/** An amount with its sign and name, to the last unit: "-4.0988 SOL", "+1,198.12 BAYLA". */
export function legAmount(v: bigint, leg: Pick<Leg, 'name' | 'decimals'>, signed = true): string {
  const sign = !signed || v === 0n ? '' : v < 0n ? '-' : '+';
  const abs = v < 0n ? -v : v;
  if (leg.name === 'SOL') return `${sign}${sol(abs)}`;
  const f = formatTokenAmount(abs, leg.decimals, leg.decimals ?? 0);
  return `${sign}${f.text}${f.isBaseUnits ? ' base units of' : ''} ${leg.name}`;
}

// ── the steps, decoded from the bytes ───────────────────────────────────────

/** Programs with a public name. The venue's own (launch, pool, range) are named by the step they decoded as. */
const KNOWN_PROGRAMS: Readonly<Record<string, string>> = {
  ComputeBudget111111111111111111111111111111: 'Compute budget',
  '11111111111111111111111111111111': 'System',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated token account',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Token metadata (Metaplex)',
};

/** Takes `never`, so a new kind of step with no words here does not compile. */
function noWordsFor(_s: never): string {
  return 'A step this page has no words for';
}

/** The program a step ran in: its public name, or which of this venue's programs it is. */
export function programName(step: Step, programId: string): string {
  const known = KNOWN_PROGRAMS[programId];
  if (known) return known;
  switch (step.kind) {
    case 'create-launch':
    case 'curve-buy':
    case 'curve-sell':
    case 'migrate':
      return "This venue's launch program";
    case 'pool-swap':
    case 'pool-deposit':
    case 'pool-withdraw':
    case 'pool-create':
      return "This venue's pool program";
    case 'range-open':
    case 'range-decrease':
    case 'range-close':
    case 'range-swap':
      return "This venue's range program";
    default:
      return 'A program this page does not name';
  }
}

/** What a step's words need beside the step: the fee payer, the page's text rule, the pool's coins in order. */
export interface StepContext {
  wallet: string | null;
  display: (s: string, max: number) => string;
  /** The pool's coin 0 and coin 1 by name, when the summary says which is which. */
  coins: [string, string] | null;
}

/** The pool's two coins by name, coin 0 first, from a summary that says which side is which. */
export function poolCoins(s: TxSummary): [string, string] | null {
  const named = (mint: PublicKey) => quoteCoin(mint.toBase58())?.symbol ?? 'the token';
  if (s.kind === 'range-open' || s.kind === 'range-remove' || s.kind === 'range-close' || s.kind === 'range-swap') {
    const l = s.poolLine;
    return l.tokenIsToken0 ? [named(l.tokenMint), l.quote.symbol] : [l.quote.symbol, named(l.tokenMint)];
  }
  if (s.kind === 'lp-deposit' || s.kind === 'lp-withdraw' || s.kind === 'lp-create') {
    return s.quoteIsToken0 ? [s.quote.symbol, named(s.tokenMint)] : [named(s.tokenMint), s.quote.symbol];
  }
  return null;
}

/**
 * One step in words, with its raw values (base units, ticks, whole addresses) for whoever
 * checks them; a coin the site knows carries its ticker beside its address.
 */
export function stepText(step: Step, ctx: StepContext): string {
  const who = (k: PublicKey) => (ctx.wallet !== null && k.toBase58() === ctx.wallet ? 'your wallet' : k.toBase58());
  const mint = (k: PublicKey) => {
    const sym = quoteCoin(k.toBase58())?.symbol;
    return sym ? `${k.toBase58()} (${sym})` : k.toBase58();
  };
  const two = (a: bigint, b: bigint) =>
    ctx.coins ? `${n(a)} base units of ${ctx.coins[0]} and ${n(b)} of ${ctx.coins[1]}` : `${n(a)} and ${n(b)} base units of its two coins`;
  const display = ctx.display;
  switch (step.kind) {
    case 'compute-limit':
      return `Compute limit: ${n(step.units)} units`;
    case 'compute-price':
      return `Priority price: ${n(step.microLamports)} micro-lamports a unit`;
    case 'create-mint-account':
      return `Open the new token's mint account ${step.mint.toBase58()}, with ${sol(step.lamports)} of rent in it`;
    case 'init-mint':
      return `Set up the mint ${step.mint.toBase58()} with ${step.decimals} decimals`;
    case 'create-metadata':
      return `Write the token's details: name "${display(step.name, 32)}", symbol "${display(step.symbol, 10)}", link ${display(step.uri, 200)}`;
    case 'create-launch':
      return `Create the launch of ${step.mint.toBase58()}; its platform reserve goes to ${step.treasuryToken.toBase58()}, the account of ${step.feeRecipient.toBase58()}`;
    case 'create-token-account':
      return `Open the token account ${step.address.toBase58()} for the mint ${mint(step.mint)}, owned by ${who(step.owner)}, if it is not open yet`;
    case 'curve-buy':
      return `Buy ${step.mint.toBase58()} on its curve: at most ${sol(step.maxLamportsIn)} in, at least ${n(step.minTokensOut)} base units out`;
    case 'curve-sell':
      return `Sell ${n(step.tokensIn)} base units of ${step.mint.toBase58()} to its curve, for at least ${sol(step.minLamportsOut)}`;
    case 'migrate':
      return `Finish the graduation of ${step.mint.toBase58()} into the pool ${step.pool.toBase58()}`;
    case 'wrap-sol':
      return `Move ${sol(step.lamports)} into your wrapped SOL account`;
    case 'sync-wsol':
      return 'Count the SOL in that account as wrapped SOL';
    case 'close-wsol':
      return 'Close your wrapped SOL account: what is in it comes back as SOL';
    case 'pool-swap':
    case 'range-swap':
      return `Swap in the pool ${step.pool.toBase58()}: ${n(step.amountIn)} base units of ${mint(step.inputMint)} in, at least ${n(step.minimumAmountOut)} base units of ${mint(step.outputMint)} out`;
    case 'plant-burn':
      return `Burn ${n(step.amount)} base units of ${mint(step.mint)} from ${step.account.toBase58()}`;
    case 'plant-transfer':
      return `Send ${n(step.amount)} base units of ${mint(step.mint)} from ${step.from.toBase58()} to ${step.to.toBase58()}`;
    case 'pool-deposit':
      return `Add to the pool ${step.pool.toBase58()}: exactly ${n(step.lpAmount)} pool shares, at most ${two(step.max0, step.max1)}`;
    case 'pool-withdraw':
      return `Give ${n(step.lpAmount)} pool shares back to the pool ${step.pool.toBase58()} from ${step.lpAccount.toBase58()}, for at least ${two(step.min0, step.min1)}`;
    case 'pool-create':
      return `Open the pool ${step.pool.toBase58()} on the fee tier ${step.ammConfig.toBase58()}, with exactly ${two(step.init0, step.init1)}`;
    case 'range-open':
      return `Open a position in the pool ${step.pool.toBase58()} from tick ${step.tickLower} to tick ${step.tickUpper}: liquidity ${n(step.liquidity)}, at most ${two(step.max0, step.max1)}; its NFT is ${step.nftMint.toBase58()}`;
    case 'range-decrease':
      return step.liquidity === 0n
        ? `Collect what the position ${step.position.toBase58()} in the pool ${step.pool.toBase58()} is owed`
        : `Take liquidity ${n(step.liquidity)} out of the position ${step.position.toBase58()} in the pool ${step.pool.toBase58()}, for at least ${two(step.min0, step.min1)}, with what it is owed`;
    case 'range-close':
      return `Close the position ${step.position.toBase58()}: burn its NFT ${step.nftMint.toBase58()} and give its deposits back`;
    default:
      return noWordsFor(step);
  }
}

/** Each instruction's program address beside its decoded step. Throws when the two do not line up. */
export function decodedSteps(p: PreparedTx): Array<{ step: Step; program: string }> {
  const ixs = p.tx.instructions;
  if (ixs.length !== p.steps.length) throw new Error(`${ixs.length} instructions and ${p.steps.length} decoded steps`);
  return p.steps.map((step, i) => ({ step, program: ixs[i]!.programId.toBase58() }));
}

/** The compute limit the transaction sets, or null when it sets none. */
export function unitLimit(p: PreparedTx): number | null {
  const s = p.steps.find((x) => x.kind === 'compute-limit');
  return s?.kind === 'compute-limit' ? s.units : null;
}

// ── the accounts it writes ──────────────────────────────────────────────────

export interface Written {
  address: string;
  /** The fee payer: never put in a link. */
  wallet: boolean;
  label: string | null;
  /** The range program's own name for the account, from its instruction's account list (clmm/ix.ts). */
  field: string | null;
}

/** The range program's accounts per step, in its own names (ix.test.ts holds them to the Rust structs). */
const RANGE_FIELDS: Partial<Record<Step['kind'], readonly AccountSpec[]>> = {
  'range-open': OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS,
  'range-decrease': DECREASE_LIQUIDITY_V2_ACCOUNTS,
  'range-close': CLOSE_POSITION_ACCOUNTS,
  'range-swap': SWAP_V2_ACCOUNTS,
};

/** Each account of a range step by the program's own name; past the list, a swap's bands, else extra accounts. */
function rangeFields(p: PreparedTx): Map<string, string> {
  const at = new Map<string, string>();
  if (p.tx.instructions.length !== p.steps.length) return at;
  p.steps.forEach((step, i) => {
    const spec = RANGE_FIELDS[step.kind];
    if (!spec) return;
    p.tx.instructions[i]!.keys.forEach((k, j) => {
      const name = spec[j]?.name ?? (step.kind === 'range-swap' ? 'tick_array' : 'remaining_account');
      if (!at.has(k.pubkey.toBase58())) at.set(k.pubkey.toBase58(), name);
    });
  });
  return at;
}

/** What the decoded steps and the watch list say each account is. */
function accountLabels(p: PreparedTx, wallet: string | null): Map<string, string> {
  const at = new Map<string, string>();
  const name = (k: PublicKey, label: string) => {
    if (!at.has(k.toBase58())) at.set(k.toBase58(), label);
  };
  for (const s of p.steps) {
    if ('pool' in s) name(s.pool, 'The pool');
    if (s.kind === 'range-decrease' || s.kind === 'range-close') name(s.position, "Your position's record");
    if (s.kind === 'range-open' || s.kind === 'range-close') name(s.nftMint, "Your position's NFT");
    // intent.ts accepts only create-if-missing: the account may already be there.
    if (s.kind === 'create-token-account') name(s.address, s.owner.toBase58() === wallet ? 'A token account of yours, opened if missing' : 'A token account, opened if missing');
    if (s.kind === 'create-mint-account' || s.kind === 'init-mint' || s.kind === 'create-launch') name(s.mint, "The new token's mint");
    if (s.kind === 'create-launch') name(s.treasuryToken, "The platform treasury's token account");
    if (s.kind === 'pool-withdraw') name(s.lpAccount, 'Your pool-share account');
    if (s.kind === 'plant-burn') name(s.account, 'Your $BAYLA account');
    if (s.kind === 'plant-transfer') name(s.to, "The island Workshop's $BAYLA account");
  }
  for (const d of p.simulated.tokenDeltas) {
    name(d.account, d.role === 'treasury' ? 'The fee account this transaction pays' : d.role === 'workshop' ? "The island Workshop's account" : 'Your token account');
  }
  return at;
}

/** Every account the transaction writes, the fee payer first, each once. */
export function writtenAccounts(p: PreparedTx): Written[] {
  const wallet = p.tx.feePayer?.toBase58() ?? null;
  const labels = accountLabels(p, wallet);
  const fields = rangeFields(p);
  const seen = new Set<string>();
  const out: Written[] = [];
  const add = (a: string) => {
    if (seen.has(a)) return;
    seen.add(a);
    const label = a === wallet ? 'Your wallet, which pays the fees' : (labels.get(a) ?? null);
    out.push({ address: a, wallet: a === wallet, label, field: fields.get(a) ?? null });
  };
  if (wallet) add(wallet);
  for (const ix of p.tx.instructions) for (const k of ix.keys) if (k.isWritable) add(k.pubkey.toBase58());
  return out;
}

// ── the bytes ───────────────────────────────────────────────────────────────

/** The transaction as built, every signature slot empty, in base64: what a wallet is handed before signing. */
export function unsignedBase64(tx: Transaction): string {
  const bytes = Transaction.populate(tx.compileMessage()).serialize({ requireAllSignatures: false, verifySignatures: false });
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The network says so in the log itself when it cuts a long log short. */
export const logCutShort = (logs: readonly string[]) => logs.some((l) => l.startsWith('Log truncated'));

/** "14:02:11 UTC" from a time in ms. */
export const utcTime = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

export { n as grouped };
