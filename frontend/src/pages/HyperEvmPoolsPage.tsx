import { lazy, Suspense, useEffect } from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// Uniswap's SDK comes with the pools section only, never with the swap or the main bundle.
const HyperEvmPoolsSection = lazy(() => import('../components/hyperevm/HyperEvmPoolsSection'));

/** /hyperevm-pools: our HyperEVM pools, your positions, add, collect, take out. Routed only while HyperEVM is live. */
export default function HyperEvmPoolsPage() {
  usePageTitle('HyperEVM Pools', 'The venue’s own Uniswap V3 pools on HyperEVM: add liquidity, earn the pool fee, collect.');
  useEffect(() => {
    trackPageView('hyperevm-pools');
  }, []);
  return (
    <>
      <PageArtBackdrop pageId="liquidity" />
      <div className="relative max-w-md mx-auto px-4 py-8">
        <Suspense fallback={<p role="status" className="text-white/70 text-[13px] py-3">Reading our pools…</p>}>
          <HyperEvmPoolsSection />
        </Suspense>
      </div>
    </>
  );
}
