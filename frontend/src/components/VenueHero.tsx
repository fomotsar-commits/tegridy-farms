import { Link } from 'react-router-dom';
import { VENUE } from '../lib/arrival';
import { OPEN_BUNGALOWS_EVENT } from '../lib/bungalows';

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
  return (
    <>
      <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
        {VENUE.heroTitle}<br /><span className="text-white">{VENUE.heroLine}</span>
      </h1>

      <p className="text-white text-base md:text-lg mb-3 max-w-md leading-relaxed">
        {VENUE.heroCopy}
      </p>
      <p className="text-base md:text-lg mb-6 max-w-md leading-relaxed font-semibold" style={{ color: 'var(--color-kyle)' }}>
        {VENUE.heroHook}
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={openBungalows}
          className="btn-primary px-7 py-2.5 text-[14px] inline-block text-center"
          aria-label="Open the bungalow picker"
        >
          Pick a bungalow
        </button>
        <Link
          to="/launch"
          className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#d4a843]"
          style={{ background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)', color: '#0a0a0f' }}
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
