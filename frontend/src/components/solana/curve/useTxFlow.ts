import { useCallback, useEffect, useRef, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import { sameToSign } from '../../../lib/launcher/solana/write/sameToSign';
import { holdReload } from '../../../lib/reloadHold';
import type { Prepared, PreparedTx, TxOutcome, TxSigner, WriteApi, WriteRpc } from './ports';
import type { ReviewText } from './reviewLines';

// One transaction, start to finish, for any kind:
//
//   idle → preparing → review → submitting → sent → outcome
//                  ↘ outcome (not-sent: nothing was signed)
//
// Nothing reaches the wallet without a review whose every line is true of it.

/**
 * How long a prepared transaction may be signed as it is, from the Review press. Its
 * blockhash is read while preparing and lasts 150 blocks: about 40 seconds at mainnet's
 * 0.27 s a block (measured 2026-10-03), so this clock runs out with SIGN_MARGIN_BLOCKS and
 * more to spare. Past it the prepared transaction is never handed to the wallet. A
 * repeatable review is never shut by it while it is read: Sign builds it again (island,
 * answer eighteen: reading time is never a failure).
 */
export const REVIEW_TTL_MS = 30_000;
/** Blocks the wallet prompt and the first send must still have: about 7 seconds. */
export const SIGN_MARGIN_BLOCKS = 25;
const HEIGHT_READ_TIMEOUT_MS = 3_000;

/** The confirmed block height, or null when it cannot be read quickly. */
async function confirmedHeight(rpc: WriteRpc): Promise<number | null> {
  if (typeof rpc.getBlockHeight !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const h = await Promise.race([
      rpc.getBlockHeight('confirmed'),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), HEIGHT_READ_TIMEOUT_MS);
      }),
    ]);
    return typeof h === 'number' && Number.isFinite(h) ? h : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fewer than SIGN_MARGIN_BLOCKS left at a height that was read. An unread height is not "over". */
const nearlyOver = (height: number | null, p: PreparedTx) => height !== null && height + SIGN_MARGIN_BLOCKS >= p.lastValidBlockHeight;

/** A review's lines as its reader sees them: `reviewLines` in TxFlowView. */
export type ReviewLines = (p: PreparedTx) => ReviewText;

type Changed = { now: string[]; gone: string[] };

/** `now`'s lines that `was` does not have, and `was`'s that `now` does not: each line counted once. */
function diff(was: string[], now: string[]): Changed {
  const left = [...was];
  const added = now.filter((l) => {
    const at = left.indexOf(l);
    if (at >= 0) left.splice(at, 1);
    return at < 0;
  });
  return { now: added, gone: left };
}

/** A line's words with every number taken out: a warning whose numbers moved still says the same thing. */
const wordsOf = (line: string) => line.replace(/\d[\d,.]*/g, '#');

/**
 * Further off than this since it was read, and the price check is news, not a market
 * move: poolHealth.ts `PRICE_TOLERANCE`, the gap at which the page starts to warn (a test
 * pins the two together; that module is not imported here, it reads the chain).
 */
export const PRICE_RUN = 0.03;

/** How far the pool's price is from what it was checked against, when it was compared with anything. */
function gapOf(p: PreparedTx): number | null {
  const s = p.summary;
  if (s.kind === 'range-open' || s.kind === 'range-create') return s.price.state === 'agrees' || s.price.state === 'disagrees' ? Math.abs(s.price.diff) : null;
  if (s.kind !== 'lp-deposit' && s.kind !== 'lp-create') return null;
  return s.price.state === 'agrees' || s.price.state === 'disagrees' ? Math.abs(s.price.diff) : null;
}

/**
 * Only the network's fees moved the fee lines: the base fee is the same, the priority fee
 * is inside this page's own cap, and the SOL the test run moved, fees aside, is the same
 * to the lamport. A cap that cannot be read is never "inside it".
 */
