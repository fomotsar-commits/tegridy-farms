import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { clearFirstFrameDraft, peekFirstFrameDraft } from '../lib/firstFrameDraft';
import { heatExampleLine, VENUE, OPEN_VENUE_WELCOME_EVENT } from '../lib/arrival';
import { heatLaunchFloor } from '../lib/heat/heatGateConfig';
import { tierAtFloor } from '../lib/heat/heatOracle';
import { BAR_NAV, MENU_MARKETPLACE, NFT_FINANCE_LIVE, SWAP_SECTION, YIELD_SECTION } from '../lib/navConfig';
import { opensSheet, SHEET_PRESS } from '../lib/sheet';
import { VenueStats } from './VenueStats';
import { HeatCard } from './HeatCard';
import { FinePrint } from './ui/FinePrint';

/**
 * A door's colour says what it does, as on a room's hero (BungalowHero): trade gold, the pool
 * teal, stake green, and the trust blue for Scan, the marketplace and NFT loans. Here every door
 * is an outline, because the hero's one filled button is Read Heat. Class strings are whole
 * literals so Tailwind keeps each focus ring.
 */
const DOOR_TONES = {
  trade: {
    ring: 'focus-visible:ring-[#d4a843]',
    style: { border: '1px solid rgba(212,168,67,0.6)', color: '#d4a843' },
  },
  pool: {
    ring: 'focus-visible:ring-[#31d0aa]',
    style: { border: '1px solid rgba(49,208,170,0.6)', color: '#31d0aa' },
  },
  stake: {
    ring: 'focus-visible:ring-[#4CAF50]',
    style: { border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)' },
  },
  trust: {
    ring: 'focus-visible:ring-[#1E88E5]',
    style: { border: '1px solid rgba(30,136,229,0.55)', color: 'var(--color-stan)' },
  },
} as const;

type HeroDoor = { label: string; to: string; tone: keyof typeof DOOR_TONES };

/** A bar word's address, read now: the door and the word open the same thing (the Buy sheet over the home, for Trade). */
function barTo(label: string, fallback: string): string {
  return BAR_NAV.find((w) => w.label === label)?.to ?? fallback;
}

/**
 * The doors a room's hero has, for the venue (owner, 2026-11-14: "all these functions missing
 * from when youre in no specific bungalow"). A room's doors name its coin; with no room entered
 * they name the action, and each opens what the top bar's word opens. NFT loans rides the same
 * gate as its menu row. Read at render, so a room entered later moves Trade, Add and Stake with it.
 */
function heroDoors(): HeroDoor[] {
  return [
    { label: 'Trade', to: barTo(SWAP_SECTION.heading, SWAP_SECTION.hub), tone: 'trade' },
    { label: 'Add', to: barTo('Add', '/pools'), tone: 'pool' },
    { label: 'Stake', to: barTo(YIELD_SECTION.heading, YIELD_SECTION.hub), tone: 'stake' },
    { label: 'Scan', to: '/scan', tone: 'trust' },
    { label: MENU_MARKETPLACE.label, to: MENU_MARKETPLACE.to, tone: 'trust' },
    ...(NFT_FINANCE_LIVE ? [{ label: 'NFT loans', to: '/nft-finance', tone: 'trust' as const }] : []),
  ];
}

/**
 * Two rows of three, the width of the read field above them, so the row lines up with the
 * instrument and never wraps into a ragged third line on a phone. Each cell is a 44px target.
 */
