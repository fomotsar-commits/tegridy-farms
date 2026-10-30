import { priceNumber, rangePrices, type Pair, type Preset } from '../../../lib/solana/clmm/rangeMath';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { Notice, Row } from '../curve/ui';
import type { RangePick } from './rangePick';
import { priceText, tokenName, tokenWord } from './rangeText';

/** The presets, the two prices, the range they make and the amount (`useRangePick`). `at` names the price the range starts from. */
export function RangePickFields({ pair, p, busy, at }: { pair: Pair; p: RangePick; busy: boolean; at: string }) {
  const PRESETS: { id: Preset; label: string }[] = [
    { id: 'close', label: `Close to ${at}` },
    { id: 'wide', label: 'Wide' },
    { id: 'token-above', label: `${tokenName(pair)} only, above ${at}` },
    { id: 'coin-below', label: `${pair.quote.symbol} only, below` },
  ];
  const holdsLine =
    p.holds === 'token-only'
      ? `This range is above ${at}, so it holds ${tokenWord(pair)} only. It sells ${tokenWord(pair)} for ${pair.quote.symbol} as the price rises through it, and earns nothing until the price reaches it.`
      : p.holds === 'coin-only'
        ? `This range is below ${at}, so it holds ${pair.quote.symbol} only. It buys ${tokenWord(pair)} as the price falls through it, and earns nothing until the price reaches it.`
        : p.holds === 'both'
          ? `${at[0]!.toUpperCase()}${at.slice(1)} is inside this range, so it holds both coins and earns from the first swap.`
          : null;
  const per = tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair);
  const r = p.r;
  return (
    <fieldset disabled={busy} className="space-y-2 min-w-0 disabled:opacity-70">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Range presets">
        {PRESETS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={p.preset === x.id}
            className={`min-h-[44px] px-3 rounded-lg border text-[12px] ${p.preset === x.id ? 'border-emerald-300/70 bg-emerald-400/15 text-white' : 'border-white/15 bg-white/5 text-white/80 hover:text-white'}`}
            onClick={() => p.pick(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-white/70 text-[11px] mb-1">
            Lowest price ({pair.quote.symbol} per {per})
          </span>
          <input
            inputMode="decimal"
            autoComplete="off"
            className="w-full min-h-[44px] rounded-lg bg-black/40 border border-white/15 px-3 text-white text-[14px]"
            value={p.minText}
            onChange={(e) => p.setMin(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-white/70 text-[11px] mb-1">
            Highest price ({pair.quote.symbol} per {per})
          </span>
          <input
            inputMode="decimal"
            autoComplete="off"
            className="w-full min-h-[44px] rounded-lg bg-black/40 border border-white/15 px-3 text-white text-[14px]"
            value={p.maxText}
            onChange={(e) => p.setMax(e.target.value)}
          />
        </label>
      </div>
      {r && (
        <div className="space-y-1.5" data-testid="range-chosen">
          <Row label="Your range" value={`${priceText(pair, rangePrices(pair, r).min)} to ${formatSolPrice(priceNumber(rangePrices(pair, r).max))}`} mono={false} />
          <p className="text-white/45 text-[10px]">Moved to the nearest prices a position in this pool can use.</p>
          {holdsLine && <Notice tone={p.holds === 'both' ? 'info' : 'warn'}>{holdsLine}</Notice>}
        </div>
      )}
      {r && (
        <>
          {p.holds === 'both' && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Which coin you type an amount of">
              {(['token', 'coin'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={p.side === s}
                  className={`min-h-[44px] px-3 rounded-lg border text-[12px] ${p.side === s ? 'border-emerald-300/70 bg-emerald-400/15 text-white' : 'border-white/15 bg-white/5 text-white/80'}`}
                  onClick={() => p.setChosenSide(s)}
                >
                  {s === 'token' ? `Amount in ${tokenWord(pair)}` : `Amount in ${pair.quote.symbol}`}
                </button>
              ))}
            </div>
          )}
          <label className="block">
            <span className="block text-white/70 text-[11px] mb-1">
              How much {p.side === 'token' ? tokenWord(pair) : pair.quote.symbol} to put in
            </span>
            <input
              inputMode="decimal"
              autoComplete="off"
              className="w-full min-h-[44px] rounded-lg bg-black/40 border border-white/15 px-3 text-white text-[14px]"
              value={p.amountText}
              onChange={(e) => p.setAmountText(e.target.value)}
            />
          </label>
        </>
      )}
    </fieldset>
  );
}
