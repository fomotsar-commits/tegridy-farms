/**
 * userdata write-path tests — the pre-flight for Supabase migration 015 §1.
 *
 * 015 §1 DROPs the permissive `qual = true` write policies on user_profiles,
 * user_favorites, user_watchlist and votes. After it runs, the only surviving
 * write policies compare `wallet` against the SIWE JWT claim — a claim the
 * browser's anon key does not carry. So:
 *
 *   1. every mutation must leave through /api/supabase-proxy, never the anon
 *      client (the proxy holds the httpOnly SIWE cookie), and
 *   2. a refusal must reach the caller as a NAMED reason, not a bare `false`
 *      that is indistinguishable from "nothing changed".
 *
 * AUDIT FIX TF-004 / TF-007 — reads are now covered too. 015 §2 (the read-side
 * policies) is no longer deferred for the two PERSONAL tables: a watchlist is a
 * statement of trading intent and a favourites list is a behavioural profile,
 * and both were world-readable to anyone who pulled the anon key out of the
 * shipped bundle — while PrivacyPage §3 told every visitor that RLS scoped
 * their rows to their own SIWE wallet claim. Migration 016 drops those two
 * `USING (true)` policies; these tests pin the read path that has to move
 * FIRST, because dropping the policy under an anon read returns zero rows
 * rather than an error, and a silent zero is the failure this codebase refuses.
 *
 * `votes` and `user_profiles` deliberately stay public — see 016's header.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// The server's own validator. Asserting our bodies against it is what proves
// "the proxy schema already allows every field we need" without anyone having
// to widen an allowlist.
import { validateBody } from "../../../api/_lib/proxy-schemas.js";

const LOWER = "0x" + "ab".repeat(20);
const WALLET = "0x" + "AB".repeat(20); // callers pass checksummed/mixed case
const OTHER = "0x" + "cd".repeat(20);

const proxyWrite = vi.fn();
// AUDIT FIX TF-004 / TF-007: the two personal-table reads moved onto the proxy
// as well, so the owner-scoped RLS policy can match a proven wallet and the
// world-readable `USING (true)` twin can be dropped (migration 016).
const proxyRead = vi.fn();
/** Records ANY mutating verb called on the anon Supabase client. Must stay at 0. */
const anonMutation = vi.fn();

function makeAnonClient() {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    range: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    // Thenable so `await supabase.from(x).select(y).eq(...)` resolves like
    // PostgREST's builder does.
    then: (resolve) => resolve({ data: [], error: null }),
    insert: vi.fn((...a) => { anonMutation("insert", ...a); return chain; }),
    upsert: vi.fn((...a) => { anonMutation("upsert", ...a); return chain; }),
    update: vi.fn((...a) => { anonMutation("update", ...a); return chain; }),
    delete: vi.fn((...a) => { anonMutation("delete", ...a); return chain; }),
  };
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn((...a) => { anonMutation("rpc", ...a); return chain; }),
  };
}

/**
 * SYNC_ENABLED is captured at module-init from CHAT_ENABLED, so each scenario
 * needs a fresh module registry.
 */
async function loadUserdata({ syncEnabled }) {
  vi.resetModules();
  proxyWrite.mockReset();
  proxyWrite.mockResolvedValue([{}]);
  proxyRead.mockReset();
  proxyRead.mockResolvedValue([]);
  anonMutation.mockReset();
  vi.doMock("./supabase", () => ({
    CHAT_ENABLED: syncEnabled,
    supabase: syncEnabled ? makeAnonClient() : null,
  }));
  vi.doMock("./supabaseProxy", () => ({ proxyWrite, proxyRead }));
  return import("./userdata.js");
}

