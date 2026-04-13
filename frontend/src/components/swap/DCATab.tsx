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

const MAX_AMOUNT_ETH = 100;

/** Block minus/negative sign in number inputs */
const blockNegativeKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === 'e') e.preventDefault();
};

export function DCATab() {
  const { isConnected } = useAccount();
  const { activeSchedules, dueSchedules, createSchedule, cancelSchedule, pauseSchedule, resumeSchedule } = useDCA();
  const [amount, setAmount] = useState('');
  const [intervalIdx, setIntervalIdx] = useState(0); // daily
  const [totalSwaps, setTotalSwaps] = useState('30');

  const fromToken = DEFAULT_TOKENS.find(t => t.symbol === 'ETH')!;
  const toToken = DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI')!;

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const num = parseFloat(val);
    if (val !== '' && num < 0) return;
    setAmount(val);
  };

  const handleSwapsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const num = parseInt(val);
    if (val !== '' && num < 0) return;
    setTotalSwaps(val);
  };

  const handleCreate = () => {
    const parsed = parseInt(totalSwaps);
    if (!amount || parseFloat(amount) <= 0 || !totalSwaps || !Number.isFinite(parsed) || parsed <= 0) return;
    createSchedule({
      fromToken: { symbol: fromToken.symbol, address: fromToken.address, decimals: fromToken.decimals, ...(fromToken.isNative && { isNative: true }) },
      toToken: { symbol: toToken.symbol, address: toToken.address, decimals: toToken.decimals, ...(toToken.isNative && { isNative: true }) },
      amountPerSwap: amount,
      interval: INTERVALS[intervalIdx].value,
      totalSwaps: parsed,
    });
    setAmount('');
    setTotalSwaps('30');
  };

  const totalCost = amount && totalSwaps ? ((parseFloat(amount) || 0) * (parseInt(totalSwaps) || 0)).toFixed(4) : '0';

  return (
    <div className="p-5">
      <p className="text-white text-[11px] mb-2">Automatically buy TOWELI at regular intervals. Reduce timing risk with dollar-cost averaging.</p>
      <p className="text-amber-400/60 text-[10px] mb-4 bg-amber-900/20 rounded px-2 py-1 border border-amber-700/30">⚠️ Browser-only feature: DCA schedules only run while this tab is open. Closing the browser stops all scheduled swaps. A keeper-based on-chain DCA is planned for v2.</p>

      {/* Amount per swap */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="dca-amount" className="text-white text-[11px]">Amount per Swap (ETH)</label>
          <span className="text-white/40 text-[10px] font-mono">Max: {MAX_AMOUNT_ETH} ETH</span>
        </div>
        <input id="dca-amount" type="number" inputMode="decimal" value={amount} onChange={handleAmountChange}
          onKeyDown={blockNegativeKey}
          placeholder="0.01" min="0" max={MAX_AMOUNT_ETH} step="0.001"
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ border: '1px solid rgba(255,255,255,0.20)' }} />
      </div>

      {/* Interval */}
      <div className="mb-3">
        <span id="dca-frequency-label" className="text-white text-[11px] mb-1.5 block">Frequency</span>
        <div className="flex gap-1.5" role="group" aria-labelledby="dca-frequency-label">
          {INTERVALS.map((opt, i) => (
            <button key={opt.value} onClick={() => setIntervalIdx(i)}
              aria-pressed={intervalIdx === i}
              className="flex-1 py-2 min-h-[44px] rounded-lg text-[11px] font-medium cursor-pointer transition-all"
              style={{
                background: intervalIdx === i ? 'rgba(139,92,246,0.75)' : 'rgba(0,0,0,0.55)',
                color: intervalIdx === i ? 'var(--color-primary)' : 'rgba(255,255,255,0.4)',
                border: intervalIdx === i ? '1px solid rgba(139,92,246,0.75)' : '1px solid rgba(255,255,255,0.25)',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Number of swaps */}
      <div className="mb-3">
        <label htmlFor="dca-total-swaps" className="text-white text-[11px] mb-1.5 block">Number of Swaps</label>
        <input id="dca-total-swaps" type="number" inputMode="numeric" value={totalSwaps} onChange={handleSwapsChange}
          onKeyDown={blockNegativeKey}
          placeholder="30" min="1" max="365"
          onBlur={() => { const v = parseInt(totalSwaps); if (isNaN(v) || v < 1) setTotalSwaps('1'); else if (v > 365) setTotalSwaps('365'); }}
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ border: '1px solid rgba(255,255,255,0.20)' }} />
      </div>

      {/* Summary */}
      {amount && parseFloat(amount) > 0 && totalSwaps && parseInt(totalSwaps) > 0 && (
        <div className="rounded-lg p-3 mb-4" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}
          aria-live="polite">
          <div className="flex items-center justify-between mb-1">
            <span className="text-white text-[11px]">Per swap</span>
            <span className="text-white text-[12px] font-mono">{amount} ETH → TOWELI</span>
          </div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-white text-[11px]">Schedule</span>
            <span className="text-white text-[12px]">{INTERVALS[intervalIdx].label} × {totalSwaps}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white text-[11px]">Total cost</span>
            <span className="stat-value text-[12px] text-white">{totalCost} ETH</span>
          </div>
        </div>
      )}

      {isConnected ? (
        <button type="button" onClick={handleCreate}
          disabled={!amount || parseFloat(amount) <= 0 || !totalSwaps || parseInt(totalSwaps) <= 0}
          aria-disabled={!amount || parseFloat(amount) <= 0 || !totalSwaps || parseInt(totalSwaps) <= 0}
          className="btn-primary w-full py-3 min-h-[44px] text-[13px] disabled:opacity-70 disabled:cursor-not-allowed">
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
        Swaps execute automatically when due. Keep this tab open — your wallet will prompt for approval.
      </p>
      <p className="text-amber-400/40 text-[10px] text-center mt-1">
        Schedules are stored in your browser. Clearing browser data or switching devices will remove them.
      </p>

      {/* Active DCA Schedules */}
      {activeSchedules.length > 0 && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(139,92,246,0.75)' }}>
          <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-2">Active DCA</p>
          {activeSchedules.map(s => (
            <div key={s.id} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-black/60"
              style={{ borderBottom: '1px solid rgba(139,92,246,0.75)' }}>
              <div>
                <span className="text-white text-[12px] font-medium">{s.amountPerSwap} ETH</span>
                <span className="text-white text-[11px] mx-1"> · </span>
                <span className="text-white text-[11px]">{s.interval}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-success text-[10px]">{s.completedSwaps}/{s.totalSwaps}</span>
                {dueSchedules.some(d => d.id === s.id) && (
                  <span className="badge badge-warning text-[9px]">Due</span>
                )}
                {s.status === 'active' ? (
                  <button onClick={() => pauseSchedule(s.id)}
                    className="text-white hover:text-warning text-[10px] min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer transition-colors">
                    Pause
                  </button>
                ) : s.status === 'paused' ? (
                  <button onClick={() => resumeSchedule(s.id)}
                    className="text-white hover:text-white text-[10px] min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer transition-colors">
                    Resume
                  </button>
                ) : null}
                <button onClick={() => cancelSchedule(s.id)}
                  className="text-white hover:text-danger text-[10px] min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer transition-colors">
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
