import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PublicKey } from '@solana/web3.js';
import {
  clipDetail,
  curveProgress,
  formatSol,
  readMint,
  type BondingCurve,
  type CurveRpc,
  type MintFacts,
  type Read,
  type SolanaRpc,
} from '../../../lib/launcher/solana/curve';
import { Card, Notice } from './ui';
import { TOGGLE_CLS, sharePercent } from './uiFormat';
import { CreatorStakeFacts, LaunchImage } from './LaunchIdentity';
import { identityWarnings, safeImageUrl } from './identity';
import { holdingFact, openingBuyFact, type Fact } from './facts';
import type { CurveWriteConfig, LaunchListItem, LaunchListPage, MetadataRead, WriteApi } from './ports';

/**
 * The platform reserve, as the launch's own account records it. The program pays it
 * to the treasury inside create_launch and marks the curve paid there, so a launch
 * it created reads "already paid"; anything else is said as exactly what it records.
 */
function ReserveLine({ curve, supply }: { curve: BondingCurve; supply: bigint | null }) {
  if (curve.platformReserveTokens === 0n) return null;
  const share = supply !== null ? sharePercent(curve.platformReserveTokens, supply) : null;
  const what = share ? `${share} of the supply` : 'part of the supply';
  return (
    <p className="text-white/55 text-[10px]">
      {curve.platformReserveReleased
        ? `Platform reserve (${what}): already paid to the platform treasury when the token was created.`
        : `Platform reserve (${what}): this launch's account does not record it as paid.`}
    </p>
  );
}

/** Calls to the list reader per view. Each call already looks at a bounded number of entries. */
const MAX_LOADS = 3;

type View = 'recent' | 'mine';

type ListState =
  | { status: 'loading'; items: LaunchListItem[]; scanned: number; loads: number }
  | { status: 'ok'; items: LaunchListItem[]; before: string | null; scanned: number; loads: number }
  | { status: 'unreadable'; items: LaunchListItem[]; detail: string; scanned: number; loads: number };

/**
 * Recent launches, read from the chain only. Anyone can make a launch appear in the
 * recent list, including a copy of a known coin, so the list says so, and every row
 * carries its own warnings and the creator's stake. "Yours" lists the connected
 * wallet's own launches from that wallet's history, which nobody else can add to.
 */
