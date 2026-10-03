import { Link } from 'react-router-dom';

/**
 * Under "This wallet cannot … yet" on the Add and Open forms: what to do about it. The
 * notice gave the numbers and stopped (owner and three phone walks, 2026-10-03: a greyed
 * Review, a reason, and no way on). It says only what the wallet is short of: SOL has to
 * come from outside this site; the token may be had on the site's own Solana swap, which
 * can only try (it has no route for every token).
 */
export function FundingNextStep({ needsSol, needsToken }: { needsSol: boolean; needsToken: boolean }) {
  if (!needsSol && !needsToken) return null;
  const swap = (
    <Link to="/solana" className="underline underline-offset-2 text-white hover:text-white/80">
      this site’s Solana swap
    </Link>
  );
  return (
    <p className="text-white/75" data-testid="lp-funding-next">
      {needsSol && needsToken ? (
        <>Send SOL to this wallet first. With SOL in it, try {swap} for the token, then come back to this tab.</>
      ) : needsSol ? (
        <>Send SOL to this wallet, then come back to this tab.</>
      ) : (
        <>Try {swap} for the token, then come back to this tab.</>
      )}
    </p>
  );
}
