import { useMemo, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import {
  LAUNCH_ERROR_COPY,
  applySlippage,
  buyBlockedReason,
  decimalCommaToPoint,
  formatSol,
  formatTokenAmount,
  parseDecimalToBaseUnits,
  quoteBuyOnCurve,
  quoteSellOnCurve,
  sellBlockedReason,
  type CurveAccount,
  type LaunchState,
} from '../../../lib/launcher/solana/curve';
import { Card, Field, ImpactRows, Notice, Row, SlippagePicker } from './ui';
import { DEFAULT_SLIPPAGE_BPS, TOGGLE_CLS, feeSplitLabel, inputCls, inputStyle } from './uiFormat';
import { TxFlowView } from './TxFlowView';
import { YourHolding } from './YourHolding';
import type { Fact } from './facts';
import { WalletNeeded } from './WalletNeeded';
import { useReturnFocus, useTxFlow, type OnSent, type OnSettled } from './useTxFlow';
import type { ActionAvailability, OpenGate, WriteApi, WriteRpc } from './ports';
import type { CurveSignerState } from './useCurveSigner';

type Side = 'buy' | 'sell';

export interface CurveTradePanelProps {
  api: WriteApi;
  rpc: WriteRpc;
  gate: OpenGate;
  launch: LaunchState;
  curve: CurveAccount;
  mint: PublicKey;
  /** The mint's decimals, read from the mint. `null` = raw base units, never an assumed 9. */
  decimals: number | null;
  /** The curve account's rent floor. `null` = unread, and then no sell is offered. */
  rentFloor: bigint | null;
  actions: ActionAvailability;
  signerState: CurveSignerState;
  onSettled: OnSettled;
  /** The transaction is about to be sent: the page writes its "may still land" note. */
  onSent?: OnSent;
  /** The connected wallet's tokens of this mint, for the sell side. `null` while reading. */
  walletHolding?: Fact<bigint> | null;
}

/**
 * Buy and sell on a live curve. The quote shown is the program's own arithmetic
 * (curve/math.ts); the transaction is built and test-run by the write layer, and
 * the review shows what that transaction carries.
 */
export function CurveTradePanel({
  api,
  rpc,
  gate,
  launch,
  curve,
  mint,
  decimals,
  rentFloor,
  actions,
  signerState,
  onSettled,
  onSent,
  walletHolding,
}: CurveTradePanelProps) {
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);
  const flow = useTxFlow(api, rpc, onSettled, onSent);
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flow.state.step);
  const c = curve.curve;

  // Paused stops buys only; sells are open on chain by design, so they stay open here.
  const buyReason = buyBlockedReason(launch.phase, gate.paused || launch.paused === true);
  const sellReason = sellBlockedReason(launch.phase);
  const allowed = side === 'buy' ? actions.buy : actions.sell;
  const reasonCopy =
    side === 'buy'
      ? buyReason
        ? LAUNCH_ERROR_COPY[buyReason]
        : allowed
          ? null
          : 'Buying is not available right now.'
      : sellReason
        ? LAUNCH_ERROR_COPY[sellReason]
        : !allowed
          ? 'Selling is not available right now.'
          : rentFloor === null
            ? "The curve's rent floor could not be read, so a sell cannot be checked. Try again shortly."
            : null;

  const raw = side === 'buy' ? parseDecimalToBaseUnits(amount, 9) : parseDecimalToBaseUnits(amount, decimals ?? 0);

  const quote = useMemo(() => {
    if (reasonCopy || raw === null || raw === 0n) return null;
    if (side === 'buy') {
      const q = quoteBuyOnCurve(c, raw);
      return q.ok ? ({ side: 'buy', ...q.value } as const) : ({ side: 'error', code: q.error } as const);
    }
    const q = quoteSellOnCurve(
      c,
      raw,
      0n,
      rentFloor === null ? undefined : { curveAccountLamports: curve.lamports, rentExemptLamports: rentFloor },
    );
    return q.ok ? ({ side: 'sell', ...q.value } as const) : ({ side: 'error', code: q.error } as const);
  }, [reasonCopy, raw, side, c, rentFloor, curve.lamports]);

  const tok = (v: bigint) => {
    const f = formatTokenAmount(v, decimals);
    return f.isBaseUnits ? `${f.text} (base units)` : f.text;
  };
  const split = feeSplitLabel(c.creatorFeeShareBps);
  const signer = signerState.kind === 'ready' ? signerState.signer : null;
  const canReview =
    !!signer && !reasonCopy && slippageBps !== null && (quote?.side === 'buy' || quote?.side === 'sell') && !flow.locked;

  const review = () => {
    if (!signer || raw === null || slippageBps === null) return;
    if (side === 'buy') {
      const build = () =>
        api.prepareCurveBuy(rpc, gate, { trader: signer.publicKey, mint, curve, lamportsIn: raw, slippageBps });
      void flow.prepare(build, { repeatable: true });
    } else if (rentFloor !== null) {
      const build = () =>
        api.prepareCurveSell(rpc, gate, {
          trader: signer.publicKey,
          mint,
          curve,
          curveRentFloor: rentFloor,
          tokensIn: raw,
          slippageBps,
        });
      void flow.prepare(build, { repeatable: true });
    }
  };

  return (
    <Card title="Trade on the curve" testId="curve-trade-panel" headingRef={headingRef}>
      {flow.state.step !== 'idle' ? (
        <TxFlowView flow={flow} api={api} cluster={gate.cfg.cluster} decimals={decimals} signer={signer} />
      ) : (
        <>
          <div className="flex gap-1.5 mb-3" role="group" aria-label="Buy or sell">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSide(s);
                  setAmount('');
                }}
                aria-pressed={side === s}
                className={`${TOGGLE_CLS} font-medium capitalize`}
                style={{
                  background: side === s ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                  border: side === s ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {reasonCopy && <Notice tone="warn">{reasonCopy}</Notice>}

          <Field
            label={side === 'buy' ? 'Spend at most (SOL)' : decimals === null ? 'Sell (token base units)' : 'Sell (tokens)'}
            hint={
              side === 'buy'
                ? 'The trade fee comes out of this amount. The last buy of a launch uses only what the curve can take.'
                : decimals === null
                  ? "The token's decimals could not be read, so this is in raw base units."
                  : undefined
            }
            error={amount.trim() !== '' && raw === null ? 'That is not an amount this token can hold.' : null}
          >
            {(a11y) => (
              <input
                className={`${inputCls} disabled:opacity-50`}
                style={inputStyle}
                value={amount}
                // A comma typed on a phone keypad with no "." is the decimal point.
                onChange={(e) => setAmount(decimalCommaToPoint(e.target.value, amount))}
                placeholder="0.0"
                inputMode="decimal"
                spellCheck={false}
                disabled={!!reasonCopy}
                {...a11y}
              />
            )}
          </Field>
          {side === 'sell' && signer && walletHolding !== undefined && (
            <YourHolding holding={walletHolding} decimals={decimals} onPick={setAmount} disabled={!!reasonCopy} />
          )}

          <SlippagePicker valueBps={slippageBps} onChange={setSlippageBps} disabled={!!reasonCopy} />

          {quote?.side === 'error' && <Notice tone="warn">{LAUNCH_ERROR_COPY[quote.code]}</Notice>}
          {quote?.side === 'buy' && (
            <div className="space-y-1.5 pt-1">
              {quote.capped && raw !== null && (
                <Notice tone="warn">
                  This buy fills the curve: only {formatSol(quote.lamportsIn)} of your {formatSol(raw)} SOL is used. The
                  rest never leaves your wallet.
                </Notice>
              )}
              <Row label="You pay (at most)" value={`${formatSol(quote.lamportsIn)} SOL`} />
              <Row label="Trade fee (inside that amount)" value={`${formatSol(quote.feeLamports)} SOL`} />
              {split && <Row label="Fee goes to" value={split} mono={false} />}
              <Row label="You receive (quoted)" value={tok(quote.tokensOut)} />
              <Row
                label="You receive at least"
                value={(() => {
                  const f = slippageBps === null ? null : applySlippage(quote.tokensOut, slippageBps);
                  return f === null ? 'set a tolerance' : tok(f);
                })()}
              />
              <ImpactRows bps={api.priceImpactBps(c, 'buy', quote.lamportsToCurve, quote.tokensOut)} />
            </div>
          )}
          {quote?.side === 'sell' && raw !== null && (
            <div className="space-y-1.5 pt-1">
              <Row label="You receive (quoted)" value={`${formatSol(quote.lamportsOut)} SOL`} />
              <Row label="Fee" value={`${formatSol(quote.feeLamports)} SOL`} />
              {split && <Row label="Fee goes to" value={split} mono={false} />}
              <Row
                label="You receive at least"
                value={(() => {
                  const f = slippageBps === null ? null : applySlippage(quote.lamportsOut, slippageBps);
                  return f === null ? 'set a tolerance' : `${formatSol(f)} SOL`;
                })()}
              />
              <ImpactRows bps={api.priceImpactBps(c, 'sell', raw, quote.grossLamports)} />
            </div>
          )}

          <div className="pt-2">
            <WalletNeeded state={signerState} />
          </div>
          <button
            ref={reviewRef}
            type="button"
            className="btn-primary w-full py-2.5 text-[13px] mt-2 disabled:opacity-60"
            disabled={!canReview}
            onClick={review}
          >
            Review {side}
          </button>
          <p className="text-white/35 text-[10px] leading-relaxed">
            Review builds the transaction and test-runs it first. Nothing is signed until you press Sign in wallet on the
            next step.
          </p>
        </>
      )}
    </Card>
  );
}
