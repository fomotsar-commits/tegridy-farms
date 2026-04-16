import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatEther } from 'viem';
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
  { icon: '\u{1F4B0}', title: 'Revenue Sharing', desc: 'Earn ETH from 100% of protocol swap fees distributed to stakers.' },
  { icon: '\u{1F4B8}', title: 'Reduced Fees', desc: 'Gold Card holders pay lower swap fees via the premium discount applied on-chain.' },
  { icon: '\u{26A1}', title: 'Priority Harvesting', desc: 'Reward claims are processed with priority gas during high-traffic periods.' },
  { icon: '\u{1F514}', title: 'Smart Alerts', desc: 'Custom price alerts, whale movement notifications, and yield opportunity updates.' },
  { icon: '\u{1F4CA}', title: 'Advanced Analytics', desc: 'Deep portfolio analytics, P&L tracking, and yield projections on your dashboard.' },
];

/* Shimmer skeleton block */
function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded bg-white/10 ${className}`} />
  );
}

/* Etherscan tx link */
function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={`https://etherscan.io/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[12px] font-mono hover:underline"
      style={{ color: '#d4a017' }}
    >
      Tx: {hash.slice(0, 8)}...{hash.slice(-6)} &#8599;
    </a>
  );
}

export default function PremiumPage() {
  usePageTitle('Gold Card', 'Premium membership with enhanced yields and exclusive features.');
  const { address } = useAccount();
  const premium = usePremiumAccess();
  const revenue = useRevenueStats();
  const [selectedPlan, setSelectedPlan] = useState(1); // index

  const plan = PLANS[selectedPlan]!;
  // Fix #1: Derive display cost from BigInt calculation, not float math
  const totalCostRaw = plan.discount > 0
    ? premium.monthlyFee * BigInt(plan.months) * BigInt(100 - plan.discount) / 100n
    : premium.monthlyFee * BigInt(plan.months);
  const totalCostDisplay = formatEther(totalCostRaw);
  const canAfford = premium.userBalance >= totalCostRaw;
  const needsApproval = premium.needsApproval(plan.months);

  const isLoading = premium.isDataLoading;
  const hasError = premium.isDataError || revenue.isDataError;
  const errorMsg = premium.dataError?.message || revenue.dataError?.message || 'Failed to load contract data';

  return (
    <div className="-mt-14 relative min-h-screen">
      {/* Art background */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.swordOfLove.src} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[1000px] mx-auto px-4 md:px-6 pt-24 pb-28 md:pb-16">
        {/* Hero */}
        <motion.div className="text-center mb-12" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div className="inline-block mb-4">
            <div className="w-20 h-20 mx-auto rounded-2xl overflow-hidden" style={{
              border: '2px solid #d4a017',
              boxShadow: '0 0 30px rgba(212,160,23,0.3), 0 0 60px rgba(212,160,23,0.1)',
            }}>
              <img src={ART.bobowelie.src} alt="" loading="lazy" className="w-full h-full object-cover" />
            </div>
          </div>
          <h1 className="heading-luxury text-2xl md:text-4xl lg:text-5xl text-white tracking-tight mb-3">
            Gold <span style={{ color: '#d4a017' }}>Card</span>
          </h1>
          <p className="text-white text-base md:text-lg max-w-lg mx-auto">
            Unlock premium features and earn 3x points across the protocol.
          </p>
        </motion.div>

        {/* Fix #2: Wallet-disconnected prompt */}
        {!address && (
          <motion.div className="mb-8 rounded-xl p-6 text-center"
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
            style={{
              background: 'linear-gradient(135deg, var(--color-purple-12) 0%, var(--color-purple-04) 100%)',
              border: '1px solid var(--color-purple-25)',
            }}>
            <div className="text-white text-[14px] font-semibold mb-2">Connect your wallet to get started</div>
            <p className="text-white text-[12px] mb-4">View your subscription status, subscribe, and claim revenue.</p>
            <div className="flex justify-center">
              <ConnectButton />
            </div>
          </motion.div>
        )}

        {/* Fix #4: Error state */}
        {hasError && address && (
          <motion.div className="mb-8 rounded-xl p-4 text-center"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            style={{
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
            }}>
            <div className="text-red-400 text-[13px] font-semibold mb-1">Error Loading Data</div>
            <div className="text-white text-[12px]">{errorMsg.split('\n')[0] ?? errorMsg}</div>
            <button onClick={() => { premium.refetch(); revenue.refetch(); }}
              className="mt-2 text-[12px] font-semibold px-3 py-1 rounded-lg"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
              Retry
            </button>
          </motion.div>
        )}

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
              <div className="text-white text-[12px] mt-1">
                {premium.daysRemaining} days remaining
              </div>
            )}
            {premium.isLifetime && (
              <div className="text-white text-[12px] mt-1">JBAC NFT holder — permanent access</div>
            )}
          </motion.div>
        )}

        {/* Stats Row */}
        <motion.div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-10"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
          {/* Fix #3: Loading skeletons for stats */}
          {isLoading ? (
            <>
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="glass-card p-3 text-center">
                  <Skeleton className="h-3 w-20 mx-auto mb-2" />
                  <Skeleton className="h-5 w-24 mx-auto" />
                </div>
              ))}
            </>
          ) : (
            [
              { label: 'Monthly Fee', value: premium.monthlyFeeFormatted > 0 ? `${premium.monthlyFeeFormatted.toLocaleString()} TOWELI` : '...' },
              { label: 'Active Subscribers', value: premium.totalSubscribers.toString() },
              { label: 'Total Revenue', value: premium.totalRevenueFormatted > 0 ? `${premium.totalRevenueFormatted.toLocaleString()} TOWELI` : '0' },
              { label: 'Revenue Distributed', value: revenue.totalDistributed > 0 ? `${revenue.totalDistributed.toFixed(4)} ETH` : '0 ETH' },
            ].map((s) => (
              <div key={s.label} className="glass-card p-3 text-center">
                <div className="text-white text-[11px] uppercase tracking-wider label-pill mb-1">{s.label}</div>
                <div className="stat-value text-white text-[14px]">{s.value}</div>
              </div>
            ))
          )}
        </motion.div>

        {/* Benefits Grid */}
        <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Gold Card Benefits</h2>
          <p className="text-white text-[12px] mb-5">Everything included with your Gold Card membership</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ACTIVE_BENEFITS.map((b, i) => (
              <motion.div key={b.title} className="glass-card p-4"
                initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.06 }}>
                <div className="text-2xl mb-2">{b.icon}</div>
                <h3 className="text-white text-[14px] font-semibold mb-1">{b.title}</h3>
                <p className="text-white text-[12px] leading-relaxed">{b.desc}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Subscribe Section */}
        {!premium.hasPremium && (
          <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Choose Your Plan</h2>
            <p className="text-white text-[12px] mb-5">Pay in TOWELI. Longer plans save more.</p>

            {/* Plan Cards — Fix #1: BigInt-derived display values */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              {PLANS.map((p, i) => {
                const planCostRaw = p.discount > 0
                  ? premium.monthlyFee * BigInt(p.months) * BigInt(100 - p.discount) / 100n
                  : premium.monthlyFee * BigInt(p.months);
                const planCostDisplay = formatEther(planCostRaw);
                const fullCostRaw = premium.monthlyFee * BigInt(p.months);
                const fullCostDisplay = formatEther(fullCostRaw);
                const hasData = premium.monthlyFee > 0n;

                return (
                  <button key={p.months} onClick={() => setSelectedPlan(i)}
                    className="relative rounded-xl p-4 text-center transition-all"
                    style={{
                      background: selectedPlan === i
                        ? 'linear-gradient(135deg, rgba(212,160,23,0.15) 0%, rgba(212,160,23,0.05) 100%)'
                        : 'var(--color-purple-75)',
                      border: selectedPlan === i
                        ? '1px solid rgba(212,160,23,0.4)'
                        : '1px solid var(--color-purple-75)',
                    }}>
                    {p.discount > 0 && (
                      <div className="absolute -top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: '#d4a017', color: '#0a0a0f' }}>
                        -{p.discount}%
                      </div>
                    )}
                    <div className="text-white text-[15px] font-semibold mb-1">{p.label}</div>
                    <div className="text-white text-[12px]">
                      {isLoading ? (
                        <Skeleton className="h-4 w-16 mx-auto" />
                      ) : hasData ? (
                        `${Number(planCostDisplay).toLocaleString()} TOWELI`
                      ) : '...'}
                    </div>
                    {p.discount > 0 && hasData && !isLoading && (
                      <div className="text-white text-[11px] line-through mt-0.5">
                        {Number(fullCostDisplay).toLocaleString()}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Subscribe Action */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-white text-[11px] uppercase tracking-wider label-pill">Total Cost</div>
                  <div className="stat-value text-xl" style={{ color: '#d4a017' }}>
                    {isLoading ? (
                      <Skeleton className="h-6 w-32" />
                    ) : premium.monthlyFee > 0n ? (
                      `${Number(totalCostDisplay).toLocaleString()} TOWELI`
                    ) : '...'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-white text-[11px] uppercase tracking-wider label-pill">Your Balance</div>
                  <div className="stat-value text-[14px]" style={{ color: '#d4a017' }}>
                    {isLoading ? (
                      <Skeleton className="h-5 w-24 ml-auto" />
                    ) : (
                      `${premium.userBalanceFormatted.toLocaleString()} TOWELI`
                    )}
                  </div>
                </div>
              </div>

              {/* Fix #5: Approval success feedback */}
              {premium.isApproveSuccess && !needsApproval && (
                <div className="mb-3 rounded-lg p-3 text-center text-[13px] font-semibold"
                  style={{
                    background: 'rgba(34,197,94,0.1)',
                    border: '1px solid rgba(34,197,94,0.3)',
                    color: '#22c55e',
                  }}>
                  Approved! Click Subscribe to continue.
                </div>
              )}

              {/* Fix #6: Transaction hash display */}
              {premium.approveHash && premium.isApproveSuccess && (
                <div className="mb-3 text-center">
                  <TxLink hash={premium.approveHash} />
                </div>
              )}
              {premium.actionHash && premium.isActionSuccess && (
                <div className="mb-3 text-center">
                  <TxLink hash={premium.actionHash} />
                </div>
              )}

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
                <button disabled className="w-full py-3 rounded-lg text-[14px] font-semibold bg-black/60 text-white cursor-not-allowed">
                  Insufficient TOWELI Balance
                </button>
              ) : needsApproval ? (
                <button
                  onClick={() => premium.approveToweli(plan.months)}
                  disabled={premium.isPending || premium.isConfirming}
                  className="btn-primary w-full py-3 text-[14px]"
                >
                  {premium.isPending ? 'Confirm in Wallet...' : premium.isConfirming ? 'Approving...' : `Approve ${Number(totalCostDisplay).toLocaleString()} TOWELI`}
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
          <p className="text-white text-[12px] mb-5">100% of protocol fees distributed to stakers</p>

          {revenue.isDataLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="glass-card p-4">
                  <Skeleton className="h-3 w-24 mb-2" />
                  <Skeleton className="h-6 w-20 mb-1" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="glass-card p-4">
                <div className="text-white text-[11px] uppercase tracking-wider label-pill mb-1">Total Distributed</div>
                <div className="stat-value text-white text-lg">{revenue.totalDistributed.toFixed(4)} ETH</div>
                <div className="text-white text-[11px] mt-1">{revenue.epochCount} epochs</div>
              </div>
              <div className="glass-card p-4">
                <div className="text-white text-[11px] uppercase tracking-wider label-pill mb-1">Your Pending</div>
                <div className="stat-value text-lg" style={{ color: revenue.pendingRevenue > 0 ? '#22c55e' : 'rgba(255,255,255,1)' }}>
                  {(revenue.pendingRevenue ?? 0).toFixed(6)} ETH
                </div>
                {revenue.pendingRevenueBig > 0n ? (
                  <>
                    <button onClick={revenue.claimRevenue}
                      disabled={revenue.isPending || revenue.isConfirming}
                      className="mt-2 text-[12px] font-semibold px-3 py-1 rounded-lg"
                      style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
                      {revenue.isPending ? 'Confirming...' : 'Claim ETH'}
                    </button>
                    {/* Fix #6: Revenue claim tx hash */}
                    {revenue.hash && revenue.isSuccess && (
                      <div className="mt-2">
                        <TxLink hash={revenue.hash} />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-white text-[11px] mt-1">No pending revenue</div>
                )}
              </div>
              <div className="glass-card p-4">
                <div className="text-white text-[11px] uppercase tracking-wider label-pill mb-1">Referral Earnings</div>
                <div className="stat-value text-lg" style={{ color: revenue.referralPending > 0 ? '#22c55e' : 'rgba(255,255,255,1)' }}>
                  {(revenue.referralPending ?? 0).toFixed(6)} ETH
                </div>
                <div className="text-white text-[11px] mt-1">{revenue.referredCount} referrals</div>
                {revenue.referralPendingBig > 0n && (
                  <>
                    <button onClick={revenue.claimReferralRewards}
                      disabled={revenue.isPending || revenue.isConfirming}
                      className="mt-2 text-[12px] font-semibold px-3 py-1 rounded-lg"
                      style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
                      {revenue.isPending ? 'Confirming...' : 'Claim Referral ETH'}
                    </button>
                    {revenue.hash && revenue.isSuccess && (
                      <div className="mt-2">
                        <TxLink hash={revenue.hash} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </motion.div>

        {/* JBAC NFT Section */}
        <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="glass-card p-5 flex flex-col md:flex-row items-center gap-5" style={{ border: '1px solid rgba(212,160,23,0.15)' }}>
            <div className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0" style={{ border: '1px solid rgba(212,160,23,0.3)' }}>
              <img src={ART.apeHug.src} alt="" loading="lazy" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 text-center md:text-left">
              <h3 className="text-white text-[15px] font-semibold mb-1">JBAC NFT Holders</h3>
              <p className="text-white text-[13px] leading-relaxed">
                Own a Jungle Bay Ape Club NFT? You get lifetime Gold Card access for free.
                No subscription needed — just claim your access.
              </p>
            </div>
            {address && premium.holdsJBAC && !premium.hasPremium && (
              <button onClick={premium.activateNFTPremium}
                disabled={premium.isPending || premium.isConfirming}
                className="px-5 py-3 rounded-lg text-[13px] font-semibold flex-shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #d4a017 0%, #b8892e 100%)',
                  color: '#0a0a0f',
                }}>
                {premium.isPending ? 'Confirming...' : 'Activate NFT Premium'}
              </button>
            )}
          </div>
        </motion.div>

        {/* Contract Link */}
        <div className="text-center">
          <a href={`https://etherscan.io/address/${PREMIUM_ACCESS_ADDRESS}`} target="_blank" rel="noopener noreferrer"
            className="text-white text-[11px] hover:text-white transition-colors font-mono">
            Contract: {PREMIUM_ACCESS_ADDRESS.slice(0, 6)}...{PREMIUM_ACCESS_ADDRESS.slice(-4)} &#8599;
          </a>
        </div>
      </div>
    </div>
  );
}
