import { describe, it, expect, vi } from "vitest";
import { ingestWatch, runTick } from "./ingest.js";
import { SolanaRpcError } from "./rpc.js";

const POOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BASE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE = "So11111111111111111111111111111111111111112";
const VAULT_AUTH = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const PAYER = "8DkRR6cyCLYNbTNBBqCVLxU7c5PCsCvJHvKvNMArzq4h";

const watch = (over = {}) => ({
  pool: POOL,
  baseMint: BASE,
  quoteMint: QUOTE,
  feeReceiver: null,
  startSignature: null,
  ...over,
});

const bal = (accountIndex, mint, owner, amount) => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount: String(amount), decimals: 6 },
});

/** A clean buy: the pool releases base and takes quote. */
const buyTx = (slot) => ({
  slot,
  blockTime: 1_700_000 + slot,
  transaction: { message: { accountKeys: [{ pubkey: PAYER }] } },
  meta: {
    err: null,
    preTokenBalances: [bal(4, BASE, VAULT_AUTH, 1_000_000), bal(5, QUOTE, VAULT_AUTH, 500_000)],
    postTokenBalances: [bal(4, BASE, VAULT_AUTH, 900_000), bal(5, QUOTE, VAULT_AUTH, 600_000)],
  },
});

function fakeStore(cursor = null) {
  const commits = [];
  const gaps = [];
  const ticks = [];
  return {
    commits,
    gaps,
    ticks,
    async getCursor() {
      return cursor;
    },
    async commitSignature(row) {
      commits.push(row);
    },
    async recordGap(gap) {
      gaps.push(gap);
    },
    async recordTick(t) {
      ticks.push(t);
    },
  };
}

function fakeRpc({ pages = [[]], transactions = {}, getTransaction, getSlot } = {}) {
  let page = 0;
  return {
    getSlot: getSlot ?? (async () => 12_345),
    async getSignaturesForAddress() {
      return pages[page++] ?? [];
    },
    getTransaction: getTransaction ?? (async (sig) => transactions[sig] ?? null),
  };
}

const sigEntry = (n, over = {}) => ({
  signature: `sig${n}`,
  slot: 1000 + n,
  blockTime: 1_700_000 + n,
  err: null,
  ...over,
});

describe("ingestWatch — the happy path", () => {
  it("commits trades oldest-first so the cursor only ever crosses a contiguous prefix", async () => {
    const store = fakeStore();
    const rpc = fakeRpc({
      pages: [[sigEntry(3), sigEntry(2), sigEntry(1)]],
      // "seed" present: the cursor-retention probe (AUDIT FIX 2026-08-24) asks
      // the cluster about the resume signature; a fixture without it models an
      // aged-out cursor and legitimately records a gap.
      transactions: { seed: buyTx(999), sig1: buyTx(1001), sig2: buyTx(1002), sig3: buyTx(1003) },
    });
    const out = await ingestWatch({ rpc, store, watch: watch({ startSignature: "seed" }), pageLimit: 10, maxPages: 5 });

    expect(out.trades).toBe(3);
    expect(store.commits.map((c) => c.signature)).toEqual(["sig1", "sig2", "sig3"]);
    expect(store.commits[0].trade).toMatchObject({ direction: "buy", baseAmount: 100_000n });
    expect(store.gaps).toEqual([]);
  });

  it("advances past a reverted transaction without fetching its body", async () => {
    const store = fakeStore();
    const getTransaction = vi.fn(async () => buyTx(999));
    const rpc = fakeRpc({ pages: [[sigEntry(1, { err: { Custom: 1 } })]], getTransaction });
    const out = await ingestWatch({ rpc, store, watch: watch({ startSignature: "seed" }), pageLimit: 10, maxPages: 5 });

    // The invariant is about the REVERTED signature's body — the one call the
    // cursor-retention probe makes is for "seed", never for sig1.
    expect(getTransaction).not.toHaveBeenCalledWith("sig1");
    expect(out.trades).toBe(0);
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0].trade).toBeNull();
    expect(store.gaps).toEqual([]);
  });
});

