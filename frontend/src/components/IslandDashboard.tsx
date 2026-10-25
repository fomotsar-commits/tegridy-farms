import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { BUNGALOWS } from '../lib/bungalows';
import { doorArt } from '../lib/doorArt';
import { artSrcSet } from '../lib/artSrcSet';
import { MIN_BOOST_BPS, MAX_BOOST_BPS } from '../lib/constants';
import { CONNECT_ETHEREUM_WALLET } from '../lib/copy';
import { hasMixedSolanaSection } from '../lib/routeVoice';
import { getSolanaSurfaceState, requestSolanaOpen, shortSolanaAddress, wantOwnSolana } from '../lib/solanaSurface';
import { CHAIN_LABEL, hasLadder, rowTerms, venuePoolRows, type VenuePoolRow } from '../lib/venuePools';
import {
  WALLET_CHAIN_LABEL, boostOf, fmtUsd, holdingShares, holdingsTotal, pctText,
  type HoldingRow, type HoldingShare, type NamedLeg, type PositionRow, type WalletChain,
} from '../lib/wallet/walletRows';
import { EDITORIAL_BG, EDITORIAL_EASE, EDITORIAL_GRAIN, EDITORIAL_INK, HEADING_FONT, pad2 } from '../lib/editorial';
import { useWalletBoard } from '../hooks/useWalletBoard';
import { CardArt } from './ui/CardArt';
import { FinePrint } from './ui/FinePrint';

/**
 * The island's dashboard (owner, 2026-10-21: "give it an avantegarde upgrade" and "put the
 * dashboard on top of" the home's three cards; 2026-10-22: "things that matter like positions on
 * the website and what the wallet holds", then "avantegarde cutting edge"). It renders on the
 * venue home, above the cards, and as the venue's /dashboard page.
 *
 * First the connected wallets: what they hold (SOL, ETH and every island coin, with USD where a
 * price was read) and their positions on this site (locks, stakes, pool shares), each read from
 * the chain by the reader its own page uses (hooks/useWalletBoard.ts). A part that could not be
 * read says so, by name, with Try again; it is never a zero or an empty list.
 *
 * What is drawn is only what was read: the holdings' worth split by coin (a bar, and each coin's
 * share on its row) only when every coin held was read and priced; a tape of the coins held only
 * when every holdings leg was read; a lock's place on the ladder from the boost its own pool
 * reported. Nothing here is estimated.
 *
 * Then every pool on the island, one press away, as a numbered index. That list reads no chain
 * (VenuePoolIndex.tsx says why): its rows and terms come from the registry (lib/venuePools.ts).
 *
 * The menu's editorial look (lib/editorial.ts): heavy type, hairlines, mono captions, hard
 * corners, grain. Every row carries its room's door picture, and the big frame shows the row
 * you are on, laid out for the screen (owner, 2026-10-24: "the mobile and ipad versions to have
 * the dashboard too ... aesthetic according to the space given"):
 *   - from 1024px, beside the board, following the pointer;
 *   - an upright iPad (768px to 1023px), beside the board as a tall frame, the pool list under both;
 *   - a phone, a wide plate pinned under the top bar while the rows scroll beneath it.
 * A phone or an iPad has no pointer, so there the frame follows the scroll instead (useFollow),
 * and the row it shows lights as a pointed-at row does.
 */

const GREEN = '#22c55e';
// The home's chain pills' own colors (HomePage.tsx), so a chain reads the same everywhere.
const CHAIN_DOT: Record<string, string> = { solana: '#4CAF50', ethereum: '#8b5cf6', base: '#2151f5' };
// An outlined word: body's text-shadow (index.css) would fill the hollow letters black.
const OUTLINE = { WebkitTextStroke: `1.5px ${EDITORIAL_INK}`, color: 'transparent', textShadow: 'none' } as const;
const TAPE_MASK = 'linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent)';

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
 * What the big frame shows: a row's room, or, for a coin with no room (SOL, ETH), its chain. `no`
 * is its plate number: the row's section and place ("01.05", the fifth coin held), or a pool's place.
 */
type Fig = { key: string; roomId: string | null; chain: string; word: string; caption: string; no: string };

// Touch-first: no hover, or a coarse pointer. Width alone is not it: a mouse in a narrow window
// points, and an iPad with a trackpad attached reports a fine pointer that hovers.
const TOUCH = '(hover: none), (pointer: coarse)';
// A phone held sideways, or any window this short: a pinned frame would fill it.
const SHORT = '(max-height: 500px)';

