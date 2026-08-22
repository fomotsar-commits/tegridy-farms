// AUDIT SIWE-RESTORE: `validateBody` must FAIL CLOSED.
//
// Pre-fix, an unrecognised table or an unrecognised (table, method) pair
// returned `{ ok: true, data: body }` — i.e. the write body was forwarded to
// PostgREST completely unvalidated. The justification in the source was "the
// proxy allowlist already checked it", which is only half true: the allowlist
// gates the TABLE, nothing gates the (table, method) PAIR. Any allowlisted
// table whose schema map is missing the method in play sailed straight past
// the strict Zod object, the length bounds, AND the JWT wallet/author/sender
// ownership refinement below it.
//
// This matters much more now than it did last week: restoring SIWE login arms
// authorization paths that have never actually executed in production. A
// validator that defaults to "allow" is not a defense-in-depth layer, it is a
// hole with a comment on it. The allowlist is now the schema map itself.
//
// The companion file `proxy-schemas.test.js` still contains three
// "pass-through cases" tests that assert the OLD fail-open contract. They are
// the false-green artifact of this defect and need inverting; that file is
// outside this change's scope — see the lane report.

import { describe, it, expect } from "vitest";
import { validateBody } from "../proxy-schemas.js";

const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);
const CLAIMS_A = { wallet: WALLET_A };

describe("validateBody — fail closed on unmapped table/method", () => {
  it("rejects a table with no schema entry", () => {
    const r = validateBody("unknown_table", "INSERT", { x: 1 }, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects a table with no schema entry even when the body looks harmless", () => {
    const r = validateBody("revoked_jwts", "INSERT", { jti: "j-1" }, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects an allowlisted table when the method has no schema entry", () => {
    // `messages` is proxy-allowlisted and only maps INSERT. Pre-fix, UPDATE
    // bypassed the 280-char bound and the author-ownership check entirely.
    const r = validateBody("messages", "UPDATE", { text: "x" }, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("an unmapped method cannot be used to forge a row owned by another wallet", () => {
    // The load-bearing consequence: the JWT-ownership refinement lives BELOW
    // the early returns, so a fail-open path skipped it. Author is WALLET_B
    // while the JWT claims WALLET_A — this must never be forwarded.
    const r = validateBody("messages", "UPSERT", { author: WALLET_B, text: "hi", slug: "s" }, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects DELETE, which has no body schema on any table", () => {
    const r = validateBody("messages", "DELETE", undefined, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("does not leak schema internals in the rejection reason", () => {
    // Same posture as the Zod-failure branch: no table/column names, no Zod
    // issue paths. Pins the property, not the wording.
    const r = validateBody("unknown_table", "INSERT", { x: 1 }, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error).not.toMatch(/unknown_table/);
    expect(r.error).not.toMatch(/zod|ZodError|invalid_type/i);
  });
});

// Fail-closed is only correct if it closes on nothing real. These are every
// (table, method) pair the frontend actually issues through the proxy —
// src/nakamigos/lib/{supabase,userdata,dm,notifications}.js. If a future
// schema-map edit drops one of these, this block goes red instead of the
// feature silently 400ing in production.
describe("validateBody — every live proxy write path still validates", () => {
  const dmKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  const LIVE_PATHS = [
    ["messages", "INSERT", { author: WALLET_A, text: "gm", slug: "nakamigos" }],
    ["user_profiles", "UPSERT", { wallet: WALLET_A, display_name: "me", updated_at: new Date().toISOString() }],
    ["user_favorites", "UPSERT", { wallet: WALLET_A, token_id: "1", collection_slug: "nakamigos" }],
    ["user_watchlist", "UPSERT", { wallet: WALLET_A, token_id: "1", collection_slug: "nakamigos", target_price: 1.5, note: null }],
    ["push_subscriptions", "UPSERT", { wallet: WALLET_A, endpoint: "https://push.example.com/x", p256dh: "k", auth: "a" }],
    ["dm_messages", "INSERT", { sender: WALLET_A, recipient: WALLET_B, channel_key: dmKey(WALLET_A, WALLET_B), text: "hi" }],
    ["dm_messages", "UPDATE", { read_at: new Date().toISOString() }],
  ];

  for (const [table, method, row] of LIVE_PATHS) {
    it(`${table} ${method} is accepted`, () => {
      const r = validateBody(table, method, row, CLAIMS_A);
      expect(r.ok, `expected ${table}/${method} to validate, got: ${r.error}`).toBe(true);
    });
  }
});
