import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { BUNGALOWS } from '../lib/bungalows';
import { doorArt } from '../lib/doorArt';
import { artSrcSet } from '../lib/artSrcSet';
import { MIN_BOOST_BPS, MAX_BOOST_BPS } from '../lib/constants';
import { CHAIN_LABEL, hasLadder, rowTerms, venuePoolRows, type VenuePoolRow } from '../lib/venuePools';
import { EDITORIAL_BG, EDITORIAL_EASE, EDITORIAL_GRAIN, EDITORIAL_INK, HEADING_FONT, pad2 } from '../lib/editorial';
import { CardArt } from './ui/CardArt';
import { FinePrint } from './ui/FinePrint';

/**
 * The island's dashboard (owner, 2026-10-21: "give it an avantegarde upgrade" and "put the
 * dashboard on top of" the home's three cards). It renders on the venue home, above the cards,
 * and as the venue's /dashboard page.
 *
 * The menu's editorial look (lib/editorial.ts): a numbered index of every pool on the island in
 * heavy type, hairlines, mono captions, hard corners, grain. Each row carries its resident's door
 * picture: on a phone beside the word, from 1024px in a big frame that follows the pointer.
 *
 * It reads no chain, as /earn's index reads none (VenuePoolIndex.tsx says why): every row, count
 * and term comes from the registry (lib/venuePools.ts). A rate is read inside each room, where a
 * failed read can say so.
 */

const GREEN = '#22c55e';
// The home's chain pills' own colors (HomePage.tsx), so a chain reads the same everywhere.
const CHAIN_DOT: Record<string, string> = { solana: '#4CAF50', ethereum: '#8b5cf6', base: '#2151f5' };
// An outlined word: body's text-shadow (index.css) would fill the hollow letters black.
const OUTLINE = { WebkitTextStroke: `1.5px ${EDITORIAL_INK}`, color: 'transparent', textShadow: 'none' } as const;

function prefersReducedMotion(): boolean {
  // matchMedia, not framer's hook: the page tests mock framer-motion without it.
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function doorOf(id: string) {
  const b = BUNGALOWS.find((x) => x.id === id);
  return b ? doorArt(b) : null;
}

/**
 * The lock ladder drawn to scale: every staking program on the island grows a lock's share in a
 * straight line, from the floor at seven days to the ceiling at four years (lib/ladder/program.ts
 * boostBpsForLock, lib/lighthouseLadder.ts boostBpsFor, TegridyStaking.sol calculateBoost).
 */
function LadderWedge({ className = '' }: { className?: string }) {
  const h = 14;
  const floor = (MIN_BOOST_BPS / MAX_BOOST_BPS) * h;
  return (
    <svg width="40" height={h} viewBox={`0 0 40 ${h}`} aria-hidden="true" className={`flex-shrink-0 ${className}`}>
      <path d={`M0 ${h} L40 ${h} L40 0 L0 ${h - floor} Z`} fill="currentColor" />
    </svg>
  );
}

function ChainMark({ chain }: { chain: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="w-1.5 h-1.5 flex-shrink-0" style={{ background: CHAIN_DOT[chain] ?? EDITORIAL_INK }} />
      {CHAIN_LABEL[chain] ?? chain}
    </span>
  );
}

/** The pool's terms. Never cut: "0.40×–4.00×" with its ceiling cut off would misstate the ladder. */
function Terms({ terms }: { terms: string }) {
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      {hasLadder(terms) && <LadderWedge className="text-[#f5e4b8]/70 group-hover/row:text-[#22c55e] transition-colors" />}
      <span className="whitespace-nowrap">{rowTerms(terms)}</span>
    </span>
  );
}

