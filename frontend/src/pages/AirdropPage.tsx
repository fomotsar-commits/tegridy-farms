import { useEffect, useState } from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { CampaignBuilder } from '../components/airdrop/CampaignBuilder';
import { ClaimPanel } from '../components/airdrop/ClaimPanel';
import { AIRDROP_FACTORY_ADDRESS, isDeployed } from '../lib/constants';

/**
 * Merkle airdrop campaigns (#65) — create and claim.
 *
 * The rail is undeployed. What that gates is exactly the transactions: the merkle
 * builder runs client-side and stays useful, because a root computed from a CSV is a
 * fact about the CSV and needs no chain. Every on-chain surface below reads its own
 * state and says when it has none.
 */
export default function AirdropPage() {
  usePageTitle('Airdrops', 'Build a merkle airdrop from a holder list, or prove eligibility and claim one.');
  const [tab, setTab] = useState<'claim' | 'create'>('claim');

  useEffect(() => {
    trackPageView('/airdrop');
  }, []);

  const live = isDeployed(AIRDROP_FACTORY_ADDRESS);

  return (
    <>
      <PageArtBackdrop pageId="airdrop" />
      <div className="relative z-10 max-w-4xl mx-auto px-4 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Airdrops</h1>
          <p className="text-white/60 text-sm mt-1 max-w-2xl leading-relaxed">
            Merkle distribution through immutable, ownerless campaign contracts. A creator funds a root; recipients
            prove a leaf. Nobody — not the factory owner, not a guardian, not us — can re-price, freeze or drain a
            campaign once it exists.
          </p>
          {!live && (
            <p className="text-amber-200/85 text-[12px] mt-3 max-w-2xl leading-relaxed">
              The airdrop factory is not deployed on this deployment. Building and verifying a tree works here anyway;
              funding and claiming do not, and the surfaces below say so where they would otherwise fire a transaction.
            </p>
          )}
        </div>

        <div className="flex gap-2 mb-6" aria-label="Airdrop views">
          {(['claim', 'create'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-4 py-2 text-[13px] border transition-colors ${
                tab === t
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-white/12 text-white/60 hover:bg-white/5'
              }`}
            >
              {t === 'claim' ? 'Claim' : 'Create a campaign'}
            </button>
          ))}
        </div>

        {tab === 'claim' ? <ClaimPanel /> : <CampaignBuilder />}

        <div className="mt-10 rounded-2xl border border-white/10 bg-black/20 p-5">
          <h2 className="text-white/80 font-semibold text-sm mb-2">How a campaign is built</h2>
          <ul className="text-white/50 text-xs space-y-1.5 leading-relaxed list-disc pl-4 marker:text-white/25">
            <li>
              The claim path is Uniswap's <code className="text-white/70">merkle-distributor</code>, vendored verbatim
              and extended by inheritance — the leaf encoding here is transcribed from that source, and a fixture pins
              both languages to one root the deployed bytecode accepts.
            </li>
            <li>
              Leaf indices come from address order, so two people with the same list build the same root. Your
              spreadsheet's row order never reaches the chain.
            </li>
            <li>
              The chain stores the root and nothing else. Publishing the manifest is part of running a campaign; a lost
              manifest makes a funded campaign unclaimable by everyone.
            </li>
            <li>
              After the window closes, unclaimed tokens return to the creator and to nobody else. There is no admin
              rescue path, because there is no admin.
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
