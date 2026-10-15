import { useMemo, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import {
  WSOL_MINT,
  applySlippage,
  decimalCommaToPoint,
  formatSol,
  formatTokenAmount,
  parseDecimalToBaseUnits,
} from '../../../lib/launcher/solana/curve';
import { quoteOwnPool } from '../../../lib/solana/cpswap/read';
import { CardArt } from '../../ui/CardArt';
import { Card, Field, ImpactRows, Notice, Row, SlippagePicker } from './ui';
import { DEFAULT_SLIPPAGE_BPS, TOGGLE_CLS, fractionToBps, inputCls, inputStyle } from './uiFormat';
import { PoolCreatorFeeRow, TxFlowView } from './TxFlowView';
import { YourHolding } from './YourHolding';
import type { Fact } from './facts';
import { WalletNeeded } from './WalletNeeded';
import { useReturnFocus, useTxFlow, type OnSent, type OnSettled } from './useTxFlow';
import type { ActionAvailability, LaunchPoolRead, OpenGate, WriteApi, WriteRpc } from './ports';
import type { CurveSignerState } from './useCurveSigner';

type Side = 'buy' | 'sell';

/** Why no swap is offered, for every answer that is not a checked, open pool. */
function poolProblem(pool: Exclude<LaunchPoolRead, { kind: 'ok' }>): string {
  switch (pool.kind) {
    case 'unreadable':
      return `The pool could not be read, so no swap is offered: ${pool.detail}`;
    case 'absent':
      return 'No pool was found at the address this launch recorded, so no swap is offered.';
    case 'undecodable':
    case 'not-a-pool':
      return 'The account at this launch’s pool address is not a pool, so no swap is offered.';
    case 'not-graduated':
      return 'This launch has not graduated, so it has no pool yet.';
    case 'mismatch':
      return `The pool does not match what graduation creates (${pool.detail}), so no swap is offered.`;
    case 'closed-to-swaps':
      return `The pool is not taking swaps right now: ${pool.detail}`;
  }
}

/** cp-swap fee rates are parts per million. 2500 → "0.25%". */
const ppmPercent = (ppm: bigint) => `${(Number(ppm) / 10_000).toFixed(2)}%`;

export interface PoolSwapPanelProps {
  api: WriteApi;
  rpc: WriteRpc;
  gate: OpenGate;
  mint: PublicKey;
  /** The launch's OWN pool, as recorded on its curve and checked field by field. `null` while loading. */
  pool: LaunchPoolRead | null;
  decimals: number | null;
  actions: ActionAvailability;
  signerState: CurveSignerState;
  onSettled: OnSettled;
  /** The transaction is about to be sent: the page writes its "may still land" note. */
  onSent?: OnSent;
  /** The connected wallet's tokens of this mint, for the sell side. `null` while reading. */
  walletHolding?: Fact<bigint> | null;
}

/**
 * Trading a graduated launch in its own pool. The pool is the one the curve
 * recorded at graduation, never the pool program's standard address for the pair,
 * which anyone could have created first.
 */
export function PoolSwapPanel({
  api,
  rpc,
  gate,
  mint,
  pool,
  decimals,
  actions,
  signerState,
  onSettled,
  onSent,
  walletHolding,
}: PoolSwapPanelProps) {
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);
  const flow = useTxFlow(api, rpc, onSettled, onSent);
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flow.state.step);
  const signer = signerState.kind === 'ready' ? signerState.signer : null;
  const p = pool?.kind === 'ok' ? pool.value : null;

  const raw = side === 'buy' ? parseDecimalToBaseUnits(amount, 9) : parseDecimalToBaseUnits(amount, decimals ?? 0);
  const quote = useMemo(() => {
    if (!p || raw === null || raw === 0n) return null;
    // The pool opens by the CHAIN's clock, which readLaunchPool read with the pool
    // (and already checked the pool is open by). Never the viewer's clock, which can
    // be behind the chain right after graduation.
    const nowSecs = p.chainTime != null ? Number(p.chainTime) : Number(p.snapshot.pool.openTime);
    return quoteOwnPool(p.snapshot, p.ammConfig, (side === 'buy' ? WSOL_MINT : mint).toBase58(), raw, nowSecs);
  }, [p, raw, side, mint]);

  const tok = (v: bigint) => {
    const f = formatTokenAmount(v, decimals);
    return f.isBaseUnits ? `${f.text} (base units)` : f.text;
  };
  const out = (v: bigint) => (side === 'buy' ? tok(v) : `${formatSol(v)} SOL`);
  const floor = quote && slippageBps !== null ? applySlippage(quote.outAmount, slippageBps) : null;

  if (pool === null) {
    return (
      <Card title="Trade in the pool" testId="pool-swap-panel" art={<CardArt pageId="curve-launch" idx={22} />}>
        <Notice>Reading the pool…</Notice>
      </Card>
    );
  }
  if (pool.kind !== 'ok' || !p) {
    return (
      <Card title="Trade in the pool" testId="pool-swap-panel" art={<CardArt pageId="curve-launch" idx={22} />}>
        <Notice tone="warn">{pool.kind === 'ok' ? 'The pool could not be read.' : poolProblem(pool)}</Notice>
      </Card>
    );
  }

  const canReview =
    !!signer && actions.poolSwap && !!quote && floor !== null && floor > 0n && slippageBps !== null && !flow.locked;
  // Pool swaps switched off: the form stays visible (so the numbers can be read) but
  // nothing in it can be used, the same as the curve panel.
  const off = !actions.poolSwap;
  // The pool's own creator fee: cp-swap charges it on top of the trade fee, when the
  // pool has it switched on and its fee settings set a rate.
  const creatorPpm = p.snapshot.pool.enableCreatorFee ? p.ammConfig.creatorFeeRate : 0n;

  return (
    <Card title="Trade in the pool" testId="pool-swap-panel" headingRef={headingRef} art={<CardArt pageId="curve-launch" idx={22} />}>
      {flow.state.step !== 'idle' ? (
        <TxFlowView flow={flow} api={api} cluster={gate.cfg.cluster} decimals={decimals} signer={signer} />
      ) : (
        <>
          <Row label="Pool" value={p.address.toBase58()} />
          <Row label="Pool fee" value={ppmPercent(p.ammConfig.tradeFeeRate)} />
          {creatorPpm > 0n && <Row label="Creator fee (on top of the pool fee)" value={ppmPercent(creatorPpm)} />}
          {off && <Notice tone="warn">Pool swaps are not available right now.</Notice>}
          <div className="flex gap-1.5 my-3" role="group" aria-label="Buy or sell in the pool">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSide(s);
                  setAmount('');
                }}
                aria-pressed={side === s}
                disabled={off}
                className={`${TOGGLE_CLS} font-medium capitalize disabled:opacity-50`}
                style={{
                  background: side === s ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                  border: side === s ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <Field
            label={side === 'buy' ? 'Pay (SOL)' : decimals === null ? 'Sell (token base units)' : 'Sell (tokens)'}
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
                disabled={off}
                {...a11y}
              />
            )}
          </Field>
          {side === 'sell' && signer && walletHolding !== undefined && (
            <YourHolding holding={walletHolding} decimals={decimals} onPick={setAmount} disabled={off} />
          )}
          <SlippagePicker valueBps={slippageBps} onChange={setSlippageBps} disabled={off} />
          {raw !== null && raw > 0n && !quote && (
            <Notice tone="warn">The pool would refuse this swap right now (closed to swaps, not open yet, or too large).</Notice>
          )}
          {quote && (
            <div className="space-y-1.5">
              <Row label="You receive (quoted)" value={out(quote.outAmount)} />
              <Row label="You receive at least" value={floor === null ? 'set a tolerance' : out(floor)} />
              <Row
                label="Pool fee (inside what you pay)"
                value={side === 'buy' ? `${formatSol(quote.result.tradeFee)} SOL` : tok(quote.result.tradeFee)}
              />
              <PoolCreatorFeeRow quote={quote} buying={side === 'buy'} sol={(v) => `${formatSol(v)} SOL`} tok={tok} />
              <ImpactRows bps={fractionToBps(quote.priceImpact)} />
              {floor === 0n && (
                <Notice tone="warn">
                  This amount is too small: after the pool fee and your price tolerance you would receive nothing. Enter
                  a larger amount.
                </Notice>
              )}
              <p className="text-white/35 text-[10px]">
                SOL is wrapped for the swap and unwrapped after it, inside the same transaction.
              </p>
            </div>
          )}
          <WalletNeeded state={signerState} />
          <button
            ref={reviewRef}
            type="button"
            className="btn-primary w-full py-2.5 text-[13px] mt-2 disabled:opacity-60"
            disabled={!canReview}
            onClick={() =>
              signer &&
              raw !== null &&
              slippageBps !== null &&
              void flow.prepare(
                () => api.preparePoolSwap(rpc, gate, { owner: signer.publicKey, mint, pool: p, side, amountIn: raw, slippageBps }),
                { repeatable: true },
              )
            }
          >
            Review pool {side}
          </button>
        </>
      )}
    </Card>
  );
}
