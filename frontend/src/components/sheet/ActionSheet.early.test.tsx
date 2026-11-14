// An address with the sheet up starts the sheet's two chunks with the app (island answer thirty-three, section 4).
import { describe, expect, it, vi } from 'vitest';
import { BAYLA_MINT } from '../../lib/bungalows';

// A mint no room holds: /pools draws its own door for it, and no sheet takes it.
const COIN = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

/** The app's sheet module, evaluated as on a fresh document that opened on `address`: which chunks it started. */
async function boot(address: string) {
  vi.resetModules();
  const loaded = { connection: 0, form: 0 };
  // Each chunk's stand-in counts the times it was loaded.
  vi.doMock('./SheetSolana', () => {
    loaded.connection += 1;
    return { default: () => null };
  });
  vi.doMock('./SheetBody', () => {
    loaded.form += 1;
    return { default: () => null };
  });
  window.history.replaceState(null, '', address);
  await import('./ActionSheet');
  await vi.dynamicImportSettled();
  return loaded;
}

describe("the sheet's two chunks, when the app starts", () => {
  it.each([
    ['/bayla?sheet=add', "a room's door with Add up"],
    ['/bayla?sheet=buy', "a room's door with Buy up"],
    ['/swap?sheet=buy&coin=soy', 'Buy over another page'],
  ])('%s starts both, the form without waiting for the connection: %s', async (address) => {
    expect(await boot(address)).toEqual({ connection: 1, form: 1 });
  });

  it.each([
    ['/bayla', 'a room with no sheet'],
    ['/pools', 'the pools page'],
    [`/pools?mint=${COIN}&task=add`, "an add link for a coin with no room: the page's own door"],
    ['/earn?sheet=stake', 'a word the sheet does not know'],
    // The island's links: the app sends each to the room's sheet, whose chunks then load as they did.
    [`/pools?mint=${BAYLA_MINT}&task=add`, "the island's add link"],
    [`/solana?out=${BAYLA_MINT}`, "the island's buy link"],
    ['/', 'the venue'],
  ])('%s starts neither: %s', async (address) => {
    expect(await boot(address)).toEqual({ connection: 0, form: 0 });
  });
});