/** One pool: its number, its word, its chain and terms, and the door into its room. */
function PoolRow({ n, row, onShow }: { n: number; row: VenuePoolRow; onShow: () => void }) {
  const door = doorOf(row.id);
  // The 44px thumbnail takes the smallest derivative, as the hall's doors do (VenueDoors.tsx):
  // a door's source is up to 2048px wide, and a phone draws twelve of them here.
  const thumbSet = door ? artSrcSet(door.src) : undefined;
  return (
    <li>
      {/* A real link to the pool's own address, /earn/<id>, which enters its room on arrival
          (App.tsx EarnPoolRoute). The whole row is the target. */}
      <Link
        to={`/earn/${row.id}`}
        aria-label={`Open ${row.symbol}`}
        onMouseEnter={onShow}
        onFocus={onShow}
        className="group/row relative grid items-center gap-x-3 md:gap-x-4 lg:gap-x-5 grid-cols-[2.75rem_minmax(0,1fr)_2.5rem] md:grid-cols-[2.75rem_1.5rem_minmax(0,1fr)_6.5rem_13rem_2.75rem] lg:grid-cols-[2rem_minmax(0,1fr)_6.5rem_13.5rem_2.75rem] min-h-[64px] py-2.5 pl-0 md:pl-3 border-b border-white/[0.10] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#22c55e]"
        style={{ color: EDITORIAL_INK }}
      >
        {/* The resident's color, rising up the row's edge on hover. */}
        <span aria-hidden="true"
          className="absolute left-0 top-0 bottom-0 w-[3px] origin-bottom scale-y-0 transition-transform duration-300 ease-out group-hover/row:scale-y-100 group-focus-visible/row:scale-y-100"
          style={{ background: row.accent ?? GREEN }} />
        {/* The rule under the row sweeps green, as the menu's do. */}
        <span aria-hidden="true"
          className="absolute left-0 right-0 -bottom-px h-px origin-left scale-x-0 bg-[#22c55e] transition-transform duration-500 ease-out group-hover/row:scale-x-100 group-focus-visible/row:scale-x-100" />

        {/* Under 1024px: the door's picture beside the word. From 1024px the big frame shows it. */}
        <span aria-hidden="true" className="lg:hidden relative w-11 h-11 overflow-hidden border border-white/15">
          {door && (
            <img src={door.src} {...(thumbSet ? { srcSet: thumbSet, sizes: '44px' } : {})} alt="" loading="lazy" decoding="async" width={44} height={44}
              className="w-full h-full object-cover" style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined} />
          )}
        </span>
        <span aria-hidden="true"
          className="hidden md:block self-start pt-1 font-mono text-[11px] tracking-[0.12em] tabular-nums text-[#f5e4b8]/45 transition-colors group-hover/row:text-[#22c55e]">
          {pad2(n)}
        </span>

        <span className="min-w-0">
          <span className="block truncate font-black leading-[0.95] tracking-[-0.045em] text-[24px] md:text-[28px] lg:text-[34px] transition-[transform,color] duration-300 ease-out group-hover/row:translate-x-1.5 group-hover/row:text-white"
            style={HEADING_FONT}>
            {row.symbol}
          </span>
          {/* A phone: the chain and the terms under the word, the terms on a line of their own when they need it. */}
          <span className="md:hidden mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 font-mono text-[10px] tracking-[0.06em] text-[#f5e4b8]/65">
            <span className="uppercase tracking-[0.1em]"><ChainMark chain={row.chain} /></span>
            <Terms terms={row.terms} />
          </span>
        </span>

        <span className="hidden md:block font-mono text-[11px] uppercase tracking-[0.12em] text-[#f5e4b8]/70">
          <ChainMark chain={row.chain} />
        </span>
        <span className="hidden md:flex font-mono text-[11px] tracking-[0.04em] text-[#f5e4b8]/70">
          <Terms terms={row.terms} />
        </span>

        <span aria-hidden="true"
          className="justify-self-end w-10 h-10 md:w-11 md:h-11 flex items-center justify-center border border-white/20 transition-colors duration-300 group-hover/row:bg-[#22c55e] group-hover/row:border-[#22c55e] group-hover/row:text-[#05080f] group-focus-visible/row:bg-[#22c55e] group-focus-visible/row:text-[#05080f]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
            className="transition-transform duration-300 group-hover/row:translate-x-0.5">
            <path d="M4 12h15M13 6l6 6-6 6" />
          </svg>
        </span>
      </Link>
    </li>
  );
}

/** The big frame, from 1024px: the door picture of the row under the pointer, captioned as a plate. */
function Figure({ n, row }: { n: number; row: VenuePoolRow }) {
  const door = doorOf(row.id);
  const reduce = prefersReducedMotion();
  const srcSet = door ? artSrcSet(door.src) : undefined;
  return (
    <div aria-hidden="true" className="hidden lg:block lg:sticky lg:top-24 self-start pt-4">
      <div className="relative aspect-[4/5] overflow-hidden border border-white/15" style={{ background: EDITORIAL_BG }}>
        <AnimatePresence initial={false}>
          <m.div key={row.id} className="absolute inset-0"
            initial={reduce ? { opacity: 0 } : { clipPath: 'inset(100% 0% 0% 0%)' }}
            animate={reduce ? { opacity: 1 } : { clipPath: 'inset(0% 0% 0% 0%)' }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
            transition={{ duration: 0.7, ease: EDITORIAL_EASE }}>
            {door && (
              // art-bright: index.css dims any full-bleed art to 0.45; nothing but a caption sits on this one.
              <img src={door.src} {...(srcSet ? { srcSet, sizes: '360px' } : {})} alt="" loading="lazy" decoding="async"
                className="w-full h-full object-cover art-bright"
                style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined} />
            )}
          </m.div>
        </AnimatePresence>
        <span className="absolute inset-x-0 bottom-0 h-2/5 pointer-events-none" style={{ background: `linear-gradient(to top, ${EDITORIAL_BG} 0%, rgba(5,8,15,0) 100%)` }} />
        {/* The resident's word, outlined and cut by the frame's foot. */}
        <span key={`w-${row.id}`} className="absolute left-4 bottom-0 translate-y-[24%] whitespace-nowrap font-black leading-none tracking-[-0.06em] text-[clamp(3.5rem,6.2vw,5.75rem)] select-none"
          style={{ ...HEADING_FONT, ...OUTLINE }}>
          {row.symbol}
        </span>
      </div>
      <div className="mt-2 flex justify-between gap-3 font-mono text-[11px] tracking-[0.12em] text-[#f5e4b8]/60">
        <span>fig. {pad2(n)}</span>
        <span className="truncate">{row.name} · {CHAIN_LABEL[row.chain] ?? row.chain}</span>
      </div>
    </div>
  );
}

