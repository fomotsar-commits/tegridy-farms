// AUDIT API-M8: per-table Zod validation for the Supabase write-proxy.
//
// This is a defense-in-depth layer — the primary security boundary for
// user-generated-content tables is RLS at PostgREST. This module adds an
// *earlier* rejection for:
//
//   1. Unknown/misspelled columns (strict object schemas).
//   2. Oversize strings (max length bounds matching the Supabase schema).
//   3. Wallet-impersonation in writable rows (wallet/author MUST match the
//      JWT's wallet claim). Today RLS is the enforcer; tomorrow a policy
//      regression would leak only the rows the attacker's JWT can already
//      see, rather than arbitrary rows. Belt-and-suspenders.
//
// The validator returns { ok: true, data } or { ok: false, error }. The
// error string is deliberately generic — we don't want to leak schema or
// constraint names client-side. The caller is expected to JSON-stringify
// `data` on the happy path (so we normalize defaults and coerce).
//
// Row-schemas below are the source of truth for what the proxy will
// forward. If you add a new column to one of these tables in Supabase,
// you MUST extend the matching schema here or the column will be rejected
// as unknown.

import { z } from "zod";

// Reusable atoms
const wallet = z.string().regex(/^0x[a-f0-9]{40}$/);

// Row schemas (strict — unknown fields rejected)
const messages = z.object({
  author: wallet,
  text: z.string().min(1).max(280),
  slug: z.string().max(64),
  token_id: z.string().max(64).nullable().optional(),
}).strict();

const user_profiles = z.object({
  wallet: wallet,
  display_name: z.string().max(32).nullable().optional(),
  bio: z.string().max(160).nullable().optional(),
  twitter: z.string().max(40).nullable().optional(),
  avatar_url: z.string().url().max(512).nullable().optional(),
  updated_at: z.string().datetime().optional(),
}).strict();

const user_favorites = z.object({
  wallet: wallet,
  token_id: z.string().max(64),
  collection_slug: z.string().max(64).default("nakamigos"),
}).strict();

const user_watchlist = z.object({
  wallet: wallet,
  token_id: z.string().max(64),
  collection_slug: z.string().max(64).default("nakamigos"),
  target_price: z.number().finite().nonnegative().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
}).strict();

const votes = z.object({
  wallet: wallet,
  token_id: z.string().max(64),
  week: z.string().regex(/^\d{4}-W\d{2}$/),
}).strict();

// Accept single row or array of rows. The typical writer for
// user_favorites/user_watchlist upserts an array of selections in one call.
// Max 200 keeps a malicious client from burning a full request budget on
// one call while remaining comfortably above realistic use.
const arrayable = (row) => z.union([row, z.array(row).max(200)]);

const TABLE_SCHEMAS = {
  messages: {
    INSERT: arrayable(messages),
  },
  user_profiles: {
    INSERT: arrayable(user_profiles),
    UPSERT: arrayable(user_profiles),
    // UPDATE can be a partial row; wallet is still required so the JWT-
    // ownership check below has something to compare against.
    UPDATE: arrayable(user_profiles.partial().extend({ wallet })),
  },
  user_favorites: {
    INSERT: arrayable(user_favorites),
    UPSERT: arrayable(user_favorites),
  },
  user_watchlist: {
    INSERT: arrayable(user_watchlist),
    UPSERT: arrayable(user_watchlist),
  },
  votes: {
    INSERT: arrayable(votes),
    UPSERT: arrayable(votes),
  },
};

/**
 * Validate a proxy write-body against the per-table schema and enforce
 * JWT-ownership on wallet/author fields.
 *
 * @param {string} table - the already-allowlisted Supabase table name
 * @param {"INSERT"|"UPSERT"|"UPDATE"|"DELETE"} method
 * @param {unknown} body - the row (or array of rows) the client posted
 * @param {{ wallet?: string }} jwtClaims - claims decoded from siwe_jwt
 * @returns {{ ok: true, data: unknown } | { ok: false, error: string }}
 */
export function validateBody(table, method, body, jwtClaims) {
  const tableSchema = TABLE_SCHEMAS[table];
  // Unknown table — upstream will reject via the allowlist already checked
  // in the proxy. Don't double-fail here.
  if (!tableSchema) return { ok: true, data: body };

  const methodSchema = tableSchema[method];
  // Method not in schema map (e.g., DELETE which has no body). Pass through.
  if (!methodSchema) return { ok: true, data: body };

  const parsed = methodSchema.safeParse(body);
  if (!parsed.success) {
    // AUDIT API-M8: don't leak Zod issue paths or structural info to the
    // client. The server log can carry the detail; the response cannot.
    return { ok: false, error: "Invalid payload shape" };
  }

  // JWT-ownership refinement: any row carrying a wallet/author field MUST
  // match the JWT's wallet claim. This prevents forging writes as another
  // user even if RLS were momentarily mis-configured.
  const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const claimWallet = (jwtClaims?.wallet || "").toLowerCase();
  for (const row of rows) {
    if (row.wallet && row.wallet.toLowerCase() !== claimWallet) {
      return { ok: false, error: "wallet mismatch" };
    }
    if (row.author && row.author.toLowerCase() !== claimWallet) {
      return { ok: false, error: "author mismatch" };
    }
  }

  return { ok: true, data: parsed.data };
}
