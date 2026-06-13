# Nakamigos / Tradermigos Marketplace — Full Frontend Audit

Synthesized from 10 agents: live-browser (prod, 3432px ultrawide), exact-viewport Playwright (iPhone 390 / iPad 820 / desktop 1440), and code-read (HEAD of `mvp-launch`). Tag key: **[verified]** = live + code agree · **[code-read]** = code only · **[live]** = browser only · **[fixed at HEAD — prod stale]** = code shows it fixed but prod still exhibits it. Owner mandate honored throughout: every suggestion is additive — no existing art or page section is removed.

---

## Splash, Skeletons & Page Transitions

> **What's already good:** The card-collage splash with glitch shader and the three coherent themes (default / midnight starfield / royal gold) are genuinely beautiful brand work; in-app SPA tab-to-tab transitions are instant with zero flicker; scroll position + originating-card highlight ring restore on modal close; honest "Scanning N/20,000" progressive states on data-heavy pages.

### Wrong
- **critical** — On iPad/desktop deep-link visits to sub-routes (`/listings`, `/analytics`, `/portfolio`, `/trades`), the "CLICK TO ENTER" gate is **dead — 8+ center clicks over 60s never dismiss it**, permanently stranding the highest-value visitor (shared-link follower); root `/nakamigos` gate dismisses fine ([live] `viewport:tablet-desktop`, `ipad_nakamigos-nakamigos-listings_1.png`). Likely the sub-route-mounted gate is missing the onClick wiring the root has.
- **high** — Keyboard / assistive-tech users **cannot enter the app at all**: the only path to `onComplete` is `onClick` on a non-focusable `<div>` (no role/tabIndex/keydown); replays every visit, no skip control ([code-read] `SplashScreen.jsx:749-755,1372-1381`; `App.jsx:161-163`).
- **high** — `?token=` deep links are **stripped during the splash click-through** — shared token links never open the token; in-session browsing generates exactly this URL format so copied links break for recipients (path-based `/nft/:id` survives) ([verified] `live:naka-browse #2` + `code:naka-shell #1`: URL-sync effect deletes the param before the reader effect runs, `App.jsx:280-309`).
- **medium** — Reduced-motion CSS rule `.splash-screen { display:none }` targets a class the splash **never applies**; if anyone "fixed" the class it would hide the only clickable element → permanent black screen ([code-read] `App.css:3551` vs `SplashScreen.jsx:752`).
- **polish** — Splash stats plaque + loading messages are hardcoded to the default Nakamigos collection ("20,000 WORKS") even when deep-linking into Jungle Bay (5,555) or GNSS (9,697); status line concatenates all three collections' messages ([verified] `code:naka-shell #21` + `live:naka-social` splash note).

### Needs improvement
- **high/medium** — Mandatory click-gated splash **replays on every full page load** (reloads seconds apart, deep links, even 404 routes), costs ~10-20s per visit; "CLICK TO ENTER" only becomes actionable at ~9-15s (earlier clicks swallowed); no sessionStorage gate, no skip, no remembered preference ([verified] across `live:naka-social #3`, `live:naka-browse #9`, `live:naka-market #14`, `viewport:mobile-naka #5`, `code:naka-shell #19`, `viewport:tablet-desktop #5`). Owner standing decision keeps the splash per-entry; the **duration and the swallowed early clicks** are the tax — tie the progress bar to real data readiness, make it click-skippable from second 0, and trim the 2.65s desktop exit chain to the mobile 1.4s timings.
- **medium** — Splash blocks a further ~4-8s near-black skeleton fade before content paints; start data-fetching/preloading behind the splash so the post-click fade disappears ([live] `live:naka-social`, `live:naka-browse`).

### Missing vs objective
- **medium** — No visible skip / "press Enter to skip" fast-path for repeat visitors (additive, preserves the every-entry intent while unblocking keyboard users) ([code-read] `code:naka-shell` missing-list).

### Polish
- **polish** — Skeleton fidelity is poor: listings loading state renders a **7-column geometry that jumps to the real 4-column + sweep-panel layout** on load; stats tiles show em-dashes ("—") instead of shimmer (reads as "no data exists"); images pop in with no fade (one-frame black→art swap) ([verified] `live:naka-browse #17`, `live:naka-browse #14`).
- **polish** — Modal OFFERS / Comparable-Sales skeletons **latch forever** on prod (still pulsing after 60s) — covered under NFT Detail Modal below ([verified] multi-agent).

---

## Splash Screen (Tradermigos brand gate) — component-level

> **What's already good:** Physics engine is well-engineered (rAF paused on visibilitychange, spark caps, GPU canvas disposal on unmount, mobile-reduced art set, 8s force-ready failsafe).

### Wrong
- **high** — Keyboard-inaccessible entry (see Splash section above) — the single hardest a11y block in the sub-app ([code-read]).

### Needs improvement
- **low** — "CLICK TO ENTER" wording shown on touch devices; the main Tegridy loader already does `isMob ? 'TAP TO ENTER' : 'CLICK TO ENTER'` ([code-read] `SplashScreen.jsx:1381` vs `src/components/loader/phases/hold.ts:153`).
- **polish** — `IS_MOBILE` frozen at module load → a rotated tablet keeps the wrong piece set until reload ([code-read] `SplashScreen.jsx:5`).

### Polish
- **polish** — At 390px the "THE DIGITAL ART GALLERY" subtitle is ~7px and lost in the title glow; stats sub-labels at the edge of legibility ([live] `viewport:mobile-naka #18`).

---

## Collections Hub / Landing (`/nakamigos`)

> **What's already good:** Hub search autocomplete finds any token ID across all 3 collections with thumbnails and routes to a real `/nft/:id` deep-linkable page; balanced 3-card row at 1440; per-collection floor/owners/supply populate via fallback.

### Wrong
- **high** — `/api/opensea?path=collections/{slug}/stats` returns **400 (bad request, not rate-limit) for every collection on every load** → VOLUME shows "—" on all three hub cards (and "TOTAL VOLUME —" on About pages); Nakamigos card's FLOOR/VOLUME/OWNERS/SUPPLY can stay gray skeletons forever while GNSS/JB resolve via fallback ([verified] `viewport:tablet-desktop #1`, `live:naka-browse #8`, `live:naka-social #8`, `viewport:mobile-naka #3`). Yet the gallery header showed "52.2K ETH ALL-TIME VOL" once, so the data exists — fix the path or fall back to indexer/Alchemy volume.
- **medium** — Unexplained orange "• DEMO" badge on the hub (collection pages say green "• LIVE — Real active listings via OpenSea") with **no tooltip / no title attr**; a trust-sensitive UI flipping DEMO↔LIVE with no explanation undermines the real-data story ([verified] `live:naka-social #9` + `live:naka-browse #22`).
- **low** — Token-ID search assumes ids are `1..supply`; gnssart ids go past supply and junglebay has burns, so valid ids are excluded and burned ids link to dead tokens; `id > 0` also excludes a 0-indexed token #0 ([code-read] `CollectionLanding.jsx:98-105` vs `constants.js:33,49`).
- **low** — Floor stat rounds ≥1 ETH to whole numbers (a 1.5 ETH floor renders "2 ETH") ([code-read] `CollectionLanding.jsx:334-340`).

### Needs improvement
- **medium** — All three collections' stats refetch (4 API calls each) on **every landing visit with no cache** ([code-read] `code:naka-browse #28`, `CollectionLanding.jsx:618-653`).

### Missing vs objective
- **low** — Collection cards show static floor/volume/owners with **no 24h deltas, sparklines, or last-updated stamp** (Dexscreener/OpenSea category pages lead with change indicators) ([code-read]).

### Polish
- **low** — Cross-collection search dropdown lacks keyboard nav + combobox ARIA; `<h3>`/`<p>` nested inside a `<button>` is invalid HTML ([code-read] `CollectionLanding.jsx:149-265`).

---

## Shell / Routing / Header / Nav

> **What's already good:** Layered error-boundary architecture (app-level hard-reload reset + per-surface scoped resets + `key={tab}` un-latch fix that verifiably stops one crashed tab bricking the rest); chunk-load auto-reload with bounded 3-attempt guard; all 7 contexts memoized and per-collection-keyed; `CollectionView` remount-by-key eliminates cross-collection bleed; honest LIVE/DEMO + StaleIndicator signaling; per-page document titles are excellent ("Nakamigos - Chat | Tradermigos").