export function IslandDashboard({ headingLevel = 2 }: { headingLevel?: 1 | 2 }) {
  const rows = venuePoolRows();
  const [shown, setShown] = useState(0);
  const chains = new Set(rows.map((r) => r.chain).filter((c) => c !== 'tbd')).size;
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const reduce = prefersReducedMotion();
  const current = rows[Math.min(shown, rows.length - 1)];

  return (
    <section
      id="dashboard"
      aria-labelledby="island-dashboard-heading"
      className="relative isolate overflow-hidden scroll-mt-24 border border-white/15 px-4 pt-5 pb-4 md:px-7 md:pt-7 lg:px-10 lg:pt-9 lg:pb-6"
      style={{ background: EDITORIAL_BG, color: EDITORIAL_INK, textShadow: 'none' }}
    >
      <CardArt pageId="island-dashboard" idx={0} scrim="rgba(5,8,15,0.8)" />
      <div aria-hidden="true" className="absolute inset-0 pointer-events-none opacity-[0.08] mix-blend-screen" style={{ backgroundImage: EDITORIAL_GRAIN }} />

      <header className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end pb-5 border-b border-white/25">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[#f5e4b8]/60">
            <span aria-hidden="true" className="w-1.5 h-1.5 bg-[#22c55e]" />
            Jungle Bay Island
          </p>
          {/* The word rises from under a mask, as the menu's do. */}
          <Heading id="island-dashboard-heading"
            className="mt-2 font-black leading-[0.86] tracking-[-0.055em] text-[clamp(3rem,14.5vw,9.5rem)]"
            style={{ ...HEADING_FONT, textShadow: 'none' }}>
            <span className="block overflow-hidden pb-[0.05em] pr-[0.04em]">
              <m.span className="block whitespace-nowrap"
                initial={reduce ? false : { y: '105%' }} animate={{ y: 0 }}
                transition={{ duration: 0.9, ease: EDITORIAL_EASE }}>
                Dash<span style={OUTLINE}>board</span>
              </m.span>
            </span>
          </Heading>
          <p className="mt-3 text-[14px] md:text-[15px] leading-snug text-[#f5e4b8]/80">
            Open a room to see what you hold there.
          </p>
        </div>

        {/* What the index holds, counted from the registry, and how a lock earns. */}
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3 lg:flex-col lg:items-end lg:gap-y-4">
          <dl className="flex gap-7">
            {[{ v: rows.length, l: 'Pools' }, { v: chains, l: 'Chains' }].map((s) => (
              <div key={s.l} className="flex flex-col-reverse">
                <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#f5e4b8]/55">{s.l}</dt>
                <dd className="font-black leading-none tracking-[-0.05em] text-[44px] lg:text-[56px] tabular-nums" style={HEADING_FONT}>{pad2(s.v)}</dd>
              </div>
            ))}
          </dl>
          <p className="flex items-center gap-2.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#f5e4b8]/70">
            <LadderWedge className="text-[#22c55e]" />
            Longer lock, bigger share
          </p>
        </div>
      </header>

      <div className="relative grid lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] gap-x-10">
        <ol className="min-w-0" aria-label="Pools on the island">
          {rows.map((row, i) => (
            <PoolRow key={row.id} n={i + 1} row={row} onShow={() => setShown(i)} />
          ))}
        </ol>
        {current && <Figure n={Math.min(shown, rows.length - 1) + 1} row={current} />}
      </div>

      <div className="relative mt-3 flex flex-wrap items-center justify-between gap-x-6">
        {/* The venue's OWN earning surface: its pools belong to the factory this venue deployed. */}
        <Link to="/liquidity"
          className="group/lp inline-flex items-center gap-2 min-h-[44px] font-mono text-[11px] uppercase tracking-[0.14em] no-underline transition-colors hover:text-[#22c55e]"
          style={{ color: EDITORIAL_INK }}>
          Provide liquidity on venue pools
          <span aria-hidden="true" className="transition-transform duration-300 group-hover/lp:translate-x-1">→</span>
        </Link>
        <FinePrint summary="Why no rates?">
          <p>
            Positions live in the room they were opened in. Each resident&apos;s pool is its own token, on
            its own chain, read by its own panel. The venue itself holds nothing on your behalf.
          </p>
          <p>
            &ldquo;Lock 7d–4y, 0.40×–4.00×&rdquo; is a lock ladder: lock from seven days to four years for
            that share of the pool&rsquo;s rewards, growing evenly with the lock, as the wedge draws it.
          </p>
          <p>
            No rate is shown here because none is read here. Twelve pools across three chains would be
            twelve calls before this list could draw, and a call that does not answer renders as a zero,
            which would read as &ldquo;empty, pays nothing&rdquo; about a pool that may be neither. Pick a
            room to see its live rate, its rewards and what your position is worth.
          </p>
        </FinePrint>
      </div>
    </section>
  );
}
