import { useState, type CSSProperties, type ReactNode } from 'react';
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
 * corners, grain. Every row carries its room's door picture: beside the word under 1024px, and
 * from 1024px in a big frame that follows the pointer. The frame shows at every width: under
 * 1024px it is a wide plate under the board.
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

function RowRules({ accent }: { accent?: string }) {
  return (
    <>
      <span aria-hidden="true"
        className="absolute left-0 top-0 bottom-0 w-[3px] origin-bottom scale-y-0 transition-transform duration-300 ease-out group-hover/row:scale-y-100 group-focus-visible/row:scale-y-100"
        style={{ background: accent ?? GREEN }} />
      <span aria-hidden="true"
        className="absolute left-0 right-0 -bottom-px h-px origin-left scale-x-0 bg-[#22c55e] transition-transform duration-500 ease-out group-hover/row:scale-x-100 group-focus-visible/row:scale-x-100" />
    </>
  );
}

/** The row's number, from 768px; the picture carries the row on a phone. */
function Index({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="hidden md:block self-start pt-1 font-mono text-[11px] tracking-[0.12em] tabular-nums text-[#f5e4b8]/45 transition-colors group-hover/row:text-[#22c55e]">
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
function HoldingItem({ n, row, share, onShow }: { n: number; row: HoldingRow; share: number | undefined; onShow: () => void }) {
  const body = (
    <>
      <RowRules accent={accentOf(row.roomId)} />
      <Index n={n} />
      <Thumb roomId={row.roomId} chain={row.chain} />
      <span className="min-w-0">
        <span className="block truncate font-black leading-[0.95] tracking-[-0.045em] text-[24px] md:text-[30px] transition-[transform,color] duration-300 ease-out group-hover/row:translate-x-1.5 group-hover/row:text-white" style={HEADING_FONT}>
          {row.symbol}
        </span>
        <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#f5e4b8]/60"><ChainMark chain={row.chain} /></span>
      </span>
      <span className="text-right">
        <span className="block font-black leading-none tracking-[-0.03em] text-[20px] md:text-[26px] tabular-nums" style={HEADING_FONT}>{row.amount}</span>
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
  return (
    <m.li {...rise(n - 1)}>
      {row.to ? (
        <Link to={row.to} aria-label={`${row.symbol}: ${row.amount}, open its room`} onMouseEnter={onShow} onFocus={onShow} className={cls} style={{ color: EDITORIAL_INK }}>
          {body}
        </Link>
      ) : (
        <div className={cls} onMouseEnter={onShow}>{body}</div>
      )}
    </m.li>
  );
}

/** One position on this site: what it is, its read facts, its place on the ladder, and the door to it. */
function PositionItem({ n, row, onShow }: { n: number; row: PositionRow; onShow: () => void }) {
  const boost = boostOf(row.facts);
  return (
    <m.li {...rise(n - 1)}>
      <Link to={row.to} aria-label={`${row.title}: ${row.facts.join(', ')}. Open it`} onMouseEnter={onShow} onFocus={onShow}
        className={`${ROW_CLASS} grid-cols-[2.75rem_minmax(0,1fr)_2.5rem] md:grid-cols-[2rem_2.75rem_minmax(0,14rem)_minmax(0,1fr)_2.5rem]`} style={{ color: EDITORIAL_INK }}>
        <RowRules accent={accentOf(row.roomId)} />
        <Index n={n} />
        <Thumb roomId={row.roomId} chain={row.chain} />
        <span className="min-w-0">
          <span className="flex items-center gap-2.5 min-w-0">
            <span className="truncate font-black leading-[0.95] tracking-[-0.045em] text-[20px] md:text-[24px] transition-[transform,color] duration-300 ease-out group-hover/row:translate-x-1.5 group-hover/row:text-white" style={HEADING_FONT}>
              {row.title}
            </span>
            {boost !== null && <LockMark boost={boost} />}
          </span>
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#f5e4b8]/60"><ChainMark chain={row.chain} /></span>
          {/* A phone: the facts under the title. */}
          <span className="md:hidden mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-[#f5e4b8]/80">
            {row.facts.map((f) => <span key={f}>{f}</span>)}
          </span>
        </span>
        <span className="hidden md:flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px] tracking-[0.02em] text-[#f5e4b8]/85">
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

/**
 * The big frame: the door picture of the row under the pointer, captioned as a plate. From 1024px
 * it stands beside the board. Under 1024px (a phone, an upright iPad) it is a wide plate under the
 * board, so the rows still come first (owner, 2026-10-23: "the mobile and ipad dont have the
 * dashboard updated like pc version"; it was hidden there).
 */
function Figure({ n, roomId, caption }: { n: number; roomId: string; caption: string }) {
  const room = BUNGALOWS.find((b) => b.id === roomId);
  const door = doorOf(roomId);
  const reduce = prefersReducedMotion();
  const srcSet = door ? artSrcSet(door.src) : undefined;
  return (
    <div aria-hidden="true" className="mt-6 lg:mt-0 lg:sticky lg:top-24 self-start lg:pt-4">
      <div className="relative aspect-[4/3] md:aspect-[16/9] lg:aspect-[4/5] overflow-hidden border border-white/15" style={{ background: EDITORIAL_BG }}>
        <AnimatePresence initial={false}>
          <m.div key={roomId} className="absolute inset-0"
            initial={reduce ? { opacity: 0 } : { clipPath: 'inset(100% 0% 0% 0%)' }}
            animate={reduce ? { opacity: 1 } : { clipPath: 'inset(0% 0% 0% 0%)' }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
            transition={{ duration: 0.7, ease: EDITORIAL_EASE }}>
            {door && (
              // art-bright: index.css dims any full-bleed art to 0.45; nothing but a caption sits on this one.
              <img src={door.src} {...(srcSet ? { srcSet, sizes: '(min-width: 1024px) 360px, 100vw' } : {})} alt="" loading="lazy" decoding="async"
                className="w-full h-full object-cover art-bright"
                style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined} />
            )}
          </m.div>
        </AnimatePresence>
        <span className="absolute inset-x-0 bottom-0 h-2/5 pointer-events-none" style={{ background: `linear-gradient(to top, ${EDITORIAL_BG} 0%, rgba(5,8,15,0) 100%)` }} />
        {/* The resident's word, outlined and cut by the frame's foot. */}
        <span key={`w-${roomId}`} className="absolute left-4 bottom-0 translate-y-[24%] whitespace-nowrap font-black leading-none tracking-[-0.06em] text-[clamp(3.5rem,15vw,7.5rem)] lg:text-[clamp(3.5rem,6.2vw,5.75rem)] select-none"
          style={{ ...HEADING_FONT, ...OUTLINE }}>
          {room?.symbol ?? ''}
        </span>
      </div>
      <div className="mt-2 flex justify-between gap-3 font-mono text-[11px] tracking-[0.12em] text-[#f5e4b8]/60">
        <span>fig. {pad2(n)}</span>
        <span className="truncate">{caption}</span>
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
  // The frame shows the row under the pointer, else the wallet's first row with a room, else the first pool.
  const walletRooms = [
    ...heldRows,
    ...board.positions.flatMap((l) => (l.leg.status === 'ok' ? l.leg.rows : [])),
  ].flatMap((r) => (r.roomId ? [r.roomId] : []));
  const [hovered, setHovered] = useState<{ roomId: string; caption: string; n: number } | null>(null);
  const fallbackRoom = walletRooms[0] ?? pools[0]?.id ?? 'bayla';
  const fallback = BUNGALOWS.find((b) => b.id === fallbackRoom);
  const shown = hovered ?? { roomId: fallbackRoom, caption: fallback ? `${fallback.name} · ${CHAIN_LABEL[fallback.chain] ?? fallback.chain}` : '', n: 1 };
  const show = (roomId: string | null, caption: string, n: number) => () => {
    if (roomId) setHovered({ roomId, caption, n });
  };

  const total = holdingsTotal(board.holdings.map((l) => l.leg));
  // Shares and the tape only over a whole read: a part left out would misstate the rest.
  const shares = total.kind === 'total' ? holdingShares(heldRows) : [];
  const shareOf = new Map(shares.map((s) => [s.key, s.pct]));
  const everyLegRead = board.holdings.length > 0 && board.holdings.every((l) => l.leg.status === 'ok');

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

      <div className="relative grid lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] gap-x-10">
        <div className="min-w-0">
          {connected ? (
            <>
              <LegBlock n={1} title="Holdings" legs={board.holdings}
                empty="No SOL, ETH or island coins in this wallet."
                render={(r, i) => <HoldingItem key={r.key} n={i + 1} row={r} share={shareOf.get(r.key)} onShow={show(r.roomId, `${r.symbol} · ${WALLET_CHAIN_LABEL[r.chain]}`, 1)} />} />
              <LegBlock n={2} title="Positions" legs={board.positions}
                empty="No locks, stakes or pool shares here yet. Every pool is listed below."
                render={(r, i) => <PositionItem key={r.key} n={i + 1} row={r} onShow={show(r.roomId, `${r.title} · ${WALLET_CHAIN_LABEL[r.chain]}`, 2)} />} />
              {(!board.solanaAddress || !board.evmAddress) && (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <span className="text-[13px] text-[#f5e4b8]/70">Hold coins on the other chain too?</span>
                  <ConnectButtons solana={Boolean(board.solanaAddress)} evm={Boolean(board.evmAddress)} />
                </div>
              )}
            </>
          ) : (
            <div className="py-8">
              <ConnectButtons solana={false} evm={false} />
            </div>
          )}

          {/* Every pool on the island, one press away: where a position starts. */}
          <details className="group/pools mt-6 border-t border-white/25">
            <summary className="flex items-center justify-between gap-3 min-h-[52px] cursor-pointer select-none list-none font-mono text-[11px] uppercase tracking-[0.16em] text-[#f5e4b8]/80 hover:text-[#22c55e] [&::-webkit-details-marker]:hidden">
              <span>All {pools.length} pools on the island · {chains} chains</span>
              <span aria-hidden="true" className="text-[16px] transition-transform duration-300 group-open/pools:rotate-45">+</span>
            </summary>
            <p className="flex items-center gap-2.5 pb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#f5e4b8]/70">
              <LadderWedge className="text-[#22c55e]" />
              Longer lock, bigger share
            </p>
            <ol className="min-w-0" aria-label="Pools on the island">
              {pools.map((row, i) => (
                <PoolRow key={row.id} n={i + 1} row={row} onShow={show(row.id, `${row.name} · ${CHAIN_LABEL[row.chain] ?? row.chain}`, i + 1)} />
              ))}
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
        <Figure n={shown.n} roomId={shown.roomId} caption={shown.caption} />
      </div>
    </section>
  );
}
