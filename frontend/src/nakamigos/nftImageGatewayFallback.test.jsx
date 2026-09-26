import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";
import NftImage from "./components/NftImage";
import { IPFS_GATEWAYS, IPFS_STEP_TIMEOUT_MS } from "../lib/ipfsGateways";

// 2026-09-21: ipfs.io and dweb.link were retired. NftImage rendered IPFS art on
// exactly one gateway and, on error, went straight to the metadata proxy and the
// letter placeholder, so a dead first gateway meant no art even though three
// other gateways had it. It must walk the whole gateway list first, and it must
// also walk past a gateway that HANGS, because a hang never fires onError.

const PATH = "QmaTrk9RrN3yhwyB1EbRFrxBEEtcbBaGs2NppJGn262Bid/1.png";
const ON = (i) => `${IPFS_GATEWAYS[i]}${PATH}`;

const metadataCalls = [];

beforeEach(() => {
  metadataCalls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    metadataCalls.push(String(url));
    return { ok: false, json: async () => ({}) };
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderCard(nft, props = {}) {
  return render(
    <CollectionProvider slug="junglebay">
      <NftImage nft={nft} {...props} />
    </CollectionProvider>,
  );
}

describe("NftImage walks the IPFS gateway list", () => {
  it("renders a dead-gateway URL on the first live gateway", () => {
    const nft = { id: "810001", name: "JBAC #810001", image: `https://ipfs.io/ipfs/${PATH}` };
    renderCard(nft);
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(0));
  });

  it("tries every gateway on error before the metadata proxy", async () => {
    const nft = { id: "810002", name: "JBAC #810002", image: `ipfs://${PATH}` };
    renderCard(nft);

    for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
      await waitFor(() => expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(i)));
      expect(metadataCalls).toEqual([]);
      fireEvent.error(screen.getByAltText(nft.name));
    }
    // Only once every gateway has failed does the old chain take over.
    await waitFor(() => expect(metadataCalls.some((u) => u.includes("/api/alchemy"))).toBe(true));
  });

  it("walks the gateways even while a batch fetch owns the metadata (noSelfFetch)", async () => {
    const nft = { id: "810003", name: "JBAC #810003", image: ON(0) };
    renderCard(nft, { noSelfFetch: true });
    fireEvent.error(screen.getByAltText(nft.name));
    await waitFor(() => expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(1)));
    expect(metadataCalls).toEqual([]);
  });

  it("moves past a gateway that hangs without an error", async () => {
    vi.useFakeTimers();
    const nft = { id: "810004", name: "JBAC #810004", image: ON(0) };
    renderCard(nft, { priority: true });
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(0));

    await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS - 1); });
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(0));

    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(1));
  });

  it("leaves a loaded image alone", async () => {
    vi.useFakeTimers();
    const nft = { id: "810005", name: "JBAC #810005", image: ON(0) };
    renderCard(nft, { priority: true });
    fireEvent.load(screen.getByAltText(nft.name));
    await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 3); });
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(0));
  });

  it("does not start a lazy card's clock before it nears the viewport", async () => {
    vi.useFakeTimers();
    const observers = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    });
    const nft = { id: "810006", name: "JBAC #810006", image: ON(0) };
    renderCard(nft);

    await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 3); });
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(0));

    // Scrolled near: now the gateway gets its time, then the next one is tried.
    await act(async () => { observers.at(-1).cb([{ isIntersecting: true }]); });
    await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS); });
    expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(1));
  });

  it("does not walk the same image's gateways twice in large mode", async () => {
    const nft = { id: "810007", name: "JBAC #810007", image: ON(0), imageLarge: `ipfs://${PATH}` };
    renderCard(nft, { large: true });
    for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
      await waitFor(() => expect(screen.getByAltText(nft.name)).toHaveAttribute("src", ON(i)));
      fireEvent.error(screen.getByAltText(nft.name));
    }
    // The "thumbnail" is the same CID, so the step-down is skipped and the
    // metadata proxy is next, not a second lap of the gateways.
    await waitFor(() => expect(metadataCalls.some((u) => u.includes("/api/alchemy"))).toBe(true));
  });
});
