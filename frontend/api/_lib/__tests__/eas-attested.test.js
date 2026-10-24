// eas-attested (?resource=eas-attested): one token's EAS attestations under the disclosure schema,
// from keyless Blockscout only, strict input, and a failed read that is a 5xx, never `[]`.
// Mock and req/res conventions mirror evm-birth.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toEventSelector } from "viem";
import {
  EAS_ATTESTED_EVENT,
  EAS_MAINNET,
  EAS_MAINNET_FIRST_BLOCK,
  factSheetSchemaUid,
} from "../../../src/lib/launcher/attestation";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

// A real attestation under the disclosure schema, as eth.blockscout.com returned it 2026-10-14.
const TOKEN = "0xfb5d11f4485361c19917118fc27fd5d44f8a4601";
const UID = "0x250c9f1702e44513ef2a541dd795904348185e716a67d26f56e8e1bae14746ff";
const ATTESTER = "0x64291eebc576c331ed6e8890af176c079b9f5c7e";
const SCHEMA = "0x0e4570dbb466fb8990c1ef51fce3f1c1877b3f2d49d9e02efceb18f01b3ab3b9";
const OTHER_SCHEMA = "0xa644034a40c9ed8025a75bca841f8d8a85a12a0297f89b1829a23de6f41006cc";
const OTHER = "0x3069160fa5623fd49f4a2a1b3366348a2e876717";
const pad = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();

let mod;
let fetchMock;
let consoleErrorSpy;

function makeReq({ method = "GET", query = {}, headers = {} } = {}) {
  return { method, query, headers: { origin: "https://memetics.finance", ...headers } };
}
function makeRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  r.end = vi.fn(() => r);
  return r;
}
const answer = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get: () => null },
  body: null,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});
const attestedLog = ({ recipient = TOKEN, schema = SCHEMA, uid = UID, block = 0x18883c2, logIndex = "0x3d3", address = EAS_MAINNET } = {}) => ({
  address: address.toLowerCase(),
  blockNumber: "0x" + block.toString(16),
  data: uid,
  logIndex,
  timeStamp: "0x6a79a077",
  topics: [mod.ATTESTED_TOPIC0, pad(recipient), pad(ATTESTER), schema],
  transactionHash: "0x8b53091ab4c01f6334426861f62124bb98dfc7fb36834af980091f273793e681",
});
const ok = (result) => answer({ message: "OK", result, status: "1" });
const noLogs = () => answer({ message: "No logs found", result: [], status: "0" });

async function call(query, reqOpts = {}) {
  const res = makeRes();
  await mod.handleEasAttested(makeReq({ query, ...reqOpts }), res);
  return res;
}
const QUERY = { recipient: TOKEN, schema: SCHEMA };

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn(async () => noLogs());
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mod = await import("../eas-attested.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleErrorSpy.mockRestore();
});

describe("eas-attested: the constants are the ones the browser decodes with", () => {
  it("Attested's topic, the EAS address, its first block and the schema match attestation.ts", () => {
    expect(mod.ATTESTED_TOPIC0).toBe(toEventSelector(EAS_ATTESTED_EVENT));
    expect(mod.EAS_MAINNET).toBe(EAS_MAINNET.toLowerCase());
    expect(mod.EAS_FROM_BLOCK).toBe(Number(EAS_MAINNET_FIRST_BLOCK));
    expect(mod.FACT_SHEET_SCHEMA_UID).toBe(factSheetSchemaUid());
  });
});

