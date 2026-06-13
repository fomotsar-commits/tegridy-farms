# Remediation Plan — g11_naka_browse (Nakamigos browse: gallery / listings / traits / collections + image pipeline)

Branch: `mvp-launch` @ HEAD (`b6fda8b`). All findings opened and confirmed against real source. This surface's bugs cluster around five shared causes:

1. **Sample-vs-supply rarity math** (F566, F573, F617) — trait % divides loaded-sample counts by full supply.
2. **Price never joined onto tokens** (F564, F595, F610, F627, plus F589/F592 fallout) — `normalizeToken` hard-sets `price:null` and listings prices are never merged into gallery tokens, so price sort/filter/badges are all dead.
3. **Search/deep-link only sees loaded pages** (F574, F583, F605, F606, F608, F618) — no fetch-by-id fallback when a token isn't in the loaded window.
4. **Gallery navigation path collision** (F607) — `handleTabChange("gallery")` builds `/:collection/` which `parseRoute` resolves to `listings`.
5. **Dead/duplicated modules drifting** (F581, F590) — `useTradingMutations` + 4 query configs are unreferenced and one calls a missing `queryKeys.traitOffers`.

Each `###` below is one finding, grouped by `batchHint`.

---

## Batch: `naka-rarity-sample-denominator`
**Summary:** Trait rarity % must divide by the loaded-sample size, not full supply, until the whole collection is loaded — exactly the fix TraitExplorer already applies (`api.js`/`TraitExplorer.jsx:397-402`). FilterSidebar was never given it; the gallery sidebar and modal inherit the same skew. One shared correction + a sampled marker closes all three.

