// The birth socket relay. Every test here corresponds to one of the four "hard facts"
// on the island's config card, which are described as TESTED BEHAVIOUR IN THE LIVE
// SOCKET — so getting them wrong fails against a real server, not a mock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  handleBirths,
  validateBirthBody,
  canonicalBirthBytes,
  signBirthBytes,
  hexEquals,
} from "../_lib/births.js";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const SECRET = "test-secret-not-the-real-one";

const VALID = {
  ca: "0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca",
  chain: "base",
  creator: "0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a",
  birth_block: 123456789,
  gate_decision_id: "gd_abc123",
  record_url: "https://memetic.fun/record/base/0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca.json",
};

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

const reqWith = (body, method = "POST") => ({ method, headers: { origin: "https://memetic.fun" }, query: {}, body });

beforeEach(() => {
  process.env.MEMETICS_BIRTH_SECRET = SECRET;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEMETICS_BIRTH_SECRET;
});

describe("fact 1 — six keys, strict", () => {
  it("accepts exactly the six", () => {
    expect(validateBirthBody(VALID)).toBeNull();
  });

  it("NAMES a seventh field rather than dropping it silently", () => {
    const v = validateBirthBody({ ...VALID, extra: "nope" });
    expect(v.field).toBe("extra");
    expect(v.error).toMatch(/Unexpected field: extra/);
  });

  it("names a MISSING field", () => {
    const { record_url, ...missing } = VALID;
    expect(record_url).toBeTruthy();
    expect(validateBirthBody(missing)).toMatchObject({ field: "record_url" });
  });

  it("rejects a chain the socket does not know", () => {
    expect(validateBirthBody({ ...VALID, chain: "polygon" })).toMatchObject({ field: "chain" });
  });

  it("rejects a hex address on the solana rail, and base58 on an EVM rail", () => {
    expect(validateBirthBody({ ...VALID, chain: "solana" })).toMatchObject({ field: "ca" });
    expect(
      validateBirthBody({ ...VALID, ca: "So11111111111111111111111111111111111111112" }),
    ).toMatchObject({ field: "ca" });
  });

  it("birth_block must be a real integer — chain truth, never approximated", () => {
    expect(validateBirthBody({ ...VALID, birth_block: "123" })).toMatchObject({ field: "birth_block" });
    expect(validateBirthBody({ ...VALID, birth_block: 1.5 })).toMatchObject({ field: "birth_block" });
    expect(validateBirthBody({ ...VALID, birth_block: -1 })).toMatchObject({ field: "birth_block" });
  });

  it("record_url must be https — the island fetches it", () => {
    expect(validateBirthBody({ ...VALID, record_url: "http://insecure/x.json" })).toMatchObject({
      field: "record_url",
    });
  });

  it("gate_decision_id may not be empty — it is what ties a birth to its gate row", () => {
    expect(validateBirthBody({ ...VALID, gate_decision_id: "" })).toMatchObject({
      field: "gate_decision_id",
    });
  });

  it("sends ONLY the six, in a fixed order, whatever the caller's key order was", () => {
    const shuffled = {
      record_url: VALID.record_url,
      chain: VALID.chain,
      ca: VALID.ca,
      gate_decision_id: VALID.gate_decision_id,
      creator: VALID.creator,
      birth_block: VALID.birth_block,
    };
    expect(canonicalBirthBytes(shuffled).toString("utf8")).toBe(canonicalBirthBytes(VALID).toString("utf8"));
    expect(Object.keys(JSON.parse(canonicalBirthBytes(shuffled).toString("utf8")))).toEqual([
      "ca",
      "chain",
      "creator",
      "birth_block",
      "gate_decision_id",
      "record_url",
    ]);
  });
});