/** Run every mutating export once. Returns the module. */
async function runAllMutations(mod) {
  await mod.castVote(WALLET, 1234, "nakamigos");
  await mod.saveProfile(WALLET, { displayName: "gm", bio: "b", twitter: "t" }, "nakamigos");
  await mod.addFavoriteRemote(WALLET, 7, "nakamigos");
  await mod.removeFavoriteRemote(WALLET, 7, "nakamigos");
  await mod.addWatchlistRemote(WALLET, 9, { targetPrice: 1.25, note: "n" }, "nakamigos");
  await mod.removeWatchlistRemote(WALLET, 9, "nakamigos");
  await mod.syncFavorites(WALLET, ["11"], "nakamigos");
  await mod.syncWatchlist(WALLET, [{ id: "22", targetPrice: 2, note: "x" }], "nakamigos");
  return mod;
}

const readFor = (table) =>
  proxyRead.mock.calls.map((c) => c[0]).find((p) => p.table === table);

const callFor = (table, method) =>
  proxyWrite.mock.calls.map((c) => c[0]).find((p) => p.table === table && p.method === method);

afterEach(() => {
  vi.doUnmock("./supabase");
  vi.doUnmock("./supabaseProxy");
  localStorage.clear();
});

// ── 1. Every mutation leaves through the proxy ──────────────────────

describe("every mutation routes through the SIWE proxy, not the anon key", () => {
  let mod;
  beforeEach(async () => {
    mod = await loadUserdata({ syncEnabled: true });
  });

  it("castVote UPSERTs votes through the proxy with a string token_id", async () => {
    const result = await mod.castVote(WALLET, 1234, "nakamigos");

    expect(proxyWrite).toHaveBeenCalledTimes(1);
    expect(proxyWrite).toHaveBeenCalledWith({
      table: "votes",
      method: "UPSERT",
      body: {
        wallet: LOWER,
        token_id: "1234", // NOT the raw number — the proxy schema is z.string()
        week: expect.stringMatching(/^\d{4}-W\d{2}$/),
      },
    });
    expect(result).toEqual({ ok: true, status: mod.SYNC_STATUS.OK });
    expect(anonMutation).not.toHaveBeenCalled();
  });

  it("saveProfile UPSERTs user_profiles through the proxy", async () => {
    await mod.saveProfile(WALLET, { displayName: "gm", bio: "hi", twitter: "x" }, "nakamigos");
    const call = callFor("user_profiles", "UPSERT");
    expect(call).toBeDefined();
    expect(call.body.wallet).toBe(LOWER);
    expect(call.body.display_name).toBe("gm");
    expect(anonMutation).not.toHaveBeenCalled();
  });

  it("addFavoriteRemote / removeFavoriteRemote go through the proxy", async () => {
    await mod.addFavoriteRemote(WALLET, 7, "nakamigos");
    await mod.removeFavoriteRemote(WALLET, 7, "nakamigos");

    expect(callFor("user_favorites", "UPSERT").body).toEqual({
      wallet: LOWER, token_id: "7", collection_slug: "nakamigos",
    });
    // DELETE carries no wallet — RLS scopes it to the JWT wallet server-side.
    const del = callFor("user_favorites", "DELETE");
    expect(del.match).toEqual({ token_id: "7", collection_slug: "nakamigos" });
    expect(del.match.wallet).toBeUndefined();
    expect(anonMutation).not.toHaveBeenCalled();
  });

  it("addWatchlistRemote / removeWatchlistRemote go through the proxy", async () => {
    await mod.addWatchlistRemote(WALLET, 9, { targetPrice: 1.5, note: "n" }, "nakamigos");
    await mod.removeWatchlistRemote(WALLET, 9, "nakamigos");

    expect(callFor("user_watchlist", "UPSERT").body).toEqual({
      wallet: LOWER, token_id: "9", target_price: 1.5, note: "n", collection_slug: "nakamigos",
    });
    expect(callFor("user_watchlist", "DELETE").match).toEqual({
      token_id: "9", collection_slug: "nakamigos",
    });
    expect(anonMutation).not.toHaveBeenCalled();
  });

  it("syncFavorites / syncWatchlist push their local-only rows through the proxy", async () => {
    const merged = await mod.syncFavorites(WALLET, ["11"], "nakamigos");
    expect(merged).toContain("11");
    expect(callFor("user_favorites", "UPSERT").body).toEqual([
      { wallet: LOWER, token_id: "11", collection_slug: "nakamigos" },
    ]);

    await mod.syncWatchlist(WALLET, [{ id: "22", targetPrice: 2, note: "x" }], "nakamigos");
    expect(callFor("user_watchlist", "UPSERT").body).toEqual([
      { wallet: LOWER, token_id: "22", collection_slug: "nakamigos", target_price: 2, note: "x" },
    ]);
    expect(anonMutation).not.toHaveBeenCalled();
  });

  it("no mutating verb EVER reaches the anon Supabase client", async () => {
    await runAllMutations(mod);
    expect(anonMutation).not.toHaveBeenCalled();
    // …and the reads still did happen on the anon client (015 §2 is deferred),
    // so this guard cannot be satisfied by deleting the feature.
    expect(proxyWrite.mock.calls.length).toBeGreaterThanOrEqual(8);
  });

  it("a failed sync push no longer throws away the merge it just computed", async () => {
    proxyWrite.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 403 }));
    const seen = [];
    const merged = await mod.syncFavorites(WALLET, ["11", "12"], "nakamigos", (r) => seen.push(r));
    expect(merged).toEqual(["11", "12"]);
    expect(seen).toEqual([{ ok: false, status: "denied", error: "Unauthorized" }]);
  });
});

