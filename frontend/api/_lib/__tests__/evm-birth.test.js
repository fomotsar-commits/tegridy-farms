// evm-birth (?resource=curve-birth, ?resource=doppler-birth): one launch's birth transaction,
// from fixed hosts only, strict input, and a failed read that is a 5xx, never `{ tx: null }`.
// Mock and req/res conventions mirror pool-market.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toEventSelector } from "viem";
import { dopplerERC20V1Abi } from "@whetstone-research/doppler-sdk/evm";
import { CURVE_LAUNCHER_ABI } from "../../../src/lib/launcher/curve";
import { contractOn } from "../../../src/lib/chains/registry";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const TOKEN = "0x10422E419fE9858F9da77D2F30FECFBb4482e790";
const OTHER_TOKEN = "0x00000000000000000000000000000000000000aa";
const TX = "0x730b0c9f5f1c272b054f132459d81802950f04b74f7f8342718885c71134b250";
const TX2 = "0x59dca1e473545400919939870ef08f234dc3f63488ff54b7a8ea5b8c59c0ab98";
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
/** A log as Blockscout's getLogs writes it: lowercase, hex numbers, null-padded topics. */
const bsLog = (address, topics, tx = TX, block = 0x17e102c) => ({
  address: address.toLowerCase(),
  blockNumber: "0x" + block.toString(16),
  data: "0x",
  logIndex: "0x1",
  topics: [...topics, ...Array(4 - topics.length).fill(null)],
  transactionHash: tx,
});
const ok = (result) => answer({ message: "OK", result, status: "1" });
const noLogs = () => answer({ message: "No logs found", result: [], status: "0" });

async function call(handler, query, reqOpts = {}) {
  const res = makeRes();
  await mod[handler](makeReq({ query, ...reqOpts }), res);
  return res;
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn(async () => noLogs());
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mod = await import("../evm-birth.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleErrorSpy.mockRestore();
});

describe("evm-birth: the constants are the chain's", () => {
  it("LaunchCreated's topic is the one curve.ts decodes with", () => {
    const ev = CURVE_LAUNCHER_ABI.find((x) => x.type === "event" && x.name === "LaunchCreated");
    expect(mod.LAUNCH_CREATED_TOPIC0).toBe(toEventSelector(ev));
  });

  it("VestingAllocated's topic is the one the Doppler SDK's DopplerERC20V1 ABI derives", () => {
    const ev = dopplerERC20V1Abi.find((x) => x.type === "event" && x.name === "VestingAllocated");
    expect(mod.VESTING_ALLOCATED_TOPIC0).toBe(toEventSelector(ev));
  });

  it("each chain's launcher is the one the site trades through", () => {
    for (const id of [1, 8453, 4663]) {
      const c = contractOn(id, "curveLauncher");
      expect(c.status).toBe("deployed");
      expect(mod.CURVE_CHAINS[id].launcher).toBe(c.address.toLowerCase());
    }
  });
});

describe("curve-birth: Ethereum and Base read keyless Blockscout", () => {
  for (const [chain, host] of [["1", "eth.blockscout.com"], ["8453", "base.blockscout.com"]]) {
    it(`chain ${chain}: finds the LaunchCreated log for this token on ${host}`, async () => {
      const c = mod.CURVE_CHAINS[chain];
      fetchMock.mockResolvedValueOnce(ok([bsLog(c.launcher, [mod.LAUNCH_CREATED_TOPIC0, pad(TOKEN), pad(OTHER_TOKEN)])]));
      const res = await call("handleCurveBirth", { chain, token: TOKEN });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ tx: TX, block: 0x17e102c });
      const url = new URL(fetchMock.mock.calls[0][0]);
      expect(url.host).toBe(host);
      expect(url.searchParams.get("address")).toBe(c.launcher);
      expect(url.searchParams.get("topic0")).toBe(mod.LAUNCH_CREATED_TOPIC0);
      expect(url.searchParams.get("topic1")).toBe(pad(TOKEN));
      expect(url.searchParams.get("topic0_1_opr")).toBe("and");
      expect(url.searchParams.get("fromBlock")).toBe(String(c.fromBlock));
      expect(/s-maxage=(\d+)/.exec(res.headers["Cache-Control"])?.[1]).toBe("300");
    });
  }

  it("answers { tx: null } when Blockscout read the history and found none, cached briefly", async () => {
    const res = await call("handleCurveBirth", { chain: "1", token: TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ tx: null, block: null });
    expect(Number(/s-maxage=(\d+)/.exec(res.headers["Cache-Control"])?.[1])).toBeLessThanOrEqual(30);
  });

  it("ignores a log about another token or from another address", async () => {
    const c = mod.CURVE_CHAINS["1"];
    fetchMock.mockResolvedValueOnce(
      ok([
        bsLog(c.launcher, [mod.LAUNCH_CREATED_TOPIC0, pad(OTHER_TOKEN)]),
        bsLog(OTHER_TOKEN, [mod.LAUNCH_CREATED_TOPIC0, pad(TOKEN)]),
      ]),
    );
    const res = await call("handleCurveBirth", { chain: "1", token: TOKEN });
    expect(res.body).toEqual({ tx: null, block: null });
  });
});

