// PERF-01. `pageArt()` is called from inside React render bodies — 192 call
// sites, up to 18 surfaces on a single page render — and each call reached
// `getActiveBungalow()`, which built a fresh `URLSearchParams` from
// `window.location.search` every time. Rendering a ten-surface page cost ten
// query-string parses; re-rendering it cost ten more.
//
// WHAT IS PINNED IS THE INPUT, NOT A CACHE. The parse is memoised on
// `window.location.search`, which is the whole of what the function reads, so a
// hit is provably the same answer. The second test is the one that matters more:
// it proves the memo cannot go stale, because a deep link that stopped being
// honoured after the first render is a far worse bug than the parse it saved.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pageArt } from './artConfig';
import { BUNGALOW_STORAGE_KEY } from './bungalows';

let parses = 0;
const RealURLSearchParams = globalThis.URLSearchParams;

class CountingURLSearchParams extends RealURLSearchParams {
  constructor(init?: ConstructorParameters<typeof RealURLSearchParams>[0]) {
    super(init);
    parses += 1;
  }
}

function setSearch(search: string): void {
  window.history.replaceState(null, '', `/${search}`);
}

beforeEach(() => {
  localStorage.clear();
  setSearch('');
  parses = 0;
  vi.stubGlobal('URLSearchParams', CountingURLSearchParams);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSearch('');
  localStorage.clear();
});

describe('resolving a page of art does not re-parse the query string per surface', () => {
  it('parses once for ten surfaces, and not again on a re-render', () => {
    // Prime: the first call in this URL is allowed to parse.
    pageArt('home', 0);
    const afterFirst = parses;
    expect(afterFirst).toBeGreaterThan(0);

    for (let render = 0; render < 3; render += 1) {
      for (let idx = 0; idx < 10; idx += 1) pageArt('home', idx);
    }

    // Thirty more resolutions, zero more parses. Before this, thirty.
    expect(parses).toBe(afterFirst);
  });

  it('still honours a deep link that arrives after the first read', () => {
    pageArt('home', 0);
    const before = parses;

    // A different query string is a different question and must be re-parsed:
    // a memo keyed on anything coarser would serve the venue's art to someone
    // who followed a ?bungalow= link.
    setSearch('?bungalow=bayla');
    pageArt('home', 0);

    expect(parses).toBeGreaterThan(before);
    // ...and the deep link took effect: the persist side effect still ran.
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe('bayla');
  });
});
