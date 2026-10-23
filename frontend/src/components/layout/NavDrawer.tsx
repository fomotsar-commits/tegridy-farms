import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { useEffect, useRef, useState, type Ref } from 'react';
import { DASHBOARD_NAV, INDEX_GROUPS, indexName, type IndexGroup, type NavItem } from '../../lib/navConfig';
import { VENUE } from '../../lib/arrival';
import { ArtImg } from '../ArtImg';
// The menu's own look (lib/editorial.ts), the same in both themes. A full-screen index that opens
// as a circle from the menu button.
import { EDITORIAL_BG as BG, EDITORIAL_INK as INK, EDITORIAL_EASE as EASE, EDITORIAL_GRAIN as GRAIN, HEADING_FONT, pad2 as pad } from '../../lib/editorial';

// Each group's picture is `nav-drawer:N` in /art-studio (artSurfaces.ts): navConfig's INDEX_GROUPS
// carry theirs; 0 is the menu's own; Dashboard's row, once a wallet connects, is 4.
const DASHBOARD_ART = 4;

/** What the big frame shows: a picture and its caption. */
interface Shown {
  art: number;
  caption: string;
}

const isHere = (to: string, pathname: string) => pathname === to || pathname.startsWith(`${to}/`);

/** The group that owns this page, if any: lit, and the frame's picture when nothing is hovered. */
function groupHere(groups: readonly IndexGroup[], pathname: string): IndexGroup | undefined {
  return groups.find((g) => g.items.some((i) => isHere(i.to, pathname)) || (g.to !== undefined && isHere(g.to, pathname)));
}

/** The index's groups: navConfig's, Dashboard once a wallet connects, and Admin for its holder. */
function groupsFor(isConnected: boolean, showAdmin: boolean): IndexGroup[] {
  const groups = [...INDEX_GROUPS];
  const records = groups.pop()!;
  if (isConnected) groups.push({ heading: DASHBOARD_NAV.label, to: DASHBOARD_NAV.to, items: [], art: DASHBOARD_ART });
  groups.push(showAdmin ? { ...records, items: [...records.items, { to: '/admin', label: 'Admin' }] } : records);
  return groups;
}

/** "Jump to": a group whose word matches keeps every page; otherwise only the pages that match. */
function narrow(groups: readonly IndexGroup[], q: string): IndexGroup[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...groups];
  const hit = (s: string) => s.toLowerCase().includes(needle);
  return groups.flatMap((g) => {
    if (hit(g.heading)) return [g];
    const items = g.items.filter((i) => hit(indexName(g, i)) || hit(i.label) || hit(i.to.slice(1)));
    return items.length ? [{ ...g, items }] : [];
  });
}

/**
 * One page in a group: a small word with its number after it, the rule under it sweeping green
 * on hover and staying green where you are. Its ::after covers the row, so the number takes the tap.
 */
function IndexLink({ n, name, item, here, onHover, onGo }: { n: number; name: string; item: NavItem; here: boolean; onHover: () => void; onGo: () => void }) {
  return (
    // 44px rows on a phone and an iPad; 38px from 900px, where a pointer taps.
    <li className="group/page relative flex items-center gap-2 min-h-[44px] py-1.5 min-[900px]:min-h-[38px] min-[900px]:py-1 border-b border-white/[0.09]" onMouseEnter={onHover}>
      <Link to={item.to} onClick={onGo} onFocus={onHover} aria-current={here ? 'page' : undefined}
        className={`min-w-0 truncate font-black leading-tight tracking-[-0.03em] text-[17px] min-[900px]:text-[16px] transition-colors after:absolute after:inset-0 after:z-10 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[#22c55e] ${here ? 'text-[#22c55e]' : 'text-[#f5e4b8] group-hover/page:text-white'}`}
        style={HEADING_FONT}>
        {name}
      </Link>
      <span aria-hidden="true"
        className={`self-start mt-0.5 flex-shrink-0 font-mono text-[10px] tracking-[0.12em] tabular-nums transition-colors ${here ? 'text-[#22c55e]' : 'text-[#f5e4b8]/50 group-hover/page:text-[#22c55e]'}`}>
        {pad(n)}
      </span>
      <span aria-hidden="true"
        className={`absolute left-0 right-0 -bottom-px h-px origin-left pointer-events-none bg-[#22c55e] transition-transform duration-500 ease-out ${here ? 'scale-x-100' : 'scale-x-0 group-hover/page:scale-x-100'}`} />
    </li>
  );
}

