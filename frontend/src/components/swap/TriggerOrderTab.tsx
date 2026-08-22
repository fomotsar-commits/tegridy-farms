import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useTriggerOrders } from '../../hooks/useTriggerOrders';
import {
  planTrigger,
  trailingStopPrice,
  TRIGGER_KINDS,
  TRIGGER_KIND_LABELS,
  MAX_TRAIL_BPS,
  MIN_TRAIL_BPS,
  type TriggerKind,
} from '../../lib/triggers/triggerPlan';
import { KEEPER_REQUIREMENTS } from '../../lib/triggers/armState';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { WETH_ADDRESS } from '../../lib/constants';
import { formatTokenAmountGrouped } from '../../lib/formatting';

const SLIPPAGE_PRESETS_BPS = [50, 100, 200, 500];
const STALENESS_OPTIONS = [
  { label: '15 minutes', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '6 hours', seconds: 21600 },
  { label: '24 hours', seconds: 86400 },
];

const MAX_SELL_TOWELI = 1_000_000_000;
const WETH_SCALE = 10n ** 18n;

const blockNegativeKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === 'e') e.preventDefault();
};

/** Prices here are tiny (WETH per TOWELI); grouping helpers assume the opposite. */
function formatPrice(v: bigint): string {
  return formatUnits(v, 18);
}

/**
 * Trigger-order builder — stop-loss, take-profit, trailing stop, OCO, exiting a
 * TOWELI position into WETH.
 *
 * The panel is built around one refusal. Only a stop-loss, from a Safe, on a pair
 * with configured price feeds, has an executor that exists today (CoW's watchtower
 * polling a ComposableCoW StopLoss order). Everything else needs the venue keeper,
 * which is not built — so those orders are never placed, and the panel says that in
 * the largest words on it rather than accepting an order nothing would ever fire.
 */
