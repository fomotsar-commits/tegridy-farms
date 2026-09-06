import { Link } from 'react-router-dom';
import { VENUE, OPEN_VENUE_WELCOME_EVENT } from '../lib/arrival';
import { HeatCard } from './HeatCard';

/**
 * The venue's own arrival hero: what a visitor sees at memetics.finance
 * when no bungalow has been entered. Rendered by HomePage IN PLACE OF the
 * classic Tegridy cluster, which now lives whole inside the TOWELI
 * bungalow (arrivalVoice() === 'toweli'). The chain pills and security
 * badge around it stay shared: venue facts either way.
 *
 * Honesty rules, same bar as the cluster it replaces:
 *  - No yield numbers, no certification claim, no "certified" stamp.
 *    The venue reads the island's standard; it never self-declares.
 *  - Heat claims name the mechanism (held time, the island's instrument)
 *    and nothing the gate does not enforce in code.
 *  - The second-person hook states only what the oracle serves: a heat
 *    reading exists for any wallet, counted from its first buy.
 */
export function VenueHero() {
  // No local state left: the instrument is always open, so there is nothing to
  // disclose and nothing to remember.
  return (
    <>
      <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
        {VENUE.heroTitle}<br /><span className="text-white">{VENUE.heroLine}</span>
      </h1>

      {/* PLAIN LANGUAGE FIRST (field review, 2026-09-03). The island writing
          below is untouched — this is added above it, not in place of it.
          The review claimed the hero "never says what the site does"; that is
          slightly unfair, heroCopy's second sentence does name staking and
          swaps. But it names them mid-paragraph, behind a place-name, and
          without a single chain. A first-time reader finished the hero unable
          to tell whether this was an NFT project, a game or a DEX. The lore is
          the best asset on the page; it just should not be the doorman. */}
      <p className="text-white text-base md:text-lg mb-3 max-w-md leading-relaxed font-semibold">
        {VENUE.heroPlain}
      </p>

      {/* WAVE SEVEN, element B: VENUE.heroCopy used to sit here, four sentences
          between the hook and the instrument. It is not deleted — it now opens
          /start (OnboardingFlow), which is linked from this hero and is the page
          a newcomer can return to and read without a wallet. The hero is three
          lines now, and the third one is a question the field below answers. */}
      <p className="text-base md:text-lg mb-3 max-w-md leading-relaxed font-semibold" style={{ color: 'var(--color-kyle)' }}>
        {VENUE.heroHook}
      </p>

      {/* "Your heat already exists" is the most compelling sentence on the page,
          and it used to sit next to nothing. The natural next thought is HOW
          MUCH DO I HAVE, and there was no way to answer it without connecting a
          wallet — on a page whose whole pitch is that the number already exists
          independently of you.
          HeatCard is wallet-free by construction: it falls back to a free-text
          address field ("0x… or a Solana address"), and is already embedded this
          way by LaunchGate. Nothing new is built here; it is mounted.
          WAVE SEVEN, element B: it is NO LONGER COLLAPSED. The field and its Read
          button render always, directly under the hook, because a disclosure that
          hides the answer to the sentence immediately above it is a wall with a
          handle on it. The Read button is now the only filled button in the hero. */}
      <div className="mb-6 max-w-md">
        <HeatCard variant="embedded" />

        {/* Under the card, in venue voice. The first sentence answers the question
            every multi-wallet holder asks on sight, and answers it honestly rather
            than pretending the island can see across wallets by itself. The second
            says what to do about it, at the island's door, which is the only place
            it can be done. */}
        <p className="text-white/70 text-[12px] leading-relaxed mt-3">
          Held time is measured per wallet. A bag moved to a new wallet starts that
          wallet&apos;s clock at the move.
        </p>
        <p className="text-white/70 text-[12px] leading-relaxed mt-2">
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

        {/* The mechanical definition stays WITH the instrument, so the number and
            the sentence that explains it are never separated. Both come from
            lib/arrival.ts, which sources them from heatOracle.ts. */}
        <p className="text-white/60 text-[12px] leading-relaxed mt-3">{VENUE.heatPlain}</p>
        <p className="text-[12px] leading-relaxed mt-1" style={{ color: 'var(--color-kyle)' }}>
          {VENUE.heatExample}
        </p>
      </div>

      {/* THE THREE CTAs ARE GONE FROM THE HERO, and none of them is orphaned.
          AE1(b) already found that three near-equal buttons here were a hierarchy
          problem; wave seven finishes the thought. A stranger now meets ONE number
          before meeting any choice, and the choosing happens under the hall, in
          <ThreePaths>, where they arrive having already seen what the place is.

          Where each one went:
            "Pick a bungalow"  -> the HOLD path, plus the hall itself directly
                                  below, plus the picker's three other doors
                                  (TopNav, Footer, BungalowDoorLanding).
            "Launch on Heat"   -> the LAUNCH path, and navConfig's Launch section.
            "Scan any token"   -> navConfig's Token Scanner (/scan).
          The only filled button in the hero is now the instrument's own Read. */}

      {/* ARRIVAL FLOW 2026-08-31: orientation by invitation. The venue never
          auto-opens its welcome; this quiet pill is the door to the tour. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_VENUE_WELCOME_EVENT))}
          className="text-[12px] underline underline-offset-4 decoration-white/30 hover:decoration-white transition-colors"
          style={{ color: 'rgba(255,255,255,0.75)' }}
        >
          First time on the island? Take the tour
        </button>
        {/* /start (OnboardingFlow, App.tsx:385) is the BETTER newcomer surface —
            wallet-free, never gated, and its step list is built from live gates
            rather than written prose. It was linked from nowhere in the entire
            codebase: a grep for "/start" outside App.tsx's own route returned
            nothing, and it is absent from navConfig. The review read this area
            as "the tour link is too small"; the real defect was an orphaned
            page. Both surfaces now have a door. */}
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
          <span className="text-[11px] not-italic" style={{ color: 'var(--color-weed)' }}>&mdash; {VENUE.museBy}</span>
        </span>
      </div>
    </>
  );
}
