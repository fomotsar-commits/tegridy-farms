import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useDCA } from '../../hooks/useDCA';
import { DEFAULT_TOKENS } from '../../lib/tokenList';


const INTERVALS = [
  { label: 'Daily', value: 'daily' as const },
  { label: 'Weekly', value: 'weekly' as const },
  { label: 'Bi-weekly', value: 'biweekly' as const },
  { label: 'Monthly', value: 'monthly' as const },
];

export function DCATab() {
  const { isConnected } = useAccount();
  const { activeSchedules, dueSchedules, createSchedule, cancelSchedule } = useDCA();
  const [amount, setAmount] = useState('');
  const [intervalIdx, setIntervalIdx] = useState(0); // daily
  const [totalSwaps, setTotalSwaps] = useState('30');

  const fromToken = DEFAULT_TOKENS.find(t => t.symbol === 'ETH')!;
  const toToken = DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI')!;

  const handleCreate = () => {
    if (!amount || parseFloat(amount) <= 0 || !totalSwaps || parseInt(totalSwaps) <= 0) return;
    createSchedule({
      fromToken: { symbol: fromToken.symbol, address: fromToken.address, decimals: fromToken.decimals },
      toToken: { symbol: toToken.symbol, address: toToken.address, decimals: toToken.decimals },
      amountPerSwap: amount,
      interval: INTERVALS[intervalIdx].value,
      totalSwaps: parseInt(totalSwaps),
    });
    setAmount('');
    setTotalSwaps('30');
  };

  const totalCost = amount && totalSwaps ? (parseFloat(amount) * parseInt(totalSwaps)).toFixed(4) : '0';

  return (
    <div className="p-5">
      <p className="text-white/30 text-[11px] mb-4">Automatically buy TOWELI at regular intervals. Reduce timing risk with dollar-cost averaging.</p>

      {/* Amount per swap */}
      <div className="mb-3">
        <label className="text-white/40 text-[11px] mb-1.5 block">Amount per Swap (ETH)</label>
        <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
          placeholder="0.01" min="0" step="0.001"
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-3 py-2.5 rounded-lg token-input"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
      </div>

      {/* Interval */}
      <div className="mb-3">
        <label className="text-white/40 text-[11px] mb-1.5 block">Frequency</label>
        <div className="flex gap-1.5">
          {INTERVALS.map((opt, i) => (
            <button key={opt.value} onClick={() => setIntervalIdx(i)}
              className="flex-1 py-2 rounded-lg text-[11px] font-medium cursor-pointer transition-all"
              style={{
                background: intervalIdx === i ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)',
                color: intervalIdx === i ? 'var(--color-primary)' : 'rgba(255,255,255,0.4)',
                border: intervalIdx === i ? '1px solid rgba(139,92,246,0.30)' : '1px solid rgba(255,255,255,0.06)',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Number of swaps */}
      <div className="mb-3">
        <label className="text-white/40 text-[11px] mb-1.5 block">Number of Swaps</label>
        <input type="number" value={totalSwaps} onChange={e => setTotalSwaps(e.target.value)}
          placeholder="30" min="1" max="365"
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-3 py-2.5 rounded-lg token-input"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
      </div>

      {/* Summary */}
      {amount && parseFloat(amount) > 0 && totalSwaps && parseInt(totalSwaps) > 0 && (
        <div className="rounded-lg p-3 mb-4" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-white/30 text-[11px]">Per swap</span>
            <span className="text-white/60 text-[12px] font-mono">{amount} ETH → TOWELI</span>
          </div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-white/30 text-[11px]">Schedule</span>
            <span className="text-white/60 text-[12px]">{INTERVALS[intervalIdx].label} × {totalSwaps}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/30 text-[11px]">Total cost</span>
            <span className="stat-value text-[12px] text-primary">{totalCost} ETH</span>
          </div>
        </div>
      )}

      {isConnected ? (
        <button onClick={handleCreate}
          disabled={!amount || parseFloat(amount) <= 0 || !totalSwaps || parseInt(totalSwaps) <= 0}
          className="btn-primary w-full py-3 text-[13px] disabled:opacity-35 disabled:cursor-not-allowed">
          Start DCA
        </button>
      ) : (
        <ConnectButton.Custom>
          {({ openConnectModal, mounted }) => (
            <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
              <button onClick={openConnectModal} className="btn-primary w-full py-3 text-[13px]">Connect Wallet</button>
            </div>
          )}
        </ConnectButton.Custom>
      )}

      <p className="text-white/15 text-[10px] text-center mt-2">
        Note: DCA schedules are saved locally as price alerts. You'll need to execute each swap manually.
      </p>

      {/* Active DCA Schedules */}
      {activeSchedules.length > 0 && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(139,92,246,0.08)' }}>
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-2">Active DCA</p>
          {activeSchedules.map(s => (
            <div key={s.id} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-white/[0.02]"
              style={{ borderBottom: '1px solid rgba(139,92,246,0.04)' }}>
              <div>
                <span className="text-white/60 text-[12px] font-medium">{s.amountPerSwap} ETH</span>
                <span className="text-white/20 text-[11px] mx-1"> · </span>
                <span className="text-white/40 text-[11px]">{s.interval}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-success text-[10px]">{s.completedSwaps}/{s.totalSwaps}</span>
                {dueSchedules.some(d => d.id === s.id) && (
                  <span className="badge badge-warning text-[9px]">Due</span>
                )}
                <button onClick={() => cancelSchedule(s.id)}
                  className="text-white/20 hover:text-danger text-[10px] cursor-pointer transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
