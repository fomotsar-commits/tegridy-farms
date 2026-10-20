import { perCoinText, priceText } from '../../../lib/solana/lp/format';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { setPriceSide, usePriceSide } from './priceSide';

/**
 * A pool's price, said the way the switch is set, as a button that turns every pool's
 * price round. A price that cannot be turned round (zero, unreadable) is plain text.
 */
export function PriceFlip({ perToken, quote, unit }: { perToken: number; quote: QuoteCoin; unit: { one: string; many: string } }) {
  const shown = usePriceSide();
  const turned = perCoinText(perToken, quote, unit.many);
  const plain = priceText(perToken, quote, unit.one);
  if (turned === null) return <>{plain}</>;
  const text = shown === 'coin' ? turned : plain;
  const next = shown === 'coin' ? `1 ${unit.one}` : `1 ${quote.symbol}`;
  return (
    <button
      type="button"
      data-testid="lp-price-flip"
      onClick={() => setPriceSide(shown === 'coin' ? 'token' : 'coin')}
      title={`Show every pool’s price per ${next}`}
      className="group inline-block -my-1 py-1 [text-align:inherit] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 rounded-sm cursor-pointer"
    >
      <span className="[overflow-wrap:anywhere] underline decoration-dotted decoration-white/35 underline-offset-[3px] group-hover:decoration-white/70">{text}</span>
      <svg aria-hidden="true" viewBox="0 0 16 16" className="inline-block w-3 h-3 ml-1 align-[-0.1em] opacity-60" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3" />
      </svg>
    </button>
  );
}
