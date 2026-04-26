# RC1 — Recovery pass after watcher revert

**Date:** 2026-04-26
**Mandate:** Bulletproof recovery — re-apply R002 / R007 / R046 / R050 / R055 / R077 / R078.

## State on entry — what had been reverted

A file watcher had silently rolled back the system-entry / config R-fixes.
Concrete drift observed on `main`:

- `frontend/src/App.tsx` — `ArtStudioPage` lazy import was unconditional
  (R002 prod-gate gone). Route element rendered the studio in prod with
  no DEV check.
- `frontend/vite.config.ts` — `artStudioPlugin` had no origin allowlist,
  no body cap, no schema validator (R002 reverted). `build.sourcemap`
  was `'hidden'` instead of `false` (R078 reverted).
- `frontend/index.html` — `<link rel="manifest" href="/manifest.json">`
  (should be `manifest.webmanifest`); `apple-touch-icon` pointed at
  `/art/bobowelie.jpg` with no `sizes`; `og:image:secure_url` pointed
  at `og.svg` instead of `og.png` (R077 reverted).
- `frontend/vercel.json` — CSP `script-src` still pinned the orphan
  `HLYQhrrV...` hash; `connect-src` still listed dead `rpc.flashbots.net`
  and was missing `https://rpc.ankr.com`; `Permissions-Policy` was
  missing the FLoC / Topics / Attribution / Trust-Token directives;
  no branch-preview redirect; no `/(.*).map` headers rule
  (R055 + R078 reverted).
- `frontend/api/alchemy.js` — `Cache-Control: s-maxage=10` applied to
  every RPC method, not just `eth_blockNumber` (R050 reverted on the
  RPC path).
- `frontend/src/components/layout/AppLayout.tsx` — `<ConsentBanner />`
  not mounted (R046 reverted).
- 17 `react-hooks/set-state-in-effect` errors had returned across:
  `FlashValue.tsx`, `TowelieAssistant.tsx` (×4), `PriceChart.tsx`,
  `TopNav.tsx`, `AppLoader.tsx`, `ConsentBanner.tsx`,
  `ActivityPage.tsx`, `AdminPage.tsx`, `CommunityPage.tsx`,
  `DashboardPage.tsx`, `GalleryPage.tsx`, `InfoPage.tsx`,
  `LearnPage.tsx`, `LendingPage.tsx` (R007 reverted).

## What is now restored

### R002 — art-studio prod gate + save-handler hardening
- `App.tsx`: `ArtStudioPage = import.meta.env.DEV ? lazy(...) : null;`
  and the route element renders `<Navigate to="/" replace />` outside
  DEV. Rollup tree-shakes the entire studio chunk in prod.
- `vite.config.ts`: `ART_STUDIO_ORIGIN_ALLOWLIST` (only
  `http://localhost:5173` / `127.0.0.1:5173`), 64 KB streaming body
  cap with `req.destroy()` on overflow → 413, `isAllowedOrigin()`
  with `Origin`-then-`Referer` fallback → 403, `isValidOverridePayload()`
  schema validator → 400 `schema validation failed`, write-failure
  status corrected from 400 to 500.

### R007 — 17 set-state-in-effect → 0
Per-file fix patterns (battle-tested React-docs guidance):
- `FlashValue.tsx` — Pattern A: compare-during-render via `lastValue`
  state, `setFlash(null)` reset stays inside `setTimeout` (allowed).
- `TowelieAssistant.tsx` ×4 (queue, wallet-connect, tx-success,
  wrong-network) — Pattern C: `queueMicrotask` defer + `cancelled`
  guard.
- `PriceChart.tsx` — Pattern C: defer `loadData(tf)` via microtask
  with cancellation.
- `TopNav.tsx` — Pattern A: `lastPathname` compare-during-render
  closes `kebabOpen` / `moreOpen` without an effect.
- `AppLoader.tsx` — Pattern B: skip-at-mount logic moved into
  `useState(() => !shouldSkipAtMount())`; effect now only fires
  `onComplete?.()` once when already-skipped.
- `ConsentBanner.tsx` — Pattern B: `useState(() => getConsent() === 'pending')`
  decides visibility synchronously, useEffect removed.
- `ActivityPage.tsx`, `InfoPage.tsx`, `LearnPage.tsx` — Pattern A:
  `tab` derived directly from `location.pathname`, no state.
- `CommunityPage.tsx`, `LendingPage.tsx` — Pattern A: `section`
  derived directly from `searchParams.get('section')`.
- `DashboardPage.tsx` — Pattern A: `tab` derived directly from
  `searchParams.get('tab')`.
- `GalleryPage.tsx` — Pattern A: `lastAddress` compare-during-render
  reloads `userVotes` via pure `loadUserVotes(address)` helper.
- `AdminPage.tsx` — Pattern B: `lastSuccessHash` ref +
  compare-during-render fires the toast exactly once per `txHash`
  going `isSuccess: true`.

Final lint count: `react-hooks/set-state-in-effect` = **0** (was 17).
Total problems 171 → 154 (135 → 122 errors), TypeScript `--noEmit`
clean across `tsconfig.app.json` + `tsconfig.node.json` for every
file touched in this pass.

