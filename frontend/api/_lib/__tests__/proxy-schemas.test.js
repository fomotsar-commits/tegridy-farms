// AUDIT API-M8 test suite: per-table validation for the Supabase write-proxy.
//
// These tests exercise `validateBody` directly. The proxy integration test
// (supabase-proxy.test.js) covers how the handler WIRES validation in.

import { describe, it, expect } from "vitest";
import { validateBody } from "../proxy-schemas.js";

const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);
const CLAIMS_A = { wallet: WALLET_A };

describe("validateBody — messages", () => {
  it("accepts a valid single-row insert", () => {
    const row = { author: WALLET_A, text: "hello world", slug: "nakamigos-1" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(row);
  });

  it("accepts a valid insert with token_id", () => {
    const row = { author: WALLET_A, text: "gm", slug: "nakamigos", token_id: "1337" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("accepts null token_id", () => {
    const row = { author: WALLET_A, text: "hi", slug: "x", token_id: null };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("rejects missing required field (text)", () => {
    const row = { author: WALLET_A, slug: "x" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid payload shape");
  });

  it("rejects missing required field (author)", () => {
    const row = { text: "hi", slug: "x" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects empty string text", () => {
    const row = { author: WALLET_A, text: "", slug: "x" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects oversize text (281 chars)", () => {
    const row = { author: WALLET_A, text: "a".repeat(281), slug: "x" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid payload shape");
  });

  it("accepts 280-char text (boundary)", () => {
    const row = { author: WALLET_A, text: "a".repeat(280), slug: "x" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown field (is_admin)", () => {
    const row = { author: WALLET_A, text: "hi", slug: "x", is_admin: true };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid payload shape");
  });

  it("rejects oversize slug (65 chars)", () => {
    const row = { author: WALLET_A, text: "hi", slug: "a".repeat(65) };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects uppercase author (wallet regex is lowercase-hex)", () => {
    const row = { author: "0x" + "A".repeat(40), text: "hi", slug: "x" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects author that doesn't match JWT wallet", () => {
    const row = { author: WALLET_B, text: "hi", slug: "x" };
    const r = validateBody("messages", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("author mismatch");
  });

  it("treats jwt wallet claim as case-insensitive match", () => {
    const mixedClaims = { wallet: WALLET_A.toUpperCase() };
    const row = { author: WALLET_A, text: "hi", slug: "x" };
    const r = validateBody("messages", "INSERT", row, mixedClaims);
    expect(r.ok).toBe(true);
  });
});

describe("validateBody — user_profiles", () => {
  it("accepts a valid INSERT", () => {
    const row = { wallet: WALLET_A, display_name: "anon", bio: "gm" };
    const r = validateBody("user_profiles", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("accepts a valid UPSERT", () => {
    const row = { wallet: WALLET_A, display_name: "anon" };
    const r = validateBody("user_profiles", "UPSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("accepts a partial UPDATE (only wallet + bio)", () => {
    const row = { wallet: WALLET_A, bio: "new bio" };
    const r = validateBody("user_profiles", "UPDATE", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("UPDATE still requires wallet (so JWT check has something to compare)", () => {
    const row = { bio: "new bio" };
    const r = validateBody("user_profiles", "UPDATE", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects wallet mismatch on INSERT", () => {
    const row = { wallet: WALLET_B, display_name: "anon" };
    const r = validateBody("user_profiles", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("wallet mismatch");
  });

  it("rejects wallet mismatch on UPDATE", () => {
    const row = { wallet: WALLET_B, bio: "x" };
    const r = validateBody("user_profiles", "UPDATE", row, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("wallet mismatch");
  });

  it("rejects invalid avatar_url", () => {
    const row = { wallet: WALLET_A, avatar_url: "not-a-url" };
    const r = validateBody("user_profiles", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown field on UPSERT", () => {
    const row = { wallet: WALLET_A, display_name: "anon", is_admin: true };
    const r = validateBody("user_profiles", "UPSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects oversize bio (161 chars)", () => {
    const row = { wallet: WALLET_A, bio: "a".repeat(161) };
    const r = validateBody("user_profiles", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });
});

describe("validateBody — user_favorites", () => {
  it("accepts a valid INSERT", () => {
    const row = { wallet: WALLET_A, token_id: "123", collection_slug: "nakamigos" };
    const r = validateBody("user_favorites", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("applies collection_slug default", () => {
    const row = { wallet: WALLET_A, token_id: "123" };
    const r = validateBody("user_favorites", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
    expect(r.data.collection_slug).toBe("nakamigos");
  });

  it("rejects wallet mismatch", () => {
    const row = { wallet: WALLET_B, token_id: "123" };
    const r = validateBody("user_favorites", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("wallet mismatch");
  });

  it("accepts an array of rows", () => {
    const rows = [
      { wallet: WALLET_A, token_id: "1" },
      { wallet: WALLET_A, token_id: "2" },
    ];
    const r = validateBody("user_favorites", "INSERT", rows, CLAIMS_A);
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(2);
  });

  it("array: one bad row invalidates the whole batch", () => {
    const rows = [
      { wallet: WALLET_A, token_id: "1" },
      { wallet: WALLET_A, token_id: "a".repeat(65) }, // over 64-char limit
    ];
    const r = validateBody("user_favorites", "INSERT", rows, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("array: wallet mismatch on any row rejects the batch", () => {
    const rows = [
      { wallet: WALLET_A, token_id: "1" },
      { wallet: WALLET_B, token_id: "2" },
    ];
    const r = validateBody("user_favorites", "INSERT", rows, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("wallet mismatch");
  });

  it("array: rejects a batch of >200 rows", () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      wallet: WALLET_A, token_id: String(i),
    }));
    const r = validateBody("user_favorites", "INSERT", rows, CLAIMS_A);
    expect(r.ok).toBe(false);
  });
});

describe("validateBody — user_watchlist", () => {
  it("accepts a valid INSERT with optional fields", () => {
    const row = {
      wallet: WALLET_A, token_id: "123", target_price: 0.5, note: "cheap",
    };
    const r = validateBody("user_watchlist", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("rejects negative target_price", () => {
    const row = { wallet: WALLET_A, token_id: "123", target_price: -1 };
    const r = validateBody("user_watchlist", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects infinite target_price", () => {
    const row = { wallet: WALLET_A, token_id: "123", target_price: Infinity };
    const r = validateBody("user_watchlist", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects oversize note (501 chars)", () => {
    const row = { wallet: WALLET_A, token_id: "1", note: "x".repeat(501) };
    const r = validateBody("user_watchlist", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });
});

describe("validateBody — votes", () => {
  it("accepts a valid insert", () => {
    const row = { wallet: WALLET_A, token_id: "42", week: "2026-W16" };
    const r = validateBody("votes", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("rejects malformed week", () => {
    const row = { wallet: WALLET_A, token_id: "42", week: "2026-04-19" };
    const r = validateBody("votes", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("rejects week with wrong prefix", () => {
    const row = { wallet: WALLET_A, token_id: "42", week: "W2026-16" };
    const r = validateBody("votes", "INSERT", row, CLAIMS_A);
    expect(r.ok).toBe(false);
  });
});

// AUDIT SIWE-RESTORE: these three used to assert the FAIL-OPEN contract
// (`ok: true`, body forwarded unvalidated). That contract was the defect —
// nothing gates the (table, method) PAIR, so an unmapped method skipped the
// strict schema, the length bounds AND the JWT ownership refinement. The
// schema map is now itself the allowlist; these assertions are inverted to
// match. Deeper coverage lives in proxy-schemas-failclosed.test.js.
describe("validateBody — fail-closed cases", () => {
  it("unknown table is rejected", () => {
    const r = validateBody("unknown_table", "INSERT", { x: 1 }, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("DELETE has no schema entry — rejected", () => {
    const r = validateBody("messages", "DELETE", undefined, CLAIMS_A);
    expect(r.ok).toBe(false);
  });

  it("messages has no UPDATE entry — rejected", () => {
    const r = validateBody("messages", "UPDATE", { text: "x" }, CLAIMS_A);
    expect(r.ok).toBe(false);
  });
});

describe("validateBody — dm_messages", () => {
  const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const validDm = {
    sender: WALLET_A,
    recipient: WALLET_B,
    channel_key: key(WALLET_A, WALLET_B),
    text: "gm — about that trade",
  };

  it("accepts a valid DM from the JWT wallet", () => {
    const r = validateBody("dm_messages", "INSERT", validDm, CLAIMS_A);
    expect(r.ok).toBe(true);
  });

  it("accepts an attached trade_id uuid and rejects a non-uuid", () => {
    const ok = validateBody("dm_messages", "INSERT", { ...validDm, trade_id: "123e4567-e89b-42d3-a456-426614174000" }, CLAIMS_A);
    expect(ok.ok).toBe(true);
    const bad = validateBody("dm_messages", "INSERT", { ...validDm, trade_id: "not-a-uuid" }, CLAIMS_A);
    expect(bad.ok).toBe(false);
  });

  it("rejects sender forgery (sender != JWT wallet)", () => {
    const r = validateBody("dm_messages", "INSERT", { ...validDm, sender: WALLET_B, recipient: WALLET_A, channel_key: key(WALLET_A, WALLET_B) }, CLAIMS_A);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sender mismatch/);
  });

  it("rejects self-DMs and wrong channel keys", () => {
    const self = validateBody("dm_messages", "INSERT", { ...validDm, recipient: WALLET_A, channel_key: key(WALLET_A, WALLET_A) }, CLAIMS_A);
    expect(self.ok).toBe(false);
    const wrongKey = validateBody("dm_messages", "INSERT", { ...validDm, channel_key: `${WALLET_B}_${WALLET_A}` }, CLAIMS_A);
    expect(wrongKey.ok).toBe(false);
  });

  it("rejects oversize text and unknown columns", () => {
    const big = validateBody("dm_messages", "INSERT", { ...validDm, text: "x".repeat(501) }, CLAIMS_A);
    expect(big.ok).toBe(false);
    const extra = validateBody("dm_messages", "INSERT", { ...validDm, admin: true }, CLAIMS_A);
    expect(extra.ok).toBe(false);
  });

  it("UPDATE allows only read_at (mark-read)", () => {
    const ok = validateBody("dm_messages", "UPDATE", { read_at: "2026-06-10T10:00:00Z" }, CLAIMS_A);
    expect(ok.ok).toBe(true);
    const bad = validateBody("dm_messages", "UPDATE", { text: "edited!" }, CLAIMS_A);
    expect(bad.ok).toBe(false);
  });
});
