import { Link } from 'react-router-dom';
import type { usePoolTVL } from '../../hooks/usePoolTVL';
import { TOKEN_LOGOS } from '../farm/poolConfig';

/**
 * The venue's own pools, as a table.
 *
 * WHY A TABLE AND NOT MORE CARDS. Cards are what this repo already had — one
 * `LivePoolCard` on /farm — and a card is the right shape for ONE pool being
 * shown off. It is the wrong shape for the question this page has to answer:
 * "what is here, how deep is it, and what does it pay?" That is a comparison,
 * and comparisons want aligned columns. It is also the shape every venue a
 * large wallet has already used presents pools in, so it needs no learning.
 *
 * ⚠️ EVERY NUMBER HERE HAS AN UNREADABLE STATE, AND IT IS NOT ZERO. `usePoolTVL`
 * already returns '–' for TVL and APR when the reserve or fee reads have not
 * landed (`isLoaded`, `feesReadOk`), and this table renders those verbatim
 * rather than coercing them to `$0` / `0%`. That is deliberate and it is the
 * repo's most-repeated bug class: a failed read that renders as a real zero
 * tells a visitor the pool is empty and pays nothing, which is a money-harmful
 * lie about a pool that may be neither. `aprIsEstimated` / `volIsEstimated`
 * carry the same honesty one step further — a derived figure is marked as
 * derived, in the footnote, not presented as a measurement.
 *
 * ONE ROW TODAY, and the table says so rather than implying a catalogue.
 * `UPCOMING_POOLS` was emptied by the 2026-06-09 credibility fix that deleted
 * four speculative cards, and nothing here re-adds them: a pool appears in this
 * table when it exists on chain. The empty-ish state is honest and the "seed a
 * new pair" line below turns it into an invitation instead of a dead end —
 * which is the actual answer to "not friendly for LPing": the venue is small,
 * and the first LP in a new pair sets its price and owns all of it.
 */
export function VenuePoolTable({ poolData }: { poolData: ReturnType<typeof usePoolTVL> }) {
  const rows = [
    {
      key: 'toweli-eth',
      base: 'TOWELI',
      quote: 'ETH',
      baseLogo: TOKEN_LOGOS.TOWELI,
      quoteLogo: TOKEN_LOGOS.ETH,
      kind: 'Constant product · 0.3%',
      tvl: poolData.tvlFormatted,
      apr: poolData.apr,
      vol: poolData.vol24hFormatted,
      aprIsEstimated: poolData.aprIsEstimated,
      volIsEstimated: poolData.volIsEstimated,
    },
  ];

  return (
    <section aria-labelledby="venue-pools-heading" className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 id="venue-pools-heading" className="text-white text-lg font-semibold">
          Pools on this venue
        </h2>
        <a href="#provide" className="text-[12.5px] underline underline-offset-2 text-white/70 hover:text-white">
          Seed a new pair ↓
        </a>
      </div>

      {/* overflow-x-auto on the WRAPPER, not the page: a five-column table has
          to scroll inside its own box on a 390px phone rather than making the
          document scroll sideways. */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[560px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-white/50">
                <th scope="col" className="font-semibold px-4 py-3">Pool</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">TVL</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">Est. APR</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">Est. 24h volume</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <th scope="row" className="px-4 py-3.5 font-normal">
                    <div className="flex items-center gap-3">
                      <div className="flex -space-x-2 flex-shrink-0">
                        <img src={r.baseLogo} alt="" className="w-7 h-7 rounded-full object-cover"
                          style={{ border: '2px solid var(--color-purple-30)' }} />
                        <img src={r.quoteLogo} alt="" className="w-7 h-7 rounded-full object-cover bg-[#627eea]/20"
                          style={{ border: '2px solid rgba(45,139,78,0.3)' }} />
                      </div>
                      <span className="min-w-0">
                        <span className="block text-white text-[14px] font-semibold whitespace-nowrap">
                          {r.base} / {r.quote}
                        </span>
                        {/* Naming the pool TYPE inline, not in a legend. It is
                            the thing that decides how the position behaves, and
                            a reader should not have to look it up. */}
                        <span className="block text-white/50 text-[11px] whitespace-nowrap">{r.kind}</span>
                      </span>
                    </div>
                  </th>
                  <td className="px-4 py-3.5 text-right text-white text-[14px] tabular-nums">{r.tvl}</td>
                  <td className="px-4 py-3.5 text-right text-[14px] tabular-nums" style={{ color: 'var(--color-success)' }}>
                    {r.apr}
                  </td>
                  <td className="px-4 py-3.5 text-right text-white/80 text-[14px] tabular-nums">{r.vol}</td>
                  <td className="px-4 py-3.5 text-right">
                    <a
                      href="#provide"
                      className="inline-flex items-center justify-center whitespace-nowrap px-3.5 py-2 min-h-[36px] rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110"
                      style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)' }}
                    >
                      Provide
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* The footnote is load-bearing, not decoration. It says which figures are
          measured and which are derived, and it says what a dash means — so a
          dash reads as "we could not read it", which is what it is, rather than
          as "nothing". */}
      <p className="mt-2.5 text-[11.5px] text-white/50 leading-relaxed">
        TVL is a live read of the pair&apos;s reserves.{' '}
        {rows.some((r) => r.aprIsEstimated || r.volIsEstimated)
          ? 'APR and 24h volume are estimated from those reserves and the fees the pool has accrued since it opened — not a measured trailing window. '
          : 'APR and 24h volume are measured. '}
        A dash means the read did not land, never that the number is zero.
      </p>

      <p className="mt-3 text-[12.5px] text-white/60 leading-relaxed">
        This venue is small on purpose and the list is short. Any ERC-20 pair can be opened here —
        if the pair does not exist yet, the first deposit creates it, sets its starting price, and
        owns 100% of it.
      </p>

      {/* /pools is the OTHER venue — the Solana AMM — and is a sibling tab, so
          this is a pointer rather than a link out of the section. */}
      <p className="mt-2 text-[12.5px] text-white/60">
        The venue also runs its own constant-product AMM on Solana.{' '}
        <Link to="/pools" className="underline underline-offset-2 text-white hover:text-white/80">
          See where that stands
        </Link>
        .
      </p>
    </section>
  );
}
