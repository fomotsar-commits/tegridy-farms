// The marketplace landing lists nine collections and states each one's facts
// in its own currency, chain and unit.
//
// Nothing covered CollectionLanding before this. The card hardcoded ETH and
// "? items", which is harmless while every collection is an Ethereum ERC-721
// and a misstatement the moment one is not: Junglets' 0.695 SOL floor printed
// as 0.695 ETH is wrong by roughly fifty times, and an ERC-1155's supply is a
// count of designs and a count of editions, not one number.
//
// Only the network is faked: api.js's two readers are spies, and the family
// collections' reads are answered from their captured responses.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { COLLECTIONS } from "../constants";
import { EXPECTED_FAMILY, REGISTRY_ORDER, VIEW_ONLY_SLUGS, VENUE_SLUGS } from "../__fixtures__/jungleBayFamily";
import bojStats from "../../../e2e/fixtures/jungle-bay-family/opensea-stats.bojungless.json";
import seedsStats from "../../../e2e/fixtures/jungle-bay-family/opensea-stats.seeds-from-the-memetic-garden.json";
import memesStats from "../../../e2e/fixtures/jungle-bay-family/opensea-stats.the-memes-by-junglebay-x-mfers-artists.json";
import towStats from "../../../e2e/fixtures/jungle-bay-family/opensea-stats.rare-towelie-cards.json";
import meStats from "../../../e2e/fixtures/jungle-bay-family/me-stats.junglet.json";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchCollectionStats: vi.fn(async ({ contract }) => {
    if (String(contract).toLowerCase() === "0x6aa03f42c5366e2664c887eb2e90844ca00b92f3") {
      return { floor: null, volume: 43, owners: 97, supply: 123 };
    }
    return { floor: 0.1, volume: 100, owners: 1000, supply: null };
  }),
  fetchTokens: vi.fn(async () => ({ tokens: [], continuation: null })),
}));

const FIX = {
  "collections/bojungless/stats": bojStats.response,
  "collections/seeds-from-the-memetic-garden/stats": seedsStats.response,
  "collections/the-memes-by-junglebay-x-mfers-artists/stats": memesStats.response,
  "collections/rare-towelie-cards/stats": towStats.response,
  "/collections/junglet/stats": meStats.response,
};

let fetchMock;

// Rendering the real App costs a first import of several seconds.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn(async (input) => {
    const url = new URL(String(input), "https://memetics.finance");
    const body = FIX[url.searchParams.get("path")];
    return body
      ? { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body }
      : { ok: false, status: 503, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  window.matchMedia = (q) => ({
    matches: /prefers-reduced-motion/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderLanding() {
  const { default: CollectionLanding } = await import("./CollectionLanding.jsx");
  return render(<MemoryRouter><CollectionLanding /></MemoryRouter>);
}

/** The card (a <button>) whose heading names this collection. */
function card(slug) {
  const name = COLLECTIONS[slug]?.name ?? EXPECTED_FAMILY[slug]?.name;
  const heading = screen.getAllByRole("heading", { level: 3 }).find((h) => h.textContent.trim() === name);
  expect(heading, `no card for ${slug}`).toBeTruthy();
  return heading.closest("button");
}

const settle = () => waitFor(() => expect(screen.queryAllByText(/^Floor$/).length).toBeGreaterThan(0));
const text = (el) => (el.textContent || "").replace(/\s+/g, " ");

describe("the landing lists nine collections", () => {
  it("one card per registry entry, in registry order", async () => {
    await renderLanding();
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent.trim());
    expect(names).toEqual(REGISTRY_ORDER.map((s) => COLLECTIONS[s]?.name ?? EXPECTED_FAMILY[s].name));
  });

  it("counts nine collections across three chains", async () => {
    await renderLanding();
    const count = screen.getByText(/^9 Collections$/);
    const badge = count.parentElement;
    expect(text(badge)).toMatch(/Ethereum/);
    expect(text(badge)).toMatch(/Base/);
    expect(text(badge)).toMatch(/Solana/);
  });

  it("the fee line names how many collections actually trade here", async () => {
    await renderLanding();
    expect(screen.getByText("Native listings: one flat 1% fee on the 4 collections that trade here, every fee funds the treasury")).toBeInTheDocument();
  });
});

describe("each card reads from the right place", () => {
  it("venue collections read the venue's stats; the five view-only ones never do", async () => {
    await renderLanding();
    await settle();
    const api = await import("../api");
    const asked = api.fetchCollectionStats.mock.calls.map(([a]) => String(a.contract).toLowerCase()).sort();
    expect(asked).toEqual(VENUE_SLUGS.map((s) => COLLECTIONS[s].contract.toLowerCase()).sort());
    for (const [a] of api.fetchTokens.mock.calls) {
      for (const s of VIEW_ONLY_SLUGS) {
        expect(String(a?.contract).toLowerCase()).not.toBe(String(EXPECTED_FAMILY[s].contract).toLowerCase());
      }
    }
  });

  it("the view-only collections read their home market's stats instead", async () => {
    await renderLanding();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5));
    const paths = fetchMock.mock.calls.map((c) => new URL(String(c[0]), "https://memetics.finance").searchParams.get("path"));
    for (const p of Object.keys(FIX)) expect(paths).toContain(p);
  });
});

