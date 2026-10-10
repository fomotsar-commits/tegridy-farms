import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { isCreatedPool, type PoolEntry, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { PRICE_TOLERANCE, formatWhen, vaultFreezer, type PoolHealth, type PriceReference, type WithdrawalsState } from '../../../lib/solana/lp/poolHealth';
import { feeRateText, priceText, quoteText, tokenText, tradeCostText } from '../../../lib/solana/lp/format';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { noPriceClause } from '../../../lib/solana/lp/poolHealth';
import { TOO_NEW_WHY } from '../../../lib/solana/lp/ownPrice';
import { chargedCreatorFeeRate, feeSplit } from '../../../lib/solana/cpswap/venue';
import { ratePercent } from '../../../lib/solana/cpswap/math';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { poolEarned } from '../../../lib/solana/lp/poolGrowth';
import {
  POOL_PAST_AGAIN,
  POOL_PAST_BUTTON,
  POOL_PAST_READING,
  POOL_PAST_READ_MORE,
  olderPageProblem,
  pagePast,
  poolPastText,
  type PoolPastPage,
  type PoolTx,
} from '../../../lib/solana/lp/poolPast';
import { HISTORY_PAGES_MAX } from '../../../lib/solana/lp/txHistory';
import { Notice, Row } from '../curve/ui';
import { CARD, CARD_STYLE, SHADOW } from '../curve/uiFormat';
import { AddLiquidityPanel } from './AddLiquidityPanel';
import { depositOffer, lpHeld, type DepositOffer } from './offers';
import type { LpReaders } from './readers';
import { useLpWrites, type LpWrites } from './useLpWrites';
import { WholeDates } from './WholeDates';

const ORIGIN_LABEL: Record<PoolView['origin'], string> = {
  'launch-pool': 'Launch pool: opened by the launch program when the token graduated',
  standard: 'At the standard address for its fee tier (anyone could have opened it)',
  other: 'At its own address (anyone could have opened it)',
};

const withdrawalsText = (state: WithdrawalsState, quote: QuoteCoin): string =>
  state === 'open'
    ? 'Open'
    : state === 'switched-off'
      ? 'Switched off by the pool program’s admin'
      : `Blocked: one of the pool’s vaults is frozen by ${vaultFreezer(quote)}`;

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

/**
 * The heading over a pool's deposit checks. A pool that takes deposits WITH warnings
 * (owner ruling 2026-10-04: its price is off, it has no market price, its token copies a
 * name or can be frozen) is never called a clean pass: the heading says there are
 * warnings, in the warning colour, and they are listed under it.
 */
function depositHeading(d: PoolHealth['deposits']): { title: string; tone: string } {
  if (d.verdict === 'refused') return { title: 'Deposits: refused here', tone: 'text-rose-300/90' };
  if (d.verdict === 'unchecked') return { title: 'Deposits: not checked', tone: 'text-amber-300/90' };
  return d.warnings.length > 0
    ? { title: 'Deposits: the checks pass, with warnings', tone: 'text-amber-300/90' }
    : { title: 'Deposits: the checks pass', tone: 'text-emerald-300/90' };
}

/** How far a price is from what it was checked against, said once: "2.6% above", "1.2% below" (never "-1.2% below"). */
const differenceText = (diff: number) => `${(Math.abs(diff) * 100).toFixed(1)}% ${diff >= 0 ? 'above' : 'below'}`;

/** The row label for what a price was checked against. A Record, so a new reference must say. */
const REFERENCE_LABEL: Readonly<Record<PriceReference, string>> = {
  outside: 'Outside price (Jupiter)',
  'own-average': 'Its own average, last 30 minutes',
  'launch-pool': 'The launch pool’s price',
};

/** The pool's price and what it was checked against, both in the pool's own pairing coin. */
function PriceRows({ price, quote }: { price: PoolHealth['price']; quote: QuoteCoin }) {
  switch (price.state) {
    case 'empty-pool':
      return <Row label="Price" value="No price: one side is empty" mono={false} />;
    case 'no-market':
      // Jupiter ANSWERED that it has no market for the token. That is not a failed read,
      // so it is not "unread": the price is shown, and what it was not checked against.
      // When it is the pairing COIN Jupiter has no price for, the row names the coin:
      // the token has a price then, and "this token" would be wrong.
      return (
        <>
          <Row label="Price here" value={priceText(price.pool, quote)} mono={false} />
          <Row label="Checked against" value={`Nothing: ${noPriceClause(price.of, quote)}`} mono={false} />
        </>
      );
    case 'too-new':
      // A launch pool with no route and under ten minutes of trading. Read, not unread:
      // the price is shown, and why it was compared with nothing.
      return (
        <>
          <Row label="Price here" value={priceText(price.pool, quote)} mono={false} />
          <Row label="Checked against" value={`Nothing: ${TOO_NEW_WHY}`} mono={false} />
        </>
      );
    case 'no-trades-yet':
      return (
        <>
          <Row label="Price here" value={priceText(price.pool, quote)} mono={false} />
          <Row label="Checked against" value="Nothing needed: nobody has traded since the launch program opened this pool at this price" mono={false} />
        </>
      );
    case 'skipped':
    case 'unread':
      return (
        <>
          <Row label="Price here" value={price.pool === null ? 'not worked out' : priceText(price.pool, quote)} mono={false} />
          <Row label="Checked against" value={price.state === 'skipped' ? `Not compared: ${price.detail.replace(/^not compared, /, '')}` : `Nothing: ${price.detail}`} mono={false} />
        </>
      );
    case 'agrees':
    case 'disagrees':
      return (
        <>
          <Row label="Price here" value={priceText(price.pool, quote)} mono={false} />
          <Row
            label={REFERENCE_LABEL[price.against]}
            value={priceText(price.reference, quote)}
            mono={false}
          />
          {/* Further apart than the check allows is a warning (listed with the deposit checks), not a refusal: the row says which side of the line it is. */}
          <Row
            label="Difference"
            value={`${differenceText(price.diff)}${price.state === 'disagrees' ? `. That is more than ${Math.round(PRICE_TOLERANCE * 100)}% apart: see the warning above.` : ''}`}
            mono={false}
          />
        </>
      );
  }
}

/**
 * A wish that names this pool and cannot end in its Add form (PoolFinder `LpWish.pool`:
 * the pool refuses deposits, could not be checked or read, has a deposit pending, or
 * adding is paused). The card comes onto the screen and its heading takes focus, once,
 * so this pool's own reason is what the visitor reads, by eye, keyboard or screen
 * reader. Nothing else opens in its place.
 */
function useShownOnce(showNow: number, onActed: ((n: number) => void) | undefined, card: RefObject<HTMLLIElement | null>, heading: RefObject<HTMLHeadingElement | null>) {
  const shown = useRef(0);
  useEffect(() => {
    if (!showNow || shown.current === showNow) return;
    shown.current = showNow;
    heading.current?.focus({ preventScroll: true });
    card.current?.scrollIntoView?.({ block: 'start' });
    onActed?.(showNow);
  }, [showNow, onActed, card, heading]);
}

/**
 * Why a wish that named this pool did not end in its Add form, in one sentence. The card
 * shows it under its heading and the heading is described by it, so the reason is what a
 * screen reader says when focus lands there: the heading alone is only the pool's kind,
 * and two cards can carry the same one (review, 2026-10-04).
 */
function notOpenedWhy(offer: DepositOffer, health: PoolHealth): string {
  const reasons = health.deposits.reasons.join(' ');
  switch (offer) {
    case 'paused-here':
      return 'adding liquidity from this site is paused right now.';
    case 'held':
      return 'a deposit you sent to this pool is not confirmed yet.';
    case 'checks':
      return health.deposits.verdict === 'refused'
        ? `this pool does not pass the checks a deposit needs. ${reasons}`
        : `the checks a deposit needs could not be run on this pool. ${reasons}`;
    case 'gate':
    case 'off':
    case 'offer':
      return 'adding liquidity is not open right now.';
  }
}

/** The wish number this card was last shown for (`useShownOnce`), kept after the wish is spent. */
function useShownFor(showNow: number): number {
  const [shownFor, setShownFor] = useState(0);
  // Adjusted during render, so the line is on the page before the heading takes focus.
  if (showNow && showNow !== shownFor) setShownFor(showNow);
  return shownFor;
}

function WishWhy({ id, why }: { id: string; why: string }) {
  return (
    <div id={id} data-testid="lp-wish-why" className="mb-2 text-[12px] leading-relaxed">
      <Notice tone="warn">This is your position’s pool. Its Add form was not opened: {why}</Notice>
    </div>
  );
}

export function PoolCard({
  view,
  health,
  tokenDecimals,
  safety = null,
  chainNow = null,
  readers = null,
  openNow = 0,
  showNow = 0,
  onActed,
}: {
  view: PoolView;
  health: PoolHealth;
  tokenDecimals: number | null;
  /** The token's check, for the Add panel's warnings and its "calls itself" row. */
  safety?: TokenSafety | null;
  /** The chain's clock as read with the pools: the pace is measured to it, never to the device's. */
  chainNow?: bigint | null;
  /** For the pool's past, on a press only. Without `poolPast` no button is shown. */
  readers?: Pick<LpReaders, 'poolPast'> | null;
  /** A wish's number (PoolFinder LpWish), or 0: open this pool's Add form by itself, once. */
  openNow?: number;
  /** A wish's number, or 0: the wish named this pool and its form cannot open (`useShownOnce`). */
  showNow?: number;
  /** Told when this card acts on a wish, so the finder spends it. */
  onActed?: (n: number) => void;
}) {
  const cardRef = useRef<HTMLLIElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useShownOnce(showNow, onActed, cardRef, headingRef);
  const shownFor = useShownFor(showNow);
  const whyId = useId();
  const writes = useLpWrites();
  const offer: DepositOffer = writes
    ? depositOffer({ mode: writes.mode, gate: writes.gate, health, held: lpHeld(writes.pending.notes, view.address, 'add') })
    : 'off';
  // Gone as soon as the pool offers adding again: the button under the checks says so then.
  const why = shownFor && offer !== 'offer' ? notOpenedWhy(offer, health) : null;
  const { pool } = view.snapshot;
  const swaps = swapsText(health);
  const cfg = view.config;
  const split = cfg ? feeSplit(cfg) : null;
  // cp-swap adjust_creator_fee_rate: the tier's rate, only when this pool's own switch is on.
  const creatorRate = cfg ? chargedCreatorFeeRate(cfg, pool.enableCreatorFee) : 0n;
  const quoteFees = view.quoteIsToken0 ? [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0] : [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1];
  const tokFees = view.quoteIsToken0 ? [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1] : [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0];
  const price = health.price;
  const depositsHead = depositHeading(health.deposits);
  // What its shares have earned, from what the finder already read: no call of its own.
  const earned = poolEarned(view, chainNow);

  return (
    <li
      ref={cardRef}
      className={CARD}
      style={CARD_STYLE}
      data-testid="lp-pool"
      data-pool={view.address}
      data-origin={view.origin}
      data-quote={view.quote.symbol}
      data-swaps={health.swaps.state}
      data-withdrawals={health.withdrawals}
      data-deposits={health.deposits.verdict}
      data-price={price.state}
      data-add={offer}
    >
      <h3 ref={headingRef} tabIndex={-1} aria-describedby={why ? whyId : undefined} className="text-white font-semibold text-[13px] mb-1 outline-none" style={SHADOW}>
        {view.origin === 'launch-pool' ? 'Launch pool' : view.origin === 'standard' ? `Standard address, fee tier ${cfg?.index ?? '?'}` : 'Pool at its own address'}
      </h3>
      {why && <WishWhy id={whyId} why={why} />}
      <p className="text-white/50 text-[11px] mb-2">{ORIGIN_LABEL[view.origin]}</p>
      {isCreatedPool(view.address) && (
        <p className="text-emerald-300/90 text-[12px] mb-2" data-testid="lp-opened-here">
          You opened this pool just now. Your share is under &apos;Your positions&apos;.
        </p>
      )}
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">
        <Row label="Pool address" value={view.address} />
        <Row label="Token" value={view.tokenMint} />
        <Row label="Paired with" value={view.quote.symbol} mono={false} />

        <Row label="Swaps" value={swaps.text} mono={false} />
        <Row label="Withdrawals" value={withdrawalsText(health.withdrawals, view.quote)} mono={false} />
        <div data-testid="lp-pool-deposits">
          <p className={`text-[12px] font-semibold ${depositsHead.tone}`}>{depositsHead.title}</p>
          {health.deposits.reasons.map((r) => (
            <Notice key={r} tone={health.deposits.verdict === 'refused' ? 'bad' : 'warn'}>{r}</Notice>
          ))}
          {/* Said whatever the verdict is: a pool that is refused or unchecked for another reason still has them. */}
          {health.deposits.warnings.length > 0 && (
            <div data-testid="lp-pool-warnings" className="space-y-1">
              {health.deposits.verdict !== 'allowed' && <p className="text-amber-300/90 font-semibold">Warnings about this pool, apart from that:</p>}
              {health.deposits.warnings.map((w) => (
                <Notice key={w} tone="warn">{w}</Notice>
              ))}
            </div>
          )}
          {!writes && health.deposits.verdict === 'allowed' && (
            <Notice>Adding liquidity from this page is not switched on yet. These checks will run again before any deposit.</Notice>
          )}
          {writes && <DepositOfferBlock writes={writes} offer={offer} view={view} health={health} safety={safety} tokenDecimals={tokenDecimals} openNow={openNow} onActed={onActed} />}
        </div>

        <Row label="In the pool" value={`${quoteText(view.quoteReserve, view.quote)} and ${tokenText(view.tokenReserve, tokenDecimals)}`} mono={false} />
        <PriceRows price={price} quote={view.quote} />

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
        {/* Each is named for whose it is: neither is a liquidity provider's, and neither can be claimed by one. */}
        <Row label="Venue’s cut, not collected yet" value={`${quoteText(quoteFees[0]!, view.quote)} and ${tokenText(tokFees[0]!, tokenDecimals)}`} mono={false} />
        {pool.enableCreatorFee && (
          <Row label="Creator’s fee, not collected yet" value={`${quoteText(quoteFees[1]!, view.quote)} and ${tokenText(tokFees[1]!, tokenDecimals)}`} mono={false} />
        )}
        <Notice>
          LPs’ share of fees is not paid out separately: it stays in the pool, so each pool share is worth a little more after every trade.
        </Notice>
        {earned && (
          <div data-testid="lp-pool-earned" className="space-y-1 text-white/75">
            <p data-testid="lp-pool-trade">
              <WholeDates text={earned.trade} />
            </p>
            {earned.growth && (
              <p data-testid="lp-pool-growth">
                <WholeDates text={earned.growth} />
              </p>
            )}
            {earned.pace && <p data-testid="lp-pace">{earned.pace}</p>}
          </div>
        )}
        {readers?.poolPast && <PoolPastBlock view={view} readers={readers} />}
        <Row label="Pool shares issued" value={tokenText(pool.lpSupply, pool.lpMintDecimals, 'shares')} mono={false} />
        <Row label="Opened by" value={pool.poolCreator} />
      </div>
    </li>
  );
}

interface PastAnswer {
  /** Every entry read so far, newest first. */
  items: PoolTx[];
  more: boolean;
  pages: number;
}

const PAST_BUTTON = 'btn-secondary w-full sm:w-auto min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60';

/**
 * The pool's last transactions, on a press only: one signatures page and at most 20
 * transaction reads a press, behind the budget gate (poolPast.ts). A search can list 103
 * pools, so nothing here reads by itself. Read 20 more joins the older page's entries and
 * totals them again, up to HISTORY_PAGES_MAX pages. A failed read prints its reason and no
 * count. The first button and the status line stay mounted: focus stays, answers are read out.
 */
function PoolPastBlock({ view, readers }: { view: PoolView; readers: Pick<LpReaders, 'poolPast'> }) {
  const [answer, setAnswer] = useState<PastAnswer | null>(null);
  const [problem, setProblem] = useState<{ text: string; tone: 'info' | 'warn' } | null>(null);
  const [busy, setBusy] = useState(false);
  const againButton = useRef<HTMLButtonElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const ask = async (before?: string): Promise<PoolPastPage> => {
    try {
      // Called through its object, so a reader that needs `this` keeps it.
      return before === undefined ? await readers.poolPast!(view) : await readers.poolPast!(view, { before });
    } catch (e) {
      return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
    }
  };
  const said = (page: PoolPastPage, text: string) => setProblem({ text, tone: page.kind === 'paused' ? 'info' : 'warn' });
  const read = async (older: boolean) => {
    if (busy) return;
    const held = older ? answer : null;
    const oldest = held?.items[held.items.length - 1];
    if (older && (!held || !oldest)) return;
    setBusy(true);
    setProblem(null);
    const page = await ask(oldest?.signature);
    if (held) {
      // What was read stays; an older page joins it only when every entry of it was read.
      const why = olderPageProblem(page);
      if (page.kind === 'page' && why === null) {
        // Read 20 more leaves the page when nothing older is offered: focus goes to the button that stays.
        const offeredAgain = page.more && held.pages + 1 < HISTORY_PAGES_MAX;
        if (!offeredAgain && document.activeElement === moreButton.current) againButton.current?.focus();
        setAnswer({ items: [...held.items, ...page.items], more: page.more, pages: held.pages + 1 });
      } else if (why !== null) said(page, why);
    } else if (page.kind === 'page') setAnswer({ items: page.items, more: page.more, pages: 1 });
    else {
      setAnswer(null);
      said(page, poolPastText(page, view));
    }
    setBusy(false);
  };
  const past = answer ? pagePast({ kind: 'page', items: answer.items, more: answer.more }) : null;
  const canPage = past?.kind === 'ok' && answer !== null && answer.more && answer.pages < HISTORY_PAGES_MAX;
  const pastText = past ? poolPastText(past, view) : null;
  return (
    <div data-testid="lp-pool-past" data-past={past?.kind ?? 'idle'} className="relative space-y-2 text-white/75">
      {past && pastText !== null &&
        (past.kind === 'ok' ? (
          <p data-testid="lp-pool-past-text">
            <WholeDates text={pastText} />
          </p>
        ) : (
          <Notice tone="warn">{pastText}</Notice>
        ))}
      {problem && <Notice tone={problem.tone}>{problem.text}</Notice>}
      <div className="flex flex-col sm:flex-row gap-2">
        {canPage && (
          <button ref={moreButton} type="button" className={PAST_BUTTON} aria-disabled={busy} onClick={() => void read(true)}>
            {POOL_PAST_READ_MORE}
          </button>
        )}
        {/* Always here: pressing it never takes it off the page, so focus stays on it. */}
        <button ref={againButton} type="button" className={PAST_BUTTON} aria-disabled={busy} onClick={() => void read(false)}>
          {past ? POOL_PAST_AGAIN : POOL_PAST_BUTTON}
        </button>
      </div>
      {/* Always there, so the reading line and each answer are read out when they arrive. */}
      <p role="status" className={busy ? undefined : 'sr-only'}>
        {busy ? POOL_PAST_READING : problem?.text ?? pastText ?? ''}
      </p>
    </div>
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
  const blockRef = useRef<HTMLDivElement | null>(null);
  const acted = useRef(0);
  const { open: openPanel, busy } = writes;
  useEffect(() => {
    if (!openNow || acted.current === openNow || offer !== 'offer') return;
    acted.current = openNow;
    // Already open, or another form is mid-flow: the press still shows where its form is.
    if (!open && !busy) openPanel('add', key, addButton.current);
    else (blockRef.current?.querySelector('h4') ?? addButton.current)?.scrollIntoView?.({ block: 'start' });
    onActed?.(openNow);
  }, [openNow, offer, open, busy, openPanel, key, onActed]);
  // Another panel's flow is running: this one cannot open over it.
  const blockedByOther = writes.busy && !open;
  // An open panel stays mounted whatever the offer turns into while its flow runs: its
  // own sent deposit makes this pool `held`, and the outcome on screen must not vanish.
  const panel = open ? <AddLiquidityPanel view={view} health={health} safety={safety} tokenDecimals={tokenDecimals} onClose={writes.close} /> : null;
  return (
    <div ref={blockRef} className="space-y-2 mt-2">
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
      // Not about the outside price alone any more: a pool with no market price at all is
      // offered, with a warning. What stops it here is a check that could not be RUN (the
      // reasons above say which), and a read that failed is never taken as a pass.
      return health.deposits.verdict === 'unchecked' ? (
        <Notice>We offer adding liquidity only when every check above could be run, and one of them could not be run just now.</Notice>
      ) : null;
    case 'offer':
    case 'gate':
    case 'off':
      return null;
  }
}

export function UnreadPoolCard({
  entry,
  showNow = 0,
  onActed,
}: {
  entry: Extract<PoolEntry, { kind: 'unread' }>;
  /** As on PoolCard: a wish named this pool, and a pool that was not read opens no form. */
  showNow?: number;
  onActed?: (n: number) => void;
}) {
  const cardRef = useRef<HTMLLIElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useShownOnce(showNow, onActed, cardRef, headingRef);
  const shownFor = useShownFor(showNow);
  const whyId = useId();
  return (
    <li ref={cardRef} className={CARD} style={CARD_STYLE} data-testid="lp-pool" data-pool={entry.address} data-deposits="unchecked" data-swaps="unread">
      <h3 ref={headingRef} tabIndex={-1} aria-describedby={shownFor ? whyId : undefined} className="text-white font-semibold text-[13px] mb-1 outline-none" style={SHADOW}>Pool not read</h3>
      {shownFor > 0 && <WishWhy id={whyId} why="this pool could not be read just now. Press Add more liquidity on your position again in a minute." />}
      <div className="text-white/60 text-[11px] leading-relaxed space-y-2">
        <Row label="Pool address" value={entry.address} />
        <Notice tone="warn">We could not read this pool ({entry.detail}). Nothing about it is checked.</Notice>
      </div>
    </li>
  );
}
