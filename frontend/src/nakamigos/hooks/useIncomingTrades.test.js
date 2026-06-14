import { describe, it, expect } from "vitest";
import { countPendingIncoming } from "./useIncomingTrades";

const NOW = 1_700_000_000_000;
const future = (ms) => new Date(NOW + ms).toISOString();
const past = (ms) => new Date(NOW - ms).toISOString();

describe("countPendingIncoming", () => {
  it("returns 0 for non-array / empty input", () => {
    expect(countPendingIncoming(undefined, NOW)).toBe(0);
    expect(countPendingIncoming(null, NOW)).toBe(0);
    expect(countPendingIncoming([], NOW)).toBe(0);
  });

  it("counts active, unexpired offers", () => {
    const rows = [
      { status: "active", expires_at: future(3600_000) },
      { status: "active", expires_at: future(60_000) },
    ];
    expect(countPendingIncoming(rows, NOW)).toBe(2);
  });

  it("ignores non-active statuses", () => {
    const rows = [
      { status: "accepted", expires_at: future(3600_000) },
      { status: "declined", expires_at: future(3600_000) },
      { status: "cancelled", expires_at: future(3600_000) },
      { status: "countered", expires_at: future(3600_000) },
      { status: "active", expires_at: future(3600_000) },
    ];
    expect(countPendingIncoming(rows, NOW)).toBe(1);
  });

  it("excludes active rows whose expires_at has already passed", () => {
    const rows = [
      { status: "active", expires_at: past(1000) },        // just expired
      { status: "active", expires_at: future(3600_000) },  // still live
    ];
    expect(countPendingIncoming(rows, NOW)).toBe(1);
  });

  it("treats expiry exactly at now as expired (not counted)", () => {
    const rows = [{ status: "active", expires_at: new Date(NOW).toISOString() }];
    expect(countPendingIncoming(rows, NOW)).toBe(0);
  });

  it("counts active rows with no expires_at (no expiry to fail)", () => {
    const rows = [{ status: "active" }];
    expect(countPendingIncoming(rows, NOW)).toBe(1);
  });

  it("skips null/garbage rows without throwing", () => {
    const rows = [null, undefined, {}, { status: "active", expires_at: future(1000) }];
    expect(countPendingIncoming(rows, NOW)).toBe(1);
  });
});
