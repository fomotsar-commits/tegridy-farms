# Remediation Plan — g09 Main-app Responsive (iPhone / iPad / desktop / ultrawide)

Surface: main Tegridy app + the embedded Tradermigos (Nakamigos) sub-app, viewed across mobile/tablet/desktop.
Branch: `mvp-launch` at HEAD. Each finding below was opened against the real source and confirmed (or demoted to false-positive / redeploy-only / duplicate).

**Cross-cutting note on prod staleness (T1):** several "viewport" findings were captured against the *live* prod build, which is known to lag HEAD. Where HEAD already renders correctly, the verdict is `redeploy-only` and the finding does not need code. The two biggest are F507 (BottomNav now global) and F515 (analytics/portfolio tabs now wired).

---

## Batch: `rpc-and-price-transport` (F511, F517, F524 + the price-staleness fallout)

**Summary.** One root cause spans three findings: the browser is firing requests to endpoints it can never use. `src/lib/wagmi.ts` ends its mainnet `fallback([...])` with a bare `http()` — viem's default mainnet RPC for that is `https://eth.merkle.io`, which is **not** in the `connect-src` allowlist in `vercel.json`, so every data refresh logs a CSP violation. `eth.llamarpc.com` is in both the transport list and the CSP but is provider-side CORS-broken. And `useToweliPrice.ts` fetches GeckoTerminal **directly from the browser** (`api.geckoterminal.com` is in CSP but the call still intermittently CORS-fails), which is what surfaces the "Price oracle is stale" banner on /treasury and forces price/FDV onto the on-chain fallback. Fix the transport list + proxy the price call once and all three close. This is real at HEAD; it ships only on redeploy (CSP lives in `vercel.json`).

