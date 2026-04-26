# Agent 086 — Vercel / CSP / Edge-Headers Forensic Audit

Scope: `frontend/vercel.json`, `frontend/scripts/csp-hash.mjs`, `frontend/index.html`, `frontend/public/theme-init.js`, `.vercel/`, `frontend/api/*`, `frontend/.env.example`.

Audit-only: NO files were modified.

---

## File map

| Path | Purpose | State |
|---|---|---|
| `frontend/vercel.json` | Edge headers + rewrites + redirects + CSP | present, single source of truth |
| `vercel.json` (root) | (none) | absent — only `frontend/vercel.json` exists |
| `frontend/scripts/csp-hash.mjs` | Re-compute SHA-256 hashes of inline `<script>` blocks for CSP `script-src` | present, runs cleanly |
| `frontend/index.html` | Shipped HTML, contains 1 inline `<script type="application/ld+json">` | present |
| `frontend/public/theme-init.js` | Pre-hydration theme script, loaded externally (`<script src="/theme-init.js">`) | present, 971 bytes |
| `.vercel/project.json` | Local project linkage (`prj_J1FvjRMmzfpMy8bfAnxC15k4dILI` → team `team_EVDD1zUWWUUoAzBGWe58k0uR`) | present, no secrets, gitignored-style internal data |
| `frontend/api/*` | Vercel Functions (`alchemy`, `etherscan`, `opensea`, `orderbook`, `supabase-proxy`, `auth/siwe`, `auth/me`, `v1/index`) | no `/api/admin*` route exists |
| `frontend/.env.example` | Schema with explicit "DO NOT paste real values" comment, marks server-only keys | clean — no secrets |
| `frontend/.env` | Local file (NOT inspected for values; only key names) | contains both `VITE_*` (public) and bare server keys (`ALCHEMY_API_KEY`, `OPENSEA_API_KEY`, `ETHERSCAN_API_KEY`) — a local-dev convenience but the bare keys must NOT be deployed via `vercel env push` from this file |

---

## Header / CSP audit (vercel.json `/(.*)` source)

| Directive | Value | Status |
|---|---|---|
| `X-Frame-Options` | `DENY` | OK (legacy, fine alongside `frame-ancestors 'none'`; older browsers still honor it; modern browsers prefer CSP — no conflict because both deny framing) |
| `X-Content-Type-Options` | `nosniff` | OK |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | OK |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | OK (2y, preload-eligible) |
| `Permissions-Policy` | camera/mic/geo/payment/usb/magnetometer/gyroscope/accelerometer all `()` | OK — note: if PWA features ever request push/notifications they'll need `interest-cohort=()`-style additions but the listed disables are the right defaults for a DeFi UI |
| `X-Permitted-Cross-Domain-Policies` | `none` | OK |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | OK (needed for WalletConnect popups) |
| `Cross-Origin-Resource-Policy` | `same-site` | OK |
| `Content-Security-Policy` | see below | mostly OK with caveats below |

CSP literal:

```
default-src 'self';
script-src 'self'
  'sha256-fs/Fksxr9J5Rwod3ET+U0AyQJosZ8lzM4DBNs4NuZfM='
  'sha256-HLYQhrrVIImu5zi4jq79GmRWdTZjdunmdgi6j+sZJ/s='
  'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self' https://rpc.flashbots.net https://*.publicnode.com https://*.llamarpc.com
  https://api.geckoterminal.com https://api.swapapi.dev https://api.etherscan.io
  https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com
  wss://*.walletconnect.org https://rpc.walletconnect.com https://explorer-api.walletconnect.com
  https://*.infura.io https://cloudflare-eth.com https://verify.walletconnect.com
  https://verify.walletconnect.org https://api.odos.xyz https://api.cow.fi https://li.quest
  https://aggregator-api.kyberswap.com https://open-api.openocean.finance https://api.paraswap.io
  https://*.alchemy.com https://api.opensea.io wss://*.alchemy.com https://nft-cdn.alchemy.com
  wss://eth-mainnet.g.alchemy.com https://pulse.walletconnect.org https://api.web3modal.org
  https://*.reown.com https://*.supabase.co wss://*.supabase.co;
frame-src https://www.geckoterminal.com https://verify.walletconnect.com https://verify.walletconnect.org;
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

---

## Findings

### F1 [HIGH] — connect-src missing `https://rpc.ankr.com` → wagmi fallback transport will be CSP-blocked