function onlyFeesMoved(reviewed: PreparedTx, fresh: PreparedTx): boolean {
  const fees = (p: PreparedTx) => p.fees.baseLamports + p.fees.priorityLamports;
  const cap = fresh.check?.intent?.maxPriorityLamports;
  return (
    typeof cap === 'bigint' &&
    fresh.fees.priorityLamports <= cap &&
    fresh.fees.baseLamports === reviewed.fees.baseLamports &&
    fresh.simulated.signerLamportsDelta + fees(fresh) === reviewed.simulated.signerLamportsDelta + fees(reviewed)
  );
}

/**
 * May `fresh` go to the wallet in place of the review being read? `changed: null` = yes:
 * the transaction's own lines read the same, in order, every instruction is the same byte
 * for byte, and the rest moved only as a market or the network's fees move (`moved`, shown
 * while the wallet is open). Otherwise `changed` lists what reads differently, with empty
 * lists when the lines could not be read or only the bytes differ: unreadable is never
 * "same". What shuts the wallet besides the transaction's own lines: a warning whose words
 * are new, a price check that ran more than PRICE_RUN further off, and fee lines that moved
 * for any reason but the fees.
 */
function compare(reviewed: PreparedTx, fresh: PreparedTx, lines: ReviewLines | undefined): { changed: Changed | null; moved: Changed } {
  const none: Changed = { now: [], gone: [] };
  const unknown = { changed: none, moved: none };
  if (!lines) return unknown;
  try {
    const was = lines(reviewed);
    const now = lines(fresh);
    // Two empty readings agree with each other and say nothing about the review.
    if (was.lines.length === 0) return unknown;
    const own = diff(was.lines, now.lines);
    const market = diff(was.market, now.market);
    const warned = diff(was.warnings, now.warnings);
    const fees = diff(was.fees, now.fees);
    const seen = new Set(was.warnings.map(wordsOf));
    const news = warned.now.filter((l) => !seen.has(wordsOf(l)));
    const gapWas = gapOf(reviewed);
    const gapNow = gapOf(fresh);
    const ran = gapWas !== null && gapNow !== null && gapNow - gapWas > PRICE_RUN;
    const feesHold = (fees.now.length === 0 && fees.gone.length === 0) || onlyFeesMoved(reviewed, fresh);
    // Every line that reads differently: all of them are listed when the wallet stays shut,
    // so "every other line reads as it did" beside the button stays true.
    const all: Changed = {
      now: [...own.now, ...market.now, ...warned.now, ...fees.now],
      gone: [...own.gone, ...market.gone, ...warned.gone, ...fees.gone],
    };
    const shut = own.now.length > 0 || own.gone.length > 0 || news.length > 0 || ran || !feesHold;
    if (shut) return { changed: all, moved: none };
    const inOrder = was.lines.length === now.lines.length && was.lines.every((l, i) => l === now.lines[i]);
    if (!inOrder || !sameToSign(reviewed, fresh)) return unknown;
    return { changed: null, moved: all };
  } catch {
    return unknown;
  }
}

export interface ReviewState {
  step: 'review';
  prepared: PreparedTx;
  /**
   * Too old to hand to the wallet as it is. A review that is not renewable goes so when its
   * clock runs out, and only Start over is left. A renewable one never goes so while it is
   * read: only when a Sign press built it again and the network moved on before the wallet
   * could open, so the next press builds it once more.
   */
  expired: boolean;
  expiresAt: number;
  /** The panel said its build only reads, so Sign on a stale review builds it again. */
  renewable: boolean;
  /** Sign was pressed and the block height is being read before the wallet opens. */
  checking?: boolean;
  /** Sign was pressed on a review past its clock and it is being built again. */
  renewing?: boolean;
  /**
   * This review took the place of the one being read (`n` counts them). `now`: its lines
   * that read differently. `gone`: lines it no longer has. Both empty when the two could
   * not be compared line by line, or only the instructions differ.
   */
  replaced?: { n: number } & Changed;
}