### Wrong
- **critical** — **Gallery is unreachable from every nav surface.** Clicking "Gallery" (header, mobile nav, logo, About/Traits "filter then jump" flows) and the `g`/`1` hotkey all land on Floor/Listings with the Floor tab lit; `/nakamigos/<slug>/gallery` typed directly works ([verified] `live:naka-social #0`, `live:naka-browse #1`, `code:naka-shell #0`). Root cause: `App.jsx:358` builds the gallery URL as a bare collection path and `parseRoute` (`App.jsx:91`) maps bare → "listings". Reproduced identically at HEAD — **not fixed**. `navRouting.test.jsx` only checks nav keys ∈ VALID_TABS, not URL construction.
- **high** — At **exactly 768px viewport** (iPad Mini/9.7"/10.2" portrait) every nav surface is hidden: desktop-nav hides ≤768, hamburger hidden ≥768 `!important`, bottom-nav shows only ≤767 → no nav at all ([code-read] `App.css:1370,1437,3704-3707`). Violates the flawless-iPad mandate.
- **high** — ErrorBoundary "Go Home" sets `window.location.hash` on a **BrowserRouter** app — it doesn't navigate, so a deterministically-crashing tab is an inescapable loop (the documented escape hatch is broken) ([code-read] `ErrorBoundary.jsx:134`; same dead fallback `NotFound.jsx:31`).
- **medium** — Two theme systems write the same `documentElement[data-theme]`: visiting Tradermigos **permanently clobbers the main app's light/dark theme** until reload (no unmount cleanup) ([code-read] `nakamigos/contexts/ThemeContext.jsx:105` vs main `ThemeContext.tsx:30`).
- **low** — The hamburger button + `.mobile-nav` drawer are **dead UI** — CSS hides the hamburger at every width (the show rule can never win) ([code-read] `App.css:1023-1027,1371,1437,3713`).
- **low** — Closing a deep-linked modal (X/Escape) silently switches the underlying tab from Gallery → Floor (same root-cause family as the gallery bug) ([code-read] `code:naka-shell #13`).
- **polish** — `parseRoute` parseInt is lenient: `/nft/12abc` resolves to token 12; Header Ticker + StaleIndicator intervals keep firing while `document.hidden` ([code-read] `code:naka-shell #22`).

### Needs improvement
- **medium** — Three always-on pollers (`useSmartAlerts` 30s, `usePriceAlerts` 30s, `useCollection` 60s) fetch the same stats/activity endpoints — **~6 req/min per idle visitor, none gated on tab visibility**, no shared cache; given the prod Upstash rate-limiter incident this is the first thing to consolidate ([code-read] `code:naka-shell #8`).
- **medium** — Every cart/favorite/toast/activity change re-renders the **entire CollectionView tree** — fine-grained context split defeated by top-level consumption + prop drilling ([code-read] `code:naka-shell #11`).
- **low** — Clicking the connected-wallet address **instantly disconnects** with no menu/confirm (one misclick = disconnect); best-in-class headers open an account popover ([code-read] `Header.jsx:316-323`).
- **low** — "More" dropdown: no Escape-close, no focus management, position recomputed only at open (stale on resize/scroll) ([code-read] `code:naka-shell #16`).
- **low** — PWA Install: clicking Install a second time after dismissing throws `InvalidStateError` (deferredPrompt not cleared on 'dismissed') ([code-read] `InstallPrompt.jsx:22-29`).
- **low** — Non-chunk errors render the **raw stack trace** to end users ([code-read] `ErrorBoundary.jsx:102-104`).
- **low** — Fallback data fabricates activity by **real named wallets** ("vitalik.eth Bought 3, 4m ago") with fresh fake timestamps; only disclosure is the DEMO badge, hidden entirely ≤390px — contradicts the honesty-pass standard ([code-read] `constants.js:176-189`, `App.css:4294-4297`).

### Missing vs objective
- **medium** — No URL-persisted/shareable gallery state (filters/sort/search/Lite-Pro all in-memory, lost on tab switch); no scroll-position restoration (always scrolls to top); no data cache across tab switches (only listings use react-query) ([code-read] `code:naka-shell #25` + missing-list). OpenSea/Blur encode these in the querystring.
- **medium** — Browser Back/Forward doesn't close/restore the NFT modal (one-way URL sync, no popstate) ([code-read]).
- **low** — No inline collection switcher inside a collection view (must return to the hub); no `aria-current` on active nav tabs; no onboarding re-entry point ([code-read] missing-list).

