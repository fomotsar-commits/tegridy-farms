import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { clearFirstFrameDraft, peekFirstFrameDraft } from '../lib/firstFrameDraft';
import { heatExampleLine, VENUE, OPEN_VENUE_WELCOME_EVENT } from '../lib/arrival';
import { heatLaunchFloor } from '../lib/heat/heatGateConfig';
import { tierAtFloor } from '../lib/heat/heatOracle';
import { VenueVolume } from './VenueVolume';
import { HeatCard } from './HeatCard';
import { FinePrint } from './ui/FinePrint';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { noteOwnSolanaFailed } from '../lib/solanaSurface';

const HomeModules = lazy(() => import('./HomeModules'));

/** The pages the home's cards come from, when the cards' code did not load. */
function ModulesUnloaded() {
  // The cards' connection is the top bar's Solana one on the home: its wallet sheet says the load failed.
  useEffect(() => {
    noteOwnSolanaFailed();
  }, []);
  return (
    <p className="mt-2 mb-2 flex flex-wrap gap-x-4 text-[13px]">
      <Link to="/solana" className="underline underline-offset-4" style={{ color: 'var(--color-kyle)' }}>Swap</Link>
      <Link to="/earn/bayla" className="underline underline-offset-4" style={{ color: 'var(--color-kyle)' }}>Stake BAYLA</Link>
      <Link to="/solana-lp" className="underline underline-offset-4" style={{ color: 'var(--color-kyle)' }}>Add liquidity</Link>
    </p>
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
      </div>

    </>
  );
}

/**
 * The home's cards, swap, stake and add liquidity (owner, 2026-10-16), in their own row under
 * the hero: the hero column is too narrow for three side by side. Lazy: the Solana wallet stack
 * loads after the hero has painted. If its code cannot load, the pages they come from are linked.
 */
export function VenueCards() {
  return (
    <ErrorBoundary fallback={() => <ModulesUnloaded />}>
      <Suspense fallback={null}>
        <HomeModules />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Under the cards: the tour, the four steps and the island line. */
export function VenueHeroFooter() {
  return (
    <>
      {/* The all-time volume, counted hourly (VenueVolume.tsx). */}
      <VenueVolume />
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