export type TxFlowState =
  | { step: 'idle' }
  | { step: 'preparing' }
  | ReviewState
  /**
   * The wallet's turn. `moved`: built again at the press, the lines a market or the
   * network's fees moved since the review was read (nothing else had changed).
   */
  | { step: 'submitting'; prepared: PreparedTx; moved?: Changed }
  /** The signature is known: from here it may land even if this tab goes away. */
  | { step: 'sent'; prepared: PreparedTx; signature: string }
  /** `checks`: how many times "Check again" has answered, so each answer reads as new. */
  | { step: 'outcome'; outcome: TxOutcome; prepared: PreparedTx | null; rechecking: boolean; checks?: number };

/**
 * A settled transaction, for the page. `sentSignature` is the signature it had once
 * it reached `sent`, or null: a `not-sent` outcome after `sent` (the network turned it
 * away at the first send) still names the note to clear.
 */
export type OnSettled = (outcome: TxOutcome, prepared: PreparedTx | null, sentSignature?: string | null) => void;
/**
 * The signature is known and the first byte has not left yet. The page writes its
 * "may still land" note here, so the note survives a reload.
 */
export type OnSent = (signature: string, prepared: PreparedTx) => void;

export interface TxFlow {
  state: TxFlowState;
  /** True while a sent-but-unconfirmed transaction stands. Panels lock their action on it. */
  locked: boolean;
  /**
   * `repeatable`: the build only reads the chain, so it may run again for a stale review.
   * Leave it off when the build asks the wallet or uploads anything (the launch).
   */
  prepare(build: () => Promise<Prepared>, opts?: { repeatable?: boolean }): Promise<void>;
  /** Without `lines`, a review that was built again is always shown again, never signed unread. */
  confirm(signer: TxSigner, lines?: ReviewLines): Promise<void>;
  recheck(): Promise<void>;
  reset(): void;
}

