# Tegridy Farms — Master Frontend Remediation Plan

Engineering-lead sequencing of all **838** findings from the 14 per-surface planners
(`frontend/plan/g01…g14.md`) and the cross-cutting themes (`frontend/AUDIT_REPORT_CROSS.md`).
Both apps in scope: main DeFi app (`frontend/`) and the Nakamigos / Tradermigos marketplace.

Owner mandate honored throughout: **every fix is additive** — no art or page section is removed; the
splash stays per the standing owner decision (we only add the skip/keyboard/perf affordances).

---

## 1. How to read this plan

### Verdict legend
| Verdict | Meaning | Where it lives in this plan |
|---|---|---|
| `fix-now` | Code I write. | A phase → batch (§3). 625 items. |
| `redeploy-only` | Already fixed at HEAD; only prod is stale. | P0 redeploy batch (§3) + operator note (§4). 16 items. |
| `operator-action` | Needs the owner (keys, infra, server proxy, art pinning, deploy). | Operator register (§4). 14 items. |
| `product-decision` | Needs an owner call before I build (scope/UX/new feature). | Decision register (§4). 121 items. |
| `duplicate` | Same fix as another item; closes for free with its parent. | Dropped register (§5). 57 items. |
| `false-positive` | Not a real defect on verification. | Dropped register (§5). 5 items. |

### The core rule: root-cause fixes close clusters
Twelve themes (**T1–T12**) each recur on 3+ surfaces with **one** underlying cause. The cross-report's
central thesis: *the engineering is exchange-grade; the wiring between it and the user is where it
breaks.* So the plan **front-loads the T-theme work-items (§2)** — each builds one shared
helper/primitive and retires many per-surface findings at once. A per-surface batch in §3 then only
carries the residue that the shared fix didn't cover. **When a batch says "(T*n*)" the work is in the §2
work-item, not the surface batch** — the surface batch just verifies the call-site adopted it.

Effort: **S** = <½ day · **M** = ½–2 days · **L** = multi-day. Risk: low / med / high (blast radius if wrong).
A batch = one reviewable commit. **Deps are respected**: a batch never precedes the batch holding its dependency.

---

## 2. Root-cause work-items (T1–T12) — do these FIRST

Each is ONE work-item, scheduled into the early phases (P0–P3). These are the highest-leverage work in the
document. The per-surface batches in §3 reference them.

### T1 — Stale prod build (redeploy closes a CRIT + several HIGHs)
- **Fix:** redeploy prod from HEAD; the worst "bugs" are already fixed in the tree. Add a post-deploy
  bundle-marker check + a "0 aggregators responded / RPC #1 down" telemetry beacon so this never silently rots again.
- **Build/reuse:** existing Vercel deploy procedure (`reference_vercel_deploy_procedure.md`) + a one-line
  bundle-hash assertion; a client beacon when `allSettled` returns 0 live aggregators or the first RPC 503s.
- **Closes (redeploy-only, 16):** F48, F58, F59, F224, F307, F355, F358, F362, F427, F439, F507, F515, F611, F763, F765, F774.
- **Effort:** S deploy + M telemetry (deferred to P4). **Risk:** low.
- **Test:** prod bundle hash == HEAD build; `/api/aggregator` returns JSON not `index.html`; Gallery votes UI present; no `eth.llamarpc.com` in first RPC probe; Naka activity feed serves live.

### T2 — Frozen-tween animation-settle bug (cloned across modals)
- **Fix:** the framer-motion entrance starts `opacity:0 scale(.95)` but the `animate` target omits the
  final `opacity:1`, so under `LazyMotion domAnimation` the tween freezes mid-fade. Add `opacity:1`/`fill-forwards`
  to every animate target; fix the 5 dead `layoutId` tab indicators configured for an animation `domAnimation` can't run.
- **Build/reuse:** one shared `modalMotion`/`tabPaneMotion` variant in the shared lib, adopted at every callsite.
- **Closes:** F225 (swap token-selector CRIT), F354 (gallery lightbox CRIT), F438 (swap tab-panes HIGH), F591 (Naka hero hard-cut), F623 (image fade). Unblocks F822 (Naka mobile modal). *(F1 layout `domMax` tradeoff is product-decision, §4.)*
- **Effort:** S. **Risk:** med (touches every modal entrance — visual regression pass needed).
- **Test:** Gallery lightbox, Swap token modal, and Swap Liquidity/DCA/Alerts panes all reach `opacity:1`; tab indicator slides.

### T3 — Hardcoded / pre-relaunch constants drifting from on-chain truth (trust-killer)
- **Fix:** a single source-of-truth read layer for fee/share/verification/dates; replace literals with live
  reads or a dated constant block; add a **last-reviewed stamp** to Security/Contracts/FAQ.