describe("a view-only card says where it trades, and is still one control", () => {
  it.each(VIEW_ONLY_SLUGS)("%s carries a Trades on badge and nests no link or button", async (slug) => {
    await renderLanding();
    const c = card(slug);
    expect(text(c)).toMatch(new RegExp(`Trades on ${EXPECTED_FAMILY[slug].market.name}`));
    expect(c.querySelector("a, button")).toBeNull();
  });

  it("a venue card carries no such badge", async () => {
    await renderLanding();
    for (const slug of VENUE_SLUGS) expect(text(card(slug))).not.toMatch(/Trades on/);
  });
});

describe("numbers in their own unit", () => {
  it("an ERC-1155 says designs and editions, never ? items", async () => {
    await renderLanding();
    expect(text(card("junglebaymemes"))).toMatch(/22 designs, 975 editions/);
    expect(text(card("raretowelie"))).toMatch(/61 designs, 3,529 editions/);
    for (const slug of VIEW_ONLY_SLUGS) expect(text(card(slug))).not.toMatch(/\?\s*items/);
  });

  it("Junglets counts its items and prices in SOL, with no ETH anywhere on its card", async () => {
    await renderLanding();
    await waitFor(() => expect(text(card("junglets"))).toMatch(/0\.695 SOL/));
    expect(text(card("junglets"))).toMatch(/208 items/);
    expect(text(card("junglets"))).not.toMatch(/\bETH\b/);
  });

  it("the Base collections say ETH on Base, at full precision", async () => {
    await renderLanding();
    await waitFor(() => expect(text(card("memeticseeds"))).toMatch(/0\.0528 ETH on Base/));
    expect(text(card("memeticseeds"))).toMatch(/369 items/);
    await waitFor(() => expect(text(card("bojungles"))).toMatch(/ETH on Base/));
    expect(text(card("bojungles"))).toMatch(/250 items/);
  });

  it("an Ethereum family volume under one keeps its digits", async () => {
    await renderLanding();
    await waitFor(() => expect(text(card("raretowelie"))).toMatch(/0\.0600 ETH/));
  });

  it("Gold Cards reads 123 items", async () => {
    await renderLanding();
    await settle();
    expect(text(card("junglebaygoldcards"))).toMatch(/123 items/);
  });
});

describe("cross-collection search", () => {
  async function search(q) {
    await renderLanding();
    const box = screen.getByRole("combobox", { name: /Search collections or token ID/ });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: q } });
    return screen.queryByRole("listbox") ? within(screen.getByRole("listbox")).getAllByRole("option").map((o) => text(o)) : [];
  }

  it("finds a family collection by name", async () => {
    const hits = await search("bojung");
    expect(hits.some((h) => /Bojungles/.test(h))).toBe(true);
  });

  it("finds the family by its shared tag", async () => {
    const hits = await search("jungle bay");
    for (const s of VIEW_ONLY_SLUGS) {
      expect(hits.some((h) => h.includes(EXPECTED_FAMILY[s].name)), s).toBe(true);
    }
  });

  it("a token id offers only collections whose tokens open here", async () => {
    const hits = await search("12");
    expect(hits.some((h) => /Jungle Bay Gold Cards #12/.test(h))).toBe(true);
    for (const s of VIEW_ONLY_SLUGS) {
      expect(hits.some((h) => h.includes(`${EXPECTED_FAMILY[s].name} #12`)), s).toBe(false);
    }
  });

  it("Gold Cards has no token 0, so #0 never offers one", async () => {
    const hits = await search("00");
    expect(hits.some((h) => /Nakamigos #0/.test(h))).toBe(true);
    expect(hits.some((h) => /Gold Cards #0/.test(h))).toBe(false);
  });
});
