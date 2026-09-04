import { describe, it, expect, beforeEach } from 'vitest';
import {
  WATCHLIST_MAX,
  WATCHLIST_STORAGE_KEY,
  isWatched,
  loadWatchlist,
  normalizeWatchKey,
  parseWatchKey,
  parseWatchlist,
  saveWatchlist,
  toggleWatch,
  watchKeyFor,
  watchedOn,
} from './watchlist';

// The watchlist stores addresses and nothing else, so most of what could go wrong
// here is corruption rather than dishonesty. It has two honesty properties:
//
//   1. A key that can never match a row is refused at the door. A watch that
//      silently matches nothing looks identical to a watch on a pool that never
//      trades.
//   2. A key names its CHAIN. The same 0x address is a different, unrelated pool
//      on Ethereum and on Base, so a bare key would light up the wrong star and,
//      worse, send the wrong address to the wrong network's `pools/multi`.
//
// And one security property: a watchlist key is the only value on this page that
// travels from localStorage into a fetch URL, where `pools/multi/{a,b,c}` joins
// addresses into a PATH SEGMENT. The regexes below are that boundary.

const ETH_A = '0x1111111111111111111111111111111111111111';
const ETH_B = '0x2222222222222222222222222222222222222222';
const SOL_MINT = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';

beforeEach(() => {
  localStorage.clear();
});

describe('keys name their chain', () => {
  it('folds an EVM address to lowercase so a checksummed paste still matches a row', () => {
    expect(normalizeWatchKey('eth:0xAbCdEf0123456789AbCdEf0123456789AbCdEf01')).toBe(
      'eth:0xabcdef0123456789abcdef0123456789abcdef01',
    );
  });

  it('keeps Solana case EXACTLY — base58 lowercased is a different, valid-looking address', () => {
    // The whole point. A naive `.toLowerCase()` port of the EVM rule produces
    // '4nv5gnwwp68zudat26yschreqvaqaludfjbksgezpump', which still matches the
    // base58 regex, still looks like a mint, and points at nothing. This
    // assertion fails on that mutation.
    expect(normalizeWatchKey(`solana:${SOL_MINT}`)).toBe(`solana:${SOL_MINT}`);
    expect(normalizeWatchKey(`solana:${SOL_MINT}`)).not.toBe(
      `solana:${SOL_MINT.toLowerCase()}`,
    );
  });

  it('treats the same address on two chains as two different keys', () => {
    expect(normalizeWatchKey(`eth:${ETH_A}`)).not.toBe(normalizeWatchKey(`base:${ETH_A}`));
    expect(isWatched([`base:${ETH_A}`], `eth:${ETH_A}`)).toBe(false);
  });

  it('migrates a legacy bare 0x entry to eth: — that is what it meant when written', () => {
    // The retained Venue-pairs tab still calls onToggleWatch(row.pair) with a
    // bare 0x address, and every star saved before this change is bare. Both
    // must keep working; a null here would silently empty every existing list.
    expect(normalizeWatchKey(ETH_A)).toBe(`eth:${ETH_A}`);
    expect(parseWatchlist(JSON.stringify([ETH_A]))).toEqual([`eth:${ETH_A}`]);
    expect(toggleWatch([], ETH_A)).toEqual([`eth:${ETH_A}`]);
    expect(isWatched([`eth:${ETH_A}`], ETH_A)).toBe(true);
  });

  it('refuses a chain/format mismatch rather than storing a dead key', () => {
    // Each of these is a shape that would sail past a single shared regex.
    expect(normalizeWatchKey(`eth:${SOL_MINT}`)).toBeNull();
    expect(normalizeWatchKey(`solana:${ETH_A}`)).toBeNull();
    expect(normalizeWatchKey(`base:${SOL_MINT}`)).toBeNull();
    expect(normalizeWatchKey('polygon:' + ETH_A)).toBeNull();
    expect(normalizeWatchKey('solana:not-base58-because-of-hyphens!!')).toBeNull();
  });

  it('refuses anything that could reshape a request path', () => {
    // `pools/multi/{a,b}` joins these into a path segment. A key carrying '/'
    // or ',' would change which endpoint is called, not merely fail to match.
    for (const bad of [
      '',
      '  ',
      'not-an-address',
      '0x123',
      `eth:${ETH_A}/../../tokens`,
      `eth:${ETH_A},${ETH_B}`,
      `solana:${SOL_MINT}/trades`,
      `eth:${ETH_A}?x=1`,
    ]) {
      expect(normalizeWatchKey(bad)).toBeNull();
    }
  });

  it('parseWatchKey splits into the parts the URL builder needs', () => {
    expect(parseWatchKey(`solana:${SOL_MINT}`)).toEqual({ network: 'solana', address: SOL_MINT });
    expect(parseWatchKey(`base:${ETH_A.toUpperCase().replace('0X', '0x')}`)).toEqual({
      network: 'base',
      address: ETH_A,
    });
    expect(parseWatchKey('junk')).toBeNull();
  });

  it('watchKeyFor validates its own arguments rather than trusting the caller', () => {
    expect(watchKeyFor('eth', ETH_A)).toBe(`eth:${ETH_A}`);
    expect(watchKeyFor('eth', SOL_MINT)).toBeNull();
    expect(watchKeyFor('solana', ETH_A)).toBeNull();
  });
});

