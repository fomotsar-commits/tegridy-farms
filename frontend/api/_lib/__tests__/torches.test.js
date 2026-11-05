// Torches proxy (api/_lib/torches.js) — server-side suite.
//
// What this pins: the five island routes are fixed URLs (nothing from the request
// reaches them); only allowlisted fields leave (no signatures, no painted-card links,
// no person ids); each part stands alone, so one failed route nulls its own part and
// never zeroes it; a full page of flames is not a count; and only an island that
// could not be read at all is a 502.
//
// Mock/req/res conventions mirror api/_lib/__tests__/flames.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

// Shapes read live from memetics.wtf on 2026-10-23, cut to a few rows each.
const TORCHES = {
  torches: [
    {
      id: 84, place: "fire", kind: "fire", for: null, door: "https://memetics.wtf/#fire", label: "THE FIRE",
      row: 1, slot: 62, name: "_seacasa", amount: 100000,
      signature: "4FVep7etMogipQYVuWshFcYL9kVtrwm9KyrnR9kK5j3fWGPz1zGgwYt2kdxqQN8hdRpGtqnP2PpduQcLQ2qAenex",
      lit_at: "2026-10-23T05:26:26.000Z", piece: { ref: null, title: null, artist: null, image: null },
      asset: null, status: "lit", card: { wide: "https://api.memetics.wtf/api/torch/card/84.png" },
    },
    {
      id: 70, place: "jungle-bay", kind: "bungalow", for: null, door: "https://memetics.wtf/b/jungle-bay",
      label: "$JBM", row: 1, slot: 3, name: "_seacasa", amount: 75000,
      signature: "sigJBM", lit_at: "2026-10-15T21:05:11.000Z", piece: { ref: null }, status: "lit",
      card: { wide: "https://api.memetics.wtf/api/torch/card/70.png" },
    },
    {
      id: 68, place: "solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump", kind: "bungalow", label: "$BAYLA",
      row: 1, slot: 7, name: "_seacasa", amount: 175000, signature: "sigBAYLA",
      lit_at: "2026-10-15T00:27:48.000Z", status: "minted",
    },
    {
      id: 40, place: "solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump", kind: "bungalow", label: "$BAYLA",
      row: 1, slot: 6, name: null, amount: 150000, signature: "sigOlder", lit_at: "2026-10-09T10:00:00.000Z",
    },
  ],
  as_of_unix: 1792746260,
};
const PLACES = {
  gate_degrees: 80,
  places: [
    {
      place: "solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump", label: "$BAYLA",
      name: "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump", image: null,
      collection: "7EqRsYwYgHsFBmqsJkhpKpvYhT4P8mbt1ovy76b9B3xc", torched: 700000, torches: 7,
      open_row: 1, next_slot: 8, next_price: 200000, slots_per_row: 12, leading: true,
    },
    {
      place: "jungle-bay", label: "$JBM", name: "Jungle Bay Memes", image: null, collection: "CWGu",
      torched: 150000, torches: 3, open_row: 1, next_slot: 4, next_price: 100000, slots_per_row: 12, leading: false,
    },
    {
      place: "soy", label: "$SOY", name: "Soyjak", image: null, collection: "2tGV", torched: 25000,
      torches: 1, open_row: 1, next_slot: 2, next_price: 50000, slots_per_row: 12, leading: false,
    },
  ],
  as_of_unix: 1792746261,
};
const SEASON = {
  season: 1, starts_at: "2026-09-30T04:38:15.000Z", ends_at: "2026-12-29T04:38:15.000Z",
  dials: { count: 20, cap_per_wallet: 12, days: 90, gate_degrees: 80 },
  people: [{ name: "_seacasa", torches: 12 }], bonfire: [], flames: [], as_of_unix: 1792746260,
};
const FIRE = {
  floor: 1000, fire: { since: "2026-10-16T09:04:21.940Z", burned: 239799, feeds: 14, torches: 0 },
  all_time: { burned: 5716710, feeds: 58, torches: 26, first_lit_at: "2026-09-30T04:38:15.000Z" },
  embers: [], as_of_unix: 1792746261,
};
const flameRow = (i) => ({
  x_username: i === 0 ? "@_seacasa" : null, x_pfp: null, degrees: 1831.24 - i, tier: "Elder",
  held_since_unix: 1642281378, token_count: 14, wallet_count: 18,
  person_id: "0414f482-ef4b-41ea-8961-0235f52e4444",
});
const FLAMES = { flames: Array.from({ length: 134 }, (_, i) => flameRow(i)), as_of_unix: 1792746260 };

