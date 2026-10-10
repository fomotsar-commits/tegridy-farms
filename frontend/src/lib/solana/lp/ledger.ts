// A position's ledger from its share account's own transactions: what was put in and
// taken out, what it is worth, and the three differences, exact to a stated bound. An
// entry is proven by discriminator, slots, signer and the two-way share proof; the
// amounts are the vaults' deltas. Figures appear only when the books balance over proven
// entries. No fee is ever summed: the growth figure reads "Fees earned" and always says
// that a token sent into a vault raises it exactly like a fee. One page, budget first.
import { formatSol, formatTokenAmount } from '../../launcher/solana/curve/format';
import { clipDetail } from '../../launcher/solana/curve/read';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { IX_DEPOSIT, IX_INITIALIZE, IX_WITHDRAW } from '../cpswap/program';
import { lpWithdrawValue } from '../cpswap/read';
import { minuteText, quoteText, tokenText } from './format';
import { tokenSymbol } from './identity';
import { LOCKED_LP, LOCKED_SHARES_TEXT, isqrt } from './liquidityMath';
import { paceText } from './pace';
import type { PoolView } from './poolFinder';
import type { LastTrade } from './poolPast';
import { optionalReadAllowed, pausedText } from './rpcBudget';
import { cached, readSignatures, readTransactions, remember, tokenDelta, type Ix, type ParsedTx, type SigEntry } from './txHistory';

/** The share whose history is read: its account and mint, the wallet, and what it holds now (`Position.lpAmount`). */
export interface Share { lpAccount: string; lpMint: string; owner: string; lpAmount: bigint }

export type LedgerEntry =
  | { kind: 'deposit' | 'withdrawal' | 'opening'; signature: string; slot: number; blockTime: number | null; final: boolean; lp: bigint; token: bigint; coin: bigint; lpBefore: bigint }
  | { kind: 'other' | 'mixed' | 'failed'; signature: string; slot: number; blockTime: number | null; final: boolean }
  | { kind: 'unread'; signature: string; blockTime: number | null; detail: string };

/** A signed figure in coin base units, or nothing rounding can tell from zero. */
export type Figure = { kind: 'none-yet' } | { kind: 'amount'; coin: bigint };

export interface LedgerFigures {
  /** `count` is the deposits; an opening is counted apart (`locked` is then set). */
  putIn: { token: bigint; coin: bigint; count: number };
  takenOut: { token: bigint; coin: bigint; count: number } | null;
  worthNow: { token: bigint; coin: bigint };
  /** V_hold and V_pos + V_out in coin base units: the two sides the versus-holding sentence names. */
  holdWorth: bigint;
  nowAndOutWorth: bigint;
  versusHolding: Figure;
  growth: Figure;
  priceEffect: Figure;
  /** What the 100 locked share units are worth now; only on a run that holds the opening. */
  locked: bigint | null;
  since: number | null;
  provenShares: bigint;
  /** Case B: shares that arrived another way, valued apart and never counted. */
  otherShares: { lp: bigint; worth: { token: bigint; coin: bigint } } | null;
}

export interface LedgerWindow { count: number; oldest: number | null; more: boolean }
export type WorthOnlyWhy = 'shares-left' | 'withdrawal-unbalanced' | 'run-start-not-read' | 'unread-entry' | 'mixed-entry' | 'no-deposit-read';

export type LedgerRead =
  | { kind: 'ok'; figures: LedgerFigures; entries: LedgerEntry[]; window: LedgerWindow; case: 'A' | 'B' }
  | { kind: 'worth-only'; why: WorthOnlyWhy; entries: LedgerEntry[]; window: LedgerWindow }
  | { kind: 'unread'; detail: string }
  /** The budget gate refused to start (rpcBudget.ts). */
  | { kind: 'paused' };

// ── shared with the pool past ────────────────────────────────────────────────────────

/** Does the step's data start with `disc`? A short data field is no discriminator. */
export function discriminatorIs(ix: Ix, disc: Uint8Array): boolean {
  return ix.data.length >= 8 && disc.every((b, i) => ix.data[i] === b);
}

/** Every cp-swap step, top-level or inner, that names `pool` among its accounts. */
export function stepsNaming(tx: ParsedTx, pool: string, programId: string): Ix[] {
  return [...tx.instructions, ...tx.inner].filter((ix) => ix.programId === programId && ix.accounts.includes(pool));
}

