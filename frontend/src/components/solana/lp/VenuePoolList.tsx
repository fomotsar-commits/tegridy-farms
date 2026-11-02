import type { Ref } from 'react';
import { Link } from 'react-router-dom';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { LITTLE_MONEY_TEXT, byWorth, marketGap, pairSwapLink, poolTags, poolWorthUsd, tokenDecimalsOf, type MarketPrices, type PoolListRead } from '../../../lib/solana/lp/poolList';
import { PRICE_TOLERANCE, poolPricePerToken } from '../../../lib/solana/lp/poolHealth';
import { quoteText, tokenText, turnedDiff, usdText } from '../../../lib/solana/lp/format';
import { pairLabel, siteNamed, tokenTicker } from '../../../lib/solana/lp/identity';
import { QUOTE_COINS_OR } from '../../../lib/solana/lp/quotes';
import { Card, Notice } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import type { LpReaders } from './readers';
import { useLivePoolList } from './usePoolList';
import { useMarketPrices } from './useMarketPrices';
import { ArbitrageBoard } from './ArbitrageBoard';
import { PriceFlip } from './PriceFlip';
import { usePriceSide } from './priceSide';

/**
 * Every pool on the venue, listed before a token is picked, so nobody has to search one
 * token at a time to see what is here. Each row's View looks its token up in the finder,
 * where the pool's checks and its Add and Remove buttons are; its Add opens that pool's
 * form; its Swap opens the swap page on that pair. A row's tags are warnings from what
 * the list already read (poolList.ts `poolTags`), and one Jupiter price read for the
 * whole list (`readMarketPrices`) gives each pool's dollars and the price tags: nothing
 * is read per row. The same two reads feed the Arbitrage card above the list
 * (ArbitrageBoard.tsx), and both are read again by themselves while the tab is in view
 * (usePoolList.ts `useLivePoolList`).
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
  /** A row's Add (the LP door): that pool's Add form in one press. Left out, rows have Swap and View only. */
  onAdd?: (tokenMint: string, pool: string, quoteMint: string) => void;
  /** Set by the section: "Add to another pool" after a withdrawal scrolls here and sends focus here. */
  sectionRef?: Ref<HTMLElement>;
}) {
  const live = useLivePoolList(readers, reloadKey);
  const read = live.read;
  const market = useMarketPrices(readers, read?.kind === 'ok' ? read.list.pools : null);
  if (!readers.listPools) return null;
  return (
    <>
      <ArbitrageBoard live={live} prices={market} legQuote={readers.legQuote} />
      <section ref={sectionRef} tabIndex={sectionRef ? -1 : undefined} className="outline-none" data-testid="lp-all-pools" aria-label="All pools">
        <Card title="All pools" art={<CardArt pageId="solana-lp" idx={13} />}>
          {read === null ? (
            <p className="text-white/70 text-[13px]">Reading the pools from the chain…</p>
          ) : read.kind === 'unread' ? (
            <>
              <Notice tone="warn">Not read just now. That does not mean there are none: search a token above.</Notice>
              <FinePrint summary="Why">
                <p>{read.detail}</p>
              </FinePrint>
            </>
          ) : (
            <PoolRows list={read.list} prices={market.prices} onView={onView} onAdd={onAdd} />
          )}
          <FinePrint summary="How this list works">
            <p>
              Our pool index names every pool paired with {QUOTE_COINS_OR}, and each one is then read and checked on chain. Past what the
              list can hold it shows the deepest, and a search finds the rest. The dollars beside a pair are what the pool holds at
              Jupiter’s listed prices, the read the Arbitrage card above is stamped with; a coin Jupiter does not price gets none.
            </p>
            <p>
              The pools with the most money in come first. A pool priced over {PRICE_TOLERANCE * 100}% below Jupiter is ranked by its{' '}
              {QUOTE_COINS_OR} side, since anyone can print more of their own coin, and a coin Jupiter does not price is counted at the
              pool’s own price. Until Jupiter’s prices are read, SOL pools come first, then USDC, then BAYLA, the deepest of each first.
            </p>
            <p>Anyone can open a pool, at any price. View one to see its checks before adding to it. Swap opens the swap page on the pair.</p>
            <p>
              A coin that is not one of ours shows the ticker it gives itself, with its whole address under it. Anyone can give a coin
              any ticker: one that copies the ticker of one of ours, or of SOL, USDC or USDT, reads “fake”. Only the address says which
              coin it is.
            </p>
            <p>
              The tags on a row come from what the list read. Trading off, Adding off and Removing off: the pool has that switched off. Frozen:
              a coin’s issuer froze one of the pool’s accounts, so nothing moves in or out. Price over {PRICE_TOLERANCE * 100}% above or
              below Jupiter: the pool’s price is that far from Jupiter’s market price, read once for the whole list. Adding at that price
              loses part of the deposit to the first trade that closes the gap. The pool’s card checks again with live quotes and gives
              the exact gap, which can differ by a few points on a thinly traded coin; what that trade makes, and for whom, is on the
              Arbitrage card above. Trading not open yet: its trading starts later,
              maybe years from now. Little money in pool: it holds {LITTLE_MONEY_TEXT} (a pool priced in BAYLA never gets this tag). No
              trades yet, and No trades in 7 days: from the pool’s own trade record. Anything not read gives no tag, and a row with no tag is
              not a pool that passed: its full price check is on its card, when you View it.
            </p>
          </FinePrint>
        </Card>
      </section>
    </>
  );
}