const URLS = {
  torches: "https://memetics.wtf/api/torches?limit=500",
  places: "https://memetics.wtf/api/torches/places",
  season: "https://memetics.wtf/api/torches/season",
  fire: "https://memetics.wtf/api/fire",
  flames: "https://memetics.wtf/api/flames?limit=500",
};

function makeReq({ method = "GET", query = {}, headers = {} } = {}) {
  return { method, query, headers: { origin: "https://tegridyfarms.vercel.app", ...headers } };
}

function makeRes() {
  const headerSpy = vi.fn();
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const endSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: endSpy,
  };
  return { res, headerSpy, statusSpy, jsonSpy, endSpy };
}

/** Answers by URL. A route set to `null` fails with a 500; one set to a string returns it raw. */
function islandWith(overrides = {}) {
  const bodies = {
    [URLS.torches]: TORCHES, [URLS.places]: PLACES, [URLS.season]: SEASON,
    [URLS.fire]: FIRE, [URLS.flames]: FLAMES, ...overrides,
  };
  return vi.fn(async (url) => {
    if (!(url in bodies)) throw new Error(`unexpected upstream ${url}`);
    const body = bodies[url];
    if (body === null) return { ok: false, status: 500, headers: { get: () => null }, body: null, text: async () => "" };
    return {
      ok: true, status: 200, headers: { get: () => null }, body: null,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  });
}

let handleTorches;
let fetchMock;
let consoleErrorSpy;

async function call(req = makeReq()) {
  const r = makeRes();
  await handleTorches(req, r.res);
  return { ...r, status: r.statusSpy.mock.calls[0]?.[0], body: r.jsonSpy.mock.calls[0]?.[0] };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NODE_ENV = "test";
  fetchMock = islandWith();
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleTorches } = await import("../torches.js"));
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  delete process.env.ALLOWED_ORIGIN;
});

describe("the island read", () => {
  it("reads exactly the five fixed island routes, whatever the request carries", async () => {
    await call(makeReq({ query: { limit: "99999", place: "../../etc", url: "https://evil.example" } }));
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(Object.values(URLS).sort());
  });

  it("paints each room's torches from places, with its newest torch as the last", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    const bayla = body.places.find((p) => p.label === "$BAYLA");
    expect(bayla).toEqual({
      place: "solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump",
      label: "$BAYLA",
      torches: 7,
      open_row: 1,
      next_price: 200000,
      slots_per_row: 12,
      last: { name: "_seacasa", amount: 175000, lit_at: "2026-10-15T00:27:48.000Z" },
    });
    // A place with no torch in the list has no last torch, never someone else's.
    expect(body.places.find((p) => p.label === "$SOY").last).toBeNull();
  });

  it("the island's last torch is its newest, a feed to the fire included, as the island's own page counts it", async () => {
    const { body } = await call();
    expect(body.last_torch).toEqual({
      kind: "fire", place: "fire", label: "THE FIRE", name: "_seacasa", amount: 100000, lit_at: "2026-10-23T05:26:26.000Z",
    });
  });

  it("a feed to the fire is never a room's last torch", async () => {
    const feedIntoJbm = { ...TORCHES.torches[0], place: "jungle-bay", lit_at: "2026-10-23T06:00:00.000Z" };
    fetchMock = islandWith({ [URLS.torches]: { torches: [feedIntoJbm, ...TORCHES.torches] } });
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.places.find((p) => p.label === "$JBM").last).toEqual({ name: "_seacasa", amount: 75000, lit_at: "2026-10-15T21:05:11.000Z" });
  });

  it("orders by the time lit, not by the order served", async () => {
    fetchMock = islandWith({ [URLS.torches]: { torches: [...TORCHES.torches].reverse() } });
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.last_torch.label).toBe("THE FIRE");
    expect(body.places.find((p) => p.label === "$BAYLA").last.amount).toBe(175000);
  });

  it("the fire is the island's served all-time total, the season its number and end, the flames counted", async () => {
    const { body } = await call();
    expect(body.fire).toEqual({ burned: 5716710 });
    expect(body.season).toEqual({ season: 1, ends_at: "2026-12-29T04:38:15.000Z" });
    expect(body.flames).toBe(134);
  });

  it("is cached at the edge for about a minute", async () => {
    const { headerSpy } = await call();
    expect(headerSpy).toHaveBeenCalledWith("Cache-Control", "s-maxage=60, stale-while-revalidate=240");
  });
});

