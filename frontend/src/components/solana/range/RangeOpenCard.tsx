import { useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve';
import {
  depositFrom,
  holdsNow,
  parsePrice,
  presetRange,
  priceAtSqrt,
  rangeFromPrices,
  rangePrices,
  type Pair,
  type Preset,
  type TickRange,
} from '../../../lib/solana/clmm/rangeMath';
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
import { bothAmounts, coinAmount, priceText, tokenAmount, tokenName, tokenWord } from './rangeText';
import { useFlowReports } from './useRangeData';

const TOLERANCE_HINT =
  'Your deposit takes at most this much more of either coin than shown. If the price moves enough to need more before it runs, it is refused and only the network fee is spent.';

/**
 * Pick a range and put liquidity in it. The presets and the two prices give a range of
 * usable ticks (rangeMath.ts); the amount is of ONE coin and the program works out the
 * other side from it, as the review shows. Press Review and the builder reads the pool
 * again and test-runs the deposit (write/range.ts `prepareRangeOpen`).
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
  const [preset, setPreset] = useState<Preset | null>(null);
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
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
  const range = useMemo(() => {
    if (preset) return presetRange(pair, v, preset);
    const min = parsePrice(minText);
    const max = parsePrice(maxText);
    if (!minText && !maxText) return null;
    if (!min || !max) return 'unreadable-price' as const;
    return rangeFromPrices(pair, min, max);
  }, [preset, minText, maxText, pair, v]);
  const r: TickRange | null = range && typeof range === 'object' ? range : null;
  const holds = r ? holdsNow(pair, v, r) : null;
  const side = holds === 'token-only' ? 'token' : holds === 'coin-only' ? 'coin' : chosenSide;
  const decimals = side === 'token' ? pair.tokenDecimals : pair.quoteDecimals;
  const amount = amountText ? parseDecimalToBaseUnits(amountText, decimals) : null;
  const plan = r && amount !== null && amount > 0n ? depositFrom(pair, v, r, side, amount) : null;

  const pick = (to: Preset) => {
    const pr = presetRange(pair, v, to);
    setPreset(to);
    if (typeof pr === 'object') {
      const prices = rangePrices(pair, pr);
      setMinText(formatSolPrice(priceNumber(prices.min)));
      setMaxText(formatSolPrice(priceNumber(prices.max)));
    }
  };
  const PRESETS: { id: Preset; label: string }[] = [
    { id: 'close', label: 'Close to today’s price' },
    { id: 'wide', label: 'Wide' },
    { id: 'token-above', label: `${tokenName(pair)} only, above today’s price` },
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
      ? `This range is above today’s price, so it holds ${tokenWord(pair)} only. It sells ${tokenWord(pair)} for ${pair.quote.symbol} as the price rises through it, and earns nothing until the price reaches it.`
      : holds === 'coin-only'
        ? `This range is below today’s price, so it holds ${pair.quote.symbol} only. It buys ${tokenWord(pair)} as the price falls through it, and earns nothing until the price reaches it.`
        : holds === 'both'
          ? 'Today’s price is inside this range, so it holds both coins and earns from the first swap.'
          : null;

  return (
    <Card title="Pick your range" testId="range-open" art={<CardArt pageId="range-pools" idx={2} />}>
      <Row label="Price now" value={priceText(pair, now)} mono={false} />
      <fieldset disabled={busy} className="space-y-2 min-w-0 disabled:opacity-70">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Range presets">
        {PRESETS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={preset === x.id}
            className={`min-h-[44px] px-3 rounded-lg border text-[12px] ${preset === x.id ? 'border-emerald-300/70 bg-emerald-400/15 text-white' : 'border-white/15 bg-white/5 text-white/80 hover:text-white'}`}
            onClick={() => pick(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-white/70 text-[11px] mb-1">Lowest price ({pair.quote.symbol} per {tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair)})</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            className="w-full min-h-[44px] rounded-lg bg-black/40 border border-white/15 px-3 text-white text-[14px]"
            value={minText}
            onChange={(e) => {
              setPreset(null);
              setMinText(e.target.value);
            }}
          />
        </label>
        <label className="block">
          <span className="block text-white/70 text-[11px] mb-1">Highest price ({pair.quote.symbol} per {tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair)})</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            className="w-full min-h-[44px] rounded-lg bg-black/40 border border-white/15 px-3 text-white text-[14px]"
            value={maxText}
            onChange={(e) => {
              setPreset(null);
              setMaxText(e.target.value);
            }}
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
                  className={`min-h-[44px] px-3 rounded-lg border text-[12px] ${side === s ? 'border-emerald-300/70 bg-emerald-400/15 text-white' : 'border-white/15 bg-white/5 text-white/80'}`}
                  onClick={() => setChosenSide(s)}
                >
                  {s === 'token' ? `Amount in ${tokenWord(pair)}` : `Amount in ${pair.quote.symbol}`}
                </button>
              ))}
            </div>
          )}
          <label className="block">
            <span className="block text-white/70 text-[11px] mb-1">How much {side === 'token' ? tokenWord(pair) : pair.quote.symbol} to put in</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              className="w-full min-h-[44px] rounded-lg bg-black/40 border border-white/15 px-3 text-white text-[14px]"
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
      {/* Said beside every deposit, never folded away. */}
      <Notice tone="warn">Out of range, a position earns nothing. {plan ? `This one is worth ${tokenAmount(pair, pair.tokenIsToken0 ? plan.amount0 : plan.amount1)} and ${coinAmount(pair, pair.tokenIsToken0 ? plan.amount1 : plan.amount0)} at today’s price.` : ''}</Notice>
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
