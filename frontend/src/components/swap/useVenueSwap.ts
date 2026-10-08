import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { browserCurveRpc, browserRpc } from '../../lib/launcher/solana/curve/rpc';
import { ownPoolSwapsOn } from '../../lib/solana/swap/ownPoolSwapFlag';
import { withReadCommitment } from '../solana/curve/confirmedRpc';
import { browserGateRpc } from '../solana/curve/gateRpc';
import { SWAP_PENDING_SCOPE, readPendingTrades } from '../solana/curve/pendingTrade';
import type { CurveWriteConfig, GateBlock, GateRpc, SwapGate, SwapOpenGate, VenueSwapApi, WriteRpc } from '../solana/curve/ports';
import { useCurveSigner, type CurveSignerState } from '../solana/curve/useCurveSigner';
import { usePendingTrades, type CheckSignature, type PendingTradesState } from '../solana/curve/usePendingTrades';
import { useTxFlow, type OnSettled, type TxFlow } from '../solana/curve/useTxFlow';
import { useLoadedGate } from '../solana/curve/useWriteGate';
import { loadVenueSwapApi } from './venueSwapApi';

/**
 * What the swap page needs to send a trade to one of our own pools: the swap code
 * (loaded only once a pool of ours has quoted, or a note of an unconfirmed swap stands),
 * its gate, the wallet as a signer, the one review flow, and the notes that survive a
 * reload. The same review, test run and Sign in wallet as every other signed action here.
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
  /** Swaps sent from this browser that the chain has not answered for yet. */
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
  const on = o.on ?? ownPoolSwapsOn();
  const gateRpc = useMemo(() => {
    if (o.gateRpc) return o.gateRpc;
    const rpc = withReadCommitment(browserRpc());
    return browserGateRpc(rpc, browserCurveRpc(rpc));
  }, [o.gateRpc]);

  // Wanted once is wanted for the page's life. A note found on arrival wants the code at
  // once, switch on or off, because checking that note needs the send path.
  const [latched, setLatched] = useState(() => readPendingTrades(SWAP_PENDING_SCOPE).length > 0);
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

  // The send path, awaited: the flow below exists before the swap code has loaded, and
  // nothing reaches it until `ready` is set.
  const lazy = useMemo(() => {
    const load = o.load ?? loadVenueSwapApi;
    return {
      submitPrepared: async (...a: Parameters<VenueSwapApi['submitPrepared']>) => (await load()).submitPrepared(...a),
      recheckOutcome: async (...a: Parameters<VenueSwapApi['recheckOutcome']>) => (await load()).recheckOutcome(...a),
    };
  }, [o.load]);

  // Through the lazy loader, never null: a note found on arrival is checked (and "Check again"
  // answers) even while the swap code has not loaded; a load that fails is said by the card.
  const check = useMemo<CheckSignature>(
    () => (sig, lvbh) => lazy.recheckOutcome(connection, sig, lvbh === null ? undefined : { lastValidBlockHeight: lvbh }),
    [lazy, connection],
  );
  const onResolved = o.onResolved;
  const resolved = useCallback(() => onResolved?.(), [onResolved]);
  const pending = usePendingTrades(SWAP_PENDING_SCOPE, check, resolved);

  const { record, sent } = pending;
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
