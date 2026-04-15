import { useState, useEffect, lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';

const SwapPage = lazy(() => import('./SwapPage'));
const LiquidityPage = lazy(() => import('./LiquidityPage'));

type Section = 'swap' | 'liquidity';

export default function TradePage() {
  usePageTitle('Trade');
  const [section, setSection] = useState<Section>('swap');

  // Track page view on mount
  useEffect(() => { trackPageView('trade'); }, []);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.apeHug.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        {/* Header */}
        <motion.div className="mb-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Trade</h1>
          <p className="text-white text-[13px]">Swap tokens and manage liquidity positions</p>
        </motion.div>

        {/* Section Toggle */}
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${section === 'swap' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'glass-card text-white hover:text-white'}`}
            onClick={() => setSection('swap')}
          >
            Swap
          </button>
          <button
            className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${section === 'liquidity' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'glass-card text-white hover:text-white'}`}
            onClick={() => setSection('liquidity')}
          >
            Liquidity
          </button>
        </div>

        {/* Content */}
        <motion.div key={section} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
          <Suspense fallback={<div className="text-center py-20 text-white animate-pulse">Loading...</div>}>
            {section === 'swap' && <SwapPage embedded />}
            {section === 'liquidity' && <LiquidityPage embedded />}
          </Suspense>
        </motion.div>
      </div>
    </div>
  );
}
