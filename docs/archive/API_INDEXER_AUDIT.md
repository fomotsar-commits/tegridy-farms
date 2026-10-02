# API + Indexer Audit

**Scope:** `frontend/api/**` (8 Vercel serverless functions) + `indexer/` (Ponder configuration + event handlers)
**Date:** Apr 17, 2026
**Methodology:** 3 parallel specialist agents produced raw findings; every claim spot-checked against the actual source before classification here. Agent output is preserved in session logs; this document is my own triage.

---

## Calibration note

Agent findings were a mix of real issues, defensive-hardening ideas framed as bugs, and outright false-positives that misread library APIs. Example: one agent flagged `siweMessage.verify()` as not validating signature recovery — it does (that is the library's entire job). Another flagged a public `llamarpc.com` endpoint in an `.env.local.example` file as a CRITICAL secret leak — it's a public RPC with no key.

Each finding below has been verified against code. Severity reflects my classification, not the originating agent's.

---

## Real findings, ranked

### HIGH

**API-H1 — SIWE signature lacks explicit freshness enforcement**
File: `frontend/api/auth/siwe.js:163`
The `siweMessage.verify({ signature })` call passes no time options, so freshness depends entirely on whether the message itself includes `expirationTime` / `notBefore`. The server only validates nonce expiry (L154), not message expiry. A client can construct a SIWE message with no `expirationTime` and replay it until the nonce is used (the nonce check is single-use so this is bounded, but a message signed 24 hours ago is still accepted if its nonce is presented first).
Fix: pass explicit time parameters to `verify`:
```js
verifyResult = await siweMessage.verify({
  signature,
  time: new Date().toISOString(),
  domain: allowedDomain,
  nonce: siweMessage.nonce,
});
```
This also strengthens domain binding (currently checked separately at L134).

**API-H2 — JWT algorithm not pinned on verify**
File: `frontend/api/auth/me.js:51`
`jwtVerify(token, secret, { issuer, audience })` does not pin `algorithms`. `jose` v5 defaults rule out `none` but explicit pinning defends against algorithm-confusion attacks if the secret is ever reused across a HS256/RS256 boundary.
Fix: add `algorithms: ['HS256']` to the options object.

**INDEXER-H1 — Zero-address placeholder user rows pollute user-scoped queries**
File: `indexer/src/index.ts` (LockExtended, AmountIncreased handlers)
Handlers for stateless-position events insert `user = "0x0000000000000000000000000000000000000000"` as a default because the event payload has no user field. Downstream queries like "actions by user X" see clean results, but "all unique users" or "aggregate user counts" see a phantom zero-address user. Reconstructs of user timelines from the indexer are thus contaminated.
Fix: either (a) don't insert a row for these events (update the existing position by tokenId instead) or (b) resolve `user = IERC721(tegridyStaking).ownerOf(tokenId)` via a contract read inside the handler. (a) is simpler.

**INDEXER-H2 — Idempotency not enforced via `event.log.id` primary key**
File: `indexer/src/index.ts` (all insert handlers)
Ponder replays events on reorgs, but the handlers use synthetic keys (txHash + tokenId + index) rather than the canonical `event.log.id`. Re-indexing the same block range can produce duplicate rows if the synthetic key construction ever drifts from Ponder's view of event identity.
Fix: use `event.log.id` as the primary key for action/event tables; use `.onConflictDoNothing()` on inserts. Ponder's own docs recommend this pattern.

### MEDIUM

**API-M1 — Rate limit headers are cosmetic (not enforced)**
Files: `alchemy.js:17-23`, `opensea.js:14-17`, `orderbook.js:109-112`
Every proxy emits `X-RateLimit-*` headers with hardcoded numbers. No actual per-IP or per-wallet bucket exists. A client can spam any of these endpoints up to Vercel's default concurrency. Since the proxies pass through Alchemy / OpenSea / your own DB, the practical impact is a small DoS + real-money cost accrual on the upstream paid services.
Fix: implement per-IP rate limiting via Vercel Edge Middleware + Upstash Redis (or similar). Until then, at minimum delete the misleading headers so operators aren't lulled by them.

**API-M2 — `supabase-proxy.js` filter value interpolation permits operator-prefix smuggling**
File: `frontend/api/supabase-proxy.js:78,88`
Line 78/88: `params.set(key, `eq.${value}`)`. PostgREST parses values after the first operator prefix literally, so `eq.neq.0xdead` behaves as an equality on the literal string "neq.0xdead" — not as an inequality. **The RLS layer on Supabase is the real defence and it still works**, but the proxy should not accept values containing PostgREST meta-characters like `(`, `)`, `,`, `*` — future PostgREST versions could treat combinations as operators.
Fix: reject any value that is not `/^[0-9a-zA-Z_.-]{1,256}$/` before interpolation. Document that RLS is the authoritative authorization layer.

**API-M3 — Supabase JWT expiry not sanity-checked at the proxy before forwarding**
File: `frontend/api/supabase-proxy.js:30`
The cookie is extracted and forwarded as-is. If JWT is expired, Supabase returns 401 and the proxy passes it through. This is correct behaviour but leaks zero information about whether the session is dead vs the request is bad.
Fix (optional): verify JWT at proxy, short-circuit with a clean 401 + `clear-cookie` header on expiry so the client knows to re-auth.

**API-M4 — Upstream error-status passthrough discloses infrastructure state**
Files: `alchemy.js:241`, `opensea.js:168`, `etherscan.js:84`, `supabase-proxy.js:106`
All four pass upstream HTTP status + body through verbatim. A client can tell "upstream is 401 (our API key is revoked)" vs "upstream is 502 (their service is down)" — useful signal for attackers enumerating infrastructure.
Fix: collapse all upstream 5xx / upstream-auth failures to a single opaque 500 `{error: "Upstream service error"}`. Log the real status server-side for ops.

**API-M5 — `opensea.js` path validation doesn't decode before whitelist check**
File: `frontend/api/opensea.js:33-55`
`path.includes("%2e")` + `"%2E"` catches double-encoded traversal but not single-encoded characters inside the whitelist check. If OpenSea (or its path router) URL-decodes on receipt, a request with `/offers%2F..%2Fadmin` passes the prefix whitelist and decodes server-side.
Fix: `const decoded = decodeURIComponent(path); if (decoded.includes('..') || decoded !== path) return 400;` before any prefix check.

**API-M6 — `etherscan.js` block range unbounded**
File: `frontend/api/etherscan.js:74`
`startblock` / `endblock` are forwarded verbatim. A client can request the entire chain history and burn our Etherscan quota.
Fix: `if (endblock - startblock > 10_000) return 400;`.

**API-M7 — Fill-event verification in `orderbook.js` doesn't pin Seaport address**
File: `frontend/api/orderbook.js:411-443`
When `fill` is called with a transaction hash, the endpoint fetches the receipt and checks logs for an `OrderFulfilled` topic. It does not verify `log.address === SEAPORT_ADDRESS`. A malicious contract that emits the same event topic signature from its own address could produce a passing "fill" record.
Fix: `if (log.address.toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) continue;` in the log-scan loop.

**API-M8 — CORS `Access-Control-Allow-Credentials: true` on auth endpoints**
File: `frontend/api/auth/siwe.js:43`
Credentialed requests are allowed from every origin in `ALLOWED_ORIGINS`. If any one of those origins is ever compromised (XSS on the listed domains), it can exfiltrate the SIWE cookie. The defence is (a) keep the allowlist tight, (b) prefer `Authorization` header with explicit bearer over cookie if feasible.
Fix: documented trade-off — current stance is correct for a browser SPA but worth revisiting post-launch.

**INDEXER-M1 — `ponder.config.ts` has no explicit RPC timeout or fallback URL list**
File: `indexer/ponder.config.ts:320-322`
Transport uses a single URL from env with no timeout. A hung RPC call can stall indexer sync indefinitely.
Fix: use viem's `http(url, { timeout: 30_000, retryCount: 3 })` and pass multiple RPC URLs when available.

**INDEXER-M2 — Missing handlers for ClaimedBonus, ClaimedBase, BribeClaimed, ProposalVoted**
Files: `indexer/src/index.ts:224-225,286,453`
Several claim / vote events are deposited but never indexed. Downstream queries (user reward totals, vote history) silently return incomplete data.
Fix: add tables + handlers. Low-risk additive change.

**INDEXER-M3 — Addresses stored as generic `hex()` text, not typed**
File: `indexer/ponder.schema.ts` (address fields across 20+ tables)
Generic hex text allows mixed-case and non-address strings; queries must normalise on both write and read.
Fix: either constrain in schema (if Ponder supports) or enforce lowercase-on-write in a helper applied to every insert. Document the convention.

### LOW / INFO

- **API-L1** `frontend/api/siwe.js:55` — cookie-secure logic between `buildAuthCookie` and `buildClearAuthCookie` is slightly asymmetric. Cosmetic; production path is correct.
- **API-L2** `frontend/api/orderbook.js:323` — `params.salt = randomUUID()` when omitted. Client could rely on server-generated salt rather than its own. Document that explicit salt is recommended but not required.
- **API-L3** `frontend/api/opensea.js` — if `OPENSEA_API_KEY` is unset the proxy passes through without auth. Should fail closed with 503 rather than silently hammer OpenSea's anonymous quota.
- **API-L4** `frontend/api/v1/index.js:13` — if `ALCHEMY_API_KEY` is unset the code path falls back to "demo". Fail closed.
- **INDEXER-L1** `indexer/.env.local.example` — uses `https://eth.llamarpc.com`. This is a public endpoint with no credential; not a secret. Agent flagged this as CRITICAL; it's at most a stylistic note that examples should use placeholders. Classified LOW/INFO.
- **INDEXER-L2** `indexer/package.json:13` — `ponder: ^0.8.30`. Caret allows auto-upgrade of minor versions. Pin exact for reproducibility.

---

## False positives (agent flagged, verified as non-issues)

| Agent ID | Claim | Why it's wrong |
|---|---|---|
| S-001 (CRITICAL) | `SiweMessage.verify()` doesn't validate signature recovery | It does — that is exactly what the library exists to do. `verifyResult.success === true` means the recovered address matches `siweMessage.address`. |
| S-003 (HIGH) | SIWE statement/version not validated | The siwe library rejects non-`1` versions internally. Statement is optional per EIP-4361. |
| S-004 (MEDIUM) | Nonce issuance-time TTL not enforced | Line 154 literally checks `new Date(nonceRow.expires_at) < new Date()`. |
| S-007 (LOW) | No CSRF defence on nonce GET | Nonces are single-use + short-lived + only useful when paired with a valid signature of a message containing the same nonce. Enumeration is harmless. |
| PON-020 (CRITICAL) | "RPC URL is public; no sensitivity on secrets file" | The example file contains `https://eth.llamarpc.com`, a public no-auth endpoint. Not a secret. |
| OB-004 (INFO) | Seaport domain separator not verified | The orderbook endpoint recovers signatures from a custom auth message, not from a Seaport order. EIP-712 verification happens on-chain when Seaport itself processes the fill. |

---

## Recommended remediation order

**Next batch (self-contained, low risk):**
1. API-H1 (SIWE explicit freshness)
2. API-H2 (JWT alg pinning)
3. API-M4 (collapse upstream errors)
4. API-M5 (`opensea.js` decode-then-check)
5. API-M6 (etherscan block-range cap)
6. API-M7 (orderbook: pin Seaport address in log scan)

**Following batch (needs infra choice):**
7. API-M1 — real rate-limiting. Choose Upstash vs Vercel Edge Config first.

**Indexer batch:**
8. INDEXER-H1 (zero-address rows), INDEXER-H2 (`event.log.id` PK), INDEXER-M1 (RPC timeout), INDEXER-M2 (missing handlers)

---

*End of API / indexer audit.*
