import { useEffect, useState } from 'react';
import { againstQuote, fetchFillScoreboard, type FillScoreboard } from '../../lib/fillScoreboard';
import { FinePrint } from '../ui/FinePrint';

const whenFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const sol = (lamports: bigint) => (Number(lamports) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 });

/**
 * What Jupiter trades made here actually got against their quote, read from the chain hourly
 * (fill-scoreboard.yml). Unread shows nothing: no figure is claimed until a run has finished.
 */
export function FillScoreLine() {
  const [record, setRecord] = useState<FillScoreboard | null>(null);
  useEffect(() => {
    let live = true;
    void fetchFillScoreboard().then((r) => {
      if (live) setRecord(r);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!record || record.state === 'unread') return null;

  const r = record;
  return (
    <div className="mt-2 text-center text-[10px] text-white/60" data-testid="fill-score">
      <p>
        {r.trades === 0
          ? `No Jupiter trades here in the last ${r.windowDays} days.`
          : `Jupiter trades here, last ${r.windowDays} days: ${r.atOrAboveQuote} of ${r.trades} got at least the quote, ${r.nearFloor === 0 ? 'none' : r.nearFloor} near the slippage floor.`}
        {r.state === 'behind' && (
          <span style={{ color: 'var(--color-warning)' }}> Not up to date, last read {whenFmt.format(r.asOf)}.</span>
        )}
      </p>
      <FinePrint summary="How this is read">
        <p>
          Jupiter writes its quote into each swap. Every hour we read that quote and what reached the wallet from the
          chain, for each swap that paid our fee.
          {r.medianFillBps !== null && r.worstFillBps !== null && (
            <> Typical trade: {againstQuote(r.medianFillBps)}. Worst: {againstQuote(r.worstFillBps)}.</>
          )}
          {r.deposits.trades > 0 && (
            <> {r.deposits.trades} also left {sol(r.deposits.lamports)} SOL as deposits in accounts the route opened.</>
          )}
          {r.unscored > 0 && <> {r.unscored} could not be scored.</>} Swaps in our own pools are not in it yet.
        </p>
      </FinePrint>
    </div>
  );
}
