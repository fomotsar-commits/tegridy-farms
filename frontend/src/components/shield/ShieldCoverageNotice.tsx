import { SHIELD_VENUES, shieldVenueReadiness, unreadableVenues } from '../../lib/shield/venues';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

// What this surface can see, and what it cannot.
//
// The unreadable list is the point. A borrower with an Aave position who reads a
// calm shield page and concludes they are covered has been misled by an omission,
// and an omission is easy to ship because nothing renders. Naming every venue
// this app cannot read turns that silence into a sentence. The names stay
// visible; why each one is not read is one press away.

export function ShieldCoverageNotice() {
  const readiness = shieldVenueReadiness();
  const dark = unreadableVenues();
  if (dark.length === 0) return null;

  return (
    <section
      className="relative isolate rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
      aria-label="Coverage"
    >
      <CardArt pageId="shield" idx={2} />
      <p className="text-white text-[12px] font-semibold">Not covered by this page</p>
      <p className="mt-1 text-white/80 text-[12px]">{dark.map((id) => SHIELD_VENUES[id].label).join(' · ')}</p>
      <FinePrint className="mt-1">
        <p>
          These venues are not read here. A position on any of them is not being watched, and its absence
          below means nothing was asked — not that nothing is at risk.
        </p>
        <ul className="space-y-2">
          {dark.map((id) => (
            <li key={id}>
              <p className="text-white/80 font-medium">{SHIELD_VENUES[id].label}</p>
              <p>{readiness[id].detail}</p>
            </li>
          ))}
        </ul>
      </FinePrint>
    </section>
  );
}

export default ShieldCoverageNotice;
