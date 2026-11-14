import { useMemo, useState } from 'react';
import { parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve';
import {
  holdsNow,
  parsePrice,
  presetRange,
  priceNumber,
  rangeFromPrices,
  rangePrices,
  type DepositPlan,
  type Pair,
  type Preset,
  type TickRange,
} from '../../../lib/solana/clmm/rangeMath';
import type { PoolStateView } from '../../../lib/solana/clmm/program';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { tokenWord } from './rangeText';

/**
 * The range and the amount a deposit is planned from: a preset or two typed prices, moved to
 * usable ticks (rangeMath.ts), then an amount of ONE coin. Shared by an opening in a pool,
 * from the pool's price, and the first position of a new pool, from its opening price.
 */
export function useRangePick(pair: Pair, v: Pick<PoolStateView, 'tickCurrent' | 'sqrtPriceX64'>) {
  const [preset, setPreset] = useState<Preset | null>(null);
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [chosenSide, setChosenSide] = useState<'token' | 'coin'>('token');
  const [amountText, setAmountText] = useState('');
  const range = useMemo(() => {
    if (preset) return presetRange(pair, v, preset);
    const min = parsePrice(minText);
    const max = parsePrice(maxText);
    if (!minText && !maxText) return null;
    if (!min || !max) return 'unreadable-price' as const;
    return rangeFromPrices(pair, min, max);
  }, [preset, minText, maxText, pair, v]);
  const r: TickRange | null = range && typeof range === 'object' ? range : null;
  const holds = r ? holdsNow(pair, v, r) : null;
  const side = holds === 'token-only' ? 'token' : holds === 'coin-only' ? 'coin' : chosenSide;
  const decimals = side === 'token' ? pair.tokenDecimals : pair.quoteDecimals;
  const amount = amountText ? parseDecimalToBaseUnits(amountText, decimals) : null;
  const pick = (to: Preset) => {
    const pr = presetRange(pair, v, to);
    setPreset(to);
    if (typeof pr === 'object') {
      const prices = rangePrices(pair, pr);
      setMinText(formatSolPrice(priceNumber(prices.min)));
      setMaxText(formatSolPrice(priceNumber(prices.max)));
    }
  };
  return {
    preset,
    minText,
    maxText,
    amountText,
    range,
    r,
    holds,
    side,
    amount,
    pick,
    setMin: (t: string) => {
      setPreset(null);
      setMinText(t);
    },
    setMax: (t: string) => {
      setPreset(null);
      setMaxText(t);
    },
    setAmountText,
    setChosenSide,
  };
}

export type RangePick = ReturnType<typeof useRangePick>;

/** What is wrong with the range or the amount, in words; '' when nothing is. */
export function pickProblem(pair: Pair, p: RangePick, plan: DepositPlan | null): string {
  return p.range === 'min-not-below-max'
    ? 'The lowest price must be below the highest.'
    : p.range === 'unreadable-price'
      ? 'Type each price as a plain number, like 0.0003.'
      : p.range === 'outside-the-pool'
        ? 'That range reaches past the prices this pool can hold.'
        : p.amountText && p.amount === null
          ? `Type an amount of ${p.side === 'token' ? tokenWord(pair) : pair.quote.symbol} as a plain number.`
          : p.r && p.amount !== null && p.amount > 0n && !plan
            ? 'That amount buys nothing in this range. Try a larger amount.'
            : '';
}
