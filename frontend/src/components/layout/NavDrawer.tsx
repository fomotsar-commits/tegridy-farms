import { Link, NavLink } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { useState, type Ref } from 'react';
import { DASHBOARD_NAV, DRAWER_LINKS, DRAWER_MORE, DRAWER_SECTIONS, sectionIsActive, type NavItem } from '../../lib/navConfig';
import { VENUE } from '../../lib/arrival';
import { ArtImg } from '../ArtImg';

// The menu's own look, the same in both themes: near-black, cream, and the venue's green for
// "here". A full-screen index that opens as a circle from the menu button.
const BG = '#05080f';
const INK = '#f5e4b8';
const EASE = [0.22, 1, 0.36, 1] as const;
// Film grain over the black, tiled from an inline SVG (the CSP's img-src allows data:).
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")";
// Each row's own picture: `nav-drawer:1..4` in /art-studio (artSurfaces.ts). 0 is the menu's own;
// 3, the Island row's until Island moved to the bar (2026-10-18), is the "More" list's.
const ROW_ART: Record<string, number> = { Pools: 1, Check: 2, [DASHBOARD_NAV.label]: 4 };
const MORE_ART = 3;
// The big words, sized so the longest ("Dashboard", about 5.5em in Archivo Black) fits its row.
// Phone: the width less the gutters, number and picture (~140px). Past 600px the height binds
// too, so a phone on its side keeps its rows on screen. From 900px the words share the screen
// with the picture frame, so they top out at 5.75rem.
const WORD_SIZE =
  'text-[length:clamp(2rem,calc((100vw-140px)/5.7),4rem)] min-[600px]:text-[length:clamp(2.6rem,min(10vw,12vh),6rem)] min-[900px]:text-[length:clamp(3.5rem,min(7vw,11vh),5.75rem)]';

const pad = (n: number) => String(n).padStart(2, '0');

interface Row {
  to: string;
  label: string;
  here: boolean;
  art: number;
}

/** What the big frame shows: a picture and its caption. */
interface Shown {
  art: number;
  caption: string;
}

const isHere = (to: string, pathname: string) => pathname === to || pathname.startsWith(`${to}/`);

/**
 * One big row. The number, the picture and the arrow sit beside the link, never in it, so its
 * name stays the bare word ("Pools"); its ::after covers the row, so they still take the tap.
 * On a mouse, hovering one row turns the others to outlines. The word rises from under a mask
 * on an inner span: a transform on the link would shrink the ::after to the word.
 */
function DrawerRow({ i, row, onHover, onGo }: { i: number; row: Row; onHover: (shown: Shown) => void; onGo: () => void }) {
  const ink = row.here
    ? 'text-[#22c55e] group-hover/list:text-transparent group-hover/list:[-webkit-text-stroke:1px_#22c55e] hover:text-[#22c55e]! hover:[-webkit-text-stroke:0px_transparent]!'
    : 'text-[#f5e4b8] group-hover/list:text-transparent group-hover/list:[-webkit-text-stroke:1px_rgba(245,228,184,0.45)] hover:text-white! hover:[-webkit-text-stroke:0px_transparent]!';
  return (
    <li className="group/row relative flex items-center gap-3 min-[600px]:gap-5 py-3 min-[900px]:py-4 border-b border-white/[0.09]"
      onMouseEnter={() => onHover({ art: row.art, caption: row.label })}>
      <Link to={row.to} onClick={onGo} onFocus={() => onHover({ art: row.art, caption: row.label })} aria-current={row.here ? 'page' : undefined}
        className={`flex-none whitespace-nowrap font-black leading-[0.9] tracking-[-0.055em] transition-colors duration-300 after:absolute after:inset-0 after:z-10 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[#22c55e] ${WORD_SIZE} ${ink}`}
        style={{ fontFamily: 'var(--font-family-heading)' }}>
        <span className="block overflow-hidden pr-[0.08em] pb-[0.04em]">
          <m.span className="block" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ delay: 0.24 + i * 0.07, duration: 0.85, ease: EASE }}>
            {row.label}
          </m.span>
        </span>
      </Link>
      <span aria-hidden="true"
        className={`self-start mt-[0.4em] font-mono text-[11px] min-[900px]:text-[12px] tracking-[0.12em] tabular-nums transition-colors ${row.here ? 'text-[#22c55e]' : 'text-[#f5e4b8]/60 group-hover/row:text-[#22c55e]'}`}>
        {pad(i + 1)}
      </span>
      {/* The row's own picture, on a phone and an iPad (the big frame carries it from 900px). */}
      <span aria-hidden="true"
        className={`ml-auto flex-shrink-0 w-14 h-14 min-[600px]:w-20 min-[600px]:h-20 overflow-hidden border min-[900px]:hidden ${row.here ? 'border-[#22c55e]' : 'border-white/15'}`}>
        <ArtImg pageId="nav-drawer" idx={row.art} alt="" loading="lazy" className="w-full h-full object-cover" />
      </span>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"
        className={`hidden min-[900px]:block ml-auto flex-shrink-0 transition-[color,transform,opacity] duration-300 ${row.here ? 'text-[#22c55e]' : 'text-[#f5e4b8] opacity-0 -translate-x-3 group-hover/row:opacity-100 group-hover/row:translate-x-0 group-hover/row:text-[#22c55e]'}`}>
        <path d="M4 12h15M13 6l6 6-6 6" />
      </svg>
      {/* The rule under the row sweeps green from the left on hover, and stays green where you are. */}
      <span aria-hidden="true"
        className={`absolute left-0 right-0 -bottom-px h-px origin-left pointer-events-none bg-[#22c55e] transition-transform duration-500 ease-out ${row.here ? 'scale-x-100' : 'scale-x-0 group-hover/row:scale-x-100'}`} />
    </li>
  );
}

