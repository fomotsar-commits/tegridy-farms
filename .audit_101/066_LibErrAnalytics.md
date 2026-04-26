# Audit 066 — LibErrAnalytics (errorReporting / analytics / copy / navConfig)

Agent: 066 of 101
Date: 2026-04-25
Mode: AUDIT-ONLY (no code changes)

## Targets
- `frontend/src/lib/errorReporting.ts` (+ `errorReporting.test.ts`)
- `frontend/src/lib/analytics.ts` (+ `analytics.test.ts`)
- `frontend/src/lib/copy.ts` (+ `copy.test.ts`)
- `frontend/src/lib/navConfig.ts` (+ `navConfig.test.ts`)

## Counts
- HIGH: 1
- MEDIUM: 4
- LOW: 4
- INFO: 3
- Total: 12

---

## HIGH

### H-1 — Analytics + error reporting fire before any user consent (no consent gate)
**File:** `frontend/src/lib/analytics.ts` (entire module)
**File:** `frontend/src/lib/errorReporting.ts` (`installGlobalHandlers`, line 152)
**Wired in:** `frontend/src/main.tsx:9` (`installGlobalHandlers()` runs at boot), `frontend/src/pages/TradePage.tsx:66` (`trackPageView('trade')` in `useEffect`), `frontend/src/components/layout/AppLayout.tsx:87` (`trackWalletConnect(connector.name)`).

Neither module checks for a user-consent flag (cookie banner / GDPR opt-in) before queueing or POSTing. Repository-wide grep for `consent|cookie.*banner|gdpr|ConsentBanner` returns only `frontend/src/pages/TermsPage.tsx`; **no consent banner component exists, no consent state is consulted before `track()` / `reportError()` send.** With `VITE_ANALYTICS_ENDPOINT` set, an EU/UK visitor's first page view, wallet-connect event, and uncaught error all leave the browser before they have any way to opt out. ePrivacy / GDPR risk is real once the env var is non-empty in prod.

**Compounds:**
- `installGlobalHandlers()` registers `window` listeners synchronously at module init; even if a consent UI is added later, the network POST happens via `flush()` which fires every 5 s on a setTimeout chain.
- `trackPageView` lives in a `useEffect(() => …, [])` so it queues the event before any banner could mount.
- `analytics.ts` line 78 fires `flush(true)` on `visibilitychange → hidden`, i.e. when the user closes the tab — that beacon goes out without consent too.

**Recommend:** wrap `track()` early-return on a `localStorage.getItem('tegridy_consent') !== 'granted'` check; gate `installGlobalHandlers()` behind same flag in `main.tsx`; ship a consent banner before turning either env var on for an EU-reachable origin.

---

## MEDIUM

### M-1 — `analytics.ts` `trackError(error, context)` has no PII sanitizer; mirrors raw `error.message`
**File:** `frontend/src/lib/analytics.ts:132-135`
```ts
export function trackError(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : String(error);
  track('error', { message, context });
}
```
`errorReporting.ts` strips 0x-keys, mnemonics, bearer tokens, JWTs (line 8-9 `SENSITIVE_PATTERNS`), but the **parallel** `trackError` path on the analytics rail does **not**. A revert message such as `"signing 0xdead… for vault 0xCafe…"` would ship the wallet-related hex unredacted to `VITE_ANALYTICS_ENDPOINT`. Two telemetry rails, only one is sanitized — asymmetric.

### M-2 — `errorReporting.ts` redacts 64-hex (private keys) but **not** 40-hex wallet addresses
**File:** `frontend/src/lib/errorReporting.ts:8-9`
```
/\b(0x[0-9a-fA-F]{64})\b|...
```
The pattern catches private-key-shaped (32-byte) and JWT/bearer/12-word mnemonic, but does not match the 40-hex EVM address shape. A stack trace like `"Failed at TegridyVault.deposit(0xAbCd…1234)"` will report the user's wallet address verbatim. The audit prompt explicitly flags wallet-address forwarding as in-scope; the regex misses it.

### M-3 — `errorReporting.ts` mnemonic regex is fragile / locale-dependent
**File:** `frontend/src/lib/errorReporting.ts:9` segment `(\b(?:[a-z]+\s){11,23}[a-z]+\b)`
Only catches lowercase ASCII words separated by literal `\s`. Any mnemonic that round-trips through `JSON.stringify` with capitalisation, smart quotes, NBSP, or unicode-normalised whitespace bypasses it. Also matches innocuous prose of 12-24 lowercase words (false-positive risk in long stack traces).