describe("ingestWatch — a hole is never a zero", () => {
  // Terminal failure: the cluster listed a signature and then would not hand
  // over the transaction. Advancing quietly would delete it from history.
  it("records tx-unavailable AND advances, so it neither loops nor vanishes", async () => {
    const store = fakeStore();
    const rpc = fakeRpc({ pages: [[sigEntry(1)]], transactions: { seed: buyTx(999) } });
    const out = await ingestWatch({ rpc, store, watch: watch({ startSignature: "seed" }), pageLimit: 10, maxPages: 5 });

    expect(out.gaps).toBe(1);
    expect(store.gaps[0]).toMatchObject({ kind: "tx-unavailable", signature: "sig1" });
    expect(store.commits.map((c) => c.signature)).toEqual(["sig1"]);
  });

  it("records an undecodable transaction as a gap rather than dropping it", async () => {
    const store = fakeStore();
    const routed = buyTx(1001);
    routed.meta.postTokenBalances = [bal(4, BASE, VAULT_AUTH, 900_000)]; // one leg only
    const rpc = fakeRpc({ pages: [[sigEntry(1)]], transactions: { seed: buyTx(999), sig1: routed } });
    const out = await ingestWatch({ rpc, store, watch: watch({ startSignature: "seed" }), pageLimit: 10, maxPages: 5 });

    expect(out.trades).toBe(0);
    expect(store.gaps[0].kind).toBe("undecodable");
    expect(store.commits[0].trade).toBeNull();
  });

  it("records a truncated backlog when the resume point is not reached", async () => {
    const store = fakeStore({ lastSignature: "old", lastSlot: 500, lastBlockTime: null });
    const rpc = fakeRpc({
      pages: [[sigEntry(9), sigEntry(8)], [sigEntry(7), sigEntry(6)]],
      transactions: {},
      getTransaction: async () => buyTx(1),
    });
    const out = await ingestWatch({ rpc, store, watch: watch(), pageLimit: 2, maxPages: 2 });

    const truncation = store.gaps.find((g) => g.kind === "backlog-truncated");
    expect(truncation).toBeTruthy();
    expect(truncation.fromSlot).toBe(500);
    expect(out.fetched).toBe(4);
  });

  it("records unbackfilled history on a cold start with no startSignature", async () => {
    const store = fakeStore(null);
    const rpc = fakeRpc({
      pages: [[sigEntry(2), sigEntry(1)]],
      getTransaction: async () => buyTx(1),
    });
    await ingestWatch({ rpc, store, watch: watch(), pageLimit: 2, maxPages: 1 });
    expect(store.gaps[0].kind).toBe("history-not-backfilled");
  });

  it("records pruned-history and stops when the RPC no longer retains the range", async () => {
    const store = fakeStore({ lastSignature: "old", lastSlot: 42, lastBlockTime: null });
    const rpc = {
      getSlot: async () => 1,
      getSignaturesForAddress: async () => {
        throw new SolanaRpcError("pruned", "Slot skipped");
      },
      getTransaction: async () => null,
    };
    const out = await ingestWatch({ rpc, store, watch: watch(), pageLimit: 10, maxPages: 5 });

    expect(out.stoppedEarly).toBe(true);
    expect(store.gaps[0]).toMatchObject({ kind: "pruned-history", fromSlot: 42 });
    expect(store.commits).toEqual([]);
  });
});