// ── 2. The bodies satisfy the server's own schema ────────────────────

// AUDIT TF-004 / TF-007. The property: a wallet's personal rows are never
// fetched with a credential that cannot prove that wallet. The anon key
// cannot — it carries no JWT claim — so these reads must leave through the
// proxy that holds the SIWE cookie, and must be scoped to the caller's own
// wallet rather than fetching the table.
describe("personal-table reads leave through the SIWE proxy, not the anon key", () => {
  it("syncFavorites and syncWatchlist read through the proxy", async () => {
    const mod = await loadUserdata({ syncEnabled: true });
    await mod.syncFavorites(WALLET, ["11"], "nakamigos");
    await mod.syncWatchlist(WALLET, [{ id: "22" }], "nakamigos");

    expect(readFor("user_favorites")).toBeTruthy();
    expect(readFor("user_watchlist")).toBeTruthy();
  });

  it("scopes every personal read to the caller's OWN lower-cased wallet", async () => {
    const mod = await loadUserdata({ syncEnabled: true });
    await mod.syncFavorites(WALLET, [], "nakamigos");
    await mod.syncWatchlist(WALLET, [], "nakamigos");

    for (const table of ["user_favorites", "user_watchlist"]) {
      // A read with no wallet in `match` would be a table scan against
      // whatever the policy allows — precisely the exposure being closed.
      expect(readFor(table).match.wallet, `${table} read is not wallet-scoped`).toBe(LOWER);
    }
  });

  it("never reaches the anon client for those two tables", async () => {
    const mod = await loadUserdata({ syncEnabled: true });
    const { supabase } = await import("./supabase");
    await mod.syncFavorites(WALLET, ["11"], "nakamigos");
    await mod.syncWatchlist(WALLET, [{ id: "22" }], "nakamigos");

    const anonTables = supabase.from.mock.calls.map((c) => c[0]);
    expect(anonTables).not.toContain("user_favorites");
    expect(anonTables).not.toContain("user_watchlist");
  });

  it("degrades to the local list when there is no SIWE session, never to a throw", async () => {
    const mod = await loadUserdata({ syncEnabled: true });
    const denied = new Error("Sign-in required");
    denied.needsAuth = true;
    proxyRead.mockRejectedValue(denied);

    await expect(mod.syncFavorites(WALLET, ["11"], "nakamigos")).resolves.toEqual(["11"]);
    await expect(
      mod.syncWatchlist(WALLET, [{ id: "22" }], "nakamigos"),
    ).resolves.toEqual([{ id: "22" }]);
  });
});

