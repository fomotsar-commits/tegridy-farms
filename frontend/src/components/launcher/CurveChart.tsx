// Bonding-curve visualisation for our own Solana launch program (`tegridy-launch`).
//
// Plots the curve as a FUNCTION OF STATE — price against amount raised — which is
// always knowable from a single account read. It is deliberately NOT a time series:
// the program is not deployed anywhere, there is no indexer and no trade history,
// so a price-over-time chart could only be fabricated
// (docs/OWN_CURVE_FRONTEND_CONTRACT.md §9 row 7). Nothing here draws one.
//
// Inline SVG, no charting dependency. `lightweight-charts` is already installed for
// /chart, but it is a TIME-SERIES library — reaching for it here would both add
// weight and push the surface toward exactly the fabricated history this must not
// show. Sparkline.tsx is the house precedent for hand-rolled SVG.
//
// Fetches nothing. The parent supplies a decoded snapshot (or an honest failure
// state), so this stays pure, testable, and impossible to render as "live" by
// accident — see `CurveChartState`, which has no default and no zero-value fallback.

import { useId, useMemo } from 'react';
// 2026-08-28 (bundle audit): import the PURE halves directly, not the
// `…/solana/curve` barrel. The barrel also re-exports program/ix/read/rpc,
// which statically import @solana/web3.js + buffer — harmless while this
// chart's only consumer is the lazy Solana page, but the day it's reused on an
// EVM surface the barrel would weld vendor-solana into that page's chunk (the
// exact 08-27 instance-2 shape). Direct imports make the reuse safe by
// construction.
import {
  buildCurveGeometry,
  type CurveGeometry,
  type CurveSnapshot,
  type CurveUnplottableReason,
} from '../../lib/launcher/solana/curve/geometry';
import { formatSol as formatSolRaw, spotPriceLabel } from '../../lib/launcher/solana/curve/format';

/**
 * Fixed-width SOL for the stat grid — a ragged fraction breaks the column.
 *
 * `formatSol` is the ONE formatter (curve/format.ts); `fixed` is a presentation
 * setting on it, not a second copy. It keeps the `<0.0001` floor either way, so a
 * curve holding a single lamport reads as "<0.0001 SOL" here rather than the
 * "0.0000 SOL" the chart's own former copy produced.
 */
const formatSol = (lamports: bigint, decimalPlaces = 4) =>
  formatSolRaw(lamports, decimalPlaces, { fixed: true });

/**
 * Where the plotted numbers came from. Required, not optional: an illustrative
 * curve rendered without its badge is the exact bug this component exists to avoid.
 */
export type CurveChartSource =
  /** Decoded from a real `BondingCurve` account read. */
  | { kind: 'chain' }
  /** Parameters supplied by hand — a shape, not a market. `note` says whose. */
  | { kind: 'illustrative'; note: string };

/**
 * Every state this surface can be in. No `undefined` curve, no zero-filled
 * placeholder: a caller that has not read the chain has to say which failure it hit.
 */
export type CurveChartState =
  /** `getAccountInfo(PROGRAM_ID)` returned null (contract §7.1 row 0). */
  | { status: 'not-deployed' }
  /** A read threw or timed out. Never fall through to a later phase (row 0b). */
  | { status: 'unreadable'; detail?: string }
  /** No `curve` account for this mint — pre-launch, NOT "0 SOL raised" (row 2). */
  | { status: 'no-curve' }
  | { status: 'ready'; curve: CurveSnapshot; source: CurveChartSource };

export interface CurveChartProps {
  state: CurveChartState;
  /**
   * SPL decimals of the launch mint, read from the mint account. Omit when it was
   * not read — labels then stay in base units rather than assuming 9 (§9 row 3).
   */
  tokenDecimals?: number;
  className?: string;
}

const VIEW_W = 640;
const VIEW_H = 220;
const PAD = 14;
const INNER_W = VIEW_W - PAD * 2;
const INNER_H = VIEW_H - PAD * 2;

const toX = (x: number) => PAD + x * INNER_W;
const toY = (y: number) => PAD + (1 - y) * INNER_H;

