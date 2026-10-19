import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';

/** One section of the room's page: the id of its slot on the page, and the word the rail prints. */
export interface RoomStop {
  id: string;
  label: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The room's own index: one entry per section its page renders (HomePage.tsx names them, in page
 * order), numbered, the one on screen lit, one tap to each. Under 1440px a strip that stays under
 * the top bar while the cards scroll; from 1440px a rail fixed at the left edge, numbers and rules,
 * with the words from 1700px, where the gutter beside the 1200px column has room for them. A room
 * with one section has no index to show. No art on it: a fixed strip is never an art surface.
 */
export function RoomRail({ stops }: { stops: readonly RoomStop[] }) {
  const ref = useRef<HTMLElement>(null);
  const [here, setHere] = useState<string | null>(null);

  // The section crossing the upper part of the screen is the one you are reading.
  useEffect(() => {
    if (stops.length < 2 || typeof IntersectionObserver === 'undefined') return;
    const els = stops.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    const io = new IntersectionObserver((entries) => {
      const hit = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setHere(hit.target.id);
    }, { rootMargin: '-20% 0px -65% 0px', threshold: 0 });
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [stops]);

  if (stops.length < 2) return null;

  // A tap scrolls the section under the fixed header (and under this strip, where it is one).
  function go(e: MouseEvent<HTMLAnchorElement>, id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    const header = document.querySelector('header')?.getBoundingClientRect().height ?? 56;
    const docked = window.matchMedia('(min-width: 1440px)').matches;
    const strip = docked ? 0 : (ref.current?.getBoundingClientRect().height ?? 0) + 8;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - header - strip - 12, behavior: reduce ? 'auto' : 'smooth' });
    setHere(id);
  }

  return (
    <nav ref={ref} aria-label="On this page"
      // Sticky under the header's row until 1440px (the --rail-top var, so the docked rail's top-1/2 wins there).
      className="sticky top-[var(--rail-top)] z-30 mb-6 -mx-1 min-[1440px]:fixed min-[1440px]:left-5 min-[1440px]:top-1/2 min-[1440px]:-translate-y-1/2 min-[1440px]:m-0"
      style={{ '--rail-top': 'calc(3.5rem + env(safe-area-inset-top, 0px) + 0.5rem)' } as CSSProperties}>
      {/* The same dark glass at both sizes: the docked rail sits on full-bleed art, where bare
          cream type at 60% was not legible over a pale painting. */}
      <ol
        className="flex items-center gap-0.5 overflow-x-auto px-1.5 rounded-full border border-white/10 bg-[rgba(6,12,26,0.82)] backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(90deg,#000_calc(100%-28px),transparent)] min-[1440px]:[mask-image:none] min-[1440px]:flex-col min-[1440px]:items-start min-[1440px]:gap-0.5 min-[1440px]:overflow-visible min-[1440px]:px-3 min-[1440px]:py-2.5 min-[1440px]:rounded-2xl">
        {stops.map((s, i) => {
          const lit = here ? here === s.id : i === 0;
          return (
            <li key={s.id} className="flex-shrink-0">
              <a href={`#${s.id}`} onClick={(e) => go(e, s.id)} aria-current={lit ? 'location' : undefined}
                className={`group relative flex items-center gap-2 whitespace-nowrap min-h-[44px] px-2.5 font-mono text-[11px] tracking-[0.14em] uppercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22c55e] rounded-full min-[1440px]:min-h-0 min-[1440px]:px-0 min-[1440px]:py-1 min-[1440px]:rounded-none ${lit ? 'text-[#22c55e]' : 'text-[#f5e4b8]/60 hover:text-[#f5e4b8]'}`}>
                {/* Docked: a rule before the number, longer where you are. */}
                <span aria-hidden="true"
                  className={`hidden min-[1440px]:block h-px bg-current transition-[width] duration-500 ease-out ${lit ? 'w-7' : 'w-2.5 group-hover:w-5'}`} />
                <span aria-hidden="true" className="tabular-nums text-[10px] opacity-80">{pad(i + 1)}</span>
                {/* The word: on the strip always; docked, from 1700px, and read aloud at every width. */}
                <span className="min-[1440px]:sr-only min-[1700px]:not-sr-only">{s.label}</span>
                {/* The strip's own mark of where you are: a dot under the word. */}
                <span aria-hidden="true"
                  className={`absolute left-1/2 -translate-x-1/2 bottom-1 w-1 h-1 rounded-full bg-[#22c55e] transition-opacity min-[1440px]:hidden ${lit ? 'opacity-100' : 'opacity-0'}`} />
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