describe("ingestWatch — transient failure changes nothing", () => {
  // The mirror image of the rule above. A cluster that did not answer has not
  // told us anything is missing, so nothing is recorded as missing and the
  // cursor stays where it was.
  it("stops mid-batch on an unreachable cluster without advancing or writing a gap", async () => {
    const store = fakeStore();
    let calls = 0;
    const rpc = fakeRpc({
      pages: [[sigEntry(3), sigEntry(2), sigEntry(1)]],
      getTransaction: async (sig) => {
        calls++;
        if (sig === "sig2") throw new SolanaRpcError("unreachable", "ECONNRESET");
        return buyTx(1001);
      },
    });
    const out = await ingestWatch({ rpc, store, watch: watch({ startSignature: "seed" }), pageLimit: 10, maxPages: 5 });

    expect(out.stoppedEarly).toBe(true);
    expect(store.commits.map((c) => c.signature)).toEqual(["sig1"]);
    expect(store.gaps).toEqual([]);
    // 3 calls: the cursor-retention probe for "seed", then sig1, then sig2
    // (which throws). Was 2 before the probe existed.
    expect(calls).toBe(3);
  });

  it("records resume-aged-out when the walk claims the cursor but the cluster no longer knows it", async () => {
    // The SILENT variant of pruned-history (AUDIT FIX 2026-08-24): most RPCs do
    // not throw on an aged-out `until` — they ignore it, drain to the retention
    // floor, and the walk reports reachedUntil. Pre-fix that read as "caught
    // up" while the range between the floor and the old cursor vanished
    // unrecorded. The one-getTransaction probe turns it into a gap row.
    const store = fakeStore({ lastSignature: "old", lastSlot: 500, lastBlockTime: null });
    const rpc = fakeRpc({
      pages: [[sigEntry(2), sigEntry(1)]],
      transactions: { sig1: buyTx(1001), sig2: buyTx(1002) }, // no "old": aged out
    });
    const out = await ingestWatch({ rpc, store, watch: watch(), pageLimit: 10, maxPages: 5 });

    const gap = store.gaps.find((g) => g.kind === "resume-aged-out");
    expect(gap).toBeTruthy();
    expect(gap.toSlot).toBe(500);
    expect(out.gaps).toBeGreaterThanOrEqual(1);
    // The new signatures themselves still commit — the gap is the record of
    // what could NOT be fetched, not a reason to drop what could.
    expect(store.commits.map((c) => c.signature)).toEqual(["sig1", "sig2"]);
  });
});

describe("runTick", () => {
  it("keeps going when one pool fails and names it in the tick row", async () => {
    const store = fakeStore();
    const goodWatch = watch({ startSignature: "seed" });
    const badWatch = watch({ pool: "BADPOOL", startSignature: "seed" });
    const rpc = {
      getSlot: async () => 777,
      getSignaturesForAddress: async (pool) => {
        if (pool === "BADPOOL") throw new SolanaRpcError("malformed", "nonsense");
        return [sigEntry(1)];
      },
      getTransaction: async () => buyTx(1001),
    };

    const out = await runTick({
      rpc,
      store,
      watches: [goodWatch, badWatch],
      pageLimit: 10,
      maxPages: 2,
      logger: { error: () => {} },
    });

    expect(out.headSlot).toBe(777);
    expect(out.summaries).toHaveLength(1);
    expect(store.ticks[0].headSlot).toBe(777);
    expect(store.ticks[0].error).toContain("BADPOOL");
  });

  // A tick that could not even read the head slot must not be recorded as a
  // clean tick — /ready reads last_ok_at, and a null error would set it.
  it("records a null head slot with the error rather than a clean tick", async () => {
    const store = fakeStore();
    const rpc = {
      getSlot: async () => {
        throw new SolanaRpcError("unreachable", "down");
      },
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null,
    };
    await runTick({ rpc, store, watches: [watch({ startSignature: "seed" })], pageLimit: 10, maxPages: 2 });
    expect(store.ticks[0].headSlot).toBeNull();
    expect(store.ticks[0].error).toContain("getSlot");
  });

  it("writes a tick row even when there is nothing to do", async () => {
    const store = fakeStore();
    await runTick({ rpc: fakeRpc(), store, watches: [], pageLimit: 10, maxPages: 2 });
    expect(store.ticks).toHaveLength(1);
    expect(store.ticks[0].error).toBeNull();
  });
});
