# Remediation Plan — g14: Nakamigos misc UX (theater / keyboard / share / sound / modals / toasts) + naka responsive

Surface: `frontend/src/nakamigos/**`. Branch: `mvp-launch` @ HEAD. Planning only — no code edited here.

All findings below were confirmed against source at HEAD unless explicitly marked false-positive / redeploy-only / operator-action. Several findings collapse into a handful of shared fixes (a modal-stack registry, a shared `trapFocus` util, a shared `lockScroll`, a derived `SHORTCUTS` constant, a `rankTier()` helper, routing prices through `formatPrice`). Those are grouped under shared batchHints so they land in one commit each.

Verified shared infrastructure already in the codebase that we will reuse rather than reinvent:
- `lib/scrollLock.js` — ref-counted body lock (already imported by Modal/WalletModal/KeyboardHelp).
- `lib/formatPrice.js` — the canonical ETH formatter (used by 11 components already).
- `src/components/loader/phases/hold.ts:153` — the `isMob ? 'TAP TO ENTER' : 'CLICK TO ENTER'` ternary to copy.
- `@media (hover: none) and (pointer: coarse)` block at `App.css:4431` — the existing touch-gate to extend.

---

## Batch: `modal-stack-registry` (F785, F791, F792, F786)

**Summary.** The root cause of the stacked-overlay bugs is that TheaterMode, ShareCard, WalletModal, and the NFT Modal all mount as *siblings* in `App.jsx` while `selected` stays set, and each registers its own `document`/`window` keydown listener with no notion of "who is on top." Escape closes the wrong layer (registration-order dependent), and the inline `onClose` recreated every render flips that order. We introduce one tiny modal-stack registry (push-on-mount / pop-on-unmount; only the topmost entry acts on Escape), stabilize the App-level `onClose` callbacks with `useCallback`, and gate the global keyboard handler while any overlay is open. Land the scroll-lock unification (F786) here too since it touches the same four components.

