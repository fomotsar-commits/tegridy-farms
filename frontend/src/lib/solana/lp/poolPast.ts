import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { IX_DEPOSIT, IX_INITIALIZE, IX_SWAP_BASE_INPUT, IX_SWAP_BASE_OUTPUT, IX_WITHDRAW } from '../cpswap/program';
import { minuteText, quoteText, tokenText } from './format';
import { tokenSymbol } from './identity';
import { detailOf, discriminatorIs, stepsNaming, transactionsOf, vaultMoves } from './ledger';
import type { PoolView } from './poolFinder';
import { formatWhen } from './poolHealth';
import { optionalReadAllowed, pausedText } from './rpcBudget';
import { HISTORY_PAGE, readSignatures, type ParsedTx, type SigEntry } from './txHistory';

/**
 * A pool's past, from what the finder already read for free: the price record the
 * program itself writes. `initialized` flips only inside the oracle's `update`, which
 * only a swap calls (states/oracle.rs, swap_base_input.rs), so it is the fact "a trade
 * has reached this pool", and `last_update_timestamp` is when the last one did. The fee
 * counters are never the source: a dust swap books a protocol fee of 0 and still flips
 * the record. The time is printed, never the word "active": a dust swap makes any dead
 * pool's record read minutes old.
 */

export type LastTrade = { kind: 'none' } | { kind: 'at'; time: bigint } | { kind: 'unread'; detail: string };

/** When the pool's last trade happened, from its own record; `none` before the first swap. */
export function lastTrade(view: PoolView): LastTrade {
  const h = view.history;
  if (h.kind === 'not-read') return { kind: 'unread', detail: 'not read yet' };
  if (h.kind === 'unread') return { kind: 'unread', detail: h.detail };
  const obs = h.obs;
  if (!obs.initialized) return { kind: 'none' };
  // The newest slot's own time stands in when `last_update_timestamp` is 0 (as ownPrice.ts reads it).
  const time = obs.lastUpdate > 0n ? obs.lastUpdate : obs.observations[obs.index]!.blockTimestamp;
  // `update` writes both times from the Clock; a ring with neither is not one the program wrote.
  if (time === 0n) return { kind: 'unread', detail: 'its price record carries no time' };
  return { kind: 'at', time };
}

export const NO_TRADE_YET = 'No trade has reached this pool yet.';

export const lastTradeText = (t: LastTrade): string => {
  if (t.kind === 'none') return NO_TRADE_YET;
  if (t.kind === 'at') return `Last trade: ${formatWhen(t.time)}`;
  return `Its trade record could not be read (${t.detail}).`;
};

// ── the pool's last 20 transactions, on a press ──────────────────────────────────────
//
// Bounded to one page a press (txHistory.ts), behind the budget gate, classified by the cp-swap
// discriminators. Fees traders paid are NOT summed: every swap reads the rate live and the
// vault can change it, so a sum at today's rate is an estimate under a measured label.

export type PoolTx =
  | { kind: 'swap'; signature: string; slot: number; blockTime: number | null; final: boolean; inSide: 'token' | 'coin'; inAmount: bigint }
  | { kind: 'deposit' | 'withdrawal' | 'opening'; signature: string; slot: number; blockTime: number | null; final: boolean; signer: string }
  | { kind: 'mixed' | 'failed' | 'other'; signature: string; slot: number; blockTime: number | null; final: boolean }
  | { kind: 'unread'; signature: string; blockTime: number | null; detail: string };

export type PoolPastRead =
  | {
      kind: 'ok';
      count: number;
      swaps: number;
      deposits: number;
      withdrawals: number;
      openings: number;
      /** Distinct wallets that signed a deposit. */
      wallets: number;
      /** Transactions on the pool that were none of the above, failed, or changed it in more than one way at once. */
      other: number;
      /** What swaps put in, per side: the rising vault's delta, never the trader's side. */
      volumeIn: { token: bigint; coin: bigint };
      from: number | null;
      to: number | null;
      /** The whole history was read (the page was not full). */
      complete: boolean;
      reachedOpening: boolean;
    }
  | { kind: 'partial'; unreadCount: number }
  | { kind: 'unread'; detail: string }
  | { kind: 'paused' };

/**
 * One transaction of the pool by what it did: a swap when ONE cp-swap step names the pool
 * with a swap discriminator and one vault rose while the other fell; a deposit, withdrawal
 * or opening by its discriminator with the wallet in the owner slot, which must have signed.
 */
export function classifyPoolTx(sig: SigEntry, tx: ParsedTx | null, view: PoolView, programId: string): PoolTx {
  if (tx === null) return { kind: 'unread', signature: sig.signature, blockTime: sig.blockTime, detail: 'the node has no record of it' };
  const at = { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, final: sig.confirmationStatus === 'finalized' };
  if (tx.err !== null) return { kind: 'failed', ...at };
  const steps = stepsNaming(tx, view.address, programId);
  if (steps.length > 1) return { kind: 'mixed', ...at };
  if (steps.length === 0) return { kind: 'other', ...at };
  const ix = steps[0]!;
  if (discriminatorIs(ix, IX_SWAP_BASE_INPUT) || discriminatorIs(ix, IX_SWAP_BASE_OUTPUT)) {
    if (tx.pre.length === 0 && tx.post.length === 0) return { kind: 'unread', signature: tx.signature, blockTime: tx.blockTime, detail: 'the record carries no token balances' };
    const m = vaultMoves(tx, view);
    if (m.coin > 0n && m.token < 0n) return { kind: 'swap', ...at, inSide: 'coin', inAmount: m.coin };
    if (m.token > 0n && m.coin < 0n) return { kind: 'swap', ...at, inSide: 'token', inAmount: m.token };
    return { kind: 'other', ...at };
  }
  const kind = discriminatorIs(ix, IX_DEPOSIT) ? 'deposit' : discriminatorIs(ix, IX_WITHDRAW) ? 'withdrawal' : discriminatorIs(ix, IX_INITIALIZE) ? 'opening' : null;
  const signer = ix.accounts[0];
  if (kind === null || signer === undefined || !tx.signers.includes(signer)) return { kind: 'other', ...at };
  return { kind, ...at, signer };
}