// THE TIMELINE (island answer twenty-four, build 7): the newest piece hung on the island,
// read from the same /api/torches the doors already read. Shapes are torch #95 and #70 as
// the island served them on 2026-11-03: a hung piece rides a minted bungalow torch.
const HUNG = {
  id: 95, place: "ethereum-0x6982508145454ce325ddbe47a25d4ec3d2311933", kind: "bungalow", for: null,
  door: "https://memetics.wtf/b/ethereum-0x6982508145454ce325ddbe47a25d4ec3d2311933", label: "$PEPE", row: 1, slot: 9,
  name: "loground", amount: 50000, signature: "sigHUNG", lit_at: "2026-10-28T20:55:02.000Z",
  piece: {
    ref: "7f4dc061-e10a-4ae3-b73f-83e078efad26", title: "Halloween", artist: "loground",
    image: "https://junglebayisland.com/api/storage-image?key=gallery%2Floground%2F7f4dc061-e10a-4ae3-b73f-83e078efad26%2Flarge.webp",
  },
  asset: "BsNpDPMz8xLyYiAUp4JRNr23zfQNXr5NAv5GrP2ECR1E", status: "minted",
  card: { wide: "https://api.memetics.wtf/api/torch/card/95.png" },
};
const HUNG_OLDER = {
  ...HUNG, id: 70, place: "jungle-bay", door: "https://memetics.wtf/b/jungle-bay", label: "$JBM", lit_at: "2026-10-15T21:05:11.000Z",
  piece: {
    ref: "a919adb9-c1a6-4008-86f7-724bc773c966", title: "Skull", artist: "CoppyBoyz ",
    image: "https://junglebayisland.com/api/storage-image?key=gallery%2Fcoppyboyz%2Fa919adb9-c1a6-4008-86f7-724bc773c966%2Flarge.webp",
  },
  asset: "5PtsSxVJJzFJ14UzfFtMJ4o6tu5JYFgMQ9b8Rjzupeir",
};
const withPieces = (...extra) => ({ [URLS.torches]: { torches: [...TORCHES.torches, ...extra], as_of_unix: 1793677136 } });

