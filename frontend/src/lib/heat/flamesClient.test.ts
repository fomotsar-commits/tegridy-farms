// The board's browser-side boundary. Three outcomes that must never collapse into
// each other: a board, a board that is OFF, and a read we could not make.
//
// The inversion this file exists to prevent is the repo's most repeated bug class:
// an unreadable answer rendering as a confident empty one. "The island has no flames"
// and "we failed to reach the island" look identical on screen if the client is
// careless, and only one of them is true.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchFlames,
  clearFlamesCache,
  insertionRank,
  BoardUnavailableError,
  type Flame,
} from './flamesClient';

const BODY = {
  flames: [
    {
      x_username: '@_seacasa',
      degrees: 1785.14,
      tier: 'Elder',
      held_since_unix: 1_642_281_378,
      token_count: 18,
    },
    {
      x_username: null,
      degrees: 524.27,
      tier: 'Elder',
      held_since_unix: 1_644_551_442,
      token_count: 6,
    },
  ],
  as_of_unix: 1_788_684_733,
};

function res({ status = 200, body = BODY as unknown, json = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (!json) throw new SyntaxError('not json');
      return body;
    },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearFlamesCache();
  fetchMock = vi.fn(async () => res());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearFlamesCache();
});

describe('the request', () => {
  it('goes through our proxy, never the island directly', async () => {
    await fetchFlames({ limit: 5, claimed: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/aggregator?resource=flames&limit=5&claimed=1');
  });

  it('omits claimed when the caller does not ask for it', async () => {
    await fetchFlames({ limit: 500 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/aggregator?resource=flames&limit=500');
  });

  it.each([
    [9999, 500],
    [0, 1],
    [-3, 1],
    [25.7, 25],
  ])('clamps a limit of %s to %i', async (given, expected) => {
    await fetchFlames({ limit: given });
    expect(fetchMock.mock.calls[0][0]).toContain(`limit=${expected}`);
  });
});

describe('the three outcomes', () => {
  it('returns the board when the island answers', async () => {
    const board = await fetchFlames({ limit: 5 });
    expect(board?.flames).toHaveLength(2);
    expect(board?.asOfUnix).toBe(1_788_684_733);
  });

  it('returns null — not an empty board — when the island’s board is OFF', async () => {
    fetchMock.mockResolvedValue(res({ status: 204 }));
    await expect(fetchFlames({ limit: 5 })).resolves.toBeNull();
  });

  it.each([500, 502, 503])('THROWS on upstream %i rather than reading as empty', async (status) => {
    fetchMock.mockResolvedValue(res({ status }));
    await expect(fetchFlames({ limit: 5 })).rejects.toBeInstanceOf(BoardUnavailableError);
  });

  it('THROWS when the network fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(fetchFlames({ limit: 5 })).rejects.toBeInstanceOf(BoardUnavailableError);
  });

  it('THROWS on a non-JSON body', async () => {
    fetchMock.mockResolvedValue(res({ json: false }));
    await expect(fetchFlames({ limit: 5 })).rejects.toBeInstanceOf(BoardUnavailableError);
  });

  it('THROWS on a 200 whose shape moved, never "nobody is on the island"', async () => {
    fetchMock.mockResolvedValue(res({ body: { board: [], as_of_unix: 1 } }));
    await expect(fetchFlames({ limit: 5 })).rejects.toBeInstanceOf(BoardUnavailableError);
  });

  it('THROWS when rows arrived but none could be read', async () => {
    // The upstream said there ARE flames; we just could not parse any. Answering with
    // an empty board here would be a confident answer to a question we failed.
    fetchMock.mockResolvedValue(res({ body: { flames: [{ nonsense: true }], as_of_unix: 1 } }));
    await expect(fetchFlames({ limit: 5 })).rejects.toBeInstanceOf(BoardUnavailableError);
  });

  it('returns a genuinely empty board as empty, when the island says so', async () => {
    fetchMock.mockResolvedValue(res({ body: { flames: [], as_of_unix: 1 } }));
    await expect(fetchFlames({ limit: 5 })).resolves.toEqual({ flames: [], asOfUnix: 1 });
  });
});

describe('parsing a flame', () => {
  it('normalises the handle to its bare form', async () => {
    const board = await fetchFlames({ limit: 5 });
    expect(board?.flames[0].xHandle).toBe('_seacasa');
  });

  it('reads an unnamed flame as null', async () => {
    const board = await fetchFlames({ limit: 5 });
    expect(board?.flames[1].xHandle).toBeNull();
  });

  it('refuses a spoofed handle through the SAME validator the reading uses', async () => {
    // One implementation for the board, the tape and the instrument, so a hostile
    // handle cannot slip in through whichever surface forgot to check.
    fetchMock.mockResolvedValue(
      res({ body: { flames: [{ ...BODY.flames[0], x_username: '//evil.example' }], as_of_unix: 1 } }),
    );
    const board = await fetchFlames({ limit: 5 });
    expect(board?.flames[0].xHandle).toBeNull();
  });

  it('drops a row with no readable degrees rather than painting it as zero', async () => {
    fetchMock.mockResolvedValue(
      res({
        body: {
          flames: [BODY.flames[0], { ...BODY.flames[1], degrees: 'hot' }],
          as_of_unix: 1,
        },
      }),
    );
    const board = await fetchFlames({ limit: 5 });
    expect(board?.flames).toHaveLength(1);
    expect(board?.flames[0].degrees).toBe(1785.14);
  });
});

describe('the cache', () => {
  it('does not re-ask the island for the same board twice', async () => {
    await fetchFlames({ limit: 5, claimed: true });
    await fetchFlames({ limit: 5, claimed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps different shapes of request apart', async () => {
    await fetchFlames({ limit: 5, claimed: true });
    await fetchFlames({ limit: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches an OFF board too, so a dark board is not re-asked every render', async () => {
    fetchMock.mockResolvedValue(res({ status: 204 }));
    await fetchFlames({ limit: 5 });
    await fetchFlames({ limit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure, so an outage cannot outlive itself', async () => {
    fetchMock.mockResolvedValue(res({ status: 503 }));
    await expect(fetchFlames({ limit: 5 })).rejects.toThrow();
    fetchMock.mockResolvedValue(res());
    await expect(fetchFlames({ limit: 5 })).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads when the caller insists', async () => {
    await fetchFlames({ limit: 5 });
    await fetchFlames({ limit: 5, fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('insertionRank', () => {
  const f = (degrees: number): Flame => ({
    xHandle: null,
    degrees,
    tier: 'Elder',
    heldSinceUnix: null,
    tokenCount: 0,
  });

  it('counts how many beat it, and grows the board by one', () => {
    expect(insertionRank(100, [f(300), f(200), f(150), f(50)])).toEqual({ rank: 4, of: 5 });
  });

  it('puts a number that beats everyone at the top', () => {
    expect(insertionRank(999, [f(300), f(200)])).toEqual({ rank: 1, of: 3 });
  });

  it('puts a number that beats nobody at the bottom', () => {
    expect(insertionRank(1, [f(300), f(200)])).toEqual({ rank: 3, of: 3 });
  });

  it('does not let an exact tie displace the flame already there', () => {
    // Strictly greater, so an equal number sits BELOW the one on the board. Ranking
    // above it would be the venue asserting a placement the island never made.
    expect(insertionRank(200, [f(300), f(200)])).toEqual({ rank: 2, of: 3 });
  });

  it('ranks first against an empty board', () => {
    expect(insertionRank(10, [])).toEqual({ rank: 1, of: 1 });
  });
});
