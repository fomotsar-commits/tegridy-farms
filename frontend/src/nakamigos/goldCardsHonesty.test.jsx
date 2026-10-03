// Gold Cards pages claim nothing their reads cannot produce.
//
// Gold Cards trades here exactly like the three collections before it, but it
// is not shaped like them: 123 tokens with ids 1..123 (ownerOf(0) and
// ownerOf(124) revert), one shared image, no traits, no lore, no Blur page,
// nothing listed anywhere, and an OpenSea description whose benefit list
// includes a 1.5x $JBAC multiplier the venue's own staking does not honour.
// Surfaces written for the first three quietly assumed their shape. Each test
// below renders one of them for Gold Cards and pins the honest answer:
//
//   - the detail Modal shows no Nakamigos lore for a Gold token that happens
//     to carry a `Type` attribute, and does not offer "Buy on OpenSea" for a
//     token that is listed nowhere;
//   - Deals says it has no traits to compare, rather than "all listings are
//     priced at or above their trait floors";
//   - About labels the description as the collection's own words;
//   - the Hero never prints the 1.5x promise;
//   - the bulk lister never prices a card at an unread floor of 0;
//   - a deep link to an id that does not exist says so, and offers no bid;
//   - the footer offers no Blur page the venue never verified.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, configure } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollectionProvider } from "./contexts/CollectionContext";
import { TradingModeProvider } from "./contexts/TradingModeContext";
import { ADDR } from "./__fixtures__/jungleBayFamily";

const GOLD = ADDR.junglebaygoldcards;

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
vi.mock("./hooks/useEns", () => ({ default: () => ({ ensName: null }) }));
// The item Modal mounts OfferPanel. Its real offer-book read retries a failed
// fetch for about ten seconds, which outlives this file; a retry that lands
// after the environment is gone throws "window is not defined".
vi.mock("./api-offers", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTokenOfferBook: vi.fn(async () => ({ offers: [], bestOffer: null, unavailable: false })),
}));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal();
  // Gold Cards' 123 tokens (ids 1..123, read on chain), shaped as api.js
  // normalises them: one shared image, no traits.
  const all = [];
  for (let id = 1; id <= 123; id++) {
    all.push({ id: String(id), name: `JungleBay Gold Card #${id}`, image: "https://junglebay.s3.us-east-2.amazonaws.com/Thumbnail.JPG", attributes: [], owner: null, contract: "0x6aa03f42c5366e2664c887eb2e90844ca00b92f3", price: null, lastSale: null, rank: null });
  }
  return {
    ...actual,
    fetchTokens: vi.fn(async ({ contract } = {}) => (
      String(contract).toLowerCase() === "0x6aa03f42c5366e2664c887eb2e90844ca00b92f3"
        ? { tokens: all, continuation: null }
        : { tokens: [], continuation: null }
    )),
    fetchTokensByIds: vi.fn(async () => []),
    fetchCollectionStats: vi.fn(async () => ({ floor: null, volume: 43, owners: 97, supply: 123 })),
    fetchListings: vi.fn(async () => ({ listings: [], source: "opensea" })),
    fetchActivity: vi.fn(async () => ({ activities: [], empty: true })),
    fetchWalletNfts: vi.fn(async () => ({ tokens: [], totalCount: 0 })),
    fetchTopHolders: vi.fn(async () => ({ holders: [], fallback: true })),
    fetchTokenSalesHistory: vi.fn(async () => []),
    fulfillSeaportOrder: vi.fn(),
  };
});

// Rendering the real Modal and App costs a first import of several seconds.
vi.setConfig({ testTimeout: 30000 });
// The waits get room too. Testing Library gives up a findBy or waitFor after 1s, a clock
// the line above does not move, and what these waits wait for is real work (the gallery
// read, then the lazy Modal) that slows with machine load.
configure({ asyncUtilTimeout: 15000 });

