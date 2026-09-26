// Polyfill MUST load before any @solana/* import — keep this the very first
// import in this lazy chunk's entry (mirrors CurveLaunchPage / SolanaSwapPage).
import '../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import {
  browserCurveRpc,
  browserRpc,
  clipDetail,
  looksLikePubkey,
  migrationEligibility,
  readLaunch,
  readMint,
  readRentFloors,
  type CurveRpc,
  type LaunchState,
  type MintFacts,
  type Read,
  type SolanaRpc,
} from '../lib/launcher/solana/curve';
import { Card, Notice, Row } from '../components/solana/curve/ui';
import { CurveStateCard } from '../components/solana/curve/CurveStateCard';
import { WriteGateBanner } from '../components/solana/curve/WriteGateBanner';
import { CreatorStakeFacts, LaunchIdentity } from '../components/solana/curve/LaunchIdentity';
import { CurveTradePanel } from '../components/solana/curve/CurveTradePanel';
import { GraduationPanel } from '../components/solana/curve/GraduationPanel';
import { PoolSwapPanel } from '../components/solana/curve/PoolSwapPanel';
import { browserGateRpc } from '../components/solana/curve/gateRpc';
import { withReadCommitment } from '../components/solana/curve/confirmedRpc';
import { useWriteGate, type WriteGateState } from '../components/solana/curve/useWriteGate';
import { useCurveSigner, type CurveSignerState } from '../components/solana/curve/useCurveSigner';
import {
  awaitingOwnLaunch,
  clearPendingLaunch,
  readPendingLaunch,
  type PendingLaunch,
} from '../components/solana/curve/pendingLaunch';
import { holdingFact, openingBuyFromOrigin, type Fact } from '../components/solana/curve/facts';
import { usePendingTrades, type PendingTradesState } from '../components/solana/curve/usePendingTrades';
import { BeforeYouTrade } from '../components/solana/curve/BeforeYouTrade';
import { sharePercent } from '../components/solana/curve/uiFormat';
import type { OnSettled } from '../components/solana/curve/useTxFlow';
import type { LaunchPoolRead, MetadataRead, TokenMetadata, WriteRpc } from '../components/solana/curve/ports';

// /curve-launch/:mint: one launch on our own Solana curve. Identity, the creator's
// stake, the curve's state, and, only while the write gate is open, the trade,
// graduation and pool panels.
//
// Everything is read from the program the write layer is configured for. A launch
// that does not exist says so; one that was just sent and has not landed says "not
// found yet", from a note this browser kept when it sent it.

/** Everything the page reads about one launch. Each field keeps its own "could not read". */
export interface LaunchData {
  launch: LaunchState;
  mintFacts: Read<MintFacts>;
  rentFloor: bigint | null;
  metadata: Read<TokenMetadata>;
  json: MetadataRead | null;
  openingBuy: Fact<bigint> | null;
  holding: Fact<bigint> | null;
  /** `null` when not graduated, or not read yet. */
  pool: LaunchPoolRead | null;
}

export interface SolanaLaunchViewProps {
  gateState: WriteGateState;
  mint: PublicKey;
  /** `null` while the first read is in flight. */
  data: LaunchData | null;
  pending: PendingLaunch | null;
  signerState: CurveSignerState;
  writeRpc: WriteRpc;
  onSettled: OnSettled;
  onRecheckPending: () => void;
  recheckingPending: boolean;
  /** What the last check of this browser's pending launch found, in plain words. */
  pendingCheckMessage?: string | null;
  /** Read the launch again (offered when a read failed). */
  onReload?: () => void;
  /** The connected wallet's tokens of this mint, for the sell side. `null` while reading. */
  walletHolding?: Fact<bigint> | null;
  /**
   * Trades on this mint this browser sent and could not confirm, kept across a
   * reload. While any stands, no trade form is shown. Its `sent` is what every panel
   * calls the moment a transaction is sent, so the note exists before the wait.
   */
  pendingTrade?:
    | (Pick<PendingTradesState, 'notes' | 'checking' | 'message' | 'recheck' | 'dismiss'> &
        Partial<Pick<PendingTradesState, 'sent'>>)
    | null;
}

