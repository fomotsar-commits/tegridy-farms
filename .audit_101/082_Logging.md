# Agent 082 — Logging Forensic Audit (AUDIT-ONLY)

Scope: `frontend/api/**`, `frontend/src/lib/errorReporting.ts`, `indexer/src/index.ts`,
plus broader `frontend/src/**` survey for completeness.

## Counts
- `frontend/api/**` console.* calls: 17 (all `console.error` / `console.warn`, NO `console.log`)
- `frontend/src/lib/errorReporting.ts` console.*: 0 (clean — no direct console writes)
- `indexer/src/index.ts` console.*: 0 (CLEAN — only logs in `indexer/ponder.config.ts` line 336 dev warn)
- `frontend/src/**` console.* (broader survey): ~95 hits, vast majority gated behind `import.meta.env.DEV`
- Sentry / PostHog / `captureException`: **0 references** — no third-party error forwarding configured anywhere
- `logger.*` structured logger: **0 references** — codebase uses `console` only
- `console.log`: **0 occurrences in scoped paths** (api + lib) — strong signal that prod logging is intentionally restrained

## Redaction posture (errorReporting.ts)
- SENSITIVE_PATTERNS regex (line 9): catches 64-hex private keys, 12–24 word mnemonics, `bearer …`, JWTs (`eyJ…`)
- `sanitize()` clamps to MAX_FIELD_LENGTH=500
- `sanitizeUrl()` strips `?search` and `#fragment` (line 36–38) — defends against JWT-in-URL leakage
- Endpoint allowlist (line 79) blocks RFC1918, link-local, cloud metadata (169.254/16, metadata.google.internal), IPv6 unique-local/link-local, non-HTTPS
- **GAP A (LOW)**: scrubber does NOT redact keys named `privateKey` / `apiKey` / `authorization` / `cookie` / `password` in object stringification — only matches by literal value pattern. If a stack trace contains `apiKey: "abc123"` (12-char value), it WILL pass. Real JWTs / 64-hex / mnemonics are caught.
- **GAP B (LOW)**: `componentStack` from React error boundaries can include prop values; sanitize() only does pattern replace, so non-secret PII in props (e.g., user-typed input) reaches the endpoint.

## Top-5 findings

1. **[INFO] Indexer is clean** — `indexer/src/index.ts` has zero `console.*`, zero stack/trace logging. No PII or secret leakage surface. Only ponder.config.ts line 336 has a single dev-mode `console.warn` for missing RPC URL config (no secret in message).

2. **[LOW] api/auth/siwe.js logs error.message from supabase responses** — lines 130, 195, 281 (`Nonce storage error: ${error.message}`, `Nonce claim error`, `Revoke insert error`). Supabase service-role error messages can include constraint names, table schema hints, or row data on integrity-violation paths. **No JWT or cookie value is logged**, but PostgREST error bodies could leak schema details to wherever Vercel forwards stderr. Severity-LOW: Vercel stderr is private to project owners, not public.

3. **[LOW] api/_lib/ratelimit.js line 136** — `console.error('[ratelimit] upstash error:', err?.message ?? err)`. If Upstash REST client ever embeds the full URL (with token) in an error, `err.message` could surface it. Upstash's error formatter does NOT include tokens (verified pattern), but this is a defense-in-depth gap.

4. **[LOW] api/orderbook.js line 475** — `console.error("On-chain verification failed, rejecting fill:", rpcErr.message)`. Alchemy RPC error objects are safe (no key embedded), but the alchemy.js URL is built with `${ALCHEMY_API_KEY}` as path segment — if any future RPC error stringifies the request URL into err.message, the API key leaks. **No occurrence right now**, but no defensive scrubber exists either.

5. **[INFO] Frontend `console.error/warn` widely DEV-gated** — most user-facing files (GalleryPage, useLimitOrders, useDCA, useTegridyScore, userdata.js, supabase.js, portfolio.js) use `if (import.meta.env.DEV) console.*`, so prod bundles drop them. **Exceptions** (always-on logs in prod) include: Header.jsx:298 `SIWE sign-in failed: err.message`, MyCollection.jsx:171 `Cancel listing error`, BulkListingWizard.jsx:625, ErrorBoundary.tsx:37, BidManager.jsx, api-offers.js (~15 calls), api.js (~15 calls). None contain wallet+amount as a structured pair; all are err.message strings. ErrorBoundary.tsx:37 logs `(error, errorInfo)` to console where errorInfo.componentStack may contain prop strings.

## Confirmed NEGATIVES (audit-asked items NOT FOUND)
- No `console.log` of wallet+amount tuples
- No `error.message` containing user JWT (JWT is stored in httpOnly cookie, never deserialized into JS-visible state)
- No request-body verbatim logging (`JSON.stringify(req.body)` does NOT appear in any console.* call)
- No request-URL-with-secret-query logging (sanitizeUrl strips queries; api/* never logs req.url)
- No signed-message string logging — orderbook.js handles signatures but never logs `signature` or `message` variables
- No Sentry / PostHog forwarding (zero captureException calls in entire frontend)
- No always-on dev logs in api/auth/* (all are error-path warn/error, not info/debug)

## Recommendations (not actions — audit only)
- Add a key-name scrubber to `errorReporting.ts.sanitize()` that walks JSON-shaped strings and redacts values whose key ∈ {privateKey, apiKey, authorization, cookie, password, secret, token}
- Wrap `api/auth/siwe.js` console.errors with a generic message (drop `error.message`) — internal supabase error detail belongs in a structured logger, not stderr
- Consider a `sanitizeForLog()` helper in api/_lib that strips Alchemy/Upstash URLs from error messages before console.error