/**
 * One group: its word, a link where the section's word goes (Swap follows the room), then its
 * pages two across. The word rises from under a mask; on a phone and an iPad the group's own
 * picture sits beside it (the big frame carries it from 900px).
 */
function IndexGroupBlock({ i, group, first, here, pathname, onHover, onGo }: {
  i: number; group: IndexGroup; first: number; here: boolean; pathname: string; onHover: (shown: Shown) => void; onGo: () => void;
}) {
  const id = `nav-index-${group.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const word = (
    <span className="block overflow-hidden pr-[0.08em] pb-[0.06em]">
      <m.span className="block" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ delay: 0.2 + i * 0.05, duration: 0.8, ease: EASE }}>
        {group.heading}
      </m.span>
    </span>
  );
  // Sized so "Records", the longest word, fits a third of the desktop's column.
  const wordClass = 'font-black leading-[0.95] tracking-[-0.05em] text-[clamp(1.75rem,7vw,2.5rem)] min-[600px]:text-[2.125rem]';
  return (
    <section aria-labelledby={id} className="min-w-0"
      onMouseEnter={() => onHover({ art: group.art, caption: group.heading })}>
      <div className="group/word relative flex items-end gap-3 pb-2 border-b border-white/20">
        <h2 id={id} className={`min-w-0 ${wordClass} ${here ? 'text-[#22c55e]' : 'text-[#f5e4b8]'}`} style={HEADING_FONT}>
          {group.to !== undefined ? (
            <Link to={group.to} onClick={onGo} onFocus={() => onHover({ art: group.art, caption: group.heading })} aria-current={here ? 'page' : undefined}
              className="block transition-colors hover:text-white focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#22c55e] after:absolute after:inset-0 after:content-['']">
              {word}
            </Link>
          ) : word}
        </h2>
        {group.to !== undefined && (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"
            className={`mb-[0.35em] flex-shrink-0 transition-[color,transform,opacity] duration-300 ${here ? 'text-[#22c55e]' : 'text-[#f5e4b8] opacity-0 -translate-x-2 group-hover/word:opacity-100 group-hover/word:translate-x-0 group-hover/word:text-[#22c55e]'}`}>
            <path d="M4 12h15M13 6l6 6-6 6" />
          </svg>
        )}
        {/* The group's own picture, on a phone and an iPad. */}
        <span aria-hidden="true"
          className={`ml-auto flex-shrink-0 w-12 h-12 min-[600px]:w-14 min-[600px]:h-14 overflow-hidden border min-[900px]:hidden ${here ? 'border-[#22c55e]' : 'border-white/15'}`}>
          <ArtImg pageId="nav-drawer" idx={group.art} alt="" loading="lazy" className="w-full h-full object-cover" />
        </span>
      </div>
      {/* Two across on a phone and an iPad, where the groups have the width; one column from
          900px, where the groups share the screen with the picture and a word two across clipped. */}
      {group.items.length > 0 && (
        <ul className="grid grid-cols-2 gap-x-5 min-[600px]:gap-x-6 min-[900px]:grid-cols-1">
          {group.items.map((item, j) => (
            <IndexLink key={item.to} n={first + j} name={indexName(group, item)} item={item} here={isHere(item.to, pathname)}
              onHover={() => onHover({ art: group.art, caption: indexName(group, item) })} onGo={onGo} />
          ))}
        </ul>
      )}
    </section>
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
  /** Opened with Ctrl+K / ⌘K: the cursor starts in "Jump to". A tap on the button leaves the keyboard down. */
  focusSearch: boolean;
}

function Panel({ ref, onClose, from, pathname, isConnected, showAdmin, focusSearch }: PanelProps) {
  // Read once per open. A reduced-motion visitor gets a fade, not the circle (App.tsx's
  // MotionConfig already stills the transforms for them).
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState<Shown | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);

  const all = groupsFor(isConnected, showAdmin);
  const groups = narrow(all, q);
  // Numbers run through the whole index, group after group.
  const firsts: number[] = [];
  let n = 1;
  for (const g of groups) {
    firsts.push(n);
    n += g.items.length;
  }
  const here = groupHere(all, pathname);
  const hereItem = here?.items.find((i) => isHere(i.to, pathname));
  // The frame shows what is under the pointer, else where you are, else the menu's own picture.
  const shown: Shown | null = hover ?? (here ? { art: here.art, caption: hereItem ? indexName(here, hereItem) : here.heading } : null);
  const venue = `${VENUE.markMain}${VENUE.markSub}`.toLowerCase();
  const x = from?.x ?? (typeof window === 'undefined' ? 0 : window.innerWidth - 28);
  const y = from?.y ?? 28;
  const circle = (r: number) => `circle(${r}vmax at ${x}px ${y}px)`;

  // Enter opens the first page the search left standing, else the first group's own page.
  function jump() {
    const first = groups.find((g) => g.items.length > 0)?.items[0]?.to ?? groups.find((g) => g.to !== undefined)?.to;
    if (!first) return;
    onClose();
    navigate(first);
  }

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
        style={HEADING_FONT}>
        {VENUE.markMain}
      </div>

      {/* Laid out like the top bar, so the close button lands where the menu button was. */}
      <div className="relative z-10 flex-shrink-0 mx-auto w-full page-column h-14 px-2 min-[400px]:px-3 min-[480px]:px-4 md:px-6 flex items-center justify-between gap-3">
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
        <div className="mx-auto w-full page-column min-h-full px-5 min-[480px]:px-6 pt-1 pb-10 grid content-start min-[900px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-x-16">
          <div className="min-w-0">
            <Figure art={0} caption={venue} className="min-[900px]:hidden h-[18vh] min-h-[96px] mb-6" />

            {/* Jump to: the index narrows as you type; Enter opens the first page left. */}
            <div className="relative border-b border-white/20 transition-colors focus-within:border-[#22c55e]">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"
                className="absolute left-0 top-1/2 -translate-y-1/2 text-[#f5e4b8]/60 pointer-events-none">
                <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
              </svg>
              <input ref={searchRef} type="search" value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); jump(); } }}
                aria-label="Jump to a page" placeholder="Jump to…" autoComplete="off" spellCheck={false} enterKeyHint="go"
                // The rule under the field turns green on focus; index.css's purple ring is off here
                // (.nav-index-search there: an unlayered rule, which a utility cannot outrank).
                className="nav-index-search w-full h-12 pl-7 pr-20 bg-transparent font-mono text-[15px] tracking-[0.04em] text-[#f5e4b8] placeholder:text-[#f5e4b8]/40 outline-none [&::-webkit-search-cancel-button]:appearance-none" />
              <kbd aria-hidden="true"
                className="hidden min-[900px]:inline-block absolute right-0 top-1/2 -translate-y-1/2 px-1.5 py-0.5 border border-white/15 font-mono text-[10px] tracking-[0.14em] text-[#f5e4b8]/50">
                {mac ? '⌘K' : 'CTRL K'}
              </kbd>
            </div>

            {/* The index: every section with its pages, in the order a visitor moves (navConfig
                INDEX_GROUPS); Dashboard once a wallet connects; the records last. The groups run
                in one column on a phone, two from 600px and three from 1100px. */}
            <nav aria-label="Site index" onMouseLeave={() => setHover(null)}>
              {groups.length === 0 ? (
                <p role="status" className="py-8 font-mono text-[12.5px] tracking-[0.06em] text-[#f5e4b8]/60">
                  Nothing here is called “{q.trim()}”.
                </p>
              ) : (
                <div className="grid gap-y-9 min-[600px]:grid-cols-2 min-[1100px]:grid-cols-3 gap-x-8 min-[1100px]:gap-x-9 items-start pt-3">
                  {groups.map((group, i) => (
                    <IndexGroupBlock key={group.heading} i={i} group={group} first={firsts[i]!} here={group.heading === here?.heading}
                      pathname={pathname} onHover={setHover} onGo={onClose} />
                  ))}
                </div>
              )}
            </nav>
          </div>
          <Figure art={shown?.art ?? 0} caption={shown?.caption ?? venue}
            className="hidden min-[900px]:block w-full max-w-[480px] justify-self-end sticky top-0 h-[min(64vh,600px)] pb-6" />
        </div>
      </div>
    </m.div>
  );
}

/** The menu, at every width: the site's index, grouped, with "Jump to" at its head. */
export function NavDrawer({ open, ...panel }: PanelProps & { open: boolean }) {
  return <AnimatePresence>{open && <Panel key="nav-drawer" {...panel} />}</AnimatePresence>;
}
