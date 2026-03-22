import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { StakeModal } from './StakeModal';
import { usePoolData } from '../../hooks/usePoolData';
import { useUserPosition } from '../../hooks/useUserPosition';
import { useFarmActions } from '../../hooks/useFarmActions';
import { useNetworkCheck } from '../../hooks/useNetworkCheck';
import { formatTokenAmount } from '../../lib/formatting';

interface PoolCardProps {
  pid: number;
  name: string;
  subtitle: string;
  tokenSymbol: string;
  lpTokenAddress: `0x${string}`;
  allocPercent: number;
  icon: string;
  color: 'green' | 'blue';
}

const MOCK = { apr: '–', tvl: '–', staked: '0.00', earned: '0.00' };
// Minimum claimable amount to avoid wasting gas (0.01 TOWELI)
const MIN_CLAIM_AMOUNT = 10000000000000000n; // 0.01e18

export function PoolCard({ pid, name, subtitle, tokenSymbol, lpTokenAddress, allocPercent, icon, color }: PoolCardProps) {
  const { isConnected } = useAccount();
  const { isWrongNetwork } = useNetworkCheck();
  const [showStake, setShowStake] = useState(false);
  const [showUnstake, setShowUnstake] = useState(false);

  const poolId = BigInt(pid);
  const pool = usePoolData(poolId);
  const position = useUserPosition(poolId, lpTokenAddress);
  const { claim: claimReward, isPending, isConfirming, writeError, isTxError } = useFarmActions();
  const canClaim = position.pendingReward >= MIN_CLAIM_AMOUNT;

  const tvl = pool.isDeployed ? `${Number(pool.totalStaked).toLocaleString()} ${tokenSymbol}` : MOCK.tvl;
  const staked = position.isDeployed ? position.stakedFormatted : MOCK.staked;
  const earned = position.isDeployed ? position.pendingFormatted : MOCK.earned;

  return (
    <>
      {/* Lock & Boost status */}
      {position.isLocked && (
        <div className="rounded-lg p-2 mb-2 flex items-center justify-between"
          style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.12)' }}>
          <span className="text-white/40 text-[10px]">
            Locked until {new Date(position.lockExpiry * 1000).toLocaleDateString()}
          </span>
          <span className="text-primary text-[10px] font-semibold">{position.boostMultiplier}x Boost</span>
        </div>
      )}

      {/* Low rewards warning */}
      {pool.rewardsLow && pool.isDeployed && (
        <div className="rounded-lg p-2 mb-2 text-[10px] text-warning"
          style={{ background: 'rgba(255,178,55,0.06)', border: '1px solid rgba(255,178,55,0.15)' }}>
          Rewards running low (~{pool.daysRemaining}d remaining). Emission rate is being throttled.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { l: 'TVL', v: tvl },
          { l: 'Your Stake', v: `${formatTokenAmount(staked)} ${tokenSymbol}` },
          { l: 'Earned', v: `${formatTokenAmount(earned)} TOWELI`, accent: true },
        ].map((s) => (
          <div key={s.l} className="rounded-lg p-2.5"
            style={{ background: 'rgba(6,12,26,0.6)', border: '1px solid rgba(139,92,246,0.08)' }}>
            <p className="text-white/30 text-[10px] uppercase tracking-wider mb-0.5">{s.l}</p>
            <p className={`stat-value text-[13px] ${s.accent ? 'text-primary' : 'text-white'}`}>{s.v}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      {!isConnected ? (
        <p className="text-center py-2 text-white/30 text-[12px]">Connect wallet to start farming</p>
      ) : isWrongNetwork ? (
        <p className="text-center py-2 text-danger text-[12px]">Switch to Ethereum Mainnet</p>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => setShowStake(true)} className="btn-primary flex-1 py-2 text-[13px]">Stake</button>
          <button onClick={() => setShowUnstake(true)} className="btn-secondary flex-1 py-2 text-[13px]">Unstake</button>
          <button onClick={() => claimReward(poolId)} disabled={isPending || isConfirming || !canClaim}
            className={`btn-secondary flex-1 py-2 text-[13px] ${isPending || isConfirming || !canClaim ? 'opacity-35 cursor-not-allowed' : ''}`}
            title={!canClaim ? 'Minimum 0.01 TOWELI to claim' : undefined}>
            {isPending || isConfirming ? '...' : 'Claim'}
          </button>
        </div>
      )}

      {/* Transaction error display */}
      {(writeError || isTxError) && (
        <p className="text-danger text-[11px] mt-2">
          {writeError?.message?.includes('user rejected') ? 'Rejected' : 'Transaction failed'}
        </p>
      )}

      <AnimatePresence>
        {showStake && <StakeModal pid={pid} tokenSymbol={tokenSymbol} lpTokenAddress={lpTokenAddress} action="stake" onClose={() => setShowStake(false)} />}
        {showUnstake && <StakeModal pid={pid} tokenSymbol={tokenSymbol} lpTokenAddress={lpTokenAddress} action="unstake" onClose={() => setShowUnstake(false)} />}
      </AnimatePresence>
    </>
  );
}
