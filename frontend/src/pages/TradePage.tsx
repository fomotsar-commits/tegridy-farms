import { useState, lazy, Suspense } from 'react';
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
  useState(() => { trackPageView('trade'); });

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.apeHug.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.4) 25%, rgba(0,0,0,0.65) 55%, rgba(0,0,0,0.88) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-20 pb-12">
        {/* Header */}
        <motion.div className="mb-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Trade</h1>
          <p className="text-white/50 text-[13px]">Swap tokens and manage liquidity positions</p>
        </motion.div>

        {/* Section Toggle */}
        <div className="flex gap-2 mb-6">
          <button
            className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${section === 'swap' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'glass-card text-white/60 hover:text-white'}`}
            onClick={() => setSection('swap')}
          >
            Swap
          </button>
          <button
            className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${section === 'liquidity' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'glass-card text-white/60 hover:text-white'}`}
            onClick={() => setSection('liquidity')}
          >
            Liquidity
          </button>
        </div>

        {/* Content */}
        <motion.div key={section} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
          <Suspense fallback={<div className="text-center py-20 text-white/40 animate-pulse">Loading...</div>}>
            {section === 'swap' && <SwapPage embedded />}
            {section === 'liquidity' && <LiquidityPage embedded />}
          </Suspense>
        </motion.div>
      </div>
    </div>
  );
}
