import { motion } from 'framer-motion';
import { ART } from '../../lib/artConfig';
import { MIN_LOCK_DURATION, MAX_LOCK_DURATION, MIN_BOOST_BPS, MAX_BOOST_BPS, JBAC_BONUS_BPS } from '../../lib/constants';

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

function calculateBoost(durationSec: number): number {
  if (durationSec <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
  if (durationSec >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
  const range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
  const boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
  const elapsed = durationSec - MIN_LOCK_DURATION;
  return MIN_BOOST_BPS + (elapsed * boostRange) / range;
}

interface BoostScheduleTableProps {
  selectedLockLabel: string;
}

export function BoostScheduleTable({ selectedLockLabel }: BoostScheduleTableProps) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
      <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
        <div className="absolute inset-0">
          <img src={ART.swordOfLove.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%' }} />
        </div>
        <div className="relative z-10 p-6">
        <h3 className="heading-luxury text-white text-[20px] mb-5">Boost Schedule</h3>
        <p className="text-white text-[12px] mb-4">Lock longer = higher boost + more voting power. JBAC NFT holders get +0.5x bonus.</p>

        <div className="space-y-1.5">
          {LOCK_OPTIONS.map((opt) => {
            const b = calculateBoost(opt.seconds);
            const withNft = b + JBAC_BONUS_BPS;
            return (
              <div key={opt.label} className="flex items-center justify-between rounded-lg px-4 py-2.5"
                style={{
                  background: selectedLockLabel === opt.label ? 'rgba(139,92,246,0.75)' : 'rgba(0,0,0,0.50)',
                  border: selectedLockLabel === opt.label ? '1px solid rgba(139,92,246,0.2)' : '1px solid transparent',
                }}>
                <span className="text-white text-[13px]">{opt.label}</span>
                <div className="flex items-center gap-3">
                  <span className="stat-value text-[14px] text-white">{(b / 10000).toFixed(2)}x</span>
                  <span className="text-white text-[11px]">({(withNft / 10000).toFixed(2)}x w/NFT)</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(255,178,55,0.12)' }}>
          <div className="absolute inset-0">
            <img src={ART.chaosScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-4">
            <p className="text-warning/80 text-[12px] font-medium mb-1">Early Withdrawal</p>
            <p className="text-white text-[11px]">
              You can exit your lock at any time with a {EARLY_WITHDRAWAL_PENALTY_PCT}% penalty. Penalty tokens are redistributed to remaining stakers — so diamond hands get rewarded.
            </p>
          </div>
        </div>

        <div className="mt-4 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
          <div className="absolute inset-0">
            <img src={ART.forestScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
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
    </motion.div>
  );
}
