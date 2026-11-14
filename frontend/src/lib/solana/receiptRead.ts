import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { fundFee, protocolFee } from './cpswap/math';
import { RECEIPT_WORDS } from '../arrival';
import { settleReceipt, type ReceiptFee } from '../receipt';

/**
 * The receipt card's figures, read from the confirmed transaction (island answer twenty-five,
 * screen 3: "Never a typed figure: the rows are what the signature paid"). A swap in the
 * venue's own pool is read from the pool program's own event, its fee split by the program's
 * own arithmetic and the pool's fee settings; a swap through Jupiter from what the venue's fee
 * account received in that transaction; an add from the pool program's deposit event. A read
 * that fails leaves the card saying so, never a guess.
 */

// Anchor event discriminators: sha256("event:<Name>")[0..8], as the fork's cp-swap emits them.
const SWAP_EVENT = '40c6cde8260871e2';
const LP_CHANGE_EVENT = '79a3cdc939da753c';
const DATA = 'Program data: ';

export interface SwapEvent {
  pool: string;
  inputAmount: bigint;
  outputAmount: bigint;
  inputMint: string;
  outputMint: string;
  /** The pool's trade fee, in the input coin; its LP, protocol and fund parts are taken out of it. */
  tradeFee: bigint;
  creatorFee: bigint;
  creatorFeeOnInput: boolean;
}

export interface LpChange {
  pool: string;
  amount0: bigint;
  amount1: bigint;
  deposit: boolean;
}