/**
 * One feature in the "More" list: a smaller word with its number after it, as on the big rows,
 * so every word in the menu starts on one left edge. Its ::after covers the row.
 */
function DrawerMoreLink({ n, item, here, onHover, onGo }: { n: number; item: NavItem; here: boolean; onHover: () => void; onGo: () => void }) {
  return (
    <li className="group/more relative flex items-center gap-2.5 min-h-[48px] py-2 border-b border-white/[0.09]" onMouseEnter={onHover}>
      <Link to={item.to} onClick={onGo} onFocus={onHover} aria-current={here ? 'page' : undefined}
        className={`min-w-0 truncate font-black leading-tight tracking-[-0.035em] text-[19px] min-[600px]:text-[18px] min-[1100px]:text-[20px] transition-colors after:absolute after:inset-0 after:z-10 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[#22c55e] ${here ? 'text-[#22c55e]' : 'text-[#f5e4b8] group-hover/more:text-white'}`}
        style={{ fontFamily: 'var(--font-family-heading)' }}>
        {item.label}
      </Link>
      <span aria-hidden="true"
        className={`self-start mt-0.5 flex-shrink-0 font-mono text-[10px] tracking-[0.12em] tabular-nums transition-colors ${here ? 'text-[#22c55e]' : 'text-[#f5e4b8]/50 group-hover/more:text-[#22c55e]'}`}>
        {pad(n)}
      </span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"
        className={`ml-auto flex-shrink-0 transition-[color,transform,opacity] duration-300 ${here ? 'text-[#22c55e]' : 'text-[#f5e4b8] opacity-0 -translate-x-2 group-hover/more:opacity-100 group-hover/more:translate-x-0 group-hover/more:text-[#22c55e]'}`}>
        <path d="M4 12h15M13 6l6 6-6 6" />
      </svg>
      <span aria-hidden="true"
        className={`absolute left-0 right-0 -bottom-px h-px origin-left pointer-events-none bg-[#22c55e] transition-transform duration-500 ease-out ${here ? 'scale-x-100' : 'scale-x-0 group-hover/more:scale-x-100'}`} />
    </li>
  );
}

/** A small mono row (the records), its left edge on the big words' left edge. */
function DrawerSmallLink({ to, label, onGo }: { to: string; label: string; onGo: () => void }) {
  return (
    <li>
      <NavLink to={to} onClick={onGo}
        className={({ isActive }) => `inline-flex items-center min-h-[44px] md:min-h-[34px] font-mono text-[12.5px] tracking-[0.06em] underline-offset-4 transition-colors hover:text-[#22c55e] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22c55e] ${isActive ? 'text-[#22c55e]' : 'text-[#f5e4b8]/75'}`}>
        {label}
      </NavLink>
    </li>
  );
}

