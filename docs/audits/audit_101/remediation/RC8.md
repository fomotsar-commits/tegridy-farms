# RC8 — Recovery pass for API + GitHub workflows

**Date:** 2026-04-26
**Trigger:** R048-R053 + R056 had been reverted on disk; verified each
file against its R*.md change log and re-applied.

## Files re-applied

### `frontend/api/alchemy.js`
R048 `USE_HEADER_AUTH` gate: `Authorization: Bearer ${KEY}` via
`authHeaders()`; URL no longer carries the key. R049: `readBoundedText`
on NFT-API + RPC + tip-resolver paths; eth_getLogs delta cap 10_000n
(BigInt) with `resolveChainTip()` for `latest`; reverse-range 400.
R050: method-specific RPC cache — only `eth_blockNumber` gets
`s-maxage=12, swr=12`; everything else `private, no-store`. logSafe()
on every error path.

### `frontend/api/etherscan.js`
R048: v2 multichain (`/v2/api` + `chainid=1` + `Authorization: Bearer`)
when key set; v1 querystring fallback only when unset. R049:
`readBoundedText`. logSafe on errors.

### `frontend/api/v1/index.js`
R048: header auth on alchemyFetch. R049: `checkRateLimit` 20/min
identifier `"v1"` (replaces cosmetic `setRateLimitHeaders`); bounded
reads in alchemyFetch + OpenSea listings.

### `frontend/api/_lib/ratelimit.js`
R051 H-1: `extractIp` rewritten — `request.ip` → `x-real-ip` →
XFF[**last**] → `'unknown'`. Whitespace trim + empty-filter on XFF
parse. Function exported. R051 M: `buildRateLimitKey(req, wallet)`
exported; `wallet:` / `ip:` namespaces. `checkRateLimit` accepts
`opts.walletAddress`.

### `frontend/api/supabase-proxy.js`
R051: `export const config = { api: { bodyParser: { sizeLimit: "32kb" } } }`.
Two-stage rate limit — IP baseline 50/min `supabase-proxy-ip`, then
write bucket 20/min `supabase-proxy` keyed on verified wallet. R050:
env-driven CORS allowlist (`ALLOWED_ORIGINS`), OPTIONS handler,
`Vary: Origin` always, fail-closed credentialed CORS.

### `frontend/api/auth/siwe.js`
R051: bodyParser sizeLimit 8kb. R052: env-driven allowlist (no
`nakamigos.gallery` fallback); Origin required (400 missing / 403
non-allowlisted) hoisted above message construction; require
`expirationTime` + `notBefore` (≤15 min future); `siweMessage.uri`
host validated; CSRF threat model documented; DELETE uses `jwtVerify`
+ `siwe-logout` 5/min rate limit.

### `frontend/api/auth/me.js`
R052: `auth-me` 60/min/IP rate limit. R050: env-driven allowlist;
no hardcoded fallback.

### `_lib/seaport-verify.js` + `_lib/url-allowlist.js` (R053)
Verified present; no edits — staged commit captured them.

### `.github/workflows/{ci,release,slither,codeql,contracts-ci}.yml`
R056: all 12 third-party action invocations SHA-pinned (zero floating
`@vN` tags remain — grep verified). `ci.yml` build splits on
`pull_request.head.repo.full_name == github.repository` for WC secret
gating. `release.yml` adds strict-semver validator step,
env-passthrough (`TAG: ${{ ... }}` + quoted `"$TAG"`), workflow-scope
`contents: read` with job-scope `contents: write` on release only.
`slither.yml` `fail-on: medium`.

## Not run
Per instructions, no tests executed (build mid-flight elsewhere).
Existing test suites in `frontend/api/__tests__/` (R049-hardening,
auth-siwe, supabase-proxy, orderbook-r053, opensea-r053,
seaport-verify, url-allowlist) and `_lib/__tests__/` (logSafe,
ratelimit) cover all changes.
