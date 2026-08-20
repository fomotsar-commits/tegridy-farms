import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useCowTwap } from '../../hooks/useCowTwap';
import { planTwap, twapDataFromPlan, TWAP_MAX_PARTS, TWAP_MIN_PARTS } from '../../lib/composableCow';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { WETH_ADDRESS } from '../../lib/constants';
import { formatTokenAmountGrouped } from '../../lib/formatting';
import { Link } from 'react-router-dom';
import { TWAP_IDLE_NOTE } from '../../lib/yield/dcaYield';

const INTERVAL_OPTIONS = [
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '6 hours', seconds: 21600 },
  { label: '24 hours', seconds: 86400 },
];

const MAX_TOTAL_WETH = 1000;
const WETH_SCALE = 10n ** 18n;

const blockNegativeKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === 'e') e.preventDefault();
};

/**
 * TWAP order panel — splits a large WETH→TOWELI trade into equal parts that each
 * settle through CoW's solver auction (MEV-protected) on a schedule, via
 * ComposableCoW. Transparent by construction: the full plan (parts, size each,
 * price floor each, schedule) is shown BEFORE anything is signed.
 *
 * Honest scope: ComposableCoW is a smart-contract-order mechanism, so it only
 * works from an ERC-1271 wallet (a Safe) with CoW's fallback handler configured.
 * For a plain EOA the panel self-gates and explains why, pointing back to the
 * single-signature CoW limit order in this same tab.
 */
