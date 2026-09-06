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
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THERE IS NO APR COLUMN. This is the most important thing in the file.
 *
 * The first cut of this table had one, reading `usePoolTVL().apr`, and it was
 * WRONG in a way that mattered: that figure is derived from
 * `SwapFeeRouter.totalETHFees()` (usePoolTVL.ts:48, :131-139), which is the
 * VENUE's own platform fee — skimmed off `msg.value` BEFORE the swap reaches
 * the pair (SwapFeeRouter.sol:721-732) — annualised against this pool's TVL.
 *
 * It is not the LP's income. The LP's income is the pair's 0.3% swap fee, of
 * which 5/6 accrues into the reserves and 1/6 goes to the protocol's `feeTo`
 * (TegridyPair.sol:16-17). Those are different parties taking different cuts of
 * different bases. Worse, `totalETHFees` counts only swaps that went THROUGH
 * the fee router, so it also undercounts the pool's actual activity.
 *
 * Printing that under a column head an LP reads as "what will I earn" is a
 * money-harmful mislabel, and a table is where it does the most damage because
 * a column head is read as a promise. So the column is gone, and the footnote
 * says why rather than leaving the absence to look like an oversight. When a
 * real LP-fee APR can be read — accumulated fees per LP token, from the pair —
 * it can come back.
 *
 * (The same figure is labelled "APR" on `LivePoolCard` inside the TOWELI farm.
 * That is pre-existing and NOT changed here: it has its own tests and its own
 * surface, and silently redefining another page's numbers from this file would
 * be worse than reporting it. It is written up for the operator.)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * EVERY REMAINING NUMBER HAS AN UNREADABLE STATE, AND IT IS NOT ZERO.
 * `usePoolTVL` returns '–' for TVL when the reserve read has not landed
 * (`isLoaded`) and for volume when the fee read has not (`feesReadOk`), and this
 * table renders those verbatim rather than coercing them to `$0`. A failed read
 * that renders as a real zero tells a visitor the pool is empty and pays
 * nothing, which is a lie about a pool that may be neither.
 */
export function VenuePoolTable({ poolData }: { poolData: ReturnType<typeof usePoolTVL> }) {
  const rows = [
    {
      key: 'toweli-eth',
      base: 'TOWELI',
      quote: 'ETH',
      baseLogo: TOKEN_LOGOS.TOWELI,
      quoteLogo: TOKEN_LOGOS.ETH,
      kind: 'Constant product · 0.3% fee',
      tvl: poolData.tvlFormatted,
      vol: poolData.vol24hFormatted,
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

      {/* overflow-x-auto on the WRAPPER, not the page: the table has to scroll
          inside its own box on a 390px phone rather than making the document
          scroll sideways. */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      >
        {/* `relative` IS LOAD-BEARING — it is what CONTAINS the sr-only span in the
            last <th>. Tailwind's `sr-only` is `position:absolute`, and an
            absolutely-positioned element is clipped by an ancestor's overflow
            ONLY if that ancestor is its containing block, i.e. positioned. With
            a STATIC scroll wrapper the span escaped the clip, painted at the
            520px table's right edge, and dragged `documentElement.scrollWidth`
            to 521 on a 390px phone — so the whole PAGE scrolled sideways while
            the table itself sat there looking perfectly contained.

            Measured live before the fix: /liquidity and /farm both scrolled
            horizontally at 390px; /trust (same RouteTabs, no wide table) did
            not. Proven by A/B/A in the page: remove the span -> 390, restore it
            -> 521, add `relative` here -> 390. */}
        <div className="relative overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[520px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-white/50">
                <th scope="col" className="font-semibold px-4 py-3">Pool</th>
                <th scope="col" className="font-semibold px-4 py-3 text-right">TVL</th>
                {/* "Routed", not "24h volume". The figure is reconstructed from
                    the fee router's own take (usePoolTVL.ts:145-150), so it sees
                    only swaps that came through the venue's router and not those
                    that hit the pair directly. Naming the scope in the column
                    head is cheaper than a footnote nobody reads. */}
                <th scope="col" className="font-semibold px-4 py-3 text-right">Routed 24h</th>
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
                        {/* Naming the pool TYPE and its fee inline, not in a
                            legend. Together they decide how the position
                            behaves, and a reader should not have to look either
                            one up. Both are contract constants, not reads. */}
                        <span className="block text-white/50 text-[11px] whitespace-nowrap">{r.kind}</span>
                      </span>
                    </div>
                  </th>
                  <td className="px-4 py-3.5 text-right text-white text-[14px] tabular-nums">{r.tvl}</td>
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

      {/* The footnote is load-bearing, not decoration: it says what each number
          is, what a dash means, and — the part most tables skip — what is NOT
          here and why. An absent APR with no explanation reads as an oversight;
          an absent APR with a reason reads as a standard. */}
      <p className="mt-2.5 text-[11.5px] text-white/50 leading-relaxed">
        TVL is a live read of the pair&apos;s reserves. &ldquo;Routed 24h&rdquo; is reconstructed from the
        venue router&apos;s own fee take, so it counts swaps that came through this venue and not
        those that hit the pool directly. A dash means the read did not land, never that the number
        is zero.{' '}
        <strong className="text-white/70">There is deliberately no APR column:</strong> the only fee
        figure this venue can read on chain is the router&apos;s platform fee, which is the
        protocol&apos;s income rather than yours, and annualising it against the pool would misstate
        what providing liquidity actually pays.
      </p>

      <p className="mt-3 text-[12.5px] text-white/60 leading-relaxed">
        This venue is small on purpose and the list is short. Most ERC-20 pairs can be opened here —
        ERC-777 tokens are refused by the factory — and if the pair does not exist yet, the first
        deposit creates it and sets its starting price.
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