### F785 — Escape closes the WRONG modal in stacked overlays
- **verdict:** fix-now
- **rootCause:** standalone (architectural; the modal layer has no z-order awareness)
- **confirmed:** `Modal.jsx:159-195` registers a `document` keydown that calls `e.stopImmediatePropagation()` + `onClose()` with deps `[nft, onClose]`; `App.jsx:757-775` mounts Modal while `theaterNft`/`shareNft`/`walletModalOpen` mount as siblings (App.jsx:800-847) with `selected` still set. `onClose` is an inline arrow (App.jsx:759-763) recreated each render → listener re-registration flips order. TheaterMode (TheaterMode.jsx:149-157) does NOT stop propagation, so the "both orders are wrong" claim holds.
- **approach:** Add `lib/modalStack.js` exporting `pushModal(id)` / `popModal(id)` / `isTopModal(id)` over a module-level array. In each overlay's keydown effect, early-return unless `isTopModal(myId)` before handling Escape (and keep `stopImmediatePropagation`). Register Modal lowest, Theater/Share/Wallet on top by mount order. Reuse the same registry for F792's app-handler gate.
- **files:** `src/nakamigos/lib/modalStack.js` (new), `src/nakamigos/components/Modal.jsx:159-195`, `src/nakamigos/components/TheaterMode.jsx:149-157`, `src/nakamigos/components/ShareCard.jsx:149-169`, `src/nakamigos/components/WalletModal.jsx:30-55`
- **effort:** M
- **risk:** med (touches every overlay's keyboard path)
- **test:** Add a jsdom test under `src/nakamigos/__tests__/` that mounts Modal then TheaterMode and asserts Escape closes Theater first, then Modal. Manual: open NFT modal → open Theater → Esc closes only Theater.
- **deps:** []
- **batchHint:** modal-stack-registry

### F791 — Unstable `onClose` re-registers listeners + yanks focus on every re-render
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `Modal.jsx:195` effect deps `[nft, onClose]`; `App.jsx:759` passes inline arrow; price-alert/poll re-renders (`usePriceAlerts` at App.jsx:566, `useSmartAlerts` at :569) re-run the effect whose body calls `closeBtn?.focus()` (Modal.jsx:188-189).
- **approach:** Wrap the Modal `onClose` (and Theater/Share/Wallet `onClose`) in `useCallback` in `App.jsx`. In `Modal.jsx`, split the mount-only focus-trap setup (focus close button, capture `previouslyFocused`, lockScroll) into a `[]`-dep effect, leaving only the keydown handler keyed on stable deps. Same split pattern is already used correctly in `KeyboardHelp.jsx:94-98` vs `:129-132`.
- **files:** `src/nakamigos/App.jsx:759-763,769-770,804,815,837,845`, `src/nakamigos/components/Modal.jsx:159-195`
- **effort:** S
- **risk:** low
- **test:** Manual: tab to "Make Offer", trigger a toast (e.g. add to cart elsewhere), confirm focus stays on "Make Offer". Existing modal render tests should still pass.
- **deps:** []
- **batchHint:** modal-stack-registry

### F792 — Global shortcuts fire under theater; F double-toggles favorite
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `TheaterMode.jsx:149-157` handles t/f/Escape on `document` without `stopPropagation`; `App.jsx:405-507` window handler still runs, and `case "f"` (App.jsx:454-463) toggles the focused card's favorite → same token toggled twice.
- **approach:** In TheaterMode's keydown call `e.stopPropagation()`, and additionally gate the App-level `handleKey` (App.jsx:405) with an early return when any overlay is open — read it from the modal-stack registry (`isAnyModalOpen()`) so digits/g/f don't fire under Theater/Modal. Minimal: the registry gate alone fixes both the double-toggle and the tab-switch-underneath.
- **files:** `src/nakamigos/components/TheaterMode.jsx:149-157`, `src/nakamigos/App.jsx:405-415`
- **effort:** S
- **risk:** low
- **test:** Open Theater, press F once → favorite toggles exactly once (check heart state). Press 3 → no tab switch underneath.
- **deps:** [F785]
- **batchHint:** modal-stack-registry

### F786 — Theater/ShareCard bypass ref-counted scrollLock
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `TheaterMode.jsx:132-133` and `ShareCard.jsx:165,168` write `document.body.style.overflow` directly, while `lib/scrollLock.js` is the ref-counted source of truth used by Modal/WalletModal/KeyboardHelp. Closing Theater over an open Modal sets `overflow=""` and desyncs the count.
- **approach:** Replace the four direct `body.style.overflow` writes with `lockScroll()` / `unlockScroll()` imported from `../lib/scrollLock`. (Evidence also names `BulkListingWizard.jsx:553-554` and `BundleListing.jsx:63-68` — fix those two as well for completeness; same one-line swap.)
- **files:** `src/nakamigos/components/TheaterMode.jsx:132-133`, `src/nakamigos/components/ShareCard.jsx:165,168`, `src/nakamigos/components/BulkListingWizard.jsx:553-554`, `src/nakamigos/components/BundleListing.jsx:63-68`
- **effort:** S
- **risk:** low
- **test:** Open Modal → open Theater → close Theater → body must NOT scroll (Modal still open). Then close Modal → body scrolls.
- **deps:** []
- **batchHint:** modal-stack-registry

---

## Batch: `shared-focus-trap` (F800, F793)

**Summary.** The identical ~12-line Tab focus-trap is copy-pasted in Modal, ShareCard, WalletModal, and KeyboardHelp, and none of them filter `:disabled`, so when the Buy button is disabled (during purchase) the trap can no-op and Tab escapes the dialog. Extract one `trapFocus(container, e)` util that filters disabled elements, and while we're adding dialog a11y, give TheaterMode the dialog semantics + focus trap the other four already have.

### F800 — Focus traps include disabled buttons
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** All four traps use the same selector without `:not([disabled])` (`Modal.jsx:172`, `ShareCard.jsx:153`, `WalletModal.jsx:35`, `KeyboardHelp.jsx:111`); `Modal.jsx:419-422` disables Buy while `buying`.
- **approach:** Add `lib/trapFocus.js` exporting `getFocusable(container)` (selector + `:not([disabled])` + visibility check) and `trapFocus(container, e)` (the shift/last/first logic). Replace the inline trap in all four files. This is a pure refactor of duplicated logic.
- **files:** `src/nakamigos/lib/trapFocus.js` (new), `src/nakamigos/components/Modal.jsx:170-181`, `src/nakamigos/components/ShareCard.jsx:152-162`, `src/nakamigos/components/WalletModal.jsx:34-44`, `src/nakamigos/components/KeyboardHelp.jsx:108-126`
- **effort:** S
- **risk:** low
- **test:** Open Modal during a (mocked) buy so Buy is disabled, Tab repeatedly — focus must stay inside the modal. Unit test `getFocusable` excludes a disabled button.
- **deps:** []
- **batchHint:** shared-focus-trap

### F793 — TheaterMode has no dialog semantics / focus management / trap
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `TheaterMode.jsx:372-441` root div has no `role="dialog"`/`aria-modal`/`aria-label`; focus is never moved in; Tab walks the page behind; fav button (`:391-397`) has no `aria-pressed` (Modal.jsx:259 has it).
- **approach:** Add `role="dialog" aria-modal="true" aria-label={...}` to the overlay div, focus the close button on mount (ref), add the shared `trapFocus` (from F800) to TheaterMode's existing keydown effect, and add `aria-pressed={isFavorite}` to the fav button. Additive only — no layout change.
- **files:** `src/nakamigos/components/TheaterMode.jsx:149-157,372-373,391-397`
- **effort:** S
- **risk:** low
- **test:** axe/manual: Tab cycles within Theater; screen reader announces dialog; favorite button announces pressed state.
- **deps:** [F800]
- **batchHint:** shared-focus-trap

---

## Batch: `theater-mobile` (F787, F813)

**Summary.** TheaterMode is entirely inline-styled with fixed desktop dimensions (300px sidebar, `paddingRight:300`, `14px 28px` HUD) and zero media queries, violating the responsive mandate. Add an additive mobile layout (`window.innerWidth <= 640` branch already trivially available via the existing `dimensions` state) that turns the trait sidebar into a bottom sheet and drops the image padding — desktop untouched. F813 (missing lightbox features) is a product-decision backlog item, parked here as the same surface.

### F787 — Theater has zero mobile adaptation
- **verdict:** fix-now
- **rootCause:** T10 (responsive)
- **confirmed:** `TheaterMode.jsx:189` `paddingRight: showTraits ? 300 : 0`; `:291-307` sidebar `width:300`; `:223` HUD `padding:"14px 28px"`; no media queries.
- **approach:** Derive `const isMobile = dimensions.w <= 640` (state already exists at `:126`). When mobile: sidebar becomes a bottom sheet (`left:0; right:0; bottom:0; width:auto; maxHeight:"50vh"; transform: translateY(showTraits?0:100%)`), `imageContainer.paddingRight = 0`, `hudBar.right = 0`, `toggleBtn` repositioned to bottom-center horizontal (drop `writingMode`). Keep the desktop object intact under the `else`. Additive.
- **files:** `src/nakamigos/components/TheaterMode.jsx:180-229,290-370`
- **effort:** M
- **risk:** low
- **test:** Chrome at 390px: open Theater → image fills width; tap TRAITS → bottom sheet slides up, artwork not crushed. Desktop unchanged at 1440px.
- **deps:** []
- **batchHint:** theater-mobile

### F813 — Theater missing zoom/pan, prev/next, download, Fullscreen API
- **verdict:** product-decision
- **rootCause:** standalone (best-in-class gap)
- **confirmed:** No zoom/pan/nav/download/fullscreen in `TheaterMode.jsx` (read in full).
- **approach:** Backlog. Lowest-risk increment if approved: wire `j`/`k` to a passed `onPrev`/`onNext` (App already tracks `allTokens`) and add a download button reusing `ShareCard`'s `canvas.toBlob` download idiom. Pinch-zoom/Fullscreen API are a larger lift — defer. No code until owner prioritizes.
- **files:** `src/nakamigos/components/TheaterMode.jsx`, `src/nakamigos/App.jsx:802-808` (would need onPrev/onNext wiring)
- **effort:** L
- **risk:** med
- **test:** N/A until scoped.
- **deps:** []
- **batchHint:** theater-mobile

---

## Batch: `naka-z-and-css-leak` (F788, F790, F799, F810, F811)

**Summary.** Two related CSS problems: (1) the mobile bottom nav (z 9999) floats above the modal overlay (z 1000) and stays tappable; and (2) several unscoped selectors in the eagerly-bundled `nakamigos/App.css` leak into the entire Tegriddy app. Fix the z-order/visibility for the nav and scope every leaking selector with `.nakamigos-app`. Fold in the related polish (F799 padding, F810 reduced-motion/shimmer/dead-blocks, F811 help overflow + toast offset) since they live in the same file.

### F788 — Mobile bottom nav floats above the modal and stays tappable
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `App.css:662` `.modal-bg { z-index:1000 }`; `MobileNav.jsx:123` nav z 9999, rendered unconditionally (`App.jsx:866`). Z-map comment (`App.css:14-32`) documents modal=1000 < mobile nav=9997.
- **approach:** Minimal & robust: hide `MobileNav` while any overlay is open. `CollectionView` already holds `selected`/`cartOpen`/`theaterNft`/`shareNft`/`walletModalOpen`/`profileAddress` — pass an `overlayOpen` boolean to `<MobileNav>` and early-return `null` (or `style.display:none`) when true. Do NOT just raise `.modal-bg` z-index (it would still leave the nav tappable for non-modal overlays). Update the z-map comment.
- **files:** `src/nakamigos/App.jsx:866`, `src/nakamigos/components/MobileNav.jsx:30-51`, `src/nakamigos/App.css:14-32` (comment)
- **effort:** S
- **risk:** low
- **test:** 390px: open NFT modal → bottom nav hidden, tapping where a tab was does nothing; close modal → nav returns.
- **deps:** []
- **batchHint:** naka-z-and-css-leak

### F790 — Unscoped selectors in nakamigos App.css leak app-wide
- **verdict:** fix-now
- **rootCause:** standalone (CSS scoping; high blast-radius since `main.tsx:15` bundles it globally)
- **confirmed:** `App.css:3664-3667` `@media(max-width:768px){button,a,select,input{min-height:44px;min-width:44px}}` (forces 44px on every main-app control); `:1862` `details summary::-webkit-details-marker{display:none}`; `:3535-3538` `*:focus-visible{outline:2px solid var(--naka-blue)}` — `--naka-blue` is defined only on `.nakamigos-app` (`App.css:42`), so outside it the var is invalid-at-computed-value; `:3551` `.splash-screen{display:none}`; `:4419` `main,[role="main"]{padding-bottom:68px}`; `:3678-3687` forced-colors `button` rule.
- **approach:** Prefix each leaking selector with `.nakamigos-app ` (descendant). For the `@media` blocks, prefix the inner selectors (e.g. `.nakamigos-app button, .nakamigos-app a, ...`). The file already documents this exact class of leak at its own button rules (~`:239`), so the pattern is established. Pure scoping — visually identical inside nakamigos, removes the app-wide bleed.
- **files:** `src/nakamigos/App.css:1862,3535-3538,3551,3664-3667,3678-3687,4419`
- **effort:** M
- **risk:** med (regression risk is in the *main* app losing these rules — but that is the intended fix; verify main-app mobile controls + disclosure markers after)
- **test:** Load a main-app page (e.g. `/swap`) at 768px → controls no longer forced to 44px boxes; `<details>` markers reappear; `:focus-visible` outline renders (valid var). Load `/nakamigos` → unchanged.
- **deps:** []
- **batchHint:** naka-z-and-css-leak

### F799 — 390px rule flattens section bottom padding
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `App.css:4386-4396` comment says "tighter horizontal padding" but the rule sets full `padding:14px 10px`, collapsing the 60px bottom padding (e.g. `:2455-2457`).
- **approach:** Change that block to `padding-left:10px; padding-right:10px;` only (leave vertical padding to the existing rules). One-line-ish edit matching the comment's stated intent.
- **files:** `src/nakamigos/App.css:4386-4396`
- **effort:** S
- **risk:** low
- **test:** 390px: scroll Activity/Favorites to bottom → content no longer butts against footer/nav.
- **deps:** []
- **batchHint:** naka-z-and-css-leak

### F810 — Reduced-motion freezes spinners; sovereign shimmer occluded; dead blocks
- **verdict:** fix-now (spinner + dead blocks) · needs-verification (shimmer visual)
- **rootCause:** T10 (reduced-motion) + standalone (dead CSS)
- **confirmed:** `App.css:3546-3550` blanket `animation-iteration-count:1 !important` freezes `.spinner` (`:653-657`) into a static arc; empty media blocks at `:3600-3601`, `:3512-3513`, `:3650-3651`; sovereign `.nft-card::before` shimmer (`:3424-3434`) uses `inset:-2px; z-index:-1` while `.nft-card` has `overflow:hidden` (`:537`).
- **approach:** Under `@media (prefers-reduced-motion: reduce)`, add a `.nakamigos-app .spinner { animation: none; opacity: 0.5; }` (or an opacity pulse) so the loader doesn't read as hung; the blanket rule already runs there. Delete the three empty `@media` blocks. For the shimmer: verify visually in Chrome under `theme-sovereign` — if confirmed invisible, move the pseudo above the card content (or drop `overflow:hidden` on sovereign cards); do NOT change non-sovereign cards. De-dupe `.activity-filter-btn.active` (`:2033` vs `:2488`) keeping the sovereign-aware one.
- **files:** `src/nakamigos/App.css:3544-3552,3600-3601,3512-3513,3650-3651,3424-3434,2033,2488`
- **effort:** S
- **risk:** low
- **test:** OS reduced-motion on → spinner shows a pulse, not a frozen arc. Visual check of sovereign card shimmer before/after. CSS lint clean.
- **deps:** []
- **batchHint:** naka-z-and-css-leak

### F811 — Help panel overflows short viewports; toasts overlap mobile nav
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `KeyboardHelp.jsx:33-41` panel has no `max-height`/overflow; `App.css:848-849` `.toast-container { bottom:24px; z-index:10500 }` sits over the 56px mobile bottom nav.
- **approach:** Add `maxHeight: "85vh", overflowY: "auto"` to `panelStyle` in `KeyboardHelp.jsx:33-41`. In `App.css`, under `@media (max-width:767px)`, bump `.toast-container { bottom: 72px; }` so toasts clear the bottom nav (keep desktop 24px).
- **files:** `src/nakamigos/components/KeyboardHelp.jsx:33-41`, `src/nakamigos/App.css:848-853` (+ mobile override)
- **effort:** S
- **risk:** low
- **test:** Landscape phone (~370px tall) → help panel scrolls. 390px portrait → a toast does not cover bottom-nav buttons.
- **deps:** []
- **batchHint:** naka-z-and-css-leak

---

## Batch: `shortcuts-single-source` (F789, F821, F836)

**Summary.** Two user-facing shortcut listings (KeyboardHelp + About) both disagree with the real keymap in `App.jsx` (tabs are 1–6, not 1–9/1–7; F/T claims are wrong). Derive both lists from one exported `SHORTCUTS` constant so they can't drift, fix the tab range, and hide the touch-only About panel behind a pointer media query.

### F789 — Both shortcut listings are wrong vs the handler
- **verdict:** fix-now
- **rootCause:** T3 (drifting hardcoded constants)
- **confirmed:** `App.jsx:114-121` `TAB_KEYS` is only "1"–"6"; switch (`App.jsx:452-503`) handles g/f/c/s,//m/?/escape. `KeyboardHelp.jsx:10` advertises `"1–9, 0"`; `About.jsx:348` `"1-7"`, `:353` `["F","Go to Floor"]`, `:354` `["T","Go to Traits"]` — F actually favorites the focused card and there is no T binding.
- **approach:** Add `lib/shortcuts.js` exporting a single `SHORTCUTS` array (sections → `[key, desc]`) reflecting the real handler (tabs `1–6`; j/k, Enter, Esc, g, f, c, s//, m, ?). Import it in `KeyboardHelp.jsx` (replace local `SHORTCUTS` at `:4-19`) and `About.jsx` (replace the inline array at `:347-355`). Remove the phantom F/T-as-navigation and 7/8/9/0 entries.
- **files:** `src/nakamigos/lib/shortcuts.js` (new), `src/nakamigos/components/KeyboardHelp.jsx:4-19`, `src/nakamigos/components/About.jsx:347-355`
- **effort:** S
- **risk:** low
- **test:** Open `?` help and About → both list 1–6 and identical bindings; press each listed key and confirm it does what the label says.
- **deps:** []
- **batchHint:** shortcuts-single-source

### F821 — Help list is static text (no live key highlight)
- **verdict:** product-decision
- **rootCause:** standalone (polish/best-in-class)
- **confirmed:** `KeyboardHelp.jsx` renders static rows; no key-press echo.
- **approach:** Optional enhancement after F789 lands the single source: add a `keydown` listener in KeyboardHelp that flashes the matching `keyStyle` chip. Low value, defer to owner. Once F789 derives from the real keymap, the "stays accurate" half of this finding is already satisfied.
- **files:** `src/nakamigos/components/KeyboardHelp.jsx`
- **effort:** M
- **risk:** low
- **test:** N/A until scoped.
- **deps:** [F789]
- **batchHint:** shortcuts-single-source

### F836 — Keyboard Shortcuts section rendered on touch-only devices
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `About.jsx:343-362` renders `.about-shortcuts` unconditionally; `App.css:2422` `.about-shortcuts` has no pointer gate. Screenshot `pass6/iphone14_nakamigos-nakamigos-about_3.png` shows it at 390px.
- **approach:** Add `@media (hover: none) and (pointer: coarse) { .nakamigos-app .about-shortcuts { display: none; } }` — the touch-gate media block already exists at `App.css:4431`, so append there. Additive; keeps the panel for keyboard users.
- **files:** `src/nakamigos/App.css:4431` (append rule)
- **effort:** S
- **risk:** low
- **test:** 390px Chrome (touch emulation) → About no longer shows Keyboard Shortcuts; desktop still shows it.
- **deps:** []
- **batchHint:** shortcuts-single-source

---

## Batch: `naka-price-formatting` (F802, F797, F804, F809)

**Summary.** The canonical `formatPrice` exists but Modal/About/ShareCard/PriceHistoryChart bypass it with raw `.toFixed(4)`, and dust values collapse to `0.0000`. Route price strings through `formatPrice`, add a sub-0.0001 floor, fix the ShareCard header overflow, and centralize the three divergent rank-tier rules into one `rankTier()` helper.

### F802 — Modal/About/ShareCard/PriceHistoryChart bypass formatPrice
- **verdict:** fix-now
- **rootCause:** T6 (raw-value rendering) / T3
- **confirmed:** `Modal.jsx:362,367,445`, `:40` (FairValueBadge), `:106-108` (chart), `About.jsx:70` all use raw `.toFixed(4)`. `formatPrice.js:14` returns `"0"` for exactly 0 but `<0.00005` rounds to `"0.0000"` via the `n.toFixed(4)` path — indistinguishable from zero.
- **approach:** Import `formatPrice` from `../lib/formatPrice` in Modal/About/ShareCard and replace the raw `.toFixed(4)` calls (price box, last sale, Buy button label, fair value, chart min/avg/max, About floor). Add a floor branch to `formatPrice.js`: `if (n !== 0 && Math.abs(n) < 0.0001) return "<0.0001";` (placed before the `<1000` path). This single formatter change closes the dust-display half across all 11 existing consumers too.
- **files:** `src/nakamigos/lib/formatPrice.js:14-21`, `src/nakamigos/components/Modal.jsx:40,106-108,362,367,445`, `src/nakamigos/components/About.jsx:70`, `src/nakamigos/components/ShareCard.jsx:71`
- **effort:** M
- **risk:** med (formatPrice is shared by 11 components — regression-test the floor branch carefully)
- **test:** Unit-test `formatPrice(0.00003) === "<0.0001"`, `formatPrice(1234.5) === "1,234.50"`, `formatPrice(0) === "0"`. Manual: modal price box shows commas for big values.
- **deps:** []
- **batchHint:** naka-price-formatting

### F797 — ShareCard collection header drawn with no maxWidth
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `ShareCard.jsx:43` `ctx.fillText(collection.name.toUpperCase(), rx, 80)` omits the `rw` maxWidth that the NFT-name line uses (`:49`).
- **approach:** Pass `rw` as the 4th arg: `ctx.fillText(collection.name.toUpperCase(), rx, 80, rw)`. One-token change.
- **files:** `src/nakamigos/components/ShareCard.jsx:43`
- **effort:** S
- **risk:** low
- **test:** Generate a share card for a long-named collection → header no longer paints past the canvas edge.
- **deps:** []
- **batchHint:** naka-price-formatting

### F804 — Price history chart: no skeleton, no dates, no tooltips, no SVG a11y
- **verdict:** fix-now
- **rootCause:** T11 (loading) + T10 (a11y)
- **confirmed:** `Modal.jsx:68` `if (!sales) return null` → layout shift; points (`:99-103`) carry no date/tx and no hover; svg (`:92`) has no `aria-label`/`title`.
- **approach:** While `sales === null`, render a fixed-height (`h=80`) skeleton `<div>` instead of `null` to reserve space. Add `<title>{date} · {price} ETH}</title>` inside each `<circle>` for native hover tooltips, and `role="img" aria-label="Price history sparkline"` on the `<svg>`. Reuse `formatPrice` for the axis labels (from F802). Additive.
- **files:** `src/nakamigos/components/Modal.jsx:52-111`
- **effort:** S
- **risk:** low
- **test:** Open a modal for a token with sales → no jump as chart loads; hover a point shows date+price; axe reports the svg labeled.
- **deps:** [F802]
- **batchHint:** naka-price-formatting

### F809 — Three different rank-tier semantics across surfaces
- **verdict:** fix-now
- **rootCause:** T3
- **confirmed:** `Modal.jsx:229` top-25% badge; `ShareCard.jsx:57-61` gold@0.5%/blue@2.5%; `TheaterMode.jsx:162` any `rank<=supply`. Card.css has a separate `.card-rank-top`.
- **approach:** Add `rankTier(rank, supply) -> "gold" | "blue" | "plain" | null` to `constants.js` (or `lib/`), encoding the gold≤0.5% / blue≤2.5% thresholds ShareCard already uses (the most considered scale). Use it in Modal (`:229,249`), ShareCard (`:60`), TheaterMode (`:162,388`). Keep each surface's visual treatment; only the threshold logic converges. Additive — does not remove any badge.
- **files:** `src/nakamigos/constants.js` (add helper), `src/nakamigos/components/Modal.jsx:229,249`, `src/nakamigos/components/ShareCard.jsx:57-61`, `src/nakamigos/components/TheaterMode.jsx:162,388`
- **effort:** M
- **risk:** low
- **test:** Pick one token; confirm its tier reads identically in Modal, ShareCard, and Theater. Unit-test `rankTier(1, 10000) === "gold"`.
- **deps:** []
- **batchHint:** naka-price-formatting

---

## Batch: `share-targets` (F796, F798, F814, F816)

**Summary.** The tweet intent has no app link, the generated PNG is only downloadable, and the card footer prints a pseudo-domain (`nakamigos.gallery`) the project doesn't own. Append the canonical deep link to the tweet, add Web Share / copy-image when supported, print the real host, and deep-link the buy success toast's tx hash.

### F796 — Tweet has no app link; image never shared, only downloadable
- **verdict:** fix-now
- **rootCause:** T4-adjacent (share UX) / standalone
- **confirmed:** `ShareCard.jsx:183-188` builds intent with name+rank only, no `url`; `Modal.jsx:343` already has the canonical deep link format. No `navigator.share`, no clipboard image.
- **approach:** In `handleTwitter` append `&url=${encodeURIComponent(deepLink)}` where `deepLink = ${window.location.origin}/nakamigos/${collection.slug}/gallery?token=${nft.id}` (same format as Modal.jsx:343). Add a "Share" button that calls `navigator.share({ files:[file], url:deepLink })` when `navigator.canShare?.({files})`, and a "Copy image" button using `navigator.clipboard.write([new ClipboardItem({'image/png':blob})])` when supported (feature-detect; hide otherwise). Reuse the existing `canvas.toBlob` from `handleDownload`.
- **files:** `src/nakamigos/components/ShareCard.jsx:171-188,223-230`
- **effort:** M
- **risk:** low
- **test:** Tweet opens with `url=` present. On a mobile UA, Share button invokes the native sheet with the PNG. Copy-image button hidden where `ClipboardItem` unsupported.
- **deps:** []
- **batchHint:** share-targets

### F798 — Pseudo-domain footer + supply copy drift
- **verdict:** fix-now (host) · product-decision (the `~9,697` lore number)
- **rootCause:** T4 (overstated/incorrect claim) / T3
- **confirmed:** `ShareCard.jsx:105` prints `${collection.slug}.gallery`; `About.jsx:154` says final population "~9,697" while `constants.js:33` says `supply: 9696`.
- **approach:** Host: replace `${collection.slug}.gallery` with `window.location.host` (the real share origin). Supply: the 9,696 vs ~9,697 gap is a *curation lore* figure (MGXS's final mint), not the on-chain supply — flag to owner before editing About prose (preserve-art mandate on lore copy). Minimal code change = the host fix only.
- **files:** `src/nakamigos/components/ShareCard.jsx:105`; (deferred) `src/nakamigos/components/About.jsx:154`
- **effort:** S
- **risk:** low
- **test:** Generate a card → footer shows `tegridyfarms.vercel.app` (or current host), not `nakamigos.gallery`.
- **deps:** []
- **batchHint:** share-targets

### F814 — ShareCard missing Web Share file-attach, copy-image, tweet link, Farcaster/Lens, format toggle
- **verdict:** duplicate
- **rootCause:** standalone
- **confirmed:** Same surface as F796; Web Share + copy-image + tweet link are exactly F796's scope. Farcaster/Lens targets and a story/square format toggle are additional best-in-class items.
- **approach:** Web Share / copy-image / tweet-url are handled by **F796**. Farcaster (Warpcast intent) and a 1080×1080 / 1080×1920 format toggle are a product-decision backlog item — defer until owner asks. Mark this id as duplicate-of-F796 for the implemented portion.
- **files:** `src/nakamigos/components/ShareCard.jsx`
- **effort:** M
- **risk:** low
- **test:** Covered by F796 tests for the implemented portion.
- **deps:** [F796]
- **batchHint:** share-targets

### F816 — Buy success toast doesn't deep-link tx hash to Etherscan
- **verdict:** fix-now
- **rootCause:** T5-adjacent (post-write UX)
- **confirmed:** `Modal.jsx:434-438` `onSuccess` has `hash` in scope and calls `recordTransaction({...hash...})` but the toast (`addToast(\`Success! Bought #${nft.id}\`, "success")`) drops it.
- **approach:** Extend `addToast` usage to include an Etherscan link. The Toast component supports custom content via `t.message`/`undoAction`; simplest additive path is to add an optional `txHash`/`href` to the toast object and render an "View on Etherscan ↗" link in `Toast.jsx`. Construct the URL with the existing `ETHERSCAN_TX` constant (or `ETHERSCAN_TOKEN` sibling in `../constants`). Couple with F794's CTA flip.
- **files:** `src/nakamigos/components/Modal.jsx:434-438`, `src/nakamigos/components/Toast.jsx:64-91`, `src/nakamigos/constants.js` (confirm an `ETHERSCAN_TX` helper exists; add if not)
- **effort:** S
- **risk:** low
- **test:** Mock a successful buy → toast shows a working Etherscan tx link.
- **deps:** []
- **batchHint:** share-targets

---

## Batch: `modal-post-buy` (F794)

### F794 — Stale "Buy for X ETH" button after a successful buy
- **verdict:** fix-now
- **rootCause:** T5 (writes don't refetch)
- **confirmed:** `Modal.jsx:434-438` `onSuccess` records + toasts but never clears `nft.orderHash`/`price`, closes, or refetches; a second click fires `fulfillSeaportOrder` again → `OrderAlreadyFilled` (mapped at `errorMessages.js:19`).
- **approach:** On success set local `const [purchased, setPurchased] = useState(false)`; flip the primary CTA to a disabled `Purchased ✓ — view on Etherscan` (link from F816) and trigger the listings refetch the app already exposes (`refreshListings` from `useListings`, passed down or invoked via a new `onPurchased` prop). Minimal: local `purchased` state gates the CTA; the listings refetch is the optional second half. Additive — no removed UI.
- **files:** `src/nakamigos/components/Modal.jsx:120,418-460`, `src/nakamigos/App.jsx:757-775` (optional `onPurchased`→`refreshListings`)
- **effort:** S
- **risk:** low
- **test:** Mock a successful buy → CTA becomes disabled "Purchased ✓"; cannot re-submit; reopening modal after refetch shows it no longer listed.
- **deps:** [F816]
- **batchHint:** modal-post-buy

---

## Batch: `toast-system` (F795, F805)

### F795 — Two parallel toast systems (sonner + nakamigos Toast)
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** Main app imports `sonner` (GaugeVoting/community/swap); nakamigos ships its own `Toast.jsx`/`ToastContext.jsx` mounted at `App.jsx:863`, fixed bottom-right (`App.css:848-853`).
- **approach:** Full convergence (theming sonner with nakamigos classes) is a larger product call — defer. The actionable, low-risk subset (pause-on-hover + longer error duration) is **F805**; implement that and leave the two-system convergence as an owner decision.
- **files:** `src/nakamigos/components/Toast.jsx`, `src/nakamigos/contexts/ToastContext.jsx`
- **effort:** L
- **risk:** med
- **test:** N/A until scoped.
- **deps:** [F805]
- **batchHint:** toast-system

### F805 — No pause-on-hover; errors share the 3.5s success dismiss
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `Toast.jsx:35` `const duration = t.duration || 3500` uniform; no mouseenter handlers; undo toasts (`:71-81`) get only 3.5s.
- **approach:** Default duration by type: `const duration = t.duration || (t.type === "error" || t.undoAction ? 7000 : 3500)`. Add `onMouseEnter`/`onMouseLeave` (and `onFocus`/`onBlur`) on each toast element that clear/restart its timer (track remaining time in `timersRef`). Keeps the nakamigos skin; matches sonner's hover-pause behavior.
- **files:** `src/nakamigos/components/Toast.jsx:32-50,65-91`
- **effort:** M
- **risk:** low
- **test:** Hover a toast → it stops counting down; error/undo toasts persist ~7s; success stays 3.5s.
- **deps:** []
- **batchHint:** toast-system

---

## Batch: `wallet-modal-polish` (F806)

### F806 — JS hover sticks on touch; "terms of use" no link; unknown connectors blank
- **verdict:** fix-now
- **rootCause:** T10 / standalone
- **confirmed:** `WalletModal.jsx:131-138` set styles in onMouseEnter/Leave (sticks on iOS tap); `:285` "terms of use" links nowhere; `:172-176` descriptions only for 6 hardcoded ids → empty row otherwise.
- **approach:** Move the connector-button hover to a CSS class on `.nakamigos-app` (`:hover` with `@media (hover:hover)` so it never triggers on touch) and drop the inline mouse handlers. Wrap "terms of use" in a `<Link to="/legal/terms">` (or the existing terms route — confirm path) and add a generic fallback description `"Browser wallet"` for unmatched connector ids (`:172-177`). Same disconnect-button hover at `:212-219` can be migrated too.
- **files:** `src/nakamigos/components/WalletModal.jsx:113-138,172-177,285,212-219`, `src/nakamigos/App.css` (add `.naka-connector-btn:hover` rule)
- **effort:** M
- **risk:** low
- **test:** iOS Safari emulation: tap a connector, move away → highlight clears. Terms link navigates. A non-standard injected wallet shows "Browser wallet" not an empty row.
- **deps:** []
- **batchHint:** wallet-modal-polish

---

## Batch: `sound-prewarm` (F807, F817)

### F807 — Alert sounds may be silent until next user gesture
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `useSound.js:143-151` `getCtx()` resumes inside `play()`; `usePriceAlerts`/`useSmartAlerts` (`App.jsx:566-569`) can call `play()` with no preceding gesture; `ctxRef.current.resume()` is fire-and-forget.
- **approach:** Add a one-shot `pointerdown`/`keydown` listener (mounted once) that calls `getCtx()` to create+resume the AudioContext on the first user gesture, then removes itself. This pre-warms so the first alert chirp isn't dropped by autoplay policy. Non-crash, additive.
- **files:** `src/nakamigos/hooks/useSound.js:143-160` (add prewarm effect)
- **effort:** S
- **risk:** low
- **test:** Fresh load, click once anywhere, then trigger a mocked price alert → sound plays on the first alert.
- **deps:** []
- **batchHint:** sound-prewarm

### F817 — Sound: binary mute only, no volume, no distinct offer-received sound
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `useSound.js` exposes `toggleMute` only; `SOUNDS` map has no offer-received entry.
- **approach:** Adding a volume slider + a new `offerReceived` sound is a feature, not a fix — defer to owner. If approved, add a `volume` state persisted to localStorage (mirror `nakamigos_sound_muted`) applied to the gain node in `playSound`, and a new `SOUNDS.offer` entry triggered where offers arrive.
- **files:** `src/nakamigos/hooks/useSound.js`
- **effort:** M
- **risk:** low
- **test:** N/A until scoped.
- **deps:** []
- **batchHint:** sound-prewarm

---

## Batch: `scroll-lock-hardening` (F808)

### F808 — Scroll lock causes Windows scrollbar shift; unreliable on old iOS Safari
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `scrollLock.js:8-11` only sets `overflow:hidden` — Windows desktop loses ~15px scrollbar (content jumps); body overflow:hidden doesn't fully lock iOS Safari <16.
- **approach:** In `lockScroll`, on first lock compute scrollbar width (`window.innerWidth - document.documentElement.clientWidth`) and apply `padding-right` compensation (or set `scrollbar-gutter: stable` on `html`), and store/restore `scrollY` via the `position:fixed; top:-scrollY` technique for iOS; reverse in `unlockScroll` when count hits 0. Keep the ref-count intact. Once F786 routes all overlays through this, the fix benefits every modal.
- **files:** `src/nakamigos/lib/scrollLock.js:6-19`
- **effort:** M
- **risk:** med (scroll restoration is fiddly — test the multi-lock count carefully)
- **test:** Windows Chrome: open modal → no horizontal content jump. iOS Safari: open modal, attempt to scroll background → locked; close → scroll position restored.
- **deps:** [F786]
- **batchHint:** scroll-lock-hardening

---

## Batch: `csv-export` (F801, F819)

### F801 — CR-only/CRLF values unquoted; heterogeneous keys drop columns
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `csv.js:15` quotes only on `,`/`"`/`\n` (bare `\r` breaks Excel rows); `csv.js:6` `headers = Object.keys(rows[0])` drops keys present only on later rows.
- **approach:** Add `\r` to the quote condition: `val.includes(",")||val.includes('"')||val.includes("\n")||val.includes("\r")`. Build headers by unioning keys across all rows: `const headers = [...rows.reduce((s,r)=>{Object.keys(r).forEach(k=>s.add(k));return s;}, new Set())]`. Minimal, preserves the injection-guard.
- **files:** `src/nakamigos/lib/csv.js:6,15`
- **effort:** S
- **risk:** low
- **test:** Unit-test export of `[{a:1},{b:2}]` yields header `a,b` and both rows; a value containing `\r` is quoted.
- **deps:** []
- **batchHint:** csv-export

### F819 — CSV export: no column selection / filter-aware export / JSON option
- **verdict:** product-decision
- **rootCause:** standalone
- **confirmed:** `csv.js` exports all keys of all passed rows; callers pass full datasets.
- **approach:** Column-picker UI + JSON export are features — defer. Filter-aware export is mostly a caller concern (pass the already-filtered array). No code until owner prioritizes.
- **files:** `src/nakamigos/lib/csv.js`, callers
- **effort:** M
- **risk:** low
- **test:** N/A until scoped.
- **deps:** [F801]
- **batchHint:** csv-export

---

## Batch: `eth-icon-a11y` (F803)

### F803 — Eth icon unit-bearing but invisible to screen readers
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `Icons.jsx:1-10` svg has no `role`/`aria-label`/`title`/`aria-hidden`; used as the ETH unit next to bare numbers (`Modal.jsx:360` etc.).
- **approach:** Add `role="img" aria-label="ETH"` to the `<svg>` in `Icons.jsx`. One-attribute change; every consumer benefits.
- **files:** `src/nakamigos/components/Icons.jsx:2-3`
- **effort:** S
- **risk:** low
- **test:** Screen reader announces "ETH" before the number in the modal price box.
- **deps:** []
- **batchHint:** eth-icon-a11y

---

## Batch: `naka-grid-mobile` (F828, F829, F830, F841)

**Summary.** At 390px the compact "gallery view" forces 4 columns (crops art, truncates labels to gibberish), listing-card titles ellipsize away the `#id`, whale stats clip at the right edge, and the vertical sales ticker eats ~250px of prime viewport. All are CSS/layout fixes plus a small label-priority change.

### F828 — 4-column gallery grid unreadable at 390px
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `App.css:1392` `.gallery-grid.compact { repeat(4,1fr) }`; the ≤480px block (`:1441-1453`) overrides `.gallery-grid.gallery` to `minmax(160px,1fr)` (→2 col) but does NOT override `.compact`, so compact stays 4-col at 390px.
- **approach:** In the `@media (max-width:480px)` block (`App.css:1441`) add `.gallery-grid.compact { grid-template-columns: repeat(2, 1fr); }`. Optionally make `#tokenId` the primary card label under ~110px width (Card component) — but the column fix alone resolves the crop. Additive.
- **files:** `src/nakamigos/App.css:1441-1453`
- **effort:** S
- **risk:** low
- **test:** 390px, toggle to compact/gallery view → 2 columns, art not cropped.
- **deps:** []
- **batchHint:** naka-grid-mobile

### F829 — Listing card titles ellipsize away the token number
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `Listings.jsx:814` renders `nft.name` = `${collection.name} #${tokenId}` (`:166`); at 3-col 390px the long prefix ellipsizes the `#id`. `.listing-card-name` truncates left-to-right.
- **approach:** Render the token id prominently. Minimal additive change: in `Listings.jsx:814` show `#{nft.id}` as the primary `.listing-card-name` and move the collection name to a smaller secondary line (or `title={nft.name}` for the full string on hover). Alternatively CSS `direction: rtl; text-align:left` to truncate from the left — but the explicit `#id` label is clearer and matches the buyer's mental model.
- **files:** `src/nakamigos/components/Listings.jsx:814`, `src/nakamigos/App.css` (`.listing-card-name`)
- **effort:** S
- **risk:** low
- **test:** 390px Floor grid → each card shows its `#id`; full name available on hover/title.
- **deps:** []
- **batchHint:** naka-grid-mobile

### F830 — Whale stats clip at the right edge at 390px
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** Screenshots `pass6/iphone14_nakamigos-nakamigos-whales_2.png`/`_3.png` show "4,990 / 20," clipped and whale-alert prices truncated. (Layout-only; the whales section CSS at `App.css:763` is desktop-padded with no ≤480px wrap for these rows.)
- **approach:** In the ≤480px media block, allow the holder-concentration total and whale-alert rows to wrap to two lines (`flex-wrap: wrap` / `white-space: normal`) and/or shorten the address midsection to free numeric space. Target the specific `.whale-*` / holder-concentration classes. Additive CSS.
- **files:** `src/nakamigos/App.css` (≤480px whale rules; confirm class names in `Whales`/`WhaleAlerts` components)
- **effort:** M
- **risk:** low
- **test:** 390px `/whales` → "X / 20,000" fully visible; alert prices not truncated.
- **deps:** []
- **batchHint:** naka-grid-mobile

### F841 — Vertical sales ticker eats ~250px; rows look tappable but only highlight
- **verdict:** fix-now
- **rootCause:** T10 + standalone (dead affordance)
- **confirmed:** Screenshots `pass8/iphone14_card_first_tap.png`/`card_second_tap.png` — six stacked ticker rows above Filters; tapping only toggles a highlight. (Component is the gallery `NftMarquee`, rendered at `App.jsx:578` with `onPick={setSelected}` available.)
- **approach:** On mobile cap the ticker at 2–3 rows (CSS `max-height` + overflow, or a count prop) so it doesn't dominate the viewport, and ensure each row's tap calls the existing `onPick(token)` to open the modal (the marquee already receives `onPick`). Additive — keep the ticker art.
- **files:** `src/nakamigos/components/NftMarquee.jsx`, `src/nakamigos/App.css` (mobile marquee height)
- **effort:** M
- **risk:** low
- **test:** 390px gallery → ticker ≤3 rows; tapping a row opens that token's modal.
- **deps:** []
- **batchHint:** naka-grid-mobile

---

## Batch: `naka-mobile-modal` (F822, F823)

**Summary.** The critical mobile-modal defects: the artwork never renders (placeholder + broken geometry) and "Make Offer" is clipped off-screen. F822 mixes a fixed-at-HEAD CSS conflict with a possible image-fetch gap; F823 is a flex-layout fix.

### F822 — NFT detail modal never shows artwork on iPhone (placeholder + broken geometry)
- **verdict:** fix-now
- **rootCause:** T10 + T11 (loading/geometry)
- **confirmed (geometry):** `App.css:3613` `.modal-image-side { max-height:280px !important }` and `:4383` `max-height:220px !important` (≤480px) clamp the side while `.modal-image-wrap` (`App.css:691`) stays square `width:100%` → overflow/crop. The placeholder bg (`rgba(255,255,255,0.02)`) is invisible on dark. **The image-fetch half (placeholder instead of `<img>`) overlaps with the prod rate-limiter incident (F824) — needs live verification on the redeployed build.**
- **approach:** (1) CSS: in the ≤640px / ≤480px blocks give `.modal-image-wrap` `max-height` matching `.modal-image-side` (e.g. 240px) with `object-fit: contain` on the `<img>` so it letterboxes instead of cropping; (2) style `.nft-placeholder` visibly on dark bg (e.g. `background: var(--surface); color: var(--text-dim)`) so a missing image reads as a labeled placeholder, not black; (3) ensure the modal's `NftImage` self-fetches the large URL when `nft.imageLarge`/`nft.image` is missing (pass `priority`, do not pass `noSelfFetch`) — confirm against `NftImage.jsx:62` props. Additive.
- **files:** `src/nakamigos/App.css:691,3612-3614,4382-4384`, `.nft-placeholder` rule, `src/nakamigos/components/Modal.jsx:245-248`
- **effort:** M
- **risk:** med (image pipeline interacts with F824's rate-limit fix)
- **test:** 390px Chrome on a freshly-deployed build: open `/nakamigos/nakamigos/nft/3` → artwork renders letterboxed within ~240px; if it genuinely can't load, a styled placeholder (not black) shows.
- **deps:** [F824]
- **batchHint:** naka-mobile-modal

### F823 — "Make Offer" clipped off the right edge in the modal buy row
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `Modal.jsx:417` `<div style={{ display:"flex", gap:10 }}>` with primary `flex:1` and `:452-459` secondary `flex:0, whiteSpace:"nowrap"`; at 390px the nowrap secondary can be pushed past the viewport (reproduced twice in `pass9`).
- **approach:** Add `flexWrap: "wrap"` to the action row (`:417`) and `minWidth: 0` to the primary button (`:421`) so the offer CTA wraps to a second line rather than overflowing. Additive style tweak.
- **files:** `src/nakamigos/components/Modal.jsx:417,421,454`
- **effort:** S
- **risk:** low
- **test:** 390px → both buttons fully visible (offer wraps below if needed); no horizontal overflow (scrollWidth stays 390).
- **deps:** []
- **batchHint:** naka-mobile-modal

---

## Batch: `lite-mode-deeplinks` (F826, F838)

### F826 — Deep links to 9 Pro tabs silently dump Lite users on Floor
- **verdict:** fix-now
- **rootCause:** T7-adjacent (silent gate)
- **confirmed:** `App.jsx:315-319` `if (isLite && LITE_HIDDEN_ALL.has(tab)) navigate(...,{replace:true})` with no feedback; sets in `TradingModeContext.jsx:15-23`.
- **approach:** Before the redirect, fire a toast ("That's a Pro feature — switch to Pro in the header to view {tab}") via the `addToast` already in scope, OR render the tab with a Pro-upsell gate component instead of replacing. Minimal: the toast on redirect. Keep the redirect so the URL stays valid.
- **files:** `src/nakamigos/App.jsx:315-319`
- **effort:** S
- **risk:** low
- **test:** In Lite mode open `/nakamigos/nakamigos/sniper` → lands on Floor WITH a toast explaining why.
- **deps:** []
- **batchHint:** lite-mode-deeplinks

### F838 — "Trade" and "P2P Trades" near-duplicate More-menu items
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `MobileNav.jsx:13` `"⇄ P2P Trades"` (key `trades`) and `:17` `"Trade"` (key `trade`); both in `VALID_TABS` (`constants.js:68`); `/trade` = peer-to-peer swap, `/trades` = NFT-for-NFT offers — genuinely distinct flows with confusing labels.
- **approach:** Rename for clarity rather than merge (both routes are real): `trade` → "Swap NFTs", `trades` → "Trade Offers". Update the `MORE_TABS` labels (`MobileNav.jsx:13,17`) and any desktop nav label source. Pure label change.
- **files:** `src/nakamigos/components/MobileNav.jsx:13,17` (+ desktop nav label source if separate)
- **effort:** S
- **risk:** low
- **test:** Pro More menu shows "Swap NFTs" and "Trade Offers" — no longer ambiguous.
- **deps:** []
- **batchHint:** lite-mode-deeplinks

---

## Batch: `splash-copy` (F827, F835, F840)

### F827 — Two stacked interstitials (per-entry splash + first-visit tour)
- **verdict:** product-decision
- **rootCause:** standalone (the per-mount splash is a deliberate standing decision — `App.jsx:138-143`)
- **confirmed:** `App.jsx:160-163` renders SplashScreen on every fresh mount (documented intent); first-visit tour (`showOnboarding`, `App.jsx:312`) also gates content.
- **approach:** Keep the splash per the standing decision. Owner-gated tweaks: (a) shorter ready-time on mobile, (b) auto-advance after ready, (c) defer the onboarding tour by one navigation when a deep link is resolving (don't stack it on the same visit). Implement only after owner confirms — the splash behavior is explicitly a user decision in memory.
- **files:** `src/nakamigos/components/SplashScreen.jsx`, `src/nakamigos/App.jsx:312,855-859`
- **effort:** M
- **risk:** low
- **test:** N/A until scoped.
- **deps:** []
- **batchHint:** splash-copy

### F835 — "CLICK TO ENTER" / "Click the heart" on touch devices
- **verdict:** fix-now
- **rootCause:** standalone
- **confirmed:** `SplashScreen.jsx:1381` hardcodes "CLICK TO ENTER"; the main loader already does `isMob ? 'TAP TO ENTER' : 'CLICK TO ENTER'` at `hold.ts:153`. Favorites empty state says "Click the heart...".
- **approach:** In `SplashScreen.jsx`, compute `isMobile` (matchMedia `(hover: none) and (pointer: coarse)` or reuse the same check as `hold.ts:153`) and render `TAP TO ENTER`/`CLICK TO ENTER` accordingly. Apply the same ternary to the favorites empty-state copy ("Tap"/"Click the heart"). Additive copy change.
- **files:** `src/nakamigos/components/SplashScreen.jsx:1381`, favorites empty-state component (`Favorites`/`FavoritesSection`)
- **effort:** S
- **risk:** low
- **test:** 390px touch emulation → splash says "TAP TO ENTER"; desktop says "CLICK TO ENTER".
- **deps:** []
- **batchHint:** splash-copy

### F840 — Splash subtitle ~7px, lost in title glow at 390px
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** Screenshots `pass1/iphone14_nakamigos_splash.png` show a tiny low-contrast subtitle and stats-plaque sub-labels at the edge of legibility.
- **approach:** Bump the subtitle to ≥10px and raise its color contrast under a mobile media query (or inline `clamp()`), and lift the stats sub-label contrast. Additive — no art removed.
- **files:** `src/nakamigos/components/SplashScreen.jsx` (subtitle + stats-plaque styles), `src/nakamigos/App.css` (`.splash-*` mobile rules if present)
- **effort:** S
- **risk:** low
- **test:** 390px → subtitle legible (≥10px, higher contrast); plaque sub-labels readable.
- **deps:** []
- **batchHint:** splash-copy

---

## Batch: `footer-scrim` (F839)

### F839 — Footer marketplace card low-contrast over collage art
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** Screenshots `pass6/...deals_3.png`/`favorites_1.png`/`whales_3.png` show the footer block's text/pills barely readable over the NFT collage behind it.
- **approach:** Add a darker scrim layer behind the footer card content (raise overlay opacity / add a `linear-gradient` darkening over the collage) while keeping the art per the preserve-art mandate. Target `.footer-full`/`.footer-inner` background. Additive.
- **files:** `src/nakamigos/App.css` (`.footer-full` / footer collage overlay)
- **effort:** S
- **risk:** low
- **test:** Footer text and OpenSea/Blur/Etherscan pills meet contrast against the art on mobile and desktop.
- **deps:** []
- **batchHint:** footer-scrim

---

## Batch: `naka-deeplink-perf` (F833)

### F833 — NFT deep-link modal open is slow/flaky (gated on first gallery page)
- **verdict:** fix-now
- **rootCause:** T8-adjacent (sequenced fetch) / standalone
- **confirmed:** `App.jsx:301-308` only fetches the deep-linked token after `nfts.allTokens?.length` (the comment "waiting for the first page proves the API path is up"); also `:330-338` falls back to a stub. So the modal waits on the full first page.
- **approach:** Fire `fetchTokensByIds([id], contract, metadataBase)` immediately for the deep-linked id in parallel with the first page load (don't gate on `allTokens.length`), and show a dedicated modal loading state (the stub at `:336` already opens an empty modal — give it a spinner/skeleton via the F822 styled placeholder). Keep the `tokenParamHandled` ref guard so it fires once.
- **files:** `src/nakamigos/App.jsx:290-309,329-338`
- **effort:** M
- **risk:** med (fetch ordering + the once-guard; don't double-fire)
- **test:** Open a `?token=` / `/nft/:id` deep link cold → modal appears within ~2s with a loading state, independent of the first gallery page.
- **deps:** []
- **batchHint:** naka-deeplink-perf

---

## Operator / redeploy / infra (no app-code fix in this surface)

### F824 — Buy-grid cards render letter placeholders below the fold (prod rate-limit)
- **verdict:** operator-action (with code follow-up)
- **rootCause:** T8 (the prod rate-limiter incident pattern, 2026-06-11)
- **confirmed:** `NftImage.jsx:57-61` documents the exact incident; the batch path (`fetchTokensByIds` + `noSelfFetch`) is the existing mitigation. Whether all 60 rendered cards are covered by the batch needs a live check against the redeployed build.
- **approach:** Operator: confirm the Upstash/Alchemy proxy rate-limit headroom on prod (matches the 06-09/06-11 incidents). Code follow-up (if the batch misses rows): ensure the Floor grid passes `noSelfFetch` for ALL mounted cards and staggers/chunks `fetchTokensByIds` so 60 cards don't burst. Verify on the new build before more code.
- **files:** `src/nakamigos/components/Listings.jsx` (batch coverage), `src/nakamigos/components/NftImage.jsx:57-61`, prod proxy config
- **effort:** M
- **risk:** med
- **test:** Live: load `/nakamigos/nakamigos/listings` on prod, scroll below fold → all cards resolve to art within a few seconds, no minutes-long placeholders.
- **deps:** []
- **batchHint:** prod-image-pipeline

### F825 — Prod /api/opensea failing: offers 502, stats 400
- **verdict:** operator-action (with a small UI follow-up)
- **rootCause:** T8 / standalone (server-side proxy)
- **confirmed:** Network logs show 502 on the offers path and 400 on `collections/nakamigos/stats`. This is a serverless/proxy/key issue, not nakamigos client code.
- **approach:** Operator: fix the `/api/opensea` proxy path/key server-side (the offers seaport path and the collection-stats path). Code follow-up: replace the permanent skeletons with a visible "Offers unavailable" / "—" error state when the proxy errors (so a down API doesn't latch forever). The error-state UI is a small fix-now once the endpoint is triaged.
- **files:** `frontend/api/opensea*` (serverless), `src/nakamigos/components/OfferPanel.jsx` (error state)
- **effort:** M
- **risk:** med
- **test:** Live: `/nft/3` offers section shows offers or a clear "unavailable" state; hub VOLUME and junglebay FLOOR/OWNERS/SUPPLY resolve.
- **deps:** []
- **batchHint:** prod-opensea-proxy

### F831 — Activity feed serving cached example data with duplicate rows
- **verdict:** operator-action
- **rootCause:** T8 (Upstash rate-limiter incident pattern)
- **confirmed:** Screenshots show the honest "Showing cached example data — live API unavailable" banner + duplicate rows (#16971/#8949/#4228 twice). The banner is correct behavior; the live pulse is down on prod.
- **approach:** Operator: investigate the activity API outage (same 06-09 Upstash pattern). The banner honesty is already good — no client fix needed beyond de-duping the cached sample (a tiny data-fixture cleanup if the duplicates are in the fallback fixture).
- **files:** activity API / fallback fixture (server), optional `src/nakamigos/components/Activity*` de-dupe
- **effort:** M
- **risk:** low
- **test:** Live: `/activity` shows live data with no duplicate rows once the API is restored.
- **deps:** []
- **batchHint:** prod-activity-api

### F832 — Sniper reports "no listings" while Floor shows 778
- **verdict:** operator-action (with code follow-up)
- **rootCause:** standalone (divergent feed)
- **confirmed:** Sniper says "No Nakamigos listings available" while Analytics (same session) shows ACTIVE LISTINGS 778 — the sniper consumes a different/empty feed than the Floor grid.
- **approach:** Code: point the Sniper at the same `useListings` source the Floor tab uses (or surface the actual fetch error instead of the empty state). Confirm the Sniper component's data hook against `useListings`. Likely a one-line hook swap, but needs live verification of which feed is empty.
- **files:** `src/nakamigos/components/Sniper.jsx` (data source), `src/nakamigos/hooks/useListings`
- **effort:** M
- **risk:** med
- **test:** Live (Pro): Sniper shows opportunities when Floor shows listings.
- **deps:** []
- **batchHint:** prod-sniper-feed

### F834 — CSP/CORS console noise (eth.merkle.io blocked, llamarpc CORS, font style-src)
- **verdict:** operator-action
- **rootCause:** standalone (CSP/RPC config, not nakamigos component code)
- **confirmed:** Console on all routes shows CSP `connect-src` blocking `eth.merkle.io`, CORS failures on `eth.llamarpc.com`, and `style-src` blocking the Press Start 2P stylesheet.
- **approach:** Operator/config: either drop `eth.merkle.io`/`eth.llamarpc.com` from the RPC fallback list or add them to `connect-src` in the CSP (vercel.json / headers / index meta). Self-host the Press Start 2P font (or add `fonts.googleapis.com` to `style-src`) — note `App.css:1-11` already defers the font import deliberately; self-hosting aligns with that. These are headers/RPC config, not nakamigos JSX.
- **files:** `vercel.json` / CSP header config, RPC config (`src/nakamigos/api.js` fallback list), font hosting
- **effort:** M
- **risk:** low
- **test:** Live: clean console on `/nakamigos` routes; pixel font loads without style-src violation.
- **deps:** []
- **batchHint:** csp-rpc-font

### F837 — "Back to top" sits 1px from the Gallery tab (mis-tap)
- **verdict:** fix-now
- **rootCause:** T10
- **confirmed:** `tap_metrics.json` — back-to-top right edge 72px, Gallery tab x:73 (1px gap). Back-to-top is `App.css:918` (`bottom:28px; left:28px`); the bottom nav is at the same corner region on mobile.
- **approach:** On mobile (≤767px) raise the back-to-top button ~60px above the bottom nav (e.g. `bottom: 76px`) or add horizontal margin so the two 44px targets don't abut. Additive CSS.
- **files:** `src/nakamigos/App.css:918` (+ mobile override)
- **effort:** S
- **risk:** low
- **test:** 390px → back-to-top clears the bottom nav row; no adjacent-target mis-tap.
- **deps:** []
- **batchHint:** footer-scrim

### F812 / F820 — No print stylesheet, no light theme in nakamigos
- **verdict:** F812 fix-now (print block) · F820 duplicate-of-F812
- **rootCause:** T10
- **confirmed:** No `@media print` and no `prefers-color-scheme: light` anywhere in `App.css` (grep clean); main app has a print block at `index.css:817`. F820 is the same observation restated.
- **approach:** Additively add a minimal `@media print` block scoped to `.nakamigos-app` (white bg, black text, hide nav/marquee/splash/ticker) so About/lore and share cards print legibly. No full light theme per the art direction (owner mandate). F820 marked duplicate-of-F812.
- **files:** `src/nakamigos/App.css` (append `@media print` block)
- **effort:** S
- **risk:** low
- **test:** Print-preview the About page → dark-on-dark replaced with legible black-on-white; nav/marquee hidden.
- **deps:** []
- **batchHint:** naka-print
