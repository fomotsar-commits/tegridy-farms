import { useEffect, useState } from 'react';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import { poolSolPerToken } from '../../../lib/solana/lp/poolHealth';
import { formatSolPrice, shortAddress, solText, tokenText, tradeCostText } from '../../../lib/solana/lp/format';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { usdOfPool, usdText } from '../../../lib/solana/lp/usd';
import { Card, Notice, Row } from '../curve/ui';
import type { LpReaders } from './readers';

/**
 * The pools a visitor can see before typing anything: every TOKEN/SOL pool on the venue,
 * deepest SOL side first, each read and checked on chain. "Open this pool" puts its token
 * in the finder, which then shows the pool's full card with its checks and its Add button.
 *
 * It is a list, not a verdict: the token checks and the price check that gate a deposit
 * run in the finder, on fresh reads. Nothing here is trusted from the index alone.
 */

/** Null until the first answer; a re-read keeps the last answer on screen until the new one lands. */
type Answer = { read: PoolListRead; safety: Map<string, TokenSafety> } | null;

const ORIGIN_WORD: Record<PoolView['origin'], string> = { 'launch-pool': 'launch pool', standard: 'standard address', other: 'other address' };
const VERDICT_WORD = { ok: 'no problems found', warn: 'warnings: see its card', blocked: 'blocked' } as const;
const ROW_STYLE = { background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)' } as const;

const count = (n: number, one: string, many: string) => (n === 1 ? `One ${one}` : `${n} ${many}`);

export function VenuePoolList({
  readers,
  reloadKey,
  usdPerSol,
  onPick,
}: {
  readers: LpReaders;
  reloadKey: number;
  /** Jupiter's SOL price, or null when it is not known: no dollar line then. */
  usdPerSol: number | null;
  /** A pool was chosen: open the finder on its token. */
  onPick: (mint: string) => void;
}) {
  const list = readers.listPools;
  const [answer, setAnswer] = useState<Answer>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!list) return;
    let live = true;
    (async () => {
      const read = await list();
      const mints = read.kind === 'ok' ? [...new Set(read.list.pools.map((p) => p.tokenMint))] : [];
      let safety = new Map<string, TokenSafety>();
      if (mints.length) {
        try {
          safety = await readers.safety(mints);
        } catch {
          safety = new Map();
        }
      }
      if (live) setAnswer({ read, safety });
    })().catch((e: unknown) => {
      if (live) setAnswer({ read: { kind: 'unread', detail: e instanceof Error ? e.message : String(e) }, safety: new Map() });
    });
    return () => {
      live = false;
    };
  }, [list, readers, reloadKey, nonce]);
  if (!list) return null;
  const state = answer === null ? ({ status: 'reading' } as const) : ({ status: 'done', ...answer } as const);

  const again = (
    <button type="button" className="btn-secondary min-h-[44px] px-4 text-[12px]" onClick={() => setNonce((n) => n + 1)}>
      Read again
    </button>
  );

  return (
    <Card title="Pools on the venue" testId="lp-venue-pools">
      {state.status === 'reading' && (
        <p role="status" data-testid="lp-venue-reading">
          Reading the venue’s pools…
        </p>
      )}
      {state.status === 'done' && state.read.kind === 'unread' && (
        <div className="space-y-2" data-testid="lp-venue-unread">
          <Notice tone="warn">The venue’s pools could not be listed ({state.read.detail}). That says nothing about how many there are.</Notice>
          {again}
        </div>
      )}
      {state.status === 'done' && state.read.kind === 'ok' && (
        <>
          {state.read.list.pools.length === 0 ? (
            <p data-testid="lp-venue-empty">No pool is open on the venue yet. Create a pool, above, opens the first one.</p>
          ) : (
            <ul className="space-y-2" data-testid="lp-venue-list">
              {state.read.list.pools.map((v) => (
                <PoolRow key={v.address} view={v} safety={state.safety.get(v.tokenMint) ?? null} usdPerSol={usdPerSol} onPick={onPick} />
              ))}
            </ul>
          )}
          <Footnotes list={state.read.list} />
          <div className="flex flex-wrap items-center gap-2">
            {again}
            <p className="text-white/40 text-[10px] leading-relaxed min-w-0 flex-1">
              Listed from our pool index, then each pool read and checked on chain, deepest SOL side first. The index can leave a
              pool out; it cannot add one that is not on chain.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}

function PoolRow({ view, safety, usdPerSol, onPick }: { view: PoolView; safety: TokenSafety | null; usdPerSol: number | null; onPick: (mint: string) => void }) {
  const decimals = safety?.kind === 'read' ? safety.facts?.decimals ?? null : null;
  const named = safety?.kind === 'read' && (safety.name || safety.symbol) ? `${displaySafe(safety.name ?? '', 32)} (${displaySafe(safety.symbol ?? '', 12)})` : null;
  const price = decimals === null ? null : poolSolPerToken(view.snapshot, view.tokenMint, decimals);
  const liquidity = usdText(usdOfPool(view.solReserve, usdPerSol));
  const cfg = view.config;
  return (
    <li className="rounded-lg p-3 space-y-1.5" style={ROW_STYLE} data-testid="lp-venue-pool" data-pool={view.address} data-mint={view.tokenMint}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-white text-[12px] font-semibold [overflow-wrap:anywhere]">{named ?? shortAddress(view.tokenMint)}</span>
        <span className="text-white/45 text-[10px]">{ORIGIN_WORD[view.origin]}</span>
      </div>
      <Row label="Token" value={view.tokenMint} />
      <Row
        label="Token check"
        value={!safety ? 'not read' : safety.kind === 'read' ? VERDICT_WORD[safety.verdict] : safety.kind === 'absent' ? 'not a token' : 'not read'}
        mono={false}
      />
      <Row label="In the pool" value={`${solText(view.solReserve)} and ${tokenText(view.tokenReserve, decimals)}`} mono={false} />
      {liquidity && <Row label="Liquidity" value={`${liquidity} (twice the SOL side, at Jupiter’s SOL price)`} mono={false} />}
      <Row label="Price here" value={price === null ? 'not worked out' : `1 token = ${formatSolPrice(price)} SOL`} mono={false} />
      <Row
        label={cfg ? `Fee tier ${cfg.index}` : 'Fee tier'}
        value={cfg ? `Traders pay ${tradeCostText(cfg, view.snapshot.pool.enableCreatorFee)}` : 'not read'}
        mono={false}
      />
      <button type="button" className="btn-secondary w-full min-h-[44px] text-[12px]" onClick={() => onPick(view.tokenMint)}>
        Open this pool
      </button>
    </li>
  );
}

function Footnotes({ list }: { list: Extract<PoolListRead, { kind: 'ok' }>['list'] }) {
  const notes: string[] = [];
  if (list.unread > 0) notes.push(`${count(list.unread, 'pool the index named', 'pools the index named')} could not be read this time.`);
  if (list.otherPairs > 0) {
    notes.push(`${count(list.otherPairs, 'pool is', 'pools are')} not a token against SOL. This site does not show those pools yet.`);
  }
  if (list.truncated) notes.push('The index holds more pools than it lists; only the deepest are here.');
  if (!notes.length) return null;
  return (
    <div className="text-white/55 text-[11px] leading-relaxed space-y-1" data-testid="lp-venue-notes">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}
