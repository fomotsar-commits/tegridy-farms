import { useMemo } from 'react';
import { marketsForKind, type YieldMarketsState } from '../../hooks/useYieldMarkets';
import { apyDisplay, exitLiquidityDisplay, feedStatusLine, pegDisplay } from '../../lib/yield/display';
import { bestRateClaim } from '../../lib/yield/metrics';
import { yieldRouteFee, yieldRouteFeeValue, YIELD_THIRD_PARTY_NOTE } from '../../lib/yield/fee';
import { yieldVenueAvailability, type YieldVenueKind } from '../../lib/yield/venues';
import { YieldMetricCell } from './YieldMetricCell';

// ONE panel, configured twice — liquid staking and stablecoin lending are the
// same comparison over different counterparties, and two components would be two
// places for the "best rate" wording to drift apart.
//
// Rows are rendered in RANKED order where a rate was read, then the rows nothing
// could be read for. That second group is listed, not hidden: a venue dropped
// from the table because its rate was unreadable is a venue silently excluded
// from a comparison the reader believes is complete.
//
// The route control is disabled with its reason beside it rather than absent.
// A missing button says the feature does not exist; a disabled one with a
// sentence says what would have to change — and this build's answer, on every
// row, is that no deposit address is wired.

export interface YieldRouterPanelProps {
  id: string;
  heading: string;
  intro: string;
  kinds: readonly YieldVenueKind[];
  markets: YieldMarketsState;
}

export function YieldRouterPanel({ id, heading, intro, kinds, markets }: YieldRouterPanelProps) {
  const { rows, ranking } = useMemo(() => marketsForKind(markets.rows, kinds), [markets.rows, kinds]);

  // Ranked first, then the unrankable, with the catalogue's own order preserved
  // inside each group.
  const ordered = useMemo(() => {
    const rankedIds = ranking.ranked.map((r) => r.venue.id);
    return [
      ...rankedIds.map((vid) => rows.find((r) => r.venue.id === vid)!),
      ...rows.filter((r) => !rankedIds.includes(r.venue.id)),
    ];
  }, [ranking, rows]);

  // No provider is chosen because nothing routes from here, so the fee module is
  // asked with a null source and answers with the reason rather than a rate.
  const fee = yieldRouteFee(null);

  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="mb-6">
      <h2 id={`${id}-heading`} className="heading-luxury text-xl text-text-primary mb-1.5">
        {heading}
      </h2>
      <p className="text-[13px] text-text-secondary leading-relaxed mb-3">{intro}</p>

      <div className="glass-card rounded-xl p-3 mb-3">
        <p className="text-[12px] text-text-secondary leading-relaxed">
          {feedStatusLine(markets.status, markets.detail)}
        </p>
        <p className="text-[12px] text-text-primary leading-relaxed mt-1.5">{bestRateClaim(ranking)}</p>
        {markets.status === 'unavailable' && (
          <button
            type="button"
            onClick={markets.reload}
            className="btn-secondary mt-2 px-4 py-2 min-h-[44px] text-[12px]"
          >
            Try reading the feed again
          </button>
        )}
      </div>

      <ul className="space-y-3 list-none p-0 m-0">
        {ordered.map((row) => {
          const availability = yieldVenueAvailability(row.venue.id);
          const routable = availability?.routable === true;
          const peg = pegDisplay(row.peg, row.venue.pegReference);
          return (
            <li key={row.venue.id} className="glass-card rounded-xl p-4">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-text-primary font-semibold text-[15px]">{row.venue.label}</span>
                <span className="text-[11px] font-mono text-text-muted shrink-0">{row.venue.symbol}</span>
              </div>
              <p className="text-[11px] text-text-muted mb-3">Issued by {row.venue.issuer}</p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <YieldMetricCell label="APY" display={apyDisplay(row.apy)} />
                <YieldMetricCell label={`Peg vs ${row.venue.pegReference}`} display={peg} notable={peg.notable} />
                <YieldMetricCell label="Exit liquidity" display={exitLiquidityDisplay(row.exitLiquidity)} />
              </div>

              <div className="rounded-lg p-3 mb-3" style={{ background: 'rgba(0,0,0,0.30)' }}>
                <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Whose risk you take</p>
                <p className="text-[12px] text-text-secondary leading-relaxed mb-1.5">{row.venue.counterparty}</p>
                <p className="text-[12px] text-text-secondary leading-relaxed">{row.venue.riskNote}</p>
              </div>

              <button
                type="button"
                disabled={!routable}
                aria-disabled={!routable}
                className="btn-primary w-full py-3 min-h-[44px] text-[13px] disabled:opacity-70 disabled:cursor-not-allowed"
              >
                Route into {row.venue.symbol}
              </button>
              {!routable && availability && (
                <p className="text-[11px] text-text-muted mt-1.5 leading-snug">{availability.reason}</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="glass-card rounded-xl p-3 mt-3">
        <div className="flex justify-between items-baseline gap-3">
          <span className="text-[12px] text-text-secondary">Tegridy fee on this route</span>
          <span className="font-mono text-[12px] text-text-primary">{yieldRouteFeeValue(fee)}</span>
        </div>
        <p className="text-[11px] text-text-muted mt-1 leading-snug">
          {fee.charged ? YIELD_THIRD_PARTY_NOTE : `${fee.reason} ${YIELD_THIRD_PARTY_NOTE}`}
        </p>
      </div>
    </section>
  );
}

export default YieldRouterPanel;
