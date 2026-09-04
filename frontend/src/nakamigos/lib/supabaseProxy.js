/**
 * Shared client for the SIWE write proxy (/api/supabase-proxy).
 *
 * Supabase RLS hides writes from the anon key — the SIWE JWT lives in an
 * httpOnly cookie the client JS can't read. This proxy POSTs with
 * `credentials: "include"` so the cookie travels server-side, where the proxy
 * attaches it as the Authorization header and PostgREST applies RLS / auth.jwt()
 * scoped to the authenticated wallet. (DMs already use this exact pattern in
 * lib/dm.js; this generalises it for chat sends, likes/reactions, and userdata.)
 *
 * Throws `err.needsAuth === true` on 401 so callers can prompt SIWE sign-in.
 */
const PROXY = "/api/supabase-proxy";

async function proxyCall(payload) {
  const res = await fetch(PROXY, {
    method: "POST",
    credentials: "include", // the SIWE httpOnly cookie
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    const err = new Error("Sign-in required");
    err.needsAuth = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Proxy ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Table write (INSERT / UPSERT / UPDATE / DELETE). Returns PostgREST's response. */
export function proxyWrite({ table, method, body, match }) {
  return proxyCall({ table, method, body, match });
}

/**
 * Owner-scoped table READ.
 *
 * AUDIT FIX TF-004 / TF-007. The anon key cannot carry a wallet claim — the
 * SIWE JWT is in an httpOnly cookie client JS can never read — so an
 * owner-scoped RLS policy can only ever match on a request that went through
 * this proxy. Reading personal rows (a watchlist, a favourites list) with the
 * anon key therefore requires a `USING (true)` policy, which is exactly the
 * policy that publishes EVERY wallet's rows to anyone holding the key.
 *
 * Moving the read here is what makes dropping that policy possible without
 * turning the feature into a silent zero. `match` is required server-side —
 * there are no table scans through this path.
 *
 * Returns rows on success. Throws with `err.needsAuth === true` when the
 * caller has no SIWE session, which is the honest answer: without a proven
 * wallet nobody can be shown that wallet's rows.
 */
export function proxyRead({ table, match }) {
  return proxyCall({ table, method: "SELECT", match });
}

/** RPC call — the proxy injects the JWT-verified wallet into `args`. */
export function proxyRpc(fn, args = {}) {
  return proxyCall({ method: "RPC", fn, args });
}

/** PostgREST returns an array for table writes; unwrap the single row. */
export function firstRow(data) {
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}
