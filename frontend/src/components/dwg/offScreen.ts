import { useEffect, useState, type RefObject } from 'react';

/** True while the drawing is off screen or its tab is hidden: its loops stand still then (dwg.css `data-dwg-paused`). */
export function useOffScreenPause(ref: RefObject<Element | null>): boolean {
  const [off, setOff] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setOff(!entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const on = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return off || hidden;
}
