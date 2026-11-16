import { useEffect, useState, type RefObject } from 'react';

/**
 * How big the drawing is drawn: `now` and `tall` its width and height in CSS pixels, `first` and
 * `firstH` the same in device pixels at its first measure (0 until then), so a picture's copy is
 * chosen once per page view. Measured as it mounts (a browser drawing no frames reports no resize)
 * and on every resize. The height is the one laid out: a skew on an element round it stretches its
 * box's height, never its width, so the box's height stands in only where no layout height is read.
 */
export function useDrawnWidth(host: RefObject<SVGSVGElement | null>): { now: number; tall: number; first: number; firstH: number } {
  const [drawn, setDrawn] = useState({ now: 0, tall: 0, first: 0, firstH: 0 });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const px = box.width;
      if (px > 0) {
        const dpr = window.devicePixelRatio || 1;
        const tall = parseFloat(window.getComputedStyle(el).height) || box.height;
        setDrawn((d) => (d.now === px && d.tall === tall ? d
          : { now: px, tall, first: d.first || px * dpr, firstH: d.firstH || tall * dpr }));
      }
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [host]);
  return drawn;
}
