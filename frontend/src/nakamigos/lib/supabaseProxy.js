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

/** RPC call — the proxy injects the JWT-verified wallet into `args`. */
export function proxyRpc(fn, args = {}) {
  return proxyCall({ method: "RPC", fn, args });
}

/** PostgREST returns an array for table writes; unwrap the single row. */
export function firstRow(data) {
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}