beforeEach(() => {
  // Not resetModules: the providers imported above must be the same module
  // instances the components import, or the context lookup misses.
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) })));
  window.matchMedia = (q) => ({
    matches: /prefers-reduced-motion/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
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

const bodyText = () => (document.body.textContent || "").replace(/\s+/g, " ");
// A Blur link is one whose host is blur.io or a subdomain of it.
const isBlurLink = (href) => {
  const { hostname } = new URL(href ?? "", "https://venue.invalid/");
  return hostname === "blur.io" || hostname.endsWith(".blur.io");
};

function withCollection(slug, node) {
  return (
    <MemoryRouter>
      <TradingModeProvider>
        <CollectionProvider slug={slug}>{node}</CollectionProvider>
      </TradingModeProvider>
    </MemoryRouter>
  );
}

const goldToken = (over = {}) => ({
  id: "12", name: "JungleBay Gold Card #12", image: "https://junglebay.s3.us-east-2.amazonaws.com/Thumbnail.JPG",
  attributes: [], owner: null, contract: GOLD.toLowerCase(), price: null, lastSale: null, rank: null, ...over,
});

async function renderModal(slug, nft) {
  const { default: Modal } = await import("./components/Modal.jsx");
  return render(withCollection(slug, (
    <Modal
      nft={nft}
      onClose={() => {}}
      isFavorite={false}
      onToggleFavorite={() => {}}
      wallet={null}
      onConnect={() => {}}
      addToast={() => {}}
      onTheater={() => {}}
      onShare={() => {}}
      onViewProfile={() => {}}
      floorPrice={null}
      statsSupply={123}
      allTokens={[]}
      onList={() => {}}
    />
  )));
}

describe("the detail Modal", () => {
  it("shows no Nakamigos lore for a Gold token that carries a Type attribute", async () => {
    await renderModal("junglebaygoldcards", goldToken({ attributes: [{ key: "Type", value: "Ghost" }] }));
    await screen.findByRole("dialog");
    expect(bodyText()).not.toMatch(/The rarest type\. Only 9 exist/);
    expect(bodyText()).not.toMatch(/ULTRA RARE/);
  });

  it("control: a Nakamigos Ghost still shows its lore", async () => {
    await renderModal("nakamigos", { ...goldToken({ attributes: [{ key: "Type", value: "Ghost" }] }), contract: ADDR.nakamigos.toLowerCase(), name: "Nakamigos #3648", id: "3648" });
    await screen.findByRole("dialog");
    expect(bodyText()).toMatch(/The rarest type\. Only 9 exist/);
  });

  it("does not offer to buy a token that is listed nowhere; it offers to view it", async () => {
    await renderModal("junglebaygoldcards", goldToken());
    await screen.findByRole("dialog");
    expect(bodyText()).not.toMatch(/Buy on OpenSea/);
    expect(bodyText()).toMatch(/View on OpenSea/);
  });
});

describe("Deals", () => {
  it("says there are no traits to compare, rather than that every listing sits at its trait floor", async () => {
    const { default: Deals } = await import("./components/Deals.jsx");
    const tokens = [goldToken({ id: "1" }), goldToken({ id: "2" }), goldToken({ id: "3" })];
    render(withCollection("junglebaygoldcards", (
      <Deals tokens={tokens} listings={[]} listingsLoading={false} onPick={() => {}} wallet={null} onConnect={() => {}} addToast={() => {}} onRefresh={() => {}} loadAll={() => {}} hasMore={false} />
    )));
    await waitFor(() => expect(bodyText()).toMatch(
      /Deals compares listings with their trait floors\. Jungle Bay Gold Cards has no traits in its metadata, so there is nothing to compare\./,
    ));
    expect(bodyText()).not.toMatch(/priced at or above their trait floors/);
  });
});

describe("About", () => {
  it("labels the description as the collection's own, and names the chain", async () => {
    const { default: About } = await import("./components/About.jsx");
    render(withCollection("junglebaygoldcards", <About stats={{ floor: null, volume: 43, owners: 97, supply: 123 }} />));
    await waitFor(() => expect(bodyText()).toMatch(/JUNGLE BAY GOLD CARDS/));
    // An excerpt: the venue keeps the first paragraph only, and says so.
    expect(bodyText()).toMatch(/First paragraph of the collection's OpenSea description/);
    expect(bodyText()).not.toMatch(/Description from the collection's OpenSea page/);
    expect(bodyText()).toMatch(/Ethereum/);
    expect(bodyText()).not.toMatch(/1\.5x/);
  });
});

describe("Hero", () => {
  it("never prints the 1.5x $JBAC promise the venue's staking does not honour", async () => {
    const { default: Hero } = await import("./components/Hero.jsx");
    render(withCollection("junglebaygoldcards", <Hero stats={{ floor: null, volume: 43, owners: 97, supply: 123 }} tokens={[]} onPick={() => {}} />));
    await waitFor(() => expect(bodyText()).toMatch(/Jungle Bay Gold Cards/));
    expect(bodyText()).not.toMatch(/1\.5x/);
    expect(bodyText()).not.toMatch(/multiplier/i);
    expect(bodyText()).not.toMatch(/airdrop/i);
  });

  it("says its description is the first paragraph of the collection's OpenSea text", async () => {
    const { default: Hero } = await import("./components/Hero.jsx");
    render(withCollection("junglebaygoldcards", <Hero stats={{ floor: null, volume: 43, owners: 97, supply: 123 }} tokens={[]} onPick={() => {}} />));
    await waitFor(() => expect(bodyText()).toMatch(/Jungle Bay Gold Cards/));
    expect(bodyText()).toMatch(/\(first paragraph of its OpenSea description\)/);
    expect(bodyText()).not.toMatch(/\(from the collection's OpenSea page\)/);
  });
});

describe("the bulk lister", () => {
  it("with no floor read, never prices at the floor: floor pricing is off and says why", async () => {
    const { default: BulkListingWizard } = await import("./components/BulkListingWizard.jsx");
    render(withCollection("junglebaygoldcards", (
      <BulkListingWizard tokens={[goldToken({ id: "7" })]} wallet={"0x" + "a".repeat(40)} onClose={() => {}} onListingCreated={() => {}} addToast={() => {}} onConnect={() => {}} stats={{ floor: null }} listingMap={new Map()} />
    )));
    fireEvent.click(screen.getByRole("button", { name: /Select All/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue with 1 NFT/ }));
    await waitFor(() => expect(bodyText()).toMatch(/Floor unavailable/));
    const floorMode = screen.getAllByRole("button").find((b) => /Floor Price/.test(b.textContent));
    const traitMode = screen.getAllByRole("button").find((b) => /Trait Floor/.test(b.textContent));
    expect(floorMode).toBeDisabled();
    expect(traitMode).toBeDisabled();
  });
});

describe("the Gold Cards trading view", () => {
  async function renderAt(path) {
    const { default: App } = await import("./App.jsx");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it.each(["0", "124"])("a deep link to #%s, an id that does not exist, says so and offers no bid", async (id) => {
    await renderAt(`/nakamigos/junglebaygoldcards/nft/${id}`);
    await waitFor(() => expect(bodyText()).toMatch(/JUNGLE BAY GOLD CARDS/));
    await waitFor(() => expect(bodyText()).toMatch(/not in this collection/i));
    expect(screen.queryByRole("button", { name: /Make an offer/i })).toBeNull();
    const api = await import("./api");
    expect(api.fetchTokensByIds).not.toHaveBeenCalled();
  });

  it("control: a deep link to a real Gold token opens it", async () => {
    await renderAt("/nakamigos/junglebaygoldcards/nft/5");
    expect(await screen.findByRole("dialog", { name: /Gold Card #5/ })).toBeInTheDocument();
  });

  it("offers no Blur page for Gold Cards", async () => {
    await renderAt("/nakamigos/junglebaygoldcards");
    await waitFor(() => expect(bodyText()).toMatch(/JUNGLE BAY GOLD CARDS/));
    const footer = document.querySelector("footer");
    const hrefs = [...footer.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.some(isBlurLink)).toBe(false);
    expect(hrefs).toContain("https://opensea.io/collection/junglebaygoldcards");
    expect(hrefs).toContain(`https://etherscan.io/address/${GOLD}`);
  });

  it("control: the three that trade today keep their Blur page", async () => {
    await renderAt("/nakamigos/gnssart");
    await waitFor(() => expect(bodyText()).toMatch(/GNSS ART/));
    const hrefs = [...document.querySelector("footer").querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://blur.io/eth/collection/gnssart");
  });
});

