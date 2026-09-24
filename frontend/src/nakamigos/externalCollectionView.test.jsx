// The five view-only family collections open in their own view: a gallery and
// an About page, a button to the market where they really trade, and none of
// the Ethereum trading app.
//
// Rendered through the real App at real routes. Only the network is faked,
// with the collections' own captured answers (e2e/fixtures/jungle-bay-family),
// and api.js's readers are spies, so a test can prove the Ethereum readers
// never ran rather than merely that nothing crashed.
//
// What is pinned:
//   - the view that mounts, its nav (Gallery and About only) and the absence
//     of every money control;
//   - every other tab answers with an explicit unavailable state and the
//     market button, in words that give the right reason for the tab;
//   - stats and items that could not be read say so, never 0 and never
//     "No items"; a deep link that cannot be resolved because a page failed
//     says the read failed, never "not found";
//   - the market buttons go where the collection trades, per item where an
//     item page was verified, never for a token held by the burn address;
//   - the view's own copy carries no prose em dash and no protocol voice.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { COLLECTIONS, VALID_TABS } from "./constants";
import { EXPECTED_FAMILY, VIEW_ONLY_SLUGS, TOWELI_ONLY } from "./__fixtures__/jungleBayFamily";
import bojStats from "../../e2e/fixtures/jungle-bay-family/opensea-stats.bojungless.json";
import bojNfts from "../../e2e/fixtures/jungle-bay-family/opensea-nfts.bojungless.json";
import seedsStats from "../../e2e/fixtures/jungle-bay-family/opensea-stats.seeds-from-the-memetic-garden.json";
import seedsNfts from "../../e2e/fixtures/jungle-bay-family/opensea-nfts.seeds-from-the-memetic-garden.json";
import memesStats from "../../e2e/fixtures/jungle-bay-family/opensea-stats.the-memes-by-junglebay-x-mfers-artists.json";
import memesNfts from "../../e2e/fixtures/jungle-bay-family/opensea-nfts.the-memes-by-junglebay-x-mfers-artists.json";
import towStats from "../../e2e/fixtures/jungle-bay-family/opensea-stats.rare-towelie-cards.json";
import towNfts from "../../e2e/fixtures/jungle-bay-family/opensea-nfts.rare-towelie-cards.json";
import meStats from "../../e2e/fixtures/jungle-bay-family/me-stats.junglet.json";
import meListings from "../../e2e/fixtures/jungle-bay-family/me-listings.junglet.json";

vi.mock("./contexts/WalletContext", () => {
  const state = { address: null, isConnected: false, walletName: null, isWrongNetwork: false };
  const actions = { connectWallet: () => {}, disconnect: () => {}, switchChain: () => {} };
  const ui = { isPending: false, connectError: null, availableConnectors: [], isSwitching: false };
  return {
    WalletProvider: ({ children }) => children,
    useWalletState: () => state,
    useWalletActions: () => actions,
    useWalletUI: () => ui,
    useWallet: () => ({ ...state, ...actions, ...ui }),
    config: null,
    HAS_WC_PROJECT_ID: false,
  };
});
vi.mock("./components/Background", () => ({ default: () => null }));
vi.mock("./components/InstallPrompt", () => ({ default: () => null }));
vi.mock("./hooks/useOpenSeaStream", () => ({
  default: vi.fn(() => ({ listings: [], sales: [], bids: [], cancellations: [], isConnected: false })),
}));
vi.mock("./hooks/useActivityWebSocket", () => ({
  default: vi.fn(() => ({ liveActivities: [], isWebSocketConnected: false })),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTokens: vi.fn(async () => ({ tokens: [], continuation: null })),
  fetchTokensByIds: vi.fn(async () => []),
  fetchCollectionStats: vi.fn(async () => ({ floor: null, volume: null, owners: null, supply: null })),
  fetchListings: vi.fn(async () => ({ listings: [], source: null })),
  fetchActivity: vi.fn(async () => ({ activities: [], empty: true })),
  fetchWalletNfts: vi.fn(async () => ({ tokens: [], totalCount: 0 })),
  fetchTopHolders: vi.fn(async () => ({ holders: [], fallback: true })),
}));

