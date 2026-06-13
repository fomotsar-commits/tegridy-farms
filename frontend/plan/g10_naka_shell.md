# Remediation Plan — g10_naka_shell

Surface: Nakamigos (Tradermigos) shell / routing / header / nav / error-boundary / onboarding / splash.
Branch: `mvp-launch` @ HEAD. Repo root: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend`.

All 37 findings were opened against the real source at HEAD and confirmed (or reclassified). The Nakamigos sub-app is **JSX** and mounted under the parent app's `BrowserRouter` (`frontend/src/App.tsx`), or standalone via `frontend/src/nakamigos/main.jsx` (also BrowserRouter). No `react-query` is used outside `useListings`; the shell has its own theme/toast/context stack distinct from the main app.

**Big picture:** the single highest-leverage fix is the **gallery-route shorthand** (T-standalone but it spawns F525/F538 and touches the modal-close path). The second is **consolidating the three stats/activity pollers** (F533, the prod rate-limiter risk). The third is an **accessibility cluster** on the splash + nav (F527/F534/F557/F558/F559). Everything else is additive polish that respects the owner's "never remove art/sections" mandate.

---

## Batch: gallery-route-fix
**Summary:** One root cause — `handleTabChange` builds the gallery URL as an empty trailing segment (`/nakamigos/<slug>/`) and `parseRoute` defaults a bare collection path to `listings`. That single mismatch makes Gallery unreachable from every nav surface (F525) and makes the modal-close/Escape land on Floor instead of Gallery (F538). Fix the URL construction once and round-trip-test it. Land F525 and F538 together.

### F525 — Gallery nav lands on Floor (gallery unreachable from every nav surface)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `App.jsx:358` builds `/nakamigos/${slug}/${newTab === "gallery" ? "" : newTab}` → `/nakamigos/<slug>/` ; `parseRoute` (`App.jsx:91`) maps `segments[1] || "listings"` so a bare collection path resolves to `listings`. `VALID_TABS` (`constants.js:68`) includes `gallery`, so a typed `/<slug>/gallery` works — proving only the URL builder is wrong. Header "Gallery" (`Header.jsx:127`), MobileNav gallery (`MobileNav.jsx:5`), logo click (`Header.jsx:367`), keyboard `g`/`1` (`App.jsx:417,453`), and the `onNavigateGallery`/`onFilterGallery` flows (`App.jsx:629,647`) all funnel through `handleTabChange("gallery")`.
- **approach:** In `handleTabChange` emit the explicit segment: `navigate(\`/nakamigos/${collectionSlug}/${newTab}\`)` for every tab (drop the `=== "gallery" ? "" : newTab` shorthand). Keep `parseRoute`'s `|| "listings"` default for the truly-bare `/nakamigos/<slug>` entry path (that is the intended Floor landing). This is the minimal change that keeps the deliberate Floor-default while making the gallery segment explicit.
- **files:** `src/nakamigos/App.jsx:358`
- **effort:** S
- **risk:** med (routing is load-bearing across all tabs; the title-effect at `App.jsx:341-344` keys gallery off `tab === "gallery"` and still works since the parsed tab is unchanged)
- **test:** Extend `src/nakamigos/navRouting.test.jsx` with a round-trip: for every entry in `VALID_TABS`, feed `handleTabChange(tab)`'s constructed pathname through `parseRoute` and assert `parseRoute(url).tab === tab`. Manual: click Gallery in desktop nav, mobile bottom-nav, logo, and press `g` — assert URL is `/nakamigos/nakamigos/gallery` and the Gallery nav item shows active.
- **deps:** []
- **batchHint:** gallery-route-fix

### F538 — Closing a deep-linked modal silently switches Gallery → Floor
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `App.jsx:496` (Escape) and `App.jsx:762` (X/onClose) `navigate(\`/nakamigos/${collectionSlug}\`, { replace: true })` when path includes `/nft/`; that bare path parses to `listings` (`App.jsx:91`) while `/:collection/nft/:id` parsed to `gallery` (`App.jsx:95`). So the tab under the modal swaps from gallery to Floor on close. Same family as F525.
- **approach:** Change both close paths to `navigate(\`/nakamigos/${collectionSlug}/gallery\`, { replace: true })` — uses the explicit segment F525 establishes.
- **files:** `src/nakamigos/App.jsx:496`, `src/nakamigos/App.jsx:762`
- **effort:** S
- **risk:** low
- **test:** Open a `/nft/:id` deep link, close via X then via Escape; assert the underlying tab stays Gallery (not Floor) and the URL is `/nakamigos/<slug>/gallery`.
- **deps:** [F525]
- **batchHint:** gallery-route-fix

---

## Batch: deeplink-modal-fix
**Summary:** Two related deep-link defects: shared `?token=` links never open the modal because the URL-sync effect deletes the param before the reader effect runs (F526), and `/nft/:id` links outside the loaded pages open an empty placeholder shell because they never fetch (F535). Both are fixed by making the readers authoritative and reusing the existing `fetchTokensByIds` fallback. Land together.

### F526 — Shared `?token=` links never open the modal (sync effect deletes the param first)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** The URL→modal **sync** effect (`App.jsx:280-288`) is declared BEFORE the param **reader** effect (`App.jsx:291-309`). On mount `selected` is null → `next=null`, `current='<id>'` differ → the sync effect runs `url.searchParams.delete("token")` + `replaceState`. React runs same-component effects in declaration order, so by the time the reader runs, `window.location.search` no longer has `token`; it sets `tokenParamHandled.current = true` and never opens the modal. `Modal.jsx:343` is exactly the link that's produced, so this is the canonical share path.
- **approach:** Capture the initial token param ONCE before any effect can mutate the URL — read `new URLSearchParams(window.location.search).get("token")` into a `useRef` initializer (runs during render, before effects) or a module-mount snapshot, and have the reader effect consume that captured value instead of re-reading `window.location.search`. Minimal alternative: guard the sync effect with `if (!tokenParamHandled.current) return;` so it cannot delete the param until the reader has consumed it. Prefer the ref-capture (deterministic, no ordering coupling).
- **files:** `src/nakamigos/App.jsx:280-288`, `src/nakamigos/App.jsx:291-309`
- **effort:** S
- **risk:** med (touches the modal-open + URL-write lifecycle; verify it still clears `?token=` when the user manually closes the modal)
- **test:** Add a jsdom test that mounts `CollectionView` with `window.location.search = "?token=11007"` and asserts `setSelected` is called (modal opens). Manual: copy a share link from the modal, paste in a fresh tab — modal opens on the right token.
- **deps:** []
- **batchHint:** deeplink-modal-fix

### F535 — `/nft/:id` deep link outside loaded pages opens an empty placeholder modal
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `App.jsx:330-338` — when `deepLinkTokenId` isn't in `nfts.allTokens`, it `setSelected({ id, name: \`#${id}\`, attributes: [], image: null })` with NO fetch. The `?token=` handler immediately above (`App.jsx:303-308`) already calls `fetchTokensByIds([id], collection.contract, collection.metadataBase)` for exactly this case. `useNfts` loads 40/page, so any shared `/nft/:id` past page 1 shows a blank shell. `Modal.jsx` has no metadata self-fetch.
- **approach:** In the `/nft/:id` effect, replace the placeholder `setSelected` with the same `fetchTokensByIds(...)` fallback used by the `?token=` handler — set the placeholder first (so the modal opens immediately) then patch in the fetched token via `.then((arr) => arr?.[0] && setSelected(arr[0]))`. Reuse the existing import, no new code path.
- **files:** `src/nakamigos/App.jsx:330-338`
- **effort:** S
- **risk:** low
- **test:** Deep-link to a token id known to be beyond page 1 (e.g. `/nakamigos/nakamigos/nft/19000`); assert the modal renders the real image + traits, not a blank `#19000` shell.
- **deps:** []
- **batchHint:** deeplink-modal-fix

---

## Batch: errorboundary-escape-hatch
**Summary:** The ErrorBoundary "Go Home" button writes `window.location.hash` on a BrowserRouter app, which does not navigate — so a deterministically-crashing tab is an inescapable loop (F529), and the same boundary prints a raw stack trace to retail users (F545). Both live in `ErrorBoundary.jsx`; fix together.

### F529 — ErrorBoundary "Go Home" sets `window.location.hash` on a BrowserRouter app (inescapable crash loop)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `ErrorBoundary.jsx:134` `window.location.hash = "#/nakamigos/"`. The app mounts under BrowserRouter (`nakamigos/main.jsx` standalone; embedded via parent `frontend/src/App.tsx`). Hash changes don't change pathname → the crashing route re-renders; line 133 does `setState({hasError:false})` first, so a render-time crash is re-caught → user stuck. The tab boundary at `App.jsx:745` intentionally passes no `onReset` (comment: "Go Home button is the escape hatch") — i.e. the documented escape hatch is the broken one. `NotFound.jsx:31` has the same dead-hash fallback but is mitigated (both `App.jsx` call sites pass `onGoHome`).
- **approach:** Replace the hash write with a hard `window.location.href = "/nakamigos"` — matches the app-level boundary's own pattern at `App.jsx:967` (`onReset={() => window.location.href = '/nakamigos'}`). Hard nav guarantees a fresh document and breaks the loop. (Optional, additive: also accept an `onGoHome` prop so the tab boundary could pass a router `navigate` — but the hard-href is the minimal, consistent fix.) While here, fix `NotFound.jsx:31`'s identical dead fallback to `window.location.href = "/nakamigos"` for safety even though it's currently masked.
- **files:** `src/nakamigos/components/ErrorBoundary.jsx:134`, `src/nakamigos/components/NotFound.jsx:31`
- **effort:** S
- **risk:** low
- **test:** Temporarily throw in a tab body, click "Go Home" — assert the app navigates to `/nakamigos` (landing) and the error screen is gone. Verify "Try Again" still retries the same tab.
- **deps:** []
- **batchHint:** errorboundary-escape-hatch

### F545 — Non-chunk errors render the raw stack trace to end users
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `ErrorBoundary.jsx:102-104` prints `(error?.message) + "\n\n" + (error?.stack || "")` in the user-facing card (`wordBreak:break-all`, `maxHeight:300`, `overflow:auto`). Hostile for a retail marketplace.
- **approach:** Show `error?.message` only; gate the stack behind `import.meta.env.DEV` (or a collapsible `<details>` disclosure). Keep the card markup/styling intact — just conditionalize the stack string.
- **files:** `src/nakamigos/components/ErrorBoundary.jsx:102-104`
- **effort:** S
- **risk:** low
- **test:** Build prod (`import.meta.env.DEV === false`), trigger a non-chunk error, assert only the message renders. In dev, assert the stack still shows.
- **deps:** []
- **batchHint:** errorboundary-escape-hatch

---

## Batch: ipad-nav-breakpoint
**Summary:** Pure CSS breakpoint alignment. At exactly 768px every nav surface is hidden (F528), and the legacy `.hamburger`/`.mobile-nav` drawer is dead at every width because `!important` rules always beat the show rule (F539). These conflict and confuse each other — resolve as one CSS pass. F539 has an owner-decision component (revive vs. excise the drawer); the breakpoint fix (F528) is unconditional.

### F528 — At exactly 768px (iPad portrait) every navigation surface is hidden
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `.desktop-nav { display:none }` inside `@media (max-width:768px)` (`App.css:1356` open, rule `:1370`) → hides at ≤768. `.hamburger { display:none !important }` inside `@media (min-width:768px)` (`App.css:1437`) → hides at ≥768. `.mobile-bottom-nav { display:flex !important }` only inside `@media (max-width:767px)` (`App.css:3704-3707`) → NOT at 768. Net at exactly 768px: no desktop nav, no hamburger, no bottom nav. Violates the "flawless on iPads" mandate (iPad Mini/9.7"/10.2" portrait = 768 CSS px).
- **approach:** Align the boundaries so two ranges share an edge. Simplest: change the bottom-nav media to `@media (max-width: 768px)` (`App.css:3704`) so the bottom nav covers 768, OR change `.desktop-nav` hide to `@media (max-width: 767px)` so desktop nav survives at 768. Given the desktop nav at 768 would be cramped, prefer **bottom-nav ≤768** (and bump the sibling `.desktop-controls`/`.hamburger` hide rule at `3713`/`3704` block to ≤768 to match). Verify no new overlap at 768.
- **files:** `src/nakamigos/App.css:3704` (and the related ≤767 sibling rules in that block, `3709`/`3713`)
- **effort:** S
- **risk:** med (breakpoint edits ripple; test 767/768/769 and 1024)
- **test:** In Chrome DevTools device toolbar set width exactly 768 (iPad portrait) — assert the bottom nav is visible and tappable. Re-check 767 and 769 still show exactly one nav surface. Use the project's iPad responsive standard.
- **deps:** []
- **batchHint:** ipad-nav-breakpoint

### F539 — Hamburger button + `.mobile-nav` drawer are dead UI at every viewport width
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** Base `.hamburger { display:none }` (`App.css:1023`); `display:flex` at ≤768 (`App.css:1371`, non-important); `display:none !important` at ≤767 (`App.css:3713`) and at ≥768 (`App.css:1437`). The `!important` rules win at every width — the show rule can never apply. `Header.jsx:438-442` still ships the button + `mobileOpen` state + the `.mobile-nav` drawer (`Header.jsx:561-569`). Mobile actually navigates via `MobileNav` (`.mobile-bottom-nav`). So the hamburger/drawer are unreachable dead code that also muddied the 768px analysis.
- **approach (owner call):** Two options, no middle ground per the finding. (A) **Revive** the drawer for the tablet band to also close the 768 gap: scope `.hamburger { display:flex }` to e.g. `@media (min-width:768px) and (max-width:1024px)` and remove the competing `!important` hides in that band — this gives iPad portrait a real menu. (B) **Excise** the dead `mobileOpen` state + hamburger button (`Header.jsx:438-442`) + `.mobile-nav` drawer (`561-569`) and rely on `MobileNav` only (then F528 alone closes the 768 gap). Do not leave both. **Recommendation:** (B) excise — `MobileNav` already covers mobile/tablet, and removing dead code is lower-risk than re-introducing a second drawer. (Additive-art mandate is not implicated — this is dead control markup, not art/sections.)
- **files:** `src/nakamigos/components/Header.jsx:278,327,438-442,561-569`; `src/nakamigos/App.css:1023,1371,1437,3713`
- **effort:** M
- **risk:** med
- **test:** After excise: grep confirms no `.hamburger`/`.mobile-nav` references remain orphaned; at 768/375/1024 the only nav is `MobileNav`/desktop-nav respectively. After revive: hamburger toggles the drawer at 768–1024 and nav works.
- **deps:** [F528]
- **batchHint:** ipad-nav-breakpoint

---

## Batch: poller-consolidation
**Summary:** The prod rate-limiter risk. Three independent always-on pollers hit the same stats/activity endpoints with no shared cache and no tab-visibility gate (F533). One react-query consolidation closes it. This is the memory-flagged "first thing to consolidate."

### F533 — Three always-on pollers fetch the same stats/activity endpoints, none gated on visibility
- **verdict:** fix-now
- **rootCause:** T8
- **confirmed:** `useSmartAlerts.js:7,329` polls `fetchCollectionStats`+`fetchActivity` every 30s, floor enabled by default (`DEFAULT_CONFIG.floor.enabled = true`, line 14). `PriceAlerts.jsx:8,69` (`usePriceAlerts`, mounted at `App.jsx:566`) polls `fetchCollectionStats` every 30s. `useCollection.js:9-10,80-81` polls stats+activity every 60s (300s with WS). Only `useDmUnread.js:32` checks `document.hidden` (`if (!document.hidden) refresh()`). No shared cache — react-query is used only in `useListings.js`. ~6 req/min per idle visitor, all duplicating the same two endpoints.
- **approach:** Introduce a shared react-query layer for stats+activity: a `useCollectionStats`/`useCollectionActivity` query keyed by `[collection.slug]` (or contract) with `refetchInterval: 60000` and `refetchIntervalInBackground: false` (gates on tab visibility). Refactor `useCollection`, `usePriceAlerts`, and `useSmartAlerts` to read from the shared query cache instead of each owning a `setInterval`+`fetchCollectionStats`. The alert engines subscribe to the cached value (effect on the query data) rather than fetching. Reuse the existing react-query `QueryClient` already powering `useListings`. As an interim minimal step if the full refactor is too large for one PR: add `if (document.hidden) return;` guards inside each poller's `check()/fetchFloor()/load()` (cheap, immediately cuts background load) and file the cache-consolidation as the follow-up — but prefer the react-query consolidation since memory flags this as the prod incident root.
- **files:** `src/nakamigos/hooks/useCollection.js:49-85`, `src/nakamigos/components/PriceAlerts.jsx:58-71`, `src/nakamigos/hooks/useSmartAlerts.js:300-331`; new shared hook e.g. `src/nakamigos/hooks/useCollectionData.js`
- **effort:** L
- **risk:** med (these feed the LIVE/DEMO badge, ticker, alerts, and floor — verify all three consumers still update; a wrong queryKey would cross-contaminate collections)
- **test:** Network panel: with the tab backgrounded, assert zero stats/activity requests fire; foregrounded, assert one shared request per interval (not three). Add a hook test asserting a single `fetchCollectionStats` call services all three consumers. Verify the Header LIVE/DEMO badge and ticker still update.
- **deps:** []
- **batchHint:** poller-consolidation

### F554 — No data cache across tab switches (only listings use react-query)
- **verdict:** fix-now
- **rootCause:** T8
- **confirmed (missingVsBestInClass):** Re-verified against code — `useListings.js` is the only react-query consumer; `useCollection`, `usePriceAlerts`, `useSmartAlerts`, trades/portfolio hooks all refetch from zero on remount. The `key={tab}` boundary (`App.jsx:745`) remounts tab bodies, so every tab switch re-pays the fetch + skeleton.
- **approach:** Direct extension of F533's shared react-query layer — once stats/activity/tokens live in the query cache, tab switches read cached data instantly with background revalidation (`staleTime` tuned per endpoint). Land as the same consolidation PR (or its immediate follow-up). No separate mechanism needed.
- **files:** same as F533 plus `src/nakamigos/hooks/useNfts.js` (move token pages into react-query) and the trades/portfolio hooks if in scope
- **effort:** L
- **risk:** med
- **test:** Switch Floor → Gallery → Floor with the network throttled; assert the second visit renders from cache with no skeleton flash.
- **deps:** [F533]
- **batchHint:** poller-consolidation

---

## Batch: splash-a11y
**Summary:** The splash is a hard keyboard/AT block on every visit (F527), the reduced-motion CSS rule targets a class that's never applied (F534), there is no visible skip affordance (F559), and there is no app-wide JS reduced-motion strategy for the framer/physics layers (F558). All converge on the same SplashScreen + a single `MotionConfig`/matchMedia gate. Land together; strictly additive — keep the splash art and choreography exactly as designed.

### F527 — Keyboard/AT users cannot enter the app ("CLICK TO ENTER" is a click-only gate on a non-focusable div)
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `SplashScreen.jsx:749-755` — the only `onComplete` path is `onClick={handleEnter}` on a plain `<div>` (no role/tabIndex/keydown). "CLICK TO ENTER" is a `<motion.span>` (`SplashScreen.jsx:1372-1381`), also non-focusable. `App.jsx:161-163` renders nothing but the splash until `splashDone`, and it replays on every `/nakamigos` entry (intentional, `App.jsx:138-143`). No skip control → keyboard/switch-access users are hard-blocked from the entire sub-app.
- **approach:** Additive, keeps the splash exactly as designed: on the root container (`750`) add `role="button"`, `tabIndex={0}`, `aria-label="Enter Tradermigos"`, an `onKeyDown` that calls `handleEnter` on `Enter`/`Space` (guarded by `phase === "ready"`), and autofocus the container (via a ref + `el.focus()`) when `phase` becomes `"ready"`. `handleEnter` already early-returns unless `phase === "ready"`, so wiring keydown is safe.
- **files:** `src/nakamigos/components/SplashScreen.jsx:677-701,749-755`
- **effort:** S
- **risk:** low
- **test:** Tab to the splash, press Enter — app enters. Screen-reader announces a button labelled "Enter Tradermigos". Mouse click path unchanged.
- **deps:** []
- **batchHint:** splash-a11y

### F534 — Reduced-motion rule `.splash-screen { display:none }` targets a class the splash never applies (and would soft-lock if it ever matched)
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `App.css:3551` (in `@media (prefers-reduced-motion: reduce)`) and `App.css:1988` style `.splash-screen`, but `SplashScreen.jsx:752` renders `className={exitPhase === "glitch" ? "splash-glitch" : ""}` — `.splash-screen` is never applied (grep: only `App.css` references it). So reduced-motion users still get the full rAF/framer splash; and if anyone "fixed" the class, `display:none` would hide the only element whose click calls `onComplete` → permanent black screen.
- **approach:** Honor the preference in JS, not CSS. In `SplashScreen`, read `matchMedia("(prefers-reduced-motion: reduce)").matches`; when true, skip the physics + exit choreography and render a static title + the (now keyboard-accessible, per F527) Enter affordance — keeps the art, drops the motion. Delete the dead/dangerous `.splash-screen { display:none }` CSS rule (`App.css:3551`); leave the `.splash-screen` style block at `1988` or repurpose it harmlessly. Shares the matchMedia gate with F558.
- **files:** `src/nakamigos/components/SplashScreen.jsx` (add reduced-motion branch), `src/nakamigos/App.css:3551` (delete rule)
- **effort:** M
- **risk:** low
- **test:** Emulate `prefers-reduced-motion: reduce` in DevTools rendering panel; load `/nakamigos` — assert a static splash with a working Enter button, no physics/glitch, and the app enters normally (no black screen).
- **deps:** [F527]
- **batchHint:** splash-a11y

### F559 — No visible skip/fast-path on the splash for repeat visitors
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed (missingVsBestInClass):** No skip control exists; entry requires waiting for `phase === "ready"` then clicking (`SplashScreen.jsx:677`). Owner intent is splash-every-entry (`App.jsx:138-143`), so the fix is an affordance, not removal.
- **approach:** The keyboard Enter affordance from F527 is the skip path; additionally surface a small always-visible "Press Enter to skip" hint (or make the focused container the obvious target) so repeat/keyboard visitors aren't gated. Strictly additive text + the F527 keydown. Pairs with F544 (trim the exit chain) for the perceived-speed win.
- **files:** `src/nakamigos/components/SplashScreen.jsx` (hint text near the CLICK TO ENTER span, `~1372-1381`)
- **effort:** S
- **risk:** low
- **test:** On a repeat visit, the "press Enter / skip" hint is visible and Enter immediately advances.
- **deps:** [F527]
- **batchHint:** splash-a11y

### F558 — No app-wide reduced-motion strategy for the JS-driven motion layers
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed (missingVsBestInClass):** The CSS `animation-duration: 0.01ms` kill (`App.css:3545-3550`) cannot stop framer-motion (animates inline styles) or rAF/canvas physics. Only `Starfield` checks `matchMedia` (`Background.jsx:365`); GhostArt/MeshGradient/LightRays/GlassOrbs/DustMotes and the splash physics ignore the preference.
- **approach:** Wrap the Nakamigos tree (e.g. at `App.jsx:972` `.nakamigos-app`, or inside `AppInner`) in framer's `<MotionConfig reducedMotion="user">` so all `motion.*` components auto-respect the OS preference, and add a single `usePrefersReducedMotion()` matchMedia hook that the splash (F534) and Background infinite-loop layers (F543) consult to render static frames. One gate, reused. Keeps all art — only the looping motion is suppressed.
- **files:** `src/nakamigos/App.jsx` (add `MotionConfig`), new `src/nakamigos/hooks/usePrefersReducedMotion.js`, consumed by `SplashScreen.jsx` (F534) and `Background.jsx` (F543)
- **effort:** M
- **risk:** low
- **test:** With reduced-motion emulated, assert framer entrance/loops settle to static (no perpetual drift on ghost art, no mesh animation) and the app remains fully usable.
- **deps:** [F534]
- **batchHint:** splash-a11y

---

## Batch: onboarding-anchors
**Summary:** The onboarding tour's spotlight machinery is well-built but never lights up because the target DOM elements don't carry the `data-tour` attributes the STEPS reference (F532), and once dismissed the tour is unreachable forever (F561). Both are additive: add attributes, add a replay entry point.

### F532 — 4 of 5 tour steps anchor to non-existent selectors (tour degrades to floating centered tooltips)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `Onboarding.jsx` STEPS reference `[data-tour='gallery'|'floor'|'wallet'|'cart'|'shortcuts']` plus legacy class fallbacks. Grep over `frontend/src/nakamigos` confirms **no element carries any `data-tour` attribute** (only the STEPS reference them). `.gallery-grid` exists only on `Favorites.jsx:56` / `MyCollection.jsx:370,394` (not the default gallery — `VirtualGalleryGrid` renders a plain `<div>` + `.nft-card` items, no `.gallery-grid`/`.virtual-gallery-grid`). `.wallet-btn` DOES exist (`Header.jsx:536`) so step 3 anchors; the other four fall back to `resolveTarget`→`setSpotlightRect(null)` centered tooltips (`Onboarding.jsx:154-162`). Step 1's copy shows over Floor because the default route is `listings` (compounded by F525).
- **approach:** Purely additive — add the `data-tour` attributes to the real elements so the existing spotlight/pulse code lights up: `data-tour="gallery"` on the VirtualGalleryGrid wrapper `<div>` (`VirtualGalleryGrid.jsx:182`), `data-tour="floor"` on the Floor nav-tab button (`Header.jsx:388`, conditionally when `k === "listings"`), `data-tour="cart"` on the cart button (`Header.jsx:504`), `data-tour="shortcuts"` on a Keys/`?` affordance (or the existing keyboard-help trigger). `wallet` already resolves via `.wallet-btn`. No STEPS edits needed.
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx:182`, `src/nakamigos/components/Header.jsx:388,504`, (shortcuts target wherever the `?`/Keys control lives)
- **effort:** S
- **risk:** low
- **test:** Clear `localStorage` `nakamigos_onboarded`, reload — assert each of the 5 steps spotlights a real element (not a centered tooltip), with the pulse ring on the gallery grid, Floor tab, wallet, cart, and shortcuts.
- **deps:** [F525] (so step-1 gallery copy shows on the gallery tab)
- **batchHint:** onboarding-anchors

### F561 — No onboarding re-entry point (tour is unreachable once dismissed)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed (missingVsBestInClass):** `Onboarding.jsx:138-139,220` gate on `localStorage[\`${slug}_onboarded\`]` set to `"true"` on finish; nothing resets it. No "replay tour" control exists in the Keys/help overlay.
- **approach:** Add a "Replay tour" action (in `KeyboardHelp.jsx` or a help affordance) that clears the `${slug}_onboarded` key and re-mounts/re-activates `Onboarding` (lift a `showOnboarding` setter — `App.jsx:312` already owns `showOnboarding` state, expose a re-trigger). Additive, low surface.
- **files:** `src/nakamigos/components/KeyboardHelp.jsx`, `src/nakamigos/App.jsx:312` (expose re-trigger), `src/nakamigos/components/Onboarding.jsx`
- **effort:** S
- **risk:** low
- **test:** Finish the tour, open Keys/help, click "Replay tour" — the tour re-runs from step 1.
- **deps:** [F532]
- **batchHint:** onboarding-anchors

---

## Batch: theme-isolation
**Summary:** Single-finding batch. The Nakamigos theme writes `documentElement[data-theme]` (and body class + meta) with no unmount cleanup, clobbering the main app's light/dark theme until reload.

### F531 — Two theme systems write the same `documentElement[data-theme]`; visiting Tradermigos clobbers the main app's theme
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `nakamigos/contexts/ThemeContext.jsx:99` already scopes `data-theme` to `.nakamigos-app` (good), but `:105` ALSO sets `document.documentElement.setAttribute("data-theme", themeId)` (values `default|midnight|sovereign`), `:104` sets a body theme class, and `:108-111` sets meta theme-color — with **no unmount cleanup**. The main app's `ThemeContext.tsx:30` writes the same attribute with `dark|light` and stays mounted across routes, so it never re-asserts on return from `/nakamigos`. A light-mode user returns to a main app where `[data-theme="light"]` (`index.css:551-680`) no longer matches → silent revert to dark, and mobile chrome keeps the nakamigos theme-color.
- **approach:** Remove (or scope) the `documentElement` write — the `.nakamigos-app[data-theme=…]` scoping at `App.css:101-135` already handles in-app theming, so the `documentElement.setAttribute` at line 105 is redundant for Nakamigos styling. Snapshot the main app's `documentElement[data-theme]` + meta theme-color on `ThemeProvider` mount and restore them on unmount (cleanup in the apply effect / a mount effect). Keep the body Background class if Background reads it, but restore it too. Minimal, reversible.
- **files:** `src/nakamigos/contexts/ThemeContext.jsx:99-115` (apply fn), `ThemeProvider` mount/unmount (`~119`)
- **effort:** M
- **risk:** med (theme is global; verify the in-app Nakamigos themes still render and the main app light mode survives a round-trip)
- **test:** Set main app to light mode → navigate to `/nakamigos`, cycle a theme → navigate back → assert main app is still light and `documentElement[data-theme]==="light"` and meta theme-color restored. Repeat on mobile, check browser chrome color.
- **deps:** []
- **batchHint:** theme-isolation

---

## Batch: pagetransition-decision
**Summary:** Single-finding owner decision. The `key={tab}` error-latch fix (correct, keep it) silently disabled the PageTransition animation by remounting it every tab change so its change-detector never fires.

### F530 — PageTransition is dead at runtime (key={tab} remount defeats its tabKey-change detector)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `App.jsx:745-749` `<ErrorBoundary key={tab}><Suspense><PageTransition tabKey={tab}>`. The `key` change unmounts/remounts the subtree, so PageTransition mounts fresh with `prevKeyRef.current = tabKey` (`PageTransition.jsx:146`); its transition effect bails at `:167` (`if (prevKeyRef.current === tabKey) return;`). The 3-phase glitch/cover/reveal choreography never runs; tabs hard-swap. `injectStyles()` still re-runs per mount (`:161-163`). The error-latch itself works — it just disabled the feature the component exists for.
- **approach (owner call):** Two paths. (A) **Keep the swap, delete-route the transition** — remove the `PageTransition` wrapper (and its injected styles) since it's inert; lowest code, accepts the hard tab-swap. (B) **Restore the animation** — hoist `PageTransition` ABOVE the `key={tab}` boundary so it survives tab changes and animates the swap, keeping the boundary keyed for the latch fix. (B) preserves the designed motion (aligns with the "additive, don't remove" spirit) but is riskier (must ensure the boundary still latches per-tab). **Recommendation:** (B) hoist, to keep the choreography the component was built for; fall back to (A) only if hoisting reintroduces the error-latch.
- **files:** `src/nakamigos/App.jsx:745-749`, `src/nakamigos/components/PageTransition.jsx`
- **effort:** M
- **risk:** med (interacts with the prod error-latch fix from 2026-06-11 — must not reintroduce a crashed-tab latch)
- **test:** Switch tabs — assert the glitch/cover/reveal plays (option B) or is cleanly gone (option A). Then crash one tab, navigate away and back — assert the error does NOT persist across tabs (latch fix intact).
- **deps:** []
- **batchHint:** pagetransition-decision

---

## Batch: header-account-menu
**Summary:** Two header-interaction polish items: clicking your own connected address instantly disconnects (F542), and the More dropdown lacks Escape/focus/reposition (F541). Both are Header UX; group.

### F542 — Clicking the connected-wallet address instantly disconnects with no menu/confirm
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `Header.jsx:316-323` `handleConnect`: `if (wallet) { setWallet(); return; }` where `setWallet` is `handleDisconnect` (`App.jsx:513-516`, which disconnects + toasts). One misclick on your own address = disconnect.
- **approach:** Replace the bare disconnect-on-click with a small account popover (copy address / view on explorer / disconnect) — mirror the pattern RainbowKit's `ConnectButton` / OpenSea use. The disconnect toast already exists; move disconnect behind the menu item. Keep the connected-state button visual. (Could reuse RainbowKit's account modal if the embed exposes it, otherwise a minimal local popover consistent with the existing `More` portal.)
- **files:** `src/nakamigos/components/Header.jsx:316-323,534-556`
- **effort:** M
- **risk:** low
- **test:** Click the connected address — assert a popover opens (no immediate disconnect); copy-address and disconnect items work; disconnect still toasts.
- **deps:** []
- **batchHint:** header-account-menu

### F541 — More dropdown lacks Escape-close, focus management, and reposition-on-resize
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `Header.jsx:306-314` `toggleMore` captures `getBoundingClientRect()` once; the portal (`:402-433`) is `position:fixed` with that stale `top/right` so a resize/scroll leaves it floating. No keydown handler (Escape doesn't close it; the global Escape in `App.jsx:489-501` doesn't know about `moreOpen`). `aria-haspopup`/`aria-expanded` are set but there's no focus trap or arrow-key nav.
- **approach:** Add: Escape closes (`useEffect` keydown while `moreOpen`), focus the first menu item on open, reposition on `resize`/`scroll` while open (re-run the `getBoundingClientRect` capture), and `role="menu"`/`role="menuitem"` semantics with arrow-key navigation. Or simpler/robust: anchor with `position:absolute` inside the relative `.more-dropdown` wrapper that already exists (`Header.jsx:392`) to eliminate the stale-fixed-position class of bug entirely. Pairs with F557 (aria-current + menu semantics).
- **files:** `src/nakamigos/components/Header.jsx:306-314,392-434`
- **effort:** M
- **risk:** low
- **test:** Open More, press Escape → closes. Resize window with More open → it stays anchored. Tab/arrow through items; focus returns to the More button on close.
- **deps:** []
- **batchHint:** header-account-menu

---

## Batch: nav-a11y-semantics
**Summary:** Single-finding accessibility addition for nav state/keyboard. Overlaps F541's menu-semantics work.

### F557 — No `aria-current` on active nav tabs; More dropdown lacks menu semantics/keyboard support
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed (missingVsBestInClass):** Active nav state is color+weight only — `Header.jsx:388` (`className=\`nav-tab ${tab===k?"active":""}\``) and `MobileNav.jsx:152,182` set color, no `aria-current`. The More portal items (`Header.jsx:420-429`) are plain buttons with no `role="menu"/"menuitem"`.
- **approach:** Add `aria-current="page"` (or `aria-current={tab===k}`) to the active nav-tab buttons in `Header.jsx` and `MobileNav.jsx`; give the More dropdown `role="menu"` + items `role="menuitem"` with arrow-key handling (shared with F541's work). Additive attributes only.
- **files:** `src/nakamigos/components/Header.jsx:388,420-429`, `src/nakamigos/components/MobileNav.jsx:140-168,171-198`
- **effort:** S
- **risk:** low
- **test:** Screen reader announces the active tab as "current"; axe/Lighthouse a11y pass shows no missing-state warning on nav. Arrow-keys navigate the More menu.
- **deps:** []
- **batchHint:** nav-a11y-semantics

---

## Batch: gallery-url-state
**Summary:** Filter/sort/search/scroll state is never URL-persisted or restored, so tab switches (which remount via `key={tab}`) destroy browsing context, and the back button doesn't close the modal. F550/F551/F552/F553 are duplicates describing the same gap from different angles; F551 is the one I'll fully spec, the others reference it. F555 (prefetch) and F551's history are related-but-separate.

### F550 — Filter/sort/search/scroll state not URL-persisted or restored
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `Gallery.jsx:20-25` holds `search/viewMode/priceRange/listedOnly` in local state (reset on collection change, `:28-34`); `useNfts` holds `activeFilters/sortBy`; `handleTabChange` always `window.scrollTo` top (`App.jsx:360`). The `key={tab}` boundary (`App.jsx:745`) remounts tab bodies, so returning to Gallery loses everything.
- **approach:** Serialize `activeFilters/sortBy/search/viewMode` into `searchParams` (the router is already mounted — use `useSearchParams`), initialize Gallery/useNfts state from the URL, and write back on change (debounced for search). This also delivers deep-linkable filtered views (F552). Skip the scroll-to-top when navigating BACK to a previously-visited tab (F553). Land as one PR covering F550/F552/F553.
- **files:** `src/nakamigos/components/Gallery.jsx:20-34`, `src/nakamigos/hooks/useNfts.js`, `src/nakamigos/App.jsx:353-363`
- **effort:** L
- **risk:** med (URL state is easy to over-write/loop; guard against feedback loops between URL→state→URL)
- **test:** Apply a trait filter + sort + search, switch tab and back — assert filters/sort/search restored and the URL reflects them; paste the URL fresh — assert the filtered view loads.
- **deps:** [F525]
- **batchHint:** gallery-url-state

### F552 — No shareable/persistent gallery state (filters/sort/search/Lite-Pro never reach the URL)
- **verdict:** duplicate
- **rootCause:** standalone
- **confirmed (missingVsBestInClass):** Same gap as F550, framed as the deep-link/share angle. Lite/Pro mode lives in `TradingModeContext` (localStorage), also not URL.
- **approach:** Covered by F550's `useSearchParams` serialization; additionally include the Lite/Pro flag in the URL if shareable mode is desired (optional). No separate work.
- **files:** same as F550
- **effort:** S (incremental over F550)
- **risk:** low
- **test:** Covered by F550.
- **deps:** [F550]
- **batchHint:** gallery-url-state

### F553 — No scroll-position restoration when returning to a tab
- **verdict:** duplicate
- **rootCause:** standalone
- **confirmed (missingVsBestInClass):** `handleTabChange` unconditionally `window.scrollTo({top:0})` (`App.jsx:360`); combined with the `key={tab}` remount, scroll is always lost.
- **approach:** Part of F550's PR — store last scroll per tab (a ref map keyed by tab) and restore on return instead of always scrolling to top; or rely on the browser's scroll restoration once tab bodies are cached (F554). Skip the forced `scrollTo` when navigating back to a previously-visited tab.
- **files:** `src/nakamigos/App.jsx:353-363`
- **effort:** S (incremental over F550)
- **risk:** low
- **test:** Scroll deep into Gallery, switch to Floor and back — assert scroll position restored.
- **deps:** [F550]
- **batchHint:** gallery-url-state

### F551 — Back/forward doesn't close/restore the NFT detail modal (one-way URL↔modal sync, no popstate)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed (missingVsBestInClass):** The `?token=`/`/nft/:id` ↔ `selected` sync is one-way: the URL-sync effect (`App.jsx:280-288`) writes via `history.replaceState` (not `pushState`), and there's no `popstate`/route-driven close. Pressing Back doesn't close the modal; OpenSea/Blur treat item views as history entries.
- **approach:** Drive modal open/close from the route rather than only writing the URL: when the modal opens via the share path, `navigate` to the `?token=`/`/nft/:id` URL with `pushState` (a new history entry) so Back pops it; have the route/`popstate` close the modal (set `selected = null` when the token param/`/nft/` segment disappears). Reconcile carefully with F526's reader-before-sync fix so they don't fight. Note this changes `replaceState`→`push` semantics — verify it doesn't spam history on rapid open/close.
- **files:** `src/nakamigos/App.jsx:280-309,754-778`
- **effort:** M
- **risk:** med (history manipulation is subtle; coordinate with F526)
- **test:** Open an NFT modal, press browser Back — assert the modal closes and the gallery is intact; Forward re-opens it.
- **deps:** [F526]
- **batchHint:** gallery-url-state

### F555 — No prefetch of lazy tab chunks on nav hover/idle
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed (missingVsBestInClass):** Tabs are lazy-loaded (`Suspense`/`LazyFallback` at `App.jsx:746`); nothing prefetches the chunk on hover/idle, so first visit to each tab pays chunk download + skeleton.
- **approach:** On `mouseenter`/`focus` of a nav-tab (and on `requestIdleCallback` after first paint for the most-likely-next tabs), call the same `import()` used by the lazy definition to warm the chunk cache. Trivial, additive — add an `onMouseEnter` to nav buttons that triggers the matching `import()`.
- **files:** `src/nakamigos/components/Header.jsx:387-391`, `src/nakamigos/App.jsx` (lazy import map)
- **effort:** M
- **risk:** low
- **test:** Network panel: hover a nav-tab — assert its JS chunk downloads before click; clicking then renders without a skeleton flash.
- **deps:** []
- **batchHint:** gallery-url-state

---

## Batch: shell-usd
**Summary:** Single-finding feature add — no fiat values at the shell level.

### F556 — No USD values at the shell level (ticker, cart, floor stats are ETH-only)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed (missingVsBestInClass):** `Header.jsx` Ticker (`:31-33`) renders `... ETH` only; cart badge is a count; floor stats are ETH. Every comparable marketplace shows inline fiat.
- **approach:** Needs an owner decision on the ETH/USD price source (the main app may already have a price oracle/hook to reuse — check `frontend/src` for an existing `useEthPrice`/price context before adding a new fetch; avoid a new always-on poller given F533). If approved, surface `≈ $X` next to ETH amounts in the ticker, cart total, and floor stat using the shared price. Reuse an existing price hook; do not add another unguarded fetch.
- **files:** `src/nakamigos/components/Header.jsx:31-33` (ticker), cart total render, floor stat render; price source TBD
- **effort:** M
- **risk:** low
- **test:** With a known ETH/USD rate stubbed, assert the ticker/cart/floor show the correct `≈ $` value.
- **deps:** []
- **batchHint:** shell-usd

---

## Batch: collection-switcher
**Summary:** Single-finding feature add — no inline collection switcher inside a collection view.

### F560 — No collection switcher inside a collection view
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed (missingVsBestInClass):** Moving between collections requires the back-to-collections button (`Header.jsx:356-366`) → landing → pick. `COLLECTIONS` (`constants.js`) holds the full set; no inline dropdown.
- **approach:** Add an inline collection dropdown in the header (next to the logo/collection name `Header.jsx:367-382`) that `navigate`s to `/nakamigos/<otherSlug>/<currentTab>` — purely additive, reuses `COLLECTIONS` and the existing route. Owner decision on placement/visual to fit the custom header. Coordinate the target segment with F525's explicit-segment routing.
- **files:** `src/nakamigos/components/Header.jsx:367-382`
- **effort:** M
- **risk:** low
- **test:** From Nakamigos Gallery, open the switcher, pick Jungle Bay — assert it navigates to `/nakamigos/junglebay/gallery` without bouncing through the landing page.
- **deps:** [F525]
- **batchHint:** collection-switcher

---

## Batch: honesty-fallback-data
**Summary:** Single-finding trust item — fallback/demo data fabricates activity by real named wallets with always-fresh fake timestamps, against the project honesty-pass standard.

### F540 — Fallback data fabricates activity by real named wallets with fresh fake timestamps
- **verdict:** fix-now
- **rootCause:** T4
- **confirmed:** `constants.js:176-182` `FALLBACK_WHALES` invents `vitalik.eth Bought 3 / 4m ago`, `pranksy.eth Swept 8 / 23m ago`, etc.; `constants.js:184-189` `FALLBACK_ACTIVITY` stamps sales `Date.now() - 120000` → always "2 minutes ago". Served on fallback at `api.js:504` (activity) and `api.js:585` (whales). The only disclosure is the `DEMO` badge (`Header.jsx:446-453`), hidden entirely at ≤390px (`App.css:4294-4297` hides `.header-status-group`).
- **approach:** Two-part: (1) De-fabricate — watermark fallback rows inline (append "· sample" / "demo" to the rendered row), use obviously-synthetic ENS names instead of real people (`vitalik.eth`/`pranksy.eth`/`punk6529.eth`→`whale-1.eth` etc.), and stop the always-"2 min ago" trick (use stable relative labels or omit timestamps). (2) Keep the DEMO badge visible at all widths — move it out of `.header-status-group` or don't hide it at ≤390px (`App.css:4294`). Additive/edit only, no art removed.
- **files:** `src/nakamigos/constants.js:176-189`, `src/nakamigos/api.js:585` (whale mapping), `src/nakamigos/App.css:4294-4297`, and the renderers (`WhaleIntelligence.jsx`, `ActivityFeed.jsx`) for the inline watermark
- **effort:** M
- **risk:** low
- **test:** Force fallback (block the live endpoints), assert whale/activity rows are visibly marked sample, names are synthetic, timestamps aren't all "2 minutes ago", and the DEMO badge shows at 375px.
- **deps:** []
- **batchHint:** honesty-fallback-data

---

## Batch: background-perf
**Summary:** Single-finding performance item — the Background mounts 20 full-res JPEGs (~2.3 MB) plus 6 always-animating blur layers with no lazy/idle loading and no reduced-motion gating outside Starfield. Art must be preserved (owner constraint).

### F543 — Background loads 20 full-res ghost-art JPEGs + 6 infinite blur loops, no lazy/idle/reduced-motion
- **verdict:** fix-now
- **rootCause:** T12
- **confirmed:** `Background.jsx:72-102` `BG_ART` = 20 `/splash/*.jpg` (two >400 KB), rendered as `<img>` in `GhostArt` (`:104-136`) with no `loading="lazy"`/`decoding="async"`. `MeshGradient`/`LightRays`/`GlassOrbs`/`DustMotes` run infinite framer loops over `filter:blur(...)` surfaces (`:139-296`); only `Starfield` checks `prefers-reduced-motion` (`:365`). Renders on every page incl. landing.
- **approach (keep all art):** Add `loading="lazy" decoding="async"` to the `GhostArt` `<img>` (`Background.jsx:123-126`); defer `GhostArt` mounting to `requestIdleCallback` after first paint; serve webp/avif variants of the `/splash` images (build-time or `<picture>`); and skip the infinite framer loops (render static frames) under the shared reduced-motion hook from F558. No art removed — only load/animation behavior changes.
- **files:** `src/nakamigos/components/Background.jsx:104-136` (lazy + idle mount), `139-356` (reduced-motion static branch), asset pipeline for webp/avif
- **effort:** M
- **risk:** low
- **test:** Lighthouse perf on `/nakamigos`: assert the ghost-art images are lazy/deferred (not in the initial critical path) and total image bytes drop with webp; with reduced-motion emulated, assert the blur layers are static.
- **deps:** [F558]
- **batchHint:** background-perf

---

## Batch: splash-perf-collection
**Summary:** Two splash content/timing items: the ~7s forced entry wait (F544) and the hardcoded default-collection stats/messages regardless of destination (F546). Both edit `SplashScreen.jsx`; group (and they pair with the splash-a11y batch).

### F544 — Splash costs ~7s per visit (4s synthetic progress + mandatory click + 2.65s exit chain)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `SplashScreen.jsx:647` `TOTAL_DURATION=4000` drives a timer-only progress bar (no real loading measured); `phase "ready"` requires a click (`:677`); desktop exit chain = glitch 900 + flash 150 + cover 1200 + collapse 400 = 2650ms (`:688-700`). The splash-every-entry is intentional (`App.jsx:138-143`) — the duration is the cost, not the existence.
- **approach (keep the splash):** Tie the progress bar to actual readiness so it can finish early — resolve when the first token page / collection data is ready (or `requestIdleCallback` after critical chunks) instead of a fixed 4s timer, keeping the 8s safety cap (`:664-672`). Trim the desktop exit chain to the existing mobile timings (`400/100/600/300 = 1.4s`, `:688`) which already feel complete. Art unchanged.
- **files:** `src/nakamigos/components/SplashScreen.jsx:645-672` (progress→readiness), `:688-700` (exit timings)
- **effort:** M
- **risk:** low
- **test:** With warm cache, assert the splash completes in ~1.4s of exit (not 2.65s) and the progress bar can finish before 4s when data is ready; the 8s safety still fires if data never loads.
- **deps:** []
- **batchHint:** splash-perf-collection

### F546 — Splash stats plaque + loading messages hardcoded to the default collection
- **verdict:** fix-now
- **rootCause:** T3
- **confirmed:** `SplashScreen.jsx:1410` always reads `COLLECTIONS[DEFAULT_COLLECTION]` for the stats plaque (`20,000 WORKS / ERC-721 / ETHEREUM`); `:1389` concatenates `LOADING_MESSAGES` of all three collections, so a Nakamigos visitor sees Jungle Bay copy. Per-collection `LOADING_MESSAGES` sets exist (`constants.js`) and were clearly meant to be collection-scoped.
- **approach:** Parse the target collection from `location.pathname` inside `SplashScreen` (reuse `parseRoute` from `App.jsx` or a slug match against `COLLECTIONS`), then feed the matching `COLLECTIONS[slug]` stats and `LOADING_MESSAGES[slug]` instead of the default/concatenated sets. Minimal, no art change.
- **files:** `src/nakamigos/components/SplashScreen.jsx:1387-1392,1409-1415`
- **effort:** S
- **risk:** low
- **test:** Enter via `/nakamigos/junglebay/...` — assert the splash shows Jungle Bay stats and only Jungle Bay loading messages; Nakamigos entry shows Nakamigos copy.
- **deps:** []
- **batchHint:** splash-perf-collection

---

## Batch: pwa-install-fix
**Summary:** Single-finding bug — the PWA install prompt throws on a second click after the native prompt is dismissed because `deferredPrompt` isn't cleared on the `dismissed` outcome.

### F537 — Second Install click after dismissal throws (deferredPrompt not cleared on `dismissed`)
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `InstallPrompt.jsx:22-29`: `await deferredPrompt.prompt(); const { outcome } = await deferredPrompt.userChoice; if (outcome === "accepted") setDeferredPrompt(null);` — `prompt()` can only be called once; on `dismissed` the stale event stays in state and the banner stays visible, so the next click rejects with `InvalidStateError` in an un-try/catch'd async handler (the embedded app doesn't install `nakamigos/main.jsx`'s `unhandledrejection` hook).
- **approach:** `setDeferredPrompt(null)` regardless of outcome (Chrome may re-fire `beforeinstallprompt` later, which re-populates it), and wrap the `prompt()`/`userChoice` in `try/catch`. ~3-line fix.
- **files:** `src/nakamigos/components/InstallPrompt.jsx:22-29`
- **effort:** S
- **risk:** low
- **test:** Trigger the install banner, click Install, dismiss the native prompt, click Install again — assert no `InvalidStateError` and the banner behaves (re-shows on a later `beforeinstallprompt`).
- **deps:** []
- **batchHint:** pwa-install-fix

---

## Batch: shell-perf-rerender
**Summary:** Single-finding performance item — top-level context consumption + prop drilling defeats the fine-grained context split, so every cart/favorite/toast/activity change re-renders the whole CollectionView tree.

### F536 — Every cart/favorite/toast/activity change re-renders the entire CollectionView tree
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `CollectionView` (`App.jsx:250-267`) consumes `useToast`/`useFavorites`/`useCart`/`useCollection`(`activities` update on every poll/WS)/`useListings`/`useNfts` at the top and prop-drills slices to `Header` and every tab. One `addToCart` → `CartContext` value changes → `CollectionView` re-renders → `renderTab()` re-renders the active tab, and `Header`'s `memo` (`Header.jsx:253`) is defeated because `activities/cartCount/lastRefresh` props change anyway. The contexts ARE well-memoized (e.g. `CartContext.jsx:46-49`) — the problem is no leaf consumes them directly.
- **approach:** Have leaf components consume the contexts directly instead of via props: the Header cart badge reads `useCart` itself, the cart drawer reads `useCart`, the ticker reads `useCollection().activities` — so a cart change re-renders only the badge/drawer, not the whole tree. Split the high-churn `activities` feed out of `useCollection`'s return object (or into its own context) so ticker updates don't ripple through `renderTab()`. Incremental refactor; ship per-consumer to bound risk.
- **files:** `src/nakamigos/App.jsx:250-267,679-718` (stop drilling), `src/nakamigos/components/Header.jsx` (consume `useCart`/activities directly), `src/nakamigos/hooks/useCollection.js` (split activities)
- **effort:** L
- **risk:** med (broad refactor of the context/prop graph; verify no consumer loses data and memo boundaries actually hold)
- **test:** React DevTools Profiler: `addToCart` re-renders only the cart badge/drawer (not `renderTab`/active tab); a ticker/activity tick re-renders only the ticker. Add a render-count assertion in a test if feasible.
- **deps:** []
- **batchHint:** shell-perf-rerender

---

## Batch: ux-polish-bundle
**Summary:** Assorted one-line polish items that share no deeper cause; bundle into the next UX commit (F547). Includes the dismiss-glyph, lenient token-id parse, hidden-tab interval ticks, and the frozen `IS_MOBILE`.

### F547 — Assorted polish: 'x' dismiss glyph, lenient parseInt token ids, hidden-tab intervals, frozen IS_MOBILE
- **verdict:** fix-now
- **rootCause:** standalone (T10 for the glyph; T8 for the hidden-tab intervals)
- **confirmed:** (1) `InstallPrompt.jsx:71` renders the letter `x` not `×`/an SVG. (2) `parseRoute` (`App.jsx:94,103`) `parseInt("12abc",10)===12` → `/nft/12abc` resolves to token 12. (3) `Header.jsx` `Ticker` `setInterval` (`:13-23`) and `StaleIndicator` (`:75-78`) keep firing while `document.hidden`. (4) `SplashScreen.jsx:5` computes `IS_MOBILE` once at module load → a rotated tablet keeps the wrong piece set until reload.
- **approach:** (1) Use `×` (or a small SVG) for the dismiss button. (2) Tighten the token-id parse to reject trailing junk — `/^\d+$/.test(seg)` before `parseInt` (the `?token=` reader already uses `/^\d{1,10}$/`, reuse that). (3) Gate the Ticker/StaleIndicator intervals on `document.hidden` (early-return inside the tick) — consistent with `useDmUnread.js:32`. (4) Make `IS_MOBILE` reactive — read `window.innerWidth` inside the component (or a `matchMedia` listener) instead of a module constant. Each is a one-liner; bundle.
- **files:** `src/nakamigos/components/InstallPrompt.jsx:71`, `src/nakamigos/App.jsx:94,103`, `src/nakamigos/components/Header.jsx:13-23,75-78`, `src/nakamigos/components/SplashScreen.jsx:5`
- **effort:** S
- **risk:** low
- **test:** `/nft/12abc` → 404 (or no token), dismiss glyph renders `×`, backgrounded tab fires no Ticker/StaleIndicator ticks, rotating a tablet switches the splash piece set.
- **deps:** []
- **batchHint:** ux-polish-bundle

---

## Batch: toast-consolidation
**Summary:** Single-finding maintenance note — two toast systems in one product. Not a bug; long-term consistency.

### F548 — Two toast systems (nakamigos hand-rolled Toast vs main-app sonner)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `nakamigos/contexts/ToastContext.jsx` + `Toast.jsx` implement a custom queue (500ms dedupe `ToastContext.jsx:12`, undo buttons, aria-live), while the rest of Tegridy Farms uses `sonner`. Duplicated behavior, slightly different look/stacking. Not a bug.
- **approach (owner call):** Long-term, adapt `addToast` to wrap `sonner` with the nakamigos skin so dedupe/undo semantics live in one place — but the nakamigos Toast is feature-rich (undo, dedupe, aria-live) and replacing it risks regressions for low value. Recommend deferring; if pursued, build a `sonner` adapter behind the existing `addToast` signature so call sites don't change. No urgency.
- **files:** `src/nakamigos/contexts/ToastContext.jsx`, `src/nakamigos/components/Toast.jsx`
- **effort:** L
- **risk:** med
- **test:** If implemented: assert dedupe (rapid duplicate toasts collapse), undo action, and aria-live announcements all still work through the sonner adapter.
- **deps:** []
- **batchHint:** toast-consolidation

---

## Batch: seaport-version-verify
**Summary:** Single-finding must-verify (largely resolved during this pass). Seaport domain pinned to v1.5 with an unresolved 1.6-migration note.

### F549 — Seaport domain pinned to v1.5; verify fulfillment honors per-order protocolAddress
- **verdict:** false-positive
- **rootCause:** T3
- **confirmed (verified during this pass):** `constants.js:96,102` pin `SEAPORT_ADDRESS`/`SEAPORT_DOMAIN` to 1.5; the comment flags 1.6. **Critically, the fulfillment paths DO honor each order's own protocol address:** `orderbook.js:101,127` use `order.protocol_address || SEAPORT_ADDRESS`; `api.js:1019` passes `listing.protocolAddress` to OpenSea's `fulfillment_data`; `api.js:660,719` read `protocol_address` off the order. The 1.5 pin is used ONLY for the app's OWN native-order **signing** (`orderbook.js:316,323,369`) — i.e. external OpenSea 1.6 orders fulfill correctly; native orders are signed at 1.5. So the feared "can't fulfill 1.6 orders" runtime bug does not exist.
- **approach:** No funds-at-risk bug to fix. The only residual is a **product decision** (tracked separately): whether the app's NATIVE orders should be signed with Seaport 1.6 to match OpenSea's current default protocol (interoperability/discoverability), which would mean adding a 1.6 domain constant and signing path. That's an opt-in enhancement, not a remediation. Recommend: add a code comment at `constants.js:95` noting fulfillment is per-order (so future readers don't re-chase), and file the native-1.6 signing as a roadmap item.
- **files:** `src/nakamigos/constants.js:95-105` (comment only), `src/nakamigos/lib/orderbook.js:316-369` (native signing, only if the product decision lands)
- **effort:** S
- **risk:** low
- **test:** Confirm (manual/existing `orderbook.test`/`api-offers.test`) that fulfilling an OpenSea order whose `protocol_address` is the 1.6 contract uses that address, not the hardcoded 1.5 — already the case per the code read.
- **deps:** []
- **batchHint:** seaport-version-verify

---

## Cross-batch dependency notes
- **F525 is foundational** for the routing family: F538 (modal-close segment), F532 (gallery step-1 copy), F550/F560 (target segments) all reference the explicit-segment convention it establishes. Land F525 first.
- **F526 before F551** — the modal back/forward (popstate) work must reconcile with the reader-before-sync fix; doing F551 first would build on the buggy ordering.
- **F527 → F534 → F558** form the reduced-motion/keyboard chain on the splash; F558's shared `usePrefersReducedMotion` hook then feeds F543 (background) and F544 (splash timing pairs with it).
- **F533 → F554** — the cache-across-tabs win is the same react-query consolidation; F555 (prefetch) is independent and can land anytime.
