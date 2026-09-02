import { useMemo } from 'react';
import type { CandleSeries } from '../../lib/chart/candles';
import {
  DEFAULT_VIEWPORT,
  buildLayout,
  formatAxisPrice,
  priceTicks,
} from '../../lib/chart/geometry';

// Pure SVG candlestick renderer. No charting dependency — the same shape the
// nakamigos DepthChart already proved out in this repo: geometry lives in a
// unit-tested pure module (lib/chart/geometry.ts) and this file only turns
// numbers into elements.
//
// WHAT THE GAPS ARE. A bucket where nothing traded gets a hatched column of its
// own true width. It is not a candle, it is not skipped, and no line joins the
// candles across it. On a venue where a pool can go a day without a trade, the
// alternative — packing candles together and letting the axis stretch — draws a
// continuous market that does not exist.
//
// This component renders a series or nothing. Every "why is it not here" state
// belongs to ChartStatus, so the chart itself never has an empty-but-plausible
// mode a reader could mistake for a flat market.

export interface CandleChartProps {
  series: CandleSeries;
  /** e.g. "TOWELI" — the token a candle's price is quoted PER. */
  baseSymbol: string;
  /** e.g. "WETH" — the token a candle's price is quoted IN. */
  quoteSymbol: string;
  /**
   * The newest bucket may still be accumulating at the source.
   *
   * True for a server-aggregated feed (GeckoTerminal returns the current bucket
   * with whatever has traded so far), false for the indexed path, which builds
   * its buckets out of swaps it has already read. The difference matters because
   * the newest candle's CLOSE is the one number a reader acts on, and on a live
   * bucket it is "the last trade so far", not "where this bucket closed". It is
   * marked with a dashed body and said in words rather than left to be assumed.
   */
  newestMayBeOpen?: boolean;
}

const UP = 'var(--color-success)';
const DOWN = 'var(--color-danger)';
const FLAT = 'rgba(255,255,255,0.72)';

function colorOf(direction: 'up' | 'down' | 'flat'): string {
  return direction === 'up' ? UP : direction === 'down' ? DOWN : FLAT;
}

function utcLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * The trade-count clause, or nothing at all.
 *
 * `trades` is null when the SOURCE reports no count (every GeckoTerminal
 * bucket). Printing "0 trades" there would turn "nobody told us" into "nothing
 * traded" on a candle that demonstrably has four prices behind it, so the clause
 * is omitted entirely rather than filled with a number nobody measured.
 */
function tradeClause(trades: number | null): string {
  if (trades === null) return '';
  return ` · ${trades} trade${trades === 1 ? '' : 's'}`;
}

