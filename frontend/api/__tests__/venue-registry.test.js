// One server-side venue list, and it matches the client's.
//
// api/ cannot import src/, so the tradeable collections used to be typed out
// five times on the server (opensea, alchemy, orderbook, the chat holder gate
// and the v1 API). Adding Gold Cards to five lists by hand is how one gets
// missed, and adding a family collection to any of them by mistake would open
// a paid-key proxy, an order book or a chat room to a contract the venue
// cannot settle. So: one list in api/_lib/venue-registry.js, every route reads
// it, and this file holds it equal to src's VENUE_COLLECTIONS.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTIONS } from "../../src/nakamigos/constants.js";
import { ADDR, VIEW_ONLY_EVM_SLUGS } from "../../src/nakamigos/__fixtures__/jungleBayFamily.js";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ from: vi.fn() })) }));

const load = (p) => import(/* @vite-ignore */ p);
const registry = () => load("../_lib/venue-registry.js");
const clientVenue = () => load("../../src/nakamigos/lib/venue.js");

const VIEW_ONLY_CONTRACTS = VIEW_ONLY_EVM_SLUGS.map((s) => ADDR[s].toLowerCase());

describe("the server venue list", () => {
  it("equals the client's venue collections, slug to lowercase contract", async () => {
    const { VENUE_SLUG_CONTRACTS } = await registry();
    const { VENUE_COLLECTIONS } = await clientVenue();
    expect(VENUE_SLUG_CONTRACTS).toEqual(
      Object.fromEntries(VENUE_COLLECTIONS.map((c) => [c.slug, c.contract.toLowerCase()])),
    );
    expect(Object.isFrozen(VENUE_SLUG_CONTRACTS)).toBe(true);
  });

  it("is the three that trade today plus Gold Cards", async () => {
    const { VENUE_SLUG_CONTRACTS, VENUE_SLUGS, VENUE_CONTRACTS } = await registry();
    expect(VENUE_SLUG_CONTRACTS).toEqual({
      nakamigos: ADDR.nakamigos.toLowerCase(),
      gnssart: ADDR.gnssart.toLowerCase(),
      junglebay: ADDR.junglebay.toLowerCase(),
      junglebaygoldcards: ADDR.junglebaygoldcards.toLowerCase(),
    });
    expect([...VENUE_SLUGS].sort()).toEqual(Object.keys(VENUE_SLUG_CONTRACTS).sort());
    expect([...VENUE_CONTRACTS].sort()).toEqual(Object.values(VENUE_SLUG_CONTRACTS).sort());
  });

  it("every venue slug is also its OpenSea slug, so one list serves both", () => {
    for (const c of Object.values(COLLECTIONS).filter((x) => x.venueTrade)) {
      expect(c.slug, c.name).toBe(c.openseaSlug);
    }
  });

  it("the read-only OpenSea slugs are exactly the family collections OpenSea lists", async () => {
    const { READ_ONLY_OPENSEA_SLUGS } = await registry();
    const want = Object.values(COLLECTIONS)
      .filter((c) => !c.venueTrade && c.openseaSlug)
      .map((c) => c.openseaSlug)
      .sort();
    expect([...READ_ONLY_OPENSEA_SLUGS].sort()).toEqual(want);
    expect([...READ_ONLY_OPENSEA_SLUGS].sort()).toEqual([
      "bojungless", "rare-towelie-cards", "seeds-from-the-memetic-garden", "the-memes-by-junglebay-x-mfers-artists",
    ]);
  });
});

describe("every route reads that one list", () => {
  it("the OpenSea proxy's slug and contract allowlists are the venue list", async () => {
    const { VENUE_SLUGS, VENUE_CONTRACTS, READ_ONLY_OPENSEA_SLUGS } = await registry();
    const os = await load("../opensea.js");
    expect([...os.ALLOWED_SLUGS].sort()).toEqual([...VENUE_SLUGS].sort());
    expect([...os.ALLOWED_CONTRACTS].sort()).toEqual([...VENUE_CONTRACTS].sort());
    expect([...os.READ_ONLY_OPENSEA_SLUGS].sort()).toEqual([...READ_ONLY_OPENSEA_SLUGS].sort());
  });

  it("the Alchemy proxy's contract allowlist is the venue list", async () => {
    const { VENUE_CONTRACTS } = await registry();
    const alchemy = await load("../alchemy.js");
    expect([...alchemy.ALLOWED_CONTRACTS].sort()).toEqual([...VENUE_CONTRACTS].sort());
  });

  it("the order book's contract allowlist is the venue list", async () => {
    const { VENUE_CONTRACTS } = await registry();
    const ob = await load("../orderbook.js");
    expect([...ob.ALLOWED_CONTRACTS].sort()).toEqual([...VENUE_CONTRACTS].sort());
  });

  it("the chat holder gate's rooms are the venue list", async () => {
    const { VENUE_SLUG_CONTRACTS } = await registry();
    const gate = await load("../_lib/holder-gate.js");
    expect(gate.SLUG_CONTRACTS).toEqual(VENUE_SLUG_CONTRACTS);
  });

  it("the v1 API's contract allowlist and slug map are the venue list", async () => {
    const { VENUE_SLUG_CONTRACTS, VENUE_CONTRACTS } = await registry();
    const v1 = await load("../v1/index.js");
    expect([...v1.ALLOWED_CONTRACTS].sort()).toEqual([...VENUE_CONTRACTS].sort());
    expect(v1.SLUG_TO_CONTRACT).toEqual(VENUE_SLUG_CONTRACTS);
  });

  it("no route keeps a literal copy of the list", () => {
    // The GNSS Art address stands in for the whole list: a file that still
    // spells it out has its own copy, and its own chance to drift.
    const gnss = ADDR.gnssart.toLowerCase();
    for (const f of ["opensea.js", "alchemy.js", "orderbook.js", "_lib/holder-gate.js", "v1/index.js"]) {
      const src = readFileSync(join(process.cwd(), "api", f), "utf8").toLowerCase();
      expect(src.includes(gnss), `api/${f} still carries its own venue list`).toBe(false);
    }
  });
});

describe("no view-only contract reaches any tradeable list", () => {
  it("the four family contracts that live on EVM chains are in none of them", async () => {
    const os = await load("../opensea.js");
    const alchemy = await load("../alchemy.js");
    const ob = await load("../orderbook.js");
    const gate = await load("../_lib/holder-gate.js");
    const v1 = await load("../v1/index.js");
    const lists = {
      "opensea ALLOWED_CONTRACTS": [...os.ALLOWED_CONTRACTS],
      "alchemy ALLOWED_CONTRACTS": [...alchemy.ALLOWED_CONTRACTS],
      "orderbook ALLOWED_CONTRACTS": [...ob.ALLOWED_CONTRACTS],
      "holder-gate SLUG_CONTRACTS": Object.values(gate.SLUG_CONTRACTS),
      "v1 ALLOWED_CONTRACTS": [...v1.ALLOWED_CONTRACTS],
      "v1 SLUG_TO_CONTRACT": Object.values(v1.SLUG_TO_CONTRACT),
    };
    for (const [name, list] of Object.entries(lists)) {
      const lower = list.map((a) => String(a).toLowerCase());
      for (const c of VIEW_ONLY_CONTRACTS) expect(lower, `${name} admits ${c}`).not.toContain(c);
      expect(lower, `${name} is missing Gold Cards`).toContain(ADDR.junglebaygoldcards.toLowerCase());
    }
  });
});
