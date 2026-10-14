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
import { bestRateClaim, pegAssessment } from '../../lib/yield/metrics';
import { yieldVenueAvailability, type YieldVenueKind } from '../../lib/yield/venues';
import { YieldDepositPanel } from './YieldDepositPanel';
import { YieldMetricCell } from './YieldMetricCell';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

// Venue cards take yield art 5 to 9 by the venue's place in the CATALOGUE, not
// by its rank: the ranking moves as rates arrive, and a card must not change its
// art when it changes rows. The staking list (5 venues) and the stablecoin list
// (3) are never on screen together, so they share these.
const VENUE_ART_BASE = 5;
const VENUE_ART_SLOTS = 5;

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
//
// FEWER WORDS ON THE FACE OF IT (owner, 2026-10-13). Each row shows its figures
// and the two qualifiers a figure cannot be read without (exit meaning, a NAV
// discount); every source line, the counterparty and loss mode, and the reason a
// row cannot route sit in that row's FinePrint, verbatim.

export interface YieldRouterPanelProps {
  id: string;
  heading: string;
  /** One short visible line under the heading. */
  intro: string;
  /** The longer explanation, shown in the section's FinePrint. */
  introDetail?: string;
  kinds: readonly YieldVenueKind[];
  markets: YieldMarketsState;
}

export function YieldRouterPanel({ id, heading, intro, introDetail, kinds, markets }: YieldRouterPanelProps) {
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

      <div className="relative isolate glass-card rounded-xl p-3 mb-3">
        <CardArt pageId="yield" idx={4} />
        <p className="text-[12px] text-text-secondary leading-relaxed">
          {readStatusLine(markets.status, markets.block, markets.asOf, markets.unreadCells, markets.totalCells, markets.detail)}
        </p>
        {(markets.status === 'unavailable' || markets.status === 'partial') && (
          <button type="button" onClick={markets.reload} className="btn-secondary mt-2 px-4 py-2 min-h-11 text-[12px]">
            Read the chain again
          </button>
        )}
        <FinePrint summary="How it works" className="mt-1">
          {introDetail ? <p>{introDetail}</p> : null}
          <p className="text-text-primary">{bestRateClaim(ranking)}</p>
        </FinePrint>
      </div>

      <ul className="space-y-3 list-none p-0 m-0">
        {ordered.map((row) => {
          const artSlot = Math.max(0, rows.indexOf(row));
          const availability = yieldVenueAvailability(row.venue.id);
          const routable = availability?.routable === true;
          const vs = vsNavDisplay(row.vsNav);
          const cells = [
            ['Rate', rateDisplay(row.rate)],
            ['Protocol rate (NAV)', navDisplay(row.nav)],
            ['Market price', marketDisplay(row.market)],
            ['vs NAV', vs],
            ['Exit', exitDisplay(row.exit)],
          ] as const;
          // The two qualifiers a bare figure would contradict: a discount worth
          // flagging, and whether an exit figure is liquidity or a queue.
          const peg = pegAssessment(row.vsNav);
          const vsNote = peg.state === 'below-nav' && peg.notable ? `${peg.discountPct.toFixed(2)}% under NAV` : undefined;
          const exitNote =
            row.exit.state === 'read'
              ? row.exit.meaning === 'queued-ahead'
                ? 'queued ahead of a new withdrawal'
                : 'redeemable now'
              : undefined;
          const open = openVenue === row.venue.id;
          const panelId = `${id}-${row.venue.id}-deposit`;
          return (
            <li key={row.venue.id} className="relative isolate glass-card rounded-xl p-4">
              <CardArt pageId="yield" idx={VENUE_ART_BASE + (artSlot % VENUE_ART_SLOTS)} />
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <h3 className="text-text-primary font-semibold text-[15px] m-0">{row.venue.label}</h3>
                <span className="text-[11px] font-mono text-text-muted shrink-0">{row.venue.symbol}</span>
              </div>
              <p className="text-[11px] text-text-muted mb-3">Issued by {row.venue.issuer}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
                <YieldMetricCell label="Rate" display={cells[0][1]} />
                <YieldMetricCell label="Protocol rate (NAV)" display={cells[1][1]} />
                <YieldMetricCell label="Market price" display={cells[2][1]} />
                <YieldMetricCell label="vs NAV" display={vs} notable={vs.notable} note={vsNote} />
                <YieldMetricCell label="Exit" display={cells[4][1]} note={exitNote} />
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
              <FinePrint summary="Risks and sources" className="mt-1">
                <p>
                  <span className="text-text-primary">Whose risk you take:</span> {row.venue.counterparty}
                </p>
                <p>{row.venue.riskNote}</p>
                {!routable && availability ? <p>{availability.reason}</p> : null}
                <ul className="list-none p-0 m-0 space-y-1">
                  {cells.map(([label, display]) => (
                    <li key={label}>
                      <span className="text-text-primary">{label}:</span> {display.detail}
                    </li>
                  ))}
                </ul>
                {row.block !== null && (
                  <p>
                    Read at block {row.block} · chain time{' '}
                    {row.asOf === null ? 'unknown' : new Date(row.asOf * 1000).toISOString().replace('.000Z', 'Z')}
                  </p>
                )}
              </FinePrint>
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
