// The swap form's "VWAP" tab: start an order that buys or sells over a chosen time in slices,
// each sized by when the pair usually trades and sent only while its price is within your
// limit of the pair's 24h average (lib/solana/swap/vwapOrder.ts). The money stays in the
// wallet: each slice is an Instant swap through Jupiter that the wallet approves, so the
// page has to stay open. The runner itself is mounted by the page (useVwapRunner), so the
// order keeps going while another tab of the form is open.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useWallet } from '@solana/wallet-adapter-react';
import { FinePrint } from '../../ui/FinePrint';
import { SolanaConnectButton } from '../SolanaConnectButton';
import { PairAverageLine } from '../PairAverageLine';
import { SiteFeeRow } from '../../swap/SiteFeeRow';
import { toBaseUnits } from '../../../lib/jupiter';
import { amountText } from '../../../lib/solana/receiptRead';
import { SOL_MINT } from '../../../lib/solana';
import type { SolToken } from '../../../lib/solanaTokenList';
import { fetchPairAverage, fetchPairVolumeProfile, sayAs } from '../../../lib/solana/swap/pairAverage';
import {
  VWAP_BANDS_BPS,
  VWAP_DURATIONS_S,
  filledTotals,
  nextAction,
  planOrder,
  readOrder,
  sliceCountsFor,
  type VwapOrder,
  type VwapSlice,
} from '../../../lib/solana/swap/vwapOrder';
import { needsRunner } from '../../../lib/solana/swap/vwapRun';
import { forgetOrder, saveOrder, useVwapOrder, type RunnerWhere } from './useVwapRunner';

/** Kept back from a SOL total for each slice's network fee and a first token account. */
const SOL_KEEP = 10_000_000n;

const DURATION_LABEL: Record<number, string> = { 3_600: '1 hour', 14_400: '4 hours', 43_200: '12 hours', 86_400: '1 day' };
const FIELD = { background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' } as const;
const SELECT = 'bg-black/40 text-white font-mono text-[16px] sm:text-[12px] outline-none rounded-md px-2 py-1.5';
const SELECT_STYLE = { border: '1px solid rgba(255,255,255,0.12)' } as const;
const LABEL_SHADOW = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' } as const;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function acceptAmount(v: string, set: (s: string) => void) {
  const s = v.replace(',', '.');
  if (s === '' || /^\d*\.?\d*$/.test(s)) set(s);
}

/** Whether the person is buying the base coin (paying the quote coin), as the 24h average names them. */
const buyingBase = (payMint: string, buyMint: string) => sayAs(payMint, buyMint)[1] === payMint;

export interface VwapOrderTabProps {
  payToken: SolToken;
  buyToken: SolToken;
  /** The pay coin's balance in base units; null while unread. */
  payBalance: bigint | null;
  feePct: string;
  feeMintSymbol: string | null;
  /** The pair's risk lines, as the other tabs show them. */
  warnings: ReactNode;
  needsAck: boolean;
  ack: boolean;
  setAck: (v: boolean) => void;
  onPickPay: () => void;
  onPickBuy: () => void;
  where: RunnerWhere;
}

export function VwapOrderTab(p: VwapOrderTabProps) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const order = useVwapOrder(wallet);
  if (order) return <OrderView o={order} where={p.where} feePct={p.feePct} feeMintSymbol={p.feeMintSymbol} />;
  return <OrderForm {...p} wallet={wallet} />;
}

