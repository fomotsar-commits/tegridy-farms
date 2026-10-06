import { useCallback, useEffect, useRef, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import { sameToSign } from '../../../lib/launcher/solana/write/sameToSign';
import type { Prepared, PreparedTx, TxOutcome, TxSigner, WriteApi, WriteRpc } from './ports';
import type { ReviewLine } from './reviewLines';

// One transaction, start to finish, for any kind:
//
//   idle → preparing → review → submitting → sent → outcome
//                  ↘ outcome (not-sent: nothing was signed)
//
// Nothing reaches the wallet without a review whose every line is true of it.

/**
 * How long a review may be signed as it is, from the Review press. Its blockhash is read
 * while preparing and lasts 150 blocks: about 40 seconds at mainnet's 0.27 s a block
 * (measured 2026-10-03), so this clock runs out with SIGN_MARGIN_BLOCKS and more to
 * spare. Past it the reviewed transaction is never handed to the wallet.
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
export type ReviewLines = (p: PreparedTx) => ReviewLine[];

/** Lines that read differently: `now` as they read now, `gone` no longer there. */
export type Changed = { now: string[]; gone: string[] };

/** What `now` has that `was` does not, and what `was` has that `now` does not, each counted. */
function diff(was: string[], now: string[]): Changed {
  const left = [...was];
  const added = now.filter((l) => {
    const at = left.indexOf(l);
    if (at >= 0) left.splice(at, 1);
    return at < 0;
  });
  return { now: added, gone: left };
}

/**
 * Is `fresh` the review being read? `stop` is null when it may go to the wallet: every
 * line but the market's reads the same, in order; no market line is new (one may move or
 * go); every instruction is the same. Else what reads differently, or empty lists when the
 * lines could not be read or only the bytes differ. `moved`: the market's lines that did.
 */
function compare(reviewed: PreparedTx, fresh: PreparedTx, lines: ReviewLines | undefined): { stop: Changed | null; moved: Changed } {
  const none: Changed = { now: [], gone: [] };
  const unknown = { stop: none, moved: none };
  if (!lines) return unknown;
  try {
    const was = lines(reviewed);
    const now = lines(fresh);
    if (was.length === 0) return unknown;
    const text = (ls: ReviewLine[]) => ls.map((l) => l.text);
    const own = (ls: ReviewLine[]) => text(ls.filter((l) => l.market === null));
    const market = (ls: ReviewLine[]) => ls.filter((l) => l.market !== null);
    const [a, b] = [own(was), own(now)];
    const same = a.length === b.length && a.every((l, i) => l === b[i]);
    const newMarket = diff(market(was).map((l) => l.market!), market(now).map((l) => l.market!)).now.length > 0;
    if (!same || newMarket) return { stop: diff(text(was), text(now)), moved: none };
    if (!sameToSign(reviewed, fresh)) return unknown;
    return { stop: null, moved: diff(text(market(was)), text(market(now))) };
  } catch {
    return unknown;
  }
}

const movedAny = (m: Changed) => m.now.length + m.gone.length > 0;

export interface ReviewState {
  step: 'review';
  prepared: PreparedTx;
  /** Too old to hand to the wallet: its clock ran out, or the block height said so. */
  expired: boolean;
  expiresAt: number;
  /** The panel said its build only reads, so Sign on a stale review builds it again. */
  renewable: boolean;
  /** Sign was pressed and the block height is being read before the wallet opens. */
  checking?: boolean;
  /** Sign was pressed on a stale review and it is being built again. */
  renewing?: boolean;
  /**
   * This review took the place of the one being read (`n` counts them). `now`: its lines
   * that read differently. `gone`: lines it no longer has. Both empty when the two could
   * not be compared line by line, or only the instructions differ.
   */
  replaced?: { n: number } & Changed;
  /** Built again, its market lines read differently from those read (`compare`). They stop nothing. */
  moved?: Changed;
}

export type TxFlowState =
  | { step: 'idle' }
  | { step: 'preparing' }
  | ReviewState
  /** The wallet's turn. `moved`: the market lines that read differently when it was built again. */
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

  // Expire the review. The timer is tied to the prepared transaction it guards.
  const reviewing = state.step === 'review' ? state.prepared : null;
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
      let moved: { moved?: Changed } = {};
      let stale = s.expired;
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
          cur.step === 'review' && cur.prepared === prepared ? { ...cur, expired: true, checking: false, renewing: true } : cur,
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
        const { stop, moved: market } = compare(prepared, fresh, lines);
        if (stop) {
          // Not the review that was read: it is shown, and signing it takes another press.
          rebuilding.current = false;
          busy.current = false;
          setState({ ...review, expired: false, replaced: { n: (s.replaced?.n ?? 0) + 1, ...stop } });
          return;
        }
        moved = movedAny(market) ? { moved: market } : {};
        // The review that was read, on a newer blockhash: held to both clocks like any other.
        const height = await confirmedHeight(rpc);
        if (abandoned()) return;
        rebuilding.current = false;
        if (Date.now() >= review.expiresAt || nearlyOver(height, fresh)) {
          busy.current = false;
          setState({ ...review, expired: true, ...(s.replaced ? { replaced: s.replaced } : {}), ...moved });
          return;
        }
        prepared = fresh;
      }
      setState({ step: 'submitting', prepared, ...moved });
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
