// One line on the swap form and on our pool's review: the pair's 24-hour average traded
// price, and how far this trade's price is above or below it. How it is worked out sits in
// the drop-down. A reference only: nothing here holds or changes a trade.
import { useEffect, useState } from 'react';
import { FinePrint } from '../ui/FinePrint';
import {
  MIN_TRADED_QUARTER_HOURS,
  MIN_TRADES_24H,
  MIN_VOLUME_USD_24H,
  fetchPairAverage,
  sayAs,
  tradeVsAverage,
  type PairAverage,
} from '../../lib/solana/swap/pairAverage';

/** Read again this often while on screen: the window moves. */
const REFRESH_MS = 120_000;
/** A read that failed (most often the keyless feed's rate limit) is tried again sooner. */
export const RETRY_UNREAD_MS = 30_000;

export interface PairAverageTrade {
  payMint: string;
  buyMint: string;
  paySymbol: string;
  buySymbol: string;
  /** The trade in whole coins, fees and price impact inside; null when there is no trade to compare. */
  payAmount: number | null;
  buyAmount: number | null;
}

/** A price as a person reads it: 4 significant figures under 1, two decimals from 1. */
export function averagePriceText(n: number): string {
  if (n < 1) return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** "1.2% above", "0.04% below", or "at the average" when it rounds to nothing. */
export function aboveBelowText(pct: number): string {
  const shown = Math.abs(pct).toFixed(Math.abs(pct) < 1 ? 2 : 1);
  if (Number(shown) === 0) return 'at the average';
  return `${shown}% ${pct > 0 ? 'above' : 'below'}`;
}

export function averageLineText(state: PairAverage | 'loading', t: PairAverageTrade): string {
  const sym = (mint: string) => (mint === t.payMint ? t.paySymbol : t.buySymbol);
  const [base] = sayAs(t.buyMint, t.payMint);
  const lead = `${sym(state !== 'loading' && state.kind === 'ok' ? state.baseMint : base)} 24h average`;
  if (state === 'loading') return `${lead}: …`;
  if (state.kind === 'thin') return `${lead}: not enough trading to average`;
  if (state.kind === 'none') return `${lead}: no pool found for this pair`;
  if (state.kind === 'unread') return `${lead}: could not be read`;
  const pct = tradeVsAverage(state, t);
  const said = `${lead}: ${averagePriceText(state.price)} ${sym(state.quoteMint)}`;
  return pct === null ? said : `${said} · this trade ${aboveBelowText(pct)}`;
}

function PairAverageInner({ trade, testId }: { trade: PairAverageTrade; testId: string }) {
  const [state, setState] = useState<PairAverage | 'loading'>('loading');
  const { payMint, buyMint } = trade;
  useEffect(() => {
    const ctrl = new AbortController();
    let next: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      fetchPairAverage(payMint, buyMint, ctrl.signal)
        .catch((): PairAverage => ({ kind: 'unread' }))
        .then((v) => {
          if (ctrl.signal.aborted) return;
          setState(v);
          next = setTimeout(read, v.kind === 'unread' ? RETRY_UNREAD_MS : REFRESH_MS);
        });
    };
    next = setTimeout(read, 0);
    return () => { clearTimeout(next); ctrl.abort(); };
  }, [payMint, buyMint]);

  return (
    <FinePrint summary={<span data-testid={`${testId}-line`}>{averageLineText(state, trade)}</span>} testId={testId}>
      <p>
        The average price this pair traded at over the last 24 hours, each price weighted by how much traded at
        it. Worked out on this page from the 15-minute candles of the pair&apos;s top pool on GeckoTerminal: each
        candle&apos;s high, low and close, weighted by its volume. Trades in our own pools are not in it.
      </p>
      <p>
        Shown only when that pool had at least {MIN_TRADES_24H} trades and $
        {MIN_VOLUME_USD_24H.toLocaleString('en-US')} of trading in 24 hours, in at least {MIN_TRADED_QUARTER_HOURS}{' '}
        separate quarter-hours. Below that, a few trades would set it.
      </p>
      <p>
        This trade&apos;s price includes the fees and price impact in its quote. Above means a higher price for the
        coin named first. The average is a reference only: it never stops or changes a trade.
      </p>
    </FinePrint>
  );
}

/** Remounted per pair, so a new pair starts from "…" and never shows the last pair's number. */
export function PairAverageLine({ trade, testId = 'pair-average' }: { trade: PairAverageTrade; testId?: string }) {
  const key = [trade.payMint, trade.buyMint].sort().join('|');
  return <PairAverageInner key={key} trade={trade} testId={testId} />;
}
