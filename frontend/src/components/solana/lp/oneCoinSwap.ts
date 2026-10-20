import { VersionedTransaction, type Connection } from '@solana/web3.js';
import { fromBaseUnits, NoRouteError, quoteHasPlatformFee, type JupiterQuote, type PriorityLevel } from '../../../lib/jupiter';
import { blockhashSeen, recentBlockhashOf, type NoteBlockhash } from '../../../lib/solana/blockhashWindow';
import { pollConfirm } from '../../../lib/solana/confirm';
import { NOT_TEST_RUN_COPY, prepareJupiterSwap, refusalWhy, refusedSaid, type FeeRetryDeps } from '../../../lib/solana/swap/jupiterFeeRetry';
import { jupiterLastValidAtMost } from '../../../lib/solana/swap/jupiterNote';
import { OWN_ROUTE_COPY } from '../../../lib/solana/swap/ownPoolRoute';
import { CHECK_KEEPS_FAILING, HELD_NOT_SENT, lostAnswerCopy, nothingSentCopy } from '../../../lib/solana/swap/walletCopy';
import { readSendThrow } from '../../../lib/solana/walletThrow';
import { DEFAULT_SLIPPAGE_BPS, fractionToBps } from '../curve/uiFormat';

/**
 * Step 1 of "Add with one coin" when Jupiter pays more: the swap page's Buy press, rule
 * for rule (pages/SolanaSwapPage.tsx handleSwap). A fresh quote held to the one reviewed;
 * our own pool takes the trade if it now pays at least as much; build and test run with
 * the one no-fee retry (jupiterFeeRetry.ts), sent only when its site fee, or none, is what
 * the review said; a note this wallet holds stops it right
 * before the wallet; the note is written on the signature, or with none for a lost answer.
 */

/** The swap page's wait for a Jupiter swap (SPEC_S3). */
export const SWAP_CONFIRM_TIMEOUT_MS = 90_000;

export interface JupiterLegDeps extends FeeRetryDeps {
  /** Does our own pool, read again now, pay at least `out` for this swap? False when it cannot be asked. */
  ownPoolWins(out: bigint): Promise<boolean>;
  /** Read again now: does a swap this wallet sent, in any tab, still hold it? */
  holdsNow(): boolean;
  /** Write this swap's note: by its signature, or null for a wallet answer that was lost. */
  hold(note: { signature: string | null; lastValidBlockHeight: number | null; blockhash: NoteBlockhash | null; sentAt: number }): void;
  /** Is this note still there? A late read only completes a note that is, never brings back a released one. */
  stillHeld(note: { signature: string | null; sentAt: number }): boolean;
  release(signature: string): void;
  /** The wallet signs and sends. */
  send(tx: VersionedTransaction): Promise<string>;
  rpc: Pick<Connection, 'getBlockHeight' | 'getSignatureStatuses'> & Partial<Pick<Connection, 'isBlockhashValid'>>;
  confirm?(signature: string): Promise<'confirmed' | 'reverted' | 'unknown'>;
}

export type JupiterLegEnd =
  /** Nothing reached the wallet, or it said no. `replan`: the figures changed, review again. */
  | { kind: 'not-sent'; title: string; message: string; replan?: true; unchecked?: true; refused?: { why: string | null } }
  | { kind: 'sent'; signature: string; outcome: 'confirmed' | 'reverted' | 'unknown'; quote: JupiterQuote; feeWaived: boolean }
  /** The wallet stopped without a signature after it may have sent: held by a note with none. */
  | { kind: 'lost'; message: string };

export interface JupiterLegArgs {
  /** The quote the review showed. */
  shown: JupiterQuote;
  inputMint: string;
  outputMint: string;
  /** Base units of the input: the swap share the review showed. */
  amount: string;
  slippageBps: number;
  user: string;
  priority: PriorityLevel;
  /** Presses in a row before this one whose test run could not run. */
  uncheckedBefore: number;
  /** "≈12 BAYLA with 0.1 SOL": completes "whether it sent ___". */
  words: string;
  /** Learned on the way: this pair's transaction goes out with no site fee (or with it again). */
  onNoFee?(noFee: boolean): void;
}

