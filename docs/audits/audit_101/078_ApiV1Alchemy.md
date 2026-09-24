# 078 — API Proxy Audit (v1/index.js, alchemy.js, etherscan.js)

Agent 078 — AUDIT-ONLY. Targets:
- `frontend/api/v1/index.js`
- `frontend/api/alchemy.js`
- `frontend/api/etherscan.js`
- (context) `frontend/api/_lib/ratelimit.js`

Hunt categories: API key leak via response, key in URL logged by Vercel, SSRF
(caller-supplied URL to fetch), missing RPC method allow-list, RPC pass-through
of write methods (eth_sendRawTransaction), permissive CORS, missing auth, no
rate-limit, shared edge cache for private data, gzip-bomb DoS, JSON.parse
without try/catch, missing 5xx fallback.

---

## Tally

- HIGH: 4
- MEDIUM: 6
- LOW: 5
- INFO: 4
- Total: 19

## Top-5 (severity-ordered)

### H-1 — Alchemy & Etherscan API keys interpolated into upstream URL (queryable from Vercel logs / SaaS observability)
Files:
- `frontend/api/v1/index.js:14` → `ALCHEMY_NFT = ".../nft/v3/${ALCHEMY_KEY}"`
- `frontend/api/alchemy.js:8-9` → `BASE` and `RPC_BASE` both embed `${ALCHEMY_KEY}` in path
- `frontend/api/etherscan.js:93` → `apikey: ETHERSCAN_KEY` placed in `URLSearchParams` then concatenated into the GET URL at line 101
Why it matters: Alchemy's URL convention puts the key in the **path segment**.
Etherscan's puts it in the **query string**. Both end up in:
- Vercel runtime logs (request URL is logged by default for serverless fn outbound HTTP if any error/timeout middleware ever stringifies the URL — see `console.error("Alchemy non-JSON response:", text.slice(0,200))` at `alchemy.js:248`; if upstream ever returns an HTML page that echoes the request URL, the key is now in our own logs).
- Any future request-mirroring / Datadog / New Relic / Sentry transport.
- `process.env`-leaking error stack traces if Node ever prints `err.stack` (currently masked, but only by `console.error("API v1 error:", err.message)` at `v1/index.js:233` — still risky if a future contributor logs `err`).
- The `URL` object's `.toString()` value, which is what `fetch` uses; if any wrapper (OpenTelemetry, Vercel speed insights instrumentation) auto-traces outbound fetches, the URL — including the key in path/query — is captured.
Mitigation: prefer Alchemy's header-based key (`Authorization: Bearer <key>` is supported on the JSON-RPC endpoint; for NFT v3 use the `g.alchemy.com` URL but rotate keys on a schedule and add log scrubbers). Etherscan supports body-based keys on v2 — migrate. At minimum, redact the URL before any logging; ensure `URL.toString()` is never passed to `console.*`.
Severity: **HIGH**.

### H-2 — `v1/index.js` has NO real rate limit (cosmetic headers only)
Files: `frontend/api/v1/index.js:37-41` (`setRateLimitHeaders` writes static `60/59/+60s` headers but never calls `checkRateLimit`).
Compare: `alchemy.js:92-95` and `etherscan.js:52-55` correctly use the
Upstash sliding-window limiter from `_lib/ratelimit.js`.
Impact: anyone can saturate the v1 API at the speed Vercel will run it,
burning Alchemy quota (Alchemy bills per CU; getNFTSales is ~150 CU; at
Vercel's default ~1k req/min cap a single attacker burns the entire
monthly Alchemy budget in <1h) and OpenSea quota (also called from
`v1/index.js:203-206` with `x-api-key` header — the OpenSea key is also at risk if quota-exhaustion → 429 spamming).
Mitigation: import `checkRateLimit` from `_lib/ratelimit.js` and apply
the same `{ limit: 60, windowSec: 60, identifier: 'v1' }` pattern as
`alchemy.js`. Currently zero protection.
Severity: **HIGH**.

