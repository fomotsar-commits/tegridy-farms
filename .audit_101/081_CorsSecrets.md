# Agent 081 — CORS + Secret-Handling Forensic Audit

**Mission:** Cross-cutting CORS/secret hygiene across `frontend/api/**`.
**Date:** 2026-04-25
**Verdict:** Strong baseline. No CORS wildcards on per-user endpoints. No `.env`
files committed. No client-bundle leakage of server secrets. **Two MEDIUM** and
**three LOW** findings, all defense-in-depth, no live exfil paths.

---

## Counts

| Surface                    | Count | Notes                                                                 |
|----------------------------|------:|-----------------------------------------------------------------------|
| API route files audited    |     7 | alchemy, etherscan, opensea, orderbook, supabase-proxy, auth/{siwe,me}, v1 |
| Endpoints with CORS        |     7 | All set per-origin allowlist (`Vary: Origin` properly set)            |
| `Access-Control-Allow-Origin: *` on per-user data | 0 | Clean                                                       |
| `Allow-Credentials: true` endpoints |    2 | `auth/siwe.js`, `auth/me.js` — both with strict origin allowlist (correct) |
| OPTIONS preflight handlers |     7 | All seven endpoints handle `OPTIONS` → 200                            |
| `.env` files tracked       |     0 | Only `.env.example` files (3, sanitized placeholders)                 |
| Server-secret leakage to `frontend/src/**` | 0 | No `VITE_*` references to `SUPABASE_SERVICE_KEY`, `JWT_SECRET`, `ALCHEMY_API_KEY`, `OPENSEA_API_KEY`, `ETHERSCAN_API_KEY` |
| GH Actions secret-echo     |     0 | `release.yml` echoes only public refs/tags. `ci.yml` only injects public `VITE_WALLETCONNECT_PROJECT_ID` (intended public). |
| `console.log` of headers/tokens |    0 | Error logs use `error.message` only — no `error.config.headers`     |

---

## Top-5 Findings

### 1. MED — `auth/me.js` and `auth/siwe.js` set `Allow-Credentials: true` on hardcoded fallback origin (`https://nakamigos.gallery`)
**File:** `frontend/api/auth/me.js:37`, `frontend/api/auth/siwe.js:46`
When request `Origin` is unknown, both return:
```
Access-Control-Allow-Origin: https://nakamigos.gallery
Access-Control-Allow-Credentials: true
```
Browser still blocks since `Origin` won't match, **but** if an attacker controls
`https://nakamigos.gallery` (or a subdomain via DNS takeover), credentialed
session cookies could leak across origins. Recommend: when origin is **not**
allowlisted, OMIT `Access-Control-Allow-Origin` entirely (don't return the
fallback). Already correct in `alchemy.js`-style endpoints when not
credentialed, but credentialed flows demand stricter handling.

### 2. MED — `supabase-proxy.js` does NOT call `setCors()` / handle `OPTIONS`
**File:** `frontend/api/supabase-proxy.js:30-34`
The handler immediately rejects non-POST with 405 and never sets any CORS
header. Browsers issuing a credentialed POST with custom `Content-Type` will
preflight; preflight sees no `Allow-Origin` and is blocked. Currently works
because the route is same-origin (Vercel deploys both front + API on one host),
but if frontend ever splits to a separate origin (e.g. Vercel preview pulling
from prod API), the auth-cookie flow silently breaks. Add `setCors()` + OPTIONS
handler matching the `auth/*` pattern, including `Allow-Credentials: true`
since this proxy depends on the `siwe_jwt` cookie.

### 3. LOW — `ALLOWED_ORIGIN` env var fallback is unsafe default
**Files:** `alchemy.js:60,82`, `opensea.js:64,83`, `orderbook.js:81,105`, `v1/index.js:28,57`
Pattern: `res.setHeader("Access-Control-Allow-Origin", isAllowed ? origin : ALLOWED_ORIGIN)`.
If a deploy ever sets `ALLOWED_ORIGIN` to `*` via misconfig, every endpoint
silently becomes globally readable. None of these endpoints return per-user
data (allowlisted contracts only), so impact is limited to API-key abuse via
free proxy, but the pattern is fragile. Recommend: validate `ALLOWED_ORIGIN` at
boot rejects `*` and any value not in the static allowlist; or omit the header
on unknown origins (browsers handle the rejection cleanly).

### 4. LOW — `Vary: Origin` not set on `supabase-proxy.js`
**File:** `frontend/api/supabase-proxy.js`
Same root cause as #2 — no CORS handling at all. If a CDN/cache layer is ever
inserted in front of Vercel, responses keyed without `Vary: Origin` could be
served cross-origin. Combine fix with #2.

### 5. INFO — `frontend/.env.example:24-31` documents `VITE_*` keys for
Etherscan + Alchemy + Supabase ANON
**File:** `frontend/.env.example`
The file correctly notes which are public-safe (anon key with RLS), but
`VITE_ETHERSCAN_API_KEY` and `VITE_ALCHEMY_API_KEY` are flagged as "public
read-only" — these still bundle into client JS. Code already migrated away
from `VITE_ETHERSCAN_API_KEY` (see `pages/HistoryPage.tsx:204` comment), but
the `.env.example` still advertises it. Recommend: remove the `VITE_ETHERSCAN_API_KEY`
and `VITE_ALCHEMY_API_KEY` lines so new contributors don't reintroduce the
bundle leak. Server-only counterparts (`ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY`)
already exist in the file and are properly documented as Vercel-only.

---

## Verified Safe (no action)

- **Rate limiter (`_lib/ratelimit.js`)**: production fail-closed (503), dev
  fail-open with warning. No header/token logging.
- **JWT handling**: HS256 pinned in both verify paths; `siwe_jwt` cookie is
  HttpOnly + Secure + SameSite=Strict; revocation table backs logout.
- **Error logs**: All `console.error` calls log only `.message` or sliced
  upstream text (≤500 chars) — no headers, no req body, no auth context.
- **GitHub Actions**: only `VITE_WALLETCONNECT_PROJECT_ID` injected at build
  (intentionally public). No `echo "${{ secrets.X }}"`. `release.yml` echoes
  only refs/tags. No `pull_request_target` hooks (no fork-PR secret leak).
- **Git history**: `.env`, `.env.local`, `.env.production` never committed
  (verified via `git log --all --diff-filter=A`); only `.env.example` files.
- **`.gitignore`**: lines 3-4 cover `.env` and `.env.local`. `.gitattributes`
  has no rule that would exclude .env from tracking checks.
- **Client bundle**: zero references to `SUPABASE_SERVICE_KEY`,
  `SUPABASE_JWT_SECRET`, `ALCHEMY_API_KEY` (server), `OPENSEA_API_KEY`,
  `UPSTASH_REDIS_REST_TOKEN` from `frontend/src/**`.

---

## Files Reviewed
- `frontend/api/alchemy.js`
- `frontend/api/etherscan.js`
- `frontend/api/opensea.js`
- `frontend/api/orderbook.js`
- `frontend/api/supabase-proxy.js`
- `frontend/api/auth/siwe.js`
- `frontend/api/auth/me.js`
- `frontend/api/v1/index.js`
- `frontend/api/_lib/ratelimit.js`
- `.gitignore`, `.gitattributes`
- `.github/workflows/*.yml` (5 files)
- `frontend/.env.example`
