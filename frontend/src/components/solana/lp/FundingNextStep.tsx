import { Link } from 'react-router-dom';
import type { QuoteCoin } from '../../../lib/solana/lp/quotes';
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
 *
 * A pool paired with USDC or BAYLA (`coin`) can leave a wallet short of three things: the
 * SOL that pays the network fee and the account deposits, the coin, and the token. The
 * coin is had the way the token is: on the swap, opened on the coin by its address. For a
 * SOL pool the coin IS SOL, `needsSol` says it, and the words are what they always were.
 */
export function FundingNextStep({
  coin,
  needsSol,
  needsCoin = false,
  needsToken,
  mint,
  wallet,
}: {
  /** The pool's pairing coin. */
  coin: QuoteCoin;
  /**
   * Short of SOL. A SOL pool: none left to put in after the costs. Any other coin: less
   * SOL than the fee and the deposits need (`cannotFundText`'s own rule, panelKit.ts).
   */
  needsSol: boolean;
  /** Holds none of the pairing coin. Only read for a coin that is not SOL. */
  needsCoin?: boolean;
  needsToken: boolean;
  /** The token's mint: the swap link carries it. */
  mint: string;
  /** The connected wallet's address, to copy; null when there is none. */
  wallet: string | null;
}) {
  const shortCoin = !coin.native && needsCoin;
  if (!needsSol && !shortCoin && !needsToken) return null;
  // A finger-sized press area that leaves the sentence's lines where they are: 12px of
  // padding above and below the 21.125px line (45px in all), taken back by the same
  // negative margin. A 44px box in the line pushed its neighbours 33 or 44px apart, and
  // on a small phone the sentence read as separate lines. 4px each side the same way:
  // "USDC" alone is 37px wide.
  // The area reaches over the lines above and below, so what a press there hits is set
  // by three layers (the sentence is `isolate`, so they stay inside it):
  //   the press areas (`relative`), over the sentence's plain words, which are drawn
  //     later and would take the bottom of each area;
  //   the Copy button, whole (`z-10`: its words cannot be wrapped from here), over a
  //     link's area on the next line;
  //   each link's own words (`z-20`), over any other target's area.
  // So a press on a target's words is always that target.
  // The keyboard's ring goes round the words too (`ring-on-words`, index.css): round the
  // area it is 53px tall on a 21px line and strikes through the lines above and below.
  const press = 'relative px-1 -mx-1 py-3 -my-3 ring-on-words';
  const swapOn = (to: string, text: string) => (
    <Link to={`/solana?out=${to}`} className={`inline-block ${press} underline underline-offset-2 text-white hover:text-white/80`}>
      <span className="relative z-20 ring-words">{text}</span>
    </Link>
  );
  const copy = wallet ? (
    <>
      {' '}
      <CopyButton text={wallet} display="Copy this wallet’s address" className={`${press} z-10 underline text-white/85`} wordsClassName="ring-words" />
    </>
  ) : null;
  // What the swap is tried for: the words after "try".
  const swapFor =
    shortCoin && needsToken ? (
      <>
        this site’s Solana swap for both: {swapOn(coin.mint, coin.symbol)} and {swapOn(mint, 'the token')} (each opens the swap on that one, by
        its address)
      </>
    ) : shortCoin ? (
      <>
        {swapOn(coin.mint, 'this site’s Solana swap')} for {coin.symbol} (it opens on {coin.symbol}, by its address)
      </>
    ) : needsToken ? (
      <>{swapOn(mint, 'this site’s Solana swap')} for the token (it opens on this token, by its address)</>
    ) : null;
  return (
    <p className="isolate text-white/75" data-testid="lp-funding-next">
      {needsSol && swapFor ? (
        <>
          Send SOL to this wallet first.{copy} With SOL in it, try {swapFor}, then come back to this tab.
        </>
      ) : needsSol ? (
        <>Send SOL to this wallet, then come back to this tab.{copy}</>
      ) : (
        <>Try {swapFor}, then come back to this tab.</>
      )}
    </p>
  );
}