const thrownWords = (err: unknown): string => {
  const s = (err instanceof Error ? err.message : String(err ?? '')).replace(/\s+/g, ' ').trim();
  if (!s) return 'no reason was given';
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

const FEE_BACK_COPY = 'The site fee can be taken on this route now, so you receive slightly less. Nothing was sent. Review the new figures and press again.';
const FEE_GONE_COPY = 'The site fee cannot be taken on this route, so the figures changed. Nothing was sent. Review the new figures and press again.';
const movedCopy = (bps: number) => `The quote dropped beyond your ${(bps / 100).toFixed(2)}% slippage. Nothing was sent. Review the new figures and press again.`;

export async function sendJupiterLeg(d: JupiterLegDeps, a: JupiterLegArgs): Promise<JupiterLegEnd> {
  const routeChanged: JupiterLegEnd = { kind: 'not-sent', title: 'Route changed', message: OWN_ROUTE_COPY.ownNowWins, replan: true };
  let fresh: JupiterQuote;
  try {
    fresh = await d.getQuote({ inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps });
  } catch (e) {
    if (e instanceof NoRouteError) return { kind: 'not-sent', title: 'No route', message: 'Jupiter has no route for this swap just now. Nothing was sent.', replan: true };
    return { kind: 'not-sent', title: 'Not sent', message: nothingSentCopy('Jupiter’s price', thrownWords(e)) };
  }
  const carriesFee = d.swapCarriesPlatformFee(a.inputMint, a.outputMint);
  // The review showed a no-fee quote: a fee-bearing `fresh` sits under it by the fee alone,
  // so the like-for-like check is prepareJupiterSwap's (the swap page's rule).
  const shownWaived = carriesFee && !quoteHasPlatformFee(a.shown);
  // The reviewed figure is what was agreed to: a fresh one below its slippage floor is shown, never sent.
  if (!shownWaived) {
    try {
      const shownOut = BigInt(a.shown.outAmount);
      if (BigInt(fresh.outAmount) < shownOut - (shownOut * BigInt(a.slippageBps)) / 10_000n) return { kind: 'not-sent', title: 'Price moved', message: movedCopy(a.slippageBps), replan: true };
    } catch {
      /* unparseable: the test run below still guards */
    }
  }
  if (!carriesFee && (await d.ownPoolWins(BigInt(fresh.outAmount)))) return routeChanged;

  let prepared: Awaited<ReturnType<typeof prepareJupiterSwap>>;
  try {
    prepared = await prepareJupiterSwap(d, {
      fresh,
      shown: a.shown,
      inputMint: a.inputMint,
      outputMint: a.outputMint,
      amount: a.amount,
      slippageBps: a.slippageBps,
      user: a.user,
      priority: a.priority,
    });
  } catch (e) {
    return { kind: 'not-sent', title: 'Not sent', message: nothingSentCopy('Jupiter’s transaction for this swap', thrownWords(e)) };
  }
  if (prepared.status === 'blocked') {
    // A test run that could not run is no verdict (law 8); the second in a row is ours to say (D2).
    if (prepared.unchecked) {
      return a.uncheckedBefore + 1 < 2
        ? { kind: 'not-sent', title: 'Swap not checked', message: NOT_TEST_RUN_COPY, unchecked: true }
        : { kind: 'not-sent', title: 'Swap not checked', message: CHECK_KEEPS_FAILING, unchecked: true };
    }
    return { kind: 'not-sent', title: 'Swap would fail', message: refusedSaid(prepared, a.slippageBps), refused: { why: refusalWhy(prepared, a.slippageBps) } };
  }
  a.onNoFee?.(prepared.status === 'moved' || prepared.siteFeeWaived);
  if (prepared.status === 'moved') return { kind: 'not-sent', title: 'Price moved', message: movedCopy(a.slippageBps), replan: true };
  const sent = prepared.quote;
  if (carriesFee && (await d.ownPoolWins(BigInt(sent.outAmount)))) return routeChanged;
  // The review says what goes out, the site fee included. Reviewed with no site fee and the
  // fee can be taken now: that pays less than the review said. Reviewed with the fee and
  // this route's transaction goes out with none (the 6014 retry): the review said a fee that
  // is not taken. Either way it is reviewed again on the figures that would be sent.
  if (shownWaived !== prepared.siteFeeWaived) return { kind: 'not-sent', title: 'Quote changed', message: shownWaived ? FEE_BACK_COPY : FEE_GONE_COPY, replan: true };
  // A swap this wallet sent in another tab meanwhile holds this one. Nothing is awaited from here to the wallet.
  if (d.holdsNow()) return { kind: 'not-sent', title: 'Not sent', message: HELD_NOT_SENT };

  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.swapTransaction), (c) => c.charCodeAt(0)));
  // Read after Jupiter built it, so its blockhash is older than this height (jupiterNote.ts).
  const lastValid: { at: number | null } = { at: null };
  const heightRead = jupiterLastValidAtMost(() => d.rpc.getBlockHeight('confirmed')).then((h) => (lastValid.at = h));
  const proof: { bh: NoteBlockhash | null } = { bh: null };
  const bhRead = blockhashSeen(d.rpc, recentBlockhashOf(tx)).then((b) => (proof.bh = b));
  const sentAt = Date.now();
  const note = (signature: string | null) => {
    const write = () => d.hold({ signature, lastValidBlockHeight: signature ? lastValid.at : null, blockhash: proof.bh, sentAt });
    write();
    const had = { at: lastValid.at, bh: proof.bh };
    // A read that lands after the note: the note learns when the swap can no longer land.
    void Promise.all([heightRead, bhRead]).then(() => {
      const learned = (signature !== null && had.at === null && lastValid.at !== null) || (had.bh === null && proof.bh !== null);
      if (learned && d.stillHeld({ signature, sentAt })) write();
    });
  };
  let signature: string;
  try {
    signature = await d.send(tx);
  } catch (e) {
    const t = readSendThrow(e);
    if (t.kind !== 'unsure') return { kind: 'not-sent', title: 'Not sent', message: t.message };
    // It may be out with no signature to look up: held until its blockhash can no longer land (D1).
    note(null);
    return { kind: 'lost', message: lostAnswerCopy(t.reason, `it sent ${a.words}`) };
  }
  note(signature);
  const outcome = d.confirm ? await d.confirm(signature) : (await pollConfirm(d.rpc, signature, SWAP_CONFIRM_TIMEOUT_MS)).outcome;
  // Landed or refused: the chain answered. Unread: the note stays and holds.
  if (outcome !== 'unknown') d.release(signature);
  return { kind: 'sent', signature, outcome, quote: sent, feeWaived: prepared.siteFeeWaived };
}

