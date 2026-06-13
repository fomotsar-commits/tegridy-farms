# Remediation Plan — g12 Nakamigos Market (trade/offers/bids/cart/sweep/sniper + Seaport)

Surface verified at HEAD of `mvp-launch`. Each finding below was confirmed (or refuted) against the actual source. Findings that share one underlying fix carry the same `batchHint` and are grouped under a single batch header so they land in one commit.

Key cross-cutting root causes discovered while verifying:
- **The collection-offer price is the offer TOTAL, not per-item** (`fetchCollectionOffers` → `api-offers.js:116` maps `safePriceFromWei(o.price.value)` raw). This single bug is the root of both F639 (code) and F682 (the live crossed-order-book / "-4225% Healthy" nonsense). One normalization fix closes both.
- **Partial token loading poisons every rarity join.** `data/rarity.json` is an empty stub (`totalTokens: 0`); rarity exists only for the ~40 progressively-loaded tokens. This is the real root of F684 (sniper empty), F686 + F687 (analytics from 40 tokens), and F693 (contradictory rank). Seeding a shared rarity source closes the cluster.
- **No outlier clamp on any price axis** (F689) and **no trait-floor sanity cap** (F644 / F693 / F699) — one shared "robust valuation" guard fixes the headline-number absurdities.
- **The post-fill backend-notify `signMessage` sits OUTSIDE the inner try/catch** in three places (F631) — one wrap pattern fixes all three.
- **The Seaport cancel ABI ends in `totalOriginalConsiderationItems` instead of `counter`** in four copies (F630) — the correct pattern already exists in `trades.js:946` (`cancelTradeOnChain`).

---

## Batch: seaport-cancel-counter  (CRITICAL)

**Summary:** Four copies of the Seaport `cancel()` ABI end the `OrderComponents` tuple with `uint256 totalOriginalConsiderationItems` instead of `uint256 counter`. ethers fills the counter slot with the wrong field (or nothing for native orders), so the derived order hash never matches the signed order: the cancel tx mines (gas burned, phantom `OrderCancelled`), the UI optimistically removes the row + toasts success, but the listing/bid stays 100% fillable and reappears on next refresh. The repo already has the correct pattern in `lib/trades.js:946 cancelTradeOnChain` (ABI ends in `uint256 counter`, fetches live `getCounter(offerer)`, builds the components object explicitly).

### F630 — Seaport cancel encodes phantom order; real listing/bid stays live while UI reports success
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Extract one shared `cancelSeaportOrder(params, { protocolAddress, signer })` helper modeled verbatim on `cancelTradeOnChain` (trades.js:946-981): ABI tuple ending in `uint256 counter`, fetch `getCounter(offerer)` live, map `offer`/`consideration` to BigInt fields, set `counter`. Replace the four broken call sites (`api-offers.js:668` cancelOrder, `BidManager.jsx:279` cancelBid, `MyListings.jsx:353`, `OrderBookPanel.jsx:66`) with calls to it. Do NOT change the optimistic-UI/toast — it becomes correct once the cancel actually invalidates the order.
- **files:** `src/nakamigos/lib/orderbook.js` (new shared helper, sibling to createNativeListing), `src/nakamigos/api-offers.js:668-677`, `src/nakamigos/components/BidManager.jsx:278-288`, `src/nakamigos/components/MyListings.jsx:352-357`, `src/nakamigos/components/OrderBookPanel.jsx:65-71`
- **effort:** M
- **risk:** med (touches every cancel path; mitigated by reusing a proven helper)
- **test:** Add a unit test (extend `api-offers.test.js`) that derives the order hash from the components object via `ethers.TypedDataEncoder.from(SEAPORT_ORDER_TYPES).hash(components)` and asserts it equals the stored `order_hash`/`seaportOrderHash` for a fixture OpenSea order AND a fixture native order. Manual: list, cancel, confirm the row does NOT reappear on the 30s refresh.
- **deps:** []
- **batchHint:** seaport-cancel-counter

---

## Batch: notify-sign-swallow  (HIGH)

**Summary:** After `fulfillOrder` confirms on-chain, a second informational `signMessage` notifies the backend. In three places that `signMessage` is OUTSIDE the inner try/catch, so a user rejecting the (already-settled) notify prompt makes a CONFIRMED purchase/trade report as "cancelled by user." Consumers then mislead: ShoppingCart `break`s and leaves the now-owned item in the cart; TradesPanel silences and never refreshes. The backend already self-heals (pre-flight `getOrderStatus`), so the prompt is non-critical.

### F631 — Rejecting the post-success notify signature makes a confirmed trade/buy report as cancelled
- **verdict:** fix-now
- **rootCause:** T5
- **approach:** Wrap each post-success `signer.signMessage(fillMessage)` in its own try/catch that swallows rejection and still returns `{ success: true, hash }` (mirror the existing inner-try that already wraps the POST). Apply at `trades.js:602` (acceptTrade), `trades.js:889` (acceptOpenTrade), `orderbook.js:178` (fulfillNativeOrder). This makes the three outer catches (trades.js:618, trades.js:905, orderbook.js:215) unreachable for the notify-reject case. ShoppingCart's `break`-on-rejected (ShoppingCart.jsx:264) then only fires for a true pre-broadcast rejection.
- **files:** `src/nakamigos/lib/trades.js:602`, `src/nakamigos/lib/trades.js:889`, `src/nakamigos/lib/orderbook.js:178`
- **effort:** S
- **risk:** low
- **test:** Unit test (extend `trades.test.js`): mock `signer.signMessage` to reject AFTER `tx.wait()` resolves; assert the function returns `{ success: true }`, not `{ error: "rejected" }`. Manual: buy an item, reject the second wallet prompt, confirm the item is removed from cart and a success toast fires.
- **deps:** []
- **batchHint:** notify-sign-swallow

---

## Batch: bundle-listing-honesty  (HIGH)

**Summary:** Bundle listing is a fake flow — a 600ms `setTimeout` then a success-style toast and a full fee/"You Receive" breakdown, with no wallet interaction, no Seaport order, no API call. Direct contradiction of the honesty-pass mandate (commit 7639fdf).

### F632 — Bundle listing is a simulated success toast on a money surface
- **verdict:** product-decision
- **rootCause:** T4
- **approach:** Owner must choose: (A) gate the submit button behind an explicit "Coming soon" state (fast, honest, additive — keep the modal art), or (B) wire a real Seaport bundle order (one order with N ERC-721 offer items — `createNativeListing` in orderbook.js:229 has every building block: signer, getCounter, signTypedData, authMessage, POST). Until decided, do NOT ship the fake toast. If (A) is chosen it's an S fix; (B) is L. Default recommendation while unblocked: (A).
- **files:** `src/nakamigos/components/BundleListing.jsx:108-122` (handleSubmit), `:296-335` (fee/You-Receive block — keep as preview but disable submit)
- **effort:** S (gate) / L (real order)
- **risk:** low (gate) / high (new money path)
- **test:** Gate path: manual — open Bundle modal, confirm submit is disabled with a "Coming soon" affordance and no success toast fires. Real-order path: integration test asserting a multi-offer-item order is POSTed and verifiable on-chain.
- **deps:** []
- **batchHint:** bundle-listing-honesty

---

## Batch: cart-normalize-keys  (HIGH)

**Summary:** RaritySniper's "+ Cart" passes the raw `fetchListings` shape (no `id`/`name`/`image`) into `addToCart`. `CartContext.addToCart` dedupes on `String(nft.id)` (CartContext.jsx:24), so a second sniper-add no-ops on `"undefined"===" undefined"` and `removeFromCart(undefined)` clears all sniper items at once. ShoppingCart matches on `String(l.tokenId) === String(item.id)` (ShoppingCart.jsx:242), which never matches (`item.id` undefined) → every sniper item is flagged stale and `continue`-skipped ("no longer listed"). Sniper-added items are unbuyable by construction. Same class of bug breaks the global `c` shortcut (F695).

### F633 — Sniper "+ Cart" adds raw listings (no id) — blank render, dedupe collides, sweep always skips
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Normalize inside `CartContext.addToCart` (CartContext.jsx:22) to key on `nft.id ?? nft.tokenId` so any caller passing a listing or token is deduped correctly; AND in RaritySniper enrich the payload: `onAddToCart?.({ ...item.listing, id: item.tokenId, name: item.token.name, image: item.token.image })` (RaritySniper.jsx:333 — `item.token` and `item.tokenId` already exist, confirmed at :298). Normalizing in the context is the durable fix; the RaritySniper enrichment also fixes blank render.
- **files:** `src/nakamigos/contexts/CartContext.jsx:22-37`, `src/nakamigos/components/RaritySniper.jsx:333`
- **effort:** S
- **risk:** low
- **test:** Unit test (new) for `addToCart`/`removeFromCart` with an `{tokenId}`-only object: assert dedupe and removal key on tokenId. Manual: snipe → + Cart twice → cart shows one enriched row → Sweep buys it (not "no longer listed").
- **deps:** []
- **batchHint:** cart-normalize-keys

