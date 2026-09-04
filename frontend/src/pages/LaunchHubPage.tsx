import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { LAUNCH_SECTION } from '../lib/navConfig';

// Token launch rail (Doppler V4 integration). LIVE since 2026-07-22
// (LAUNCHER_ENABLED = true); renders the create wizard. Still in-page-gated by
// isLauncherEnabled() so it can be re-gated by flipping the flag + redeploying.
const LaunchPage = lazy(() => import('./LaunchPage'));
// Our OWN EVM bonding curve (TegridyCurveLauncher). LIVE on three chains —
// Ethereum, Base and Robinhood Chain — and the page's own chain picker is what
// switches between them; see the `?c=` deep link it maintains.
const EthCurvePage = lazy(() => import('./EthCurvePage'));
// Our OWN Solana bonding curve (tegridy-launch), which graduates into our cp-swap
// fork. Since the Meteora rail was retired 2026-08-23 this is the ONLY Solana launch
// rail. NOT gated by a flag: the page probes the chain for the program on mount and
// renders "not deployed" from that live read, so it needs no redeploy to start
// working once the program ships.
const CurveLaunchPage = lazy(() => import('./CurveLaunchPage'));
// Launch simulator — preview a token's distribution band + Fact-Sheet tier before
// launching. Pure client-side, always usable (deliberately live before the launch rail).
const LaunchSimulatorPage = lazy(() => import('./LaunchSimulatorPage'));

/**
 * LaunchHubPage — the Launch section as ONE page with four tabs.
 *
 * NAMED "…Hub" rather than "LaunchPage" because LaunchPage is the Doppler rail
 * it hosts in its first tab. Two files, two jobs: this one is the strip, that
 * one is the wizard.
 *
 * The per-token records at /launch/:token and /eth-curve/:token are deliberately
 * NOT hosted here. They keep their own routes and render bare, because a
 * launched token's disclosures are a permanent shareable record and must not
 * arrive wrapped in the creator's navigation.
 */
export default function LaunchHubPage() {
  return (
    <SectionHost
      section={LAUNCH_SECTION}
      idPrefix="launch"
      ariaLabel="Launch sections"
      panels={{
        '/launch': LaunchPage,
        '/curve-launch': CurveLaunchPage,
        '/eth-curve': EthCurvePage,
        '/launch-simulator': LaunchSimulatorPage,
      }}
    />
  );
}
