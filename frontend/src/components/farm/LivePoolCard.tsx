import { Link } from 'react-router-dom';
import { TOKEN_LOGOS } from './poolConfig';
import { PoolStatusBadge } from './PoolStatusBadge';
import type { usePoolTVL } from '../../hooks/usePoolTVL';
import { ArtImg } from '../ArtImg';
import { CountUpText } from '../motion';

/**
 * Live TOWELI/ETH pool card with on-chain data.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE SECOND TILE IS NOT AN APR. It used to read "Est. APR".
 *
 * The figure behind it is `usePoolTVL().apr`, derived from
 * `SwapFeeRouter.totalETHFees()` (usePoolTVL.ts) — the VENUE's own platform
 * fee, skimmed off `msg.value` BEFORE the swap ever reaches the pair — and
 * annualised against this pool's TVL. It is the protocol's income, not the
 * liquidity provider's. An LP's income is the pair's 0.3% swap fee, of which
 * 5/6 accrues into the reserves and 1/6 goes to `feeTo`
 * (TegridyPair.sol:16-17): a different party, a different cut, a different
 * base. `totalETHFees` also counts only swaps that went THROUGH the fee
 * router, so it undercounts the pool's real activity on top of that.
 *
 * /liquidity took this decision first and wrote it up — see the block comment
 * at the top of `VenuePoolTable.tsx`, which dropped its APR column for exactly
 * this reason and explicitly left this card "for the operator". This is that
 * follow-up. The RELABEL was chosen over reading a real LP-fee APR because the
 * real one is not a read: the pair exposes no accumulated-fee-per-LP-token
 * figure, so it has to be reconstructed from `kLast` growth between two
 * observations, which needs historical state this card does not have. Wiring a
 * mislabelled number correctly is a rename; wiring a right one is a data
 * pipeline. The mislabel is the part that costs someone money, so it goes now.
 *
 * The number is kept rather than deleted — the venue's take against pool depth
 * is a real, interesting figure — but it is named for what it is.
 *
 * ⚠️ AND THE DASHES ARE NOT ESTIMATES. `aprIsEstimated` / `volIsEstimated`
 * initialise TRUE and go false only once the figure WAS computed, so a `true`
 * means "unreadable, showing a dash". The old footnote said the figures were
 * "estimated from on-chain reserves" unconditionally, which told a visitor
 * looking at three dashes that they were looking at estimates. Nothing on this
 * card may claim a number exists that was never read.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function LivePoolCard({ poolData }: { poolData: ReturnType<typeof usePoolTVL> }) {
  return (
    <div className="relative overflow-hidden rounded-xl card-hover group" style={{ border: '1px solid rgba(239,68,68,0.15)' }}>
      <div className="absolute inset-0">
        <ArtImg pageId="live-pool" idx={0} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
      </div>
      <div className="relative z-10 p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              <img src={TOKEN_LOGOS.TOWELI} alt="TOWELI" className="w-9 h-9 rounded-full object-cover"
                style={{ border: '2px solid var(--color-purple-30)' }} />
              <img src={TOKEN_LOGOS.ETH} alt="ETH" className="w-9 h-9 rounded-full object-cover bg-[#627eea]/20"
                style={{ border: '2px solid rgba(45,139,78,0.3)' }} />
            </div>
            <div>
              <p className="text-white font-semibold text-[15px]">TOWELI / ETH</p>
              {/* Named "pair fee" now that the card carries a second, different
                  fee below it — this is the 0.3% the POOL charges a swapper,
                  the tile is the venue's own take. */}
              <p className="text-white text-[11px]">Pair fee: 0.3%</p>
            </div>
          </div>
          {/* F117: derive the badge from live data instead of a hardcoded "HOT".
              An unseeded/empty pool (dash TVL) shows no badge; once it has real
              TVL it reads "LIVE" — no vaporware signal on an empty pool. */}
          {poolData.isLoaded && poolData.tvl > 0 && <PoolStatusBadge status="live" />}
        </div>

        {/* Stats Grid -- live data */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
          <div className="rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid var(--color-purple-30)' }}>
            <p className="text-[10px] uppercase tracking-wider label-pill mb-0.5" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>TVL</p>
            <p className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}><CountUpText value={poolData.tvlFormatted} /></p>
          </div>
          <div className="rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid var(--color-purple-30)' }}>
            <p className="text-[10px] uppercase tracking-wider label-pill mb-0.5" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Venue Fee / TVL</p>
            <p className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}><CountUpText value={poolData.apr} /></p>
          </div>
          <div className="rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid var(--color-purple-30)' }}>
            <p className="text-[10px] uppercase tracking-wider label-pill mb-0.5" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Routed 24h</p>
            <p className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}><CountUpText value={poolData.vol24hFormatted} /></p>
          </div>
        </div>

        {/* Load-bearing, not decoration — it is what stops each tile above from
            being read as something it is not, and it names what a dash means so
            a failed read is never taken for a zero. */}
        <p className="text-white/75 text-[10px] mb-3 leading-relaxed">
          &ldquo;Venue fee / TVL&rdquo; annualises the venue router&apos;s own platform fee against pool
          depth &mdash; the protocol&apos;s income, not what providing liquidity pays.
          &ldquo;Routed 24h&rdquo; is reconstructed from that same fee, so it sees only swaps that came
          through this venue&apos;s router. A dash means the read did not land, never that the figure
          is zero.
        </p>

        {/* Action */}
        <Link to="/liquidity" className="btn-primary w-full py-2.5 text-[13px] text-center block">
          Provide Liquidity
        </Link>
      </div>
    </div>
  );
}
