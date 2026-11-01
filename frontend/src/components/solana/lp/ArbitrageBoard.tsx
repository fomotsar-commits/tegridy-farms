import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rankArbitrage, swapLink, tokenDecimalsOf, unsizedPools, type Opportunity } from '../../../lib/solana/lp/poolList';
import { agoText, quoteText, tokenText, usdText } from '../../../lib/solana/lp/format';
import { pairLabel, siteNamed, tokenTicker } from '../../../lib/solana/lp/identity';
import { pausedText } from '../../../lib/solana/lp/rpcBudget';
import { Card, Notice, Row } from '../curve/ui';
import { TEXT_PRESS } from '../curve/uiFormat';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import { PriceFlip } from './PriceFlip';
import { READ_AGAIN_AFTER_MS, STALE_MS, type LivePoolList } from './usePoolList';
import type { MarketPricesState } from './useMarketPrices';

/**
 * Every paying gap on the venue, ranked by what one trade makes, from the one list read
 * and the one Jupiter price read All pools already makes (poolList.ts `rankArbitrage`).
 * Each row is the trade in the trader's own units: what to pay, what comes back, the
 * profit after the pool's fee (and the token's), where the fee goes, the pool's price
 * after, and one press that opens the swap page on that trade with the amount filled in.
 * The figures say when they were read; they are read again every half minute while the
 * tab is in view, and a read that fails keeps them and says their age (usePoolList.ts,
 * useMarketPrices.ts). What could not be sized is said, never folded into "None".
 *
 * A gap is said as a figure here, with its basis on the stamp line: Jupiter's LISTED price
 * (its price feed, read once for the list), not the two live quotes a pool's card asks for,
 * which can differ by points on a thin coin. The row tag in All pools keeps naming no
 * figure for that reason; the swap page quotes the trade again before anything is sent.
 */
