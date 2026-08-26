// `eth_getCode` batch — a partially-answered batch is not "these are all EOAs".
//
// The scanner's exclusion pass (LP pairs, CEX wallets, bridges, lockers, vaults)
// has exactly one generic input: `isContract`. Anything that silently produces a
// `false` there does not disable the exclusion loudly — it makes the loop run and
// match nothing, which reads downstream as "every one of these holders is a
// person". So this module rejects a batch it cannot fully account for rather than
// trusting the part that arrived.

import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchContractFlags, rpcUrlChain } from "../_lib/eth-code.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CODE = "0x60806040"; // any non-empty code
const EOA = "0x";

/** A batch response for the given results, in id order. */
function batch(results) {
  return {
    ok: true,
    status: 200,
    json: async () => results.map((result, id) => ({ jsonrpc: "2.0", id, result })),
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchContractFlags", () => {
  it("reads code presence per address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => batch([CODE, EOA])));
    const flags = await fetchContractFlags([A, B]);
    expect(flags.get(A)).toBe(true);
    expect(flags.get(B)).toBe(false);
  });

  it("treats a batch that answered only SOME ids as unreadable", async () => {
    // ⚠ The case that matters. Silently keeping the answered half would mark every
    // unanswered address an EOA — a pool counted as a person, which is the exact
    // defect this module exists to remove.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ jsonrpc: "2.0", id: 0, result: CODE }] })),
    );
    await expect(fetchContractFlags([A, B])).rejects.toThrow(/answered 1 of 2/);
  });

  it("rejects a duplicated id rather than letting arrival order decide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { jsonrpc: "2.0", id: 0, result: CODE },
          { jsonrpc: "2.0", id: 0, result: EOA },
        ],
      })),
    );
    await expect(fetchContractFlags([A, B])).rejects.toThrow(/more than once/);
  });

  it("rejects an RPC error, a non-array body and a non-hex result", async () => {
    const bodies = [
      [{ jsonrpc: "2.0", id: 0, error: { message: "limit exceeded" } }],
      { jsonrpc: "2.0", id: 0, result: CODE }, // not a batch
      [{ jsonrpc: "2.0", id: 0, result: "nope" }],
    ];
    for (const body of bodies) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
      await expect(fetchContractFlags([A])).rejects.toThrow();
    }
  });

  it("walks to the next endpoint when one fails, and only throws when all do", async () => {
    // Keyless roster is 2 endpoints since the 2026-08-25 merkle drop: one
    // transport failure, then the last slot succeeds.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("socket hang up");
        return batch([CODE]);
      }),
    );
    expect((await fetchContractFlags([A])).get(A)).toBe(true);
    expect(call).toBe(2);
  });

  it("throws when every endpoint fails — never an all-EOA default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchContractFlags([A])).rejects.toThrow();
  });

  it("dedupes addresses and answers an empty request without a network call", async () => {
    const spy = vi.fn(async () => batch([CODE]));
    vi.stubGlobal("fetch", spy);
    const flags = await fetchContractFlags([A, A.toUpperCase()]);
    expect(flags.size).toBe(1);
    expect(spy.mock.calls[0][1].body).toBe(
      JSON.stringify([{ jsonrpc: "2.0", id: 0, method: "eth_getCode", params: [A, "latest"] }]),
    );

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should not be called"); }));
    expect((await fetchContractFlags([])).size).toBe(0);
  });

  it("prefers a configured key and always keeps the keyless roster as backup", () => {
    delete process.env.ALCHEMY_API_KEY;
    expect(rpcUrlChain()).toHaveLength(2);
    process.env.ALCHEMY_API_KEY = "realkey";
    const chain = rpcUrlChain();
    expect(chain[0]).toContain("realkey");
    expect(chain).toHaveLength(3);
    // "demo" is a placeholder, not a key — it must not displace a working public node.
    process.env.ALCHEMY_API_KEY = "demo";
    expect(rpcUrlChain()).toHaveLength(2);
    delete process.env.ALCHEMY_API_KEY;
  });
});