### H-3 — `v1/index.js` has NO body-size guard, NO upstream response-size cap, NO gzip-bomb defense
Files: `frontend/api/v1/index.js:68` (`fetch(url.toString(), {...})` — direct `.json()` consumption with no `Content-Length` check; lines 203-213 same for OpenSea).
`frontend/api/alchemy.js:99-103` has a 10 KB request-body guard but **no
response-size guard** — `await response.text()` (line 243) reads the
**entire** upstream body into memory. Alchemy normally caps responses,
but a compromised / spoofed upstream (or someone tunneling through the
proxy with a malformed endpoint that hits a large debug response) could
return 100 MB and OOM the lambda.
`frontend/api/etherscan.js:104` calls `response.json()` directly — same
exposure: a giant gzip-encoded body decompressing to gigabytes will OOM
or hang the function. (Etherscan supports `gzip` by default; Node's
`fetch` honors `accept-encoding` and auto-decompresses.)
Impact: gzip bomb / memory exhaustion DoS; per-IP rate limit doesn't
help because each request is an independent OOM.
Mitigation: stream the response, count bytes as they arrive, abort
above a sane cap (e.g. 5 MB for NFT JSON, 1 MB for Etherscan tx lists).
At minimum, check `Content-Length` header before reading body and fail
with 502 above threshold.
Severity: **HIGH**.

### H-4 — Shared edge cache (`s-maxage=…`) on RPC response that may carry per-request data
Files: `frontend/api/alchemy.js:144` — RPC proxy sets
`Cache-Control: s-maxage=10, stale-while-revalidate=30` on a JSON-RPC
*response*. Two of the allow-listed methods (`eth_blockNumber`,
`eth_getLogs`) are public, but the issue is the **request_id** in the
JSON-RPC envelope (`{"id": 1, ...}`) is hard-coded. Different callers
get the same response, so the `id` confusion isn't user-bound. However,
**any future addition to `ALLOWED_RPC_METHODS`** (e.g. `eth_call` with
caller-specific `from` / `data`) will silently leak one user's response
to the next via the Vercel edge cache.
Also `frontend/api/v1/index.js:114, 130, 149, 168, 180, 225` set
`s-maxage=15..300` on responses derived from query params that include
`limit`, `slug`, `tokenId`. These are public data, so cache **per
URL** is safe — but the cache key is the URL only by default, **not
including** the `Origin` header. If we ever add an authenticated route
that reads `Authorization`, the response becomes cacheable across
users.
Mitigation: explicitly set `Vary: Origin, Authorization` on cached
responses and add a comment that any per-user route must use
`Cache-Control: private, no-store`. For the RPC route, change to
`private, max-age=10` if any per-caller data ever ships.
Severity: **HIGH** (latent; would become Critical the moment an
authenticated route is added without remembering this).

### H-5 — `eth_getLogs` block-range is unbounded (gzip / quota DoS vector)
Files: `frontend/api/alchemy.js:115-135`. `fromBlock` / `toBlock` are
validated against a hex regex but **no max range** is enforced. A caller
can request `fromBlock=0x0&toBlock=latest` against an active NFT
contract and get back hundreds of MB of logs, blowing through Alchemy
CUs (eth_getLogs is the most expensive method) and triggering H-3's
OOM. Compare with `frontend/api/etherscan.js:82-87` which **does**
enforce `e - s > 10_000 → 400`.
Mitigation: in `alchemy.js` rpc handler, parse `fromBlock`/`toBlock` as
`BigInt`, reject ranges > 10k blocks; reject `latest` paired with `0x0`.
Severity: **HIGH**.

---

## MEDIUM (6)

