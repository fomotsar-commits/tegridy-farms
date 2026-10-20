import { Link } from 'react-router-dom';
import type { usePoolTVL } from '../../hooks/usePoolTVL';
import { TOKEN_LOGOS } from '../farm/poolConfig';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

/**
 * The venue's own pools, as a table.
 *
 * No APR column: usePoolTVL().apr is the fee router's take, the venue's income,
 * not what an LP earns. A '–' is a read that did not land, never zero; it is
 * drawn as given. Below 640px TVL and Routed 24h fold under the pair's name, so
 * the Provide button stays on the screen beside it.
 */
export function VenuePoolTable({ poolData }: { poolData: ReturnType<typeof usePoolTVL> }) {
  const rows = [
    {
      key: 'toweli-eth',
      base: 'TOWELI',
      quote: 'ETH',
      baseLogo: TOKEN_LOGOS.TOWELI,
      quoteLogo: TOKEN_LOGOS.ETH,
      kind: '0.3% fee',
      tvl: poolData.tvlFormatted,
      vol: poolData.vol24hFormatted,
    },
  ];

  return (
    <section aria-labelledby="venue-pools-heading" className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 id="venue-pools-heading" className="text-white text-lg font-semibold">
          Pools
        </h2>
        <a href="#provide" className="text-[12.5px] underline underline-offset-2 text-white/70 hover:text-white">
          Seed a new pair ↓
        </a>
      </div>

      {/* overflow-x-auto on the WRAPPER, not the page: should the table ever
          outgrow its box, it scrolls inside it and the document never scrolls
          sideways. On a phone it fits (see the 640px fold below). */}
      <div
        className="relative isolate rounded-2xl overflow-hidden"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      >
        <CardArt pageId="liquidity" idx={1} />
        {/* `relative` IS LOAD-BEARING — it is what CONTAINS the sr-only span in the
            last <th>. `sr-only` is position:absolute, clipped by this overflow only
            when this box is positioned; static, the span painted at the table's
            right edge and the whole page scrolled sideways on a phone. */}
        <div className="relative overflow-x-auto">
          <table className="w-full text-left border-collapse sm:min-w-[520px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-white/50">
                <th scope="col" className="font-semibold px-4 py-3">Pool</th>
                <th scope="col" className="hidden sm:table-cell font-semibold px-4 py-3 text-right">TVL</th>
                {/* "Routed", not "24h volume". The figure is reconstructed from
                    the fee router's own take (usePoolTVL.ts:145-150), so it sees
                    only swaps that came through the venue's router and not those
                    that hit the pair directly. Naming the scope in the column
                    head is cheaper than a footnote nobody reads. */}
                <th scope="col" className="hidden sm:table-cell font-semibold px-4 py-3 text-right">Routed 24h</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <th scope="row" className="pl-4 pr-2 sm:pr-4 py-3.5 font-normal">
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
                        {/* Naming the pool TYPE and its fee inline, not in a
                            legend. Together they decide how the position
                            behaves, and a reader should not have to look either
                            one up. Both are contract constants, not reads. */}
                        <span className="block text-white/50 text-[11px] whitespace-nowrap">{r.kind}</span>
                        {/* Below 640px the TVL and Routed 24h cells are hidden; their figures ride here. */}
                        <span className="sm:hidden block mt-1 text-white/80 text-[12px] tabular-nums whitespace-nowrap">
                          TVL {r.tvl} · Routed 24h {r.vol}
                        </span>
                      </span>
                    </div>
                  </th>
                  <td className="hidden sm:table-cell px-4 py-3.5 text-right text-white text-[14px] tabular-nums">{r.tvl}</td>
                  <td className="hidden sm:table-cell px-4 py-3.5 text-right text-white/80 text-[14px] tabular-nums">{r.vol}</td>
                  <td className="pl-2 pr-4 sm:pl-4 py-3.5 text-right">
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

      {/* The one line that stays out: a dash is "not read", never a zero. What
          each number is, and why there is no APR column, sit in the small print
          below, closed but in the DOM. */}
      <p className="mt-2.5 text-[11.5px] text-white/50 leading-relaxed">
        A dash: not read, never zero.
      </p>

      <FinePrint summary="Details">
        <p>
          A dash means the read did not land, never that the number is zero. The pool is a constant-product pool with a 0.3% fee.{' '}
          TVL is a live read of the pair&apos;s reserves. &ldquo;Routed 24h&rdquo; is reconstructed from the
          venue router&apos;s own fee take, so it counts swaps that came through this venue and not
          those that hit the pool directly.{' '}
          <strong className="text-white/85">There is deliberately no APR column:</strong> the only fee
          figure this venue can read on chain is the router&apos;s platform fee, which is the
          protocol&apos;s income rather than yours, and annualising it against the pool would misstate
          what providing liquidity actually pays.
        </p>
        <p>
          This venue is small on purpose and the list is short. Most ERC-20 pairs can be opened here —
          ERC-777 tokens are refused by the factory — and if the pair does not exist yet, the first
          deposit creates it and sets its starting price.
        </p>
        {/* /pools is the OTHER venue — the Solana AMM — and is a sibling tab, so
            this is a pointer rather than a link out of the section. */}
        <p>
          The venue also runs its own constant-product AMM on Solana.{' '}
          <Link to="/pools" className="underline underline-offset-2 text-white hover:text-white/80">
            See where that stands
          </Link>
          .
        </p>
      </FinePrint>
    </section>
  );
}