describe("proxied bodies satisfy api/_lib/proxy-schemas.js as-is", () => {
  it("every INSERT/UPSERT/UPDATE body validates against the server schema", async () => {
    const mod = await loadUserdata({ syncEnabled: true });
    await runAllMutations(mod);

    const writes = proxyWrite.mock.calls
      .map((c) => c[0])
      .filter((p) => ["INSERT", "UPSERT", "UPDATE"].includes(p.method));
    expect(writes.length).toBeGreaterThanOrEqual(6);

    for (const { table, method, body } of writes) {
      const result = validateBody(table, method, body, { wallet: LOWER });
      expect(result, `${table}.${method} body rejected by the server schema`).toMatchObject({ ok: true });
    }
  });

  it("the server takes the wallet from the JWT — a forged one is refused", () => {
    // The `wallet` field we send is compared to the JWT claim, never trusted.
    const forged = validateBody("votes", "UPSERT",
      { wallet: OTHER, token_id: "1", week: "2026-W33" }, { wallet: LOWER });
    expect(forged).toEqual({ ok: false, error: "wallet mismatch" });
  });

  it("an uncoerced numeric token_id would be refused — String() is load-bearing", () => {
    const raw = validateBody("votes", "UPSERT",
      { wallet: LOWER, token_id: 1234, week: "2026-W33" }, { wallet: LOWER });
    expect(raw.ok).toBe(false);
  });
});

// ── 3. Denials surface instead of vanishing ──────────────────────────

describe("a denial surfaces with a reason instead of a silent false", () => {
  let mod;
  beforeEach(async () => {
    mod = await loadUserdata({ syncEnabled: true });
  });

  const reject = (err) => { proxyWrite.mockReset(); proxyWrite.mockRejectedValue(err); };

  const CASES = [
    ["RLS refusal (PostgREST 42501 → 403)", Object.assign(new Error("Unauthorized"), { status: 403 }), "denied"],
    ["proxy schema / wallet-mismatch 400", Object.assign(new Error("Request rejected"), { status: 400 }), "denied"],
    ["no SIWE cookie (401)", Object.assign(new Error("Sign-in required"), { needsAuth: true }), "needs-auth"],
    ["rate limited (429)", Object.assign(new Error("Too many"), { status: 429 }), "network"],
    ["upstream fault (502)", Object.assign(new Error("Upstream"), { status: 502 }), "network"],
    ["request never landed", new TypeError("Failed to fetch"), "network"],
  ];

  it.each(CASES)("castVote reports %s as `%s`", async (_label, err, status) => {
    reject(err);
    const result = await mod.castVote(WALLET, 1234, "nakamigos");
    // The regression this guards: castVote used to `return !error`.
    expect(result).not.toBe(false);
    expect(result).toMatchObject({ ok: false, status });
  });

  it.each(CASES)("saveProfile reports %s as `%s`", async (_label, err, status) => {
    reject(err);
    const result = await mod.saveProfile(WALLET, { displayName: "a", bio: "", twitter: "" }, "nakamigos");
    expect(result).not.toBe(false);
    expect(result).toMatchObject({ ok: false, status });
  });

  it("every favorite / watchlist mutator reports the denial too", async () => {
    reject(Object.assign(new Error("Unauthorized"), { status: 403 }));
    const results = [
      await mod.addFavoriteRemote(WALLET, 1, "nakamigos"),
      await mod.removeFavoriteRemote(WALLET, 1, "nakamigos"),
      await mod.addWatchlistRemote(WALLET, 1, {}, "nakamigos"),
      await mod.removeWatchlistRemote(WALLET, 1, "nakamigos"),
    ];
    for (const r of results) {
      // These four used to return `undefined` with `catch { /* silent */ }`.
      expect(r).toBeDefined();
      expect(r).toMatchObject({ ok: false, status: "denied" });
    }
  });

  it("syncFailureToast turns every failure into user-facing copy, and success into silence", async () => {
    expect(mod.syncFailureToast({ ok: true, status: "ok" })).toBeNull();
    expect(mod.syncFailureToast({ ok: true, status: "local-only" })).toBeNull();
    expect(mod.syncFailureToast(undefined)).toBeNull();

    for (const status of ["needs-auth", "denied", "network"]) {
      const toast = mod.syncFailureToast({ ok: false, status }, "vote");
      expect(toast, `no copy for ${status}`).not.toBeNull();
      expect(toast.message).toContain("vote");
      expect(["info", "error"]).toContain(toast.type);
    }
    // A denial must read as an error, not a shrug.
    expect(mod.syncFailureToast({ ok: false, status: "denied" }, "vote").type).toBe("error");
  });

  it("a missing wallet is 'needs-auth', not a mystery false", async () => {
    for (const r of [
      await mod.castVote(null, 1, "nakamigos"),
      await mod.saveProfile(null, { displayName: "" }, "nakamigos"),
      await mod.addFavoriteRemote(null, 1, "nakamigos"),
      await mod.addWatchlistRemote(null, 1, {}, "nakamigos"),
    ]) {
      expect(r).toMatchObject({ ok: false, status: "needs-auth" });
    }
    expect(proxyWrite).not.toHaveBeenCalled();
  });
});