const FIX = {
  "collections/bojungless/stats": bojStats.response,
  "collection/bojungless/nfts": bojNfts.response,
  "collections/seeds-from-the-memetic-garden/stats": seedsStats.response,
  "collection/seeds-from-the-memetic-garden/nfts": seedsNfts.response,
  "collections/the-memes-by-junglebay-x-mfers-artists/stats": memesStats.response,
  "collection/the-memes-by-junglebay-x-mfers-artists/nfts": memesNfts.response,
  "collections/rare-towelie-cards/stats": towStats.response,
  "collection/rare-towelie-cards/nfts": towNfts.response,
  "/collections/junglet/stats": meStats.response,
  "/collections/junglet/listings": meListings.response,
};

let fetchMock;
let override;

function reply(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

function route(input) {
  const url = new URL(String(input?.url ?? input), "https://memetics.finance");
  if (override) {
    const r = override(url);
    if (r) return r;
  }
  if (url.pathname === "/api/opensea" || (url.pathname === "/api/aggregator" && url.searchParams.get("resource") === "me-read")) {
    const body = FIX[url.searchParams.get("path")];
    return body ? reply(body) : reply({ error: "upstream-rejected" }, 400);
  }
  return reply({ error: "not in this test" }, 503);
}

const requested = () => fetchMock.mock.calls.map((c) => new URL(String(c[0]?.url ?? c[0]), "https://memetics.finance"));

// Rendering the real App costs a first import of several seconds.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  vi.resetModules();
  override = null;
  fetchMock = vi.fn(async (input) => route(input));
  vi.stubGlobal("fetch", fetchMock);
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: /prefers-reduced-motion/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  }));
  window.scrollTo = () => {};
  sessionStorage.setItem("tm-splash-seen", "1");
  localStorage.setItem("tradermigos_onboarded", "1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

async function renderAt(path) {
  const { default: App } = await import("./App.jsx");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Copy checks read the page's text, so they hold however the markup splits a
// sentence into elements.
const bodyText = () => (document.body.textContent || "").replace(/\s+/g, " ");
const findInBody = (re, timeout = 3000) => waitFor(() => expect(bodyText()).toMatch(re), { timeout });
const notInBody = (re) => expect(bodyText()).not.toMatch(re);
// A Blur link is one whose host is blur.io or a subdomain of it.
const isBlurLink = (href) => {
  const { hostname } = new URL(href ?? "", "https://venue.invalid/");
  return hostname === "blur.io" || hostname.endsWith(".blur.io");
};

const marketName = (slug) => EXPECTED_FAMILY[slug].market.name;
const marketLinks = (slug, root = document.body) =>
  within(root).queryAllByRole("link", { name: new RegExp(`^Trade on ${marketName(slug)}`) });
const waitForMarketButton = (slug) => waitFor(() => expect(marketLinks(slug).length).toBeGreaterThan(0));

const MONEY_TABS = ["listings", "deals", "sniper", "trade", "trades", "bids", "my-listings", "collection"];
const READ_TABS = VALID_TABS.filter((t) => t !== "gallery" && t !== "about" && !MONEY_TABS.includes(t));

describe("a view-only collection opens its own view", () => {
  for (const slug of VIEW_ONLY_SLUGS) {
    describe(slug, () => {
      it("shows the collection, with the market button in its header", async () => {
        await renderAt(`/nakamigos/${slug}`);
        expect(await screen.findByRole("heading", { level: 1, name: new RegExp(escapeRe(EXPECTED_FAMILY[slug].name), "i") })).toBeInTheDocument();
        await waitForMarketButton(slug);
        const hero = marketLinks(slug)[0];
        expect(hero).toHaveAttribute("href", EXPECTED_FAMILY[slug].market.collectionUrl);
        expect(hero).toHaveAttribute("target", "_blank");
        expect(hero.getAttribute("rel")).toMatch(/noopener/);
        expect(hero.getAttribute("rel")).toMatch(/noreferrer/);
        expect(hero.textContent).toMatch(/opens in a new tab/i);
      });

      it("says where it lives and where it trades, in one plain line", async () => {
        await renderAt(`/nakamigos/${slug}`);
        const chain = { ethereum: "Ethereum", base: "Base", solana: "Solana" }[EXPECTED_FAMILY[slug].chain];
        await findInBody(new RegExp(escapeRe(
          `${EXPECTED_FAMILY[slug].name} lives on ${chain}. Browse it here; it trades on ${marketName(slug)}.`,
        )));
      });

      it("offers exactly Gallery and About, on desktop and mobile", async () => {
        await renderAt(`/nakamigos/${slug}`);
        await waitForMarketButton(slug);
        const desktop = screen.getByRole("navigation", { name: "Main navigation" });
        const labels = within(desktop).getAllByRole("button").map((b) => b.textContent.trim());
        expect(labels).toEqual(["Gallery", "About"]);
        // MobileNav hides itself with an inline display:none that a media query
        // lifts, so its buttons are queried with hidden:true.
        expect(screen.getAllByRole("button", { name: /^Gallery$/, hidden: true }).length).toBeGreaterThan(0);
        expect(screen.queryByRole("button", { name: "More tabs", hidden: true })).toBeNull();
        for (const t of ["Floor", "Deals", "Traits", "Activity", "My NFTs", "P&L"]) {
          expect(within(desktop).queryByRole("button", { name: t })).toBeNull();
        }
      });

      it("offers no money control of any kind", async () => {
        await renderAt(`/nakamigos/${slug}`);
        await waitForMarketButton(slug);
        expect(screen.queryByRole("button", { name: "Shopping cart", hidden: true })).toBeNull();
        const MONEY = /\b(buy|make (an )?offer|add(ed)? to cart|offer a trade|list (it|for sale)|accept|sweep|bid)\b/i;
        const controls = [...screen.queryAllByRole("button", { hidden: true }), ...screen.queryAllByRole("link", { hidden: true })];
        for (const el of controls) {
          const name = (el.getAttribute("aria-label") || el.textContent || "").trim();
          expect(MONEY.test(name), `money control "${name}"`).toBe(false);
        }
      });

      it("never runs an Ethereum reader or touches the Alchemy proxy or the order book", async () => {
        await renderAt(`/nakamigos/${slug}`);
        await waitForMarketButton(slug);
        await new Promise((r) => setTimeout(r, 50));
        const api = await import("./api");
        for (const fn of ["fetchTokens", "fetchCollectionStats", "fetchListings", "fetchActivity", "fetchWalletNfts", "fetchTopHolders", "fetchTokensByIds"]) {
          expect(api[fn], fn).not.toHaveBeenCalled();
        }
        const stream = (await import("./hooks/useOpenSeaStream")).default;
        const ws = (await import("./hooks/useActivityWebSocket")).default;
        expect(stream).not.toHaveBeenCalled();
        expect(ws).not.toHaveBeenCalled();
        for (const u of requested()) {
          expect(u.pathname, u.href).not.toBe("/api/alchemy");
          expect(u.pathname, u.href).not.toBe("/api/orderbook");
        }
      });

      it("names itself in the tab title", async () => {
        await renderAt(`/nakamigos/${slug}`);
        await waitFor(() => expect(document.title).toBe(`${EXPECTED_FAMILY[slug].name} | Tradermigos`));
      });

      it("keeps a footer of its own: the market, the explorer, and no Seaport trust strip", async () => {
        await renderAt(`/nakamigos/${slug}`);
        await waitForMarketButton(slug);
        const footer = document.querySelector("footer");
        expect(footer).toBeTruthy();
        const hrefs = [...footer.querySelectorAll("a")].map((a) => a.getAttribute("href"));
        expect(hrefs).toContain(EXPECTED_FAMILY[slug].market.collectionUrl);
        expect(hrefs).toContain(EXPECTED_FAMILY[slug].explorer.addressUrl);
        expect(hrefs.some(isBlurLink)).toBe(false);
        expect(footer.textContent).not.toMatch(/Seaport/);
        expect(footer.textContent).not.toMatch(/platform fee/i);
      });
    });
  }
});

describe("every other tab says it is not offered here, and why", () => {
  it.each(MONEY_TABS)("a money tab (%s) gives the trading reason and the market button", async (tab) => {
    await renderAt(`/nakamigos/bojungles/${tab}`);
    await findInBody(/is not offered for Bojungles here\./);
    await findInBody(/Bojungles is an ERC-721 collection on Base, and this venue trades Ethereum ERC-721 collections\./);
    expect(marketLinks("bojungles").length).toBeGreaterThan(0);
  });

  it.each(READ_TABS)("a read tab (%s) says only that it is not available, with the market button", async (tab) => {
    await renderAt(`/nakamigos/bojungles/${tab}`);
    await findInBody(/is not available for Bojungles here\./);
    notInBody(/this venue trades Ethereum ERC-721 collections/);
    expect(marketLinks("bojungles").length).toBeGreaterThan(0);
  });

  it("uses the right article for each standard", async () => {
    await renderAt("/nakamigos/junglets/listings");
    await findInBody(/Junglets is a Metaplex pNFT collection on Solana, and this venue trades Ethereum ERC-721 collections\./);
    cleanup();
    await renderAt("/nakamigos/raretowelie/bids");
    await findInBody(/RARE TOWELIE CARDS is an ERC-1155 collection on Ethereum, and this venue trades Ethereum ERC-721 collections\./);
  });
});

describe("stats say what they read, and say so when they could not", () => {
  it("labels its source, and shows Base volume as ETH on Base at full precision", async () => {
    await renderAt("/nakamigos/memeticseeds");
    await findInBody(/Stats from OpenSea/);
    await findInBody(/0\.0528 ETH on Base/);
  });

  it("a floor that was read as none listed says None listed", async () => {
    await renderAt("/nakamigos/bojungles");
    await findInBody(/None listed/);
  });

  it("a floor read as 0 says None listed, never a price of 0", async () => {
    override = (u) => (u.searchParams.get("path") === "collections/bojungless/stats"
      ? reply({ total: { floor_price: 0, floor_price_symbol: "", volume: 1.42308, num_owners: 100 }, intervals: [] })
      : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Stats from OpenSea/);
    const floor = screen.getByText("FLOOR").closest(".stat-card");
    expect(floor.textContent).toMatch(/None listed/);
    expect(floor.textContent).not.toMatch(/\bETH\b/);
  });

  it("a floor the read did not carry is the unread dash, marked not read, never None listed", async () => {
    override = (u) => (u.searchParams.get("path") === "collections/bojungless/stats"
      ? reply({ total: { volume: 1.42308, num_owners: 100 }, intervals: [] })
      : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Stats from OpenSea/);
    const floor = screen.getByText("FLOOR").closest(".stat-card");
    expect(floor.querySelector(".stat-value").textContent).toBe("\u2014");
    expect(floor.textContent).toMatch(/not read/);
    notInBody(/None listed/);
  });

  it("a failed stats read says Stats unavailable and shows the unread dash, never a zero", async () => {
    override = (u) => (u.searchParams.get("path") === "collections/bojungless/stats" ? reply("<html></html>", 200, { "content-type": "text/html" }) : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Stats unavailable/);
    expect(screen.getAllByText("\u2014").length).toBeGreaterThan(0);
    notInBody(/(^|\s)0(\.0+)? ETH/);
  });

  it("Junglets reads Magic Eden: a floor in SOL, the listed count, and no volume it did not read", async () => {
    await renderAt("/nakamigos/junglets");
    await findInBody(/Stats from Magic Eden/);
    await findInBody(/0\.695 SOL/);
    await findInBody(/55 listed/);
    await findInBody(/not read here/);
    notInBody(/\bETH\b/);
  });
});

describe("the gallery says what it shows", () => {
  it("an EVM collection shows the items read from OpenSea, and says how many", async () => {
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Showing 50 items read from OpenSea/);
    expect(screen.getAllByRole("button", { name: /Bojungles #248/ }).length).toBeGreaterThan(0);
  });

  it("Junglets shows only what is listed, and says so", async () => {
    const all = { ...meStats.response, listedCount: 5 };
    override = (u) => (u.searchParams.get("path") === "/collections/junglet/stats" ? reply(all) : null);
    await renderAt("/nakamigos/junglets");
    await findInBody(/Showing the 5 Junglets listed on Magic Eden, of 208\./);
  });

  // The stats read and the listings read are separate. The captured answers
  // say 55 are listed and the listings read returned 5, so the gallery must
  // not call the 5 "the" listed ones: one screen would state two listed counts.
  it("Junglets fewer than the stats' listed count: N of the M listed, never the N listed", async () => {
    expect(meStats.response.listedCount).toBe(55);
    await renderAt("/nakamigos/junglets");
    await findInBody(/Showing 5 of the 55 Junglets listed on Magic Eden, of 208 in all\./);
    await findInBody(/55 listed/);
    notInBody(/Showing the 5 Junglets listed/);
  });

  it("Junglets with no listed count read: N listed, never the N listed", async () => {
    override = (u) => (u.searchParams.get("path") === "/collections/junglet/stats" ? reply({ error: "upstream-rate-limited" }, 429, { "retry-after": "60" }) : null);
    await renderAt("/nakamigos/junglets");
    await findInBody(/Showing 5 Junglets listed on Magic Eden, of 208\./);
    notInBody(/Showing the 5 Junglets listed/);
  });

  it("a failed item read offers Retry, and never claims No items", async () => {
    override = (u) => (u.searchParams.get("path") === "collection/bojungless/nfts" ? reply({ error: "upstream-rate-limited" }, 429, { "retry-after": "60" }) : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Items could not be read from OpenSea right now/);
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    notInBody(/No items/);
  });

  it("Retry waits out the wait the market asked for", async () => {
    override = (u) => (u.searchParams.get("path") === "collection/bojungless/nfts" ? reply({ error: "upstream-rate-limited" }, 429, { "retry-after": "60" }) : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Items could not be read from OpenSea right now/);
    const itemReads = () => requested().filter((u) => u.searchParams.get("path") === "collection/bojungless/nfts").length;
    const before = itemReads();
    const retry = screen.getByRole("button", { name: /Retry/ });
    if (!retry.disabled) retry.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(itemReads()).toBe(before);
  });

  it("Retry asks again at once when the market named no wait", async () => {
    let failing = true;
    override = (u) => (u.searchParams.get("path") === "collection/bojungless/nfts" && failing ? reply("<html></html>", 200, { "content-type": "text/html" }) : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Items could not be read from OpenSea right now/);
    failing = false;
    screen.getByRole("button", { name: /Retry/ }).click();
    await findInBody(/Showing 50 items read from OpenSea/);
  });

  it("a successful read that returned nothing is the only way to say No items", async () => {
    override = (u) => (u.searchParams.get("path") === "collection/bojungless/nfts" ? reply({ nfts: [], next: null }) : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/No items/);
  });

  it("rows OpenSea returned that none could be read are a failed read, never No items", async () => {
    // A field renamed upstream: every row misses `contract`.
    const renamed = bojNfts.response.nfts.map(({ contract, ...row }) => ({ ...row, contract_address: contract }));
    override = (u) => (u.searchParams.get("path") === "collection/bojungless/nfts" ? reply({ nfts: renamed, next: null }) : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Items could not be read from OpenSea right now/);
    notInBody(/No items/);
    notInBody(/Showing 0 items/);
  });

  it("rows that could not be read are counted, never silently left out", async () => {
    const nfts = bojNfts.response.nfts.map((row, i) => (i < 2 ? { ...row, identifier: "not-a-number" } : row));
    override = (u) => (u.searchParams.get("path") === "collection/bojungless/nfts" ? reply({ nfts, next: null }) : null);
    await renderAt("/nakamigos/bojungles");
    await findInBody(/Showing 48 items read from OpenSea\. 2 more could not be read and are not shown\./);
  });

  it("an id that may be among the rows that could not be read is never called not found", async () => {
    const nfts = bojNfts.response.nfts.map((row) => (row.identifier === "248" ? { ...row, identifier: "not-a-number" } : row));
    override = (u) => (u.searchParams.get("path") === "collection/bojungless/nfts" ? reply({ nfts, next: null }) : null);
    await renderAt("/nakamigos/bojungles/nft/248");
    await findInBody(/1 more could not be read and is not shown/);
    notInBody(/not found in this collection's OpenSea items/i);
  });

  it("a partial read is counted as at least N, never as the whole collection", async () => {
    override = (u) => {
      if (u.searchParams.get("path") !== "collection/bojungless/nfts") return null;
      return u.searchParams.get("next")
        ? reply({ error: "upstream-rate-limited" }, 429, { "retry-after": "60" })
        : reply({ ...bojNfts.response, next: "page-2" });
    };
    await renderAt("/nakamigos/bojungles");
    await findInBody(/at least 50/);
    notInBody(/Showing 50 items read from OpenSea/);
  });
});

describe("the item panel and its market button", () => {
  it("a Seeds item opens with a button to that item's OpenSea page", async () => {
    await renderAt("/nakamigos/memeticseeds/nft/86");
    const panel = await screen.findByRole("dialog");
    expect(panel.textContent).toMatch(/Nobrainfer/);
    const link = within(panel).getByRole("link", { name: /^Trade on OpenSea/ });
    expect(link).toHaveAttribute("href", "https://opensea.io/item/base/0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3/86");
    expect(panel.textContent).toMatch(/\bBase\b/);
    expect(panel.textContent).toMatch(/ERC-721/);
  });

  it("Seeds #88 is held by the burn address: it says so, and offers no way to buy it", async () => {
    await renderAt("/nakamigos/memeticseeds/nft/88");
    await findInBody(/held by the burn address/i);
    const toItem = screen.queryAllByRole("link").filter((a) => /\/88$/.test(a.getAttribute("href") || ""));
    expect(toItem).toEqual([]);
  });

  it("an id every page was read for and none holds is not found", async () => {
    await renderAt("/nakamigos/bojungles/nft/249");
    await findInBody(/not found in this collection's OpenSea items/i);
  });

  it("an id on a page that failed to load is unavailable, not not-found", async () => {
    override = (u) => {
      if (u.searchParams.get("path") !== "collection/bojungless/nfts") return null;
      return u.searchParams.get("next")
        ? reply({ error: "upstream-rate-limited" }, 429, { "retry-after": "60" })
        : reply({ ...bojNfts.response, next: "page-2" });
    };
    await renderAt("/nakamigos/bojungles/nft/249");
    await findInBody(/Items could not be read from OpenSea right now/);
    notInBody(/not found in this collection's OpenSea items/i);
  });

  it("a Junglets item opens with the price it is listed at and the collection-level button only", async () => {
    await renderAt("/nakamigos/junglets");
    const card = (await screen.findAllByRole("button", { name: /Junglet #64/ }))[0];
    card.click();
    const panel = await screen.findByRole("dialog");
    expect(panel.textContent).toMatch(/0\.695 SOL/);
    const links = within(panel).getAllByRole("link", { name: /^Trade on Magic Eden/ });
    for (const l of links) expect(l).toHaveAttribute("href", "https://magiceden.us/marketplace/junglet");
  });

  it("a numeric Junglets deep link opens nothing: Junglets are addressed by mint, not number", async () => {
    await renderAt("/nakamigos/junglets/nft/64");
    await findInBody(/Junglets listed on Magic Eden/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("About states the collection's own facts, with their sources", () => {
  it("Seeds: its description labelled as its own, its supply note and deploy date, and its explorer", async () => {
    await renderAt("/nakamigos/memeticseeds/about");
    await findInBody(/Description from the collection's OpenSea page/);
    await findInBody(new RegExp(escapeRe(String(COLLECTIONS.memeticseeds?.supplyNote ?? "a supply note that does not exist yet"))));
    await findInBody(/2025-07-15/);
    const explorer = screen.getAllByRole("link").find((a) => a.getAttribute("href") === EXPECTED_FAMILY.memeticseeds.explorer.addressUrl);
    expect(explorer).toBeTruthy();
  });

  // The text lives in an IPFS JSON the Metaplex account points to by uri;
  // the account itself holds only the name, symbol and that uri.
  it("Junglets: a description from its collection NFT's metadata, not said to be on chain, and its collection mint", async () => {
    await renderAt("/nakamigos/junglets/about");
    await findInBody(/Description from the collection NFT's metadata \(IPFS, linked on chain\)/);
    notInBody(/on-chain metadata/i);
    await findInBody(/5csQ/);
  });

  it("Rare Towelie Cards: no description, and nothing written in its place", async () => {
    await renderAt("/nakamigos/raretowelie/about");
    await findInBody(new RegExp(escapeRe(String(COLLECTIONS.raretowelie?.supplyNote ?? "a supply note that does not exist yet"))));
    notInBody(/Description from/);
  });
});

describe("the view's own copy", () => {
  // The e2e walkers (em-dash-zero, voice-census) visit the /nakamigos landing
  // only, so this view's copy would otherwise be measured by nobody. Same rule
  // as the e2e walker: a text node that CONTAINS U+2014 and is not exactly
  // U+2014 is prose; exactly U+2014 is the unread placeholder and passes.
  function walk() {
    const hits = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      const text = (n.textContent || "").trim();
      if (!text) continue;
      if (text.includes("\u2014") && text !== "\u2014") hits.push(`dash: ${text.slice(0, 80)}`);
      if (/tegridy/i.test(text)) hits.push(`tegridy: ${text.slice(0, 80)}`);
      if (TOWELI_ONLY.test(text)) hits.push(`toweli: ${text.slice(0, 80)}`);
    }
    return hits;
  }

  for (const slug of VIEW_ONLY_SLUGS) {
    for (const tab of ["gallery", "about", "listings", "activity"]) {
      it(`${slug}/${tab} carries no prose em dash and no protocol voice`, async () => {
        await renderAt(`/nakamigos/${slug}/${tab}`);
        await waitForMarketButton(slug);
        await new Promise((r) => setTimeout(r, 50));
        expect(walk()).toEqual([]);
      });
    }
  }
});

describe("Gold Cards is not view-only", () => {
  it("opens the trading view, with the cart and no market button", async () => {
    await renderAt("/nakamigos/junglebaygoldcards");
    expect(await screen.findByRole("button", { name: "Shopping cart" })).toBeInTheDocument();
    await findInBody(/JUNGLE BAY GOLD CARDS/);
    expect(marketLinks("junglebaygoldcards")).toEqual([]);
  });

  it("control: GNSS Art opens the trading view today, so the harness itself is sound", async () => {
    await renderAt("/nakamigos/gnssart");
    expect(await screen.findByRole("button", { name: "Shopping cart" })).toBeInTheDocument();
  });
});
