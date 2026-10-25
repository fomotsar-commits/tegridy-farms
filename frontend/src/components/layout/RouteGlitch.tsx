import { useLocation } from 'react-router-dom';
import { useState, useEffect, useRef, Suspense, lazy } from 'react';
import type { GlitchConfig } from '../GlitchTransition';
import { BUNGALOWS, bungalowLpDoor } from '../../lib/bungalows';

// Decorative: lazy, so the main chunk ships without the animation code.
const GlitchTransition = lazy(() =>
  import('../GlitchTransition').then(m => ({ default: m.GlitchTransition })),
);

const NAV_ORDER = [
  '/', '/dashboard', '/earn', '/swap', '/nft-finance', '/gallery', '/tokenomics',
  '/lore', '/community', '/premium', '/history', '/admin',
];

// By first segment, so one pool (/earn/bayla) sits where Earn does.
const section = (path: string) => '/' + (path.split('/')[1] ?? '');

// The LP road, a room to a signed add: every room with an Add door, and the Pools pages.
const LP_ROAD = new Set([
  '/pools', '/range-pools', '/liquidity', '/zap', '/solana-lp',
  ...BUNGALOWS.filter((b) => bungalowLpDoor(b)).map((b) => `/${b.id}`),
]);

/** A phone held either way: the site's phone width, or a touch screen whose short side is under it. */
function onPhone(): boolean {
  if (window.innerWidth < 768) return true;
  const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return touch && Math.min(window.innerWidth, window.innerHeight) < 768;
}

function getGlitchConfig(from: string, to: string): GlitchConfig {
  const fromIdx = NAV_ORDER.indexOf(section(from));
  const toIdx = NAV_ORDER.indexOf(section(to));
  const direction: GlitchConfig['direction'] = toIdx > fromIdx ? 'forward' : 'backward';
  if (from === '/' || to === '/') return { intensity: 'heavy', direction, sliceCount: 16, duration: 1000 };
  if (Math.abs(fromIdx - toIdx) <= 1) return { intensity: 'light', direction, sliceCount: 12, duration: 1000 };
  return { intensity: 'medium', direction, sliceCount: 14, duration: 1000 };
}

/**
 * The full-screen glitch between pages, one second on a change of path. Never on a phone, and
 * never into or out of the LP road (owner, 2026-10-25): those pages just open.
 */
export function RouteGlitch() {
  const location = useLocation();
  const [glitchConfig, setGlitchConfig] = useState<GlitchConfig | null>(null);
  const prevPath = useRef(location.pathname);
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; prevPath.current = location.pathname; return; }
    if (location.pathname !== prevPath.current) {
      const from = prevPath.current;
      prevPath.current = location.pathname;
      if (onPhone() || LP_ROAD.has(section(from)) || LP_ROAD.has(section(location.pathname))) return;
      const cfg = getGlitchConfig(from, location.pathname);
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