### F695 — Documented `c = add to cart` shortcut does nothing; trait-offer popover ignores Escape
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Two parts. (1) The `c` handler (App.jsx:464-476) looks the token up in `nfts.allTokens` (partial set — often misses listed cards) and fires NO toast on success. Change it to resolve from the `listings` array (full 786) and add an `addToast` confirmation like RaritySniper does (RaritySniper.jsx:334); reuse the F633-normalized `addToCart`. (2) The "Pick a trait" popover lacks Escape/outside-click dismissal — add a `keydown`/`mousedown` listener that closes it (mirror the dismissal pattern in `MakeOfferModal`/`WalletModal`).
- **files:** `src/nakamigos/App.jsx:464-476`, `src/nakamigos/components/Listings.jsx` (trait-offer popover state/handlers)
- **effort:** S
- **risk:** low
- **test:** Manual: focus a card with `j`, press `c`, confirm cart badge increments + toast. Open Trait Offer popover, press Escape and click outside — both dismiss.
- **deps:** [F633]
- **batchHint:** cart-normalize-keys

---

## Batch: collection-offer-per-item  (CRITICAL + MEDIUM)

**Summary:** `fetchCollectionOffers` (api-offers.js:111) returns `price = safePriceFromWei(o.price.value)`, which is the offer's TOTAL value, and captures `quantity` but never divides by it. Every consumer (OrderBookPanel best-bid + ladder, the standalone DepthChart, CollectionOffersPanel "BEST COLLECTION OFFER", `deriveTraitOffers`) renders that total as a per-item bid. A 4.52-WETH multi-quantity criteria offer shows as a 4.52 ETH "best bid" against the 0.1045 floor → the live crossed book, "Spread -4.4155 (-4225.4%)" labeled green "Healthy." This is one root fix plus a crossed-book guard.

### F682 — Order book nonsense: bestBid 4.52 vs bestAsk 0.1045, -4225% spread labeled "Healthy"
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Normalize to per-item price at the source in `fetchCollectionOffers` (api-offers.js:115-122): divide the total `price.value` by the offer's NFT quantity before mapping. NOTE/VERIFY: the captured `offer[0].startAmount` is the WETH wei amount, NOT the NFT count — the correct denominator is the consideration NFT count / remaining quantity from `protocol_data` (the live evidence 4.52/43≈0.105 matching the card's 0.1020 confirms a ~43-item offer). Confirm the exact field against one live multi-quantity offer, then divide. Separately, add a crossed-book sanity guard in `computeSpread` (DepthChart.jsx:34) and the OrderBookPanel spread (OrderBookPanel.jsx:424): if `bestBid > bestAsk`, mark health non-green and suppress the "narrow…healthy" insight (generateSummary, DepthChart.jsx:72-77) — a negative pct must never read green.
- **files:** `src/nakamigos/api-offers.js:115-122` (normalize), `src/nakamigos/components/DepthChart.jsx:34-42` (computeSpread guard), `src/nakamigos/components/DepthChart.jsx:72-77` (summary), `src/nakamigos/components/OrderBookPanel.jsx:424-425`
- **effort:** M
- **risk:** med (mis-identifying the quantity field would skew all bids — verify against a live offer first)
- **test:** Unit test (extend `api-offers.test.js`) with a fixture multi-quantity collection offer: assert normalized price = total/quantity. Manual: open Order Book on a live offer, confirm best bid ≤ floor and the spread reads a sane positive % (not green-Healthy when crossed).
- **deps:** []
- **batchHint:** collection-offer-per-item

### F639 — Collection/trait offer prices show offer TOTAL not per-item (quantity fetched, unused)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same root and same fix as F682 — normalize in `fetchCollectionOffers`. Once the source emits per-item price, CollectionOffersPanel (`:96`), `deriveTraitOffers` (`:138-148`), OrderBookPanel and DepthChart are all correct with no further change. Add a "×N" quantity badge (F680) in the same pass since `quantity` is already on the object.
- **files:** `src/nakamigos/api-offers.js:115-122` (shared with F682)
- **effort:** S (folded into F682)
- **risk:** low
- **test:** Covered by F682's unit test.
- **deps:** [F682]
- **batchHint:** collection-offer-per-item

### F680 — Collection-offer quantity display ("0.1 WETH ×10")
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Once F682 normalizes price, render a small "×{quantity}" badge beside the per-item price in CollectionOffersPanel (`:96`) and the OrderBookPanel bid ladder — `quantity` is already on the normalized object (api-offers.js:120). Additive, OpenSea-style.
- **files:** `src/nakamigos/components/CollectionOffersPanel.jsx:96-114`, `src/nakamigos/components/OrderBookPanel.jsx` (bid ladder rows)
- **effort:** S
- **risk:** low
- **test:** Manual: confirm a multi-quantity offer shows "Ξ0.10 ×N".
- **deps:** [F682]
- **batchHint:** collection-offer-per-item

---

## Batch: depth-chart-bid-cumulative  (MEDIUM)

**Summary:** The standalone `DepthChart.jsx` accumulates bid-side cumulative depth in ascending price order (`bucketPrices` accumulates low→high for both sides, lines 28-31), so the highest bid carries the largest cumulative — an inverted bid-depth curve. OrderBookPanel's embedded chart does it correctly (`bucketize(bidPrices,8).reverse()` then accumulate, OrderBookPanel.jsx:415-420). The two charts on the same Listings page disagree about the same bids.

### F638 — Bid-side cumulative depth accumulates ascending — inverted curve vs the sibling chart
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** In `DepthChart.jsx`, accumulate bid buckets from highest price down (mirror OrderBookPanel.jsx:415-420: reverse the bid buckets before the cumulative pass). Extract one shared `bucketizeAndCumulate(prices, side)` helper so the two charts can't drift again. Folds cleanly with the F682 normalization (both touch DepthChart).
- **files:** `src/nakamigos/components/DepthChart.jsx:15-32` (bucketPrices / bid cumulative), `:119-122`
- **effort:** S
- **risk:** low
- **test:** Unit test: feed bids [0.10, 0.09, 0.08]; assert cumulative at 0.10 = 1 (not 3). Manual: bid depth grows as price falls, matching the OrderBookPanel chart.
- **deps:** []
- **batchHint:** depth-chart-bid-cumulative

---

## Batch: robust-valuation-guard  (MEDIUM + LOW)

**Summary:** Deals trait floors are built from just the two lowest asks per trait (Deals.jsx:479-505) with no minimum cohort, no cap, no sales data; `discount = (maxTraitFloor - price)/maxTraitFloor` (Deals.jsx:572) has no clamp. One outlier ask (a 100 ETH or 18 ETH troll listing on a thin trait) makes every co-trait token a "90%+ deal" → the live "95% below / 18 ETH fair value / TOTAL SAVINGS 20.13 ETH" absurdities and the column literally labeled "Fair Value". Same outliers (up to ~1650 ETH) blow every linear price axis (scatter Y `Math.max(...ys)*1.1` at Deals.jsx:264; floor-depth histogram in SweepCalculator; ask ladder). `valuation.js` already caps at 5× for exactly this reason.

### F644 — "Fair Value"/"Total Savings" gameable by a single outlier ask (no sample-size or cap)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Additive guardrails in `traitFloorData`/deals memo (Deals.jsx:479-591): require ≥3 listings sharing a trait before that trait floor counts toward `maxTraitFloor`; cap `maxTraitFloor` at `min(traitFloor, 5 × collectionFloor)` (reuse the 5× cap convention already in `lib/valuation.js`); relabel the column header "Fair Value" → "Trait floor" (Deals.jsx:901) and "Total Savings" → "Est. savings (trait-floor)" (Deals.jsx:788). Optionally badge low-confidence (cohort <3) rows. Keep the scanner art/table intact.
- **files:** `src/nakamigos/components/Deals.jsx:479-505` (cohort count), `:559-572` (cap + discount), `:788` (label), `:901` (header)
- **effort:** M
- **risk:** med (changes which rows qualify as deals — verify legit 20-50% finds survive)
- **test:** Unit test for the deals memo with a one-outlier trait: assert it does NOT produce a 95% deal; assert a genuine 3-cohort 30% deal still appears. Manual: confirm no >90% "deal" with an 18 ETH fair value.
- **deps:** []
- **batchHint:** robust-valuation-guard

### F699 — Fair-value outliers produce unbelievable headline claims (95% off, 18 ETH, 20.13 ETH savings)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same fix as F644 (cohort ≥3 + 5× cap + relabel). This is the live manifestation of the F644 code bug; no separate work.
- **files:** `src/nakamigos/components/Deals.jsx:479-591` (shared with F644)
- **effort:** S (folded into F644)
- **risk:** low
- **test:** Covered by F644.
- **deps:** [F644]
- **batchHint:** robust-valuation-guard

### F689 — Outlier troll listings (~1650 ETH) destroy every linear price axis
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Clamp chart domains at p95 of the listing prices (or `floor × 3`) with a "+N outliers" annotation, applied to the Deals scatter Y-domain (Deals.jsx:264 `Math.max(...ys)*1.1`), the SweepCalculator floor-depth histogram (`buildPriceTiers` / axis, SweepCalculator.jsx:18-31), and the OrderBookPanel ask-ladder buckets. Extract one `clampDomain(values, {pct:0.95})` helper. Additive — does not hide outlier rows from the table, only the axis.
- **files:** `src/nakamigos/components/Deals.jsx:261-264`, `src/nakamigos/components/SweepCalculator.jsx:18-31` + axis render, `src/nakamigos/components/OrderBookPanel.jsx` (ask bucketize)
- **effort:** M
- **risk:** low
- **test:** Manual: with a 1650 ETH listing present, confirm the scatter/histogram/ladder spread the floor cluster across the axis and show "+N outliers".
- **deps:** []
- **batchHint:** robust-valuation-guard