export function TriggerOrderTab() {
  const { isConnected, address } = useAccount();

  const sellToken = DEFAULT_TOKENS.find((t) => t.symbol === 'TOWELI')!;

  const [kind, setKind] = useState<TriggerKind>('stop-loss');
  const [amount, setAmount] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [referencePrice, setReferencePrice] = useState('');
  const [trailPct, setTrailPct] = useState('10');
  const [slippageBps, setSlippageBps] = useState(100);
  const [stalenessIdx, setStalenessIdx] = useState(1);
  const [showKeeperDetail, setShowKeeperDetail] = useState(false);

  const trigger = useTriggerOrders({
    kind,
    sellToken: sellToken.address,
    buyToken: WETH_ADDRESS,
  });

  const showStop = kind === 'stop-loss' || kind === 'oco';
  const showTarget = kind === 'take-profit' || kind === 'oco';
  const showTrail = kind === 'trailing-stop';

  const plan = useMemo(() => {
    const parse = (v: string): bigint => {
      try {
        return v ? parseUnits(v, 18) : 0n;
      } catch {
        return 0n;
      }
    };
    let sellAmount: bigint;
    try {
      sellAmount = amount ? parseUnits(amount, sellToken.decimals) : 0n;
    } catch {
      sellAmount = 0n; // an unparseable amount is zero, which planTrigger rejects with a reason
    }
    const trailNum = Number(trailPct);
    return planTrigger({
      kind,
      sellAmount,
      sellScale: 10n ** BigInt(sellToken.decimals),
      buyScale: WETH_SCALE,
      stopPrice: parse(stopPrice),
      targetPrice: parse(targetPrice),
      referencePrice: parse(referencePrice),
      trailBps: Number.isFinite(trailNum) ? Math.round(trailNum * 100) : 0,
      slippageBps,
      stalenessSeconds: STALENESS_OPTIONS[stalenessIdx]!.seconds,
    });
  }, [
    kind,
    amount,
    stopPrice,
    targetPrice,
    referencePrice,
    trailPct,
    slippageBps,
    stalenessIdx,
    sellToken.decimals,
  ]);

  const amountExceedsCap =
    !!amount && Number.isFinite(parseFloat(amount)) && parseFloat(amount) > MAX_SELL_TOWELI;

  const derivedTrail = useMemo(() => {
    if (!showTrail) return null;
    let ref: bigint;
    try {
      ref = referencePrice ? parseUnits(referencePrice, 18) : 0n;
    } catch {
      return null;
    }
    const trailNum = Number(trailPct);
    if (!Number.isFinite(trailNum)) return null;
    return trailingStopPrice(ref, Math.round(trailNum * 100));
  }, [showTrail, referencePrice, trailPct]);

  const canSubmit =
    trigger.arm.armed && plan.valid && !amountExceedsCap && !trigger.isSubmitting && !!address;

  const handleSubmit = async () => {
    if (!canSubmit || !address) return;
    const result = await trigger.submit(plan, {
      sellToken: sellToken.address as `0x${string}`,
      buyToken: WETH_ADDRESS,
      receiver: address,
    });
    if (result) {
      setAmount('');
      setStopPrice('');
    }
  };

  const inputClass =
    'w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input';
  const inputStyle = { background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' };
  const labelClass = 'text-white text-[11px] mb-1.5 block';
  const labelStyle = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' };

  return (
    <div className="p-5 pt-0">
      <div className="pt-4 mt-2" style={{ borderTop: '1px solid var(--color-purple-75)' }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-white text-[13px] font-semibold" style={labelStyle}>
            Trigger order
          </span>
          <span
            className={`text-[9px] px-1.5 py-0.5 rounded ${trigger.arm.armed ? 'text-emerald-300' : 'text-amber-200'}`}
            style={
              trigger.arm.armed
                ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.35)' }
                : { background: 'rgba(255,178,55,0.12)', border: '1px solid rgba(255,178,55,0.40)' }
            }
          >
            {trigger.arm.statusLabel}
          </span>
        </div>
        <p className="text-white/75 text-[11px] mb-3" style={labelStyle}>
          Exit a <strong>{sellToken.symbol}</strong> position into WETH when the price moves. Prices are
          quoted in <strong>WETH per {sellToken.symbol}</strong>.
        </p>

        {/* Kind */}
        <div className="grid grid-cols-2 gap-1.5 mb-3">
          {TRIGGER_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`px-2 py-2 min-h-[40px] rounded-lg text-[11px] ${kind === k ? 'text-white' : 'text-white/70'}`}
              style={{
                background: kind === k ? 'rgba(139,92,246,0.30)' : 'rgba(0,0,0,0.45)',
                border: kind === k ? '1px solid var(--color-stan-40)' : '1px solid rgba(255,255,255,0.14)',
              }}
            >
              {TRIGGER_KIND_LABELS[k]}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="mb-3">
          <label htmlFor="trigger-amount" className={labelClass} style={labelStyle}>
            Amount to sell ({sellToken.symbol})
          </label>
          <input
            id="trigger-amount"
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={blockNegativeKey}
            placeholder="1000000"
            min="0"
            max={MAX_SELL_TOWELI}
            aria-invalid={amountExceedsCap}
            className={inputClass}
            style={{
              ...inputStyle,
              border: amountExceedsCap ? '1px solid rgba(239,68,68,0.65)' : inputStyle.border,
            }}
          />
          {amountExceedsCap && (
            <p role="alert" className="mt-1 text-[10px] text-red-300">
              Max {MAX_SELL_TOWELI.toLocaleString()} {sellToken.symbol} per order.
            </p>
          )}
        </div>

        {showStop && (
          <div className="mb-3">
            <label htmlFor="trigger-stop" className={labelClass} style={labelStyle}>
              Stop price (WETH per {sellToken.symbol}) — sell if it falls to this
            </label>
            <input
              id="trigger-stop"
              type="number"
              inputMode="decimal"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              onKeyDown={blockNegativeKey}
              placeholder="0.00000003"
              min="0"
              className={inputClass}
              style={inputStyle}
            />
          </div>
        )}

        {showTarget && (
          <div className="mb-3">
            <label htmlFor="trigger-target" className={labelClass} style={labelStyle}>
              Target price (WETH per {sellToken.symbol}) — sell if it rises to this
            </label>
            <input
              id="trigger-target"
              type="number"
              inputMode="decimal"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
              onKeyDown={blockNegativeKey}
              placeholder="0.00000009"
              min="0"
              className={inputClass}
              style={inputStyle}
            />
          </div>
        )}

        {showTrail && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label htmlFor="trigger-ref" className={labelClass} style={labelStyle}>
                Trail starts from
              </label>
              <input
                id="trigger-ref"
                type="number"
                inputMode="decimal"
                value={referencePrice}
                onChange={(e) => setReferencePrice(e.target.value)}
                onKeyDown={blockNegativeKey}
                placeholder="0.00000006"
                min="0"
                className={inputClass}
                style={inputStyle}
              />
            </div>
            <div>
              <label htmlFor="trigger-trail" className={labelClass} style={labelStyle}>
                Trail ({MIN_TRAIL_BPS / 100}–{MAX_TRAIL_BPS / 100}%)
              </label>
              <input
                id="trigger-trail"
                type="number"
                inputMode="decimal"
                value={trailPct}
                onChange={(e) => setTrailPct(e.target.value)}
                onKeyDown={blockNegativeKey}
                min={MIN_TRAIL_BPS / 100}
                max={MAX_TRAIL_BPS / 100}
                className={inputClass}
                style={inputStyle}
              />
            </div>
            {derivedTrail !== null && (
              <p className="col-span-2 text-[10px] text-white/70">
                Stop sits at <span className="font-mono">{formatPrice(derivedTrail)}</span> WETH today. It only
                moves up if something holds the high-water mark between now and the fill.
              </p>
            )}
          </div>
        )}

        {/* Tolerances */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label htmlFor="trigger-slippage" className={labelClass} style={labelStyle}>
              Max slippage
            </label>
            <select
              id="trigger-slippage"
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value))}
              className="w-full font-mono text-[13px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg"
              style={inputStyle}
            >
              {SLIPPAGE_PRESETS_BPS.map((bps) => (
                <option key={bps} value={bps} style={{ background: '#0d1530' }}>
                  {bps / 100}%
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="trigger-staleness" className={labelClass} style={labelStyle}>
              Refuse prices older than
            </label>
            <select
              id="trigger-staleness"
              value={stalenessIdx}
              onChange={(e) => setStalenessIdx(Number(e.target.value))}
              className="w-full font-mono text-[13px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg"
              style={inputStyle}
            >
              {STALENESS_OPTIONS.map((opt, i) => (
                <option key={opt.label} value={i} style={{ background: '#0d1530' }}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Plan preview */}
        {amount && (showStop ? stopPrice : true) && (
          <div
            className="mb-3 px-3 py-2.5 rounded-lg text-[11px]"
            style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid var(--color-stan-40)' }}
          >
            {plan.valid ? (
              <>
                {plan.legs.map((leg, i) => (
                  <div key={i} className={i > 0 ? 'mt-2 pt-2' : ''} style={i > 0 ? { borderTop: '1px solid rgba(255,255,255,0.12)' } : undefined}>
                    <div className="flex justify-between">
                      <span className="text-white/80">
                        {leg.direction === 'falls-to' ? 'Fires if price falls to' : 'Fires if price rises to'}
                      </span>
                      <span className="text-white font-mono">{formatPrice(leg.triggerPrice)}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-white/80">Minimum received</span>
                      <span className="text-white font-mono">
                        {formatTokenAmountGrouped(formatUnits(leg.buyAmount, 18))} WETH
                      </span>
                    </div>
                  </div>
                ))}
                {plan.doubleFillRisk && (
                  <p className="mt-2 text-amber-200 leading-snug">
                    Both legs would be live at once. Nothing cancels the loser when the winner fills, so an OCO
                    is only an OCO once an executor holds both legs.
                  </p>
                )}
              </>
            ) : (
              <p className="text-amber-300">{plan.error}</p>
            )}
          </div>
        )}

        {/* Fee row */}
        <div className="mb-3">
          <div className="flex justify-between text-[11px]">
            <span className="text-white">{trigger.fee.label}</span>
            <span className="font-mono text-white">{trigger.fee.value}</span>
          </div>
          <p className="mt-0.5 text-[10px] text-white/70" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
            {trigger.fee.note}
          </p>
        </div>

        {/* Arm state — the load-bearing element on this panel. */}
        <div
          className="mb-3 px-3 py-2.5 rounded-lg text-[11px]"
          style={
            trigger.arm.armed
              ? { background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.35)' }
              : { background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.40)' }
          }
        >
          <p className={trigger.arm.armed ? 'text-emerald-200' : 'text-amber-200'}>
            <strong>{trigger.arm.statusLabel}.</strong> {trigger.arm.statusDetail}
          </p>
          {trigger.arm.blockers.length > 0 && (
            <ul className="mt-1.5 space-y-1 text-white/80">
              {trigger.arm.blockers.map((b) => (
                <li key={b.code} className="leading-snug">
                  — {b.message}
                </li>
              ))}
            </ul>
          )}
          {trigger.arm.path === 'keeper' && (
            <>
              <button
                type="button"
                onClick={() => setShowKeeperDetail((v) => !v)}
                className="mt-1.5 text-[10px] text-white/60 hover:text-white/90 underline underline-offset-2"
              >
                {showKeeperDetail ? 'Hide what the keeper must provide' : 'What would have to exist for this to fire?'}
              </button>
              {showKeeperDetail && (
                <ul className="mt-1.5 space-y-1 text-white/70 text-[10px]">
                  {KEEPER_REQUIREMENTS.map((r) => (
                    <li key={r} className="leading-snug">
                      — {r}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* Action */}
        {!isConnected ? (
          <ConnectButton.Custom>
            {({ openConnectModal, mounted }) => (
              <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                <button onClick={openConnectModal} className="btn-primary w-full py-3 text-[13px]">
                  Connect Wallet
                </button>
              </div>
            )}
          </ConnectButton.Custom>
        ) : trigger.isChecking ? (
          <p className="text-white/60 text-[11px] text-center py-2">Checking wallet type…</p>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
            className="btn-primary w-full py-3 min-h-[44px] text-[13px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {trigger.isSubmitting
              ? 'Registering…'
              : trigger.arm.armed
                ? `Arm ${TRIGGER_KIND_LABELS[kind].toLowerCase()}`
                : 'Cannot be armed'}
          </button>
        )}
      </div>
    </div>
  );
}
