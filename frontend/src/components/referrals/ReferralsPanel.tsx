import { useAccount } from 'wagmi';
import { useReferralAttribution } from '../../hooks/useReferralAttribution';
import { useReferralStanding } from '../../hooks/useReferralStanding';
import { useRevenueStats } from '../../hooks/useRevenueStats';
import { shouldWarnBeforeSharing } from '../../lib/referrals/qualification';
import { ReferralQualificationNotice } from './ReferralQualificationNotice';
import { ReferralShareCard } from './ReferralShareCard';
import { ReferralEarningsCard } from './ReferralEarningsCard';
import { ReferralAttributionCard } from './ReferralAttributionCard';

// Composition root for the referral surface. Mountable anywhere; routing it
// lives in pages/ReferralsPage.tsx.
//
// ─── ORDER IS THE FEATURE ───────────────────────────────────────────────────
//
// ReferralQualificationNotice is FIRST, above the share card, and that is not a
// layout preference. Below MIN_REFERRAL_STAKE_POWER a referrer earns nothing and
// their referees' carve is paid to the treasury instead, silently — so the only
// moment the disclosure is worth anything is before somebody shares a link.
// Discovering it under an empty claim page is discovering it after the fees are
// gone. src/components/referrals/referralsDisclosure.test.tsx pins this ordering
// as well as the text, because a future edit that moves the notice down the page
// is the same defect as deleting it.
//
// ─── WHERE EACH FACT COMES FROM ─────────────────────────────────────────────
//
// READS come from `useReferralStanding`, which maps every failed contract read
// to null and lets lib/referrals/qualification.ts collapse any null into an
// `unknown` verdict. Nothing on this surface may show a number that did not come
// off the chain.
//
// WRITES come from `useRevenueStats`, which already owns `claimReferralRewards`
// and `setReferrer` for the dashboard's ReferralWidget — including the
// chain-check, the toast lifecycle and `surfaceTxError`. Building a second write
// path over the same two contract methods would give the app two claim buttons
// with different error handling over one contract. The split is deliberate and
// asymmetric on purpose: `useRevenueStats` defaults its failed READS to `0n`,
// which is precisely the honesty defect this surface exists to fix, so not one
// figure below is sourced from it.

export function ReferralsPanel() {
  const { address, isConnected } = useAccount();
  const attribution = useReferralAttribution();
  const standing = useReferralStanding();
  const revenue = useRevenueStats();

  const connected = isConnected && !!address;
  const busy = revenue.isPending || revenue.isConfirming;

  return (
    <div className="space-y-4">
      {/* FIRST. Always. See the header. */}
      <ReferralQualificationNotice
        earn={standing.earn}
        isLoading={standing.isLoading}
        connected={connected}
        referralFeeBps={standing.referralFeeBps}
      />

      <ReferralShareCard
        address={connected ? address! : null}
        warnBeforeSharing={connected && !standing.isLoading && shouldWarnBeforeSharing(standing.earn)}
      />

      <ReferralEarningsCard
        claim={standing.claim}
        isLoading={standing.isLoading}
        connected={connected}
        referredCount={standing.referredCount}
        lifetimeEarnedWei={standing.lifetimeEarnedWei}
        forfeitedWei={standing.forfeitedWei}
        onClaim={connected ? revenue.claimReferralRewards : undefined}
        busy={busy}
      />

      <ReferralAttributionCard
        state={attribution}
        wallet={address ?? null}
        onChainReferrer={revenue.referrer}
        hasReferrer={revenue.hasReferrer}
        onLink={connected ? revenue.setReferrer : undefined}
        busy={busy}
      />
    </div>
  );
}

export default ReferralsPanel;
