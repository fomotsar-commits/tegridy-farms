// Failure classification is the whole job here: the command layer branches on
// `reason`, so a failure sorted into the wrong bucket becomes a sentence that says
// the wrong thing about somebody's wallet.
//
// The cross-repo half — that this file's signing string matches the verifier in
// frontend/api/_lib/botLink.js — is pinned by
// frontend/api/__tests__/bot-noncustodial.test.js, which can import BOTH sides
// (this module needs only node:crypto; the API module needs frontend's
// node_modules, which is not on this project's resolution path).

import { describe, it, expect, vi } from "vitest";
import { beginLink, readHeat, readLink, revokeLink, signBotRequest, VENUE_FAIL } from "./venueClient.js";

const cfg = {
  linkSecret: "shared-secret",
  venueOrigin: "https://memetic.fun",
  appOrigin: "https://memetic.fun",
};

const CHAT_REF = "a".repeat(64);

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: async () => JSON.stringify(body),
  };
}

describe("the signed call", () => {
  it("signs the exact bytes it sends, with the timestamp inside the signature", () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { code: "ABCDEFGHJK", expiresAt: "2026-01-01T00:00:00Z" }));
    return beginLink(cfg, CHAT_REF, { fetchImpl, now: () => 1_700_000_000_000 }).then(() => {
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://memetic.fun/api/aggregator?resource=bot-link");
      expect(init.headers["X-Bot-Timestamp"]).toBe("1700000000");
      // Signed over the SAME string that is sent — not a re-serialisation of it.
      expect(init.headers["X-Bot-Signature"]).toBe(
        signBotRequest(cfg.linkSecret, "1700000000", init.body),
      );
      expect(JSON.parse(init.body)).toEqual({ action: "begin", chatRef: CHAT_REF });
    });
  });

  it("makes no request at all without a secret, rather than signing with nothing", () => {
    const fetchImpl = vi.fn();
    return callAndExpect(beginLink({ ...cfg, linkSecret: null }, CHAT_REF, { fetchImpl }), VENUE_FAIL.NOT_READY).then(
      () => expect(fetchImpl).not.toHaveBeenCalled(),
    );
  });
});

async function callAndExpect(promise, reason) {
  const result = await promise;
  expect(result.ok).toBe(false);
  expect(result.reason).toBe(reason);
  return result;
}

describe("failures land in the right bucket", () => {
  it("a network error is unreachable", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await callAndExpect(readLink(cfg, CHAT_REF, { fetchImpl }), VENUE_FAIL.UNREACHABLE);
  });

  it("a 500 is unreachable", async () => {
    const fetchImpl = async () => jsonResponse(500, {});
    await callAndExpect(readLink(cfg, CHAT_REF, { fetchImpl }), VENUE_FAIL.UNREACHABLE);
  });

  it("a missing migration is NOT-READY and carries the operator's step", async () => {
    // The distinction the whole feature rests on. `schema-missing` must never
    // reach the user as "your chat is not linked".
    const fetchImpl = async () =>
      jsonResponse(503, { error: "table missing", code: "schema-missing", operatorStep: "apply 020" });
    const result = await callAndExpect(readLink(cfg, CHAT_REF, { fetchImpl }), VENUE_FAIL.NOT_READY);
    expect(result.operatorStep).toBe("apply 020");
  });

  it("a 401 is a rejection, not an outage", async () => {
    const fetchImpl = async () => jsonResponse(401, { error: "Bot request not authenticated", code: "bad-signature" });
    const result = await callAndExpect(revokeLink(cfg, CHAT_REF, { fetchImpl }), VENUE_FAIL.REJECTED);
    expect(result.code).toBe("bad-signature");
  });

  it("a 409 already-linked carries the wallet forward so the reply can name it", async () => {
    const fetchImpl = async () =>
      jsonResponse(409, { error: "already", code: "already-linked", wallet: `0x${"1".repeat(40)}` });
    const result = await callAndExpect(beginLink(cfg, CHAT_REF, { fetchImpl }), VENUE_FAIL.REJECTED);
    expect(result.code).toBe("already-linked");
    expect(result.wallet).toBe(`0x${"1".repeat(40)}`);
  });

  it("a 200 with an unreadable body is malformed, never an empty success", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, body: null, text: async () => "<html>" });
    await callAndExpect(readLink(cfg, CHAT_REF, { fetchImpl }), VENUE_FAIL.MALFORMED);
  });

  it("a real answer comes back intact", async () => {
    const fetchImpl = async () => jsonResponse(200, { linked: true, wallet: `0x${"2".repeat(40)}` });
    const result = await readLink(cfg, CHAT_REF, { fetchImpl });
    expect(result).toEqual({ ok: true, data: { linked: true, wallet: `0x${"2".repeat(40)}` } });
  });
});

describe("heat", () => {
  it("reports an outage as an outage and never as a reading", async () => {
    const fetchImpl = async () => jsonResponse(502, { error: "Heat oracle unavailable" });
    const result = await callAndExpect(readHeat(cfg, `0x${"3".repeat(40)}`, { fetchImpl }), VENUE_FAIL.UNREACHABLE);
    // A user must not read an unavailable oracle as a cold wallet.
    expect(result.detail).toMatch(/not a reading of zero/i);
  });

  it("refuses a 200 that carries no degrees rather than rendering undefined", async () => {
    const fetchImpl = async () => jsonResponse(200, { tier: "warm" });
    await callAndExpect(readHeat(cfg, `0x${"3".repeat(40)}`, { fetchImpl }), VENUE_FAIL.MALFORMED);
  });

  it("passes a real reading through unchanged", async () => {
    const fetchImpl = async () => jsonResponse(200, { degrees: 412, tier: "molten", as_of_unix: 1_760_000_000 });
    const result = await readHeat(cfg, `0x${"3".repeat(40)}`, { fetchImpl });
    expect(result.ok).toBe(true);
    // Forwarded, not recomputed — the island's measurement is the island's.
    expect(result.data.degrees).toBe(412);
  });
});
