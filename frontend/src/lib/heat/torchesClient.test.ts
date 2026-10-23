// The browser's read of the island's torches, and the venue's pinned twelve.
//
// The pin is the part a typo would break silently: a wrong place string shows a room
// nothing, forever, with no error. So every chain-and-address place is checked against
// the registry's own chain and address, and every live room is checked to be pinned.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNGALOWS } from '../bungalows';
import {
  ISLAND_ROOMS, TorchesUnavailableError, ageWords, clearTorchesCache, fetchIslandTorches,
  islandRoomHref, roomOfPlace, roomTorches, seasonLine, type IslandTorches,
} from './torchesClient';

// What /api/aggregator?resource=torches answered for the island on 2026-10-23, cut short.
const PROXY_BODY = {
  places: [
    {
      place: 'solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump', label: '$BAYLA', torches: 7, open_row: 1,
      next_price: 200000, slots_per_row: 12, last: { name: '_seacasa', amount: 175000, lit_at: '2026-10-15T00:27:48.000Z' },
    },
    { place: 'jungle-bay', label: '$JBM', torches: 3, open_row: 1, next_price: 100000, slots_per_row: 12, last: null },
  ],
  last_torch: { place: 'jungle-bay', label: '$JBM', name: '_seacasa', amount: 75000, lit_at: '2026-10-15T21:05:11.000Z' },
  fire: { burned: 5716710 },
  season: { season: 1, ends_at: '2026-12-29T04:38:15.000Z' },
  flames: 134,
  as_of_unix: 1792746261,
};

function answer(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

beforeEach(() => clearTorchesCache());
afterEach(() => vi.unstubAllGlobals());

describe('the pinned twelve', () => {
  it('pins every live room on the island, and nothing else', () => {
    const live = BUNGALOWS.filter((b) => b.live && b.chain !== 'tbd').map((b) => b.id).sort();
    expect(Object.keys(ISLAND_ROOMS).sort()).toEqual(live);
    expect(live).toHaveLength(12);
  });

  it('a chain-and-address place is the registry chain and address, lowercase, as the island serves them', () => {
    for (const [roomId, { place }] of Object.entries(ISLAND_ROOMS)) {
      if (!place.includes('-0x') && !place.startsWith('solana-')) continue;
      const b = BUNGALOWS.find((x) => x.id === roomId)!;
      expect(place, roomId).toBe(`${b.chain}-${b.address!.toLowerCase()}`);
    }
  });

  it('the keys are the twelve the island named in answer eighteen', () => {
    expect(Object.values(ISLAND_ROOMS).map((r) => r.key).sort()).toEqual(
      ['bayla', 'bnkr', 'bobo', 'brainlet', 'drb', 'jungle-bay', 'mfer', 'pepe', 'qr', 'rizz', 'soy', 'toweli'],
    );
    expect(islandRoomHref('bayla')).toBe('https://memetics.wtf/b/bayla');
    expect(islandRoomHref('jbm')).toBe('https://memetics.wtf/b/jungle-bay');
    expect(islandRoomHref('nb1')).toBeNull();
  });

  it('a served place maps back to its room', () => {
    expect(roomOfPlace('jungle-bay')).toBe('jbm');
    expect(roomOfPlace('solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump')).toBe('bayla');
    expect(roomOfPlace('fire')).toBeNull();
  });
});

describe('fetchIslandTorches', () => {
  it('reads one proxy route and keeps each part', async () => {
    const fetchMock = answer(200, PROXY_BODY);
    vi.stubGlobal('fetch', fetchMock);
    const data = await fetchIslandTorches();
    expect(fetchMock).toHaveBeenCalledWith('/api/aggregator?resource=torches', expect.anything());
    expect(data.fireBurned).toBe(5716710);
    expect(data.flames).toBe(134);
    expect(data.season).toEqual({ number: 1, endsAtMs: Date.parse('2026-12-29T04:38:15.000Z') });
    expect(data.lastTorch).toEqual({ place: 'jungle-bay', label: '$JBM', name: '_seacasa', amount: 75000, litAtMs: Date.parse('2026-10-15T21:05:11.000Z') });
  });

  it('a part the proxy could not read stays null; it never becomes a zero', async () => {
    vi.stubGlobal('fetch', answer(200, { ...PROXY_BODY, fire: null, flames: null, season: null, last_torch: null }));
    const data = await fetchIslandTorches();
    expect(data.fireBurned).toBeNull();
    expect(data.flames).toBeNull();
    expect(data.season).toBeNull();
    expect(data.lastTorch).toBeNull();
    expect(data.places).toHaveLength(2);
  });

  it('a 502 and a network error are both unavailable, never an empty island', async () => {
    vi.stubGlobal('fetch', answer(502, { error: 'The island could not be read' }));
    await expect(fetchIslandTorches()).rejects.toBeInstanceOf(TorchesUnavailableError);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchIslandTorches({ fresh: true })).rejects.toBeInstanceOf(TorchesUnavailableError);
  });
});