export function ArbitrageBoard({ live, prices }: { live: LivePoolList; prices: MarketPricesState }) {
  const now = useNow(5_000);
  const { read, readAt, failed, reading, again, paused } = live;
  const age = readAt === null ? null : Math.max(0, now - readAt);
  const list = read?.kind === 'ok' ? read.list : null;
  const usd = prices.prices?.kind === 'ok' ? prices.prices.usd : null;
  const ranked = list && usd ? rankArbitrage(list, usd) : null;
  const unsized = list ? unsizedPools(list) : null;
  const stale = age !== null && age >= STALE_MS;
  // Read again is held after an answer (the caches are 30 s) and while a read is on its way. It is
  // said, not `disabled`: a button that disables itself under the finger drops keyboard focus.
  const held = reading || (list !== null && age !== null && age < READ_AGAIN_AFTER_MS);
  const pricesAge = prices.at === null ? null : Math.max(0, now - prices.at);
  return (
    <section data-testid="lp-arb" aria-label="Arbitrage" data-read-at={readAt ?? undefined}>
      <Card title="Arbitrage" art={<CardArt pageId="solana-lp" idx={15} />}>
        {read === null ? (
          <p data-testid="lp-arb-reading" className="text-white/70 text-[13px]">Reading the pools from the chain…</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px]">
              {/* The basis of every figure below, once: Jupiter's listed price, and how old the read is. */}
              {failed !== null && list && age !== null ? (
                <p data-testid="lp-arb-stamp" data-stale="" className="text-amber-300/90 [overflow-wrap:anywhere]">
                  Could not read again ({failed}). Showing the read from {agoText(age)}, against Jupiter’s listed prices.
                </p>
              ) : list && age !== null ? (
                <p data-testid="lp-arb-stamp" data-stale={stale ? '' : undefined} className={stale ? 'text-amber-300/90' : 'text-white/70'}>
                  Against Jupiter’s listed prices, read {agoText(age)}.
                </p>
              ) : (
                <p data-testid="lp-arb-unread" className="text-amber-300/90">Not read.</p>
              )}
              <button
                type="button"
                data-testid="lp-arb-again"
                className={`${TEXT_PRESS}${held ? ' opacity-50 cursor-default' : ''}`}
                onClick={() => {
                  if (!held) again();
                }}
                aria-disabled={held || undefined}
                aria-busy={reading || undefined}
              >
                <span className="ring-words">Read again</span>
              </button>
            </div>
            {paused && (
              <div data-testid="lp-arb-paused">
                <Notice tone="warn">{pausedText('List reads')}</Notice>
              </div>
            )}
            {list && prices.prices === null && <p data-testid="lp-arb-reading" className="text-white/70 text-[13px]">Reading Jupiter’s prices…</p>}
            {list && prices.prices?.kind === 'unread' && <p data-testid="lp-arb-prices-unread" className="text-amber-300/90 text-[13px]">Jupiter’s prices not read.</p>}
            {/* Prices that could not be read again stand, said as old: the figures below rest on them. */}
            {list && usd && prices.failed && pricesAge !== null && (
              <p data-testid="lp-arb-prices-stale" className="text-amber-300/90 text-[12.5px]">
                Jupiter’s prices could not be read again. Showing the prices read {agoText(pricesAge)}.
              </p>
            )}
            {ranked && unsized?.clock && (
              <p data-testid="lp-arb-unsized" className="text-amber-300/90 text-[13px]">The chain’s clock was not read, so no trade can be sized.</p>
            )}
            {ranked && ranked.length === 0 && !unsized?.clock && <p data-testid="lp-arb-none" className="text-white/70 text-[13px]">None right now.</p>}
            {ranked && ranked.length > 0 && (
              // Rows keep their place across a read (keyed by pool), so a focused Swap stays focused.
              <ul className="space-y-2" aria-label="Arbitrage: ranked by profit, most first">
                {ranked.map((o) => (
                  <OpportunityRow key={o.view.address} o={o} />
                ))}
              </ul>
            )}
            {/* Pools that were not read, or whose token's fee was not read, are not checked: said, never folded into "None". */}
            {ranked && unsized && !unsized.clock && (unsized.unreadPools > 0 || unsized.unreadChecks > 0) && (
              <p data-testid="lp-arb-partial" className="text-amber-300/90 text-[12.5px]">
                {[
                  unsized.unreadPools > 0 ? `${unsized.unreadPools === 1 ? 'One pool' : `${unsized.unreadPools} pools`} could not be read` : null,
                  unsized.unreadChecks > 0 ? `${unsized.unreadChecks === 1 ? 'one pool’s token check' : `${unsized.unreadChecks} pools’ token checks`} could not be read` : null,
                ]
                  .filter(Boolean)
                  .join(', and ')}
                , so {unsized.unreadPools + unsized.unreadChecks === 1 ? 'it is' : 'they are'} not checked.
              </p>
            )}
          </div>
        )}
        <FinePrint summary="How this is worked out">
          <p>
            Jupiter’s listed price is its price feed: one read for the whole list, shared by every visitor for 30 seconds. A pool’s card
            asks Jupiter for two live trade quotes instead, and on a thinly traded coin the two can differ by several points; a trade
            pays the live one. So a figure here can be off by that much: the swap page quotes the trade again, against Jupiter and
            against our pool, before anything is sent, and sends it where it pays more. A coin Jupiter does not price is not listed here.
            The gap is the token’s price here against Jupiter’s, whichever way round the prices are shown.
          </p>
          <p>
            Each trade is sized to where the next bit no longer pays after the pool’s fee (and the token’s transfer fee, when it has
            one), and priced with the pool program’s own maths, so what you get and the fee are the chain’s. The profit is at most: it
            is before your network fee and before whatever you pay to trade the other way elsewhere. Under a cent, nothing is listed.
          </p>
          <p>
            It comes out of the pool’s LPs: the pool sells below the market or buys above it. The trade pays the pool’s fee like any
            other: the LPs’ part stays in the pool, the venue’s part goes where the Rates card below says, and a pool creator’s fee to
            the wallet that opened the pool. A token with a transfer fee keeps back part of the trade for whoever collects its fee; a
            token whose transfer fee could not be read gets no figure.
          </p>
          <p>
            A pool that is frozen, has trading switched off, is not open yet, or holds a token this site does not trade is not listed
            here, whatever its gap. Pools past what the list can hold are not checked. The figures are read again every 30 seconds
            while this tab is in view, and on Read again; a read that fails keeps the last figures and says when they were read.
          </p>
        </FinePrint>
      </Card>
    </section>
  );
}

