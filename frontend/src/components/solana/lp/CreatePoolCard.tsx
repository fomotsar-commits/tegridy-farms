import { useEffect, useId, useRef, useState } from 'react';
import { formatSol } from '../../../lib/launcher/solana/curve/format';
import { tokenReasons, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import { isCreatedPool, type PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { tradeCostText } from '../../../lib/solana/lp/format';
import { CREATOR_FEE_SWITCH } from '../../../lib/solana/cpswap/venue';
import { TOKEN_2022_NATIVE_MINT } from '../../../lib/solana/lp/opening';
import { Notice } from '../curve/ui';
import { CARD, CARD_STYLE, SHADOW } from '../curve/uiFormat';
import type { CreateFacts, TierState } from '../curve/ports';
import { CreatePoolPanel } from './CreatePoolPanel';
import { MONEY_NOTE } from './LpDisclosures';
import { createAdvice, createOffer, depositOffer, lpHeld, poolListCut, type CreateAdvice, type CreateOffer } from './offers';
import { solAbout } from './panelKit';
import { useLpWrites, type LpWrites } from './useLpWrites';

const NATIVE_2022_LINE = 'This is SOL under the newer token program. Pools here pair a token with SOL.';

/** A sentence ends once: reasons from the checks already carry their own full stop. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
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
  // Said beside an offer only: a stopped card has its own line, and names no pool to add to.
  const advice: CreateAdvice =
    offer === 'offer' ? createAdvice({ gate: writes.gate, search, healths, openedHere: isCreatedPool }) : { kind: 'none' };
  const answer = answerKey(offer, advice, facts, outside, search, healths);
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
  const pointsTo = advice.kind;
  useEffect(() => {
    if (!openNow || acted.current === openNow || !settled) return;
    acted.current = openNow;
    // Not offered, already open, or another form is mid-flow: the card comes onto the
    // screen, so the press shows its reason (or its open form) instead of doing nothing.
    // An open form's own heading, when there is one: the card's top would leave it below the screen.
    // A token that already has a pool to add to is not taken straight into the open-a-pool
    // form either: the card comes onto the screen with both choices (add to that pool, or
    // open another), so the pool it points to is seen before a second one is opened.
    if (offer !== 'offer' || pointsTo !== 'none' || open || busy) (sectionRef.current?.querySelector('h4') ?? sectionRef.current)?.scrollIntoView?.({ block: 'start' });
    else openPanel('create', key, openButton.current, headingRef.current);
    onActed?.(openNow);
  }, [openNow, settled, offer, pointsTo, open, busy, openPanel, key, onActed]);
  // The pool the card points to (createAdvice) gets a button, not only words: asked to
  // create a pool for a token that has one, a phone ended on a card with nothing to press
  // for it (phone walk of the build, 2026-10-03, the day the first BAYLA pool was
  // opened). Offered when that pool takes deposits right now, by the same rule its own
  // Add button follows. It sits beside Open a pool, which stays: a token may have as
  // many pools as people open (owner ruling 2026-10-03).
  const { mode, gate } = writes;
  const notes = writes.pending.notes;
  const pointedTo = advice.kind === 'none' ? null : advice.pool.address;
  const pointedHealth = pointedTo ? healths.get(pointedTo) : undefined;
  const addInstead =
    pointedTo && pointedHealth && gate?.kind === 'open' && depositOffer({ mode, gate, health: pointedHealth, held: lpHeld(notes, pointedTo, 'add') }) === 'offer'
      ? pointedTo
      : null;
  if (offer === 'off') return null;

  // Another panel's flow is running: this one cannot open over it.
  const blockedByOther = writes.busy && !open;
  const tier: TierState | null = facts?.tier ?? null;
  // The search's own read of the standard tier-1 address. Prepare decides for good.
  const standardAddress = search.kind === 'ok' ? search.search.known.standard.find((s) => s.index === 1)?.address ?? null : null;
  const standard: 'empty' | 'taken' =
    search.kind === 'ok' && standardAddress && search.search.knownState[standardAddress] && search.search.knownState[standardAddress] !== 'absent'
      ? 'taken'
      : 'empty';

  return (
    <section
      ref={sectionRef}
      className={`${CARD} scroll-mt-[4.5rem]`}
      style={CARD_STYLE}
      data-testid="lp-create"
      data-create={offer}
      data-advice={advice.kind}
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
            advice={advice}
            facts={facts}
            safety={safety}
            outside={outside}
            search={search}
            healths={healths}
            busy={reading}
            onReread={readAgain(onReread)}
            onRereadFacts={readAgain(writes.refreshCreateFacts)}
          />
        </div>
        {/* What the last Read again found, so the same answer is not silence. */}
        <p role="status" className="text-white/55 text-[11px]" data-testid="lp-create-reread">
          {asked !== null ? 'Reading again…' : said === 'same' ? 'Read again just now: the same answer.' : said === 'changed' ? 'Read again just now: the answer above is new.' : ''}
        </p>
        {addInstead && (
          <button
            type="button"
            className="btn-primary w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60"
            disabled={writes.busy}
            onClick={(e) => writes.open('add', `add:${addInstead}`, e.currentTarget)}
          >
            Add liquidity to that pool
          </button>
        )}
        {offer === 'offer' && (
          <>
            <p className="text-white/60 text-[11px]">{MONEY_NOTE}</p>
            {/* Stays mounted while its panel is open, so focus can come back to it on Close. */}
            <button
              ref={openButton}
              type="button"
              // Beside "Add liquidity to that pool" this is the second choice, and looks it.
              className={`${addInstead ? 'btn-secondary' : 'btn-primary'} w-full sm:w-auto min-h-[44px] px-4 text-[13px] disabled:opacity-60`}
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
            tier={tier}
            standard={standard}
            offer={offer}
            advice={advice.kind}
            reading={reading}
            onClose={writes.close}
            onReread={onReread}
          />
        )}
      </div>
    </section>
  );
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
  advice: CreateAdvice,
  facts: CreateFacts | null,
  outside: OutsidePrice | null,
  search: PoolSearchRead,
  healths: ReadonlyMap<string, PoolHealth>,
): string {
  return [
    offer,
    advice.kind === 'none' ? '' : `${advice.kind}:${advice.pool.address}:${advice.pool.solReserve}`,
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
  advice,
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
  /** The pool to add to first, said beside an offer. Never a stop. */
  advice: CreateAdvice;
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
          This token has more pools than our pool index lists. The index lists the ones holding the most SOL, so the ones left out hold no
          more SOL than those. They were not read or checked here.
        </p>
      );
      const otherTierLine = otherTiers.length > 0 && (
        <p>
          This token also has a pool on fee tier {otherTiers.join(' and ')} that passes the checks. A new pool will not share its liquidity or
          fees.
        </p>
      );
      // A pool to add to first. The opener may still open another: it is their choice.
      if (advice.kind === 'opened-here') {
        return (
          <>
            {cutLine}
            <p>
              You opened a pool for this token just now (<span className="font-mono break-all">{advice.pool.address}</span>). Your share is under
              &apos;Your positions&apos;. Adding to it keeps your liquidity in one place.
            </p>
            <p data-testid="lp-create-still">
              You can still open another on the public fee tier ({terms}). It will be a separate pool, and the fee to open is paid again.
            </p>
          </>
        );
      }
      if (advice.kind === 'exists') {
        return (
          <>
            {cutLine}
            <p data-testid="lp-create-refer">
              This token already has a pool on the public fee tier that passes the checks (above). The biggest is{' '}
              <span className="font-mono break-all">{advice.pool.address}</span>, holding {solAbout(advice.pool.solReserve)}. We suggest adding to
              it: liquidity in one place gives traders a better price.
            </p>
            <p data-testid="lp-create-still">
              You can still open your own on the public fee tier ({terms}). It will be a separate pool: it does not share the other pool&apos;s
              liquidity or fees.
            </p>
            {otherTierLine}
          </>
        );
      }
      return (
        <>
          {cutLine}
          <p>
            {cut ? 'None of the pools read for this token' : "None of this token's pools"}
            {otherTiers.length > 0 ? ' on the public fee tier' : ''} passes the checks above.{' '}
            You can open a new one on the public fee tier ({terms}). It will be a separate pool: it does not fix or join the others.
          </p>
          {otherTierLine}
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
    case 'no-route':
      return (
        <p>
          Jupiter has no market price for this token. This site opens pools only for tokens that already trade somewhere it can price, so nobody
          can be talked into an opening price that only they would pay.
        </p>
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
      const reason = tokenReasons(safety, 'pools').refused[0] ?? (safety.mint === TOKEN_2022_NATIVE_MINT ? NATIVE_2022_LINE : 'it did not pass the checks');
      return <p>This site does not open pools for this token: {sentence(reason)}</p>;
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
