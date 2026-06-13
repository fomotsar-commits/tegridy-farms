import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useDCA, DEFAULT_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from '../../hooks/useDCA';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { InfoTooltip } from '../ui/InfoTooltip';


const INTERVALS = [
  { label: 'Daily', value: 'daily' as const },
  { label: 'Weekly', value: 'weekly' as const },
  { label: 'Bi-weekly', value: 'biweekly' as const },
  { label: 'Monthly', value: 'monthly' as const },
];

const MAX_AMOUNT_ETH = 100;
// AUDIT FIX FE-HIGH-4: same presets as the swap UI so a DCA flow doesn't feel
// like a different product. 0.5% default mirrors the swap default.
const SLIPPAGE_PRESETS_PCT = [0.1, 0.5, 1.0, 2.0];

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
  // AUDIT FIX FE-HIGH-4: per-schedule slippage in % (UI). Stored as bps when
  // forwarded to createSchedule below.
  const [slippagePct, setSlippagePct] = useState<number>(DEFAULT_SLIPPAGE_BPS / 100);

  const fromToken = DEFAULT_TOKENS.find(t => t.symbol === 'ETH')!;
  const toToken = DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI')!;

  // F231: the HTML max=100 only constrains spinner arrows, so a typed "200"
  // was accepted and the summary computed "Total cost 6000 ETH". Show an inline
  // error when the typed amount exceeds the cap; createSchedule already rejects
  // out-of-range as a backstop. We keep the raw value (don't silently rewrite
  // the user's keystrokes) and surface the error + disable Start.
  const amountExceedsCap = !!amount && Number.isFinite(parseFloat(amount)) && parseFloat(amount) > MAX_AMOUNT_ETH;

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
    // F231: hard-stop over-cap amounts (UI guard; createSchedule re-validates).
    if (parseFloat(amount) > MAX_AMOUNT_ETH) return;
    // AUDIT FIX FE-HIGH-4: clamp slippage to bps and forward; createSchedule
    // re-validates server-side as a defensive backstop.
    const slippageBps = Math.max(
      MIN_SLIPPAGE_BPS,
      Math.min(MAX_SLIPPAGE_BPS, Math.round(slippagePct * 100)),
    );
    createSchedule({
      fromToken: { symbol: fromToken.symbol, address: fromToken.address, decimals: fromToken.decimals, ...(fromToken.isNative && { isNative: true }) },
      toToken: { symbol: toToken.symbol, address: toToken.address, decimals: toToken.decimals, ...(toToken.isNative && { isNative: true }) },
      amountPerSwap: amount,
      interval: INTERVALS[intervalIdx]!.value,
      totalSwaps: parsed,
      slippageBps,
    });
    setAmount('');
    setTotalSwaps('30');
    setSlippagePct(DEFAULT_SLIPPAGE_BPS / 100);
  };

  const totalCost = amount && totalSwaps ? ((parseFloat(amount) || 0) * (parseInt(totalSwaps) || 0)).toFixed(4) : '0';

  return (
    <div className="p-5">
      <p className="text-white text-[11px] mb-2" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Set reminders to buy TOWELI at regular intervals. Your wallet signs each swap when it&rsquo;s due &mdash; keep this tab open. (Dollar-cost-averaging pattern, but execution is tab-local, not a keeper.)</p>
      <p className="text-amber-300 text-[10px] mb-4 rounded px-2 py-1.5 border border-amber-500/50" style={{ background: 'rgba(0,0,0,0.70)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>&#9888; Browser-only feature: DCA schedules only run while this tab is open. Closing the browser stops all scheduled swaps. A keeper-based on-chain DCA is planned for v2.</p>

      {/* Amount per swap */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="dca-amount" className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Amount per Swap (ETH)</label>
          <span className="text-white/90 text-[10px] font-mono" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Max: {MAX_AMOUNT_ETH} ETH</span>
        </div>
        <input id="dca-amount" type="number" inputMode="decimal" value={amount} onChange={handleAmountChange}
          onKeyDown={blockNegativeKey}
          placeholder="0.01" min="0" max={MAX_AMOUNT_ETH} step="0.001"
          aria-invalid={amountExceedsCap}
          className="w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ background: 'rgba(0,0,0,0.55)', border: amountExceedsCap ? '1px solid rgba(239,68,68,0.65)' : '1px solid rgba(255,255,255,0.18)' }} />
        {amountExceedsCap && (
          <p role="alert" className="mt-1 text-[10px] text-red-300" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
            Max {MAX_AMOUNT_ETH} ETH per swap.
          </p>
        )}
      </div>

      {/* Interval */}
      <div className="mb-3">
        <span id="dca-frequency-label" className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Frequency</span>
        <div className="flex gap-1.5" role="group" aria-labelledby="dca-frequency-label">
          {INTERVALS.map((opt, i) => (
            <button key={opt.value} onClick={() => setIntervalIdx(i)}
              aria-pressed={intervalIdx === i}
              className="flex-1 py-2 min-h-[44px] rounded-lg text-[11px] font-medium cursor-pointer transition-all text-white"
              style={{
                background: intervalIdx === i ? 'var(--color-stan)' : 'rgba(0,0,0,0.55)',
                border: intervalIdx === i ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.18)',
                boxShadow: intervalIdx === i ? '0 4px 12px var(--color-stan-40)' : undefined,
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Number of swaps */}
      <div className="mb-3">
        <label htmlFor="dca-total-swaps" className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Number of Swaps</label>
        <input id="dca-total-swaps" type="number" inputMode="numeric" value={totalSwaps} onChange={handleSwapsChange}
          onKeyDown={blockNegativeKey}
          placeholder="30" min="1" max="365"
          onBlur={() => { const v = parseInt(totalSwaps); if (isNaN(v) || v < 1) setTotalSwaps('1'); else if (v > 365) setTotalSwaps('365'); }}
          className="w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }} />
      </div>

      {/* AUDIT FIX FE-HIGH-4: per-schedule slippage. Pre-fix every DCA swap
          ran with a hard-coded 5% (sandwich-attack bait). Bounded to
          [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS] so a careless click can't
          set 20%. */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="dca-slippage" className="text-white text-[11px] inline-flex items-center gap-1.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Slippage Tolerance
            {/* F241: the help was a native title= attr (1-2s desktop hover, no
                touch path — violates the responsive mandate). InfoTooltip is
                tap- and keyboard-accessible. */}
            <InfoTooltip
              text={`Max price drift you'll accept per swap. Lower = more MEV-resistant but more failed swaps. Range: ${MIN_SLIPPAGE_BPS / 100}%–${MAX_SLIPPAGE_BPS / 100}%.`}
            />
          </label>
          <span className="text-white/90 text-[10px] font-mono" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{slippagePct.toFixed(2)}%</span>
        </div>
        <div className="flex items-center gap-1.5 mb-1.5" role="group" aria-label="Slippage presets">
          {SLIPPAGE_PRESETS_PCT.map(pct => {
            const active = Math.abs(slippagePct - pct) < 0.001;
            return (
              <button key={pct} type="button" onClick={() => setSlippagePct(pct)}
                aria-pressed={active}
                className="flex-1 py-1.5 min-h-[36px] rounded-lg text-[11px] font-medium cursor-pointer transition-all text-white"
                style={{
                  background: active ? 'var(--color-stan)' : 'rgba(0,0,0,0.55)',
                  border: active ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.18)',
                }}>
                {pct}%
              </button>
            );
          })}
        </div>
        <input id="dca-slippage" type="number" inputMode="decimal"
          value={slippagePct}
          min={MIN_SLIPPAGE_BPS / 100} max={MAX_SLIPPAGE_BPS / 100} step="0.1"
          onKeyDown={blockNegativeKey}
          onChange={e => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) setSlippagePct(v);
          }}
          onBlur={() => {
            // Clamp to [min, max] on blur so the user can't end up with an
            // out-of-range value the create handler rejects.
            const minPct = MIN_SLIPPAGE_BPS / 100;
            const maxPct = MAX_SLIPPAGE_BPS / 100;
            if (slippagePct < minPct) setSlippagePct(minPct);
            else if (slippagePct > maxPct) setSlippagePct(maxPct);
          }}
          aria-label={`Custom slippage in percent (${MIN_SLIPPAGE_BPS / 100}%–${MAX_SLIPPAGE_BPS / 100}%)`}
          className="w-full font-mono text-[14px] text-white outline-none px-3 py-2 min-h-[40px] rounded-lg token-input"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }} />
      </div>

      {/* Summary — hidden while the amount is over the cap (F231) so we don't
          show a "Total cost 6000 ETH" for an amount that won't be accepted. */}
      {amount && parseFloat(amount) > 0 && !amountExceedsCap && totalSwaps && parseInt(totalSwaps) > 0 && (
        <div className="rounded-lg p-3 mb-4" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}
          aria-live="polite">
          <div className="flex items-center justify-between mb-1">
            <span className="text-white text-[11px]">Per swap</span>
            <span className="text-white text-[12px] font-mono">{amount} ETH → TOWELI</span>
          </div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-white text-[11px]">Schedule</span>
            <span className="text-white text-[12px]">{INTERVALS[intervalIdx]!.label} × {totalSwaps}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white text-[11px]">Total cost</span>
            <span className="stat-value text-[12px] text-white">{totalCost} ETH</span>
          </div>
        </div>
      )}

      {isConnected ? (
        <button type="button" onClick={handleCreate}
          disabled={!amount || parseFloat(amount) <= 0 || amountExceedsCap || !totalSwaps || parseInt(totalSwaps) <= 0}
          aria-disabled={!amount || parseFloat(amount) <= 0 || amountExceedsCap || !totalSwaps || parseInt(totalSwaps) <= 0}
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
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--color-purple-75)' }}>
          <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-2">Active DCA</p>
          {activeSchedules.map(s => (
            <div key={s.id} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-black/60"
              style={{ borderBottom: '1px solid var(--color-purple-75)' }}>
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
