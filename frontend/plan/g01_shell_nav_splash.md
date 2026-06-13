# Remediation Plan — g01_shell_nav_splash

Surface: App shell, header/nav/footer, 404, providers, splash, page transitions.
Branch: `mvp-launch` @ HEAD. All paths absolute under `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend`.

Verification method: every finding below was opened against the real source at HEAD before planning. Findings already correct at HEAD (the prod build is stale) are marked **redeploy-only**; vague/unconfirmed items are marked **false-positive** with the reason.

Systemic notes that recur:
- **T1 stale prod build** — several live-agent findings (F48, F58, F54-title) reproduce only on prod, not localhost HEAD. One redeploy closes them.
- **T7 logged-out wall** — F47 (`ETH Distributed`) is the load-bearing example: a public global stat is gated behind `enabled: !!address`.
- **T11 loading-vs-empty** — F47 also conflates "loaded zero" with "loading" → permanent shimmer.
- Two bottom-right fixed overlays collide (F17 ≡ F49) — one fix.
- Scroll restoration is a 3-way dup (F18 ≡ F38, and F5 remount feeds it).

---

## Batch: light-theme-legibility
Light mode is functionally broken because page heroes/sections keep a fixed dark art layer that never themes, while headings/labels flip to navy. This is the single highest-impact visual defect on the surface.

### F45 — Light theme illegible app-wide (navy headings on dark art)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `index.css:596` & `:641` set `[data-theme="light"] .heading-luxury { color:#1e1b4b }` (deep navy); `index.css:579` sets `body` bg `#f5f3ff`, but `HomePage.tsx:77` (and FarmPage etc.) render their own `fixed inset-0` art layer at `#060c1a` that ignores theme. Navy-on-near-black headings = ~1.5:1. Reproduced on localhost HEAD per the live agent, so NOT a stale-prod artifact.
- **approach:** This needs an owner choice on the light-mode model before coding (mandate: never remove the art). Two viable additive directions: (A) keep the dark art murals in both themes and scope heading/label/stat colors to stay light-on-dark on art-backed surfaces (cheapest, preserves art, "light mode" becomes "light chrome over dark canvas"); or (B) give art-backed pages a light-theme scrim/wash so navy text reads. Recommend (A): add a `.on-art` text-color guard that overrides the `[data-theme="light"]` navy on hero/section headers that sit over `ArtImg`. Do NOT recolor the murals. Once the owner picks A/B, the coding is an `index.css` pass auditing every text-on-art combo in light mode.
- **files:** `C:\...\frontend\src\index.css:596`, `:641`, `C:\...\frontend\src\pages\HomePage.tsx:77`, plus per-page hero wrappers (FarmPage, TokenomicsPage, CommunityPage)
- **effort:** L
- **risk:** med
- **test:** Toggle the sun icon on Home/Farm/Tokenomics; zoom every heading + stat card and confirm ≥4.5:1 contrast. Add a visual-regression note to the responsive checklist.
- **deps:** []
- **batchHint:** light-theme-legibility

### F14 — Light-mode footer copyright painted invisible
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `Footer.tsx:75` hardcodes `background: rgba(6,12,26,0.78)` (dark in both themes); `Footer.tsx:176` renders `© 2026 Tegridy Farms` in `text-white/60`; `index.css:651-653` overrides `[data-theme="light"] footer .text-white\/60 { color: var(--color-text-secondary) }` (=`#4c1d95`). Deep purple on near-black ≈1.5:1. The sibling overrides at `index.css:645-659` all assume a light footer surface that no longer exists.
- **approach:** Footer is dark in both themes — delete the now-wrong light-mode footer text overrides at `index.css:645-659` so the footer keeps its dark-theme white/kyle colors. Minimal and additive-safe (removes dead CSS, no markup change).
- **files:** `C:\...\frontend\src\index.css:645-659`
- **effort:** S
- **risk:** low
- **test:** Switch to light mode, scroll to footer, confirm the copyright and all link columns are legible (white/kyle on dark panel).
- **deps:** []
- **batchHint:** light-theme-legibility

### F63 — Theme-toggle icon + Tradermigos link low-contrast on orange header (light)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `TopNav.tsx:108-109` light header gradient is Kenny orange `rgba(255,140,26..255,111,0)`; the toggle glyph uses `text-text-secondary` and `Tradermigos` is `.nav-link` = `#4c1d95` (`index.css:666`). Navy/white-ish on orange is weak. The CSS comment at `index.css:664` even says "against the cream backdrop" — stale, the light header is orange.
- **approach:** Add a `[data-theme="light"] header .nav-link`/toggle override that darkens icon + link to a high-contrast tone on orange (e.g. `#1a0f00`/near-black or white with shadow), matching the orange-header reality. Fix the stale "cream backdrop" comment at `index.css:664`. Additive CSS only.
- **files:** `C:\...\frontend\src\index.css:664-678`, `C:\...\frontend\src\components\layout\TopNav.tsx:256-280` (toggle color class)
- **effort:** S
- **risk:** low
- **test:** Light mode, zoom the header; sun glyph and Tradermigos both ≥4.5:1 on orange.
- **deps:** []
- **batchHint:** light-theme-legibility

---

## Batch: hero-trust-stats
The hero's "ETH Distributed" is the one number that backs the "every fee flows on-chain — verifiable" pitch, and it's stuck shimmering. Two root causes: a public read gated on wallet connection, and a zero/loading conflation.

### F47 — "ETH Distributed" hero stat shimmers forever
- **verdict:** fix-now
- **rootCause:** T7 (and T11)
- **confirmed:** `HomePage.tsx:181` maps the stat to `'–'` when `revenueStats.totalDistributed > 0` is false; `HomePage.tsx:192` renders the shimmer skeleton whenever `(!s.v || s.v === '–')` — so a value of `'–'` (loaded-but-zero, OR never-loaded) renders the **loading shimmer indefinitely**. Worse, `useRevenueStats.ts:37` sets `query:{ enabled: !!address }`, so for a disconnected visitor the `totalDistributed` read (a global `RevenueDistributor.totalDistributed`) never fires → always `0n` → always `'–'` → permanent shimmer. Reproduced on prod AND localhost HEAD.
- **approach:** Two-part: (1) In `useRevenueStats.ts`, split the global reads (`totalDistributed`/`totalClaimed`/`epochCount`/`totalReferralsPaid`) into a second `useReadContracts` that is NOT gated on `!!address` (or set the whole query `enabled: true` and keep the user-arg reads tolerant of the zero-address) so the public lifetime-ETH number loads logged-out — this is the T7 "gate the action, not the data" fix and also surfaces the indexer-grade truth. (2) In `HomePage.tsx`, stop treating `'–'` as loading: expose `revenueStats.isLoading`/`isDeployed` and render the shimmer only while genuinely loading; when loaded-and-zero, render the honest `0 ETH` (or `0 ETH — fees start at pool seed`). Reuse the existing `formatWei` already imported in the hook.
- **files:** `C:\...\frontend\src\hooks\useRevenueStats.ts:21-44`, `C:\...\frontend\src\pages\HomePage.tsx:181`, `:189`, `:192`
- **effort:** M
- **risk:** med
- **test:** Load Home logged-out → stat resolves to `0 ETH` (or real value), no shimmer after first read. Add a unit/render test asserting the stat node has non-skeleton text when `totalDistributed === 0n` and `isLoading === false`.
- **deps:** []
- **batchHint:** hero-trust-stats

### F57 — Rotating Towelie quote near-illegible / causes layout shift
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `HomePage.tsx:65-73` drives a rotating quote (`TOWELIE_QUOTES`) under the CTAs; rendered small/italic/low-contrast over the mural, and one cycle can be empty causing the trust badge to jump.
- **approach:** Bump size/contrast slightly and add a subtle `backdrop-blur` pill behind the quote (consistent with the existing hero scrim at `HomePage.tsx:87`); reserve a fixed min-height on the quote slot so an empty/short quote doesn't shift the badge. Additive — keep the quotes and art.
- **files:** `C:\...\frontend\src\pages\HomePage.tsx` (quote render block ~`:130-145`)
- **effort:** S
- **risk:** low
- **test:** Reload Home several times; quote is readable on the mural and the trust badge never jumps between quote cycles.
- **deps:** []
- **batchHint:** hero-trust-stats

---

