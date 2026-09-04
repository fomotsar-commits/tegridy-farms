// Tests for _lib/ethcall.js — the dependency-free eth_call transport the chat
// holder gate rides on.
//
// The module is a VERBATIM extraction of the failover block that still lives in
// _lib/seaport-verify.js (lines 142-247). De-duplicating it needs an edit to
// seaport-verify.js, which the agent that added this module did not own, so the
// first test below pins the two RPC rosters against each other. Delete that
// test the moment seaport-verify.js imports from ethcall.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ethCall, PUBLIC_RPC_URLS, padAddr, pad32 } from "../_lib/ethcall.js";

// cwd = frontend/, and import.meta.url is not reliably a file: URL under jsdom
// (same workaround as src/nakamigos/navRouting.test.jsx:28 and
// src/lib/cowProtocol.test.ts:116). The existence assertion below makes a wrong
// cwd fail loudly instead of silently skipping the drift check.
const SEAPORT_SRC = resolve(process.cwd(), "api/_lib/seaport-verify.js");

/** Pull the string literals out of a `const NAME = Object.freeze([...])` block. */
function extractFrozenList(source, name) {
  const block = source.match(
    new RegExp(`const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`),
  );
  if (!block) return null;
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("ethcall — no drift against the seaport-verify copy", () => {
  it("both modules carry the identical public RPC roster", () => {
    expect(existsSync(SEAPORT_SRC)).toBe(true);
    const fromSeaport = extractFrozenList(readFileSync(SEAPORT_SRC, "utf8"), "PUBLIC_RPC_URLS");
    // Once seaport-verify.js imports the roster instead of declaring it, the
    // literal is gone and there is nothing left to drift.
    if (fromSeaport === null) return;
    expect(fromSeaport).toEqual([...PUBLIC_RPC_URLS]);
  });
});

describe("ethcall — encoding helpers", () => {
  it("padAddr left-pads a lowercased address to 32 bytes", () => {
    expect(padAddr("0x" + "A".repeat(40))).toBe("a".repeat(40).padStart(64, "0"));
  });

  it("padAddr rejects a non-address", () => {
    expect(() => padAddr("0xdeadbeef")).toThrow();
  });

  it("pad32 rejects a value wider than uint256", () => {
    expect(pad32(1n)).toBe("1".padStart(64, "0"));
    expect(() => pad32(2n ** 256n)).toThrow();
  });
});

describe("ethcall — failover chain", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ALCHEMY_API_KEY;

  beforeEach(() => {
    delete process.env.ALCHEMY_API_KEY; // chain = the 2 public URLs only (merkle dropped 2026-08-25)
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = originalKey;
  });

  it("advances to the next URL on a transport failure", async () => {
    // Roster is 2 entries since the 2026-08-25 merkle drop: one transport
    // failure, then the last slot succeeds.
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: "0x2a" }) });
    globalThis.fetch = fetchMock;

    await expect(ethCall("0x" + "1".repeat(40), "0xdeadbeef")).resolves.toBe("0x2a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a deterministic JSON-RPC error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 3, message: "execution reverted" } }),
    });
    globalThis.fetch = fetchMock;

    await expect(ethCall("0x" + "1".repeat(40), "0xdeadbeef")).rejects.toThrow("execution reverted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when every URL in the chain fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(ethCall("0x" + "1".repeat(40), "0xdeadbeef")).rejects.toThrow();
  });
});

// AUDIT TF-022. `eth_call`'s return length is chosen by the CALLED CONTRACT,
// not by the ABI: a fallback doing `assembly { return(0, N) }` answers any
// selector with N bytes. Every caller of this module is reachable
// unauthenticated with an attacker-supplied address, so before the cap the
// callee picked the size of the buffer this lambda allocated.
//
// What is pinned is the pair of properties that make the cap worth having:
// the oversized body is refused, AND refusing it does not send the failover
// chain round again — a retry would multiply the very cost being bounded.
describe("ethcall — an oversized response body", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ALCHEMY_API_KEY;

  beforeEach(() => {
    delete process.env.ALCHEMY_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = originalKey;
  });

  /** A Response whose Content-Length declares more than the cap. */
  const oversized = () => ({
    ok: true,
    headers: { get: (h) => (h.toLowerCase() === "content-length" ? String(50 * 1024 * 1024) : null) },
    body: { cancel() {} },
    json: async () => {
      throw new Error("the body must never be read once the cap is known to be exceeded");
    },
  });

  it("is refused rather than buffered", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(oversized());
    await expect(ethCall("0x" + "1".repeat(40), "0xdeadbeef")).rejects.toThrow(/too large/i);
  });

  it("is NOT retried down the rest of the chain", async () => {
    // Deterministic: the same contract returns the same bytes every time.
    const fetchMock = vi.fn().mockResolvedValue(oversized());
    globalThis.fetch = fetchMock;
    await expect(ethCall("0x" + "1".repeat(40), "0xdeadbeef")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still returns a normal-sized result", async () => {
    // Non-vacuity: the cap must not have broken the ordinary path.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: "0x2a" }),
    });
    await expect(ethCall("0x" + "1".repeat(40), "0xdeadbeef")).resolves.toBe("0x2a");
  });
});