describe('a corrupt store degrades to empty, never to a throw', () => {
  it('survives junk', () => {
    for (const junk of [null, '', 'not json', '{"a":1}', '[1,2,3]', '["nope"]']) {
      expect(parseWatchlist(junk)).toEqual([]);
    }
  });

  it('drops malformed entries but keeps the good ones', () => {
    expect(
      parseWatchlist(JSON.stringify([`eth:${ETH_A}`, 'junk', 42, null, `solana:${SOL_MINT}`])),
    ).toEqual([`eth:${ETH_A}`, `solana:${SOL_MINT}`]);
  });

  it('de-duplicates across casing and across the legacy shape', () => {
    expect(
      parseWatchlist(
        JSON.stringify([
          `eth:${ETH_A}`,
          `eth:${ETH_A.toUpperCase().replace('0X', '0x')}`,
          ETH_A, // legacy bare form of the same thing
        ]),
      ),
    ).toEqual([`eth:${ETH_A}`]);
  });

  it('caps a hostile store', () => {
    const many = Array.from(
      { length: WATCHLIST_MAX + 50 },
      (_, i) => `eth:0x${i.toString(16).padStart(40, '0')}`,
    );
    expect(parseWatchlist(JSON.stringify(many))).toHaveLength(WATCHLIST_MAX);
  });
});

describe('toggling', () => {
  const a = `eth:${ETH_A}`;
  const b = `eth:${ETH_B}`;

  it('adds, removes, and does not mutate the input', () => {
    const start: string[] = [];
    const added = toggleWatch(start, a);
    expect(added).toEqual([a]);
    expect(start).toEqual([]);
    expect(toggleWatch(added, a)).toEqual([]);
  });

  it('is case-insensitive on removal for EVM keys', () => {
    expect(toggleWatch([a], `eth:${ETH_A.toUpperCase().replace('0X', '0x')}`)).toEqual([]);
  });

  it('ignores a malformed key instead of storing it', () => {
    expect(toggleWatch([a], 'garbage')).toEqual([a]);
  });

  it('drops the OLDEST entry at the cap so the newest intent survives', () => {
    const full = Array.from(
      { length: WATCHLIST_MAX },
      (_, i) => `eth:0x${i.toString(16).padStart(40, '0')}`,
    );
    const next = toggleWatch(full, b);
    expect(next).toHaveLength(WATCHLIST_MAX);
    expect(next[next.length - 1]).toBe(b);
    expect(next[0]).toBe(full[1]);
  });

  it('isWatched agrees with the list', () => {
    expect(isWatched([a], `eth:${ETH_A.toUpperCase().replace('0X', '0x')}`)).toBe(true);
    expect(isWatched([a], b)).toBe(false);
    expect(isWatched([a], 'garbage')).toBe(false);
  });
});

describe('grouping by network — the shape pools/multi takes', () => {
  it('returns only that network’s ADDRESSES, in stored order', () => {
    const list = [`eth:${ETH_A}`, `solana:${SOL_MINT}`, `base:${ETH_B}`, `eth:${ETH_B}`];
    expect(watchedOn(list, 'eth')).toEqual([ETH_A, ETH_B]);
    expect(watchedOn(list, 'base')).toEqual([ETH_B]);
    expect(watchedOn(list, 'solana')).toEqual([SOL_MINT]);
  });

  it('never leaks a key from another chain into a request list', () => {
    // The mutation this guards: dropping the `parsed.network === network` test
    // would send a Solana mint to Ethereum's pools/multi, which answers 404 —
    // and the page would render that as "could not read" for a pool that is
    // perfectly readable on its own network.
    expect(watchedOn([`solana:${SOL_MINT}`], 'eth')).toEqual([]);
    expect(watchedOn([`base:${ETH_A}`], 'eth')).toEqual([]);
  });
});

describe('round trip through storage', () => {
  it('saves and reloads', () => {
    const a = `eth:${ETH_A}`;
    expect(saveWatchlist([a])).toBe(true);
    expect(localStorage.getItem(WATCHLIST_STORAGE_KEY)).toBe(JSON.stringify([a]));
    expect(loadWatchlist()).toEqual([a]);
  });

  it('keeps the storage key stable across the key-shape migration', () => {
    // Changing it would strand every existing watchlist under a name nothing
    // reads — the entries would still be in the browser, invisible. It is also
    // the exact string listed in lib/storage.ts's EVICTION_PROTECTED_KEYS.
    expect(WATCHLIST_STORAGE_KEY).toBe('tegridy-terminal-watchlist');
  });
});
