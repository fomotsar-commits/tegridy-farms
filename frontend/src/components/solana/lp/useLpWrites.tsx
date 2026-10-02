import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { browserCurveRpc, browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import type { LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { rememberCreatedShare, type PositionsRead } from '../../../lib/solana/lp/positions';
import { rememberCreatedPool } from '../../../lib/solana/lp/poolFinder';
import { withReadCommitment } from '../curve/confirmedRpc';
import { browserGateRpc } from '../curve/gateRpc';
import { LP_PENDING_SCOPE, readPendingTrades } from '../curve/pendingTrade';
import { useCurveSigner, type CurveSignerState } from '../curve/useCurveSigner';
import { usePendingTrades, type CheckSignature, type PendingTradesState } from '../curve/usePendingTrades';
import { useLpGate } from '../curve/useWriteGate';
import type { CreateFacts, CurveWriteConfig, GateRpc, LpGate, LpWriteApi, WriteRpc } from '../curve/ports';
import { loadLpWriteApi } from './lpWriteApi';
import type { LpReaders } from './readers';

/**
 * Everything an Add, Remove or Open-a-pool panel needs, for every card and row in the LP
 * section, from one place: the write code (loaded only when LP's switch is not 'off'),
 * the LP gate, the create facts (the public fee tier and the fee account, read beside
 * the gate and never inside it), the connection that sends, the wallet, the pending
 * notes, and which panel is open.
 *
 * ONE PANEL AT A TIME. `active` names the open panel (`add:<pool>`, `remove:<lpAccount>`
 * or `create:<mint>`). Opening another closes it, unless it is busy (preparing,
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
  active: { kind: PanelKind; key: string } | null;
  busy: boolean;
  /**
   * False (and nothing changes) while another panel is busy. On close, focus goes back to
   * `opener`, or to `fallback` (the card's heading) when the opener is gone or switched off.
   */
  open(kind: PanelKind, key: string, opener: HTMLButtonElement | null, fallback?: HTMLElement | null): boolean;
  close(): void;
  setBusy(b: boolean): void;
  /** A flow went back to idle after an outcome: read the pools and the positions again. */
  finished(): void;
  /** Reads the gate again, and the create facts with it. */
  refreshGate(): void;
  /**
   * The public fee tier and the fee account, for opening a pool only: null until read.
   * Read once the gate is open with the mode 'on'; it never changes the gate, Add or Remove.
   */
  createFacts: CreateFacts | null;
  /** The create facts are being read (again): what `createFacts` shows is the last answer. */
  createFactsReading: boolean;
  refreshCreateFacts(): void;
  /**
   * A confirmed opening of `pool` (for `tokenMint`, when known): this tab remembers the
   * pool (the finder lists it for that token, and the card says "you opened one") and its
   * share's placement (Remove is offered at once).
   */
  remember(pool: string, tokenMint?: string): void;
  /** Pool shares the wallet holds of this share mint, from the last positions read; null when unread. */
  heldShares(lpMint: string): bigint | null;
  /** "Your positions" reports each answer here, so a deposit can say the share before and after. */
  reportPositions(read: PositionsRead | null): void;
}

export type PanelKind = 'add' | 'remove' | 'create';

const LpWritesContext = createContext<LpWrites | null>(null);

/** The panels' hook: null without a provider, which is a build with LP switched 'off'. */
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

  // The pool program the page reads (and, with no mismatch, writes to): the created
  // share's placement is keyed by it, exactly as the positions read keys it.
  const programId = readers.programId;
  const remember = useCallback(
    (pool: string, tokenMint?: string) => {
      rememberCreatedPool(pool, tokenMint ?? null);
      try {
        rememberCreatedShare(new PublicKey(programId), new PublicKey(pool));
      } catch {
        // Only a shortcut: without it the share is still placed by the index or the chain.
      }
    },
    [programId],
  );

  // A liquidity note is looked up with its config and its kind, so a refusal found
  // there is said in that kind's own words. A confirmed opening found here (after a
  // reload, or on Check again) is remembered like one confirmed in its own panel: its
  // pool is read from this tab's note before the note is cleared.
  const check = useMemo<CheckSignature | null>(
    () =>
      api && cfg
        ? async (sig, lvbh, kind) => {
            const note = readPendingTrades(LP_PENDING_SCOPE).find((n) => n.signature === sig);
            const o = await api.recheckOutcome(connection, sig, { lastValidBlockHeight: lvbh ?? undefined, cfg, kind });
            if (o.status === 'confirmed' && note?.kind === 'lp-create' && note.pool) remember(note.pool);
            return o;
          }
        : null,
    [api, cfg, connection, remember],
  );
  // Live: a note holds every card in this tab the moment it is written (another pool,
  // another token, a panel that was closed or left), not only after a reload.
  const pending = usePendingTrades(LP_PENDING_SCOPE, check, finished, { live: true });

  const [active, setActive] = useState<LpWrites['active']>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const openerFallback = useRef<HTMLElement | null>(null);
  const [focusOpener, setFocusOpener] = useState(0);

  const open = useCallback(
    (kind: PanelKind, key: string, from: HTMLButtonElement | null, fallback: HTMLElement | null = null) => {
      if (busyRef.current) return false;
      opener.current = from;
      openerFallback.current = fallback;
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
    else if (openerFallback.current?.isConnected) openerFallback.current.focus();
  }, [focusOpener]);

  // The create facts: only once the gate is open with the mode 'on' (opening a pool is
  // paused with adding). An answer counts only for the gate it was asked under; the last
  // answer stays on screen while the facts are read again.
  const [facts, setFacts] = useState<{ gate: LpGate; facts: CreateFacts; nonce: number } | null>(null);
  const [factsNonce, setFactsNonce] = useState(0);
  const factsGate = gate?.kind === 'open' && gate.mode === 'on' && mode === 'on' ? gate : null;
  useEffect(() => {
    if (!api || !factsGate) return;
    let live = true;
    // `readCreateFacts` never throws. If it ever did, that is an unread tier, never a ready one.
    Promise.resolve()
      .then(() => api.readCreateFacts(gateRpc, factsGate.cfg))
      .then(
        (f) => {
          if (live) setFacts({ gate: factsGate, facts: f, nonce: factsNonce });
        },
        (e: unknown) => {
          if (!live) return;
          const detail = e instanceof Error ? e.message : String(e);
          setFacts({
            gate: factsGate,
            facts: { tier: { kind: 'unread', address: factsGate.cfg.cpSwapProgram, detail }, feeAccount: { kind: 'unread', detail } },
            nonce: factsNonce,
          });
        },
      );
    return () => {
      live = false;
    };
  }, [api, factsGate, gateRpc, factsNonce]);
  const createFacts = factsGate && facts && facts.gate === factsGate ? facts.facts : null;
  const createFactsReading = !!api && factsGate !== null && !(facts && facts.gate === factsGate && facts.nonce === factsNonce);
  const refreshCreateFacts = useCallback(() => setFactsNonce((n) => n + 1), []);
  const refreshGateOnly = gateState.refresh;
  const refreshGate = useCallback(() => {
    refreshGateOnly();
    refreshCreateFacts();
  }, [refreshGateOnly, refreshCreateFacts]);

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
      refreshGate,
      createFacts,
      createFactsReading,
      refreshCreateFacts,
      remember,
      heldShares,
      reportPositions,
    }),
    [
      mode, gateState, api, cfg, gate, mismatch, connection, signerState, readers, pending, active, busy, open, close, setBusy, finished,
      refreshGate, createFacts, createFactsReading, refreshCreateFacts, remember, heldShares, reportPositions,
    ],
  );
  return <LpWritesContext.Provider value={value}>{children}</LpWritesContext.Provider>;
}
