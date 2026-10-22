import { Link } from 'react-router-dom';
import { CHAIN_LABEL, rowTerms, venuePoolRows } from '../../lib/venuePools';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

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
 * ⚠️ ONE TABLE, TWO LAYOUTS, SINCE 2026-10-14. The table was 520px wide by
 * declaration inside a sideways-scrolling wrapper, so on a 390px phone the
 * "Open" column sat off the right edge and the visitor's first screen showed
 * three rows of wrapped terms and nothing to press (the lead's walk, Bayla
 * skin). Below `sm` the same <table> now lays each row out as a wrapped flex
 * line with its button on it, and the header row is hidden; the table, row and
 * cell roles are written out so a screen reader keeps the table once `display`
 * is no longer `table-*`. venueVoice.test.tsx reads the index by its table
 * role. The name column is hidden on phones; the symbol is the name there.
 */

/** A cell that reads as "· Ethereum" on a phone line and as a plain column on a desktop row. */
const PHONE_INLINE_CELL =
  "max-sm:p-0 max-sm:text-[12px] max-sm:before:mr-2 max-sm:before:text-white/30 max-sm:before:content-['·']";

export function VenuePoolIndex() {
  const rows = venuePoolRows();

  return (
    <section aria-labelledby="venue-pools-index" className="mb-8">
      <div
        className="relative isolate rounded-2xl overflow-hidden"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      >
        <CardArt pageId="earn" idx={1} />
        {/* The card's one heading. venueVoice.test.tsx reads it by text: the
            venue names the whole island, not one resident. */}
        <h2
          id="venue-pools-index"
          className="px-4 pt-3.5 pb-1 text-[11px] uppercase tracking-wider font-semibold text-white/60"
        >
          Earn across Jungle Bay Island
        </h2>
        <table role="table" className="w-full text-left border-collapse max-sm:block">
          <thead className="max-sm:hidden">
            <tr role="row" className="text-[10px] uppercase tracking-wider text-white/50">
              <th role="columnheader" scope="col" className="font-semibold px-4 py-3">Pool</th>
              <th role="columnheader" scope="col" className="font-semibold px-4 py-3">Chain</th>
              <th role="columnheader" scope="col" className="font-semibold px-4 py-3">Terms</th>
              <th role="columnheader" scope="col" className="font-semibold px-4 py-3 text-right">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {rows.map((b) => (
              <tr
                key={b.id}
                role="row"
                className="max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-2 max-sm:gap-y-1 max-sm:px-4 max-sm:py-2.5"
                style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
              >
                <th role="rowheader" scope="row" className="px-4 py-3.5 font-normal max-sm:p-0">
                  <span className="flex items-center gap-2.5">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: b.accent ?? 'var(--color-kyle)' }}
                      aria-hidden="true"
                    />
                    <span className="text-white text-[14px] font-semibold">{b.symbol}</span>
                    <span className="hidden sm:inline text-white/45 text-[12px]">{b.name}</span>
                  </span>
                </th>
                <td role="cell" className={`px-4 py-3.5 text-white/75 text-[13px] ${PHONE_INLINE_CELL}`}>
                  {CHAIN_LABEL[b.chain] ?? b.chain}
                </td>
                <td role="cell" className={`px-4 py-3.5 text-white/60 text-[12.5px] ${PHONE_INLINE_CELL}`}>
                  {rowTerms(b.terms)}
                </td>
                <td role="cell" className="px-4 py-3.5 text-right max-sm:p-0 max-sm:ml-auto">
                  {/* A real link: each pool has its own address, /earn/<id>, which
                      enters that pool's room on arrival (App.tsx EarnPoolRoute). */}
                  <Link
                    to={`/earn/${b.id}`}
                    className="inline-flex items-center justify-center whitespace-nowrap px-3.5 py-2 min-h-[36px] rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110"
                    style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)' }}
                  >
                    Open {b.symbol}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <FinePrint summary="Why no rates?" className="mt-1.5">
        <p>
          Pick a pool to see its live rate and rewards. &ldquo;Lock 7d–4y, 0.40×–4.00×&rdquo; is a
          lock ladder: lock from seven days to four years for that share of the pool&rsquo;s rewards.
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

      {/* The venue's OWN surface, named as such. Liquidity is the one earning
          route that is genuinely the VENUE's rather than a resident's — the
          pools belong to the factory this protocol deployed — so it is the only
          thing that earns a line of its own under a table of thirteen peers. */}
      <div className="mt-5">
        <Link
          to="/liquidity"
          className="text-[13px] underline underline-offset-2 text-white/80 hover:text-white"
        >
          Provide liquidity on venue pools →
        </Link>
      </div>
    </section>
  );
}