export function CandleChart({ series, baseSymbol, quoteSymbol, newestMayBeOpen = false }: CandleChartProps) {
  const layout = useMemo(() => buildLayout(series.slots, DEFAULT_VIEWPORT), [series.slots]);
  const ticks = useMemo(() => (layout ? priceTicks(layout) : []), [layout]);

  // buildLayout returns null when there is no candle to place. The caller has
  // already branched on status, so reaching here with nothing drawable means the
  // window held no priceable swap — which is a sentence, not a blank axis.
  if (!layout) {
    return (
      <p className="rounded-lg border border-white/15 bg-white/[0.03] px-4 py-6 text-center text-xs text-white/75">
        No priceable swap landed in this window, so there is no candle to draw. This is the
        window being empty, not the price being zero.
      </p>
    );
  }

  const { area } = layout;
  const first = series.from;
  const last = series.to;

  // Which body carries the open-bucket marker. Found by walking back to the last
  // CANDLE rather than taking the last box, because a series can end on a gap —
  // in which case the newest candle is not the newest slot and marking the box
  // at the end would put the dashed body on the wrong bucket.
  let newestCandleStart: number | null = null;
  for (let i = layout.boxes.length - 1; i >= 0; i -= 1) {
    const box = layout.boxes[i];
    if (box && box.kind === 'candle') {
      newestCandleStart = box.slot.startSec;
      break;
    }
  }

  const description =
    `Candlestick chart of ${baseSymbol} priced in ${quoteSymbol}. ` +
    `${series.candleCount} bucket${series.candleCount === 1 ? '' : 's'} traded` +
    (series.emptyBuckets > 0
      ? `, and ${series.emptyBuckets} bucket${series.emptyBuckets === 1 ? '' : 's'} had no trade at all and are drawn as gaps rather than filled in`
      : ' with no empty buckets in between') +
    `. Price range ${formatAxisPrice(layout.band.min)} to ${formatAxisPrice(layout.band.max)} ${quoteSymbol}.` +
    (newestMayBeOpen ? ' The newest bucket may still be open.' : '');

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${DEFAULT_VIEWPORT.width} ${DEFAULT_VIEWPORT.height}`}
          preserveAspectRatio="xMidYMid meet"
          className="w-full min-w-[320px]"
          role="img"
          aria-label={description}
        >
          <defs>
            {/* The gap fill. Hatching rather than a flat tint so an empty bucket
                cannot be misread as a very quiet one at a glance. */}
            <pattern id="candle-gap-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="transparent" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.16)" strokeWidth="1.5" />
            </pattern>
          </defs>

          {ticks.map((t) => (
            <g key={`tick-${t.price}`}>
              <line
                x1={area.x}
                x2={area.x + area.width}
                y1={t.y}
                y2={t.y}
                stroke="var(--color-purple-12)"
                strokeWidth="0.75"
                strokeDasharray="4 4"
              />
              <text
                x={area.x + area.width + 6}
                y={t.y + 3}
                fill="rgba(255,255,255,0.55)"
                fontSize="8"
                fontFamily="ui-monospace, monospace"
              >
                {formatAxisPrice(t.price)}
              </text>
            </g>
          ))}

          {layout.boxes.map((box) =>
            box.kind === 'gap' ? (
              <rect
                key={`gap-${box.slot.startSec}`}
                x={box.x}
                y={area.y}
                width={box.width}
                height={area.height}
                fill="url(#candle-gap-hatch)"
              >
                <title>
                  {`No trade for ${box.slot.buckets} bucket${box.slot.buckets === 1 ? '' : 's'} — ${utcLabel(box.slot.startSec)} to ${utcLabel(box.slot.endSec)}. Drawn as a gap; no price is claimed for this time.`}
                </title>
              </rect>
            ) : (
              <g key={`candle-${box.slot.startSec}`}>
                <line
                  x1={box.wickX}
                  x2={box.wickX}
                  y1={box.wickTop}
                  y2={box.wickBottom}
                  stroke={colorOf(box.direction)}
                  strokeWidth="1"
                  opacity="0.8"
                />
                <rect
                  x={box.bodyX}
                  y={box.bodyY}
                  width={box.bodyWidth}
                  height={box.bodyHeight}
                  fill={colorOf(box.direction)}
                  opacity={box.direction === 'flat' ? 0.9 : 0.85}
                  {...(newestMayBeOpen && box.slot.startSec === newestCandleStart
                    ? { stroke: 'rgba(255,255,255,0.85)', strokeWidth: 1, strokeDasharray: '2 2' }
                    : {})}
                >
                  <title>
                    {`${utcLabel(box.slot.startSec)} · O ${formatAxisPrice(box.slot.open)} H ${formatAxisPrice(box.slot.high)} L ${formatAxisPrice(box.slot.low)} C ${formatAxisPrice(box.slot.close)} ${quoteSymbol}${tradeClause(box.slot.trades)}${
                      newestMayBeOpen && box.slot.startSec === newestCandleStart
                        ? ' · bucket may still be open'
                        : ''
                    }`}
                  </title>
                </rect>
              </g>
            ),
          )}

          {first !== null && last !== null ? (
            <>
              <text
                x={area.x}
                y={DEFAULT_VIEWPORT.height - 8}
                fill="rgba(255,255,255,0.45)"
                fontSize="8"
                fontFamily="ui-monospace, monospace"
              >
                {utcLabel(first)}
              </text>
              <text
                x={area.x + area.width}
                y={DEFAULT_VIEWPORT.height - 8}
                textAnchor="end"
                fill="rgba(255,255,255,0.45)"
                fontSize="8"
                fontFamily="ui-monospace, monospace"
              >
                {utcLabel(last)}
              </text>
            </>
          ) : null}
        </svg>
      </div>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/60">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-[1px]" style={{ background: UP }} aria-hidden="true" />
          Closed up
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-[1px]" style={{ background: DOWN }} aria-hidden="true" />
          Closed down
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-4 rounded-[1px] border border-white/25"
            style={{ backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.22) 0 2px, transparent 2px 5px)' }}
            aria-hidden="true"
          />
          No trade — gap, not a price
        </span>
        <span>
          {baseSymbol} priced in {quoteSymbol}
        </span>
      </figcaption>

      {/* THE PLOT IN WORDS. An `aria-label` on the svg says what the chart is
          about; it cannot say what any individual bucket did, and a shape with
          no reachable numbers is a chart only a sighted mouse user can read.
          The same slots are listed here in the same order, with the gaps kept
          as gaps — a table that quietly omitted the empty buckets would be a
          more convincing version of the lie the plot refuses to draw. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] text-white/60 hover:text-white/85">
          Read these candles as a table
        </summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full min-w-[320px] border-collapse text-left text-[11px] text-white/75">
            <caption className="sr-only">
              {`Every bucket in this chart, oldest first. ${baseSymbol} priced in ${quoteSymbol}.`}
            </caption>
            <thead className="text-white/55">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">Bucket opened (UTC)</th>
                <th scope="col" className="py-1 pr-3 font-medium">Open</th>
                <th scope="col" className="py-1 pr-3 font-medium">High</th>
                <th scope="col" className="py-1 pr-3 font-medium">Low</th>
                <th scope="col" className="py-1 pr-3 font-medium">Close</th>
                <th scope="col" className="py-1 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {series.slots.map((slot) =>
                slot.kind === 'gap' ? (
                  <tr key={`row-gap-${slot.startSec}`} className="border-t border-white/10">
                    <th scope="row" className="py-1 pr-3 font-normal">{utcLabel(slot.startSec)}</th>
                    <td className="py-1 pr-3" colSpan={4}>
                      Not returned by the source — no price is claimed
                    </td>
                    <td className="py-1">{`gap, ${slot.buckets} bucket${slot.buckets === 1 ? '' : 's'}`}</td>
                  </tr>
                ) : (
                  <tr key={`row-candle-${slot.startSec}`} className="border-t border-white/10">
                    <th scope="row" className="py-1 pr-3 font-normal">{utcLabel(slot.startSec)}</th>
                    <td className="py-1 pr-3 tabular-nums">{formatAxisPrice(slot.open)}</td>
                    <td className="py-1 pr-3 tabular-nums">{formatAxisPrice(slot.high)}</td>
                    <td className="py-1 pr-3 tabular-nums">{formatAxisPrice(slot.low)}</td>
                    <td className="py-1 pr-3 tabular-nums">{formatAxisPrice(slot.close)}</td>
                    <td className="py-1">
                      {slot.trades === null ? '' : `${slot.trades} trade${slot.trades === 1 ? '' : 's'}`}
                      {newestMayBeOpen && slot.startSec === newestCandleStart
                        ? `${slot.trades === null ? '' : ' · '}may still be open`
                        : ''}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export default CandleChart;
