import { m } from 'framer-motion';
import { pageArt } from '../../lib/artConfig';
import { JBAC_BONUS_BPS } from '../../lib/constants';
import { calculateBoost } from '../../lib/boostCalculations';
import { ArtImg } from '../ArtImg';

const EARLY_WITHDRAWAL_PENALTY_PCT = 25;

const LOCK_OPTIONS = [
  { label: '7 Days', seconds: 7 * 86400 },
  { label: '30 Days', seconds: 30 * 86400 },
  { label: '90 Days', seconds: 90 * 86400 },
  { label: '6 Months', seconds: 180 * 86400 },
  { label: '1 Year', seconds: 365 * 86400 },
  { label: '2 Years', seconds: 730 * 86400 },
  { label: '4 Years', seconds: 1460 * 86400 },
];

interface BoostScheduleTableProps {
  selectedLockLabel: string;
  apr?: string;
}

export function BoostScheduleTable({ selectedLockLabel, apr }: BoostScheduleTableProps) {
  const baseApr = parseFloat(apr || '0');
  return (
    <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
      <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
        <div className="absolute inset-0">
          <ArtImg pageId="boost-schedule" idx={0} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 p-4 sm:p-6">
        <h3 className="heading-luxury text-white text-[20px] mb-5" id="boost-schedule-heading">Boost Schedule</h3>
        <p className="text-white text-[12px] mb-4">Lock longer = higher boost + more voting power. JBAC NFT holders get +0.5x bonus.</p>

        {/* Desktop / tablet: flex-table layout with horizontal scroll fallback. Hidden below 480px. */}
        <div className="hidden max-[480px]:hidden min-[481px]:block space-y-1.5 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0" role="table" aria-labelledby="boost-schedule-heading">
          <div className="min-w-[320px]">
          {LOCK_OPTIONS.map((opt) => {
            const b = calculateBoost(opt.seconds);
            const withNft = b + JBAC_BONUS_BPS;
            const isSelected = selectedLockLabel === opt.label;
            return (
              <div key={opt.label} role="row" aria-selected={isSelected}
                className="flex items-center justify-between rounded-lg px-3 sm:px-4 py-2 sm:py-2.5 mb-1.5"
                style={{
                  background: isSelected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.50)',
                  border: isSelected ? '1px solid var(--color-purple-20)' : '1px solid transparent',
                }}>
                <span className="text-white text-[12px] sm:text-[13px] flex-shrink-0">{opt.label}</span>
                <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
                  <span className="stat-value text-[13px] sm:text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(b / 10000).toFixed(2)}x</span>
                  {baseApr > 0 && <span className="text-emerald-400 text-[10px] sm:text-[11px] font-mono">{(baseApr * b / 10000).toFixed(1)}% APY</span>}
                  {baseApr === 0 && <span className="text-[10px] sm:text-[11px]" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>({(withNft / 10000).toFixed(2)}x w/NFT)</span>}
                </div>
              </div>
            );
          })}
          </div>
        </div>

        {/* Mobile (<=480px): semantic card list. Drops role="table" in favor of <ul>/<li>. */}
        <ul className="hidden max-[480px]:flex flex-col gap-2 list-none p-0 m-0" aria-labelledby="boost-schedule-heading">
          {LOCK_OPTIONS.map((opt) => {
            const b = calculateBoost(opt.seconds);
            const withNft = b + JBAC_BONUS_BPS;
            const isSelected = selectedLockLabel === opt.label;
            return (
              <li key={opt.label} aria-current={isSelected ? 'true' : undefined}
                className="rounded-lg px-3 py-3"
                style={{
                  background: isSelected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.50)',
                  border: isSelected ? '1px solid var(--color-purple-20)' : '1px solid transparent',
                  minHeight: '44px',
                }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white/60 text-[10px] uppercase tracking-wider">Lock</span>
                  <span className="text-white text-[13px] font-medium">{opt.label}</span>
                </div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white/60 text-[10px] uppercase tracking-wider">Boost</span>
                  <span className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(b / 10000).toFixed(2)}x</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60 text-[10px] uppercase tracking-wider">
                    {baseApr > 0 ? 'APY' : 'With NFT'}
                  </span>
                  {baseApr > 0 ? (
                    <span className="text-emerald-400 text-[12px] font-mono">{(baseApr * b / 10000).toFixed(1)}%</span>
                  ) : (
                    <span className="text-[12px]" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{(withNft / 10000).toFixed(2)}x</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(255,178,55,0.12)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="boost-schedule" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-4">
            <p className="text-warning/80 text-[12px] font-medium mb-1">Early Withdrawal</p>
            <p className="text-white text-[11px]">
              You can exit your lock at any time with a {EARLY_WITHDRAWAL_PENALTY_PCT}% penalty. Penalty tokens are redistributed to remaining stakers — so diamond hands get rewarded.
            </p>
          </div>
        </div>

        <div className="mt-4 relative overflow-hidden rounded-lg" style={{ border: '1px solid var(--color-purple-75)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="boost-schedule" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-4">
            <p className="text-white text-[12px] font-medium mb-1">Auto-Max Lock</p>
            <p className="text-white text-[11px]">
              Enable auto-max lock to keep maximum boost (4.0x) perpetually. Your lock auto-renews on every claim. Disable anytime to let it expire naturally.
            </p>
          </div>
        </div>
        </div>
      </div>
    </m.div>
  );
}