export function LaunchList({
  api,
  cfg,
  rpc,
  curveRpc,
  wallet,
}: {
  api: WriteApi;
  cfg: CurveWriteConfig;
  rpc: SolanaRpc;
  curveRpc: CurveRpc;
  /** The connected wallet, for the "Yours" view. */
  wallet: PublicKey | null;
}) {
  const [view, setView] = useState<View>('recent');
  const [state, setState] = useState<ListState>({ status: 'loading', items: [], scanned: 0, loads: 0 });
  const generation = useRef(0);

  const load = useCallback(
    async (v: View, before: string | undefined, prev: { items: LaunchListItem[]; scanned: number; loads: number }) => {
      const gen = ++generation.current;
      setState({ status: 'loading', items: prev.items, scanned: prev.scanned, loads: prev.loads });
      let r: Read<LaunchListPage>;
      try {
        r =
          v === 'mine' && wallet
            ? await api.listLaunchesByCreator(rpc, cfg, wallet, before ? { before } : {})
            : await api.listRecentLaunches(rpc, cfg, before ? { before } : {});
      } catch (e) {
        r = { kind: 'unreadable', detail: clipDetail(e) };
      }
      if (gen !== generation.current) return;
      const loads = prev.loads + 1;
      if (r.kind !== 'ok') {
        const detail = r.kind === 'unreadable' ? r.detail : 'the list did not decode';
        setState({ status: 'unreadable', items: prev.items, detail, scanned: prev.scanned, loads });
        return;
      }
      const seen = new Set(prev.items.map((i) => i.mint.toBase58()));
      const fresh = r.value.items.filter((i) => !seen.has(i.mint.toBase58()));
      setState({
        status: 'ok',
        items: [...prev.items, ...fresh],
        before: r.value.before,
        scanned: prev.scanned + r.value.scanned,
        loads,
      });
    },
    [api, rpc, cfg, wallet],
  );

  useEffect(() => {
    void load(view, undefined, { items: [], scanned: 0, loads: 0 });
  }, [load, view]);

  const items = state.items;
  return (
    <Card title="Launches" testId="launch-list">
      <div className="flex gap-1.5" role="group" aria-label="Which launches">
        {(
          [
            ['recent', 'Recent'],
            ['mine', 'Yours'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            aria-pressed={view === v}
            disabled={v === 'mine' && !wallet}
            className={`${TOGGLE_CLS} disabled:opacity-50`}
            style={{
              background: view === v ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
              border: view === v ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'recent' ? (
        <p>
          Recent launches. Listed automatically from the network. Anyone can appear here, and we have not checked any of
          them. Always compare the full token address before you buy.
        </p>
      ) : (
        <p>Launches your connected wallet created, read from its own history.</p>
      )}
      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((i) => (
            <LaunchRow key={i.mint.toBase58()} api={api} rpc={rpc} curveRpc={curveRpc} item={i} />
          ))}
        </ul>
      )}
      {state.status === 'loading' && <Notice>Reading launches…</Notice>}
      {state.status === 'unreadable' && (
        <Notice tone="warn">
          The list could not be read right now ({state.detail}). This says nothing about any launch. Any launch still
          opens by its address.
        </Notice>
      )}
      {state.status === 'ok' && items.length === 0 && (
        <Notice>
          {state.scanned === 0
            ? view === 'mine'
              ? 'No launches from this wallet yet.'
              : 'No launches yet.'
            : `No launches in the most recent ${state.scanned.toLocaleString('en-US')} transactions we checked.`}
        </Notice>
      )}
      {((state.status === 'ok' && state.before && state.loads < MAX_LOADS) ||
        (state.status === 'loading' && state.loads > 0)) && (
        // Stays on screen (and focused) while the next page loads: removing it would
        // drop keyboard focus to the page. It does nothing until the page is in.
        <button
          type="button"
          className={`btn-secondary w-full py-2 text-[12px] ${state.status === 'loading' ? 'opacity-60' : ''}`}
          aria-disabled={state.status === 'loading' || undefined}
          onClick={() => {
            if (state.status === 'ok') void load(view, state.before ?? undefined, state);
          }}
        >
          Show more
        </button>
      )}
      {state.status === 'ok' && state.before && state.loads >= MAX_LOADS && (
        <p className="text-white/40 text-[10px]">Older launches are not listed here. Open them by their address.</p>
      )}
    </Card>
  );
}

function LaunchRow({
  api,
  rpc,
  curveRpc,
  item,
}: {
  api: WriteApi;
  rpc: SolanaRpc;
  curveRpc: CurveRpc;
  item: LaunchListItem;
}) {
  const meta = api.meta;
  const mint = item.mint.toBase58();
  const [json, setJson] = useState<MetadataRead | null>(null);
  const [mintFacts, setMintFacts] = useState<Read<MintFacts> | null>(null);
  const [holding, setHolding] = useState<Fact<bigint> | null>(null);

  useEffect(() => {
    let live = true;
    if (item.metadata.kind === 'ok') {
      meta
        .readLaunchMetadataJson(item.metadata.value.uri, mint)
        .then((r) => live && setJson(r))
        .catch((e: unknown) => live && setJson({ kind: 'unreadable', detail: clipDetail(e) }));
    }
    readMint(rpc, mint).then((r) => live && setMintFacts(r));
    api
      .readCreatorHolding(curveRpc, item.mint, item.creator)
      .then((r) => live && setHolding(holdingFact(r)))
      .catch((e: unknown) => live && setHolding({ kind: 'unreadable', detail: clipDetail(e) }));
    return () => {
      live = false;
    };
  }, [api, meta, rpc, curveRpc, item, mint]);

  const md = item.metadata.kind === 'ok' ? item.metadata.value : null;
  const warnings = identityWarnings(meta, item.metadata, json);
  const progress = item.curve.kind === 'ok' ? curveProgress(item.curve.value.curve) : null;
  const facts = mintFacts?.kind === 'ok' ? mintFacts.value : null;

  return (
    <li className="rounded-xl p-3 space-y-1.5" style={{ border: '1px solid rgba(255,255,255,0.1)' }} data-testid="launch-row">
      <Link to={`/curve-launch/${mint}`} className="flex items-center gap-3 min-w-0">
        <LaunchImage src={safeImageUrl(meta, json)} size={44} />
        <span className="min-w-0">
          <span className="block text-white font-medium break-words">
            {md
              ? meta.displaySafe(md.name, 32) || 'No name'
              : item.metadata.kind === 'absent'
                ? 'No name (made outside this site)'
                : 'Name could not be read'}
          </span>
          {md && <span className="block text-white/60 font-mono text-[10px] break-all">{meta.displaySafe(md.symbol, 10)}</span>}
        </span>
      </Link>
      <p className="font-mono text-white/50 text-[10px] break-all">{mint}</p>
      {warnings.map((w) => (
        <p key={w} className="text-amber-300/90 text-[10px]">
          {w}
        </p>
      ))}
      <p className="text-white/70">
        {item.curve.kind !== 'ok'
          ? 'Progress: could not read'
          : item.curve.value.curve.complete
            ? 'Graduated to its pool'
            : progress?.progressBps == null
              ? 'Progress: could not compute'
              : `Raised ${formatSol(item.curve.value.curve.realSolReserves)} SOL, ${(progress.progressBps / 100).toFixed(2)}% of the way to graduation`}
      </p>
      {item.curve.kind === 'ok' && <ReserveLine curve={item.curve.value.curve} supply={facts ? facts.supply : null} />}
      <CreatorStakeFacts
        openingBuy={openingBuyFact(item.openingBuyTokens)}
        holding={holding}
        supply={facts ? facts.supply : null}
        decimals={facts ? facts.decimals : null}
      />
    </li>
  );
}
