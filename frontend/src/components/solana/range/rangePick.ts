import { useMemo, useState } from 'react';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { parsePrice, presetRange, priceNumber, rangeFromPrices, rangePrices, type Pair, type Preset, type RangeProblem, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import type { RangePool } from '../../../lib/solana/clmm/read';

/**
 * The range a visitor is picking, shared by the chart (03) and the deposit card (04): a
 * preset, two typed prices, or two edges moved on the chart (exact ticks). It belongs to one
 * pool; another pool starts empty. Moving an edge writes both prices into the fields.
 */
export interface RangePick {
  preset: Preset | null;
  minText: string;
  maxText: string;
  range: TickRange | RangeProblem | null;
  pickPreset(p: Preset): void;
  typeMin(text: string): void;
  typeMax(text: string): void;
  setEdges(r: TickRange): void;
}

interface PickState {
  pool: string;
  preset: Preset | null;
  edges: TickRange | null;
  minText: string;
  maxText: string;
}

export function useRangePick(pool: RangePool | null, pair: Pair | null): RangePick {
  const address = pool?.pool.address ?? '';
  const [state, setState] = useState<PickState | null>(null);
  const cur: PickState = state && state.pool === address ? state : { pool: address, preset: null, edges: null, minText: '', maxText: '' };
  const v = pool?.pool ?? null;

  const range = useMemo((): RangePick['range'] => {
    if (!pair || !v) return null;
    if (cur.edges) return cur.edges;
    if (cur.preset) return presetRange(pair, v, cur.preset);
    if (!cur.minText && !cur.maxText) return null;
    const min = parsePrice(cur.minText);
    const max = parsePrice(cur.maxText);
    if (!min || !max) return 'unreadable-price';
    return rangeFromPrices(pair, min, max);
  }, [cur.edges, cur.preset, cur.minText, cur.maxText, pair, v]);

  const texts = (r: TickRange) => {
    if (!pair) return { minText: '', maxText: '' };
    const p = rangePrices(pair, r);
    return { minText: formatSolPrice(priceNumber(p.min)), maxText: formatSolPrice(priceNumber(p.max)) };
  };
  return {
    preset: cur.preset,
    minText: cur.minText,
    maxText: cur.maxText,
    range,
    pickPreset: (preset) => {
      const r = pair && v ? presetRange(pair, v, preset) : null;
      setState({ ...cur, preset, edges: null, ...(r && typeof r === 'object' ? texts(r) : {}) });
    },
    typeMin: (minText) => setState({ ...cur, preset: null, edges: null, minText }),
    typeMax: (maxText) => setState({ ...cur, preset: null, edges: null, maxText }),
    setEdges: (edges) => setState({ ...cur, preset: null, edges, ...texts(edges) }),
  };
}