### F693 — Two contradictory fair-value/rank models for the same token (deals vs modal)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Root is two divergent sources: the Deals table uses trait-floor valuation + runtime rank that refines as the scan progresses; the modal shows a different "Est. Fair Value"/rank. Pick ONE rank source and ONE valuation source for both surfaces, OR label them distinctly ("Trait-floor value" in Deals vs "Sale-history value" in the modal) so they aren't presented as the same number. Pairs with F710 (rank "~" marker) and the partial-rank cluster — once a shared rarity source exists (see naka-rarity-source batch), ranks stop drifting between surfaces.
- **files:** `src/nakamigos/components/Deals.jsx` (fair value + rank), `src/nakamigos/components/Modal.jsx` (Est. Fair Value + RANK)
- **effort:** M
- **risk:** med
- **test:** Manual: click a "32% below" deal; the modal's verdict and rank are consistent with (or clearly labeled as a different metric than) the table.
- **deps:** [F644]
- **batchHint:** robust-valuation-guard

---

## Batch: naka-rarity-source  (HIGH cluster)

**Summary:** `src/nakamigos/data/rarity.json` is an empty stub (`totalTokens: 0`). Rarity exists only for the ~40 tokens the app progressively loads, so every rarity join silently fails on the other 19,960 tokens. This is the shared root of the sniper-empty, analytics-from-40, and scatter-empty findings. Seeding a real per-token rank source (precompute server-side once — ranks are static for a fixed collection — into `rarity.json`, or share the Deals progressive-scan cache) closes the cluster.

### F684 — Rarity Sniper permanently empty ("0/0 — No listings available") while 786 listings exist
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Root is NOT "only ingests new listing events" (the suggestion is off — `listings` IS populated from the shared `useListings` query). The real bug: `opportunities` (RaritySniper.jsx:270-307) sets `hasRarity` true if ANY loaded token has a rank, then drops every listing whose token isn't in the 40-token `tokenMap` (`if (hasRarity && !hasRank) return null`, line 286). With partial token data, all 786 listed tokens get dropped → `opportunities.length === 0` → "No listings available." Fix: do NOT drop listings that lack loaded rarity — fall back to the price-only score path (line 294 already handles `!hasRank`) per-listing instead of globally gating on `hasRarity`. The durable fix is seeding `rarity.json` so ranks exist for all tokens.
- **files:** `src/nakamigos/components/RaritySniper.jsx:284-294`, `src/nakamigos/data/rarity.json` (seed), rank lookup in `api.js` normalizeToken
- **effort:** M
- **risk:** med
- **test:** Manual: open /sniper with listings loaded — confirm opportunities render (not 0/0). Unit test: opportunities with `hasRarity` true but a listed token absent from tokenMap still produces a price-scored row.
- **deps:** []
- **batchHint:** naka-rarity-source

### F686 — Trait/rarity analytics computed from only 40 of 20,000 tokens
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Share the seeded `rarity.json` (or a server-precomputed trait-count table — static for a fixed collection) so Analytics trait distribution and "Rarest Traits" use the full 20,000, not `tokens.length` loaded (Analytics.jsx:104,206,301,510). Keep the honest "X of N loaded" footnote ONLY while genuinely streaming; once precomputed counts exist, drop it.
- **files:** `src/nakamigos/components/Analytics.jsx:104,206,301,478,510`, `src/nakamigos/data/rarity.json`
- **effort:** M
- **risk:** low
- **test:** Manual: Analytics "Rarest Traits" shows real counts/percentages, not all "1 / 2.5%".
- **deps:** [F684]
- **batchHint:** naka-rarity-source

### F687 — "Rarity vs Price" scatter never renders ("Need at least 3 listed items with rarity data") despite 786 listings
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Same root: the scatter (RarityPriceScatter.jsx:694) needs ≥3 listed items WITH rank, but ranks only exist for the 40 loaded tokens. Once `rarity.json` is seeded (or the Deals rank cache is shared), the join succeeds — the listed tokens already have prices; they just need ranks. No separate logic needed beyond the shared rarity source + the join.
- **files:** `src/nakamigos/components/RarityPriceScatter.jsx:694` (and its rarity join), `src/nakamigos/data/rarity.json`
- **effort:** S (once F684/F686 land the rarity source)
- **risk:** low
- **test:** Manual: scatter renders points for listed tokens.
- **deps:** [F684]
- **batchHint:** naka-rarity-source

### F710 — Rank values silently shift while the scan runs, with no "approximate" marker in the table
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** With a seeded full-collection `rarity.json` ranks stop drifting. Until then (and as a belt-and-suspenders), suffix displayed ranks with "~" while `rankApproximate` is true (RaritySniper already exposes `isApproximate`, RaritySniper.jsx:265-267) and surface the same marker in the Deals rank cells. Additive copy only.
- **files:** `src/nakamigos/components/Deals.jsx` (rank cell), `src/nakamigos/components/RaritySniper.jsx` (already has isApproximate)
- **effort:** S
- **risk:** low
- **test:** Manual: during a scan, Deals ranks show "~#982"; after seed, no marker.
- **deps:** [F684]
- **batchHint:** naka-rarity-source

---

## Batch: snipe-score-residual  (MEDIUM)

### F645 — Snipe score saturates at 999 and is dominated by price index near the floor
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `computeSnipeScore` (RaritySniper.jsx:10-14) floors `priceScore` at 0.01 → `rarity×1000` capped at 999, so anything rarer than ~0.1% pins at 999 near the floor with arbitrary ties. Replace with a price-vs-expected residual from the rank-price regression the Deals ScatterPlot already computes (Deals.jsx:261-316), keeping the current formula as a fallback when <~10 listings exist. Pairs with naka-rarity-source (residual needs real ranks).
- **files:** `src/nakamigos/components/RaritySniper.jsx:10-14,270-307`
- **effort:** M
- **risk:** med (reorders the headline list)
- **test:** Unit test: two equally-cheap tokens of different rank get distinct, rank-ordered scores (no 999 tie).
- **deps:** [F684]
- **batchHint:** snipe-score-residual

---

## Batch: makeoffer-input-sanitize  (MEDIUM)

### F634 — Exponential notation ("1e-8") in the offer price crashes the modal via BigInt()
- **verdict:** fix-now
- **rootCause:** T6
- **approach:** The `type="number"` input (MakeOfferModal.jsx:275) accepts "e" notation; `price.split(".")` then `BigInt("1e-8")` (lines 290-292 and 308-310) throws inside the render IIFE → modal crash. Replace the manual BigInt math with viem `parseEther(price)` inside a try/catch (parseEther is already imported in api-offers.js), returning null on parse failure; and reject `e`/`E` in `onChange` (strip non-`[0-9.]`). Apply the same onChange guard to the BulkListingWizard ladder inputs (BulkListingWizard.jsx:241,258) which share the pattern.
- **files:** `src/nakamigos/components/MakeOfferModal.jsx:281,290-292,308-310`, `src/nakamigos/components/BulkListingWizard.jsx:242,259`
- **effort:** S
- **risk:** low
- **test:** Unit/manual: type "1e-8" and "2e3" — modal does not crash, shows a validation hint. Type "0.5" — works.
- **deps:** []
- **batchHint:** makeoffer-input-sanitize

---

## Batch: bulk-listing-pricing  (MEDIUM)

**Summary:** Two pricing modes in BulkListingWizard are broken/inverted.

### F635 — "Trait Floor" pricing is dead code (attr.traitFloor never populated → everything at floor)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `attr.traitFloor` (BulkListingWizard.jsx:138,501) is never set anywhere (normalizeToken maps only `{key,value}`). Feed the wizard the live trait-floor map the Deals page already computes (Deals.jsx:479-505) via a shared helper/prop, OR disable the "Trait Floor" mode with an explanatory tooltip until wired. Disabling is the safe minimal fix; wiring the real map is preferred and shares the F644 guardrails.
- **files:** `src/nakamigos/components/BulkListingWizard.jsx:133-143,501`, (optional) shared trait-floor helper extracted from `Deals.jsx:479-505`
- **effort:** M
- **risk:** med (mis-priced listings if the map is wrong)
- **test:** Manual: choose "Trait Floor" mode — a rare-trait token prices above collection floor (or the mode is visibly disabled with a tooltip).
- **deps:** []
- **batchHint:** bulk-listing-pricing

### F636 — Ladder pricing gives the RAREST NFT the START price (rarest lists cheapest with the suggested 0.10→0.50)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Ladder sorts rarest-first (rank 1 → i=0 → `start`, BulkListingWizard.jsx:148-152) but placeholders are START "0.10" / END "0.50" (lines 241,258), so the rarest lists cheapest. Either reverse the assignment (rarest gets END/highest) or relabel the inputs "Rarest item price" / "Most common item price" and swap placeholders (0.50 / 0.10). Show resulting min/max next to the rarest/commonest thumbnails for confirmation. Relabel is the lowest-risk fix.
- **files:** `src/nakamigos/components/BulkListingWizard.jsx:144-153,239-261,510-514`
- **effort:** S
- **risk:** low
- **test:** Manual: set ladder, confirm the rarest token gets the higher price (or the labels make the direction unambiguous).
- **deps:** []
- **batchHint:** bulk-listing-pricing

