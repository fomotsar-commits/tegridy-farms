// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../lib/solanaPolyfill';
import { lazy, Suspense, useEffect } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { useVenueStatus } from '../hooks/useVenueStatus';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { VenueStatusCard } from '../components/solana/VenueStatusCard';
import { lpWriteMode, type LpWriteMode } from '../lib/launcher/solana/lpWriteFlag';

// Lazy: the LP section brings the Solana wallet stack, which only a live venue needs.
const SolanaLpSection = lazy(() => import('../components/solana/lp/SolanaLpSection'));

/**
 * /solana-lp: the Pools tab that opens straight into the venue's Solana LP section (find
 * a pool, add or remove liquidity, open a pool). It is the same section /pools mounts,
 * behind the same live venue read; ?mint= opens the finder on a token, as on /pools.
 */
export default function SolanaLpPage() {
  usePageTitle(
    'Solana liquidity',
    'Find a pool, add or remove liquidity, or open a new pool on the venue’s own Solana AMM.',
  );
  useEffect(() => { trackPageView('solana-lp'); }, []);

  const { status, refresh } = useVenueStatus();
  // A capability is said in the present tense only once the read says live.
  const venueIsOpen = status?.kind === 'live';
  // Fixed for the life of a build: a production build reads only the committed constant.
  const lpMode = lpWriteMode();

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="swap" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.86)' }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <m.div className="mb-6" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">Solana LP · Venue AMM</p>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            Solana liquidity.
          </h1>
          <p className="text-white/85 text-[15px] max-w-xl leading-relaxed">
            {venueIsOpen ? HERO_LINE[lpMode] : HERO_NOT_OPEN}
          </p>
          <p className="text-[13px] mt-2">
            <Link to="/pools" className="inline-block py-2 underline underline-offset-2 text-white hover:text-white/80">
              See fees, status and how the pools work on the Venue AMM tab
            </Link>
          </p>
        </m.div>

        <VenueStatusCard status={status} onRefresh={refresh} lpMode={lpMode} />

        {venueIsOpen && (
          <Suspense fallback={<p className="text-white/60 text-[13px] mt-6">Loading the pool finder…</p>}>
            <SolanaLpSection />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// What this tab can do follows LP's own switch (lpWriteFlag.ts), as on /pools.
const HERO_LINE: Record<LpWriteMode, string> = {
  on: 'Find a pool, add or remove liquidity, or open a new pool on the venue’s own Solana AMM.',
  'withdraw-only': 'Find a pool and take your liquidity out on the venue’s own Solana AMM. Adding liquidity and opening pools from here are paused.',
  off: 'Find a pool and check its health on the venue’s own Solana AMM. Adding and removing liquidity from here is not switched on yet.',
};
const HERO_NOT_OPEN =
  'Liquidity on the venue’s own Solana AMM opens here once a chain read says the venue is open. The card below says what the latest read found.';