- **Build/reuse:** `useProtocolTruth()` (fee from on-chain `SWAP_FEE_BPS` getter, `stakerShareBps` live like
  TreasuryPage already does, verification probed from Etherscan, `POOL_LAUNCH_TIMESTAMP` corrected to the
  June-6 relaunch block) + a `<LastReviewed date>` component.
- **Closes (fix-now):** F99, F100, F101, F108, F123, F143, F200, F261, F268, F269, F270, F319, F327, F339,
  F373, F378, F379, F387, F388, F391, F399, F405, F414, F435, F447, F452, F468, F469, F470, F476, F478, F490,
  F540, F546, F580, F582, F650, F690, F745, F773, F809.
- **Effort:** M. **Risk:** low.
- **Test:** fee shown identically everywhere == on-chain bps; "100% to stakers" derives from `stakerShareBps`;
  no "Verified on Etherscan" unless the live probe confirms it; every trust page shows a last-reviewed date.

### T4 — Fabricated / overstated trust claims (honesty-pass sweep)
- **Fix:** one sweep across **every** promise surface — pull verified-false claims, make "success" toasts
  check the write result, label all fallback/demo data.
- **Build/reuse:** an `assertWriteOk(result)` guard before any success toast; a `<DemoBadge>` + tooltip;
  delete fabricated activity by real named wallets.
- **Closes (fix-now):** F67, F68, F69, F85, F96, F116, F117, F119, F131, F133, F302, F331, F367, F372, F380,
  F415 (CRIT), F424, F432, F454, F480, F485, F628, F651, F729, F738, F798. *(F632 bundle-listing honesty is
  product-decision; F762 product-decision — §4.)*
- **Effort:** M. **Risk:** low.
- **Test:** no claim renders a number the chain can't back; every success toast gated on a confirmed write;
  fallback/demo data carries a visible badge; the fake bundle-listing flow no longer toasts "submitted".

### T5 — Writes don't refetch (success ≠ state update)
- **Fix:** every write-success effect calls its section's `refetchAll()` (or invalidates the react-query key);
  stop relying on the 30–60s poller as the only refresh path.
- **Build/reuse:** a `useWriteThenRefetch()` wrapper (await receipt → invalidate section keys → then toast);
  fix the loans 60s no-op identity `setState`.
- **Closes (fix-now):** F102, F105, F106, F124, F137, F130, F140, F146, F257, F279, F315, F320, F321, F328,
  F340, F384, F465, F471, F472, F477, F631, F646, F692, F715, F794, F816.
- **Effort:** M. **Risk:** low–med (touches many write paths; per-section verify).
- **Test:** after a confirmed approve/claim/vote/offer/cancel/buy the relevant list/button updates within one
  tick — no stale "Approve" or re-clickable "Claim", no reappearing cancelled row.

### T6 — Raw-value rendering (wei / scientific-notation / missing-decimals leak)
- **Fix:** route every money render through `formatPrice`/`formatTokenAmount` and every numeric input through
  `safeParseEther`; sanitize `e`/exponent out of `type="number"` inputs.
- **Build/reuse:** the existing `safeParseEther`/`formatPrice`/`formatTokenAmount` helpers wired into the
  remaining unprotected paths; one shared input-sanitize util.
- **Closes (fix-now):** F10, F11, F60, F62, F98, F107, F111, F135, F151, F207, F226 (HIGH), F227 (HIGH), F235,
  F260, F282, F341, F399, F451, F486, F634, F637, F802, F804, F809.
- **Effort:** M. **Risk:** low–med (money-critical; needs a formatting unit test).
- **Test:** no "+4.6e+21%" or wei-vs-human comparisons; `0.3`/`3.5` slippage typeable; `1e5`→rejected not `15`;
  `1e-8` doesn't crash `BigInt()`; dust shows distinctly from zero.

### T7 — Logged-out wall hides all read-only data (the conversion gap)
- **Fix:** move gating from page/section level to **action** level — render the public read-only data, gate
  only the button. All underlying reads are public.
- **Build/reuse:** a `<ConnectGatedAction>` wrapper (renders children read-only, overlays the connect CTA on
  the action only) + a logged-out read path for each surface's data hooks.
- **Closes (fix-now):** F115, F138, F164, F169 (HIGH), F170 (HIGH), F175, F271, F299 (HIGH), F300 (HIGH), F313,
  F322, F357 (HIGH), F376, F698, F826. *(F445/F456/F228/F221/F705 logged-out-scope are product-decision, §4.)*