/**
 * The not-deployed notice, hoisted out of the JSX so a test can pin the BODY.
 *
 * ⚠ THE BODY IS THE LOAD-BEARING PART, not the title. A reviewer replaced this
 * whole body with "Trading opens soon. Current price 0.0000 SOL" — a fabricated
 * market for a program that does not exist — and the suite stayed 45/45 green,
 * because the only assertion matched the title. The `unreadable` and `no-curve`
 * branches were already pinned on their bodies; this one was not. It is now
 * (CurveChart.test.tsx), and that is why this is a constant rather than a string
 * literal inline: a test that reads the same literal proves nothing, so the test
 * asserts the SUBSTANCE — the three things it promises are absent — not this
 * object's identity.
 */
export const NOT_DEPLOYED_COPY = {
  title: 'The launch program is not deployed',
  body: 'There is no bonding curve to plot. This program has not been deployed to mainnet-beta or devnet, so there is no market, no price, and no history — and none is shown here.',
} as const;

/** Copy for every reason the curve cannot be plotted. Exported for tests. */
export const UNPLOTTABLE_COPY: Record<CurveUnplottableReason, string> = {
  graduated:
    'This launch graduated. Migration moved the liquidity to the pool and closed the curve, so the curve no longer describes a market — trade on the pool instead.',
  'no-virtual-reserves':
    'This curve has no virtual reserves, so it has no price to plot. That is a configuration fault, not a market condition.',
  'no-graduation-target':
    'This curve has no graduation target, so there is nothing to measure progress against.',
  'fee-out-of-range':
    'This curve records a trade fee outside the range the program accepts, so no quote or plot from it would be trustworthy.',
  'arithmetic-refused':
    'The same arithmetic the program runs refused these curve terms, so the amount still needed to graduate cannot be stated. Nothing is plotted rather than plotted around a missing figure.',
};

