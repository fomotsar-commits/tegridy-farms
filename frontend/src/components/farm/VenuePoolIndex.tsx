import { Link } from 'react-router-dom';
import { BUNGALOWS } from '../../lib/bungalows';
import { doorArt } from '../../lib/doorArt';
import { artSrcSet } from '../../lib/artSrcSet';
import { EDITORIAL_BG, EDITORIAL_GRAIN, EDITORIAL_GREEN, EDITORIAL_INK, HEADING_FONT, pad2 } from '../../lib/editorial';
import { CHAIN_LABEL, hasLadder, rowTerms, venuePoolRows, type VenuePoolRow } from '../../lib/venuePools';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { LadderWedge } from '../ui/LadderWedge';

/**
 * Every pool on the island: /earn, whatever room the visitor is in. Each row
 * opens that pool at /earn/<id>, and each pool links back here.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. /farm gated on
 * `bungalow && bungalow.id !== DEFAULT_BUNGALOW_ID`, and `getActiveBungalow()`
 * returns null when NOTHING is chosen — so the venue's own default arrival, the
 * first impression a stranger gets, fell through to the classic TOWELI farm:
 * "Stake TOWELI and earn rewards · FAFO", TOWELI price, TOWELI balance, the
 * whole stack. TOWELI is the token of ONE bungalow. The venue does not have a
 * token, and it should not speak as though a resident's is its own.
 *
 * The classic farm did not move and was not edited — it is exactly where it was,
 * inside its own room (isToweliVoice()). This is what the venue says instead.
 *
 * ⚠️ IT READS NO CHAIN, ON PURPOSE, AND THAT IS THE DESIGN — not a shortcut.
 * Twelve pools across three chains would be twelve multicalls before this page
 * could render a single row, and the failure mode is the one this repo keeps
 * relearning: a read that does not land renders as `$0` / `0% APR`, which tells
 * a visitor a funded pool is empty and pays nothing. That is a money-harmful lie
 * about a pool that is neither.
 *
 * So the index is REGISTRY-DERIVED — chain, program shape and lock ladder are
 * facts of `BUNGALOWS`, true whether or not an RPC answers — and every rate,
 * balance and TVL stays where it is actually read: inside each room, on its own
 * self-gating panel, which can name the pool that failed and the reason it gave.
 * The rule this follows is the repo's: a number is publishable only when a read
 * returned it.
 *
 * ⚠️ A TABLE BY ROLE, LAID OUT AS A GRID AT EVERY WIDTH. Until 2026-10-14 it was
 * 520px wide by declaration inside a sideways-scrolling wrapper, so on a 390px
 * phone the "Open" column sat off the right edge and the visitor's first screen
 * showed three rows of wrapped terms and nothing to press (the lead's walk, Bayla
 * skin). Each row is its own grid, so no width can push its button off the edge,
 * and the table, row and cell roles are written out so a screen reader keeps the
 * table although no element is `display: table-*`. venueVoice.test.tsx reads the
 * index by its table role; e2e/pool-open-buttons.spec.ts taps every row's link.
 *
 * THE EDITORIAL LOOK (owner, 2026-11-14: "avantegarde edition 5d architect vibes"),
 * set out as an architect's schedule: a number, the room's door picture, the coin
 * in heavy type, its chain, its terms with the ladder drawn to scale, and the way
 * in. The numbers are drawn by CSS from `data-n`, so they are not words (the list's
 * word budget, e2e/word-budget.spec.ts). The whole row is the link's target (its
 * `after` covers the row), and a row pointed at lights its block on the site model
 * above (IsoIsland.tsx): `activeId` and `onActive` tie the two.
 *
 * The room's name is no longer printed beside its coin: on every row it repeated
 * the ticker ("QR QR", "PEPE Pepe"), twelve words for no information.
 */

const CHAIN_DOT: Record<string, string> = { solana: '#4CAF50', ethereum: '#8b5cf6', base: '#2151f5' };

/**
 * One template for the heading row and every pool row, so the columns line up although each row
 * is its own grid. A phone: the picture, the coin with its chain beside it and its terms under,
 * and the way in. From 768px a number leads and the terms take a column; from 1024px the chain
 * takes one too.
 */
const ROW_GRID =
  "grid items-center gap-x-3 md:gap-x-4 grid-cols-[2.75rem_auto_minmax(0,1fr)_2.75rem] [grid-template-areas:'pic_coin_chain_open'_'pic_terms_terms_open'] "
  + "md:grid-cols-[1.75rem_2.75rem_auto_minmax(0,1fr)_13.5rem_10.25rem] md:[grid-template-areas:'n_pic_coin_chain_terms_open'] "
  + "lg:grid-cols-[1.75rem_2.75rem_minmax(0,1fr)_7rem_13.5rem_10.25rem]";

