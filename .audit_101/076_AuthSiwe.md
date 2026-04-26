# Agent 076 — Auth/SIWE Forensic Audit

**Targets:**
- `frontend/api/auth/siwe.js`
- `frontend/api/auth/me.js`
- (supporting) `frontend/api/_lib/ratelimit.js`

**Scope:** SIWE replay, nonce hygiene, domain/uri/chainId validation, EIP-4361 time bounds, statement injection, JWT/session hygiene, cookie flags, CSRF, ENS/address normalization, rate limits.

---

## Summary Counts

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 1     |
| Medium   | 3     |
| Low      | 4     |
| Info     | 4     |
| **Total**| **12**|

---

## Findings

### H-076-1 — `expirationTime` / `notBefore` not server-side enforced when omitted [HIGH]
**File:** `siwe.js:208-218`
**Issue:** `siweMessage.verify({ time, domain, nonce })` validates freshness only when the SIWE message contains an `expirationTime` (and `notBefore`). Per `siwe` library v2 semantics, if the message omits `expirationTime`, the `time` parameter has no expiration to compare against — the message's only freshness binding becomes the server-side single-use nonce (5 min TTL). That nonce TTL is acceptable as a freshness floor, but the server does not *require* `expirationTime` on the message, so a client can submit a SIWE payload that is technically eternal.
**Impact:** A signed message captured after one successful login (e.g. via XSS pre-DOMContentLoaded, MITM on http://localhost in dev, or wallet-side history leak) cannot be replayed because the nonce is consumed atomically before verify (good — `siwe.js:187-200`). The 5-min nonce TTL closes the window. So practical impact is bounded — but defence-in-depth is broken: there is no second time anchor.
**Fix:** Require `siweMessage.expirationTime` to exist and be ≤ now+5min, and require `siweMessage.notBefore` (if present) to be ≤ now. Reject otherwise before verify.
**Status:** Existing nonce-claim-then-verify makes this practically mitigated; flagged HIGH because it's the kind of regression that resurfaces if nonce store is moved/weakened.

---

### M-076-1 — `URI` (`siweMessage.uri`) not validated against allowed origins [MEDIUM]
**File:** `siwe.js:163-168`
**Issue:** Code validates `siweMessage.domain` against the host portion of `ALLOWED_ORIGINS`, but never checks `siweMessage.uri`. Per EIP-4361 §"Verifying the Sign-In with Ethereum message," the verifier SHOULD check that `uri` matches the resource the user intended to authenticate to. A relying party could craft a SIWE message with `domain=tegridyfarms.xyz` (passes) and `uri=https://attacker.example/login` (passes — never inspected). The user's wallet UI will surface the URI; mismatched URI vs domain weakens the user-facing trust signal but the server accepts.
**Impact:** Phishing UX harm: a third party operating a relay could induce users to sign messages whose URI claims a different resource, and our backend accepts. Does not directly compromise our auth (signature still binds to our domain+nonce), but it weakens the audit trail of *what* the user thought they were signing into.
**Fix:** Parse `siweMessage.uri`, take `.host`, require it to be in the allowed-domain set (same set used for `domain` check).

---

### M-076-2 — Origin used for `domain` in verify can be empty (server-trusts-self header) [MEDIUM]
**File:** `siwe.js:164, 207-215`
**Issue:** `originHost` is derived from `req.headers.origin` and passed into `siweMessage.verify({ domain: originHost })`. If `Origin` header is missing (some user agents, curl, server-to-server), `originHost` is `undefined`, and `siwe`'s verify treats `undefined` as "no domain check" — the only domain enforcement collapses to the earlier `allowedDomains.includes(siweMessage.domain)` check (line 166). That earlier check is solid, but the dual binding intended at line 213 becomes single binding.
**Impact:** Defence-in-depth degrades when a request lacks `Origin` (e.g., direct POST from a CLI tool with stolen nonce). The single remaining check (`siweMessage.domain` in `allowedDomains`) is bypassable only if attacker can issue a SIWE message claiming our domain — which is exactly what a stolen nonce + signing oracle would produce.
**Fix:** If `originHost` is missing or not in the allowed-domain set, reject with 400 *before* calling verify. Don't allow verify to skip domain binding.

---

### M-076-3 — No CSRF token on POST `/api/auth/siwe` [MEDIUM]
**File:** `siwe.js:141-257`
**Issue:** SIWE login is a state-changing endpoint (issues an httpOnly Set-Cookie). It has no CSRF token. Mitigations in place: (a) `SameSite=Strict` on the issued cookie (`siwe.js:74`) — but `Strict` only protects *subsequent* requests carrying the cookie; it does not stop a fresh CSRF that *establishes* the cookie. (b) CORS `Access-Control-Allow-Credentials: true` with origin pinning — solid for browser-driven cross-origin XHR, but does not stop a top-level form-POST from an attacker site (browsers send those without preflight when content-type is form-encoded). (c) Body must be JSON `{message, signature}` and the signature must verify against an attacker-unobtainable nonce — *this is the real defence*. An attacker cannot forge a SIWE message valid against a fresh nonce without the user's wallet, so CSRF-as-login-fixation is not exploitable here.
**Impact:** Theoretical: login CSRF / session-fixation. Practically blocked by the SIWE signature requirement. Still flagged because the defence is implicit and audit reviewers will flag it.
**Fix:** Either document the implicit defence or require an `X-Requested-With` / origin-pinned header (forces preflight, which CORS will block from non-allowed origins). Adding a require-`Content-Type: application/json` check with a custom header is cheap insurance.

---

### L-076-1 — `statement` field accepted unvalidated; logged via console [LOW]
**File:** `siwe.js:158-160`, `siwe.js:130, 195`
**Issue:** `new SiweMessage(message)` parses the message string verbatim including the user-controlled `statement` line. The `statement` is never logged in this file (good), but `siwe.js:130` and `:195` log error messages (which include database errors, not the statement). However, downstream consumers of the JWT may surface `payload.wallet` etc. in JSON-injectable destinations. The more pressing concern: there is no length cap on `statement` — a malicious client could submit a 10 MB statement, paying our DB-row cost (statement isn't stored), our verify-CPU cost, and our log-file cost on parse errors.
**Impact:** Resource-exhaustion vector via oversized SIWE messages. Bounded by Vercel's request body limit (4.5 MB) and the per-IP rate limit of 10/min on `siwe-verify`. Low impact.
**Fix:** Reject `message` strings >4 KB before parsing. Optionally pin an allowlist of `statement` values.

---

### L-076-2 — `address.toLowerCase()` is correct for EIP-55 but ENS namespace not normalized [LOW]
**File:** `siwe.js:229`
**Issue:** Wallet claim is lowercased — correct for the on-chain address space. However if any consumer of the JWT cross-references ENS reverse records (e.g., for display in admin UI), the JWT carries only the address, which is fine; but the original `siweMessage.address` comes from the message, not from `ecrecover` directly. `siwe-library`'s `verify()` does call ecrecover internally and confirms the recovered address matches `siweMessage.address` — so `siweMessage.address` *is* the recovered-and-validated address, and lowercasing it is the right normalization. **No bug here, just verifying.** I'm flagging this LOW only as a reminder: if a future change reads `verifyResult.data.address` instead of `siweMessage.address`, double-check the source.
**Fix:** None needed today. Add a code comment that `siweMessage.address` is post-verify ground truth.

---

### L-076-3 — `aud` claim baked at sign time, validated at verify — but `iss` also OK [LOW]
**File:** `siwe.js:239`, `me.js:69-73`
**Issue:** JWT is signed with `aud: "authenticated"` (in payload) AND `setIssuer("supabase")` (in protected payload). `me.js` validates both via `jwtVerify(..., { issuer: "supabase", audience: "authenticated" })` — correct. However, `aud` is also embedded in the *payload* manually at `:239` while `setIssuer` sets it via the jose helper. This is redundant but not wrong. Note: jose's `SignJWT` will set `aud` from `setAudience()` if called; here it's set in the constructor object, which jose treats as a payload literal — same result. Mild code-smell, not a vuln.
**Fix:** Use `setAudience("authenticated")` for symmetry with `setIssuer`. Cosmetic.

---

### L-076-4 — Logout `decodeJwt` accepts unsigned tokens [LOW]
**File:** `siwe.js:269-290`
**Issue:** Logout decodes the cookie WITHOUT verifying the signature (line 273, `decodeJwt`), then writes the decoded `jti` into `revoked_jwts`. An attacker who can plant a cookie on a victim's browser (or send a DELETE with their own forged cookie carrying an arbitrary `jti`) can write *anything* into `revoked_jwts`. Two consequences:
1. **DoS via revocation table flooding:** rate-limited by IP (ratelimit.js does not appear to be applied to DELETE — confirmed: the DELETE branch on line 269 has no `checkRateLimit` call). An attacker can hit the DELETE endpoint repeatedly with crafted `jti` values, growing `revoked_jwts` until the `prune_revoked_jwts` RPC catches up.
2. **Targeted revocation of victim's `jti` if attacker knows it:** would require XSS-level access to the cookie, at which point game's already over.
**Impact:** Mostly storage-exhaustion. The `prune_revoked_jwts` RPC + `exp`-bounded inserts limit growth to (rate-limit unit × 24h).
**Fix:** Add `checkRateLimit(req, res, { limit: 10, windowSec: 60, identifier: 'siwe-logout' })` to the DELETE branch. Also: consider verifying the signature instead of decoding — only insert `jti` if the token is genuinely ours.

---

### I-076-1 — `chainId === 1` hardcoded; future L2 support requires code change [INFO]
**File:** `siwe.js:171-173`
**Note:** Validates chainId is mainnet (1). This is correct for the current product (mainnet-only ENS/NFT app). When L2 support is added, this is the chokepoint to update.

---

### I-076-2 — Nonce uses `randomUUID().replace(/-/g, '')` — 122-bit entropy [INFO]
**File:** `siwe.js:124`
**Note:** UUIDv4 gives 122 bits of entropy after stripping dashes, well above SIWE's "≥8 alphanumeric" minimum. No attack surface. Good.

---

### I-076-3 — `revoked_jwts` lookup fails open on DB error [INFO]
**File:** `me.js:84-90`
**Note:** Documented in the comment at `:86-90`. Acceptable trade-off (availability over consistency for one /me cycle), but worth re-reviewing if the threat model ever upgrades to "stolen-cookie + active attacker."

---

### I-076-4 — `algorithms: ["HS256"]` correctly pinned; `alg=none` cannot be accepted [INFO]
**File:** `me.js:69-73`
**Note:** Defence against alg-confusion attacks is in place. jose v5 default rejects `alg: "none"` regardless. Good defence-in-depth.

---

## Cross-File Notes

- **Cookie flags:** `HttpOnly` ✓, `Secure` (prod only) ✓, `SameSite=Strict` ✓, `Path=/` ✓. No `Domain` attribute (good — cookie scoped to the exact host that issued it). All flags correct.
- **JWT secret:** read from `process.env.SUPABASE_JWT_SECRET`. No literal secret in code (good). Strength of secret is environmental — out of scope of this audit but: if the deploy reuses a weak/default Supabase JWT secret, every finding above is moot.
- **Rate limiting:** GET nonce ✓ (10/min), POST verify ✓ (10/min), DELETE logout ✗ (missing — see L-076-4). No rate limit on `/api/auth/me` (low-risk read endpoint, but flooded `me` calls do a DB roundtrip to `revoked_jwts`).
- **Refresh logic:** None observed. Cookie has fixed 24h expiry, no rolling refresh — *good*. No "refresh forever" footgun present.
- **Replay protection:** Atomic nonce-claim via `DELETE ... .eq('nonce', ...).gt('expires_at', now).select(...)` is the correct pattern. Race-free per Postgres row-level locking semantics. Excellent.

---

## Prioritized Fix Order

1. **H-076-1** — Enforce `siweMessage.expirationTime` presence and bound it server-side.
2. **M-076-2** — Reject requests with missing/mismatched `Origin` before calling `verify`.
3. **M-076-1** — Validate `siweMessage.uri.host` against allowed-origin set.
4. **L-076-4** — Add rate limit to DELETE branch; consider signature-verify before revocation insert.
5. **M-076-3** — Document or strengthen CSRF posture (custom header or content-type pin).

---

*Audit produced by agent 076. AUDIT-ONLY: no code changed.*
