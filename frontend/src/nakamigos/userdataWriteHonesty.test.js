/**
 * TRIPWIRE — a new direct anon-key mutation in userdata.js must fail here.
 *
 * Supabase migration 015 §1 DROPs the permissive `qual = true` write policies
 * on user_profiles, user_favorites, user_watchlist and votes. Once it runs,
 * the surviving owner-scoped policies compare `wallet` to the SIWE JWT claim,
 * which the browser's anon key does not carry — so ANY direct anon-key write
 * from this file is refused with SQLSTATE 42501. `castVote` was the last one:
 * it returned `!error`, i.e. a bare `false` on denial, and the UI had no error
 * path, so a vote silently evaporated. That is the exact regression this file
 * exists to prevent from coming back.
 *
 * Behaviour lives in lib/userdata.test.js. This is the source-level guard, in
 * the shape the repo already uses for invariants (see
 * lib/rpcProvider.callers.test.js).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Strip comments so that *documenting* a forbidden call (this file's own
 * header does it, and userdata.js carries the whole CREATE POLICY docblock)
 * is never what fails the guard. Only live code is scanned.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const USERDATA = read("./lib/userdata.js");
const CODE = stripComments(USERDATA);

// PostgREST's mutating verbs as the supabase-js client spells them.
const ANON_MUTATION = /\.\s*(insert|upsert|update|delete|rpc)\s*\(/;

const OWNED_TABLES = ["user_profiles", "user_favorites", "user_watchlist", "votes"];

describe("userdata.js performs NO direct anon-key mutation (migration 015 §1)", () => {
  it("calls no mutating verb on the Supabase client", () => {
    const hit = CODE.match(new RegExp(ANON_MUTATION.source, "g"));
    expect(
      hit,
      "A mutating PostgREST verb appeared in userdata.js. After migration 015 §1 " +
        "the anon key cannot write these tables — RLS refuses with 42501 and the " +
        "failure is invisible. Route it through proxyWrite/proxyRpc from " +
        "lib/supabaseProxy.js instead (the proxy attaches the SIWE JWT server-side).",
    ).toBeNull();
  });

  it("imports proxyWrite and uses it for all four owner-scoped tables", () => {
    expect(CODE).toMatch(/import\s*\{[^}]*proxyWrite[^}]*\}\s*from\s*["']\.\/supabaseProxy["']/);
    const targets = new Set([...CODE.matchAll(/table:\s*"([^"]+)"/g)].map((m) => m[1]));
    for (const table of OWNED_TABLES) {
      expect([...targets], `${table} has no proxyWrite call`).toContain(table);
    }
  });

  it("names no table the server proxy would reject", () => {
    const proxy = read("../../api/supabase-proxy.js");
    const allowed = (proxy.match(/const ALLOWED_TABLES = \[([^\]]*)\]/)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(allowed.length).toBeGreaterThan(0); // guards the parse

    for (const table of [...CODE.matchAll(/table:\s*"([^"]+)"/g)].map((m) => m[1])) {
      expect(allowed, `${table} is not in the proxy's ALLOWED_TABLES`).toContain(table);
    }
  });

  it("still READS through the anon client — 015 §2 is deferred, not done here", () => {
    // Guards the guard: deleting the feature must not be a way to pass. Reads
    // stay on the anon key by design; only writes moved.
    expect(CODE).toMatch(/import\s*\{[^}]*supabase[^}]*\}\s*from\s*["']\.\/supabase["']/);
    expect(CODE).toMatch(/\.select\(/);
    for (const table of OWNED_TABLES) {
      expect(CODE, `${table} lost its read path`).toContain(`.from("${table}")`);
    }
  });
});

describe("no mutation reports failure as a bare boolean", () => {
  it("userdata.js returns no bare `false` from a write path", () => {
    // `return false` is the silent-failure shape: indistinguishable from
    // "nothing needed changing". Every mutator returns { ok, status } instead.
    expect(
      /\breturn\s+false\s*;/.test(CODE),
      "A write path returned a bare `false`. Return a { ok, status } result " +
        "(SYNC_STATUS) so the caller can tell denied from not-signed-in from network.",
    ).toBe(false);
  });

  it("exports the discriminated status set and the toast mapper", () => {
    expect(CODE).toMatch(/export const SYNC_STATUS/);
    expect(CODE).toMatch(/export function syncFailureToast/);
    for (const status of ["ok", "local-only", "needs-auth", "denied", "network"]) {
      expect(CODE, `SYNC_STATUS is missing "${status}"`).toContain(`"${status}"`);
    }
  });
});

describe("every caller surfaces the failure to the user", () => {
  // A named result nobody reads is the same silence with more steps. Each
  // surface that mutates user data must map the result to a toast.
  const CALLERS = [
    ["./components/EditProfile.jsx", "profile save"],
    ["./App.jsx", "favourite toggle + background favourites sync"],
    ["./components/Watchlist.jsx", "watchlist add/remove/note/target + background sync"],
  ];

  it.each(CALLERS)("%s reports sync failures (%s)", (rel) => {
    const src = stripComments(read(rel));
    expect(src).toMatch(/syncFailureToast\s*\(/);
    expect(src).toMatch(/addToast/);
  });

  it("EditProfile no longer treats the result as a bare boolean", () => {
    const src = stripComments(read("./components/EditProfile.jsx"));
    // The old shape was `const synced = await saveProfile(...); if (synced)`,
    // which is now ALWAYS truthy and would silently re-lie.
    expect(src).not.toMatch(/if\s*\(\s*synced\s*\)/);
  });
});
