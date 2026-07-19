import { describe, it, expect } from "vitest";

import { resolveSeaportTarget, KNOWN_SEAPORT_ADDRESSES, SEAPORT_ADDRESS } from "../constants";

// SECURITY REGRESSION TEST — native-orderbook fulfillment target pinning.
//
// A stored native order carries its own `protocol_address`, and the client uses that
// value as BOTH the contract it calls AND the recipient of `{ value: totalWei }`
// (lib/orderbook.js fulfillNativeOrder). The row is server-supplied, so an unpinned
// value would let a poisoned/tampered row aim the buyer's ETH at an arbitrary
// contract. The OpenSea/Seaport sibling path already aborts on an unexpected target
// ("Unexpected transaction target — aborting for safety"); these tests hold the
// native path to the same standard.
//
// The load-bearing property is FAIL-CLOSED: an unknown address must resolve to null
// so the caller aborts. It must never silently fall back to the default Seaport
// address — that would execute an order whose signed domain doesn't match where the
// ETH is being sent.
describe("resolveSeaportTarget — fulfillment target pinning", () => {
  it("accepts Seaport 1.5 (the canonical address)", () => {
    expect(resolveSeaportTarget(SEAPORT_ADDRESS)).toBe(SEAPORT_ADDRESS);
  });

  it("accepts Seaport 1.6", () => {
    const v16 = "0x0000000000000068F116a894984e2DB1123eB395";
    expect(resolveSeaportTarget(v16)).toBe(v16);
  });

  it("is case-insensitive (rows may be stored lowercased or checksummed)", () => {
    expect(resolveSeaportTarget(SEAPORT_ADDRESS.toLowerCase())).toBeTruthy();
    expect(resolveSeaportTarget(SEAPORT_ADDRESS.toUpperCase().replace("0X", "0x"))).toBeTruthy();
  });

  it("defaults to canonical Seaport when the row omits the field", () => {
    expect(resolveSeaportTarget(undefined)).toBe(SEAPORT_ADDRESS);
    expect(resolveSeaportTarget(null)).toBe(SEAPORT_ADDRESS);
    expect(resolveSeaportTarget("")).toBe(SEAPORT_ADDRESS);
  });

  // The whole point: an attacker-named target must FAIL CLOSED, not fall back.
  it("REFUSES an attacker-controlled address (returns null, does NOT fall back)", () => {
    const attacker = "0x00000000000000000000000000000000deadbeef";
    expect(resolveSeaportTarget(attacker)).toBeNull();
    expect(resolveSeaportTarget(attacker)).not.toBe(SEAPORT_ADDRESS);
  });

  it("refuses near-miss / lookalike addresses", () => {
    // one hex digit off the real Seaport 1.5 address
    expect(resolveSeaportTarget("0x00000000000000ADc04C56Bf30aC9d3c0aAF14dD")).toBeNull();
    // right prefix, wrong tail
    expect(resolveSeaportTarget("0x00000000000000ADc04C56Bf30aC9d3c00000000")).toBeNull();
  });

  it("refuses non-address junk instead of throwing", () => {
    expect(resolveSeaportTarget("not-an-address")).toBeNull();
    expect(resolveSeaportTarget("0x")).toBeNull();
    expect(resolveSeaportTarget(12345)).toBeNull();
  });

  it("allowlist stays minimal — only the two audited Seaport versions", () => {
    expect(KNOWN_SEAPORT_ADDRESSES.size).toBe(2);
    // stored lowercased so the case-insensitive lookup works
    for (const a of KNOWN_SEAPORT_ADDRESSES) expect(a).toBe(a.toLowerCase());
  });
});
