import { describe, it, expect, vi } from "vitest";
import { IPFS_GATEWAYS, DEAD_IPFS_GATEWAY_HOSTS } from "../lib/ipfsGateways";

// Jungle Bay's metadataBase sat on ipfs.io and becomes every JBAC card's
// `${metadataBase}/<id>.png` across the market (Listings, BidManager, MyListings,
// CommunityChat). Retired 2026-09-21, it broke every one of those cards.

const batch = { nfts: [] };

vi.mock("./lib/proxy", () => {
  class ApiError extends Error {}
  return {
    ApiError,
    alchemyGet: vi.fn(async () => ({})),
    alchemyPost: vi.fn(async () => batch),
    openseaGet: vi.fn(async () => ({})),
    openseaPost: vi.fn(async () => ({})),
  };
});

const { COLLECTIONS } = await import("./constants");
const { fetchTokensByIds } = await import("./api");

const onDeadHost = (url) => {
  const h = new URL(url).hostname;
  return DEAD_IPFS_GATEWAY_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
};

describe("Nakamigos-market IPFS URLs", () => {
  it("builds every collection's metadataBase off a retired gateway", () => {
    // The Jungle Bay family entries have metadataBase null on purpose (no
    // per-id image exists); null names no host, so it is on no gateway.
    const withBase = Object.entries(COLLECTIONS).filter(([, c]) => c.metadataBase !== null);
    expect(withBase.map(([slug]) => slug)).toEqual(expect.arrayContaining(["nakamigos", "gnssart", "junglebay"]));
    for (const [slug, c] of withBase) {
      expect(onDeadHost(c.metadataBase), `${slug}: ${c.metadataBase}`).toBe(false);
    }
    expect(COLLECTIONS.junglebay.metadataBase).toBe(
      `${IPFS_GATEWAYS[0]}QmaTrk9RrN3yhwyB1EbRFrxBEEtcbBaGs2NppJGn262Bid`,
    );
  });

  it("rewrites an ipfs.io originalUrl and an ipfs:// raw image onto a live gateway", async () => {
    batch.nfts = [
      { tokenId: "1", contract: { address: COLLECTIONS.nakamigos.contract }, image: { originalUrl: "https://ipfs.io/ipfs/QmA/1.png" } },
      { tokenId: "2", contract: { address: COLLECTIONS.nakamigos.contract }, raw: { metadata: { image: "ipfs://QmB/2.png" } } },
    ];
    const [a, b] = await fetchTokensByIds(["1", "2"], COLLECTIONS.nakamigos.contract, COLLECTIONS.nakamigos.metadataBase);
    expect(a.image).toBe(`${IPFS_GATEWAYS[0]}QmA/1.png`);
    expect(a.imageLarge).toBe(`${IPFS_GATEWAYS[0]}QmA/1.png`);
    expect(b.image).toBe(`${IPFS_GATEWAYS[0]}QmB/2.png`);
  });
});
