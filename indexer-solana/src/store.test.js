import { describe, it, expect, vi } from "vitest";
import { createStore, STANDING_GAP_KINDS } from "./store.js";

const POOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** Records every statement, in order, the way a real client would receive them. */
function fakeClient(responder = () => ({ rows: [] })) {
  const log = [];
  return {
    log,
    async query(text, params) {
      log.push({ text: text.trim(), params });
      return responder(text, params) ?? { rows: [] };
    },
    /** First word of each statement — enough to assert transaction shape. */
    shape() {
      return log.map((q) => q.text.split(/\s+/)[0].toUpperCase());
    },
    find(fragment) {
      return log.filter((q) => q.text.includes(fragment));
    },
  };
}

const trade = { payer: "payer", direction: "buy", baseAmount: 100n, quoteAmount: 250n };

describe("commitSignature", () => {
  // THE DURABILITY RULE. Rows and the cursor advance must be one transaction,
  // and the cursor must go LAST. Committing the cursor first and crashing
  // leaves the resume point ahead of the data: next boot starts after rows
  // that were never written, and nothing anywhere records that they are gone.
  it("writes rows and the cursor inside one transaction, cursor last", async () => {
    const client = fakeClient();
    await createStore(client).commitSignature({
      pool: POOL,
      signature: "sigA",
      slot: 10,
      blockTime: 1_700_000,
      trade,
      claims: [{ receiver: "vault", mint: "mint", amount: 7n }],
    });

    expect(client.shape()).toEqual(["BEGIN", "INSERT", "INSERT", "INSERT", "COMMIT"]);
    const texts = client.log.map((q) => q.text);
    expect(texts[1]).toContain("solana_dbc_trade");
    expect(texts[2]).toContain("solana_fee_claim");
    expect(texts[3]).toContain("solana_cursor");
  });

  it("still advances the cursor for a signature that produced no rows", async () => {
    const client = fakeClient();
    await createStore(client).commitSignature({
      pool: POOL,
      signature: "sigA",
      slot: 10,
      blockTime: null,
      trade: null,
      claims: [],
    });
    expect(client.shape()).toEqual(["BEGIN", "INSERT", "COMMIT"]);
    expect(client.find("solana_cursor")).toHaveLength(1);
  });

  it("sends amounts as decimal strings, never as JS numbers", async () => {
    const client = fakeClient();
    const huge = 18_446_744_073_709_551_615n; // u64 max — not representable as a Number
    await createStore(client).commitSignature({
      pool: POOL,
      signature: "sigA",
      slot: 1,
      blockTime: null,
      trade: { ...trade, baseAmount: huge, quoteAmount: 1n },
      claims: [],
    });
    const params = client.find("solana_dbc_trade")[0].params;
    expect(params[6]).toBe("18446744073709551615");
    expect(typeof params[6]).toBe("string");
  });

  it("rolls back and rethrows when a row write fails", async () => {
    const client = fakeClient((text) => {
      if (text.includes("solana_dbc_trade")) throw new Error("constraint violation");
      return { rows: [] };
    });
    await expect(
      createStore(client).commitSignature({
        pool: POOL,
        signature: "sigA",
        slot: 1,
        blockTime: null,
        trade,
        claims: [],
      }),
    ).rejects.toThrow("constraint violation");
    expect(client.shape()).toEqual(["BEGIN", "INSERT", "ROLLBACK"]);
    // The cursor was never reached, so the resume point still points at the
    // last signature whose rows exist.
    expect(client.find("solana_cursor")).toHaveLength(0);
  });
});

describe("gaps", () => {
  it("marks design limits as standing and faults as not", async () => {
    const client = fakeClient();
    const store = createStore(client);
    await store.recordGap({ pool: POOL, kind: "undecodable", signature: "sigA", detail: "x" });
    await store.recordGap({ pool: POOL, kind: "accrual-not-indexed", detail: "y" });
    expect(client.log[0].params[2]).toBe(false);
    expect(client.log[1].params[2]).toBe(true);
    expect(STANDING_GAP_KINDS.has("fee-receiver-unset")).toBe(true);
  });

  it("dedupes a re-detected gap through the open-gap unique index", async () => {
    const client = fakeClient();
    await createStore(client).recordGap({ pool: POOL, kind: "undecodable", detail: "x" });
    const text = client.log[0].text;
    expect(text).toContain("ON CONFLICT");
    expect(text).toContain("WHERE resolved_at IS NULL");
    expect(text).toContain("DO NOTHING");
    // from_slot is part of the identity so two truncations at different slots
    // stay two rows — collapsing them would drop the second missing span.
    expect(text).toContain("COALESCE(from_slot, -1)");
  });
});

describe("declareLimitations", () => {
  // Both limits are written per pool so a consumer reading only SQL sees them.
  // A fee total that silently omits unclaimed accrual is a number that will be
  // quoted as revenue.
  it("always records that unrealized accrual is not indexed", async () => {
    const client = fakeClient();
    await createStore(client).declareLimitations([
      { pool: POOL, feeReceiver: "vault" },
    ]);
    const kinds = client.log.map((q) => q.params[1]);
    expect(kinds).toEqual(["accrual-not-indexed"]);
    expect(client.log[0].params[6]).toContain("COLLECTED");
  });

  it("adds a second limitation when no fee receiver is configured", async () => {
    const client = fakeClient();
    await createStore(client).declareLimitations([{ pool: POOL, feeReceiver: null }]);
    expect(client.log.map((q) => q.params[1])).toEqual(["accrual-not-indexed", "fee-receiver-unset"]);
  });
});

describe("syncWatches", () => {
  it("retires pools dropped from the env instead of deleting their history", async () => {
    const client = fakeClient();
    await createStore(client).syncWatches([
      { pool: POOL, label: null, baseMint: "b", quoteMint: "q", feeReceiver: null, baseDecimals: null, quoteDecimals: null },
    ]);
    const last = client.log[client.log.length - 1];
    expect(last.text).toContain("retired_at = now()");
    expect(last.text).not.toContain("DELETE");
    expect(last.params[0]).toEqual([POOL]);
  });
});

describe("getCursor", () => {
  it("returns null when the pool has never been indexed", async () => {
    const store = createStore(fakeClient(() => ({ rows: [] })));
    expect(await store.getCursor(POOL)).toBeNull();
  });

  // A bigint column arrives as a string from node-postgres. Reading it as-is
  // would make every slot comparison a string comparison.
  it("coerces bigint columns to numbers and keeps nulls null", async () => {
    const store = createStore(
      fakeClient(() => ({ rows: [{ last_signature: "sigA", last_slot: "1234", last_block_time: null }] })),
    );
    expect(await store.getCursor(POOL)).toEqual({
      lastSignature: "sigA",
      lastSlot: 1234,
      lastBlockTime: null,
    });
  });
});

describe("recordTick", () => {
  it("records a failed tick without touching the last-success timestamp", async () => {
    const client = fakeClient();
    await createStore(client).recordTick({ headSlot: 900, error: "boom" });
    const q = client.log[0];
    expect(q.text).toContain("last_tick_at = now()");
    expect(q.text).toContain("CASE WHEN $2::text IS NULL THEN now() ELSE last_ok_at END");
    expect(q.params).toEqual([900, "boom"]);
  });
});