describe("curve-birth: Robinhood reads its RPC in windows it accepts", () => {
  const HEAD = 78_104_297;
  function robinhood({ hit = null, fail = null } = {}) {
    return vi.fn(async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (fail === method) return answer({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "nope" } });
      if (method === "eth_blockNumber") return answer({ jsonrpc: "2.0", id: 1, result: "0x" + HEAD.toString(16) });
      const [f] = params;
      const from = Number(f.fromBlock);
      const to = Number(f.toBlock);
      const logs = hit !== null && hit >= from && hit <= to
        ? [bsLog(mod.CURVE_CHAINS["4663"].launcher, [mod.LAUNCH_CREATED_TOPIC0, pad(TOKEN)], TX, hit)]
        : [];
      return answer({ jsonrpc: "2.0", id: 1, result: logs });
    });
  }

  it("covers deploy block to head with windows of at most 10,000,000 blocks, and finds the log", async () => {
    fetchMock = robinhood({ hit: 70_000_000 });
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("handleCurveBirth", { chain: "4663", token: TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ tx: TX, block: 70_000_000 });
    const windows = fetchMock.mock.calls
      .map(([url, init]) => ({ url, body: JSON.parse(init.body) }))
      .filter((c) => c.body.method === "eth_getLogs")
      .map((c) => {
        expect(new URL(c.url).host).toBe("rpc.mainnet.chain.robinhood.com");
        const [f] = c.body.params;
        expect(f.address).toBe(mod.CURVE_CHAINS["4663"].launcher);
        expect(f.topics).toEqual([mod.LAUNCH_CREATED_TOPIC0, pad(TOKEN)]);
        return [Number(f.fromBlock), Number(f.toBlock)];
      })
      .sort((a, b) => a[0] - b[0]);
    expect(windows[0][0]).toBe(46_343_018);
    expect(windows.at(-1)[1]).toBe(HEAD);
    for (const [i, [from, to]] of windows.entries()) {
      expect(to - from + 1).toBeLessThanOrEqual(10_000_000);
      if (i > 0) expect(from).toBe(windows[i - 1][1] + 1);
    }
  });

  it("a refused window is a 502, never { tx: null }", async () => {
    fetchMock = robinhood({ fail: "eth_getLogs" });
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("handleCurveBirth", { chain: "4663", token: TOKEN });
    expect(res.statusCode).toBe(502);
    expect(res.headers["Cache-Control"]).toBeUndefined();
  });
});

describe("curve-birth: a failed read is a 502, never an empty answer", () => {
  const FAILURES = [
    ["an HTTP 500", () => answer("", { ok: false, status: 500 })],
    ["a throttle in Blockscout's status 0 shape", () => answer({ message: "Max rate limit reached", result: null, status: "0" })],
    ["a body that is not JSON", () => answer("<html>challenge</html>")],
    ["a full page of logs (we did not see them all)", () => ok(Array.from({ length: 1000 }, () => bsLog(mod.CURVE_CHAINS["1"].launcher, [mod.LAUNCH_CREATED_TOPIC0, pad(TOKEN)])))],
    ["matching logs from two transactions", () => ok([
      bsLog(mod.CURVE_CHAINS["1"].launcher, [mod.LAUNCH_CREATED_TOPIC0, pad(TOKEN)], TX),
      bsLog(mod.CURVE_CHAINS["1"].launcher, [mod.LAUNCH_CREATED_TOPIC0, pad(TOKEN)], TX2),
    ])],
    ["a network error", () => { throw new Error("ECONNRESET"); }],
  ];
  for (const [label, reply] of FAILURES) {
    it(`${label}`, async () => {
      fetchMock.mockImplementationOnce(async () => reply());
      const res = await call("handleCurveBirth", { chain: "1", token: TOKEN });
      expect(res.statusCode).toBe(502);
      expect(res.body.tx).toBeUndefined();
      expect(res.headers["Cache-Control"]).toBeUndefined();
    });
  }
});

