import { m } from 'framer-motion';
import { pageArt, artStyle } from '../../lib/artConfig';
import { CURRENT_SEASON } from '../../lib/constants';
import { PulseDot } from '../PulseDot';
import { Sparkline } from '../Sparkline';

interface FarmStatsRowProps {
  stats: { tvl: string; toweliPrice: string };
  pool: { isDeployed: boolean; apr: string; aprDisclaimer?: string };
  price: { displayPriceStale: boolean };
  priceData: number[];
  priceError: unknown;
  daysLeft: number;
}

export function FarmStatsRow({ stats, pool, price, priceData, priceError, daysLeft }: FarmStatsRowProps) {
  const items = [
    { l: 'Total Value Locked', v: stats.tvl, art: pageArt('farm-stats', 0), pos: 'center 30%' },
    { l: 'TOWELI Price', v: stats.toweliPrice + (price.displayPriceStale ? ' (stale)' : ''), art: pageArt('farm-stats', 1), pos: 'center 30%' },
    { l: 'Base APR', v: pool.isDeployed ? `${pool.apr}%` : '–', accent: true, art: pageArt('farm-stats', 2), pos: 'center 0%', sub: pool.aprDisclaimer },
    { l: 'Season', v: `${daysLeft}d left`, sub: CURRENT_SEASON.name, art: pageArt('farm-stats', 3), pos: 'center 30%' },
  ];

  return (
    <m.div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
      {items.map((s) => (
        <div key={s.l} className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
          <div className="absolute inset-0">
            <img src={s.art.src} alt="" loading="lazy" className="w-full h-full object-cover" style={artStyle(s.art, s.pos)} />
          </div>
          {/* Semi-transparent content panel — art bleeds through while kyle-green text stays readable. */}
          <div className="relative z-10 m-2 md:m-3 rounded-lg p-3 md:p-4 pt-6 pb-5" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <p className="text-[11px] uppercase tracking-wider label-pill mb-2 flex items-center gap-1.5" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.l}{s.l === 'TOWELI Price' && <PulseDot size={5} />}</p>
          <div className="flex items-center gap-2">
            <p className="stat-value text-2xl" style={{ color: '#22c55e', textShadow: '0 1px 8px rgba(0,0,0,0.95)' }}>{s.v}</p>
            {s.l === 'TOWELI Price' && priceData.length > 1 && (
              <Sparkline data={priceData} width={48} height={18} />
            )}
            {s.l === 'TOWELI Price' && !!priceError && priceData.length === 0 && (
              <span className="text-[10px]" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Price data unavailable</span>
            )}
          </div>
          {s.sub && <p className="text-[11px] mt-1" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{s.sub}</p>}
          </div>
        </div>
      ))}
    </m.div>
  );
}