// ── 4. The offline path is untouched ─────────────────────────────────

describe("SYNC_ENABLED=false keeps the localStorage fallback exactly as before", () => {
  let mod;
  beforeEach(async () => {
    localStorage.clear();
    mod = await loadUserdata({ syncEnabled: false });
  });

  it("castVote writes the local tally and getUserVote / getWeekVotes read it back", async () => {
    const result = await mod.castVote(WALLET, 1234, "naka");
    expect(result).toEqual({ ok: true, status: "local-only" });
    expect(proxyWrite).not.toHaveBeenCalled();

    expect(JSON.parse(localStorage.getItem("naka_votes"))[LOWER].tokenId).toBe(1234);
    expect(await mod.getUserVote(WALLET, undefined, "naka")).toBe(1234);
    expect(await mod.getWeekVotes(undefined, "naka")).toEqual({ 1234: 1 });
  });

  it("saveProfile writes the local cache and getProfile reads it back", async () => {
    const result = await mod.saveProfile(WALLET, { displayName: "gm", bio: "b", twitter: "t" }, "naka");
    expect(result).toEqual({ ok: true, status: "local-only" });
    expect(proxyWrite).not.toHaveBeenCalled();
    expect(await mod.getProfile(WALLET, "naka")).toMatchObject({ displayName: "gm", bio: "b" });
  });

  it("favorite / watchlist mutators are local-only no-ops that never call the proxy", async () => {
    for (const r of [
      await mod.addFavoriteRemote(WALLET, 1, "naka"),
      await mod.removeFavoriteRemote(WALLET, 1, "naka"),
      await mod.addWatchlistRemote(WALLET, 1, {}, "naka"),
      await mod.removeWatchlistRemote(WALLET, 1, "naka"),
    ]) {
      expect(r).toEqual({ ok: true, status: "local-only" });
    }
    expect(proxyWrite).not.toHaveBeenCalled();
  });

  it("syncFavorites / syncWatchlist return the local data untouched", async () => {
    const ids = ["1", "2"];
    const items = [{ id: "3", targetPrice: 1, note: "n" }];
    expect(await mod.syncFavorites(WALLET, ids, "naka")).toBe(ids);
    expect(await mod.syncWatchlist(WALLET, items, "naka")).toBe(items);
    expect(proxyWrite).not.toHaveBeenCalled();
  });

  it("local-only is a SUCCESS — the offline build must not toast a failure", async () => {
    const result = await mod.castVote(WALLET, 1, "naka");
    expect(result.ok).toBe(true);
    expect(mod.syncFailureToast(result, "vote")).toBeNull();
  });
});
