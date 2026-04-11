import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { usePremiumAccess } from '../hooks/usePremiumAccess';
import { useRevenueStats } from '../hooks/useRevenueStats';
import { PREMIUM_ACCESS_ADDRESS } from '../lib/constants';
import { usePageTitle } from '../hooks/usePageTitle';

const PLANS = [
  { months: 1, label: '1 Month', discount: 0 },
  { months: 3, label: '3 Months', discount: 10 },
  { months: 6, label: '6 Months', discount: 20 },
  { months: 12, label: '1 Year', discount: 30 },
];

const ACTIVE_BENEFITS = [
  { icon: '\u{1F4C8}', title: '3x Points Multiplier', desc: 'Earn points 3x faster on every action. Climb the leaderboard.' },
  { icon: '\u{1F451}', title: 'JBAC Lifetime Access', desc: 'Jungle Bay Ape Club holders get permanent Gold Card access for free.' },
  { icon: '\u{1F4B0}', title: 'Revenue Sharing', desc: 'Register to earn ETH from 100% of protocol swap fees distributed to stakers.' },
];

const COMING_SOON_BENEFITS = [
  { icon: '\u{26A1}', title: 'Priority Harvesting', desc: 'Reward claims processed first during high-traffic periods.' },
  { icon: '\u{1F4CA}', title: 'Advanced Analytics', desc: 'Deep portfolio analytics, P&L tracking, and yield projections.' },
  { icon: '\u{1F4B8}', title: 'Reduced Fees', desc: 'Lower withdrawal penalties and swap fees for Gold Card holders.' },
  { icon: '\u{1F514}', title: 'Smart Alerts', desc: 'Custom price alerts, whale movement notifications, and yield updates.' },
];