function HeroDoors() {
  return (
    <nav aria-label="Island actions" data-testid="venue-hero-doors" className="mt-5 grid max-w-md grid-cols-3 gap-2 sm:gap-2.5">
      {heroDoors().map((door) => {
        const tone = DOOR_TONES[door.tone];
        return (
          <Link
            key={door.label}
            to={door.to}
            state={opensSheet(door.to) ? SHEET_PRESS : undefined}
            className={`flex min-h-[44px] items-center justify-center rounded-lg px-2 py-2 text-center text-[13px] font-semibold leading-tight transition-all hover:brightness-110 sm:text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent ${tone.ring}`}
            style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', ...tone.style }}
          >
            {door.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The venue's arrival hero, shown when no bungalow is entered. It claims no yield and no
 * certification, and says of heat only what the oracle serves and the gate enforces.
 */
export function VenueHero() {
  // `?heat=<address>` is where every shared read lands (/read/<address> redirects here).
  // Not validated here: a bad address reads as the field's own invalid state. Capped at 64.
  const [searchParams] = useSearchParams();
  const heatParam = searchParams.get('heat');
  const initialAddress = heatParam ? heatParam.trim().slice(0, 64) || null : null;
  // What the first frame's field held, and whether it had focus: peeked in render and
  // cleared in an effect, because this page's first render suspends and is thrown away
  // (lib/firstFrameDraft.ts). It only fills the field; nobody submitted it.
  const [typedBeforeReact] = useState(peekFirstFrameDraft);
  useEffect(() => clearFirstFrameDraft(), []);
  const launchFloor = heatLaunchFloor();

  return (
    <>
      <h1 className="heading-luxury text-[clamp(1.25rem,7.4vw,1.875rem)] md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
        {/* A real space before the break: a <br> is not text, so without it a screen
            reader or an unfurl reads "MEMETICS.FINANCEHeld". */}
        {VENUE.heroTitle}{' '}<br /><span className="text-white">{VENUE.heroLine}</span>
      </h1>

      {/* The instrument, always open and wallet-free; its Read is the hero's only filled button.
          The two sentences that stood above it are in How heat works (owner, 2026-10-16: fewer words). */}
      <div className="mb-6 max-w-md">
        <HeatCard
          lpDoors
          variant="embedded"
          initialAddress={initialAddress}
          initialDraft={typedBeforeReact.value}
          focusField={typedBeforeReact.focused}
        />

        {/* The definition, the launch floor and the linked-wallet sentence stay with the
            instrument, one press away; all of them come from lib/arrival.ts. */}
        <FinePrint summary="How heat works" className="mt-2">
          <p>{VENUE.heroPlain}</p>
          <p>{VENUE.heroHook}</p>
          <p>{VENUE.heatPlain}</p>
          <p style={{ color: 'var(--color-kyle)' }}>
            {heatExampleLine(launchFloor, tierAtFloor(launchFloor))}
          </p>
          <p>{VENUE.heatOnePerson}</p>
          <p>
            Hold in several wallets?{' '}
            <a
              href="https://memetics.wtf/register"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
              style={{ color: 'var(--color-kyle)' }}
            >
              Bring them together at the island&apos;s door
            </a>{' '}
            and every one of them reads your whole flame.
          </p>
        </FinePrint>

        {/* Under the instrument and its small print: the read stays the first thing, and every
            door is still on the first screen. */}
        <HeroDoors />
      </div>

    </>
  );
}

/** Under the cards (components/VenueCards.tsx; the hero column is too narrow for three side by side): the tour, the four steps and the island line. */
export function VenueHeroFooter() {
  return (
    <>
      {/* TVL, read from every chain each minute, and the all-time volume (VenueStats.tsx). */}
      <VenueStats />
      {/* The venue never opens its welcome by itself: this pill is the door to the tour. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_VENUE_WELCOME_EVENT))}
          className="text-[12px] underline underline-offset-4 decoration-white/30 hover:decoration-white transition-colors"
          style={{ color: 'rgba(255,255,255,0.75)' }}
        >
          First time on the island? Take the tour
        </button>
        {/* /start is the wallet-free newcomer page; this is its door from the hero. */}
        <Link
          to="/start"
          className="text-[12px] underline underline-offset-4 decoration-white/30 hover:decoration-white transition-colors"
          style={{ color: 'rgba(255,255,255,0.75)' }}
        >
          Or walk the four steps
        </Link>
      </div>

      {/* The island line: same pill geometry as the ticker it replaces. */}
      <div className="mt-4 min-h-[48px] md:min-h-[34px] flex items-center">
        <span
          className="inline-flex items-baseline gap-2 text-[13px] italic rounded-full px-3 py-1.5"
          style={{ background: 'rgba(6,12,26,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
          <span className="text-white/90">&ldquo;{VENUE.museLine}&rdquo;</span>
          {/* A middle dot, not a dash (answer eight, ruling 8). */}
          <span className="text-[11px] not-italic" style={{ color: 'var(--color-weed)' }}>&middot; {VENUE.museBy}</span>
        </span>
      </div>
    </>
  );
}