describe("curve-birth and doppler-birth: strict input, refused before any network call", () => {
  const BAD = [
    ["an unserved chain", { chain: "5", token: TOKEN }],
    ["a chain written another way", { chain: "01", token: TOKEN }],
    ["a chain in exponent form", { chain: "1e0", token: TOKEN }],
    ["no chain", { token: TOKEN }],
    ["a short token", { chain: "1", token: "0xdeadbeef" }],
    ["a token that is a URL", { chain: "1", token: "https://evil.example/x" }],
    ["two tokens", { chain: "1", token: [TOKEN, TOKEN] }],
    ["a prototype key for a chain", { chain: "__proto__", token: TOKEN }],
  ];
  for (const [label, query] of BAD) {
    it(`curve-birth refuses ${label}`, async () => {
      const res = await call("handleCurveBirth", query);
      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("doppler-birth refuses another chain and a bad token", async () => {
    for (const query of [{ chain: "8453", token: TOKEN }, { token: "0x1234" }, {}]) {
      const res = await call("handleDopplerBirth", query);
      expect(res.statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin in production and a POST, and answers a preflight", async () => {
    const saved = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      expect((await call("handleCurveBirth", { chain: "1", token: TOKEN }, { headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
      expect((await call("handleDopplerBirth", { token: TOKEN }, { method: "POST" })).statusCode).toBe(405);
      expect((await call("handleCurveBirth", {}, { method: "OPTIONS" })).statusCode).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      // The site's own fetch is a same-origin GET with no Origin header: it must pass.
      const res = makeRes();
      const req = makeReq({ query: { chain: "1", token: TOKEN } });
      delete req.headers.origin;
      req.headers["sec-fetch-site"] = "same-origin";
      await mod.handleCurveBirth(req, res);
      expect(res.statusCode).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved;
    }
  });
});

describe("doppler-birth: the token's own VestingAllocated logs on eth.blockscout.com", () => {
  it("returns the one transaction its allocations were made in", async () => {
    const t = TOKEN.toLowerCase();
    fetchMock.mockResolvedValueOnce(
      ok([
        bsLog(t, [mod.VESTING_ALLOCATED_TOPIC0, pad("0x295c4315fd4c0710d286b69e7cd5cecd289d5e6c"), "0x" + "0".repeat(64)]),
        bsLog(t, [mod.VESTING_ALLOCATED_TOPIC0, pad(OTHER_TOKEN), "0x" + "0".repeat(63) + "1"]),
      ]),
    );
    const res = await call("handleDopplerBirth", { token: TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.body.tx).toBe(TX);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe("eth.blockscout.com");
    expect(url.searchParams.get("address")).toBe(t);
    expect(url.searchParams.get("topic0")).toBe(mod.VESTING_ALLOCATED_TOPIC0);
  });

  it("answers { tx: null } for a token whose history holds no allocation", async () => {
    const res = await call("handleDopplerBirth", { token: TOKEN, chain: "1" });
    expect(res.body).toEqual({ tx: null, block: null });
  });

  it("an upstream error is a 502", async () => {
    fetchMock.mockResolvedValueOnce(answer("", { ok: false, status: 503 }));
    const res = await call("handleDopplerBirth", { token: TOKEN });
    expect(res.statusCode).toBe(502);
  });
});

describe("routing: both resources cost no function of their own", () => {
  it("dispatch behind a lazy import, ABOVE const provider", () => {
    const src = readFileSync(join(process.cwd(), "api/aggregator.js"), "utf8");
    const provider = src.indexOf("const provider = req.query.provider");
    for (const name of ["curve-birth", "doppler-birth"]) {
      const branch = src.indexOf(`req.query.resource === "${name}"`);
      expect(branch).toBeGreaterThan(-1);
      expect(branch).toBeLessThan(provider);
    }
    expect(src).toContain('await import("./_lib/evm-birth.js")');
  });
});