/** One opportunity: the pair, the gap, the trade in rows, and Swap. */
function OpportunityRow({ o }: { o: Opportunity }) {
  const { view, safety, arb } = o;
  const symbol = tokenTicker(view.tokenMint, safety);
  const unit = symbol ? { one: symbol, many: symbol } : { one: 'token', many: 'tokens' };
  const tokenDecimals = tokenDecimalsOf(view);
  const label = pairLabel(view, safety);
  const buy = arb.side === 'buy';
  const pay = buy ? quoteText(arb.amountIn, view.quote) : tokenText(arb.amountIn, tokenDecimals, unit.many);
  const get = buy ? tokenText(arb.outAmount, tokenDecimals, unit.many) : quoteText(arb.outAmount, view.quote);
  // The same rounding as the card's Difference row, so the board and the card say one figure.
  const gap = `${(Math.abs(arb.gap) * 100).toFixed(1)}% ${arb.gap >= 0 ? 'dearer' : 'cheaper'} here`;
  const fee =
    `${usdText(arb.lpFeeUsd)} to LPs · ${usdText(arb.venueFeeUsd)} to the venue` +
    (arb.creatorFeeUsd > 0 ? ` · ${usdText(arb.creatorFeeUsd)} to the pool’s creator` : '') +
    (arb.transferFeeUsd > 0 ? ` · the token keeps back ${usdText(arb.transferFeeUsd)}` : '');
  const press = buy ? `Swap: buy ${symbol ?? 'the token'} with ${pay}` : `Swap: sell ${pay} for ${view.quote.symbol}`;
  return (
    <li data-testid="lp-arb-row" data-pool={view.address} data-side={arb.side} className="rounded-lg px-3 py-2.5 space-y-1" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-white font-semibold text-[14px] [overflow-wrap:anywhere]">{label}</p>
        <p data-testid="lp-arb-gap" className="text-rose-200/90 font-semibold text-[12.5px] ml-auto">{gap}</p>
      </div>
      {/* Any other coin's ticker is its own claim: the whole address is said too, as the rows say it. */}
      {!siteNamed(view.tokenMint) && <p className="font-mono text-white/55 text-[11px] break-all">{view.tokenMint}</p>}
      <div className="text-[12.5px] space-y-0.5">
        <Row label="Pay" value={`${pay} (${usdText(arb.tradeUsd)})`} mono={false} />
        <Row label="Get" value={`≈ ${get} (${usdText(arb.outUsd)})`} mono={false} />
        <Row label="Profit" value={`up to ${usdText(arb.profitUsd)}, after the pool’s fee${arb.transferFeeUsd > 0 ? ' and the token’s' : ''}`} mono={false} />
        <Row label="Fee" value={fee} mono={false} />
        <Row label="After" value={<PriceFlip perToken={arb.afterPerToken} quote={view.quote} unit={unit} />} mono={false} />
      </div>
      {/* `relative`: painted above the price flip's press area, which reaches 14px below its line. */}
      <div className="relative flex justify-end pt-1">
        <Link to={swapLink(arb, buy ? view.quote.decimals : tokenDecimals)} className="btn-primary min-h-[44px] px-5 text-[13px] inline-flex items-center" data-testid="lp-arb-swap" aria-label={press}>
          Swap
        </Link>
      </div>
    </li>
  );
}

/** The clock, every `everyMs`, for the stamp: "read 12 s ago" moves without a read. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
