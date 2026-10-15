import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { neverAnswered, stalledBody, watch } from "../../test/quietHost";

// A signed listing is sent to /api/orderbook with 30 s to be taken. Those 30 s cover every
// attempt and the reading of each answer: an orderbook that sends its headers and half a
// body has not answered, and the seller is told the submit timed out.
//
// The wallet is faked (ethers' BrowserProvider and Contract); the order, its hash and the
// request are built by the real code. Global `fetch` is the orderbook.

const WALLET = "0x" + "a".repeat(40);

vi.mock("../api", () => ({ getProvider: () => ({}) }));
// The bundle path is behind a flag that is off in production; on here so it runs.
vi.mock("../constants", async (importOriginal) => ({ ...(await importOriginal()), BUNDLE_LISTING_ENABLED: true }));
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class BrowserProvider {
    async getNetwork() { return { chainId: 1n }; }
    async getSigner() {
      return {
        getAddress: async () => WALLET,
        signTypedData: async () => "0x" + "1".repeat(130),
        signMessage: async () => "0x" + "2".repeat(130),
      };
    }
  }
  class Contract {
    async isApprovedForAll() { return true; }
    async getCounter() { return 0n; }
  }
  return { ...actual, ethers: { ...actual.ethers, BrowserProvider, Contract } };
});

// Imported statically so both are loaded before any clock is faked. orderbook.js imports
// ethers only when a listing is made, and its first load does not fit inside a test.
import "ethers";
import { createNativeListing, createNativeBundleListing } from "./orderbook";
import { CONTRACT } from "../constants";

const whole = (status, body) => () => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
const half = (status) => (signal) => Promise.resolve(stalledBody(signal, status));

const SUBMITS = [
  ["createNativeListing", () => createNativeListing({ contract: CONTRACT, tokenId: "1", priceEth: 0.1 }), "Order submission timed out"],
  [
    "createNativeBundleListing",
    () => createNativeBundleListing({ items: [{ contract: CONTRACT, tokenId: "1" }, { contract: CONTRACT, tokenId: "2" }], priceEth: 0.2 }),
    "Bundle submission timed out",
  ],
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(SUBMITS)("%s: the orderbook goes quiet", (_name, submit, timedOut) => {
  const TIMED_OUT = { error: "timeout", message: timedOut };

  /**
   * Plays `answers` in order, one per request (the last one repeats). Says how the submit
   * ended, how long after its first request (the wallet steps run first, off the fake
   * clock), and how many requests were made.
   */
  async function play(...answers) {
    const start = Date.now();
    const asked = [];
    vi.stubGlobal("fetch", (_url, init) => {
      asked.push(Date.now() - start);
      // As fetch does: a request on a spent signal is refused at once.
      if (init.signal.aborted) return neverAnswered(init.signal);
      return answers[Math.min(asked.length, answers.length) - 1](init.signal);
    });
    const ended = await watch(submit, 120_000, 250);
    return ended && { value: ended.value, afterFirstRequestMs: ended.afterMs - asked[0], requests: asked.length };
  }

  it("a 200 that stops part-way is given up after 30 s as a timeout, not as an invalid response", async () => {
    const ended = await play(half(200));
    expect(ended, "still pending after 120 s").not.toBeNull();
    expect(ended).toEqual({ value: TIMED_OUT, afterFirstRequestMs: 30_000, requests: 1 });
  });

  it("a 500 that stops part-way is given up after 30 s, and is not sent again", async () => {
    const ended = await play(half(500));
    expect(ended, "still pending after 120 s").not.toBeNull();
    expect(ended).toEqual({ value: TIMED_OUT, afterFirstRequestMs: 30_000, requests: 1 });
  });

  it("a 409 that stops part-way is a timeout: half a refusal names nothing to cancel", async () => {
    const ended = await play(half(409));
    expect(ended, "still pending after 120 s").not.toBeNull();
    expect(ended).toEqual({ value: TIMED_OUT, afterFirstRequestMs: 30_000, requests: 1 });
  });

  it("an orderbook that never answers is given up at 30 s, with no retry on the spent time", async () => {
    const ended = await play(neverAnswered);
    expect(ended).toEqual({ value: TIMED_OUT, afterFirstRequestMs: 30_000, requests: 1 });
  });

  it("the second attempt is on the same 30 s: a 500, then an answer that stops part-way", async () => {
    const ended = await play(whole(500, { error: "db down" }), half(200));
    expect(ended, "still pending after 120 s").not.toBeNull();
    expect(ended).toEqual({ value: TIMED_OUT, afterFirstRequestMs: 30_000, requests: 2 });
  });

  it("a 500 is still sent again, and the listing is made when the second attempt is taken", async () => {
    const ended = await play(whole(500, { error: "db down" }), whole(200, { orderHash: "0xhash" }));
    expect(ended).toEqual({ value: { success: true, orderHash: "0xhash" }, afterFirstRequestMs: 1_000, requests: 2 });
  });

  it("a whole 200 that is not JSON is still an invalid response", async () => {
    const ended = await play(whole(200, "<!doctype html>"));
    expect(ended).toEqual({
      value: { error: "post-failed", message: "Invalid response from orderbook" },
      afterFirstRequestMs: 0,
      requests: 1,
    });
  });

  it("a whole 409 still names the bundles in the way, and is not sent again", async () => {
    const ended = await play(whole(409, { error: "Already in a bundle", conflictingBundles: ["0xb1"] }));
    expect(ended).toEqual({
      value: { error: "conflict", message: "Already in a bundle", conflictingBundles: ["0xb1"] },
      afterFirstRequestMs: 0,
      requests: 1,
    });
  });
});