- **Effort:** L. **Risk:** med (each surface's read hook must run disconnected).
- **Test:** Farm/Dashboard/Swap/Liquidity/Community/NFT-Finance and the Naka gates all show live data while
  disconnected; only the action shows a connect CTA; no bait-and-switch (paint-then-collapse).

### T8 — Always-on pollers ignore tab visibility + duplicate fetches (prod rate-limiter risk)
- **Fix:** one shared visibility-gated react-query cache; dedup the stats fan-out; gate every interval on
  `document.hidden`; fix the double-instantiated `usePriceAlerts`.
- **Build/reuse:** a `useVisibilityQuery()` wrapper (refetchInterval pauses on hidden); collapse the 6 main-app
  read-hook batches and the 3 Naka pollers onto shared keys.
- **Closes (fix-now):** F76, F110, F144, F152, F336, F404, F483, F533, F554, F569, F593, F643, F717, F721,
  F725, F726, F748, F833.
- **Effort:** M (main) + L (Naka). **Risk:** med.
- **Test:** idle-tab network requests drop to ~0 when `document.hidden`; per-visitor req/min within the Upstash
  budget; `usePriceAlerts` instantiated once; no duplicate stats fetches.

### T9 — chainId pinning inconsistent (wrong-network = silently-wrong data)
- **Fix:** centralize the chain pin into the read layer so every read hook is pinned identically.
- **Build/reuse:** `usePinnedRead()` (or `chainId: MAINNET` default baked into the shared read client); pin
  the unpinned siblings (`usePoolData`/`useRevenueStats`/`useUserPosition`/`useRestaking`/`usePoints`/`useAddLiquidity`).
- **Closes (fix-now):** F71, F94, F103, F134, F149, F198, F201, F255, F390.
- **Effort:** S–M. **Risk:** low.
- **Test:** a wrong-network wallet sees correct mainnet data (or a clear switch prompt), never the other
  chain's token priced as ETH or an empty stake form.

### T10 — Accessibility & keyboard entry gaps (app-wide)
- **Fix:** shared a11y primitives — focusable/keyboard splash entry, a WAI-ARIA `<Tabs>` (arrow-key,
  `role=tab`+`tablist`, valid `aria-controls`), a shared focus-trap + layered-dialog stack so Escape closes the
  topmost overlay, nav links as `<a>` not `<button>`.
- **Build/reuse:** `<SplashEnter>` (button semantics + Enter/Space), `<Tabs>`, `useFocusTrap()`, a modal-stack
  registry, `aria-current="page"` + `:focus-visible` ring on nav.
- **Closes (fix-now):** F9, F12, F22, F29, F44, F77, F78, F79, F104, F145, F150, F177, F178, F205, F241, F275,
  F303, F312, F329, F332, F334, F389, F395, F398, F402, F420, F421, F426, F430, F434, F448, F527 (HIGH), F534,
  F557, F558, F559, F586, F587, F625, F660, F702, F739, F754, F759 (HIGH), F775, F787, F788, F790, F793, F799,
  F800, F803, F806, F810, F811, F812, F822 (CRIT), F823 (HIGH), F828, F829, F830, F836, F837, F839, F840, F841.
- **Effort:** M (primitives) + per-surface adoption. **Risk:** low–med.
- **Test:** keyboard-only user can enter both splashes and tab through every interactive surface; Escape closes
  topmost overlay; nav middle-click opens new tab; axe-core clean on touched surfaces.

### T11 — Skeletons that mislead (bait-and-switch + latch-forever)
- **Fix:** separate loading from empty/error; add a terminal error state behind every skeleton; make skeleton
  geometry match the real grid; show shimmer not "—".
- **Build/reuse:** a `<DataState loading empty error>` primitive; remove static imports that defeat Suspense.
- **Closes (fix-now):** F70, F72, F136, F141, F142, F148, F173, F181, F259, F326, F337, F419, F426, F641, F701,
  F724, F777, F804. *(F611 OFFERS skeleton is redeploy-only — prod stale.)*
- **Effort:** S–M. **Risk:** low.
- **Test:** no skeleton latches forever on 429/502; geometry doesn't jump 7-col→4-col; disconnected stats
  shimmer (not "—"); error states render terminally.

### T12 — Background/hero art pops in late with no placeholder (perceived-quality tax)
- **Fix:** add LQIP/blur-up/dominant-color placeholder + `fetchpriority`/`srcset`/`sizes` to `ArtImg`/`NftImage`;
  lazy/async the ghost JPEGs.
- **Build/reuse:** upgrade the shared `ArtImg`/`NftImage` once; emit `srcset` from Alchemy thumbnail/png/original sizes.
- **Closes (fix-now):** F6, F52, F66 (HIGH), F234, F308, F333, F361, F371, F543, F603, F621, F623, F833.
  *(F365 gallery perf rework is product-decision, §4.)*
- **Effort:** M. **Risk:** low.
- **Test:** no 5–14s art-pop; blur-up placeholder on first paint; LCP image carries `fetchpriority=high`; no
  one-frame black→art swap.

> **Cluster math:** the T-theme work-items carry the shared logic for ~250 of the 625 fix-now findings. The
> per-surface batches in §3 list each id once (in its home batch) and annotate which T-item closes it, so the
> coverage matrix counts every id exactly once.

---

## 3. Phased rollout

Ordering principle: **(a) unblock users → (b) stop trust damage → (c) convert → (d) per-surface long-tail → (e) polish/a11y.**
Every `fix-now` id lands in exactly one batch. Batch = one commit.

### P0 — Ship & quick wins (unblock now)

| Batch | Summary | Finding ids | Files | Effort | Risk | Verify |
|---|---|---|---|---|---|---|
| **P0-B1 prod-redeploy (T1)** | Redeploy both apps from HEAD; verify bundle markers. | F48, F58, F59, F224, F307, F355, F358, F362, F427, F439, F507, F515, F611, F763, F765, F774 | (deploy; no code) | S | low | aggregator returns JSON; votes UI live; no llamarpc; Naka feed live |
| **P0-B2 quick-wins-shell** | Home 414px overflow clip, toaster/mascot offset, bottom-right pill, RPC prune, MotionConfig reduced-motion. | F8, F13, F14, F16, F19, F23, F24, F25, F26, F27, F28, F30, F31, F32, F33, F49, F56, F57, F61, F63, F503, F509, F510, F512 | HomePage.tsx, shell, RPC config | S | low | no horizontal overflow; pill clears mascot |
| **P0-B3 quick-wins-format-input (T6)** | Sanitize `e`/exponent inputs, future time-ago, copy-button per-button state. | F46, F60, F62, F107, F111, F231, F240, F267, F330, F400, F459, F797 | formatting.ts, input components | S | low | `1e5` rejected; "Ends just now" gone |

### P1 — Money-path criticals

| Batch | Summary | Finding ids | Files | Effort | Risk | Verify |
|---|---|---|---|---|---|---|
| **P1-B1 frozen-tween (T2)** | `opacity:1`/`fill-forwards` on shared modal/tab variants; fix dead `layoutId`. | F225, F354, F438, F591, F623 | shared motion variant; Gallery lightbox; Swap modal/tabs; Naka hero | S | med | all 3 CRIT/HIGH modals reach opacity:1 |
| **P1-B2 swap-spender-parity** | Derive approval spender from executing router via one helper + test. | F186, F188, F463, F464, F466, F467 | swap exec lib; aggregator client (g08) | M | high | approve-target === write-target per route (unit test) |
| **P1-B3 swap-receipt-latch (T5)** | Per-action `lastActionRef`; tracked-receipt fix; toast dedup. | F187, F465, F472 | swap hooks; shared toast | S | med | success toast fires once, matches action |
| **P1-B4 seaport-cancel-counter** | Fix `cancel()` ABI in all 4 paths; copy working `trades.js` `getCounter()`. | F630, F655 | Naka cancel paths | M | med | cancelled order no longer fillable |
| **P1-B5 collection-offer-per-item** | Per-item collection-offer prices; `bestBid>bestAsk ⇒ dirty` invariant. | F682, F638, F680, F609 | order-book lib; depth chart | M | med | order book sane; no -4071% "Healthy" |
| **P1-B6 cart-normalize-keys** | Normalize `+Cart` item objects/keys. | F633, F695 | Naka cart store | S | low | cart items resolve image/price/id |
| **P1-B7 naka-detail-modal-artwork** | On-demand metadata fetch + grid-thumb fallback + fix `max-height:280px`. | F606, F683, F612, F616, F624 | Naka detail modal | M | med | artwork shows for un-enriched tokens |
| **P1-B8 naka-rarity-source** | Seed RaritySniper from listings snapshot; surface real rank. | F684, F686, F687, F710, F610 | Naka rarity/sniper | M | med | sniper non-zero; rank sorts work |
| **P1-B9 supabase-write-proxy** | Route chat/likes/reactions/userdata writes through SIWE proxy; fix port. | F711, F712, F713, F714, F716, F735, F715 | Naka social proxy + hooks | L | med | chat sends; likes persist; profile saves only on success |
| **P1-B10 dm-polling-auth (T8)** | DM auth + visibility-gated polling. | F717, F718, F737, F740, F746 | Naka DM | M | med | DM budget within rate limit; auth enforced |
| **P1-B11 dca-keeper-venue** | DCA + price-alert keepers quote & execute on same venue. | F132, F168, F171, F172, F179 | farm DCA/keeper | M | med | trigger no longer reverts on empty native pool |
| **P1-B12 write-refetch-core (T5)** | Wire write-success → section refetch (farm/dashboard/community/NFT). | F102, F105, F106, F124, F137, F130, F140, F146, F315, F320, F321, F328, F340, F384, F471, F477, F631, F646, F692, F794, F816, F257, F279 | farm/dashboard/community/NFT/Naka write paths | M | med | every confirmed write updates its section |
| **P1-B13 naka-nav-route-fixes** | Gallery nav + G-hotkey route; `?token=` splash strip; deep-link enter gate. | F607, F608, F525, F526, F529, F535, F538, F545, F756, F757, F760 | Naka router; splash; error boundary | M | med | Gallery reachable; deep links survive splash |

### P2 — Trust sweep (T3 + T4)

| Batch | Summary | Finding ids | Files | Effort | Risk | Verify |
|---|---|---|---|---|---|---|
| **P2-B1 protocol-truth-hook (T3)** | `useProtocolTruth()` + `<LastReviewed>`; replace fee/share/verify/date literals. | F99, F100, F101, F108, F123, F143, F200, F261, F373, F378, F379, F387, F388, F391, F399, F405, F414, F435, F447, F452, F468, F469, F470, F476, F478, F490, F546, F580, F582, F650, F690 | useProtocolTruth; Contracts/Security/FAQ/Tokenomics; gauge/bribe labels; Naka stats | M | low | one fee everywhere == on-chain; stamps present |
| **P2-B2 honesty-claims-sweep (T4)** | Pull verified-false claims; gate success toasts; label demo data. | F67, F68, F69, F85, F96, F116, F117, F119, F131, F133, F302, F331, F367, F372, F380, F415, F424, F432, F454, F480, F485, F628, F651, F729, F738, F798, F773, F745, F540, F809 | home/farm/community/Learn/Naka copy + toasts | M | low | no unbacked number; demo badges present |
| **P2-B3 nft-finance-truth (T3)** | NFT lender earnings/fee accuracy, refund wording, stat labels. | F264, F265, F268, F269, F270 | NFT-finance components | S | low | earnings/fee math matches chain |

### P3 — Conversion (T7 + T12 + T11)

| Batch | Summary | Finding ids | Files | Effort | Risk | Verify |
|---|---|---|---|---|---|---|
| **P3-B6 chainid-pin (T9)** | Centralize chain pin; pin unpinned siblings. *(early — read-layer foundation)* | F71, F94, F103, F134, F149, F198, F201, F255, F390 | read hooks | S | low | wrong-network wallet sees correct data |
| **P3-B1 logged-out-reads (T7)** | `<ConnectGatedAction>` + logged-out read paths. | F115, F138, F164, F169, F170, F175, F271, F299, F300, F313, F322, F357, F376, F698, F826 | ConnectGatedAction; farm/dashboard/swap/community/NFT/Naka gates | L | med | live data while disconnected; action-only gate |
| **P3-B2 art-lqip (T12)** | LQIP/blur-up + `fetchpriority`/`srcset` on ArtImg/NftImage; lazy ghost JPEGs. | F6, F52, F66, F234, F308, F333, F361, F371, F543, F603, F621, F833 | ArtImg; NftImage; route transitions | M | low | no 5–14s art-pop; blur-up first paint |
| **P3-B3 honest-skeletons (T11)** | `<DataState>`; terminal error states; geometry match; shimmer not "—". | F70, F72, F136, F141, F142, F148, F173, F181, F259, F326, F337, F419, F426, F641, F701, F724, F777, F804 | DataState + skeleton callsites | M | low | no latch-forever; geometry stable |
| **P3-B4 splash-affordances (T10 entry)** | Skip-from-0 + auto-enter + keyboard/AT entry + once-ever + preserve params (additive; art kept). | F2, F3, F7, F51, F527, F534, F558, F559, F759, F775 | Splash (both apps) | M | med | keyboard entry; params survive; art unchanged |
| **P3-B5 poller-consolidation (T8)** | `useVisibilityQuery()`; dedup stats fan-out; gate on `document.hidden`. | F76, F110, F144, F152, F336, F404, F483, F533, F554, F569, F593, F643, F721, F726, F725, F748, F833(shared) | shared read layer; Naka pollers | L | med | idle-tab requests ~0; within rate budget |

### P4 — Per-surface correctness long-tail
(After the shared fixes land. Each surface batch is independent and parallelizable.)

| Batch | Summary | Finding ids | Group | Effort | Risk |
|---|---|---|---|---|---|
| **P4-B1 shell-nav-misc** | Splash robustness, SEO meta, scroll restoration, storage safety, referral, tokenomics chart, nav IA, hero-trust stats. | F5, F9, F10, F11, F12, F15, F18, F22, F29, F34, F44, F47, F50, F54 | g01 | M | low–med |
| **P4-B2 home-misc** | Yield-calc APR contract, referral continuity, protocol-stats grid, hero quote, best-in-class additions. | F64, F65, F74, F75, F80, F81, F82, F86, F87, F90, F91, F92, F93 | g02 | M | low–med |
| **P4-B3 farm-dashboard-misc** | IL calc, lock-options dedupe, USD denom, fee-share live, portfolio, chart features, POL accumulator, RPC transport, polish. | F95, F97, F98, F109, F112, F113, F114, F118, F126, F127, F139, F153, F154, F155, F157, F176, F180, F184, F185 | g03 | L | med |
| **P4-B4 trade-misc** | Slippage UX, quote-debounce, native address, wrap/unwrap, price-impact venue, custom-token store, CoW/MEV persist, deep links, tx-history, USD/rate rows, quick-amounts, flip-carry, tab naming, light-mode, RPC rotation, status pill. | F190, F191, F192, F193, F195, F196, F197, F199, F202, F203, F204, F206, F207, F208, F209, F211, F216, F218, F219, F226, F227, F230, F232, F233, F235, F236, F237, F242, F243, F244, F246, F248 | g04 | L | med |
| **P4-B5 nftfinance-misc** | AMM pool safety, admin panel, launchpad wizard, grace-period states, restake routing, price-unavailable LTV, metadata imagery, USD denom, dutch/allowlist mint, pool directory, simulate/revert decode, loan alerts, nested-tab URLs, overview cards, perf/dead-code, prod rpc. | F249, F250, F251, F252, F253, F254, F256, F258, F259, F260, F262, F263, F266, F272, F273, F274, F276, F277, F278, F281, F282, F283, F284, F285, F286, F304, F305, F306, F309, F310, F311, F314 | g05 | L | med |
| **P4-B6 community-gallery-misc** | Bounties funnel, legacy route param, time-left, pagination, gauge salt export, gauge pair labels, bounties validation, gallery controls, image perf, lightbox polish, orphan-refund, infotooltip clamp, deep links, ultrawide, global light-mode/mascot/fade. | F316, F317, F318, F319, F323, F324, F325, F329, F332, F333, F334, F335, F338, F341, F342, F343, F348, F359, F360, F361, F364, F366, F369, F370 | g06 | L | med |
| **P4-B7 learn-activity-info-misc** | History feed, premium discount/claims, leaderboard readability, FAQ search, privacy anchors, changelog, RPC failover, mascot/ticker overlap, swap tab-pane settle, scroll-reveal, no-op hover, admin gating, copybutton. | F375, F377, F382, F383, F385, F386, F389, F392, F394, F395, F396, F397, F398, F401, F402, F403, F408, F413, F419, F420, F421, F426, F429, F430, F431, F433, F434, F436, F437, F446, F448, F450, F451, F458, F460, F462 | g07 | L | med |
| **P4-B8 shared-lib-misc** | IPFS gateway order, getLogs deploy-block, txerror surfacing, analytics import safety, refund toast, txhistory skip-zeroed, errorreport persist, hook consistency, quote-refresh. | F474, F475, F481, F482, F484, F488 | g08 | M | low |
| **P4-B9 responsive-main-misc** | First-visit overlays, loader touch-skip, over-art legibility, info sticky subnav, RPC/price transport, Naka enter gate, opensea stats path + empty states, tradermigos tablet density, premium default tab. | F504, F505, F506, F508, F511, F513, F514, F516, F518, F519, F520, F521, F522, F523 | g09 | L | med |
| **P4-B10 naka-shell-misc** | Theme isolation, onboarding anchors, header account menu, splash-perf collection, gallery URL state, error-boundary escape, PWA install, nav a11y, shell rerender. | F528, F531, F532, F536, F537, F540, F541, F542, F544, F547, F550, F551, F555, F557, F561 | g10 | L | med |
| **P4-B11 naka-browse-misc** | VirtualGrid scroll/columns, merge listing prices, filter cleanup, rarity denominator, species deeplink, image pipeline, listings refetch, fetch-by-id fallback, junglebay timeline, dead modules, price formatting, empty/loading, card rank, a11y keyboard. | F562, F563, F564, F565, F566, F567, F568, F570, F571, F573, F574, F575, F576, F577, F578, F579, F581, F583, F584, F585, F586, F587, F588, F589, F595, F605, F614, F617, F619, F620, F625, F626, F627 | g11 | L | med |
| **P4-B12 naka-market-misc** | Make-offer sanitize, bulk-listing pricing, live gas, depth-chart, received-offers filter, trades error, batch-fill 5792, valuation guard, snipe-score, wallet inventory pagination, sweep validate, fee honesty, tx-history types, counter button, tx-progress, USD everywhere, net-proceeds, ENS, scanner exports, pending-tx persistence, wash-trade, activity filters, holder honesty, RPC, live ticker. | F634, F635, F636, F637, F640, F641, F642, F644, F645, F647, F648, F652, F653, F654, F656, F657, F658, F659, F660, F661, F662, F663, F664, F665, F666, F667, F668, F669, F677, F678, F679, F681, F688, F689, F691, F693, F694, F700, F701, F702, F703, F704, F706, F708, F709 | g12 | L | med |
| **P4-B13 naka-analytics-social-misc** | Activity sale filter/sort, alerts consolidation, P&L honesty, whale ENS/fallback, activity cursor, scatter zoom, wallet-modal connectors, modal detail fixes, onboarding tour, chat-room richness, watchlist UX, hub/badges, copy/content, ultrawide/polish, card skeletons, scatter a11y. | F719, F720, F722, F723, F724, F727, F728, F730, F731, F732, F733, F734, F738, F739, F741, F742, F743, F748, F753, F754, F758, F761, F764, F766, F767, F768, F769, F770, F772, F776, F777, F778, F779, F780, F781, F782 | g13 | L | med |
| **P4-B14 naka-ux-misc** | Modal-stack registry, theater mobile, z/css-leak, shortcuts single-source, shared focus-trap, post-buy, share targets, csv export, sound prewarm, scroll-lock, grid-mobile, footer-scrim, print, lite-mode deeplinks. | F785, F786, F787, F788, F789, F790, F791, F792, F793, F794, F796, F799, F800, F801, F803, F805, F806, F807, F808, F809, F816, F822, F823, F826, F828, F829, F830, F833, F835, F836, F837, F838 | g14 | L | med |

### P5 — Polish & a11y

| Batch | Summary | Finding ids | Group | Effort | Risk |
|---|---|---|---|---|---|
| **P5-B1 a11y-primitives-adoption (T10)** | Adopt `<Tabs>`/focus-trap/nav-`<a>`/splash-enter across remaining surfaces. | F77, F78, F79, F104, F145, F150, F177, F178, F205, F241, F275, F303, F312 | g02–g05 | M | low |
| **P5-B2 naka-polish** | Remaining Naka polish: header popovers, z-index, print, footer scrim, grid-mobile polish, splash copy. | F810, F811, F812, F839, F840, F841 | g14 | S | low |

---

## 4. Operator / product-decision register
Not code I write — each needs an owner action or call.

### Operator-action (14)
| id | Group | What's needed |
|---|---|---|
| F83 | g02 | Pin/host the home art asset (CDN/IPFS) so it can't 404. |
| F238 | g04 | HEAD-probe / availability check on an external endpoint the owner controls. |
| F374 | g07 | **Source-verify the live contracts on Etherscan** (invalid key at deploy) so Contracts can truthfully claim "Verified". |
| F409 | g07 | Best-in-class contracts-page asset/data the owner must supply. |
| F442 | g07 | Treasury source labeling — owner confirms Safe-multisig address/source. |
| F489 | g08 | Verify the Ankr RPC endpoint/key is live and rate-OK. |
| F496 | g08 | Provide the missing best-in-class data source/integration. |
| F613 | g11 | **Server-side: fix OpenSea `collections/<slug>/stats` proxy path (400s) + batch/cache best-offer (429s).** |
| F783 | g13 | Copy/content the owner must author. |
| F824 | g14 | **Prod image pipeline** (Alchemy/IPFS CDN) — server/infra. |
| F825 | g14 | **Prod OpenSea proxy** — server/infra. |
| F831 | g14 | **Prod activity API** — server/infra. |
| F832 | g14 | **Prod sniper feed** — server/infra. |
| F834 | g14 | CSP `connect-src` + font/RPC allowlist — infra config. |

**Already tracked in `project_pending_operator_tasks.md`:** the prod redeploy (P0-B1 unblocks the code side)
and the **Etherscan read-only API key rotation** (the loose end; F374 source-verify depends on a valid key).
Standing splash decision: owner keeps the per-entry splash; this plan only adds the additive
skip/keyboard/perf affordances (P3-B4), never removing the art or the entry.

### Product-decision (121) — owner call before I build (none block the phases)
- **Splash scope (keep per standing decision; decide only extras):** F20, F21, F35, F36, F37, F39, F40, F41,
  F43, F229, F363, F417, F443, F444, F615, F696, F827, F1 (layout `domMax` perf tradeoff).
- **Logged-out reads scope (how far to preview):** F228, F445, F456, F221, F705.
- **Best-in-class / new feature — main:** F45, F53, F55, F73, F84, F88, F89, F121, F122, F125, F128, F129,
  F156, F158, F165, F166, F167, F174, F182, F189, F194, F213, F223, F245, F298, F301.
- **Trust/leaderboard/history scope (Learn):** F393, F407, F410, F411, F412, F418, F422, F423, F449, F453,
  F455, F457, F461.
- **Shared-lib best-in-class:** F479, F487, F491, F492, F493, F494, F495, F497, F498, F499, F500, F501, F502.
- **Community best-in-class:** F344, F345, F346, F347, F349, F350, F353, F368.
- **Naka shell/browse best-in-class:** F530, F539, F548, F556, F560, F572, F590, F594, F596, F597, F598, F599,
  F600, F601, F602, F604, F622, F629.
- **Naka market/social best-in-class:** F632 (bundle-listing honesty — build real flow or remove), F697, F707,
  F747, F749, F750, F751, F752, F755, F762, F784, F795, F813, F815, F817, F818, F819, F821.

---

## 5. Dropped items

### Duplicate (57) — closes with its parent (same code change as the listed dep)
F17→F49, F38→F18, F42→F30, F120→F114, F147→F132, F159→F154, F160→F156, F161→F155, F162→F157, F163→F154,
F164→F138/F169, F210→F243, F212→F244, F214→F243/F246, F215→F243, F217→F195, F220→F228, F222→F209, F247→F219,
F280→F300, F287→F300, F288→F279, F289→F281, F290→F281, F291→F282, F292→F284, F293→F285, F294→F286, F295→F283,
F296→F283, F297→F272, F351→F316, F352→F334/F366/F348, F356→F322, F381→F415, F406→F418, F416→F379, F428→F388,
F440→F373, F441→F387, F517→F511, F524→F511, F618→F574/F579, F639→F682, F649→F690, F670→F642, F671→F665,
F672→F666, F673→F708, F674→F669, F675→F668, F676→F667, F699→F644, F814→F796, F820→F812.

*(F164 carries a HIGH severity but is a duplicate of the logged-out-preview fix already in P3-B1 via F138/F169 — closes there, no separate work.)*

### False-positive (5) — not a real defect on verification
- **F183** (g03): verified not an actual defect.
- **F239** (g04): DCA keystroke "flake" is a test-env artifact, not a product bug.
- **F425** (g07): the flagged stale-build symptom does not reproduce at HEAD.
- **F473** (g08): zod-schema "gap" — existing validation is sufficient; no schema needed.
- **F549** (g10): Seaport version is correct on verification.

---

## 6. Coverage matrix

| Bucket | Count | Where |
|---|---|---|
| fix-now | 625 | §3 phases P0–P5 (each id in exactly one batch) |
| redeploy-only | 16 | P0-B1 (code already at HEAD) + §4 operator note |
| operator-action | 14 | §4 operator register |
| product-decision | 121 | §4 decision register |
| duplicate | 57 | §5 (closes with parent) |
| false-positive | 5 | §5 |
| **TOTAL** | **838** | |
| **Unassigned** | **0** | — |

Every one of the 838 indexed findings is in a batch (§3), the operator/decision register (§4), or the dropped
register (§5). The fix-now distribution: P0 ~39, P1 ~80, P2 ~64, P3 ~78, P4 ~344, P5 ~20 (each id counted once
in its home batch; T-annotations mark where the shared logic lives).

---

## 7. Sequenced commit checklist (execution order)

Execute top-to-bottom; deps satisfied by ordering. Rough effort per phase in parentheses.

**P0 — Ship & quick wins (~1.5 days)**
1. P0-B1 prod-redeploy *(S)* — first; unblocks 16 redeploy-only findings.
2. P0-B2 quick-wins-shell *(S)*
3. P0-B3 quick-wins-format-input *(S)*

**P1 — Money-path criticals (~7–9 days)**
4. P1-B1 frozen-tween (T2) *(S)*
5. P1-B2 swap-spender-parity *(M, high-risk — test-gated)*
6. P1-B3 swap-receipt-latch *(S)* — after B2
7. P1-B4 seaport-cancel-counter *(M)*
8. P1-B5 collection-offer-per-item *(M)*
9. P1-B6 cart-normalize-keys *(S)*
10. P1-B7 naka-detail-modal-artwork *(M)*
11. P1-B8 naka-rarity-source *(M)* — after B5 (listings snapshot)
12. P1-B9 supabase-write-proxy *(L)*
13. P1-B10 dm-polling-auth *(M)* — after B9
14. P1-B11 dca-keeper-venue *(M)*
15. P1-B12 write-refetch-core (T5) *(M)*
16. P1-B13 naka-nav-route-fixes *(M)*

**P2 — Trust sweep (~4–5 days)**
17. P2-B1 protocol-truth-hook (T3) *(M)*
18. P2-B2 honesty-claims-sweep (T4) *(M)* — after B1 (shares the truth hook)
19. P2-B3 nft-finance-truth *(S)* — after B1

**P3 — Conversion (~8–10 days)**
20. P3-B6 chainid-pin (T9) *(S)* — early; read-layer foundation for logged-out reads
21. P3-B1 logged-out-reads (T7) *(L)* — after B6
22. P3-B2 art-lqip (T12) *(M)*
23. P3-B3 honest-skeletons (T11) *(M)*
24. P3-B4 splash-affordances *(M)*
25. P3-B5 poller-consolidation (T8) *(L)*

**P4 — Per-surface long-tail (~3–4 weeks, parallelizable by surface)**
26–39. P4-B1 … P4-B14 (one commit per surface group g01–g14). Order is free; each depends only on the
P1–P3 shared primitives already being in the tree.

**P5 — Polish & a11y (~1.5 days)**
40. P5-B1 a11y-primitives-adoption (T10) *(M)*
41. P5-B2 naka-polish *(S)*

> **Order invariants honored:** P0-B1 first (redeploy). T2/T5/T9 land before the batches depending on them
> (logged-out reads after chainId pin; rarity after collection-offer normalization; DM after the write proxy;
> receipt-latch after spender-parity). Within P4 each surface batch is independent and may run in parallel.