describe("fact 2 — sign the EXACT wire bytes", () => {
  it("the signature is over the same bytes that leave the socket", async () => {
    let sentBody = null;
    let sentSig = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        sentBody = init.body;
        sentSig = init.headers["X-Venue-Signature"];
        return { status: 202, headers: new Map(), body: null, text: async () => JSON.stringify({ status: "enrolled", enrollment_id: 7 }) };
      }),
    );

    const res = mockRes();
    await handleBirths(reqWith(VALID), res);

    // THE test: recompute the HMAC over the bytes that were actually sent.
    expect(Buffer.isBuffer(sentBody)).toBe(true);
    const recomputed = createHmac("sha256", SECRET).update(sentBody).digest("hex");
    expect(sentSig).toBe(recomputed);
  });

  it("is bare lowercase hex, 64 chars, no prefix", () => {
    const sig = signBirthBytes(SECRET, canonicalBirthBytes(VALID));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.startsWith("0x")).toBe(false);
  });

  it("a different body is a different signature", () => {
    const a = signBirthBytes(SECRET, canonicalBirthBytes(VALID));
    const b = signBirthBytes(SECRET, canonicalBirthBytes({ ...VALID, birth_block: 999 }));
    expect(a).not.toBe(b);
  });

  it("a re-serialised body would have broken it — the bytes are passed through, not the object", async () => {
    let sentBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u, init) => {
        sentBody = init.body;
        return { status: 202, text: async () => "{}" };
      }),
    );
    await handleBirths(reqWith(VALID), mockRes());
    // A plain object here would let fetch/undici choose its own serialisation between
    // signing and sending, which is exactly the failure the card warns about. A Buffer
    // cannot be re-serialised — the bytes are already fixed.
    expect(Buffer.isBuffer(sentBody)).toBe(true);
    expect(sentBody.equals(canonicalBirthBytes(VALID))).toBe(true);
  });
});

describe("fact 3 — retries are free, forever", () => {
  it("202 enrolled is success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 202, text: async () => JSON.stringify({ status: "enrolled", enrollment_id: 12 }) })));
    const res = mockRes();
    await handleBirths(reqWith(VALID), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "enrolled", enrollment_id: 12, replay: false });
  });

  it("200 already_enrolled is ALSO success, flagged as a replay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ status: "already_enrolled", enrollment_id: 12 }) })));
    const res = mockRes();
    await handleBirths(reqWith(VALID), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "already_enrolled", enrollment_id: 12, replay: true });
  });
});

describe("failure handling — retryable vs not", () => {
  it("a 401 from the island is NOT retryable — a rotated secret needs a human", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, text: async () => JSON.stringify({ code: "invalid_signature" }) })));
    const res = mockRes();
    await handleBirths(reqWith(VALID), res);
    expect(res.statusCode).toBe(422);
    expect(res.body.retryable).toBe(false);
  });

  it("a 400 from the island is NOT retryable, and carries the field it named", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 400, text: async () => JSON.stringify({ error: "bad ca", code: "invalid", field: "ca" }) })));
    const res = mockRes();
    await handleBirths(reqWith(VALID), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ field: "ca", retryable: false });
  });

  it("an unreachable socket IS retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNRESET");
    }));
    const res = mockRes();
    await handleBirths(reqWith(VALID), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.retryable).toBe(true);
  });

  it("a 500 from the island IS retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, text: async () => "{}" })));
    const res = mockRes();
    await handleBirths(reqWith(VALID), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.retryable).toBe(true);
  });

  it("an unconfigured secret is a 503 that says so — never a fake success", async () => {
    delete process.env.MEMETICS_BIRTH_SECRET;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = mockRes();
    await handleBirths(reqWith(VALID), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("no_secret");
    // And it never spent one of the island's shared rate-limit slots.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a malformed body never reaches the island", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = mockRes();
    await handleBirths(reqWith({ ...VALID, extra: 1 }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.field).toBe("extra");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-POST", async () => {
    const res = mockRes();
    await handleBirths(reqWith(VALID, "GET"), res);
    expect(res.statusCode).toBe(405);
  });
});

describe("hexEquals", () => {
  it("compares equal-length hex without leaking length by early return", () => {
    const a = signBirthBytes(SECRET, canonicalBirthBytes(VALID));
    expect(hexEquals(a, a)).toBe(true);
    expect(hexEquals(a, a.replace(/.$/, (c) => (c === "0" ? "1" : "0")))).toBe(false);
    expect(hexEquals(a, "abc")).toBe(false);
  });
});
