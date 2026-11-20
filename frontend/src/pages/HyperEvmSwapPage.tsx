import { useEffect } from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { ChainSwitch } from '../components/swap/ChainSwitch';
import { HyperEvmSwapCard } from '../components/hyperevm/HyperEvmSwapCard';

/** /hyperevm: the swap on our own HyperEVM pools. Routed only while HyperEVM is live (lib/chains/hyperEvm.ts). */
export default function HyperEvmSwapPage() {
  usePageTitle('HyperEVM Swap', 'Swap on HyperEVM in the venue’s own pools, on memetics.finance.');
  useEffect(() => {
    trackPageView('hyperevm-swap');
  }, []);
  return (
    <>
      {/* The Ethereum swap's surfaces until HyperEVM has its own in the studio. */}
      <PageArtBackdrop pageId="trade" />
      <div className="relative max-w-md mx-auto px-4 py-8">
        <ChainSwitch />
        <HyperEvmSwapCard />
      </div>
    </>
  );
}
