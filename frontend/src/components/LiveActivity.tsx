import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { m } from 'framer-motion';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { formatCurrency } from '../lib/formatting';
import { Sparkline } from './Sparkline';
import { PulseDot } from './PulseDot';

// AUDIT 2026-05-30 (iPad re-pass): hide the floating "Protocol Active" pill on
// long-form info / legal / policy routes where the agent found it overlapping
// body content (/treasury balance value, /lore body, /terms /privacy /risks copy,
// /community footer, /changelog entries, etc.). Transactional + landing pages
// keep the pill — the overlap only matters on prose-heavy surfaces.
const HIDE_ON_ROUTES: ReadonlySet<string> = new Set([
  '/security', '/risks', '/terms', '/privacy', '/lore', '/changelog',
  '/contracts', '/treasury', '/tokenomics', '/faq', '/community',
]);

export function LiveActivity() {
  const { pathname } = useLocation();
  const [visible, setVisible] = useState(false);
  const { priceInUsd, isLoaded } = useTOWELIPrice();
  const { history: priceData } = usePriceHistory();

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 2000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;
  if (HIDE_ON_ROUTES.has(pathname)) return null;

  const displayPrice = isLoaded && priceInUsd > 0
    ? formatCurrency(priceInUsd, 6)
    : null;

  return (
    <m.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="fixed bottom-4 right-24 z-40 hidden md:block"
      style={{ pointerEvents: 'none' }}
      aria-live="polite"
      aria-label="Live protocol status"
    >
      <div
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
        style={{
          background: 'rgba(6, 12, 26, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--color-purple-15)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.65), 0 0 10px var(--color-purple-10)',
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
    </m.div>
  );
}
