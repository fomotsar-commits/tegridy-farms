import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { browserCurveRpc, browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import type { LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import type { PositionsRead } from '../../../lib/solana/lp/positions';
import { withReadCommitment } from '../curve/confirmedRpc';
import { browserGateRpc } from '../curve/gateRpc';
import { LP_PENDING_SCOPE } from '../curve/pendingTrade';
import { useCurveSigner, type CurveSignerState } from '../curve/useCurveSigner';
import { usePendingTrades, type CheckSignature, type PendingTradesState } from '../curve/usePendingTrades';
import { useLpGate } from '../curve/useWriteGate';
import type { CurveWriteConfig, GateRpc, LpGate, LpWriteApi, WriteRpc } from '../curve/ports';
import { loadLpWriteApi } from './lpWriteApi';
import type { LpReaders } from './readers';

/**
 * Everything an Add or Remove panel needs, for every card and row in the LP section,
 * from one place: the write code (loaded only when LP's switch is not 'off'), the LP
 * gate, the connection that sends, the wallet, the pending notes, and which panel is
 * open.
 *
 * ONE PANEL AT A TIME. `active` names the open panel (`add:<pool>` or
 * `remove:<lpAccount>`). Opening another closes it, unless it is busy (preparing,
 * signing, sent, or an unknown outcome with a signature): then every other entry
 * button is disabled. One live `useTxFlow` is what the pending lock assumes.
 */
export interface LpWrites {
  mode: LpWriteMode;
  status: 'loading' | 'load-failed' | 'ready';
  /** Why the write code did not load. */
  detail: string | null;
  api: LpWriteApi | null;
  /** This build's write ids and cluster (for explorer links); null until the write code loads. */
  cfg: CurveWriteConfig | null;
  /**
   * The gate the section acts on. A gate that opened on a pool program other than the
   * one this page reads pools from is reported as blocked (`mismatch`): the pools it
   * reads and the program it writes to must be one program.
   */
  gate: LpGate | null;
  mismatch: boolean;
  rpc: WriteRpc;
  signerState: CurveSignerState;
  readers: LpReaders;
  pending: PendingTradesState;
  active: { kind: 'add' | 'remove'; key: string } | null;
  busy: boolean;
  /** False (and nothing changes) while another panel is busy. */
  open(kind: 'add' | 'remove', key: string, opener: HTMLButtonElement | null): boolean;
  close(): void;
  setBusy(b: boolean): void;
  /** A flow went back to idle after an outcome: read the pools and the positions again. */
  finished(): void;
  refreshGate(): void;
  /** Pool shares the wallet holds of this share mint, from the last positions read; null when unread. */
  heldShares(lpMint: string): bigint | null;
  /** "Your positions" reports each answer here, so a deposit can say the share before and after. */
  reportPositions(read: PositionsRead | null): void;
}

const LpWritesContext = createContext<LpWrites | null>(null);

/** The panels' hook: null without a provider, which is the shipped 'off' build. */
// eslint-disable-next-line react-refresh/only-export-components
export function useLpWrites(): LpWrites | null {
  return useContext(LpWritesContext);
}

export function LpWritesProvider({
  readers,
  mode,
  load = loadLpWriteApi,
  gateRpc: givenGateRpc,
  onFinished,
  children,
}: {
  readers: LpReaders;
  mode: Exclude<LpWriteMode, 'off'>;
  load?: () => Promise<LpWriteApi>;
  /** Tests pass one; the browser reads through /api/solrpc. */
  gateRpc?: GateRpc;
  /** A flow finished: the section bumps its re-read key. */
  onFinished?: () => void;
  children: ReactNode;
}) {
  const { connection } = useConnection();
  const gateRpc = useMemo(() => {
    if (givenGateRpc) return givenGateRpc;
    const rpc = withReadCommitment(browserRpc());
    return browserGateRpc(rpc, browserCurveRpc(rpc));
  }, [givenGateRpc]);
  const gateState = useLpGate<LpWriteApi>(gateRpc, { enabled: true, load });
  const signerState = useCurveSigner();

  const api = gateState.status === 'ready' ? gateState.api : null;
  const rawGate = gateState.status === 'ready' ? gateState.gate : null;
  const cfg = gateState.status === 'ready' ? gateState.cfg : null;
  const mismatch = rawGate?.kind === 'open' && rawGate.cfg.cpSwapProgram.toBase58() !== readers.programId;
  const gate: LpGate | null = useMemo(
    () =>
      mismatch && rawGate?.kind === 'open'
        ? {
            kind: 'blocked',
            reason: 'venue-mismatch',
            detail: `This page reads pools from ${readers.programId} and would send to ${rawGate.cfg.cpSwapProgram.toBase58()}.`,
          }
        : rawGate,
    [mismatch, rawGate, readers.programId],
  );

  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  }, [onFinished]);
  const finished = useCallback(() => finishedRef.current?.(), []);

  // A liquidity note is looked up with its config and its kind, so a refusal found
  // there is said in that kind's own words.
  const check = useMemo<CheckSignature | null>(
    () =>
      api && cfg
        ? (sig, lvbh, kind) => api.recheckOutcome(connection, sig, { lastValidBlockHeight: lvbh ?? undefined, cfg, kind })
        : null,
    [api, cfg, connection],
  );
  const pending = usePendingTrades(LP_PENDING_SCOPE, check, finished);

  const [active, setActive] = useState<LpWrites['active']>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [focusOpener, setFocusOpener] = useState(0);

  const open = useCallback(
    (kind: 'add' | 'remove', key: string, from: HTMLButtonElement | null) => {
      if (busyRef.current) return false;
      opener.current = from;
      setActive({ kind, key });
      return true;
    },
    [],
  );
  const close = useCallback(() => {
    if (busyRef.current) return;
    setActive(null);
    setFocusOpener((n) => n + 1);
  }, []);
  const setBusy = useCallback((b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  }, []);

  // Back to the button that opened the panel, once the panel is gone.
  useEffect(() => {
    if (focusOpener === 0) return;
    const el = opener.current;
    if (el && el.isConnected && !el.disabled) el.focus();
  }, [focusOpener]);

  const [positions, setPositions] = useState<PositionsRead | null>(null);
  const reportPositions = useCallback((read: PositionsRead | null) => setPositions(read), []);
  const heldShares = useCallback(
    (lpMint: string) => {
      if (!positions || positions.kind !== 'ok') return null;
      return positions.positions.filter((p) => p.lpMint === lpMint).reduce((sum, p) => sum + p.lpAmount, 0n);
    },
    [positions],
  );

  const value = useMemo<LpWrites>(
    () => ({
      mode,
      status: gateState.status === 'ready' ? 'ready' : gateState.status === 'load-failed' ? 'load-failed' : 'loading',
      detail: gateState.status === 'load-failed' ? gateState.detail : null,
      api,
      cfg,
      gate,
      mismatch,
      rpc: connection,
      signerState,
      readers,
      pending,
      active,
      busy,
      open,
      close,
      setBusy,
      finished,
      refreshGate: gateState.refresh,
      heldShares,
      reportPositions,
    }),
    [mode, gateState, api, cfg, gate, mismatch, connection, signerState, readers, pending, active, busy, open, close, setBusy, finished, heldShares, reportPositions],
  );
  return <LpWritesContext.Provider value={value}>{children}</LpWritesContext.Provider>;
}
