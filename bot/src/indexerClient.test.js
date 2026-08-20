// The gate: an unhosted or still-syncing indexer must never produce a zero.

import { describe, it, expect, vi } from "vitest";
import { INDEXER_UNAVAILABLE, parseMeta, recentSwaps, SWAPS_QUERY } from "./indexerClient.js";

const WALLET = `0x${"a".repeat(40)}`;
const configured = { indexerUrl: "https://idx.example.com", indexerUrlRaw: "https://idx.example.com" };

function gql(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const readyMeta = { _meta: { status: { mainnet: { ready: true, block: { number: 25_300_000, timestamp: 1 } } } } };

describe("the absence of a URL is the flag", () => {
  it("asks nothing and says the venue hosts no indexer", async () => {
    const fetchImpl = vi.fn();
    const result = await recentSwaps({ indexerUrl: null, indexerUrlRaw: null }, WALLET, 5, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(INDEXER_UNAVAILABLE.NOT_CONFIGURED);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The sentence that must be there. "Nothing here says your history is empty."
    expect(result.detail).toMatch(/nothing here says your history is empty/i);
  });

  it("separates a typo'd URL from an absent one", async () => {
    const result = await recentSwaps({ indexerUrl: null, indexerUrlRaw: "wat" }, WALLET, 5, { fetchImpl: vi.fn() });
    expect(result.detail).toMatch(/not a valid http/i);
  });
});

describe("a reachable indexer that is still backfilling is not an answer", () => {
  it("reports backfilling rather than the short page it was handed", async () => {
    // THE failure this gate exists for: 200, well-formed, zero rows, and the
    // wallet in question has traded plenty — the rows are simply not indexed yet.
    const fetchImpl = async () =>
      gql(200, {
        data: {
          swaps: { items: [], pageInfo: { hasNextPage: false } },
          _meta: { status: { mainnet: { ready: false, block: { number: 25_270_000, timestamp: 1 } } } },
        },
      });
    const result = await recentSwaps(configured, WALLET, 5, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(INDEXER_UNAVAILABLE.BACKFILLING);
  });

  it("treats a missing _meta as not-ready, never as fine", async () => {
    const fetchImpl = async () => gql(200, { data: { swaps: { items: [], pageInfo: {} } } });
    const result = await recentSwaps(configured, WALLET, 5, { fetchImpl });
    expect(result.reason).toBe(INDEXER_UNAVAILABLE.BACKFILLING);
  });

  it("is not-ready when ANY chain is behind, not when all are", async () => {
    expect(
      parseMeta({
        _meta: { status: { a: { ready: true, block: { number: 10, timestamp: 1 } }, b: { ready: false } } },
      }).ready,
    ).toBe(false);
  });

  it("drops the synced block when one chain reports none, rather than overstating coverage", () => {
    const meta = parseMeta({
      _meta: { status: { a: { ready: true, block: { number: 10, timestamp: 1 } }, b: { ready: true } } },
    });
    expect(meta.ready).toBe(true);
    expect(meta.syncedBlock).toBeNull();
  });
});

describe("transport failures", () => {
  it("a thrown fetch is unreachable", async () => {
    const fetchImpl = async () => {
      throw new Error("ETIMEDOUT");
    };
    expect((await recentSwaps(configured, WALLET, 5, { fetchImpl })).reason).toBe(INDEXER_UNAVAILABLE.UNREACHABLE);
  });

  it("a proxy 429 is unreachable, not an empty result", async () => {
    const fetchImpl = async () => gql(429, {});
    expect((await recentSwaps(configured, WALLET, 5, { fetchImpl })).reason).toBe(INDEXER_UNAVAILABLE.UNREACHABLE);
  });

  it("GraphQL errors are a rejection", async () => {
    const fetchImpl = async () => gql(200, { errors: [{ message: "nope" }], data: null });
    expect((await recentSwaps(configured, WALLET, 5, { fetchImpl })).reason).toBe(INDEXER_UNAVAILABLE.REJECTED);
  });

  it("a non-JSON 200 is malformed", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    expect((await recentSwaps(configured, WALLET, 5, { fetchImpl })).reason).toBe(INDEXER_UNAVAILABLE.MALFORMED);
  });
});

describe("a ready answer", () => {
  it("returns exactly the rows it was given and the block it was told", async () => {
    const items = [{ id: "1", tokenIn: `0x${"1".repeat(40)}`, tokenOut: `0x${"2".repeat(40)}`, timestamp: "1760000000" }];
    const fetchImpl = async () => gql(200, { data: { swaps: { items, pageInfo: {} }, ...readyMeta } });
    const result = await recentSwaps(configured, WALLET, 5, { fetchImpl });
    expect(result).toEqual({ ok: true, items, syncedBlock: 25_300_000 });
  });

  it("an empty READY page is a real answer and is allowed through", async () => {
    const fetchImpl = async () => gql(200, { data: { swaps: { items: [], pageInfo: {} }, ...readyMeta } });
    const result = await recentSwaps(configured, WALLET, 5, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
  });

  it("lowercases the wallet filter, because a casing detail must not read as 'never traded'", async () => {
    const fetchImpl = vi.fn(async () => gql(200, { data: { swaps: { items: [], pageInfo: {} }, ...readyMeta } }));
    await recentSwaps(configured, `0x${"A".repeat(40)}`, 5, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).variables.where.user).toBe(WALLET);
  });

  it("clamps the page size", async () => {
    const fetchImpl = vi.fn(async () => gql(200, { data: { swaps: { items: [], pageInfo: {} }, ...readyMeta } }));
    await recentSwaps(configured, WALLET, 99_999, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).variables.limit).toBe(100);
  });
});

describe("the document is the frontend's document", () => {
  it("asks for _meta in the same round trip", () => {
    // Without this selection there is no ready flag, and every branch above that
    // depends on one silently becomes "not ready" forever.
    expect(SWAPS_QUERY).toContain("_meta { status }");
  });
});