### F656 — Bulk listing = 2 wallet prompts per NFT (undisclosed); Escape closes the progress UI mid-flight
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Each `createNativeListing` signs EIP-712 (orderbook.js:323) + an auth message (orderbook.js:351) = ~2N prompts. Add "you will be asked to sign ~2× per item" to StepReview; gate the Escape handler on `!submitting` (BulkListingWizard.jsx:539 currently calls `onClose()` unconditionally — the backdrop and ✕ already check submitting). Optionally fold the auth message into the EIP-712 payload server-side to halve prompts (larger, defer).
- **files:** `src/nakamigos/components/BulkListingWizard.jsx:537-539` (Escape gate), StepReview disclosure block
- **effort:** S
- **risk:** low
- **test:** Manual: start a bulk submit, press Escape — progress UI stays; review step discloses the prompt count.
- **deps:** []
- **batchHint:** bulk-listing-pricing

---

## Batch: live-gas-estimate  (MEDIUM)

### F637 — Sweep gas estimate hardcodes 30 gwei (~30-300× too high at current basefees)
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** `estimateGas(count, gasPriceGwei=30)` (SweepCalculator.jsx:13-16) is only ever called as `estimateGas(effectiveCount)` — never with a live price; the ShoppingCart fallback uses the same stale `0.0045 // 150k*30gwei` constant (ShoppingCart.jsx:104). Reuse ShoppingCart's `provider.getFeeData()` path (ShoppingCart.jsx:111-118) — pass the live gwei into `estimateGas`, fall back to a clearly-labeled "rough estimate" only when no provider. Extract one `liveGasEstimate(count)` helper shared by both.
- **files:** `src/nakamigos/components/SweepCalculator.jsx:13-16,224,234`, `src/nakamigos/components/ShoppingCart.jsx:104,111-118`
- **effort:** S
- **risk:** low
- **test:** Manual: at ~0.2 gwei, EST. GAS shows ~0.0001 ETH not ~0.018; with no provider, labeled "rough estimate".
- **deps:** []
- **batchHint:** live-gas-estimate

---

## Batch: received-offers-filter  (MEDIUM)

### F640 — Expired/cancelled/finalized received offers show live Accept buttons
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `fetchReceivedOffers` (BidManager.jsx:355-382) sets `results.flat()` with no filter, while the sibling `fetchMyBids` (BidManager.jsx:345) already filters `!cancelled && !finalized && !expired`. Apply the identical filter to received offers and show `expiryColor`/timeLeft (already in the file). Accepting a dead offer otherwise walks into setApprovalForAll + a fulfillment_data error.
- **files:** `src/nakamigos/components/BidManager.jsx:368-375`
- **effort:** S
- **risk:** low
- **test:** Unit/manual: an expired offer fixture does not render an Accept button.
- **deps:** []
- **batchHint:** received-offers-filter

---

## Batch: trades-error-surface  (MEDIUM)

### F641 — TradesPanel API failure renders as "No active trades" (error discarded)
- **verdict:** fix-now
- **rootCause:** T11
- **approach:** `load()` destructures `{ trades: rows }` and ignores `error` (TradesPanel.jsx:414); `fetchTrades` returns `{ trades: [], error }` on failure (trades.js:422-426). Capture `error` into state and render the error-banner + Retry pattern MyCollection uses (MyCollection.jsx:362-367) instead of the empty state. Distinguishes outage from a genuinely empty inbox.
- **files:** `src/nakamigos/components/TradesPanel.jsx:411-419,502-511`
- **effort:** S
- **risk:** low
- **test:** Manual/mock: force fetchTrades to error — panel shows an error banner with Retry, not "No trades".
- **deps:** []
- **batchHint:** trades-error-surface

---

## Batch: offerpanel-refetch  (MEDIUM)

### F646 — OfferPanel poll resets to skeletons every 30s; accepts surface generic errors / stale lists
- **verdict:** fix-now
- **rootCause:** T5
- **approach:** `load()` calls `setLoading(true)` every interval tick (OfferPanel.jsx:16) → skeletons flash over real offers. Only show skeletons when `offers.length === 0` (keep previous data while refetching). In `handleAccept` pass `result.message` through `getFriendlyError` instead of the generic toast (OfferPanel.jsx:48 — acceptOffer returns precise messages), and call `load()` after a successful accept so the filled offer disappears immediately.
- **files:** `src/nakamigos/components/OfferPanel.jsx:13-29,43-49`
- **effort:** S
- **risk:** low
- **test:** Manual: with offers present, the panel does not flash skeletons on refresh; a failed accept shows the specific reason; an accepted offer disappears without waiting 30s.
- **deps:** []
- **batchHint:** offerpanel-refetch

### F692 — Modal Offers + Comparable Sales show skeletons that never resolve
- **verdict:** fix-now
- **rootCause:** T11
- **approach:** ComparableSales returns null when no sales (ComparableSales.jsx:59) but its `loading` can stay true if the fetch hangs (no timeout/finally guard); same flash class as OfferPanel. Ensure both fetches always settle `loading=false` in a `finally`, and render an explicit empty state ("No comparable sales in 30d" / "No other offers") instead of perpetual skeletons. Reuse the F646 keep-previous-data approach in the modal's OfferPanel instance.
- **files:** `src/nakamigos/components/ComparableSales.jsx:10,42-59`, `src/nakamigos/components/OfferPanel.jsx` (shared with F646)
- **effort:** S
- **risk:** low
- **test:** Manual: open a token modal with no comparable sales — shows "No comparable sales", not skeletons; with no offers — "No other offers".
- **deps:** [F646]
- **batchHint:** offerpanel-refetch

---

## Batch: wallet-inventory-pagination  (MEDIUM)

### F647 — Wallet inventory silently truncated at 100 NFTs across every trade/list surface
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `fetchWalletNfts` (api.js:598-614) requests `pageSize:"100"` and never follows the Alchemy `pageKey`. Loop pageKey until exhausted (cap ~500, mirroring the MAX_MY_PAGES convention) OR return `totalCount` and have callers show "showing first 100 of N" with a load-more when `totalCount > tokens.length`. Looping is the durable fix; all four consumers (TradeWindow, OpenTradeAccept, MyCollection, BidManager) inherit it for free.
- **files:** `src/nakamigos/api.js:598-614`
- **effort:** M
- **risk:** med (more Alchemy calls for whales — cap pages)
- **test:** Unit/mock: a 150-NFT owner returns >100 tokens (capped). Manual: a whale can select tokens beyond #100.
- **deps:** []
- **batchHint:** wallet-inventory-pagination

### F654 — My Bids fetch is unpaginated (heavy bidders see a truncated list)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Partly valid: BidManager.fetchMyBids (BidManager.jsx:336-341) calls `openseaGet(...offers...)` once with no cursor (the expiry/cancel filter at :345 IS present, so only pagination is the gap). Reuse `fetchMyOffers` (api-offers.js:557-594) which already paginates up to 500 via MAX_MY_PAGES and normalizes+filters, instead of the bespoke single-page fetch.
- **files:** `src/nakamigos/components/BidManager.jsx:332-352`
- **effort:** S
- **risk:** low
- **test:** Mock: >50 open bids return all pages. Manual: heavy bidder sees the full list.
- **deps:** []
- **batchHint:** wallet-inventory-pagination

---

## Batch: sweep-validate-continue  (MEDIUM)

### F648 — Sweep and Deals buys skip the 3-layer pre-flight validation the cart runs
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** ShoppingCart runs `validateOrderFillability` and auto-removes reds before confirming (ShoppingCart.jsx:132-187); SweepCalculator.handleSweep (SweepCalculator.jsx:288-308) and Deals.handleBuy call fulfill* directly. Run `validateOrderQuick` (already written in `lib/orderValidator.js`) over the sweep list first, drop reds with a toast, and in SweepCalculator `continue` past per-item failures (currently `break`s at :306) the way ShoppingCart does.
- **files:** `src/nakamigos/components/SweepCalculator.jsx:288-308`, `src/nakamigos/components/Deals.jsx:640-674`
- **effort:** M
- **risk:** med (changes sweep control flow)
- **test:** Manual: include one stale listing in a sweep — it's dropped pre-flight (toast) and the rest still execute (no break).
- **deps:** []
- **batchHint:** sweep-validate-continue

---

## Batch: batch-fill-5792  (MEDIUM + missing)

### F642 — Sweeps are N sequential wallet txs — no Seaport batch fill, no EIP-5792 reuse
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** ShoppingCart (ShoppingCart.jsx:237-258) and SweepCalculator (SweepCalculator.jsx:288-293) loop `fulfill*` once per item. Batch native+OpenSea fills into one `fulfillAvailableAdvancedOrders` (already allowlisted in SEAPORT_FULFILLMENT_FUNCTIONS, api.js:13-14, skip-on-fail built in), OR at minimum wrap the sequential calls in the existing `tryAtomicBatch` (wallet_sendCalls) from trades.js:120-168 for 5792 wallets. Biggest UX/gas gap vs Blur/Gem.
- **files:** `src/nakamigos/components/ShoppingCart.jsx:237-258`, `src/nakamigos/components/SweepCalculator.jsx:288-293`, `src/nakamigos/lib/orderbook.js` (batch-fill wrapper)
- **effort:** L
- **risk:** high (new fill path on a money surface — verify skip-on-fail + refunds)
- **test:** Integration: a 3-item sweep settles in one confirmation on a 5792 wallet; non-5792 falls back to sequential.
- **deps:** []
- **batchHint:** batch-fill-5792