`frontend/src/lib/wagmi.ts:14` declares `http('https://rpc.ankr.com/eth')` as a transport in the `fallback([...])` provider list, but `rpc.ankr.com` is not in `connect-src`. When `publicnode` and `llamarpc` fail (or are slow), wagmi will dispatch to ankr, the browser will block the fetch with a CSP violation, and the user sees "RPC error" with no obvious cause. This degrades reliability under load exactly when fallback is most useful.

Fix: add `https://rpc.ankr.com` to `connect-src` in `frontend/vercel.json`.

### F2 [MEDIUM] — Stale/orphan inline-script hash in `script-src`

`csp-hash.mjs` reports exactly **one** inline `<script>` in `index.html` (the JSON-LD block), with hash `sha256-fs/Fksxr9J5Rwod3ET+U0AyQJosZ8lzM4DBNs4NuZfM=`. CSP also lists a second hash `sha256-HLYQhrrVIImu5zi4jq79GmRWdTZjdunmdgi6j+sZJ/s=` which corresponds to nothing in the current `index.html`.

`frontend/public/theme-init.js` (loaded as an *external* `<script src="/theme-init.js">`) has SHA-256 = `xZdRZ1jGdQ5Iv86patmv5n8qZ31TdNRBAdtzSiezTyo=`, so the orphan hash is not theme-init either. It is most likely the leftover of a previously-inlined theme bootstrap that has since been moved to `/theme-init.js` (per the comment in `index.html:9-15` confirming the move).

