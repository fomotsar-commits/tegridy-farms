import { Link } from 'react-router-dom';

/**
 * The way out of one pool (/earn/<id>) to the list of every pool (/earn), at
 * the top of the pool, where a visitor is reading. Earn's top-bar word and its
 * Staking tab go to the same list.
 */
export function BackToEarn() {
  return (
    <Link
      to="/earn"
      className="inline-flex items-center gap-1.5 mb-4 text-[13px] text-white/80 hover:text-white underline-offset-2 hover:underline"
    >
      <span aria-hidden="true">←</span>
      Back to Earn
    </Link>
  );
}
