import { Link } from 'react-router-dom';
import { ALL_POOLS_PATH } from '../../lib/earnRoutes';

/**
 * The way out of one pool (/earn/<id>) to the list of every pool, at the top of the pool,
 * where a visitor is reading. Lock and its Staking tab open the room's own pool (owner,
 * 2026-10-15), so this is the list's door from inside a room.
 */
export function BackToEarn() {
  return (
    <Link
      to={ALL_POOLS_PATH}
      className="inline-flex items-center gap-1.5 mb-4 text-[13px] text-white/80 hover:text-white underline-offset-2 hover:underline"
    >
      <span aria-hidden="true">←</span>
      Every pool
    </Link>
  );
}