describe("the newest piece hung on the island", () => {
  it("is the newest torch that hangs a piece: its picture, artist, title, the island page it hangs in, and when", async () => {
    // Torch #112, a feed to the fire lit after the piece: the island's newest torch hangs nothing.
    const feed = { ...TORCHES.torches[0], id: 112, lit_at: "2026-11-02T17:35:59.000Z" };
    fetchMock = islandWith(withPieces(HUNG_OLDER, HUNG, feed));
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.last_piece).toEqual({
      image: HUNG.piece.image,
      artist: "loground",
      title: "Halloween",
      door: "https://memetics.wtf/b/ethereum-0x6982508145454ce325ddbe47a25d4ec3d2311933",
      lit_at: "2026-10-28T20:55:02.000Z",
    });
    // A feed to the fire hangs nothing, so the island's last torch and its last piece differ.
    expect(body.last_torch.kind).toBe("fire");
  });

  it("trims the artist's name as the island typed it", async () => {
    fetchMock = islandWith(withPieces(HUNG_OLDER));
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.last_piece.artist).toBe("CoppyBoyz");
    expect(body.last_piece.title).toBe("Skull");
  });

  it.each([
    ["a picture off the island's image host", { piece: { ...HUNG.piece, image: "https://evil.example/x.webp" } }],
    ["a picture not on https", { piece: { ...HUNG.piece, image: "http://junglebayisland.com/api/storage-image?key=x" } }],
    ["a picture that is not a URL", { piece: { ...HUNG.piece, image: "javascript:alert(1)" } }],
    ["no artist", { piece: { ...HUNG.piece, artist: "   " } }],
    ["a door off the island", { door: "https://evil.example/b/pepe" }],
    ["a time that is not one", { lit_at: "soon" }],
  ])("passes over a piece with %s, to the next one that reads", async (_why, over) => {
    fetchMock = islandWith(withPieces(HUNG_OLDER, { ...HUNG, ...over }));
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.last_piece.title).toBe("Skull");
  });

  it("is null when no torch hangs a piece, and when the torches route was not read", async () => {
    expect((await call()).body.last_piece).toBeNull();
    fetchMock = islandWith({ [URLS.torches]: null });
    vi.stubGlobal("fetch", fetchMock);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.last_piece).toBeNull();
  });
});