/** The two vaults' deltas as the pool's token and coin sides. A vault the record does not carry did not move. */
export function vaultMoves(tx: ParsedTx, view: PoolView): { token: bigint; coin: bigint } {
  const p = view.snapshot.pool;
  const d0 = tokenDelta(tx, p.token0Vault);
  const d1 = tokenDelta(tx, p.token1Vault);
  return view.quoteIsToken0 ? { coin: d0, token: d1 } : { coin: d1, token: d0 };
}

export const detailOf = (e: unknown): string => clipDetail(e);

/**
 * The page's transactions: finalized ones from memory, the rest in one round of
 * getTransaction. The PARSED transaction is what is kept, never a classification: one
 * signature is read for a pool and for a share alike, and the two read it differently.
 */
export async function transactionsOf(rpc: SolanaRpc, entries: SigEntry[]): Promise<Map<string, ParsedTx | null>> {
  const out = new Map<string, ParsedTx | null>();
  const toRead: SigEntry[] = [];
  for (const e of entries) {
    const kept = cached<ParsedTx>(e.signature);
    if (kept !== undefined) out.set(e.signature, kept);
    else toRead.push(e);
  }
  const read = await readTransactions(rpc, toRead);
  for (const e of toRead) {
    const tx = read.get(e.signature) ?? null;
    out.set(e.signature, tx);
    if (tx) remember(e, tx);
  }
  return out;
}

// ── the entry rule ───────────────────────────────────────────────────────────────────

const u64At = (data: Uint8Array, at: number): bigint | null =>
  data.length >= at + 8 ? new DataView(data.buffer, data.byteOffset + at, 8).getBigUint64(0, true) : null;

/** The share account's balance entry: its mint and what it held before; null when the record carries none. */
function balanceOf(tx: ParsedTx, address: string): { mint: string; pre: bigint } | null {
  const index = tx.keys.indexOf(address);
  if (index < 0) return null;
  const pre = tx.pre.find((b) => b.accountIndex === index);
  const post = tx.post.find((b) => b.accountIndex === index);
  const either = post ?? pre;
  return either ? { mint: either.mint, pre: pre?.amount ?? 0n } : null;
}

/**
 * One transaction of the share account as this wallet's entry into this pool, or not.
 * Proven when ONE cp-swap step names the pool with the deposit, withdraw or initialize
 * discriminator, its owner slot is this wallet and a signer, its pool and share slots are
 * this pool and this account, both vaults moved the right way, and the share account's
 * delta equals the instruction's amount (an opening: isqrt of the vault deltas less the
 * 100 locked). Anything else is `other`: a transfer, a fee sweep, a stranger's deposit.
 */
export function classifyLedgerTx(sig: SigEntry, tx: ParsedTx | null, share: Share, view: PoolView, programId: string): LedgerEntry {
  if (tx === null) return { kind: 'unread', signature: sig.signature, blockTime: sig.blockTime, detail: 'the node has no record of it' };
  const at = { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, final: sig.confirmationStatus === 'finalized' };
  if (tx.err !== null) return { kind: 'failed', ...at };
  const steps = stepsNaming(tx, view.address, programId);
  if (steps.length > 1) return { kind: 'mixed', ...at };
  const held = balanceOf(tx, share.lpAccount);
  if (!held) return { kind: 'unread', signature: tx.signature, blockTime: tx.blockTime, detail: 'the record carries no balance for your share account' };
  const other: LedgerEntry = { kind: 'other', ...at };
  if (steps.length === 0) return other;
  const ix = steps[0]!;
  const kind = discriminatorIs(ix, IX_DEPOSIT) ? 'deposit' : discriminatorIs(ix, IX_WITHDRAW) ? 'withdrawal' : discriminatorIs(ix, IX_INITIALIZE) ? 'opening' : null;
  if (kind === null) return other;
  // deposit.rs / withdraw.rs: owner 0, pool_state 2, owner_lp_token 3. initialize.rs: creator 0, pool_state 3, creator_lp_token 9.
  const [ownerSlot, poolSlot, lpSlot] = kind === 'opening' ? [0, 3, 9] : [0, 2, 3];
  if (ix.accounts[ownerSlot] !== share.owner || !tx.signers.includes(share.owner)) return other;
  if (ix.accounts[poolSlot] !== view.address || ix.accounts[lpSlot] !== share.lpAccount) return other;
  if (held.mint !== share.lpMint) return other;
  const moves = vaultMoves(tx, view);
  const inward = kind !== 'withdrawal';
  if (inward ? moves.coin <= 0n || moves.token <= 0n : moves.coin >= 0n || moves.token >= 0n) return other;
  const lpDelta = tokenDelta(tx, share.lpAccount);
  let expected: bigint | null;
  if (kind === 'opening') expected = isqrt(moves.coin * moves.token) - LOCKED_LP;
  else {
    const arg = u64At(ix.data, 8);
    expected = arg === null ? null : kind === 'deposit' ? arg : -arg;
  }
  if (expected === null || lpDelta !== expected) return other;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return { kind, ...at, lp: abs(lpDelta), token: abs(moves.token), coin: abs(moves.coin), lpBefore: held.pre };
}

