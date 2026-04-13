import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { formatCurrency } from '../lib/formatting';
import { Sparkline } from './Sparkline';
import { PulseDot } from './PulseDot';

export function LiveActivity() {
  const [visible, setVisible] = useState(false);
  const { priceInUsd, isLoaded } = useTOWELIPrice();
  const { history: priceData } = usePriceHistory();

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 2000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const displayPrice = isLoaded && priceInUsd > 0
    ? formatCurrency(priceInUsd, 6)
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="fixed bottom-4 right-4 z-40 hidden md:block"
      style={{ pointerEvents: 'none' }}
    >
      <div
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
        style={{
          background: 'rgba(6, 12, 26, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(139, 92, 246, 0.15)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.65), 0 0 10px rgba(139,92,246,0.1)',
          maxWidth: 200,
        }}
      >
        <PulseDot color="#22c55e" size={6} />
        <span className="text-[11px] text-white whitespace-nowrap">Protocol Active</span>
        {displayPrice && (
          <>
            <span className="text-[11px] font-mono text-white whitespace-nowrap">{displayPrice}</span>
            {priceData.length > 1 && (
              <Sparkline data={priceData} width={36} height={12} />
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
