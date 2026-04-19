import { Link } from 'react-router-dom';
import { pageArt } from '../../lib/artConfig';
import { TOKEN_LOGOS } from './poolConfig';
import { PoolStatusBadge } from './PoolStatusBadge';
import type { usePoolTVL } from '../../hooks/usePoolTVL';
import { ArtImg } from '../ArtImg';

/** Live TOWELI/ETH pool card with on-chain data */
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
              <p className="text-white text-[11px]">Fee: 0.3%</p>
            </div>
          </div>
          <PoolStatusBadge status="hot" />
        </div>

        {/* Stats Grid -- live data */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
          <div className="rounded-lg p-2.5" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
            <p className="text-[10px] uppercase tracking-wider label-pill mb-0.5" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>TVL</p>
            <p className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{poolData.tvlFormatted}</p>
          </div>
          <div className="rounded-lg p-2.5" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
            <p className="text-[10px] uppercase tracking-wider label-pill mb-0.5" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Est. APR</p>
            <p className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{poolData.apr}</p>
          </div>
          <div className="rounded-lg p-2.5" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
            <p className="text-[10px] uppercase tracking-wider label-pill mb-0.5" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Est. 24h Vol</p>
            <p className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{poolData.vol24hFormatted}</p>
          </div>
        </div>

        <p className="text-white text-[10px] mb-3 text-center">APR &amp; volume estimated from on-chain reserves</p>

        {/* Action */}
        <Link to="/liquidity" className="btn-primary w-full py-2.5 text-[13px] text-center block">
          Provide Liquidity
        </Link>
      </div>
    </div>
  );
}
