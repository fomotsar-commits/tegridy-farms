import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { useBribes } from '../hooks/useBribes';
import { TOWELI_WETH_LP_ADDRESS } from '../lib/constants';
import { formatEther } from 'viem';
import { usePageTitle } from '../hooks/usePageTitle';

export default function BribesPage() {
  usePageTitle('Bribes');
  const { isConnected } = useAccount();
  const bribes = useBribes();

  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.roseApe.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.3 }} />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.96) 100%)' }} />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <motion.div className="text-center max-w-sm" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <h2 className="heading-luxury text-2xl text-white mb-2">Vote Incentives</h2>
            <p className="text-white/40 text-[13px] mb-6">Connect your wallet to view and claim bribes.</p>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                  <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">Connect Wallet</button>
                </div>
              )}
            </ConnectButton.Custom>
          </motion.div>
        </div>
      </div>
    );
  }

  if (!bribes.isDeployed) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.roseApe.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.3 }} />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.96) 100%)' }} />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <motion.div className="text-center max-w-sm" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <h2 className="heading-luxury text-2xl text-white mb-2">Vote Incentives</h2>
            <p className="text-white/40 text-[13px] mb-2">Bribe market coming soon.</p>
            <p className="text-white/25 text-[11px]">External protocols will be able to deposit bribes for veTOWELI holders.</p>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.roseApe.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.85) 30%, rgba(0,0,0,0.92) 60%, rgba(0,0,0,0.96) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Vote Incentives</h1>
          <p className="text-white/50 text-[14px]">Earn bribes from protocols competing for veTOWELI votes</p>
        </motion.div>

        {/* Stats Overview */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          {[
            { label: 'Current Epoch', value: String(bribes.currentEpoch) },
            { label: 'Completed Epochs', value: String(bribes.epochCount) },
            { label: 'Bribe Fee', value: `${bribes.bribeFeeBps / 100}%` },
            { label: 'Last Snapshot', value: bribes.latestEpoch ? new Date(bribes.latestEpoch.timestamp * 1000).toLocaleDateString() : '–' },
          ].map(s => (
            <div key={s.label} className="rounded-xl p-3 text-center" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
              <p className="text-white/30 text-[10px] mb-1">{s.label}</p>
              <p className="stat-value text-lg text-white">{s.value}</p>
            </div>
          ))}
        </motion.div>

        {/* Claimable Bribes */}
        <motion.div className="relative overflow-hidden rounded-xl mb-6" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <div className="absolute inset-0">
            <img src={ART.roseApe.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.1 }} />
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.92)' }} />
          </div>
          <div className="relative z-10 p-5">
            <h3 className="text-white text-[15px] font-semibold mb-4">Your Claimable Bribes</h3>

            {bribes.claimableTokens.length === 0 ? (
              <p className="text-white/30 text-[13px]">No claimable bribes for TOWELI/WETH pair in the latest epoch.</p>
            ) : (
              <div className="space-y-2 mb-4">
                {bribes.claimableTokens.map((t, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-3 rounded-lg"
                    style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                    <span className="text-white/60 text-[13px]">{t.isETH ? 'ETH' : `${t.token.slice(0, 6)}...${t.token.slice(-4)}`}</span>
                    <span className="stat-value text-[14px] text-primary">{(parseFloat(t.formatted) || 0).toFixed(6)} {t.isETH ? 'ETH' : 'tokens'}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {bribes.claimableTokens.length > 0 && (
                <button
                  onClick={() => bribes.claimBribes(bribes.epochCount - 1, TOWELI_WETH_LP_ADDRESS)}
                  disabled={bribes.isPending || bribes.isConfirming}
                  className="btn-primary px-5 py-2 min-h-[44px] text-[13px]"
                >
                  {bribes.isPending || bribes.isConfirming ? 'Claiming...' : 'Claim Bribes'}
                </button>
              )}
              {bribes.epochCount > 1 && bribes.claimableTokens.length > 0 && (
                <button
                  onClick={() => bribes.claimBribesBatch(0, bribes.epochCount, TOWELI_WETH_LP_ADDRESS)}
                  disabled={bribes.isPending || bribes.isConfirming}
                  className="btn-secondary px-5 py-2 min-h-[44px] text-[13px]"
                >
                  Claim All Epochs
                </button>
              )}
            </div>
          </div>
        </motion.div>

        {/* Advance Epoch */}
        <motion.div className="relative overflow-hidden rounded-xl mb-6" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.95)' }} />
          <div className="relative z-10 p-5">
            <h3 className="text-white text-[15px] font-semibold mb-2">Epoch Management</h3>
            <p className="text-white/30 text-[12px] mb-3">
              Anyone can advance the epoch to snapshot voting power. Min 1 hour between epochs.
            </p>
            <button
              onClick={bribes.advanceEpoch}
              disabled={bribes.isPending || bribes.isConfirming}
              className="btn-secondary px-5 py-2 min-h-[44px] text-[13px]"
            >
              {bribes.isPending || bribes.isConfirming ? 'Processing...' : 'Advance Epoch'}
            </button>
          </div>
        </motion.div>

        {/* How Bribes Work */}
        <motion.div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.95)' }} />
          <div className="relative z-10 p-5">
            <h3 className="text-white text-[15px] font-semibold mb-3">How Bribes Work</h3>
            <div className="space-y-2.5 text-[12px] text-white/40">
              <div className="flex gap-3 items-start">
                <span className="text-primary font-semibold shrink-0">1.</span>
                <span>External protocols deposit ETH or whitelisted ERC20 tokens as bribes for specific pool pairs.</span>
              </div>
              <div className="flex gap-3 items-start">
                <span className="text-primary font-semibold shrink-0">2.</span>
                <span>Anyone calls Advance Epoch to snapshot the current voting power distribution.</span>
              </div>
              <div className="flex gap-3 items-start">
                <span className="text-primary font-semibold shrink-0">3.</span>
                <span>veTOWELI holders claim their proportional share based on voting power at snapshot time.</span>
              </div>
              <div className="flex gap-3 items-start">
                <span className="text-primary font-semibold shrink-0">4.</span>
                <span>A {bribes.bribeFeeBps / 100}% fee is taken from deposits and sent to the protocol treasury.</span>
              </div>
            </div>
            <p className="text-white/20 text-[10px] mt-3">
              Inspired by Aerodrome/Velodrome voter bribe model. Shares computed from on-chain checkpointed voting power.
            </p>
          </div>
        </motion.div>

        {/* Latest Epoch Info */}
        {bribes.latestEpoch && (
          <motion.div className="relative overflow-hidden rounded-xl mt-6" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
            <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.95)' }} />
            <div className="relative z-10 p-5">
              <h3 className="text-white text-[15px] font-semibold mb-3">Latest Epoch #{bribes.epochCount - 1}</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                  <p className="text-white/30 text-[10px] mb-1">Total Voting Power</p>
                  <p className="stat-value text-[14px] text-white">{parseFloat(formatEther(bribes.latestEpoch.totalPower)).toLocaleString()} veTOWELI</p>
                </div>
                <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                  <p className="text-white/30 text-[10px] mb-1">Snapshot Time</p>
                  <p className="stat-value text-[14px] text-white">{new Date(bribes.latestEpoch.timestamp * 1000).toLocaleString()}</p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