### Polish
- **polish** — Header alternates 1-row/2-row layout on scroll, moving Floor/More by hundreds of px — clicks land on the wrong control after a switch ([live] `live:naka-market #25`).
- **polish** — Two parallel toast systems in one product (nakamigos hand-rolled `Toast.jsx` vs the main app's sonner): no pause-on-hover, errors auto-dismiss in the same 3.5s as successes, undo toasts give only 3.5s to react ([verified] `code:naka-ux-misc #10/#20`, `code:naka-shell #23`).
- **polish** — Background mounts 20 full-res ghost-art JPEGs (~2.3 MB, two files >400 KB) with no `loading="lazy"`/`decoding="async"` + 6 always-animating blur layers, no reduced-motion gating outside Starfield ([code-read] `Background.jsx:72-296`). Keep the art — defer to `requestIdleCallback`, serve webp/avif, static frames under reduced-motion.

---

## NFT Detail Modal (all collections)

> **What's already good:** Trust features are real — ORDER WARNING ("Listed 48 days ago"), Est. Fair Value, price-history sparkline with min/avg/max, trait spotlight cards with real exist-counts, OpenSea/Etherscan outlinks, `validateOrderQuick` red/yellow pre-validation (a tx-simulation-style affordance many marketplaces lack), and honest "(based on X/Y loaded)" captions. `fulfillSeaportOrder` is exchange-grade hardened.

### Wrong
- **critical** — **Detail-modal hero image never loads** for most tokens — shows the "N #id" letter placeholder permanently (`.modal-image-wrap` contains no `<img>` at all) while the SAME token's grid thumbnail renders fine; on un-enriched tokens it also shows "No traits available." Reproduced on prod (#5/#18156/#0/#777, JB #4522, GNSS #5907) AND at HEAD ([verified] `live:naka-browse #0`, `live:naka-social #1`, `viewport:mobile-naka #0`, `live:naka-market #1`). The single-NFT evaluation objective (see the art, see the traits) fails. On dev the image loads after ~9s but renders bottom-cropped: `App.css:3612` forces `.modal-image-side { max-height:280px !important }` while `.modal-image-wrap` stays square. **Fix: fire on-demand `getNFTMetadata` on open, fall back instantly to the already-loaded grid thumbnail URL, and fix the geometry.**
- **high** — `/api/opensea` offers endpoint returns **502/429** → OFFERS section shows 3 grey skeleton bars that **never resolve** (still pulsing after 60s); same for Comparable Sales ([verified] `live:naka-browse #5`, `live:naka-market #10`, `viewport:mobile-naka #3`, `live:naka-social #28`). On dev skeletons=0, so partly data-dependent — verify before closing.
- **high** — Identical unlabeled address "0x255d...1963" shown in the modal header across **different collections** (JB #4522 and GNSS #5907) while each CONTRACT field below differs — reads like a contract, smells like stale/bled owner data; on dev it renders an ENS so it's the OWNER but unlabeled ([live] `live:naka-social #4`).
- **medium/high** — Secondary **"Make Offer" button clipped to "Mak"/"Ma"** (~30-34px) next to the Buy CTA, overflowing the modal's right edge; on 390px the gold buy button takes full width and pushes the offer CTA off-viewport. Reproduced on prod AND HEAD, every token ([verified] `live:naka-social #5`, `live:naka-browse #6`, `live:naka-market #9`, `viewport:mobile-naka #1`). Fix: `flexWrap:'wrap'` + `minWidth:0` on the primary, `flex-shrink:0`/min-width on the offer button.
- **medium** — Rarity rank + trait percentages computed from a **tiny loaded sample (40-80 of full supply)** yet presented as authoritative — "RANK #17 of 20,000" from 80 tokens, and the same number baked into the shareable PNG ([verified] `live:naka-social #6`, `live:naka-browse #11`). Ship precomputed full-collection rarity or label "sample estimate" and keep it off the ShareCard until exact.
- **medium** — Two contradictory fair-value/rank models for the **same token on the same click path**: Deals lists #1170 "32% below, rank ~#1103"; its modal says "FAIR, Est. Fair Value 0.2502, RANK #3332" ([live] `live:naka-market #11`). Use one fair-value + one rank source on both surfaces.
- **medium** — On dev/HEAD the modal renders a **raw ethers error dump** ("ORDER WARNING ... missing revert data, invocation=null, code=CALL...") including hex calldata in the UI ([live] `live:naka-social #10`).
- **low** — Modal/About/ShareCard/PriceHistoryChart bypass the canonical `formatPrice` and use raw `.toFixed(4)` (a 1234.5 ETH value shows "1234.5000"); dust < 0.00005 renders "0.0000" indistinguishable from zero ([code-read] `code:naka-ux-misc #17`).
- **low** — After a successful buy the modal still shows the stale "Buy for X ETH" CTA (a second click reverts `OrderAlreadyFilled`) ([code-read] `Modal.jsx:434-438`).

### Needs improvement
- **medium** — `OfferPanel` 30s poll calls `setLoading(true)` each tick → **flashes skeletons over real offers every 30s**; successful accepts surface generic errors and don't refetch ([code-read] `code:naka-market #16`).
- **low** — Price-history chart pops in with no skeleton/dates/tooltips/SVG-a11y and refetches on every modal open ([code-read] `code:naka-ux-misc #19`).

### Missing vs objective
- **medium** — No net-proceeds preview when accepting an offer; no floor-relative context ("92% of floor") on bids ([code-read] `code:naka-market #36`).
- **low** — No comparable-sales / similar-tokens module (no "cheapest other Human Coffee") even though trait-floor data exists in the drill-down views ([live] `live:naka-browse #23`).
- **low** — No USD equivalents in the modal price box; no tx-hash deep link to Etherscan after buy (recordTransaction already has it) ([code-read] missing-list).

### Polish
- **low/polish** — Owner row renders a stray leading "- 0xbluemoon.eth · Profile"; Eth unit icon invisible to screen readers ([live] `live:naka-market #24`; [code-read] `Icons.jsx:1-10`).

---

## Browse — Gallery (`/gallery`)

> **What's already good:** Honest sampling disclosure ("TOKENS LOADED 1,840 OF 20,000 — TRAIT % FROM LOADED SAMPLE"); virtualized grid with `contain:strict`; AbortController cancellation on collection switch; aspect-ratio CLS prevention; scroll restoration + highlight ring on modal close.

### Wrong
- **high** — **Infinite scroll yanks the user to the top on every page append**: the scroll-reset key includes `tokens.length`, so a loadMore (40→80) looks like a filter change and resets `scrollTop=0`; load-more fires 5 rows from bottom → every page-2+ load jumps to top ([code-read] `VirtualGalleryGrid.jsx:115-122`). Hits all three >1000-supply collections.
- **high** — **Column count frozen at default 4** — `ResizeObserver` never attaches because first render is the skeleton branch (no `parentRef`); on 390px iPhone this renders `repeat(4,1fr)` ~85px cards ([code-read] `VirtualGalleryGrid.jsx:41-46`). Corroborated live: 4-col gallery at 390px makes names "Nakamig…#0" and traits "Type:…" unreadable, crops square art into tall tiles ([live] `viewport:mobile-naka #6`).
- **high** — Gallery **price sort and price-range filter operate on a price field that is always null** — `normalizeToken` sets `price:null` and listing prices are never joined onto tokens; so price sort is a no-op and any price range filters out the entire collection → "No NFTs Match" empty state ([code-read] `code:naka-browse #2`). Listed prices exist in the `listings` prop but are never merged.
- **medium** — Filter sidebar accordion + trait-search state **wiped on every appended page** (`setTraitFilters` gets a new array each page, and the reset effect keys on its identity) ([code-read] `FilterSidebar.jsx:403-407`).
- **medium** — Trait rarity % **divides loaded-sample counts by full supply** → every trait reads <5% and shows the gold "rare" color until the whole collection loads (TraitExplorer already fixed this exact bug; FilterSidebar wasn't given the fix) ([code-read] `FilterSidebar.jsx:571`).
- **medium** — Gallery search matches **loaded pages only** — searching a valid unloaded token ID ("5000"/"15000") shows a **message-less empty state** of ghost skeleton cards, even though the hub search finds it instantly via fetch-by-id ([verified] `live:naka-browse #12`, `code:naka-browse #12`).
- **low** — Two stacked empty states on no-results: full-height "No items found" from the grid plus the styled `.empty-state` card below it ([code-read] `code:naka-browse #17`).
- **low** — Featured-NFT hero rotation swaps `src` abruptly (hard cut despite an opacity transition on the img); volume formatter caps at "K" (no M tier) ([code-read] `Hero.jsx:41,85-89`).

### Needs improvement
- **low** — `FilterSidebar` has dead `isMobile` state with a resize listener causing re-render churn ([code-read] `FilterSidebar.jsx:400,410-415`).
- **low** — No "loading more" indicator during scroll pagination; mobile filter count can double-count (Gallery omits price filter, FilterSidebar includes it) ([code-read] `code:naka-browse #27`).

### Missing vs objective
- **high (consolidated)** — No listed-price/listed-status badges on gallery cards (data exists in the `listings` prop, never merged) — Blur/OpenSea grids lead with price; with "Listed Only" on, cards show trait subtitles but no ETH price ([code-read] `code:naka-browse` missing-list; [live] `live:naka-browse #21`).
- **low** — No trait-value search / fuzzy matching / fetch-by-id fallback; no `srcset`/DPR variants on NftImage (retina upscales thumbnails); no jump-to-token affordance ([code-read] missing-list).

### Polish
- **low** — Add-to-cart button on gallery cards is **hover-gated → unreachable on touch** ([code-read] `VirtualGalleryGrid.jsx:358`).
- **polish** — Raw price in aria-label (`0.123456789 ETH`) while visible UI uses formatPrice; unstable list keys in Listings (`${id}-${idx}`) remount all cards on re-sort ([code-read] `code:naka-browse #30`).

---

## Browse — Floor / Listings (`/listings`)

> **What's already good:** Genuinely pro-grade toolkit — working sort, live max-price filter with "Showing 6 of 786" counter, sweep panel (BY QTY/BY BUDGET), trait-filter cascade, floor-depth histogram, floor-impact estimate, per-item venue badges; median-led MEDIAN/AVG stat with whale-skew comment; chunked 60-card reveal; self-buy guard; documented iOS Safari flex-order fix. The 2026-06-11 image-pipeline fix is real and correct on its primary path.

### Wrong
- **critical** — **Order Book bid side is nonsense and the verdict contradicts itself**: BEST BID 4.28-4.52 ETH vs BEST ASK 0.1026-0.1045 on a 0.10-floor collection, "Spread -4.18 ETH (-4071%)" labeled green "● Healthy — Price gap is narrow, suggesting healthy trading"; bid ladder 4.44/4.30/4.16/3.87 ([verified] `live:naka-browse #3`, `live:naka-market #0`). Almost certainly **multi-quantity collection-offer TOTALS read as per-item prices** (4.52/43 ≈ 0.105 = the real per-item offer the cards correctly show). Fix: normalize per-item (total/quantity), add a `bestBid > bestAsk` ⇒ "crossed/dirty, suppress Healthy" invariant.
- **high** — Buy-grid cards render as **letter placeholders instead of art below the fold** (8 of 9 visible cards on iPhone ~6s after load), matching the documented prod 2026-06-11 incident ([live] `viewport:mobile-naka #2`; corroborated `live:naka-social #21`). Verify the batch `fetchTokensByIds` covers all 60 rendered cards.
- **medium** — `c = add to cart` keyboard shortcut **does nothing** on a visibly-focused card (no toast, no badge); the "Trait Offer" popover ignores Escape/outside-click and persisted across Lite/Pro remount ([live] `live:naka-market #13`).
- **medium** — Outlier troll listings (up to ~1650 ETH) **destroy every linear price axis** — deals scatter, floor-depth histogram (`0.10…1500 ETH`, all bars in first 10%), and the ask ladder (782 of 786 asks in bucket 1) all carry zero information ([live] `live:naka-market #7`). Clamp domains at p95 / floor×3 with a "+N outliers" annotation, or log scale.
- **medium (mobile)** — Batch-selection bar (`z-index:100`, fixed bottom) is **covered by the mobile bottom nav** (`z-index:9999`) — "N selected / Add All to Cart" buttons hidden ([code-read] `Listings.jsx:900-907` vs `MobileNav.jsx:117-128`).
- **medium** — "Rank: Best First" / "Rank: Highest #" sorts are **silent no-ops** (return the exact same order as price-asc), though rank data exists (the modal shows "RANK #791") ([live] `live:naka-browse #4`).
- **low** — Token-metadata enrichment **refetches the same IDs on every activities/tokens update** (already-fetched ids never added to `knownIds`, deps include the 60s-polled `activities`) — periodic batch-fetch storm of ~8 POSTs ([code-read] `Listings.jsx:124-145`).
- **low** — Nakamigos `metadataBase/<id>.png` fallback URL **verifiably 404s** (curl-confirmed) yet three code paths still emit it for recent-sales cards → broken-image flash + per-card metadata fetch burst (the exact pattern the 2026-06-11 fix eliminated) ([code-read] `Listings.jsx:239-246`, `api.js:105-108`).
- **low** — Inconsistent image sourcing: some cards use raw `ipfs.io` 2000px full-res (slow, re-blacks on every grid re-render) instead of the Alchemy 250px CDN ([live] `live:naka-browse #15`).
- **low** — Mobile listing card titles ellipsize away the **token number — the only identifier** ("Nakamigos …", "Jungle Bay…") ([live] `viewport:mobile-naka #7`).
- **low** — Hardcoded `FALLBACK_STATS` (floor 0.1048, 5,238 owners) render as live data on first paint and on API failure with no staleness marker in the Hero ([code-read] `code:naka-browse #20`).
- **low** — Stale fee claim "Save 0.5% vs OpenSea / OpenSea ~1.5%" — OpenSea is 1% now; project memory says don't market a fee discount ([verified] `live:naka-market #8`, `code:naka-market #19/#20`).

### Needs improvement
- **medium** — On API failure near the bottom, load-more **retries in an unthrottled loop** (guard resets on every loading flip, `onLoadMore` identity changes, `hasMore` stays true) — hammers the proxy that already rate-limited in prod ([code-read] `code:naka-browse #8`).
- **low** — Floor/owners differ across surfaces within minutes (Floor 0.1026/5,212 vs Gallery 0.1045 vs loading-state 0.1048/5,238) — two unreconciled sources ([verified] `live:naka-browse #13`, `live:naka-social #15`).
- **low** — JB stats bar shows "—" for floor/owners/supply for ~10s while the sweep panel already has floor data ([live] `live:naka-browse #14`).
- **low** — `fetchNativeListings` retry wrapper shares one 15s AbortController across attempts and clears the timeout after attempt 1 → later retries have no timeout (or get pre-aborted) ([code-read] `orderbook.js:40-51`).

### Missing vs objective
- **low** — No trait/source toggle on the buy grid (Listings offers only sort + max-price; `traitCategories` is already computed); no expiry countdown / "listed X ago" / maker ENS / per-listing floor-% on cards ([code-read] missing-list).

### Polish
- **low** — LIVE sales ticker intermittently renders empty (green dot, no text) — keep the last sale until the next is ready ([live] `live:naka-market #19`).

---

## Browse — Traits (`/traits`)

> **What's already good:** Best-in-class content — full-supply type cards with floors, subtypes with "View in Gallery", ultra-rare combo callouts, population distribution chart, 16-category value board; uses ultrawide width well; sampling honesty with "~" prefixes and a written rationale.

### Wrong
- **medium** — Visiting Traits **silently kicks off loading ALL 20,000 tokens** (~500 sequential pages over ~100s) with O(n²) trait re-extraction per page → sustained jank and the exact API pressure that previously tripped the Upstash limiter; leaving the tab doesn't stop it ([code-read] `TraitExplorer.jsx:379-381`). Add a precomputed trait-summary path (rarity.json exists) or a cancelable "Load all (may take a minute)" affordance.
- **medium** — "Rarest First" category sort compares each category's **most-common** value, not its rarest (`values[0]` is count-DESC sorted) → orders "most evenly distributed first" ([code-read] `TraitExplorer.jsx:490-495`).
- **low** — Search placeholder renders the **literal text "…"** to users (JSX attribute string doesn't process the JS unicode escape) ([code-read] `TraitExplorer.jsx:716`).

### Polish
- **low** — Trait value rows / detail-grid items are mouse-only (no role/tabIndex/keydown) while FilterSidebar rows have the full pattern ([code-read] `code:naka-browse #24`).

---

## Market — Deals (`/deals`)

> **What's already good:** Genuinely live — progressive "Scanning X/20,000" counter, real-time stat refinement, instant filters (price/discount/trait/rank), 12s slow-upstream notice instead of an infinite spinner.

### Wrong
- **medium** — "Fair Value"/"Total Savings" is **gameable by a single outlier ask** — trait floors built from the two lowest asks, so one 100 ETH rare-trait listing makes every same-trait token a "90%+ deal"; live this produced "95% below, fair value 18 ETH, TOTAL SAVINGS 20.13 ETH" on a 0.104-floor collection ([verified] `code:naka-market #14`, `live:naka-market #17`). Require ≥3 listings/trait, cap at ~5× floor (valuation.js already caps), blend sales; relabel the column "Trait floor" not "Fair Value".

### Needs improvement
- **low** — Rank values silently shift while the scan runs (#434: #910→#982→#994) with no "~"/approximate marker in the table ([live] `live:naka-market #28`).

### Missing vs objective
- **low** — No per-row deep links / share / CSV export (the CSV helper exists, only wired to MyCollection); no last-sale / price-history column (sales-history API exists) ([code-read] `code:naka-market #38`).
- **low** — Scanner canvases (ScatterPlot, DepthChart) are mouse-only — no keyboard/SR path or data-table alternative ([code-read] `code:naka-market #30`).

### Polish
- **polish** — "N new deals — Click to refresh view" badge **refreshes nothing** (table is already reactive); it only scrolls to top ([code-read] `Deals.jsx:800-806`).

---

## Market — Sweep / Cart / Sniper

> **What's already good:** `lib/orderValidator.js` 3-layer validation (expiry → batched RPC status/ownership/approval → staticCall simulation) and ShoppingCart actually uses it, auto-removing invalid items; sweep math verified by hand (0.5 ETH budget → 4 items, 0.4193 total); per-item venue badges; price re-verify per item before each buy.

### Wrong
- **critical** — **Seaport `cancel()` ABI encodes `totalOriginalConsiderationItems` into the counter slot** in four copies (`api-offers.js:668`, `BidManager.jsx:279`, `MyListings.jsx:353`, `OrderBookPanel.jsx:66`) → cancels a phantom order; the tx mines (gas burned, "cancelled successfully" toast, row optimistically removed) but the real listing/bid stays 100% fillable and reappears on the next 30s refresh. The correct `uint256 counter` + live `getCounter()` template already exists in `trades.js:955-972` ([code-read] `code:naka-market #0`). **Every Cancel button is a silent gas-burning no-op.**
- **high** — RaritySniper "+ Cart" adds **raw listing objects with no id/name/image** → items render blank, dedupe collides on `undefined` (a second add no-ops, remove wipes all sniper items), and the sweep **always skips them** as "no longer listed" — sniper-added items are unbuyable by construction ([code-read] `code:naka-market #3`, `RaritySniper.jsx:333`).
- **high** — RaritySniper is **permanently empty**: "0/0 opportunities — No Nakamigos listings available" while 778-786 live listings exist; Refresh changes nothing; reproduced at HEAD ([verified] `live:naka-market #2`, `viewport:mobile-naka #10`). It only ingests NEW listing events post-load instead of seeding from the existing snapshot the Floor page already has.
- **medium** — SweepCalculator gas estimate **hardcodes 30 gwei** (`estimateGas` never called with a live price) → "EST. GAS" is ~30-300× too high at current sub-gwei basefees; ShoppingCart's fallback uses the same stale constant ([code-read] `SweepCalculator.jsx:13-16`).

### Needs improvement
- **medium** — Sweeps are **N sequential wallet transactions** — no Seaport `fulfillAvailableAdvancedOrders` (already allowlisted) and no reuse of the existing EIP-5792 `tryAtomicBatch` helper; the single biggest UX/gas gap vs Blur/Gem ([code-read] `code:naka-market #12`).
- **medium** — Pre-flight validation is inconsistent: cart runs 3 layers, but **sweep and deals buys don't** — stale listings reach the wallet and revert mid-sweep (SweepCalculator stops the whole sweep on first failure) ([code-read] `code:naka-market #18`).
- **medium** — Snipe score saturates at 999 and is dominated by price index near the floor → ordering is barely rarity-driven where it matters ([code-read] `code:naka-market #15`).

### Missing vs objective
- **low** — No USD/fee/gas breakdown in the cart (sweep panel shows gas, cart doesn't — inconsistent); no pending-sweep persistence/resume across reloads ([live] `live:naka-market #26`; [code-read] `code:naka-market #39`).

### Polish
- **polish** — ShoppingCart/SweepCalculator hover styling via `onMouseEnter` style mutation instead of CSS classes (no touch/focus-visible/reduced-motion parity) ([code-read] `code:naka-market #34`).

---

## Market — Offers / Bids / My-Listings / Bundle

### Wrong
- **high** — **Bundle listing is a fake flow**: `await setTimeout(600)` then "Bundle listing submitted!" toast — no wallet interaction, no Seaport order, no API call, but the modal shows price/duration/fee/"You Receive". Directly contradicts the honesty-pass mandate ([code-read] `BundleListing.jsx:108-122`).
- **high** — Rejecting the **post-success backend-notify signature** makes a CONFIRMED on-chain trade/purchase report as "cancelled"; ShoppingCart then keeps the now-OWNED item and `recordTransaction` is skipped ([code-read] `trades.js:602,889`, `orderbook.js:178`).
- **medium** — `MakeOfferModal`: typing **exponential notation ("1e-8")** into the price crashes the render via `BigInt()` (type=number accepts "e") ([code-read] `MakeOfferModal.jsx:290-292`).
- **medium** — BulkListingWizard "Trait Floor" pricing is **dead code** (`attr.traitFloor` never populated) → silently prices everything at collection floor — rare NFTs listed at floor with no warning ([code-read] `BulkListingWizard.jsx:138,501`).
- **medium** — BulkListingWizard ladder mode gives the **rarest NFT the START price** — with the placeholder example (0.10→0.50) the rarest item lists cheapest (inverted) ([code-read] `BulkListingWizard.jsx:148-152`).
- **medium** — Collection/trait offer prices likely show the offer's **TOTAL value, not per-item** (quantity is fetched but never divided by) — feeds the nonsense order-book bid side above ([code-read] `code:naka-market #9`; [verified] via `live:naka-market #0`).
- **medium** — BidManager Received-Offers: **expired/cancelled/finalized offers not filtered** → live Accept buttons on dead offers (OfferPanel filters correctly; BidManager doesn't) ([code-read] `BidManager.jsx:368-375`).
- **medium** — `DepthChart.jsx` bid-side cumulative depth **accumulates ascending** (inverted curve) — contradicts the correctly-reversed `OrderBookPanel` chart on the same page ([code-read] `DepthChart.jsx:28-31`).
- **low** — OrderBookPanel "Save 0.5% vs OpenSea" badge built on an assumed ~0.5% royalty; stale "vs OpenSea 2.5%" comment in `orderbook.js:227` ([code-read] `code:naka-market #19/#20`).
- **low** — TransactionHistory empty-state promises "offers and bids" but only `type:"buy"` is ever recorded; Board tab shows inbox/outbox copy instead of board copy ([code-read] `code:naka-market #21/#22`).
- **low** — BidManager "Counter" doesn't counter — it just opens the token modal (TradesPanel has a real prefilled counter flow) ([code-read] `BidManager.jsx:474-478`).
- **polish** — MyListings prints floor-distance twice per row in two formats (toFixed(1) vs Math.round) that can disagree ([code-read] `MyListings.jsx:603-616`).
- **polish** — `var(--border)` used as a card **background** token in BidManager/TransactionHistory ([code-read] `code:naka-market #33`).

### Needs improvement
- **medium** — BidManager Received-Offers polling storm: **~21 OpenSea proxy calls every 30s**, bypassing the React Query 2-min staleTime policy ([code-read] `BidManager.jsx:355-432`).
- **medium** — Wallet inventory **silently truncated at 100 NFTs** (no pagination) across every trade/list surface — a 150-NFT whale can't list 50 of their tokens, no notice ([code-read] `code:naka-market #17`).
- **low** — BidManager "My Bids" fetch is unpaginated (default page size) while `fetchMyOffers` paginates to 500 ([code-read] `BidManager.jsx:336-341`).
- **low** — MyListings "Cancel All" signs one backend message per listing after the single `incrementCounter` tx → N surprise wallet popups; a mid-loop rejection leaves the DB half-synced ([code-read] `MyListings.jsx:430-451`).
- **low** — BulkListingWizard = 2 wallet prompts per NFT with no upfront warning; Escape closes the progress UI mid-flight ([code-read] `BulkListingWizard.jsx:538-539`).

### Missing vs objective
- **low** — No USD anywhere on money surfaces (`priceUsd` stubbed null); no net-proceeds preview on accept; no ENS resolution + identity preview in the trade counterparty field (lookalike-scam vector); no incoming-trade badge in global nav ([code-read] `code:naka-market #35/#36/#37`).

### Polish
- **low** — `TransactionProgress` (polished tx stepper) wired into **only 1 of 5 buy surfaces**; speed-up failures silent; APPROVE step never shows an active state; pending phase is cosmetic (fulfill helpers `tx.wait()` before returning) ([code-read] `code:naka-market #28`).
- **low** — CollectionOffersPanel fixed 2-col grid has no mobile breakpoint (~150px columns at iPhone width) ([code-read] `CollectionOffersPanel.jsx:77`).

---

## Market — Trade / P2P Trades / Portfolio gates

> **What's already good:** `trades.js` is the strongest file on the surface — full pre-flight battery (chain guard, Seaport getOrderStatus, LIVE `ownerOf` re-check, EIP-5792 atomic batching, 4001 rethrow); `/trades` 404 and `/portfolio` P&L TDZ crash are both **fixed in prod**; TradeWindow ships a lopsided-trade warning + capped valuation + proper modal a11y.

### Wrong
- **high** — Analytics and Portfolio **deep links render the Floor tab** instead of their own tab (Floor highlighted, "778 currently listed" headline) — while `/trades` deep-links correctly ([live] `viewport:tablet-desktop #2`). Distinct from the Lite-mode redirect below.
- **medium** — Deep links to the 9 Lite-hidden tabs (deals/analytics/portfolio/sniper/trade/watchlist/bids/my-listings/alerts) **silently dump Lite-mode users on Floor with zero explanation** ([code-read + live] `viewport:mobile-naka #4`, `App.jsx:316`). A shared `/sniper` link looks broken. Show a Pro-upsell toast/gate instead of a silent replace.

### Needs improvement
- **medium** — "Trade" and "P2P Trades" coexist as near-duplicate connect-gated tabs with no preview of the flow ([verified] `live:naka-market #15`, `viewport:mobile-naka #16`). Differentiate ("Swap NFTs" vs "Trade Offers") and show a read-only mock behind the gate.

### Missing vs objective
- **medium** — No public collection bid book for logged-out users (`/bids` is purely a connect gate, though the COLLECTION OFFERS ladder data exists) ([live] `live:naka-market #16`).
- **low** — Six connect-gates share one visual with no "demo/preview" affordance ([live] `live:naka-market #23`).
- **low** — Trade counterparty field accepts only raw 0x (no ENS) despite `useEns` in the bundle ([code-read] `TradeWindow.jsx:289-301`).

---

## Analytics / Whales / Holder / Depth / Rarity-Scatter / Comparable-Sales

> **What's already good:** Every lazy sub-panel wrapped in ErrorBoundary + Suspense with staggered skeletons; consistently honest about partial data; Whale Intelligence has real substance (top-25 holders, concentration bars Top10 16.6%, live alerts, polished holder profile drawer); RarityPriceScatter builds its tooltip with DOM APIs to kill innerHTML XSS, is dpr-aware, offers Pearson correlation + click-through.

### Wrong
- **high** — Trait/rarity analytics computed from only **40 of 20,000 tokens** — "Rarest Traits" grid shows 16 traits all count=1, "2.5%*"; meanwhile the Deals page on the same visit scanned 3,600+ tokens ([live] `live:naka-market #4`). Share the Deals scan cache or precompute server-side.
- **high** — "Rarity vs Price" scatter **never renders** ("Need at least 3 listed items with rarity data") despite 786 active listings — the listings↔rarity join is missing ([live] `live:naka-market #5`).
- **medium** — "Recent Sales" / "24H VOLUME" math **counts live listing/bid prices as sales** once the OpenSea stream connects (`activities` is merged listings+sales+bids, all carry price>0) → above-floor listings inflate volume ([code-read] `code:naka-analytics-social #8`). ActivityFeed already filters `type==="sale"`.
- **medium** — Trend labels **contradict their own numbers**: "Whales are ACCUMULATING" at Net +0; "Accumulation phase ▲" at 1.0:1 buyers/sellers — invents a bullish signal from zero data ([live] `live:naka-market #6`). Add a NEUTRAL/"Balanced flow" state.
- **medium** — Floor Depth chart renders an essentially **blank box**; FLOOR card shows bare "1h: %"/"7d: %" glyphs and an implausible "24h ↓35.0%" while the floor sat at ~0.1045 all session ([live] `live:naka-market #12`).
- **medium** — `RarityPriceScatter` "Reset Zoom" button **reads a ref during render** — zooming mutates the ref without setState, so the button never appears when you zoom ([code-read] `RarityPriceScatter.jsx:746`).
- **low** — Top Holder Distribution histogram buckets are misleading (top-100 only, so 1/2-5/6-10/11-25 rows are always 0) under a full-collection title ([live] `live:naka-market #22`).
- **low** — "Diamond Hands" badge granted for **whale-count alone** (no hold-duration); health "never sold" only looks at the last ~50 events ([code-read] `OnChainProfile.jsx:496`, `CollectionHealth.jsx:262-269`).
- **low** — ActivityFeed: live stream events render as **uncolored grey "listing"/"cancellation" chips** — `EVENT_LABELS` expects "ask" but the stream emits "listing" (same gap in OnChainProfile/WhaleIntelligence) ([code-read] `ActivityFeed.jsx:8-23`).
- **low** — `useActivityWebSocket` advances the block cursor **before** the logs fetch succeeds → a failed `eth_getLogs` permanently skips that range's transfers ([code-read] `useActivityWebSocket.js:126`).
- **polish** — UNIQUE HOLDERS sparkline is **synthetic** (`base += sales*0.1`) presented as a trend ([code-read] `CollectionHealth.jsx:282-292`).

### Needs improvement
- **medium** — `WhaleIntelligence`/`OnChainProfile` resolve ENS against a **hardcoded llamarpc endpoint** (bypassing failover), don't cache misses (re-resolve ~45/cycle every 30s), and use a cache format that `useEns` prunes away ([code-read] `code:naka-analytics-social #14`).
- **medium** — Three always-on 30s pollers ignore `document.hidden` and duplicate the stats fetch; WhaleIntelligence additionally re-pulls the **entire owner set** every 30s ([code-read] `code:naka-analytics-social #15`).

### Missing vs objective
- **medium** — No real historical series — holder-count trend is synthetic, floor change uses sale-price proxies from a 50-event window; no USD in P&L per-token rows / analytics panels; no P&L CSV export (Analytics has one); canvas charts have no accessible alternative or pinch-zoom on touch ([code-read] missing-list).

### Polish
- **low** — Hardcoded fallback whale data shows with no "example data" banner (ActivityFeed has one) ([code-read] `code:naka-analytics-social #27`).
- **low** — Holder profile drawer: Escape doesn't close it; expanded holder grid lazy-loads many blank cells before images arrive ([live] `live:naka-market #20`).

---

## Portfolio / P&L (`/portfolio`)

> **What's already good:** The 2026-06-11 P&L crash is fixed (`useTOWELIPriceOptional() ?? {}`); page loads with zero console errors.

### Wrong
- **medium** — "GAS SPENT" is a **hardcoded 0.003 ETH-per-token fiction** charged to every held token including mints/airdrops — ~10-30× off at current gas, rendered as a primary red stat with no "est." qualifier ([code-read] `lib/portfolio.js:175,188`).
- **medium** — Realized P&L FIFO matching can **pair a sale with a buy that happened after it**; sells without a matched buy count full proceeds as profit; `saleToEth` assumes 18-decimals (a USDC sale is wildly wrong) ([code-read] `lib/portfolio.js:216-229`).
- **low** — Top gainers/losers overlap when <6 tokens have cost basis — a positive-P&L token can render "+12%" under the red TOP LOSERS header ([code-read] `PortfolioTracker.jsx:204-210`).
- **low** — "Refresh" is a no-op for up to 5 min — `calculatePnL` serves its localStorage cache including a stale floor price ([code-read] `lib/portfolio.js:122-124`).
- **low** — API outage renders as a confident "this wallet holds 0 NFTs" (the `error` field is ignored by OnChainProfile/WhaleIntelligence/PortfolioTracker) ([code-read] `code:naka-analytics-social #13`).

---

## Social — Chat / DMs / Notifications / Alerts / Watchlist / Favorites / Profile

> **What's already good:** DirectMessages is a strong surface (optimistic sends + retry, day separators, read receipts, block list, impersonation warning when a peer has no shared trade history); chat sanitizes input via DOMParser with spam patterns + send cooldown; the supabase-proxy server layer is hardened well (JWT verify, jti revocation fail-closed, per-table schema validation); Favorites loop is flawless client-side; Alert Settings is a real per-collection feature (floor/underpriced/whale/volume/listing-rate/cooldown/quiet-hours).

### Wrong
- **critical** — **Chat posting writes with the anon-key client that the JWT-gated RLS policy rejects → sending fails for everyone in live mode.** `sendMessage` does a direct anon insert; migration 004 requires `author = jwt->>'wallet'` which the anon JWT has no claim for → INSERT rejected → user always sees "Failed to send message." The proxy is ready (`ALLOWED_TABLES` includes "messages") but CommunityChat was never migrated and has no SIWE sign-in affordance ([code-read] `code:naka-analytics-social #0`, `CommunityChat.jsx:516-522`, `supabase.js:216-218`).
- **high** — Like button is a **silent no-op** in live mode (`toggle_like` RPC requires a JWT wallet claim the anon client can't supply; no else-branch/toast) ([code-read] `supabase.js:255-257`).
- **high** — `toggle_reaction` RPC has **no JWT ownership check** — anyone with the public anon key can add/remove reactions as ANY wallet (it's simultaneously the only chat write that works AND spoofable) ([code-read] migration `007:119-149`, `008:20`).
- **high** — Entire **userdata cloud-sync layer is dead in production** — all writes (and, since migration 004, favorites/watchlist reads) go through the anon client RLS rejects → everything silently degrades to this-browser-only localStorage; the header comment "persistence across devices" is false at runtime ([code-read] `code:naka-analytics-social #3`).
- **high** — `EditProfile` fires **"Profile saved" success toast even when the cloud write was rejected** (`saveProfile` returns false without throwing, so the catch never runs) ([code-read] `EditProfile.jsx:92-97`).
- **high** — `NftCompare` still uses the legacy `userdata.createTradeOffer` path migration 007 revoked → trades become **localStorage ghosts the counterparty never sees** ([code-read] `NftCompare.jsx:8,424,457`).
- **high** — DM polling consumes **18 of the proxy's 20 req/min wallet budget**; the first 429 is then misclassified as "DMs aren't enabled yet — migration 007 hasn't been switched on" (wrong message for rate limiting) ([code-read] `code:naka-analytics-social #6`).
- **medium** — DM "Sign in" button produces an **unhandled promise rejection** when the user rejects the wallet signature (no try/catch; `signIn` throws on 4001) ([code-read] `DirectMessages.jsx:341-344`).
- **medium** — ActivityFeed not chronologically ordered when live events are present (two merge points skip sorting) ([code-read] `code:naka-analytics-social #9`).
- **medium** — `usePriceAlerts` instantiated **twice** (App level + inside the panel) → duplicate 30s pollers and duplicate alert toasts/notifications; `useSmartAlerts` adds a third stats poller ([code-read] `App.jsx:566` + `PriceAlerts.jsx:415`).
- **low** — "Normal rate" alert setting is **dead** — the engine ignores `config.listingRate.normalRate` ([code-read] `NotificationCenter.jsx:111` vs `useSmartAlerts.js:293`).
- **low** — Supabase votes are global across collections while the local fallback is slug-scoped (voting in one collection merges with another; writes are RLS-dead anyway) ([code-read] `userdata.js:325-327`).
- **low** — `useSiweAuth` `isAuthenticated` never flips when the token expires while the page stays open ([code-read] `useSiweAuth.js:139-142`).
- **low** — Quiet hours **drop alerts entirely** (return before the history append) → events are unrecoverable, not just silenced ([code-read] `useSmartAlerts.js:129-130`).

### Needs improvement
- **medium** — Disconnected chat is a **dead room**: "Be the first to start a conversation", "1 online", ~300px message panel on a 1308px viewport with 60% empty space below; Alpha/Discussion filters also empty ([live] `live:naka-social #13`). Inject live marketplace events as system messages, show total members, let the panel flex.
- **medium** — Watchlist remote upsert fires on **every keystroke** of note/target (no debounce); watched items outside the loaded token set vanish with no "not yet loaded" hint (Favorites has one) ([code-read] `code:naka-analytics-social #16`).
- **low** — Profile drawer (`OnChainProfile`) lacks Escape-close/focus-trap/scroll-lock and renders raw unformatted price (EditProfile has the full pattern) ([code-read] `code:naka-analytics-social #25`).
- **low** — New-DM input accepts only raw 0x — no ENS resolution despite `useEns` loaded in the same component ([code-read] `DirectMessages.jsx:389/398`).

### Missing vs objective
- **medium** — No watchlist feature reachable from cards/modal (searched More menu, header, modal — no watch/star control); `nakamigos_price_alerts:[]` exists in localStorage but no UI adds a per-token alert ([live] `live:naka-social #14`).
- **medium** — Smart alerts only fire **while the tab is open** (client 30s polling); the push_subscriptions + VAPID infra exists but only trade alerts use it — no server-side floor/outbid pushes ([code-read] missing-list). Watchlist target prices don't actually alert (copy says "set price alerts").
- **low** — Chat history caps at 100 with no "load older"; DMs poll at 15s with no realtime channel/typing indicator; no ENS-name input resolution or avatars in chat ([code-read] missing-list).

### Polish
- **low** — Per-collection onboarding tour **re-fires identically for every collection** (3 tours in one session); 4 of 5 steps are centered modals that don't anchor to the feature — corroborated by code: 4 of 5 tour selectors don't exist anywhere, so the spotlight machinery never runs ([verified] `live:naka-social #11/#12`, `code:naka-shell #7`).
- **low** — NotificationCenter empty-state microcopy "No notifications in price"/"in whale" is awkward ([live] `live:naka-social #24`).
- **low** — Favorites empty state has good copy but no "Browse Gallery" CTA (made worse by the broken Gallery nav); rank badge "#17/20,000" on cards reads like a token number ([live] `live:naka-social #25/#26`).
- **polish** — PriceAlerts uses bare `new Notification()` (throws on Android Chrome) while the SW-based `sendLocalNotification` helper exists ([code-read] `PriceAlerts.jsx:148`).
- **polish** — ActivityFeed rows keyed by array index (defeats reconciliation, replays entrance animations on prepend) ([code-read] `code:naka-analytics-social #32`).

---

## Misc UX — Theater / Keyboard Help / Share Card / Sound / Modals / Toasts

> **What's already good:** `lib/scrollLock.js` is a correct ref-counted lock (Modal/WalletModal/KeyboardHelp use it properly); `lib/csv.js` has formula-injection protection + UTF-8 BOM; `lib/errorMessages.js` is a comprehensive Seaport/ethers map with hex/url scrubbing; KeyboardHelp has proper dialog semantics + focus trap; useSound is a single App-owned AudioContext with mute persisted; ShareCard preview is polished (image, rank badge, rarity score, trait chips).

### Wrong
- **high** — **Escape closes the WRONG modal in every stacked-overlay combination** (Theater/Share/Wallet mount as siblings while the NFT Modal stays mounted; Modal's older document listener runs first, stops propagation, closes the BOTTOM modal); and because `onClose` is an unstable inline arrow, the listener re-registers on any state change, flipping order so one Escape can close BOTH layers ([code-read] `code:naka-ux-misc #0`, `Modal.jsx:162-195`). Live corroboration: from fullscreen view, first Escape closes the underlying modal and orphans the fullscreen viewer ([verified] `live:naka-browse #10`).
- **high** — Theater/ShareCard **bypass the ref-counted scrollLock** (write `body.style.overflow` directly) → body scrolls behind the still-open NFT modal and the lock count desyncs (also BulkListingWizard/BundleListing) ([code-read] `code:naka-ux-misc #1`).
- **medium** — Both shortcut listings shown to users (`KeyboardHelp.jsx:10` "1–9, 0"; `About.jsx:347-355` "1-7", "F Go to Floor", "T Go to Traits") are **wrong vs the actual handler** (tabs are only 1-6; F toggles favorite; there is no T) ([code-read] `code:naka-ux-misc #4`).
- **medium** — Unscoped selectors in `nakamigos/App.css` (eagerly bundled via `main.tsx`) **leak into the entire main app**: a `min-height:44px` rule forces 44px boxes on every main-app control on mobile, `details summary marker` hidden app-wide, `*:focus-visible` uses a var only defined on `.nakamigos-app` (degrades outside it), reduced-motion `.splash-screen{display:none}` + `main{padding-bottom:68px}` apply app-wide ([code-read] `code:naka-ux-misc #5`).
- **medium** — Mobile bottom nav (z 9997-9999) **floats above the NFT/Wallet modal overlay (z 1000)** and stays tappable — tapping a nav tab switches tabs underneath the open modal ([code-read] `code:naka-ux-misc #3`).
- **medium** — Modal's unstable `onClose` dep **yanks keyboard focus back to the close button on every app re-render** (toast/poll/alert) — a user who tabbed to "Make Offer" gets snapped back to ✕ ([code-read] `code:naka-ux-misc #6`).
- **medium** — Global shortcuts still fire under Theater mode — pressing F double-toggles the favorite (net no-op); digits 1-6/g switch tabs underneath the open theater ([code-read] `code:naka-ux-misc #7`).
- **low** — ShareCard tweet intent contains **no link back to the app** and the generated PNG is download-only (no Web Share, no copy-image); the collection-name header has no `maxWidth` so long names overflow the 1200×630 canvas ([code-read] `code:naka-ux-misc #11/#12`).
- **low** — ShareCard footer prints "`<slug>.gallery`" (e.g. "nakamigos.gallery") — a domain the project doesn't own — instead of the real share URL; About says "~9,697" while constants say 9696 ([verified] `code:naka-ux-misc #13`, `live:naka-social #17`).
- **low** — Focus traps include disabled buttons → the Tab cycle can no-op at the edges (while buying, the disabled Buy button can be first/last) ([code-read] `code:naka-ux-misc #15`).
- **low** — `csv.js` doesn't quote bare-CR/CRLF values; heterogeneous-key rows silently lose columns ([code-read] `code:naka-ux-misc #16`).

### Needs improvement
- **medium** — Theater mode has **zero mobile adaptation** — fixed 300px trait sidebar + `paddingRight` crush the image to ~75px on a 375px iPhone; HUD padding is desktop-sized ([code-read] `code:naka-ux-misc #2`).
- **medium** — Theater overlay has no dialog semantics, no focus management, no focus trap; Tab walks the page behind it ([code-read] `code:naka-ux-misc #8`).
- **low** — Three different rank-tier semantics across Modal (top 25%) / ShareCard (top 0.5%/2.5%) / Theater (any rank ≤ supply) — same NFT reads "special" on one surface, plain on another ([code-read] `code:naka-ux-misc #24`).
- **low** — WalletModal: JS-driven hover styles stick on touch; "terms of use" links nowhere; unknown connectors get an empty description row ([code-read] `code:naka-ux-misc #21`).
- **low** — Scroll lock causes ~15px scrollbar layout shift on Windows and is unreliable on iOS Safari <16 (no `position:fixed` fallback) ([code-read] `code:naka-ux-misc #23`).
- **low** — Programmatic alert sounds may be silent until the next user gesture (AudioContext resume is fire-and-forget) ([code-read] `code:naka-ux-misc #22`).

### Missing vs objective
- **medium** — Theater: no zoom/pan, no prev/next navigation between NFTs (j/k dead there), no download button, no Fullscreen API — OpenSea/Blur lightboxes have all four ([code-read] missing-list).
- **low** — ShareCard: no Web Share with file attach, no copy-image-to-clipboard, no Farcaster/Lens targets, single fixed 1200×630 layout; no light theme and no print stylesheet anywhere in the surface ([code-read] missing-list).
- **low** — Sound is binary mute only (no volume, no distinct offer-received sound); keyboard has no arrow-grid nav (j/k is linear) and no "b" buy shortcut ([code-read] missing-list).

### Polish
- **polish** — Reduced-motion blanket freezes spinners into a static arc (reads as hung); KeyboardHelp panel can overflow short landscape viewports (no max-height); toasts overlap the mobile bottom nav; dead empty CSS blocks + a doubly-defined `.activity-filter-btn.active` ([code-read] `code:naka-ux-misc #25/#26`).
- **polish** — Theme cycler is mystery-meat (cycles default→midnight→gold with only a hover title; aria-label never updates) ([live] `live:naka-social #20`, `live:naka-browse #19`).
- **polish** — Fullscreen art viewer bottom bar duplicates the token id ("Nakamigos #18156  #18156") ([live] `live:naka-browse #18`, `live:naka-market #24`).
- **polish** — Notifications popover anchors far left of the bell (hovers over the sales ticker) ([live] `live:naka-browse #20`).
- **polish** — Dotted separator line above the footer reads as a debug border on every tab ([live] `live:naka-social #23`).

---

## The 3 Collections (nakamigos / gnssart / junglebay)

> **What's already good:** Per-collection data integrity is strong — JB (5,555 / 0.0886 / ape traits / 0xd372 contract / JB sales ticker) and GNSS (9,697 / 0.0289 / generative traits / 0xa1De contract) show no Nakamigos bleed in grids/tickers/traits/footers; the collection switcher fully rebinds everything; About pages are best-in-class content (JB rug-to-riches timeline + 20 legendary 1/1 cards with working Find-in-Gallery; GNSS species encyclopedia with inline-expanding cards).

### Wrong
- **medium** — Activity feed serving **cached example data in prod** ("Showing cached example data — live API unavailable") with duplicated rows (#16971/#8949/#4228 each twice) — banner honesty is good but the live pulse is down ([live] `viewport:mobile-naka #9`).
- **low** — JB "Rug-to-Riches" timeline is **out of chronological order** ("May 2022 — Otherside" above "Nov 2021 — Sandbox") and embeds a hardcoded "0.98% of supply listed" stat under a "Present" label ([verified] `live:naka-social #16`, `code:naka-browse #18`).
- **low** — GNSS "View in Gallery" species deep-link navigates with a `?species=` param **nothing reads** → lands on the unfiltered gallery (JB/CharacterType use the correct `onFilterGallery` callback) ([code-read] `SpeciesEncyclopedia.jsx:327-329`).
- **low** — `Card.jsx` ignores `rankApproximate` (shows the badge unconditionally) while VirtualCard/Hero gate it → gnssart/junglebay favorites show unreliable ranks as authoritative ([code-read] `Card.jsx:44`).

### Polish
- **polish** — GNSS species encyclopedia shows "Supply TBD" on 8 species (Cipr/Duqe/Genj/Naion/Que/Soco/Yami/Zuur) though the collection is fully minted ([live] `live:naka-social #27`).

---

## 404 / Error / Empty States

> **What's already good:** 404 handling exists for both bad tabs and bad collections with correct titles and a working "Back to Home"; honest data-status banners and three distinct ActivityFeed empty states.

### Wrong
- **low** — `/:collection/nft/:id` and `?token=` deep links to an **unloaded token open a bare placeholder modal** (no image/attributes) — the `?token=` handler fetches but the `/nft/:id` path doesn't ([code-read] `App.jsx:330-338`).

### Needs improvement
- **low** — 404 costs a full splash and offers only "Back to Home"; bad-collection URLs show a generic 404 that doesn't name the collection or list the 3 valid ones ([live] `live:naka-social #19`).

### Missing vs objective
- **low** — No `<a>` hrefs on nav tabs (they're `<button>`) → middle-click / open-in-new-tab fails everywhere; no offline/`navigator.onLine` banner ([live] `live:naka-social #28`; [code-read] missing-list).

---

## Responsive (iPhone 390 / iPad 820 / desktop 1440 / ultrawide 3432)

> **What's already good:** Zero horizontal overflow on every route at 390/820/1440 (`scrollWidth === innerWidth` measured everywhere); tap targets meet 44px on mobile; the bottom MobileNav is genuinely good (5 tabs + 3-col More sheet); Filters drawer + stat-tile pages reflow cleanly at 390px; 1440 is the design sweet spot. **No horizontal-overflow routes were found at any breakpoint.**

### iPhone 390
- **critical** — Modal artwork never displays + broken image geometry (`.modal-image-side max-height:280px !important` vs square wrap) — see NFT Detail Modal ([live] `viewport:mobile-naka #0`).
- **high** — "Make Offer" clipped off the right edge in the modal buy row ([live] `viewport:mobile-naka #1`).
- **high** — Buy-grid cards render as letter placeholders below the fold ([live] `viewport:mobile-naka #2`).
- **high** — 4-column gallery grid at 390px → unreadable names/traits, cropped art ([live] `viewport:mobile-naka #6`).
- **medium** — Listing card titles ellipsize away the token number ([live] `viewport:mobile-naka #7`).
- **medium** — Whales: right-edge text clipping ("4,990 / 20," denominator cut; whale prices truncated) ([live] `viewport:mobile-naka #8`).
- **medium (code)** — Batch-selection bar covered by the bottom nav; CollectionOffersPanel 2-col has no breakpoint ([code-read]).
- **low** — Floating "Back to top" sits 1px from the Gallery tab (mis-tap); Keyboard-Shortcuts section + "CLICK TO ENTER" wording shown on a touch device ([live] `viewport:mobile-naka #15/#14/#13`).
- **polish** — Vertical sales ticker consumes ~250px above the grid and rows look tappable but only highlight; footer card text low-contrast over the collage ([live] `viewport:mobile-naka #19/#17`).

### iPad 820
- **high** — Deep-link enter gate dead on sub-routes — visitor permanently stuck ([live] `viewport:tablet-desktop #0`).
- **high** — At exactly **768px every nav surface is hidden** ([code-read] `code:naka-shell #3`).
- **medium** — 820 gets a **denser grid than desktop** (5 NFT columns at 820 vs 4 at 1440) with sub-44px touch targets — inverted density on a touch context ([live] `viewport:tablet-desktop #7`). Cap at 3-4 columns below ~1024px.

### Desktop 1440
- Clean — the design sweet spot; the ultrawide problems below do not exist at 1440.

### Ultrawide 3432 / 1912 CSS
- **low** — About pages, chat, and the hub **strand 50-60% of the viewport**: About hero is a ~600px left column against an empty right half; chat is a short full-width strip with the bottom half bare; listings end ~1200px with ~700px of dimmed art ([verified] `live:naka-social #22`, `live:naka-browse #16`). Grids and the Traits 3-col board use the width well. Additive: 6-8 grid columns >1600px, dock the order-book open by default, add a right-rail module (recent sales / rarity spotlight) on About + Gallery hero.

---

## Console & Network (systemic)

- **medium** — RPC failover rotation includes endpoints the app **cannot use**: `eth.merkle.io` is blocked by the app's own CSP `connect-src` (up to 209 console errors in ~30s on the portfolio route), `eth.llamarpc.com` fails CORS preflight (no `Access-Control-Allow-Origin`) and returns 521 (origin down), retried on every page/refresh ([verified] all viewport + live agents). Drop/replace both or add merkle.io to connect-src; this also unmasks real errors.
- **medium** — Own `/api/opensea` rate limiter **429s within ~6 page loads in 3 minutes** in one normal session → listings grid dead-ends in an endless "Fetching live listings…" skeleton with no error state; per-NFT best-offer calls ~7% 429 ([verified] `viewport:tablet-desktop #3`, `live:naka-browse #7`). Batch/cache the per-page fan-out (stats requested 3-8× per page) and add a terminal error/retry state.
- **medium** — `collections/{slug}/stats` returns a consistent **400** (request bug, not rate-limit) on every collection — the root cause of "VOLUME —" everywhere (see Hub).
- **low** — `/api/opensea` offers path returns 502/503 on prod → the never-resolving modal OFFERS skeletons.
- **low** — `Press Start 2P` font stylesheet blocked by CSP `style-src` (`fonts.googleapis.com`) on mobile → pixel font silently falls back ([live] `viewport:mobile-naka #12`). Self-host or allowlist.
- **low** — GeckoTerminal price fetch fails from the browser (ERR_FAILED) on /tokenomics + /premium (fallback works); proxy it through the API layer ([live] `viewport:tablet-desktop #11`).
- **good** — Zero JS pageerrors across all 23 routes × 4 passes on mobile and across the full prod live sessions — the error-boundary/latch work is holding.

*Note: main-app (non-Tradermigos) viewport findings (dashboard connect-prompt over camo art, mascot toast overlap, /premium defaulting to the SOON Gold Card tab, low-contrast subtitles) are out of scope for this Nakamigos report but were captured by `viewport:tablet-desktop #6/#9/#10/#8` for the main-app audit.*

---

## TOP 15 PRIORITIES (impact-ranked)

1. **Fix the dead Gallery nav** — clicking Gallery / `g` lands on Floor from every surface; Gallery is unreachable except by typed URL. Add a `parseRoute`-round-trip test (`code:naka-shell #0`, [verified], not fixed at HEAD).
2. **Fix the broken Seaport `cancel()` ABI** in all 4 paths — every Cancel button burns gas and leaves the order live + fillable; copy the `trades.js` counter+`getCounter()` template (`code:naka-market #0`).
3. **Route chat/likes/reactions/userdata writes through the SIWE proxy** — chat send fails for everyone, likes are no-ops, reactions are spoofable, profile/favorites/watchlist sync is dead and falsely toasts success (`code:naka-analytics-social #0/#1/#2/#3/#4`).
4. **Fix the dead deep-link enter gate on iPad/desktop sub-routes** — shared-link visitors are permanently stuck (`viewport:tablet-desktop #0`).
5. **Make the modal show the artwork** — on-demand metadata fetch + instant grid-thumbnail fallback + fix the `max-height` geometry; the single-NFT-evaluation objective fails on prod and HEAD (`live:naka-browse #0`, `viewport:mobile-naka #0`).
6. **Normalize collection-offer prices to per-item** — fixes the "best bid 4.52 vs ask 0.10, -4071% spread = Healthy" order book and the inflated bid wall (`live:naka-market #0`); add a `bestBid>bestAsk ⇒ dirty` invariant.
7. **Fix the `/api/opensea/.../stats` 400 + own-proxy 429s** — VOLUME "—" everywhere, endless listing skeletons with no error state; batch/cache the per-page fan-out (`viewport:tablet-desktop #1/#3`).
8. **Resolve or empty-state the never-resolving modal OFFERS/Comparable-Sales skeletons** (502/503) — they read as broken on the conversion surface (`live:naka-browse #5`, multi-agent).
9. **Make `?token=` deep links survive the splash** + add keyboard/AT entry to the splash — shared token links never open, and keyboard users can't enter at all (`code:naka-shell #1/#2`).
10. **Stop the bundle-listing fake-success + the trade/buy "rejected after on-chain success" bug** — honesty-mandate violations on money surfaces (`code:naka-market #2/#1`).
11. **Seed RaritySniper from the existing listings snapshot** (permanently "0/0 — no listings" while 786 exist) and fix sniper "+Cart" objects so swept items are buyable (`live:naka-market #2`, `code:naka-market #3`).
12. **Consolidate the 3-6 always-on 30s/60s pollers** into one visibility-gated react-query source — the prod Upstash-limiter risk (`code:naka-shell #8`, `code:naka-market #13`, `code:naka-analytics-social #10/#15`).
13. **Fix the gallery infinite-scroll top-jump + frozen 4-column grid** — browsing is broken at scale and unreadable at 390px (`code:naka-browse #0/#1`, `viewport:mobile-naka #6`).
14. **Merge listing prices onto gallery tokens** — fixes the always-null price sort/filter (any price range → empty collection) and gives cards prices for free (`code:naka-browse #2`).
15. **Fix the 768px nav blackout + ErrorBoundary "Go Home" hash-on-BrowserRouter loop + theme-attribute clobber** — three structural shell bugs (`code:naka-shell #3/#4/#6`).

## 10 QUICK WINS (<1h each)

1. Add `flexWrap:'wrap'` + `minWidth:0` to the modal buy row so "Make Offer" stops clipping to "Mak" (`Modal.jsx:417-460`).
2. Drop/demote `eth.llamarpc.com` and `eth.merkle.io` from the RPC transport list (or add merkle.io to CSP `connect-src`) — kills the dominant console noise + dead retries.
3. Self-host or CSP-allowlist the `Press Start 2P` font so the pixel font stops silently falling back (`viewport:mobile-naka #12`).
4. Reverse the BulkListingWizard ladder assignment (or relabel inputs) so the rarest NFT isn't priced cheapest (`BulkListingWizard.jsx:148-152`).
5. Sanitize "e/E" out of the MakeOfferModal price input to stop the `BigInt("1e-8")` render crash (`MakeOfferModal.jsx:290`).
6. Fix the literal "…" placeholder in TraitExplorer search (`{"Search traits or values…"}`) (`TraitExplorer.jsx:716`).
7. Sort the JB "Rug-to-Riches" timeline array chronologically (Nov 2021 before May 2022) (`JungleBayShowcase.jsx:29-39`).
8. Replace ErrorBoundary's user-facing raw stack trace with message-only (gate the stack behind `import.meta.env.DEV`) (`ErrorBoundary.jsx:102-104`).
9. Hide MobileNav while any overlay is open (or raise `.modal-bg` above 9999) so the bottom nav stops floating over modals (`code:naka-ux-misc #3`).
10. Add a NEUTRAL/"Balanced flow" state to whale/buyer-seller trend labels so Net +0 / 1.0:1 stops reading "ACCUMULATING ▲" (`live:naka-market #6`).
