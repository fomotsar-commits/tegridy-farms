import { NO_SITE_FEE_ROUTE_COPY } from '../../lib/solana/swap/jupiterFeeRetry';

/**
 * The "Platform fee" row of the Solana swap's quote details.
 *
 * `waived` is true only while the quote on screen is the no-fee re-quote the
 * send path took after Jupiter's 6014 (lib/solana/swap/jupiterFeeRetry.ts).
 * Then the row says so in plain words, and the sentence is announced, because
 * the amounts above it have just changed to that re-quote.
 */
export function SiteFeeRow({ feePct, feeMintSymbol, waived }: {
  feePct: string;
  /** The token the fee is taken in on this pair, or null when the pair carries none. */
  feeMintSymbol: string | null;
  waived: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between text-white/70">
        <span>Platform fee</span>
        <span className="font-mono" data-testid="site-fee-value">
          {waived ? 'None on this route' : feeMintSymbol ? `${feePct}% · in ${feeMintSymbol}` : 'None on this pair'}
        </span>
      </div>
      {waived && (
        <p role="status" data-testid="site-fee-waived" className="text-amber-300">
          {NO_SITE_FEE_ROUTE_COPY}
        </p>
      )}
    </>
  );
}
