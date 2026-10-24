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
  // A finger-sized press area on the price's own line: 14px of padding above and below,
  // taken back by the same negative margin, so nothing round it moves (44px on a 16px line
  // and up). `relative` paints it above the rows after it, which otherwise take a press on
  // its lower part. The keyboard's ring goes round the words (`ring-on-words`, index.css).
  return (
    <button
      type="button"
      data-testid="lp-price-flip"
      onClick={() => setPriceSide(shown === 'coin' ? 'token' : 'coin')}
      title={`Show every pool’s price per ${next}`}
      className="group relative inline-block py-3.5 -my-3.5 [text-align:inherit] hover:text-white ring-on-words cursor-pointer"
    >
      <span className="ring-words rounded-sm">
        <span className="[overflow-wrap:anywhere] underline decoration-dotted decoration-white/35 underline-offset-[3px] group-hover:decoration-white/70">{text}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="inline-block w-3 h-3 ml-1 align-[-0.1em] opacity-60" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3" />
        </svg>
      </span>
    </button>
  );
}
