// A VWAP order run by this page (owner, 2026-11-19: "i want to be able to place order based
// on a volume weighted average price", then "Both, site version first").
//
// One total is split into slices over a chosen time. Each slice is sized by when the pair
// usually trades (the hours of its last 7 days, pairAverage.ts hourlyProfile), and each one
// goes only while its price is within the person's limit of the pair's 24h average traded
// price (the same number the swap form shows). The money stays in the person's wallet: a
// slice is an ordinary Instant swap through Jupiter, signed in the wallet and sent by this
// page (walletSwapSend.ts), so the venue takes its usual site fee on each one and the page
// has to stay open. Our own pools are not used for a slice: a swap there always shows its
// review first (owner, 2026-10-13), and a slice goes without one.
//
// This file is the order's arithmetic and its record, with no reads and no clock of its
// own: the page's runner (useVwapRunner) does the reads and the sending.

import { sayAs, tradeVsAverage, type PairAverage } from './pairAverage';

export const VWAP_DURATIONS_S = [3_600, 14_400, 43_200, 86_400] as const;
export const VWAP_SLICE_COUNTS = [4, 8, 12, 24] as const;
/** How much worse than the 24h average a slice may be: 0.5%, 1%, 3%. */
export const VWAP_BANDS_BPS = [50, 100, 300] as const;
/** The on-chain floor under each slice's quote. */
export const SLICE_SLIPPAGE_BPS = 100;
/** The shortest time between two slices: the average's own candles are 15 minutes. */
export const MIN_SLICE_GAP_S = 900;
/** A slice that waited is asked again after this. */
export const RETRY_MS = 60_000;
/** A signature that comes back later than this after the wallet was asked is not sent: its price is stale. */
export const LATE_SIGN_MS = 45_000;
/**
 * A slice sent and never confirmed is called "did not land" only this long after it was
 * sent (the swap notes' own ten minutes, pendingTrade.ts), and only when two reads of the
 * chain's history find nothing. An unread answer is never a failed one: sending again on it
 * would pay twice.
 */
export const UNLANDED_AFTER_MS = 10 * 60_000;

export interface VwapCoin {
  mint: string;
  symbol: string;
  decimals: number;
}

export type SliceState = 'waiting' | 'sending' | 'unconfirmed' | 'filled' | 'missed';

export interface VwapSlice {
  /** When it may first go, ms. Its window runs to the next slice's, the last one's to the end. */
  dueAt: number;
  /** Its planned part of the total, base units of the coin paid. */
  planned: string;
  state: SliceState;
  /** Sent: its signature, and when. */
  sig?: string;
  sentAt?: number;
  /** Filled: what it paid, and what it received (read from the chain when `gotExact`, else the quote's). */
  paid?: string;
  got?: string;
  gotExact?: boolean;
  /** The last time it was tried, and why it did not go. */
  triedAt?: number;
  why?: string;
  /** The person said no in the wallet: not asked again in this slice's window. */
  declined?: boolean;
  /** Its price against the 24h average at the last try, in percent (above is more of the quote coin per base coin). */
  vsAveragePct?: number;
}

export interface VwapOrder {
  v: 1;
  id: string;
  wallet: string;
  pay: VwapCoin;
  buy: VwapCoin;
  /** Base units of `pay`. */
  total: string;
  startAt: number;
  endAt: number;
  bandBps: number;
  /** 'volume': sized by the pair's day; 'even': its day could not be read. */
  sizing: 'volume' | 'even';
  slices: VwapSlice[];
  stoppedAt?: number;
}

/** The slice counts a duration allows: at least MIN_SLICE_GAP_S between two. */
export function sliceCountsFor(durationS: number): number[] {
  return VWAP_SLICE_COUNTS.filter((n) => durationS / n >= MIN_SLICE_GAP_S);
}

/**
 * Each slice's share of the total. With a profile, a slice's weight is how much the pair
 * trades across its window (each hour of the day counted for the minutes the window spends
 * in it), held between half and twice an even share so one busy hour or one quiet one never
 * sets the order; without one, even shares. Sums to 1.
 */
export function sliceWeights(startSec: number, gapS: number, count: number, profile: readonly number[] | null): number[] {
  const even = new Array<number>(count).fill(1 / count);
  if (!profile || profile.length !== 24 || !profile.every((v) => Number.isFinite(v) && v >= 0)) return even;
  const STEP = 300;
  const raw = even.map((_, i) => {
    let w = 0;
    for (let t = startSec + i * gapS; t < startSec + (i + 1) * gapS; t += STEP) w += profile[new Date(t * 1_000).getUTCHours()]!;
    return w;
  });
  const sum = raw.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) return even;
  let w = raw.map((x) => x / sum);
  // Clamped and spread again twice: close enough to the bounds for a share of a slice.
  for (let pass = 0; pass < 2; pass++) {
    w = w.map((x) => Math.min(2 / count, Math.max(0.5 / count, x)));
    const s = w.reduce((a, x) => a + x, 0);
    w = w.map((x) => x / s);
  }
  return w;
}

