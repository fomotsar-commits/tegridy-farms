import { lazy, Suspense, useEffect } from 'react';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { rangePoolsVisible } from '../lib/solana/clmm/programId';
import { EDITORIAL_BG, EDITORIAL_EASE, EDITORIAL_GRAIN, EDITORIAL_INK, HEADING_FONT } from '../lib/editorial';

/** The second word drawn in outline, as the dashboard draws its own. */
const OUTLINE = { WebkitTextStroke: `1.5px ${EDITORIAL_INK}`, color: 'transparent' } as const;

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
      <div className="fixed inset-0 z-0" style={{ background: EDITORIAL_BG }}>
        <ArtImg pageId="swap" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(5,8,15,0.86)' }} />
        <div aria-hidden="true" className="absolute inset-0 opacity-[0.08] mix-blend-screen" style={{ backgroundImage: EDITORIAL_GRAIN }} />
      </div>
      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <m.div className="mb-6 sm:mb-8 pb-6 border-b border-white/[0.18]" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EDITORIAL_EASE }}>
          <p aria-hidden="true" className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-[#f5e4b8]/60">
            <span className="text-[#22c55e] tabular-nums">03</span>
            <span className="ml-3">Pools · Solana · between two prices</span>
          </p>
          <h1 className="font-black leading-[0.86] tracking-[-0.055em] text-[58px] sm:text-[88px] md:text-[112px] mb-4" style={{ ...HEADING_FONT, color: EDITORIAL_INK }}>
            <span>Range</span> <span style={OUTLINE}>pools.</span>
          </h1>
          <p className="text-[#f5e4b8]/85 text-[15px] max-w-xl leading-relaxed">{open ? HERO_LINE : HERO_NOT_OPEN}</p>
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
