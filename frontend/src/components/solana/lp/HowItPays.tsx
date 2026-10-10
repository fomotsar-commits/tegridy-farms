import { PUBLIC_TIER_INDEX } from '../../../lib/solana/cpswap/program';
import { SOLANA_FEE_ACCOUNT, SOLANA_PLATFORM_FEE_BPS, isSolanaFeeConfigured } from '../../../lib/solana';
import { EARN_TITLES, howVenueEarns, howYouEarn, type JupiterFee } from '../../../lib/solana/lp/earnCopy';
import type { FeeTierRead } from '../../../lib/solana/lp/poolFinder';
import { Card, Notice } from '../curve/ui';
import { AddressRow } from './AddressRow';
import { explorerOf } from './panelKit';
import { useLpWrites } from './useLpWrites';

/** The swap's own fee as jupiter.ts takes it: only with a wallet to pay and a rate above zero. */
const BUILD_JUPITER_FEE: JupiterFee | null =
  isSolanaFeeConfigured() && SOLANA_PLATFORM_FEE_BPS > 0 ? { bps: SOLANA_PLATFORM_FEE_BPS, wallet: SOLANA_FEE_ACCOUNT } : null;

const LINE = 'text-white/80 text-[12px]';

/**
 * Two short cards on the LP section: how a liquidity provider earns, and how the venue
 * does (earnCopy.ts holds the words). The rates are the public fee tier's from the
 * section's one tier read, the same answer the Fee tiers card prints; until it is in, or
 * when it failed, the sentences carry no number and one line under them says why.
 */
export function HowItPays({ read, jupiterFee = BUILD_JUPITER_FEE }: { read: FeeTierRead | null; jupiterFee?: JupiterFee | null }) {
  const tier = read?.kind === 'ok' ? read.tiers.find((t) => t.index === PUBLIC_TIER_INDEX && t.state === 'live')?.config ?? null : null;
  const venue = howVenueEarns(tier, jupiterFee);
  const explorer = explorerOf(useLpWrites());
  // Three states with no rate, kept apart: still reading, a read that failed, a tier that is not there.
  const noRate = tier
    ? null
    : read === null
      ? 'Reading the rates from the chain…'
      : read.kind === 'unread'
        ? 'The fee tiers could not be read just now, so no rate is shown here.'
        : 'There is no public fee tier to read yet, so no rate is shown here.';
  return (
    <section data-testid="lp-how-it-pays" aria-label="How you earn, and how the venue earns" className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card title={EARN_TITLES.you} testId="lp-how-you-earn">
        {howYouEarn(tier).map((line) => (
          <p key={line} className={LINE}>
            {line}
          </p>
        ))}
      </Card>
      <Card title={EARN_TITLES.venue} testId="lp-how-venue-earns">
        <ul className={`list-disc pl-4 space-y-1 ${LINE}`}>
          {venue.sources.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {venue.where && <p className={LINE}>{venue.where}</p>}
        {venue.wallets.map((w) => (
          <AddressRow key={w.label} label={w.label} value={w.address} explorerUrl={explorer(w.address)} />
        ))}
      </Card>
      {/* Said once, for both cards. */}
      {noRate && (
        <div data-testid="lp-no-rate" className="md:col-span-2 px-1 text-[12px]">
          <Notice tone={read?.kind === 'unread' ? 'warn' : 'info'}>{noRate}</Notice>
        </div>
      )}
    </section>
  );
}
