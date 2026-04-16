import { Link } from 'react-router-dom';
import { PoolStatusBadge } from './PoolStatusBadge';
import type { UPCOMING_POOLS } from './poolConfig';

/** Coming soon pool card */
export function UpcomingPoolCard({ pool }: { pool: typeof UPCOMING_POOLS[number] }) {
  return (
    <div className="relative overflow-hidden rounded-xl glass-card-animated card-hover group" style={{ border: '1px solid var(--color-purple-75)' }}>
      <div className="absolute inset-0">
        <img src={pool.art} alt="" loading="lazy" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" style={{ objectPosition: pool.artPos }} />
      </div>
      <div className="relative z-10 p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              <img src={pool.tokenA.logo} alt={pool.tokenA.symbol} className="w-9 h-9 rounded-full object-cover bg-black/60"
                style={{ border: '2px solid rgba(255,255,255,0.12)' }} />
              <img src={pool.tokenB.logo} alt={pool.tokenB.symbol} className="w-9 h-9 rounded-full object-cover bg-black/60"
                style={{ border: '2px solid rgba(255,255,255,0.12)' }} />
            </div>
            <div>
              <p className="text-white font-semibold text-[15px]">{pool.name}</p>
              <p className="text-white text-[11px]">Fee: {pool.fee}</p>
            </div>
          </div>
          <PoolStatusBadge status="soon" />
        </div>

        {/* Placeholder Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
          {['TVL', 'APR', '24h Vol'].map((label) => (
            <div key={label} className="rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.50)', border: '1px solid rgba(255,255,255,0.20)' }}>
              <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-0.5">{label}</p>
              <p className="stat-value text-[14px] text-white">&ndash;</p>
            </div>
          ))}
        </div>

        {/* Action -- link to liquidity page */}
        <Link to="/liquidity" className="w-full py-2.5 text-[13px] text-center rounded-lg font-semibold block transition-colors"
          style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-25)', color: '#000000' }}>
          Add Liquidity
        </Link>
      </div>
    </div>
  );
}