## Batch: tokenomics-chart
### F50 — Supply Distribution pie renders empty (legend only)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `TokenomicsPage.tsx:115-134` wraps a recharts `ResponsiveContainer width="100%" height="100%"` in a `w-full h-48 min-h-[192px]` box, with `minWidth={1} minHeight={192}`. The legend at `:136-143` proves `SUPPLY_DATA` is populated, but the pie area is blank — classic recharts "container measured at 0/-1 during route transition / under the `key={pathname}` remount" (the comment at `:117-119` acknowledges the warning). Reproduced prod AND localhost HEAD.
- **approach:** Make the chart size-deterministic: give the `ResponsiveContainer` an explicit pixel `height={192}` (drop `height="100%"`) so it doesn't depend on a flex parent that measures late, and/or render the `PieChart` at a fixed `width`/`height` via a `useResizeObserver`d width. Simplest reliable fix: replace `ResponsiveContainer height="100%"` with `height={192}` and ensure the parent `div` has a resolved width (it does — `w-full`). Keep the `ErrorBoundary` and legend. The `key={location.pathname}` remount (see F5) compounds this by re-mounting recharts cold each visit — fixing F5's remount also helps.
- **files:** `C:\...\frontend\src\pages\TokenomicsPage.tsx:115-133`
- **effort:** M
- **risk:** low
- **test:** Navigate to `/tokenomics` (and back-and-forth from another route); donut renders on first paint with all 5 slices. Resize window; donut reflows.
- **deps:** [F5]
- **batchHint:** tokenomics-chart

---

## Batch: bottom-right-overlay-collision
F17 (code) and F49 (live) are the SAME collision — one fix.

### F49 — Towelie avatar covers the Protocol-Active price pill (live-confirmed)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `LiveActivity.tsx:43` pill = `fixed bottom-4 right-4 z-40 hidden md:block` (maxWidth 200, pointer-events none); `TowelieAssistant.tsx:329` = `fixed right-4 z-[60] bottom-20 md:bottom-4`. At ≥768px both anchor bottom-right; the higher-z avatar sits on the pill. Live agent confirmed via `elementFromPoint`.
- **approach:** Offset the pill clear of the avatar on md+ — change `LiveActivity.tsx:43` to `right-4 md:right-24` (or stack it above the avatar with a `md:bottom-20`). Pure CSS, additive, no art touched. Single change closes F17 too.
- **files:** `C:\...\frontend\src\components\LiveActivity.tsx:43`
- **effort:** S
- **risk:** low
- **test:** Desktop ≥768px, observe bottom-right: pill and avatar no longer overlap; pill price fully visible.
- **deps:** []
- **batchHint:** bottom-right-overlay-collision

### F17 — Protocol-Active pill and Towelie share bottom-4 right-4 (code-confirmed)
- **verdict:** duplicate
- **rootCause:** standalone
- **confirmed:** Same coordinates as F49 — see above.
- **approach:** Duplicate of **F49**; fixed by the same `LiveActivity.tsx:43` offset.
- **files:** `C:\...\frontend\src\components\LiveActivity.tsx:43`
- **effort:** S
- **risk:** low
- **test:** Covered by F49.
- **deps:** [F49]
- **batchHint:** bottom-right-overlay-collision

### F21 — "Protocol Active" pill is unconditional copy, not a health signal
- **verdict:** product-decision
- **rootCause:** T4 (overstated trust claim)
- **confirmed:** `LiveActivity.tsx:59-60` renders a green `PulseDot` + "Protocol Active" whenever the route allows, independent of RPC/price/pause state. Only the price portion (`:61-68`) is live. Against the honesty-pass standard a static green "Active" is a promise surface.
- **approach:** Needs an owner call on what "health" means, then drive the dot/label from something real — e.g. the age of the last successful price fetch (`useTOWELIPrice` already exposes `isLoaded`) and/or last successful RPC read: `Active` (fresh) vs `Degraded` (stale > N s). Reuse `priceInUsd>0 && isLoaded` already in scope. Until the owner defines the threshold this stays a decision (also overlaps F36 below).
- **files:** `C:\...\frontend\src\components\LiveActivity.tsx:59-60`
- **effort:** M
- **risk:** low
- **test:** Throttle/break RPC in devtools; pill flips to Degraded. With healthy RPC it reads Active.
- **deps:** []
- **batchHint:** bottom-right-overlay-collision

---

## Batch: scroll-restoration
F18 (low) and F38 (missing) are the same gap; F5's keyed remount is the enabler.

### F18 — Back/forward always scrolls to top (no POP restoration)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `App.tsx:109-113` `ScrollToTop` runs `window.scrollTo(0,0)` on every pathname change with no `useNavigationType` check; `AppLayout.tsx:135` `<div key={location.pathname}>` remounts content so native restoration is also defeated.
- **approach:** In `ScrollToTop`, consult `useNavigationType()` and skip the reset on `'POP'`. For full fidelity, store per-key scroll offsets in a `Map` keyed by `location.key` and restore on POP. Minimal first cut: just guard the reset. Pairs with relaxing the F5 remount so the restored DOM still exists.
- **files:** `C:\...\frontend\src\App.tsx:108-113`
- **effort:** S
- **risk:** low
- **test:** Scroll down a long page (e.g. /tokenomics), navigate into a detail route, hit Back → position restored (after F5). Forward PUSH still scrolls to top.
- **deps:** [F5]
- **batchHint:** scroll-restoration

### F38 — Scroll restoration on back/forward (missing-vs-best-in-class)
- **verdict:** duplicate
- **rootCause:** standalone
- **confirmed:** Same gap as F18 (no evidence body; `missingVsBestInClass`).
- **approach:** Duplicate of **F18**.
- **files:** `C:\...\frontend\src\App.tsx:108-113`
- **effort:** S
- **risk:** low
- **test:** Covered by F18.
- **deps:** [F18]
- **batchHint:** scroll-restoration

---

## Batch: route-transition-tuning
The 1s pointer-blocking glitch + full remount degrades in-page tab switches and route loads.

