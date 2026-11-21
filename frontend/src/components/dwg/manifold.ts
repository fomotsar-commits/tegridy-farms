import { feeSplit } from '../../lib/solana/cpswap/venue';

// The Rates figure: a trade's fee as one pipe in and two out, each pipe as wide as its share.
// Pure, from a fee tier the chain returned; a tier not read draws nothing.

/** The pipe that carries the whole fee, in the drawing's units. */
export const PIPE_IN = 34;
/** The drawing's box, in its own units. */
export const MANIFOLD_BOX = { w: 520, h: 190 } as const;

export interface ManifoldWidths {
  readonly in: number;
  readonly pool: number;
  readonly venue: number;
}

type TierRates = { tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint };

/** Each pipe's width: the whole fee in, the pool's share and the venue's share out. Null with no tier read, or no fee to split. */
export function manifoldWidths(tier: TierRates | null, inWidth = PIPE_IN): ManifoldWidths | null {
  if (!tier) return null;
  const split = feeSplit(tier);
  if (!(split.tradeFeePct > 0)) return null;
  return {
    in: inWidth,
    pool: (inWidth * split.lpKeepsPct) / split.tradeFeePct,
    venue: (inWidth * split.venueTakesPct) / split.tradeFeePct,
  };
}

export interface ManifoldShape {
  /** The pipe in: from its mouth to the valve, along the middle. */
  readonly inPipe: readonly [number, number, number, number];
  readonly valve: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Each pipe out as a path, its height the centre line the stroke is laid on; null for a share of nothing. */
  readonly pool: string | null;
  readonly venue: string | null;
  /** Where each pipe's caption sits, as fractions of the box. */
  readonly captions: { readonly fee: readonly [number, number]; readonly pool: readonly [number, number]; readonly venue: readonly [number, number] };
}

/** The manifold set out in MANIFOLD_BOX for these widths. */
export function manifoldShape(widths: ManifoldWidths): ManifoldShape {
  const { w, h } = MANIFOLD_BOX;
  const x0 = 12;
  const xs = w * 0.36;
  const x1 = w - 12;
  const cy = h * 0.5;
  const py = h * 0.3;
  const vy = h * 0.78;
  const r = (n: number) => Math.round(n * 100) / 100;
  const pipe = (y: number, width: number) =>
    width > 0 ? `M${r(xs)} ${r(cy)} C ${r(xs + 60)} ${r(cy)}, ${r(x1 - 110)} ${r(y)}, ${r(x1 - 40)} ${r(y)} L ${r(x1)} ${r(y)}` : null;
  return {
    inPipe: [x0, cy, xs, cy],
    valve: { x: r(xs - 7), y: r(cy - widths.in / 2 - 7), w: 14, h: r(widths.in + 14) },
    pool: pipe(py, widths.pool),
    venue: pipe(vy, widths.venue),
    captions: {
      fee: [x0 / w, (cy - widths.in / 2 - 10) / h],
      pool: [x1 / w, (py - widths.pool / 2 - 8) / h],
      venue: [x1 / w, (vy - widths.venue / 2 - 8) / h],
    },
  };
}