// ── the figures ──────────────────────────────────────────────────────────────────────

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The rounding bound in coin base units: a deposit's two ceilings, two floors in the payout, one in val, one per isqrt. */
export const eps = (view: PoolView): bigint => 2n * ceilDiv(view.quoteReserve, view.tokenReserve) + 6n;

/** A figure within `bound` of zero is none yet, never a signed number. */
export function figure(x: bigint, bound: bigint): Figure {
  return x <= bound && x >= -bound ? { kind: 'none-yet' } : { kind: 'amount', coin: x };
}

type Proven = Extract<LedgerEntry, { kind: 'deposit' | 'withdrawal' | 'opening' }>;
const isProven = (e: LedgerEntry): e is Proven => e.kind === 'deposit' || e.kind === 'withdrawal' || e.kind === 'opening';
const sum = <T>(xs: T[], f: (x: T) => bigint): bigint => xs.reduce((a, x) => a + f(x), 0n);

/**
 * The figures over `entries` (newest first) against the live pool and the shares held now.
 * Pure. The run starts at the oldest proven entry whose share balance was 0 before it; when
 * the page is the whole history (`more` false), at the oldest entry read. Case A: the proven
 * shares equal the shares held. Case B: fewer, with no withdrawal; the rest is valued apart.
 * Otherwise worth only, with the reason.
 */
export function ledgerFigures(entries: LedgerEntry[], view: PoolView, lpAmount: bigint, more = false): LedgerRead {
  const last = entries[entries.length - 1];
  const window: LedgerWindow = { count: entries.length, oldest: last ? last.blockTime : null, more };
  const worthOnly = (why: WorthOnlyWhy): LedgerRead => ({ kind: 'worth-only', why, entries, window });

  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (isProven(e) && e.lpBefore === 0n) { start = i; break; }
  }
  if (start < 0) {
    if (more || entries.length === 0) return worthOnly('run-start-not-read');
    start = entries.length - 1;
  }
  const run = entries.slice(0, start + 1);
  if (run.some((e) => e.kind === 'unread')) return worthOnly('unread-entry');
  if (run.some((e) => e.kind === 'mixed')) return worthOnly('mixed-entry');

  const proven = run.filter(isProven).reverse(); // oldest first
  const inward = proven.filter((e) => e.kind !== 'withdrawal');
  const withdrawals = proven.filter((e) => e.kind === 'withdrawal');
  // Shares that only ever arrived by transfer have no cost this page can read: no figure
  // over zero proven shares, which would print "0 SOL and 0 X, in 0 deposits".
  if (inward.length === 0) return worthOnly('no-deposit-read');
  const provenShares = sum(inward, (e) => e.lp) - sum(withdrawals, (e) => e.lp);
  let ledgerCase: 'A' | 'B';
  if (provenShares === lpAmount) ledgerCase = 'A';
  else if (provenShares < lpAmount && withdrawals.length === 0) ledgerCase = 'B';
  else return worthOnly(provenShares > lpAmount ? 'shares-left' : 'withdrawal-unbalanced');

  const Rc = view.quoteReserve;
  const Rt = view.tokenReserve;
  if (Rt <= 0n || view.snapshot.pool.lpSupply <= 0n) return { kind: 'unread', detail: 'the pool has nothing to value shares against' };
  const val = (t: bigint, c: bigint): bigint => c + (t * Rc) / Rt;
  const worthOf = (shares: bigint): { token: bigint; coin: bigint } | null => {
    if (shares === 0n) return { token: 0n, coin: 0n };
    const w = lpWithdrawValue(view.snapshot, shares);
    if (!w) return null;
    return view.quoteIsToken0 ? { coin: w.token0Amount, token: w.token1Amount } : { coin: w.token1Amount, token: w.token0Amount };
  };
  const worth = worthOf(provenShares);
  const otherWorth = ledgerCase === 'B' ? worthOf(lpAmount - provenShares) : null;
  if (!worth || (ledgerCase === 'B' && !otherWorth)) return { kind: 'unread', detail: 'the pool has nothing to value shares against' };

  const Vpos = val(worth.token, worth.coin);
  const Tin = sum(inward, (e) => e.token);
  const Cin = sum(inward, (e) => e.coin);
  const Vhold = val(Tin, Cin);
  const Tout = sum(withdrawals, (e) => e.token);
  const Cout = sum(withdrawals, (e) => e.coin);
  const Vout = val(Tout, Cout);
  const N = Vpos + Vout - Vhold;

  // Basis in liquidity units: a deposit buys isqrt(t * c); the opening's is the shares it
  // minted (the 100 locked are paid for and not held); a withdrawal removes its share of
  // the basis and realises what its payout's liquidity exceeds that by.
  let B = 0n;
  let f = 0n;
  for (const e of proven) {
    if (e.kind === 'deposit') B += isqrt(e.token * e.coin);
    else if (e.kind === 'opening') B += e.lp;
    else {
      if (e.lpBefore <= 0n) return worthOnly('withdrawal-unbalanced');
      const removed = (B * e.lp) / e.lpBefore;
      f += isqrt(e.token * e.coin) - removed;
      B -= removed;
    }
  }
  const valueOfLiquidity = (liq: bigint): bigint => {
    const v = (2n * isqrt(liq * liq * Rc * Rt)) / Rt;
    return liq < 0n ? -v : v;
  };
  const Vnf = valueOfLiquidity(B);
  const G = Vpos - Vnf + valueOfLiquidity(f);
  const opened = inward.some((e) => e.kind === 'opening');
  const Vlock = opened ? valueOfLiquidity(LOCKED_LP) : null;
  const I = N - G + (Vlock ?? 0n);
  const bound = eps(view);

  const figures: LedgerFigures = {
    putIn: { token: Tin, coin: Cin, count: inward.filter((e) => e.kind === 'deposit').length },
    takenOut: withdrawals.length ? { token: Tout, coin: Cout, count: withdrawals.length } : null,
    worthNow: worth,
    holdWorth: Vhold,
    nowAndOutWorth: Vpos + Vout,
    versusHolding: figure(N, bound),
    growth: figure(G, bound),
    priceEffect: figure(I, bound),
    locked: Vlock,
    since: entries[start]!.blockTime,
    provenShares,
    otherShares: otherWorth ? { lp: lpAmount - provenShares, worth: otherWorth } : null,
  };
  return { kind: 'ok', figures, entries, window, case: ledgerCase };
}

