// A loan is offered only on a collection the lending contract accepts.
//
// TegridyNFTLending whitelists three collections in its constructor (JBAC,
// Nakamigos, GNSS Art) and reverts CollectionNotWhitelisted for any other.
// Gold Cards now trades on this venue, so an owner of one reaches the detail
// Modal and My NFTs, the two places that point a holder at NFT Finance. A
// Gold Cards loan cannot be taken, so neither may offer one. The venue's
// list of loan collections is also held to the contract's own whitelist here,
// so the two cannot drift apart unnoticed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import { CollectionProvider } from "./contexts/CollectionContext";
import { TradingModeProvider } from "./contexts/TradingModeContext";
import * as constants from "./constants";
import { ADDR } from "./__fixtures__/jungleBayFamily";

const OWNER = "0x" + "b".repeat(40);

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
vi.mock("./hooks/useEns", () => ({ default: () => ({ ensName: null }) }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // The owner's wallet holds one token of whichever collection is asked for.
    fetchWalletNfts: vi.fn(async (wallet, contract) => ({
      tokens: [{ id: "7", name: "Token #7", image: null, attributes: [], owner: wallet, contract: String(contract).toLowerCase(), price: null, lastSale: null, rank: null }],
      totalCount: 1,
      complete: true,
    })),
    fetchTokenSalesHistory: vi.fn(async () => []),
    fulfillSeaportOrder: vi.fn(),
  };
});
vi.mock("./api-offers", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchMyListings: vi.fn(async () => ({ listings: [], fallback: false })),
  fetchTokenOfferBook: vi.fn(async () => ({ best: null, offers: [], fallback: false })),
}));

// Rendering the real Modal costs a first import of several seconds.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
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

function withCollection(slug, node) {
  return (
    <MemoryRouter>
      <TradingModeProvider>
        <CollectionProvider slug={slug}>{node}</CollectionProvider>
      </TradingModeProvider>
    </MemoryRouter>
  );
}

const loanLinks = () => screen.queryAllByRole("link").filter((a) => a.getAttribute("href") === "/nft-finance");

async function renderOwnedModal(slug) {
  const { default: Modal } = await import("./components/Modal.jsx");
  const contract = constants.COLLECTIONS[slug].contract.toLowerCase();
  const nft = { id: "7", name: "Token #7", image: null, attributes: [], owner: OWNER, contract, price: null, lastSale: null, rank: null };
  render(withCollection(slug, (
    <Modal
      nft={nft}
      onClose={() => {}}
      isFavorite={false}
      onToggleFavorite={() => {}}
      wallet={OWNER}
      onConnect={() => {}}
      addToast={() => {}}
      onTheater={() => {}}
      onShare={() => {}}
      onViewProfile={() => {}}
      floorPrice={null}
      statsSupply={null}
      allTokens={[]}
      onList={() => {}}
    />
  )));
  await screen.findByRole("dialog");
}

async function renderMyNfts(slug) {
  const { default: MyCollection } = await import("./components/MyCollection.jsx");
  render(withCollection(slug, (
    <MyCollection wallet={OWNER} onPick={() => {}} onConnect={() => {}} addToast={() => {}} stats={{ floor: null }} />
  )));
  await waitFor(() => expect(screen.getAllByText(/Token #7/).length).toBeGreaterThan(0));
}

describe("the lending whitelist", () => {
  it("the venue's loan collections are exactly the ones TegridyNFTLending whitelists", () => {
    const sol = readFileSync(fileURLToPath(new URL("../../../contracts/src/TegridyNFTLending.sol", import.meta.url)), "utf8");
    const whitelisted = [...sol.matchAll(/whitelistedCollections\[(0x[0-9a-fA-F]{40})\]\s*=\s*true/g)].map((m) => m[1].toLowerCase());
    expect(whitelisted.length).toBe(3);
    const desk = constants.NFT_LOAN_DESK_CONTRACTS;
    expect(desk, "constants.js exports no NFT_LOAN_DESK_CONTRACTS").toBeInstanceOf(Set);
    expect([...desk].sort()).toEqual([...whitelisted].sort());
    expect(desk.has(ADDR.junglebaygoldcards.toLowerCase())).toBe(false);
  });
});

describe("the detail Modal", () => {
  it("offers a Gold Cards owner no loan: the lending contract does not accept Gold Cards", async () => {
    expect(constants.NFT_LOAN_DESK_LIVE).toBe(true);
    await renderOwnedModal("junglebaygoldcards");
    expect(screen.queryByText(/Borrow ETH against it/)).toBeNull();
    expect(loanLinks()).toEqual([]);
  });

  it("control: a Nakamigos owner is still pointed at NFT Finance", async () => {
    await renderOwnedModal("nakamigos");
    expect(screen.getByText(/Borrow ETH against it in NFT Finance/)).toBeInTheDocument();
    expect(loanLinks().length).toBe(1);
  });
});

describe("My NFTs", () => {
  it("tells a Gold Cards holder nothing about a loan their cards cannot back", async () => {
    await renderMyNfts("junglebaygoldcards");
    expect(screen.queryByText(/can back an ETH loan/)).toBeNull();
    expect(loanLinks()).toEqual([]);
  });

  it("control: a Nakamigos holder still sees the loan banner", async () => {
    await renderMyNfts("nakamigos");
    await waitFor(() => expect(screen.getByText(/Your Nakamigos NFTs can back an ETH loan in NFT Finance/)).toBeInTheDocument());
    expect(loanLinks().length).toBe(1);
  });
});