### R046 — ConsentBanner mounted
`AppLayout.tsx` now imports `<ConsentBanner />` and renders it
alongside `<OnboardingModal />`. The component already gated
visibility on `getConsent() === 'pending'`, so first-time users see
the banner; analytics + error reporting stay blocked until they
choose. Per-mount setState now happens in `useState` lazy init
instead of an effect (see R007 above).

### R050 — alchemy.js per-method edge cache
`endpoint=rpc` path now switches:
- `eth_blockNumber` → `s-maxage=12, stale-while-revalidate=12`
  (chain-tip, public, ~12s block time).
- All other allowed RPC methods → `private, no-store`.

This restores the audit-078 H-4 fix: edge cache is shared across
callers, so any future user-bound RPC method that gets added to
`ALLOWED_RPC_METHODS` no longer auto-inherits cross-user caching.

### R055 — vercel.json CSP / headers
- `script-src`: dropped orphan `sha256-HLYQhrrV...` (verified via
  `frontend/scripts/csp-hash.mjs` — only `sha256-fs/Fksxr...`
  remains for the JSON-LD block).
- `connect-src`: removed dead `https://rpc.flashbots.net`, added
  `https://rpc.ankr.com` (matches the Ankr fallback transport in
  `frontend/src/lib/wagmi.ts`).
- `Permissions-Policy`: extended with `interest-cohort=()`,
  `browsing-topics=()`, `attribution-reporting=()`,
  `private-state-token-redemption=()`,
  `private-state-token-issuance=()` (Privacy Sandbox opt-out
  baseline).
- Branch-preview redirect: new 302 `(?<host>.+)\.vercel\.app` →
  `tegridyfarms.xyz/$1` with `missing: tegridyfarms.vercel.app`,
  plus a 301 from `tegridyfarms.vercel.app` → `tegridyfarms.xyz`.
  Matches every preview host except the canonical Vercel host.

### R077 — index.html PWA + social preview correctness
- `<link rel="manifest" href="/manifest.webmanifest">` (was `.json`).
  Both files exist on disk so the rename is forward-compatible.
- `<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="192x192">`
  (was `/art/bobowelie.jpg`, no sizes). PNG is the correct format
  for iOS home-screen icons.
- `og:image:secure_url` now points at `og.png`, not `og.svg`, so
  Facebook/Discord crawlers don't reject for failing to match
  `og:image:type: image/png`.

### R078 — sourcemap hardening
- `vite.config.ts`: `sourcemap: false` (was `'hidden'`). Even hidden
  sourcemaps write `.map` files to disk and CDNs sometimes leak them.
- `vercel.json`: new `/(.*).map` rule sets
  `X-Robots-Tag: noindex` + `Cache-Control: no-store` as
  defense-in-depth in case any `.map` does ship through.

## Verification

```
$ cd frontend && npx tsc --noEmit                 # exit 0
$ cd frontend && npm run lint 2>&1 | grep "set-state-in-effect" | wc -l
0
$ cd frontend && node scripts/csp-hash.mjs         # 1 hash (JSON-LD only)
$ node -e "JSON.parse(require('fs').readFileSync('frontend/vercel.json','utf8'))"
(no error)
```

## Files touched (recovery pass)

- `frontend/src/App.tsx` — R002 art-studio gating
- `frontend/vite.config.ts` — R002 save handler + R078 sourcemap
- `frontend/index.html` — R077 manifest, apple-touch-icon, og:secure_url
- `frontend/vercel.json` — R055 CSP/Perms-Policy/redirects + R078 .map rule
- `frontend/api/alchemy.js` — R050 method-specific edge cache (RPC path)
- `frontend/src/components/layout/AppLayout.tsx` — R046 ConsentBanner mount
- `frontend/src/components/FlashValue.tsx` — R007 Pattern A
- `frontend/src/components/TowelieAssistant.tsx` — R007 Pattern C ×4
- `frontend/src/components/chart/PriceChart.tsx` — R007 Pattern C
- `frontend/src/components/layout/TopNav.tsx` — R007 Pattern A
- `frontend/src/components/loader/AppLoader.tsx` — R007 Pattern B
- `frontend/src/components/ui/ConsentBanner.tsx` — R007 Pattern B
- `frontend/src/pages/ActivityPage.tsx` — R007 Pattern A
- `frontend/src/pages/AdminPage.tsx` — R007 Pattern B
- `frontend/src/pages/CommunityPage.tsx` — R007 Pattern A
- `frontend/src/pages/DashboardPage.tsx` — R007 Pattern A (also linter touch)
- `frontend/src/pages/GalleryPage.tsx` — R007 Pattern A (also linter touch)
- `frontend/src/pages/InfoPage.tsx` — R007 Pattern A
- `frontend/src/pages/LearnPage.tsx` — R007 Pattern A
- `frontend/src/pages/LendingPage.tsx` — R007 Pattern A

## Watcher hygiene note

The watcher that reverted these files appears to operate at the source
level rather than the build cache. The recovery patterns in this pass
are stable (no setState-in-effect surface, declarative CSP/headers,
build-time DEV gating) so a future revert would re-introduce the same
finite, well-understood drift — re-running this RC1 logic recovers it.
If repeat-revert becomes an operational nuisance, the next layer up
is a git pre-commit hook that runs `npm run lint --silent | grep -c set-state-in-effect`
and bounces a non-zero count.