function mediaQuery(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => mediaQuery(query)?.matches ?? false);
  useEffect(() => {
    const mq = mediaQuery(query);
    if (!mq) return;
    const sync = () => setOn(mq.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return on;
}

type Picked = { key: string; i: number; total: number; near: string[] } | null;

/**
 * The frame follows the scroll where there is no pointer: it shows the row at the reading line.
 * The line is just under the frame where the frame is pinned above the rows (a phone), and 45%
 * down the screen where it stands beside them. Rows are the board's `data-fig-key` elements that
 * are shown; a closed pool list's are not. `clear` hands the frame back until the next scroll, for
 * a row a finger tapped or the keyboard focused.
 */
function useFollow(on: boolean, wrap: RefObject<HTMLDivElement | null>, fig: RefObject<HTMLDivElement | null>, rowKeys: string) {
  const [picked, setPicked] = useState<Picked>(null);
  const lastScroll = useRef(0);
  useEffect(() => {
    if (!on) return;
    let frame = 0;
    const pick = () => {
      frame = 0;
      const root = wrap.current;
      const f = fig.current?.getBoundingClientRect();
      if (!root || !f) return;
      // A closed <details> still lays its rows out in Chrome, so its rows are left out by name.
      const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-fig-key]'))
        .filter((el) => !el.closest('details:not([open])'))
        .map((el) => ({ key: el.dataset.figKey ?? '', r: el.getBoundingClientRect() }))
        .filter((x) => x.r.height > 0);
      const first = rows[0]?.r;
      const last = rows[rows.length - 1]?.r;
      const stacked = first ? f.left < first.right && f.right > first.left : false;
      // Never below the screen: a short screen unpins the frame, and its foot may be anywhere.
      let line = Math.min(stacked ? f.bottom + 8 : window.innerHeight * 0.45, window.innerHeight * 0.8);
      // Where the page ends before the last rows can reach the line, the line slides down to meet
      // them over the last stretch of scroll, so the bottom of the page shows the last row.
      const page = document.scrollingElement ?? document.documentElement;
      const left = Math.max(0, page.scrollHeight - window.innerHeight - window.scrollY);
      const stop = last ? last.top - left : line;
      if (stop > line) line += (stop - line) * Math.min(1, Math.max(0, 1 - left / (window.innerHeight * 0.75)));
      let at = -1;
      rows.forEach((x, i) => { if (x.r.top <= line) at = i; });
      // The lit row is always one you can read: on a phone the next row takes over as soon as this
      // one starts to slide under the frame, and beside the frame once it is half past the line.
      const reached = rows[at]?.r;
      const passing = reached && (stacked ? reached.top < f.bottom - 4 : (reached.top + reached.bottom) / 2 < line);
      if (passing && at < rows.length - 1) at += 1;
      const next = at < 0 ? null : {
        key: rows[at]!.key, i: at, total: rows.length,
        near: [rows[at - 1]?.key, rows[at + 1]?.key].filter((k): k is string => Boolean(k)),
      };
      setPicked((p) => (p?.key === next?.key && p?.i === next?.i && p?.total === next?.total ? p : next));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(pick); };
    const scrolled = () => {
      lastScroll.current = performance.now();
      schedule();
    };
    schedule();
    const root = wrap.current;
    window.addEventListener('scroll', scrolled, { passive: true });
    window.addEventListener('resize', schedule);
    // Opening the pool list adds rows; `toggle` does not bubble, so it is caught on the way down.
    root?.addEventListener('toggle', schedule, true);
    // Rows that move without a scroll (a part finishing its read, the tape arriving above them).
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    if (root) resized?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', scrolled);
      window.removeEventListener('resize', schedule);
      root?.removeEventListener('toggle', schedule, true);
      resized?.disconnect();
    };
  }, [on, wrap, fig, rowKeys]);
  // A row sliding under a resting pointer during a scroll fires the same "entered" as a pointer
  // moved onto it, so a hand-back that close behind a scroll is the scroll's, and is ignored.
  const clear = () => {
    if (performance.now() - lastScroll.current > 300) setPicked(null);
  };
  return { picked: on ? picked : null, clear };
}

/** The value once it has stopped changing for `ms`: the frame's picture waits for the scroll to rest. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Fetch a frame's picture ahead, at the size the frame will ask for, so it is there when the frame turns to it. */
function preloadDoor(roomId: string | null) {
  const door = roomId ? doorOf(roomId) : null;
  if (!door || typeof Image === 'undefined') return;
  const img = new Image();
  const set = artSrcSet(door.src);
  if (set) {
    img.sizes = FIG_SIZES;
    img.srcset = set;
  }
  img.src = door.src;
}

const accentOf = (roomId: string | null) => (roomId ? BUNGALOWS.find((b) => b.id === roomId)?.accent : undefined);
const colorOf = (roomId: string | null, chain: WalletChain) => accentOf(roomId) ?? CHAIN_DOT[chain] ?? GREEN;

/** A coin's word in a key or on the tape: with its chain when the same word is held on another chain too (ETH on Ethereum and on Base). */
function keyWord(symbol: string, chain: WalletChain, all: readonly { symbol: string }[]): string {
  return all.filter((r) => r.symbol === symbol).length > 1 ? `${symbol} on ${WALLET_CHAIN_LABEL[chain]}` : symbol;
}

/** A row rises into place, each a beat after the last; still with reduced motion. */
const rise = (i: number) =>
  prefersReducedMotion()
    ? {}
    : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.55, ease: EDITORIAL_EASE, delay: Math.min(i, 10) * 0.05 } };

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

