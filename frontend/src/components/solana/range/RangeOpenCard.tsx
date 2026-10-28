import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { depositFrom, planFromCeiling, priceAtSqrt, type Pair, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import type { RangePool } from '../../../lib/solana/clmm/read';
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
import { marketGap, type MarketGap } from '../../../lib/solana/clmm/priceCheck';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { RangeReviewDisclosure, RangeRisks } from './RangeRisks';
import { RangePickFields } from './RangePickFields';
import { pickProblem, useRangePick } from './rangePick';
import { bothAmounts, coinAmount, priceNumberText, priceText, tokenAmount } from './rangeText';
import { useFlowReports } from './useRangeData';

const TOLERANCE_HINT =
  'Your deposit takes at most this much more of either coin than shown. If the price moves enough to need more before it runs, it is refused and only the network fee is spent.';

/**
 * Pick a range and put liquidity in it. The presets and the two prices give a range of
 * usable ticks (rangeMath.ts), from this pool's price, shown beside the market's. The typed
 * amount of ONE coin is the most the deposit takes of it: a fixed liquidity is planned from
 * it less the tolerance, both coins capped. Review reads the pool again and test-runs it.
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
}) {
  const { pool, pair } = p;
  const v = pool.pool;
  const pick = useRangePick(pair, v);
  const [tolerance, setTolerance] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);
  // While a deposit is under review or on its way, the range and the amount it was built from stay put.
  const [busy, setBusy] = useState(false);
  const onBusy = (b: boolean) => {
    setBusy(b);
    p.onBusy(b);
  };

  const now = priceAtSqrt(pair, v.sqrtPriceX64);
  // The market's price beside this pool's own, read when the pool is picked (Review asks again, fresh).
  // Kept with the pool and price it was read for, so a stale answer is never shown for another.
  const gapKey = `${v.address}:${v.sqrtPriceX64}`;
  const [read, setRead] = useState<{ key: string; gap: MarketGap } | null>(null);
  const gap = read?.key === gapKey ? read.gap : null;
  const reads = p.reads;
  useEffect(() => {
    let live = true;
    const pr = pair;
    const ask = (mint: string, decimals: number) =>
      reads.outsidePrice(mint, decimals).catch((e: unknown): OutsidePrice => ({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }));
    void Promise.all([ask(pr.tokenMint, pr.tokenDecimals), pr.quote.native ? Promise.resolve(null) : ask(pr.quote.mint, pr.quote.decimals)]).then(([token, coin]) => {
      if (live) setRead({ key: `${v.address}:${v.sqrtPriceX64}`, gap: marketGap(pr, v.sqrtPriceX64, token, coin) });
    });
    return () => {
      live = false;
    };
  }, [reads, pair, v.address, v.sqrtPriceX64]);
  const marketText =
    gap === null
      ? 'reading…'
      : gap.state === 'no-market'
        ? 'none: Jupiter has no route for this pair'
        : gap.state === 'unread'
          ? `could not be read just now (${gap.detail})`
          : priceNumberText(pair, gap.reference);
  const { r, side, amount } = pick;
  // Planned as the builder plans it, so the card and the review show one figure.
  const plan = r && amount !== null && amount > 0n ? depositFrom(pair, v, r, side, planFromCeiling(amount, Number(tolerance ?? 0n))) : null;
  const problemText = pickProblem(pair, pick, plan);

  return (
    <Card title="Pick your range" testId="range-open" art={<CardArt pageId="range-pools" idx={2} />}>
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
      <RangePickFields pair={pair} p={pick} busy={busy} at="this pool’s price" />
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