export function CurveChart({ state, tokenDecimals, className }: CurveChartProps) {
  const gradientId = useId();

  const result = useMemo(
    () => (state.status === 'ready' ? buildCurveGeometry(state.curve) : null),
    [state],
  );

  if (state.status === 'not-deployed') {
    return (
      <Frame className={className}>
        <Notice title={NOT_DEPLOYED_COPY.title} body={NOT_DEPLOYED_COPY.body} />
      </Frame>
    );
  }

  if (state.status === 'unreadable') {
    return (
      <Frame className={className}>
        <Notice
          title="Curve state could not be read"
          body={
            state.detail
              ? `The on-chain read failed, so nothing below is known: ${state.detail}`
              : 'The on-chain read failed, so the curve is unknown. This is not a reading of zero — retry, or check your connection.'
          }
        />
      </Frame>
    );
  }

  if (state.status === 'no-curve') {
    return (
      <Frame className={className}>
        <Notice
          title="No curve for this mint"
          body="This mint has no bonding-curve account, so it has not been launched on this rail. That is different from a launch that has raised nothing."
        />
      </Frame>
    );
  }

  if (!result?.ok) {
    return (
      <Frame className={className}>
        <Notice title="Curve cannot be plotted" body={UNPLOTTABLE_COPY[result!.reason]} />
      </Frame>
    );
  }

  const g = result.geometry;
  const spot = spotPriceLabel(g.current.price, tokenDecimals);
  const progressPct = (g.progress * 100).toFixed(1);
  const targetSeparate = g.target.raisedLamports !== g.ceiling.raisedLamports;

  const curvePath = g.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.x).toFixed(2)},${toY(p.y).toFixed(2)}`).join(' ');
  const raisedPoints = g.points.filter((p) => p.raisedLamports <= g.current.raisedLamports);
  const areaPath =
    raisedPoints.length > 1
      ? `${raisedPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.x).toFixed(2)},${toY(p.y).toFixed(2)}`).join(' ')} L${toX(g.current.x).toFixed(2)},${toY(0).toFixed(2)} L${toX(0).toFixed(2)},${toY(0).toFixed(2)} Z`
      : null;

  return (
    <Frame className={className}>
      {state.source.kind === 'illustrative' && (
        <p
          className="text-[11px] leading-relaxed rounded-lg px-3 py-2 mb-3"
          style={{
            color: 'var(--color-warning)',
            border: '1px solid var(--color-warning-dim)',
            background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
          }}
        >
          Illustrative shape — these parameters were supplied, not read from a live curve. {state.source.note}
        </p>
      )}

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full h-auto block"
        role="img"
        aria-label={`Bonding curve: ${formatSol(g.current.raisedLamports)} SOL raised of ${formatSol(g.ceiling.raisedLamports)} SOL needed to graduate, ${progressPct} percent. Price rises along the curve; no trade history is shown.`}
      >
        <title>Bonding curve — price against SOL raised</title>
        <defs>
          <linearGradient id={`curve-fill-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Baseline. There is no y-axis scale drawn: the y range is the curve's own
            price range over the plotted domain, and labelling it would invite reading
            a price off the picture instead of off the figures below. */}
        <line
          x1={toX(0)}
          y1={toY(0)}
          x2={toX(1)}
          y2={toY(0)}
          stroke="var(--color-border)"
          strokeWidth={1}
        />

        {areaPath && <path d={areaPath} fill={`url(#curve-fill-${gradientId})`} />}

        <path
          d={curvePath}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {targetSeparate && (
          <line
            x1={toX(g.target.x)}
            y1={PAD}
            x2={toX(g.target.x)}
            y2={toY(0)}
            stroke="var(--color-text-muted)"
            strokeWidth={1}
            strokeDasharray="2 5"
          />
        )}

        <line
          x1={toX(g.ceiling.x)}
          y1={PAD}
          x2={toX(g.ceiling.x)}
          y2={toY(0)}
          stroke="var(--color-warning)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />

        <line
          x1={toX(g.current.x)}
          y1={toY(g.current.y)}
          x2={toX(g.current.x)}
          y2={toY(0)}
          stroke="var(--color-success)"
          strokeWidth={1}
          strokeOpacity={0.45}
        />
        <circle
          cx={toX(g.current.x)}
          cy={toY(g.current.y)}
          r={5.5}
          fill="var(--color-success)"
          stroke="var(--color-bg-surface)"
          strokeWidth={2}
        />
      </svg>

      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
        <Swatch color="var(--color-primary)">price along the curve</Swatch>
        <Swatch color="var(--color-success)">where it stands now</Swatch>
        <Swatch color="var(--color-warning)">fully funded — buys stop</Swatch>
        {targetSeparate && <Swatch color="var(--color-text-muted)">graduation target</Swatch>}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <Stat label="SOL raised" value={`${formatSol(g.current.raisedLamports)} SOL`} />
        <Stat label="Progress" value={`${progressPct}%`} hint="of target + migration reserve" />
        <Stat
          label="Still to send"
          value={g.lamportsUntilCeiling == null ? 'fully funded' : `${formatSol(g.lamportsUntilCeiling)} SOL`}
          hint={g.lamportsUntilCeiling == null ? 'awaiting migration' : 'includes the trade fee'}
        />
        <Stat label="Spot price" value={spot.value} hint={spot.unit} />
      </dl>

      <p className="text-[11px] leading-relaxed mt-3" style={{ color: 'var(--color-text-muted)' }}>
        Graduation needs {formatSol(g.ceiling.raisedLamports)} SOL on the curve —{' '}
        {formatSol(g.target.raisedLamports)} SOL that seeds the pool plus{' '}
        {formatSol(g.ceiling.raisedLamports - g.target.raisedLamports)} SOL held back to pay for the
        migration. Progress is measured against the sum, because that is what the program caps buys
        against.
      </p>
      <p className="text-[11px] leading-relaxed mt-1" style={{ color: 'var(--color-text-muted)' }}>
        This is the curve&rsquo;s shape, not its history. Spot price is a display ratio — any trade
        moves it, and the price you get is the one the program quotes at signing time.
        {g.pastCeiling && ' This curve holds more than the amount needed, so the plot extends past the graduation line.'}
      </p>
    </Frame>
  );
}

/** Card chrome, matching the launcher's existing panels (LaunchAfterlife). */
function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      aria-label="Bonding curve"
      className={`rounded-2xl p-4 sm:p-5 ${className ?? ''}`}
      style={{ border: '1px solid var(--color-border)', background: 'var(--color-bg-surface)' }}
    >
      {children}
    </section>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
        {title}
      </p>
      <p className="text-xs mt-1 max-w-prose leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
        {body}
      </p>
    </div>
  );
}

function Swatch({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{ width: 8, height: 8, background: color }}
      />
      {children}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </dt>
      <dd className="text-sm font-mono mt-0.5 break-words" style={{ color: 'var(--color-text-primary)' }}>
        {value}
      </dd>
      {hint && (
        <dd className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {hint}
        </dd>
      )}
    </div>
  );
}

export type { CurveGeometry, CurveSnapshot };
