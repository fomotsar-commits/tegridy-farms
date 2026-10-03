import { Link } from 'react-router-dom';

/**
 * Under "This wallet cannot … yet" on the Add and Open forms: what to do about it. The
 * notice gave the numbers and stopped (owner and three phone walks, 2026-10-03: a greyed
 * Review, a reason, and no way on). SOL has to come from outside this site; the token can
 * then be had on the site's own Solana swap.
 */
export function FundingNextStep() {
  return (
    <p className="text-white/75" data-testid="lp-funding-next">
      Send SOL to this wallet first. With SOL in it, you can get the token on{' '}
      <Link to="/solana" className="underline underline-offset-2 text-white hover:text-white/80">
        this site’s Solana swap
      </Link>
      , then come back to this tab.
    </p>
  );
}
