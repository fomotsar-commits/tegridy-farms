import { useMemo, useState } from 'react';
import { marketsForKind, type YieldMarketsState } from '../../hooks/useYieldMarkets';
import {
  exitDisplay,
  marketDisplay,
  navDisplay,
  rateDisplay,
  readStatusLine,
  vsNavDisplay,
} from '../../lib/yield/display';
import { bestRateClaim } from '../../lib/yield/metrics';
import { yieldVenueAvailability, type YieldVenueKind } from '../../lib/yield/venues';
import { YieldDepositPanel } from './YieldDepositPanel';
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
// The block and chain time are hoisted to ONE line per row rather than repeated
// in five cells. Every figure on the row came from the same aggregate3 call, so
// five copies of the same block number would be five chances to imply they came
// from five different reads.
//
// `aria-controls` is set ONLY while the deposit panel is mounted. A control that
// names a panel absent from the DOM is an invalid-attribute finding, and the
// panel here is genuinely conditional.

export interface YieldRouterPanelProps {
  id: string;
  heading: string;
  intro: string;
  kinds: readonly YieldVenueKind[];
  markets: YieldMarketsState;
}

export function YieldRouterPanel({ id, heading, intro, kinds, markets }: YieldRouterPanelProps) {
  const { rows, ranking } = useMemo(() => marketsForKind(markets.rows, kinds), [markets.rows, kinds]);
  const [openVenue, setOpenVenue] = useState<string | null>(null);

  // Ranked first, then the unrankable, with the catalogue's own order preserved
  // inside each group.
  const ordered = useMemo(() => {
    const rankedIds = ranking.ranked.map((r) => r.venue.id);
    return [
      ...rankedIds.map((vid) => rows.find((r) => r.venue.id === vid)!),
      ...rows.filter((r) => !rankedIds.includes(r.venue.id)),
    ];
  }, [ranking, rows]);

  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="mb-6">
      <h2 id={`${id}-heading`} className="heading-luxury text-xl text-text-primary mb-1.5">
        {heading}
      </h2>
      <p className="text-[13px] text-text-secondary leading-relaxed mb-3">{intro}</p>

      <div className="glass-card rounded-xl p-3 mb-3">
        <p className="text-[12px] text-text-secondary leading-relaxed">
          {readStatusLine(markets.status, markets.block, markets.asOf, markets.unreadCells, markets.totalCells, markets.detail)}
        </p>
        <p className="text-[12px] text-text-primary leading-relaxed mt-1.5">{bestRateClaim(ranking)}</p>
        {(markets.status === 'unavailable' || markets.status === 'partial') && (
          <button type="button" onClick={markets.reload} className="btn-secondary mt-2 px-4 py-2 min-h-11 text-[12px]">
            Read the chain again
          </button>
        )}
      </div>

      <ul className="space-y-3 list-none p-0 m-0">
        {ordered.map((row) => {
          const availability = yieldVenueAvailability(row.venue.id);
          const routable = availability?.routable === true;
          const vs = vsNavDisplay(row.vsNav);
          const open = openVenue === row.venue.id;
          const panelId = `${id}-${row.venue.id}-deposit`;
          return (
            <li key={row.venue.id} className="glass-card rounded-xl p-4">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <h3 className="text-text-primary font-semibold text-[15px] m-0">{row.venue.label}</h3>
                <span className="text-[11px] font-mono text-text-muted shrink-0">{row.venue.symbol}</span>
              </div>
              <p className="text-[11px] text-text-muted mb-3">Issued by {row.venue.issuer}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-2">
                <YieldMetricCell label="Rate" display={rateDisplay(row.rate)} />
                <YieldMetricCell label="Protocol rate (NAV)" display={navDisplay(row.nav)} />
                <YieldMetricCell label="Market price" display={marketDisplay(row.market)} />
                <YieldMetricCell label="vs NAV" display={vs} notable={vs.notable} />
                <YieldMetricCell label="Exit" display={exitDisplay(row.exit)} />
              </div>
              {row.block !== null && (
                <p className="text-[10px] text-text-muted mb-3 leading-snug">
                  Read at block {row.block} · chain time{' '}
                  {row.asOf === null ? 'unknown' : new Date(row.asOf * 1000).toISOString().replace('.000Z', 'Z')}
                </p>
              )}

              <div className="rounded-lg p-3 mb-3" style={{ background: 'rgba(0,0,0,0.30)' }}>
                <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Whose risk you take</p>
                <p className="text-[12px] text-text-secondary leading-relaxed mb-1.5">{row.venue.counterparty}</p>
                <p className="text-[12px] text-text-secondary leading-relaxed">{row.venue.riskNote}</p>
              </div>

              <button
                type="button"
                disabled={!routable}
                aria-disabled={!routable}
                aria-expanded={open}
                {...(open ? { 'aria-controls': panelId } : {})}
                onClick={() => setOpenVenue(open ? null : row.venue.id)}
                className="btn-primary w-full py-3 min-h-11 text-[13px] disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {row.venue.route.kind === 'none' ? `${row.venue.symbol} — comparison only` : row.venue.route.cta}
              </button>
              {!routable && availability && (
                <p className="text-[11px] text-text-muted mt-1.5 leading-snug">{availability.reason}</p>
              )}
              {routable && open && (
                <div id={panelId}>
                  <YieldDepositPanel
                    venue={row.venue}
                    rocket={markets.rocket}
                    depositFee1e18={markets.rocket?.depositFee1e18 ?? null}
                    block={markets.block}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default YieldRouterPanel;
