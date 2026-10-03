// @vitest-environment node
//
// The server's pool index (api/_lib/pool-index.js) keeps its own copy of the pairing
// coins: api/ is plain JS and does not import quotes.ts. This pins the copy to the
// original. Without it, a coin added, moved or put under another token program in one
// place and not the other would pass every other test, and the index would quietly
// never find that coin's pools (or rank its vaults last).
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { MAX_POOLS, QUOTE_COINS as SERVER_COINS, quotesFor as serverQuotesFor } from '../../../../api/_lib/pool-index.js';
import { POOL_INDEX_MAX } from './poolIndex';
import { QUOTE_COINS, quotesFor } from './quotes';

describe('the pool index and the browser agree', () => {
  it('on the pairing coins: the same mints, under the same token programs, in the same rank order', () => {
    const row = (q: { symbol: string; mint: string; program: string }) => ({ symbol: q.symbol, mint: q.mint, program: q.program });
    expect(SERVER_COINS.map(row)).toEqual(QUOTE_COINS.map(row));
  });

  it('on which coins a token is searched with: every coin, or only the coins that outrank it', () => {
    const stranger = Keypair.generate().publicKey.toBase58();
    for (const mint of [stranger, ...QUOTE_COINS.map((q) => q.mint)]) {
      expect(serverQuotesFor(mint).map((q) => q.mint), mint).toEqual(quotesFor(mint).map((q) => q.mint));
    }
  });

  // The browser refuses a longer list outright, so a server that sent one would turn
  // every full answer into "the index could not be read".
  it('on the longest list: the server never sends more addresses than the browser takes', () => {
    expect(MAX_POOLS).toBeLessThanOrEqual(POOL_INDEX_MAX);
  });
});