/** Splits `total` by `weights` exactly: floors, then the units left over go to the last slice. Null when any slice would be zero. */
export function splitTotal(total: bigint, weights: readonly number[]): bigint[] | null {
  if (total <= 0n || weights.length === 0 || !weights.every((w) => Number.isFinite(w) && w >= 0)) return null;
  // Each weight in billionths: exact integers from here on.
  const parts = weights.map((w) => BigInt(Math.round(w * 1e9)));
  const sum = parts.reduce((s, p) => s + p, 0n);
  if (sum <= 0n) return null;
  const out = parts.map((p) => (total * p) / sum);
  out[out.length - 1]! += total - out.reduce((s, p) => s + p, 0n);
  return out.every((p) => p > 0n) ? out : null;
}

export function planOrder(a: {
  id: string;
  wallet: string;
  pay: VwapCoin;
  buy: VwapCoin;
  total: bigint;
  startAt: number;
  durationS: number;
  count: number;
  bandBps: number;
  profile: readonly number[] | null;
}): VwapOrder | null {
  if (a.pay.mint === a.buy.mint || !sliceCountsFor(a.durationS).includes(a.count)) return null;
  if (!(VWAP_BANDS_BPS as readonly number[]).includes(a.bandBps)) return null;
  const gapS = a.durationS / a.count;
  const weights = sliceWeights(Math.floor(a.startAt / 1_000), gapS, a.count, a.profile);
  const parts = splitTotal(a.total, weights);
  if (!parts) return null;
  return {
    v: 1,
    id: a.id,
    wallet: a.wallet,
    pay: a.pay,
    buy: a.buy,
    total: a.total.toString(),
    startAt: a.startAt,
    endAt: a.startAt + a.durationS * 1_000,
    bandBps: a.bandBps,
    sizing: a.profile ? 'volume' : 'even',
    slices: parts.map((p, i) => ({ dueAt: a.startAt + i * gapS * 1_000, planned: p.toString(), state: 'waiting' })),
  };
}

/** What the order has paid in slices that filled, and what they received. */
export function filledTotals(o: VwapOrder): { paid: bigint; got: bigint; filled: number; exact: boolean } {
  let paid = 0n;
  let got = 0n;
  let filled = 0;
  let exact = true;
  for (const s of o.slices) {
    if (s.state !== 'filled') continue;
    paid += BigInt(s.paid ?? '0');
    got += BigInt(s.got ?? '0');
    filled++;
    if (!s.gotExact) exact = false;
  }
  return { paid, got, filled, exact };
}

/** The end of slice `i`'s window. */
export const windowEnd = (o: VwapOrder, i: number): number => o.slices[i + 1]?.dueAt ?? o.endAt;

/** Slices whose window has passed while they waited are missed: what they were to pay carries on to the next one. */
export function advance(o: VwapOrder, now: number): VwapOrder {
  let changed = false;
  const slices = o.slices.map((s, i) => {
    if (s.state === 'waiting' && windowEnd(o, i) <= now) {
      changed = true;
      return { ...s, state: 'missed' as const };
    }
    return s;
  });
  return changed ? { ...o, slices } : o;
}

export type VwapAction =
  /** Nothing more will be sent. */
  | { kind: 'done'; why: 'filled' | 'stopped' | 'ended' }
  /** A slice is out: read what became of it before anything else is sent. */
  | { kind: 'resolve'; index: number }
  | { kind: 'wait'; until: number }
  /** Slice `index` is due: send `amount` (its planned part, with what earlier slices did not pay). */
  | { kind: 'send'; index: number; amount: bigint };

