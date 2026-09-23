// Unit tests for the chat holder gate (_lib/holder-gate.js).
//
// The gate is the SERVER-side half of the "HOLDER EXCLUSIVE" claim rendered at
// CommunityChat.jsx:925-932. Before it existed, the only gate was a hidden
// textarea (CommunityChat.jsx:885) and the RLS policy (migration 004:97-102)
// checked identity, not entitlement — so any wallet that completed a free SIWE
// signature could post in a room advertised as holder-only.
//
// `_lib/ethcall.js` is mocked so no test touches the network. `IS_PROD` is
// captured at module load, so every case re-imports via vi.resetModules() —
// same pattern as supabase-proxy.test.js:55-61.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const WALLET = "0x" + "a".repeat(40);

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const GNSSART = "0xa1de9f93c56c290c48849b1393b09eb616d55dbb";

const mocks = vi.hoisted(() => ({
  ethCall: vi.fn(),
  alchemyUrl: vi.fn(() => null),
}));

vi.mock("../_lib/ethcall.js", () => ({
  ethCall: mocks.ethCall,
  alchemyUrl: mocks.alchemyUrl,
  // Real implementation — the gate feeds the caller's address through it and a
  // stub would hide a malformed-calldata bug.
  padAddr: (addr) => {
    const stripped = String(addr).toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(stripped)) throw new Error("bad address");
    return stripped.padStart(64, "0");
  },
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

async function loadGate() {
  vi.resetModules();
  return await import("../_lib/holder-gate.js");
}

describe("holder-gate — assertChatHolder", () => {
  beforeEach(() => {
    mocks.ethCall.mockReset();
    mocks.alchemyUrl.mockReset();
    mocks.alchemyUrl.mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    delete process.env.VERCEL_ENV;
    vi.restoreAllMocks();
  });

  it("DENIES a wallet holding zero NFTs", async () => {
    mocks.ethCall.mockResolvedValue("0x0");
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "nakamigos", text: "gm" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("ALLOWS a wallet holding one NFT", async () => {
    mocks.ethCall.mockResolvedValue("0x1");
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "nakamigos", text: "gm" });
    expect(result).toEqual({ ok: true });
    // Calldata must be balanceOf(address) against the collection contract.
    expect(mocks.ethCall).toHaveBeenCalledWith(
      NAKAMIGOS,
      "0x70a08231" + WALLET.slice(2).padStart(64, "0"),
    );
  });

  it("DENIES a slug that is not a known collection (no RPC call at all)", async () => {
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "not-a-collection" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(mocks.ethCall).not.toHaveBeenCalled();
  });

  it("DENIES a caller with no / malformed verified wallet", async () => {
    const { assertChatHolder } = await loadGate();
    for (const bad of ["not-an-address", "", null, undefined, "0xdeadbeef"]) {
      const result = await assertChatHolder(bad, { slug: "nakamigos" });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
    }
    expect(mocks.ethCall).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED in production when the RPC chain is exhausted", async () => {
    process.env.NODE_ENV = "production";
    mocks.ethCall.mockRejectedValue(new Error("RPC HTTP 503"));
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "nakamigos" });
    // Pin the INVARIANT (an outage denies), never the wording.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("FAILS CLOSED on a Vercel preview deploy too", async () => {
    process.env.VERCEL_ENV = "preview";
    mocks.ethCall.mockRejectedValue(new Error("RPC HTTP 503"));
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "nakamigos" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("skips the gate in NON-prod when no RPC is configured (documented dev carve-out)", async () => {
    // Mirrors seaport-verify.js:342-345 / 403-406. This branch is why the
    // pre-existing supabase-proxy integration tests keep passing offline.
    mocks.ethCall.mockRejectedValue(new Error("RPC HTTP 503"));
    mocks.alchemyUrl.mockReturnValue(null);
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "nakamigos" });
    expect(result).toEqual({ ok: true });
  });

  it("DENIES in non-prod when an RPC key IS configured but the chain fails", async () => {
    mocks.ethCall.mockRejectedValue(new Error("RPC HTTP 503"));
    mocks.alchemyUrl.mockReturnValue("https://eth-mainnet.g.alchemy.com/v2/k");
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "nakamigos" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("checks EVERY slug in an array body, not just the first", async () => {
    mocks.ethCall.mockImplementation(async (to) => (to === NAKAMIGOS ? "0x5" : "0x0"));
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, [
      { slug: "nakamigos", text: "a" },
      { slug: "gnssart", text: "b" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(mocks.ethCall).toHaveBeenCalledWith(GNSSART, expect.any(String));
  });
});

describe("holder-gate: SLUG_CONTRACTS parity with the client's VENUE collections", () => {
  // The map mirrors the client's venue list (api/ cannot import src/). This is
  // the ONLY thing standing between the two and a silent 403 for every post in
  // a venue collection's room. It is the VENUE list, not every registry entry:
  // the gate is an ERC-721 balanceOf on Ethereum, which reverts on an ERC-1155,
  // reads the wrong chain for Base, and has no contract to call for Solana.
  it("matches VENUE_COLLECTIONS in src/nakamigos/lib/venue.js exactly", async () => {
    const { SLUG_CONTRACTS } = await import("../_lib/holder-gate.js");
    const { VENUE_COLLECTIONS } = await import(/* @vite-ignore */ "../../src/nakamigos/lib/venue.js" + "");

    expect(Object.keys(SLUG_CONTRACTS).sort()).toEqual(VENUE_COLLECTIONS.map((c) => c.slug).sort());
    for (const c of VENUE_COLLECTIONS) {
      expect(SLUG_CONTRACTS[c.slug]).toBe(c.contract.toLowerCase());
    }
  });
});

describe("holder-gate: the Jungle Bay family rooms", () => {
  const GOLD = "0x6aa03f42c5366e2664c887eb2e90844ca00b92f3";

  beforeEach(() => {
    mocks.ethCall.mockReset();
    mocks.alchemyUrl.mockReset();
    mocks.alchemyUrl.mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a Gold Card holder may post in the Gold Cards room", async () => {
    mocks.ethCall.mockResolvedValue("0x1");
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "junglebaygoldcards", text: "gm" });
    expect(result).toEqual({ ok: true });
    expect(mocks.ethCall).toHaveBeenCalledWith(GOLD, "0x70a08231" + WALLET.slice(2).padStart(64, "0"));
  });

  it("a wallet with no Gold Card may not", async () => {
    mocks.ethCall.mockResolvedValue("0x0");
    const { assertChatHolder } = await loadGate();
    const result = await assertChatHolder(WALLET, { slug: "junglebaygoldcards", text: "gm" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it.each(["bojungles", "memeticseeds", "junglebaymemes", "raretowelie", "junglets"])(
    "a view-only collection (%s) has no room, and costs no RPC call",
    async (slug) => {
      const { assertChatHolder } = await loadGate();
      const result = await assertChatHolder(WALLET, { slug, text: "gm" });
      expect(result).toEqual({ ok: false, status: 403, error: "Unknown collection" });
      expect(mocks.ethCall).not.toHaveBeenCalled();
    },
  );
});
