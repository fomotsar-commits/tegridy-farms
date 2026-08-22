import { usePageTitle } from '../hooks/usePageTitle';
import { PricingTiers } from '../components/developer/PricingTiers';
import { EndpointReference } from '../components/developer/EndpointReference';
import { ErrorSemantics } from '../components/developer/ErrorSemantics';
import { ApiKeyPanel } from '../components/developer/ApiKeyPanel';
import { useApiPlatformStatus } from '../components/developer/useApiPlatformStatus';

/**
 * The developer surface for the keyed /api/v1 layer.
 *
 * Two rules shape this page:
 *
 *   1. Nothing here is typed copy that duplicates a runtime number. Tiers, routes
 *      and refusal codes are rendered from api/_lib/apiTiers.js — the same module
 *      the limiter and the auth layer enforce — so a documented limit and an
 *      enforced limit cannot drift apart.
 *   2. What this DEPLOYMENT can do is read from /api/v1?route=status at runtime,
 *      never assumed. A build with no key store must not render a working signup,
 *      and a status endpoint we could not reach must not render as either state.
 */
export default function DeveloperPage() {
  usePageTitle(
    'Developer API',
    'Keyed token-scan and NFT data API — tiers, endpoints, and what every failure means.',
  );
  const status = useApiPlatformStatus();

  return (
    <div className="max-w-5xl mx-auto px-4 py-10 space-y-12">
      <header>
        <h1 className="text-4xl font-bold mb-3">Developer API</h1>
        <p className="opacity-80 max-w-3xl">
          The same holder-distribution read the scanner runs, served under a key with a per-tier
          rate limit and a monthly quota. Responses state what was read and where it came from, and
          a failed read is never dressed up as a clean one.
        </p>
      </header>

      {/*
        Placed first and unconditional. The whole value of a trust API is that its
        silence is trustworthy, so the reader should meet that promise before the
        price list rather than after it.
      */}
      <ErrorSemantics />

      <EndpointReference />

      <PricingTiers />

      <ApiKeyPanel status={status} />

      <section aria-labelledby="operator-heading" className="text-sm opacity-75">
        <h2 id="operator-heading" className="text-lg font-semibold mb-2">
          Current limits of this deployment
        </h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Scanning covers Ethereum ERC-20 holder distribution. Deployer reputation, wallet
            exposure and launch simulation run in the app and are not sold here yet.
          </li>
          <li>
            Keyed calls are refused unless usage metering is configured. There is no unmetered paid
            path, degraded or otherwise.
          </li>
          <li>
            No payment processor is connected. Paid tiers exist in the catalog so integrators can
            model cost; only the free tier can be issued.
          </li>
        </ul>
      </section>
    </div>
  );
}
