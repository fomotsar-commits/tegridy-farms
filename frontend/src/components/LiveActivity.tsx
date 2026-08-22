import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { m } from 'framer-motion';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { useProtocolHealth } from '../hooks/useProtocolHealth';
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
  const { priceInUsd, isLoaded, displayPriceStale } = useTOWELIPrice();
  const { history: priceData } = usePriceHistory();
  const health = useProtocolHealth();

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 2000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;
  if (HIDE_ON_ROUTES.has(pathname)) return null;

  // A cached price older than the display window is not a quote. The pill sits
  // one glance away from the swap button, so it shows the number only while the
  // number is current; the health label carries the reason when it isn't.
  const displayPrice = isLoaded && priceInUsd > 0 && !displayPriceStale
    ? formatCurrency(priceInUsd, 6)
    : null;

  // The pulsing ring reads as "live". It is reserved for the one state a
  // successful chain read licenses; every other state gets a still dot, so a
  // degraded or unverified venue can never animate like a healthy one.
  const isLive = health.status === 'active';

  return (
    <m.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="fixed bottom-4 right-24 z-40 hidden md:block"
      style={{ pointerEvents: 'none' }}
      aria-live="polite"
      aria-label={`Protocol status: ${health.label}. ${health.basis}`}
    >
      <div
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
        title={health.basis}
        style={{
          // The wrapper stays click-through; the pill itself takes pointer events
          // back so the basis tooltip is reachable. A disclosure nobody can open
          // is not a disclosure. Scoped to the pill's own ~220x34px box in the
          // bottom-right on md+ only, clear of the assistant avatar (F49).
          pointerEvents: 'auto',
          background: 'rgba(6, 12, 26, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--color-purple-15)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.65), 0 0 10px var(--color-purple-10)',
          maxWidth: 220,
        }}
      >
        {isLive ? (
          <PulseDot color={health.color} size={6} />
        ) : (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              margin: 6,
              borderRadius: '50%',
              backgroundColor: health.color,
              flexShrink: 0,
            }}
          />
        )}
        <span className="text-[11px] text-white whitespace-nowrap">{health.label}</span>
        {displayPrice && (
          <>
            {/* F176/F233: a bare currency figure beside a status word reads as
                the protocol's balance. Name the asset it prices. */}
            <span className="text-[11px] font-mono text-white whitespace-nowrap">
              TOWELI {displayPrice}
            </span>
            {priceData.length > 1 && (
              <Sparkline data={priceData} width={36} height={12} />
            )}
          </>
        )}
      </div>
    </m.div>
  );
}
