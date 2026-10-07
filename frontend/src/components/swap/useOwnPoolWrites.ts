import { useMemo, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { browserCurveRpc, browserRpc } from '../../lib/launcher/solana/curve/rpc';
import { lpWriteMode } from '../../lib/launcher/solana/lpWriteFlag';
import { LIVE_PROGRAM_ID } from '../../lib/solana/cpswap/program';
import { OWN_POOL_SWAPS } from '../../lib/solana/swap/ownPoolSwaps';
import type { OwnSend } from '../../lib/solana/swap/venueChoice';
import { withReadCommitment } from '../solana/curve/confirmedRpc';
import { browserGateRpc } from '../solana/curve/gateRpc';
import { SWAP_PENDING_SCOPE, readPendingTrades } from '../solana/curve/pendingTrade';
import type { CurveWriteConfig, GateRpc, LpOpenGate, LpWriteApi, TxSigner, WriteRpc } from '../solana/curve/ports';
import { useCurveSigner, type CurveSignerState } from '../solana/curve/useCurveSigner';
import { usePendingTrades, type CheckSignature, type PendingTradesState } from '../solana/curve/usePendingTrades';
import { useLpGate } from '../solana/curve/useWriteGate';
import { loadLpWriteApi } from '../solana/lp/lpWriteApi';

// The swap page's way to send a trade to one of our pools: the LP write layer (loaded only
// when a pool of ours quotes the pair for a connected wallet, or a note of an earlier trade
// stands), its gate, the wallet as a signer, and the notes of trades sent and not yet
// answered, which hold the whole Buy, for both venues, until the chain answers.

export const OWN_SEND_COPY = {
  switchedOff: 'trades in our pools are switched off on this page',
  paused: 'trades in our pools are paused right now',
  notLoaded: 'the code that sends trades to our pools did not load',
  otherProgram: 'this page would send to a different pool program than the one it reads',
  cannotSign: 'this wallet cannot sign a transaction for this site to send',
} as const;

export interface OwnPoolWrites {
  send: OwnSend;
  api: LpWriteApi | null;
  gate: LpOpenGate | null;
  cfg: CurveWriteConfig | null;
  signer: TxSigner | null;
  signerState: CurveSignerState;
  rpc: WriteRpc;
  pending: PendingTradesState;
}

export function useOwnPoolWrites(o: {
  /** A pool of ours quotes the pair on screen, for a connected wallet. */
  wanted: boolean;
  /** The chain answered for a note: read both venues again. */
  onResolved: () => void;
  load?: () => Promise<LpWriteApi>;
  gateRpc?: GateRpc;
  programId?: string | null;
}): OwnPoolWrites {
  const { connection } = useConnection();
  const signerState = useCurveSigner();
  const programId = o.programId === undefined ? (LIVE_PROGRAM_ID?.toBase58() ?? null) : o.programId;
  const gateRpc = useMemo(() => {
    if (o.gateRpc) return o.gateRpc;
    const rpc = withReadCommitment(browserRpc());
    return browserGateRpc(rpc, browserCurveRpc(rpc));
  }, [o.gateRpc]);
  // A note from before a reload must be checked whatever is on screen now.
  const [noted] = useState(() => readPendingTrades(SWAP_PENDING_SCOPE).length > 0);
  const mode = lpWriteMode();
  const enabled = mode !== 'off' && (noted || (OWN_POOL_SWAPS && o.wanted));
  const gateState = useLpGate<LpWriteApi>(gateRpc, { enabled, load: o.load ?? loadLpWriteApi });

  const api = gateState.status === 'ready' ? gateState.api : null;
  const cfg = gateState.status === 'ready' ? gateState.cfg : null;
  const raw = gateState.status === 'ready' ? gateState.gate : null;
  const gate = raw?.kind === 'open' && raw.mode === 'on' && raw.cfg.cpSwapProgram.toBase58() === programId ? raw : null;

  const check = useMemo<CheckSignature | null>(
    () => (api && cfg ? (sig, lvbh, kind) => api.recheckOutcome(connection, sig, { lastValidBlockHeight: lvbh ?? undefined, cfg, kind }) : null),
    [api, cfg, connection],
  );
  const pending = usePendingTrades(SWAP_PENDING_SCOPE, check, o.onResolved, { live: true });

  let send: OwnSend;
  if (!OWN_POOL_SWAPS) send = { kind: 'no', reason: OWN_SEND_COPY.switchedOff };
  else if (mode !== 'on') send = { kind: 'no', reason: OWN_SEND_COPY.paused };
  // No wallet: nothing can be pressed yet, and the line says what Buy would do.
  else if (signerState.kind === 'disconnected') send = { kind: 'yes' };
  else if (signerState.kind === 'cannot-sign') send = { kind: 'no', reason: OWN_SEND_COPY.cannotSign };
  else if (gateState.status === 'load-failed') send = { kind: 'no', reason: OWN_SEND_COPY.notLoaded };
  else if (gateState.status !== 'ready') send = { kind: 'checking' };
  else if (raw?.kind === 'open' && raw.cfg.cpSwapProgram.toBase58() !== programId) send = { kind: 'no', reason: OWN_SEND_COPY.otherProgram };
  else send = gate ? { kind: 'yes' } : { kind: 'no', reason: OWN_SEND_COPY.paused };

  return {
    send,
    api,
    gate,
    cfg,
    signer: signerState.kind === 'ready' ? signerState.signer : null,
    signerState,
    rpc: connection,
    pending,
  };
}
