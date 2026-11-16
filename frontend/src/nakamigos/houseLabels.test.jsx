// The venue's own bidder is named on every marketplace surface that shows a maker
// (BUILD-SPEC 3.2, item 2): its bids, offers and listings read "House", and a house
// COLLECTION bid reads "House · buys N (any TICKER)". So do the other places a wallet is
// named (review HR-1, HR-5): the Activity tab's sales and listings, the owner in Compare,
// the owner profile, and the integrity panel's wallet groups. With the committed registry
// (empty) every one of these surfaces reads exactly as it did before.
//
// The registry module is stood in by the real registry logic (houseRegistryCore.js) over
// `h.registry`: the committed JSON, or one house wallet.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollectionProvider } from "./contexts/CollectionContext";
import { TradingModeProvider } from "./contexts/TradingModeContext";
import COMMITTED from "../lib/house/houseRegistry.json";

const HOUSE = "0x8ba1f109551bd432803012645ac136ddd64dba72"; // lowercase, as OpenSea returns makers
const HOUSE_SHORT = "0x8ba1...ba72";
// Every regex-special character escaped (backslash included), not just the dots.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OUTSIDE = "0x" + "b".repeat(40);
const JBAC = "0xd37264c71e9af940e49795f0d3a8336afaafdda9";
const ONE_HOUSE = {
  version: 1,
  note: "test",
  wallets: [{ address: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", label: "House bidder", collections: ["junglebay", "gnssart"], since: "2026-11-16" }],
};
const HOUSE_2 = "0x" + "c".repeat(40);
const TWO_HOUSES = { ...ONE_HOUSE, wallets: [...ONE_HOUSE.wallets, { ...ONE_HOUSE.wallets[0], address: HOUSE_2 }] };

const h = vi.hoisted(() => ({ registry: null, collectionOffers: [], tokenBook: null, tokenOffers: [], holders: null, feed: null, trades: [] }));

vi.mock("../lib/house/houseRegistry.js", async () => {
  const core = await import("../lib/house/houseRegistryCore.js");
  const now = () => core.createHouseRegistry(h.registry);
  return {
    HOUSE_LABEL: core.HOUSE_LABEL,
    createHouseRegistry: core.createHouseRegistry,
    houseWallets: () => now().houseWallets(),
    isHouseWallet: (a) => now().isHouseWallet(a),
    houseLabel: (a) => now().houseLabel(a),
    houseBidLabel: (a, b) => now().houseBidLabel(a, b),
  };
});
vi.mock("./hooks/useOffers", () => ({
  useCollectionOffers: () => ({ data: h.collectionOffers, isLoading: false, refetch: () => {} }),
  useTraitOffers: () => ({ data: {}, isLoading: false, refetch: () => {} }),
}));
vi.mock("./api-offers", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTokenOfferBook: vi.fn(async () => h.tokenBook),
  fetchTokenOffers: vi.fn(async () => h.tokenOffers),
  fetchCollectionOffers: vi.fn(async () => []),
  fetchBestOffer: vi.fn(async () => null),
  acceptOffer: vi.fn(async () => ({ success: true })),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWalletNfts: vi.fn(async () => ({ tokens: [{ id: "7", name: "Token #7", image: null, attributes: [] }], totalCount: 1, complete: true })),
  fetchTokenSalesHistory: vi.fn(async () => []),
  fetchTokensByIds: vi.fn(async () => []),
  fetchTopHolders: vi.fn(async () => h.holders),
  fetchActivity: vi.fn(async () => h.feed),
  getProvider: () => null,
}));
vi.mock("./lib/trades", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTrades: vi.fn(async ({ role }) => ({ trades: role === "outgoing" ? h.trades : [], error: null })),
}));
// Only the network boundary is faked.
vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => { throw new Error("offline in test"); });
  return { ...actual, alchemyGet: down, alchemyPost: down, openseaGet: down, openseaPost: down };
});
vi.mock("./contexts/WalletContext", () => {
  const state = { address: null, isConnected: false, walletName: null, isWrongNetwork: false };
  const actions = { connectWallet: () => {}, disconnect: () => {}, switchChain: () => {} };
  const ui = { isPending: false, connectError: null, availableConnectors: [], isSwitching: false, openConnectModal: null };
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
vi.mock("./hooks/useEns", async () => {
  const { createElement } = await import("react");
  return {
    default: () => ({ ensName: null }),
    // With no ENS name, what the real EnsName shows: the short address, the full one on hover.
    EnsName: ({ address }) => (address ? createElement("span", { title: address }, `${address.slice(0, 6)}...${address.slice(-4)}`) : null),
  };
});
// The owner profile's ENS lookup (its only chain read here): no wallet has a name.
vi.mock("./lib/rpcProvider", () => ({
  getReadProvider: async () => ({ lookupAddress: async () => null, getAvatar: async () => null }),
}));

// Rendering the real Modal and Listings costs a first import of several seconds.
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => {
  // jsdom has no 2D canvas; the depth bars draw unconditionally (listingsPartialSourceHonesty.test.jsx).
  const noop = () => {};
  HTMLCanvasElement.prototype.getContext = () => ({
    scale: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, stroke: noop, fill: noop, arc: noop, fillRect: noop,
    fillText: noop, measureText: () => ({ width: 0 }), setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
  });
});

beforeEach(() => {
  h.registry = COMMITTED;
  h.collectionOffers = [];
  h.tokenBook = { offers: [], bestOffer: null, unavailable: false };
  h.tokenOffers = [];
  h.holders = { holders: [], totalOwners: 0, totalHeld: 0, fallback: true };
  h.feed = { activities: [], fallback: true, pageKey: null };
  h.trades = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) })));
  window.matchMedia = (q) => ({
    matches: /prefers-reduced-motion/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  window.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(node, slug = "junglebay") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TradingModeProvider>
          <CollectionProvider slug={slug}>{node}</CollectionProvider>
        </TradingModeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const collectionBid = (maker, over = {}) => ({
  price: 0.045, priceTotal: 0.09, quantity: 2, quantityKnown: true, currency: "WETH",
  maker, orderHash: `0x${maker.slice(2, 10)}`, criteria: { collection: { slug: "junglebay" } }, ...over,
});
const tokenOffer = (maker) => ({
  price: 0.045, maker, orderHash: "0xoffer", tokenContract: JBAC, tokenId: "5", expiry: new Date(Date.now() + 3600_000),
});

async function renderCollectionOffers(slug = "junglebay") {
  const { default: CollectionOffersPanel } = await import("./components/CollectionOffersPanel.jsx");
  return wrap(<CollectionOffersPanel wallet={null} onConnect={() => {}} addToast={() => {}} />, slug);
}
async function renderOfferPanel() {
  const { default: OfferPanel } = await import("./components/OfferPanel.jsx");
  return wrap(<OfferPanel tokenId="5" wallet={null} ownerAddress={OUTSIDE} addToast={() => {}} onMakeOffer={() => {}} />);
}
async function renderReceivedOffers() {
  const { default: BidManager } = await import("./components/BidManager.jsx");
  wrap(<BidManager wallet={OUTSIDE} onConnect={() => {}} addToast={() => {}} onPick={() => {}} tokens={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Received Offers" }));
}
async function renderListings(maker) {
  const { default: Listings } = await import("./components/Listings.jsx");
  const listings = [
    { tokenId: "1000", price: 0.05, priceWei: "50000000000000000", marketplace: "opensea", maker, orderHash: "0xl1" },
    { tokenId: "1001", price: 0.06, priceWei: "60000000000000000", marketplace: "opensea", maker: OUTSIDE, orderHash: "0xl2" },
  ];
  wrap(
    <Listings
      tokens={[]} stats={{ supply: 5555, owners: 2000, floor: 0.05 }} listings={listings}
      listingsLoading={false} listingsError={null} listingsSource="opensea"
      activities={[]} activitiesLoading={false} activitiesEmpty
      onPick={() => {}} wallet={null} onConnect={() => {}} addToast={() => {}} onAddToCart={() => {}} onFilter={() => {}}
    />,
  );
  return (id) => screen.getByRole("button", { name: new RegExp(`#${id}, `) });
}
async function renderNativeListings(isNarrow) {
  const { default: NativeListingsList } = await import("./components/NativeListingsList.jsx");
  const at = new Date().toISOString();
  const orders = [
    { order_hash: "0xn1", token_id: "42", price_eth: 0.05, maker: HOUSE, status: "active", created_at: at },
    { order_hash: "0xn2", token_id: "43", price_eth: 0.06, maker: OUTSIDE, status: "active", created_at: at },
  ];
  return render(
    <NativeListingsList orders={orders} wallet={null} isNarrow={isNarrow} buying={null} cancelling={null} onBuy={() => {}} onCancel={() => {}} floorPrice={0.05} />,
  );
}
async function renderModal(owner) {
  const { default: Modal } = await import("./components/Modal.jsx");
  const nft = { id: "7", name: "Token #7", image: null, attributes: [], owner, contract: JBAC, price: null, lastSale: null, rank: null };
  wrap(
    <Modal
      nft={nft} onClose={() => {}} isFavorite={false} onToggleFavorite={() => {}} wallet={null}
      onConnect={() => {}} addToast={() => {}} onTheater={() => {}} onShare={() => {}} onViewProfile={() => {}}
      floorPrice={null} statsSupply={null} allTokens={[]} onList={() => {}}
    />,
  );
  await screen.findByRole("dialog");
}
// The Activity tab: an outside wallet sells JBAC #123 to the house, and the house lists it.
// Each row's parties, newest row first.
async function renderActivity() {
  const { default: ActivityFeed } = await import("./components/ActivityFeed.jsx");
  const now = Date.now();
  const token = { id: "123", name: "JBAC #123" };
  const activities = [
    { type: "sale", token, price: 0.045, from: "0xbbbb...bbbb", fromFull: OUTSIDE, to: HOUSE_SHORT, toFull: HOUSE, time: now - 120_000, hash: "0x" + "1".repeat(64), marketplace: "opensea" },
    { type: "listing", token, price: 0.05, from: HOUSE_SHORT, fromFull: HOUSE, to: null, toFull: null, time: now - 60_000, hash: null, marketplace: "opensea" },
  ];
  const { container } = wrap(<ActivityFeed activities={activities} addToast={() => {}} />);
  await waitFor(() => expect(container.querySelectorAll(".activity-row")).toHaveLength(2));
  return [...container.querySelectorAll(".activity-parties")].map((p) => p.textContent);
}
// Compare: you pick the NFT the house owns as the one you want; its owner line.
async function renderCompareOwner() {
  const { default: NftCompare } = await import("./components/NftCompare.jsx");
  const tokens = [{ id: "9", name: "Token #9", image: null, attributes: [], owner: HOUSE }];
  wrap(<NftCompare tokens={tokens} wallet={OUTSIDE} onConnect={() => {}} addToast={() => {}} setTab={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/loaded/), { target: { value: "9" } });
  fireEvent.click(screen.getByText("Token #9"));
  return screen.getByText(/^Owner: /).textContent;
}
// The owner profile the Modal's owner link opens, for the house wallet.
async function renderProfile() {
  const { default: OnChainProfile } = await import("./components/OnChainProfile.jsx");
  wrap(<OnChainProfile address={HOUSE} onClose={() => {}} onPick={() => {}} wallet={null} />);
  return screen.getByTitle("Click to copy full address");
}
// The integrity panel for two wallets that traded with each other both ways: a wallet group.
async function renderWalletGroup() {
  const { WashPanel } = await import("./components/MarketIntegrity.jsx");
  const { analyzeWashTrading } = await import("./lib/marketIntegrity.js");
  const sales = [
    { fromFull: HOUSE, toFull: HOUSE_2, token: { id: "1" }, price: 0.04, time: 1 },
    { fromFull: HOUSE_2, toFull: HOUSE, token: { id: "2" }, price: 0.04, time: 2 },
  ];
  return render(<WashPanel result={analyzeWashTrading(sales)} capped={false} onViewProfile={() => {}} />);
}
// The holders panel: the house is the top holder, and bought JBAC #123 from an outside wallet.
// Its holder row's name link, once the row is in.
async function renderTopHolder() {
  const { default: WhaleIntelligence } = await import("./components/WhaleIntelligence.jsx");
  h.holders = { holders: [{ address: HOUSE, count: 40 }, { address: OUTSIDE, count: 12 }], totalOwners: 2000, totalHeld: 52, fallback: false };
  h.feed = {
    activities: [{ type: "sale", token: { id: "123", name: "JBAC #123" }, price: 0.045, from: "0xbbbb...bbbb", fromFull: OUTSIDE, to: HOUSE_SHORT, toFull: HOUSE, time: Date.now() - 60_000, hash: "0x" + "2".repeat(64) }],
    fallback: false,
    pageKey: null,
  };
  const { container } = wrap(<WhaleIntelligence />);
  const link = `a[href="https://etherscan.io/address/${HOUSE}"]`;
  await waitFor(() => expect(container.querySelector(link)).toBeTruthy());
  return container.querySelector(link);
}
// A trade you sent to the house for the NFT it owns: its card's "TO" line.
async function renderSentTrade() {
  const { default: TradesPanel } = await import("./components/TradesPanel.jsx");
  h.trades = [{
    id: "t1", offerer: OUTSIDE, target_owner: HOUSE, status: "active", eth_topup_wei: "0", weth_topup_wei: "0",
    offered: [{ contract: JBAC, tokenId: "5" }], requested: [{ contract: JBAC, tokenId: "9" }],
    expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString(),
  }];
  wrap(<TradesPanel wallet={OUTSIDE} onConnect={() => {}} addToast={() => {}} onViewProfile={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "outgoing" }));
  return (await screen.findByText("TO")).textContent;
}
// A Base collection's item: its best offer is the house's. The line naming the offer's maker.
async function renderBaseBestOffer() {
  const { default: TradeHereBase } = await import("./components/external/TradeHereBase.jsx");
  const o = { price: 0.01, currency: "WETH", maker: HOUSE, orderHash: "0xbase" };
  h.tokenBook = { offers: [o], bestOffer: o, unavailable: false };
  // Our own book answers at once with no listing, so the offer read follows without retries.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ orders: [], count: 0 }) })));
  const collection = { chain: "base", contract: "0x36afee4fadc3b77ff5f1f9a040e264150afb979a", name: "Bojungles" };
  render(<TradeHereBase collection={collection} item={{ id: "7" }} wallet={null} onConnect={() => {}} addToast={() => {}} />);
  return (await screen.findByText(/^from /)).textContent;
}

describe("with a house wallet registered", () => {
  beforeEach(() => {
    h.registry = ONE_HOUSE;
  });

  it('a house collection bid reads "House · buys N (any JBAC)" in the best-offer box and in the list', async () => {
    h.collectionOffers = [collectionBid(HOUSE), collectionBid(OUTSIDE, { price: 0.04, quantity: 1 })];
    await renderCollectionOffers();
    expect(screen.getAllByText("House · buys 2 (any JBAC)")).toHaveLength(2);
    expect(screen.getByText("0xbbbb...bbbb")).toBeTruthy(); // everyone else as before
    expect(screen.queryByText(HOUSE_SHORT)).toBeNull();
  });

  it("counts what the bid still buys, names the collection's own chip, and claims no count it lacks", async () => {
    h.collectionOffers = [collectionBid(HOUSE, { remainingQuantity: 1 })];
    await renderCollectionOffers("gnssart");
    expect(screen.getAllByText("House · buys 1 (any GNSS)")).toHaveLength(2);
    cleanup();
    h.collectionOffers = [collectionBid(HOUSE, { quantityKnown: false })];
    await renderCollectionOffers();
    expect(screen.getAllByText("House")).toHaveLength(2);
  });

  it('a house offer on a token reads "House"', async () => {
    const o = tokenOffer(HOUSE);
    h.tokenBook = { offers: [o], bestOffer: o, unavailable: false };
    await renderOfferPanel();
    expect(await screen.findByText(/^House · /)).toBeTruthy();
    expect(screen.queryByText(new RegExp(escapeRe(HOUSE_SHORT)))).toBeNull();
  });

  it('an offer the house made on your NFT reads "From: House"', async () => {
    h.tokenOffers = [tokenOffer(HOUSE)];
    await renderReceivedOffers();
    expect(await screen.findByText("From: House")).toBeTruthy();
  });

  it('a house listing\'s card says "House"; everyone else\'s says nothing new', async () => {
    const card = await renderListings(HOUSE);
    expect(within(card("1000")).getByText("House")).toBeTruthy();
    expect(within(card("1001")).queryByText("House")).toBeNull();
  });

  it('a house listing on our own order book reads "House" as its maker, on the table and on the phone card', async () => {
    await renderNativeListings(false);
    const row = screen.getByText("#42").closest("tr");
    expect(within(row).getByText("House")).toBeTruthy();
    expect(within(screen.getByText("#43").closest("tr")).getByText("0xbbbb...bbbb")).toBeTruthy();
    cleanup();
    await renderNativeListings(true);
    expect(screen.getByTestId("orderbook-cards").textContent).toMatch(/House · /);
  });

  it('the NFT the house owns reads "Owner: House", and the copy button still copies the address', async () => {
    await renderModal(HOUSE);
    const owner = screen.getByTitle("Copy owner address");
    expect(owner.textContent).toMatch(/Owner: House/);
    expect(owner.textContent).not.toMatch(/0x8ba1/);
  });

  it('the Activity tab names the house in a sale it bought and in its own listing', async () => {
    expect(await renderActivity()).toEqual(["House", "0xbbbb...bbbb→House"]);
  });

  it('Compare reads "Owner: House" for the NFT the house owns', async () => {
    expect(await renderCompareOwner()).toBe("Owner: House");
  });

  it("the house's owner profile is headed \"House\", and still shows and copies its address", async () => {
    const copy = await renderProfile();
    expect(screen.getByText("House")).toBeTruthy();
    expect(copy.textContent).toMatch(new RegExp(`^${escapeRe(HOUSE_SHORT)}`));
  });

  it("the integrity panel names house wallets in a wallet group and in its house trades", async () => {
    h.registry = TWO_HOUSES;
    await renderWalletGroup();
    expect(screen.getByTitle(HOUSE).textContent).toBe("House");
    expect(screen.getByTitle(HOUSE_2).textContent).toBe("House");
    expect(screen.getByTestId("house-trades").textContent).toContain("House bought #1 from House");
    expect(document.body.textContent).not.toMatch(/0x8ba1|0xcccc/);
  });

  it("the holders panel heads the house's row \"House\" over its address, and names it in a whale trade", async () => {
    const name = await renderTopHolder();
    expect(name.textContent).toBe("House");
    expect(name.parentElement.textContent).toContain(HOUSE_SHORT);
    await waitFor(() => expect(document.body.textContent).toContain("0xbbbb...bbbb → House"));
  });

  it('a trade you sent to the house reads "TO House"', async () => {
    expect(await renderSentTrade()).toBe("TO House");
  });

  it('a Base item\'s best offer made by the house reads "from House"', async () => {
    expect(await renderBaseBestOffer()).toBe("from House");
  });
});

describe("with the committed registry (empty): nothing changes", () => {
  it("the registry under test is the committed one, and it names no wallet", () => {
    expect(h.registry).toBe(COMMITTED);
    expect(COMMITTED.wallets).toEqual([]);
  });

  it("collection bids show their makers' addresses as before", async () => {
    h.collectionOffers = [collectionBid(HOUSE), collectionBid(OUTSIDE, { price: 0.04, quantity: 1 })];
    await renderCollectionOffers();
    expect(screen.getByText(`by ${HOUSE_SHORT}`)).toBeTruthy();
    expect(screen.getByText(HOUSE_SHORT)).toBeTruthy();
    expect(screen.queryByText(/House/)).toBeNull();
  });

  it("a token's offers show the maker's address as before", async () => {
    const o = tokenOffer(HOUSE);
    h.tokenBook = { offers: [o], bestOffer: o, unavailable: false };
    await renderOfferPanel();
    await waitFor(() => expect(screen.getByText(new RegExp(`^${escapeRe(HOUSE_SHORT)} · `))).toBeTruthy());
    expect(screen.queryByText(/House/)).toBeNull();
  });

  it("received offers show the maker's address as before", async () => {
    h.tokenOffers = [tokenOffer(HOUSE)];
    await renderReceivedOffers();
    expect(await screen.findByText(`From: ${HOUSE_SHORT}`)).toBeTruthy();
  });

  it("listing cards gain no line", async () => {
    const card = await renderListings(HOUSE);
    expect(card("1000").textContent).not.toMatch(/House/);
    // The house's card has exactly the elements an outside seller's has.
    expect(card("1000").querySelectorAll("*").length).toBe(card("1001").querySelectorAll("*").length);
  });

  it("our own order book shows every maker's address as before", async () => {
    await renderNativeListings(false);
    expect(within(screen.getByText("#42").closest("tr")).getByText(HOUSE_SHORT)).toBeTruthy();
    cleanup();
    await renderNativeListings(true);
    expect(screen.getByTestId("orderbook-cards").textContent).not.toMatch(/House/);
  });

  it("the owner line shows the address as before", async () => {
    await renderModal(HOUSE);
    expect(screen.getByTitle("Copy owner address").textContent).toMatch(new RegExp(`Owner: ${escapeRe(HOUSE_SHORT)}`));
  });

  it("the Activity tab shows every party's address as before", async () => {
    expect(await renderActivity()).toEqual([HOUSE_SHORT, `0xbbbb...bbbb→${HOUSE_SHORT}`]);
    expect(document.body.textContent).not.toMatch(/House/);
  });

  it("Compare shows the owner's address as before", async () => {
    expect(await renderCompareOwner()).toBe(`Owner: ${HOUSE_SHORT}`);
  });

  it("the owner profile is headed by the address alone, as before", async () => {
    const copy = await renderProfile();
    expect(copy.textContent).toMatch(new RegExp(`^${escapeRe(HOUSE_SHORT)}`));
    expect(document.body.textContent).not.toMatch(/House/);
  });

  it("the integrity panel's wallet groups show addresses as before, and no house trades", async () => {
    await renderWalletGroup();
    expect(screen.getByTitle(HOUSE).textContent).toBe("0x8ba1…ba72");
    expect(screen.getByTitle(HOUSE_2).textContent).toBe("0xcccc…cccc");
    expect(screen.queryByTestId("house-trades")).toBeNull();
    expect(document.body.textContent).not.toMatch(/House/);
  });

  it("the holders panel shows each holder's address as before", async () => {
    const name = await renderTopHolder();
    expect(name.textContent).toBe(HOUSE_SHORT);
    // No line under it: only an ENS name brings one.
    expect(name.parentElement.textContent).toBe(HOUSE_SHORT);
    await waitFor(() => expect(document.body.textContent).toContain(`0xbbbb...bbbb → ${HOUSE_SHORT}`));
    expect(document.body.textContent).not.toMatch(/House/);
  });

  it("a trade you sent shows the other wallet's address as before", async () => {
    expect(await renderSentTrade()).toBe("TO 0x8ba1…ba72");
  });

  it("a Base item's best offer shows its maker's address as before", async () => {
    expect(await renderBaseBestOffer()).toBe(`from ${HOUSE_SHORT}`);
  });
});