/**
 * Step 1 sent and its note ended (the chain answered, or the hold was turned off or ran
 * out): did it land? From its status alone. 'unread' is no answer: never "did not land".
 */
export async function stepOneLanded(rpc: Pick<Connection, 'getSignatureStatuses'>, signature: string): Promise<'landed' | 'failed' | 'unread'> {
  try {
    const st = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }))?.value?.[0] ?? null;
    if (!st || (st.confirmationStatus !== 'confirmed' && st.confirmationStatus !== 'finalized')) return 'unread';
    return st.err ? 'failed' : 'landed';
  } catch {
    return 'unread';
  }
}

/**
 * What a confirmed transaction paid `owner` of `mint` (base units), from its own balance
 * records, or null when that cannot be read. SOL: the signer's lamports, its fee added back.
 */
export async function receivedBy(
  rpc: Partial<Pick<Connection, 'getTransaction'>>,
  signature: string,
  owner: string,
  mint: string,
  native: boolean,
): Promise<bigint | null> {
  if (!rpc.getTransaction) return null;
  try {
    const tx = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const m = tx?.meta;
    if (!m || m.err) return null;
    let got: bigint;
    if (native) {
      const first = tx.transaction.message.staticAccountKeys[0]?.toBase58();
      const pre = m.preBalances[0];
      const post = m.postBalances[0];
      if (first !== owner || pre === undefined || post === undefined) return null;
      got = BigInt(post) - BigInt(pre) + BigInt(m.fee);
    } else {
      const sum = (list: typeof m.postTokenBalances) =>
        (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
      got = sum(m.postTokenBalances) - sum(m.preTokenBalances);
    }
    return got > 0n ? got : null;
  } catch {
    return null;
  }
}

/**
 * How far a Jupiter quote moves the price, said as the swap page says it ("1.23%", "<0.01%"),
 * and in basis points for its warning. Null when the quote's field is missing or not a
 * number: never "0%".
 */
export function priceChangeOf(q: JupiterQuote): { text: string; bps: bigint | null } | null {
  const raw: unknown = q.priceImpactPct;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const pct = Math.abs(Number(raw) * 100);
  if (!Number.isFinite(pct)) return null;
  return { text: `${pct < 0.01 ? '<0.01' : pct.toFixed(2)}%`, bps: fractionToBps(pct / 100) };
}

/** "≈12.5 BAYLA with 0.1 SOL", the swap page's words for a trade. */
export const tradeWords = (out: string, outDecimals: number, outSymbol: string, inText: string) =>
  `≈${fromBaseUnits(out, outDecimals)} ${outSymbol} with ${inText}`;

/**
 * Step 1 landed and step 2 is owed: kept per wallet (localStorage, every tab) so a reload
 * or a trip away offers step 2 again and never step 1. A convenience only: storage can
 * be empty or throw, and the swap's own note is what stops a second send.
 */
export interface StepTwoNote {
  pool: string;
  paid: 'quote' | 'token';
  kept: bigint;
  got: bigint;
  /** False: `got` is the least the swap could pay, as what it paid could not be read. */
  gotExact: boolean;
  /** The slippage picked for step 1, which step 2 opens with. */
  bps: bigint;
  signature: string;
  at: number;
}
export const STEP_TWO_TTL_MS = 60 * 60_000;
const stepTwoKey = (wallet: string) => `lp:one-coin:${wallet}`;
const UNITS = /^\d{1,30}$/;

export function readStepTwo(wallet: string, pool: string, now: number = Date.now()): StepTwoNote | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(stepTwoKey(wallet)) ?? 'null');
    if (!Array.isArray(raw)) return null;
    for (const x of raw as Record<string, unknown>[]) {
      if (!x || x.pool !== pool || (x.paid !== 'quote' && x.paid !== 'token')) continue;
      if (typeof x.kept !== 'string' || !UNITS.test(x.kept) || typeof x.got !== 'string' || !UNITS.test(x.got)) continue;
      if (typeof x.at !== 'number' || now - x.at > STEP_TWO_TTL_MS || typeof x.signature !== 'string') continue;
      const bps = typeof x.bps === 'string' && /^\d{1,4}$/.test(x.bps) && BigInt(x.bps) <= 10_000n ? BigInt(x.bps) : DEFAULT_SLIPPAGE_BPS;
      return { pool, paid: x.paid, kept: BigInt(x.kept), got: BigInt(x.got), gotExact: x.gotExact === true, bps, signature: x.signature, at: x.at };
    }
  } catch {
    /* storage unreadable: nothing remembered */
  }
  return null;
}

function writeStepTwo(wallet: string, pool: string, n: StepTwoNote | null): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(stepTwoKey(wallet)) ?? '[]');
    const rest = (Array.isArray(raw) ? (raw as { pool?: unknown }[]) : []).filter((x) => x && x.pool !== pool).slice(0, 15);
    const all = n ? [{ ...n, kept: n.kept.toString(), got: n.got.toString(), bps: n.bps.toString() }, ...rest] : rest;
    if (all.length) localStorage.setItem(stepTwoKey(wallet), JSON.stringify(all));
    else localStorage.removeItem(stepTwoKey(wallet));
  } catch {
    /* storage unavailable: this tab still shows step 2 */
  }
}
export const saveStepTwo = (wallet: string, n: StepTwoNote) => writeStepTwo(wallet, n.pool, n);
export const clearStepTwo = (wallet: string, pool: string) => writeStepTwo(wallet, pool, null);
