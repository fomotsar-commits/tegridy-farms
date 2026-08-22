import { useEffect } from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { ReferralsPanel } from '../components/referrals/ReferralsPanel';

/**
 * Referrals — link generation, the earning requirement, the on-chain claim, and
 * the record of which link this browser is attributed to. The surface itself is
 * `components/referrals/ReferralsPanel.tsx`, which is a composition root: this
 * page supplies only the title, the analytics ping and the page frame, the way
 * AlertsPage does for AlertsPanel.
 *
 * WHY THIS IS ITS OWN ROUTE AND NOT A TAB IN A HUB. The tab hosts
 * (ActivityPage / LearnPage / InfoPage) each front a set of read-only records —
 * leaderboard, history, changelog, terms. Referrals is a wallet-bound read/write
 * tool that mints an artefact the user carries off-site and sends two permanent
 * transactions (`setReferrer` is one-time; `claimReferralRewards` moves ETH).
 * That is the shape of /alerts and /airdrop, which are standalone pages that
 * gate themselves in-page, and navConfig's own rule is that a hub gets exactly
 * one nav entry — so promoting this as a hub tab would have meant a second entry
 * into the Activity hub.
 *
 * WHAT THIS PAGE DOES NOT CONTAIN, AND WHY. There is no referral leaderboard.
 * Ranking referrers needs every referrer's earnings, which means the splitter's
 * `FeeRecorded` history — and the Ponder indexer does not subscribe to
 * ReferralSplitter at all: no entry in indexer/ponder.config.ts, no table in
 * indexer/ponder.schema.ts, no entity in the generated schema, no handler in
 * indexer/src/. `lib/referrals/splitterAbi.ts` carries view functions only and no
 * event fragments, so the history cannot be reconstructed with getLogs either.
 * The one thing that could have been ranked — wallets that opted into a database
 * row — is a directory of volunteers, and a crown on top of it would tell a
 * reader that #1 is the top referrer when that is unknowable. So the capability
 * is absent rather than approximated. See the note in lib/referrals/codesClient.ts.
 *
 * WHY THERE IS NO STATIC GATE LINE HERE. Every rail this page needs is live:
 * ReferralSplitter is deployed at REFERRAL_SPLITTER_ADDRESS and the long-form
 * `/?ref=0x…` link needs no server at all. The one optional piece — short
 * `/?r=code` links — depends on a hand-applied migration, and the share card
 * prints that store's own answer where it belongs rather than having this page
 * pre-announce a state it has not read.
 */
export default function ReferralsPage() {
  usePageTitle(
    'Referrals',
    'Share a referral link, see whether your wallet actually qualifies to earn on it, and claim what the splitter holds for you on-chain.',
  );

  useEffect(() => {
    trackPageView('/referrals');
  }, []);

  return (
    <>
      <PageArtBackdrop pageId="referrals" />
      <div className="relative z-10 max-w-4xl mx-auto px-4 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Referrals</h1>
          <p className="text-white/60 text-sm mt-1 max-w-2xl leading-relaxed">
            ReferralSplitter takes a fixed carve of a referred wallet&rsquo;s swap fee and pays it to their referrer —
            but only while that referrer&rsquo;s own staking power clears the contract&rsquo;s threshold. Everything
            below is read from that contract, and where a read fails it says so instead of showing a zero.
          </p>
        </div>

        {/* The panels below carry their own <h3> headings, so this level exists to keep
            the document from stepping h1 → h3. It is announced, not drawn. */}
        <h2 className="sr-only">Your link, your standing, your balance and your attribution</h2>
        <ReferralsPanel />

        <div className="mt-10 rounded-2xl border border-white/10 bg-black/20 p-5">
          <h2 className="text-white/80 font-semibold text-sm mb-2">What this page does and does not promise</h2>
          <ul className="text-white/50 text-xs space-y-1.5 leading-relaxed list-disc pl-4 marker:text-white/25">
            <li>
              A referrer below the staking threshold earns <strong className="text-white/70">nothing</strong>. Their
              referees still pay the same fee and the referral share still leaves it — it goes to the treasury. That is
              stated above the share controls, not under the claim.
            </li>
            <li>
              The person who follows your link gets no discount and no bonus. The splitter credits the referrer only,
              and no copy on this page or in the share text says otherwise.
            </li>
            <li>
              Balances here are <span className="font-mono">pendingETH</span> read from the splitter, passed through
              untouched. There is no projection, no estimate and no &ldquo;you could earn&rdquo; figure anywhere,
              because a referral fee depends on trades that have not happened.
            </li>
            <li>
              A read that fails renders as a failed read. An outage never appears as a zero balance, a zero referee
              count, or a verdict that you do not qualify.
            </li>
            <li>
              Attribution is first-touch and stored in this browser. A later referral link never overwrites an earlier
              one, and every link that was declined is listed rather than dropped.
            </li>
            <li>
              There is no leaderboard, because there is no honest source for one — the indexer does not track this
              contract, so nobody can say who the top referrers are.
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
