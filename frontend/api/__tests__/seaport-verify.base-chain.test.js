// A Base order's signature and ownership are checked on Base: the counter is
// read from Seaport 1.6 on Base, the signature against the Seaport 1.6 Base
// domain, and ownerOf on Base. Ethereum orders keep Seaport 1.5 on Ethereum.
import { describe, it, expect, beforeEach, vi } from "vitest";
// Warms the module graph at collection time (see seaport-verify.test.js).
import "../_lib/seaport-verify.js";

const typed = vi.hoisted(() => ({ calls: [] }));
vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      verifyTypedData: vi.fn(async (args) => { typed.calls.push(args); return true; }),
    })),
  };
});

const OFFERER = "0x" + "a".repeat(40);
const BOJ = "0x36afee4fadc3b77ff5f1f9a040e264150afb979a";
const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";

function params(token) {
  return {
    offerer: OFFERER,
    zone: "0x" + "0".repeat(40),
    offer: [{ itemType: 2, token, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }],
    consideration: [],
    orderType: 0, startTime: "1", endTime: "2", zoneHash: "0x" + "0".repeat(64), salt: "1",
    conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  };
}

let verify;
let rpc;
beforeEach(async () => {
  vi.resetModules();
  typed.calls = [];
  rpc = [];
  process.env.ALCHEMY_API_KEY = "test-key";
  delete process.env.ALCHEMY_API_KEY_FALLBACK;
  delete process.env.SEAPORT_CHAIN_ID;
  globalThis.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    rpc.push({ url: String(url), to: body.params?.[0]?.to });
    // getCounter answers 0; ownerOf answers the offerer.
    const result = body.params?.[0]?.data?.startsWith("0x6352211e") ? "0x" + "0".repeat(24) + "a".repeat(40) : "0x" + "0".repeat(64);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  });
  verify = await import("../_lib/seaport-verify.js");
});

describe("verifySeaportSignature by chain", () => {
  it("a Base order is checked against Seaport 1.6 on Base, with Base's counter", async () => {
    const out = await verify.verifySeaportSignature({ parameters: params(BOJ), signature: "0x" + "1".repeat(130), chainId: 8453 });
    expect(out).toEqual({ ok: true });
    expect(rpc[0].url).toMatch(/^https:\/\/base-mainnet\.g\.alchemy\.com\//);
    expect(rpc[0].to.toLowerCase()).toBe(SEAPORT_16.toLowerCase());
    expect(typed.calls[0].domain).toEqual({ name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: SEAPORT_16 });
  });

  it("an Ethereum order keeps Seaport 1.5 on Ethereum", async () => {
    await verify.verifySeaportSignature({ parameters: params(BOJ), signature: "0x" + "1".repeat(130) });
    expect(rpc[0].url).toMatch(/^https:\/\/eth-mainnet\.g\.alchemy\.com\//);
    expect(rpc[0].to.toLowerCase()).toBe(SEAPORT_15.toLowerCase());
    expect(typed.calls[0].domain).toEqual({ name: "Seaport", version: "1.5", chainId: 1, verifyingContract: SEAPORT_15 });
  });

  it("a chain with no Seaport domain here is refused, never checked against another chain's", async () => {
    const out = await verify.verifySeaportSignature({ parameters: params(BOJ), signature: "0x" + "1".repeat(130), chainId: 137 });
    expect(out).toEqual({ ok: false, error: "unsupported-chain" });
    expect(rpc).toEqual([]);
  });
});

describe("verifyNftOwnership by chain", () => {
  it("a Base NFT's owner is read on Base", async () => {
    const out = await verify.verifyNftOwnership({ parameters: params(BOJ), chainId: 8453 });
    expect(out).toEqual({ ok: true });
    expect(rpc[0].url).toMatch(/^https:\/\/base-mainnet\.g\.alchemy\.com\//);
    expect(rpc[0].to).toBe(BOJ);
  });

  it("an unknown chain is refused before any read", async () => {
    expect(await verify.verifyNftOwnership({ parameters: params(BOJ), chainId: 137 })).toEqual({ ok: false, error: "unsupported-chain" });
    expect(rpc).toEqual([]);
  });

  it("when Alchemy is down, the Base read falls to Base's public hosts, never Ethereum's", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      rpc.push({ url: String(url) });
      if (String(url).includes("alchemy")) return { ok: false, status: 503, json: async () => ({}) };
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result: "0x" + "0".repeat(24) + "a".repeat(40) }) };
    });
    const out = await verify.verifyNftOwnership({ parameters: params(BOJ), chainId: 8453 });
    expect(out).toEqual({ ok: true });
    expect(rpc.map((r) => r.url)).toEqual(["https://base-mainnet.g.alchemy.com/v2/test-key", "https://base-rpc.publicnode.com"]);
  });
});
