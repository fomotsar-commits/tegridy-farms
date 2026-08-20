import { SHIELD_VENUES, shieldVenueReadiness, unreadableVenues } from '../../lib/shield/venues';

// What this surface can see, and what it cannot.
//
// The unreadable list is the point. A borrower with an Aave position who reads a
// calm shield page and concludes they are covered has been misled by an omission,
// and an omission is easy to ship because nothing renders. Naming every venue
// this app cannot read turns that silence into a sentence.

export function ShieldCoverageNotice() {
  const readiness = shieldVenueReadiness();
  const dark = unreadableVenues();
  if (dark.length === 0) return null;

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
      aria-label="Coverage"
    >
      <p className="text-white text-[12px] font-semibold">Not covered by this page</p>
      <p className="mt-1 text-white/60 text-[11px] leading-snug">
        These venues are not read here. A position on any of them is not being watched, and its absence
        below means nothing was asked — not that nothing is at risk.
      </p>
      <ul className="mt-2 space-y-2">
        {dark.map((id) => (
          <li key={id}>
            <p className="text-white/80 text-[11px] font-medium">{SHIELD_VENUES[id].label}</p>
            <p className="text-white/50 text-[11px] leading-snug">{readiness[id].detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default ShieldCoverageNotice;
