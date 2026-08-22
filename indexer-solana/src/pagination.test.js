import { describe, it, expect, vi } from "vitest";
import { collectNewSignatures, describeTruncation } from "./pagination.js";

const sig = (n) => ({ signature: `sig${n}`, slot: 1000 + n, blockTime: 1_700_000 + n, err: null });

/** Newest-first pages, the order the cluster returns them in. */
const pager = (pages) => {
  const calls = [];
  const fn = vi.fn(async (args) => {
    calls.push(args);
    return pages[calls.length - 1] ?? [];
  });
  fn.calls = calls;
  return fn;
};

describe("collectNewSignatures", () => {
  it("returns oldest-first, which is the order the cursor may advance over", async () => {
    const fetchPage = pager([[sig(3), sig(2), sig(1)]]);
    const out = await collectNewSignatures({ fetchPage, until: "sig0", pageLimit: 10, maxPages: 5 });
    expect(out.signatures.map((s) => s.signature)).toEqual(["sig1", "sig2", "sig3"]);
    expect(out.reachedUntil).toBe(true);
  });

  it("keeps paging while pages come back full, walking `before` backwards", async () => {
    const fetchPage = pager([
      [sig(6), sig(5)],
      [sig(4), sig(3)],
      [sig(2)],
    ]);
    const out = await collectNewSignatures({ fetchPage, until: "sig1", pageLimit: 2, maxPages: 5 });
    expect(out.pagesUsed).toBe(3);
    expect(out.reachedUntil).toBe(true);
    expect(out.signatures.map((s) => s.signature)).toEqual(["sig2", "sig3", "sig4", "sig5", "sig6"]);
    expect(fetchPage.calls[0]).toEqual({ limit: 2, until: "sig1" });
    expect(fetchPage.calls[1]).toEqual({ limit: 2, until: "sig1", before: "sig5" });
    expect(fetchPage.calls[2]).toEqual({ limit: 2, until: "sig1", before: "sig3" });
  });

  it("treats an empty first page as caught up", async () => {
    const fetchPage = pager([[]]);
    const out = await collectNewSignatures({ fetchPage, until: "sig9", pageLimit: 10, maxPages: 5 });
    expect(out.signatures).toEqual([]);
    expect(out.reachedUntil).toBe(true);
  });

  // THE BOUND. Without it a cursor that has fallen far behind pages forever
  // inside one tick — unbounded memory, no rows written, indistinguishable
  // from a hang.
  it("stops at maxPages and says it did not reach the resume point", async () => {
    const fetchPage = pager([[sig(9), sig(8)], [sig(7), sig(6)], [sig(5), sig(4)]]);
    const out = await collectNewSignatures({ fetchPage, until: "sig0", pageLimit: 2, maxPages: 2 });
    expect(out.pagesUsed).toBe(2);
    expect(out.reachedUntil).toBe(false);
    expect(out.signatures).toHaveLength(4);
  });
});

describe("describeTruncation", () => {
  it("describes nothing when the walk reached its resume point", () => {
    expect(
      describeTruncation({ reachedUntil: true, hadCursor: true, cursorSlot: 1, oldestFetchedSlot: 9, pagesUsed: 1 }),
    ).toBeNull();
  });

  it("names the unread span when a backlog was truncated", () => {
    const gap = describeTruncation({
      reachedUntil: false,
      hadCursor: true,
      cursorSlot: 500,
      oldestFetchedSlot: 900,
      pagesUsed: 20,
    });
    expect(gap.kind).toBe("backlog-truncated");
    expect(gap.fromSlot).toBe(500);
    expect(gap.toSlot).toBe(900);
    expect(gap.detail).toContain("never read");
  });

  // A cold start holds only as far back as one bounded walk reached. Calling
  // the rest "no earlier trades" is the fabricated zero this table exists to
  // prevent.
  it("records a cold start with no startSignature as unbackfilled history", () => {
    const gap = describeTruncation({
      reachedUntil: false,
      hadCursor: false,
      cursorSlot: null,
      oldestFetchedSlot: 4200,
      pagesUsed: 20,
    });
    expect(gap.kind).toBe("history-not-backfilled");
    expect(gap.detail).toContain("never requested");
  });
});
