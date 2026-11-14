// @vitest-environment node
// The bounded reader, when the body it is reading dies part-way: a dropped connection, or
// a deadline that fired mid-body (every proxy's clock stays armed through this read).
// Node, not jsdom. `reader.cancel()` on a stream that already errored answers with a
// REJECTED promise; a try/catch around it catches nothing, so the caller got its throw AND
// an unhandled rejection, which ends a Node process by default.
import { describe, it, expect } from "vitest";
import { readBoundedText } from "../_lib/bodycap.js";

const HALF = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,');

/** Runs `run`, then lets the event loop turn, and returns every rejection nobody handled. */
async function strayRejections(run) {
  const stray = [];
  const note = (e) => stray.push(e);
  process.on("unhandledRejection", note);
  try {
    await run();
    // An unhandled rejection is reported after the microtasks drain: wait two turns.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off("unhandledRejection", note);
  }
  return stray;
}

describe("readBoundedText: a body that dies part-way leaves nothing unhandled", () => {
  it("a body that errors mid-read: the read throws that error, once", async () => {
    const gaveUp = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    let fail;
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(HALF);
        fail = () => stream.error(gaveUp);
      },
    });
    let thrown = null;
    const stray = await strayRejections(async () => {
      const reading = readBoundedText(new Response(body, { status: 200 }), 5_000_000);
      setTimeout(fail, 5);
      try {
        await reading;
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown, "the caller still gets the error").toBe(gaveUp);
    expect(stray, "and nothing else escapes").toEqual([]);
  });

  it("over the cap, on a stream whose cancel fails: truncated is reported, the failure is not left unhandled", async () => {
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array(64));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    let got = null;
    const stray = await strayRejections(async () => {
      got = await readBoundedText(new Response(body, { status: 200 }), 16);
    });
    expect(got).toMatchObject({ text: "", truncated: true });
    expect(stray).toEqual([]);
  });

  it("a declared length over the cap, on a stream whose cancel fails: the same", async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error("cancel failed");
      },
    });
    let got = null;
    const stray = await strayRejections(async () => {
      got = await readBoundedText(new Response(body, { status: 200, headers: { "content-length": "999" } }), 16);
    });
    expect(got).toMatchObject({ text: "", truncated: true, bytes: 999 });
    expect(stray).toEqual([]);
  });
});
