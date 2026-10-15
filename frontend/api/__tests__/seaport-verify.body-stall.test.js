// @vitest-environment node
// What the order checks do when an RPC host sends a 200, its headers and half a body, then
// nothing. Node, not jsdom: Response, the streams and AbortSignal are the ones fetch uses.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Warms the module graph at collection time, as in seaport-verify.test.js.
import "../_lib/seaport-verify.js";

const OFFERER = "0x" + "a".repeat(40);
const SEAPORT = "0x00000000000000adc04c56bf30ac9d3c0aaf14dc";
const ALCHEMY = "eth-mainnet.g.alchemy.com";
const PUBLICNODE = "ethereum-rpc.publicnode.com";
const DRPC = "eth.drpc.org";
const JSON_HEADERS = { "content-type": "application/json" };

const PARAMETERS = {
  offerer: OFFERER,
  zone: "0x0000000000000000000000000000000000000000",
  offer: [{ itemType: "2", token: "0x" + "b".repeat(40), identifierOrCriteria: "42", startAmount: "1", endAmount: "1" }],
  consideration: [{ itemType: "0", token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "1000", endAmount: "1000", recipient: OFFERER }],
  orderType: "2",
  startTime: "1700000000",
  endTime: "1700086400",
  zoneHash: "0x" + "0".repeat(64),
  salt: "1",
  conduitKey: "0x" + "0".repeat(64),
};
const SIGNATURE = "0x" + "1".repeat(130);

/** A body that sends half an answer and then ends only by being aborted. */
function halfBody(signal) {
  return new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,'));
      signal?.addEventListener("abort", () => stream.error(new DOMException("The operation was aborted.", "AbortError")));
    },
  });
}

/**
 * The hosts in `stalled` send half a body. Every other host answers: Seaport's counter
 * is 5, and the contract that checks a signature says it is good.
 */
function network(stalled) {
  const asked = [];
  const start = Date.now();
  vi.stubGlobal("fetch", (input, init) => {
    const host = new URL(String(input)).host;
    const call = JSON.parse(String(init.body));
    const to = call.params?.[0]?.to?.toLowerCase();
    asked.push({ host, what: to === SEAPORT ? "counter" : "signature", atMs: Date.now() - start });
    if (stalled.includes(host)) return Promise.resolve(new Response(halfBody(init.signal), { status: 200, headers: JSON_HEADERS }));
    const result = to === SEAPORT ? "0x" + "5".padStart(64, "0") : "0x01";
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }), { status: 200, headers: JSON_HEADERS }));
  });
  return asked;
}

/** Runs `call` on the fake clock. Reports how it ended and when, or null if still pending after `watchMs`. */
async function watch(call, watchMs) {
  const start = Date.now();
  let ended = null;
  call().then(
    (value) => (ended = { afterMs: Date.now() - start, value }),
    (error) => (ended = { afterMs: Date.now() - start, error }),
  );
  // Small steps: a timer armed by a promise chain is only seen once the chain has run.
  while (ended === null && Date.now() - start < watchMs) await vi.advanceTimersByTimeAsync(50);
  return ended;
}

describe("seaport-verify: an RPC host that stops part-way through its answer is given up", () => {
  let originalKey;
  let verify;

  beforeEach(async () => {
    originalKey = process.env.ALCHEMY_API_KEY;
    process.env.ALCHEMY_API_KEY = "valid-key";
    vi.resetModules();
    verify = await import("../_lib/seaport-verify.js");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = originalKey;
  });

  it("the counter read leaves a half-answered host after 2.5 s and takes the next host's answer", async () => {
    const asked = network([ALCHEMY]);
    const ended = await watch(() => verify.fetchSeaportCounter(OFFERER), 60_000);
    expect(ended, "still pending after 60 s").not.toBeNull();
    expect(ended).toEqual({ afterMs: 2_500, value: 5n });
    expect(asked.map((a) => a.host)).toEqual([ALCHEMY, PUBLICNODE]);
  });

  it("the counter read fails once every host has been given its 2.5 s, as a failed read and not a revert", async () => {
    const asked = network([ALCHEMY, PUBLICNODE, DRPC]);
    const ended = await watch(() => verify.fetchSeaportCounter(OFFERER), 60_000);
    expect(ended, "still pending after 60 s").not.toBeNull();
    expect(ended.afterMs).toBe(7_500);
    expect(ended.error).toBeInstanceOf(Error);
    expect(ended.error.rpcError, "a cut-off answer is not the chain saying no").toBeUndefined();
    expect(asked.map((a) => a.host)).toEqual([ALCHEMY, PUBLICNODE, DRPC]);
  });

  it("the signature check leaves a half-answered host after viem's 10 s and passes on the next host's answer", async () => {
    const asked = network([ALCHEMY]);
    const ended = await watch(() => verify.verifySeaportSignature({ parameters: PARAMETERS, signature: SIGNATURE }), 300_000);
    expect(ended, "still pending after 300 s").not.toBeNull();
    expect(ended.value).toEqual({ ok: true });
    // 2.5 s for the counter, then viem's 10 s for the signature call.
    expect(ended.afterMs).toBe(12_500);
    expect(asked.filter((a) => a.what === "signature").map((a) => a.host)).toEqual([ALCHEMY, PUBLICNODE]);
  });
});
