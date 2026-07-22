import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { LaunchSimulator } from '../components/launchSim/LaunchSimulator';

/**
 * Launch Simulator — a pre-launch DESIGN tool.
 *
 * Runs the shipped detection core over a PROPOSED allocation and the reused
 * launcher gate over a proposed structural config, so a dev can preview the
 * distribution band + Fact-Sheet tier buyers will see and fix concentration
 * BEFORE launching. It is pure client-side what-if: no wallet, no network, no
 * on-chain reads — so it is available regardless of whether the launch rail
 * itself is un-gated (it is genuinely most useful while planning a launch).
 */
export default function LaunchSimulatorPage() {
  usePageTitle('Launch Simulator', 'Preview your token’s distribution band and Fact-Sheet tier before launching — and fix concentration first.');
  useEffect(() => {
    trackPageView('/launch-simulator');
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Launch Simulator</h1>
        <p className="text-white/60 text-sm mt-1 max-w-2xl leading-relaxed">
          Preview the distribution band and Fact-Sheet tier your token would get — from a proposed allocation, before you
          launch. It runs the exact detection method and structural gate buyers will see, then shows what it takes to
          reach each band, so you can fix concentration while it is still just numbers in a form.
        </p>
        <p className="text-white/40 text-xs mt-2">
          This is a descriptive design tool, not a verdict or a guarantee. When you are ready to launch, head to the{' '}
          <Link to="/launch" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
            launch rail
          </Link>
          .
        </p>
      </div>

      <LaunchSimulator />

      <div className="mt-10 rounded-2xl border border-white/10 bg-black/20 p-5">
        <h2 className="text-white/80 font-semibold text-sm mb-2">How the score is built</h2>
        <ul className="text-white/50 text-xs space-y-1.5 leading-relaxed list-disc pl-4 marker:text-white/25">
          <li>
            Excluded categories (pools, treasuries, bridges, burn, other contracts) are removed BEFORE any concentration
            math — they are not people holding the token.
          </li>
          <li>
            The lead metric is the effective holder count (inverse-Simpson, 1 / HHI), reported as a plain sentence, with
            top-N shares, the Nakamoto coefficient and a secondary Gini alongside it.
          </li>
          <li>
            The band is a weakest-link gate over hard facts (mint / freeze authority, LP lock, a single-holder or cluster
            majority) plus a weighted blend of the softer distribution signals.
          </li>
          <li>
            Data-confidence is reported separately from the band: a strong-looking band on thin input still reads as low
            confidence, and an un-modelled bundle/sniper signal is disclosed as a gap rather than assumed to be zero.
          </li>
        </ul>
      </div>
    </div>
  );
}