function OrderForm(p: VwapOrderTabProps & { wallet: string | null }) {
  const { payToken, buyToken } = p;
  const [amount, setAmount] = useState('');
  const [durationS, setDurationS] = useState<number>(14_400);
  const [count, setCount] = useState(8);
  const [bandBps, setBandBps] = useState(100);
  const [starting, setStarting] = useState(false);

  const counts = sliceCountsFor(durationS);
  const slices = counts.includes(count) ? count : counts[counts.length - 1]!;
  const same = payToken.mint === buyToken.mint;
  const total = useMemo(() => {
    const b = toBaseUnits(amount, payToken.decimals);
    return b ? BigInt(b) : null;
  }, [amount, payToken.decimals]);
  const keep = payToken.mint === SOL_MINT ? SOL_KEEP : 0n;
  const short = total !== null && p.payBalance !== null && total + keep > p.payBalance;
  const tooSmall = total !== null && total < BigInt(slices);
  const buying = buyingBase(payToken.mint, buyToken.mint);
  const gapMin = Math.round(durationS / slices / 60);

  async function start() {
    if (!p.wallet || total === null || same || short || tooSmall || (p.needsAck && !p.ack)) return;
    const existing = readOrder(p.wallet);
    if (needsRunner(existing)) {
      toast.error('Not started', { description: 'This wallet already has a VWAP order running.' });
      return;
    }
    setStarting(true);
    try {
      const avg = await fetchPairAverage(payToken.mint, buyToken.mint).catch(() => ({ kind: 'unread' as const }));
      if (avg.kind !== 'ok') {
        const why =
          avg.kind === 'thin' ? 'Too little trading in the last 24 hours to work out an average for this pair.'
          : avg.kind === 'none' ? 'This pair has no market to average.'
          : 'The 24h average could not be read just now. Press again.';
        toast.error('Not started', { description: `${why} Nothing was sent.` });
        return;
      }
      const profile = await fetchPairVolumeProfile(payToken.mint, buyToken.mint);
      const o = planOrder({
        id: Math.random().toString(36).slice(2, 12),
        wallet: p.wallet,
        pay: { mint: payToken.mint, symbol: payToken.symbol, decimals: payToken.decimals },
        buy: { mint: buyToken.mint, symbol: buyToken.symbol, decimals: buyToken.decimals },
        total,
        startAt: Date.now(),
        durationS,
        count: slices,
        bandBps,
        profile,
      });
      if (!o) {
        toast.error('Not started', { description: 'This amount is too small to split. Raise it or pick fewer slices.' });
        return;
      }
      if (!saveOrder(o)) {
        toast.error('Not started', { description: 'This browser would not keep the order, so nothing was started.' });
        return;
      }
      toast.success('VWAP order started', { description: 'Your wallet asks you to approve the first slice now. Keep this page open.' });
    } finally {
      setStarting(false);
    }
  }

  const amber =
    same ? 'Pick two different coins.'
    : short ? (keep > 0n ? `Not enough SOL. Keep ${amountText(keep, 9)} SOL for network fees.` : `Not enough ${payToken.symbol}.`)
    : tooSmall ? 'This amount is too small to split.'
    : null;
  const canStart = !!p.wallet && total !== null && total > 0n && !same && !short && !tooSmall && !(p.needsAck && !p.ack) && !starting;

  return (
    <>
      <div className="mb-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={LABEL_SHADOW}>Total to spend</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={FIELD}>
          <button type="button" onClick={p.onPickPay} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{payToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.0" aria-label={`Total ${payToken.symbol} to spend`} value={amount} onChange={(e) => acceptAmount(e.target.value, setAmount)} className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0" />
        </div>
      </div>

      <div className="mt-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={LABEL_SHADOW}>{buying ? 'Buying' : 'For'}</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={FIELD}>
          <button type="button" onClick={p.onPickBuy} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[40px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{buyToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <div className="flex-1 flex flex-wrap items-center justify-end gap-2 text-[11px] text-white/70">
            <select value={durationS} onChange={(e) => setDurationS(Number(e.target.value))} aria-label="Spread over" className={SELECT} style={SELECT_STYLE}>
              {VWAP_DURATIONS_S.map((d) => <option key={d} value={d}>over {DURATION_LABEL[d]}</option>)}
            </select>
            <select value={slices} onChange={(e) => setCount(Number(e.target.value))} aria-label="Number of slices" className={SELECT} style={SELECT_STYLE}>
              {counts.map((n) => <option key={n} value={n}>{n} slices</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="mb-3 text-[11px] space-y-1">
        <div className="flex items-center justify-between gap-2 text-white/70">
          <label htmlFor="vwap-limit">Price limit</label>
          <select id="vwap-limit" value={bandBps} onChange={(e) => setBandBps(Number(e.target.value))} className={SELECT} style={SELECT_STYLE}>
            {VWAP_BANDS_BPS.map((b) => <option key={b} value={b}>{b / 100}% {buying ? 'above' : 'below'} the 24h average</option>)}
          </select>
        </div>
        {!same && (
          <PairAverageLine
            testId="vwap-average"
            trade={{ payMint: payToken.mint, buyMint: buyToken.mint, paySymbol: payToken.symbol, buySymbol: buyToken.symbol, payAmount: null, buyAmount: null }}
          />
        )}
        <SiteFeeRow feePct={p.feePct} feeMintSymbol={p.feeMintSymbol} waived={false} />
        {amber && <p className="text-amber-300" data-testid="vwap-warning">{amber}</p>}
        {p.warnings}
      </div>

      {p.needsAck && (
        <label className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-lg cursor-pointer" style={{ background: 'rgba(150,40,40,0.20)', border: '1px solid rgba(255,90,90,0.35)' }}>
          <input type="checkbox" checked={p.ack} onChange={(e) => p.setAck(e.target.checked)} className="mt-0.5 flex-shrink-0" />
          <span className="text-[11px] text-red-200">
            This pair carries a risk warning (an unverified token, or flagged by Jupiter Shield above). I understand and want to trade it anyway.
          </span>
        </label>
      )}

      {!p.wallet ? (
        <SolanaConnectButton />
      ) : (
        <button type="button" onClick={() => void start()} disabled={!canStart} className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-50">
          {starting ? 'Starting…' : total === null ? 'Enter a total amount' : short ? `Insufficient ${payToken.symbol}` : 'Start the VWAP order'}
        </button>
      )}

      <p className="mt-3 text-center text-white/60 text-[10px]">
        One slice about every {gapMin} minutes. Your wallet approves each one, so keep this page open.
      </p>
      <FinePrint summary="How it works">
        <p>
          Your total is split into {slices} slices over {DURATION_LABEL[durationS]}. Busier hours get bigger slices, from
          when this pair traded over the last 7 days (between half and twice an even slice; even slices when that
          cannot be read).
        </p>
        <p>
          Before each slice, the page reads the pair&apos;s 24h average traded price and Jupiter&apos;s price for the
          slice. If the slice would cost more than your limit above the average (or, selling, get less than your limit
          below it), it waits and tries again each minute. What a slice does not spend goes with the next one. When the
          time is up, anything not spent stays in your wallet.
        </p>
        <p>
          Each slice is an ordinary Instant swap through Jupiter, with a 1% slippage floor, and pays the platform fee
          above. Your money never leaves your wallet until you approve a slice. Our own pools are not used for slices.
        </p>
      </FinePrint>
    </>
  );
}

/** The clock, read again every `everyMs`: the order's lines say what is next. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function sliceLine(o: VwapOrder, s: VwapSlice): string {
  if (s.state === 'filled') return `${amountText(BigInt(s.paid ?? '0'), o.pay.decimals)} ${o.pay.symbol} → ${s.gotExact ? '' : '≈'}${amountText(BigInt(s.got ?? '0'), o.buy.decimals)} ${o.buy.symbol}`;
  if (s.state === 'missed') return 'skipped, its part went on to the next';
  if (s.state === 'unconfirmed') return 'sent, not confirmed yet';
  if (s.state === 'sending') return 'checking the price…';
  return `${amountText(BigInt(s.planned), o.pay.decimals)} ${o.pay.symbol} planned`;
}

function OrderView({ o, where, feePct, feeMintSymbol }: { o: VwapOrder; where: RunnerWhere; feePct: string; feeMintSymbol: string | null }) {
  const { paid, got, filled, exact } = filledTotals(o);
  const live = needsRunner(o);
  const now = useNow(30_000);
  const act = nextAction(o, now);
  const latest = [...o.slices].reverse().find((s) => s.state !== 'missed' && s.why);
  const buying = buyingBase(o.pay.mint, o.buy.mint);
  const ending =
    o.stoppedAt !== undefined ? 'Stopped. Nothing more is sent.'
    : act.kind === 'done' && act.why === 'filled' ? 'Done: the whole total was spent.'
    : act.kind === 'done' ? `Time is up. ${amountText(BigInt(o.total) - paid, o.pay.decimals)} ${o.pay.symbol} was not spent and stays in your wallet.`
    : null;
  const whereLine =
    where === 'here' ? 'Running in this tab. Keep this page open.'
    : where === 'elsewhere' ? 'Running in another tab of this site.'
    : where === 'no-signer' ? 'This wallet cannot approve a slice without sending it, so the order cannot run with it.'
    : where === 'no-lock' ? 'This browser cannot keep the order to one tab, so it does not run here.'
    : null;
  const nextLine = act.kind === 'wait' && !ending ? `Next look at ${clock(act.until)}.` : null;

  return (
    <div data-testid="vwap-order">
      <div className="flex items-center justify-between mb-2">
        <span className="text-white text-[12px] font-semibold" style={LABEL_SHADOW}>
          VWAP order: {amountText(BigInt(o.total), o.pay.decimals)} {o.pay.symbol} → {o.buy.symbol}
        </span>
      </div>
      <div className="mb-3 text-[11px] space-y-1">
        <div className="flex items-center justify-between text-white/70">
          <span>Spent</span>
          <span className="font-mono" data-testid="vwap-spent">
            {amountText(paid, o.pay.decimals)} of {amountText(BigInt(o.total), o.pay.decimals)} {o.pay.symbol} · {filled} of {o.slices.length} slices
          </span>
        </div>
        <div className="flex items-center justify-between text-white/70">
          <span>Received</span>
          <span className="font-mono">{exact ? '' : '≈'}{amountText(got, o.buy.decimals)} {o.buy.symbol}</span>
        </div>
        {filled > 0 && (
          <PairAverageLine
            testId="vwap-order-average"
            trade={{ payMint: o.pay.mint, buyMint: o.buy.mint, paySymbol: o.pay.symbol, buySymbol: o.buy.symbol, payAmount: Number(paid) / 10 ** o.pay.decimals, buyAmount: Number(got) / 10 ** o.buy.decimals }}
          />
        )}
        <SiteFeeRow feePct={feePct} feeMintSymbol={feeMintSymbol} waived={false} />
        {ending && <p className="text-white/80" data-testid="vwap-ending">{ending}</p>}
        {!ending && latest?.why && <p className="text-amber-300" data-testid="vwap-why">{latest.why}</p>}
        {!ending && whereLine && <p className={where === 'here' || where === 'elsewhere' ? 'text-white/60' : 'text-amber-300'} data-testid="vwap-where">{whereLine}</p>}
        {nextLine && <p className="text-white/60">{nextLine}</p>}
      </div>

      {live && o.stoppedAt === undefined ? (
        <button
          type="button"
          onClick={() => {
            const fresh = readOrder(o.wallet);
            if (fresh && fresh.id === o.id) saveOrder({ ...fresh, stoppedAt: Date.now() });
          }}
          className="w-full py-2.5 rounded-lg text-[14px] font-medium text-red-200"
          style={{ background: 'rgba(150,40,40,0.25)', border: '1px solid rgba(255,90,90,0.35)' }}
        >
          Stop the order
        </button>
      ) : !live ? (
        <button type="button" onClick={() => forgetOrder(o.wallet)} className="btn-primary w-full py-2.5 text-[14px]">
          New order
        </button>
      ) : null}

      <FinePrint summary="Slices">
        <ol className="space-y-1">
          {o.slices.map((s, i) => (
            <li key={s.dueAt} className="flex items-center justify-between gap-2">
              <span className="font-mono text-white/60">{i + 1} · {clock(s.dueAt)}</span>
              <span className="text-right">
                {sliceLine(o, s)}
                {s.sig && (
                  <>
                    {' '}
                    <a href={`https://solscan.io/tx/${s.sig}`} target="_blank" rel="noopener noreferrer" className="underline">View</a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
        <p>
          Sized {o.sizing === 'volume' ? 'by when this pair traded over the last 7 days' : 'evenly (the pair’s last 7 days could not be read)'}.
          Limit: {o.bandBps / 100}% {buying ? 'above' : 'below'} the 24h average.
        </p>
      </FinePrint>
    </div>
  );
}