describe("eas-attested: the whole history, from keyless eth.blockscout.com", () => {
  it("returns the token's attestation, asking for this recipient AND this schema", async () => {
    fetchMock.mockResolvedValueOnce(ok([attestedLog()]));
    const res = await call(QUERY);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ attestations: [{ uid: UID, attester: ATTESTER, block: 0x18883c2 }] });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe("eth.blockscout.com");
    expect(url.searchParams.get("address")).toBe(mod.EAS_MAINNET);
    expect(url.searchParams.get("topic0")).toBe(mod.ATTESTED_TOPIC0);
    expect(url.searchParams.get("topic1")).toBe(pad(TOKEN));
    expect(url.searchParams.get("topic3")).toBe(SCHEMA);
    for (const pair of ["topic0_1_opr", "topic0_3_opr", "topic1_3_opr"]) expect(url.searchParams.get(pair)).toBe("and");
    expect(url.searchParams.get("fromBlock")).toBe("16756728");
    expect(url.searchParams.get("toBlock")).toBe("latest");
    expect(/s-maxage=(\d+)/.exec(res.headers["Cache-Control"])?.[1]).toBe("300");
  });

  it("answers [] when Blockscout read the history and found none, cached briefly", async () => {
    const res = await call(QUERY);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ attestations: [] });
    expect(Number(/s-maxage=(\d+)/.exec(res.headers["Cache-Control"])?.[1])).toBeLessThanOrEqual(30);
  });

  it("drops a log under another schema, about another token or from another contract", async () => {
    fetchMock.mockResolvedValueOnce(
      ok([attestedLog({ schema: OTHER_SCHEMA }), attestedLog({ recipient: OTHER }), attestedLog({ address: OTHER })]),
    );
    expect((await call(QUERY)).body).toEqual({ attestations: [] });
  });

  it("lists them oldest first, by block and then by place in the block", async () => {
    const a = "0x" + "a1".repeat(32);
    const b = "0x" + "b2".repeat(32);
    const c = "0x" + "c3".repeat(32);
    fetchMock.mockResolvedValueOnce(
      ok([attestedLog({ uid: c, block: 200 }), attestedLog({ uid: b, block: 100, logIndex: "0x9" }), attestedLog({ uid: a, block: 100, logIndex: "0x2" })]),
    );
    expect((await call(QUERY)).body.attestations.map((x) => x.uid)).toEqual([a, b, c]);
  });
});

describe("eas-attested: a read that did not complete is a 502, never an empty list", () => {
  const FAILURES = [
    ["an upstream HTTP error", () => answer("", { ok: false, status: 503 })],
    ["a refusal Blockscout writes where the list belongs", () => answer({ message: "NOTOK", result: "Max rate limit reached", status: "0" })],
    ["a body that is not JSON", () => answer("<html>busy</html>")],
    ["a full page, so not every log was seen", () => ok(Array.from({ length: 1000 }, () => attestedLog()))],
    ["a matching log whose uid does not decode", () => ok([{ ...attestedLog(), data: "0x" }])],
    ["a matching log that does not say where it sits", () => ok([{ ...attestedLog(), blockNumber: "soon" }])],
  ];
  for (const [label, reply] of FAILURES) {
    it(label, async () => {
      fetchMock.mockResolvedValueOnce(reply());
      const res = await call(QUERY);
      expect(res.statusCode).toBe(502);
      expect(res.body.attestations).toBeUndefined();
      expect(res.headers["Cache-Control"]).toBeUndefined();
    });
  }
});

describe("eas-attested: strict input, refused before any network call", () => {
  const BAD = [
    ["no recipient", { schema: SCHEMA }],
    ["a short recipient", { recipient: "0xdeadbeef", schema: SCHEMA }],
    ["a recipient that is a URL", { recipient: "https://evil.example/x", schema: SCHEMA }],
    ["two recipients", { recipient: [TOKEN, TOKEN], schema: SCHEMA }],
    ["no schema", { recipient: TOKEN }],
    ["any other schema", { recipient: TOKEN, schema: OTHER_SCHEMA }],
  ];
  for (const [label, query] of BAD) {
    it(`refuses ${label}`, async () => {
      const res = await call(query);
      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("refuses a foreign origin in production and a POST, and answers a preflight", async () => {
    const saved = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      expect((await call(QUERY, { headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
      expect((await call(QUERY, { method: "POST" })).statusCode).toBe(405);
      expect((await call({}, { method: "OPTIONS" })).statusCode).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved;
    }
  });

  for (const [limiter, status] of [["checkRateLimit", 429], ["checkGlobalLimit", 503]]) {
    it(`${limiter} refusing is a ${status}, under its own identifier, and nothing is fetched`, async () => {
      const rl = await import("../ratelimit.js");
      rl[limiter].mockImplementationOnce(async (...args) => {
        args.find((a) => typeof a?.status === "function").status(status).json({ error: "limited" });
        return false;
      });
      const res = await call(QUERY);
      expect(res.statusCode).toBe(status);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(rl[limiter]).toHaveBeenCalledWith(...(limiter === "checkRateLimit" ? [expect.anything()] : []), expect.anything(), expect.objectContaining({ identifier: "eas-attested" }));
    });
  }
});

describe("routing: the resource costs no function of its own", () => {
  it("dispatches behind a lazy import, ABOVE const provider", () => {
    const src = readFileSync(join(process.cwd(), "api/aggregator.js"), "utf8");
    const branch = src.indexOf('req.query.resource === "eas-attested"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(src.indexOf("const provider = req.query.provider"));
    expect(src).toContain('await import("./_lib/eas-attested.js")');
  });
});
