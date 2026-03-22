import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { formatEther, parseEther } from 'viem';
import { useUserPosition } from '../../hooks/useUserPosition';
import { useFarmActions } from '../../hooks/useFarmActions';
import { ConfettiEffect } from '../ui/ConfettiEffect';

interface StakeModalProps {
  pid: number;
  tokenSymbol: string;
  lpTokenAddress: `0x${string}`;
  action: 'stake' | 'unstake';
  onClose: () => void;
}

const LOCK_TIERS = [
  { label: '7 Days', boost: '1x', tier: 0n, duration: '7d' },
  { label: '30 Days', boost: '2x', tier: 1n, duration: '30d' },
  { label: '90 Days', boost: '3x', tier: 2n, duration: '90d' },
  { label: '180 Days', boost: '5x', tier: 3n, duration: '180d' },
];

export function StakeModal({ pid, tokenSymbol, lpTokenAddress, action, onClose }: StakeModalProps) {
  const [amount, setAmount] = useState('');
  const [selectedTier, setSelectedTier] = useState(0);
  const poolId = BigInt(pid);
  const position = useUserPosition(poolId, lpTokenAddress);
  const { approve, deposit, withdraw, isPending, isConfirming, isSuccess, isTxError, writeError, reset } = useFarmActions();

  const title = action === 'stake' ? `Stake ${tokenSymbol}` : `Unstake ${tokenSymbol}`;
  const maxBalance = action === 'stake' ? position.walletBalance : position.stakedAmount;
  const maxFormatted = formatEther(maxBalance);
  const needsApproval = action === 'stake' && position.needsApproval;

  const parsedAmount = (() => {
    try {
      const val = parseFloat(amount);
      if (isNaN(val) || val <= 0) return 0n;
      return parseEther(amount);
    } catch {
      return 0n;
    }
  })();
  const exceedsBalance = parsedAmount > 0n && parsedAmount > maxBalance;

  useEffect(() => {
    if (isSuccess) {
      position.refetchAll().then(() => {
        const timer = setTimeout(() => { reset(); onClose(); }, 1200);
        return () => clearTimeout(timer);
      });
    }
  }, [isSuccess]);

  const handleAction = () => {
    if (!amount || Number(amount) <= 0 || exceedsBalance) return;
    if (needsApproval) approve(lpTokenAddress, amount);
    else if (action === 'stake') deposit(poolId, amount, LOCK_TIERS[selectedTier].tier);
    else withdraw(poolId, amount);
  };

  const getLabel = () => {
    if (isSuccess) return 'Done!';
    if (isConfirming) return 'Confirming...';
    if (isPending) return 'Confirm in Wallet...';
    if (!amount || Number(amount) <= 0) return 'Enter Amount';
    if (exceedsBalance) return 'Exceeds Balance';
    if (needsApproval) return `Approve ${tokenSymbol}`;
    return action === 'stake' ? `Lock & Stake (${LOCK_TIERS[selectedTier].duration})` : 'Unstake';
  };

  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <motion.div className="relative card p-5 w-full max-w-sm"
        initial={{ scale: 0.95, y: 15 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 15 }}
        transition={{ type: 'spring', damping: 25 }}>

        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[16px] font-semibold text-text-primary">{title}</h3>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="text-text-muted hover:text-danger transition-colors cursor-pointer text-[16px] p-1 z-10 relative">&#10005;</button>
        </div>

        {/* Lock tier selector (only for staking) */}
        {action === 'stake' && (
          <div className="mb-3">
            <p className="text-text-muted text-[11px] uppercase tracking-wider mb-2">Lock Duration & Boost</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {LOCK_TIERS.map((t, i) => (
                <button key={i} onClick={() => setSelectedTier(i)}
                  className="rounded-lg p-2 text-center cursor-pointer transition-all"
                  style={{
                    background: selectedTier === i ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)',
                    border: selectedTier === i ? '1px solid rgba(139,92,246,0.35)' : '1px solid rgba(255,255,255,0.06)',
                  }}>
                  <p className={`text-[12px] font-semibold ${selectedTier === i ? 'text-primary' : 'text-white/50'}`}>{t.boost}</p>
                  <p className="text-white/30 text-[9px]">{t.label}</p>
                </button>
              ))}
            </div>
            {position.isLocked && (
              <p className="text-warning text-[10px] mt-1.5">
                Current lock active until {new Date(position.lockExpiry * 1000).toLocaleDateString()}. New lock must be equal or longer.
              </p>
            )}
          </div>
        )}

        {/* Unstake: show lock status */}
        {action === 'unstake' && position.isLocked && (
          <div className="rounded-lg p-2.5 mb-3 text-[11px] text-warning"
            style={{ background: 'rgba(255,178,55,0.08)', border: '1px solid rgba(255,178,55,0.20)' }}>
            Locked until {new Date(position.lockExpiry * 1000).toLocaleDateString()}. Use emergency withdraw to exit early (forfeits rewards).
          </div>
        )}

        <div className="card-inner p-3.5 mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-text-muted text-[11px]">Amount</span>
            <button onClick={() => setAmount(maxFormatted)}
              className="text-[11px] text-primary font-medium hover:opacity-80 cursor-pointer transition-opacity">MAX</button>
          </div>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00" className="w-full bg-transparent font-mono text-xl text-text-primary outline-none token-input" />
          <p className="text-text-muted text-[11px] mt-2">
            {action === 'stake' ? 'Wallet' : 'Staked'}: <span className="font-mono">{Number(maxFormatted).toFixed(4)}</span> {tokenSymbol}
          </p>
        </div>

        {/* Error display */}
        {(writeError || isTxError) && (
          <div className="rounded-lg p-2.5 mb-3 text-[11px] text-danger"
            style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
            {writeError?.message?.includes('user rejected')
              ? 'Transaction rejected in wallet'
              : writeError?.message?.includes('StillLocked')
              ? 'Tokens are still locked. Wait for lock to expire or use emergency withdraw.'
              : writeError?.message?.slice(0, 100) || 'Transaction failed'}
          </div>
        )}

        <button onClick={handleAction}
          disabled={isPending || isConfirming || !amount || Number(amount) <= 0 || exceedsBalance}
          className={`w-full py-2.5 rounded-[10px] text-[14px] font-semibold cursor-pointer transition-all
            ${isSuccess ? 'bg-success text-[#072031]' :
              exceedsBalance ? 'bg-danger/20 text-danger' :
              'btn-primary'}
            ${isPending || isConfirming ? 'opacity-35 cursor-not-allowed' : ''}`}>
          {getLabel()}
        </button>

        {needsApproval && amount && Number(amount) > 0 && !exceedsBalance && (
          <p className="text-center text-text-muted text-[11px] mt-2">Approve token first, then stake</p>
        )}
      </motion.div>

      <ConfettiEffect trigger={isSuccess} />
    </motion.div>
  );
}