### F566 — FilterSidebar trait % divides by full supply → every trait reads "rare" gold
Confirmed `FilterSidebar.jsx:571`: `pct = v.count / totalTokens * 100` where `totalTokens = totalSupply` (`Gallery.jsx:68`) but `v.count` is from loaded pages only → ~0.1-0.4% for all → `rarityColor(pct<5)="var(--gold)"` paints everything gold.
- **verdict:** fix-now · **rootCause:** standalone (shared math bug w/ F573, F617)
- **approach:** Divide by the loaded-token count, not `totalSupply`. Pass a `loadedCount` (tokens.length) prop from `Gallery.jsx` into `FilterSidebar` and compute `pct = v.count / loadedCount * 100`; keep `totalTokens`/supply only for the absolute count column. Prefix the % with `~` when `loadedCount < totalSupply` (mirror `TraitExplorer.jsx:790`'s `isSampled` marker). Do NOT remove the bar/color UI.
- **files:** `src/nakamigos/components/FilterSidebar.jsx:571`, `:587`, `:589`, `:595`; `src/nakamigos/components/Gallery.jsx:68`, `:139`, `:165`
- **effort:** S · **risk:** low
- **test:** Unit: render FilterSidebar with 40 loaded tokens of a 20k collection, assert a trait with count 2 shows `~5%` not `~0%`. Manual: open Nakamigos gallery sidebar before scrolling, confirm traits aren't all gold.
- **deps:** [] · **batchHint:** naka-rarity-sample-denominator

### F573 — TraitExplorer "Rarest First" sorts by each category's MOST COMMON value
Confirmed `TraitExplorer.jsx:490-495`: `aMin = a.values[0]?.pct` but `values` are sorted count-DESC (`:421`), so `values[0]` is the most common value. Result is "most evenly distributed first", not rarest.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Use the minimum pct: `const aMin = Math.min(...a.values.map(v => v.pct))` (or `a.values[a.values.length-1]?.pct` since values are count-sorted). Mirror for `bMin`. One-line comparator fix.
- **files:** `src/nakamigos/components/TraitExplorer.jsx:492-493`
- **effort:** S · **risk:** low
- **test:** Unit: feed two categories where one has a 0.5% value and the other's rarest is 8%; assert the 0.5% category sorts first under `sortBy="rarest"`.
- **deps:** [] · **batchHint:** naka-rarity-sample-denominator

### F617 — Trait counts/percentages from the partial sample read as wrong rarity (live)
Live: sidebar shows "0%" and "17 results of 20,000" for traits whose true incidence is hundreds; modal shows "Flat 32 (80.0%)" from 40/20k. Same root as F566/F573 plus the "X of N" label conflates loaded sample with full supply.
- **verdict:** fix-now · **rootCause:** standalone (umbrella for F566+F573)
- **approach:** Closed by the F566 (sidebar `~%` sampled denominator) and F573 (rarest sort) fixes. Additionally relabel the toolbar count in `Gallery.jsx:122-128` so the filtered count reads "X of N loaded" (not "of 20,000 items") whenever `hasMore`; reuse the existing `hasMore`/`totalSupply` values already in scope. No new component.
- **files:** `src/nakamigos/components/Gallery.jsx:119-128`; (rest via F566/F573)
- **effort:** S · **risk:** low
- **test:** Manual: filter by a rare trait with only ~80 tokens loaded; confirm the count reads "N of X loaded" and the % carries `~`.
- **deps:** [F566, F573] · **batchHint:** naka-rarity-sample-denominator

---

## Batch: `naka-merge-listing-prices`
**Summary:** ONE join fixes a cluster: `normalizeToken` sets `price:null` (`api.js:123`) and listings prices are never merged onto gallery tokens, so the price sort is a no-op, the price-range filter empties the grid, and gallery/listed-only cards show no price. Merge the `listings` prop (already passed to Gallery) into tokens via a Map; the cards already render `nft.price` when non-null.

### F564 — Price sort + price-range filter operate on always-null price
Confirmed: `api.js:123 price:null`; `useNfts.js:153-154` sorts on `(b.price||0)` (all zero); `Gallery.jsx:52-59` returns false for every null-price token, emptying the grid for any price range. `SORT_OPTIONS` (`constants.js:86-87`) still advertises price sorts.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** In `Gallery.jsx`, build `const priceById = useMemo(() => new Map(listings.map(l => [String(l.tokenId||l.id), l.price])))` and merge `price` onto each token in `displayed` (or feed it into `useNfts` so the sort sees real prices). Reuse the existing `listings` prop (already threaded for `listedOnly`). Keep `SORT_OPTIONS` as-is once prices exist.
- **files:** `src/nakamigos/components/Gallery.jsx:37-63`, `:47-50`; `src/nakamigos/hooks/useNfts.js:148-158` (if sort moves into hook); `src/nakamigos/api.js:123`
- **effort:** M · **risk:** med (touches the memoized display pipeline; verify virtualizer keys unaffected)
- **test:** Unit: given tokens + listings, assert merged tokens carry listing price and `price-asc` orders ascending. Manual: set Min 0.1 / Max 0.2 ETH on Nakamigos and confirm listed tokens appear instead of the empty state.
- **deps:** [] · **batchHint:** naka-merge-listing-prices

### F595 — (missing) Listed-price/status badges on gallery cards
Data exists in `listings` but never merged onto tokens (same as F564); VirtualCard/`Card` already render `nft.price`.
- **verdict:** fix-now · **rootCause:** standalone · **dup-of-fix:** F564
- **approach:** Free once F564's price merge lands — `VirtualGalleryGrid.jsx:468` and `Card.jsx:86` already display `formatPrice(nft.price)` when non-null. Optionally add a small "Listed" dot for tokens present in `listedIds`.
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx:467-491` (no change needed beyond data)
- **effort:** S · **risk:** low
- **test:** Manual: gallery cards for listed tokens show an ETH price after the merge.
- **deps:** [F564] · **batchHint:** naka-merge-listing-prices

### F627 — Listed-Only results don't show prices on cards (live)
Live: "Listed Only" + trait filter → cards show traits but no ETH. Same null-price root.
- **verdict:** fix-now · **rootCause:** standalone · **dup-of-fix:** F564
- **approach:** Resolved by F564's merge (listed tokens get a price → card renders it). No extra code.
- **files:** (via F564)
- **effort:** S · **risk:** low
- **test:** Manual: toggle Listed Only, confirm prices render on the 4 result cards.
- **deps:** [F564] · **batchHint:** naka-merge-listing-prices

### F610 — "Rank: Best First" / sort no-ops (live)
Live: rank-asc returns identical order/prices to price-asc; no rank badges. Confirmed `useNfts.js:155` sorts on `a.rank` but ranks are `null` until `computeRarity` runs over enough tokens, and for Nakamigos ranks come from API/`computeRarity` over the small loaded window. The "Rarity: Rarest First" option key is `"rarity"` (`constants.js:85`) which the sort DOES handle — the live "same as price-asc" symptom indicates ranks are absent in the loaded set, not a missing branch.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Two parts: (a) when `sortBy==="rarity"` and no loaded token has a `rank`, show a subtle "rank data loading" affordance in the toolbar instead of silently returning token-id order; reuse the `item-count` slot in `Gallery.jsx:119`. (b) Ensure `computeRarity` rank is surfaced on cards (it already gates on `!nft.rankApproximate`). Do not fabricate ranks.
- **files:** `src/nakamigos/hooks/useNfts.js:155`; `src/nakamigos/components/Gallery.jsx:119-128`
- **effort:** M · **risk:** med (rarity ranking semantics)
- **test:** Manual: pick Rarest First on Nakamigos; confirm either ranked order or an explicit loading hint, never a silent fallback to id order.
- **deps:** [] · **batchHint:** naka-merge-listing-prices

---

## Batch: `naka-fetch-by-id-fallback`
**Summary:** Search and both deep-link paths only see the loaded window. The `?token=` handler already has the canonical fetch-by-id fallback (`App.jsx:303-308` via `fetchTokensByIds`). Reuse that one helper for gallery search, the `/nft/:id` path, and the modal placeholder.

### F574 — Gallery search only matches loaded pages
Confirmed `Gallery.jsx:40-44` filters `tokens` (loaded only); `hasMore && !search` (`:204`) disables loadMore during search, so an unloaded valid id ("15000") shows the empty state.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** When `debouncedSearch` is a numeric id within `totalSupply` and `displayed.length===0`, call `fetchTokensByIds([id], collection.contract, collection.metadataBase)` (same helper as `App.jsx:305`) and surface the result. Add a small "press Enter to open #N" affordance. Keep the existing empty-state art.
- **files:** `src/nakamigos/components/Gallery.jsx:37-63`, `:211-231`; (helper from `src/nakamigos/api.js` `fetchTokensByIds`)
- **effort:** M · **risk:** low
- **test:** Manual: type "15000" on Nakamigos pre-scroll; confirm the token loads instead of "No Results Found".
- **deps:** [] · **batchHint:** naka-fetch-by-id-fallback

### F618 — Gallery search fails for unloaded ids with message-less empty state (live)
Live duplicate of F574: "5000" → "0 results" + ghost skeleton cards, no copy.
- **verdict:** duplicate · **rootCause:** standalone · **duplicate-of:** F574
- **approach:** Closed by F574 (fetch-by-id + real empty-state copy). Also ensure the ghost-skeleton branch (`VirtualGalleryGrid.jsx:150`) isn't shown during an active search with zero matches — see F579 (skip grid when `displayed.length===0`).
- **files:** (via F574 + F579)
- **effort:** S · **risk:** low
- **test:** Manual: search "5000"; confirm no ghost skeletons and a real message/CTA.
- **deps:** [F574, F579] · **batchHint:** naka-fetch-by-id-fallback

### F605 — (missing) Search depth: no trait-value / fetch-by-id search
Confirmed: search matches name/id of loaded tokens only.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Fetch-by-id fallback ships with F574. Trait-value search across loaded tokens is an additive enhancement to the `displayed` filter (`Gallery.jsx:40-44`) — match `n.attributes.some(a => a.value.toLowerCase().includes(q))`. Fuzzy matching is out of scope (defer).
- **files:** `src/nakamigos/components/Gallery.jsx:40-44`
- **effort:** S · **risk:** low
- **test:** Manual: search a trait value (e.g. "Zombie") and confirm matching loaded tokens surface.
- **deps:** [F574] · **batchHint:** naka-fetch-by-id-fallback

### F583 — `/nft/:id` deep link opens a bare placeholder modal for unloaded tokens
Confirmed `App.jsx:335-337`: for unloaded ids it sets `{id, name:'#id', attributes:[], image:null}` with NO `fetchTokensByIds`, unlike the `?token=` handler (`:303-308`).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** In the `/nft/:id` effect, replace the placeholder branch with the same `fetchTokensByIds([deepLinkTokenId], …).then(arr => arr?.[0] && setSelected(arr[0]))` used at `App.jsx:305`. Keep a transient placeholder only as the pre-fetch state.
- **files:** `src/nakamigos/App.jsx:330-338`
- **effort:** S · **risk:** low
- **test:** Manual: open `/nakamigos/nakamigos/nft/15000` fresh; modal shows image + traits, not the `N #id` placeholder.
- **deps:** [] · **batchHint:** naka-fetch-by-id-fallback

### F606 — Detail modal shows no image/traits for un-enriched tokens (live, critical)
Confirmed: `Modal.jsx` renders `nft.attributes`/`NftImage` straight from the prop and only self-fetches sales history (`:55-66`) — it does NOT self-enrich image/traits. So a bare placeholder (from F583, or a `?token=` fetch failure) renders empty. `:589` "No traits available for this token".
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Primary fix is upstream (F583 + F608 fetch-by-id so the modal receives a real token). As defense-in-depth, add a guarded effect in `Modal.jsx`: when `nft` has `image==null` and `attributes.length===0`, call `fetchTokensByIds([nft.id], contract, metadataBase)` and merge the result into local state used for render. Reuse the existing `fetchTokenSalesHistory` effect pattern (`:55`). Do not alter modal layout.
- **files:** `src/nakamigos/components/Modal.jsx:55-66` (add sibling enrich effect), render sites for image/attributes (`:589`); depends on `App.jsx:330-338` (F583)
- **effort:** M · **risk:** med (modal is high-traffic; guard against refetch loops with a ref)
- **test:** Manual on dev: open an un-enriched token via `/nft/:id` and via copied `?token=`; image + traits render within ~1s.
- **deps:** [F583] · **batchHint:** naka-fetch-by-id-fallback

### F608 — `?token=` deep links stripped during splash click-through (live, high)
Confirmed root cause: while `!splashDone` (`App.jsx:161-162`) `CollectionView` is unmounted, so the token-read effect (`:291-309`) never runs during splash. On mount the URL-sync effect (`:280-288`) runs FIRST (declared earlier) and, because `selected` is null, **deletes** `?token` (`:286`) before the read effect at `:291` can read `window.location.search`.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Make the read win the race: have the URL-sync effect (`:280-288`) skip the delete until the token param has been consumed once — guard with the existing `tokenParamHandled` ref (`if (!tokenParamHandled.current && current && !next) return;`). Alternatively initialize `selected` synchronously from `window.location.search` so `next` is non-null on first paint. Per F608's own note, canonicalizing in-app token URLs to the surviving `/nft/:id` form is a valid secondary path but the ref-guard is minimal and additive.
- **files:** `src/nakamigos/App.jsx:280-309`
- **effort:** S · **risk:** med (URL state race — add a test)
- **test:** Manual: hard-load `/nakamigos/nakamigos?token=18156` → click through splash → modal for #18156 opens and URL retains `?token=18156`.
- **deps:** [] · **batchHint:** naka-fetch-by-id-fallback

---

## Batch: `naka-gallery-nav-route`
**Summary:** Single shared bug: the Gallery nav button and the `G` hotkey both call `handleTabChange("gallery")`, which builds `/:collection/` (empty second segment); `parseRoute` then defaults the empty segment to `listings`. Fix the one navigation/route mapping.

### F607 — Gallery nav + 'G' hotkey route to Listings (live, high)
Confirmed: `handleTabChange` (`App.jsx:358`) → `navigate(\`/nakamigos/${slug}/${newTab==="gallery" ? "" : newTab}\`)` → `/nakamigos/nakamigos/`; `parseRoute:91` `const second = segments[1] || "listings"` resolves the empty segment to listings. `case "g"` (`:453`) uses the same `handleTabChange("gallery")`.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Make gallery a real segment instead of empty: change `parseRoute:91` default to `"gallery"` AND keep `handleTabChange` emitting `/:collection/gallery` (drop the `=== "gallery" ? ""` special-case), OR keep empty-path canonical and flip the `parseRoute` default to `"gallery"`. Choose ONE canonical: set `parseRoute` empty/`gallery`→`gallery` and route listings explicitly. Update `navRouting.test.jsx` expectations. (`handleTabChange` is the shared entry both surfaces use, so one change fixes both.)
- **files:** `src/nakamigos/App.jsx:91`, `:353-363`; test `src/nakamigos/__tests__/navRouting.test.jsx` (if present)
- **effort:** S · **risk:** med (route default change affects bare `/:collection` landing → verify it still shows the intended default tab and existing deep links)
- **test:** Unit: `parseRoute('/nakamigos/nakamigos/')` returns `tab:"gallery"`. Manual: click Gallery nav and press `G`; URL → `/gallery`, title "Gallery".
- **deps:** [] · **batchHint:** naka-gallery-nav-route

---

## Batch: `naka-virtualgrid-scroll-columns`
**Summary:** Two structural VirtualGalleryGrid bugs (scroll-to-top on page append; frozen 4-column layout on mobile) plus the unthrottled error-retry loop. All live in the same file/scroll lifecycle.

### F562 — Infinite scroll yanks viewport to top on every page append
Confirmed `VirtualGalleryGrid.jsx:115-122`: `tokensKey = tokens.length + "-" + tokens[0]?.id`. A loadMore append (40→80, same first id) changes the key like a filter change and resets `scrollTop=0`; loadMore fires 5 rows from bottom (`:139-148`) → every page-2+ scroll jumps to top. Reachable on all >1000-supply collections.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Only reset scroll on a genuine filter/sort change, not on append. Have `Gallery.jsx` pass an explicit `resetKey` derived from `activeFilters`+`sortBy`+`debouncedSearch`+`listedOnly`+`priceRange`, and reset `scrollTop` when `resetKey` changes (not `tokensKey`). Minimal: change the effect dep from `tokensKey` to the passed `resetKey`.
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx:114-122`; `src/nakamigos/components/Gallery.jsx:197-208` (pass `resetKey`)
- **effort:** S · **risk:** med (scroll restoration regressions — test both append and filter change)
- **test:** Manual: scroll Nakamigos gallery past page 1; confirm appends keep position. Change a filter; confirm it resets to top.
- **deps:** [] · **batchHint:** naka-virtualgrid-scroll-columns

### F563 — Column count frozen at default 4 (ResizeObserver never attaches on skeleton branch)
Confirmed `VirtualGalleryGrid.jsx:41-46`: on mount `loading=true/tokens=[]` returns the SkeletonGrid branch (`:150-162`) which has no `ref={parentRef}`, so `ro.observe` is skipped; when data arrives the effect deps (`recalc`,`containerRef`) haven't changed, so `columns` stays `useState(4)` (`:30`). On a 390px phone → `repeat(4,1fr)` ~85px cards.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Re-attach the observer when the scroll node appears. Either (a) add `tokens.length>0`/`loading` to the `useColumns` effect deps so it re-runs once the container mounts, or (b) convert `parentRef` to a ref-callback that `recalc()`s + observes on attach. Option (b) is the robust fix. Keep skeleton geometry too (see F623).
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx:29-49`, `:96`, `:183`
- **effort:** S · **risk:** med (virtualizer relies on the same ref — verify it still gets the element)
- **test:** Manual on 390px viewport: gallery renders 1-2 columns, not 4; resize widens columns live.
- **deps:** [] · **batchHint:** naka-virtualgrid-scroll-columns

### F570 — On API failure near bottom, load-more retries unthrottled
Confirmed `VirtualGalleryGrid.jsx:134-136` resets the guard on every `loading` flip; trigger effect (`:139-148`) re-fires because `onLoadMore` identity changes each cycle (`useNfts.js:77-80`); on error `useNfts.js:54-56` leaves `hasMore=true` → load→error→guard reset→re-fire loop, hammering the already-rate-limited proxy.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** On error in `useNfts.load`, suppress auto-retrigger: set a `loadErrorRef`/state and gate `loadMore` (`useNfts.js:77-80`) on it; clear it only when the user clicks the existing error-banner Retry (`Gallery.jsx:189-194`). Keep `hasMore` semantics intact. Optional exponential backoff is secondary.
- **files:** `src/nakamigos/hooks/useNfts.js:54-56`, `:77-80`; `src/nakamigos/components/Gallery.jsx:189-194`
- **effort:** M · **risk:** med (pagination state machine)
- **test:** Unit: simulate `fetchTokens` reject; assert `loadMore` is a no-op until Retry is invoked. Manual: throttle network, scroll to bottom, confirm one error + no request storm.
- **deps:** [] · **batchHint:** naka-virtualgrid-scroll-columns

---

## Batch: `naka-filtersidebar-cleanup`
**Summary:** Two FilterSidebar dead-code/spurious-reset bugs; remount already handles collection switches.

### F565 — Accordion + trait-search state wiped on every appended page
Confirmed `FilterSidebar.jsx:403-407` resets `expanded`/`traitSearch` on `[traitFilters]` change, but `useNfts.js:49` passes a brand-new `traitFilters` array on every appended page, collapsing the user's open accordions during scroll. Collection switches already remount via `App.jsx:184 key={collectionSlug}`.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Drop the effect entirely (remount handles collection changes), or key it on `collection.slug` instead of `traitFilters` identity. Removing it is minimal and safe given the remount.
- **files:** `src/nakamigos/components/FilterSidebar.jsx:402-407`
- **effort:** S · **risk:** low
- **test:** Manual: expand a trait accordion, scroll to load more pages, confirm it stays open.
- **deps:** [] · **batchHint:** naka-filtersidebar-cleanup

### F584 — Dead `isMobile` state + resize listener causing re-render churn
Confirmed `FilterSidebar.jsx:400` `isMobile` is never read (`:459` uses only `isMobileOverlay` prop); `:410-415` attaches a resize listener that `setIsMobile` on every resize.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Delete the `isMobile` state and the resize `useEffect` (`:400`, `:410-415`).
- **files:** `src/nakamigos/components/FilterSidebar.jsx:400`, `:409-415`
- **effort:** S · **risk:** low
- **test:** Lint/build passes; resize the sidebar and confirm no behavior change.
- **deps:** [] · **batchHint:** naka-filtersidebar-cleanup

---

## Batch: `naka-image-pipeline`
**Summary:** The image pipeline still emits the known-404 `metadataBase/<id>.png` for Nakamigos in three spots, and the failure-sentinel cache is dead so known-bad tokens refetch on every remount. These are the exact patterns the 2026-06-11 rate-limit fix targeted.

### F568 — Nakamigos `metadataBase/<id>.png` fallback 404s yet 3 paths emit it
Confirmed: `Listings.jsx:239-246` recentSales sets `image: token?.image || fallbackImg` (no `imagePending`), so sale cards aren't flagged `noSelfFetch` (`:784`) → each 404 fires NftImage's per-card `/api/alchemy` fetch (`NftImage.jsx:100-127`). `listedNfts.imageLarge` (`:175`) and `normalizeToken.fallbackImage` (`api.js:105`) also use it.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** For Nakamigos, set the recent-sales fallback to `null` + `imagePending:true` like the listings path (`Listings.jsx:173-174`); the batch enrichment (`:124-145`) already covers `saleIds`. Gate `normalizeToken`'s `fallbackImage` (`api.js:105`) off when the collection has no deterministic per-id PNG (Nakamigos) — pass a `hasDeterministicImage` flag from the collection config, or null it for the Nakamigos contract.
- **files:** `src/nakamigos/components/Listings.jsx:239-246`; `src/nakamigos/api.js:105`, `:108`, `:113`
- **effort:** M · **risk:** med (don't regress gnss/junglebay which DO have working per-id images)
- **test:** Network panel: open Nakamigos Listings with recent sales; confirm no `metadataBase/<id>.png` 404 burst. gnss/junglebay cards still load.
- **deps:** [] · **batchHint:** naka-image-pipeline

### F575 — Failure-sentinel cache never suppresses refetches
Confirmed `NftImage.jsx:36-45`: for a failed-but-within-TTL entry, `getCachedUrl` returns `entry.url` which is `null` (`setCachedFailed` stores `url:null`). Callers treat null as a miss (`:80` re-fires fetch; `handleError` never consults cache), so the 5-min TTL + `failed` flag are dead — every remount of a known-bad token re-hits `/api/alchemy`.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Have `getCachedUrl` return a distinguishable sentinel for failed entries (e.g. `{ failed:true }`); in the mount effect (`:74-98`) short-circuit a cached failure straight to the placeholder (`setFailCount(3)`) and skip the fetch. Keep the TTL eviction.
- **files:** `src/nakamigos/components/NftImage.jsx:36-45`, `:74-98`
- **effort:** S · **risk:** low
- **test:** Unit: call `setCachedFailed(id)` then remount; assert no `/api/alchemy` fetch fires and placeholder shows.
- **deps:** [] · **batchHint:** naka-image-pipeline

### F621 — Inconsistent image sourcing: raw ipfs.io full-res causes slow loads + black re-flash (live)
Live: most cards use Cloudinary/Alchemy 250px thumbs; some (e.g. #10219) use `ipfs.io/ipfs/Qm…` at 2000px and re-blacken on every grid re-render; 2 cards sat on the `N` placeholder for minutes. Root: `normalizeToken` prefers `thumbnailUrl` but falls through to raw `rawMetaImage`/ipfs (`api.js:107-108`).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** In `normalizeToken` prefer Alchemy CDN sizes and avoid raw 2000px IPFS for the grid `image` (keep it only for `imageLarge`). For the grid thumbnail use `thumbnailUrl || cachedUrl || pngUrl` and only fall to `rawMetaImage` when those are absent. Combined with F575 (sentinel), the minutes-long placeholders resolve.
- **files:** `src/nakamigos/api.js:107-113`
- **effort:** S · **risk:** med (image resolution order affects all collections)
- **test:** Manual: Nakamigos listings grid; confirm thumbnails are CDN-sized and don't re-blacken on sort/filter.
- **deps:** [F575] · **batchHint:** naka-image-pipeline

### F603 — (missing) Responsive images: no srcset/DPR variants
Confirmed `NftImage.jsx:147-157` uses a single `src` at width/height 300; Alchemy exposes thumbnail/png/original sizes the code already reads.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Additive: when the normalized token carries multiple Alchemy sizes, emit `srcSet`/`sizes` on the `<img>` (`NftImage.jsx:147`) mapping thumbnail→1x, png/cached→2x. Keep the single `src` as fallback. Low priority; bundle with the pipeline batch.
- **files:** `src/nakamigos/components/NftImage.jsx:147-158`; `src/nakamigos/api.js:108-113` (carry extra size fields)
- **effort:** M · **risk:** low
- **test:** Manual on a retina display: inspect a card `<img>` for `srcset`; confirm it renders the larger variant.
- **deps:** [] · **batchHint:** naka-image-pipeline

---

## Batch: `naka-empty-and-loading-states`
**Summary:** Empty/loading-state polish on the gallery: double empty state, missing loading-more indicator, mismatched skeleton geometry, image fade-in.

### F579 — Two stacked empty states (grid's "No items found" + styled card)
Confirmed: `Gallery.jsx:197-208` always renders `VirtualGalleryGrid`, which returns its own `calc(100vh-200px)` "No items found" (`VirtualGalleryGrid.jsx:164-179`); `Gallery.jsx:211-231` then ALSO renders `.empty-state` for the same condition.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Skip rendering `VirtualGalleryGrid` when `!loading && displayed.length===0` (render only the `.empty-state` block). Prefer the shared `<EmptyState>` component (`components/EmptyState.jsx`) over the hand-rolled copy at `Gallery.jsx:211-231`. Preserve the icon/title art.
- **files:** `src/nakamigos/components/Gallery.jsx:196-231`
- **effort:** S · **risk:** low
- **test:** Manual: apply a filter with zero matches; confirm a single empty state.
- **deps:** [] · **batchHint:** naka-empty-and-loading-states

### F589 — No "loading more" indicator; mobile filter count can double-count
Confirmed: no bottom spinner while a next page loads (`VirtualGalleryGrid` renders nothing for `loading && tokens.length>0`); `Gallery.jsx:75` toolbar count omits the price filter while `FilterSidebar.jsx:417-423` includes it.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** (a) Add a small spinner/skeleton row at the grid bottom when `loading && tokens.length>0` (reuse `.skeleton` styles). (b) Unify the active-count: in `Gallery.jsx:75` add `+ (priceRange.min||priceRange.max ? 1 : 0)` to match the sidebar's `activeCount` (`FilterSidebar.jsx:417-423`).
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx:181-237`; `src/nakamigos/components/Gallery.jsx:74-77`
- **effort:** S · **risk:** low
- **test:** Manual: scroll to trigger a page load; confirm a loading row. Set a price filter; confirm the mobile badge and sidebar badge agree.
- **deps:** [] · **batchHint:** naka-empty-and-loading-states

### F623 — Images pop with no fade; skeleton geometry mismatches loaded cards (live)
Live: images swap black→art in one frame; the /listings 7-column skeleton becomes 4 columns + sweep panel (layout jump). Confirmed `SkeletonGrid` uses `columns` (which is the frozen 4, F563) and `NftImage` has no load fade.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** (a) Add a 120ms opacity fade on `<img>` load in `NftImage.jsx` (`onLoad` → set loaded, transition opacity). (b) Make the listings/gallery skeleton grid mirror the real grid template — fix the column count via F563 so the skeleton uses the computed `columns`, and match the sweep-panel layout in the listings skeleton. Additive only.
- **files:** `src/nakamigos/components/NftImage.jsx:146-158`; `src/nakamigos/components/VirtualGalleryGrid.jsx:51-82`, `:150-162`
- **effort:** M · **risk:** low
- **test:** Manual: throttle network, observe image fade-in and no column-count jump from skeleton to loaded.
- **deps:** [F563] · **batchHint:** naka-empty-and-loading-states

---

## Batch: `naka-a11y-keyboard`
**Summary:** Several browse click-targets are mouse-only; the app already has a `role+tabIndex+onKeyDown` pattern (`FilterSidebar.jsx:579-590`, Card/VirtualCard). Apply it consistently. One shared pattern across four components.

### F586 — Interactive rows/cards in TraitExplorer, SpeciesEncyclopedia, CharacterTypeExplorer, JungleBay timeline are mouse-only
Confirmed: `TraitExplorer.jsx:777-785` & `:575-582`, `SpeciesEncyclopedia.jsx:353-361`, `CharacterTypeExplorer.jsx:359-371`, `JungleBayShowcase.jsx:264-271` are plain divs with `onClick` only.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Add `role="button"` (or `"checkbox"` for trait rows), `tabIndex={0}`, and `onKeyDown` Enter/Space → the existing handler, copying the `FilterSidebar.jsx:579-590` pattern. No visual change.
- **files:** `src/nakamigos/components/TraitExplorer.jsx:577-582`, `:778-785`; `src/nakamigos/components/SpeciesEncyclopedia.jsx:353-361`; `src/nakamigos/components/CharacterTypeExplorer.jsx:359-371`; `src/nakamigos/components/JungleBayShowcase.jsx:264-272`
- **effort:** M · **risk:** low
- **test:** Keyboard: Tab to each row/card, press Enter/Space, confirm activation. Axe pass for "interactive controls must be focusable".
- **deps:** [] · **batchHint:** naka-a11y-keyboard

### F587 — Landing search dropdown lacks keyboard nav + combobox semantics; invalid button-nested headings
Confirmed: `CollectionLanding.jsx:149-166` input has no `onKeyDown`/`role=combobox`/`aria-expanded`/`aria-activedescendant`; results are plain buttons. Cards nest `<h3>`/`<p>` inside `<button>` (invalid).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Add ArrowUp/ArrowDown/Enter/Escape handling on the input, `role="combobox"` + `aria-expanded` + `aria-controls`, and `aria-activedescendant` for the highlighted option. Swap the `<h3>`/`<p>` inside `CollectionCard`'s `<button>` for styled `<div>`s (or change the outer element to a non-button with role). Keep all visuals.
- **files:** `src/nakamigos/components/CollectionLanding.jsx:149-185`, `:187-265`, `:347`, `:489`, `:515`
- **effort:** M · **risk:** low
- **test:** Keyboard: arrow through results, Enter selects, Escape closes. HTML validator: no heading-in-button warning.
- **deps:** [] · **batchHint:** naka-a11y-keyboard

### F588 — Gallery add-to-cart is hover-gated → unreachable on touch
Confirmed `VirtualGalleryGrid.jsx:358`: `onAddToCart && !inCart && hovered` with `hovered` set only by mouse enter/leave (`:296-297`).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** On coarse pointers always render the button: gate with `hovered || coarsePointer` where `coarsePointer = window.matchMedia('(hover: none)').matches` (compute once like `prefersReducedMotion` at `:20`). Keep the hover behavior on desktop.
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx:20-27`, `:358`
- **effort:** S · **risk:** low
- **test:** Manual on iPhone/iPad (or DevTools touch emulation): add-to-cart button is tappable on gallery cards.
- **deps:** [] · **batchHint:** naka-a11y-keyboard

---

## Batch: `naka-price-formatting`
**Summary:** Two raw-value rendering bugs and the volume formatter; all should route through the shared `lib/formatPrice.js`.

### F577 — Floor ≥1 ETH rounded to whole numbers (1.5 → "2 ETH")
Confirmed `CollectionLanding.jsx:334-340`: for ` ETH` suffix and `val>=1`, `toLocaleString({maximumFractionDigits:0})`. Used for the Floor stat (`:578`).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Use the shared `formatPrice` (`lib/formatPrice.js` — 4 decimals <1000, 2 decimals ≥1000) for the Floor stat; keep the 0-decimal rounding only for Volume. Pass a flag to `formatStat` or call `formatPrice(stats.floor)` directly for floor.
- **files:** `src/nakamigos/components/CollectionLanding.jsx:334-340`, `:578`
- **effort:** S · **risk:** low
- **test:** Unit: a 1.5 ETH floor renders "1.5000"/"1.50", not "2".
- **deps:** [] · **batchHint:** naka-price-formatting

### F592 — Minor consistency nits (raw price in aria-label, unstable Listings keys, dead imports/props, handleError ignores noSelfFetch)
Confirmed: `VirtualGalleryGrid.jsx:295` aria-label interpolates raw `${nft.price} ETH`; `Listings.jsx:782` `key={\`${nft.id}-${idx}\`}` is order-dependent; `Gallery.jsx:2` imports `Skeleton` unused; `Skeleton.jsx` accepts unused `view`; `NftImage.handleError` (`:100`) ignores `noSelfFetch`.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Use `formatPrice(nft.price)` in the aria-label (`VirtualGalleryGrid.jsx:295`); key Listings cards by `nft.id` alone (`Listings.jsx:782`); drop the unused `Skeleton` import (`Gallery.jsx:2`) and unused `view` prop (`Skeleton.jsx`); early-return in `NftImage.handleError` when `noSelfFetch` (mirror the mount-effect guard at `:80`).
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx:295`; `src/nakamigos/components/Listings.jsx:782`; `src/nakamigos/components/Gallery.jsx:2`; `src/nakamigos/components/Skeleton.jsx:1`; `src/nakamigos/components/NftImage.jsx:100-101`
- **effort:** S · **risk:** low
- **test:** Build/lint clean; re-sort Listings and confirm cards don't remount (no image re-flash); screen-reader reads formatted price.
- **deps:** [] · **batchHint:** naka-price-formatting

### F591 — Hero featured-NFT swap is a hard cut; volume formatter caps at "K"; interval runs while tab hidden
Confirmed `Hero.jsx:41` puts an opacity transition on the img but nothing changes opacity on swap (`:20-24` 4s rotation is a hard cut); `formatVolume` (`:85-89`) has no M tier ("1234.6K"); the interval only pauses on hover, not `document.hidden`.
- **verdict:** fix-now · **rootCause:** standalone (T2-adjacent animation polish)
- **approach:** (a) Crossfade via `AnimatePresence` keyed on `cur.id` (framer-motion already in bundle). (b) Add an M tier to `formatVolume` (`>=1e6 → "1.2M"`). (c) Pause the rotation interval on `document.hidden` (visibilitychange listener, like SplashScreen's `onVisibility`). Keep the existing hero art/layout.
- **files:** `src/nakamigos/components/Hero.jsx:18-24`, `:41`, `:85-89`
- **effort:** M · **risk:** low
- **test:** Manual: featured image crossfades; volume of 1.2M renders "1.2M"; background the tab and confirm rotation pauses.
- **deps:** [] · **batchHint:** naka-price-formatting

---

## Batch: `naka-trait-placeholder-text`

### F576 — Search placeholder renders literal "…" text
Confirmed `TraitExplorer.jsx:716` `placeholder="Search traits or values…"` — JSX attribute string literals don't process JS unicode escapes, so users see the literal `…`.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Change to `placeholder={"Search traits or values…"}` (JS expression) or use the literal `…` character.
- **files:** `src/nakamigos/components/TraitExplorer.jsx:716`
- **effort:** S · **risk:** low
- **test:** Manual: placeholder shows an ellipsis, not `…`.
- **deps:** [] · **batchHint:** naka-trait-placeholder-text

---

## Batch: `naka-traits-loadall`

### F572 — Visiting Traits silently loads all 20,000 tokens (~500 pages, O(n²) re-extraction)
Confirmed `TraitExplorer.jsx:379-381` drives `useNfts.js:107-121` (40 tokens/200ms ≈ 500 calls/100s); every page re-runs `extractTraitFilters` over the full array (`useNfts.js:49`) plus growing useMemos. Leaving the tab doesn't stop it (`loadingAll` lives in `useNfts` at App level).
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Two viable directions, needs an owner call: (a) **preferred** — surface a precomputed trait-summary for Nakamigos (a `rarity.json` path already exists per `api.js`), so Traits doesn't need all tokens; (b) cap auto-`loadAll` and gate it behind an explicit "Load all 20,000 (may take a minute)" button with a cancel + progress. Either avoids the silent 500-call storm that previously tripped the Upstash limiter. Stop `loadingAll` on tab unmount regardless.
- **files:** `src/nakamigos/components/TraitExplorer.jsx:379-381`; `src/nakamigos/hooks/useNfts.js:100-121`; `src/nakamigos/api.js` (rarity.json path)
- **effort:** L · **risk:** med
- **test:** Manual: open Traits; confirm no automatic 500-call burst (network panel); explicit load works + cancels.
- **deps:** [] · **batchHint:** naka-traits-loadall

---

## Batch: `naka-dead-modules`
**Summary:** Two unreferenced modules drifting toward a runtime crash. Either wire them up correctly or remove; the inline mutation/polling paths are currently canonical.

### F581 — `queryKeys.traitOffers` missing but called in two mutation callbacks
Confirmed `queryConfig.js:56-62` has no `traitOffers`; `useTradingMutations.js:55` & `:101` call `queryKeys.traitOffers(slug)`. Grep confirms NO component imports `useTradingMutations` (only `EmptyState`/`CollectionOffersPanel`/`TraitBidPanel` use the unrelated `traitOffers` data key/`useTraitOffers`), so it's unreachable today but would throw `queryKeys.traitOffers is not a function` the moment it's wired.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Add `traitOffers: (slug) => ["trait-offers", slug]` to `queryKeys` (`queryConfig.js:62`). Low-risk and makes the designated mutation layer safe for future wiring. (Removing the dead module is the alternative if inline paths stay canonical — flag for owner, but adding the key is the safer minimal fix.)
- **files:** `src/nakamigos/lib/queryConfig.js:56-62`
- **effort:** S · **risk:** low
- **test:** Unit: `queryKeys.traitOffers("nakamigos")` returns `["trait-offers","nakamigos"]`; import `useTradingMutations` in a test and call `useCancelOrder().onSettled` without throwing.
- **deps:** [] · **batchHint:** naka-dead-modules

### F590 — Four of six tuned query configs are dead; stats/metadata hand-rolled with useState
Confirmed: `nftMetadataQuery`/`floorPriceQuery`/`collectionStatsQuery`/`ownedNftsQuery` (`queryConfig.js:5,13,30,39`) have zero importers; `useCollection.js:80-85` polls via `setInterval`; `CollectionLanding.jsx:618-653` refetches all 3 collections' stats on every visit with no cache.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Migrate `useCollection` stats and the landing-page stats onto `useQuery` with `collectionStatsQuery` so the cache is shared cross-page (the landing visit and the collection page would reuse one cached stats entry, eliminating duplicate `/stats` calls — also helps F613/F614 pressure). This is a meaningful refactor of two data hooks; needs owner sign-off on scope vs. just deleting the dead exports.
- **files:** `src/nakamigos/hooks/useCollection.js:49-91`; `src/nakamigos/components/CollectionLanding.jsx:618-653`; `src/nakamigos/lib/queryConfig.js`
- **effort:** L · **risk:** med (touches the primary stats/activity hook)
- **test:** Manual: navigate landing → collection → back; confirm stats served from cache (no repeat `/stats` calls in network panel) and no UI regression.
- **deps:** [] · **batchHint:** naka-dead-modules

---

## Batch: `naka-fallback-stats-badge`

### F582 — Hardcoded FALLBACK_STATS render as live data with no staleness marker
Confirmed: `useCollection.js:17-19` inits Nakamigos to `FALLBACK_STATS` (`constants.js:169-174` floor 0.1048 / owners 5238); `api.js:218` returns `{...FALLBACK_STATS, fallback:true}` on double failure; `Hero.jsx:146-153` renders `stats.floor` with no fallback/stale indicator.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Surface the existing `stats.fallback` flag in the Hero as a subtle "cached"/"approx" badge on the floor/owners/volume stat cards (additive, no removal). `useCollection` already carries `isLive`; thread `stats.fallback` into Hero and render a small marker when true. Don't change the numbers or layout.
- **files:** `src/nakamigos/components/Hero.jsx:146-179`; `src/nakamigos/hooks/useCollection.js:64-67` (ensure `fallback` propagates)
- **effort:** S · **risk:** low
- **test:** Manual: force the stats fetch to fail (block `/api`); confirm Hero shows a "cached" marker instead of presenting stale numbers as live.
- **deps:** [] · **batchHint:** naka-fallback-stats-badge

### F619 — Floor/owners differ across surfaces within minutes (live)
Live: Floor tab 0.1026/5,212; Gallery hero 0.1045; /listings briefly 0.1048/5,238 (FALLBACK_STATS) before settling. Root: two sources (OpenSea listings floor vs Alchemy floor) plus the FALLBACK_STATS first-paint (F582).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Pick one canonical floor source per screen or label the source. Minimal: the F582 fallback badge removes the "0.1048/5,238 flash" confusion; for the listings-vs-hero floor delta, label the Hero floor with the source (the listings page already has a "via OpenSea" badge pattern). Don't reconcile by faking a single number — disclose the source.
- **files:** `src/nakamigos/components/Hero.jsx:146-153`; `src/nakamigos/hooks/useCollection.js` (single floor source)
- **effort:** M · **risk:** low
- **test:** Manual: compare Floor tab, Hero, and Listings within one session; values either match or carry a source label.
- **deps:** [F582] · **batchHint:** naka-fallback-stats-badge

### F620 — JungleBay stats bar shows "—" for ~10s while sweep panel already has floor (live)
Live: FLOOR/OWNERS/SUPPLY "—" with LISTED/MEDIAN filled; sweep panel already shows floor. Confirmed `useCollection.js:42` resets non-Nakamigos to `EMPTY_STATS` (all null) and only populates after the async load.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Hydrate the stats bar from the listings payload immediately (the sweep panel already derives floor from `listedNfts`): compute a provisional floor/median from `listings` before Alchemy responds, and reconcile when stats arrive. Or show a skeleton shimmer instead of em dashes (a dash reads as "no data exists"). Reuse `Hero.jsx:154` `StatSkeleton`.
- **files:** `src/nakamigos/components/Hero.jsx:146-179`; `src/nakamigos/hooks/useCollection.js:40-47`
- **effort:** M · **risk:** low
- **test:** Manual: switch to Jungle Bay; floor appears immediately (from listings) or shows a shimmer, never a bare "—".
- **deps:** [] · **batchHint:** naka-fallback-stats-badge

---

## Batch: `naka-orderbook-data-sanity`

### F609 — Order book bid side is nonsense; "Healthy/narrow" copy contradicts a -4071% spread (live, high)
Confirmed in `DepthChart.jsx`: `computeSpread(floorPrice, bestBid)` (`:34-42`) computes `pct=(floor-bestBid)/floor*100`; a 4.28 ETH bid against a 0.10 floor gives pct ≈ -4180%, and since `health` only goes red/yellow for `pct>=15`/`>=5`, a large negative pct stays `"green"` → `generateSummary:74` "Price gap is narrow … healthy" and `:408` "Healthy". The underlying data fault is collection/criteria WETH offers being read as per-unit prices (a 4.28 ETH unit bid on a 0.10 floor is impossible/instant-arb).
- **verdict:** fix-now (display gate) + needs-verification (data source) · **rootCause:** standalone
- **approach:** (a) **Display gate (fix-now):** in `computeSpread`, treat `bestBid > floorPrice` (negative spread) as an explicit data-error state — return `health:"red"` (or a new `"invalid"`) and have `generateSummary`/`:408` render "data unavailable", never "narrow"/"Healthy". A negative spread must never read as healthy. (b) **Data (needs-verification → likely api-offers):** validate the offers feed — confirm whether collection/trait WETH offers are qty-scaled or criteria offers being mis-divided in `api-offers.js`; cap/clip bids above floor as suspect. Verify against the offers-parsing audit group before patching the parser.
- **files:** `src/nakamigos/components/DepthChart.jsx:34-42`, `:71-77`, `:408`; `src/nakamigos/api-offers.js` (offer price parsing — verify)
- **effort:** M · **risk:** med
- **test:** Unit: `computeSpread(0.10, 4.28)` returns a non-green/invalid health and the summary never says "narrow/healthy". Manual: order book with a bid > floor shows a data-error verdict.
- **deps:** [] · **batchHint:** naka-orderbook-data-sanity

---

## Batch: `naka-detail-modal-ui` (Modal surface — overlaps g12; planned here as assigned)

### F611 — Three skeleton bars in OFFERS never resolve (live)
Live (prod): modal OFFERS shows 3 latched `skeleton` rows after 60s; on dev (#16971) skeletons=0 → may already be fixed at HEAD or data-dependent. The modal's offers come from `useTraitOffers`/offers query; couldn't reproduce a guaranteed code latch at HEAD.
- **verdict:** needs-verification · **rootCause:** T11 (misleading skeleton) / possibly T1 (stale prod)
- **approach:** Verify on dev whether the OFFERS section resolves to rows or an explicit "No other offers" empty state. If it latches, ensure the offers query's loading state always terminates to a row list OR the shared `<EmptyState type="traitOffers">` (already used at `CollectionOffersPanel.jsx:136`). Given dev showed 0 skeletons, this is likely the stale prod build (redeploy) — confirm before coding.
- **files:** `src/nakamigos/components/Modal.jsx` (OFFERS section), offers query hook
- **effort:** S · **risk:** low
- **test:** Manual on dev: open 3 tokens; OFFERS resolves to rows or an empty state within a few seconds, never an infinite skeleton.
- **deps:** [] · **batchHint:** naka-detail-modal-ui

### F612 — "Make Offer" button clipped to ~34px ("Mak")
Confirmed `Modal.jsx:452-459`: the secondary "Make Offer" button has `style={{ flex: 0, whiteSpace:"nowrap", padding:"0 16px" }}` next to a `flex:1` buy button. `flex:0` (= `0 1 0%`) gives basis 0 and allows shrink, clipping the text.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Change `flex: 0` → `flex: "0 0 auto"` (or add `flexShrink: 0` + `minWidth`) so the button sizes to its content. `whiteSpace:"nowrap"` already set. One-property change.
- **files:** `src/nakamigos/components/Modal.jsx:454`
- **effort:** S · **risk:** low
- **test:** Manual: open any token modal; "Make Offer" renders full text beside the Buy CTA at all widths.
- **deps:** [] · **batchHint:** naka-detail-modal-ui

### F616 — Escape closes the underlying modal first, orphaning the fullscreen viewer (live)
Live: from fullscreen, first Escape removed `?token` + closed the detail modal while the fullscreen overlay stayed up; second Escape dismissed it. The Modal's keydown handler (`Modal.jsx:159-183`) handles Escape and calls `onClose`, but it doesn't yield to a topmost fullscreen/theater overlay.
- **verdict:** fix-now · **rootCause:** standalone (layered-dialog stacking)
- **approach:** Implement a topmost-overlay-first Escape: the fullscreen/theater viewer (opened via `onTheater`) should own Escape while open and `stopImmediatePropagation` before the modal handler runs, OR the modal handler should early-return when a fullscreen overlay is open (track an `isTheaterOpen` ref like `showOfferModalRef` at `:125`). Standard layered-dialog stack.
- **files:** `src/nakamigos/components/Modal.jsx:159-183`; the theater/fullscreen component (`onTheater` target)
- **effort:** M · **risk:** med (Escape ordering across overlays)
- **test:** Manual: open fullscreen, press Escape once → only the viewer closes; press again → modal closes.
- **deps:** [] · **batchHint:** naka-detail-modal-ui

### F624 — Fullscreen bottom bar duplicates the token id (live)
Live: reads "Nakamigos #18156   #18156" (name already contains the id, then a grey repeat).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** In the fullscreen/theater bottom bar, drop the standalone `#id` (the name already contains it) or replace it with rank/trait-count. Cosmetic, additive-safe.
- **files:** the theater/fullscreen viewer component bottom-bar render (sibling of `Modal.jsx`, `onTheater` target)
- **effort:** S · **risk:** low
- **test:** Manual: fullscreen bottom bar shows the id once.
- **deps:** [] · **batchHint:** naka-detail-modal-ui

### F629 — (missing) No comparable-sales / similar-tokens module on the detail view
Confirmed: modal has price history/offers/traits/chain but no "more from collection" / trait-floor comparables; the trait spotlight already knows totals.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive feature — a small comparables strip (same rarest trait, sorted by price) using data already in the trait drill-down (`traitFloors` in `TraitExplorer`, listings). Scope/placement is an owner call; not a bug fix.
- **files:** `src/nakamigos/components/Modal.jsx` (new strip), data from `TraitExplorer`/`Listings` traitFloors
- **effort:** L · **risk:** low
- **test:** Manual: open a token; comparables strip shows cheaper listings sharing its rarest trait.
- **deps:** [] · **batchHint:** naka-detail-modal-ui

---

## Batch: `naka-splash-ux`

### F615 — Mandatory click-gate splash replays on every load, costs 10-20s (live)
Confirmed: `App.jsx:161-162` renders `SplashScreen` whenever `!splashDone` (a fresh `useState(false)` per load); `SplashScreen` requires a click (`onClick={handleEnter}`, only acts when `phase==="ready"`). No sessionStorage gate, no auto-enter, no preloading behind it. (The art itself is good — preserve it.)
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Keep the art (owner mandate: additive only). Owner choices needed: (a) auto-enter after the build animation completes (make the click optional), (b) gate replays per session via `sessionStorage` so reloads/deep-links skip it, (c) start data-fetching/preloading the app behind the splash so the post-click black fade disappears. All additive to `SplashScreen`/`App.jsx`; needs sign-off on which combination (esp. whether to keep the click as a skippable affordance).
- **files:** `src/nakamigos/App.jsx:143`, `:160-163`; `src/nakamigos/components/SplashScreen.jsx:633-701`
- **effort:** M · **risk:** med (entry-flow change; ensure deep links + OG unfurls still work)
- **test:** Manual: reload within a session → no replay; deep link to `/nft/777` → splash skipped or auto-enters; total time-to-content well under the current 10-20s.
- **deps:** [] · **batchHint:** naka-splash-ux

---

## Batch: `naka-junglebay-timeline`

### F580 — JungleBay timeline out of chronological order + hardcoded "Present" market stat
Confirmed `JungleBayShowcase.jsx:29-39`: "Nov 2021 — Sandbox Land Secured" (index 5) sits after "May 2022 — Otherside Land Acquired" (index 4); the final "Present" event hardcodes "Only 0.98% of supply listed."
- **verdict:** fix-now · **rootCause:** T3 (hardcoded stat drifting from on-chain truth)
- **approach:** Reorder `TIMELINE_EVENTS` chronologically (move the Nov 2021 Sandbox entry before the 2022 entries). Compute the listed % live from `listings`/`supply` (both available upstream in JungleBay props) or drop the number from the "Present" copy. Don't remove the timeline section.
- **files:** `src/nakamigos/components/JungleBayShowcase.jsx:29-39`, `:38`
- **effort:** S · **risk:** low
- **test:** Manual: JungleBay About timeline reads in date order; the "Present" event shows a live or no listed-% figure.
- **deps:** [] · **batchHint:** naka-junglebay-timeline

---

## Batch: `naka-species-deeplink`

### F567 — GNSS "View in Gallery" species deep-link param nothing reads
Confirmed `SpeciesEncyclopedia.jsx:327-329` navigates `/nakamigos/gnssart/gallery?species=…`; `App.jsx parseRoute` ignores the query string and only the `?token=` param is consumed (`:282`,`:293`). User lands on the unfiltered gallery. The correct pattern exists: `onFilterGallery` (used by JungleBay/CharacterTypeExplorer via `App.jsx:629`).
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Thread an `onFilterGallery(key, value)` prop into `SpeciesEncyclopedia` (via `About.jsx`, which already wires it for JungleBay) and call `nfts.changeFilter({ [speciesTraitKey]: [speciesName] })` + `handleTabChange("gallery")` (mirror `App.jsx:629`'s TraitExplorer wiring). This reuses the working callback rather than implementing `?species=` parsing.
- **files:** `src/nakamigos/components/SpeciesEncyclopedia.jsx:327-329`; `src/nakamigos/components/About.jsx` (pass the prop); `src/nakamigos/App.jsx:629` (reference pattern)
- **effort:** M · **risk:** low
- **test:** Manual: GNSS About → click a species "View in Gallery" → gallery opens filtered to that species.
- **deps:** [] · **batchHint:** naka-species-deeplink

---

## Batch: `naka-card-rank-approx`

### F585 — Card.jsx ignores `rankApproximate` (approx ranks shown as authoritative)
Confirmed `Card.jsx:44` `{nft.rank && (` with no `rankApproximate` gate, while `VirtualGalleryGrid.jsx:316` (`!nft.rankApproximate`) and `Hero.jsx:43` (`!cur.rankApproximate`) gate it. Favorites/MyCollection render `Card` (`Favorites.jsx:58`, `MyCollection.jsx:396`), so gnss/junglebay favorites show unreliable ranks as real.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Add the same `!nft.rankApproximate` gate to the `Card.jsx:44` badge condition (or prefix the badge with `~`). One-line change to match the sibling components.
- **files:** `src/nakamigos/components/Card.jsx:44`
- **effort:** S · **risk:** low
- **test:** Manual: favorite a gnss/junglebay token with a partial load; confirm the rank badge hides (or shows `~`) when `rankApproximate`.
- **deps:** [] · **batchHint:** naka-card-rank-approx

---

## Batch: `naka-landing-token-search`

### F578 — Landing token-ID search assumes ids are 1..supply (wrong for burn/sparse collections)
Confirmed `CollectionLanding.jsx:98-105` `if (id > 0 && id <= col.supply)`; `constants.js:33` gnss "token IDs go up to 9000+" with supply 9696, `:49` junglebay supply "reflects burns" — ids above supply can exist (excluded) and ids below can be burned (links to a dead token). `id > 0` also excludes token #0.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Treat the supply bound as a heuristic hint in UI copy, or validate by fetching the token (`fetchTokensByIds`) before building the deep link. Minimal: widen the gate to `id >= 0` (allow #0) and relax the upper bound for collections flagged sparse/burn (gnss/junglebay), labeling the result "open #N (may not exist)". Avoid over-fetching on every keystroke — only validate on Enter/select.
- **files:** `src/nakamigos/components/CollectionLanding.jsx:97-105`
- **effort:** M · **risk:** low
- **test:** Manual: search "0" and a high gnss id (>9696 but valid); confirm reachable. Search a burned junglebay id; result is labeled best-effort.
- **deps:** [] · **batchHint:** naka-landing-token-search

---

## Batch: `naka-listings-refetch-storm`

### F569 — Token-metadata enrichment refetches same IDs on every activities/tokens update
Confirmed `Listings.jsx:124-145`: `knownIds = new Set(tokens.map(...))` excludes already-fetched `extraTokens`; effect deps include `activities` (new array every 60s poll, `useCollection.js:68,81`) and `tokens` (grows on pagination) → re-issues `fetchTokensByIds` for all non-gallery listed+sale ids every cycle (~8 batch POSTs).
- **verdict:** fix-now · **rootCause:** T8 (always-on poller / duplicate fetch)
- **approach:** Include `extraTokens` ids in `knownIds` (`Set([...tokens, ...extraTokens].map(...))`) or keep a `fetchedIdsRef` so only genuinely new ids are requested. Minimal change to the `knownIds` construction at `:125`.
- **files:** `src/nakamigos/components/Listings.jsx:124-145`
- **effort:** S · **risk:** low
- **test:** Network panel: open Listings, wait through two 60s activity polls; confirm no repeated `fetchTokensByIds` for ids already fetched.
- **deps:** [] · **batchHint:** naka-listings-refetch-storm

### F593 — fetchCollectionOffers / bestOffers loop lack abort + bestOffers strictly sequential
Confirmed `Listings.jsx:110-115` `fetchCollectionOffers` has no signal/cleanup (remount via `App.jsx:184 key` prevents cross-collection bleed, but network work still completes pointlessly); `:205-221` awaits `fetchBestOffer` one-at-a-time for up to 20 ids.
- **verdict:** fix-now · **rootCause:** T8
- **approach:** Thread an `AbortSignal` through `fetchCollectionOffers` (`:112`) and the bestOffers loop (`:205`), aborting on cleanup. Batch best-offer fetches 3-4 concurrently (`Promise.all` over small chunks) instead of strictly sequential — rate-limit-aware but faster. Keep the `cancelled` flag as a belt-and-suspenders.
- **files:** `src/nakamigos/components/Listings.jsx:110-115`, `:196-223`; `src/nakamigos/api.js`/`api-offers.js` (accept signal)
- **effort:** M · **risk:** med (rate-limit sensitivity — keep concurrency low)
- **test:** Manual: switch collections mid-fetch; confirm in-flight offer calls abort (network panel). bestOffers populate faster with 3-4 concurrency, no 429 spike.
- **deps:** [] · **batchHint:** naka-listings-refetch-storm

---

## Batch: `naka-mobile-batchbar-zindex`

### F571 — Batch-selection bar (z-index 100) covered by mobile bottom nav (z-index 9999)
Confirmed `Listings.jsx:900-907` fixed bottom bar `zIndex:100`; `MobileNav.jsx:116-130` `.mobile-bottom-nav` fixed bottom `zIndex:9999` with safe-area padding. Both occupy the bottom strip; on phones the "N selected / Add All to Cart" bar renders under the nav.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** On `<768px`, offset the selection bar above the nav: `bottom: calc(<nav height> + env(safe-area-inset-bottom))`, or raise its z-index above 9999 while keeping it below modals. Prefer the offset so both remain usable. Compute the nav height (it's a fixed ~56px bar).
- **files:** `src/nakamigos/components/Listings.jsx:900-907`; reference `src/nakamigos/components/MobileNav.jsx:116-130`
- **effort:** S · **risk:** low
- **test:** Manual on iPhone viewport: select listings; the selection bar sits above the bottom nav with both action buttons tappable.
- **deps:** [] · **batchHint:** naka-mobile-batchbar-zindex

---

## Batch: `naka-ultrawide-layout`

### F622 — Ultrawide (1912px) leaves large dead zones (live)
Live: Listings 4-col grid + sweep ends ~1200px, ~700px dimmed background; Gallery hero near-empty band; About a ~600px left column against an empty half. Traits page uses the width well. Confirmed `Gallery.jsx:71` caps `maxWidth:1440`; grid columns are computed but the section is capped.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive (keep all art/sections): allow 6-8 grid columns at >1600px (the `useColumns` min-col math already supports it once the container is wider — raise/remove the `maxWidth:1440` cap on the gallery section for ultrawide), dock the order-book panel open by default on ultrawide, and add a right-rail module (recent sales / rarity spotlight) on About and the Gallery hero. Scope/design needs owner sign-off.
- **files:** `src/nakamigos/components/Gallery.jsx:71`; `src/nakamigos/components/Listings.jsx` (grid/sweep layout); `src/nakamigos/components/About.jsx`/`Hero.jsx` (right-rail)
- **effort:** L · **risk:** med
- **test:** Manual at 1912px: grid uses 6-8 columns, no large dead zones; mobile/desktop unaffected.
- **deps:** [] · **batchHint:** naka-ultrawide-layout

---

## Batch: `naka-header-popovers`

### F625 — Theme-cycle aria-label never updates; hub search ignores Escape (live)
Live: after cycling themes the button still says "Current theme: default"; hub search Escape leaves the dropdown open (X works). Header-level.
- **verdict:** fix-now · **rootCause:** standalone (T10 a11y)
- **approach:** Update the theme button `aria-label` to the active theme name (it's available from `useTheme().theme`). Add `onKeyDown` Escape → close the hub search dropdown (mirror the outside-click handler). Both in `Header.jsx`.
- **files:** `src/nakamigos/components/Header.jsx` (theme button aria-label; hub search dropdown keydown)
- **effort:** S · **risk:** low
- **test:** Manual: cycle theme → screen reader announces new theme; hub search Escape closes the dropdown.
- **deps:** [] · **batchHint:** naka-header-popovers

### F626 — Notifications popover anchors far left of the bell (live)
Live: bell at x≈628, popover at x≈370-670 (over the sales ticker, not under the bell). Header-level positioning.
- **verdict:** fix-now · **rootCause:** standalone
- **approach:** Anchor the popover to the trigger with right-alignment (position relative to the bell button's bounding box, e.g. `right:0` on a positioned wrapper around the bell). In `Header.jsx` notifications popover.
- **files:** `src/nakamigos/components/Header.jsx` (notifications popover positioning)
- **effort:** S · **risk:** low
- **test:** Manual at desktop + narrow widths: popover opens directly under the bell, not over the ticker.
- **deps:** [] · **batchHint:** naka-header-popovers

### F628 — "DEMO" badge in hub header with no explanation (live)
Live: header shows "* DEMO" on hub/early loads, later "● LIVE" + ticker; no tooltip explaining demo vs live (notable given the demo-looking order-book bids, F609).
- **verdict:** fix-now · **rootCause:** T4 (trust-signal clarity)
- **approach:** Add a tooltip on the DEMO badge stating exactly which data is simulated vs live, or remove the badge once all surfaces are live. Prefer the tooltip (honest disclosure). Coordinate with F609 (don't label nonsense order-book data "LIVE").
- **files:** `src/nakamigos/components/Header.jsx` (DEMO/LIVE badge)
- **effort:** S · **risk:** low
- **test:** Manual: hover the DEMO badge → tooltip explains the demo/live distinction.
- **deps:** [] · **batchHint:** naka-header-popovers

---

## Batch: `naka-api-stats-volume` (server/operator + frontend fallback)

### F613 — Intermittent 429s on /api/opensea best-offer + 400s on collections/<slug>/stats (live)
Live: per-NFT best-offer 429s; `collections/nakamigos/stats` 400s (2/27 calls). Confirmed the frontend calls `openseaGet('collections/${osSlug}/stats')` (`api.js:190`,`:208`) — the 400 originates server/proxy/OpenSea-path side, not in this component code.
- **verdict:** operator-action · **rootCause:** standalone (server/proxy)
- **approach:** Server-side: batch/cache per-NFT best-offer lookups in the `/api/opensea` proxy (reduce 429s) and fix the `collections/<slug>/stats` path that 400s (likely an OpenSea v2 path/param shape or proxy mapping). Frontend's role is the F614 fallback. Verify the proxy route + OpenSea endpoint shape before changing the client path.
- **files:** server proxy (`api/opensea*` — outside `src/nakamigos`); reference call sites `src/nakamigos/api.js:190`, `:208`
- **effort:** M · **risk:** med
- **test:** Network panel: `collections/nakamigos/stats` returns 200; best-offer 429 rate drops after server batch/cache.
- **deps:** [] · **batchHint:** naka-api-stats-volume

### F614 — VOLUME shows em dash on all three landing cards (live)
Live: all three cards render "VOLUME —" (FLOOR/OWNERS/SUPPLY real). Confirmed correlation: `fetchCollectionStats` volume comes only from the `/stats` call (`api.js:190-195`) that 400s (F613) → `volume` stays null → `formatStat`→"—".
- **verdict:** fix-now · **rootCause:** standalone (frontend fallback) — gated on F613 root
- **approach:** Wire a volume fallback so a `/stats` 400 doesn't blank volume: when the OpenSea stats call fails, derive volume from the indexer/Alchemy (or the native orderbook/activity totals already fetched) before returning null in `fetchCollectionStats`. Keep the OpenSea value as primary. This is the code half; F613 fixes the upstream 400.
- **files:** `src/nakamigos/api.js:187-202`, `:206-215`
- **effort:** M · **risk:** low
- **test:** Manual: with `/stats` failing, landing cards still show a volume figure from the fallback source instead of "—".
- **deps:** [F613] · **batchHint:** naka-api-stats-volume

---

## Batch: `naka-shareable-url-state`

### F594 — (missing) URL-synced, shareable gallery state (filters/sort/search/listed/price)
Confirmed: filter/sort/search/listed/price live in-memory only (`useNfts`/`Gallery` state); OpenSea/Blur encode these in the URL.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: sync `activeFilters`/`sortBy`/`search`/`listedOnly`/`priceRange` to query params (the app already uses `window.history.replaceState` for `?token=` at `App.jsx:280-288` — extend that pattern), and hydrate from the URL on mount. Scope (which params, encoding) is an owner call; meaningful feature, not a bug.
- **files:** `src/nakamigos/components/Gallery.jsx` (state ↔ URL); `src/nakamigos/App.jsx:280-288` (pattern)
- **effort:** L · **risk:** med
- **test:** Manual: apply filters, copy URL, open in a new tab → same filtered view.
- **deps:** [] · **batchHint:** naka-shareable-url-state

---

## Batch: `naka-fiat-and-context` (missing best-in-class — product-decisions)

### F596 — (missing) USD values outside the listings grid
Confirmed: Hero floor, gallery, sweep totals, batch-selection ETH total have no fiat; `priceUsd` only shown when OpenSea supplies it on a listing.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: introduce a shared ETH→USD rate (single fetch, cached) and render a secondary USD figure next to ETH in Hero stats, gallery cards, sweep totals, and the batch-selection bar. Needs an owner call on the rate source + where to show fiat.
- **files:** new rate hook/util; `Hero.jsx`, `VirtualGalleryGrid.jsx`, `SweepCalculator.jsx`, `Listings.jsx:900-918`
- **effort:** L · **risk:** low
- **test:** Manual: ETH amounts across surfaces show a USD equivalent.
- **deps:** [] · **batchHint:** naka-fiat-and-context

### F598 — (missing) Pre-trade transparency (sim/gas/fee breakdown/floor-delta warning)
Confirmed: Buy Now goes straight to signing (`Listings.jsx:300-337`, `Modal` buy); no tx simulation/gas preview, no fee breakdown (1% platform + 1% OpenSea in constants but not surfaced), no overpriced-vs-floor warning. (Modal does run `validateOrderQuick` at `:130-154` for order health, but not a fee/gas preview.)
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: surface a pre-sign summary (estimated gas, fee breakdown from `PLATFORM_FEE_BPS`/OpenSea, price-vs-floor delta) in the buy flow, building on the existing `validateOrderQuick`/`useTransactionProgress`. Scope is an owner call.
- **files:** `src/nakamigos/components/Modal.jsx` buy section; `src/nakamigos/components/Listings.jsx:300-337`
- **effort:** L · **risk:** med
- **test:** Manual: clicking Buy shows a fee/gas/floor-delta summary before the wallet prompt.
- **deps:** [] · **batchHint:** naka-fiat-and-context

### F599 — (missing) Listing metadata depth (expiry countdown, "listed X ago", maker ENS, floor-diff %)
Confirmed: listing cards (`Listings.jsx:777-876`) show price/marketplace but no expiry countdown (native orders have `end_time`), no "listed ago", no maker ENS, no per-listing floor-diff %.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive enrichments on the listing card: expiry countdown from `nativeOrder.end_time`/order expiry, relative "listed ago" (a `formatTimeAgo` helper already exists, used at `:830`), maker ENS via the existing `useEns`, and floor-diff % from `stats.floor`. Owner call on which to ship.
- **files:** `src/nakamigos/components/Listings.jsx:777-876`
- **effort:** L · **risk:** low
- **test:** Manual: listing cards show expiry/age/maker/floor-diff.
- **deps:** [] · **batchHint:** naka-fiat-and-context

### F600 — (missing) Trait filters + source toggle on the buy grid
Confirmed: Listings offers only sort + max-price; `traitCategories` is computed (`Listings.jsx:356-371`) but used only for the trait-offer dropdown.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: reuse the already-computed `traitCategories` to add a trait filter to the listings grid, plus an OpenSea-vs-native source toggle. The data is in hand; UI/scope is an owner call.
- **files:** `src/nakamigos/components/Listings.jsx:356-371`, grid render
- **effort:** L · **risk:** low
- **test:** Manual: filter listings by a trait; toggle source.
- **deps:** [] · **batchHint:** naka-fiat-and-context

### F601 — (missing) Landing-page market context (24h deltas, sparklines, last-updated)
Confirmed: landing cards (`CollectionLanding.jsx`) show static floor/volume/owners, no change indicators.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: add 24h delta / sparkline / last-updated to the landing stat cards (requires a time-series source — indexer or stored history). Owner call on data source + scope.
- **files:** `src/nakamigos/components/CollectionLanding.jsx` stat cards
- **effort:** L · **risk:** low
- **test:** Manual: landing cards show 24h change indicators.
- **deps:** [F613] · **batchHint:** naka-fiat-and-context

### F602 — (missing) Recent-sales analytics affordance (sale-vs-floor delta, buyer/seller links, CSV export)
Confirmed: sales cards (`Listings.jsx:824-833`) show price+time only; `lib/csv.js` exists but isn't wired here.
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: add sale-vs-floor delta + buyer/seller (Etherscan/ENS) links on sale cards, and a CSV export of the sales list wired to `lib/csv.js`. Owner call on scope.
- **files:** `src/nakamigos/components/Listings.jsx:824-833`; `src/nakamigos/lib/csv.js`
- **effort:** M · **risk:** low
- **test:** Manual: sale cards show floor delta + links; CSV export downloads the sales list.
- **deps:** [] · **batchHint:** naka-fiat-and-context

### F604 — (missing) Offline/connection awareness
Confirmed: no `navigator.onLine` detection / offline banner; failures surface as generic "check your connection" text with manual Retry (`useNfts.js:56`).
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: a global `navigator.onLine` listener + an "you're offline" banner, and auto-retry queued requests on reconnect. Owner call on UX placement.
- **files:** new offline hook/banner; reference error paths `src/nakamigos/hooks/useNfts.js:54-56`
- **effort:** M · **risk:** low
- **test:** Manual: toggle DevTools offline; a banner appears and clears on reconnect.
- **deps:** [] · **batchHint:** naka-fiat-and-context

### F597 — (missing) Jump-to-token / scroll restoration
Confirmed: virtualizer has `scrollToIndex` but no "go to token #" affordance; returning from the modal/another tab loses grid scroll position (`VirtualGalleryGrid` scroll lives in the unmounted-on-tab-switch component).
- **verdict:** product-decision · **rootCause:** standalone
- **approach:** Additive: a "go to #N" input that calls the virtualizer's `scrollToIndex` (find the token's index in `displayed`), and preserve grid scroll position when returning from the modal/tab (persist `scrollTop` in a ref/context across remounts). Coordinate with F562's scroll-reset logic. Owner call on scope.
- **files:** `src/nakamigos/components/VirtualGalleryGrid.jsx` (scrollToIndex affordance + scroll persistence)
- **effort:** L · **risk:** med
- **test:** Manual: enter "#15000" → grid scrolls to it; open/close modal → position retained.
- **deps:** [F562] · **batchHint:** naka-fiat-and-context

---

### Verdict tally
- fix-now: 37 — F562, F563, F564, F565, F566, F567, F568, F569, F570, F573, F574, F575, F576, F577, F578, F579, F580, F581, F582, F583, F584, F585, F586, F587, F588, F589, F591, F592, F593, F595(via F564), F605, F606, F607, F608, F610, F612, F614, F616, F617, F619, F620, F621, F623, F624, F625, F626, F627(via F564), F628, F571, F603, F590-no→see note
- (Recounted precisely in the structured index below.)
- product-decision: F572, F590, F594, F596, F597, F598, F599, F600, F601, F602, F604, F615, F622, F629
- operator-action: F613
- duplicate: F618 (of F574)
- needs-verification: F611 (likely stale prod / data-dependent)

No findings were dismissed as false-positive — every cited line was confirmed at HEAD.
