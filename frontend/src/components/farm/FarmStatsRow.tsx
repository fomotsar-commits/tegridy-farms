import { motion } from 'framer-motion';
import { ART } from '../../lib/artConfig';
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
    { l: 'Total Value Locked', v: stats.tvl, art: ART.apeHug.src, pos: 'center 30%' },
    { l: 'TOWELI Price', v: stats.toweliPrice + (price.displayPriceStale ? ' (stale)' : ''), art: ART.roseApe.src, pos: 'center 30%' },
    { l: 'Base APR', v: pool.isDeployed ? `${pool.apr}%` : '–', accent: true, art: ART.wrestler.src, pos: 'center 0%', sub: pool.aprDisclaimer },
    { l: 'Season', v: `${daysLeft}d left`, sub: CURRENT_SEASON.name, art: ART.beachSunset.src, pos: 'center 30%' },
  ];

  return (
    <motion.div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
      {items.map((s) => (
        <div key={s.l} className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
          <div className="absolute inset-0">
            <img src={s.art} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: s.pos }} />
          </div>
          <div className="relative z-10 p-3 md:p-5 pt-8 pb-6">
          <p className="text-white text-[11px] uppercase tracking-wider label-pill mb-2 flex items-center gap-1.5">{s.l}{s.l === 'TOWELI Price' && <PulseDot size={5} />}</p>
          <div className="flex items-center gap-2">
            <p className={`stat-value text-2xl text-white`}>{s.v}</p>
            {s.l === 'TOWELI Price' && priceData.length > 1 && (
              <Sparkline data={priceData} width={48} height={18} />
            )}
            {s.l === 'TOWELI Price' && !!priceError && priceData.length === 0 && (
              <span className="text-white text-[10px]">Price data unavailable</span>
            )}
          </div>
          {s.sub && <p className="text-white text-[11px] mt-1">{s.sub}</p>}
          </div>
        </div>
      ))}
    </motion.div>
  );
}
