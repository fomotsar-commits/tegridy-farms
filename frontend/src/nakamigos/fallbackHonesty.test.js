import { describe, it, expect, vi } from "vitest";
import { FALLBACK_ACTIVITY } from "./constants";

// Guards the honesty-pass fix (F540): fallback/demo data must not fabricate
// activity by real, named collectors with perpetually-fresh timestamps.

describe("fallback data honesty (F540)", () => {
  it("FALLBACK_ACTIVITY timestamps are not perpetually 'just now'", () => {
    // The old code used Date.now() - offset so the first sale always rendered as
    // "2 minutes ago". A fixed reference timestamp must read as clearly in the
    // past relative to the current clock.
    const now = Date.now();
    for (const a of FALLBACK_ACTIVITY) {
      // Well in the past (more than a day old) — never masquerades as fresh.
      expect(now - a.time).toBeGreaterThan(24 * 60 * 60 * 1000);
      // Explicitly flagged as sample data for any inline watermark consumer.
      expect(a.sample).toBe(true);
    }
  });
});

// Keep the real module so `ApiError` (api.js:2) still resolves — only the
// network call is replaced.
vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, alchemyGet: vi.fn(async () => { throw new Error("holders API down"); }) };
});

describe("holder-data outage honesty", () => {
  // A plain Error is neither TypeError nor ApiError, so withRetry (api.js:47)
  // treats it as non-retryable and this resolves without any backoff sleep.
  it("fetchTopHolders returns NO holders when the holder API is down", async () => {
    const { fetchTopHolders } = await import("./api");
    const { CONTRACT } = await import("./constants");
    const res = await fetchTopHolders({ contract: CONTRACT, limit: 100 });
    expect(res.fallback).toBe(true);
    expect(res.holders).toEqual([]);
    expect(res.totalOwners).toBe(0);
    expect(res.totalHeld).toBe(0);
  });

  it("constants ship no synthetic whale roster", async () => {
    const constants = await import("./constants");
    expect(constants.FALLBACK_WHALES).toBeUndefined();
  });
});