/**
 * One read: the budget gate, one signatures page of the share account, the transactions
 * not already in memory (at most 20 getTransaction), then the figures. Who starts it, a
 * press or the positions list for its first rows, is YourPositions.tsx's rule.
 */
export async function readLedger(rpc: SolanaRpc, share: Share, view: PoolView, programId: string, opts: { before?: string } = {}): Promise<LedgerRead> {
  if (!optionalReadAllowed()) return { kind: 'paused' };
  try {
    const page = await readSignatures(rpc, share.lpAccount, opts);
    const txs = await transactionsOf(rpc, page.entries);
    const entries = page.entries.map((e) => classifyLedgerTx(e, txs.get(e.signature) ?? null, share, view, programId));
    return ledgerFigures(entries, view, share.lpAmount, page.more);
  } catch (e) {
    return { kind: 'unread', detail: detailOf(e) };
  }
}

// ── the words ────────────────────────────────────────────────────────────────────────

export const LEDGER_COPY = {
  /** On every placed share, with no press: the pool program has no claim step for a liquidity provider. */
  feesInShares: 'Fees you earn are already inside your shares: there is nothing to claim, and you receive them when you remove liquidity.',
  button: 'Work out what this position earned',
  reading: 'Working out what this position earned…',
  readAgain: 'Read again',
  noneYet: 'none yet',
  readMore: 'Read 20 more',
  olderNotRead: 'Older history is not read by this page.',
  notFinal: '(not final yet)',
  exactTo: 'Exact to a few of the smallest units, which rounding cannot tell from zero.',
  /** Under Fees earned. The second sentence stays: the program cannot tell a token sent to a vault from a fee. */
  feesNote: 'Your part of this pool’s trading fees, already inside your shares. Anything sent straight into the pool counts here too, because the pool cannot tell it from a fee.',
  noTradeYet: 'No trade has reached this pool yet, so there are no fees yet.',
  noTradeButGrowth: 'Not from fees: no trade has reached this pool, so this came from tokens sent straight into it.',
  belowRounding: 'No fees to show yet. The pool rounds each deposit a few of the smallest units in its own favour, and that is most likely all this is.',
  versusNote: 'Compared with keeping the two tokens in your wallet, at this pool’s price now.',
  priceCostMore: 'The price moved after you put in, and so far that has cost more than the fees have earned. It is not a fee and not a fault.',
  priceEffectNote: 'What the price moving after you put in did to this position, compared with keeping the two tokens.',
  priceEffectLoss: 'It is often called impermanent loss.',
  otherSharesWhere: 'They are part of Worth now and of no other figure here.',
  sharesLeft: 'Some shares left this account without a withdrawal this pool recorded (sent out, or burned), so what they cost is not known. Earned and versus holding cannot be worked out for this position.',
  withdrawalUnbalanced: 'A withdrawal here took out shares whose deposits were not read, so the figures cannot be worked out.',
} as const;