### F670 — True single-transaction sweep (missingVsBestInClass)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same scope as F642 — the missing-feature framing of the same gap. No separate work.
- **files:** (see F642)
- **effort:** L
- **risk:** high
- **test:** Covered by F642.
- **deps:** [F642]
- **batchHint:** batch-fill-5792

---

## Batch: offers-polling-visibility  (MEDIUM)

### F643 — BidManager received-offers polling storm (~21 OpenSea calls every 30s, bypasses cache)
- **verdict:** fix-now
- **rootCause:** T8
- **approach:** `fetchReceivedOffers` (BidManager.jsx:355-382) does fetchWalletNfts + fetchTokenOffers ×20 in parallel every 30s (interval at :430), bypassing the React Query offers cache (queryConfig.js:47-52 sets offers staleTime to 2min for exactly this rate-limit reason). Add a `document.hidden` skip to the interval (TradesPanel.jsx:424 already does this) and either lengthen the interval or move these into React Query with `offersQuery` so the cache is shared. The visibility skip is the minimal high-value fix.
- **files:** `src/nakamigos/components/BidManager.jsx:427-432`
- **effort:** S (visibility) / M (React Query move)
- **risk:** low
- **test:** Manual: background the tab — network panel shows the offer fetches pause.
- **deps:** []
- **batchHint:** offers-polling-visibility

---

## Batch: native-fee-honesty  (LOW + MEDIUM)