- **M-1** `frontend/api/v1/index.js:69` `throw new Error("Alchemy ${res.status}")` — error message swallowed by outer catch (line 232) and replaced with generic "Internal error", but the *upstream HTTP status* is opaque to ops. Etherscan handler has the same pattern (`etherscan.js:108`). Recommend `console.error` with full context server-side, generic 5xx to client.
- **M-2** `frontend/api/v1/index.js:79` destructures `req.query` directly. Vercel parses query params as `string | string[]`. If a caller sends `?contract=a&contract=b`, `rawContract` is `["a","b"]` and `isValidAddress` returns false (good), but `slug` could be `["nakamigos","junglebay"]` and `SLUG_TO_CONTRACT[slug]` evaluates to `undefined` → 400 (good). Still, explicitly coerce to string.
- **M-3** `frontend/api/alchemy.js:170` reads `params["contractAddresses[]"]` and `params["contractAddresses%5B%5D"]` — Vercel decodes URL params, but if a client sends both forms only the second is checked. Edge case; unlikely to be exploitable but inconsistent.
- **M-4** `frontend/api/alchemy.js:243-250` JSON-parse fallback is good, but the 200-char `text.slice(0,200)` log can leak the API key if Alchemy's HTML error page echoes the request URL (which Alchemy *does* do in 401/403 pages). Log only `text.slice(0,200)` AFTER scrubbing the key.
- **M-5** `frontend/api/v1/index.js:204` builds OpenSea URL via string interpolation of `${s}` (slug) — `s` is validated against `SLUG_TO_CONTRACT` so safe, but `safeLimit` is concatenated without coercion to int. Currently parsed via `parseInt`, so safe; flagging as fragile.
- **M-6** No `Content-Type` validation on POST body in `alchemy.js`. A client can send `Content-Type: text/html` with a JSON body and Vercel still parses it, but downstream `JSON.stringify(req.body ?? {})` may behave unexpectedly. Not exploitable but adds a quirk.

## LOW (5)

- **L-1** `frontend/api/etherscan.js:33-40` — allow-list includes `getabi` and `getsourcecode`, both of which call `module=contract` not `module=account`. The check at line 66 (`module !== "account" && module !== "contract"`) handles this, but the action allow-list mixes both modules with no per-module gating. Risk is low (Etherscan source is public) but it's defense-in-depth: a malicious actor could spam `getsourcecode` to burn quota.
- **L-2** `frontend/api/alchemy.js:255` 502 fallback logs `text.slice(0,500)` — same key-leak concern as M-4 if the upstream HTML error response echoes the request URL.
- **L-3** `setRateLimitHeaders` in `v1/index.js:37-41` is dead code (cosmetic); should either be deleted or wired to the real limiter.
- **L-4** `frontend/api/v1/index.js:97` `rawContract?.toLowerCase()` returns `undefined` if not an address but a `slug` — fine, but the cascade (`|| (slug && SLUG_TO_CONTRACT[slug]) || null`) silently swallows mismatches. Should be explicit: if both provided and disagree, 400.
- **L-5** No `User-Agent` set on outbound `fetch` to Alchemy / OpenSea / Etherscan. Some upstreams rate-limit harder for missing-UA traffic; not a security issue but operational.

## INFO (4)

- **I-1** `ALLOWED_RPC_METHODS` is correctly read-only (`eth_blockNumber`, `eth_getLogs`). No `eth_sendRawTransaction`, no `admin_*`, no `personal_*`, no `debug_*`. Good.
- **I-2** No SSRF: caller never supplies a URL or hostname. `endpoint` is allow-listed; `contract` is regex-checked + allow-listed; `slug` is allow-listed dictionary lookup. Good.
- **I-3** No auth gate on any of these. By design — they are public read APIs gated by the contract allow-list. Acceptable but means rate-limiting (M-2 H-2) is the *only* line of defense against quota burn.
- **I-4** Etherscan key never appears in error responses (line 108 returns generic "Etherscan proxy error"). Good.

---

## Recommended remediation order
1. H-2 (zero rate limit on v1) — single-line import, biggest blast radius.
2. H-5 (eth_getLogs unbounded range) — copy Etherscan's 10k cap.
3. H-3 (response-size / gzip bomb caps) — add a streaming guard helper in `_lib/`.
4. H-1 (key-in-URL) — migrate to header-auth where supported, scrub logs.
5. H-4 (cache headers) — add `Vary` + comments before someone adds an auth route.
