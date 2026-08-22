import { describe, it, expect, vi } from "vitest";
import { createSolanaRpc, SolanaRpcError } from "./rpc.js";

const ok = (result) => ({
  ok: true,
  status: 200,
  json: async () => ({ jsonrpc: "2.0", id: 1, result }),
});
const rpcError = (code, message) => ({
  ok: true,
  status: 200,
  json: async () => ({ jsonrpc: "2.0", id: 1, error: { code, message } }),
});
const httpStatus = (status) => ({ ok: status < 400, status, json: async () => ({}) });

describe("createSolanaRpc", () => {
  it("requires at least one endpoint", () => {
    expect(() => createSolanaRpc({ urls: [] })).toThrow();
  });

  it("posts a well-formed JSON-RPC envelope", async () => {
    const fetchImpl = vi.fn(async () => ok(1234));
    const rpc = createSolanaRpc({ urls: ["https://a"], fetchImpl });
    expect(await rpc.getSlot()).toBe(1234);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ jsonrpc: "2.0", method: "getSlot" });
  });

  it("asks for jsonParsed, which is the encoding that carries balance owners", async () => {
    const fetchImpl = vi.fn(async () => ok({ slot: 7, meta: { err: null } }));
    const rpc = createSolanaRpc({ urls: ["https://a"], fetchImpl });
    await rpc.getTransaction("sigA");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.params[1]).toMatchObject({ encoding: "jsonParsed", maxSupportedTransactionVersion: 0 });
  });

  it("rotates to the next endpoint when one is unreachable", async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url) => {
      seen.push(url);
      if (url === "https://a") throw new Error("ECONNRESET");
      return ok(99);
    });
    const rpc = createSolanaRpc({ urls: ["https://a", "https://b"], fetchImpl });
    expect(await rpc.getSlot()).toBe(99);
    expect(seen).toEqual(["https://a", "https://b"]);
  });

  // A second endpoint answers a "this data is gone" the same way. Rotating on
  // it turns one honest error into one per configured endpoint and hides which
  // failure actually happened.
  it("does not rotate on a pruned or rejected answer", async () => {
    const fetchImpl = vi.fn(async () => rpcError(-32007, "Slot skipped"));
    const rpc = createSolanaRpc({ urls: ["https://a", "https://b"], fetchImpl });
    await expect(rpc.getTransaction("sigA")).rejects.toMatchObject({ kind: "pruned" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies 429 and 5xx as unreachable, and other 4xx as rejected", async () => {
    for (const [status, kind] of [
      [429, "unreachable"],
      [503, "unreachable"],
      [400, "rejected"],
    ]) {
      const rpc = createSolanaRpc({ urls: ["https://a"], fetchImpl: async () => httpStatus(status) });
      await expect(rpc.getSlot()).rejects.toMatchObject({ kind });
    }
  });

  // A null result means the cluster has no record of a signature it listed.
  // Returning null (rather than an empty transaction object) is what lets the
  // caller record it as a gap instead of as a transaction that did nothing.
  it("returns null for an unknown transaction rather than an empty one", async () => {
    const rpc = createSolanaRpc({ urls: ["https://a"], fetchImpl: async () => ok(null) });
    expect(await rpc.getTransaction("sigA")).toBeNull();
  });

  it("refuses a response whose shape it does not recognise", async () => {
    const cases = [
      [async () => ({ ok: true, status: 200, json: async () => "nope" }), "malformed"],
      [async () => ok({ noMeta: true }), "malformed"],
      [
        async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1 }) }),
        "malformed",
      ],
    ];
    for (const [fetchImpl, kind] of cases) {
      const rpc = createSolanaRpc({ urls: ["https://a"], fetchImpl });
      await expect(rpc.getTransaction("sigA")).rejects.toMatchObject({ kind });
    }
  });

  it("refuses a signature page whose entries are missing slot or signature", async () => {
    const rpc = createSolanaRpc({
      urls: ["https://a"],
      fetchImpl: async () => ok([{ signature: "sigA" }]),
    });
    await expect(rpc.getSignaturesForAddress("pool")).rejects.toBeInstanceOf(SolanaRpcError);
  });

  it("normalises a missing blockTime to null rather than to zero", async () => {
    const rpc = createSolanaRpc({
      urls: ["https://a"],
      fetchImpl: async () => ok([{ signature: "sigA", slot: 5, blockTime: null }]),
    });
    const [entry] = await rpc.getSignaturesForAddress("pool");
    expect(entry.blockTime).toBeNull();
  });

  it("passes before/until through only when set", async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const rpc = createSolanaRpc({ urls: ["https://a"], fetchImpl });
    await rpc.getSignaturesForAddress("pool", { limit: 5 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).params[1]).toEqual({
      limit: 5,
      commitment: "confirmed",
    });
    await rpc.getSignaturesForAddress("pool", { limit: 5, before: "b", until: "u" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).params[1]).toMatchObject({
      before: "b",
      until: "u",
    });
  });
});
