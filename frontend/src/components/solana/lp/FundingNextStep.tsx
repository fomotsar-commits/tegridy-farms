import { Link } from 'react-router-dom';
import { CopyButton } from '../../ui/CopyButton';

/**
 * Under "This wallet cannot … yet" on the Add and Open forms: what to do about it. The
 * notice gave the numbers and stopped (owner and phone walks, 2026-10-03: a greyed Review,
 * a reason, and no way on). It says only what the wallet is short of.
 *
 * SOL has to come from outside this site, so the wallet's address is one press to copy.
 * The token may be had on the site's own Solana swap, which can only try (it has no route
 * for every token). The link opens the swap ON THIS TOKEN, by its address: a search by
 * name there lists every copy of the name, and this page has just said names can be copied.
 */
export function FundingNextStep({
  needsSol,
  needsToken,
  mint,
  wallet,
}: {
  needsSol: boolean;
  needsToken: boolean;
  /** The token's mint: the swap link carries it. */
  mint: string;
  /** The connected wallet's address, to copy; null when there is none. */
  wallet: string | null;
}) {
  if (!needsSol && !needsToken) return null;
  const swap = (
    <Link to={`/solana?out=${mint}`} className="inline-block py-1.5 underline underline-offset-2 text-white hover:text-white/80">
      this site’s Solana swap
    </Link>
  );
  const copy = wallet ? (
    <>
      {' '}
      <CopyButton text={wallet} display="Copy this wallet’s address" className="inline-block py-1.5 underline text-white/85" />
    </>
  ) : null;
  return (
    <p className="text-white/75" data-testid="lp-funding-next">
      {needsSol && needsToken ? (
        <>
          Send SOL to this wallet first.{copy} With SOL in it, try {swap} for the token (it opens on this token, by its
          address), then come back to this tab.
        </>
      ) : needsSol ? (
        <>Send SOL to this wallet, then come back to this tab.{copy}</>
      ) : (
        <>Try {swap} for the token (it opens on this token, by its address), then come back to this tab.</>
      )}
    </p>
  );
}
