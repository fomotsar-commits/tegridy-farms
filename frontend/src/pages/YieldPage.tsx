import { useState } from 'react';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { YieldRouterPanel } from '../components/yield/YieldRouterPanel';
import { useYieldMarkets } from '../hooks/useYieldMarkets';
import { hasRoutableYieldVenue } from '../lib/yield/venues';

// YIELD ROUTING — a comparison of other people's protocols.
//
// This venue ISSUES NOTHING here. No stablecoin, no receipt token, no vault, no
// contract: every destination is a third party's, which is why each row leads
// with whose balance sheet the depositor would be standing on rather than with
// its rate.
//
// It COMPARES and does not execute, and the page says so in the one place a
// reader will look — beside the buttons that are disabled. Every deposit address
// in the catalogue is unwired (lib/yield/venues.ts), so the route controls cannot
// fire; presenting a live-looking router over dead destinations would be the
// worse product by a distance.
//
// The two sections use ONE panel component with different counterparties, so the
// rules that matter — an unread rate renders as unavailable, a peg is never
// assumed to be 1.00, and "best" is a claim only a complete comparison may make —
// are enforced in a single place for both.
//
// Plain buttons with `aria-pressed`, not a tablist. A tab whose `aria-controls`
// names a panel that is not in the DOM is an invalid-attribute finding, and both
// panels here are mutually exclusive by design.

type Section = 'staking' | 'stables';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'staking', label: 'Liquid staking' },
  { id: 'stables', label: 'Stablecoin yield' },
];

// Module constants rather than inline literals: the panel memoises its scoped
// rows on this identity, and a fresh array each render would recompute the
// ranking on every keystroke elsewhere in the tree.
const STAKING_KINDS = ['lst', 'lrt'] as const;
const STABLE_KINDS = ['stable-lending'] as const;

export default function YieldPage() {
  usePageTitle(
    'Yield Routing',
    'Compare liquid staking tokens and stablecoin lending markets by rate, peg and exit liquidity — each row naming whose risk the depositor takes, and saying so when a figure could not be read.',
  );

  const [section, setSection] = useState<Section>('staking');
  const markets = useYieldMarkets();

  return (
    <>
      <PageArtBackdrop pageId="yield" />
      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-28 md:pb-16">
        <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
          <h1 className="heading-luxury text-2xl md:text-4xl text-text-primary tracking-tight mb-2">Yield Routing</h1>
          <p className="text-[14px] text-text-secondary max-w-[680px] leading-relaxed">
            Every destination on this page belongs to{' '}
            <span className="text-text-primary font-medium">someone else</span>. The venue issues no staking token and no
            stablecoin, runs no vault here, and takes no custody — so each row names the counterparty whose solvency you
            would be trusting and the specific way that position loses money, before it shows you a rate.
          </p>
        </m.div>

        <div className="glass-card rounded-xl p-4 mb-5">
          <h2 className="text-text-primary font-semibold text-[14px] mb-2">What this page does and does not do</h2>
          <ul className="text-[13px] text-text-secondary space-y-1.5 leading-relaxed list-disc pl-4">
            <li>
              <span className="text-text-primary">Rates are read, never modelled.</span> Each figure names the source it
              was read from. A rate this venue could not read is shown as unavailable — never as 0%, which is a number
              and would be a lie.
            </li>
            <li>
              <span className="text-text-primary">The peg is a reading too.</span> A liquid staking token is not worth
              one ETH because it is called staked ETH. Where the peg could not be read the column says so; it is never
              filled in as 1.00.
            </li>
            <li>
              <span className="text-text-primary">It compares; it does not deposit.</span>{' '}
              {hasRoutableYieldVenue()
                ? 'Some destinations on this build are wired for routing; each row states its own status.'
                : 'No destination in this build has a wired deposit address, so every route control is disabled with its reason attached. Nothing on this page can move your money.'}
            </li>
          </ul>
        </div>

        <div className="flex gap-2 mb-5" role="group" aria-label="Yield category">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              aria-pressed={section === s.id}
              className={`flex-1 py-2.5 min-h-[44px] rounded-lg text-[13px] font-medium cursor-pointer transition-all ${
                section === s.id ? 'btn-primary' : 'btn-secondary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {section === 'staking' ? (
          <YieldRouterPanel
            id="yield-staking"
            heading="Liquid staking and restaking"
            intro="Rate, peg and exit liquidity side by side. The peg column is the one worth your attention: these tokens trade against ETH on a market, and the market has priced several of them under it — a fact that only shows up if somebody actually reads the price instead of assuming it."
            kinds={STAKING_KINDS}
            markets={markets}
          />
        ) : (
          <YieldRouterPanel
            id="yield-stables"
            heading="Stablecoin lending markets"
            intro="The venue issues no stablecoin and holds no deposits. These are third-party lending markets, and the rate on each is paid by that market's borrowers — it moves, and it is not a promise. Read the counterparty line before the rate."
            kinds={STABLE_KINDS}
            markets={markets}
          />
        )}

        <div className="glass-card rounded-xl p-4 mt-4">
          <h2 className="text-text-primary font-semibold text-[14px] mb-2">Buying over time instead of at once</h2>
          <p className="text-[13px] text-text-secondary leading-relaxed">
            A schedule on the{' '}
            <Link to="/swap" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
              trade
            </Link>{' '}
            page holds none of your funds — it is a reminder your own wallet acts on. Its unspent budget therefore sits
            with you, earning nothing, and the DCA panel now says how much that is and what parking it would involve.
            Neither parking nor staking happens on its own: this venue runs no keeper, and no server here holds or can
            derive your key, so every leg is a transaction you sign in an open tab.
          </p>
        </div>

        <p className="text-[12px] text-text-muted mt-4 leading-relaxed">
          None of this is advice, and inclusion here is not an endorsement — see{' '}
          <Link to="/risks" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
            Risks
          </Link>
          . Every protocol listed is audited by its own team and reviewed by nobody here; the counterparty and loss-mode
          lines are descriptions of how each position is built, not judgements about whether it will hold.
        </p>
      </div>
    </>
  );
}
