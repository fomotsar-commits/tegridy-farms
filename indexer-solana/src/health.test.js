import { describe, it, expect } from "vitest";
import { computeReadiness, createStatusServer } from "./health.js";

const NOW = Date.parse("2026-08-19T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

const configured = { problems: [] };
const pool = (over = {}) => ({ pool: "P", open_gaps: 0, standing_limitations: 1, ...over });

const readiness = (over = {}) =>
  computeReadiness({
    now: NOW,
    config: configured,
    tick: { last_tick_at: ago(1000), last_ok_at: ago(1000), head_slot: 900, last_error: null },
    pools: [pool()],
    staleAfterMs: 120_000,
    ...over,
  });

describe("computeReadiness", () => {
  it("is ready when configured and recently ticking", () => {
    const r = readiness();
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("configured and ticking");
  });

  it("is not ready before the first successful tick", () => {
    const r = readiness({ tick: { last_tick_at: ago(1000), last_ok_at: null, last_error: "boom" } });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("no tick has completed");
  });

  it("goes not-ready once the last success is older than the threshold, and says how old", () => {
    const r = readiness({ tick: { last_ok_at: ago(300_000), head_slot: 1, last_error: null } });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("300s ago");
  });

  it("names every configuration problem instead of a bare false", () => {
    const r = readiness({ config: { problems: ["SOLANA_RPC_URL is unset", "SOLANA_WATCH is empty"] } });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("SOLANA_RPC_URL is unset");
    expect(r.reason).toContain("SOLANA_WATCH is empty");
  });

  // THE CENTRAL DISTINCTION. A live, fresh service can still be missing a week
  // of history it could not read. Folding that into `ready` gives one boolean
  // that gets set for "answering" and read as "has everything".
  it("stays ready while incomplete, and reports the incompleteness separately", () => {
    const r = readiness({ pools: [pool({ open_gaps: 4 })] });
    expect(r.ready).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.openGaps).toBe(4);
  });

  // The mirror error: standing limitations are true on a perfectly healthy
  // day. Counting them as open gaps makes `complete` false forever, and a
  // signal that is always red is a signal nobody reads.
  it("does not let permanent design limits mark the data incomplete", () => {
    const r = readiness({ pools: [pool({ open_gaps: 0, standing_limitations: 3 })] });
    expect(r.complete).toBe(true);
    expect(r.standingLimitations).toBe(3);
  });

  it("sums gaps across every watched pool", () => {
    const r = readiness({
      pools: [pool({ open_gaps: 2, standing_limitations: 1 }), pool({ open_gaps: 5, standing_limitations: 2 })],
    });
    expect(r.openGaps).toBe(7);
    expect(r.standingLimitations).toBe(3);
  });

  it("treats a missing tick row as not ready", () => {
    expect(readiness({ tick: null }).ready).toBe(false);
  });
});

// The server is exercised over a real socket: the status codes are the
// contract a platform health check consumes, and a handler that returns the
// right JSON with the wrong code is the failure that matters here.
async function call(server, path) {
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("status server", () => {
  const build = (over = {}) =>
    createStatusServer({
      readStatus: async () => ({
        tick: { last_tick_at: ago(1000), last_ok_at: ago(1000), head_slot: 900, last_error: null },
        pools: [pool()],
      }),
      config: configured,
      staleAfterMs: 120_000,
      now: () => NOW,
      ...over,
    });

  it("answers /health 200 regardless of the data, like Ponder's does", async () => {
    const res = await call(
      build({
        readStatus: async () => {
          throw new Error("database is gone");
        },
      }),
      "/health",
    );
    expect(res.status).toBe(200);
  });

  it("answers /ready 200 when ready and 503 with a reason when not", async () => {
    expect((await call(build(), "/ready")).status).toBe(200);

    const notReady = await call(build({ config: { problems: ["SOLANA_WATCH is empty"] } }), "/ready");
    expect(notReady.status).toBe(503);
    expect(JSON.parse(notReady.text).reason).toContain("SOLANA_WATCH is empty");
  });

  // Unable to ask is not ready, and it is emphatically not "no gaps".
  it("answers /ready 503 when the database cannot be read", async () => {
    const res = await call(
      build({
        readStatus: async () => {
          throw new Error("connection terminated");
        },
      }),
      "/ready",
    );
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text).reason).toContain("connection terminated");
  });

  it("serves the per-pool detail on /status and nothing on an unknown path", async () => {
    const status = await call(build(), "/status");
    expect(status.status).toBe(200);
    const body = JSON.parse(status.text);
    expect(body.pools).toHaveLength(1);
    expect(body).toHaveProperty("openGaps");
    expect(body).toHaveProperty("standingLimitations");

    expect((await call(build(), "/graphql")).status).toBe(404);
    expect((await call(build(), "/metrics")).status).toBe(404);
  });
});
