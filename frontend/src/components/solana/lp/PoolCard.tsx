import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { isCreatedPool, type PoolEntry, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { PRICE_TOLERANCE, formatWhen, vaultFreezer, type PoolHealth, type PriceReference, type WithdrawalsState } from '../../../lib/solana/lp/poolHealth';
import { feeRateText, priceText, quoteText, tokenText, tradeCostText } from '../../../lib/solana/lp/format';
import { pairAccessibleName, pairLabel, registryToken } from '../../../lib/solana/lp/identity';
import { detailOf } from '../../../lib/solana/lp/ledger';
import { POOL_PAST_BUTTON, lastTrade, lastTradeText, poolPastText, type PoolPastRead } from '../../../lib/solana/lp/poolPast';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
import { USD_LINES, usdOfPool, usdText } from '../../../lib/solana/lp/usd';
import { chargedCreatorFeeRate, feeSplit } from '../../../lib/solana/cpswap/venue';
import { ratePercent } from '../../../lib/solana/cpswap/math';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { ArtCard } from '../../ui/ArtCard';
import { Notice, Row } from '../curve/ui';
import { BODY, HEAD, HINT, LP_SCRIM, SHADOW } from '../curve/uiFormat';
import { AddLiquidityPanel } from './AddLiquidityPanel';
import { AddressRow } from './AddressRow';
import { depositOffer, lpHeld, type DepositOffer } from './offers';
import { ReadAt } from './ReadAt';
import type { LpReaders } from './readers';
import { useLpWrites, type LpWrites } from './useLpWrites';
import { useUsdPrices } from './useUsdPrices';

/** Where the pool sits, in a few words under its heading. The heading itself is the pair and the tier (identity.ts). */
const ORIGIN_WORDS: Record<PoolView['origin'], string> = {
  'launch-pool': 'Launch pool, opened by the launch program when the token graduated',
  standard: 'Standard address for its tier',
  other: 'At its own address',
};

/** The token's unit in an amount: the registry's symbol for a listed token, else "tokens" (format.ts's own word). */
const tokenUnit = (mint: string): string => registryToken(mint)?.symbol ?? 'tokens';

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
      return (
        <>
          <Row label="Price here" value={priceText(price.pool, quote)} mono={false} />
          <Row label="Checked against" value="Nothing: Jupiter has no market price for this token" mono={false} />
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
 * What a wish that names this pool asked for (PoolFinder `LpWish`). 'add': its Add form,
 * which cannot open (the pool refuses deposits, could not be checked or read, has a
 * deposit pending, or adding is paused), so the card says why under its heading. 'show':
 * the card alone (a pointer on the "Open a new pool" card, a press in the venue's list),
 * so nothing is said about a form: nothing was asked to open.
 */
export type ShownAs = 'add' | 'show';

/**
 * A wish that names this pool and ends on its card (`ShownAs`). The card comes onto the
 * screen and its heading takes focus, once, so this pool's own words are what the visitor
 * reads, by eye, keyboard or screen reader. Nothing else opens in its place.
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
 * screen reader says when focus lands there (review, 2026-10-04).
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

/**
 * The wish this card was last shown for (`useShownOnce`): its number and what it asked,
 * both kept after the wish is spent. The finder forgets a spent wish, so the kind is
 * remembered here with the number: read live, a spent 'show' would read as 'add'.
 */
function useShownFor(showNow: number, as: ShownAs): { n: number; as: ShownAs } {
  const [shownFor, setShownFor] = useState<{ n: number; as: ShownAs }>({ n: 0, as: 'add' });
  // Adjusted during render, so the line is on the page before the heading takes focus.
  if (showNow && showNow !== shownFor.n) setShownFor({ n: showNow, as });
  return shownFor;
}

function WishWhy({ id, why }: { id: string; why: string }) {
  return (
    <div id={id} data-testid="lp-wish-why" className="mb-2 text-[13px] leading-relaxed">
      <Notice tone="warn">This is your position’s pool. Its Add form was not opened: {why}</Notice>
    </div>
  );
}

/** The chain's own clock when the pool was read (the Clock sysvar in the same batch), or that it was not read. Never the device's. */
const chainClockText = (chainNow: bigint | null | undefined): string => `Chain clock at the read: ${chainNow === null || chainNow === undefined ? 'not read' : formatWhen(chainNow)}`;

/** The heading's classes: the kit's size, focusable by script only (a wish lands here), no focus ring of its own. */
const HEADING_CLS = `${HEAD} mb-1 outline-none`;

export function PoolCard({
  view,
  health,
  tokenDecimals,
  safety = null,
  openNow = 0,
  showNow = 0,
  shownAs = 'add',
  onActed,
  readers,
  readAt,
  chainNow,
}: {
  view: PoolView;
  health: PoolHealth;
  tokenDecimals: number | null;
  /** The token's check, for the Add panel's warnings and its "calls itself" row. */
  safety?: TokenSafety | null;
  /** A wish's number (PoolFinder LpWish), or 0: open this pool's Add form by itself, once. */
  openNow?: number;
  /** A wish's number, or 0: the wish named this pool and ends on its card (`useShownOnce`). */
  showNow?: number;
  /** What `showNow` asked for: a form that cannot open, or the card alone (`ShownAs`). */
  shownAs?: ShownAs;
  /** Told when this card acts on a wish, so the finder spends it. */
  onActed?: (n: number) => void;
  /** For the pool past, on a press only. Without `poolPast` (a build without it) no button is shown. */
  readers?: Pick<LpReaders, 'poolPast'> | null;
  /** The device's clock (ms) when this pool was read, for the stamp; left out, no stamp. */
  readAt?: number;
  /** The chain's clock at that read (the Clock sysvar), or null when it was not read. */
  chainNow?: bigint | null;
}) {
  const cardRef = useRef<HTMLLIElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useShownOnce(showNow, onActed, cardRef, headingRef);
  const shownFor = useShownFor(showNow, shownAs);
  const whyId = useId();
  const writes = useLpWrites();
  const usd = useUsdPrices(0);
  const offer: DepositOffer = writes
    ? depositOffer({ mode: writes.mode, gate: writes.gate, health, held: lpHeld(writes.pending.notes, view.address, 'add') })
    : 'off';
  // Said only for a form that was asked for, and gone as soon as the pool offers adding
  // again: the button under the checks says so then.
  const why = shownFor.n && shownFor.as === 'add' && offer !== 'offer' ? notOpenedWhy(offer, health) : null;
  // The explorer link comes with the write code (lpWriteApi.ts, the one path into write/); until it loads there is none.
  const explorer = (address: string): string | null => (writes?.api && writes.cfg ? writes.api.explorerAddressUrl(address, writes.cfg.cluster) : null);
  const { pool } = view.snapshot;
  const swaps = swapsText(health);
  const bothOpen = health.swaps.state === 'open' && health.withdrawals === 'open';
  const cfg = view.config;
  const split = cfg ? feeSplit(cfg) : null;
  // cp-swap adjust_creator_fee_rate: the tier's rate, only when this pool's own switch is on.
  const creatorRate = cfg ? chargedCreatorFeeRate(cfg, pool.enableCreatorFee) : 0n;
  const quoteFees = view.quoteIsToken0 ? [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0] : [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1];
  const tokFees = view.quoteIsToken0 ? [pool.protocolFeesToken1 + pool.fundFeesToken1, pool.creatorFeesToken1] : [pool.protocolFeesToken0 + pool.fundFeesToken0, pool.creatorFeesToken0];
  const price = health.price;
  const depositsHead = depositHeading(health.deposits);
  const unit = tokenUnit(view.tokenMint);
  // A dollar line only behind the committed switch (usd.ts), and only from a price that was read.
  const usdPool = USD_LINES === 'on' ? usdText(usdOfPool(view.quoteReserve, view.quote, usd.prices)) : null;
  const usdAge = usd.readAt === null ? null : Math.max(0, Math.floor((Date.now() - usd.readAt) / 1000));

  return (
    <li
      ref={cardRef}
      className="scroll-mt-[4.5rem]"
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
      <ArtCard pageId="solana-lp" idx={3} scrim={LP_SCRIM}>
        <h3 ref={headingRef} tabIndex={-1} aria-label={pairAccessibleName(view)} aria-describedby={why ? whyId : undefined} className={HEADING_CLS} data-text-role="head" style={SHADOW}>
          {pairLabel(view)}
        </h3>
        {why && <WishWhy id={whyId} why={why} />}
        <div className={`${HINT} mb-2 space-y-1`} data-text-role="hint">
          <p>{ORIGIN_WORDS[view.origin]}</p>
          <AddressRow label="Pool address" value={view.address} explorerUrl={explorer(view.address)} />
        </div>
        {isCreatedPool(view.address) && (
          <p className="text-emerald-300/90 text-[13px] mb-2" data-testid="lp-opened-here">
            You opened this pool just now. Your share is under &apos;Your positions&apos;.
          </p>
        )}
        <div className={`${BODY} leading-relaxed space-y-2`} data-text-role="body">
          {bothOpen ? (
            <p data-testid="lp-pool-status">Swaps: open · Withdrawals: open</p>
          ) : (
            <>
              <Row label="Swaps" value={swaps.text} mono={false} />
              <Row label="Withdrawals" value={withdrawalsText(health.withdrawals, view.quote)} mono={false} />
            </>
          )}

          <Row label="In the pool" value={`${quoteText(view.quoteReserve, view.quote)} and ${tokenText(view.tokenReserve, tokenDecimals, unit)}`} mono={false} />
          {usdPool !== null && usdAge !== null && (
            <p className={HINT} data-text-role="hint" data-testid="lp-pool-usd">
              {usdPool}, both sides at this pool’s own price, at Jupiter’s {view.quote.symbol} price read {usdAge} s ago
            </p>
          )}
          <PriceRows price={price} quote={view.quote} />
          {/* The program's own record: `initialized` flips only on a swap (poolPast.ts). The time, never the word "active". */}
          <p data-testid="lp-pool-trade">{quoteFees[0]! > 0n || tokFees[0]! > 0n ? 'Last trade: this pool has booked fees' : lastTradeText(lastTrade(view))}</p>

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
          {/* When these figures were read. The lookup's one Read again is in the finder's form, above the list. */}
          {readAt !== undefined && <ReadAt at={readAt} />}

          <div data-testid="lp-pool-deposits">
            <p className={`text-[13px] font-semibold ${depositsHead.tone}`}>{depositsHead.title}</p>
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

          {/* The venue's own books and the pool's accounts, out of the LP's way: nothing here is the LP's to claim. */}
          <details data-testid="lp-pool-more" className="pt-1">
            <summary className="cursor-pointer list-none min-h-[44px] flex items-center text-white font-semibold [overflow-wrap:anywhere]">More about this pool</summary>
            <div className="space-y-2 pt-2">
              <Row label="Paired with" value={view.quote.symbol} mono={false} />
              <Row label="Venue’s share of fees waiting" value={`${quoteText(quoteFees[0]!, view.quote)} and ${tokenText(tokFees[0]!, tokenDecimals, unit)}`} mono={false} />
              {pool.enableCreatorFee && (
                <Row label="Creator’s share of fees waiting" value={`${quoteText(quoteFees[1]!, view.quote)} and ${tokenText(tokFees[1]!, tokenDecimals, unit)}`} mono={false} />
              )}
              <Notice>Fees stay in the pool, so each share is worth a little more after every trade. There is nothing to claim.</Notice>
              <Row label="Pool shares issued" value={tokenText(pool.lpSupply, pool.lpMintDecimals, 'shares')} mono={false} />
              <Row label="Opened by" value={pool.poolCreator} />
              <AddressRow label="Token" value={view.tokenMint} explorerUrl={explorer(view.tokenMint)} />
              <p>{chainClockText(chainNow)}</p>
              {readers?.poolPast && <PoolPastBlock view={view} readers={readers} />}
            </div>
          </details>
        </div>
      </ArtCard>
    </li>
  );
}

/**
 * The pool's last 20 transactions, on a press (poolPast.ts: one signatures page, one batch,
 * the budget gate). Never on page load. After a read the sentence stands with its own stamp
 * and Read again; a press while a read runs does nothing more. The reader is called through
 * its object, so a reader that needs `this` keeps it.
 */
function PoolPastBlock({ view, readers }: { view: PoolView; readers: Pick<LpReaders, 'poolPast'> }) {
  const [last, setLast] = useState<{ read: PoolPastRead; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const read = async () => {
    if (busy || !readers.poolPast) return;
    setBusy(true);
    let got: PoolPastRead;
    try {
      got = await readers.poolPast(view);
    } catch (e) {
      got = { kind: 'unread', detail: detailOf(e) };
    }
    if (!live.current) return;
    setLast({ read: got, at: Date.now() });
    setBusy(false);
  };
  return (
    <div data-testid="lp-pool-past" className="space-y-2">
      {last === null ? (
        <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60" aria-disabled={busy} onClick={() => void read()}>
          {POOL_PAST_BUTTON}
        </button>
      ) : (
        <>
          <p data-testid="lp-pool-past-text" data-kind={last.read.kind}>{poolPastText(last.read, view)}</p>
          <ReadAt at={last.at} onReadAgain={() => void read()} busy={busy} />
        </>
      )}
      {busy && (
        <p role="status" className={HINT} data-text-role="hint">
          Reading this pool’s last 20 transactions…
        </p>
      )}
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
            className="btn-primary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60 scroll-mt-[4.5rem]"
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
  shownAs = 'add',
  onActed,
}: {
  entry: Extract<PoolEntry, { kind: 'unread' }>;
  /** As on PoolCard: a wish named this pool, and a pool that was not read opens no form. */
  showNow?: number;
  /** As on PoolCard: what `showNow` asked for. */
  shownAs?: ShownAs;
  onActed?: (n: number) => void;
}) {
  const cardRef = useRef<HTMLLIElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useShownOnce(showNow, onActed, cardRef, headingRef);
  const shownFor = useShownFor(showNow, shownAs);
  const whyId = useId();
  // A form was asked for and this pool, unread, cannot open one.
  const why = shownFor.n > 0 && shownFor.as === 'add';
  return (
    <li ref={cardRef} className="scroll-mt-[4.5rem]" data-testid="lp-pool" data-pool={entry.address} data-deposits="unchecked" data-swaps="unread">
      <ArtCard pageId="solana-lp" idx={4} scrim={LP_SCRIM}>
        <h3 ref={headingRef} tabIndex={-1} aria-describedby={why ? whyId : undefined} className={HEADING_CLS} data-text-role="head" style={SHADOW}>
          Pool not read
        </h3>
        {why && <WishWhy id={whyId} why="this pool could not be read just now. Press Add more liquidity on your position again in a minute." />}
        <div className={`${BODY} leading-relaxed space-y-2`} data-text-role="body">
          <AddressRow label="Pool address" value={entry.address} />
          <Notice tone="warn">We could not read this pool ({entry.detail}). Nothing about it is checked.</Notice>
        </div>
      </ArtCard>
    </li>
  );
}