/** The totals over one page (newest first). Any unread entry makes the page partial: nothing is summed from a partial list. */
export function poolPastTotals(items: PoolTx[], more: boolean): PoolPastRead {
  const unreadCount = items.filter((t) => t.kind === 'unread').length;
  if (unreadCount > 0) return { kind: 'partial', unreadCount };
  const count = (k: PoolTx['kind']) => items.filter((t) => t.kind === k).length;
  const volumeIn = { token: 0n, coin: 0n };
  for (const t of items) if (t.kind === 'swap') volumeIn[t.inSide] += t.inAmount;
  const times = items.flatMap((t) => (t.blockTime === null ? [] : [t.blockTime]));
  return {
    kind: 'ok',
    count: items.length,
    swaps: count('swap'),
    deposits: count('deposit'),
    withdrawals: count('withdrawal'),
    openings: count('opening'),
    wallets: new Set(items.flatMap((t) => (t.kind === 'deposit' ? [t.signer] : []))).size,
    other: count('other') + count('mixed') + count('failed'),
    volumeIn,
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    complete: !more,
    reachedOpening: count('opening') > 0,
  };
}

/** One page as read: its entries, newest first, and whether the server had more. */
export type PoolPastPage = { kind: 'page'; items: PoolTx[]; more: boolean } | { kind: 'unread'; detail: string } | { kind: 'paused' };

/**
 * One press: the budget gate, one signatures page of the pool, the transactions not in
 * memory. The entries come back, not their totals: two pages' totals cannot be added (a
 * wallet on both would count twice), so "Read 20 more" joins entries and totals them again.
 */
export async function readPoolPastPage(rpc: SolanaRpc, view: PoolView, programId: string, opts: { before?: string } = {}): Promise<PoolPastPage> {
  if (!optionalReadAllowed()) return { kind: 'paused' };
  try {
    const page = await readSignatures(rpc, view.address, opts);
    const txs = await transactionsOf(rpc, page.entries);
    return { kind: 'page', items: page.entries.map((e) => classifyPoolTx(e, txs.get(e.signature) ?? null, view, programId)), more: page.more };
  } catch (e) {
    return { kind: 'unread', detail: detailOf(e) };
  }
}

/** The totals of what was read: one page, or several pages' entries joined, newest first. */
export function pagePast(page: PoolPastPage): PoolPastRead {
  return page.kind === 'page' ? poolPastTotals(page.items, page.more) : page;
}

/** One page and its totals. */
export async function readPoolPast(rpc: SolanaRpc, view: PoolView, programId: string, opts: { before?: string } = {}): Promise<PoolPastRead> {
  return pagePast(await readPoolPastPage(rpc, view, programId, opts));
}

export const POOL_PAST_BUTTON = 'Read this pool’s last 20 transactions';
export const POOL_PAST_READING = 'Reading this pool’s transactions…';
export const POOL_PAST_READ_MORE = 'Read 20 more';
export const POOL_PAST_FEE_LINE = 'Fees are this tier’s rate on that volume; the rate can change, so no total is shown.';
export const POOL_PAST_OLDER_NOT_READ = 'Older transactions were not read.';

/**
 * Why an older page was not joined to what is shown, or null when it can be. A page with
 * an entry that could not be read is left out whole: totals over part of a page would be
 * wrong, and what was read before it stays as it is.
 */
export function olderPageProblem(page: PoolPastPage): string | null {
  if (page.kind === 'paused') return pausedText();
  if (page.kind === 'unread') return `The older transactions could not be read (${page.detail}).`;
  const unread = page.items.filter((t) => t.kind === 'unread').length;
  return unread > 0 ? `${unread} of the older transactions could not be read, so none of that page is counted. Press Read 20 more again.` : null;
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/** The pool past in one sentence, verbatim (DESIGN 2.B1). */
export function poolPastText(read: PoolPastRead, view: PoolView): string {
  if (read.kind === 'paused') return pausedText();
  if (read.kind === 'unread') return `This pool’s history could not be read (${read.detail}).`;
  if (read.kind === 'partial') return `${read.unreadCount} of the ${HISTORY_PAGE} could not be read, so no totals are shown. Read again.`;
  const p = view.snapshot.pool;
  const tokenDecimals = view.quoteIsToken0 ? p.mint1Decimals : p.mint0Decimals;
  const head = read.reachedOpening
    ? `All ${read.count} transactions since this pool opened on ${minuteText(read.from)}`
    : `Last ${read.count} transactions on this pool, ${minuteText(read.from)} to ${minuteText(read.to)}`;
  const openings = read.openings ? `, ${plural(read.openings, 'opening')}` : '';
  const counts = `${plural(read.swaps, 'swap')}, ${plural(read.deposits, 'deposit')} from ${plural(read.wallets, 'wallet')}, ${plural(read.withdrawals, 'withdrawal')}${openings}, ${read.other} other`;
  const traded = `Traded in: ${quoteText(read.volumeIn.coin, view.quote)} and ${tokenText(read.volumeIn.token, tokenDecimals, tokenSymbol(view.tokenMint))}.`;
  const body = `${head}: ${counts}. ${traded} ${POOL_PAST_FEE_LINE}`;
  return read.complete ? body : `${body} ${POOL_PAST_OLDER_NOT_READ}`;
}
