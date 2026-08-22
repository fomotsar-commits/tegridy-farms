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

export function CandleChart({ series, baseSymbol, quoteSymbol }: CandleChartProps) {
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

  const description =
    `Candlestick chart of ${baseSymbol} priced in ${quoteSymbol}. ` +
    `${series.candleCount} bucket${series.candleCount === 1 ? '' : 's'} traded` +
    (series.emptyBuckets > 0
      ? `, and ${series.emptyBuckets} bucket${series.emptyBuckets === 1 ? '' : 's'} had no trade at all and are drawn as gaps rather than filled in`
      : ' with no empty buckets in between') +
    `. Price range ${formatAxisPrice(layout.band.min)} to ${formatAxisPrice(layout.band.max)} ${quoteSymbol}.`;

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
                >
                  <title>
                    {`${utcLabel(box.slot.startSec)} · O ${formatAxisPrice(box.slot.open)} H ${formatAxisPrice(box.slot.high)} L ${formatAxisPrice(box.slot.low)} C ${formatAxisPrice(box.slot.close)} ${quoteSymbol} · ${box.slot.trades} trade${box.slot.trades === 1 ? '' : 's'}`}
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
    </figure>
  );
}

export default CandleChart;