### M-4 — `errorReporting.ts` SSRF allow-list does not block DNS rebinding / public-resolved-private addresses
**File:** `frontend/src/lib/errorReporting.ts:79-103` (`isAllowedEndpoint`)
Lexical hostname check — `evil.example.com` resolving to `10.0.0.5` passes. While the function meaningfully blocks the obvious `http://10.x` / `169.254.169.254` / `metadata.google.internal` patterns, it does not protect against attacker-controlled DNS pointing a public hostname at an internal IP. Acceptable for browser-side telemetry (browser will still hit the resolved IP, no metadata access in browser context), but the in-line comment implies stronger guarantees than delivered. Severity reduced because in-browser fetches cannot reach AWS/GCP IMDS anyway.

---

## LOW

### L-1 — Session ID is `crypto.randomUUID` per `sessionStorage` — survives across page reloads in same tab
**File:** `frontend/src/lib/analytics.ts:11-19`
Across-page-reload joinability turns "anonymous" event clusters into per-session behavioural graphs. Combined with `trackWalletConnect(walletName)` (AppLayout:87) and any future `trackSwap` containing addresses, this links a wallet to a session. Acceptable as documented behaviour but should be disclosed in privacy policy.

### L-2 — `errorReporting.ts` — `localStorage` fallback persists redacted PII to browser disk indefinitely
**File:** `frontend/src/lib/errorReporting.ts:68-76, 114-117`
On endpoint failure (`fetch().catch`) the entry array is appended to `localStorage['tegridy_error_log']`. There is no expiry, and no clear-on-logout. Any user opening DevTools sees their last 50 errors plus URL — fine, but a shared/kiosk machine leaks them to the next user.

### L-3 — `analytics.ts` `flush()` re-queue race on `sendBeacon` failure
**File:** `frontend/src/lib/analytics.ts:59`
```ts
if (!sent) queue = batch.concat(queue);
```
If a `track()` call fires between `const batch = queue; queue = []` (line 43-44) and the beacon failure, the new event ends up *after* the re-enqueued batch (`batch.concat(queue)`). Order is rarely load-bearing for analytics, but the comment says "re-queue" without acknowledging the reorder. Cosmetic.

### L-4 — `copy.ts` IP risk acknowledged in module header but no kill-switch wiring
**File:** `frontend/src/lib/copy.ts:11-15`
The header explicitly flags Paramount IP risk MEDIUM-HIGH and proposes a 48-hr rebrand by string-swap. There is no `import.meta.env.VITE_BRAND_OVERRIDE` or feature flag exposed; a real rebrand still requires editing the file and redeploying. Doc says "surgical" but architecture says "one-commit". Not a security issue — operational hygiene only.

---

## INFO

### I-1 — All `navConfig.ts` routes resolve in `App.tsx`
Verified `/dashboard, /farm, /swap, /nft-finance, /nakamigos, /community, /gallery, /leaderboard, /tokenomics, /treasury` against `frontend/src/App.tsx:113-148`. No broken hrefs, no dead nav items pointing to deleted routes. `nakamigos/*` is a wildcard route and `tokenomics/leaderboard/treasury` route into shared tabbed hosts (`LearnPage` / `ActivityPage` / `InfoPage`) consistent with the comment block at `navConfig.ts:32-36`.

### I-2 — `copy.ts` ships zero TODO/FIXME/PLACEHOLDER strings
Greps for `TODO|FIXME|placeholder|lorem|TBD|XXX` in copy module: 0 hits. Strings are intentional product copy.

### I-3 — No canvas/font/plugin fingerprinting
Searched for `canvas|getContext|navigator\.plugins|navigator\.platform|navigator\.userAgent|fingerprint` in the two telemetry modules. Zero matches. Analytics rail collects only what `track*()` helpers explicitly pass — no implicit device fingerprinting.

---

## Verdict
- **errorReporting.ts:** sanitization design is sound; gaps are wallet-addr regex (M-2), mnemonic robustness (M-3), and absence of consent gate (H-1).
- **analytics.ts:** missing consent gate is the headline risk; PII asymmetry vs. errorReporting (M-1) is the close second.
- **copy.ts:** clean. Only operational note (L-4).
- **navConfig.ts:** clean. All routes resolved.

No code changes per AUDIT-ONLY mandate.