describe("the allowlist", () => {
  it("forwards no signature, painted card, piece ref or asset, person id or wallet count", async () => {
    fetchMock = islandWith(withPieces(HUNG_OLDER, HUNG));
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    const text = JSON.stringify(body);
    for (const leak of [
      "signature", "sigBAYLA", "sigHUNG", "card", "torch/card", "person_id", "wallet_count", "0414f482", "collection", "x_pfp",
      // The piece's own ref and its minted asset stay behind; its picture's URL is the island's to name.
      '"ref"', '"asset"', "BsNpDPMz8xLy", "5PtsSxVJJzFJ", "minted", '"status"',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe("each part stands alone, and an unread part is never a zero", () => {
  it.each([
    ["torches", "last_torch"],
    ["places", "places"],
    ["season", "season"],
    ["fire", "fire"],
    ["flames", "flames"],
  ])("a failed %s route nulls only its own part", async (route, part) => {
    fetchMock = islandWith({ [URLS[route]]: null });
    vi.stubGlobal("fetch", fetchMock);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body[part]).toBeNull();
    for (const other of ["places", "season", "fire", "flames"].filter((k) => k !== part)) {
      expect(body[other], other).not.toBeNull();
    }
  });

  it("a torches route that fails leaves each place's last torch null, not another's", async () => {
    fetchMock = islandWith({ [URLS.torches]: null });
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.places.every((p) => p.last === null)).toBe(true);
    expect(body.places.find((p) => p.label === "$BAYLA").torches).toBe(7);
  });

  it("a route that answers something unreadable is unread", async () => {
    fetchMock = islandWith({
      [URLS.fire]: "<html>not json</html>",
      [URLS.season]: { season: "one" },
      [URLS.places]: { places: [{ place: "bobo", torches: "3" }] },
      [URLS.flames]: { board: [] },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.fire).toBeNull();
    expect(body.season).toBeNull();
    expect(body.places).toBeNull();
    expect(body.flames).toBeNull();
  });

  it("a full page of flames is where the island stopped, not a count", async () => {
    fetchMock = islandWith({ [URLS.flames]: { flames: Array.from({ length: 500 }, (_, i) => flameRow(i)) } });
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.flames).toBeNull();
  });

  it("an island that could not be read at all is a 502, never an empty answer", async () => {
    fetchMock = islandWith(Object.fromEntries(Object.values(URLS).map((u) => [u, null])));
    vi.stubGlobal("fetch", fetchMock);
    const { status, body, headerSpy } = await call();
    expect(status).toBe(502);
    expect(body).toEqual({ error: "The island could not be read" });
    expect(headerSpy).not.toHaveBeenCalledWith("Cache-Control", expect.anything());
  });

  it("a network error on every route is a 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const { status } = await call();
    expect(status).toBe(502);
  });
});

// The countdown's roster (island answer twenty-five, screen 2): "{n} flames are warming toward
// the door right now", the flames from the Observer floor up to the 80° door, counted from the
// same board read the flame count comes from, and only the count leaves.
describe("the flames warming toward the launch door", () => {
  const board = (degrees) => ({ flames: degrees.map((d, i) => ({ ...flameRow(i), degrees: d })), as_of_unix: 1792746260 });

  it("counts the flames from 30° up to the 80° door, the door itself not included", async () => {
    fetchMock = islandWith({ [URLS.flames]: board([1831.24, 120, 80, 79.99, 55, 30, 29.99, 0]) });
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call();
    expect(body.warming).toBe(3);
    expect(body.flames).toBe(8);
  });

  it("a board with none in the band is a read zero, not an unread one", async () => {
    fetchMock = islandWith({ [URLS.flames]: board([300, 90, 12, 0]) });
    vi.stubGlobal("fetch", fetchMock);
    expect((await call()).body.warming).toBe(0);
  });

  it("a full page is where the island stopped, so it is not a count", async () => {
    fetchMock = islandWith({ [URLS.flames]: board(Array.from({ length: 500 }, () => 50)) });
    vi.stubGlobal("fetch", fetchMock);
    expect((await call()).body.warming).toBeNull();
  });

  it("a flame with no readable degrees leaves the count unread, never a smaller number", async () => {
    const flames = board([120, 55, 40]).flames;
    flames[1] = { ...flames[1], degrees: "55" };
    fetchMock = islandWith({ [URLS.flames]: { flames } });
    vi.stubGlobal("fetch", fetchMock);
    expect((await call()).body.warming).toBeNull();
  });

  it("a flames route that fails or answers no list leaves the count null, and the rest standing", async () => {
    for (const failed of [null, { board: [] }]) {
      fetchMock = islandWith({ [URLS.flames]: failed });
      vi.stubGlobal("fetch", fetchMock);
      const { status, body } = await call();
      expect(status).toBe(200);
      expect(body.warming).toBeNull();
      expect(body.fire).toEqual({ burned: 5716710 });
    }
  });

  it("forwards the count and nothing about the flames counted", async () => {
    fetchMock = islandWith({ [URLS.flames]: board([55, 40]) });
    vi.stubGlobal("fetch", fetchMock);
    const text = JSON.stringify((await call()).body);
    for (const leak of ["person_id", "wallet_count", "x_username", "held_since_unix", "token_count"]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe("the dispatch", () => {
  it("api/aggregator sends ?resource=torches here, not into the provider 404", async () => {
    const { default: handler } = await import("../../aggregator.js");
    const r = makeRes();
    await handler(makeReq({ query: { resource: "torches" } }), r.res);
    expect(r.statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledWith(URLS.places, expect.anything());
  });
});

describe("the gates", () => {
  it("answers OPTIONS with no upstream read", async () => {
    const { res, statusSpy, endSpy } = makeRes();
    await handleTorches(makeReq({ method: "OPTIONS" }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(endSpy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a write method", async () => {
    const { status } = await call(makeReq({ method: "POST" }));
    expect(status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin in production before any upstream read", async () => {
    process.env.NODE_ENV = "production";
    vi.resetModules();
    ({ handleTorches } = await import("../torches.js"));
    const { status } = await call(makeReq({ headers: { origin: "https://evil.example" } }));
    expect(status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