export default function PremiumPage() {
  usePageTitle('Gold Card');
  const { address } = useAccount();
  const premium = usePremiumAccess();
  const revenue = useRevenueStats();
  const [selectedPlan, setSelectedPlan] = useState(1); // index

  const plan = PLANS[selectedPlan];
  const totalCost = premium.monthlyFeeFormatted * plan.months * (1 - plan.discount / 100);
  const totalCostRaw = plan.discount > 0
    ? premium.monthlyFee * BigInt(plan.months) * BigInt(100 - plan.discount) / 100n
    : premium.monthlyFee * BigInt(plan.months);
  const canAfford = premium.userBalance >= totalCostRaw;
  const needsApproval = premium.needsApproval(plan.months);

  return (
    <div className="-mt-14 relative min-h-screen">
      {/* Art background */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.swordOfLove.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.2 }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(6,12,26,0.85) 50%, rgba(6,12,26,0.98) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1000px] mx-auto px-4 md:px-6 pt-24 pb-16">
        {/* Hero */}
        <motion.div className="text-center mb-12" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div className="inline-block mb-4">
            <div className="w-20 h-20 mx-auto rounded-2xl overflow-hidden" style={{
              border: '2px solid #d4a017',
              boxShadow: '0 0 30px rgba(212,160,23,0.3), 0 0 60px rgba(212,160,23,0.1)',
            }}>
              <img src={ART.bobowelie.src} alt="" className="w-full h-full object-cover" />
            </div>
          </div>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            Gold <span style={{ color: '#d4a017' }}>Card</span>
          </h1>
          <p className="text-white/50 text-base md:text-lg max-w-lg mx-auto">
            Unlock premium features and earn 3x points across the protocol.
          </p>
        </motion.div>

        {/* Status Banner */}
        {premium.hasPremium && (
          <motion.div className="mb-8 rounded-xl p-4 text-center"
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
            style={{
              background: 'linear-gradient(135deg, rgba(212,160,23,0.15) 0%, rgba(212,160,23,0.05) 100%)',
              border: '1px solid rgba(212,160,23,0.3)',
            }}>
            <div className="text-[13px] font-semibold" style={{ color: '#d4a017' }}>
              {premium.isLifetime ? '\u{1F451} LIFETIME GOLD CARD ACTIVE' : '\u{1F451} GOLD CARD ACTIVE'}
            </div>
            {!premium.isLifetime && premium.daysRemaining > 0 && (
              <div className="text-white/40 text-[12px] mt-1">
                {premium.daysRemaining} days remaining
              </div>
            )}
            {premium.isLifetime && (
              <div className="text-white/40 text-[12px] mt-1">JBAC NFT holder — permanent access</div>
            )}
          </motion.div>
        )}

        {/* Stats Row */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
          {[
            { label: 'Monthly Fee', value: premium.monthlyFeeFormatted > 0 ? `${premium.monthlyFeeFormatted.toLocaleString()} TOWELI` : '...' },
            { label: 'Active Subscribers', value: premium.totalSubscribers.toString() },
            { label: 'Total Revenue', value: premium.totalRevenueFormatted > 0 ? `${premium.totalRevenueFormatted.toLocaleString()} TOWELI` : '0' },
            { label: 'Revenue Distributed', value: revenue.totalDistributed > 0 ? `${revenue.totalDistributed.toFixed(4)} ETH` : '0 ETH' },
          ].map((s) => (
            <div key={s.label} className="glass-card p-3 text-center">
              <div className="text-white/35 text-[11px] uppercase tracking-wider mb-1">{s.label}</div>
              <div className="stat-value text-white text-[14px]">{s.value}</div>
            </div>
          ))}
        </motion.div>

        {/* Benefits Grid */}
        <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Active Benefits</h2>
          <p className="text-white/35 text-[12px] mb-5">What you get today with a Gold Card</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {ACTIVE_BENEFITS.map((b, i) => (
              <motion.div key={b.title} className="glass-card p-4"
                initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.08 }}>
                <div className="text-2xl mb-2">{b.icon}</div>
                <h3 className="text-white text-[14px] font-semibold mb-1">{b.title}</h3>
                <p className="text-white/40 text-[12px] leading-relaxed">{b.desc}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Coming Soon</h2>
          <p className="text-white/35 text-[12px] mb-5">In development for Gold Card holders</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3" style={{ opacity: 0.55 }}>
            {COMING_SOON_BENEFITS.map((b, i) => (
              <motion.div key={b.title} className="glass-card p-4 relative"
                initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.08 }}>
                <span className="absolute top-3 right-3 px-1.5 py-0.5 rounded text-[9px] font-semibold"
                  style={{ background: 'rgba(139,92,246,0.12)', color: '#8b5cf6' }}>Soon</span>
                <div className="text-2xl mb-2">{b.icon}</div>
                <h3 className="text-white text-[14px] font-semibold mb-1">{b.title}</h3>
                <p className="text-white/40 text-[12px] leading-relaxed">{b.desc}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Subscribe Section */}
        {!premium.hasPremium && (
          <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Choose Your Plan</h2>
            <p className="text-white/35 text-[12px] mb-5">Pay in TOWELI. Longer plans save more.</p>

            {/* Plan Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {PLANS.map((p, i) => (
                <button key={p.months} onClick={() => setSelectedPlan(i)}
                  className="relative rounded-xl p-4 text-center transition-all"
                  style={{
                    background: selectedPlan === i
                      ? 'linear-gradient(135deg, rgba(212,160,23,0.15) 0%, rgba(212,160,23,0.05) 100%)'
                      : 'rgba(139,92,246,0.04)',
                    border: selectedPlan === i
                      ? '1px solid rgba(212,160,23,0.4)'
                      : '1px solid rgba(139,92,246,0.12)',
                  }}>
                  {p.discount > 0 && (
                    <div className="absolute -top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{ background: '#d4a017', color: '#0a0a0f' }}>
                      -{p.discount}%
                    </div>
                  )}
                  <div className="text-white text-[15px] font-semibold mb-1">{p.label}</div>
                  <div className="text-white/40 text-[12px]">
                    {premium.monthlyFeeFormatted > 0
                      ? `${(premium.monthlyFeeFormatted * p.months * (1 - p.discount / 100)).toLocaleString()} TOWELI`
                      : '...'}
                  </div>
                  {p.discount > 0 && premium.monthlyFeeFormatted > 0 && (
                    <div className="text-white/25 text-[11px] line-through mt-0.5">
                      {(premium.monthlyFeeFormatted * p.months).toLocaleString()}
                    </div>
                  )}
                </button>
              ))}
            </div>

            {/* Subscribe Action */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-white/40 text-[11px] uppercase tracking-wider">Total Cost</div>
                  <div className="stat-value text-xl" style={{ color: '#d4a017' }}>
                    {premium.monthlyFeeFormatted > 0 ? `${totalCost.toLocaleString()} TOWELI` : '...'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-white/40 text-[11px] uppercase tracking-wider">Your Balance</div>
                  <div className="stat-value text-[14px]" style={{ color: '#d4a017' }}>
                    {premium.userBalanceFormatted.toLocaleString()} TOWELI
                  </div>
                </div>
              </div>

              {!address ? (
                <ConnectButton.Custom>
                  {({ openConnectModal, mounted }) => (
                    <div {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none' } })}>
                      <button onClick={openConnectModal} className="btn-primary w-full py-3 text-[14px]">
                        Connect Wallet
                      </button>
                    </div>
                  )}
                </ConnectButton.Custom>
              ) : !canAfford ? (
                <button disabled className="w-full py-3 rounded-lg text-[14px] font-semibold bg-white/5 text-white/30 cursor-not-allowed">
                  Insufficient TOWELI Balance
                </button>
              ) : needsApproval ? (
                <button
                  onClick={() => premium.approveToweli(plan.months)}
                  disabled={premium.isPending || premium.isConfirming}
                  className="btn-primary w-full py-3 text-[14px]"
                >
                  {premium.isPending ? 'Confirm in Wallet...' : premium.isConfirming ? 'Approving...' : `Approve ${totalCost.toLocaleString()} TOWELI`}
                </button>
              ) : (
                <button
                  onClick={() => premium.subscribe(plan.months)}
                  disabled={premium.isPending || premium.isConfirming}
                  className="w-full py-3 rounded-lg text-[14px] font-semibold transition-all"
                  style={{
                    background: 'linear-gradient(135deg, #d4a017 0%, #b8892e 100%)',
                    color: '#0a0a0f',
                  }}
                >
                  {premium.isPending ? 'Confirm in Wallet...' : premium.isConfirming ? 'Subscribing...' : `Subscribe for ${plan.label}`}
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* Revenue Sharing Section */}
        <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Revenue Sharing</h2>
          <p className="text-white/35 text-[12px] mb-5">100% of protocol fees distributed to stakers</p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="glass-card p-4">
              <div className="text-white/35 text-[11px] uppercase tracking-wider mb-1">Total Distributed</div>
              <div className="stat-value text-primary text-lg">{revenue.totalDistributed.toFixed(4)} ETH</div>
              <div className="text-white/25 text-[11px] mt-1">{revenue.epochCount} epochs</div>
            </div>
            <div className="glass-card p-4">
              <div className="text-white/35 text-[11px] uppercase tracking-wider mb-1">Your Pending</div>
              <div className="stat-value text-lg" style={{ color: revenue.pendingRevenue > 0 ? '#22c55e' : 'rgba(255,255,255,0.5)' }}>
                {(revenue.pendingRevenue ?? 0).toFixed(6)} ETH
              </div>
              {revenue.pendingRevenueBig > 0n ? (
                <button onClick={revenue.claimRevenue}
                  disabled={revenue.isPending || revenue.isConfirming}
                  className="mt-2 text-[12px] font-semibold px-3 py-1 rounded-lg"
                  style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
                  {revenue.isPending ? 'Confirming...' : 'Claim ETH'}
                </button>
              ) : (
                <div className="text-white/25 text-[11px] mt-1">No pending revenue</div>
              )}
            </div>
            <div className="glass-card p-4">
              <div className="text-white/35 text-[11px] uppercase tracking-wider mb-1">Referral Earnings</div>
              <div className="stat-value text-lg" style={{ color: revenue.referralPending > 0 ? '#22c55e' : 'rgba(255,255,255,0.5)' }}>
                {(revenue.referralPending ?? 0).toFixed(6)} ETH
              </div>
              <div className="text-white/25 text-[11px] mt-1">{revenue.referredCount} referrals</div>
              {revenue.referralPendingBig > 0n && (
                <button onClick={revenue.claimReferralRewards}
                  disabled={revenue.isPending || revenue.isConfirming}
                  className="mt-2 text-[12px] font-semibold px-3 py-1 rounded-lg"
                  style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
                  {revenue.isPending ? 'Confirming...' : 'Claim Referral ETH'}
                </button>
              )}
            </div>
          </div>
        </motion.div>

        {/* JBAC NFT Section */}
        <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="glass-card p-5 flex flex-col md:flex-row items-center gap-5" style={{ border: '1px solid rgba(212,160,23,0.15)' }}>
            <div className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0" style={{ border: '1px solid rgba(212,160,23,0.3)' }}>
              <img src={ART.apeHug.src} alt="" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 text-center md:text-left">
              <h3 className="text-white text-[15px] font-semibold mb-1">JBAC NFT Holders</h3>
              <p className="text-white/40 text-[13px] leading-relaxed">
                Own a Jungle Bay Ape Club NFT? You get lifetime Gold Card access for free.
                No subscription needed — just claim your access.
              </p>
            </div>
            {address && !premium.isLifetime && (
              <button onClick={premium.claimNFTAccess}
                disabled={premium.isPending || premium.isConfirming}
                className="px-5 py-3 rounded-lg text-[13px] font-semibold flex-shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #d4a017 0%, #b8892e 100%)',
                  color: '#0a0a0f',
                }}>
                {premium.isPending ? 'Confirming...' : 'Claim NFT Access'}
              </button>
            )}
          </div>
        </motion.div>

        {/* Contract Link */}
        <div className="text-center">
          <a href={`https://etherscan.io/address/${PREMIUM_ACCESS_ADDRESS}`} target="_blank" rel="noopener noreferrer"
            className="text-white/20 text-[11px] hover:text-white/40 transition-colors font-mono">
            Contract: {PREMIUM_ACCESS_ADDRESS.slice(0, 6)}...{PREMIUM_ACCESS_ADDRESS.slice(-4)} &#8599;
          </a>
        </div>
      </div>
    </div>
  );
}