/** What the runner does next, for an order `advance`d to `now`. */
export function nextAction(o: VwapOrder, now: number): VwapAction {
  const out = o.slices.findIndex((s) => s.state === 'sending' || s.state === 'unconfirmed');
  if (out >= 0) return { kind: 'resolve', index: out };
  if (o.stoppedAt !== undefined) return { kind: 'done', why: 'stopped' };
  const { paid } = filledTotals(o);
  const left = BigInt(o.total) - paid;
  if (left <= 0n) return { kind: 'done', why: 'filled' };
  if (now >= o.endAt) return { kind: 'done', why: 'ended' };
  let k = -1;
  for (let i = 0; i < o.slices.length; i++) if (o.slices[i]!.dueAt <= now) k = i;
  if (k < 0) return { kind: 'wait', until: o.slices[0]!.dueAt };
  const slice = o.slices[k]!;
  const next = windowEnd(o, k);
  if (slice.state !== 'waiting' || slice.declined) return { kind: 'wait', until: next };
  const due = o.slices.slice(0, k + 1).reduce((s, x) => s + BigInt(x.planned), 0n) - paid;
  const amount = due < left ? due : left;
  if (amount <= 0n) return { kind: 'wait', until: next };
  if (slice.triedAt !== undefined && now - slice.triedAt < RETRY_MS) return { kind: 'wait', until: Math.min(slice.triedAt + RETRY_MS, next) };
  return { kind: 'send', index: k, amount };
}

/** A copy of the order with slice `i` changed. */
export function withSlice(o: VwapOrder, i: number, patch: Partial<VwapSlice>): VwapOrder {
  return { ...o, slices: o.slices.map((s, j) => (j === i ? { ...s, ...patch } : s)) };
}

/** Base units as a plain decimal number of whole coins, for prices only (never for amounts sent). */
const whole = (base: bigint, decimals: number): number => Number(base) / 10 ** decimals;

export type SliceVerdict =
  | { go: true; vsAveragePct: number }
  | { go: false; why: string; vsAveragePct?: number };

/**
 * Whether a slice may go at this quote: the pair's 24h average must be readable, and the
 * slice's price no worse for the person than `bandBps` from it. Worse is paying more per
 * coin bought, or getting less per coin sold.
 */
export function sliceVerdict(avg: PairAverage, o: Pick<VwapOrder, 'pay' | 'buy' | 'bandBps'>, payBase: bigint, outBase: bigint): SliceVerdict {
  if (avg.kind === 'thin') return { go: false, why: 'Too little trading in the last 24 hours to work out an average, so this slice waits.' };
  if (avg.kind === 'none') return { go: false, why: 'This pair has no market to average, so this slice waits.' };
  if (avg.kind === 'unread') return { go: false, why: 'The 24h average could not be read just now. This slice tries again in a minute.' };
  const pct = tradeVsAverage(avg, {
    payMint: o.pay.mint,
    buyMint: o.buy.mint,
    payAmount: whole(payBase, o.pay.decimals),
    buyAmount: whole(outBase, o.buy.decimals),
  });
  if (pct === null) return { go: false, why: 'This slice’s price could not be compared with the 24h average, so it waits.' };
  const limit = o.bandBps / 100;
  const buying = o.pay.mint === avg.quoteMint;
  const worse = buying ? pct > limit : pct < -limit;
  if (!worse) return { go: true, vsAveragePct: pct };
  const by = Math.abs(pct).toFixed(2);
  return {
    go: false,
    vsAveragePct: pct,
    why: `The price is ${by}% ${buying ? 'above' : 'below'} the 24h average, past your ${limit}%. This slice waits for a better price.`,
  };
}

/**
 * The order's own average price, said the way the swap form says the 24h average: how many
 * of the quote coin per base coin. Null until a slice filled.
 */
export function orderAveragePrice(o: VwapOrder): { price: number; base: VwapCoin; quote: VwapCoin } | null {
  const { paid, got } = filledTotals(o);
  if (paid <= 0n || got <= 0n) return null;
  const [baseMint] = sayAs(o.pay.mint, o.buy.mint);
  const payIsBase = baseMint === o.pay.mint;
  const paidW = whole(paid, o.pay.decimals);
  const gotW = whole(got, o.buy.decimals);
  const price = payIsBase ? gotW / paidW : paidW / gotW;
  if (!Number.isFinite(price) || price <= 0) return null;
  return payIsBase ? { price, base: o.pay, quote: o.buy } : { price, base: o.buy, quote: o.pay };
}

// ── The record, in this browser ──────────────────────────────────────────────

