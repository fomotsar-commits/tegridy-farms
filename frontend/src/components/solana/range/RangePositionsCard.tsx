import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { pairOf, rangePrices, type Pair } from '../../../lib/solana/clmm/rangeMath';
import type { Read, WalletPosition, WalletPositionsRead } from '../../../lib/solana/clmm/read';
import { feeSplit, poolFeeCeiling } from '../../../lib/solana/clmm/feeText';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { priceNumber } from '../../../lib/solana/clmm/rangeMath';
import { POOL_STATUS_BIT, poolAllows } from '../../../lib/solana/clmm/program';
import { CardArt } from '../../ui/CardArt';
import { Card, Notice, Row, SlippagePicker } from '../curve/ui';
import { DEFAULT_SLIPPAGE_BPS } from '../curve/uiFormat';
import { TxFlowView } from '../curve/TxFlowView';
import { WalletNeeded } from '../curve/WalletNeeded';
import { useReturnFocus, useTxFlow } from '../curve/useTxFlow';
import type { CurveSignerState } from '../curve/useCurveSigner';
import type { PendingTradesState } from '../curve/usePendingTrades';
import type { CurveWriteConfig, RangeWriteApi, WriteRpc } from '../curve/ports';
import { PAUSED_TEXT, bothAmounts, priceText, rewardAmount, rewardCoin, tokenWord, utcClock } from './rangeText';
import { useFlowReports } from './useRangeData';
import { chipCls } from './editorialUi';

const TAKE_HINT = 'If the price moves more than this before your withdrawal runs, it is refused and only the network fee is spent.';
const PERCENTS = [25, 50, 75, 100] as const;

type Action = { kind: 'collect' | 'remove' | 'close'; position: string };

/**
 * The wallet's range positions, found through its NFTs of either token program (read.ts). Each
 * says whether it is in range now, what it holds and what is waiting to collect, fees and
 * rewards, with Collect (a take-out of nothing, which pays both), Remove and Close. A
 * position that did not read is listed as such, never left out.
 */
