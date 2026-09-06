import { Link } from 'react-router-dom';
// FROM ./registry, NOT the ../../lib/chains barrel — deliberate, and the same
// import the repo already uses in ContractsPage and CurveTokenPage. The barrel
// re-exports viemChains (index.ts:23), which imports `fallback` from wagmi, so
// pulling it into a component drags a viem TRANSPORT into every consumer's
// module graph. That is not theoretical: it broke TradePage.trigger.test.tsx,
// whose wagmi mock has no `fallback` export — and it broke it as a suite that
// would not LOAD, which reports as 'all passed' with one fewer file.
import { getChainConfig } from '../../lib/chains/registry';

/**
 * Says WHY the swap form is inert on a chain the app serves but cannot swap on.
 *
 * 🔴 THE DEFECT THIS EXISTS FOR. Connect to Base or Robinhood and the swap page
 * went quietly dead: every quote read is disabled by the `chainId === CHAIN_ID`
 * gate, `outputAmount` falls to 0n, the CTA disables itself and its label stays
 * the plain word "Swap". No error, no explanation. The global wrong-network
 * banner does NOT cover it either — that fires on UNCONFIGURED chains
 * (AppLayout reads `!isChainConfigured`), and Base and Robinhood are both
 * configured. So the one state the app had no words for was the one a real
 * visitor on an L2 actually hit.
 *
 * IT DOES NOT PROMISE ANYTHING. types.ts already records why: "a UI that shows
 * 'coming soon' for a chain nobody has decided to launch on is making a promise
 * the roadmap has not made." This says what is true today and what works
 * instead — the curve, which IS live on both L2s (registry `curveLauncher`) —
 * and stops there.
 *
 * IT READS A CAPABILITY, NOT AN ADDRESS. `capabilities.ammSwap` is the whole
 * gate. Inferring from `contracts.router != null` is what produced the silence:
 * the router IS deployed on both L2s. Deployed and usable are different claims.
 */
export function ChainSwapAvailability({ chainId }: { chainId: number | undefined | null }) {
  const config = getChainConfig(chainId);

  // Unconfigured chain → the app-wide wrong-network banner owns that state, and
  // two banners saying different things about one wallet is worse than one.
  if (!config) return null;
  // The chain can swap. Nothing to explain.
  if (config.capabilities.ammSwap) return null;

  const curveHref = `/eth-curve?c=${config.id}`;

  return (
    <div
      className="mb-4 rounded-xl border p-4"
      style={{
        background: 'rgba(245, 158, 11, 0.08)',
        borderColor: 'rgba(245, 158, 11, 0.30)',
      }}
      role="status"
    >
      <p className="text-amber-200 text-[13px] font-semibold mb-1">
        Swapping is not live on {config.name} yet
      </p>
      <p className="text-white/70 text-[12px] leading-relaxed">
        The venue&rsquo;s router and factory are deployed on {config.name}, but no pair has been
        created here yet — so there is nothing to quote a price against. This form reads
        Ethereum only, which is why it stays empty rather than showing you a number it cannot
        fill.
      </p>
      <div className="mt-3 flex flex-wrap gap-3 text-[12px]">
        <Link to={curveHref} className="text-emerald-300 hover:text-emerald-200 underline">
          Trade on the {config.name} curve &rarr;
        </Link>
        <Link to="/swap" className="text-white/60 hover:text-white/80 underline">
          Switch your wallet to Ethereum to swap
        </Link>
      </div>
    </div>
  );
}