export interface LedgerUnits {
  coin(raw: bigint): string;
  token(raw: bigint): string;
  /** A signed coin amount; in the `about` form, one under the fourth decimal is said in words with its direction. */
  signed(x: bigint): string;
}

/** How the ledger prints amounts: `about` is four decimals, cut; `exact` is every unit, which is what a position row prints. */
export function ledgerUnits(view: PoolView, form: 'about' | 'exact'): LedgerUnits {
  const q = view.quote;
  const p = view.snapshot.pool;
  const decimals = view.quoteIsToken0 ? p.mint1Decimals : p.mint0Decimals;
  const symbol = tokenSymbol(view.tokenMint);
  const coin = (raw: bigint): string => {
    if (form === 'about') return quoteText(raw, q);
    return q.native ? `${formatSol(raw, 9)} SOL` : `${formatTokenAmount(raw, q.decimals, q.decimals).text} ${q.symbol}`;
  };
  const token = (raw: bigint): string => (form === 'about' ? tokenText(raw, decimals, symbol) : `${formatTokenAmount(raw, decimals, decimals).text} ${symbol}`);
  const fourth = 10n ** BigInt(Math.max(0, q.decimals - 4));
  const signed = (x: bigint): string => {
    const abs = x < 0n ? -x : x;
    if (form === 'about' && abs < fourth) return `under 0.0001 ${q.symbol} ${x < 0n ? 'less' : 'more'}`;
    return `${x < 0n ? '-' : '+'}${coin(abs)}`;
  };
  return { coin, token, signed };
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/** The labels of the earnings block, in the order a position row prints them. */
export const LEDGER_LABELS = {
  putIn: 'Put in',
  takenOut: 'Taken out',
  worthNow: 'Worth now',
  growth: 'Fees earned',
  versusHolding: 'Versus just holding',
  priceEffect: 'Price effect',
  locked: 'Locked at opening',
} as const;

/** One line of the earnings block: the figure beside its label, and the sentence under it. */
export interface LedgerLine { figure: string; note: string | null }

/** The ledger's sentences. The components print these and nothing of their own. */
export const ledgerText = {
  putIn(f: LedgerFigures, u: LedgerUnits): string {
    const deposits = plural(f.putIn.count, 'deposit');
    const inWhat = f.locked === null ? deposits : f.putIn.count === 0 ? '1 opening' : `1 opening and ${deposits}`;
    return `${u.coin(f.putIn.coin)} and ${u.token(f.putIn.token)}, in ${inWhat}, since ${minuteText(f.since)}`;
  },
  takenOut(f: LedgerFigures, u: LedgerUnits): string | null {
    return f.takenOut ? `${u.coin(f.takenOut.coin)} and ${u.token(f.takenOut.token)}, in ${plural(f.takenOut.count, 'withdrawal')}` : null;
  },
  worthNow(f: LedgerFigures, u: LedgerUnits): string {
    return `${u.coin(f.worthNow.coin)} and ${u.token(f.worthNow.token)}`;
  },
  /**
   * Fees earned: the growth figure. It says "trading fees" only when the pool's own record
   * shows a trade (poolPast.ts `lastTrade`); with none ever, a growth came from tokens sent
   * in. A figure below zero is deposits rounded in the pool's favour, never a fee paid.
   */
  growth(f: LedgerFigures, u: LedgerUnits, trade: LastTrade): LedgerLine {
    const never = trade.kind === 'none';
    if (f.growth.kind === 'none-yet') return { figure: LEDGER_COPY.noneYet, note: never ? LEDGER_COPY.noTradeYet : null };
    const x = f.growth.coin;
    return { figure: u.signed(x), note: x < 0n ? LEDGER_COPY.belowRounding : never ? LEDGER_COPY.noTradeButGrowth : LEDGER_COPY.feesNote };
  },
  /**
   * Under Fees earned: the pace since the first deposit read, by the chain's clock (pace.ts).
   * Null without a positive figure, a trade on the pool's record, or either time.
   */
  pace(f: LedgerFigures, trade: LastTrade, chainNow: bigint | null): string | null {
    if (f.growth.kind !== 'amount' || trade.kind === 'none' || f.since === null || chainNow === null) return null;
    return paceText({ growth: f.growth.coin, against: f.nowAndOutWorth, seconds: Number(chainNow) - f.since, of: 'position' });
  },
  /**
   * Versus just holding. The price is named as the cause only when the figures show it:
   * a price effect below zero that outweighs the fees. An opener's 100 locked units alone
   * can put this line a few units under zero with no price move at all.
   */
  versusHolding(f: LedgerFigures, u: LedgerUnits): LedgerLine {
    if (f.versusHolding.kind === 'none-yet') return { figure: LEDGER_COPY.noneYet, note: null };
    const n = f.versusHolding.coin;
    const g = f.growth.kind === 'amount' ? f.growth.coin : 0n;
    const i = f.priceEffect.kind === 'amount' ? f.priceEffect.coin : 0n;
    const priceDidIt = n < 0n && i < 0n && g + i < 0n;
    return { figure: u.signed(n), note: priceDidIt ? `${LEDGER_COPY.versusNote} ${LEDGER_COPY.priceCostMore}` : LEDGER_COPY.versusNote };
  },
  priceEffect(f: LedgerFigures, u: LedgerUnits): LedgerLine {
    if (f.priceEffect.kind === 'none-yet') return { figure: LEDGER_COPY.noneYet, note: null };
    const x = f.priceEffect.coin;
    return { figure: u.signed(x), note: x < 0n ? `${LEDGER_COPY.priceEffectNote} ${LEDGER_COPY.priceEffectLoss}` : LEDGER_COPY.priceEffectNote };
  },
  locked(f: LedgerFigures, u: LedgerUnits): string | null {
    return f.locked === null ? null : `${u.coin(f.locked)}: the ${LOCKED_SHARES_TEXT} every new pool keeps.`;
  },
  window(r: { window: LedgerWindow }, readAgoSec: number): string {
    const w = r.window;
    const head = `From ${plural(w.count, 'transaction')} of your share account, back to ${minuteText(w.oldest)}, read ${readAgoSec} s ago. ${LEDGER_COPY.exactTo}`;
    return w.more ? `${head} The last ${w.count} transactions on this share account were read; older ones were not.` : head;
  },
  otherShares(f: LedgerFigures, u: LedgerUnits): string | null {
    if (!f.otherShares) return null;
    const n = formatTokenAmount(f.otherShares.lp, 9, 9).text;
    return `${n} ${n === '1' ? 'share' : 'shares'} arrived another way (sent to this account, or older than the transactions read): worth ${u.coin(f.otherShares.worth.coin)} and ${u.token(f.otherShares.worth.token)} now. ${LEDGER_COPY.otherSharesWhere}`;
  },
  worthOnly(r: Extract<LedgerRead, { kind: 'worth-only' }>): string {
    const when = (kind: 'unread' | 'mixed') => minuteText(r.entries.find((e) => e.kind === kind)?.blockTime ?? null);
    switch (r.why) {
      case 'shares-left': return LEDGER_COPY.sharesLeft;
      case 'withdrawal-unbalanced': return LEDGER_COPY.withdrawalUnbalanced;
      case 'run-start-not-read': return `Your history in this pool goes back further than the ${plural(r.window.count, 'transaction')} this page reads (the oldest read is from ${minuteText(r.window.oldest)}), so what you put in could not be fully read.`;
      case 'unread-entry': return `One of your transactions in this pool (${when('unread')}) could not be read.`;
      case 'mixed-entry': return `A transaction on ${when('mixed')} changed this pool in more than one way at once, which this page cannot read as one deposit or withdrawal.`;
      case 'no-deposit-read': return `None of the ${plural(r.window.count, 'transaction')} read on this share account is a deposit by this wallet into this pool, so these shares arrived another way (sent to this account) and what they cost is not known.`;
    }
  },
  unread(detail: string): string {
    return `Your share account’s history could not be read (${detail}).`;
  },
  paused(): string {
    return pausedText();
  },
};