/** A lock's place on that ladder, from the boost its pool read: a green mark on the wedge. */
function LockMark({ boost }: { boost: number }) {
  const w = 40;
  const h = 14;
  const lo = MIN_BOOST_BPS / 10_000;
  const hi = MAX_BOOST_BPS / 10_000;
  const x = Math.max(0, Math.min(1, (boost - lo) / (hi - lo))) * w;
  const floor = (MIN_BOOST_BPS / MAX_BOOST_BPS) * h;
  return (
    <svg
      width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img"
      aria-label={`${boost.toFixed(2)}× on the ladder, from ${lo.toFixed(2)}× to ${hi.toFixed(2)}×`}
      className="flex-shrink-0 text-[#f5e4b8]/40"
    >
      <path d={`M0 ${h} L${w} ${h} L${w} 0 L0 ${h - floor} Z`} fill="currentColor" />
      <rect x={Math.max(0, Math.min(w - 2, x - 1))} y="0" width="2" height={h} fill={GREEN} />
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
function PoolRow({ n, row, onShow, figKey, current }: { n: number; row: VenuePoolRow; onShow: () => void; figKey: string; current: boolean }) {
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
        data-fig-key={figKey}
        data-current={current ? '' : undefined}
        className="group/row relative grid items-center gap-x-3 md:gap-x-4 lg:gap-x-5 grid-cols-[2.75rem_minmax(0,1fr)_2.5rem] md:grid-cols-[2.75rem_1.5rem_minmax(0,1fr)_6.5rem_13rem_2.75rem] lg:grid-cols-[2rem_minmax(0,1fr)_6.5rem_13.5rem_2.75rem] min-h-[64px] py-2.5 pl-0 md:pl-3 border-b border-white/[0.10] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#22c55e]"
        style={{ color: EDITORIAL_INK }}
      >
        <RowRules accent={row.accent} edge="-left-3 md:left-0" />

        {/* Under 1024px: the door's picture beside the word. From 1024px the big frame shows it. */}
        <span aria-hidden="true" className="lg:hidden relative w-11 h-11 overflow-hidden border border-white/15">
          {door && (
            <img src={door.src} {...(thumbSet ? { srcSet: thumbSet, sizes: '44px' } : {})} alt="" loading="lazy" decoding="async" width={44} height={44}
              className="w-full h-full object-cover" style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined} />
          )}
        </span>
        <Index n={n} />

        <span className="min-w-0">
          <span className={`block truncate font-black leading-[0.95] tracking-[-0.045em] text-[24px] md:text-[28px] lg:text-[34px] ${WORD_LIT}`}
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

/** A row's picture: its room's door art, or, for SOL and ETH, a square in the chain's color. */
function Thumb({ roomId, chain, className = '' }: { roomId: string | null; chain: WalletChain; className?: string }) {
  const door = roomId ? doorOf(roomId) : null;
  const set = door ? artSrcSet(door.src) : undefined;
  return (
    <span aria-hidden="true" className={`relative w-11 h-11 flex-shrink-0 overflow-hidden border border-white/15 ${className}`}
      style={door ? undefined : { background: CHAIN_DOT[chain] }}>
      {door ? (
        <img src={door.src} {...(set ? { srcSet: set, sizes: '44px' } : {})} alt="" loading="lazy" decoding="async" width={44} height={44}
          className="w-full h-full object-cover" style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined} />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center font-black text-[18px] text-[#05080f]" style={HEADING_FONT}>
          {chain === 'solana' ? '◎' : 'Ξ'}
        </span>
      )}
    </span>
  );
}

const ROW_CLASS =
  'group/row relative grid items-center gap-x-3 md:gap-x-4 min-h-[64px] py-2.5 border-b border-white/[0.10] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#22c55e]';

// A row lights when pointed at, focused, or (a phone, an iPad) when it is the row the frame shows:
// `data-current` on the row, set by useFollow's pick.
const WORD_LIT =
  'transition-[transform,color] duration-300 ease-out group-hover/row:translate-x-1.5 group-hover/row:text-white group-data-current/row:translate-x-1.5 group-data-current/row:text-white';

/**
 * The row's resident colour rising up its edge, and the rule under it sweeping green, as the menu's
 * do. The colour stands in the card's margin, clear of the row's number and picture; a pool row,
 * padded from 768px, keeps it on its edge there.
 */
function RowRules({ accent, edge = '-left-3' }: { accent?: string; edge?: string }) {
  return (
    <>
      <span aria-hidden="true"
        className={`absolute ${edge} top-0 bottom-0 w-[3px] origin-bottom scale-y-0 transition-transform duration-300 ease-out group-hover/row:scale-y-100 group-focus-visible/row:scale-y-100 group-data-current/row:scale-y-100`}
        style={{ background: accent ?? GREEN }} />
      <span aria-hidden="true"
        className="absolute left-0 right-0 -bottom-px h-px origin-left scale-x-0 bg-[#22c55e] transition-transform duration-500 ease-out group-hover/row:scale-x-100 group-focus-visible/row:scale-x-100 group-data-current/row:scale-x-100" />
    </>
  );
}

/** The row's number, from 768px; the picture carries the row on a phone. */
function Index({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="hidden md:block self-start pt-1 font-mono text-[11px] tracking-[0.12em] tabular-nums text-[#f5e4b8]/45 transition-colors group-hover/row:text-[#22c55e] group-data-current/row:text-[#22c55e]">
      {pad2(n)}
    </span>
  );
}

function Arrow() {
  return (
    <span aria-hidden="true"
      className="justify-self-end w-10 h-10 flex items-center justify-center border border-white/20 transition-colors duration-300 group-hover/row:bg-[#22c55e] group-hover/row:border-[#22c55e] group-hover/row:text-[#05080f] group-focus-visible/row:bg-[#22c55e] group-focus-visible/row:text-[#05080f]">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        className="transition-transform duration-300 group-hover/row:translate-x-0.5">
        <path d="M4 12h15M13 6l6 6-6 6" />
      </svg>
    </span>
  );
}

/** One coin the wallet holds: its number, picture, word and chain, the amount, its worth and its share. */
function HoldingItem({ n, row, share, onShow, figKey, current }: { n: number; row: HoldingRow; share: number | undefined; onShow: () => void; figKey: string; current: boolean }) {
  const body = (
    <>
      <RowRules accent={accentOf(row.roomId)} />
      <Index n={n} />
      <Thumb roomId={row.roomId} chain={row.chain} />
      <span className="min-w-0">
        {/* An upright iPad sets the board beside its frame, so the type steps down a size there. */}
        <span className={`block truncate font-black leading-[0.95] tracking-[-0.045em] text-[24px] md:text-[26px] lg:text-[30px] ${WORD_LIT}`} style={HEADING_FONT}>
          {row.symbol}
        </span>
        <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#f5e4b8]/60"><ChainMark chain={row.chain} /></span>
      </span>
      <span className="text-right">
        <span className="block font-black leading-none tracking-[-0.03em] text-[20px] md:text-[22px] lg:text-[26px] tabular-nums" style={HEADING_FONT}>{row.amount}</span>
        <span className="mt-1 block font-mono text-[11px] tracking-[0.04em] text-[#f5e4b8]/65 tabular-nums">
          <span>{row.usd !== null ? fmtUsd(row.usd) : 'no price read'}</span>
          {/* Its share of the whole, only while the whole is known (holdingShares). */}
          {share !== undefined && <span className="text-[#22c55e]"> · {pctText(share)}</span>}
        </span>
      </span>
      {row.to ? <Arrow /> : <span aria-hidden="true" />}
    </>
  );
  const cls = `${ROW_CLASS} grid-cols-[2.75rem_minmax(0,1fr)_auto_2.5rem] md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_auto_2.5rem]`;
  const fig = { 'data-fig-key': figKey, 'data-current': current ? '' : undefined };
  return (
    <m.li {...rise(n - 1)}>
      {row.to ? (
        <Link to={row.to} aria-label={`${row.symbol}: ${row.amount}, open its room`} onMouseEnter={onShow} onFocus={onShow} className={cls} style={{ color: EDITORIAL_INK }} {...fig}>
          {body}
        </Link>
      ) : (
        <div className={cls} onMouseEnter={onShow} {...fig}>{body}</div>
      )}
    </m.li>
  );
}

/** One position on this site: what it is, its read facts, its place on the ladder, and the door to it. */
function PositionItem({ n, row, onShow, figKey, current }: { n: number; row: PositionRow; onShow: () => void; figKey: string; current: boolean }) {
  const boost = boostOf(row.facts);
  return (
    <m.li {...rise(n - 1)}>
      {/* The facts sit beside the title from 1024px; below that (a phone, and an upright iPad, whose
          board shares its width with the frame) they sit under it. */}
      <Link to={row.to} aria-label={`${row.title}: ${row.facts.join(', ')}. Open it`} onMouseEnter={onShow} onFocus={onShow}
        data-fig-key={figKey} data-current={current ? '' : undefined}
        className={`${ROW_CLASS} grid-cols-[2.75rem_minmax(0,1fr)_2.5rem] md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_2.5rem] lg:grid-cols-[2rem_2.75rem_minmax(0,14rem)_minmax(0,1fr)_2.5rem]`} style={{ color: EDITORIAL_INK }}>
        <RowRules accent={accentOf(row.roomId)} />
        <Index n={n} />
        <Thumb roomId={row.roomId} chain={row.chain} />
        <span className="min-w-0">
          <span className="flex items-center gap-2.5 min-w-0">
            <span className={`truncate font-black leading-[0.95] tracking-[-0.045em] text-[20px] md:text-[24px] ${WORD_LIT}`} style={HEADING_FONT}>
              {row.title}
            </span>
            {boost !== null && <LockMark boost={boost} />}
          </span>
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#f5e4b8]/60"><ChainMark chain={row.chain} /></span>
          <span className="lg:hidden mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-[#f5e4b8]/80">
            {row.facts.map((f) => <span key={f}>{f}</span>)}
          </span>
        </span>
        <span className="hidden lg:flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px] tracking-[0.02em] text-[#f5e4b8]/85">
          {row.facts.map((f) => <span key={f} className="whitespace-nowrap">{f}</span>)}
        </span>
        <Arrow />
      </Link>
    </m.li>
  );
}

/** A numbered part of the board: its rows, then whatever is still reading or could not be read. */
function LegBlock<T extends { key: string }>({ n, title, legs, empty, render }: {
  n: number; title: string; legs: NamedLeg<T>[]; empty: ReactNode; render: (row: T, i: number) => ReactNode;
}) {
  const rows = legs.flatMap((l) => (l.leg.status === 'ok' ? l.leg.rows : []));
  const loading = legs.some((l) => l.leg.status === 'loading');
  const unread = legs.filter((l) => l.leg.status === 'unread');
  return (
    <section aria-label={title} className="mt-6 first:mt-4">
      <h3 className="flex items-baseline gap-3 pb-2 border-b border-white/25 font-mono text-[11px] uppercase tracking-[0.16em] text-[#f5e4b8]/70">
        <span className="tabular-nums text-[#22c55e]">{pad2(n)}</span>
        {title}
        {rows.length > 0 && <span className="ml-auto tabular-nums text-[#f5e4b8]/45">{pad2(rows.length)}</span>}
      </h3>
      {rows.length > 0 && <ol className="min-w-0">{rows.map(render)}</ol>}
      {loading && (
        <p role="status" className="py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-[#f5e4b8]/55">Reading the chain…</p>
      )}
      {unread.map((l) => (
        // The reader's own reason, on hover: the line itself stays one sentence.
        <p key={l.key} title={l.leg.status === 'unread' ? l.leg.detail : undefined}
          className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] border-b border-white/[0.10]" style={{ color: '#f0b26b' }}>
          <span>Couldn&rsquo;t read {l.what} just now, so nothing is shown for them.</span>
          <button type="button" onClick={l.retry} className="underline underline-offset-4" style={{ color: EDITORIAL_INK }}>Try again</button>
        </p>
      ))}
      {!loading && !unread.length && rows.length === 0 && (
        <p className="py-3 text-[13px] text-[#f5e4b8]/70">{empty}</p>
      )}
    </section>
  );
}

/** The holdings' worth split by coin: a bar to scale, and the key. Whole totals only. */
function HoldingsSplit({ shares }: { shares: HoldingShare[] }) {
  const said = shares.map((s) => `${keyWord(s.symbol, s.chain, shares)} ${pctText(s.pct)}`).join(', ');
  return (
    <div data-testid="holdings-split" className="lg:col-span-2">
      <div role="img" aria-label={`Holdings by value: ${said}`} className="flex h-1.5 w-full gap-px overflow-hidden">
        {shares.map((s) => (
          <span key={s.key} className="h-full min-w-[2px]" style={{ width: `${s.pct}%`, background: colorOf(s.roomId, s.chain) }} />
        ))}
      </div>
      <ul aria-hidden="true" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f5e4b8]/60">
        {shares.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5 tabular-nums">
            <span className="w-1.5 h-1.5" style={{ background: colorOf(s.roomId, s.chain) }} />
            {keyWord(s.symbol, s.chain, shares)} {pctText(s.pct)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The coins held, on a tape between hairlines: the rows below carry the words. */
function WalletTape({ rows }: { rows: HoldingRow[] }) {
  return (
    <div
      aria-hidden="true"
      className="relative mt-5 overflow-hidden border-y border-white/[0.14] py-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#f5e4b8]/60"
      style={{ WebkitMaskImage: TAPE_MASK, maskImage: TAPE_MASK }}
    >
      <div className="editorial-tape" style={{ '--tape-s': `${Math.max(24, rows.length * 7)}s` } as CSSProperties}>
        {[0, 1].map((copy) => (
          <span key={copy} className="inline-flex items-center">
            {rows.map((r) => (
              <span key={`${copy}-${r.key}`} className="inline-flex items-center gap-2 pr-8 whitespace-nowrap">
                <span className="w-1.5 h-1.5" style={{ background: colorOf(r.roomId, r.chain) }} />
                {keyWord(r.symbol, r.chain, rows)} <span className="text-[#f5e4b8]/90">{r.amount}</span>
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

function shortEvm(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Connect the chain whose wallet is missing: the top bar's own connection flow, not a second one. */
function connectSolana(pathname: string) {
  // On the home the cards' Solana connection is the page's; a tap waits for it to load. Elsewhere
  // the top bar mounts its own, and the waiting tap opens its list (lib/solanaSurface.ts).
  if (!getSolanaSurfaceState().surface && !hasMixedSolanaSection(pathname)) wantOwnSolana();
  requestSolanaOpen();
}

// Colours that change on hover are classes, never inline style: an inline colour beats hover:text-*.
const CONNECT_BTN =
  'inline-flex items-center justify-center gap-2 min-h-[44px] px-4 border font-mono text-[11px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22c55e]';

function ConnectButtons({ solana, evm }: { solana: boolean; evm: boolean }) {
  const { pathname } = useLocation();
  return (
    <div className="flex flex-wrap gap-2">
      {!solana && (
        <button type="button" onClick={() => connectSolana(pathname)} className={`${CONNECT_BTN} border-[#4CAF50]/70 text-[#f5e4b8] hover:bg-[#4CAF50] hover:text-[#05080f]`}>
          <span aria-hidden="true">◎</span> Connect Solana wallet
        </button>
      )}
      {!evm && (
        <ConnectButton.Custom>
          {({ openConnectModal, mounted }) => (
            <button type="button" onClick={openConnectModal} disabled={!mounted}
              className={`${CONNECT_BTN} border-[#8b5cf6]/70 text-[#f5e4b8] hover:bg-[#8b5cf6] hover:text-[#05080f]`}>
              <span aria-hidden="true">Ξ</span> {CONNECT_ETHEREUM_WALLET}
            </button>
          )}
        </ConnectButton.Custom>
      )}
    </div>
  );
}

// The picture's widths in each layout, for srcset: the desktop frame, the upright iPad's, the phone's strip.
const FIG_SIZES = '(min-width: 1024px) 360px, (min-width: 720px) 224px, 100vw';

/**
 * The frame's place in each layout. `slot` owns the grid area and `frame` is what pins: a pinned
 * box stays inside its parent box, and a grid area is not one, so without the slot the frame rode
 * on over the pool list below its row. The card is `overflow-clip`, not `hidden`, for the same
 * reason: a hidden-overflow box is a scroll box of its own, and nothing inside it can pin.
 *
 * `follow` (a wallet is connected, so there are rows): a phone gets a wide plate across the card,
 * pinned under the top bar while the rows scroll beneath it, on a solid strip so a passing row never
 * shows through its caption; from 720px (an iPad mini upright and up) a tall frame pinned beside
 * the board; from 1024px as before. `still` (no wallet): nothing to follow, so under 1024px it is a
 * plate under the connect buttons, never pinned over them. A screen 500px tall or less (a phone
 * held sideways) pins neither: the frame would fill it (IslandDashboard, `short`).
 */
const FIG_LAYOUT = {
  follow: {
    slot: 'contents min-[720px]:block [grid-area:fig]',
    frame: 'sticky z-10 -mx-4 mt-5 top-[calc(3.5rem+env(safe-area-inset-top,0px)+var(--app-alert-h,0px))] bg-[#05080f] min-[720px]:mx-0 min-[720px]:mt-0 min-[720px]:pt-4 min-[720px]:top-[calc(5rem+var(--app-alert-h,0px))] min-[720px]:bg-transparent lg:top-24',
    plate: 'aspect-[16/7] min-[640px]:aspect-[5/2] min-[720px]:aspect-[3/4] lg:aspect-[4/5] border-y min-[720px]:border',
    // An upright iPad's 14rem frame sets its caption on two lines rather than cut the name.
    caption: 'px-4 py-2 min-[720px]:px-0 min-[720px]:py-0 min-[720px]:mt-2 min-[720px]:max-lg:flex-col min-[720px]:max-lg:gap-1',
    name: 'min-[720px]:max-lg:whitespace-normal min-[720px]:max-lg:line-clamp-2 min-[720px]:max-lg:min-h-[2.6em]',
  },
  still: {
    slot: '[grid-area:fig]',
    frame: 'mt-6 lg:sticky lg:z-10 lg:top-24 lg:mt-0 lg:pt-4',
    plate: 'aspect-[16/7] min-[640px]:aspect-[5/2] lg:aspect-[4/5] border',
    caption: 'mt-2',
    name: '',
  },
} as const;

/** `#rrggbb` at an alpha, for a chain colour's glow. */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * A chain's mark drawn as outlines, the way the frame's word is: the Ethereum diamond (ETH on
 * Base is still ETH, in Base's blue) or Solana's three bars. The hairline stays a hairline at
 * any frame size.
 */
function ChainArt({ chain }: { chain: string }) {
  const stroke = CHAIN_DOT[chain] ?? GREEN;
  const line = { fill: tint(stroke, 0.08), stroke, strokeWidth: 1.5, strokeLinejoin: 'round' as const, vectorEffect: 'non-scaling-stroke' as const };
  return chain === 'solana' ? (
    <svg viewBox="-2 -2 124 104" className="absolute right-[8%] top-1/2 -translate-y-[58%] h-[56%] w-auto">
      <path d="M22 0H120L98 24H0Z" {...line} />
      <path d="M0 38H98L120 62H22Z" {...line} />
      <path d="M22 76H120L98 100H0Z" {...line} />
    </svg>
  ) : (
    <svg viewBox="-2 -2 104 164" className="absolute right-[10%] top-1/2 -translate-y-[56%] h-[72%] w-auto">
      <path d="M50 0L100 82L50 110L0 82Z" {...line} />
      <path d="M50 0V110M0 82L50 60L100 82" {...line} fill="none" />
      <path d="M50 122L100 94L50 160L0 94Z" {...line} />
    </svg>
  );
}

/**
 * The big frame: the door picture of the row you are on, captioned as a plate. A coin with no room
 * (SOL, ETH) shows its chain's mark on the dark plate, in the chain's colour. The frame is a size
 * container, so its word and mark are sized by the frame they sit in, and the word by its length
 * too, so a long one is never cut at the frame's side. The word wipes in with its picture.
 */
function Figure({ fig, mode, unpinned, quick, progress, frameRef }: {
  fig: Fig; mode: keyof typeof FIG_LAYOUT; unpinned: boolean; quick: boolean; progress: number | null; frameRef: RefObject<HTMLDivElement | null>;
}) {
  const layout = FIG_LAYOUT[mode];
  const door = fig.roomId ? doorOf(fig.roomId) : null;
  const reduce = prefersReducedMotion();
  const srcSet = door ? artSrcSet(door.src) : undefined;
  const plate = fig.roomId ?? `chain:${fig.chain}`;
  return (
    <div className={layout.slot}>
      <div ref={frameRef} aria-hidden="true" data-testid="dashboard-figure" className={layout.frame} style={unpinned ? { position: 'static' } : undefined}>
        <div className={`relative overflow-hidden border-white/15 [container-type:size] ${layout.plate}`} style={{ background: EDITORIAL_BG }}>
          <AnimatePresence initial={false}>
            <m.div key={plate} className="absolute inset-0"
              initial={reduce ? { opacity: 0 } : { clipPath: 'inset(100% 0% 0% 0%)' }}
              animate={reduce ? { opacity: 1 } : { clipPath: 'inset(0% 0% 0% 0%)' }}
              exit={{ opacity: 0, transition: { duration: 0.3 } }}
              // Following a scroll, a shorter wipe: the next row is never far behind.
              transition={{ duration: quick ? 0.45 : 0.7, ease: EDITORIAL_EASE }}>
              {door ? (
                // art-bright: index.css dims any full-bleed art to 0.45; nothing but a caption sits on this one.
                <img src={door.src} {...(srcSet ? { srcSet, sizes: FIG_SIZES } : {})} alt="" loading="lazy" decoding="async"
                  className="w-full h-full object-cover art-bright"
                  style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined} />
              ) : (
                <span data-testid="chain-plate" className="absolute inset-0"
                  style={{ background: `radial-gradient(120% 95% at 82% 42%, ${tint(CHAIN_DOT[fig.chain] ?? GREEN, 0.3)} 0%, ${EDITORIAL_BG} 68%)` }}>
                  <span className="absolute inset-0 opacity-[0.1] mix-blend-screen" style={{ backgroundImage: EDITORIAL_GRAIN }} />
                  <ChainArt chain={fig.chain} />
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 h-2/5 pointer-events-none" style={{ background: `linear-gradient(to top, ${EDITORIAL_BG} 0%, rgba(5,8,15,0) 100%)` }} />
              {/* The word, outlined and cut by the frame's foot. */}
              <span className="absolute left-4 bottom-0 translate-y-[24%] whitespace-nowrap font-black leading-none tracking-[-0.06em] text-[clamp(3rem,15vw,5rem)] max-lg:supports-[width:1cqw]:text-[length:min(26cqw,46cqh,calc(135cqw/var(--len)))] lg:text-[clamp(3.5rem,6.2vw,5.75rem)] select-none"
                style={{ ...HEADING_FONT, ...OUTLINE, '--len': Math.max(fig.word.length, 3) } as CSSProperties}>
                {fig.word}
              </span>
            </m.div>
          </AnimatePresence>
        </div>
        <div className={`relative flex justify-between gap-3 font-mono text-[11px] tracking-[0.12em] text-[#f5e4b8]/60 ${layout.caption}`}>
          {/* The number never wraps. */}
          <span className="shrink-0 whitespace-nowrap">fig. {fig.no}</span>
          <span className={`truncate ${layout.name}`}>{fig.caption}</span>
          {/* Following a scroll: how far down the board the frame has followed you. */}
          {progress !== null && (
            <span data-testid="figure-progress" className="absolute left-0 bottom-0 min-[720px]:-bottom-2 h-px w-full origin-left bg-[#22c55e] transition-transform duration-300 ease-out"
              style={{ transform: `scaleX(${progress})` }} />
          )}
        </div>
      </div>
    </div>
  );
}

export function IslandDashboard({ headingLevel = 2 }: { headingLevel?: 1 | 2 }) {
  const board = useWalletBoard();
  const pools = venuePoolRows();
  const chains = new Set(pools.map((r) => r.chain).filter((c) => c !== 'tbd')).size;
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const reduce = prefersReducedMotion();
  const connected = Boolean(board.solanaAddress || board.evmAddress);

  const heldRows = board.holdings.flatMap((l) => (l.leg.status === 'ok' ? l.leg.rows : []));
  const positionRows = board.positions.flatMap((l) => (l.leg.status === 'ok' ? l.leg.rows : []));
  const symbolOf = (roomId: string | null) => (roomId ? BUNGALOWS.find((b) => b.id === roomId)?.symbol : undefined);
  // A plate is numbered by its row: section and place for the wallet's rows (the board's "01" and
  // "02" headings, and each row's own number), the place alone for a pool.
  const holdingFig = (r: HoldingRow, i: number): Fig =>
    ({ key: `h:${r.key}`, roomId: r.roomId, chain: r.chain, word: symbolOf(r.roomId) ?? r.symbol, caption: `${r.symbol} · ${WALLET_CHAIN_LABEL[r.chain]}`, no: `01.${pad2(i + 1)}` });
  const positionFig = (r: PositionRow, i: number): Fig =>
    ({ key: `p:${r.key}`, roomId: r.roomId, chain: r.chain, word: symbolOf(r.roomId) ?? r.title.split(' ')[0] ?? '', caption: `${r.title} · ${WALLET_CHAIN_LABEL[r.chain]}`, no: `02.${pad2(i + 1)}` });
  const poolFig = (row: VenuePoolRow, i: number): Fig =>
    ({ key: `pool:${row.id}`, roomId: row.id, chain: row.chain, word: symbolOf(row.id) ?? row.symbol, caption: `${row.name} · ${CHAIN_LABEL[row.chain] ?? row.chain}`, no: pad2(i + 1) });
  const walletFigs = [...heldRows.map(holdingFig), ...positionRows.map(positionFig)];
  const figs = new Map([...walletFigs, ...pools.map(poolFig)].map((f) => [f.key, f]));

  // The frame shows the row you are on: under the pointer, or, on a touch screen with a wallet's
  // rows to follow, the row the scroll has brought to the reading line. Else the wallet's first row
  // with a room, else the first pool. A tap or a focus takes it back until the next scroll.
  const mode = connected ? 'follow' : 'still';
  const touch = useMedia(TOUCH);
  const short = useMedia(SHORT);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const { picked, clear } = useFollow(touch && connected, wrapRef, frameRef, [...figs.keys()].join('|'));
  const followed = picked ? figs.get(picked.key) ?? null : null;
  // The row lights at once; the picture waits for the scroll to rest, so a quick scroll is not a
  // run of half-finished wipes. The rows either side are fetched ahead.
  const settledKey = useSettled(followed?.key ?? null, 150);
  const settled = settledKey ? figs.get(settledKey) ?? null : null;
  const nearRooms = (picked?.near ?? []).map((k) => figs.get(k)?.roomId ?? '').filter(Boolean).join('|');
  useEffect(() => { for (const room of nearRooms.split('|')) if (room) preloadDoor(room); }, [nearRooms]);
  const [hovered, setHovered] = useState<Fig | null>(null);
  const fallback = walletFigs.find((f) => f.roomId) ?? (pools[0] ? poolFig(pools[0], 0) : null);
  const shown = settled ?? hovered ?? fallback;
  const show = (f: Fig) => () => {
    setHovered(f);
    clear();
  };
  const isCurrent = (f: Fig) => followed?.key === f.key;
  const figure = shown && (
    <Figure fig={shown} mode={mode} unpinned={short} quick={touch} progress={picked ? (picked.i + 1) / picked.total : null} frameRef={frameRef} />
  );

  const total = holdingsTotal(board.holdings.map((l) => l.leg));
  // Shares and the tape only over a whole read: a part left out would misstate the rest.
  const shares = total.kind === 'total' ? holdingShares(heldRows) : [];
  const shareOf = new Map(shares.map((s) => [s.key, s.pct]));
  const everyLegRead = board.holdings.length > 0 && board.holdings.every((l) => l.leg.status === 'ok');

  return (
    <section
      id="dashboard"
      aria-labelledby="island-dashboard-heading"
      // overflow-clip lets the frame pin to the screen (FIG_CLASS); `hidden` stays for a browser without clip.
      className="relative isolate overflow-hidden supports-[overflow:clip]:overflow-clip scroll-mt-24 border border-white/15 px-4 pt-5 pb-4 md:px-7 md:pt-7 lg:px-10 lg:pt-9 lg:pb-6"
      style={{ background: EDITORIAL_BG, color: EDITORIAL_INK, textShadow: 'none' }}
    >
      <CardArt pageId="island-dashboard" idx={0} scrim="rgba(5,8,15,0.8)" />
      <div aria-hidden="true" className="absolute inset-0 pointer-events-none opacity-[0.08] mix-blend-screen" style={{ backgroundImage: EDITORIAL_GRAIN }} />

      <header className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end pb-5 border-b border-white/25">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[#f5e4b8]/60">
            <span aria-hidden="true" className="w-1.5 h-1.5 bg-[#22c55e]" />
            Your wallet
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
            {connected ? 'What your wallet holds, and your positions here, read from the chain.' : 'Connect a wallet to see what it holds and your positions here.'}
          </p>
          {connected && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] tracking-[0.08em] text-[#f5e4b8]/70">
              {board.solanaAddress && <span><ChainMark chain="solana" /> {shortSolanaAddress(board.solanaAddress)}</span>}
              {board.evmAddress && <span><ChainMark chain="ethereum" /> + Base {shortEvm(board.evmAddress)}</span>}
              <button type="button" onClick={board.refresh} className="min-h-[32px] underline underline-offset-4 uppercase tracking-[0.14em] hover:text-[#22c55e]">Refresh</button>
            </div>
          )}
        </div>

        {/* The holdings' worth, only when every coin held was read and priced (holdingsTotal). */}
        {connected && (
          <div className="flex flex-col items-start lg:items-end">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#f5e4b8]/55">Holdings</span>
            <span className="font-black leading-none tracking-[-0.05em] text-[52px] lg:text-[72px] tabular-nums" style={HEADING_FONT}>
              {total.kind === 'total' ? fmtUsd(total.usd) : total.kind === 'none' ? '$0' : '—'}
            </span>
            {total.kind === 'partial' && (
              <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f5e4b8]/55">
                {board.holdings.some((l) => l.leg.status === 'loading') ? 'reading' : 'not every coin priced'}
              </span>
            )}
          </div>
        )}

        {shares.length > 0 && <HoldingsSplit shares={shares} />}
      </header>

      {connected && everyLegRead && heldRows.length > 0 && <WalletTape rows={heldRows} />}

      {/* With a wallet: a phone stacks it, the frame first so it can pin above the rows (and every
          control under it scrolls clear of the pinned frame when focused); from 720px the board and
          the frame stand side by side with the pool list under both. Without one, the frame follows
          the connect buttons. From 1024px, either way, the frame runs on beside the pool list too
          (its row is 1fr, so a tall frame never opens a gap above the list). Grid areas are named on
          the parts themselves: outside a grid they do nothing. */}
      <div ref={wrapRef}
        className={mode === 'follow'
          ? "relative min-[720px]:grid min-[720px]:gap-x-7 lg:gap-x-10 min-[720px]:grid-cols-[minmax(0,1fr)_14rem] lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] lg:grid-rows-[auto_1fr] min-[720px]:[grid-template-areas:'board_fig'_'pools_pools'] lg:[grid-template-areas:'board_fig'_'pools_fig'] max-[719px]:[&_:is(a,button,summary)]:scroll-mt-[46vw]"
          : "relative lg:grid lg:gap-x-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] lg:grid-rows-[auto_1fr] lg:[grid-template-areas:'board_fig'_'pools_fig']"}>
        {mode === 'follow' && figure}
        <div className="min-w-0 [grid-area:board]">
          {connected ? (
            <>
              <LegBlock n={1} title="Holdings" legs={board.holdings}
                empty="No SOL, ETH or island coins in this wallet."
                render={(r, i) => {
                  const f = holdingFig(r, i);
                  return <HoldingItem key={r.key} n={i + 1} row={r} share={shareOf.get(r.key)} onShow={show(f)} figKey={f.key} current={isCurrent(f)} />;
                }} />
              <LegBlock n={2} title="Positions" legs={board.positions}
                empty="No locks, stakes or pool shares here yet. Every pool is listed below."
                render={(r, i) => {
                  const f = positionFig(r, i);
                  return <PositionItem key={r.key} n={i + 1} row={r} onShow={show(f)} figKey={f.key} current={isCurrent(f)} />;
                }} />
              {(!board.solanaAddress || !board.evmAddress) && (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <span className="text-[13px] text-[#f5e4b8]/70">Hold coins on the other chain too?</span>
                  <ConnectButtons solana={Boolean(board.solanaAddress)} evm={Boolean(board.evmAddress)} />
                </div>
              )}
            </>
          ) : (
            <div className="pt-8 pb-2 lg:pb-8">
              <ConnectButtons solana={false} evm={false} />
            </div>
          )}
        </div>
        {mode === 'still' && figure}

        {/* Every pool on the island, one press away: where a position starts. */}
        <details className="group/pools mt-6 border-t border-white/25 [grid-area:pools]">
          <summary className="flex items-center justify-between gap-3 min-h-[52px] cursor-pointer select-none list-none font-mono text-[11px] uppercase tracking-[0.16em] text-[#f5e4b8]/80 hover:text-[#22c55e] [&::-webkit-details-marker]:hidden">
            <span>All {pools.length} pools on the island · {chains} chains</span>
            <span aria-hidden="true" className="text-[16px] transition-transform duration-300 group-open/pools:rotate-45">+</span>
          </summary>
          <p className="flex items-center gap-2.5 pb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#f5e4b8]/70">
            <LadderWedge className="text-[#22c55e]" />
            Longer lock, bigger share
          </p>
          <ol className="min-w-0" aria-label="Pools on the island">
            {pools.map((row, i) => {
              const f = poolFig(row, i);
              return <PoolRow key={row.id} n={i + 1} row={row} onShow={show(f)} figKey={f.key} current={isCurrent(f)} />;
            })}
          </ol>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6">
            {/* The venue's OWN earning surface: its pools belong to the factory this venue deployed. */}
            <Link to="/liquidity"
              // The colour is a class: an inline colour would beat hover:text-*.
              className="group/lp inline-flex items-center gap-2 min-h-[44px] font-mono text-[11px] uppercase tracking-[0.14em] no-underline text-[#f5e4b8] transition-colors hover:text-[#22c55e]">
              Provide liquidity on venue pools
              <span aria-hidden="true" className="transition-transform duration-300 group-hover/lp:translate-x-1">→</span>
            </Link>
            <FinePrint summary="Why no rates here?">
              <p>
                Positions live in the room they were opened in. Each resident&apos;s pool is its own token, on
                its own chain, read by its own panel. The venue itself holds nothing on your behalf.
              </p>
              <p>
                &ldquo;Lock 7d–4y, 0.40×–4.00×&rdquo; is a lock ladder: lock from seven days to four years for
                that share of the pool&rsquo;s rewards, growing evenly with the lock, as the wedge draws it. A
                green mark on a lock&rsquo;s wedge is where that lock sits, from the share its pool reported.
              </p>
              <p>
                No rate is shown here because none is read here. Twelve pools across three chains would be
                twelve calls before this list could draw, and a call that does not answer renders as a zero,
                which would read as &ldquo;empty, pays nothing&rdquo; about a pool that may be neither. Pick a
                room to see its live rate, its rewards and what your position is worth.
              </p>
            </FinePrint>
          </div>
        </details>
      </div>
    </section>
  );
}
