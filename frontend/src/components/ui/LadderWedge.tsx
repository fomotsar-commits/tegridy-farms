import { MIN_BOOST_BPS, MAX_BOOST_BPS } from '../../lib/constants';

/**
 * The lock ladder drawn to scale: every staking program on the island grows a lock's share in a
 * straight line, from the floor at seven days to the ceiling at four years (lib/ladder/program.ts
 * boostBpsForLock, lib/lighthouseLadder.ts boostBpsFor, TegridyStaking.sol calculateBoost).
 * The dashboard's pool rows and Earn's schedule both draw it (IslandDashboard.tsx,
 * farm/VenuePoolIndex.tsx).
 */
export function LadderWedge({ className = '' }: { className?: string }) {
  const h = 14;
  const floor = (MIN_BOOST_BPS / MAX_BOOST_BPS) * h;
  return (
    <svg width="40" height={h} viewBox={`0 0 40 ${h}`} aria-hidden="true" className={`flex-shrink-0 ${className}`}>
      <path d={`M0 ${h} L40 ${h} L40 0 L0 ${h - floor} Z`} fill="currentColor" />
    </svg>
  );
}
