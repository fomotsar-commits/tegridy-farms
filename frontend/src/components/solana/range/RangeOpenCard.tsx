import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve';
import { depositFrom, holdsNow, planFromCeiling, priceAtSqrt, rangePrices, type Pair, type Preset, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import type { RangePool } from '../../../lib/solana/clmm/read';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { priceNumber } from '../../../lib/solana/clmm/rangeMath';
import { CardArt } from '../../ui/CardArt';
import { Card, Notice, Row, SlippagePicker } from '../curve/ui';
import { DEFAULT_SLIPPAGE_BPS } from '../curve/uiFormat';
import { TxFlowView } from '../curve/TxFlowView';
import { WalletNeeded } from '../curve/WalletNeeded';
import { useReturnFocus, useTxFlow } from '../curve/useTxFlow';
import type { CurveSignerState } from '../curve/useCurveSigner';
import type { PendingTradesState } from '../curve/usePendingTrades';
import type { CurveWriteConfig, RangeWriteApi, WriteRpc } from '../curve/ports';
import type { RangeOpenReads } from '../../../lib/launcher/solana/write/range';
import type { MarketGap } from '../../../lib/solana/clmm/priceCheck';
import { RangeReviewDisclosure, RangeRisks } from './RangeRisks';
import { bothAmounts, coinAmount, priceNumberText, priceText, tokenAmount, tokenName, tokenWord } from './rangeText';
import { useFlowReports } from './useRangeData';
import { RangeStrip } from './RangeStrip';
import { FIELD_CLS, FIELD_LABEL_CLS, chipCls } from './editorialUi';
import type { RangePick } from './rangePick';

const TOLERANCE_HINT =
  'Your deposit takes at most this much more of either coin than shown. If the price moves enough to need more before it runs, it is refused and only the network fee is spent.';

/**
 * Pick a range and put liquidity in it. The presets, the two prices and the chart's edges
 * (card 03, through `pick`) give a range of usable ticks (rangeMath.ts), from this pool's
 * price, shown beside the market's (`gap`). The typed amount of ONE coin is the most the
 * deposit takes of it: a liquidity is planned from it less the tolerance, both coins capped.
 * Review reads the pool again and test-runs it.
 */
export function RangeOpenCard(p: {
  pool: RangePool;
  pair: Pair;
  canOpen: boolean;
  why: string | null;
  write: { api: RangeWriteApi; cfg: CurveWriteConfig } | null;
  rpc: WriteRpc;
  programId: PublicKey;
  reads: RangeOpenReads;
  signerState: CurveSignerState;
  pending: PendingTradesState;
  held: boolean;
  onBusy: (busy: boolean) => void;
  onFinished: () => void;
  pick: RangePick;
  /** This pool's price against the market's, read once per pool and price; null while reading. */
  gap: MarketGap | null;
}) {
  const { pool, pair, gap } = p;
  const v = pool.pool;
  const [chosenSide, setChosenSide] = useState<'token' | 'coin'>('token');
  const [amountText, setAmountText] = useState('');
  const [tolerance, setTolerance] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);
  // While a deposit is under review or on its way, the range and the amount it was built from stay put.
  const [busy, setBusy] = useState(false);
  const onBusy = (b: boolean) => {
    setBusy(b);
    p.onBusy(b);
  };

  const now = priceAtSqrt(pair, v.sqrtPriceX64);
  const marketText =
    gap === null
      ? 'reading…'
      : gap.state === 'no-market'
        ? 'none: Jupiter has no route for this pair'
        : gap.state === 'unread'
          ? `could not be read just now (${gap.detail})`
          : priceNumberText(pair, gap.reference);
  const { preset, minText, maxText, range } = p.pick;
  const r: TickRange | null = range && typeof range === 'object' ? range : null;
  const holds = r ? holdsNow(pair, v, r) : null;
  const side = holds === 'token-only' ? 'token' : holds === 'coin-only' ? 'coin' : chosenSide;
  const decimals = side === 'token' ? pair.tokenDecimals : pair.quoteDecimals;
  const amount = amountText ? parseDecimalToBaseUnits(amountText, decimals) : null;
  // Planned as the builder plans it, so the card and the review show one figure.
  const plan = r && amount !== null && amount > 0n ? depositFrom(pair, v, r, side, planFromCeiling(amount, Number(tolerance ?? 0n))) : null;

  const pick = (to: Preset) => p.pick.pickPreset(to);
  const PRESETS: { id: Preset; label: string }[] = [
    { id: 'close', label: 'Close to this pool’s price' },
    { id: 'wide', label: 'Wide' },
    { id: 'token-above', label: `${tokenName(pair)} only, above this pool’s price` },
    { id: 'coin-below', label: `${pair.quote.symbol} only, below` },
  ];

  const problemText =
    range === 'min-not-below-max'
      ? 'The lowest price must be below the highest.'
      : range === 'unreadable-price'
        ? 'Type each price as a plain number, like 0.0003.'
        : range === 'outside-the-pool'
          ? 'That range reaches past the prices this pool can hold.'
          : amountText && amount === null
            ? `Type an amount of ${side === 'token' ? tokenWord(pair) : pair.quote.symbol} as a plain number.`
            : r && amount !== null && amount > 0n && !plan
              ? 'That amount buys nothing in this range. Try a larger amount.'
              : '';

  const holdsLine =
    holds === 'token-only'
      ? `This range is above this pool’s price, so it holds ${tokenWord(pair)} only. It sells ${tokenWord(pair)} for ${pair.quote.symbol} as the price rises through it, and earns nothing until the price reaches it.`
      : holds === 'coin-only'
        ? `This range is below this pool’s price, so it holds ${pair.quote.symbol} only. It buys ${tokenWord(pair)} as the price falls through it, and earns nothing until the price reaches it.`
        : holds === 'both'
          ? 'This pool’s price is inside this range, so it holds both coins and earns from the first swap.'
          : null;

  return (
    <Card title="Pick your range" testId="range-open" index={4} art={<CardArt pageId="range-pools" idx={2} />}>
      <Row label="This pool’s price now" value={priceText(pair, now)} mono={false} />
      <Row label="Market price (Jupiter)" value={marketText} mono={false} />
      {gap?.state === 'disagrees' && (
        <Notice tone="warn">
          {`This pool’s price is ${Number((Math.abs(gap.diff) * 100).toFixed(1))}% ${gap.diff > 0 ? 'above' : 'below'} the market price. Anyone can open a range pool at any price, and a deposit at a price off the market loses value when trading moves it back. The presets below start from this pool’s price. Review checks again and estimates the loss.`}
        </Notice>
      )}
      {gap?.state === 'no-market' && (
        <Notice tone="warn">Jupiter has no route for this pair, so this pool’s price cannot be checked against a market price. Anyone can open a range pool at any price.</Notice>
      )}
      <RangeStrip
        now={priceNumber(now)}
        market={gap && (gap.state === 'agrees' || gap.state === 'disagrees') ? gap.reference : null}
        lo={r ? priceNumber(rangePrices(pair, r).min) : null}
        hi={r ? priceNumber(rangePrices(pair, r).max) : null}
        words={{
          now: priceText(pair, now),
          market: gap && (gap.state === 'agrees' || gap.state === 'disagrees') ? priceNumberText(pair, gap.reference) : null,
          lo: r ? priceText(pair, rangePrices(pair, r).min) : null,
          hi: r ? priceText(pair, rangePrices(pair, r).max) : null,
          unit: `${pair.quote.symbol} per ${tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair)}`,
        }}
      />
      <fieldset disabled={busy} className="space-y-2 min-w-0 disabled:opacity-70">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Range presets">
        {PRESETS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={preset === x.id}
            className={chipCls(preset === x.id)}
            onClick={() => pick(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className={FIELD_LABEL_CLS}>Lowest price ({pair.quote.symbol} per {tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair)})</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            className={FIELD_CLS}
            value={minText}
            onChange={(e) => p.pick.typeMin(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={FIELD_LABEL_CLS}>Highest price ({pair.quote.symbol} per {tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair)})</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            className={FIELD_CLS}
            value={maxText}
            onChange={(e) => p.pick.typeMax(e.target.value)}
          />
        </label>
      </div>
      {r && (
        <div className="space-y-1.5" data-testid="range-chosen">
          <Row label="Your range" value={`${priceText(pair, rangePrices(pair, r).min)} to ${formatSolPrice(priceNumber(rangePrices(pair, r).max))}`} mono={false} />
          <p className="text-white/45 text-[10px]">Moved to the nearest prices a position in this pool can use.</p>
          {holdsLine && <Notice tone={holds === 'both' ? 'info' : 'warn'}>{holdsLine}</Notice>}
        </div>
      )}
      {r && (
        <>
          {holds === 'both' && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Which coin you type an amount of">
              {(['token', 'coin'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={side === s}
                  className={chipCls(side === s)}
                  onClick={() => setChosenSide(s)}
                >
                  {s === 'token' ? `Amount in ${tokenWord(pair)}` : `Amount in ${pair.quote.symbol}`}
                </button>
              ))}
            </div>
          )}
          <label className="block">
            <span className={FIELD_LABEL_CLS}>How much {side === 'token' ? tokenWord(pair) : pair.quote.symbol} to put in</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              className={FIELD_CLS}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </label>
        </>
      )}
      </fieldset>
      {plan && (
        <div className="space-y-1.5" data-testid="range-plan">
          <Row label="You put in about" value={bothAmounts(pair, plan.amount0, plan.amount1)} mono={false} />
          <p className="text-white/45 text-[10px]">Worked out from the pool as the page read it; read again and test-run when you press Review.</p>
        </div>
      )}
      <p role="alert" className="text-rose-300/90">
        {problemText}
      </p>
      {p.why ? (
        <Notice tone="warn">{p.why}</Notice>
      ) : (
        p.write && r && plan && <OpenFlow {...p} onBusy={onBusy} write={p.write} range={r} side={side} amount={amount!} tolerance={tolerance} setTolerance={setTolerance} />
      )}
      {!p.canOpen && !p.why && <Notice>Amounts here are only worked out: opening a position is not switched on here.</Notice>}
      <RangeRisks />
      {/* Said beside every deposit, never folded away. */}
      <Notice tone="warn">Out of range, a position earns nothing. {plan ? `This one is worth ${tokenAmount(pair, pair.tokenIsToken0 ? plan.amount0 : plan.amount1)} and ${coinAmount(pair, pair.tokenIsToken0 ? plan.amount1 : plan.amount0)} at this pool’s price.` : ''}</Notice>
    </Card>
  );
}

function OpenFlow(p: {
  pool: RangePool;
  pair: Pair;
  canOpen: boolean;
  write: { api: RangeWriteApi; cfg: CurveWriteConfig };
  rpc: WriteRpc;
  programId: PublicKey;
  reads: RangeOpenReads;
  signerState: CurveSignerState;
  pending: PendingTradesState;
  held: boolean;
  onBusy: (busy: boolean) => void;
  onFinished: () => void;
  range: TickRange;
  side: 'token' | 'coin';
  amount: bigint;
  tolerance: bigint | null;
  setTolerance: (v: bigint | null) => void;
}) {
  const { api, cfg } = p.write;
  const flow = useTxFlow(api, p.rpc, p.pending.record, p.pending.sent);
  const { target: reviewRef } = useReturnFocus(flow.state.step);
  const signer = p.signerState.kind === 'ready' ? p.signerState.signer : null;
  useFlowReports(flow.state.step, flow.locked, p.onBusy, p.onFinished);
  const busy = flow.state.step !== 'idle';
  const can = p.canOpen && !!signer && p.tolerance !== null && !p.held && !flow.locked;
  const review = () => {
    if (!signer || p.tolerance === null) return;
    const args = {
      owner: signer.publicKey,
      pool: new PublicKey(p.pool.pool.address),
      tickLower: p.range.tickLower,
      tickUpper: p.range.tickUpper,
      side: p.side,
      amount: p.amount,
      toleranceBps: Number(p.tolerance),
    };
    void flow.prepare(() => api.prepareRangeOpen(p.rpc, cfg, p.programId, p.reads, args), { repeatable: true });
  };
  if (busy) {
    return (
      <TxFlowView
        flow={flow}
        api={api}
        cluster={cfg.cluster}
        decimals={p.pair.tokenDecimals}
        signer={signer}
        preparingText="Reading the pool again and test-running your deposit on the network…"
        extraReview={<RangeReviewDisclosure />}
      />
    );
  }
  return (
    <>
      <SlippagePicker valueBps={p.tolerance} onChange={p.setTolerance} hint={TOLERANCE_HINT} />
      <WalletNeeded state={p.signerState} />
      <button ref={reviewRef} type="button" className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60 disabled:grayscale" disabled={!can} onClick={review}>
        Review: open this position
      </button>
    </>
  );
}
