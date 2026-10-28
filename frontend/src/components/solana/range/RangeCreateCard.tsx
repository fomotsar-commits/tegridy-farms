import { useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { formatSol } from '../../../lib/launcher/solana/curve';
import type { RangeOpenReads } from '../../../lib/launcher/solana/write/range';
import { CREATE_POOL_FEE_LAMPORTS, CREATE_POOL_FEE_RECEIVER } from '../../../lib/solana/clmm/ix';
import { MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64, getTickAtSqrtPrice } from '../../../lib/solana/clmm/math';
import { marketGap, marketReference, type MarketGap } from '../../../lib/solana/clmm/priceCheck';
import { sortMints, type AmmConfigView } from '../../../lib/solana/clmm/program';
import { depositFrom, pairOf, parsePrice, sqrtAtPrice, type Pair, type Price, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import { feeSplit } from '../../../lib/solana/clmm/feeText';
import { rangeVenueEarns } from '../../../lib/solana/clmm/venueEarns';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { tickerAndAddress } from '../../../lib/solana/lp/identity';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { CardArt } from '../../ui/CardArt';
import { Card, Notice, Row } from '../curve/ui';
import { TxFlowView } from '../curve/TxFlowView';
import { WalletNeeded } from '../curve/WalletNeeded';
import { useReturnFocus, useTxFlow } from '../curve/useTxFlow';
import type { CurveSignerState } from '../curve/useCurveSigner';
import type { PendingTradesState } from '../curve/usePendingTrades';
import type { CurveWriteConfig, RangeWriteApi, WriteRpc } from '../curve/ports';
import { RangeReviewDisclosure, RangeRisks } from './RangeRisks';
import { RangePickFields } from './RangePickFields';
import { pickProblem, useRangePick } from './rangePick';
import { bothAmounts, coinAmount, priceNumberText, tokenAmount, tokenWord } from './rangeText';
import { useFlowReports } from './useRangeData';

/**
 * Open the pair's pool on the 1% tier (fee tier 0, the only one this site offers) with its
 * first position, in one transaction (write/range.ts `prepareRangeCreate`). The opening price
 * starts at the market's, and one more than 3% off it keeps Review off: the builder refuses
 * it too, after asking the market again. A token with no market price gets no pool here: it
 * would be a launch by another name. What opening costs and how a position earns are said in
 * plain sight, before Review.
 */
export interface RangeCreateProps {
  tier: AmmConfigView;
  tokenMint: string;
  /** The token's decimals, from its mint; null while that read is not in, or when it failed (`tokenUnread`). */
  tokenDecimals: number | null;
  tokenUnread: boolean;
  onReadAgain: () => void;
  coin: QuoteCoin;
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
}

const sol = (v: bigint) => `${formatSol(v, 9)} SOL`;

export function RangeCreateCard(p: RangeCreateProps) {
  const split = feeSplit(p.tier);
  const venue = rangeVenueEarns(p.tier);
  return (
    <Card title="Open this pool" testId="range-create" art={<CardArt pageId="range-pools" idx={7} />}>
      <p className="text-white/85">Set its opening price and put the first coins in, in one transaction.</p>
      <Row label="Token" value={tickerAndAddress(p.tokenMint)} />
      <Row label="Paired with" value={tickerAndAddress(p.coin.mint)} />
      <Row label="Fee tier" value={`${split.fee} of each swap`} mono={false} />
      {/* What opening costs and how a position earns: said before Review, never folded away. */}
      <Notice tone="warn">
        {`Opening this pool costs ${sol(CREATE_POOL_FEE_LAMPORTS)}, paid to the venue’s vault (${CREATE_POOL_FEE_RECEIVER.toBase58()}). It is not refunded. On top of it come deposits for the pool’s own accounts and its first price bands, which never come back, and for your position, which come back when you close it. The review says each to the lamport.`}
      </Notice>
      <p className="text-white/85" data-testid="range-create-earns">
        {`Positions whose range the price is in share ${split.lpOfFee} of each ${split.fee} swap fee (${split.lpOfSwap} of the swap), split by how much liquidity each has there. The venue keeps ${split.venueOfFee} (${split.venueOfSwap} of the swap).`}
      </p>
      {venue.elsewhere ? (
        <p className="text-amber-200 text-[12px]" data-testid="range-create-venue-elsewhere">
          <strong>{venue.where}</strong>
        </p>
      ) : (
        <p className="text-white/70 text-[12px]">{venue.where}</p>
      )}
      <Notice tone="warn">Trading opens the moment the pool exists, and its opening price can never be set again. A pool cannot be closed.</Notice>
      {p.tokenDecimals !== null ? (
        <OpeningPrice {...p} tokenDecimals={p.tokenDecimals} />
      ) : p.tokenUnread ? (
        <div className="space-y-2">
          <Notice tone="warn">The token could not be read just now, so its pool cannot be set up here yet.</Notice>
          <button type="button" className="btn-secondary min-h-[44px] px-4 text-[12px]" onClick={p.onReadAgain}>
            Read again
          </button>
        </div>
      ) : (
        <p className="text-white/70">Reading the token…</p>
      )}
    </Card>
  );
}

function OpeningPrice(p: RangeCreateProps & { tokenDecimals: number }) {
  const pair = useMemo<Pair | null>(() => {
    const { token0, token1 } = sortMints(new PublicKey(p.tokenMint), new PublicKey(p.coin.mint));
    const tokenIs0 = token0.toBase58() === p.tokenMint;
    return pairOf({
      tokenMint0: token0.toBase58(),
      tokenMint1: token1.toBase58(),
      mintDecimals0: tokenIs0 ? p.tokenDecimals : p.coin.decimals,
      mintDecimals1: tokenIs0 ? p.coin.decimals : p.tokenDecimals,
      tickSpacing: p.tier.tickSpacing,
    });
  }, [p.tokenMint, p.coin, p.tokenDecimals, p.tier.tickSpacing]);

  // The market's answers, asked once for this pair (Review asks again, fresh).
  const [market, setMarket] = useState<{ key: string; token: OutsidePrice; coin: OutsidePrice | null } | null>(null);
  const [nonce, setNonce] = useState(0);
  const marketKey = pair ? `${pair.tokenMint}:${pair.quote.mint}:${nonce}` : '';
  const reads = p.reads;
  useEffect(() => {
    if (!pair) return;
    let live = true;
    const ask = (mint: string, decimals: number) =>
      reads.outsidePrice(mint, decimals).catch((e: unknown): OutsidePrice => ({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }));
    void Promise.all([ask(pair.tokenMint, pair.tokenDecimals), pair.quote.native ? Promise.resolve(null) : ask(pair.quote.mint, pair.quote.decimals)]).then(([token, coin]) => {
      if (live) setMarket({ key: `${pair.tokenMint}:${pair.quote.mint}:${nonce}`, token, coin });
    });
    return () => {
      live = false;
    };
  }, [reads, pair, nonce]);
  const answers = market?.key === marketKey ? market : null;
  // The market's own price, in the pool's coin per token.
  const atMarket = answers && pair ? marketReference(pair, answers.token, answers.coin) : null;
  const reference = typeof atMarket === 'number' ? atMarket : null;
  const [priceText, setPriceText] = useState('');
  const [typed, setTyped] = useState(false);
  const shown = typed ? priceText : reference !== null ? formatSolPrice(reference) : '';
  const start = parsePrice(shown);
  const sqrt = pair && start ? sqrtAtPrice(pair, start) : null;
  const inBounds = sqrt !== null && sqrt >= MIN_SQRT_PRICE_X64 && sqrt < MAX_SQRT_PRICE_X64;
  const gap = answers && pair && inBounds ? marketGap(pair, sqrt!, answers.token, answers.coin) : null;

  if (!pair) return <Notice tone="warn">This site does not pair these two coins in a range pool.</Notice>;
  if (!answers) return <p className="text-white/70">Reading the market price…</p>;
  if (atMarket !== null && typeof atMarket !== 'number' && atMarket.state === 'no-market') {
    return <Notice tone="warn">This token has no market price, so a pool for it would be its launch. The venue does not open launches this way.</Notice>;
  }
  if (atMarket !== null && typeof atMarket !== 'number') {
    return (
      <div className="space-y-2">
        <Notice tone="warn">{`The market price could not be read just now (${atMarket.detail}). This does not mean there is none. Your opening price is checked against it, so nothing can be opened until it reads.`}</Notice>
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-[12px]" onClick={() => setNonce((n) => n + 1)}>
          Read again
        </button>
      </div>
    );
  }
  const useMarket = () => {
    setTyped(false);
    setPriceText('');
  };
  return (
    <>
      <label className="block">
        <span className="block text-white/70 text-[11px] mb-1">{`Opening price (${pair.quote.symbol} per ${tokenWord(pair) === 'tokens' ? 'token' : tokenWord(pair)})`}</span>
        <input
          inputMode="decimal"
          autoComplete="off"
          className="w-full min-h-[44px] rounded-lg bg-black/40 border border-white/15 px-3 text-white text-[14px]"
          value={shown}
          onChange={(e) => {
            setTyped(true);
            setPriceText(e.target.value);
          }}
        />
      </label>
      {reference !== null && (
        <button type="button" className="underline text-white/70 min-h-[44px] text-left" onClick={useMarket}>
          {`Use the market price (Jupiter): ${priceNumberText(pair, reference)}`}
        </button>
      )}
      {shown && !start && <p role="alert" className="text-rose-300/90">Type the opening price as a plain number, like 0.0003.</p>}
      {start && !inBounds && <p role="alert" className="text-rose-300/90">That opening price is outside what a range pool can hold.</p>}
      {gap?.state === 'disagrees' && (
        <Notice tone="bad">
          {`Your opening price is ${Number((Math.abs(gap.diff) * 100).toFixed(1))}% ${gap.diff > 0 ? 'above' : 'below'} the market price. The first trader could buy from your deposit at it, so Review stays off. Use the market price.`}
        </Notice>
      )}
      {inBounds && start && <FirstPosition {...p} pair={pair} sqrt={sqrt!} start={start} gap={gap} />}
    </>
  );
}

function FirstPosition(p: RangeCreateProps & { pair: Pair; sqrt: bigint; start: Price; gap: MarketGap | null }) {
  const { pair } = p;
  const at = useMemo(() => ({ sqrtPriceX64: p.sqrt, tickCurrent: getTickAtSqrtPrice(p.sqrt) }), [p.sqrt]);
  const pick = useRangePick(pair, at);
  const [busy, setBusy] = useState(false);
  const onBusy = (b: boolean) => {
    setBusy(b);
    p.onBusy(b);
  };
  const { r, side, amount } = pick;
  // The pool opens at this price in the same transaction, so the plan is exact: no tolerance.
  const plan = r && amount !== null && amount > 0n ? depositFrom(pair, at, r, side, amount) : null;
  const problemText = pickProblem(pair, pick, plan);
  const agrees = p.gap?.state === 'agrees';
  return (
    <>
      <RangePickFields pair={pair} p={pick} busy={busy} at="the opening price" />
      {plan && (
        <div className="space-y-1.5" data-testid="range-create-plan">
          <Row label="You put in" value={`${bothAmounts(pair, plan.amount0, plan.amount1)}, exactly`} mono={false} />
          <p className="text-white/45 text-[10px]">The pool opens at your price in the same transaction, so nothing can move it in between. Review reads the chain again and test-runs it.</p>
        </div>
      )}
      <p role="alert" className="text-rose-300/90">
        {problemText}
      </p>
      {p.why ? (
        <Notice tone="warn">{p.why}</Notice>
      ) : (
        p.write && r && plan && <CreateFlow {...p} onBusy={onBusy} write={p.write} range={r} side={side} amount={amount!} agrees={agrees} />
      )}
      {!p.canOpen && !p.why && <Notice>Amounts here are only worked out: opening a pool is not switched on here.</Notice>}
      <RangeRisks />
      {/* Said beside every deposit, never folded away. */}
      <Notice tone="warn">
        Out of range, a position earns nothing.{' '}
        {plan ? `This one is worth ${tokenAmount(pair, pair.tokenIsToken0 ? plan.amount0 : plan.amount1)} and ${coinAmount(pair, pair.tokenIsToken0 ? plan.amount1 : plan.amount0)} at the opening price.` : ''}
      </Notice>
    </>
  );
}

function CreateFlow(
  p: RangeCreateProps & { write: { api: RangeWriteApi; cfg: CurveWriteConfig }; pair: Pair; start: Price; range: TickRange; side: 'token' | 'coin'; amount: bigint; agrees: boolean },
) {
  const { api, cfg } = p.write;
  const flow = useTxFlow(api, p.rpc, p.pending.record, p.pending.sent);
  const { target: reviewRef } = useReturnFocus(flow.state.step);
  const signer = p.signerState.kind === 'ready' ? p.signerState.signer : null;
  useFlowReports(flow.state.step, flow.locked, p.onBusy, p.onFinished);
  const busy = flow.state.step !== 'idle';
  const can = p.canOpen && !!signer && p.agrees && !p.held && !flow.locked;
  const review = () => {
    if (!signer) return;
    const args = {
      owner: signer.publicKey,
      tokenMint: new PublicKey(p.pair.tokenMint),
      coinMint: new PublicKey(p.pair.quote.mint),
      startPrice: p.start,
      tickLower: p.range.tickLower,
      tickUpper: p.range.tickUpper,
      side: p.side,
      amount: p.amount,
    };
    void flow.prepare(() => api.prepareRangeCreate(p.rpc, cfg, p.programId, p.reads, args), { repeatable: true });
  };
  if (busy) {
    return (
      <TxFlowView
        flow={flow}
        api={api}
        cluster={cfg.cluster}
        decimals={p.pair.tokenDecimals}
        signer={signer}
        preparingText="Reading the chain and the market price again, and test-running the pool and your position on the network…"
        extraReview={<RangeReviewDisclosure />}
      />
    );
  }
  return (
    <>
      <WalletNeeded state={p.signerState} />
      <button ref={reviewRef} type="button" className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60 disabled:grayscale" disabled={!can} onClick={review}>
        Review: open the pool and your position
      </button>
    </>
  );
}
