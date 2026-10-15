import { useEffect, useState } from 'react';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import { poolPricePerToken } from '../../../lib/solana/lp/poolHealth';
import { priceText, quoteText, tokenText } from '../../../lib/solana/lp/format';
import { pairLabel, registryToken } from '../../../lib/solana/lp/identity';
import { QUOTE_COINS_OR, quoteCoin } from '../../../lib/solana/lp/quotes';
import { Card, Notice } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import type { LpReaders } from './readers';

/**
 * Every pool on the venue, listed before a token is picked, so nobody has to search one
 * token at a time to see what is here. Each row's View looks its token up in the finder,
 * where the pool's checks and its Add and Remove buttons are. When there are more pools
 * than the index returns, the list says so and the finder's search finds the rest.
 *
 * A list that could not be read says that, never "no pools". A reader without
 * `listPools` (every component test's fake) renders nothing.
 */
export function VenuePoolList({ readers, reloadKey = 0, onView }: { readers: LpReaders; reloadKey?: number; onView: (tokenMint: string) => void }) {
  const read = usePoolList(readers, reloadKey);
  if (!readers.listPools) return null;
  return (
    <section data-testid="lp-all-pools" aria-label="All pools">
      <Card title="All pools" art={<CardArt pageId="solana-lp" idx={13} />}>
        {read === null ? (
          <p className="text-white/70 text-[13px]">Reading the pools from the chain…</p>
        ) : read.kind === 'unread' ? (
          <Notice tone="warn">The list of pools could not be read just now ({read.detail}). That does not mean there are none: search a token above.</Notice>
        ) : (
          <PoolRows list={read.list} onView={onView} />
        )}
        <FinePrint summary="How this list works">
          <p>
            Our pool index names every pool paired with {QUOTE_COINS_OR}, and each one is then read and checked on chain. SOL pools come
            first, then USDC, then BAYLA, the deepest of each first. Past what the list can hold it shows the deepest, and a search finds the
            rest.
          </p>
          <p>Anyone can open a pool, at any price. View one to see its checks before adding to it.</p>
        </FinePrint>
      </Card>
    </section>
  );
}

function PoolRows({ list, onView }: { list: Extract<PoolListRead, { kind: 'ok' }>['list']; onView: (tokenMint: string) => void }) {
  const { pools, unread, truncated } = list;
  return (
    <div className="space-y-3">
      {pools.length === 0 && unread === 0 && !truncated && <p data-testid="lp-all-pools-none">No pools yet.</p>}
      {pools.length > 0 && (
        <ul className="space-y-2" aria-label="All pools: SOL pools first, then USDC, then BAYLA, the deepest of each first">
          {pools.map((view) => (
            <PoolRow key={view.address} view={view} onView={onView} />
          ))}
        </ul>
      )}
      {unread > 0 && <Notice tone="warn">{unread === 1 ? 'One more pool' : `${unread} more pools`} could not be read just now.</Notice>}
      {truncated && (
        <p data-testid="lp-all-pools-truncated" className="text-amber-300/90 text-[12.5px]">
          There are more pools than this list holds. Search a token above to find the rest.
        </p>
      )}
    </div>
  );
}

function PoolRow({ view, onView }: { view: PoolView; onView: (tokenMint: string) => void }) {
  const { pool } = view.snapshot;
  const tokenDecimals = view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals;
  // Named only by an address this site knows: a room's token, or a pairing coin (USDC in USDC / SOL).
  const symbol = registryToken(view.tokenMint)?.symbol ?? quoteCoin(view.tokenMint)?.symbol ?? null;
  const price = poolPricePerToken(view.snapshot, view.tokenMint, tokenDecimals);
  const label = pairLabel(view);
  return (
    <li
      data-testid="lp-all-pools-row"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg px-3 py-2.5"
      style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-white font-semibold text-[14px]">{label}</p>
        {/* Any other token is headed by its short address, which can be ground to collide: the whole one is said too. */}
        {symbol === null && <p className="font-mono text-white/55 text-[11px] break-all">{view.tokenMint}</p>}
        <p className="text-white/75 text-[12.5px] [overflow-wrap:anywhere]">
          Holds {quoteText(view.quoteReserve, view.quote)} and {tokenText(view.tokenReserve, tokenDecimals, symbol ?? 'tokens')}
        </p>
        <p className="text-white/75 text-[12.5px] [overflow-wrap:anywhere]">{price === null ? 'No price: one side is empty' : priceText(price, view.quote, symbol ?? 'token')}</p>
      </div>
      <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" aria-label={`View ${label}`} onClick={() => onView(view.tokenMint)}>
        View
      </button>
    </li>
  );
}

/**
 * The list, read on mount and again whenever `reloadKey` moves (a liquidity flow
 * finished). A re-read keeps the last answer on screen until the new one arrives; null
 * only before the first answer.
 */
function usePoolList(readers: LpReaders, reloadKey: number): PoolListRead | null {
  const [read, setRead] = useState<PoolListRead | null>(null);
  useEffect(() => {
    if (!readers.listPools) return;
    let live = true;
    readers.listPools().then(
      (r) => live && setRead(r),
      (e: unknown) => live && setRead({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [readers, reloadKey]);
  return read;
}
