import { useEffect, useState, type Ref } from 'react';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { LITTLE_MONEY_TEXT, poolTags, type PoolListRead } from '../../../lib/solana/lp/poolList';
import { poolPricePerToken } from '../../../lib/solana/lp/poolHealth';
import { quoteText, tokenText } from '../../../lib/solana/lp/format';
import { pairLabel, registryToken } from '../../../lib/solana/lp/identity';
import { QUOTE_COINS_OR, quoteCoin } from '../../../lib/solana/lp/quotes';
import { Card, Notice } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import type { LpReaders } from './readers';
import { PriceFlip } from './PriceFlip';
import { BUNGALOWS } from '../../../lib/bungalows';
import { useActiveBungalowId } from '../../../hooks/useActiveBungalowId';

/**
 * Every pool on the venue, listed before a token is picked, so nobody has to search one
 * token at a time to see what is here. Each row's View looks its token up in the finder,
 * where the pool's checks and its Add and Remove buttons are. A row's tags are warnings
 * from what the list already read (poolList.ts `poolTags`): nothing is read per row.
 * When there are more pools than the index returns, the list says so and the finder's
 * search finds the rest.
 *
 * A list that could not be read says that, never "no pools". A reader without
 * `listPools` (every component test's fake) renders nothing.
 */
export function VenuePoolList({
  readers,
  reloadKey = 0,
  onView,
  onAdd,
  sectionRef,
}: {
  readers: LpReaders;
  reloadKey?: number;
  onView: (tokenMint: string) => void;
  /** A row's Add (the LP door): that pool's Add form in one press. Left out, rows have View only. */
  onAdd?: (tokenMint: string, pool: string, quoteMint: string) => void;
  /** Set by the section: "Add to another pool" after a withdrawal scrolls here and sends focus here. */
  sectionRef?: Ref<HTMLElement>;
}) {
  const read = usePoolList(readers, reloadKey);
  if (!readers.listPools) return null;
  return (
    <section ref={sectionRef} tabIndex={sectionRef ? -1 : undefined} className="outline-none" data-testid="lp-all-pools" aria-label="All pools">
      <Card title="All pools" art={<CardArt pageId="solana-lp" idx={13} />}>
        {read === null ? (
          <p className="text-white/70 text-[13px]">Reading the pools from the chain…</p>
        ) : read.kind === 'unread' ? (
          <>
            <Notice tone="warn">The list of pools could not be read just now. That does not mean there are none: search a token above.</Notice>
            <FinePrint summary="Why">
              <p>{read.detail}</p>
            </FinePrint>
          </>
        ) : (
          <PoolRows list={read.list} onView={onView} onAdd={onAdd} />
        )}
        <FinePrint summary="How this list works">
          <p>
            Our pool index names every pool paired with {QUOTE_COINS_OR}, and each one is then read and checked on chain. SOL pools come
            first, then USDC, then BAYLA, the deepest of each first. Past what the list can hold it shows the deepest, and a search finds the
            rest.
          </p>
          <p>Anyone can open a pool, at any price. View one to see its checks before adding to it.</p>
          <p>
            The tags on a row come from what the list read. Trading off, Adding off and Removing off: the pool has that switched off. Frozen:
            a coin’s issuer froze one of the pool’s accounts, so nothing moves in or out. Trading not open yet: its trading starts later,
            maybe years from now. Little money in pool: it holds {LITTLE_MONEY_TEXT} (a pool priced in BAYLA never gets this tag). No
            trades yet, and No trades in 7 days: from the pool’s own trade record. Anything not read gives no tag, and a row with no tag is
            not a pool that passed: its price is checked only when you View it.
          </p>
        </FinePrint>
      </Card>
    </section>
  );
}

function PoolRows({
  list,
  onView,
  onAdd,
}: {
  list: Extract<PoolListRead, { kind: 'ok' }>['list'];
  onView: (tokenMint: string) => void;
  onAdd?: (tokenMint: string, pool: string, quoteMint: string) => void;
}) {
  const { pools: listed, unread, truncated, chainNow } = list;
  // A reader in a Solana room sees that coin's pools first (the LP door, island answer twenty); the rest keep the list's order.
  const roomId = useActiveBungalowId();
  const roomMint = BUNGALOWS.find((b) => b.id === roomId && b.chain === 'solana')?.address ?? null;
  const pools = roomMint ? [...listed.filter((v) => v.tokenMint === roomMint), ...listed.filter((v) => v.tokenMint !== roomMint)] : listed;
  return (
    <div className="space-y-3">
      {pools.length === 0 && unread === 0 && !truncated && <p data-testid="lp-all-pools-none">No pools yet.</p>}
      {pools.length > 0 && (
        <ul className="space-y-2" aria-label="All pools: SOL pools first, then USDC, then BAYLA, the deepest of each first">
          {pools.map((view) => (
            <PoolRow key={view.address} view={view} chainNow={chainNow} onView={onView} onAdd={onAdd} />
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

function PoolRow({ view, chainNow, onView, onAdd }: { view: PoolView; chainNow: bigint | null; onView: (tokenMint: string) => void; onAdd?: (tokenMint: string, pool: string, quoteMint: string) => void }) {
  const { pool } = view.snapshot;
  const tokenDecimals = view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals;
  // Named only by an address this site knows: a room's token, or a pairing coin (USDC in USDC / SOL).
  const symbol = registryToken(view.tokenMint)?.symbol ?? quoteCoin(view.tokenMint)?.symbol ?? null;
  const price = poolPricePerToken(view.snapshot, view.tokenMint, tokenDecimals);
  const label = pairLabel(view);
  const tags = poolTags(view, chainNow);
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
        <p className="text-white/75 text-[12.5px] [overflow-wrap:anywhere]">
          {price === null ? 'No price: one side is empty' : <PriceFlip perToken={price} quote={view.quote} unit={symbol ? { one: symbol, many: symbol } : { one: 'token', many: 'tokens' }} />}
        </p>
        {tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 pt-1" aria-label={`${label}: warnings`}>
            {tags.map((t) => (
              <li
                key={t.text}
                data-testid="lp-all-pools-tag"
                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                  t.tone === 'bad' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                }`}
              >
                {t.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        {onAdd && (
          <button type="button" className="btn-primary min-h-[44px] px-4 text-[13px]" aria-label={`Add to ${label}`} onClick={() => onAdd(view.tokenMint, view.address, view.quote.mint)}>
            Add
          </button>
        )}
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" aria-label={`View ${label}`} onClick={() => onView(view.tokenMint)}>
          View
        </button>
      </div>
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