### F5 — 1000ms pointer-blocking glitch + full remount on every nav (incl. in-page tabs)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `AppLayout.tsx:48-53` every `GlitchConfig.duration: 1000`; the glitch overlay is full-screen and skippable (pointer-enabled) so it eats clicks up to 1s. `ActivityPage.tsx:47` and `LearnPage` switch tabs via `navigate(...)`, triggering the route glitch AND the `AppLayout.tsx:135` `key={pathname}` remount (state + queries lost) for an in-host tab change.
- **approach:** Additive tuning, not removal (art mandate). (1) In `getGlitchConfig`, detect same-host tab buckets (Points↔History↔Changelog all resolve to ActivityPage; Tokenomics↔FAQ↔Security↔Lore → LearnPage) and return a short/no glitch (e.g. `duration: 0` or a 200ms light variant) for those. (2) Change the remount key from `location.pathname` to a coarser key (the lazy-component/host identity) so same-component tab routes keep state and queries; only cross-page navigations remount. Drop `light` glitch duration to ~400ms while here.
- **files:** `C:\...\frontend\src\components\layout\AppLayout.tsx:42-54`, `:135`
- **effort:** M
- **risk:** med (remount-key change can affect every page's reset semantics — verify ErrorBoundary `resetKeys` still behaves)
- **test:** Switch Points→History: no full-screen glitch, no re-fetch flash, scroll/state retained. Cross-page nav (/farm→/swap) still glitches. Verify `ErrorBoundary` still resets on real route change.
- **deps:** []
- **batchHint:** route-transition-tuning

### F6 — Desktop glitch fetches up to 16 full-res art JPGs mid-transition, no preload
- **verdict:** fix-now
- **rootCause:** T12 (art pops in late)
- **confirmed:** `GlitchTransition.tsx:350-370` `generateSlices` picks up to `config.sliceCount` (16 on desktop, `AppLayout.tsx:48`) distinct images and renders each as four bg layers (`:435-459`); the mobile path preloads 3 (`:76-97`) but the desktop path never preloads → cold-cache burst of up to 16 × ~150-200KB for a 1s effect; slices render blank until each arrives.
- **approach:** Mirror the mobile preload: preload a small fixed pool (3-5) of slice images once (module-level or in the desktop branch) and draw slices only from the warmed pool, OR reuse the splash-preloaded images. Optionally serve downsized slice variants. Additive; keeps the effect and art.
- **files:** `C:\...\frontend\src\components\GlitchTransition.tsx:76-97` (pattern to mirror), `:350-370`
- **effort:** M
- **risk:** low
- **test:** DevTools cold cache + Network throttle, navigate /→/farm on desktop: no burst of >5 art requests; slices show warmed images, not blanks.
- **deps:** []
- **batchHint:** route-transition-tuning

### F52 — Inconsistent transition quality: Swap blank-dark flash + stray orange line; late hero mural
- **verdict:** fix-now
- **rootCause:** T12 (and T11 misleading skeleton)
- **confirmed (partial):** Swap route uses `SwapSkeleton` fallback (`App.tsx:137`) so the "almost-empty dark + floating orange divider + ghost footer" is the skeleton/footer showing through before the card mounts; Dashboard has richer skeletons. The "hero mural pops in 3-5s after text" is `HomePage.tsx:78` `ArtImg` with no blur-up/LQIP. Live-observed; the swap-flash specifics are plausible but not byte-verified.
- **approach:** (1) Improve `SwapSkeleton` to match the Dashboard skeleton density (card-shaped shimmer) so the route-loading state reads as intentional; hide/scrim the `Footer` while the route Suspense fallback is showing (the footer renders inside `AppLayout` regardless of route-load — gate it or let the skeleton fill min-height). (2) Add a blur-up/LQIP placeholder to the hero `ArtImg` (low-res inline blur → fade to full) — this is the shared T12 fix with F12/hero art across pages; do it in `ArtImg` so every page benefits. Additive, no art removed.
- **files:** `C:\...\frontend\src\components\PageSkeletons.tsx` (SwapSkeleton), `C:\...\frontend\src\pages\HomePage.tsx:78`, `C:\...\frontend\src\components\ArtImg.tsx`
- **effort:** M
- **risk:** med
- **test:** Throttle to Slow 3G: Swap route shows a card skeleton (not a void with a stray divider); hero mural fades up from a blur, no hard pop.
- **deps:** []
- **batchHint:** route-transition-tuning

---

## Batch: splash-skip-and-robustness
The splash can deadlock on a stalled preload and offers no touch/visible skip — both block users.

### F2 — Stalled image preload = indefinite black screen, all skip paths inert
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `AppLoader.tsx:205-218` starts the RAF loop only inside `preloadImages(srcs).then(...)`; `preload.ts:1-16` has no timeout (a hung image keeps the promise pending forever via `Promise.allSettled`). During `phase:'loading'` the overlay is opaque `#000` (`AppLoader.tsx:618`). The ESC handler (`:131-144`) only sets `phase='skip'` and the click handler (`:109-128`) only acts in hold/textForm/vortex — with no `tick` running, neither does anything. User is stuck.
- **approach:** Add a `Promise.race` timeout (3-4s) around `preloadImages` in `AppLoader.tsx` that resolves to the no-images path (sets `phase='textForm'` / starts the loop with `s.images=[]`, which the void→textForm branch at `:311` already supports). Independently, in the ESC handler and `handleClick`, if `phase==='loading'` call `finalize()` directly so the escape gestures always work even before the loop starts.
- **files:** `C:\...\frontend\src\components\loader\AppLoader.tsx:205-218`, `:109-144`, `C:\...\frontend\src\components\loader\preload.ts:1-16`
- **effort:** M
- **risk:** med (splash is timing-sensitive; verify no double-finalize)
- **test:** DevTools block `/splash/*` and `/art/*` requests, load fresh tab: splash falls through to the text-form path within ~4s; ESC during the initial black resolves immediately to the app.
- **deps:** []
- **batchHint:** splash-skip-and-robustness

### F3 — Mobile users cannot skip the first ~11s; ESC-only, undiscoverable
- **verdict:** fix-now
- **rootCause:** T10 (keyboard/skip gap)
- **confirmed:** `AppLoader.tsx:112` click handler ignores taps during void + art (≈ first 11s); early skip is ESC-only (`:131-144`, absent on touch); the only visible control is the mute button (`:634-657`). Replays per tab/session (`tf_loaded`).
- **approach:** Additive — render a small `Skip ▸` button styled like the existing mute button (`AppLoader.tsx:634-657`) that triggers the existing `'skip'` dissolve from ANY phase (reuse the ESC handler's `phase='skip'` logic, hoisted into a `skipNow()` callback shared by ESC + the button + the loading-phase guard from F2). Keeps all the art; gives every device an out. Closes F33 and F51's skip-hint complaint too.
- **files:** `C:\...\frontend\src\components\loader\AppLoader.tsx:131-144`, `:607-658`
- **effort:** S
- **risk:** low
- **test:** Mobile emulation, fresh session: a visible Skip control appears immediately and dissolves the splash on tap during the art gallery.
- **deps:** [F2]
- **batchHint:** splash-skip-and-robustness

### F33 — Splash auto-plays on first session entry to ANY route (incl. /terms, /risks)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `AppLayout.tsx:92` wraps the whole layout in `<AppLoader>`, not just `/`; a fresh-tab deep link to `/terms` plays the full ~14.5s experience (`constants.ts T_TEXT_END=14500`), gated per session by `tf_loaded`.
- **approach:** Minimum: the visible Skip control from F3 makes this tolerable everywhere. Recommended additive refinement (low risk): keep auto-play only on `/` — pass the current pathname into `AppLoader` and `shouldSkipAtMount()` returns true for non-`/` routes (still replayable via the TopNav bobowelie button at `TopNav.tsx:127-139`). Implement after F3 lands so the Skip button is the universal fallback.
- **files:** `C:\...\frontend\src\components\loader\AppLoader.tsx:28-43`, `C:\...\frontend\src\components\layout\AppLayout.tsx:92`
- **effort:** S
- **risk:** low
- **test:** Fresh tab → `/risks`: lands on legal text quickly (or with an obvious skip); `/` still plays the full splash; bobowelie button replays.
- **deps:** [F3]
- **batchHint:** splash-skip-and-robustness

### F51 — Splash: long black hold, no skip hint, tiny art labels (live)
- **verdict:** fix-now
- **rootCause:** T12 (and T10)
- **confirmed:** `constants.ts T_VOID_END=1500` (initial black), `T_ART_DURATION=2600`×`T_ART_COUNT=4`, then dissolve, then the `hold` gate ("CLICK TO ENTER"). Clicking mid-show skips but nothing says so; repeat visits correctly skip via `tf_loaded`.
- **approach:** The Skip control (F3) supplies the missing "click to skip" affordance. Additionally: shorten the initial void slightly and/or start the first art frame as soon as the first image preloads (the F2 timeout/preload work enables this), and add a small per-art progress indicator. Larger art labels handled in F61. Additive only.
- **files:** `C:\...\frontend\src\components\loader\constants.ts:51-55`, `C:\...\frontend\src\components\loader\AppLoader.tsx:205-218`
- **effort:** S
- **risk:** low
- **test:** Fresh session: visible skip hint, first art appears sooner, progress dots advance per piece.
- **deps:** [F2, F3]
- **batchHint:** splash-skip-and-robustness

### F61 — Splash art labels deserve more presentation (polish)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** Art titles come from `ART_COLLECTION` (`constants.ts:1-43`) and are drawn by the art phase (`phases/art.ts`, invoked at `AppLoader.tsx:369`) in small letter-spaced caps.
- **approach:** In the art-phase draw, bump the label font size and add a second line (collection name, e.g. "Nakamigos" / "JBAC"). Pure canvas-draw tweak; a free brand moment. Additive.
- **files:** `C:\...\frontend\src\components\loader\phases\art.ts` (label draw)
- **effort:** S
- **risk:** low
- **test:** Fresh session: art labels are clearly readable with a collection sub-line.
- **deps:** []
- **batchHint:** splash-skip-and-robustness

### F20 — Splash references missing /audio/ambient-loop.mp3 → guaranteed 404
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `AppLoader.tsx:106` `audio.playAmbient('/audio/ambient-loop.mp3')`; `frontend/public/audio` does not exist (Test-Path false per finding). `fx/audio.ts` catches the failure silently — no crash, but every first click/ESC fires a dead request, and the mute button mostly toggles audio that never plays (only synthesized SFX are real).
- **approach:** Owner choice: ship an `ambient-loop.mp3` (brand asset decision) OR remove the `playAmbient('/audio/...')` call and keep the WebAudio crack/shatter SFX. If removing, also hide/relabel the mute button to reflect SFX-only. Either way is small; the decision is "do we want ambient audio".
- **files:** `C:\...\frontend\src\components\loader\AppLoader.tsx:106`, `:634-657`
- **effort:** S
- **risk:** low
- **test:** Fresh session, Network tab: no 404 for `/audio/ambient-loop.mp3`; SFX still play on crack.
- **deps:** []
- **batchHint:** splash-skip-and-robustness

### F19 — Three splash JPGs (~500KB) preloaded on every page view; splash picks 4 of 41
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `index.html:70-72` preloads `mfers-heaven.jpg` (166KB), `mumu-bull.jpg` (143KB), `bobowelie.jpg` (185KB). `AppLoader.tsx:201` shuffles `ART_COLLECTION` (41 entries) and takes 4 → each preload has <10% hit chance; repeat visitors skip the splash entirely (`tf_loaded`) yet still pay the preload, and browsers log "preloaded but not used".
- **approach:** Keep `bobowelie.jpg` (it's the TopNav button + Towelie avatar, genuinely used). Drop the `mfers-heaven`/`mumu-bull` `<link rel=preload>` lines, or move them behind `fetchpriority="low"`. Simplest: delete the two unused preloads. Additive-safe (no art removed, just preload hints).
- **files:** `C:\...\frontend\index.html:70-72`
- **effort:** S
- **risk:** low
- **test:** Load any page, Network tab: no "preloaded but not used" warnings for mfers-heaven/mumu-bull; bobowelie still warm.
- **deps:** []
- **batchHint:** splash-skip-and-robustness

---

## Batch: onboarding-splash-gate
### F7 — ESC during splash also permanently dismisses the unseen OnboardingModal
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `OnboardingModal.tsx:43-45` mounts `open` on first visit (localStorage `tegridy-onboarding-seen` unset) underneath the splash; `Modal.tsx:74-76` registers a document keydown that calls `onClose()` on Escape; `OnboardingModal.close` (`:49-52`) writes the seen flag. `AppLoader.tsx:131-144` has its own window Escape handler. One ESC press fires both → skipping the splash silently marks onboarding seen. The modal's focus trap (`Modal.tsx:108-121`) also grabs focus while the splash still covers it.
- **approach:** Gate `OnboardingModal` mounting on splash completion: render it only after the loader's `onComplete`. `AppLoader` already accepts `onComplete` (`AppLoader.tsx:42`) but `AppLayout.tsx:92` passes none — thread a `splashDone` state from `AppLoader` up through `AppLayout` and render `<OnboardingModal/>` (currently `AppLayout.tsx:147`) only when `splashDone`. This also fixes the focus-trap-under-splash issue. Minimal and uses the existing `onComplete` hook.
- **files:** `C:\...\frontend\src\components\layout\AppLayout.tsx:92`, `:147`, `C:\...\frontend\src\components\loader\AppLoader.tsx:42`
- **effort:** S
- **risk:** low
- **test:** Clear storage, load `/`, press ESC to skip splash → OnboardingModal then appears (seen flag NOT pre-set); completing onboarding sets the flag.
- **deps:** []
- **batchHint:** onboarding-splash-gate

---

## Batch: layout-animation-domMax
### F1 — layoutId tab indicators are dead under LazyMotion domAnimation
- **verdict:** product-decision
- **rootCause:** T2
- **confirmed:** `App.tsx:221` wraps in `<LazyMotion features={domAnimation} strict>`; `domAnimation` does NOT include layout animation. 5 callsites use `layoutId`: `CommunityPage.tsx:101`, `LendingPage.tsx:209`, `AMMSection.tsx:472`, `NFTLendingSection.tsx:205`, `LendingSection.tsx:583`. Under `domAnimation` the `layoutId` is silently ignored — the active-tab pill teleports instead of springing (visual state still correct). The `App.tsx:214-220` comment claiming "not layout" is stale relative to these callsites.
- **approach:** Owner choice (bundle-size tradeoff): (A) switch `App.tsx:221` to `domMax` (+~10kb) so the spring underlines work as authored, or (B) accept the teleport and remove the `layoutId`/spring props at the 5 callsites so code matches reality. Either way, fix the `App.tsx:214-220` comment. Recommend (B) for the minimal-surface mandate unless the owner wants the animation. No art touched.
- **files:** `C:\...\frontend\src\App.tsx:214-221`, `C:\...\frontend\src\pages\CommunityPage.tsx:101`, `C:\...\frontend\src\pages\LendingPage.tsx:209`, `C:\...\frontend\src\components\nftfinance\AMMSection.tsx:472`, `C:\...\frontend\src\components\nftfinance\NFTLendingSection.tsx:205`, `C:\...\frontend\src\components\nftfinance\LendingSection.tsx:583`
- **effort:** S
- **risk:** low
- **test:** If (A): switch a tab, underline springs across. If (B): no console strict-mode complaint, underline still snaps to the active tab.
- **deps:** []
- **batchHint:** layout-animation-domMax

---

## Batch: seasonal-event-banner
### F4 — Ape Month banner advertises a +10% boost nothing implements (auto-activates 2026-07-01)
- **verdict:** product-decision
- **rootCause:** T4 (and T3 hardcoded-vs-chain)
- **confirmed:** `SeasonalEvent.tsx:4-23` hardcodes "Harvest Season — 2x points" (ended 2026-06-05) and "Ape Month — NFT boost bonus +10% for all holders" (2026-07-01→07-31, multiplier 1.1). `getActiveEvent` (`:27-32`) flips it live by date. No seasonal multiplier exists in `lib/pointsEngine.ts` and the on-chain JBAC boost is fixed (`constants.ts JBAC_BONUS_BPS`). On July 1 the shell will banner an unbacked "+10% for all holders" — violates the "no number the chain can't back" rule.
- **approach:** Owner must decide before 2026-07-01: either (A) wire a real event multiplier into `pointsEngine` and rewrite the banner copy to exactly what's applied, or (B) empty `SEASONAL_EVENTS` (or remove the Ape Month entry) until a backed event exists. (B) is the safe default — set `SEASONAL_EVENTS = []`. This is an honesty/product call, not a mechanical fix.
- **files:** `C:\...\frontend\src\components\SeasonalEvent.tsx:4-23`, `C:\...\frontend\src\lib\pointsEngine.ts`
- **effort:** S
- **risk:** low
- **test:** Mock `Date.now()` to 2026-07-15: banner either reflects a real, applied multiplier or does not render.
- **deps:** []
- **batchHint:** seasonal-event-banner

### F16 — animate-pulse-border class has no definition (inert)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `SeasonalEvent.tsx:99` applies `animate-pulse-border`; grep of `index.css` finds no `@keyframes pulse-border` or `--animate-pulse-border` token (only the unrelated `pulse-ring`/`border-glow`/`skeleton-pulse`). In Tailwind v4 an unknown utility emits no CSS → inert.
- **approach:** Reuse the existing `border-glow` animation (already defined in `index.css`) on the banner instead of the non-existent class, OR define `@keyframes pulse-border` + an `--animate-pulse-border` theme token. Cheapest: swap `animate-pulse-border` → the existing border-glow utility/class at `SeasonalEvent.tsx:99`.
- **files:** `C:\...\frontend\src\components\SeasonalEvent.tsx:99`, `C:\...\frontend\src\index.css` (if defining a token)
- **effort:** S
- **risk:** low
- **test:** Force an active event; banner border visibly pulses.
- **deps:** []
- **batchHint:** seasonal-event-banner

---

## Batch: transaction-receipt
### F10 — sanitize() HTML-escapes React text → visible &amp;/&#x27; entities
- **verdict:** fix-now
- **rootCause:** T6 (raw/garbled value rendering)
- **confirmed:** `TransactionReceipt.tsx:17-25` replaces `& < > " '` with HTML entities; every value is then rendered as a JSX text node (e.g. `:383`, `:368`, `:372`). React already escapes text content, so a pool named "Randy's Pool" renders as `Randy&#x27;s Pool` (and in the html2canvas copy). The escaping adds no security in this render path — it only corrupts display.
- **approach:** Drop the entity escaping for React-rendered values — replace `sanitize()` body with identity / a length-cap-only pass (keep `sanitizeTxHash` and any length capping). Keep the hash validator. Reserve real escaping for any future `innerHTML` path (there is none today).
- **files:** `C:\...\frontend\src\components\TransactionReceipt.tsx:17-25`
- **effort:** S
- **risk:** low
- **test:** Trigger a receipt with a token/pool name containing `'` and `&` → renders literally; copy-image text fallback also clean. Add a unit test on `sanitize("Randy's & Co")` returning the literal string.
- **deps:** []
- **batchHint:** transaction-receipt

### F11 — Share-to-X fallback URL points at tegridyfarms.io (not production)
- **verdict:** fix-now
- **rootCause:** T3 (drifted constant)
- **confirmed:** `TransactionReceipt.tsx:231` `const url = etherscanUrl ?? 'https://tegridyfarms.io';` — production is `https://tegridyfarms.vercel.app` (`usePageTitle.ts:4`, `index.html:28`). Synthetic receipts (no tx hash) tweet a domain the project may not own.
- **approach:** Replace the literal with a canonical `SITE_URL` constant. `usePageTitle.ts:4` defines `SITE_URL` privately — promote it to `lib/constants.ts` (or import from a shared place) and use it here. Closes the F46/F11 family of dead-domain links if `SITE_URL` becomes the single source.
- **files:** `C:\...\frontend\src\components\TransactionReceipt.tsx:231`, `C:\...\frontend\src\lib\constants.ts` (export SITE_URL)
- **effort:** S
- **risk:** low
- **test:** Build a synthetic receipt with no txHash, click Share to X → tweet URL is `tegridyfarms.vercel.app`.
- **deps:** []
- **batchHint:** transaction-receipt

---

## Batch: referral-links
### F46 — Referral links point at dead domain tegridy.farm
- **verdict:** fix-now
- **rootCause:** T3 (and T4 — dead share surface)
- **confirmed:** `ReferralWidget.tsx:71` `https://tegridy.farm/?ref=${address}` and `:94` `tegridy.farm/?ref=...` display string; the tweet (`:75`) embeds the same. `tegridy.farm` is unreachable (DNS-level fail per live agent). Every shared referral link/tweet dead-ends.
- **approach:** Point referral links at the canonical live origin until `tegridy.farm` is registered + aliased: use the shared `SITE_URL` (`tegridyfarms.vercel.app`) — or `window.location.origin` — at `ReferralWidget.tsx:71` and the display string at `:94`. Reuse the `SITE_URL` constant promoted in F11 so all share surfaces agree. (If the owner intends to register `tegridy.farm`, that's an operator task — but the code must not ship a dead link.)
- **files:** `C:\...\frontend\src\components\ReferralWidget.tsx:71`, `:94`, `C:\...\frontend\src\lib\constants.ts`
- **effort:** S
- **risk:** low
- **test:** Open Referral widget connected: link/preview shows `tegridyfarms.vercel.app/?ref=0x…`; the Tweet intent `url=` is the live origin; clicking resolves.
- **deps:** [F11]
- **batchHint:** referral-links

### F56 — Both Copy buttons flip to "Copied!" when only one is clicked
- **verdict:** fix-now
- **rootCause:** T5-adjacent (shared UI state)
- **confirmed:** `ReferralWidget.tsx:38` single `copied` state; both the top Copy button (`:157`) and the share-row Copy Link button (`:276`) read it, so one click toggles both labels.
- **approach:** Track copied state per button — either a `copiedKey: 'link'|'share'|null` state set by `handleCopy(source)`, or two booleans. Both buttons copy the same string, so a keyed state is cleanest. Minimal change in `ReferralWidget.tsx`.
- **files:** `C:\...\frontend\src\components\ReferralWidget.tsx:38`, `:77-92`, `:157`, `:276`
- **effort:** S
- **risk:** low
- **test:** Click the top Copy → only it shows "Copied!"; click the share-row Copy Link → only it does.
- **deps:** []
- **batchHint:** referral-links

---

## Batch: tab-host-credibility-and-a11y
### F9 — ActivityPage tab strip promotes "Gold Card" while PREMIUM_ACCESS is zeroed
- **verdict:** fix-now
- **rootCause:** T3 (gating drift)
- **confirmed:** `navConfig.ts:49` `PREMIUM_LIVE = isDeployed(PREMIUM_ACCESS_ADDRESS)` is false (`constants.ts` zero address) and hides Gold Card from the Footer (`Footer.tsx:24`). But `ActivityPage.tsx:7-19` hardcodes `gold:'Gold Card'` and renders all four tabs (`:67-81`), so `/leaderboard|/history|/changelog` show a promoted Gold Card tab dead-ending in the not-deployed placeholder.
- **approach:** Filter `TAB_LABELS`/`TAB_PATHS` through `PREMIUM_LIVE` the same way Footer/navConfig do — drop the `gold` tab from the rendered set when `!PREMIUM_LIVE` (and redirect `/premium` → `/leaderboard` while gated, or keep the route reachable but unpromoted). The tab reappears automatically on redeploy. Mirrors the existing `NFT_FINANCE_LIVE` pattern in `BottomNav.tsx:51`.
- **files:** `C:\...\frontend\src\pages\ActivityPage.tsx:5-31`, `:67`
- **effort:** S
- **risk:** low
- **test:** With `PREMIUM_ACCESS` zeroed: `/leaderboard` shows only Points/History/Changelog tabs; set a real address → Gold Card tab returns.
- **deps:** []
- **batchHint:** tab-host-credibility-and-a11y

### F22 — Inconsistent/incomplete tabs semantics across the three tab patterns
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `ActivityPage.tsx:71` and `LearnPage.tsx` use `aria-pressed` (toggle-button) for tabs; `CommunityPage.tsx:92-93` uses `role="tab"`/`aria-selected` but with no `role="tablist"` wrapper, no roving tabindex, no arrow-key nav. Three patterns, none WAI-ARIA-complete, mutually inconsistent.
- **approach:** Build one small accessible tab primitive (a `Tabs`/`TabList`/`Tab` set: `role=tablist` + `role=tab` + `aria-selected` + roving `tabindex` + Left/Right arrow navigation + `aria-controls`→`tabpanel`) and reuse it in ActivityPage, LearnPage, and the NFT-finance/Community hosts. Keep current visuals. This is the standardization that also underpins F1's underline.
- **files:** new `C:\...\frontend\src\components\ui\Tabs.tsx`; consumers `C:\...\frontend\src\pages\ActivityPage.tsx:67-82`, `C:\...\frontend\src\pages\LearnPage.tsx`, `C:\...\frontend\src\pages\CommunityPage.tsx:90-104`
- **effort:** M
- **risk:** med (touches multiple hosts)
- **test:** Keyboard: Tab into the strip, Arrow keys move between tabs, Enter/Space activates; screen reader announces "tab, selected". Run axe on each host.
- **deps:** []
- **batchHint:** tab-host-credibility-and-a11y

---

## Batch: nav-ia-and-naming
### F53 — Primary nav covers a fraction of the app; naming inconsistencies
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `PRIMARY_NAV` (`navConfig.ts:56-61`) = Dashboard/Farm/Trade(+NFT Finance), plus a 2-section `MORE_NAV_SECTIONS` (`:82-101`) and the right-aligned Tradermigos. The Footer exposes 13+ destinations not in the header. Same route `/leaderboard` is "Tegridy Score" in More (`:91`) but "Points" in the Footer (`Footer.tsx:25`); nav says "Trade" while the route/h1 say "Swap". `/nft-finance` sub-areas (Lending/AMM/Launchpad) aren't individually in the header.
- **approach:** IA is an owner call. Additive recommendation: expand `MORE_NAV_SECTIONS` into grouped sections (Engage / Stats / Docs+Legal) so more routes are reachable from the header dropdown, and unify the "Points" vs "Tegridy Score" label to ONE name across `navConfig.ts:91` and `Footer.tsx:25`. Don't remove sections/art. Decide the canonical labels first, then it's a small `navConfig`/`Footer` edit.
- **files:** `C:\...\frontend\src\lib\navConfig.ts:82-101`, `C:\...\frontend\src\components\layout\Footer.tsx:25`
- **effort:** M
- **risk:** low
- **test:** Every footer destination reachable from the header dropdown; "Points"/"Tegridy Score" reads identically in both places.
- **deps:** []
- **batchHint:** nav-ia-and-naming

### F26 — Dead exports + comment drift in navConfig (the nav single source of truth)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `navConfig.ts:111-115` `ALL_NAV` is consumed by zero components (TopNav uses `MORE_NAV_SECTIONS`/`MORE_NAV`; BottomNav hardcodes tabs) — only `navConfig.test.ts` asserts on it. The comment at `:106-110` says it's "used by the mobile drawer fallback" but the drawer (`TopNav.tsx:363`) uses `MORE_NAV_SECTIONS`. The comment at `:72-73` says "Three sections of three items" but `MORE_NAV_SECTIONS` has 2 sections of 2-3.
- **approach:** Delete `ALL_NAV` and its test (or wire it into the drawer if intended — but the drawer already uses the sections). Fix the `:72-73` "three sections of three" comment to match reality. Removes stale IA docs that future agents trust. Verify `MORE_NAV` is still used (it is — `TopNav.tsx:165`) before touching it.
- **files:** `C:\...\frontend\src\lib\navConfig.ts:72-73`, `:106-115`, `C:\...\frontend\src\lib\navConfig.test.ts`
- **effort:** S
- **risk:** low
- **test:** `npm test navConfig` green after removing the `ALL_NAV` assertions; app builds (no remaining import of `ALL_NAV`).
- **deps:** []
- **batchHint:** nav-ia-and-naming

---

## Batch: ios-pwa-safe-area
### F8 — Fixed header ignores env(safe-area-inset-top) despite iOS standalone opt-in
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `index.html:10` `apple-mobile-web-app-capable=yes`, `:21` `viewport-fit=cover`, manifest `display: standalone`. `TopNav.tsx:104-105` header is `fixed top-0 ... h-14` with no safe-area-top; `AppLayout.tsx:133` hardcodes `pt-14`. The wrong-network banner DOES handle it (`AppLayout.tsx:113` `top: calc(56px + env(safe-area-inset-top))`) — the header it sits under does not. On a notched iPhone home-screen launch the status bar overlays the header.
- **approach:** Add `padding-top: env(safe-area-inset-top)` to the header (and bump its effective height) and change the content offset from `pt-14` to `calc(3.5rem + env(safe-area-inset-top))`. Apply via inline style on `TopNav.tsx:104` header and the `AppLayout.tsx:133` wrapper (Tailwind can't express env() inline cleanly — use a style attr or an `index.css` utility). Mirrors the banner's existing pattern.
- **files:** `C:\...\frontend\src\components\layout\TopNav.tsx:104-105`, `C:\...\frontend\src\components\layout\AppLayout.tsx:133`
- **effort:** S
- **risk:** low
- **test:** iOS Safari "Add to Home Screen" on a notched device (or simulator with safe-area insets), launch standalone: header content clears the status bar; content top-offset matches.
- **deps:** []
- **batchHint:** ios-pwa-safe-area

### F30 — Standalone-PWA finish is partial (no status-bar-style, no startup images, no noscript)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `index.html` has `apple-mobile-web-app-capable` + valid manifest icons but no `apple-mobile-web-app-status-bar-style`, no `apple-touch-startup-image`, and no `<noscript>` (`index.html:77-80` body has only `#root` + the module script) — a JS-disabled visitor gets a blank page.
- **approach:** Add `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` (pairs with the F8 safe-area work), a one-line `<noscript>` notice inside `<body>`, and optionally startup-image links. Pure `index.html` additions.
- **files:** `C:\...\frontend\index.html:10-11`, `:77-80`
- **effort:** S
- **risk:** low
- **test:** Disable JS → see the noscript message; standalone launch shows the intended status-bar style.
- **deps:** [F8]
- **batchHint:** ios-pwa-safe-area

### F42 — PWA completeness if standalone stays enabled (missing-vs-best-in-class)
- **verdict:** duplicate
- **rootCause:** standalone
- **confirmed:** Overlaps F30 (status-bar-style, startup images, noscript) and F8 (safe-area). `missingVsBestInClass`, no separate evidence. The extra items it names — `beforeinstallprompt` handling + an offline fallback page — are net-new but low priority.
- **approach:** The status-bar/noscript/startup-image portion is **duplicate of F30**. If the owner wants install-prompt handling + an offline page, that's a separate small feature (service-worker + offline.html) — flag as a follow-up, not part of this surface's fix batch.
- **files:** `C:\...\frontend\index.html` (covered by F30)
- **effort:** S
- **risk:** low
- **test:** Covered by F30/F8.
- **deps:** [F30]
- **batchHint:** ios-pwa-safe-area

---

## Batch: bottom-nav-breakpoints
### F13 — 640-767px viewports get 80px dead bottom padding for a hidden bottom nav
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `BottomNav.tsx:60` uses `sm:hidden` (hidden ≥640px) but its comment (`:55-58`) claims R038 "restores it for ≥640px tablets" — `sm:hidden` does the opposite. `AppLayout.tsx:133` applies `pb-20 md:pb-0` and `index.css:143-147` forces `.safe-area-content-bottom { padding-bottom: calc(5rem + …) !important }` at `max-width:767px`. So 640-767px reserves ~80px for a nav that isn't rendered.
- **approach:** Align the breakpoints. The TopNav primary nav switches in at `sm:` (640px, `TopNav.tsx:149`), so the BottomNav should hide at the same point — keep `sm:hidden` on BottomNav but change the padding rules to `max-width:639px` (`index.css:143`) and `pb-20 sm:pb-0` (`AppLayout.tsx:133`) so the dead band disappears. Fix the contradictory comment at `BottomNav.tsx:55-58`.
- **files:** `C:\...\frontend\src\index.css:143-147`, `C:\...\frontend\src\components\layout\AppLayout.tsx:133`, `C:\...\frontend\src\components\layout\BottomNav.tsx:55-60`
- **effort:** S
- **risk:** low
- **test:** Resize to 700px: no bottom nav AND no reserved bottom gap; at 600px the bottom nav shows with matching padding.
- **deps:** []
- **batchHint:** bottom-nav-breakpoints

### F27 — Conflicting min-width utilities on BottomNav tab links
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `BottomNav.tsx:72` `flex-1 min-w-0 min-h-[48px] min-w-[44px]` — `min-w-0` (for truncation) and `min-w-[44px]` (tap target) are contradictory; winner depends on Tailwind's generated order, not intent.
- **approach:** Keep `min-w-0` on the link (so labels truncate) and rely on `flex-1` + `min-h-[48px]` + padding for the 44px tap floor (each tab already gets ≥44px width from `flex-1` across ≤5 tabs on a phone). Remove `min-w-[44px]`. Truncation already lives on the inner span (`:77`).
- **files:** `C:\...\frontend\src\components\layout\BottomNav.tsx:72`
- **effort:** S
- **risk:** low
- **test:** Phone widths 320-430px: all tabs ≥44px tap target, labels truncate without overflow.
- **deps:** []
- **batchHint:** bottom-nav-breakpoints

---

## Batch: a11y-focus-and-aria
### F12 — Drawer focus-restore steals focus to the hamburger on initial load
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `TopNav.tsx:91-100` `useEffect(... else { menuButtonRef.current?.focus(); }, [open])` — the else branch runs on first mount (`open=false`), not only after a close. On <640px the hamburger is visible, so page load programmatically focuses it (SR announces "Open navigation menu"). On desktop it's `sm:hidden` so it's a no-op.
- **approach:** Track a `wasOpen` ref and only restore focus when transitioning open→closed (`wasOpen.current && !open`). Minimal change in the existing effect. Standard pattern; no markup change.
- **files:** `C:\...\frontend\src\components\layout\TopNav.tsx:91-100`
- **effort:** S
- **risk:** low
- **test:** Reload a mobile-width page: focus stays on document/body, not the hamburger. Open then close the drawer: focus returns to the hamburger.
- **deps:** []
- **batchHint:** a11y-focus-and-aria

### F29 — #main-content lacks tabindex="-1" for reliable skip-link focus
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `AppLayout.tsx:97` renders the skip link → `#main-content`; `AppLayout.tsx:134` `<main id="main-content">` has no `tabindex`. Without `tabindex="-1"` some browsers scroll but don't move sequential focus, sending the next Tab back to the nav.
- **approach:** Add `tabIndex={-1}` to the `<main>` element. One-attribute change.
- **files:** `C:\...\frontend\src\components\layout\AppLayout.tsx:134`
- **effort:** S
- **risk:** low
- **test:** Tab to reveal the skip link, activate it, then Tab again → focus advances into main content, not back to the nav.
- **deps:** []
- **batchHint:** a11y-focus-and-aria

### F44 — Live region announcing route changes for screen readers (missing)
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** SPA navigations are silent — no `aria-live` region announces the new page. `usePageTitle` updates `document.title` (`usePageTitle.ts:47`) but title changes aren't reliably announced by SR on SPA route change. `missingVsBestInClass`.
- **approach:** Add a visually-hidden `aria-live="polite"` region in `AppLayout` that updates with the current page title on route change (drive it from the same `pageTitle` source, or a small `useRouteAnnouncer` hook reading `document.title` after each navigation). Additive, no visual change.
- **files:** `C:\...\frontend\src\components\layout\AppLayout.tsx` (add announcer near `:97`), optional new `C:\...\frontend\src\hooks\useRouteAnnouncer.ts`
- **effort:** S
- **risk:** low
- **test:** With a screen reader, navigate routes → the new page name is announced once per navigation.
- **deps:** []
- **batchHint:** a11y-focus-and-aria

### F59 — No aria-current on active nav items
- **verdict:** redeploy-only
- **rootCause:** T1
- **confirmed (HEAD):** Header/Bottom nav use react-router `NavLink` with a `className` callback (`TopNav.tsx:151-152`, `BottomNav.tsx:70-75`). `NavLink` emits `aria-current="page"` on the active link BY DEFAULT (not disabled here). So at HEAD the active link already has `aria-current`. The live `ariaCurrent:null` was observed on prod → stale build. Re-verify after deploy; if it's still null at HEAD in the browser, escalate to fix-now (add explicit `aria-current`).
- **approach:** No code change needed at HEAD — redeploy and re-verify. If verification fails, add `aria-current={isActive ? 'page' : undefined}` in the NavLink render props at `TopNav.tsx:151` and `BottomNav.tsx:70`.
- **files:** `C:\...\frontend\src\components\layout\TopNav.tsx:151`, `C:\...\frontend\src\components\layout\BottomNav.tsx:70` (only if re-verify fails)
- **effort:** S
- **risk:** low
- **test:** After redeploy, inspect the active header link → `aria-current="page"` present.
- **deps:** []
- **batchHint:** a11y-focus-and-aria

---

## Batch: seo-meta-hygiene
### F15 — Meta/og description goes stale on pages that don't pass one
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `usePageTitle.ts:61-67` sets description tags only `if (description)` with no cleanup; `FarmPage.tsx`, `AdminPage`, `ContractsPage`, `TreasuryPage` call `usePageTitle('X')` with no description → navigating Lore→Farm leaves Farm tagged with Lore's description. Title cleanup (`:58`) only resets `document.title`. The nakamigos sub-app (`nakamigos/App.jsx`) sets `document.title` directly and inherits the last main-app canonical/og:url.
- **approach:** In `usePageTitle`, when `description` is undefined, reset the description tags to the `index.html` default (capture the default once at module load, or a `DEFAULT_DESCRIPTION` const) in the effect/cleanup. Give Farm/Contracts/Treasury/Admin real descriptions at their `usePageTitle` calls. Route the nakamigos titles through `usePageTitle` (or a shared helper) so they reset canonical/og:url too.
- **files:** `C:\...\frontend\src\hooks\usePageTitle.ts:61-67`, `C:\...\frontend\src\pages\FarmPage.tsx`, `C:\...\frontend\src\pages\AdminPage.tsx`, `C:\...\frontend\src\pages\InfoPage.tsx` (Contracts/Treasury), `C:\...\frontend\src\nakamigos\App.jsx`
- **effort:** M
- **risk:** low
- **test:** Navigate Lore→Farm, inspect `meta[name=description]` → reflects Farm/default, not Lore. Nakamigos sets its own canonical.
- **deps:** []
- **batchHint:** seo-meta-hygiene

### F24 — NotFoundPage canonicalizes the bogus URL, served with HTTP 200
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `App.tsx:88` `usePageTitle('404 — Page Not Found')` → `usePageTitle.ts:52-56` sets `<link rel=canonical>` and og:url to `window.location.pathname` (the garbage path). With Vercel SPA rewrites returning 200, crawlers see a canonicalized soft-404.
- **approach:** Add a `noCanonical` (and `noIndex`) option to `PageTitleOptions`; on the 404 page skip canonical/og:url emission and inject `<meta name="robots" content="noindex">`. `usePageTitle` already takes an options object (`:44`) — extend it. Minimal.
- **files:** `C:\...\frontend\src\hooks\usePageTitle.ts:27-32`, `:51-56`, `C:\...\frontend\src\App.tsx:88`
- **effort:** S
- **risk:** low
- **test:** Visit `/garbage`: no `<link rel=canonical>` pointing at `/garbage`, and a `robots: noindex` meta is present.
- **deps:** []
- **batchHint:** seo-meta-hygiene

### F25 — Sitemap lists a redirect-only URL, omits /nakamigos, lastmod frozen 2026-04-19
- **verdict:** fix-now
- **rootCause:** T3 (and T1)
- **confirmed:** `sitemap.xml:9` lists `/lending` which `App.tsx:156` client-redirects to `/nft-finance`; no `/nakamigos` entry; every `<lastmod>` is `2026-04-19`. It also still promotes gated surfaces (`/premium` `:13`, `/community` `:10`).
- **approach:** Regenerate the sitemap: drop `/lending`, add `/nakamigos`, refresh `lastmod` (ideally wire into the deploy script so it's not hand-frozen). Consider dropping or lowering priority on gated `/premium`/`/community` while they're placeholder-gated. Static file edit + optional deploy-script hook.
- **files:** `C:\...\frontend\public\sitemap.xml`, (optional) deploy/build script
- **effort:** S
- **risk:** low
- **test:** Validate sitemap.xml; `/lending` absent, `/nakamigos` present, lastmod current.
- **deps:** []
- **batchHint:** seo-meta-hygiene

---

## Batch: towelie-tip-gating
### F34 — Towelie route tips overpromise gated features
- **verdict:** fix-now
- **rootCause:** T4 (and T3 gating drift)
- **confirmed:** `TowelieAssistant.tsx:84` `/nft-finance`: "Lend, borrow, trade NFTs. No oracles, no rugs.", `:83` `/community`, `:90` `/premium` — all three surfaces are isDeployed/PROMOTE-gated to placeholders today, so the tips promise functionality the page denies.
- **approach:** Gate these three tips on the same `*_LIVE` flags (`NFT_FINANCE_LIVE`/`COMMUNITY_LIVE`/`PREMIUM_LIVE` from `navConfig.ts`) — when not live, substitute a "coming soon"-style tip or suppress the tip for that route. Import the flags already exported from `navConfig`. Note: `PROMOTE_PENDING=true` currently forces NFT Finance/Community visible in nav while addresses are zeroed, so the tip and the placeholder page will still disagree — align the tip to the *page's actual deployed state* (isDeployed on the addresses), not the promotion flag.
- **files:** `C:\...\frontend\src\components\TowelieAssistant.tsx:77-99`
- **effort:** S
- **risk:** low
- **test:** On `/nft-finance` while contracts are zeroed: Towelie's tip doesn't promise live lending. After addresses land: the full tip returns.
- **deps:** []
- **batchHint:** towelie-tip-gating

---

## Batch: storage-safety
### F23 — Raw localStorage access in render/effect paths despite safeGetItem
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `App.tsx:205` `if (!localStorage.getItem('tegridy_first_visit'))` (raw read; the write uses `safeSetItem`) and `TopNav.tsx:21` `window.localStorage?.getItem('tegridy_admin')` — accessing `window.localStorage` throws `SecurityError` when site data is blocked; the optional chain doesn't guard the property access. `storage.ts:113-119` exports `safeGetItem` for exactly this.
- **approach:** Route both reads through `safeGetItem` (`lib/storage.ts:113`). `App.tsx:205` and `TopNav.tsx:21` → `safeGetItem('tegridy_first_visit')` / `safeGetItem('tegridy_admin')`. Two-line change; eliminates the SecurityError crash path.
- **files:** `C:\...\frontend\src\App.tsx:205`, `C:\...\frontend\src\components\layout\TopNav.tsx:21`
- **effort:** S
- **risk:** low
- **test:** Chrome → block site data → load app: no SecurityError in console; app renders. Admin flag still respected when storage works.
- **deps:** []
- **batchHint:** storage-safety

---

## Batch: toaster-offset
### F28 — Toast position never accounts for the fixed 56px header / mobile bottom nav
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `AppLayout.tsx:153-164` `<Toaster position="top-right" .../>` with no `offset`/`mobileOffset` — default sonner offset (~24-32px) puts toasts flush with / behind the `h-14` header on small screens.
- **approach:** Add `offset="72px"` (and a `mobileOffset` clearing the header, and on bottom-anchored mobile toasts the bottom nav) to the existing `<Toaster>`. One-prop change; sonner supports it.
- **files:** `C:\...\frontend\src\components\layout\AppLayout.tsx:153-164`
- **effort:** S
- **risk:** low
- **test:** Fire a toast on a narrow viewport: it renders fully below the header, not clipped.
- **deps:** []
- **batchHint:** toaster-offset

---

## Batch: glitch-perf-polish
### F31 — GlitchTransition: duplicate slice entry + per-frame getImageData without willReadFrequently
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `GlitchTransition.tsx:19` & `:21` list both `/splash/new/28.avif` and `/splash/new/28.jpg` (same artwork twice in the slice pool). `MobileGlitchTransition`'s canvas context (`GlitchTransition.tsx:107` `canvas.getContext('2d')`) does per-frame `getImageData`/`putImageData` displacement (`:203-214`) without `{ willReadFrequently: true }` — Chrome warns and slow-paths.
- **approach:** Remove the duplicate `#28` entry (keep one format) and pass `{ willReadFrequently: true }` to both glitch canvas `getContext('2d')` calls (the splash loader already does this at `AppLoader.tsx:151` — same pattern). Pure perf/correctness, no visual change.
- **files:** `C:\...\frontend\src\components\GlitchTransition.tsx:19-21`, `:107`
- **effort:** S
- **risk:** low
- **test:** Trigger a mobile glitch transition: no Chrome "willReadFrequently" warning; #28 not double-weighted in the slice pool.
- **deps:** []
- **batchHint:** glitch-perf-polish

### F32 — btn-primary disabled state carries old purple inset on a green button + stale comment
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `index.css:280` `.btn-primary:disabled { ... box-shadow: inset 0 1px 0 rgba(167,139,250,0.15); }` references the old purple (#a78bfa) while the button was rethemed to Kyle-green (`index.css:254-258`). The light-mode nav-link comment at `index.css:664` says "against the cream backdrop" while the light header is Kenny orange.
- **approach:** Change the disabled inset to a green/neutral tone (or drop the inset) at `index.css:280`; fix the stale comment at `:664` (already covered by F63's comment fix — coordinate so it's edited once).
- **files:** `C:\...\frontend\src\index.css:280`, `:664`
- **effort:** S
- **risk:** low
- **test:** Disable a primary button: inset highlight is green/neutral, not purple.
- **deps:** []
- **batchHint:** glitch-perf-polish

---

## Batch: stale-prod-redeploy
These live-agent findings reproduce only on prod; HEAD is already correct. One redeploy closes them. (See `reference_vercel_deploy_procedure`.)

### F48 — "Dashboard" shows active while on Home (/)
- **verdict:** redeploy-only
- **rootCause:** T1
- **confirmed:** Live agent could NOT reproduce on localhost HEAD (link stays cream); only on prod after visiting /dashboard. HEAD's `NavLink` active matching is correct.
- **approach:** Redeploy prod from HEAD, then re-verify the active-nav state on `/`. No code change.
- **files:** (deploy only)
- **effort:** S
- **risk:** low
- **test:** After deploy: visit /dashboard then /, header "Dashboard" is not active.
- **deps:** []
- **batchHint:** stale-prod-redeploy

### F58 — eth.llamarpc.com 503 on page load
- **verdict:** redeploy-only
- **rootCause:** T1
- **confirmed (HEAD):** `wagmi.ts:13-18` already demotes llamarpc to LAST in the `fallback([...])` list (comment: "demoted to last-resort: observed 503/521"). `fallback` tries transports in order, not in parallel, so at HEAD llamarpc is only hit if publicnode AND ankr both fail. The live 503 was the stale prod build (or a transient where the first two failed). 
- **approach:** Redeploy from HEAD. No code change — the demotion already landed. (If 503s persist post-deploy on every load, escalate to a health-check/removal — but that's not the current HEAD state.)
- **files:** (deploy only; `C:\...\frontend\src\lib\wagmi.ts:13-18` already correct)
- **effort:** S
- **risk:** low
- **test:** After deploy, Network tab on cold load: no `eth.llamarpc.com` request unless the first two RPCs fail.
- **deps:** []
- **batchHint:** stale-prod-redeploy

### F54 — NFT Finance page document.title generic + raw "--%" protocol-fee stat
- **verdict:** fix-now
- **rootCause:** T1 (title) + T6 (raw `--%`)
- **confirmed:** Title: `LendingPage.tsx:85` already calls `usePageTitle('NFT Finance', ...)` at HEAD → sets "NFT Finance | Tegridy Farms". The live "stays generic after /restake→/nft-finance" is stale prod (redeploy fixes the title). Raw stat: `LendingSection.tsx:501` `protocolFeeBps !== undefined ? \`${bpsToPercent(...)}%\` : '--%'` — when the read is undefined (contract not deployed / read fails) it renders literal `--%`.
- **approach:** Split: the **title** is redeploy-only (already correct at HEAD). The **`--%`** is a fix-now — replace the `'--%'` fallback at `LendingSection.tsx:501` with a known protocol-fee constant (if one exists in `constants.ts`) or an honest `'TBD'`/`'—'` placeholder consistent with the not-deployed gating. Mirror at `NFTLendingSection.tsx:161` if it has the same pattern.
- **files:** `C:\...\frontend\src\components\nftfinance\LendingSection.tsx:501`, `C:\...\frontend\src\components\nftfinance\NFTLendingSection.tsx:161`
- **effort:** S
- **risk:** low
- **test:** With contracts zeroed, the Protocol Fee stat shows "TBD" (not "--%"); after redeploy the page title reads "NFT Finance | Tegridy Farms".
- **deps:** []
- **batchHint:** stale-prod-redeploy

---

## Batch: 404-and-dashboard-polish
### F62 — 404 could route users better
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `App.tsx:87-106` `NotFoundPage` has the starfield, "404 Page Not Found", and a single "Back to Home" button — no quick links to Farm/Trade/Dashboard.
- **approach:** Additive — add 3 quick links (Farm, Trade, Dashboard) below the existing button, keep the starfield art and copy. Small JSX addition in `NotFoundPage`.
- **files:** `C:\...\frontend\src\App.tsx:90-104`
- **effort:** S
- **risk:** low
- **test:** Visit /garbage → 3 working quick links plus Back to Home; art unchanged.
- **deps:** []
- **batchHint:** 404-and-dashboard-polish

### F60 — Dashboard ETH balance card shows bare em-dash for USD value
- **verdict:** fix-now
- **rootCause:** T6 (and T11)
- **confirmed (live):** TOWELI card shows `$22.86` but the ETH balance card shows `—` where its USD value should be (TOWELI gets a USD line, ETH does not). Needs the DashboardPage source open to pin the line, but the live evidence is specific and consistent.
- **approach:** Price ETH via the same price feed used for TOWELI USD (or, if no ETH/USD feed is wired, omit the USD line entirely for consistency rather than showing a lone em-dash). Locate the ETH balance card in `DashboardPage.tsx` and either populate or remove the USD sub-line.
- **files:** `C:\...\frontend\src\pages\DashboardPage.tsx` (ETH balance card)
- **effort:** S
- **risk:** low
- **test:** Dashboard connected: ETH card either shows a real `$` value or no USD line — never a bare `—`.
- **deps:** []
- **batchHint:** 404-and-dashboard-polish

---

## Batch: ultrawide-layout
### F55 — Non-art pages waste the ultrawide canvas
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed (live):** Home/Farm fill the width with the mural; `/swap`, `/community`, `/tokenomics` float a narrow column in a flat-black void at 3000+ CSS px.
- **approach:** Owner call on direction. Additive options (no art removed): on `xl+` give Swap a side panel (route detail / recent trades / chart), let stat pages use 2-column layouts, OR extend the mural/starfield art to these routes so the void reads as intentional. Recommend the last (extend art) as the cheapest brand-consistent fix, but it's a design decision.
- **files:** `C:\...\frontend\src\pages\TradePage.tsx`, `C:\...\frontend\src\pages\CommunityPage.tsx`, `C:\...\frontend\src\pages\TokenomicsPage.tsx` (layout wrappers)
- **effort:** L
- **risk:** low
- **test:** At ≥2560px: Swap/Community/Tokenomics no longer sit in a bare black void.
- **deps:** []
- **batchHint:** ultrawide-layout

---

## Batch: missing-best-in-class (product backlog)
These five are `missingVsBestInClass` net-new features with no current-code defect — each needs an owner decision to schedule, not a bug fix. Listed for completeness; none block launch.

### F35 — Global pending-transaction indicator in the header
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** No shell-level in-flight-tx indicator exists; `TransactionReceipt` is per-action only. Net-new feature.
- **approach:** Owner-scheduled feature: a header wallet-chip spinner/count driven by a global pending-tx store (could subscribe to wagmi's pending writes). Build after the higher-priority fixes; out of scope for a bug-fix pass.
- **files:** (new) `C:\...\frontend\src\components\layout\TopNav.tsx` + a tx-tracking context
- **effort:** M
- **risk:** low
- **test:** Initiate a stake; header shows a pending spinner until confirmed across page navigations.
- **deps:** []
- **batchHint:** missing-best-in-class

### F36 — Real protocol/network health surface (gas widget + RPC-driven status)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** Overlaps F21 — the existing pill is static copy; no gas widget or degraded-mode banner. Net-new.
- **approach:** Owner-scheduled. The health-driven status overlaps F21's fix (drive the pill from RPC/price freshness); a gas-price widget is additional. Treat F21 as the first increment; the gas widget is a separate backlog item.
- **files:** `C:\...\frontend\src\components\LiveActivity.tsx` (shared with F21), (new) gas widget
- **effort:** M
- **risk:** low
- **test:** Degraded RPC → status reflects it; gas widget shows current gwei.
- **deps:** [F21]
- **batchHint:** missing-best-in-class

### F37 — Command palette / global search (Cmd+K)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** No Cmd+K palette exists. Net-new, standard in best-in-class DeFi shells.
- **approach:** Owner-scheduled feature (routes/tokens/docs search). Out of scope for a defect-fix pass; schedule separately.
- **files:** (new) `C:\...\frontend\src\components\CommandPalette.tsx`
- **effort:** L
- **risk:** low
- **test:** Cmd+K opens a searchable palette that navigates to routes.
- **deps:** []
- **batchHint:** missing-best-in-class

### F39 — Per-page OG images
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `usePageTitle.ts:28-29,:70` supports an `ogImage` override but every route ships the same `DEFAULT_OG_IMAGE` (gallery collage). Net-new content work.
- **approach:** Owner-scheduled: generate per-page (or per-position) OG cards and pass `ogImage` per route. The hook plumbing already exists — this is an asset/generation effort, not a code defect.
- **files:** consumers' `usePageTitle(...)` calls + an OG-render script
- **effort:** L
- **risk:** low
- **test:** Each route's `og:image` differs; social preview shows the page-specific card.
- **deps:** []
- **batchHint:** missing-best-in-class

### F40 — "Add TOWELI to wallet" (wallet_watchAsset) quick action
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** No `wallet_watchAsset` quick action next to the contract-address copy chip (Footer `:98-103`). Net-new.
- **approach:** Owner-scheduled, but small and high-value: add an "Add TOWELI to wallet" button near the Footer contract chip (and/or header) that calls `wallet_watchAsset` via the connected provider. Could be folded into a polish PR if the owner greenlights.
- **files:** `C:\...\frontend\src\components\layout\Footer.tsx:98-103` (+ a small hook)
- **effort:** S
- **risk:** low
- **test:** Connected wallet: clicking adds TOWELI to the wallet's token list.
- **deps:** []
- **batchHint:** missing-best-in-class

### F41 — Session continuity (recent-tx dropdown + per-device "skip intro permanently")
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** No header recent-transactions dropdown; splash skip is per-session only (`tf_loaded` in sessionStorage, `AppLoader.tsx:30-39`), not a persisted per-device preference.
- **approach:** Owner-scheduled. The "skip intro permanently" half is cheap (a localStorage preference checked in `shouldSkipAtMount` alongside `tf_loaded`) and pairs naturally with the F3 skip work; the recent-tx dropdown overlaps F35. Recommend doing the persisted-skip toggle as part of the splash batch if greenlit; defer the dropdown to F35.
- **files:** `C:\...\frontend\src\components\loader\AppLoader.tsx:28-39` (persisted skip), (new) recent-tx dropdown
- **effort:** M
- **risk:** low
- **test:** Check "don't show again" on the splash → never replays on that device until cleared.
- **deps:** [F3, F35]
- **batchHint:** missing-best-in-class

### F43 — Locale/number-format awareness (i18n scaffolding)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** All copy/meta are en-US; no i18n scaffolding. Explicitly "acceptable now" per the finding.
- **approach:** Owner-scheduled, low priority. At minimum, number-format localization via `Intl.NumberFormat` in the shared formatters (`lib/formatting.ts`) could be a first step without full i18n. Defer unless a non-US launch is planned.
- **files:** `C:\...\frontend\src\lib\formatting.ts` (number-format step)
- **effort:** L
- **risk:** low
- **test:** With a non-US locale, numbers render in the locale's grouping/decimal format.
- **deps:** []
- **batchHint:** missing-best-in-class
