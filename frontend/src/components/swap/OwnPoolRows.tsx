import { applySlippage } from '../../lib/launcher/solana/curve/math';
import type { OwnCandidate } from '../../lib/solana/swap/ownPools';
import { ownFeeText, ownRouteText } from './ownPoolText';

/** The quote's rows when our pool takes the trade, in place of Jupiter's. */
export function OwnPoolRows({ best, slippageBps, format }: { best: OwnCandidate; slippageBps: number; format: (raw: bigint) => string }) {
  const impact = best.quote.priceImpact * 100;
  const min = applySlippage(best.quote.outAmount, BigInt(slippageBps));
  return (
    <>
      <div className="flex items-start justify-between gap-3 text-white/70">
        <span className="shrink-0">Platform fee</span>
        <span className="text-right" data-testid="own-pool-fee">{ownFeeText(best)}</span>
      </div>
      <div className="flex items-center justify-between text-white/70">
        <span>Price impact</span>
        <span className="font-mono">{impact < 0.01 ? '<0.01' : impact.toFixed(2)}%</span>
      </div>
      {min !== null && (
        <div className="flex items-center justify-between text-white/70">
          <span>Minimum received</span>
          <span className="font-mono">{format(min)}</span>
        </div>
      )}
      <div className="flex items-center justify-between text-white/70">
        <span>Route</span>
        <span className="font-mono truncate ml-2" title={best.view.address}>via {ownRouteText(best)}</span>
      </div>
    </>
  );
}