export function useTxFlow(
  api: Pick<WriteApi, 'submitPrepared' | 'recheckOutcome'>,
  rpc: WriteRpc,
  onSettled?: OnSettled,
  onSent?: OnSent,
): TxFlow {
  const [state, setState] = useState<TxFlowState>({ step: 'idle' });
  // One submission per review: a second click, a double tap or a re-render finds this set.
  const busy = useRef(false);
  // The build behind the review on screen, kept only when the panel called it repeatable.
  const again = useRef<(() => Promise<Prepared>) | null>(null);
  // A stale review being built again: nothing is signed until that ends, so Start over
  // may abandon it, and so does leaving the page (no wallet prompt for a review nobody
  // is reading). `press` counts Sign presses; an abandoned press finds it moved on.
  const rebuilding = useRef(false);
  const press = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const settledRef = useRef(onSettled);
  const sentRef = useRef(onSent);
  useEffect(() => {
    settledRef.current = onSettled;
    sentRef.current = onSent;
  }, [onSettled, onSent]);

  // Sent and not answered yet: a reload or a closed tab would drop the page's watch on
  // it. The note survives that, but the browser asks first.
  const inFlight = state.step === 'sent';
  useEffect(() => {
    if (!inFlight) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [inFlight]);

  // Expire a review whose build may not run twice. The timer is tied to the prepared
  // transaction it guards. A renewable review has no timer: its clock is read at the press.
  const reviewing = state.step === 'review' && !state.renewable ? state.prepared : null;
  const expiresAt = state.step === 'review' ? state.expiresAt : 0;
  useEffect(() => {
    if (!reviewing) return;
    const t = setTimeout(
      () => {
        setState((s) => (s.step === 'review' && s.prepared === reviewing ? { ...s, expired: true } : s));
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(t);
  }, [reviewing, expiresAt]);

  const prepare = useCallback(async (build: () => Promise<Prepared>, opts?: { repeatable?: boolean }) => {
    if (busy.current) return;
    busy.current = true;
    const renewable = opts?.repeatable === true;
    again.current = renewable ? build : null;
    // The blockhash is fetched inside build(), so its window starts no earlier than now.
    const startedAt = Date.now();
    setState({ step: 'preparing' });
    try {
      const r = await build();
      if (r.ok) setState({ step: 'review', prepared: r.prepared, expired: false, expiresAt: startedAt + REVIEW_TTL_MS, renewable });
      else {
        setState({ step: 'outcome', outcome: r.outcome, prepared: null, rechecking: false });
        // A refusal is often "the price moved": the page reads the chain again so the
        // next attempt, and the numbers shown before it, start from the chain now.
        settledRef.current?.(r.outcome, null);
      }
    } catch (e) {
      // Nothing was signed yet, so this is safely "not sent".
      const outcome: TxOutcome = { status: 'not-sent', stage: 'build', message: clipDetail(e) };
      setState({ step: 'outcome', outcome, prepared: null, rechecking: false });
      settledRef.current?.(outcome, null);
    } finally {
      busy.current = false;
    }
  }, []);

  const confirm = useCallback(
    async (signer: TxSigner, lines?: ReviewLines) => {
      if (busy.current) return;
      const s = state;
      if (s.step !== 'review') return;
      const build = s.renewable ? again.current : null;
      if (s.expired && !build) return;
      busy.current = true;
      const mine = ++press.current;
      const abandoned = () => press.current !== mine || !alive.current;
      let prepared = s.prepared;
      let moved: Changed | null = null;
      let stale = s.expired || Date.now() >= s.expiresAt;
      if (!stale) {
        // A signature the network can no longer accept is wasted: read the height first.
        // Unreadable is not "fine", but it is not "stale" either; the first send runs
        // with preflight, which refuses an expired blockhash before anything is sent.
        setState((cur) => (cur.step === 'review' && cur.prepared === prepared ? { ...cur, checking: true } : cur));
        stale = nearlyOver(await confirmedHeight(rpc), prepared);
      }
      if (stale && !build) {
        busy.current = false;
        setState((cur) =>
          cur.step === 'review' && cur.prepared === prepared ? { ...cur, expired: true, checking: false } : cur,
        );
        return;
      }
      if (stale && build) {
        // Too old to sign as it is, and never signed: the build runs again on fresh
        // reads, with every check a first prepare makes.
        rebuilding.current = true;
        setState((cur) =>
          cur.step === 'review' && cur.prepared === prepared ? { ...cur, checking: false, renewing: true } : cur,
        );
        const startedAt = Date.now();
        let r: Prepared;
        try {
          r = await build();
        } catch (e) {
          r = { ok: false, outcome: { status: 'not-sent', stage: 'build', message: clipDetail(e) } };
        }
        if (abandoned()) return;
        if (!r.ok) {
          rebuilding.current = false;
          busy.current = false;
          setState({ step: 'outcome', outcome: r.outcome, prepared: null, rechecking: false });
          settledRef.current?.(r.outcome, null);
          return;
        }
        const fresh = r.prepared;
        const review = { step: 'review' as const, prepared: fresh, expiresAt: startedAt + REVIEW_TTL_MS, renewable: true };
        const compared = compare(prepared, fresh, lines);
        if (compared.changed) {
          // Not the review that was read: it is shown, and signing it takes another press.
          rebuilding.current = false;
          busy.current = false;
          setState({ ...review, expired: false, replaced: { n: (s.replaced?.n ?? 0) + 1, ...compared.changed } });
          return;
        }
        // The review that was read, on a newer blockhash: held to both clocks like any other.
        const height = await confirmedHeight(rpc);
        if (abandoned()) return;
        rebuilding.current = false;
        if (Date.now() >= review.expiresAt || nearlyOver(height, fresh)) {
          busy.current = false;
          setState({ ...review, expired: true, ...(s.replaced ? { replaced: s.replaced } : {}) });
          return;
        }
        prepared = fresh;
        if (compared.moved.now.length > 0 || compared.moved.gone.length > 0) moved = compared.moved;
      }
      setState(moved ? { step: 'submitting', prepared, moved } : { step: 'submitting', prepared });
      // From the wallet's turn to the answer the page does not reload itself
      // (lib/staleBuild.ts), whether or not this panel is still on screen.
      const release = holdReload();
      let sentSignature: string | null = null;
      let outcome: TxOutcome;
      try {
        outcome = await api.submitPrepared(rpc, signer, prepared, {
          onSent: (signature) => {
            sentSignature = signature;
            try {
              sentRef.current?.(signature, prepared);
            } catch {
              /* a note that could not be written does not stop the send */
            }
            setState((cur) =>
              cur.step === 'submitting' && cur.prepared === prepared ? { step: 'sent', prepared, signature } : cur,
            );
          },
        });
      } catch (e) {
        // We cannot say whether anything was sent, so this is `unknown`, never "failed".
        // It carries the signature when the transaction had already reached `sent`.
        outcome = {
          status: 'unknown',
          signature: sentSignature ?? '',
          message: `We lost track of this transaction (${clipDetail(e)}). Check your wallet's activity before trying again.`,
        };
      } finally {
        release();
      }
      busy.current = false;
      setState({ step: 'outcome', outcome, prepared, rechecking: false, checks: 0 });
      settledRef.current?.(outcome, prepared, sentSignature);
    },
    [api, rpc, state],
  );

  const recheck = useCallback(async () => {
    const s = state;
    if (s.step !== 'outcome' || busy.current) return;
    const sig = 'signature' in s.outcome ? s.outcome.signature : '';
    if (!sig) return;
    busy.current = true;
    setState({ ...s, rechecking: true });
    let outcome: TxOutcome;
    try {
      // With the blockhash window, "no record and the window has passed" becomes
      // `expired` (safe to retry) instead of staying unknown. A liquidity transaction
      // also passes its config and kind, so a refusal found now is said in its own
      // words; every other kind is asked exactly as it always was.
      const p = s.prepared;
      outcome = await api.recheckOutcome(
        rpc,
        sig,
        p
          ? isLpKind(p.kind)
            ? { lastValidBlockHeight: p.lastValidBlockHeight, cfg: p.check.intent.cfg, kind: p.kind }
            : { lastValidBlockHeight: p.lastValidBlockHeight }
          : undefined,
      );
    } catch (e) {
      // A failed re-read changes nothing we know. Keep the prior answer.
      outcome = { status: 'unknown', signature: sig, message: `Could not check just now (${clipDetail(e)}).` };
    }
    busy.current = false;
    setState({ step: 'outcome', outcome, prepared: s.prepared, rechecking: false, checks: (s.checks ?? 0) + 1 });
    settledRef.current?.(outcome, s.prepared, sig);
  }, [api, rpc, state]);

  const reset = useCallback(() => {
    if (busy.current) {
      if (!rebuilding.current) return;
      press.current += 1;
      rebuilding.current = false;
      busy.current = false;
    }
    again.current = null;
    setState({ step: 'idle' });
  }, []);

  // Sent and not confirmed is not an error. While it stands the panel's action stays
  // locked, so the easy mistake (paying twice) takes a deliberate step.
  const locked = state.step === 'outcome' && state.outcome.status === 'unknown' && state.outcome.signature !== '';
  return { state, locked, prepare, confirm, recheck, reset };
}

/**
 * Where focus goes when a flow ends (Cancel, Close, Start over). The flow's own
 * buttons are gone, so without this focus falls to the page body. `target` is the
 * panel's Review button; `fallback` (the card heading) is used when that button is
 * missing or switched off.
 */
export function useReturnFocus(step: TxFlowState['step']) {
  const target = useRef<HTMLButtonElement | null>(null);
  const fallback = useRef<HTMLHeadingElement | null>(null);
  const prev = useRef(step);
  useEffect(() => {
    const was = prev.current;
    prev.current = step;
    if (was === 'idle' || step !== 'idle') return;
    const t = target.current;
    if (t && t.isConnected && !t.disabled) t.focus();
    else fallback.current?.focus();
  }, [step]);
  return { target, fallback };
}
