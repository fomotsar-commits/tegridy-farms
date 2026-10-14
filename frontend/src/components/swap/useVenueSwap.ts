import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { browserCurveRpc, browserRpc } from '../../lib/launcher/solana/curve/rpc';
import { ownPoolSwapsOn } from '../../lib/solana/swap/ownPoolSwapFlag';
import { HELD_NOT_SENT } from '../../lib/solana/swap/walletCopy';
import { withReadCommitment } from '../solana/curve/confirmedRpc';
import { browserGateRpc } from '../solana/curve/gateRpc';
import { readPendingTrades, swapPendingScope } from '../solana/curve/pendingTrade';
import type { CurveWriteConfig, GateBlock, GateRpc, PreparedTx, SwapGate, SwapOpenGate, TxOutcome, VenueSwapApi, WriteRpc } from '../solana/curve/ports';
import { useCurveSigner, type CurveSignerState } from '../solana/curve/useCurveSigner';
import { usePendingTrades, type CheckLost, type CheckSignature, type PendingTradesState } from '../solana/curve/usePendingTrades';
import { blockhashGone } from '../../lib/solana/blockhashWindow';
import { useTxFlow, type OnSettled, type TxFlow } from '../solana/curve/useTxFlow';
import { useLoadedGate } from '../solana/curve/useWriteGate';
import { loadVenueSwapApi } from './venueSwapApi';

/**
 * What the swap page needs to send a trade to one of our own pools: the swap code
 * (loaded only once a pool of ours has quoted), its gate, the wallet as a signer, the one
 * review flow, and the notes of sent swaps (either route) that survive a reload. The same
 * review, test run and Sign in wallet as every other signed action here.
 */

const unreadable = (detail: string): SwapGate => ({ kind: 'blocked', reason: 'unreadable', detail });
const swapConfig = (api: VenueSwapApi) => api.swapWriteConfig();

/** Why a closed gate closes it, short enough to sit inside the route line's sentence. */
const BLOCKED: Partial<Record<GateBlock, string>> = {
  'wrong-cluster': 'this page is not on the network the pools are on',
  'cpswap-program-missing': 'the pool program is not there',
};
const NOT_CHECKED = 'the pool program could not be checked';
/** A gate that could not be read, or swap code that did not load, is asked for again this often. */
export const GATE_RETRY_MS = 15_000;
/** A note of a sent swap is looked up again this often while it holds Buy. */
export const NOTE_RECHECK_MS = 20_000;
/** A sent swap's note belongs to the wallet that signed it: the fee payer it was built for. */
export const signerScope = (p: PreparedTx): string | null => (p.tx.feePayer ? swapPendingScope(p.tx.feePayer.toBase58()) : null);

export interface VenueSwap {
  /** The swap code and the gate are still on their way. */
  loading: boolean;
  /**
   * Why a swap in our own pool cannot be prepared here right now, as a clause; null
   * when it can, or when that is not known yet (`loading`).
   */
  unavailable: string | null;
  /** Set once the swap code loaded and the gate is open on the program the page reads pools from. */
  ready: { api: VenueSwapApi; gate: SwapOpenGate } | null;
  api: VenueSwapApi | null;
  cfg: CurveWriteConfig | null;
  rpc: WriteRpc;
  signerState: CurveSignerState;
  flow: TxFlow;
  /** Swaps the connected wallet sent from this browser, by either route, that the chain has not answered for yet. */
  pending: PendingTradesState;
}