Risk: low *today* (extra hashes in `script-src` don't enable anything, they only allow a script with that exact body to inline-execute). Risk *tomorrow*: if any contributor pastes back the historic theme bootstrap as inline because they remember "it used to be inline and we have a hash for it", they will silently bypass the intent of the CSP migration.

Fix: drop the `'sha256-HLYQhrrV...'` token from `script-src` in `frontend/vercel.json`.

Also note: `csp-hash.mjs` itself is correct (line-ending normalisation to LF on line 22 matches what Vercel/Linux serve from git, regardless of CRLF on Windows working copies — good).

### F3 [MEDIUM] — `connect-src` lists `https://rpc.flashbots.net` but no code consumes it

No source file references `rpc.flashbots.net`. Either dead permission to remove, or feature work was descoped and the CSP entry was never reverted. Permission narrowing is cheap defence-in-depth; remove unless a near-term roadmap re-introduces it.

### F4 [MEDIUM] — Vercel preview deployments inherit production CSP/headers but have no auth on URL

`vercel.json` has no `protect`-style configuration (Vercel Pro feature `vercel.json#"git": { "deploymentEnabled": false }` for non-prod, or org-level password protection). Every PR/branch deploy publishes a unique `*.vercel.app` URL with full headers. Anyone who knows or guesses a preview URL can browse pre-release UI, including in-progress admin/feature-flag screens. The redirect rule on line 53-57 only catches the literal `tegridyfarms-three.vercel.app` host, not branch previews like `tegridy-farms-git-feat-x-…vercel.app`.

Recommendation: enable Vercel "Deployment Protection" → "Vercel Authentication" for Preview environments (org dashboard). Cannot be set in `vercel.json` alone.

### F5 [LOW] — `/api/admin*` route does not exist; admin authorization is contract-side `owner()` only

Confirmed by route inventory. `frontend/src/pages/AdminPage.tsx:203-206` gates rendering on `isOwner` derived from a wagmi `useReadContract({ functionName: 'owner' })` call. **All destructive operations are on-chain** — they re-verify ownership at the contract level, so a client bypass cannot actually pause/seize state. This is acceptable architecturally.

Residual concerns (not bugs, but worth noting):
- The page renders *layout* and reads contract state for non-owners as soon as their wallet is connected (a `useReadContracts` is gated `enabled: isOwner && onCorrectChain` — that's fine), but the route is still navigable. A bookmarked `/admin` reveals the "Not Authorized" panel which is fine.
- Server-side: if a future `/api/admin*` is added, it MUST re-verify (e.g. SIWE session + on-chain owner check on the server, not just rely on the same client guard).

### F6 [LOW] — `Permissions-Policy` does not list newer features

The directive is restrictive for traditional sensors but does not name `interest-cohort=()`, `browsing-topics=()`, `attribution-reporting=()`, `private-state-token-redemption=()`, `private-state-token-issuance=()`. These are FLoC/Topics/Privacy-Sandbox APIs that Chrome will silently use in third-party iframes (e.g. WalletConnect verify) unless explicitly disabled. Defence-in-depth.

### F7 [INFO] — `style-src 'unsafe-inline'`

Required by Vite-built CSS-in-JS (Tailwind/JIT is fine, but Sonner toasts and Wagmi/RainbowKit-style libs typically inject `<style>` at runtime). Mitigated by absence of script-src `unsafe-inline`. Document this in a comment in `vercel.json` so future hardening work doesn't naively flip it and break toasts.

### F8 [INFO] — `frame-ancestors 'none'` and `X-Frame-Options DENY` co-exist

Modern browsers honor `frame-ancestors`, ignore `X-Frame-Options` when both are present. Old browsers do the reverse. Both deny → no conflict. OK.

### F9 [INFO] — `frame-src` only allows `geckoterminal.com` + `verify.walletconnect.{com,org}`

Tight and correct. Does NOT allow Etherscan / OpenSea iframes, which is right (we link out instead).

### F10 [INFO] — `.env.example` is well-curated

Lines 5-12 explicitly explain VITE_ vs server-only key handling. Lines 41-65 list server-only keys with the literal warning "DO NOT paste real values into this file." No secrets are checked into the example. Notable: `VITE_SUPABASE_ANON_KEY` is correctly classified public-by-design (RLS-enforced); `SUPABASE_SERVICE_KEY` and `SUPABASE_JWT_SECRET` are correctly classified server-only.

### F11 [INFO] — `.vercel/project.json`

Contains org id + project id only. No secrets. Standard Vercel CLI artifact. Should be `.gitignored` per Vercel docs but presence here is non-sensitive (these IDs are visible to anyone who can deploy).

---

## CSP-hash script verification

```
$ node frontend/scripts/csp-hash.mjs
Found 1 inline <script> tag(s) in index.html:

  [0] attrs=type="application/ld+json"
      preview: {"@context":"https://schema.org","@type":"WebApplication","n…
      hash:    'sha256-fs/Fksxr9J5Rwod3ET+U0AyQJosZ8lzM4DBNs4NuZfM='
```

Match against vercel.json hash #1: identical → CSP currently does NOT silently violate on the JSON-LD block. CSP-hash logic is correct. Hash #2 in CSP has no inline-script counterpart (see F2).

---

## Summary

| Severity | Count |
|---|---|
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 2 |
| INFO | 5 |
| TOTAL | 11 |

Top-5 ranked:
1. F1 — connect-src missing `rpc.ankr.com` (will block wagmi fallback transport)
2. F2 — stale orphan SHA-256 hash in script-src (covers no script in current HTML)
3. F4 — Vercel preview deploys have no auth (leak unfinished features via guessable URLs)
4. F3 — connect-src lists unused `rpc.flashbots.net` (over-permission, narrow it)
5. F6 — Permissions-Policy missing modern privacy-sandbox / topics directives
