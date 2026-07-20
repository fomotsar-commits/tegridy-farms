// verifyBundleOwnership — the on-chain gate that stops a seller from listing a bundle
// containing NFTs they don't own. It had NO test coverage at all before 2026-07-19,
// which is how a rewrite of it nearly shipped unverified.
//
// It was also rewritten from a SEQUENTIAL loop to a parallel fan-out. Sequentially, each
// ownerOf can burn its own 2.5s abort across a multi-URL failover chain, so a large
// bundle could blow the serverless deadline — and it would do so AFTER the seller had
// paid approval gas and signed twice, which is precisely the state that produces a
// duplicate bundle on retry. These tests pin both the fan-out AND that parallelising it
// did not change which error wins.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const OFFERER = "0x" + "a".repeat(40);
const OTHER = "0x" + "b".repeat(40);
const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

function word(addr) {
  return "0x" + String(addr).replace(/^0x/, "").padStart(64, "0");
}

// Drives fetch per-token: `owners` maps tokenId -> address | "revert" | "hang".
// Records concurrency so we can prove the calls overlap.
function stubRpc(owners, { delayMs = 0 } = {}) {
  let inFlight = 0;
  let peakInFlight = 0;
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const data = body.params[0].data;
    const tokenId = String(BigInt("0x" + data.slice(-64)));
    calls.push(tokenId);
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const val = owners[tokenId];
      if (val === "revert") {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }) };
      }
      if (val === "empty") {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) };
      }
      if (val === "transport") {
        throw new Error("socket hang up");
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: word(val) }) };
    } finally {
      inFlight--;
    }
  }));
  return { stats: () => ({ peakInFlight, calls }) };
}

function offerItems(tokenIds) {
  return tokenIds.map((id) => ({
    itemType: 2, token: NAKAMIGOS, identifierOrCriteria: String(id),
    startAmount: "1", endAmount: "1",
  }));
}

describe("verifyBundleOwnership", () => {
  let verifyBundleOwnership;
  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    delete process.env.ALCHEMY_API_KEY_FALLBACK;
    ({ verifyBundleOwnership } = await import("../_lib/seaport-verify.js"));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("passes when the offerer owns every item", async () => {
    stubRpc({ 1: OFFERER, 2: OFFERER, 3: OFFERER });
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer: offerItems([1, 2, 3]) } });
    expect(r).toEqual({ ok: true });
  });

  // The whole point of the gate: one foreign NFT fails the entire bundle, matching
  // Seaport's own all-or-nothing semantics.
  it("fails the WHOLE bundle if any single item is owned by someone else", async () => {
    stubRpc({ 1: OFFERER, 2: OTHER, 3: OFFERER });
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer: offerItems([1, 2, 3]) } });
    expect(r).toEqual({ ok: false, error: "not-owner" });
  });

  it("maps a contract revert to token-not-found (a 4xx, not a 5xx)", async () => {
    stubRpc({ 1: OFFERER, 2: "revert" });
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer: offerItems([1, 2]) } });
    expect(r).toEqual({ ok: false, error: "token-not-found" });
  });

  it("maps empty ownerOf data to token-not-found", async () => {
    stubRpc({ 1: OFFERER, 2: "empty" });
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer: offerItems([1, 2]) } });
    expect(r).toEqual({ ok: false, error: "token-not-found" });
  });

  it("maps an exhausted RPC chain to rpc-unavailable", async () => {
    stubRpc({ 1: "transport" });
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer: offerItems([1]) } });
    expect(r).toEqual({ ok: false, error: "rpc-unavailable" });
  });

  it("rejects an empty offer", async () => {
    stubRpc({});
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer: [] } });
    expect(r).toEqual({ ok: false, error: "no-offer-item" });
  });

  it("rejects an item with no tokenId", async () => {
    stubRpc({ 1: OFFERER });
    const offer = [...offerItems([1]), { itemType: 2, token: NAKAMIGOS, identifierOrCriteria: null }];
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer } });
    expect(r).toEqual({ ok: false, error: "no-token-id" });
  });

  // Parallelising must not reorder error precedence — the first failing item in the
  // ORIGINAL offer order still decides, exactly as the sequential loop did.
  it("returns the FIRST item's error even when a later item fails faster", async () => {
    // #1 is not-owner, #2 reverts. Sequentially #1 won; it must still win.
    stubRpc({ 1: OTHER, 2: "revert" });
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer: offerItems([1, 2]) } });
    expect(r).toEqual({ ok: false, error: "not-owner" });
  });

  // The regression this rewrite exists to prevent: N items must not cost N round-trips
  // of wall-clock, or a large bundle times out after the seller already paid gas.
  it("issues the ownerOf calls concurrently, not one after another", async () => {
    const owners = {};
    for (let i = 1; i <= 10; i++) owners[i] = OFFERER;
    const rpc = stubRpc(owners, { delayMs: 40 });
    const started = Date.now();
    const r = await verifyBundleOwnership({
      parameters: { offerer: OFFERER, offer: offerItems(Object.keys(owners)) },
    });
    const elapsed = Date.now() - started;
    expect(r).toEqual({ ok: true });
    expect(rpc.stats().calls).toHaveLength(10);
    // Sequential would be >= 400ms; parallel lands near one round-trip.
    expect(rpc.stats().peakInFlight).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(300);
  });

  it("skips non-ERC721 offer items without calling the chain for them", async () => {
    const rpc = stubRpc({ 1: OFFERER });
    const offer = [
      ...offerItems([1]),
      { itemType: 1, token: NAKAMIGOS, identifierOrCriteria: "999", startAmount: "1" }, // ERC20
    ];
    const r = await verifyBundleOwnership({ parameters: { offerer: OFFERER, offer } });
    expect(r).toEqual({ ok: true });
    expect(rpc.stats().calls).toEqual(["1"]);
  });
});
