import { useEffect, useId, useRef, useState } from 'react';
import { formatSol } from '../../../lib/launcher/solana/curve/format';
import { tokenReasons, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import { isCreatedPool, type PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { tradeCostText } from '../../../lib/solana/lp/format';
import { CREATOR_FEE_SWITCH } from '../../../lib/solana/cpswap/venue';
import { QUOTE_COINS_OR } from '../../../lib/solana/lp/quotes';
import { Notice } from '../curve/ui';
import { CARD, CARD_STYLE, SHADOW } from '../curve/uiFormat';
import type { CreateFacts, TierState } from '../curve/ports';
import { CreatePoolPanel } from './CreatePoolPanel';
import { MONEY_NOTE } from './LpDisclosures';
import { createOffer, depositOffer, launchPoolCheck, lpHeld, openingCautions, pairFacts, poolListCut, type CreateOffer, type PairFacts } from './offers';
import { coinAbout } from './panelKit';
import { useLpWrites, type LpWrites } from './useLpWrites';

const NATIVE_2022_LINE = `This is SOL under the newer token program. Pools here pair a token with ${QUOTE_COINS_OR}.`;

/** Coin names in a sentence: "USDC", "USDC or BAYLA", "SOL, USDC or BAYLA". */
const orList = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);
const solFee = (lamports: bigint) => formatSol(lamports, 9);

/**
 * "Open a new pool", under a token's pool list (SPEC_S2_CREATE 4.2). Only with an
 * `LpWritesProvider` above it (LP's switch not 'off'); without one it renders nothing.
 *
 * One line per `createOffer` answer, and the **Open a pool** button only for `offer`.
 * Every input it judges was read for this search: the token, its pools and their
 * checks (`healths`, the same the pool cards show), Jupiter's price, and the public fee
 * tier and the fee account (`createFacts`). Unread is never "no": each unread input has
 * its own line, and most have a **Read again**.
 *
 * A pool that already exists never takes the button away. The card names the pool to add
 * to first (`createAdvice`: one this tab opened, else the biggest passing pool on the
 * public tier) and says a new pool is separate; the choice is the opener's.
 *
 * ANY TOKEN MAY HAVE A POOL (owner ruling 2026-10-04). A token that copies a well-known
 * name, one its creator can freeze, and one with no market price are offered like any
 * other. The card says each as a warning before its buttons (`openingCautions`), the form
 * says them again above Review, and the review screen once more. Only a token that is
 * absent or blocked is refused, in the words of the check that blocked it.
 *
 * ONE ANSWER PER PAIRING COIN (`pairFacts`). A new pool pairs the token with SOL, USDC or
 * BAYLA, and the pool to add to instead is one paired with the same coin. So each coin
 * that has such a pool gets its own line and its own Add button, what a pool holds is
 * said in that pool's own coin, and the card says which coins have no pool yet. The coin
 * itself is chosen in the form.
 */
export function CreatePoolCard(p: {
  mint: string;
  safety: TokenSafety;
  decimals: number | null;
  search: PoolSearchRead;
  healths: ReadonlyMap<string, PoolHealth>;
  outside: OutsidePrice | null;
  /** When Jupiter's price was read (ms), for the panel's "read at" time. */
  outsideAt: number | null;
  /** Search the same token again (pools, token and price). */
  onReread: () => void;
  /** The search on screen is the last answer, shown while the same token is read again. */
  refreshing?: boolean;
  /**
   * A wish's number (PoolFinder LpWish), or 0: the visitor asked for this lookup to end in
   * the form. It opens by itself once the card can offer it; when the card settles on
   * anything else, the card is brought onto the screen so its reason is what they see.
   */
  openNow?: number;
  /** Told when this card acts on a wish, so the finder spends it. */
  onActed?: (n: number) => void;
}) {
  const writes = useLpWrites();
  if (!writes) return null;
  return <CreateCard {...p} writes={writes} />;
}

function CreateCard({
  mint,
  safety,
  decimals,
  search,
  healths,
  outside,
  outsideAt,
  onReread,
  refreshing = false,
  openNow = 0,
  onActed,
  writes,
}: Parameters<typeof CreatePoolCard>[0] & { writes: LpWrites }) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const facts = writes.createFacts;
  // Anything this card judges is being read again: the search, or the create facts.
  const reading = refreshing || writes.createFactsReading;
  const offer: CreateOffer = createOffer({
    mode: writes.mode,
    gate: writes.gate,
    facts,
    notes: writes.pending.notes,
    safety,
    outside,
    search,
    healths,
  });
  // One answer per coin the token can be paired with. A pool to add to is said beside an
  // offer only: a stopped card has its own line, and names no pool to add to.
  // Worked out on every render, not kept: what this tab opened can change between two reads.
  const pairs = pairFacts({ tokenMint: mint, gate: writes.gate, search, healths, openedHere: isCreatedPool, advise: offer === 'offer' });
  // The pools the card points to, one per coin at most, SOL's first.
  const pointers = pairs.flatMap((x) => (x.advice.kind === 'none' ? [] : [{ coin: x.coin, kind: x.advice.kind, pool: x.advice.pool }]));
  const answer = answerKey(offer, pairs, facts, outside, search, healths);
  // What the opener is warned about before any button. Only beside an offer: a stopped card has no button.
  // With no route, an opening price is compared with the launch pool this search read (opening.ts).
  const launchPrice = launchPoolCheck(mint, search, healths);
  const cautions = offer === 'offer' ? openingCautions(safety, outside, launchPrice) : [];
  // A pressed Read again: what the card said before, until the new answer is in.
  const [asked, setAsked] = useState<string | null>(null);
  const [said, setSaid] = useState<'same' | 'changed' | null>(null);
  if (asked !== null && !reading) {
    setAsked(null);
    setSaid(asked === answer ? 'same' : 'changed');
  }
  const readAgain = (run: () => void) => () => {
    if (reading) return;
    setAsked(answer);
    setSaid(null);
    run();
  };
  const key = `create:${mint}`;
  const open = writes.active?.key === key;
  // Each wish acts once, and only on a settled answer: never on "checking", never on a re-read.
  const sectionRef = useRef<HTMLElement | null>(null);
  const openButton = useRef<HTMLButtonElement | null>(null);
  const acted = useRef(0);
  const settled = offer !== 'checking' && !reading;
  const { open: openPanel, busy } = writes;
  // Whichever coin it is paired with: one pool to add to is enough to show the card first.
  const pointsTo = pointers.length > 0;
  useEffect(() => {
    if (!openNow || acted.current === openNow || !settled) return;
    acted.current = openNow;
    // Not offered, already open, or another form is mid-flow: the card comes onto the
    // screen, so the press shows its reason (or its open form) instead of doing nothing.
    // An open form's own heading, when there is one: the card's top would leave it below the screen.
    // A token that already has a pool to add to is not taken straight into the open-a-pool
    // form either: the card comes onto the screen with both choices (add to that pool, or
    // open another), so the pool it points to is seen before a second one is opened.
    if (offer !== 'offer' || pointsTo || open || busy) (sectionRef.current?.querySelector('h4') ?? sectionRef.current)?.scrollIntoView?.({ block: 'start' });
    else openPanel('create', key, openButton.current, headingRef.current);
    onActed?.(openNow);
  }, [openNow, settled, offer, pointsTo, open, busy, openPanel, key, onActed]);
  // A pool the card points to (createAdvice) gets a button, not only words: asked to
  // create a pool for a token that has one, a phone ended on a card with nothing to press
  // for it (phone walk of the build, 2026-10-03, the day the first BAYLA pool was
  // opened). Offered when that pool takes deposits right now, by the same rule its own
  // Add button follows. It sits beside Open a pool, which stays: a token may have as
  // many pools as people open (owner ruling 2026-10-03). One button per pool pointed to,
  // and with more than one each says its coin, so "that pool" is never a guess.
  // Not for a pool whose price is off the market: this card does not suggest adding to
  // it (`adviceCaveat`), so it puts no button for that here. The pool's own card keeps
  // its Add button.
  const { mode, gate } = writes;
  const notes = writes.pending.notes;
  const addInstead = pointers.filter(({ pool }) => {
    const health = healths.get(pool.address);
    return !!health && adviceCaveat(health)?.add !== false && gate?.kind === 'open' && depositOffer({ mode, gate, health, held: lpHeld(notes, pool.address, 'add') }) === 'offer';
  });
  if (offer === 'off') return null;

  // Another panel's flow is running: this one cannot open over it.
  const blockedByOther = writes.busy && !open;
  const tier: TierState | null = facts?.tier ?? null;

  return (
    <section
      ref={sectionRef}
      className={`${CARD} scroll-mt-[4.5rem]`}
      style={CARD_STYLE}
      data-testid="lp-create"
      data-create={offer}
      // The first pool pointed to, SOL's before any other coin's; each line below names its own coin.
      data-advice={pointers[0]?.kind ?? 'none'}
      aria-labelledby={headingId}
      aria-busy={reading}
    >
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="text-white font-semibold text-[13px] mb-2 outline-none" style={SHADOW}>
        Open a new pool
      </h3>
      <div className="text-white/70 text-[12px] leading-relaxed space-y-2">
        {/* A changed answer is read out as it lands. */}
        <div aria-live="polite" className="space-y-2">
          <OfferLines
            offer={offer}
            pairs={pairs}
            facts={facts}
            safety={safety}
            outside={outside}
            search={search}
            healths={healths}
            busy={reading}
            onReread={readAgain(onReread)}
            onRereadFacts={readAgain(writes.refreshCreateFacts)}
          />
          {/* Warnings, never a stop: the buttons below stay. The same lead-in as the forms and the review. */}
          {cautions.length > 0 && (
            <div className="space-y-1" data-testid="lp-create-cautions">
              <Notice tone="warn">Read these about this token first:</Notice>
              <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5">
                {cautions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {/* What the last Read again found, so the same answer is not silence. */}
        <p role="status" className="text-white/55 text-[11px]" data-testid="lp-create-reread">
          {asked !== null ? 'Reading again…' : said === 'same' ? 'Read again just now: the same answer.' : said === 'changed' ? 'Read again just now: the answer above is new.' : ''}
        </p>
        {addInstead.length > 0 && (
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
            {addInstead.map(({ coin, pool }) => (
              <button
                key={pool.address}
                type="button"
                className="btn-primary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60"
                disabled={writes.busy}
                data-coin={coin.symbol}
                onClick={(e) => writes.open('add', `add:${pool.address}`, e.currentTarget)}
              >
                {pointers.length > 1 ? `Add liquidity to the ${coin.symbol} pool` : 'Add liquidity to that pool'}
              </button>
            ))}
          </div>
        )}
        {offer === 'offer' && (
          <>
            <p className="text-white/60 text-[11px]">{MONEY_NOTE}</p>
            {/* Stays mounted while its panel is open, so focus can come back to it on Close. */}
            <button
              ref={openButton}
              type="button"
              // Beside "Add liquidity to that pool" this is the second choice, and looks it.
              className={`${addInstead.length > 0 ? 'btn-secondary' : 'btn-primary'} w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60`}
              disabled={blockedByOther}
              aria-expanded={open}
              onClick={(e) => writes.open('create', key, e.currentTarget, headingRef.current)}
            >
              Open a pool
            </button>
            {blockedByOther && <Notice>Finish or close the open liquidity panel first.</Notice>}
          </>
        )}
        {/* An open panel stays mounted whatever the card says while its flow runs: its own
            sent opening holds every opening, and the outcome on screen must not vanish. */}
        {open && (
          <CreatePoolPanel
            mint={mint}
            safety={safety}
            decimals={decimals}
            outside={outside}
            outsideAt={outsideAt}
            launchPrice={launchPrice}
            tier={tier}
            pairs={pairs}
            cut={poolListCut(search)}
            offer={offer}
            reading={reading}
            onClose={writes.close}
            onReread={onReread}
          />
        )}
      </div>
    </section>
  );
}

/**
 * A pool whose price is more than 3% from its reference takes deposits now, with a
 * warning (owner ruling 2026-10-04). It is still named as the pool that exists, but this
 * card never says "we suggest adding to it" of a pool that a deposit would lose money
 * in. What it says instead, or null for a pool whose price is not off. The pool's own
 * card shows its price and the price it was checked against, so neither is repeated here.
 */
function offMarketLine(health: PoolHealth | undefined): string | null {
  if (health?.price.state !== 'disagrees') return null;
  const { diff } = health.price;
  const gap = `${(Math.abs(diff) * 100).toFixed(1)}% ${diff > 0 ? 'above' : 'below'}`;
  return `Its price is ${gap} the price it is checked against (its card above shows both), so we do not suggest adding to it now: a deposit there would pay for that gap.`;
}

/**
 * What this card says of a pool it points to whose price check did not simply pass, and
 * whether it still puts an Add button for it; null for a pool whose price agrees.
 *   - off its reference: named, not suggested, no button here (`offMarketLine`);
 *   - no market price at all (Jupiter has no route for the token): its price was compared
 *     with nothing, so the card must not say it "passes the checks" or "we suggest". It
 *     says what was not checked and what each choice means, and keeps the button: for a
 *     token with no market, the pool that exists may well be the right place.
 */
function adviceCaveat(health: PoolHealth | undefined): { line: string; add: boolean } | null {
  const off = offMarketLine(health);
  if (off) return { line: off, add: false };
  if (health?.price.state === 'no-market') {
    return {
      line: 'Jupiter has no market price for this token, so that pool’s price was not checked against anything. Adding to it keeps liquidity in one place; a pool of your own starts at the price you set.',
      add: true,
    };
  }
  return null;
}

/** Why some pool for this token could not be read or checked, in a few words. */
function poolsUnreadDetail(search: PoolSearchRead, healths: ReadonlyMap<string, PoolHealth>): string {
  if (search.kind !== 'ok') return search.detail;
  const s = search.search;
  if (s.index.kind !== 'ok') return `our pool index could not be read: ${s.index.detail}`;
  for (const e of s.pools) {
    if (e.kind !== 'pool') return `the pool at ${e.address} could not be read`;
    if (healths.get(e.view.address)?.deposits.verdict !== 'allowed' && healths.get(e.view.address)?.deposits.verdict !== 'refused') {
      return `the price of the pool at ${e.view.address} could not be checked`;
    }
  }
  return 'a pool could not be checked';
}

/**
 * What the card's answer rests on, as one string: the answer and every detail its line
 * shows. Two reads that give the same string said the same thing.
 */
function answerKey(
  offer: CreateOffer,
  pairs: readonly PairFacts[],
  facts: CreateFacts | null,
  outside: OutsidePrice | null,
  search: PoolSearchRead,
  healths: ReadonlyMap<string, PoolHealth>,
): string {
  return [
    offer,
    // Each coin's own answer: the pool pointed to and what it holds, or that it has none.
    pairs.map((x) => (x.advice.kind === 'none' ? `${x.coin.symbol}:${x.hasPool ? 'no-advice' : 'no-pool'}` : `${x.coin.symbol}:${x.advice.kind}:${x.advice.pool.address}:${x.advice.pool.quoteReserve}`)).join(','),
    outside?.kind === 'unread' ? outside.detail : '',
    facts?.tier.kind === 'unread' ? facts.tier.detail : '',
    facts?.feeAccount.kind === 'unread' ? facts.feeAccount.detail : '',
    offer === 'pools-unread' ? poolsUnreadDetail(search, healths) : '',
  ].join('|');
}

/** Read again. While a read runs it stays focusable but does nothing (aria-disabled), so focus is not lost. */
function ReadAgain({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      className="btn-secondary w-full sm:w-auto min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60"
      aria-disabled={busy}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      Read again
    </button>
  );
}

function OfferLines({
  offer,
  pairs,
  facts,
  safety,
  outside,
  search,
  healths,
  busy,
  onReread,
  onRereadFacts,
}: {
  offer: CreateOffer;
  /** Per coin the token can be paired with: the pool to add to first, said beside an offer. Never a stop. */
  pairs: readonly PairFacts[];
  facts: CreateFacts | null;
  safety: TokenSafety;
  outside: OutsidePrice | null;
  search: PoolSearchRead;
  healths: ReadonlyMap<string, PoolHealth>;
  busy: boolean;
  /** Read the token, its pools and the price again. */
  onReread: () => void;
  /** Read the public fee tier and the fee account again. */
  onRereadFacts: () => void;
}) {
  const tier = facts?.tier;
  switch (offer) {
    case 'offer': {
      if (tier?.kind !== 'ready') return null;
      // Opened with cp-swap's `initialize`, so the new pool never charges the tier's creator fee.
      const terms = `${tradeCostText(tier.config, CREATOR_FEE_SWITCH.publicOpen)}, ${solFee(tier.config.createPoolFee)} SOL to open`;
      const pools = search.kind === 'ok' ? search.search.pools.flatMap((e) => (e.kind === 'pool' ? [e.view] : [])) : [];
      // A cut list (see poolListCut) is never "no pool yet", and a new pool never "the first".
      const cut = poolListCut(search);
      if (pools.length === 0 && !cut) {
        return (
          <>
            {/* With no pool anywhere there is nothing to press "Add liquidity" on: say that this is the way in. */}
            <p>There is no pool to add liquidity to yet. Opening one is how the first liquidity goes in.</p>
            <p>No pool for this token yet. You can open the first one on the public fee tier: {terms} (read just now).</p>
          </>
        );
      }
      const tier1 = tier.address.toBase58();
      const otherTiers = [
        ...new Set(
          pools
            .filter((v) => v.snapshot.pool.ammConfig !== tier1 && healths.get(v.address)?.deposits.verdict === 'allowed')
            .map((v) => String(v.config?.index ?? '?')),
        ),
      ];
      const cutLine = cut && (
        <p>
          {pairs.length > 1
            ? 'This token has more pools than our pool index lists. For each coin a pool can be paired with, the index lists the ones holding the most of that coin, so the ones left out hold no more of it than those. They were not read or checked here.'
            : 'This token has more pools than our pool index lists. The index lists the ones holding the most SOL, so the ones left out hold no more SOL than those. They were not read or checked here.'}
        </p>
      );
      const onPublicTier = otherTiers.length > 0 ? ' on the public fee tier' : '';
      const otherTierLine = otherTiers.length > 0 && (
        <p>
          This token also has a pool on fee tier {otherTiers.join(' and ')} that passes the checks. A new pool will not share its liquidity or
          fees.
        </p>
      );
      // The coins the card points to a pool for, and the ones it does not: those with pools
      // that do not pass, and those with no pool at all. A cut list never says "no pool yet"
      // for a coin: a pool that was not read may be paired with it.
      const pointers = pairs.flatMap((x) => (x.advice.kind === 'none' ? [] : [{ coin: x.coin, kind: x.advice.kind, pool: x.advice.pool }]));
      const several = pointers.length > 1;
      const unpointed = pairs.filter((x) => x.advice.kind === 'none');
      const failing = unpointed.filter((x) => x.hasPool).map((x) => x.coin.symbol);
      const empty = cut ? [] : unpointed.filter((x) => !x.hasPool).map((x) => x.coin.symbol);
      const noneYetLine = empty.length > 0 && <p data-testid="lp-create-none-yet">This token has no {orList(empty)} pool yet. Open a pool lets you choose what to pair it with.</p>;
      if (pointers.length === 0) {
        return (
          <>
            {cutLine}
            <p>
              {cut ? 'None of the pools read for this token' : "None of this token's pools"}
              {onPublicTier} passes the checks above.{' '}
              You can open a new one on the public fee tier ({terms}). It will be a separate pool: it does not fix or join the others.
            </p>
            {noneYetLine}
            {otherTierLine}
          </>
        );
      }
      // A pool to add to first, for each coin that has one. What it holds is said in its own
      // coin, and its coin is named whenever "a pool" would not say which: always for a coin
      // that is not SOL, and for SOL once another coin's pool is pointed to as well. The
      // opener may still open another: it is their choice.
      const allMine = pointers.every((x) => x.kind === 'opened-here');
      return (
        <>
          {cutLine}
          {pointers.map(({ coin, kind, pool }) => {
            const aPool = several || !coin.native ? `a ${coin.symbol} pool` : 'a pool';
            return kind === 'opened-here' ? (
              <p key={coin.mint} data-testid="lp-create-opened" data-coin={coin.symbol}>
                You opened {aPool} for this token just now (<span className="font-mono break-all">{pool.address}</span>). Your share is under
                &apos;Your positions&apos;. {adviceCaveat(healths.get(pool.address))?.line ?? 'Adding to it keeps your liquidity in one place.'}
              </p>
            ) : (
              <p key={coin.mint} data-testid="lp-create-refer" data-coin={coin.symbol}>
                This token already has {aPool} on the public fee tier{' '}
                {adviceCaveat(healths.get(pool.address)) ? 'that takes deposits, with a warning (above)' : 'that passes the checks (above)'}. The biggest is{' '}
                <span className="font-mono break-all">{pool.address}</span>, holding {coinAbout(pool.quoteReserve, coin)}.{' '}
                {adviceCaveat(healths.get(pool.address))?.line ?? 'We suggest adding to it: liquidity in one place gives traders a better price.'}
              </p>
            );
          })}
          {failing.length > 0 && (
            <p data-testid="lp-create-failing">
              None of this token&apos;s {orList(failing)} pools{onPublicTier} passes the checks above.
            </p>
          )}
          {noneYetLine}
          <p data-testid="lp-create-still">
            {allMine
              ? `You can still open another on the public fee tier (${terms}). It will be a separate pool, and the fee to open is paid again.`
              : `You can still open your own on the public fee tier (${terms}). It will be a separate pool: it does not share ${several ? "the other pools'" : "the other pool's"} liquidity or fees.`}
          </p>
          {!allMine && otherTierLine}
        </>
      );
    }
    case 'pools-unread':
      return (
        <>
          <p>
            We could not read every pool for this token ({poolsUnreadDetail(search, healths)}), so we cannot tell whether one you could add to
            already exists. Opening a pool is off until we can.
          </p>
          <ReadAgain onClick={onReread} busy={busy} />
        </>
      );
    case 'price-unread':
      return (
        <>
          <p>
            We could not get this token&apos;s market price from Jupiter just now ({outside?.kind === 'unread' ? outside.detail : 'not read'}), so we
            cannot check an opening price. Opening a pool is off until we can.
          </p>
          <ReadAgain onClick={onReread} busy={busy} />
        </>
      );
    case 'token-refused': {
      // In the words of the check that refused it: every block on a blocked token (they say
      // whether the pool program or this site is the limit), or that the token does not
      // exist. Each is a whole sentence. The one refusal with neither is SOL under the
      // newer token program.
      const reasons = safety.kind === 'read' ? safety.blocks.map((b) => b.text) : tokenReasons(safety, 'pools').refused;
      return <p>This site does not open pools for this token: {reasons.length > 0 ? reasons.join(' ') : NATIVE_2022_LINE}</p>;
    }
    case 'token-unread':
      return (
        <>
          <p>We could not read this token just now, so opening a pool is off until we can.</p>
          <ReadAgain onClick={onReread} busy={busy} />
        </>
      );
    case 'fee-account': {
      const fa = facts?.feeAccount;
      const detail = fa?.kind === 'not-wsol' ? fa.detail : 'there is no account at its address';
      return (
        <p>
          The account that receives the fee to open a pool is not set up ({detail}), so opening a pool would fail. Nothing can be opened until the
          team&apos;s vault sets it up.
        </p>
      );
    }
    case 'fee-account-unread':
      return (
        <>
          <p>
            We could not read the account that receives the fee to open a pool ({facts?.feeAccount.kind === 'unread' ? facts.feeAccount.detail : 'not read'}),
            so opening a pool is off until we can.
          </p>
          <ReadAgain onClick={onRereadFacts} busy={busy} />
        </>
      );
    case 'tier-fee-too-high':
      return tier?.kind === 'fee-too-high' ? (
        <p>
          The fee to open a pool on the public fee tier is set to {solFee(tier.config.createPoolFee)} SOL, above this site&apos;s limit of{' '}
          {solFee(tier.limit)} SOL, so this site will not open one.
        </p>
      ) : null;
    case 'tier-off':
      return <p>Opening new pools on the public fee tier is switched off right now by the pool program&apos;s admin (the team&apos;s vault).</p>;
    case 'tier-bad':
      return (
        <p>The public fee tier&apos;s account is not what this site expects ({tier?.kind === 'not-a-tier' ? tier.detail : 'not a fee tier'}), so opening a pool is off.</p>
      );
    case 'tier-not-open':
      return (
        <p>
          New pools from this site go on the public fee tier (tier 1), and that tier has not been created on the network yet. When the team&apos;s
          vault creates it, the Open a pool button appears here.
        </p>
      );
    case 'tier-unread':
      return (
        <>
          <p>We could not read the public fee tier just now ({tier?.kind === 'unread' ? tier.detail : 'not read'}), so opening a pool is off until we can.</p>
          <ReadAgain onClick={onRereadFacts} busy={busy} />
        </>
      );
    case 'checking':
      return <p>Checking whether new pools can be opened…</p>;
    case 'held':
      return (
        <p>
          A pool you opened is not confirmed yet (see the top of this section). Opening another now could open two pools and pay the fee twice.
        </p>
      );
    case 'paused-here':
      return <p>Opening pools and adding liquidity from this site are paused right now. Removing liquidity still works.</p>;
    case 'gate':
      return (
        <p>Opening a pool needs this page to reach the pool program, and it cannot right now (see the note at the top of this section).</p>
      );
    case 'off':
      return null;
  }
}