/** A trade sent from this browser that the chain has not answered for yet. Trading stays off until it has. */
function PendingTradeCard({
  state,
  explorerUrl,
}: {
  state: NonNullable<SolanaLaunchViewProps['pendingTrade']>;
  explorerUrl: (signature: string) => string;
}) {
  return (
    <Card title="Your last trade may still be landing" testId="pending-trade">
      <Notice tone="warn">Sent, not confirmed yet. Trading here stays off until it is checked.</Notice>
      <Notice>It may still go through. Sending another trade now could make you pay twice.</Notice>
      {/* Always there, so each check's answer is read out when it arrives. */}
      <p role="status" className="text-white/55">
        {state.checking ? 'Checking it on the network…' : (state.message ?? '')}
      </p>
      {state.notes.map((n) => (
        <div key={n.signature} className="space-y-1">
          <Row label="Transaction signature" value={n.signature} />
          <a
            href={explorerUrl(n.signature)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline text-white/80"
          >
            View on the explorer
          </a>
        </div>
      ))}
      {/* aria-disabled, not disabled: a button switched off under the keyboard drops focus to the page. */}
      <button
        type="button"
        className={`btn-primary w-full py-2 text-[12px] ${state.checking ? 'opacity-60' : ''}`}
        aria-disabled={state.checking || undefined}
        onClick={() => !state.checking && state.recheck()}
      >
        Check again
      </button>
      <button
        type="button"
        className={`btn-secondary w-full py-2 text-[12px] ${state.checking ? 'opacity-60' : ''}`}
        aria-disabled={state.checking || undefined}
        onClick={() => !state.checking && state.dismiss()}
      >
        I checked my wallet: start over
      </button>
    </Card>
  );
}

const backLink = (
  <Link to="/curve-launch" className="text-white/70 underline text-[12px]">
    Back to all launches
  </Link>
);

/** Presentational: every state of the page can be driven in a test without a chain or a wallet. */
export function SolanaLaunchView({
  gateState,
  mint,
  data,
  pending,
  signerState,
  writeRpc,
  onSettled,
  onRecheckPending,
  recheckingPending,
  pendingCheckMessage = null,
  onReload,
  walletHolding,
  pendingTrade = null,
}: SolanaLaunchViewProps) {
  if (gateState.status === 'disabled') {
    return (
      <Card title="Launching and trading are not switched on here yet">
        <p>This site does not offer launches on its own Solana curve yet, so there is nothing to show for this address.</p>
        <Row label="Token address (mint)" value={mint.toBase58()} />
        {backLink}
      </Card>
    );
  }
  const banner = <WriteGateBanner state={gateState} />;
  if (gateState.status !== 'ready' || !gateState.cfg) {
    return (
      <>
        {banner}
        <Row label="Token address (mint)" value={mint.toBase58()} />
      </>
    );
  }

  const { api, gate } = gateState;
  const open = gate.kind === 'open' ? gate : null;
  const launch = data?.launch ?? null;
  const curve = launch?.curve ?? null;
  const decimals = data?.mintFacts.kind === 'ok' ? data.mintFacts.value.decimals : null;
  const supply = data?.mintFacts.kind === 'ok' ? data.mintFacts.value.supply : null;
  const eligible =
    open && curve && data ? migrationEligibility(open.global, curve, data.rentFloor).eligible === true : false;
  const actions =
    open && launch
      ? api.writeActions(open, launch, {
          migrationEligible: eligible,
          reserveReleased: curve?.curve.platformReserveReleased ?? false,
        })
      : null;
  const phase = launch?.phase.kind;
  const tradable = phase === 'trading' || phase === 'at-target' || phase === 'awaiting-migration';
  // A trade this browser sent may still land: no form until the chain has answered.
  const tradeHeld = !!pendingTrade && pendingTrade.notes.length > 0;
  const onSent = pendingTrade?.sent;
  const c = curve?.curve ?? null;
  // The pool's fee settings. A graduated launch is traded in ITS pool, under that
  // pool's own settings account; before graduation, the pool it will open uses the
  // launch program's current one (and switches the creator fee on).
  const poolRead = data?.pool ?? null;
  const livePool = poolRead && (poolRead.kind === 'ok' || poolRead.kind === 'closed-to-swaps') ? poolRead.value : null;
  const poolFees =
    phase === 'graduated'
      ? livePool
        ? {
            fee: livePool.ammConfig.tradeFeeRate,
            protocol: livePool.ammConfig.protocolFeeRate,
            fund: livePool.ammConfig.fundFeeRate,
            creator: livePool.snapshot.pool.enableCreatorFee ? livePool.ammConfig.creatorFeeRate : 0n,
          }
        : null
      : open
        ? {
            fee: open.ammConfig.tradeFeeRate,
            protocol: open.ammConfig.protocolFeeRate,
            fund: open.ammConfig.fundFeeRate,
            creator: open.ammConfig.creatorFeeRate,
          }
        : null;
  const reserveWords =
    !c || c.platformReserveTokens === 0n
      ? null
      : supply !== null
        ? `${sharePercent(c.platformReserveTokens, supply) ?? 'Part'} of the supply`
        : 'Part of the supply';

  return (
    <>
      {banner}
      <Card title="Launch" testId="launch-identity-card">
        <LaunchIdentity meta={api.meta} mint={mint} metadata={data?.metadata ?? null} json={data?.json ?? null} />
        {curve && (
          <>
            <Row label="Creator" value={curve.curve.creator.toBase58()} />
            <CreatorStakeFacts
              openingBuy={data?.openingBuy ?? null}
              holding={data?.holding ?? null}
              supply={supply}
              decimals={decimals}
            />
          </>
        )}
      </Card>

      {data === null && <Notice>Reading this launch from the network…</Notice>}

      {awaitingOwnLaunch(pending, phase) && pending ? (
        <Card title={phase === 'unreadable' ? 'Could not check yet' : 'Not found yet'} testId="pending-launch">
          <Notice tone="warn">
            {phase === 'unreadable'
              ? 'We could not read the network just now. Your launch may still be landing. Do not launch it again.'
              : 'Not found yet. Your launch may still be landing. Do not launch it again.'}
          </Notice>
          <Row label="Transaction signature" value={pending.signature} />
          <a
            href={api.explorerTxUrl(pending.signature, gateState.cfg.cluster)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline text-white/80"
          >
            View on the explorer
          </a>
          <p role="status" className="text-white/55">
            {recheckingPending ? 'Checking it on the network…' : (pendingCheckMessage ?? '')}
          </p>
          <button
            type="button"
            className={`btn-primary w-full py-2 text-[12px] ${recheckingPending ? 'opacity-60' : ''}`}
            aria-disabled={recheckingPending || undefined}
            onClick={() => !recheckingPending && onRecheckPending()}
          >
            Check again
          </button>
        </Card>
      ) : (
        phase === 'pre-launch' && (
          <Card title="No launch at this address">
            <p>This token address has no curve on this program. Check the address you were given.</p>
          </Card>
        )
      )}

      {launch && (
        <CurveStateCard
          phase={launch.phase}
          curve={curve?.curve ?? null}
          decimals={decimals}
          paused={launch.paused}
          lookedUp
        />
      )}
      {phase === 'unreadable' && !pending && onReload && (
        <button type="button" className="btn-primary w-full py-2 text-[12px]" onClick={onReload}>
          Read again
        </button>
      )}

      {open && c && actions && (
        <BeforeYouTrade
          curveFeeBps={c.tradeFeeBps}
          creatorShareBps={c.creatorFeeShareBps}
          poolFeePpm={poolFees?.fee ?? null}
          poolProtocolPpm={poolFees?.protocol ?? null}
          poolFundPpm={poolFees?.fund ?? null}
          poolCreatorPpm={poolFees?.creator ?? null}
          reserve={reserveWords}
        />
      )}
      {open && tradeHeld && pendingTrade && (
        <PendingTradeCard state={pendingTrade} explorerUrl={(sig) => api.explorerTxUrl(sig, open.cfg.cluster)} />
      )}
      {open && launch && curve && actions && tradable && !tradeHeld && (
        <CurveTradePanel
          api={api}
          rpc={writeRpc}
          gate={open}
          launch={launch}
          curve={curve}
          mint={mint}
          decimals={decimals}
          rentFloor={data?.rentFloor ?? null}
          actions={actions}
          signerState={signerState}
          onSettled={onSettled}
          onSent={onSent}
          walletHolding={walletHolding}
        />
      )}
      {open && launch && curve && actions && !tradeHeld && (
        <GraduationPanel
          api={api}
          rpc={writeRpc}
          gate={open}
          launch={launch}
          curve={curve}
          mint={mint}
          decimals={decimals}
          rentFloor={data?.rentFloor ?? null}
          actions={actions}
          signerState={signerState}
          onSettled={onSettled}
          onSent={onSent}
        />
      )}
      {open && actions && phase === 'graduated' && !tradeHeld && (
        <PoolSwapPanel
          api={api}
          rpc={writeRpc}
          gate={open}
          mint={mint}
          pool={data?.pool ?? null}
          decimals={decimals}
          actions={actions}
          signerState={signerState}
          onSettled={onSettled}
          onSent={onSent}
          walletHolding={walletHolding}
        />
      )}
      {backLink}
    </>
  );
}

async function loadLaunchData(
  gateState: Extract<WriteGateState, { status: 'ready' }>,
  rpc: SolanaRpc,
  curveRpc: CurveRpc,
  mint: PublicKey,
): Promise<LaunchData> {
  const { api, cfg, gate } = gateState;
  if (!cfg) throw new Error('no program is configured');
  const mintStr = mint.toBase58();
  const [launch, mintFacts, rent, metadata] = await Promise.all([
    readLaunch(curveRpc, mint, cfg.programId),
    readMint(rpc, mintStr),
    readRentFloors(curveRpc),
    api.readTokenMetadata(curveRpc, mint).catch(
      (e: unknown): Read<TokenMetadata> => ({ kind: 'unreadable', detail: clipDetail(e) }),
    ),
  ]);
  const curve = launch.curve;
  const [json, openingBuy, holding, pool] = await Promise.all([
    metadata.kind === 'ok'
      ? api.meta
          .readLaunchMetadataJson(metadata.value.uri, mintStr)
          .catch((e: unknown): MetadataRead => ({ kind: 'unreadable', detail: clipDetail(e) }))
      : Promise.resolve(null),
    curve
      ? api
          .readLaunchOrigin(rpc, cfg, mint)
          .then(openingBuyFromOrigin)
          .catch((e: unknown): Fact<bigint> => ({ kind: 'unreadable', detail: clipDetail(e) }))
      : Promise.resolve(null),
    curve
      ? api
          .readCreatorHolding(curveRpc, mint, curve.curve.creator)
          .then(holdingFact)
          .catch((e: unknown): Fact<bigint> => ({ kind: 'unreadable', detail: clipDetail(e) }))
      : Promise.resolve(null),
    curve && launch.phase.kind === 'graduated' && gate.kind === 'open'
      ? api
          .readLaunchPool(curveRpc, cfg, mint, curve.curve, gate.global)
          .catch((e: unknown): LaunchPoolRead => ({ kind: 'unreadable', detail: clipDetail(e) }))
      : Promise.resolve(null),
  ]);
  return { launch, mintFacts, rentFloor: rent ? rent.curve : null, metadata, json, openingBuy, holding, pool };
}

/** How often a page waiting for its own just-sent launch looks again. */
const PENDING_POLL_MS = 3_000;

function SolanaLaunchInner({ mint }: { mint: PublicKey }) {
  // Confirmed, not the RPC's finalized default: after a trade the page must quote the
  // curve the trade left behind (see confirmedRpc.ts).
  const rpc = useMemo(() => withReadCommitment(browserRpc()), []);
  const curveRpc = useMemo(() => browserCurveRpc(rpc), [rpc]);
  const { connection } = useConnection();
  const gateRpc = useMemo(() => browserGateRpc(rpc, curveRpc), [rpc, curveRpc]);
  const gateState = useWriteGate(gateRpc);
  const signerState = useCurveSigner();
  const mintStr = mint.toBase58();
  const [pending, setPending] = useState<PendingLaunch | null>(() => readPendingLaunch(mintStr));
  const [data, setData] = useState<LaunchData | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [rechecking, setRechecking] = useState(false);
  const [pendingCheckMessage, setPendingCheckMessage] = useState<string | null>(null);

  useEffect(() => {
    if (gateState.status !== 'ready' || !gateState.cfg) return;
    let live = true;
    loadLaunchData(gateState, rpc, curveRpc, mint)
      .then((d) => {
        if (!live) return;
        setData(d);
        // The launch is on chain: the note has done its job.
        if (d.launch.curve && pending) {
          clearPendingLaunch(mintStr);
          setPending(null);
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        const detail = clipDetail(e);
        setData({
          launch: { phase: { kind: 'unreadable', detail }, paused: null, ammConfigured: null, global: null, curve: null },
          mintFacts: { kind: 'unreadable', detail },
          rentFloor: null,
          metadata: { kind: 'unreadable', detail },
          json: null,
          openingBuy: null,
          holding: null,
          pool: null,
        });
      });
    return () => {
      live = false;
    };
    // `pending` is read once per load on purpose; clearing it must not trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateState, rpc, curveRpc, mint, mintStr, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // What the connected wallet holds of this token, for the sell side's balance and
  // Max. Read again after every reload (a trade changes it). An unread balance is a
  // Fact, shown as "could not read", never 0.
  const walletAddress = signerState.kind === 'ready' ? signerState.address : null;
  const [walletHolding, setWalletHolding] = useState<Fact<bigint> | null>(null);
  useEffect(() => {
    if (gateState.status !== 'ready' || !walletAddress) return;
    let live = true;
    let owner: PublicKey;
    try {
      owner = new PublicKey(walletAddress);
    } catch {
      return;
    }
    gateState.api
      .readCreatorHolding(curveRpc, mint, owner)
      .then(holdingFact)
      .catch((e: unknown): Fact<bigint> => ({ kind: 'unreadable', detail: clipDetail(e) }))
      .then((f) => live && setWalletHolding(f));
    return () => {
      live = false;
      setWalletHolding(null);
    };
  }, [gateState, curveRpc, mint, walletAddress, reloadKey]);

  // A trade sent from this browser and not confirmed survives a reload: it is checked
  // against the chain before any trade form for this mint is shown again.
  const checkTrade = useMemo(
    () =>
      gateState.status === 'ready'
        ? (sig: string, lvbh: number | null) =>
            gateState.api.recheckOutcome(connection, sig, lvbh === null ? undefined : { lastValidBlockHeight: lvbh })
        : null,
    [gateState, connection],
  );
  const pendingTrade = usePendingTrades(mintStr, checkTrade, reload);
  const recordTrade = pendingTrade.record;
  const onSettled = useCallback<OnSettled>(
    (outcome, prepared, sentSignature) => {
      recordTrade(outcome, prepared, sentSignature);
      reload();
    },
    [recordTrade, reload],
  );

  // A launch this browser just sent and the chain does not show yet: look again on
  // our own, so the page turns into the launch once it lands without a click. Stops
  // when it appears, or when the note expires (readPendingLaunch's TTL).
  const waitingForLaunch = awaitingOwnLaunch(pending, data?.launch.phase.kind);
  useEffect(() => {
    if (!waitingForLaunch) return;
    const t = setTimeout(() => {
      if (readPendingLaunch(mintStr)) reload();
      else setPending(null);
    }, PENDING_POLL_MS);
    return () => clearTimeout(t);
  }, [waitingForLaunch, data, mintStr, reload]);

  const onRecheckPending = useCallback(async () => {
    if (gateState.status !== 'ready' || !pending) return;
    setRechecking(true);
    try {
      const o = await gateState.api.recheckOutcome(
        connection,
        pending.signature,
        pending.lastValidBlockHeight === null ? undefined : { lastValidBlockHeight: pending.lastValidBlockHeight },
      );
      // Reverted or expired: the launch will never appear. Say so by dropping the note.
      if (o.status === 'reverted' || o.status === 'expired') {
        clearPendingLaunch(mintStr);
        setPending(null);
      }
      setPendingCheckMessage(
        o.status === 'unknown' ? o.message : o.status === 'confirmed' ? 'The network confirmed it. Reading the launch…' : null,
      );
    } catch (e) {
      // A failed check changes nothing we know, and says so.
      setPendingCheckMessage(`Could not check just now (${clipDetail(e)}).`);
    } finally {
      setRechecking(false);
      reload();
    }
  }, [gateState, pending, connection, mintStr, reload]);

  return (
    <SolanaLaunchView
      gateState={gateState}
      mint={mint}
      data={data}
      pending={pending}
      signerState={signerState}
      writeRpc={connection}
      onSettled={onSettled}
      onRecheckPending={() => void onRecheckPending()}
      recheckingPending={rechecking}
      pendingCheckMessage={pendingCheckMessage}
      onReload={reload}
      walletHolding={walletAddress ? walletHolding : undefined}
      pendingTrade={pendingTrade}
    />
  );
}

function parseMint(raw: string | undefined): PublicKey | null {
  if (!raw || !looksLikePubkey(raw)) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

export default function CurveLaunchDetailPage() {
  const { mint: raw } = useParams<{ mint: string }>();
  const mint = useMemo(() => parseMint(raw), [raw]);
  usePageTitle('Solana launch', 'One launch on our own Solana bonding curve, read live from the chain.');
  useEffect(() => {
    trackPageView('curve-launch-mint');
  }, []);

  return (
    <>
      <PageArtBackdrop pageId="curve-launch" />
      <div className="relative z-10 max-w-xl mx-auto px-4 py-8 space-y-4">
        <h1 className="heading-luxury text-[18px] text-white">Memetics Curve launch</h1>
        {mint ? (
          <SolanaProviders>
            {/* Keyed by mint: another address starts clean, with that mint's own notes. */}
            <SolanaLaunchInner key={mint.toBase58()} mint={mint} />
          </SolanaProviders>
        ) : (
          <Card title="Not a token address">
            <p>That is not a Solana token address. Check the link you followed.</p>
            {backLink}
          </Card>
        )}
      </div>
    </>
  );
}
