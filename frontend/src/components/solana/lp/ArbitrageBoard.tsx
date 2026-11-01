import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ARB_CHECK_MAX, checkedOrder, legKey, otherLeg, rowCheck, type RowCheck } from '../../../lib/solana/lp/arbCheck';
import { rankArbitrage, swapLink, tokenDecimalsOf, unsizedPools, type Opportunity } from '../../../lib/solana/lp/poolList';
import { SOLANA_PLATFORM_FEE_BPS, isSolanaFeeConfigured } from '../../../lib/solana';
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
import type { LpReaders } from './readers';
import { useArbChecks } from './useArbChecks';

/** The venue's swap fee on a Jupiter trade, as jupiter.ts takes it; null when none is taken. */
const JUPITER_FEE_PCT = isSolanaFeeConfigured() && SOLANA_PLATFORM_FEE_BPS > 0 ? SOLANA_PLATFORM_FEE_BPS / 100 : null;

/**
 * Every gap on the venue, sized at Jupiter's LISTED price from the list's two reads
 * (poolList.ts `rankArbitrage`), with the top rows' profit held to Jupiter's live quote for
 * the other half of the round trip (arbCheck.ts): a thin coin's listed price can promise a
 * profit its real quote does not pay. What could not be sized or checked is said.
 */
export function ArbitrageBoard({ live, prices, legQuote }: { live: LivePoolList; prices: MarketPricesState; legQuote?: LpReaders['legQuote'] }) {
  const now = useNow(5_000);
  const { read, readAt, failed, reading, again, paused } = live;
  const age = readAt === null ? null : Math.max(0, now - readAt);
  const list = read?.kind === 'ok' ? read.list : null;
  const usd = prices.prices?.kind === 'ok' ? prices.prices.usd : null;
  const ranked = useMemo(() => (list && usd ? rankArbitrage(list, usd) : null), [list, usd]);
  const legs = useMemo(() => (ranked && usd ? ranked.map((o) => otherLeg(o, usd)) : []), [ranked, usd]);
  const wanted = useMemo(
    () => (legQuote && ranked ? ranked.slice(0, ARB_CHECK_MAX).flatMap((o, i) => (legs[i] ? [{ key: legKey(o.view.address, legs[i]), leg: legs[i] }] : [])) : []),
    [legQuote, ranked, legs],
  );
  const answers = useArbChecks(legQuote, wanted);
  const ours = useMemo(() => new Set(list?.pools.map((v) => v.address)), [list]);
  const asked = new Set(wanted.map((w) => w.key));
  const rows =
    ranked && usd
      ? checkedOrder(
          ranked.map((o, i) => {
            const leg = legs[i] ?? null;
            const key = leg && legKey(o.view.address, leg);
            const answer = key && asked.has(key) ? (answers.get(key) ?? 'checking') : null;
            return { o, check: rowCheck(o, leg, answer, usd, list?.chainNow ?? null, ours) };
          }),
        )
      : null;
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
            {rows && rows.length > 0 && (
              // Keyed by pool, so a focused Swap stays focused when its row moves.
              <ul className="space-y-2" aria-label="Arbitrage: ranked by profit, most first">
                {rows.map(({ o, check }) => (
                  <OpportunityRow key={o.view.address} o={o} check={check} />
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
            Jupiter’s listed price is its price feed: one read for the whole list, shared by every visitor for 30 seconds. On a thinly
            traded coin a real trade on Jupiter can pay several points less, so the top {ARB_CHECK_MAX} rows ask Jupiter for a live
            quote of the other half of the round trip: selling what our pool gives, or buying the tokens to sell here with what they
            are worth at the listed price. Profit is that round trip, and one that does not pay says so. A row not checked says its
            figure is at the listed price, before Jupiter’s own costs. A coin Jupiter does not price is not listed here. The gap is the
            token’s price here against Jupiter’s, whichever way round the prices are shown.
          </p>
          <p>
            Each trade is sized to where the next bit no longer pays after the pool’s fee (and the token’s transfer fee, when it has
            one), and priced with the pool program’s own maths, so what you get and the fee are the chain’s. The profit is at most: it
            is before your network fee, and the swap page quotes the trade again before anything is sent.
            {JUPITER_FEE_PCT !== null &&
              ` Jupiter’s quote here has no venue fee in it: that half made on our swap page also pays the venue’s ${JUPITER_FEE_PCT}% fee when SOL or USDC is in the trade.`}{' '}
            Under a cent, nothing is listed.
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
function OpportunityRow({ o, check }: { o: Opportunity; check: RowCheck }) {
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
    <li data-testid="lp-arb-row" data-pool={view.address} data-side={arb.side} data-check={check.kind} className="rounded-lg px-3 py-2.5 space-y-1" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-white font-semibold text-[14px] [overflow-wrap:anywhere]">{label}</p>
        <p data-testid="lp-arb-gap" className="text-rose-200/90 font-semibold text-[12.5px] ml-auto">{gap}</p>
      </div>
      {/* Any other coin's ticker is its own claim: the whole address is said too, as the rows say it. */}
      {!siteNamed(view.tokenMint) && <p className="font-mono text-white/55 text-[11px] break-all">{view.tokenMint}</p>}
      <div className="text-[12.5px] space-y-0.5">
        <Row label="Pay" value={`${pay} (${usdText(arb.tradeUsd)})`} mono={false} />
        <Row label="Get" value={`≈ ${get} (${usdText(arb.outUsd)})`} mono={false} />
        {check.kind === 'unchecked' ? (
          <Row label="At listed price" value={`up to ${usdText(arb.profitUsd)} after the pool’s fee${arb.transferFeeUsd > 0 ? ' and the token’s' : ''}, before Jupiter’s own costs`} mono={false} />
        ) : (
          <Row label="Profit" value={profitText(check)} mono={false} tone={check.kind === 'loss' || check.kind === 'no-route' ? 'warn' : undefined} />
        )}
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

/** A checked row's Profit line: the round trip at Jupiter's live quote. */
function profitText(check: Exclude<RowCheck, { kind: 'unchecked' }>): string {
  if (check.kind === 'checking') return 'checking Jupiter’s quote…';
  if (check.kind === 'no-route') return 'none: Jupiter has no route for the other half';
  if (check.kind === 'profit') return `up to ${usdText(check.usd)} round trip, at Jupiter’s live quote`;
  return `none after Jupiter’s own costs${check.usd <= -0.01 ? `: the round trip loses ${usdText(-check.usd)}` : ''}`;
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
