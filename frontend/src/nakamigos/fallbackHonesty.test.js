import { describe, it, expect } from "vitest";
import { FALLBACK_WHALES, FALLBACK_ACTIVITY } from "./constants";

// Guards the honesty-pass fix (F540): fallback/demo data must not fabricate
// activity by real, named collectors with perpetually-fresh timestamps.

describe("fallback data honesty (F540)", () => {
  it("FALLBACK_WHALES uses synthetic, non-identifiable ENS handles", () => {
    const realNames = [
      "vitalik.eth",
      "pranksy.eth",
      "punk6529.eth",
      "dingaling.eth",
      "franklinisbored.eth",
    ];
    for (const w of FALLBACK_WHALES) {
      expect(realNames, `fallback whale "${w.ens}" names a real person`).not.toContain(w.ens);
      // Synthetic handles are obviously sample data.
      expect(w.ens).toMatch(/sample/i);
    }
  });

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