export function TwapOrderPanel() {
  const { isConnected, address } = useAccount();
  const twap = useCowTwap();

  const [totalAmount, setTotalAmount] = useState('');
  const [parts, setParts] = useState('4');
  const [intervalIdx, setIntervalIdx] = useState(2); // default 1 hour
  const [minPrice, setMinPrice] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toToken = DEFAULT_TOKENS.find((t) => t.symbol === 'TOWELI')!;

  const partsNum = Number(parts);
  const intervalSeconds = INTERVAL_OPTIONS[intervalIdx]!.seconds;

  // Pure schedule derivation — recomputed live as inputs change.
  const plan = useMemo(() => {
    let totalSellAmount = 0n;
    let priceNumerator = 0n;
    try {
      if (totalAmount) totalSellAmount = parseUnits(totalAmount, 18);
      if (minPrice) priceNumerator = parseUnits(minPrice, toToken.decimals);
    } catch {
      /* leave as 0 → plan invalid */
    }
    return planTwap({
      totalSellAmount,
      parts: partsNum,
      intervalSeconds,
      priceNumerator,
      priceScale: WETH_SCALE,
    });
  }, [totalAmount, minPrice, partsNum, intervalSeconds, toToken.decimals]);

  const totalExceedsCap =
    !!totalAmount && Number.isFinite(parseFloat(totalAmount)) && parseFloat(totalAmount) > MAX_TOTAL_WETH;

  const durationLabel = useMemo(() => {
    if (!plan.valid) return null;
    const totalSecs = (Number(plan.n) - 1) * intervalSeconds;
    if (totalSecs <= 0) return 'immediately';
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    if (h >= 24) return `~${Math.round(h / 24)} day(s)`;
    if (h >= 1) return `~${h}h${m ? ` ${m}m` : ''}`;
    return `~${m}m`;
  }, [plan, intervalSeconds]);

  const canSubmit = twap.isSupported && plan.valid && !totalExceedsCap && !twap.isSubmitting;

  const handleSubmit = async () => {
    if (!plan.valid || !twap.isSupported) return;
    if (totalExceedsCap || !address) return;
    // Receiver is the connected (smart-contract) account — the parts pay out to it.
    const data = twapDataFromPlan(plan, {
      sellToken: WETH_ADDRESS,
      buyToken: toToken.address as `0x${string}`,
      receiver: address,
    });
    const result = await twap.submitTwap(data);
    if (result) {
      setTotalAmount('');
      setMinPrice('');
    }
  };

  return (
    <div className="p-5 pt-0">
      <div className="pt-4 mt-2" style={{ borderTop: '1px solid var(--color-purple-75)' }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-white text-[13px] font-semibold" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            TWAP order
          </span>
          <span className="text-emerald-300 text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.35)' }}>
            MEV-protected
          </span>
        </div>
        <p className="text-white/75 text-[11px] mb-3" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Spread a large WETH → {toToken.symbol} buy into equal parts that fill on a schedule through CoW’s
          solver auction. Sells <strong>WETH</strong> (wrap ETH first).
        </p>

        {/* Inputs */}
        <div className="mb-3">
          <label htmlFor="twap-total" className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Total to sell (WETH)
          </label>
          <input
            id="twap-total"
            type="number"
            inputMode="decimal"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            onKeyDown={blockNegativeKey}
            placeholder="1.0"
            min="0"
            max={MAX_TOTAL_WETH}
            step="0.01"
            aria-invalid={totalExceedsCap}
            className="w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
            style={{ background: 'rgba(0,0,0,0.55)', border: totalExceedsCap ? '1px solid rgba(239,68,68,0.65)' : '1px solid rgba(255,255,255,0.18)' }}
          />
          {totalExceedsCap && (
            <p role="alert" className="mt-1 text-[10px] text-red-300">Max {MAX_TOTAL_WETH} WETH per TWAP.</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label htmlFor="twap-parts" className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              Parts ({TWAP_MIN_PARTS}–{TWAP_MAX_PARTS})
            </label>
            <input
              id="twap-parts"
              type="number"
              inputMode="numeric"
              value={parts}
              onChange={(e) => setParts(e.target.value)}
              onKeyDown={blockNegativeKey}
              min={TWAP_MIN_PARTS}
              max={TWAP_MAX_PARTS}
              step="1"
              className="w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
              style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}
            />
          </div>
          <div>
            <span className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Every</span>
            <select
              value={intervalIdx}
              onChange={(e) => setIntervalIdx(Number(e.target.value))}
              aria-label="Interval between parts"
              className="w-full font-mono text-[13px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg"
              style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}
            >
              {INTERVAL_OPTIONS.map((opt, i) => (
                <option key={opt.label} value={i} style={{ background: '#0d1530' }}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mb-3">
          <label htmlFor="twap-price" className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Min price ({toToken.symbol} per WETH)
          </label>
          <input
            id="twap-price"
            type="number"
            inputMode="decimal"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            onKeyDown={blockNegativeKey}
            placeholder="25000000"
            min="0"
            className="w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
            style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}
          />
        </div>

        {/* Transparent plan preview — shown BEFORE anything is signed. */}
        {totalAmount && minPrice && (
          <div className="mb-3 px-3 py-2.5 rounded-lg text-[11px]" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid var(--color-stan-40)' }}>
            {plan.valid ? (
              <>
                <div className="flex justify-between">
                  <span className="text-white/80">Each part sells</span>
                  <span className="text-white font-mono">{formatTokenAmountGrouped(formatUnits(plan.partSellAmount, 18))} WETH</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-white/80">Min received / part</span>
                  <span className="text-white font-mono">{formatTokenAmountGrouped(formatUnits(plan.minPartLimit, toToken.decimals))} {toToken.symbol}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-white/80">Guaranteed min total</span>
                  <span className="text-emerald-300 font-mono">{formatTokenAmountGrouped(formatUnits(plan.minTotalBuy, toToken.decimals))} {toToken.symbol}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-white/80">Schedule</span>
                  <span className="text-white font-mono">{plan.n.toString()} parts, {durationLabel}</span>
                </div>
                {plan.dust > 0n && (
                  <div className="flex justify-between mt-1">
                    <span className="text-white/60">Unsold remainder</span>
                    <span className="text-white/60 font-mono">{formatTokenAmountGrouped(formatUnits(plan.dust, 18))} WETH</span>
                  </div>
                )}
                {/* Sits with the plan rather than in a footnote because the
                    question it answers ("can I earn on the part that hasn't
                    sold?") is one a reader asks while looking at the schedule. */}
                <p className="text-white/60 text-[10px] leading-snug mt-2">{TWAP_IDLE_NOTE}</p>
                <p className="text-white/60 text-[10px] leading-snug mt-1">
                  A{' '}
                  <Link to="/swap" className="underline hover:text-white/80 transition-colors">DCA schedule</Link>{' '}
                  signs each buy separately, so its unspent budget is not pinned this way — the DCA tab shows how much
                  that is, and{' '}
                  <Link to="/yield" className="underline hover:text-white/80 transition-colors">Yield Routing</Link>{' '}
                  lists where it could go.
                </p>
              </>
            ) : (
              <p className="text-amber-300">{plan.error}</p>
            )}
          </div>
        )}

        {/* Action / gate */}
        {!isConnected ? (
          <ConnectButton.Custom>
            {({ openConnectModal, mounted }) => (
              <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                <button onClick={openConnectModal} className="btn-primary w-full py-3 text-[13px]">Connect Wallet</button>
              </div>
            )}
          </ConnectButton.Custom>
        ) : twap.isChecking ? (
          <p className="text-white/60 text-[11px] text-center py-2">Checking wallet type…</p>
        ) : !twap.isSupported ? (
          <div className="px-3 py-2.5 rounded-lg text-[10px]" style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.35)' }}>
            <p className="text-amber-200 leading-snug">{twap.reason}</p>
            <p className="text-white/60 mt-1.5">Prefer a single order? Use the CoW limit order above — it works from any wallet with one signature.</p>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              className="btn-primary w-full py-3 min-h-[44px] text-[13px] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {twap.isSubmitting ? 'Registering TWAP…' : `Register TWAP (WETH → ${toToken.symbol})`}
            </button>
            <p className="mt-2 text-[9px] text-white/50 leading-snug">
              Your Safe must have CoW’s ComposableCoW fallback handler enabled (the CoW Swap app sets this up).
              One transaction registers the whole schedule; CoW’s watchtower posts each part on time.
            </p>
            {plan.valid && (
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="mt-1 text-[10px] text-white/55 hover:text-white/80 underline underline-offset-2"
              >
                {showAdvanced ? 'Hide order data' : 'Show exact order data (transparency)'}
              </button>
            )}
            {showAdvanced && plan.valid && (
              <TwapCalldataPreview
                previewCalldata={twap.previewCalldata}
                plan={plan}
                toTokenAddress={toToken.address}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TwapCalldataPreview({
  previewCalldata,
  plan,
  toTokenAddress,
}: {
  previewCalldata: ReturnType<typeof useCowTwap>['previewCalldata'];
  plan: ReturnType<typeof planTwap>;
  toTokenAddress: string;
}) {
  const preview = useMemo(() => {
    const data = twapDataFromPlan(plan, {
      sellToken: WETH_ADDRESS,
      buyToken: toTokenAddress as `0x${string}`,
      receiver: WETH_ADDRESS, // placeholder for display only
    });
    return previewCalldata(data);
  }, [previewCalldata, plan, toTokenAddress]);
  return (
    <div className="mt-2 px-2 py-1.5 rounded text-[9px] text-white/70" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)' }}>
      <p className="mb-0.5"><span className="text-white/50">Contract:</span> ComposableCoW</p>
      <p className="mb-0.5 font-mono break-all"><span className="text-white/50">To:</span> {preview.to}</p>
      <p className="font-mono break-all"><span className="text-white/50">create() calldata:</span> {preview.data.slice(0, 42)}…</p>
      <p className="mt-1 text-white/40">Receiver is set to your connected account at signing time.</p>
    </div>
  );
}