/** A framed picture with a museum-style caption under it. */
function Figure({ art, caption, className }: { art: number; caption: string; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      <div className="relative w-full h-full overflow-hidden border border-white/10 bg-white/[0.03]">
        <AnimatePresence initial={false}>
          <m.div key={art} className="absolute inset-0"
            initial={{ opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: EASE }}>
            {/* art-bright: nothing sits on this picture, so index.css's backdrop dimming is off. */}
            <ArtImg pageId="nav-drawer" idx={art} alt="" loading="lazy" className="w-full h-full object-cover art-bright" />
          </m.div>
        </AnimatePresence>
      </div>
      <div className="mt-2 flex justify-between gap-3 font-mono text-[11px] tracking-[0.12em] text-[#f5e4b8]/60">
        <span>fig. {pad(art)}</span>
        <span className="truncate">{caption}</span>
      </div>
    </div>
  );
}

interface PanelProps {
  ref: Ref<HTMLDivElement>;
  onClose: () => void;
  /** The centre of the menu button, where the circle opens from. */
  from: { x: number; y: number } | null;
  pathname: string;
  isConnected: boolean;
  showAdmin: boolean;
}

function Panel({ ref, onClose, from, pathname, isConnected, showAdmin }: PanelProps) {
  // Read once per open. A reduced-motion visitor gets a fade, not the circle (App.tsx's
  // MotionConfig already stills the transforms for them).
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [hover, setHover] = useState<Shown | null>(null);
  const rows: Row[] = [
    ...DRAWER_SECTIONS.map((section) => ({
      to: section.primaryTo ?? section.hub,
      label: section.heading,
      here: sectionIsActive(section, pathname),
    })),
    // Dashboard is a row only once there is an account for it to describe.
    ...(isConnected ? [{
      to: DASHBOARD_NAV.to,
      label: DASHBOARD_NAV.label,
      here: isHere(DASHBOARD_NAV.to, pathname),
    }] : []),
  ].map((row) => ({ ...row, art: ROW_ART[row.label] ?? 0 }));
  const hereRow = rows.find((r) => r.here);
  const hereMore = DRAWER_MORE.find((item) => isHere(item.to, pathname));
  // The frame shows the row under the pointer, else the row you are on, else the menu's own picture.
  const shown: Shown | null = hover
    ?? (hereRow ? { art: hereRow.art, caption: hereRow.label } : null)
    ?? (hereMore ? { art: MORE_ART, caption: hereMore.label } : null);
  const venue = `${VENUE.markMain}${VENUE.markSub}`.toLowerCase();
  const x = from?.x ?? (typeof window === 'undefined' ? 0 : window.innerWidth - 28);
  const y = from?.y ?? 28;
  const circle = (r: number) => `circle(${r}vmax at ${x}px ${y}px)`;

  return (
    <m.div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Navigation menu"
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden"
      style={{ background: BG, color: INK, textShadow: 'none', paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      initial={reduce ? { opacity: 0 } : { clipPath: circle(0) }}
      animate={reduce ? { opacity: 1, transition: { duration: 0.15 } } : { clipPath: circle(150), transition: { duration: 0.8, ease: EASE } }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.15 } } : { clipPath: circle(0), transition: { duration: 0.45, ease: [0.65, 0, 0.35, 1] } }}
    >
      <div className="absolute inset-0 pointer-events-none opacity-[0.08] mix-blend-screen" aria-hidden="true" style={{ backgroundImage: GRAIN }} />
      {/* The venue's name, outlined and cut by the bottom of the screen. textShadow is off on the
          panel: body's (index.css) would fill these hollow letters black. */}
      <div aria-hidden="true"
        className="absolute inset-x-0 bottom-0 translate-y-[34%] text-center whitespace-nowrap select-none pointer-events-none font-black leading-none tracking-[-0.06em] text-transparent text-[min(19vw,26vh)] [-webkit-text-stroke:1px_rgba(245,228,184,0.10)]"
        style={{ fontFamily: 'var(--font-family-heading)' }}>
        {VENUE.markMain}
      </div>

      {/* Laid out like the top bar, so the close button lands where the menu button was. */}
      <div className="relative z-10 flex-shrink-0 mx-auto w-full max-w-[1200px] h-14 px-2 min-[400px]:px-3 min-[480px]:px-4 md:px-6 flex items-center justify-between gap-3">
        <span className="ml-3 min-[400px]:ml-2 md:ml-0 min-w-0 flex items-center gap-2 font-mono text-[11px] tracking-[0.08em]">
          <span aria-hidden="true" className="w-1.5 h-1.5 flex-shrink-0 bg-[#22c55e]" />
          <span className="truncate"><span className="opacity-60">{venue}</span>{pathname}</span>
        </span>
        <button onClick={onClose} aria-label="Close navigation menu"
          className="group/close -mr-1 w-11 h-11 flex-shrink-0 flex items-center justify-center border border-white/20 transition-colors hover:border-[#22c55e] hover:text-[#22c55e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22c55e]">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"
            className="transition-transform duration-300 group-hover/close:rotate-90">
            <path d="M4 4l12 12M16 4L4 16" />
          </svg>
        </button>
      </div>

      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1200px] min-h-full px-5 min-[480px]:px-6 pt-2 pb-8 grid content-start min-[900px]:content-center min-[900px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-x-16">
          <div className="min-w-0">
            <Figure art={0} caption={venue} className="min-[900px]:hidden h-[24vh] min-h-[120px] mb-12" />
            {/* One row per section, its page and not its tabs: the page's strip lists them
                (owner, 2026-09-05: printed, the tabs outgrew the screen). */}
            <nav>
              <ul className="group/list border-t border-white/[0.09]" onMouseLeave={() => setHover(null)}>
                {rows.map((row, i) => (
                  <DrawerRow key={row.to} i={i} row={row} onHover={setHover} onGo={onClose} />
                ))}
              </ul>
              {/* Every feature no word names, one tap each, until they are organised (owner,
                  2026-10-18). Two columns once there is room for them. */}
              <m.div className="mt-10" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4, duration: 0.5 }}
                onMouseLeave={() => setHover(null)}>
                <div className="flex items-end justify-between gap-3 pb-3 border-b border-white/[0.09]">
                  <h2 id="nav-drawer-more" className="font-mono text-[11px] min-[900px]:text-[12px] font-normal tracking-[0.12em] uppercase text-[#f5e4b8]/60">
                    More
                  </h2>
                  {/* The list's own picture on a phone and an iPad, as each big row has one. */}
                  <span aria-hidden="true" className="flex-shrink-0 w-14 h-14 min-[600px]:w-20 min-[600px]:h-20 overflow-hidden border border-white/15 min-[900px]:hidden">
                    <ArtImg pageId="nav-drawer" idx={MORE_ART} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </span>
                </div>
                <ul aria-labelledby="nav-drawer-more" className="grid min-[600px]:grid-cols-2 gap-x-8">
                  {DRAWER_MORE.map((item, j) => (
                    <DrawerMoreLink key={item.to} n={rows.length + j + 1} item={item} here={isHere(item.to, pathname)}
                      onHover={() => setHover({ art: MORE_ART, caption: item.label })} onGo={onClose} />
                  ))}
                </ul>
              </m.div>
              <m.ul className="mt-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5, duration: 0.5 }}>
                {DRAWER_LINKS.map((link) => (
                  <DrawerSmallLink key={link.to} to={link.to} label={link.label} onGo={onClose} />
                ))}
                {showAdmin && <DrawerSmallLink to="/admin" label="Admin" onGo={onClose} />}
              </m.ul>
            </nav>
          </div>
          <Figure art={shown?.art ?? 0} caption={shown?.caption ?? venue}
            className="hidden min-[900px]:block w-full max-w-[480px] justify-self-end h-[min(64vh,600px)] pb-6" />
        </div>
      </div>
    </m.div>
  );
}

/** The menu, at every width: Pools and Check, Dashboard once connected, the More list and the records. */
export function NavDrawer({ open, ...panel }: PanelProps & { open: boolean }) {
  return <AnimatePresence>{open && <Panel key="nav-drawer" {...panel} />}</AnimatePresence>;
}
