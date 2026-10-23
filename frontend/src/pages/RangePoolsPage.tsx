import { lazy, Suspense, useEffect } from 'react';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { rangePoolsVisible } from '../lib/solana/clmm/programId';

// Lazy: the section brings the Solana wallet stack and the range program's reads.
const RangeSection = lazy(() => import('../components/solana/range/RangeSection'));

/**
 * /range-pools, the Range tab: liquidity between two prices, in the venue's own range
 * program. Listed and routed only while `rangePoolsVisible()` (clmm/programId.ts), which
 * is false for every build until the owner opens range pools; the check here keeps the
 * section unmounted even if the page is reached some other way.
 */
export default function RangePoolsPage() {
  usePageTitle('Range pools', PAGE_DESCRIPTION);
  useEffect(() => {
    trackPageView('range-pools');
  }, []);
  const open = rangePoolsVisible();
  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="swap" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.86)' }} />
      </div>
      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <m.div className="mb-4 sm:mb-6" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">Range pools.</h1>
          <p className="text-white/85 text-[15px] max-w-xl leading-relaxed">{open ? HERO_LINE : HERO_NOT_OPEN}</p>
        </m.div>
        {open && (
          <Suspense fallback={<p className="text-white/60 text-[13px]">Loading the range pools…</p>}>
            <RangeSection />
          </Suspense>
        )}
      </div>
    </div>
  );
}

const PAGE_DESCRIPTION = 'Liquidity between two prices you pick, in the venue’s own range pools on Solana, read from the chain.';
const HERO_LINE = 'Put liquidity in between two prices you pick. It earns while the price is between them.';
const HERO_NOT_OPEN = 'Range pools open here once their fee tiers are set on the network.';
