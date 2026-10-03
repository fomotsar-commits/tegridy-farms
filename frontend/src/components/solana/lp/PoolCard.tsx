import { useEffect, useRef } from 'react';
import { isCreatedPool, type PoolEntry, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { formatWhen, type PoolHealth, type WithdrawalsState } from '../../../lib/solana/lp/poolHealth';
import { feeRateText, formatSolPrice, solText, tokenText, tradeCostText } from '../../../lib/solana/lp/format';
import { chargedCreatorFeeRate, feeSplit } from '../../../lib/solana/cpswap/venue';
import { ratePercent } from '../../../lib/solana/cpswap/math';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { Notice, Row } from '../curve/ui';
import { CARD, CARD_STYLE, SHADOW } from '../curve/uiFormat';
import { AddLiquidityPanel } from './AddLiquidityPanel';
import { depositOffer, lpHeld, type DepositOffer } from './offers';
import { useLpWrites, type LpWrites } from './useLpWrites';

const ORIGIN_LABEL: Record<PoolView['origin'], string> = {
  'launch-pool': 'Launch pool: opened by the launch program when the token graduated',
  standard: 'At the standard address for its fee tier (anyone could have opened it)',
  other: 'At its own address (anyone could have opened it)',
};

const WITHDRAWALS_TEXT: Record<WithdrawalsState, string> = {
  open: 'Open',
  'switched-off': 'Switched off by the pool program’s admin',
  'vault-frozen': 'Blocked: one of the pool’s vaults is frozen by the token’s issuer',
};

function swapsText(h: PoolHealth): { text: string; tone: 'good' | 'warn' | 'bad' } {
  switch (h.swaps.state) {
    case 'open':
      return { text: 'Open', tone: 'good' };
    case 'switched-off':
      return { text: 'Switched off by the pool program’s admin', tone: 'bad' };
    case 'unread':
      return { text: `Not checked: ${h.swaps.detail}`, tone: 'warn' };
    case 'not-open-yet':
      return h.swaps.farFuture
        ? { text: `Blocked until ${formatWhen(h.swaps.opensAt)}. A pool set up like this cannot trade.`, tone: 'bad' }
        : { text: `Opens ${formatWhen(h.swaps.opensAt)}`, tone: 'warn' };
  }
}

const DEPOSIT_TITLE = {
  allowed: 'Deposits: the checks pass',
  refused: 'Deposits: refused here',
  unchecked: 'Deposits: not checked',
} as const;

function PriceRows({ price }: { price: PoolHealth['price'] }) {
  switch (price.state) {
    case 'empty-pool':
      return <Row label="Price" value="No price: one side is empty" mono={false} />;
    case 'no-trades-yet':
      return (
        <>
          <Row label="Price here" value={`1 token = ${formatSolPrice(price.pool)} SOL`} mono={false} />
          <Row label="Checked against" value="Nothing needed: nobody has traded since the launch program opened this pool at this price" mono={false} />
        </>
      );
    case 'skipped':
    case 'unread':
      return (
        <>
          <Row label="Price here" value={price.pool === null ? 'not worked out' : `1 token = ${formatSolPrice(price.pool)} SOL`} mono={false} />
          <Row label="Checked against" value={price.state === 'skipped' ? `Not compared: ${price.detail.replace(/^not compared, /, '')}` : `Nothing: ${price.detail}`} mono={false} />
        </>
      );
    case 'agrees':
    case 'disagrees':
      return (
        <>
          <Row label="Price here" value={`1 token = ${formatSolPrice(price.pool)} SOL`} mono={false} />
          <Row
            label={price.against === 'outside' ? 'Outside price (Jupiter)' : 'Its own average, last 30 minutes'}
            value={`1 token = ${formatSolPrice(price.reference)} SOL`}
            mono={false}
          />
          <Row label="Difference" value={`${(price.diff * 100).toFixed(1)}% ${price.diff >= 0 ? 'above' : 'below'}`} mono={false} />
        </>
      );
  }
}

export function PoolCard({
  view,
  health,
  tokenDecimals,
  safety = null,
  openNow = 0,
  onActed,
}: {
  view: PoolView;
  health: PoolHealth;
  tokenDecimals: number | null;
  /** The token's check, for the Add panel's warnings and its "calls itself" row. */
  safety?: TokenSafety | null;
  /** A wish's number (PoolFinder LpWish), or 0: open this pool's Add form by itself, once. */
  openNow?: number;
  /** Told when this card acts on a wish, so the finder spends it. */
  onActed?: (n: number) => void;
}) {
  const writes = useLpWrites();
  const offer: DepositOffer = writes
    ? depositOffer({ mode: writes.mode, gate: writes.gate, health, held: lpHeld(writes.pending.notes, view.address, 'add') })
    : 'off';
  const { pool } = view.snapshot;
  const swaps = swapsText(health);
  const cfg = view.config;
  const split = cfg ? feeSplit(cfg) : null;
  // cp-swap adjust_creator_fee_rate: the tier's rate, only when this pool's own switch is on.
  const creatorRate = cfg ? chargedCreatorFeeRate(cfg, pool.enableCreatorFee) : 0n;
  const solFees = view.solIsToken0 ? [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0] : [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1];
  const tokFees = view.solIsToken0 ? [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1] : [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0];
  const price = health.price;

  return (
    <li
      className={CARD}
      style={CARD_STYLE}
      data-testid="lp-pool"
      data-pool={view.address}
      data-origin={view.origin}
      data-swaps={health.swaps.state}
      data-withdrawals={health.withdrawals}
      data-deposits={health.deposits.verdict}
      data-price={price.state}
      data-add={offer}
    >
      <h3 className="text-white font-semibold text-[13px] mb-1" style={SHADOW}>
        {view.origin === 'launch-pool' ? 'Launch pool' : view.origin === 'standard' ? `Standard address, fee tier ${cfg?.index ?? '?'}` : 'Pool at its own address'}
      </h3>
      <p className="text-white/50 text-[11px] mb-2">{ORIGIN_LABEL[view.origin]}</p>
      {isCreatedPool(view.address) && (
        <p className="text-emerald-300/90 text-[12px] mb-2" data-testid="lp-opened-here">
          You opened this pool just now. Your share is under &apos;Your positions&apos;.
        </p>
      )}
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">
        <Row label="Pool address" value={view.address} />
        <Row label="Token" value={view.tokenMint} />

        <Row label="Swaps" value={swaps.text} mono={false} />
        <Row label="Withdrawals" value={WITHDRAWALS_TEXT[health.withdrawals]} mono={false} />
        <div data-testid="lp-pool-deposits">
          <p className={`text-[12px] font-semibold ${health.deposits.verdict === 'allowed' ? 'text-emerald-300/90' : health.deposits.verdict === 'refused' ? 'text-rose-300/90' : 'text-amber-300/90'}`}>
            {DEPOSIT_TITLE[health.deposits.verdict]}
          </p>
          {health.deposits.reasons.map((r) => (
            <Notice key={r} tone={health.deposits.verdict === 'refused' ? 'bad' : 'warn'}>{r}</Notice>
          ))}
          {!writes && health.deposits.verdict === 'allowed' && (
            <Notice>Adding liquidity from this page is not switched on yet. These checks will run again before any deposit.</Notice>
          )}
          {writes && <DepositOfferBlock writes={writes} offer={offer} view={view} health={health} safety={safety} tokenDecimals={tokenDecimals} openNow={openNow} onActed={onActed} />}
        </div>

        <Row label="In the pool" value={`${solText(view.solReserve)} and ${tokenText(view.tokenReserve, tokenDecimals)}`} mono={false} />
        <PriceRows price={price} />

        {cfg && split ? (
          <>
            {/* What a trade on THIS pool costs: its tier's trade fee, plus the creator fee when the pool's own switch is on. */}
            <Row label={`Fee tier ${cfg.index}`} value={`Traders pay ${tradeCostText(cfg, pool.enableCreatorFee)}`} mono={false} />
            <Row
              label="Of that fee"
              value={`LPs keep ${split.lpKeepsPct.toFixed(3)}% of each trade, the venue ${split.venueTakesPct.toFixed(3)}%${creatorRate > 0n ? `, the pool's creator ${ratePercent(creatorRate).toFixed(3)}%` : ''}`}
              mono={false}
            />
            {creatorRate > 0n && (
              <Row
                label="Creator fee"
                value={`${feeRateText(creatorRate)} a trade on top of the trade fee, paid to the wallet that opened this pool (Opened by, below), not to LPs`}
                mono={false}
              />
            )}
          </>
        ) : (
          <Notice tone="warn">This pool’s fee settings could not be read.</Notice>
        )}
        <Row label="Fees waiting: venue’s share" value={`${solText(solFees[0]!)} and ${tokenText(tokFees[0]!, tokenDecimals)}`} mono={false} />
        {pool.enableCreatorFee && (
          <Row label="Fees waiting: creator’s share" value={`${solText(solFees[1]!)} and ${tokenText(tokFees[1]!, tokenDecimals)}`} mono={false} />
        )}
        <Notice>
          LPs’ share of fees is not paid out separately: it stays in the pool, so each pool share is worth a little more after every trade.
        </Notice>
        <Row label="Pool shares issued" value={tokenText(pool.lpSupply, pool.lpMintDecimals, 'shares')} mono={false} />
        <Row label="Opened by" value={pool.poolCreator} />
      </div>
    </li>
  );
}

/** The line under a pool's deposit checks for each offer (spec 4.3), and the Add button and panel when offered. */
function DepositOfferBlock({
  writes,
  offer,
  view,
  health,
  safety,
  tokenDecimals,
  openNow,
  onActed,
}: {
  writes: LpWrites;
  offer: DepositOffer;
  view: PoolView;
  health: PoolHealth;
  safety: TokenSafety | null;
  tokenDecimals: number | null;
  openNow: number;
  onActed?: (n: number) => void;
}) {
  const key = `add:${view.address}`;
  const open = writes.active?.key === key;
  // The visitor asked for this lookup to end in the Add form: it opens by itself, once.
  const addButton = useRef<HTMLButtonElement | null>(null);
  const acted = useRef(0);
  const { open: openPanel, busy } = writes;
  useEffect(() => {
    if (!openNow || acted.current === openNow || offer !== 'offer') return;
    acted.current = openNow;
    // Already open, or another form is mid-flow: the press still shows where its form is.
    if (!open && !busy) openPanel('add', key, addButton.current);
    else addButton.current?.scrollIntoView?.({ block: 'center' });
    onActed?.(openNow);
  }, [openNow, offer, open, busy, openPanel, key, onActed]);
  // Another panel's flow is running: this one cannot open over it.
  const blockedByOther = writes.busy && !open;
  // An open panel stays mounted whatever the offer turns into while its flow runs: its
  // own sent deposit makes this pool `held`, and the outcome on screen must not vanish.
  const panel = open ? <AddLiquidityPanel view={view} health={health} safety={safety} tokenDecimals={tokenDecimals} onClose={writes.close} /> : null;
  return (
    <div className="space-y-2 mt-2">
      <OfferLine offer={offer} health={health} />
      {offer === 'offer' && (
        <>
          {/* Stays mounted while its panel is open, so focus can come back to it on Close. */}
          <button
            ref={addButton}
            type="button"
            className="btn-primary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60"
            disabled={blockedByOther}
            aria-expanded={open}
            onClick={(e) => writes.open('add', key, e.currentTarget)}
          >
            Add liquidity
          </button>
          {blockedByOther && <Notice>Finish or close the open liquidity panel first.</Notice>}
          <Notice>These checks run again, on fresh reads, when you press Review.</Notice>
        </>
      )}
      {panel}
    </div>
  );
}

function OfferLine({ offer, health }: { offer: DepositOffer; health: PoolHealth }) {
  switch (offer) {
    case 'paused-here':
      return <Notice>Adding liquidity from this site is paused. Removing it still works.</Notice>;
    case 'held':
      return <Notice tone="warn">A deposit you sent to this pool is not confirmed yet (see the top of this section).</Notice>;
    case 'checks':
      return health.deposits.verdict === 'unchecked' ? (
        <Notice>We offer adding liquidity only after checking the pool&apos;s price against a price from outside it, and we could not get one.</Notice>
      ) : null;
    case 'offer':
    case 'gate':
    case 'off':
      return null;
  }
}

export function UnreadPoolCard({ entry }: { entry: Extract<PoolEntry, { kind: 'unread' }> }) {
  return (
    <li className={CARD} style={CARD_STYLE} data-testid="lp-pool" data-pool={entry.address} data-deposits="unchecked" data-swaps="unread">
      <h3 className="text-white font-semibold text-[13px] mb-1" style={SHADOW}>Pool not read</h3>
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">
        <Row label="Pool address" value={entry.address} />
        <Notice tone="warn">We could not read this pool ({entry.detail}). Nothing about it is checked.</Notice>
      </div>
    </li>
  );
}