describe('roomTorches', () => {
  async function read(body: unknown = PROXY_BODY): Promise<IslandTorches> {
    vi.stubGlobal('fetch', answer(200, body));
    return fetchIslandTorches({ fresh: true });
  }

  it('BAYLA: 7 of 12 lit, the next torch 200,000, the last torch, and the island page', async () => {
    expect(roomTorches(await read(), 'bayla')).toEqual({
      lit: 7, of: 12, nextPrice: 200000,
      last: { name: '_seacasa', amount: 175000, litAtMs: Date.parse('2026-10-15T00:27:48.000Z') },
      href: 'https://memetics.wtf/b/bayla',
      readAtMs: expect.any(Number),
    });
  });

  it('JBM is the island place "jungle-bay"', async () => {
    expect(roomTorches(await read(), 'jbm')).toMatchObject({ lit: 3, of: 12, href: 'https://memetics.wtf/b/jungle-bay' });
  });

  it('counts the open row: the fourteenth torch is two of twelve on row two', async () => {
    const p = { ...PROXY_BODY.places[0], torches: 14, open_row: 2 };
    expect(roomTorches(await read({ ...PROXY_BODY, places: [p] }), 'bayla')).toMatchObject({ lit: 2, of: 12 });
  });

  it('shows nothing on a miss: an unpinned room, an unserved place, no places, a count that does not add up', async () => {
    const data = await read();
    expect(roomTorches(data, 'nb1')).toBeNull();
    expect(roomTorches(data, 'soy')).toBeNull();
    expect(roomTorches(null, 'bayla')).toBeNull();
    expect(roomTorches(await read({ ...PROXY_BODY, places: null }), 'bayla')).toBeNull();
    const odd = { ...PROXY_BODY.places[0], torches: 30, open_row: 1 };
    expect(roomTorches(await read({ ...PROXY_BODY, places: [odd] }), 'bayla')).toBeNull();
  });
});

describe('the words', () => {
  const NOW = Date.parse('2026-10-23T03:00:00.000Z');

  it('says a torch\'s age in the largest whole unit', () => {
    expect(ageWords(Date.parse('2026-10-15T00:27:48.000Z'), NOW)).toBe('8 days ago');
    expect(ageWords(NOW - 86_400_000, NOW)).toBe('1 day ago');
    expect(ageWords(NOW - 3 * 3_600_000, NOW)).toBe('3 hours ago');
    expect(ageWords(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(ageWords(NOW - 10_000, NOW)).toBe('just now');
  });

  it('says the days left in the season, and nothing once it has ended', () => {
    const season = { number: 1, endsAtMs: Date.parse('2026-12-29T04:38:15.000Z') };
    expect(seasonLine(season, NOW)).toBe('68 days left in season one');
    expect(seasonLine({ ...season, endsAtMs: NOW + 3_600_000 }, NOW)).toBe('1 day left in season one');
    expect(seasonLine({ number: 12, endsAtMs: NOW + 5 * 86_400_000 }, NOW)).toBe('5 days left in season 12');
    expect(seasonLine({ ...season, endsAtMs: NOW - 1 }, NOW)).toBeNull();
  });
});