const CAPTION = 'font-mono text-[10px] uppercase tracking-[0.16em] text-[#f5e4b8]/65';

function Row({ n, row, current, onActive }: { n: number; row: VenuePoolRow; current: boolean; onActive?: (id: string | null) => void }) {
  const room = BUNGALOWS.find((b) => b.id === row.id);
  const door = room ? doorArt(room) : null;
  const thumbSet = door ? artSrcSet(door.src) : undefined;
  return (
    <tr
      role="row"
      data-current={current ? '' : undefined}
      onMouseEnter={() => onActive?.(row.id)}
      className={`group/row relative min-h-[64px] py-2.5 md:pl-3 border-b border-white/[0.10] ${ROW_GRID}`}
    >
      {/* The resident's colour rising up the row's edge, and the rule under it sweeping green, as the menu's do. */}
      <td aria-hidden="true" className="contents">
        <span className="absolute -left-3 md:left-0 top-0 bottom-0 w-[3px] origin-bottom scale-y-0 transition-transform duration-300 ease-out group-hover/row:scale-y-100 group-focus-within/row:scale-y-100 group-data-current/row:scale-y-100"
          style={{ background: row.accent ?? EDITORIAL_GREEN }} />
        <span className="absolute left-0 right-0 -bottom-px h-px origin-left scale-x-0 bg-[#22c55e] transition-transform duration-500 ease-out group-hover/row:scale-x-100 group-focus-within/row:scale-x-100 group-data-current/row:scale-x-100" />
        <span data-n={pad2(n)}
          className="hidden md:block [grid-area:n] font-mono text-[11px] tracking-[0.12em] tabular-nums text-[#f5e4b8]/45 transition-colors before:content-[attr(data-n)] group-hover/row:text-[#22c55e] group-data-current/row:text-[#22c55e]" />
        <span className="[grid-area:pic] relative w-11 h-11 overflow-hidden border border-white/15">
          {door && (
            <img src={door.src} {...(thumbSet ? { srcSet: thumbSet, sizes: '44px' } : {})} alt="" loading="lazy" decoding="async" width={44} height={44}
              className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover/row:scale-110 group-data-current/row:scale-110"
              style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined} />
          )}
        </span>
      </td>

      <th role="rowheader" scope="row" className="[grid-area:coin] min-w-0 p-0 text-left font-normal">
        <span
          className="block truncate font-black leading-[0.95] tracking-[-0.045em] text-[22px] md:text-[26px] lg:text-[30px] transition-[transform,color] duration-300 ease-out group-hover/row:translate-x-1.5 group-hover/row:text-white group-data-current/row:translate-x-1.5 group-data-current/row:text-white"
          style={HEADING_FONT}
        >
          {row.symbol}
        </span>
      </th>
      <td role="cell" className="[grid-area:chain] min-w-0 p-0 max-lg:self-end max-md:pb-[3px] md:max-lg:pb-1 font-mono text-[10px] md:text-[11px] uppercase tracking-[0.12em] text-[#f5e4b8]/70">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden="true" className="w-1.5 h-1.5 flex-shrink-0" style={{ background: CHAIN_DOT[row.chain] ?? EDITORIAL_INK }} />
          {CHAIN_LABEL[row.chain] ?? row.chain}
        </span>
      </td>
      {/* Never cut: "0.40×–4.00×" with its ceiling cut off would misstate the ladder. */}
      <td role="cell" className="[grid-area:terms] min-w-0 p-0 max-md:mt-1.5 font-mono text-[10.5px] md:text-[11px] tracking-[0.04em] text-[#f5e4b8]/70">
        <span className="inline-flex items-center gap-2">
          {hasLadder(row.terms) && <LadderWedge className="text-[#f5e4b8]/70 transition-colors group-hover/row:text-[#22c55e] group-data-current/row:text-[#22c55e]" />}
          <span className="whitespace-nowrap">{rowTerms(row.terms)}</span>
        </span>
      </td>
      <td role="cell" className="[grid-area:open] p-0 max-md:justify-self-end">
        {/* A real link: each pool has its own address, /earn/<id>, which enters that pool's room
            on arrival (App.tsx EarnPoolRoute). Its `after` covers the row, so the whole row opens
            the pool; the words stay the link's own on a phone, where only the arrow is drawn. */}
        <Link
          to={`/earn/${row.id}`}
          onFocus={() => onActive?.(row.id)}
          className="inline-flex items-center justify-center md:justify-between gap-2.5 w-11 h-11 md:w-full md:h-auto md:min-h-[44px] md:pl-3.5 md:pr-3 border border-white/20 no-underline font-mono text-[11px] uppercase tracking-[0.14em] text-[#f5e4b8] transition-colors duration-300 after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[#22c55e] group-hover/row:bg-[#22c55e] group-hover/row:border-[#22c55e] group-hover/row:text-[#05080f] group-focus-within/row:bg-[#22c55e] group-focus-within/row:border-[#22c55e] group-focus-within/row:text-[#05080f]"
        >
          <span className="max-md:sr-only whitespace-nowrap">Open {row.symbol}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"
            className="flex-shrink-0 transition-transform duration-300 group-hover/row:translate-x-0.5">
            <path d="M4 12h15M13 6l6 6-6 6" />
          </svg>
        </Link>
      </td>
    </tr>
  );
}

