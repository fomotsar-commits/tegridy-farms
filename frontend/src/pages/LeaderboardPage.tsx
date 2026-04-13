import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ART } from '../lib/artConfig';
import { usePoints } from '../hooks/usePoints';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { TIER_THRESHOLDS, BADGES } from '../lib/pointsEngine';
import { CopyButton } from '../components/ui/CopyButton';
import { CURRENT_SEASON } from '../lib/constants';
import { TegridyScore } from '../components/TegridyScore';
import { AnimatedCounter } from '../components/AnimatedCounter';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageSkeleton } from '../components/PageSkeleton';

const JB_CHRISTMAS_SRC = ART.jbChristmas.src;

export default function LeaderboardPage() {
  usePageTitle('Leaderboard');
  const { isConnected } = useAccount();
  const points = usePoints();
  const nft = useNFTBoost();

  if (isConnected && !points.data) {
    return <PageSkeleton />;
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={JB_CHRISTMAS_SRC} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        <motion.div className="mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Leaderboard</h1>
          <p className="text-white text-[14px]">{CURRENT_SEASON.name} — Earn points by using the protocol</p>
          <p className="text-amber-400/50 text-[11px] mt-1">Points are tracked locally for fun. Any future rewards will be based on on-chain activity only.</p>
        </motion.div>

        {/* Tegridy Score */}
        {isConnected && (
          <motion.div className="mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <TegridyScore />
          </motion.div>
        )}

        {/* Your Stats */}
        {isConnected && points.data && (
          <motion.div className="relative overflow-hidden rounded-xl glass-card-animated mb-6" style={{ border: '1px solid rgba(139,92,246,0.75)' }}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <div className="absolute inset-0">
              <img src={ART.roseApe.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 40%' }} />
            </div>
            <div className="relative z-10 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white text-[15px] font-semibold">Your Stats</h3>
              {nft.boostLabel && (
                <span className="badge badge-warning text-[10px]">{nft.boostLabel} Boost</span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                <p className="text-white text-[10px] mb-1">Points</p>
                <AnimatedCounter value={points.data?.points ?? 0} decimals={0} className="stat-value text-xl text-white" />
              </div>
              <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                <p className="text-white text-[10px] mb-1">Tier</p>
                <p className="stat-value text-lg" style={{ color: points.tier?.color }}>{points.tier?.name}</p>
              </div>
              <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                <p className="text-white text-[10px] mb-1">Streak</p>
                <p className="stat-value text-lg text-white">{points.data?.streak?.current ?? 0}d 🔥</p>
              </div>
              <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                <p className="text-white text-[10px] mb-1">Multiplier</p>
                <p className="stat-value text-lg text-success">{points.streakMultiplier}x</p>
              </div>
            </div>

            {/* Progress to next tier */}
            {points.nextTier && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="text-white">Progress to {points.nextTier.name}</span>
                  <span className="text-white font-mono">{points.data?.points ?? 0} / {points.nextTier.min}</span>
                </div>
                <div
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'rgba(139,92,246,0.75)' }}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, points.nextTier.min > 0 ? ((points.data?.points ?? 0) / points.nextTier.min) * 100 : 0)}
                >
                  <div className="h-full rounded-full bg-primary transition-all" style={{
                    width: `${Math.min(100, points.nextTier.min > 0 ? ((points.data?.points ?? 0) / points.nextTier.min) * 100 : 0)}%`,
                  }} />
                </div>
              </div>
            )}

            {/* Badges */}
            {(points.badges?.length ?? 0) > 0 && (
              <div>
                <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-2">Badges Earned</p>
                <div className="flex flex-wrap gap-2">
                  {(points.badges ?? []).map(b => (
                    <div key={b.id} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg"
                      style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}
                      title={b.description}>
                      <span className="text-[14px]">{b.icon}</span>
                      <span className="text-[11px] text-white font-medium">{b.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Referral link */}
            <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(139,92,246,0.75)' }}>
              <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-1.5">Your Referral Link</p>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-white font-mono truncate flex-1">{points.referralLink}</span>
                <CopyButton text={points.referralLink} display="Copy" className="text-[11px] text-white" />
              </div>
              <p className="text-white text-[10px] mt-1">Referrals: {points.data?.referralCount ?? 0} users</p>
            </div>
            </div>
          </motion.div>
        )}

        {/* How Points Work */}
        <motion.div className="relative overflow-hidden rounded-xl glass-card-animated mb-6" style={{ border: '1px solid rgba(139,92,246,0.75)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <div className="absolute inset-0">
            <img src={JB_CHRISTMAS_SRC} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 10%' }} />
          </div>
          <div className="relative z-10 p-5">
            <h3 className="text-white text-[15px] font-semibold mb-3">How Points Work</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[
                { action: 'Swap', pts: 10 },
                { action: 'Stake / Unstake', pts: 25 },
                { action: 'Provide LP', pts: 50 },
                { action: 'Claim Rewards', pts: 15 },
                { action: 'Daily Visit', pts: 5 },
                { action: 'Referral Swap', pts: 5 },
              ].map(r => (
                <div key={r.action} className="flex items-center justify-between px-3 py-2 rounded-lg"
                  style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                  <span className="text-white text-[12px]">{r.action}</span>
                  <span className="stat-value text-[12px] text-white">+{r.pts}</span>
                </div>
              ))}
            </div>
            <p className="text-white text-[10px] mt-3">Streak multipliers: 7d = 1.5x, 14d = 2x, 30d = 3x. Points are local and unverified.</p>
          </div>
        </motion.div>

        {/* Tier Breakdown */}
        <motion.div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid rgba(139,92,246,0.75)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <div className="absolute inset-0">
            <img src={ART.beachSunset.src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-5">
            <h3 className="text-white text-[15px] font-semibold mb-3">Tiers</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {TIER_THRESHOLDS.map(t => (
                <div key={t.name} className="rounded-lg p-3 text-center"
                  style={{ background: 'rgba(139,92,246,0.75)', border: `1px solid ${t.color}20` }}>
                  <p className="stat-value text-[16px] mb-0.5" style={{ color: t.color }}>{t.name}</p>
                  <p className="text-white text-[11px]">{t.min.toLocaleString()}+ pts</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* All Badges */}
        <motion.div className="relative overflow-hidden rounded-xl glass-card-animated mt-6" style={{ border: '1px solid rgba(139,92,246,0.75)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
          <div className="absolute inset-0">
            <img src={ART.jbacSkeleton.src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-5">
            <h3 className="text-white text-[15px] font-semibold mb-3">All Badges</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {BADGES.map(b => {
                const earned = (points.badges ?? []).some(eb => eb.id === b.id);
                return (
                  <div key={b.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${earned ? '' : 'opacity-30'}`}
                    style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                    <span className="text-[18px]">{b.icon}</span>
                    <div>
                      <p className="text-white text-[12px] font-medium">{b.name}</p>
                      <p className="text-white text-[10px]">{b.description}</p>
                    </div>
                    {earned && <span className="ml-auto text-success text-[12px]">✓</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