const KEY_PREFIX = 'vwap-order:v1:';
export const orderStorageKey = (wallet: string): string => `${KEY_PREFIX}${wallet}`;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const DIGITS = /^\d{1,40}$/;
const STATES: ReadonlySet<string> = new Set(['waiting', 'sending', 'unconfirmed', 'filled', 'missed']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function coinOf(v: unknown): VwapCoin | null {
  if (!isObj(v) || typeof v.mint !== 'string' || !BASE58.test(v.mint) || typeof v.symbol !== 'string' || v.symbol.length > 40) return null;
  if (typeof v.decimals !== 'number' || !Number.isInteger(v.decimals) || v.decimals < 0 || v.decimals > 18) return null;
  return { mint: v.mint, symbol: v.symbol, decimals: v.decimals };
}

function sliceOf(v: unknown): VwapSlice | null {
  if (!isObj(v) || !time(v.dueAt) || typeof v.planned !== 'string' || !DIGITS.test(v.planned)) return null;
  if (typeof v.state !== 'string' || !STATES.has(v.state)) return null;
  const s: VwapSlice = { dueAt: v.dueAt, planned: v.planned, state: v.state as SliceState };
  if (v.sig !== undefined) {
    if (typeof v.sig !== 'string' || !SIGNATURE.test(v.sig)) return null;
    s.sig = v.sig;
  }
  // A slice out with no signature is only "sending" (nothing left the page); one that is "unconfirmed" or "filled" needs one.
  if ((s.state === 'unconfirmed' || s.state === 'filled') && !s.sig) return null;
  for (const k of ['paid', 'got'] as const) {
    const x = v[k];
    if (x === undefined) continue;
    if (typeof x !== 'string' || !DIGITS.test(x)) return null;
    s[k] = x;
  }
  if (s.state === 'filled' && (s.paid === undefined || s.got === undefined)) return null;
  for (const k of ['sentAt', 'triedAt'] as const) {
    const x = v[k];
    if (x === undefined) continue;
    if (!time(x)) return null;
    s[k] = x;
  }
  if (s.state === 'unconfirmed' && s.sentAt === undefined) return null;
  if (typeof v.gotExact === 'boolean') s.gotExact = v.gotExact;
  if (v.declined === true) s.declined = true;
  if (typeof v.why === 'string' && v.why.length <= 400) s.why = v.why;
  if (typeof v.vsAveragePct === 'number' && Number.isFinite(v.vsAveragePct)) s.vsAveragePct = v.vsAveragePct;
  return s;
}

/** An order as stored, or null for anything that is not exactly one: a record that does not read is never run. */
export function parseOrder(raw: unknown, wallet: string): VwapOrder | null {
  if (!isObj(raw) || raw.v !== 1 || raw.wallet !== wallet || typeof raw.id !== 'string' || raw.id.length > 64) return null;
  const pay = coinOf(raw.pay);
  const buy = coinOf(raw.buy);
  if (!pay || !buy || pay.mint === buy.mint) return null;
  if (typeof raw.total !== 'string' || !DIGITS.test(raw.total) || BigInt(raw.total) <= 0n) return null;
  if (!time(raw.startAt) || !time(raw.endAt) || raw.endAt <= raw.startAt) return null;
  if (typeof raw.bandBps !== 'number' || !(VWAP_BANDS_BPS as readonly number[]).includes(raw.bandBps)) return null;
  if (raw.sizing !== 'volume' && raw.sizing !== 'even') return null;
  if (!Array.isArray(raw.slices) || raw.slices.length === 0 || raw.slices.length > 24) return null;
  const slices: VwapSlice[] = [];
  for (const x of raw.slices) {
    const s = sliceOf(x);
    if (!s) return null;
    slices.push(s);
  }
  if (slices.reduce((t, s) => t + BigInt(s.planned), 0n) !== BigInt(raw.total)) return null;
  for (let i = 1; i < slices.length; i++) if (slices[i]!.dueAt <= slices[i - 1]!.dueAt) return null;
  if (slices[0]!.dueAt < raw.startAt || slices[slices.length - 1]!.dueAt >= raw.endAt) return null;
  const o: VwapOrder = { v: 1, id: raw.id, wallet, pay, buy, total: raw.total, startAt: raw.startAt, endAt: raw.endAt, bandBps: raw.bandBps, sizing: raw.sizing, slices };
  if (raw.stoppedAt !== undefined) {
    if (!time(raw.stoppedAt)) return null;
    o.stoppedAt = raw.stoppedAt;
  }
  return o;
}

export function readOrder(wallet: string): VwapOrder | null {
  try {
    const raw = localStorage.getItem(orderStorageKey(wallet));
    return raw === null ? null : parseOrder(JSON.parse(raw), wallet);
  } catch {
    return null;
  }
}

/** False when the browser would not keep it: the runner then sends nothing it could not record. */
export function writeOrder(o: VwapOrder): boolean {
  try {
    localStorage.setItem(orderStorageKey(o.wallet), JSON.stringify(o));
    return true;
  } catch {
    return false;
  }
}

export function clearOrder(wallet: string): void {
  try {
    localStorage.removeItem(orderStorageKey(wallet));
  } catch {
    /* blocked site data: nothing was kept */
  }
}