export function VenuePoolIndex({ activeId = null, onActive }: {
  /** The pool pointed at on the site model above, by id: its row lights. */
  activeId?: string | null;
  onActive?: (id: string | null) => void;
} = {}) {
  const rows = venuePoolRows();

  return (
    <section
      aria-labelledby="venue-pools-index"
      className="relative isolate border-t border-white/25 px-4 pt-4 pb-3 md:px-7 lg:px-10"
      style={{ background: EDITORIAL_BG, color: EDITORIAL_INK, textShadow: 'none' }}
    >
      <CardArt pageId="earn" idx={1} scrim="rgba(5,8,15,0.88)" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 pointer-events-none opacity-[0.08] mix-blend-screen" style={{ backgroundImage: EDITORIAL_GRAIN }} />

      {/* The section's one heading. venueVoice.test.tsx reads it by text: the
          venue names the whole island, not one resident. */}
      <h2 id="venue-pools-index" className="flex items-center gap-2 pb-3 font-mono text-[11px] font-normal uppercase tracking-[0.16em] text-[#f5e4b8]/70">
        <span aria-hidden="true" className="w-1.5 h-1.5 bg-[#22c55e]" />
        Earn across Jungle Bay Island
      </h2>

      <table role="table" className="block w-full text-left" onMouseLeave={() => onActive?.(null)}>
        <thead className="block max-md:hidden border-y border-white/25">
          <tr role="row" className={`py-2 md:pl-3 ${ROW_GRID} ${CAPTION}`}>
            <th role="columnheader" scope="col" className="[grid-area:coin] p-0 font-normal">Pool</th>
            <th role="columnheader" scope="col" className="[grid-area:chain] p-0 font-normal max-lg:hidden">Chain</th>
            <th role="columnheader" scope="col" className="[grid-area:terms] p-0 font-normal">Terms</th>
            <th role="columnheader" scope="col" className="[grid-area:open] p-0 font-normal">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody className="block max-md:border-t max-md:border-white/25">
          {rows.map((b, i) => (
            <Row key={b.id} n={i + 1} row={b} current={activeId === b.id} onActive={onActive} />
          ))}
        </tbody>
      </table>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6">
        {/* The venue's OWN surface, named as such. Liquidity is the one earning
            route that is genuinely the VENUE's rather than a resident's — the
            pools belong to the factory this protocol deployed — so it is the only
            thing that earns a line of its own under a table of thirteen peers. */}
        <Link
          to="/liquidity"
          // The colour is a class: an inline colour would beat hover:text-*.
          className="group/lp inline-flex items-center gap-2 min-h-[44px] font-mono text-[11px] uppercase tracking-[0.14em] no-underline text-[#f5e4b8] transition-colors hover:text-[#22c55e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22c55e]"
        >
          Provide liquidity on venue pools
          <span aria-hidden="true" className="transition-transform duration-300 group-hover/lp:translate-x-1">→</span>
        </Link>
        <FinePrint summary="Why no rates?">
          <p>
            Pick a pool to see its live rate and rewards. &ldquo;Lock 7d–4y, 0.40×–4.00×&rdquo; is a
            lock ladder: lock from seven days to four years for that share of the pool&rsquo;s rewards,
            growing evenly with the lock, as the wedge and the model&rsquo;s ramps draw it. A flat block
            is a pool with no ladder.
          </p>
          <p>
            Every resident community runs its own pool, in its own token, on its own chain. Pick a
            room to see its live rate, its reward balance and what your position is worth. Those
            numbers are read on chain there, where a failed read can say so.
          </p>
          <p>
            No rate is shown here because none is read here. Twelve pools across three chains would be
            twelve calls before this list could draw, and a call that does not answer renders as a zero,
            which would read as &ldquo;empty, pays nothing&rdquo; about a pool that may be neither.
            Each room reads its own.
          </p>
        </FinePrint>
      </div>
    </section>
  );
}
