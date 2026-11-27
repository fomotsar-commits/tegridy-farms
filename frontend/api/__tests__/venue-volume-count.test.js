// /api/venue-volume-count: the five-minute volume count, for Vercel's cron only. It counts
// nothing without CRON_SECRET or with the wrong bearer, gives each source a short budget,
// reads Solana through the keyed RPC, and never logs a secret.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import handler from "../venue-volume-count.js";
import { DB_TIMEOUT_MS } from "../../scripts/venue-volume.mjs";
import { EVM_CHAINS, HYPEREVM_V3 } from "../../scripts/lib/venue-volume-chain.mjs";

function makeReq(headers = {}, method = "GET") {
  return { method, query: {}, headers };
}
function makeRes() {
  const out = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (k, v) => ((out.headers[k] = v), res),
    status: (c) => ((out.status = c), res),
    json: (b) => ((out.body = b), res),
  };
  return { res, out };
}
const SECRET = "cron-secret-for-tests";
const bearer = { authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_KEY = "service-key-for-tests";
  process.env.SOLANA_RPC_URL = "https://keyed.test/?api-key=k";
});
afterEach(() => {
  for (const k of ["CRON_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SOLANA_RPC_URL"]) delete process.env[k];
  vi.restoreAllMocks();
});

describe("venue-volume-count", () => {
  it("counts nothing until CRON_SECRET is set", async () => {
    delete process.env.CRON_SECRET;
    const run = vi.fn();
    const { res, out } = makeRes();
    await handler(makeReq(bearer), res, { run });
    expect(out.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("counts nothing for a missing or wrong bearer, or a POST", async () => {
    const run = vi.fn();
    for (const req of [makeReq(), makeReq({ authorization: "Bearer nope" }), makeReq({ authorization: SECRET }), makeReq(bearer, "POST")]) {
      const { res, out } = makeRes();
      await handler(req, res, { run });
      expect([401, 405]).toContain(out.status);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the count with the service key, 20 seconds per source inside a run that ends before maxDuration, and the keyed Solana RPC", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 }));
    const run = vi.fn(async (opts) => {
      await opts.deps.solana("getSlot", []);
      return 0;
    });
    const { res, out } = makeRes();
    await handler(makeReq(bearer), res, { run, fetchImpl });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    const opts = run.mock.calls[0][0];
    expect(opts.env).toEqual({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_KEY: "service-key-for-tests" });
    expect(opts.budgetMs).toBe(20_000);
    // The run's time plus the two database calls that may follow it end inside maxDuration.
    const vercel = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vercel.json"), "utf-8"));
    expect(opts.runMs + 2 * DB_TIMEOUT_MS).toBeLessThan(vercel.functions["api/venue-volume-count.js"].maxDuration * 1000);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://keyed.test/?api-key=k");
  });

  it("reads every EVM chain the hourly job reads, HyperEVM included, through that chain's own RPC", async () => {
    // Every name the hourly job (scripts/venue-volume.mjs) hands to d.evm(...): the cron must
    // serve each one, or that source records an error every five minutes and the home page's
    // volume reads "not up to date".
    const job = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "venue-volume.mjs"), "utf-8");
    const names = [...new Set([...job.matchAll(/d\.evm\("([a-z0-9-]+)"\)/g)].map((m) => m[1]))];
    expect(names).toEqual(expect.arrayContaining(["ethereum", "base", "robinhood", "hyperevm"]));
    const firstRpc = (name) => (name === "hyperevm" ? HYPEREVM_V3.rpcs[0] : EVM_CHAINS[name].rpcs[0]);

    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 }));
    const reached = {};
    const run = vi.fn(async (opts) => {
      for (const name of names) {
        fetchImpl.mockClear();
        await opts.deps.evm(name)("eth_blockNumber", []);
        reached[name] = String(fetchImpl.mock.calls[0][0]);
      }
      return 0;
    });
    const { res, out } = makeRes();
    await handler(makeReq(bearer), res, { run, fetchImpl });
    expect(out.status).toBe(200);
    for (const name of names) expect(reached[name]).toBe(firstRpc(name));
  });

  it("answers 502 when a source did not finish, and logs no secret", async () => {
    const logged = [];
    vi.spyOn(console, "log").mockImplementation((m) => logged.push(m));
    const run = vi.fn(async (opts) => {
      opts.error(`could not read: Bearer ${SECRET}`);
      return 1;
    });
    const { res, out } = makeRes();
    await handler(makeReq(bearer), res, { run });
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ ok: false });
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});
