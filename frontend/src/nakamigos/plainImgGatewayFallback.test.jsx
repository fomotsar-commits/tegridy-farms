import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";
import { IPFS_GATEWAYS, IPFS_STEP_TIMEOUT_MS } from "../lib/ipfsGateways";

// The plain <img> surfaces (history rows, whale NFT strips, chat token chips,
// portfolio rows, collection cards, ENS avatars, launchpad banners) walked the
// gateway list only on ERROR. A gateway that hangs never errors, so each of
// those images stopped at the first hung gateway. They now render through
// components/IpfsImg, which shares NftImage's hang timer. This pins the wiring
// on two real surfaces, not just the helper.

vi.mock("./lib/rpcProvider", () => ({
  getReadProvider: vi.fn(async () => {
    throw new Error("no rpc in test");
  }),
}));

vi.mock("./api", () => ({
  fetchTopHolders: vi.fn(),
  fetchActivity: vi.fn(),
  fetchWalletNfts: vi.fn(),
  shortenAddress: (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ""),
}));

const { default: TransactionHistory } = await import("./components/TransactionHistory");
const { default: WhaleIntelligence } = await import("./components/WhaleIntelligence.jsx");
const { fetchTopHolders, fetchActivity, fetchWalletNfts } = await import("./api");

const PATH = "QmaTrk9RrN3yhwyB1EbRFrxBEEtcbBaGs2NppJGn262Bid/42.png";
const ON = (i) => `${IPFS_GATEWAYS[i]}${PATH}`;
const WALLET = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

/** The three behaviours every IPFS image must have, driven on a rendered <img>. */
async function expectWalksHangsAndErrors(getImg) {
  // Starts on a live gateway (the stored URL was on retired ipfs.io).
  expect(getImg()).toHaveAttribute("src", ON(0));

  // A hung gateway: nothing arrives for a whole step, so the next one is tried.
  await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS); });
  expect(getImg()).toHaveAttribute("src", ON(1));

  // An erroring gateway: the next one at once.
  fireEvent.error(getImg());
  expect(getImg()).toHaveAttribute("src", ON(2));

  // A gateway whose bytes are arriving is left to finish.
  Object.defineProperty(getImg(), "naturalWidth", { configurable: true, get: () => 2480 });
  await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 5); });
  expect(getImg()).toHaveAttribute("src", ON(2));
}

describe("plain IPFS <img> surfaces move past a hung gateway", () => {
  it("TransactionHistory rows", async () => {
    vi.useFakeTimers();
    localStorage.setItem("nakamigos_tx_history", JSON.stringify([{
      id: "a", type: "buy", tokenId: "42", name: "Nakamigo #42", price: 0.5,
      wallet: WALLET.toLowerCase(), timestamp: Date.now() - 60_000,
      image: `https://ipfs.io/ipfs/${PATH}`,
    }]));
    const { container } = render(
      <CollectionProvider slug="nakamigos">
        <TransactionHistory wallet={WALLET} />
      </CollectionProvider>,
    );
    expect(screen.getByText("Nakamigo #42")).toBeInTheDocument();
    await expectWalksHangsAndErrors(() => container.querySelector(`img[src*="${PATH}"]`));
  });

  it("WhaleIntelligence's expanded holder NFTs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchTopHolders.mockResolvedValue({
      holders: [{ address: WALLET, count: 5 }], totalOwners: 1, totalHeld: 5, fallback: false,
    });
    fetchActivity.mockResolvedValue({ activities: [], fallback: false, pageKey: null });
    fetchWalletNfts.mockResolvedValue({
      tokens: [{ id: "42", name: "JBAC #42", image: `https://ipfs.io/ipfs/${PATH}` }],
      totalCount: 1,
    });
    render(
      <CollectionProvider slug="junglebay">
        <WhaleIntelligence />
      </CollectionProvider>,
    );
    // The address itself is an Etherscan link that stops the click; the row expands.
    const row = (await screen.findByText("0x1111…1111")).closest(".card-reveal");
    fireEvent.click(row);
    await screen.findByAltText("JBAC #42");
    // The image appeared from an async fetch, outside act: let its effects run
    // (that is when the hang timer arms) before the clock is moved.
    await act(async () => {});
    await expectWalksHangsAndErrors(() => screen.getByAltText("JBAC #42"));
  });
});