export function RangePositionsCard(p: {
  read: Read<WalletPositionsRead> | null;
  reading: boolean;
  onReadAgain: () => void;
  signerState: CurveSignerState;
  canTake: boolean;
  write: { api: RangeWriteApi; cfg: CurveWriteConfig } | null;
  rpc: WriteRpc;
  programId: PublicKey;
  pending: PendingTradesState;
  held: boolean;
  othersBusy: boolean;
  onBusy: (busy: boolean) => void;
  onFinished: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const onBusy = (b: boolean) => {
    setBusy(b);
    p.onBusy(b);
  };
  const connected = p.signerState.kind !== 'disconnected';
  const list = p.read?.kind === 'ok' ? p.read.value : null;

  return (
    <Card title="Your range positions" testId="range-positions" index={4} art={<CardArt pageId="range-pools" idx={3} />}>
      {!connected ? (
        <>
          <p className="text-white/70">Connect a wallet to see the range positions it holds.</p>
          <WalletNeeded state={p.signerState} />
        </>
      ) : p.read === null ? (
        <p className="text-white/70">Reading your positions…</p>
      ) : p.read.kind === 'unread' ? (
        <div className="space-y-2">
          <Notice tone="warn">Your positions could not be read just now. This does not mean you have none.</Notice>
          <button type="button" className="btn-secondary min-h-[44px] px-4 text-[12px]" onClick={p.onReadAgain}>
            Read again
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {list!.positions.length === 0 && list!.unread.length === 0 && <p className="text-white/70">This wallet holds no range positions.</p>}
          {list!.positions.map((w) => (
            <PositionRow
              key={w.position.address}
              w={w}
              action={action?.position === w.position.address ? action : null}
              setAction={setAction}
              disabled={busy || p.othersBusy || p.held || !p.write || !p.canTake}
              {...p}
              onBusy={onBusy}
            />
          ))}
          {list!.unread.map((u) => (
            <Notice key={u.position} tone="warn">
              {`A position (${u.position}) could not be read just now: ${u.detail}. It is still yours.`}
            </Notice>
          ))}
          {p.reading && <p className="text-white/45 text-[10px]">Reading again…</p>}
          {!p.canTake && <Notice>Collecting and taking out are not switched on here yet.</Notice>}
        </div>
      )}
    </Card>
  );
}

function PositionRow(p: {
  w: WalletPosition;
  action: Action | null;
  setAction: (a: Action | null) => void;
  disabled: boolean;
  write: { api: RangeWriteApi; cfg: CurveWriteConfig } | null;
  rpc: WriteRpc;
  programId: PublicKey;
  signerState: CurveSignerState;
  pending: PendingTradesState;
  onBusy: (busy: boolean) => void;
  onFinished: () => void;
}) {
  const { w } = p;
  const pair = pairOf(w.pool);
  const split = feeSplit(w.config, poolFeeCeiling(w.pool, w.config.tradeFeeRate));
  const id = w.position.address;
  const status =
    w.status === 'in-range'
      ? { tone: 'good' as const, text: 'In range: earning fees now.' }
      : { tone: 'warn' as const, text: `Out of range (the price is ${w.status === 'below' ? 'below' : 'above'} it): earning nothing until the price comes back into it.` };
  const both = (a0: bigint, a1: bigint) => (pair ? bothAmounts(pair, a0, a1) : `${a0} and ${a1} (in each coin’s smallest units)`);
  const prices = pair ? rangePrices(pair, { tickLower: w.position.tickLowerIndex, tickUpper: w.position.tickUpperIndex }) : null;
  const empty = w.position.liquidity === 0n;
  // What a Collect pays now: brought up to date only while removal is on, else the record's own
  // figures (decrease_liquidity.rs), and nothing a paused collection holds back.
  const removalOn = poolAllows(w.pool, POOL_STATUS_BIT.decreaseLiquidity);
  const feesOn = poolAllows(w.pool, POOL_STATUS_BIT.collectFee);
  const rewardsOn = poolAllows(w.pool, POOL_STATUS_BIT.collectReward);
  const recorded = w.pool.rewardInfos.flatMap((r, i) => (r.initialized ? [w.position.rewardInfos[i]?.rewardAmountOwed ?? 0n] : []));
  const paysFees = !feesOn ? [] : removalOn || empty ? (w.fees && [w.fees.fee0, w.fees.fee1]) : [w.position.tokenFeesOwed0, w.position.tokenFeesOwed1];
  const paysRewards = !rewardsOn ? [] : removalOn || empty ? (w.rewards && w.rewards.map((r) => r.owed)) : recorded;
  const known0 = (v: bigint[] | null) => v !== null && v.every((x) => x === 0n);
  // Collect is offered unless what it pays is known to be zero: a collect of nothing still costs a network fee.
  const nothingOwed = known0(paysFees) && known0(paysRewards);
  const hasRewards = w.pool.rewardInfos.some((r) => r.initialized);
  const paused: string[] = [];
  if (!removalOn && !empty) paused.push(PAUSED_TEXT.removal);
  if (!feesOn) paused.push(PAUSED_TEXT.fees);
  if (!rewardsOn && hasRewards) paused.push(PAUSED_TEXT.rewards);
  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-1.5" data-testid="range-position">
      {pair && tokenWord(pair) === 'tokens' && <Row label="Token (mint)" value={pair.tokenMint} />}
      <Row label="Pool" value={pair ? `${tokenWord(pair) === 'tokens' ? 'The token' : tokenWord(pair)} with ${pair.quote.symbol}, ${split.fee} fee per swap` : 'a pair this site does not read'} mono={false} />
      {prices && pair && <Row label="Range" value={`${priceText(pair, prices.min)} to ${formatSolPrice(priceNumber(prices.max))}`} mono={false} />}
      <Notice tone={status.tone}>{status.text}</Notice>
      <Row label="Holds now" value={w.amounts ? both(w.amounts.amount0, w.amounts.amount1) : 'could not be worked out just now'} mono={false} />
      <Row label="Waiting to collect" value={waitingText(w, both, paused.length === 0)} mono={false} />
      {(w.fees !== null || w.rewards !== null) && (
        <p className="text-white/45 text-[10px] font-mono" data-testid="range-position-waiting-basis">
          {`worked out from accounts read together${w.chainTime !== null ? ` at ${utcClock(w.chainTime)}` : ''}; the exact amount is fixed when you collect`}
        </p>
      )}
      {paused.map((t) => (
        <Notice key={t} tone="warn">
          {t}
        </Notice>
      ))}
      <Row label="Position" value={id} />
      {w.nftProgram === 'token' ? (
        <Notice>
          This position’s NFT is a classic SPL token, and this site takes out only positions whose NFT is a Token-2022 one, so it cannot collect from, remove or close this one yet. It is still yours: the range program takes it out for whoever holds the NFT.
        </Notice>
      ) : p.action ? (
        <ActionPanel
          {...p}
          pair={pair}
          action={p.action}
          onClose={() => p.setAction(null)}
          onFinished={() => {
            p.setAction(null);
            p.onFinished();
          }}
        />
      ) : (
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="button" className="btn-secondary min-h-[44px] w-full px-3 text-[12px] disabled:opacity-50" disabled={p.disabled || nothingOwed} onClick={() => p.setAction({ kind: 'collect', position: id })}>
            Collect
          </button>
          <button type="button" className="btn-secondary min-h-[44px] w-full px-3 text-[12px] disabled:opacity-50" disabled={p.disabled || empty} onClick={() => p.setAction({ kind: 'remove', position: id })}>
            Remove
          </button>
          <button type="button" className="btn-secondary min-h-[44px] w-full px-3 text-[12px] disabled:opacity-50" disabled={p.disabled} onClick={() => p.setAction({ kind: 'close', position: id })}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

function ActionPanel(p: {
  w: WalletPosition;
  pair: Pair | null;
  action: Action;
  onClose: () => void;
  write: { api: RangeWriteApi; cfg: CurveWriteConfig } | null;
  rpc: WriteRpc;
  programId: PublicKey;
  signerState: CurveSignerState;
  pending: PendingTradesState;
  onBusy: (busy: boolean) => void;
  onFinished: () => void;
}) {
  if (!p.write) return null;
  return <ActionInner {...p} write={p.write} />;
}

function ActionInner(p: {
  w: WalletPosition;
  pair: Pair | null;
  action: Action;
  onClose: () => void;
  write: { api: RangeWriteApi; cfg: CurveWriteConfig };
  rpc: WriteRpc;
  programId: PublicKey;
  signerState: CurveSignerState;
  pending: PendingTradesState;
  onBusy: (busy: boolean) => void;
  onFinished: () => void;
}) {
  const { api, cfg } = p.write;
  const kind = p.action.kind;
  const [percent, setPercent] = useState<number | null>(kind === 'remove' ? null : kind === 'close' ? 100 : 0);
  const [tolerance, setTolerance] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);
  const flow = useTxFlow(api, p.rpc, p.pending.record, p.pending.sent);
  const { target: reviewRef } = useReturnFocus(flow.state.step);
  useFlowReports(flow.state.step, flow.locked, p.onBusy, p.onFinished);
  const signer = p.signerState.kind === 'ready' ? p.signerState.signer : null;
  const position = new PublicKey(p.w.position.address);
  const title = kind === 'collect' ? 'Collect' : kind === 'close' ? 'Close this position' : 'Take liquidity out';
  const can = !!signer && percent !== null && tolerance !== null && !flow.locked;
  const review = () => {
    if (!signer || percent === null || tolerance === null) return;
    const base = { owner: signer.publicKey, position, toleranceBps: Number(tolerance) };
    void flow.prepare(
      () => (kind === 'close' ? api.prepareRangeClose(p.rpc, cfg, p.programId, base) : api.prepareRangeRemove(p.rpc, cfg, p.programId, { ...base, percent })),
      { repeatable: true },
    );
  };
  if (flow.state.step !== 'idle') {
    return (
      <TxFlowView
        flow={flow}
        api={api}
        cluster={cfg.cluster}
        decimals={p.pair?.tokenDecimals ?? null}
        signer={signer}
        preparingText="Reading the position again and test-running it on the network…"
      />
    );
  }
  return (
    <div className="space-y-2 pt-1" data-testid={`range-${kind}-panel`}>
      <p className="text-white font-semibold text-[12px]">{title}</p>
      {kind === 'collect' && <p className="text-white/70">Pays out what it has earned. The liquidity stays in.</p>}
      {kind === 'close' && <p className="text-white/70">Takes everything out, fees included, then burns the position’s NFT and closes its record, so its deposits come back to you too.</p>}
      {kind === 'remove' && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="How much to take out">
          {PERCENTS.map((x) => (
            <button
              key={x}
              type="button"
              aria-pressed={percent === x}
              className={chipCls(percent === x)}
              onClick={() => setPercent(x)}
            >
              {x}%
            </button>
          ))}
        </div>
      )}
      {kind !== 'collect' && <SlippagePicker valueBps={tolerance} onChange={setTolerance} hint={TAKE_HINT} />}
      <WalletNeeded state={p.signerState} />
      <div className="flex flex-col sm:flex-row gap-2">
        <button ref={reviewRef} type="button" className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60 disabled:grayscale" disabled={!can} onClick={review}>
          {kind === 'collect' ? 'Review: collect' : kind === 'close' ? 'Review: close the position' : 'Review: take out'}
        </button>
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={p.onClose}>
          Back
        </button>
      </div>
    </div>
  );
}

/**
 * "212 BAYLA and 0.093 SOL in fees · 48.2 BAYLA in rewards". A part that could not be
 * worked out says so, never 0; with nothing paused, Collect pays it in full all the same.
 */
function waitingText(w: WalletPosition, both: (a0: bigint, a1: bigint) => string, inFull: boolean): string {
  const tail = inFull ? '; Collect pays them in full all the same' : '';
  if (w.fees === null && (w.rewards === null || w.rewards.length === 0)) return `could not be worked out just now${tail}`;
  const parts = [w.fees ? `${both(w.fees.fee0, w.fees.fee1)} in fees` : 'the fees could not be worked out just now'];
  if (w.rewards === null) parts.push('the rewards could not be worked out just now');
  else if (w.rewards.length > 0) {
    const each = w.rewards.map((r) => {
      const coin = rewardCoin(r.mint);
      return rewardAmount(r.owed, r.decimals, r.mint) + (r.feeOnTransfer ? ` (${coin} takes its own fee out of each transfer, so less arrives)` : '');
    });
    parts.push(`${each.join(' and ')} in rewards`);
  }
  return parts.join(' · ') + (w.fees === null || w.rewards === null ? tail : '');
}