function bytesOf(b64: string): Uint8Array | null {
  try {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const hex8 = (b: Uint8Array) => Array.from(b.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const key = (b: Uint8Array, at: number) => new PublicKey(b.subarray(at, at + 32)).toBase58();

/** The pool program's swap and deposit events in a transaction's logs. */
export function eventsOf(logs: readonly string[] | null | undefined): { swaps: SwapEvent[]; lp: LpChange[] } {
  const swaps: SwapEvent[] = [];
  const lp: LpChange[] = [];
  for (const line of logs ?? []) {
    if (!line.startsWith(DATA)) continue;
    const b = bytesOf(line.slice(DATA.length));
    if (!b || b.length < 8) continue;
    const disc = hex8(b);
    // SwapEvent: pool, two vaults before, input and output amounts, two transfer fees, base_input,
    // the two mints, trade fee, creator fee, creator_fee_on_input: 170 bytes.
    if (disc === SWAP_EVENT && b.length >= 170) {
      swaps.push({
        pool: key(b, 8),
        inputAmount: u64(b, 56),
        outputAmount: u64(b, 64),
        inputMint: key(b, 89),
        outputMint: key(b, 121),
        tradeFee: u64(b, 153),
        creatorFee: u64(b, 161),
        creatorFeeOnInput: b[169] === 1,
      });
    }
    // LpChangeEvent: pool, lp before, two vaults before, the two amounts, two transfer fees, change type: 97 bytes.
    if (disc === LP_CHANGE_EVENT && b.length >= 97) {
      lp.push({ pool: key(b, 8), amount0: u64(b, 64), amount1: u64(b, 72), deposit: b[96] === 0 });
    }
  }
  return { swaps, lp };
}

/** A swap's trade fee split as the pool program splits it: the venue's protocol and fund parts floored out of it, the rest the LPs'. */
export function poolFeeSplit(e: SwapEvent, rates: { protocolFeeRate: bigint; fundFeeRate: bigint }): { fee: bigint; lps: bigint; venue: bigint } | null {
  const protocol = protocolFee(e.tradeFee, rates.protocolFeeRate);
  const fund = fundFee(e.tradeFee, rates.fundFeeRate);
  if (protocol === null || fund === null || protocol + fund > e.tradeFee) return null;
  return { fee: e.tradeFee, lps: e.tradeFee - protocol - fund, venue: protocol + fund };
}

type Meta = {
  err: unknown;
  fee: number;
  logMessages?: readonly string[] | null;
  preTokenBalances?: readonly TokenBalance[] | null;
  postTokenBalances?: readonly TokenBalance[] | null;
};
type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };

/** What an owner's accounts of one mint gained (negative: spent) in a transaction. */
export function ownerDelta(meta: Meta, owner: string, mint: string): bigint {
  const sum = (list: readonly TokenBalance[] | null | undefined) =>
    (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

/** What the venue's fee wallet's token accounts received, by mint, with each mint's decimals. */
export function feeReceived(meta: Meta, feeOwner: string): { mint: string; amount: bigint; decimals: number }[] {
  const out = new Map<string, { amount: bigint; decimals: number }>();
  const add = (list: readonly TokenBalance[] | null | undefined, sign: 1n | -1n) => {
    for (const b of list ?? []) {
      if (b.owner !== feeOwner) continue;
      const had = out.get(b.mint) ?? { amount: 0n, decimals: b.uiTokenAmount.decimals };
      out.set(b.mint, { amount: had.amount + sign * BigInt(b.uiTokenAmount.amount), decimals: b.uiTokenAmount.decimals });
    }
  };
  add(meta.postTokenBalances, 1n);
  add(meta.preTokenBalances, -1n);
  return [...out].filter(([, v]) => v.amount > 0n).map(([mint, v]) => ({ mint, ...v }));
}

/** Base units as the card writes them: exact, no trailing zeros, the whole part grouped; past 1,000 whole units only (never more than was moved). */
export function amountText(base: bigint, decimals: number, wholeOnlyFrom = 1_000n): string {
  const scale = 10n ** BigInt(decimals);
  const whole = base / scale;
  const grouped = whole.toLocaleString('en-US');
  if (whole >= wholeOnlyFrom || decimals === 0) return grouped;
  const frac = (base % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  // Under one whole unit every digit stays (0.00084 SOL); from one up, four places at most.
  const shown = whole >= 1n ? frac.slice(0, 4).replace(/0+$/, '') : frac;
  return shown ? `${grouped}.${shown}` : grouped;
}

const feeText = (base: bigint, decimals: number, symbol: string) => `${amountText(base, decimals, 10n ** 30n)} ${symbol}`;

type Rpc = Pick<Connection, 'getTransaction'>;
type Tx = NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>;

/** The confirmed transaction, asked again while the node has not indexed it yet (a few seconds at most). */
export async function readTx(rpc: Rpc, signature: string, waitsMs: readonly number[] = [1_000, 2_000, 4_000]): Promise<Tx | null> {
  if (typeof rpc.getTransaction !== 'function') return null;
  for (let i = 0; ; i++) {
    try {
      const tx = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx) return tx;
    } catch {
      /* asked again below */
    }
    const wait = waitsMs[i];
    if (wait === undefined) return null;
    await new Promise((r) => setTimeout(r, wait));
  }
}

export interface Coin {
  mint: string;
  symbol: string;
  decimals: number;
}

export type FeeRoute =
  | { kind: 'pool'; pool: string; rates: { protocolFeeRate: bigint; fundFeeRate: bigint } }
  | { kind: 'site'; feeOwner: string | null }
  /** Whichever the transaction shows: a swap in this pool, else Jupiter's route (step 1 of an add made with one coin). */
  | { kind: 'auto'; pool: string; rates: { protocolFeeRate: bigint; fundFeeRate: bigint }; feeOwner: string | null };

/** The fee rows of one swap's transaction, by its route. */
export function swapFee(meta: Meta, route: FeeRoute, paid: Coin): ReceiptFee {
  if (route.kind === 'auto') {
    const inPool = eventsOf(meta.logMessages).swaps.some((s) => s.pool === route.pool);
    return swapFee(meta, inPool ? { kind: 'pool', pool: route.pool, rates: route.rates } : { kind: 'site', feeOwner: route.feeOwner }, paid);
  }
  if (route.kind === 'pool') {
    const e = eventsOf(meta.logMessages).swaps.find((s) => s.pool === route.pool);
    const split = e ? poolFeeSplit(e, route.rates) : null;
    if (!e || !split) return { kind: 'unread' };
    // The trade fee is in the coin paid in; a creator fee on the way out is in the other coin.
    const unit = e.inputMint === paid.mint ? paid : null;
    if (!unit) return { kind: 'unread' };
    const creator = e.creatorFee > 0n && e.creatorFeeOnInput ? feeText(e.creatorFee, unit.decimals, unit.symbol) : null;
    return { kind: 'pool', unit: unit.symbol, fee: feeText(split.fee + (creator ? e.creatorFee : 0n), unit.decimals, unit.symbol), lps: feeText(split.lps, unit.decimals, unit.symbol), venue: feeText(split.venue, unit.decimals, unit.symbol), creator };
  }
  if (!route.feeOwner) return { kind: 'site', venue: null };
  const got = feeReceived(meta, route.feeOwner);
  if (got.length === 0) return { kind: 'site', venue: null };
  const symbolOf = (mint: string) => (mint === paid.mint ? paid.symbol : mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' ? 'USDT' : `${mint.slice(0, 4)}…`);
  return { kind: 'site', venue: got.map((g) => feeText(g.amount, g.decimals, symbolOf(g.mint))).join(' + ') };
}

/**
 * A swap's card, settled from its transaction: what it paid and got (the pool's event, or for
 * Jupiter's route what was sent and what the wallet received) and the fee rows.
 */
export async function settleSwapReceipt(
  rpc: Rpc,
  signature: string,
  ask: { wallet: string; action: 'bought' | 'sold'; paid: Coin; got: Coin & { native: boolean }; sent: bigint; route: FeeRoute; coin: string },
): Promise<void> {
  const tx = await readTx(rpc, signature);
  const meta = tx?.meta as Meta | null | undefined;
  if (!tx || !meta || meta.err) {
    settleReceipt(signature, { fee: { kind: 'unread' } });
    return;
  }
  const e = ask.route.kind === 'pool' ? eventsOf(meta.logMessages).swaps.find((s) => ask.route.kind === 'pool' && s.pool === ask.route.pool) : undefined;
  let got: bigint | null = e ? e.outputAmount : null;
  if (got === null && !ask.got.native) got = ownerDelta(meta, ask.wallet, ask.got.mint);
  if (got === null && ask.got.native) {
    // Native SOL out: the payer's lamports, the network fee given back (receivedBy's reading).
    const payer = tx.transaction.message.staticAccountKeys[0]?.toBase58();
    const pre = tx.meta?.preBalances[0];
    const post = tx.meta?.postBalances[0];
    got = payer === ask.wallet && pre !== undefined && post !== undefined ? BigInt(post) - BigInt(pre) + BigInt(meta.fee) : null;
  }
  const paidAmount = e ? e.inputAmount : ask.sent;
  const bought = ask.action === 'bought';
  const coinAmount = bought ? got : paidAmount;
  const otherAmount = bought ? paidAmount : got;
  const coinSide = bought ? ask.got : ask.paid;
  const otherSide = bought ? ask.paid : ask.got;
  settleReceipt(signature, {
    title:
      coinAmount !== null && coinAmount > 0n
        ? bought
          ? RECEIPT_WORDS.bought(amountText(coinAmount, coinSide.decimals), ask.coin)
          : RECEIPT_WORDS.sold(amountText(coinAmount, coinSide.decimals), ask.coin)
        : null,
    under: otherAmount !== null && otherAmount > 0n ? RECEIPT_WORDS.boughtFor(amountText(otherAmount, otherSide.decimals), otherSide.symbol) : null,
    fee: swapFee(meta, ask.route, ask.paid),
  });
}

/**
 * An add's card, settled from its transaction: what went into the pool (the pool's deposit
 * event), and either the swap leg's fee rows (an add made with one coin) or, for an add of both
 * coins, which pays the pool no fee, the network's cost.
 */
export async function settleAddReceipt(
  rpc: Rpc,
  signature: string,
  ask: { pool: string; quote: Coin; token: Coin; quoteIsToken0: boolean; leg: { signature: string; route: FeeRoute; paid: Coin } | null },
): Promise<void> {
  const tx = await readTx(rpc, signature);
  const meta = tx?.meta as Meta | null | undefined;
  if (!tx || !meta || meta.err) {
    settleReceipt(signature, { fee: { kind: 'unread' } });
    return;
  }
  const change = eventsOf(meta.logMessages).lp.find((c) => c.pool === ask.pool && c.deposit);
  const [quoteIn, tokenIn] = change ? (ask.quoteIsToken0 ? [change.amount0, change.amount1] : [change.amount1, change.amount0]) : [null, null];
  let fee: ReceiptFee = { kind: 'add', network: feeText(BigInt(meta.fee), 9, 'SOL') };
  if (ask.leg) {
    const legTx = await readTx(rpc, ask.leg.signature);
    const legMeta = legTx?.meta as Meta | null | undefined;
    fee = legMeta && !legMeta.err ? swapFee(legMeta, ask.leg.route, ask.leg.paid) : { kind: 'unread' };
  }
  settleReceipt(signature, {
    title:
      quoteIn !== null && tokenIn !== null
        ? RECEIPT_WORDS.added(amountText(quoteIn, ask.quote.decimals), ask.quote.symbol, amountText(tokenIn, ask.token.decimals), ask.token.symbol)
        : null,
    under: RECEIPT_WORDS.addedTo(ask.quote.symbol, ask.token.symbol),
    fee,
  });
}
