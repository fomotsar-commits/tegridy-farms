import { Card } from './ui';
import { bpsPercent } from './uiFormat';

/** cp-swap rates are parts per million. 2500 → "0.25%", 120000 → "12.00%". */
const ppmPercent = (ppm: bigint) => `${(Number(ppm) / 10_000).toFixed(2)}%`;

export interface BeforeYouTradeProps {
  /** The curve's trade fee, in bps of the trade (this launch's own, or the global terms for a new one). */
  curveFeeBps: bigint;
  /** The creator's share OF the curve fee, in bps. */
  creatorShareBps: bigint;
  /** The pool's fee (cp-swap `trade_fee_rate`), ppm of the trade. `null` = not read. */
  poolFeePpm: bigint | null;
  /** The platform's cut OF the pool fee (cp-swap `protocol_fee_rate`), ppm. `null` = not read. */
  poolProtocolPpm: bigint | null;
  /** The platform reserve as words ("3.69% of the supply"), or `null` when the launch has none. */
  reserve: string | null;
  /** Inside another card (the launch review): a heading and the list, no card of its own. */
  bare?: boolean;
}

/**
 * The plain-English facts a person should have before a trade on our own curve and
 * pool: where it can be traded, who the fees go to (before and after graduation),
 * what happens to the platform reserve, and that most launches lose value. Every
 * number is read from the programs, never typed here.
 */
export function BeforeYouTrade({
  curveFeeBps,
  creatorShareBps,
  poolFeePpm,
  poolProtocolPpm,
  reserve,
  bare = false,
}: BeforeYouTradeProps) {
  const shareOk = creatorShareBps >= 0n && creatorShareBps <= 10_000n;
  const list = (
    <ul className="list-disc pl-4 space-y-1.5 text-white/80">
      <li>
        This token can be traded only on this site: on its bonding curve, then, after it graduates, in its own pool. It
        is not on Jupiter, Phantom&apos;s swap screen or price sites, so they will not show it or trade it.
      </li>
      <li>
        On the curve every trade pays a {bpsPercent(curveFeeBps)} fee
        {shareOk
          ? `: ${bpsPercent(creatorShareBps)} of it goes to the creator and ${bpsPercent(10_000n - creatorShareBps)} to the platform.`
          : '.'}{' '}
        {poolFeePpm !== null && poolProtocolPpm !== null
          ? `After graduation the pool charges ${ppmPercent(poolFeePpm)} per trade; ${ppmPercent(poolProtocolPpm)} of that goes to the platform and the rest stays in the pool. The creator gets nothing from pool trades.`
          : 'After graduation the pool charges its own fee, and the creator gets nothing from pool trades.'}
      </li>
      <li>At graduation the pool&apos;s LP tokens are burned, so its liquidity can never be pulled.</li>
      {reserve && (
        <li>
          {reserve} is held back as the platform reserve. After graduation it goes to the platform treasury, which may
          sell it.
        </li>
      )}
      <li>Most launches lose value. You can lose everything you put in.</li>
    </ul>
  );
  if (bare) {
    return (
      <div className="space-y-1.5 text-[11px]" data-testid="before-you-trade">
        <p className="text-white font-semibold">Before you (or anyone) trade it</p>
        {list}
      </div>
    );
  }
  return (
    <Card title="Before you trade" testId="before-you-trade">
      {list}
    </Card>
  );
}
