# Audit 077 — Ratelimit + Proxy Schemas

Auditor: Agent 077 / 101
Targets:
- `frontend/api/_lib/ratelimit.js`
- `frontend/api/_lib/proxy-schemas.js`
- `frontend/api/__tests__/supabase-proxy.test.js`
Date: 2026-04-25
Mode: AUDIT-ONLY (no code modifications)

## Scope checklist

| Hunt item | Status |
|---|---|
| X-Forwarded-For trusted blindly (IP spoofing) | FINDING (HIGH) |
| Per-user vs per-IP confusion (NAT collapse) | FINDING (MEDIUM) |
| In-memory store on serverless (cold-start reset) | OK (Upstash backed) |
| Key collision between paths | FINDING (MEDIUM) |
| TTL drift / sliding-window correctness | OK |
| Rate-limit absent on auth endpoints | FINDING (LOW — `/auth/me` only) |
| Lua-script race in upstash | OK (delegated to library) |
| Zod loose-object — missing required fields | OK (`.strict()` everywhere) |
| Schema string → SSRF in downstream call | OK (no URL passed downstream) |
| Depth-limit absent (deeply nested JSON DoS) | FINDING (HIGH) |
| Log injection via unsanitized input | FINDING (LOW) |

Total findings: **6** (1 HIGH-leaning HIGH, 1 HIGH on DoS, 2 MEDIUM, 2 LOW)

---

## HIGH-01 — X-Forwarded-For trusted unconditionally → rate-limit bypass via spoofed header

`ratelimit.js:81-87`

```js
function extractIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  return 'unknown';
}
```

Comment claims "Vercel's edge strips them on ingress" — that is true for the
*outermost* hop only. An attacker sending `X-Forwarded-For: 1.2.3.4, real-ip`
gets Vercel to **append** the actual client IP to the header, but the proxy
takes `[0]` — i.e. the attacker-controlled value. Vercel itself documents this:
the *correct* IP for trust purposes is the **last** value in XFF or
`request.ip` / `x-real-ip` (which Vercel rewrites). Using `[0]` lets any
attacker rotate IPs per request and never hit the per-IP cap.

**Impact**: 20 writes/min/IP on `supabase-proxy` and 10/min on
`siwe-nonce`/`siwe-verify` are bypassable to **unbounded** by sending
`X-Forwarded-For: <random-ipv4>` per request. SIWE nonce-flooding +
verify-bombing become trivially feasible.

**Recommendation**: Use Vercel's `request.ip` (which is set after Vercel's
edge strips client-supplied XFF), or read the **last** entry of XFF, not the
first. Equivalent libraries: `@vercel/functions` `geolocation()` / `ipAddress()`.

Severity: **HIGH** (auth + write throttles bypassable)

---

## HIGH-02 — No body-size or depth-limit on JSON parsing → DoS via nested JSON

`supabase-proxy.js:49-50` reads `req.body` directly with no size cap, no
depth limit, and no key-count limit. Vercel's Node runtime defaults to 4.5 MB
on the body parser, but a 4 MB payload of the form `{"a":{"a":{"a":...}}}`
nested 100k deep:

1. `req.body` is parsed by Vercel before the handler runs (Zod can't intercept).
2. The Zod schemas use `.strict()` but **none use** `.deepStrict()` *behavior
   beyond top-level* — the array path `arrayable(row).max(200)` covers
   array-cardinality but not nesting within a row.
3. `JSON.stringify(body)` (line 135) re-serializes a deeply-nested input,
   doubling memory + CPU.

The schemas only define **leaf** types (`z.string`, `z.number`), so a
sufficiently-large nested object on a row field that Zod will eventually
reject still hits the Vercel parser and the Zod walker before rejection.
Combined with HIGH-01, an unthrottled attacker can submit 4 MB nested-JSON
payloads at unlimited rate per cold serverless instance.

**Recommendation**:
1. Add `export const config = { api: { bodyParser: { sizeLimit: '32kb' } } };`
   to `supabase-proxy.js`.
2. Reject any request whose `Content-Length` header > N before parsing.
3. Cap nesting depth (a custom Zod refinement at `arrayable` boundary).

Severity: **HIGH** (DoS amplification)

---

## MEDIUM-03 — Per-IP keying collapses NAT'd users into one bucket; key never includes wallet

`ratelimit.js:120-121`:

```js
const ip = extractIp(req);
const key = `${ip}`;
```

For SIWE-authenticated endpoints (the supabase-proxy gate), the JWT carries
the wallet — keying on IP is strictly weaker than keying on `wallet || ip`.
Two NAT'd users (corporate / mobile carrier / shared Wi-Fi / Tor exit) cannot
collectively post more than 20 messages/min. Fixing HIGH-01 makes this worse:
once the IP can no longer be spoofed, a public Wi-Fi user can DoS every
co-located wallet.

For unauthenticated endpoints (nonce), per-IP is correct. For authenticated
write endpoints, key should be wallet+identifier, not IP+identifier.

**Recommendation**: Accept an optional `keyOverride` arg (or `req.user?.wallet`)
in `checkRateLimit` and prefer it over the IP for endpoints that have already
authenticated.

Severity: **MEDIUM**

---

## MEDIUM-04 — Limiter cache key + Redis prefix mean collision risk on `identifier` reuse

`ratelimit.js:67, 74`:

```js
const key = `${identifier}:${limit}:${windowSec}`;
...
prefix: `tegridy:${identifier}`,
```

The `limiterCache` in-process Map keys on `identifier:limit:windowSec`, but
the **Redis prefix** is just `tegridy:${identifier}`. Two endpoints declaring
the same `identifier` with **different `limit`/`windowSec` tuples** (e.g.
caller error, a misnamed copy-paste) will share Redis state — the `Ratelimit`
instance with the smaller window will reset the larger window's counter and
vice-versa. The local cache treats them as different limiters, so both
co-exist in process and silently corrupt each other's counts in Redis.

Today there is no collision (`alchemy` / `supabase-proxy` / `siwe-nonce` /
`siwe-verify` are unique), but this is a foot-gun that future endpoints will
trip.

**Recommendation**: Make the Redis prefix include `${limit}:${windowSec}`
or treat identifier-reuse as an error.

Severity: **MEDIUM** (latent)

---

## LOW-05 — `/api/auth/me` is unrate-limited

`auth/me.js` reads the cookie, calls `jwtVerify`, then a Supabase
`revoked_jwts` lookup — **no `checkRateLimit` import**, no call. This is the
endpoint the frontend polls, but it also means an unauthenticated attacker
can hammer it with random/invalid JWTs at unbounded rate. Each invalid token
costs a Supabase round-trip (line 80). Combined with HIGH-01 there's nothing
gating the Supabase quota burn from this surface.

`siwe.js` rate-limits `nonce` (10/min) and `verify` (10/min); `me` does not.

**Recommendation**: Wrap the GET handler in `checkRateLimit({ limit: 60,
windowSec: 60, identifier: 'auth-me' })`.

Severity: **LOW**

---

## LOW-06 — Log-injection vector via Upstash error message

`ratelimit.js:136`:

```js
console.error('[ratelimit] upstash error:', err?.message ?? err);
```

`err.message` is a string from a network library, but if Upstash ever
echoes attacker-supplied input (the request key includes the IP, which
under HIGH-01 is attacker-controlled), the error message can carry CR/LF
and break log structured-parsing or inject fake log lines into Vercel's
log stream. Same for `proxy-schemas.js` — the Zod issue paths are not
logged here, but they are not sanitized before being thrown to the caller
(error message is "Invalid payload shape" though, so the response side is
fine; the concern is purely the `err?.message` log line).

**Recommendation**: `String(err?.message ?? err).replace(/[\r\n]/g, ' ').slice(0, 500)`
before logging.

Severity: **LOW**

---

## OK / explicit non-findings

- `proxy-schemas.js`: every row schema is `.strict()`, all string fields have
  `.max(N)` bounds, the wallet regex is anchored, the week regex is anchored,
  `.array(row).max(200)` caps batch size, and Zod's default behavior on
  number fields rejects `NaN`/`Infinity` when `.finite()` is used (correctly
  applied on `target_price`).
- `arrayable` accepts single-row OR array-of-rows — both go through the same
  strict schema, no looser variant.
- The supabase-proxy test asserts the validation runs **before** any upstream
  fetch (`expect(fetchMock).not.toHaveBeenCalled()` on every reject path).
- No SSRF in `proxy-schemas.js` — schemas don't carry URLs into downstream
  fetch calls; `avatar_url` is stored, not fetched.
- TTL drift: Upstash `slidingWindow(limit, '${windowSec} s')` is computed
  server-side; no clock skew between handler and Redis is exploitable.
- In-memory store: `limiterCache` is a per-instance optimization, not the
  source of truth — Redis is.

---

## Summary

| # | Severity | Title | File:Line |
|---|----------|-------|-----------|
| 01 | HIGH | XFF[0] trust → rate-limit bypass | ratelimit.js:81-87 |
| 02 | HIGH | No body-size / depth limit on supabase-proxy | supabase-proxy.js:49-50 |
| 03 | MEDIUM | Per-IP key collapses NAT'd users for authed endpoints | ratelimit.js:120 |
| 04 | MEDIUM | identifier-only Redis prefix can collide on tuple-reuse | ratelimit.js:74 |
| 05 | LOW | `/api/auth/me` has no rate-limit | auth/me.js |
| 06 | LOW | Log-injection via unsanitized err.message | ratelimit.js:136 |
