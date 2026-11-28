// The range pools' refusals in the words the fresh-eyes read at 390 settled (2026-11-28). The
// tests that reach each refusal compare it to its constant, so a change of words passes them
// whatever it says; these hold the words: true of what the program does, the price named as
// the page names it ("market price"), and a pool's own account never called a vault.
import { describe, it, expect } from 'vitest';
import { RANGE_COPY } from './range';
import { RANGE_SWAP_COPY } from './rangeSwap';
import { VENUE_SWAP_COPY } from './venueSwap';

describe('the range pools’ refusals, word for word', () => {
  it('a reward short of what is owed: the close waits, and Take out 100% pays what the pool holds of that reward', () => {
    expect(RANGE_COPY.closeRewardShort).toBe(
      'The pool holds less of a reward than this position is owed, and the program closes a position only once every reward owed is paid. Take out 100% and keep it open instead: that pays what the pool holds of that reward, and the rest stays owed to it.',
    );
  });

  it('removals switched off: what was earned stays owed until they are back on', () => {
    expect(RANGE_COPY.earnedWaitsOnRemoval).toBe(
      'Taking liquidity out of this pool is switched off by the team’s vault right now. What this position earned since its last change stays owed to it until that is switched back on.',
    );
  });

  it('an NFT outside your wallet’s own account, an account it could not size, a trade too big for the pool', () => {
    expect(RANGE_COPY.notYourNft).toBe(
      'This site takes a position out only when its NFT is in your wallet’s own account for it, and this one’s is not, so nothing was built.',
    );
    // Sized for your accounts and, on an opening, the pool's own: "an account", never "your account".
    expect(RANGE_COPY.cannotSize('its mint was not read')).toBe(
      'This site could not work out the deposit for an account that holds one of this pool’s coins (its mint was not read), so nothing was built.',
    );
    expect(RANGE_SWAP_COPY.partFill).toBe('This pool holds too little to fill this whole trade. Try a smaller amount.');
    expect(VENUE_SWAP_COPY.cannotPrice).toBe('This pool gives no price for this trade right now.');
  });

  it('Jupiter’s price is the market price, as the strip and the review name it', () => {
    expect(RANGE_COPY.noMarket).toBe(
      'Jupiter has no route for this pair, so this pool’s price could not be checked against a market price. Anyone can open a range pool at any price.',
    );
    expect(RANGE_COPY.priceUnread('timeout')).toBe(
      'The market price could not be read just now (timeout), so this pool’s price was not checked against it. Anyone can open a range pool at any price.',
    );
    expect(RANGE_COPY.priceOff('9.1%', 'below', null)).toBe(
      'This pool’s price is 9.1% below the market price (Jupiter’s). Anyone can open a range pool at any price. What a move back to the market price would cost you at these amounts could not be worked out.',
    );
  });
});
