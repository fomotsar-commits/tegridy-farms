import { useLocation } from 'react-router-dom';
import { useState, useEffect, useRef, Suspense, lazy } from 'react';
import type { GlitchConfig } from '../GlitchTransition';

// Decorative: lazy, so the main chunk ships without the animation code.
const GlitchTransition = lazy(() =>
  import('../GlitchTransition').then(m => ({ default: m.GlitchTransition })),
);

const NAV_ORDER = [
  '/', '/dashboard', '/earn', '/swap', '/nft-finance', '/gallery', '/tokenomics',
  '/lore', '/community', '/premium', '/history', '/admin',
];

function getGlitchConfig(from: string, to: string): GlitchConfig {
  // By first segment, so one pool (/earn/bayla) sits where Earn does.
  const section = (path: string) => '/' + (path.split('/')[1] ?? '');
  const fromIdx = NAV_ORDER.indexOf(section(from));
  const toIdx = NAV_ORDER.indexOf(section(to));
  const direction: GlitchConfig['direction'] = toIdx > fromIdx ? 'forward' : 'backward';
  const mobile = typeof window !== 'undefined' && window.innerWidth < 768;
  if (from === '/' || to === '/') {
    return { intensity: 'heavy', direction, sliceCount: mobile ? 6 : 16, duration: 1000 };
  }
  if (Math.abs(fromIdx - toIdx) <= 1) {
    return { intensity: 'light', direction, sliceCount: mobile ? 4 : 12, duration: 1000 };
  }
  return { intensity: 'medium', direction, sliceCount: mobile ? 5 : 14, duration: 1000 };
}

/** The full-screen glitch between pages, one second on every change of path. */
export function RouteGlitch() {
  const location = useLocation();
  const [glitchConfig, setGlitchConfig] = useState<GlitchConfig | null>(null);
  const prevPath = useRef(location.pathname);
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; prevPath.current = location.pathname; return; }
    if (location.pathname !== prevPath.current) {
      const cfg = getGlitchConfig(prevPath.current, location.pathname);
      prevPath.current = location.pathname;
      setGlitchConfig(cfg);
      const t = setTimeout(() => setGlitchConfig(null), cfg.duration);
      return () => clearTimeout(t);
    }
  }, [location.pathname]);

  return glitchConfig ? (
    <Suspense fallback={null}>
      <GlitchTransition config={glitchConfig} />
    </Suspense>
  ) : null;
}
