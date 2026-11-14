import { quoteCoin, type QuoteCoin } from './quotes';

/**
 * TEST ONLY: `coin`'s own row in the list flagged `delisted` while `fn` runs, and put back
 * afterwards, whatever happens. No real row is delisted (quotes.test.ts pins that), so
 * every withdraw-only test goes through here, through the same row object the site reads.
 */
export async function whileDelisted<T>(coin: Pick<QuoteCoin, 'mint'>, fn: () => T | Promise<T>): Promise<T> {
  const row = quoteCoin(coin.mint);
  if (!row) throw new Error(`${coin.mint} is not a pairing coin`);
  const before = row.delisted;
  row.delisted = true;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete row.delisted;
    else row.delisted = before;
  }
}