### F511 — CSP-blocked + CORS-failed RPC/price requests on every route
- **verdict:** fix-now
- **rootCause:** standalone (network/transport config)
- **approach:** In `src/lib/wagmi.ts` drop the bare `http()` last-resort transport (it resolves to viem's default `eth.merkle.io`, which CSP blocks) and demote/remove `http('https://eth.llamarpc.com')` (CORS-broken provider-side); keep `publicnode` + `ankr` as the ranked fallback. Separately, proxy the GeckoTerminal price fetch in `useToweliPrice.ts:112-138` through the existing serverless aggregator pattern (see `api/_lib/aggregator-proxy.js`) instead of hitting `api.geckoterminal.com` from the browser, which restores USD figures and clears the stale-price banner.
- **files:** `src/lib/wagmi.ts:12-21`, `src/hooks/useToweliPrice.ts:112-138`, `vercel.json:17` (connect-src — only if a replacement host is added)
- **effort:** M
- **risk:** med (transport changes affect every on-chain read; verify reads still resolve on publicnode+ankr alone)
- **test:** Load `/treasury` and `/tokenomics` in a real browser; console must be free of `eth.merkle.io`/`llamarpc` CSP/CORS errors and the "Price oracle is stale" banner must not appear when a fresh price is available. Add a unit assertion that `wagmi.ts` transports contain no bare `http()`.
- **deps:** []
- **batchHint:** rpc-and-price-transport

### F517 — RPC failover rotation includes endpoints the app can't use
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same fix as F511 (remove `eth.merkle.io` via the bare `http()`, drop/replace `eth.llamarpc.com`). This is the tablet-desktop sighting of the identical wagmi transport problem — it also clears the 200+ console errors that mask real failures. Duplicate of **F511**.
- **files:** `src/lib/wagmi.ts:12-21`, `vercel.json:17`
- **effort:** S
- **risk:** low
- **test:** Covered by F511's console-clean check on both viewports.
- **deps:** [F511]
- **batchHint:** rpc-and-price-transport

### F524 — GeckoTerminal price fetch fails from the browser (ERR_FAILED)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same proxy move as F511's price half — route the GeckoTerminal call in `useToweliPrice.ts` through the serverless layer so it stops ERR_FAILED-ing on `/tokenomics` and `/premium`. Duplicate of **F511** (price half). The fallback already produces the displayed price; this just removes the primary-source error.
- **files:** `src/hooks/useToweliPrice.ts:112-138`
- **effort:** S
- **risk:** low
- **test:** Covered by F511; confirm `/tokenomics` PRICE/FDV still render with no ERR_FAILED in console.
- **deps:** [F511]
- **batchHint:** rpc-and-price-transport

---

## Batch: `opensea-stats-path` (F514)

### F514 — `/api/opensea` collection stats returns 400 for every collection
- **verdict:** fix-now
- **rootCause:** standalone (path-allowlist mismatch)
- **approach:** Confirmed real bug. The client calls `collections/${osSlug}/stats` (plural — the correct OpenSea v2 endpoint) at `src/nakamigos/api.js:190,208`, but the proxy allowlist `isAllowedPath` in `api/opensea.js:137` only accepts the **singular** `collection/${slug}/stats`, so the proxy 400s before ever reaching OpenSea. Add the plural form to the per-slug allowlist loop (`if (path === \`collections/${slug}/stats\`) return true;`) and update the `selectCacheControl` regex at `api/opensea.js:88` to match `collections/{slug}/stats` too. Also surface an error state on the hub stat tiles instead of an infinite skeleton (see F516).
- **files:** `api/opensea.js:135-141` (add plural path), `api/opensea.js:88` (cache-control regex), and a stat-tile error state in the Nakamigos hub card component
- **effort:** S
- **risk:** low (additive allowlist entry; existing singular path stays)
- **test:** Extend `api/__tests__/opensea.test.js` to assert `collections/nakamigos/stats` passes `isAllowedPath`. Manually load `/nakamigos` and confirm the Nakamigos card FLOOR/VOLUME/OWNERS/SUPPLY resolve (no permanent gray skeleton).
- **deps:** []
- **batchHint:** opensea-stats-path

---

## Batch: `opensea-rate-limit-and-empty-states` (F516)

### F516 — Own `/api/opensea` rate-limiter 429s under one browsing session; infinite skeletons
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Two-part. (1) The per-page request fan-out re-requests `stats` 3-8× per page — dedupe/cache it (the proxy already sets `s-maxage=60` for stats; add a client-side in-flight de-dupe in `src/nakamigos/api.js` so concurrent callers share one request, and reuse the cached stats across tabs). Consider raising the per-IP limit in `api/_lib/ratelimit.js` / the `checkRateLimit({ limit: 30 })` call in `api/opensea.js:171` if dedupe alone is insufficient. (2) Replace the endless "Fetching live listings…" skeleton with a retry/error state when the proxy 429s — the `withRetry` helper in `api.js:23-64` already honors `Retry-After`, so wire its terminal failure to an error UI in `Listings`/`Analytics`/`PortfolioTracker` rather than leaving the skeleton latched (relates to T11).
- **files:** `src/nakamigos/api.js` (in-flight stats de-dupe), `api/opensea.js:171` + `api/_lib/ratelimit.js` (limit tuning), `src/nakamigos/components/Listings.jsx` / `Analytics.jsx` / `PortfolioTracker.jsx` (error/retry state)
- **effort:** M
- **risk:** med (touches the shared fetch layer for every Tradermigos tab)
- **test:** Throttle to one IP, walk listings→analytics→portfolio→trades in <3 min; the limiter should not 429 within a normal session, and any 429 that does occur must render a retry affordance, not a forever-skeleton. Extend `api/__tests__/ratelimit.test.js`.
- **deps:** [F514]
- **batchHint:** opensea-rate-limit-and-empty-states

---

## Batch: `naka-enter-gate` (F513, F518)

### F513 — Tradermigos deep-link enter gate is dead; visitor permanently stuck
- **verdict:** fix-now
- **rootCause:** standalone (needs-verification — see notes)
- **approach:** The Tradermigos "CLICK TO ENTER" is `src/nakamigos/components/SplashScreen.jsx`, mounted by `nakamigos/App.jsx:161` whenever `!splashDone`. `handleEnter` (SplashScreen.jsx:677) only proceeds when `phase === 'ready'`; the 4s progress + `setPhase('ready')` path plus an 8s safety timeout should make it clickable. The audit reports clicks dead for 60s on deep routes (`/nakamigos/nakamigos/listings`) while the root route dismisses immediately. Most likely cause: on a heavy deep route the surrounding `CollectionView` data work delays the splash's own rAF/timer so `phase` never reaches `ready`, OR an overlay intercepts the click on sub-routes. **Verify first** (instrument `phase`/`exitPhase` on a deep route) before patching. Fix candidates, in order of preference: (a) ensure the 8s safety `setPhase('ready')` timeout in SplashScreen.jsx:664-672 actually fires on deep routes; (b) make the gate skip when the session already entered (mirror the entered-session behavior the audit observed); (c) confirm `onClick={handleEnter}` is not shadowed by a `pointer-events` overlay at the click coordinates on sub-routes.
- **files:** `src/nakamigos/components/SplashScreen.jsx:633-755` (phase/timer + handleEnter), `src/nakamigos/App.jsx:143,160-163` (splash gate mount)
- **effort:** M
- **risk:** med (entry gate is the first thing every shared-link visitor hits)
- **test:** Fresh browser context, direct `goto /nakamigos/nakamigos/listings`; a center click must dismiss the gate within ~1s of "ready" on all four deep routes (listings/analytics/portfolio/trades), both viewports. Add a manual repro to the test plan.
- **deps:** []
- **batchHint:** naka-enter-gate

### F518 — Enter gate + art intro replays on every full page load (no entered-state persistence)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Two distinct gates replay because neither persists across a reload/deep-link. (1) Main app: `AppLoader.tsx` only writes `sessionStorage.setItem('tf_loaded','1')` (lines 536/541/577) — every new Safari session / shared deep link replays the full ~10s art gate. Persist a "seen" flag in **localStorage** (keep the reduced-motion + session skip in `shouldSkipAtMount`, AppLoader.tsx:28-40) so returning visitors fast-forward or skip. (2) Tradermigos: `nakamigos/App.jsx:143` deliberately keeps splash per-mount (`useState(false)`, no storage) per a prior owner request — gate this behind the same localStorage "entered" flag so refreshes/deep-links don't re-pay it while preserving the first-true-visit experience. This shares the persistence mechanism with F504 (mobile sighting of the same main-app gate). **Additive only — do not delete the art moment.**
- **files:** `src/components/loader/AppLoader.tsx:28-40,536,541,577`, `src/nakamigos/App.jsx:143,160-163`
- **effort:** M
- **risk:** med (gate persistence affects first-paint UX everywhere)
- **test:** Enter via `/`, then full-reload `/farm` and direct-load `/nakamigos/nakamigos/listings` — neither should replay the full gate for a returning visitor; a brand-new browser profile still sees it once.
- **deps:** []
- **batchHint:** naka-enter-gate

---

## Batch: `loader-touch-skip` (F504)

### F504 — Unskippable ~10s art loader blocks every deep link / Safari session; tap-to-enter too late, no touch skip
- **verdict:** fix-now
- **rootCause:** standalone (shares persistence fix with F518)
- **approach:** Keep the art moment but make it humane on touch. In `AppLoader.tsx`: (a) the only skip today is ESC (lines 130-144) with no touch equivalent — the overlay already has `onClick={handleClick}` but it only advances during `hold`/`textForm`/`vortex` phases; add a visible "skip"/"tap to enter" affordance that appears within ~1-2s on touch/`isMobile` devices and lets a tap dissolve the loader early (reuse the existing `skip` phase path). (b) Persist the seen-flag in localStorage (shared with F518) so returning sessions and shared deep links aren't re-gated. (c) Product decision needed on whether to bypass the gate entirely for legal deep-links (`/terms`, `/risks`, `/privacy`) — flag to owner; if approved, skip the loader when the entry path is one of those. Loader timing constants live in `src/components/loader/constants.ts` (total runs to `T_TEXT_END = 14500`).
- **files:** `src/components/loader/AppLoader.tsx:109-144,607-658`, `src/components/loader/constants.ts`, persistence shared with F518
- **effort:** M
- **risk:** med
- **test:** On an iPhone-width touch context, a skip affordance is reachable within 2s and a tap dissolves the loader; ESC still works on desktop. Confirm a returning session (localStorage flag set) does not replay.
- **deps:** [F518]
- **batchHint:** loader-touch-skip

---

## Batch: `home-overflow` (F503)

### F503 — Homepage horizontally overflows (layout viewport expands to 414px on a 390px iPhone)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed at HEAD. The hero readability-scrim div at `src/pages/HomePage.tsx:87` uses `absolute -left-6 -right-10 -top-8 -bottom-8` inside the `max-w-xl relative` wrapper (line 83) — the `-right-10` overhang pushes the page to 414px and clips the open nav menu items. Fix additively: wrap the hero block in an `overflow-x-clip` (or `overflow-hidden`) parent, or reduce `-right-10`→`-right-4` so the scrim no longer exceeds the viewport. Do **not** remove the scrim (it's the legibility layer for the hero copy over the pale ape art). One-line fix that also un-clips the menu's Tegridy Score / Treasury / close-X.
- **files:** `src/pages/HomePage.tsx:81-88`
- **effort:** S
- **risk:** low (visual scrim only; verify hero copy still legible over light art)
- **test:** Measure `document.scrollWidth`/`innerWidth` at 390px on `/` — both must equal 390. Open the nav menu on home and confirm no item renders past the right edge.
- **deps:** []
- **batchHint:** home-overflow

---

## Batch: `first-visit-overlays` (F505, F506, F522)

**Summary.** First-visit and per-route overlays pile up and overlap content. The OnboardingModal, ConsentBanner, and TowelieAssistant all mount globally in `AppLayout.tsx:146-151`. ConsentBanner already has `env(safe-area-inset-bottom)` padding (ConsentBanner.tsx:42-47) and Towelie already offsets `bottom-20 md:bottom-4` with safe-area padding (TowelieAssistant.tsx:329-330), so part of F505 is already addressed at HEAD — but the *sequencing* (three layers at once) and Towelie's *z-order vs the nav drawer* + *auto-pop occlusion* remain. Fix these together so a first-time mobile visitor faces one thing at a time.

### F505 — First-visit overlay pile-up; consent buttons at the very bottom edge
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** ConsentBanner already pads for the iOS home-indicator (`paddingBottom: max(1rem, env(safe-area-inset-bottom))` at ConsentBanner.tsx:46) — that half is **redeploy-only** (prod is stale). The remaining real issue is three simultaneous layers (OnboardingModal + ConsentBanner + Towelie route-tip). Sequence them in `AppLayout.tsx`: gate `OnboardingModal` (and the Towelie route tip) so they don't mount until consent is resolved (`getConsent() !== 'pending'` via `src/lib/consent.ts`). Towelie's `ROUTE_TIP_DELAY_MS` (2.2s) already stalls it; add a consent check before its first route tip. Additive — no overlay is removed, just ordered.
- **files:** `src/components/layout/AppLayout.tsx:146-151`, `src/components/ui/OnboardingModal.tsx:43-45`, `src/components/TowelieAssistant.tsx:149-161`, `src/lib/consent.ts`
- **effort:** M
- **risk:** med (touches first-visit gating; verify each overlay still appears exactly once)
- **test:** Fresh browser at `/` on iPhone width: consent shows first; after Accept/Decline, onboarding (and only then a Towelie tip) appears. Consent buttons sit clear of the Safari bottom bar.
- **deps:** []
- **batchHint:** first-visit-overlays

### F506 — Towelie bubble auto-pops on every route and occludes content + the open nav drawer
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed z-order: Towelie container is `z-[60]` (TowelieAssistant.tsx:329) while the TopNav mobile drawer + scrim are `z-50` (TopNav.tsx:340,348), so the bubble renders **on top of the open drawer**. Fix: suppress the Towelie bubble while the nav drawer is open (lift drawer state via context or have Towelie check a `body`-level "drawer-open" signal), or drop Towelie below the drawer's z-index. Also reduce auto-pop occlusion on `<640px`: delay the per-route tip until idle and ensure it clears the bottom tab bar (it already uses `bottom-20` on mobile, but the bubble grows upward over content). Consider a single global first-visit tip instead of per-route pops (the `STORAGE_SEEN_PREFIX` per-route keys at TowelieAssistant.tsx:102 drive the repetition). **Keep the assistant — additive tuning only.**
- **files:** `src/components/TowelieAssistant.tsx:149-161,329,332-408`, `src/components/layout/TopNav.tsx:336-388` (drawer-open signal)
- **effort:** M
- **risk:** med
- **test:** Open the nav drawer on `/farm` at mobile width — the Towelie bubble must not overlap it. On each route at <640px the bubble must not cover the primary input / footer legal links.
- **deps:** []
- **batchHint:** first-visit-overlays

### F522 — Floating mascot chat toast overlaps content bottom-right on every Tradermigos page (820px)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** The Tradermigos sub-app has its own bottom-right floating toast/avatar (separate from the main-app Towelie). At narrow widths it sits over the earnings CTA / collection cards and reappears per route. Give the page container bottom padding equal to the toast height at ≤1024px, or auto-collapse the toast to just the avatar bubble after a few seconds. Apply in the Tradermigos toast/mascot component (search `src/nakamigos/components` for the welcome-toast renderer; `nakamigos/App.jsx` already reserves `paddingBottom: 60` for the MobileNav — extend that reservation to clear the toast).
- **files:** `src/nakamigos/components/*` (the bottom-right welcome toast component), `src/nakamigos/App.jsx:680` (page `paddingBottom`)
- **effort:** M
- **risk:** low
- **test:** At 820px on `/nakamigos/nakamigos/listings`, the toast must not cover the primary CTA/cards; after a few seconds it collapses to the avatar.
- **deps:** []
- **batchHint:** first-visit-overlays

---

## Batch: `home-nav-reachability` (F507)

### F507 — No path to Farm/Swap/Dashboard from the homepage menu
- **verdict:** redeploy-only (primary tabs) + product-decision (drawer secondary links)
- **rootCause:** T1 (stale prod build) + standalone
- **approach:** Two parts. (1) "Tab bar absent on home" is **stale prod** — at HEAD `BottomNav` is rendered globally in `AppLayout.tsx:144` (not route-gated) and is `fixed ... sm:hidden`, so Dashboard/Farm/Trade/Tradermigos tabs DO appear on `/`. Redeploy fixes this. (2) The mobile drawer genuinely only holds the 4 `MORE_NAV_SECTIONS` items (Gallery, Tegridy Score, Tokenomics, Treasury) — `TopNav.tsx:363-377` renders only `MORE_NAV_SECTIONS`, by design because primary tabs live in the BottomNav. Whether to also add Farm/Trade/Dashboard to the ~90%-empty drawer is a **product decision** for the owner (the drawer is intentionally "secondary overflow only"). If approved, render `PRIMARY_NAV` above `MORE_NAV_SECTIONS` in the drawer using the existing `navConfig` source of truth — additive.
- **files:** (redeploy) none; (if approved) `src/components/layout/TopNav.tsx:359-384`, reads `PRIMARY_NAV` from `src/lib/navConfig.ts:56-61`
- **effort:** S
- **risk:** low
- **test:** After redeploy, confirm the bottom tab bar shows on `/` at mobile width. If the drawer change ships, confirm Farm/Trade/Dashboard are reachable from the drawer.
- **deps:** []
- **batchHint:** home-nav-reachability

---

## Batch: `over-art-text-legibility` (F508, F519, F521, F512)

**Summary.** A cluster of "white/low-contrast text washes out over busy/light artwork" findings. The codebase already has the right tools: the shared `ConnectPrompt` dark-card component (`src/components/ui/ConnectPrompt.tsx`), the `glass-card` utility, and a `textShadow: '0 1px 6px rgba(0,0,0,0.95)'` pattern used on FarmPage stat labels. Reuse these rather than inventing new scrims. **Never remove the art — add a scrim/shadow layer behind text only.**

### F508 — Page subtitles in white over busy/light artwork illegible at 390px
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Add a consistent scrim or `text-shadow` behind the hero subtitle text on /security, /faq, /dashboard, /swap, /liquidity, /nft-finance. Prefer the existing `textShadow: '0 1px 6px rgba(0,0,0,0.95)'` pattern (already used in FarmPage.tsx:283) or a small gradient band behind the header — apply it where each page renders its `<p>` subtitle. Where a page has a shared header block, add the shadow once there. The dark cards on the same pages already read fine, so only the over-art subtitle line needs the treatment.
- **files:** subtitle `<p>` in `src/pages/LearnPage.tsx` (security/faq), `src/pages/DashboardPage.tsx`, `src/pages/TradePage.tsx` (swap/liquidity), `src/pages/LendingPage.tsx` (nft-finance)
- **effort:** M
- **risk:** low (additive text-shadow/scrim)
- **test:** At 390px on each listed route, the full subtitle line stays legible where it crosses light art areas.
- **deps:** []
- **batchHint:** over-art-text-legibility

### F521 — Page subtitles + inactive tab labels low-contrast over bright artwork (both viewports)
- **verdict:** fix-now
- **rootCause:** standalone (sibling of F508)
- **approach:** Same scrim/`text-shadow` treatment as F508, extended to /swap, /nft-finance, /tokenomics subtitles AND the inactive tab labels (Liquidity/DCA/Alerts) that render white-on-light-art. For the inactive tab labels, add the dark-chip / text-shadow treatment the stat cards use. Land in the same commit as F508.
- **files:** `src/pages/TradePage.tsx` (subtitle + Liquidity/DCA/Alerts tab labels), `src/pages/LendingPage.tsx`, `src/pages/LearnPage.tsx` (tokenomics subtitle)
- **effort:** S
- **risk:** low
- **test:** At both 820px and 1440px the subtitles and inactive tab labels stay legible over bright art.
- **deps:** [F508]
- **batchHint:** over-art-text-legibility

### F519 — Dashboard "Connect Wallet" prompt rendered bare over busy art (illegible at 820)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed real. `DashboardPage.tsx:152-166` hand-rolls a bare `text-center` connect prompt directly over the camo art with no card, while FarmPage uses the shared `<ConnectPrompt surface="farm" />` (FarmPage.tsx:182) which has a dark backdrop card. Replace the Dashboard hand-rolled block with the existing `ConnectPrompt` component — its own header comment (ConnectPrompt.tsx:70-76) already lists /dashboard as an intended consumer, so this is finishing an incomplete rollout. Use `<ConnectPrompt surface="generic" title="Connect Wallet" description="View your portfolio, positions, and earnings." />` (or add a `dashboard` surface to the `DEFAULTS` map). Additive — keeps the art background.
- **files:** `src/pages/DashboardPage.tsx:152-166`, optionally `src/components/ui/ConnectPrompt.tsx:25-56` (new `dashboard` surface)
- **effort:** S
- **risk:** low (swaps to a tested shared component)
- **test:** Disconnected `/dashboard` at 820px and 1440px shows the dark-card prompt; extend `ConnectPrompt.test.tsx` if a `dashboard` surface is added.
- **deps:** []
- **batchHint:** over-art-text-legibility

### F512 — Leaderboard background art speech-text bleeds behind UI panels; tier rows fade under sub-nav
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Dim or blur the background art layer behind the "How Points Work" panel and the tier rows on `/leaderboard` so stray art captions ("…THIS TOWEL GETS…POINTS?…") don't read as broken UI text. Add a low-opacity scrim (`rgba(6,12,26,0.x)`) over the art behind the points panels (same additive pattern as the HomePage hero scrim). For the tier rows fading under the sticky sub-nav mid-scroll, add `scroll-margin-top` so rows clear the ActivityPage sticky tab bar (`top: 56` + pt-3, ~z-30, ActivityPage.tsx:52-84). Polish severity — bundle with the legibility batch.
- **files:** `src/pages/LeaderboardPage.tsx` (art scrim + row scroll-margin)
- **effort:** S
- **risk:** low
- **test:** On `/leaderboard` at mobile width, art captions are dimmed behind the panels and tier rows are not clipped by the sub-nav while scrolling.
- **deps:** []
- **batchHint:** over-art-text-legibility

---

## Batch: `info-sticky-subnav` (F509)

### F509 — Translucent sticky pill bar collides with H1s and ghosts text through it
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed on the InfoPage tab host (/risks, /terms, /privacy are InfoPage tabs). The sticky bar uses `background: rgba(13,21,48,0.72)` with `blur(20px)` (`InfoPage.tsx:62`) — too translucent, so underlying H1s/footer links ghost through. Bump opacity to ~0.92 (matching the BottomNav's `rgba(6,12,26,0.95)`), and add `scroll-margin-top` (≈72px to clear the 56px header + pill bar) to the page H1s on RisksPage/TermsPage/PrivacyPage so they aren't tucked under the bar. Apply the same opacity bump to the sibling ActivityPage bar (ActivityPage.tsx:59) for consistency.
- **files:** `src/pages/InfoPage.tsx:59-66`, `src/pages/ActivityPage.tsx:59-66`, H1s in `src/pages/RisksPage.tsx` / `TermsPage.tsx` / `PrivacyPage.tsx`
- **effort:** S
- **risk:** low (opacity + scroll-margin only)
- **test:** On `/risks`, `/terms`, `/privacy` at mobile width, no footer/H1 text is visible *through* the pill bar and the H1 is not tucked under it after navigation.
- **deps:** []
- **batchHint:** info-sticky-subnav

---

## Batch: `nft-finance-chip-row` (F510)

### F510 — Bottom tab chip row clips its 4th chip mid-word with no scroll affordance
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed. The NFT-finance section toggle is `flex overflow-x-auto gap-1.5 ... no-scrollbar snap-x` (`LendingPage.tsx:186`) — it scrolls horizontally but `no-scrollbar` removes any visible affordance, so "Launchpad" (4th chip) clips with no hint. Add a right-edge fade gradient (mask-image or an absolutely-positioned gradient overlay) on the scroll container, OR wrap the chips to two rows below ~420px. Additive CSS only.
- **files:** `src/pages/LendingPage.tsx:184-193`
- **effort:** S
- **risk:** low
- **test:** At 390-414px on `/nft-finance`, a right-edge fade (or two-row wrap) signals the 4th chip is reachable; the chip is no longer cut mid-word with zero affordance.
- **deps:** []
- **batchHint:** nft-finance-chip-row

---

## Batch: `tradermigos-tablet-density` (F520)

### F520 — 820px gets a denser NFT grid than desktop (5 cols @820 vs 4 @1440) with sub-44px touch targets
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Cap the Tradermigos floor/gallery grid at 3-4 columns below ~1024px and bump tap targets to ≥44px on touch. The inverted density (denser on the smaller, touch viewport) comes from the Tradermigos grid breakpoints — adjust the responsive column count in the Gallery/Analytics floor-grid CSS (`src/nakamigos` grid components / `.nakamigos-app` CSS) so the iPad portrait gets the 2-3 col reflow the main Tegridy app already does at 820px. Enlarge the "Connect & Buy" buttons (~100×22 today) and the top tab row labels to meet the 44px touch floor.
- **files:** Tradermigos floor-grid components + grid CSS under `src/nakamigos/` (Gallery / Analytics card grid; tab row in `src/nakamigos/components/Header.jsx`)
- **effort:** M
- **risk:** med (grid breakpoint changes ripple across every Tradermigos collection view)
- **test:** At 820px the floor grid renders ≤4 columns and all buy buttons/tab labels meet the 44px touch target; at 1440px the 4-col layout is unchanged.
- **deps:** []
- **batchHint:** tradermigos-tablet-density

---

## Batch: `premium-default-tab` (F523)

### F523 — /premium lands on the "Gold Card" SOON placeholder instead of the live Points tab
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: `ActivityPage.tsx:27` (`tabFromPath`) returns `'gold'` for `/premium`, and the Gold Card tab shows the SOON placeholder until the PremiumAccess contract deploys. `navConfig.ts:49` already exports `PREMIUM_LIVE = isDeployed(PREMIUM_ACCESS_ADDRESS)`. Gate the default: when the URL is `/premium` and `!PREMIUM_LIVE`, render the `points` tab content (or auto-redirect `/premium`→`/leaderboard`) so the first impression isn't an empty feature; keep the Gold Card tab present and select it automatically once PREMIUM_LIVE flips true (no code change needed on deploy). Minor product nuance — `/premium` is the canonical premium URL — but gating on the existing live-flag is the conservative, self-healing fix.
- **files:** `src/pages/ActivityPage.tsx:26-31,86-91`, reads `PREMIUM_LIVE` from `src/lib/navConfig.ts:49`
- **effort:** S
- **risk:** low (gated on an existing flag; reverts itself on deploy)
- **test:** With PremiumAccess undeployed, `/premium` shows Points content (not the SOON placeholder); the Gold Card tab is still clickable. When `PREMIUM_LIVE` is true, `/premium` shows Gold Card.
- **deps:** []
- **batchHint:** premium-default-tab

---

## Batch: `redeploy-only` (F515)

### F515 — Analytics and Portfolio deep links render the Floor tab instead of their own tab
- **verdict:** redeploy-only
- **rootCause:** T1 (stale prod build)
- **approach:** False at HEAD — `VALID_TABS` in `src/nakamigos/constants.js:68-73` includes both `"analytics"` and `"portfolio"`, `parseRoute` (`nakamigos/App.jsx:97-98`) returns the matched tab for any segment in `VALID_TABS`, and `renderTab` has dedicated `case "analytics"` (App.jsx:630) and `case "portfolio"` (App.jsx:672) branches. So at HEAD these deep links render their own tabs, and the trades deep link the audit saw working proves the sub-route machinery is sound. The "renders Floor instead" behavior is the **stale prod build** before these tabs were wired. Ships on redeploy; no code change. (If a redeploy still shows Floor, re-verify the prod bundle hash — but the source is correct.)
- **files:** none (verify: `src/nakamigos/constants.js:68-73`, `src/nakamigos/App.jsx:97-98,630,672`)
- **effort:** S
- **risk:** low
- **test:** After redeploy, `goto /nakamigos/nakamigos/analytics` and `/portfolio` render their own tab (analytics chart / portfolio-or-connect-prompt), not "FLOOR & LISTINGS".
- **deps:** []
- **batchHint:** redeploy-only