**Summary:** Stale "Save 0.5% vs OpenSea" / "OpenSea ~1.5%" / "vs OpenSea 2.5%" copy contradicts the standing decision (memory 2026-06-09: OpenSea fee is 1% now, don't market a fee discount) and `constants.js` (OPENSEA_FEE_BPS=100). Native fills also pay NO creator royalty — a material disclosure.

### F690 — Live stale fee claim "Save 0.5% vs OpenSea / OpenSea ~1.5%"
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** This is the live render of F649. Reframe additively to "flat 1% — fees fund the Tegridy treasury" (the framing orderbook.js:4-6 already prescribes) and disclose creator royalties are not collected on native fills. Change `OPENSEA_FEE_PCT = 1.5` (OrderBookPanel.jsx:16) and the "Save {savingsPerEth}%" badge (OrderBookPanel.jsx:208).
- **files:** `src/nakamigos/components/OrderBookPanel.jsx:16,208`
- **effort:** S
- **risk:** low
- **test:** Manual: Native Listings header shows "1% flat" parity messaging, no "Save 0.5%" badge.
- **deps:** []
- **batchHint:** native-fee-honesty

### F649 — "Save 0.5% vs OpenSea" badge built on an assumed ~0.5% royalty
- **verdict:** duplicate
- **rootCause:** T3
- **approach:** Same fix as F690 (code-level twin). One change to OrderBookPanel.jsx:16,208 closes both.
- **files:** `src/nakamigos/components/OrderBookPanel.jsx:16,208` (shared with F690)
- **effort:** S
- **risk:** low
- **test:** Covered by F690.
- **deps:** [F690]
- **batchHint:** native-fee-honesty

### F650 — Stale comment still claims "vs OpenSea 2.5%"
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** Fix the comment at orderbook.js:227 ("at 1% fee (vs OpenSea 2.5%)") so the next copy-paste doesn't resurrect the 2.5% claim — align with the corrected header (orderbook.js:4-6) and constants.js:143-144.
- **files:** `src/nakamigos/lib/orderbook.js:227`
- **effort:** S
- **risk:** low
- **test:** Grep confirms no "2.5%" remains in the orderbook lib.
- **deps:** []
- **batchHint:** native-fee-honesty

### F679 — Royalty/fee transparency table on the native orderbook (missingVsBestInClass)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Additive: add a small fee table on the Native Listings card stating "Platform fee 1% · Creator royalty 0% (not collected on native fills)". Reuses the F690 disclosure copy; folds into the same commit.
- **files:** `src/nakamigos/components/OrderBookPanel.jsx` (header fee table)
- **effort:** S
- **risk:** low
- **test:** Manual: the fee table renders the 1%/0% breakdown.
- **deps:** [F690]
- **batchHint:** native-fee-honesty

---

## Batch: retry-controller-scope  (LOW)

### F653 — fetchNativeListings retry shares one 15s AbortController and clears the timeout after attempt 1
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `controller`+`timeout` are created once OUTSIDE `withRetry` (orderbook.js:40-41); `clearTimeout` runs inside the first attempt (line 45) even on `!res.ok` retry, so retries 2-3 have no timeout, and a hung first attempt aborts all retries. Move the controller+timeout creation INSIDE the retried function (the pattern `postOrderbook` in trades.js:46-70 already gets right — per-attempt controller with finally clearTimeout).
- **files:** `src/nakamigos/lib/orderbook.js:40-55`
- **effort:** S
- **risk:** low
- **test:** Unit: mock a first-attempt non-ok then a slow second attempt — assert the second attempt still has a working 15s timeout.
- **deps:** []
- **batchHint:** retry-controller-scope

---

## Batch: cancel-all-single-sign  (LOW)

### F655 — Cancel All signs one backend message per listing after one incrementCounter tx (N popups)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** After `incrementCounter()` the loop signs+POSTs per listing (MyListings.jsx:430-451) → N surprise prompts; a mid-loop rejection half-syncs the DB. Sign ONE message covering all orderHashes (server verifies the list), OR have the server watch the `CounterIncremented` event and bulk-expire the rows with no client signatures (preferred — zero extra prompts). Requires a small `/api/orderbook` "bulk-cancel" action.
- **files:** `src/nakamigos/components/MyListings.jsx:425-454`, (API) `api/orderbook.js` bulk-cancel handler
- **effort:** M
- **risk:** med (server verification of the bulk message)
- **test:** Manual: Cancel All on 5 listings prompts once (or zero) and all rows clear.
- **deps:** []
- **batchHint:** cancel-all-single-sign

---

## Batch: counter-button-real  (LOW)

### F657 — "Counter" button just opens the token detail modal
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `handleCounter` (BidManager.jsx:474-478) only `onPick(resolveToken(...))` — no prefilled counter amount, silent no-op when the token isn't loaded. Open MakeOfferModal prefilled with the received offer's token + a suggested counter price (mirror the real counter flow TradesPanel.jsx:430-435 has), and disable the button with a tooltip when `resolveToken` fails.
- **files:** `src/nakamigos/components/BidManager.jsx:474-478`
- **effort:** M
- **risk:** low
- **test:** Manual: Counter opens MakeOfferModal prefilled; on an unloaded token the button is disabled with a tooltip.
- **deps:** []
- **batchHint:** counter-button-real

---

## Batch: tx-progress-coverage  (LOW)

### F658 — Polished tx-progress overlay wired into 1 of 5 buy surfaces; speed-up fails silently; approve step never activates
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Only Modal.jsx uses TransactionProgress (Modal.jsx:127,652). Adopt the overlay (it accepts `onExecute`) for cart/sweep/deals/orderbook buys; toast on speed-up failure (TransactionProgress.jsx:623-625 currently console.warn-swallows); fix the APPROVE step that latches COMPLETED on `phase==='signing'` (TransactionProgress.jsx:734-737) to show an active "approving…" state; and have `onExecute` resolve at broadcast (return the tx, let PendingMonitor own confirmation) so the pending phase is real rather than cosmetic (fulfill* currently `tx.wait()` internally before returning).
- **files:** `src/nakamigos/components/TransactionProgress.jsx:623-625,734-737`, `ShoppingCart.jsx`/`SweepCalculator.jsx`/`Deals.jsx`/`OrderBookPanel.jsx` buy handlers
- **effort:** L
- **risk:** med (changes when fulfill* resolves — verify success/record paths)
- **test:** Manual: cart/sweep/deals/orderbook buys show the stepper; a speed-up failure toasts; the approve step animates.
- **deps:** []
- **batchHint:** tx-progress-coverage

### F678 — Surface the existing tx-simulation as a "Simulated ✓" badge on single buys (missingVsBestInClass)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** The staticCall/validation layer (orderValidator.js, used by the cart) is invisible on single buys. Run `validateOrderQuick` before a single buy and show a "Simulated ✓" badge in the Modal/Deals/OrderBookPanel buy CTA. Pairs with F648 (same validator). Additive trust signal.
- **files:** `src/nakamigos/components/Modal.jsx` buy CTA, `src/nakamigos/lib/orderValidator.js`
- **effort:** M
- **risk:** low
- **test:** Manual: a valid listing shows "Simulated ✓" before the buy prompt.
- **deps:** [F648]
- **batchHint:** tx-progress-coverage

---

## Batch: pending-tx-persistence  (LOW + missing)

### F669 — Sweep progress lost on reload — no pending-state persistence or resume
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Buying state is component-only (ShoppingCart.jsx:27-28,237-277); a mid-sweep reload orphans in-flight txs. Persist `{orderHash, txHash, status}` per attempt to localStorage (the `lib/transactions.js` infra exists) and reconcile on mount — the PendingMonitor logic (TransactionProgress.jsx:559-599) is reusable for reconciliation.
- **files:** `src/nakamigos/components/ShoppingCart.jsx:27-28,237-277`, `src/nakamigos/lib/transactions.js`
- **effort:** M
- **risk:** med
- **test:** Manual: start a sweep, reload mid-flight — the resume banner reconciles bought/pending items.
- **deps:** []
- **batchHint:** pending-tx-persistence

### F674 — Pending-transaction persistence/resume across reloads (missingVsBestInClass)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same scope as F669. No separate work.
- **files:** (see F669)
- **effort:** M
- **risk:** med
- **test:** Covered by F669.
- **deps:** [F669]
- **batchHint:** pending-tx-persistence

---

## Batch: usd-everywhere  (LOW + missing)

### F665 — No USD values anywhere on the trading surface
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Every price render is ETH-only; `priceUsd` is stubbed null (api.js:649) and never filled. Add one cached ETH/USD feed (Coingecko via the existing proxy, or a Chainlink read through the Alchemy RPC route) and a small `<Usd value={eth}/>` helper used beside cart totals (ShoppingCart.jsx:572-574), offer amounts (OfferPanel.jsx:104-106), Deals (929-937), and trade cash legs (TradeWindow.jsx:463-476).
- **files:** new `src/nakamigos/components/Usd.jsx` + a `useEthUsd` hook, `ShoppingCart.jsx`, `OfferPanel.jsx`, `Deals.jsx`, `TradeWindow.jsx`, `MakeOfferModal.jsx`
- **effort:** M
- **risk:** low
- **test:** Manual: cart/offer/deals show "≈ $X" beside ETH; the feed caches and degrades gracefully when offline.
- **deps:** []
- **batchHint:** usd-everywhere

### F671 — USD values beside every ETH amount (missingVsBestInClass)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same scope as F665. No separate work.
- **files:** (see F665)
- **effort:** M
- **risk:** low
- **test:** Covered by F665.
- **deps:** [F665]
- **batchHint:** usd-everywhere

### F708 — No USD or fee/gas breakdown in cart and offer modal; offer modal lacks floor/best-offer context
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Two-fold and additive: (1) add the `<Usd/>` helper + a marketplace-fee/royalty/gas line to the cart summary (ShoppingCart total at :572-574) and offer modal — reuse the F637 live-gas estimate and the F665 USD feed. (2) In MakeOfferModal add floor price, current best offer, and a "your offer is X% below floor" hint (data already available via fetchBestOffer / stats) — this also satisfies F673.
- **files:** `src/nakamigos/components/ShoppingCart.jsx:560-580`, `src/nakamigos/components/MakeOfferModal.jsx` (context block)
- **effort:** M
- **risk:** low
- **test:** Manual: cart shows USD + fee/gas line; offer modal shows floor/best-offer + below-floor %.
- **deps:** [F665, F637]
- **batchHint:** usd-everywhere

### F673 — Floor-relative context on bids ("92% of floor") in offer panels and MakeOfferModal (missingVsBestInClass)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Covered by the MakeOfferModal context block in F708. No separate work.
- **files:** (see F708)
- **effort:** S
- **risk:** low
- **test:** Covered by F708.
- **deps:** [F708]
- **batchHint:** usd-everywhere

---

## Batch: net-proceeds-preview  (LOW + missing)

### F666 — No net-proceeds preview when accepting an offer
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `handleAccept` (OfferPanel.jsx:31-55, BidManager.jsx:453-472) jumps straight to approval+fulfillment. Pre-compute net from the offer's consideration items (fees are explicit in `protocol_data`) and show a one-line "You will receive X WETH after fees" confirm before the approval tx — the revenue-after-fee pattern already exists for listings (MyListings.jsx:619-625).
- **files:** `src/nakamigos/components/OfferPanel.jsx:31-55`, `src/nakamigos/components/BidManager.jsx:453-472`
- **effort:** M
- **risk:** low
- **test:** Manual: accepting an offer shows the net-after-fee line before the wallet prompt.
- **deps:** []
- **batchHint:** net-proceeds-preview

### F672 — Net-proceeds preview when accepting an offer (missingVsBestInClass)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same scope as F666. No separate work.
- **files:** (see F666)
- **effort:** M
- **risk:** low
- **test:** Covered by F666.
- **deps:** [F666]
- **batchHint:** net-proceeds-preview

---

## Batch: trade-ens-identity  (LOW + missing)

### F667 — Trade counterparty input lacks ENS resolution and identity preview (scam vector)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** TradeWindow accepts only raw 0x (validCounterparty regex, TradeWindow.jsx:113-114); `hooks/useEns.jsx` exists but isn't used. Resolve ENS in the input (accept "name.eth"), and show a reverse-ENS + holdings/first-seen chip once an address validates — mitigates lookalike-address scams.
- **files:** `src/nakamigos/components/TradeWindow.jsx:289-301,113-114`, `src/nakamigos/hooks/useEns.jsx`
- **effort:** M
- **risk:** low
- **test:** Manual: type "vitalik.eth" — resolves + shows an identity chip; a lookalike address is visibly distinct.
- **deps:** []
- **batchHint:** trade-ens-identity

### F676 — ENS support + counterparty identity preview (missingVsBestInClass)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same scope as F667. No separate work.
- **files:** (see F667)
- **effort:** M
- **risk:** low
- **test:** Covered by F667.
- **deps:** [F667]
- **batchHint:** trade-ens-identity

---

## Batch: scanner-deeplinks-export  (LOW + missing)

### F668 — No deep links, sharing, or export for scanner results
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Deals rows (Deals.jsx:909-1006) and sniper rows (RaritySniper.jsx:484-527) only `onPick`. Add `?token=` deep links (the router exists) and an "Export CSV" button reusing `lib/csv.js exportCSV` (already wired in MyCollection.jsx:72-84). Additive.
- **files:** `src/nakamigos/components/Deals.jsx` (row link + export button), `src/nakamigos/components/RaritySniper.jsx`, `src/nakamigos/lib/csv.js`
- **effort:** M
- **risk:** low
- **test:** Manual: a deals row copies a shareable ?token= URL; Export CSV downloads the table.
- **deps:** []
- **batchHint:** scanner-deeplinks-export

### F675 — Per-row deep links and share/export from Deals and RaritySniper (missingVsBestInClass)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same scope as F668. No separate work.
- **files:** (see F668)
- **effort:** M
- **risk:** low
- **test:** Covered by F668.
- **deps:** [F668]
- **batchHint:** scanner-deeplinks-export

---

## Batch: price-history-column  (missing)

### F681 — Price-history sparkline / last-sale column in Deals and sniper tables
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `fetchTokenSalesHistory` already exists in api.js. Add a last-sale column (and optional sparkline) to the Deals and sniper tables, gated to avoid extra per-row fetches (batch or lazy on visible rows). Additive — also feeds the F644 valuation blend.
- **files:** `src/nakamigos/components/Deals.jsx` (table column), `src/nakamigos/components/RaritySniper.jsx`, `src/nakamigos/api.js` (fetchTokenSalesHistory)
- **effort:** M
- **risk:** low
- **test:** Manual: deals/sniper rows show last sale; no per-row request storm.
- **deps:** []
- **batchHint:** price-history-column

---

## Batch: trend-neutral-state  (MEDIUM)

### F688 — Trend labels contradict their numbers: "ACCUMULATING" at Net +0; "Accumulation phase" at 1.0:1
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** WhaleIntelligence (WhaleIntelligence.jsx:294 `buys >= sells ? "ACCUMULATING" : "DISTRIBUTING"`) and the Analytics buyer/seller card invent a bullish signal at parity. Add a NEUTRAL state ("Balanced flow") for net=0 / ratio≈1, and only show ACCUMULATING/DISTRIBUTING beyond a ± threshold (e.g. >10% imbalance). Apply to both surfaces.
- **files:** `src/nakamigos/components/WhaleIntelligence.jsx:279-294`, `src/nakamigos/components/Analytics.jsx` (buyer/seller phase)
- **effort:** S
- **risk:** low
- **test:** Manual: 13 vs 13 / Net +0 reads "Balanced flow", not ACCUMULATING.
- **deps:** []
- **batchHint:** trend-neutral-state

---

## Batch: modal-image-fallback  (HIGH)

### F683 — NFT image never loads in token detail modal / theater (fallback "N #id" shown)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `NftImage` in `large` mode uses `primarySrc = nft.imageLarge || nft.image` (NftImage.jsx:68-69). When `imageLarge` is a broken full-res/IPFS URL, `handleError` jumps to the metadata API and can latch failed without ever trying the working `nft.image` thumbnail that the grid uses. Add a fallback step: in large mode, on error try `nft.image` (thumbnail) before the metadata API and before the placeholder — never show an empty pane when a thumbnail exists. NEEDS-VERIFICATION of the exact failing `imageLarge` value (live/prod issue; localhost was inconclusive per the finding) — confirm against a live token before finalizing.
- **files:** `src/nakamigos/components/NftImage.jsx:62-127`
- **effort:** S
- **risk:** low
- **test:** Manual (prod): open #10219 modal + theater — image renders (thumbnail at worst), never the bare "N" pane. Unit: large-mode with a failing imageLarge but valid image falls back to image.
- **deps:** []
- **batchHint:** modal-image-fallback

---

## Batch: wallet-modal-dedup-icons  (HIGH)

### F685 — Connect Wallet modal lists WalletConnect 3× and uses generic money-bag icons for Safe/Base/MetaMask
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `availableConnectors` is `connectors.map(...)` with no de-dup (WalletContext.jsx:70-78), so duplicate WC-based connectors render as identical rows; CONNECTOR_ICONS (WalletModal.jsx:6-13) lacks `safe`/`baseAccount` entries so they fall to the "💰" money-bag (WalletModal.jsx:152). De-dupe `availableConnectors` by a stable key (id + name) keeping the entry with a real `icon`, and add Safe/Base/Coinbase brand icons to the map (or rely on each connector's `c.icon`). Trust-critical surface — duplicates + generic icons read as phishing. NOTE: the duplicate WC connectors likely originate in the root wagmi/RainbowKit config — verify whether the dedup belongs there vs in `availableConnectors`.
- **files:** `src/nakamigos/contexts/WalletContext.jsx:70-78`, `src/nakamigos/components/WalletModal.jsx:6-22`
- **effort:** S
- **risk:** med (wallet selection is load-bearing — verify each remaining connector still connects)
- **test:** Manual: open Connect Wallet — exactly one WalletConnect row; Safe/Base/MetaMask show distinct brand icons; each connects.
- **deps:** []
- **batchHint:** wallet-modal-dedup-icons

---

## Batch: depth-chart-render-floor-delta  (MEDIUM)

### F694 — Analytics Depth Chart renders blank; floor 24h delta shows ↓35% with empty 1h/7d deltas
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** The blank depth box is the same outlier-domain problem as F689 (one 1650 ETH listing squashes everything to a corner) — the F689 p95 clamp fixes the render. Separately, the floor health card shows bare "%" glyphs for 1h/7d with no values and an implausible ↓35% 24h: hide delta rows when the baseline is missing/zero, and verify the 24h floor baseline source (a -35% day while the floor sat at ~0.1045 is a bad baseline, not a real move).
- **files:** `src/nakamigos/components/Analytics.jsx` (Depth Chart + floor delta card), shares the F689 clamp helper
- **effort:** M
- **risk:** low
- **test:** Manual: depth chart renders a real curve; 1h/7d show values or are hidden, not bare "%"; 24h delta is plausible.
- **deps:** [F689]
- **batchHint:** depth-chart-render-floor-delta

---

## Batch: splash-skippable  (MEDIUM)

### F696 — Click-to-enter splash (~10-14s) replays on every full load / deep link
- **verdict:** product-decision
- **rootCause:** T10
- **approach:** The replay-on-every-entry is INTENTIONAL per an explicit user request documented in App.jsx:138-142 ("the user asked that every entry to /nakamigos plays the splash"). So "remember per session" is a product-decision that conflicts with that standing instruction — surface to owner. However two improvements are safe and additive and do NOT remove the art: (1) make the splash click/key-skippable from second 0 (the splash already renders CLICK TO ENTER at SplashScreen.jsx:1381 — allow the skip handler immediately rather than after the ~12s animation), and (2) optionally auto-skip for deep links via a query param. Recommend shipping (1) now (S, low-risk) and asking the owner about (2)/session-memory.
- **files:** `src/nakamigos/components/SplashScreen.jsx:1288-1381` (early skip handler), `src/nakamigos/App.jsx:138-163` (optional deep-link/session gate — owner decision)
- **effort:** S (skippable) / M (session/deeplink gate)
- **risk:** low
- **test:** Manual: clicking/pressing a key during the animation enters immediately; the art is unchanged.
- **deps:** []
- **batchHint:** splash-skippable

---

## Batch: trade-gates-preview  (MEDIUM)

### F697 — Two near-identical connect-gated tabs ("Trade" and "P2P Trades") with no preview
- **verdict:** product-decision
- **rootCause:** T7
- **approach:** Owner choice on merge-vs-differentiate (builder vs inbox). Additive, non-decision part: show a read-only mock of the two-sided trade window (disabled controls) + a feed of recent public trades behind the gate (Trader.xyz/Sudoswap-style). Pairs with F705 (shared gate component) and F698 (public bid book). The copy differentiation needs an owner call; the preview is safe to build.
- **files:** `src/nakamigos/components/TradeWindow.jsx` (read-only preview mode), `src/nakamigos/components/TradesPanel.jsx` (gate copy)
- **effort:** M
- **risk:** low
- **test:** Manual: logged-out /trade shows a disabled builder preview + recent public trades.
- **deps:** []
- **batchHint:** trade-gates-preview

### F698 — No public collection bid book for logged-out users
- **verdict:** fix-now
- **rootCause:** T7
- **approach:** /bids is a pure connect wall though the data exists (Listings page already renders the COLLECTION OFFERS ladder). Show the collection-wide bid ladder (Blur-style bid wall: price × quantity × bidders) on /bids for everyone, gating only the "manage MY bids" half behind connect. Reuse CollectionOffersPanel + the F682 per-item normalization.
- **files:** `src/nakamigos/components/BidManager.jsx` (public bid-wall section above the connect gate), reuse `CollectionOffersPanel.jsx`
- **effort:** M
- **risk:** low
- **test:** Manual: logged-out /bids shows the public bid ladder; "manage my bids" stays gated.
- **deps:** [F682]
- **batchHint:** trade-gates-preview

### F705 — Six connect-gates share one visual with no demo/preview affordance
- **verdict:** product-decision
- **rootCause:** T7
- **approach:** Owner call on a "Preview with demo wallet" link rendering the real components with sample data (converts better than a wall, exercises gated code paths). Additive. Coordinate with F697/F698 so the gates share one improved component. Surface to owner before building the demo-data path.
- **files:** shared gate component used by trade/trades/portfolio/bids/my-listings/history
- **effort:** M
- **risk:** low
- **test:** Manual: a gate offers a demo-data preview that renders the connected layout.
- **deps:** [F697]
- **batchHint:** trade-gates-preview

---

## Batch: collection-offers-responsive  (LOW)

### F659 — CollectionOffersPanel fixed two-column grid has no mobile breakpoint
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `gridTemplateColumns: "1fr 1fr"` (CollectionOffersPanel.jsx:77) with no media query — ~150px columns on iPhone. Change to `repeat(auto-fit, minmax(260px, 1fr))` so columns stack on narrow viewports (project_responsive mandate).
- **files:** `src/nakamigos/components/CollectionOffersPanel.jsx:77`
- **effort:** S
- **risk:** low
- **test:** Manual at iPhone 14 width: the two columns stack, no awkward wrapping.
- **deps:** []
- **batchHint:** collection-offers-responsive

---

## Batch: market-viz-a11y  (LOW)

### F660 — Canvas/SVG market visualizations are mouse-only (no keyboard/screen-reader path)
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** Deals ScatterPlot canvas (Deals.jsx:390-395) and DepthChart tooltip (DepthChart.jsx:263) expose data only via mouse. Add `role`/`aria-label` summaries (the DepthChart already builds an auto-summary string — link it via `aria-describedby`) and a visually-hidden `<table>` of the deal/depth points. The in-repo pattern exists (TradeWindow tiles use role=checkbox + tabIndex + keydown, TradeWindow.jsx:52-55).
- **files:** `src/nakamigos/components/Deals.jsx:390-395`, `src/nakamigos/components/DepthChart.jsx:263` + a visually-hidden data table
- **effort:** M
- **risk:** low
- **test:** Screen-reader/keyboard: the chart announces a summary and a data table is reachable.
- **deps:** []
- **batchHint:** market-viz-a11y

---

## Batch: misc-polish  (POLISH + LOW)

### F661 — MyListings floor-distance printed twice per row in two formats
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** MyListings.jsx:603-605 ("+12.3% from floor", toFixed(1)) and :612-616 ("12% above floor", Math.round) show the same fact two ways that can disagree after rounding. Keep one (the health badge already encodes it) and make the second row additive (e.g. expiry date).
- **files:** `src/nakamigos/components/MyListings.jsx:603-616`
- **effort:** S
- **risk:** low
- **test:** Manual: each row shows floor-distance once.
- **deps:** []
- **batchHint:** misc-polish

### F662 — Deals "Click to refresh view" badge doesn't refresh anything
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Deals.jsx:800-806 onClick only resets the count + scrolls; deals recompute reactively (useMemo at :527). Change copy to "N new deals — jump to top" (it already does the jump). Optionally hold new rows out until clicked for true Dexscreener-style pause (defer).
- **files:** `src/nakamigos/components/Deals.jsx:800-806`
- **effort:** S
- **risk:** low
- **test:** Manual: badge copy matches its action.
- **deps:** []
- **batchHint:** misc-polish

### F663 — var(--border) used as card BACKGROUND token
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** BidManager styles.card `background: "var(--border)"` (BidManager.jsx:55) and TransactionHistory.jsx:128 use the border-color token as surface fill. Switch to `var(--surface-glass)`/`var(--card)` to match TradesPanel cards so theme border changes don't silently restyle these.
- **files:** `src/nakamigos/components/BidManager.jsx:55`, `src/nakamigos/components/TransactionHistory.jsx:128`
- **effort:** S
- **risk:** low
- **test:** Manual: cards use the surface token; toggling theme doesn't change their fill unexpectedly.
- **deps:** []
- **batchHint:** misc-polish

### F664 — ShoppingCart/SweepCalculator hover via onMouseEnter style mutation instead of CSS classes
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** ShoppingCart.jsx:407-408,518-527,769-770,789-796 mutate `e.currentTarget.style` on hover — bypasses the CSS layer (no touch/focus-visible/reduced-motion). Move to the existing class-based hover patterns (`listing-card-actions` et al. in App.css) for free `:focus-visible` parity.
- **files:** `src/nakamigos/components/ShoppingCart.jsx:407-408,518-527,769-770,789-796`, `src/nakamigos/App.css` (reuse classes)
- **effort:** M
- **risk:** low
- **test:** Manual: hover + keyboard focus both show the state; reduced-motion respected.
- **deps:** []
- **batchHint:** misc-polish

### F706 — Microcopy nits (title casing, stray leading hyphen, theater label repeated)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Humanize route-derived `document.title` ("My-listings" → "My Listings"), drop the dangling "- " separator when the collection name is absent in the modal owner row, and dedupe the theater bottom-bar "#10219 #10219" label.
- **files:** `src/nakamigos/App.jsx` (title), `src/nakamigos/components/Modal.jsx` (owner row), `src/nakamigos/components/TheaterMode.jsx` (label)
- **effort:** S
- **risk:** low
- **test:** Manual: title reads "My Listings"; no stray hyphen; theater shows one "#id".
- **deps:** []
- **batchHint:** misc-polish

### F702 — Whale profile drawer ignores Escape; expanded holder grid lazy-loads blank cells
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** Add Escape/overlay-click close to the holder profile drawer (WhaleIntelligence — reuse the WalletModal keydown pattern), and a shimmer placeholder in the holder-grid cells while thumbnails lazy-load (NftImage's `pending`/pulse path already exists, NftImage.jsx:132-136 — pass `noSelfFetch` for batch-loaded cells).
- **files:** `src/nakamigos/components/WhaleIntelligence.jsx` (drawer close + grid cell placeholder)
- **effort:** S
- **risk:** low
- **test:** Manual: Escape/overlay closes the drawer; grid cells shimmer instead of showing blank.
- **deps:** []
- **batchHint:** misc-polish

### F707 — Theme toggle only swaps accent colors (no light theme); header layout jumps on scroll
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** The moon/sun toggle re-tints accents but there is no light theme (background stays dark). Owner choice: either implement a real light theme OR swap the moon/sun icon for a palette icon to set accurate expectations. Separately, the header collapses 2-row→1-row on scroll, moving nav targets hundreds of px — consider pinning the header to one layout to keep click targets stable (additive CSS). Surface the theme decision to owner; the header-stability fix is safe to do now.
- **files:** `src/nakamigos/contexts/ThemeContext.jsx` + theme tokens (owner decision), `src/nakamigos/components/Header.jsx` (pin layout)
- **effort:** M
- **risk:** low
- **test:** Manual: icon matches behavior; header doesn't reflow nav targets on scroll.
- **deps:** []
- **batchHint:** misc-polish

---

## Batch: rpc-llamarpc-dead  (LOW)

### F700 — eth.llamarpc.com returns 521 on repeated OPTIONS preflights
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Already DEMOTED to last in rpcProvider.js (line 15, with the 2026-06-11 comment) but still in the fallback list, so OPTIONS preflights keep 521-ing in the background. Remove llamarpc entirely OR add a one-time health-check before including it. Removing is the minimal fix. (Mitigated but not eliminated at HEAD.)
- **files:** `src/nakamigos/lib/rpcProvider.js:15`
- **effort:** S
- **risk:** low
- **test:** Manual: network panel shows no llamarpc 521s after load.
- **deps:** []
- **batchHint:** rpc-llamarpc-dead

---

## Batch: live-ticker-latch  (LOW)

### F701 — LIVE sales ticker intermittently renders empty (dot with no text)
- **verdict:** fix-now
- **rootCause:** T11
- **approach:** The header sales ticker clears mid-cycle, leaving the green dot with empty sale text before recovering. Keep the last rendered sale until the next one is ready (don't clear state between cycles) — guard the render against an empty/transient value. Likely in the header ticker component / `useActivityWebSocket` consumer.
- **files:** `src/nakamigos/components/Header.jsx` (ticker), `src/nakamigos/hooks/useActivityWebSocket.js` / `lib/eventFeed.js`
- **effort:** S
- **risk:** low
- **test:** Manual: watch the ticker for several minutes — it never shows a dot with empty text.
- **deps:** []
- **batchHint:** live-ticker-latch

---

## Batch: activity-filters-search  (LOW)

### F703 — Activity type filter is only All/Sale; search ignores the timeframe; stats don't react to search
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** ActivityFeed filter chips are 24h/7d/30d/All + All/Sale only (subtitle claims "Live on-chain transfers" but no Transfer/Mint/List types exist). Either drop the redundant All/Sale pair OR add real event types (listings/transfers/mints like OpenSea); scope search to the active window (or visibly switch to "all time" when searching) and recompute the header stats from the filtered set.
- **files:** `src/nakamigos/components/ActivityFeed.jsx` (filters, search scope, header stats)
- **effort:** M
- **risk:** low
- **test:** Manual: searching within 24h returns only 24h rows (or the window visibly switches); header stats match the visible rows.
- **deps:** []
- **batchHint:** activity-filters-search

---

## Batch: holder-distribution-honesty  (LOW)

### F704 — Top Holder Distribution histogram buckets are misleading (top-100 only → 1/2-5/6-10/11-25 always 0)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** The histogram is computed from the top 100 holders, so the small-position buckets are permanently 0 under a title implying full-collection distribution. Either compute the real full-holder distribution (5,212 owners) or retitle to "Top 100 holders by position size" and drop the four empty buckets. Retitle is the minimal honest fix.
- **files:** `src/nakamigos/components/Analytics.jsx` (holder distribution histogram) / `HolderAnalytics.jsx`
- **effort:** S
- **risk:** low
- **test:** Manual: the histogram title matches its data; no permanently-empty buckets under a misleading title.
- **deps:** []
- **batchHint:** holder-distribution-honesty

---

## Batch: tx-history-record-types  (LOW)

### F651 — TransactionHistory empty-state promises offers/bids, but only purchases are recorded
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Every `recordTransaction` caller uses `type:"buy"` only (Listings.jsx:324, Modal.jsx:435, OrderBookPanel.jsx:146, SweepCalculator.jsx:297, ShoppingCart.jsx:261, Deals.jsx:657); TYPE_LABELS for offer/bid/list/cancel (TransactionHistory.jsx:38-42) are dead. Either record "list" in createNativeListing/BulkListingWizard success, "offer/bid" in MakeOfferModal success, and "cancel" in the (now-fixed) cancel paths — OR soften the copy to "Purchases you make…" (TransactionHistory.jsx:103). Recording the real types is the better fix and reuses the existing TYPE_LABELS.
- **files:** `src/nakamigos/components/TransactionHistory.jsx:103`, `MakeOfferModal.jsx` / `BulkListingWizard.jsx` / cancel paths (recordTransaction calls), `src/nakamigos/lib/transactions.js`
- **effort:** M
- **risk:** low
- **test:** Manual: make an offer/list/cancel — they appear in history with the right label; or the empty-state copy matches reality.
- **deps:** [F630]
- **batchHint:** tx-history-record-types

---

## Batch: trades-empty-board-filter  (LOW)

### F652 — Board tab empty state shows inbox/outbox copy; status filter lacks "expired"
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** The empty-state ternary only branches on `direction === "incoming"` (TradesPanel.jsx:507-509), so "board" falls into the outgoing copy. Add a board branch ("Open trades anyone can accept will appear here — post the first one") and add an "expired" option to the status filter (TradesPanel.jsx:490 — STATUS_COLOR already styles expired at :198).
- **files:** `src/nakamigos/components/TradesPanel.jsx:490,506-510`
- **effort:** S
- **risk:** low
- **test:** Manual: empty board tab shows board copy + "Post to board" CTA; the filter offers "expired".
- **deps:** []
- **batchHint:** trades-empty-board-filter

---

## Batch: trade-notify-badge  (missing)

### F677 — Incoming-trade notification badge in global nav
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Trade polling exists only inside the TradesPanel tab; Blur surfaces an actionable count globally. Surface an incoming-trade count badge in the global nav (reuse the TradesPanel fetch / a lightweight count query), respecting `document.hidden` (per F643) to avoid a polling storm.
- **files:** `src/nakamigos/components/Header.jsx` / `MobileNav.jsx` (badge), shared trade-count hook
- **effort:** M
- **risk:** low
- **test:** Manual: a new incoming trade shows a nav badge; backgrounding the tab pauses polling.
- **deps:** [F643]
- **batchHint:** trade-notify-badge

---

## Batch: wash-trade-flagging  (LOW + missing)

### F709 — No wash-trade/self-sale flagging anywhere on the trading surface
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** ActivityFeed renders same-from-and-to sales (e.g. "0xf46a… → 0xf46a…") as normal sales and includes them in stats/price history (no detection found in ActivityFeed.jsx). Badge same-wallet and round-trip sales ("possible wash") and exclude them from avg-sale and price-history stats — table-stakes for a pro tool. Add a small `isWashSale(sale)` helper used by ActivityFeed + the stats/price-history aggregations.
- **files:** `src/nakamigos/components/ActivityFeed.jsx`, sales/price-history aggregation in `api.js` / `lib/eventFeed.js`
- **effort:** M
- **risk:** low
- **test:** Manual: a same-wallet sale is badged "possible wash" and excluded from avg-sale stats.
- **deps:** []
- **batchHint:** wash-trade-flagging