export function useVenueSwap(o: {
  /** One of our pools quoted the pair on screen: from then on the swap code is wanted. */
  wanted: boolean;
  /** The pool program the page reads pools from; a gate open on another one is not open. */
  programId: string | null;
  onSettled?: OnSettled;
  /** A note the chain answered for: read the page's numbers again. */
  onResolved?: () => void;
  /** Tests pass these; the build's own switch, the real code and /api/solrpc otherwise. */
  on?: boolean;
  load?: () => Promise<VenueSwapApi>;
  gateRpc?: GateRpc;
}): VenueSwap {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const on = o.on ?? ownPoolSwapsOn();
  const gateRpc = useMemo(() => {
    if (o.gateRpc) return o.gateRpc;
    const rpc = withReadCommitment(browserRpc());
    return browserGateRpc(rpc, browserCurveRpc(rpc));
  }, [o.gateRpc]);

  // Wanted once is wanted for the page's life. A note is checked through the lazy loader
  // below, so it does not need the gate.
  const [latched, setLatched] = useState(false);
  if (on && o.wanted && !latched) setLatched(true);

  const read = useCallback((api: VenueSwapApi, cfg: CurveWriteConfig | null) => api.readSwapGate(gateRpc, cfg), [gateRpc]);
  const gateState = useLoadedGate<VenueSwapApi, CurveWriteConfig, SwapGate>({
    enabled: latched,
    load: o.load ?? loadVenueSwapApi,
    config: swapConfig,
    read,
    blocked: unreadable,
  });
  const api = gateState.status === 'ready' ? gateState.api : null;
  const gate = gateState.status === 'ready' ? gateState.gate : null;
  const cfg = gateState.status === 'ready' ? gateState.cfg : null;
  const signerState = useCurveSigner();

  // A read that failed is not the session's answer: it is asked again, so one bad
  // moment does not send every later trade our pool would win to Jupiter.
  const unread = gateState.status === 'load-failed' || (gate?.kind === 'blocked' && gate.reason === 'unreadable');
  const { refresh } = gateState;
  useEffect(() => {
    if (!unread) return;
    const t = setTimeout(refresh, GATE_RETRY_MS);
    return () => clearTimeout(t);
    // `gateState`: each answer is a new object, so an answer that failed again arms the next try.
  }, [unread, refresh, gateState]);

  const mismatch = gate?.kind === 'open' && o.programId !== null && gate.cfg.cpSwapProgram.toBase58() !== o.programId;
  const openGate = on && gate?.kind === 'open' && !mismatch ? gate : null;
  const ready = useMemo(() => (api && openGate ? { api, gate: openGate } : null), [api, openGate]);

  let unavailable: string | null = null;
  if (!on) unavailable = 'swaps in our own pools are switched off for now';
  else if (gateState.status === 'load-failed') unavailable = 'the swap code did not load';
  else if (gate?.kind === 'off') unavailable = 'it is switched off in this build';
  else if (gate?.kind === 'blocked') unavailable = BLOCKED[gate.reason] ?? NOT_CHECKED;
  else if (mismatch) unavailable = 'this page reads pools from one program and would send to another';
  else if (signerState.kind === 'cannot-sign') unavailable = 'this wallet cannot sign a transaction for this page to send';

  // Whether a note holds the wallet now, read again at the wallet's door (set below, once
  // the notes are read; storage alone until then).
  const holds = useRef<(scope?: string | null) => boolean>((at) => !!at && readPendingTrades(at).length > 0);
  // The send path, awaited: the flow below exists before the swap code has loaded, and
  // nothing reaches it until `ready` is set. A swap this wallet sent, in any tab, that the
  // chain has not answered for stops it, whatever is on screen: nothing is awaited between
  // that read and the wallet's prompt (write/submit.ts).
  const lazy = useMemo(() => {
    const load = o.load ?? loadVenueSwapApi;
    return {
      submitPrepared: async (...a: Parameters<VenueSwapApi['submitPrepared']>): Promise<TxOutcome> => {
        const api = await load();
        if (holds.current(signerScope(a[2]) ?? undefined)) return { status: 'not-sent', stage: 'sign', message: HELD_NOT_SENT };
        return api.submitPrepared(...a);
      },
      recheckOutcome: async (...a: Parameters<VenueSwapApi['recheckOutcome']>) => (await load()).recheckOutcome(...a),
    };
  }, [o.load]);

  // Through the lazy loader, never null: a note found on arrival is checked (and "Check again"
  // answers) even while the swap code has not loaded; a load that fails is said by the card.
  // A Jupiter note's blockhash, when it was seen valid, is the first proof it can no longer land.
  const check = useMemo<CheckSignature>(
    () => (sig, lvbh, _kind, blockhash) => {
      const opts = { ...(lvbh === null ? {} : { lastValidBlockHeight: lvbh }), ...(blockhash ? { blockhash } : {}) };
      return lazy.recheckOutcome(connection, sig, Object.keys(opts).length ? opts : undefined);
    },
    [lazy, connection],
  );
  // A lost wallet answer has no signature: only its blockhash, once gone, ends its hold early.
  const checkLost = useCallback<CheckLost>(async (bh) => {
    const r = await blockhashGone(connection, bh);
    return r === null ? null : r !== 'live';
  }, [connection]);
  const onResolved = o.onResolved;
  const resolved = useCallback(() => onResolved?.(), [onResolved]);
  // One wallet's notes: a swap it signed, by either route, holds Buy for it in every tab
  // of this site until the chain answers; another wallet is not held. Live, so a note
  // shows (and Buy is held) the moment it is written.
  const wallet = publicKey?.toBase58() ?? null;
  const pending = usePendingTrades(wallet ? swapPendingScope(wallet) : null, check, resolved, {
    live: true,
    scopeFor: signerScope,
    recheckEveryMs: NOTE_RECHECK_MS,
    checkLost,
  });

  const { record, sent, holdsNow } = pending;
  useEffect(() => {
    holds.current = holdsNow;
  }, [holdsNow]);
  const pageSettled = o.onSettled;
  const settled = useCallback<OnSettled>(
    (outcome, prepared, sentSignature) => {
      record(outcome, prepared, sentSignature);
      pageSettled?.(outcome, prepared, sentSignature);
    },
    [record, pageSettled],
  );
  const flow = useTxFlow(lazy, connection, settled, sent);

  return { loading: on && latched && gateState.status === 'loading', unavailable, ready, api, cfg, rpc: connection, signerState, flow, pending };
}