function PoolRows({
  list,
  prices,
  onView,
  onAdd,
}: {
  list: Extract<PoolListRead, { kind: 'ok' }>['list'];
  prices: MarketPrices | null;
  onView: (tokenMint: string) => void;
  onAdd?: (tokenMint: string, pool: string, quoteMint: string) => void;
}) {
  const { pools: read, unread, truncated, chainNow, safety } = list;
  const usd = prices?.kind === 'ok' ? prices.usd : null;
  // Most money in first once Jupiter's prices are read (poolList.ts `byWorth`); until then, the order read. In every room
  // alike: the room's own coin is no longer pinned on top (owner, 2026-11-01: "Pure TVL order", over island answer twenty).
  const pools = usd ? byWorth(read, usd) : read;
  return (
    <div className="space-y-3">
      {pools.length === 0 && unread === 0 && !truncated && <p data-testid="lp-all-pools-none">No pools yet.</p>}
      {pools.length > 0 && (
        <ul className="space-y-2" aria-label={usd ? 'All pools: the most money in first' : 'All pools: SOL pools first, then USDC, then BAYLA, the deepest of each first'}>
          {pools.map((view) => (
            <PoolRow
              key={view.address}
              view={view}
              safety={safety.get(view.tokenMint) ?? null}
              chainNow={chainNow}
              usd={usd}
              onView={onView}
              onAdd={onAdd}
            />
          ))}
        </ul>
      )}
      {/* No price tag on any row would otherwise read as every price agreeing. */}
      {pools.length > 0 && prices?.kind === 'unread' && (
        <p data-testid="lp-all-pools-prices-unread" className="text-amber-300/90 text-[12.5px]">
          Jupiter’s prices could not be read just now, so no row is marked for a price gap.
        </p>
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

function PoolRow({
  view,
  safety,
  chainNow,
  usd,
  onView,
  onAdd,
}: {
  view: PoolView;
  safety: TokenSafety | null;
  chainNow: bigint | null;
  /** Jupiter's prices for the list, or null while unread. */
  usd: ReadonlyMap<string, number> | null;
  onView: (tokenMint: string) => void;
  onAdd?: (tokenMint: string, pool: string, quoteMint: string) => void;
}) {
  const side = usePriceSide();
  const tokenDecimals = tokenDecimalsOf(view);
  // Our coins and the pairing coins by the site's own name; any other coin by its own ticker (identity.ts).
  const symbol = tokenTicker(view.tokenMint, safety);
  const price = poolPricePerToken(view.snapshot, view.tokenMint, tokenDecimals);
  const label = pairLabel(view, safety);
  // The gap is said the way round the row's price is (PriceFlip), as the pool's card says it.
  const gap = usd ? marketGap(view, usd) : null;
  const tags = poolTags(view, chainNow, gap !== null && side === 'coin' ? turnedDiff(gap) : gap);
  // What the pool holds in dollars, at Jupiter's listed prices: only when both coins have one, never $0.
  const worth = usd ? poolWorthUsd(view, usd) : null;
  return (
    <li
      data-testid="lp-all-pools-row"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg px-3 py-2.5"
      style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      {/* On a phone the text takes the whole width and the buttons wrap below it; beside them it was squeezed to half. */}
      <div className="min-w-0 grow basis-full space-y-0.5 sm:basis-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="text-white font-semibold text-[14px]">{label}</p>
          {worth !== null && (
            <span data-testid="lp-all-pools-worth" className="ml-auto text-white/85 text-[13px] font-semibold tabular-nums" title="In the pool, at Jupiter’s listed prices">
              {usdText(worth)}
            </span>
          )}
        </div>
        {/* Any other coin's ticker is its own claim, and a short address can be ground to collide: the whole address is said too. */}
        {!siteNamed(view.tokenMint) && <p className="font-mono text-white/55 text-[11px] break-all">{view.tokenMint}</p>}
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
      {/* `relative`: painted above the price flip's press area, which reaches 14px below its line. */}
      <div className="relative flex gap-2">
        {onAdd && (
          <button type="button" className="btn-primary min-h-[44px] px-4 text-[13px]" aria-label={`Add to ${label}`} onClick={() => onAdd(view.tokenMint, view.address, view.quote.mint)}>
            Add
          </button>
        )}
        {/* The pair on the swap page, paying with the pool's coin to buy its token (owner, 2026-10-30: "go to that pair and swap"). */}
        <Link to={pairSwapLink(view)} className="btn-secondary min-h-[44px] px-4 text-[13px] inline-flex items-center" data-testid="lp-all-pools-swap" aria-label={`Swap ${label}`}>
          Swap
        </Link>
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" aria-label={`View ${label}`} onClick={() => onView(view.tokenMint)}>
          View
        </button>
      </div>
    </li>
  );
}
