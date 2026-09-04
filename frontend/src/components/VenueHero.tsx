import { useState } from 'react';
import { Link } from 'react-router-dom';
import { VENUE, OPEN_VENUE_WELCOME_EVENT } from '../lib/arrival';
import { OPEN_BUNGALOWS_EVENT } from '../lib/bungalows';
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
  const openBungalows = () => window.dispatchEvent(new Event(OPEN_BUNGALOWS_EVENT));
  // Collapsed by default so the reading is one tap away without pushing the CTAs
  // below the fold. See the disclosure below for why it is here at all.
  const [openHeat, setOpenHeat] = useState(false);
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

      <p className="text-white text-base md:text-lg mb-3 max-w-md leading-relaxed">
        {VENUE.heroCopy}
      </p>
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
          Collapsed by default so the three CTAs keep their position. */}
      <div className="mb-6 max-w-md">
        <button
          type="button"
          onClick={() => setOpenHeat((v) => !v)}
          aria-expanded={openHeat}
          className="text-[13px] underline underline-offset-4 decoration-white/30 hover:decoration-white transition-colors"
          style={{ color: 'var(--color-kyle)' }}
        >
          {openHeat ? 'Hide' : 'Read your Heat — paste any address, no wallet needed'}
        </button>
        {openHeat && (
          <div className="mt-3">
            {/* The mechanical definition sits WITH the instrument, so the number
                and the sentence that explains it are never separated. Both come
                from lib/arrival.ts, which sources them from heatOracle.ts. */}
            <p className="text-white/80 text-[12px] leading-relaxed mb-1">{VENUE.heatPlain}</p>
            <p className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--color-kyle)' }}>
              {VENUE.heatExample}
            </p>
            <HeatCard variant="embedded" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={openBungalows}
          className="btn-primary px-7 py-2.5 text-[14px] inline-block text-center"
          aria-label="Open the bungalow picker"
        >
          Pick a bungalow
        </button>
        {/* AE1(b), 2026-09-03: this was a FILLED gold gradient at the same 43px
            height as the primary beside it. Three CTAs at equal weight is a
            hierarchy problem on its own, but the specific harm was that the
            loudest one — highest chroma, filled, warm against a cool ground —
            was the ADVANCED path. The eye went to "Launch on Heat" first, which
            is the action a first-time visitor is least ready for.
            Outlined now, keeping the exact gold hue so nothing about the
            venue's palette changes: same colour, less shout. "Pick a bungalow"
            is the only filled button in the hero. */}
        <Link
          to="/launch"
          className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#d4a843]"
          style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(212,168,67,0.55)', color: '#d4a843', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          Launch on Heat
        </Link>
        <Link
          to="/scan"
          className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#4CAF50]"
          style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          Scan any token
        </Link>
      </div>

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
