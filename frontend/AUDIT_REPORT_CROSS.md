# Tegridy Farms — Cross-Cutting Frontend Audit (Both Apps)

Chief-reviewer synthesis across the two per-page reports (`AUDIT_REPORT_MAIN.md` — main DeFi app; `AUDIT_REPORT_NAKA.md` — Nakamigos/Tradermigos marketplace). This layer covers ONLY what recurs across many pages or speaks to the app's mission. Per-page detail lives in the two source reports; cross-references use their tags (`[verified]` live+code agree, `[code-read]`, `[live]`, `[fixed at HEAD — prod stale]`). Owner mandate honored: every recommendation is additive — no art or page section is removed.

The single biggest message: **the engineering is exchange-grade; the wiring between it and the user is where it breaks.** The hard problems (Seaport hardening, aggregator race-guards, error-boundary architecture, on-chain honesty math) are solved well. What fails is the last mile — a stale prod build, a handful of shared root-cause bugs cloned across files, a logged-out wall that hides all the good data, and trust copy that drifted out of sync with the relaunch.

---

## 1. Systemic themes (recurring root causes, not per-page bugs)

These each appear on 3+ pages with one underlying cause. Fix the cause once and a dozen findings close together.

### T1 — Prod is running a stale build; the worst "bugs" are already fixed at HEAD
The single highest-leverage finding. A redeploy from HEAD closes a CRITICAL and several HIGHs in one shot.
- **Main / Swap:** the aggregator proxy function is missing from prod — all 7 quote sources silently return the SPA `index.html`; the "smart front-door" revenue path is dead. Fixed at HEAD (catchall + rewrites). [CRITICAL, verified]
- **Main / Shell + Gallery:** dead `eth.llamarpc.com` still first-probed; Gallery votes UI absent in prod but present at HEAD. [fixed at HEAD — prod stale]
- **Naka / Collections:** activity feeds serve cached example data ("live API unavailable") in prod while the live pulse is down.
- **Root cause:** CLI-triggered deploys with no git metadata + no "is prod == HEAD?" gate. There is no telemetry that would have caught "0 aggregators responded" or "RPC #1 is 503 on every load."

### T2 — One animation-settle bug, cloned across modals (the "frozen-tween" family)
A framer-motion entrance that starts (`opacity:0 scale(0.95)`) but never settles to `opacity:1` — the animate target omits the final opacity, so under `LazyMotion domAnimation` the tween freezes mid-fade.
- **Main / Gallery:** lightbox opens permanently invisible. [CRITICAL, verified — prod + HEAD]
- **Main / Swap:** token-selector modal never becomes visible (token selection unusable). [CRITICAL, verified]
- **Main / Swap:** Liquidity/DCA/Alerts tab-panes freeze at opacity ~0.5–0.72 (forms render ghosted, look disabled). [HIGH, verified]
- **Root cause:** missing `opacity:1` in the animate target / no `fill-forwards`; same class reused across surfaces. Also explains the dead `layoutId` tab indicators (5 callsites configured for an animation type `domAnimation` can't run).

### T3 — Hardcoded / pre-relaunch constants drifting from on-chain truth
The protocol relaunched June 6; copy, dates, and magic numbers across many files never followed. This is the trust-killer family.
- **"Verified on Etherscan"** asserted as a hardcoded badge on Security + Contracts while live contracts are NOT source-verified (key was invalid at deploy). [HIGH, verified]
- **Swap fee stated three ways:** Terms says 0.30%, Risks/constants say 0.5%, `SWAP_FEE_BPS` is a frozen literal. [HIGH, verified]
- **"100% to stakers"** hardcoded in marketing copy (ProtocolStats, IncentivesStrip, ConnectPrompt, footer, OG meta) while `stakerShareBps` is governance-mutable; TreasuryPage already reads it live. [MEDIUM]
- **Pre-relaunch timestamps/addresses:** `POOL_LAUNCH_TIMESTAMP` = 2025-03-01 (understates fee-APR 50–100×); `CONTRACTS.md`/Changelog still list abandoned addresses as "Live"; Terms "Last updated April 2026."
- **Naka:** stale "Save 0.5% vs OpenSea" (OpenSea is 1% now — and project memory says don't market a fee discount); `FALLBACK_STATS` render as live data.
- **Root cause:** no single source-of-truth read for fees/shares/dates and **no "last-reviewed" stamp** on Security/Contracts/FAQ — the structural gap that let all of it rot unnoticed.

### T4 — Fabricated / overstated trust claims (honesty-pass regressions)
The repo has an explicit honesty-pass standard ("render no number the chain can't back"); several surfaces predate or violate it.
- **Main:** Immunefi `$10k` bounty + tiers (URL 404s); "bounty live" card; 3-of-5 multisig / team-multisig claims contradicting the app's own Risks page (single-EOA admin); test-suite stats ~3× undercounted; seasonal "+10% NFT boost" multiplier nothing implements.
- **Naka:** Bundle listing is a **fake flow** (`setTimeout(600)` → "submitted!" with no wallet/Seaport/API); EditProfile toasts "Profile saved" on a rejected cloud write; fallback activity fabricates trades by **real named wallets** ("vitalik.eth Bought 3, 4m ago"); rarity "RANK #17 of 20,000" computed from 80 loaded tokens and baked into the share PNG.
- **Root cause:** the honesty pass was applied per-page as it was touched, never swept across every promise surface (especially fallback/demo data and "success" toasts that don't check the write result).

### T5 — Writes don't refetch; success ≠ state update
Across both apps, a confirmed tx leaves the UI showing pre-tx state for the full poll interval (30–60s), inviting a second pointless/destructive action.
- **Main:** Farm approve button stays "Approve TOWELI" up to 30s (users sign a 2nd approval); Dashboard Claim stays clickable (sends ~0 tx); Admin pause pill keeps the old value; Community votes/creates leave stale lists; loans never refresh (the 60s interval is a no-op identity `setState`).
- **Naka:** modal still shows "Buy for X ETH" after a successful buy (2nd click reverts); offer/loan/listing lists don't refetch after create/accept; Cancel optimistically removes a row that reappears next refresh.
- **Root cause:** success effects fire toast/confetti but never call the section's `refetchAll()`; pollers are the only refresh path.

### T6 — Raw-value rendering: wei, scientific notation, and missing-decimals leaking to users
A formatting discipline gap that reaches money-critical surfaces.
- **Main / Swap:** "Route Savings +4.6e+21%" and route rows "kyberswap 3.545e+25" (wei compared against human amounts); custom slippage `toFixed(2)` makes 0.3%/3.5% un-typeable; `1e5` stakes `15`.
- **Main / Community:** bribe claimables formatted with `formatEther` regardless of token decimals (6-dec token shows 10^12× too small).
- **Naka:** `MakeOfferModal` crashes on "1e-8" via `BigInt()`; modal/ShareCard bypass canonical `formatPrice` (`.toFixed(4)` shows "1234.5000", dust → "0.0000" = indistinguishable from zero); collection-offer totals shown as per-item prices (feeds the broken order book).
- **Root cause:** `safeParseEther`/`formatPrice`/`formatTokenAmount` helpers exist but aren't used in every path; `type="number"` inputs accept `e`/exponent and aren't sanitized.

### T7 — The logged-out wall hides all read-only data (mission-critical conversion gap)
The most consistently flagged "needs improvement" across BOTH apps. Best-in-class peers (Uniswap, Aave, Blur, OpenSea, Votium, Snapshot, NFTfi) render market data read-only and gate only the action.
- **Main:** hard connect-wall on Farm, Dashboard, Swap, Liquidity, Community (all 4 tabs — 793 chars total on the page), NFT-Finance (all 4 sections). Bait-and-switch variants: Dashboard paints 8 stat cards + chart then collapses to a connect prompt; NFT-Finance gate copy promises live features that are actually pre-deploy.
- **Naka:** six connect-gates share one visual with no preview; no public bid book; chat is a dead room when disconnected.
- **Root cause:** gating implemented at the page/section level (render the gate OR the feature) instead of at the action level (render the data, gate the button). All the underlying reads are public.

### T8 — Always-on pollers ignore tab visibility and duplicate fetches (the prod rate-limiter risk)
Given the confirmed prod Upstash rate-limiter outage that killed all NFT data, this is operationally the most dangerous theme.
- **Naka:** 3 always-on 30s/60s pollers (`useSmartAlerts`, `usePriceAlerts`, `useCollection`) hit the same stats/activity endpoints (~6 req/min per idle visitor, none gated on `document.hidden`); `usePriceAlerts` instantiated twice (duplicate pollers + toasts); BidManager ~21 proxy calls/30s; WhaleIntelligence re-pulls the entire owner set every 30s; Traits silently loads all 20,000 tokens (~500 sequential pages) on visit; DM polling burns 18 of the 20 req/min budget.
- **Main:** 6 read-hook batches refetch the same contract values every 30–60s (totalStaked/rewardRate fetched 3× each); `useBlockNumber({watch:true})` kept alive for one caption line.
- **Root cause:** no shared, visibility-gated react-query cache; each component owns its own interval.

### T9 — chainId pinning is inconsistent (wrong-network = silently wrong data)
- **Main:** `usePoolData`/`useRevenueStats`/`useUserPosition`/`useRestaking`/`usePoints`/`useAddLiquidity` unpinned while siblings (`useFarmStats`, ETHRevenueClaim) are pinned 500 lines away — a wrong-chain wallet sees an empty stake form, the other chain's native token priced as ETH, or a half-broken hero.
- **Root cause:** the pin was added reactively per audit finding, not centralized into the read layer.

### T10 — Accessibility & keyboard entry gaps, app-wide
- **Splash (both apps):** the only path into the app is `onClick` on a non-focusable `<div>` — **keyboard/assistive-tech users cannot enter at all**, every visit, no skip control.
- **Tab semantics:** three inconsistent patterns in the main app (aria-pressed vs role=tab-without-tablist vs mixed); none implements WAI-ARIA arrow-key tabs; `aria-controls` dangles to non-existent panels when disconnected. Naka nav tabs are `<button>` not `<a>` (middle-click/open-in-new-tab fails everywhere).
- **Modals:** Naka Escape closes the wrong modal in every stacked combination; Theater has no dialog semantics/focus trap; focus snaps back to ✕ on every re-render.
- **Root cause:** a11y added per-component (some are exemplary — ArtLightbox, KeyboardHelp) with no shared primitive enforced across all interactive surfaces.

### T11 — Skeletons that mislead (bait-and-switch + latch-forever)
- **Main:** Dashboard skeleton shows 8 cards + chart then collapses to a connect prompt; Swap has no skeleton (empty dark screen + stray divider); Community/Bounties/Grants skeletons are dead code (static imports defeat Suspense).
- **Naka:** modal OFFERS/Comparable-Sales skeletons latch forever (never resolve on 502/429); listings 7-col skeleton geometry jumps to the real 4-col; stats show "—" (reads as "no data exists") instead of shimmer.
- **Root cause:** loading conflated with empty/error; no terminal error state behind the skeleton.

### T12 — Background/hero art pops in 5–14s late with no placeholder (perceived-quality tax on every art surface)
Home, Swap, Liquidity, NFT-Finance, Gallery, Community (main); listings/modal images one-frame black→art swap, 20 full-res ghost JPEGs (~2.3 MB) mounted with no lazy/async (Naka). Same root cause both apps: **ArtImg/NftImage emit no LQIP/blur-up/dominant-color placeholder, no `fetchpriority`/`srcset`/`sizes`.** The art is the brand — and it's the thing that looks broken on first paint.

---

## 2. App-wide objective gaps (where the frontend fails its mission)

The frontend's job: convert first-time visitors, build trust for a freshly-relaunched protocol, surface live on-chain data, and be flawless on phone/tablet. Scored against that:

**Converting first-time visitors — FAILING.**
- The first thing a visitor hits is a ~10–30s unskippable splash that ends in a mandatory CLICK/TAP TO ENTER, replays every session and on every deep link (to /swap, /terms, a shared `?token=` link), swallows early clicks, and strips deep-link params on the way through. Keyboard users can't get in at all. This is the bounce point.
- Behind it, the logged-out wall (T7) hides every quote, price, pool, order book, and market stat — so a visitor who came to "see if this is real" sees connect prompts, not data.
- No buy-page table-stakes on Home: no USD TVL, no token-address-copy + "Add TOWELI to wallet", no 24h change/sparkline, no market-stats strip, no recent-swaps ticker, no FAQ/docs CTA, no social proof in the hero. The one number that proves the pitch ("ETH Distributed") shimmers forever for the disconnected.

**Building trust for a relaunched protocol — ACTIVELY UNDERMINED.**
- Verified-false claims (T4): "Verified on Etherscan" (not verified), Immunefi $10k (404), 3-of-5 multisig (single EOA), fake bundle-listing success, fabricated activity by real named wallets, "Profile saved" on failed writes.
- Self-contradiction across pages (T3): swap fee 0.30% vs 0.5%; penalty "redistributed to stakers" vs "sent to treasury" (the contract sends 100% to treasury — a false financial claim that incentivizes locking under wrong assumptions); DEMO↔LIVE badge flipping with no tooltip; treasury "EOA/multisig" on one page, "deployed Treasury.sol" on another.
- The structural fix is small and high-trust: a **last-reviewed stamp** on every trust page + deriving fees/verification/shares from live reads instead of literals.

**Surfacing live on-chain data — PARTIALLY FAILING.**
- Where it works it's honest and good (TreasuryPage live split, ProtocolStats no-wall-of-zeros, "Scanning N/20,000"). But the pipes are broken in prod: aggregator proxy dead (7 sources), OpenSea `stats` 400s (VOLUME "—" everywhere), own proxy 429s within ~6 loads, offers 502/503 (latched skeletons), GeckoTerminal CORS-fails browser-side.
- USD is absent almost everywhere money changes hands (Farm, Swap, Dashboard loans, all of NFT-Finance, Community $/vote, Naka modal/cart/P&L) despite `ethUsd`/`priceUsd` being in context — the single most-requested missing denomination across both reports.
- No live activity/recent-trades ticker on the surfaces that most need to prove liveness for a just-relaunched, low-volume protocol.

**Mobile / responsive excellence — CLOSE ON MAIN, BROKEN ON NAKA.**
- Main app is genuinely strong: zero horizontal overflow on 20/21 routes, thoughtful 820 tablet layout, 1440 sweet spot. The one overflow route is Home (decorative div → 414px on a 390px device — one-line fix).
- Naka has hard mobile failures: 4-column gallery grid at 390px (unreadable names/traits, cropped art), "Make Offer" clipped to "Mak", buy-grid letter-placeholders below the fold, modal artwork never displays (geometry bug), batch bar hidden behind the bottom nav.
- **iPad is violated in both:** Naka has a nav blackout at exactly 768px (no nav surface at all) and a dead deep-link enter gate on sub-routes (visitor permanently stranded) — both contradict the flawless-iPad mandate.
- Cross-app shell hazard: Naka's eagerly-bundled `App.css` leaks unscoped selectors into the main app, and the two theme systems clobber each other's `data-theme`.

---

## 3. Unified impact-ranked TOP 20 roadmap (across BOTH apps)

Effort: S = <½ day · M = ½–2 days · L = multi-day. Tagged [main]/[naka]/[both].

1. **[CRITICAL][both] Redeploy prod from HEAD + add a "0 aggregators / RPC-down" telemetry signal** — closes the dead aggregator (7 sources), stale Gallery/votes, llamarpc, and Naka cached-feed builds at once. (S deploy / M telemetry)
2. **[CRITICAL][main] Fix the approval-spender ↔ execution-venue mismatch** — every ERC20 sell reverts today; derive spender from the executing router via one shared helper + a test asserting approve-target === write-target per route. (M)
3. **[CRITICAL][both] Fix the frozen-tween animation-settle bug once (T2)** — unblocks the Gallery lightbox, Swap token-selector, and Swap tab-panes (3 CRIT/HIGH) with one `opacity:1`/`fill-forwards` fix. (S)
4. **[CRITICAL][naka] Make the NFT detail modal show the artwork** — on-demand metadata fetch + instant grid-thumbnail fallback + fix `max-height:280px` geometry; the single-NFT-evaluation objective fails on prod and HEAD. (M)
5. **[CRITICAL][naka] Fix the broken Seaport `cancel()` ABI in all 4 paths** — every Cancel burns gas and leaves the order live/fillable; copy the working `trades.js` counter + `getCounter()` template. (S)
6. **[CRITICAL][naka] Normalize collection-offer prices to per-item + add a `bestBid>bestAsk ⇒ dirty` invariant** — fixes the nonsense order book ("4.52 bid vs 0.10 ask, -4071% = Healthy") and the inflated bid wall. (M)
7. **[CRITICAL][naka] Route chat/likes/reactions/userdata writes through the SIWE proxy** — chat send fails for everyone, likes are no-ops, reactions are spoofable, profile/favorites/watchlist sync is dead and falsely toasts success. (L)
8. **[HIGH][both] Pull every verified-false trust claim + add last-reviewed stamps (T3/T4)** — Immunefi $10k, "Verified on Etherscan", 3-of-5 multisig, fake bundle-listing, 0.30%↔0.5% fee; derive verification/fee/shares from live reads. (M)
9. **[HIGH][both] Replace the logged-out wall with read-only data + action-only gating (T7)** — Farm/Dashboard/Swap/Liquidity/Community/NFT-Finance (main) and the six Naka gates; the single biggest conversion lever, all reads are public. (L)
10. **[HIGH][both] Splash: visible Skip from second 0 + auto-enter + keyboard/AT entry + once-ever localStorage + preserve `?token=`/deep-link params** — the primary first-timer bounce point; keep the art, fix the gate. (M)
11. **[HIGH][main] Fix the DCA + price-alert keepers** to quote and execute on the same venue (Uniswap-priced minOut through SFR on the empty native pool reverts every trigger). (M)
12. **[HIGH][main] Fix the Farm fake-stake receipt + "penalty redistributed to stakers" copy** — set `lastActionRef` per action; correct to "treasury" (false financial claim). (S)
13. **[HIGH][main] Stop Dashboard auto-firing DCA/limit wallet popups (read-only count variant) + cap Earnings Projection at the reward runway** with the existing disclaimer. (S)
14. **[HIGH][both] Consolidate all 30s/60s pollers into one visibility-gated react-query source (T8)** — the prod Upstash rate-limiter risk; dedup the stats fan-out and gate on `document.hidden`. (M)
15. **[HIGH][naka] Fix the dead Gallery nav + dead deep-link enter gate on iPad/desktop sub-routes** — Gallery is unreachable except by typed URL; shared-link visitors are permanently stuck. (S nav / S gate)
16. **[HIGH][both] Wire write-success → section refetch everywhere (T5)** — stale "Approve" buttons, re-clickable Claim, reappearing cancelled rows, stale order/loan lists. (M)
17. **[HIGH][both] Add USD denomination across money surfaces (T6 sibling)** — Farm/Swap/Dashboard/NFT-Finance/Community (main), modal/cart/P&L (naka); `ethUsd`/`priceUsd` already in context. (M)
18. **[HIGH][both] Add LQIP/blur-up + `fetchpriority`/`srcset` to ArtImg/NftImage (T12)** + lazy/async the 20 ghost JPEGs — kills the 5–14s art-pop that makes every art surface look broken. (M)
19. **[HIGH][naka] Seed RaritySniper from the existing listings snapshot + fix "+Cart" item objects + merge listing prices onto gallery tokens** — sniper is permanently "0/0" while 786 listings exist; gallery price sort/filter is a no-op on always-null prices. (M)
20. **[HIGH][both] Fix the structural responsive breaks** — Home iPhone 414px overflow (1 line) + Naka 768px nav blackout + Naka 4-col gallery at 390px + "Make Offer" clip + ErrorBoundary "Go Home" hash-on-BrowserRouter loop + Naka↔main CSS/theme leak. (M)

---

## 4. Twelve quick wins (each under an hour)

1. **[main] Offset the Protocol-Active price pill `right-24` on md+** (or stack above the mascot) — fixes bottom-right occlusion on every page.
2. **[main] Fix `formatTimeAgo` future-timestamp handling** (`formatting.ts:42`) — kills "Ends just now" on every live proposal/bounty.
3. **[main] Default `/premium` to the Points tab** until PremiumAccess deploys — stop landing on an empty SOON tab; flip `POLAccumulator live:false → true`.
4. **[both] Drop/demote `eth.llamarpc.com` + `eth.merkle.io` from the RPC list** (or add merkle.io to CSP `connect-src`) — kills the dominant console noise + dead retries in both apps.
5. **[main] Add `overflow-x-clip` to the decorative div at `HomePage.tsx:87`** — removes the only horizontal-overflow route (iPhone 414px) and the clipped nav menu.
6. **[main] Add `<MotionConfig reducedMotion="user">`** around the LazyMotion tree — one line, app-wide reduced motion.
7. **[naka] Add `flexWrap:'wrap'` + `minWidth:0` to the modal buy row** so "Make Offer" stops clipping to "Mak" (`Modal.jsx`).
8. **[naka] Sanitize "e/E" out of `MakeOfferModal` price input** — stops the `BigInt("1e-8")` render crash; same sanitize fixes `1e5`→`15` staking on main.
9. **[naka] Reverse the BulkListingWizard ladder assignment (or relabel)** so the rarest NFT isn't priced cheapest; fix the literal "…" placeholder in TraitExplorer search.
10. **[naka] Hide MobileNav while any overlay is open** (or raise `.modal-bg` above 9999) — stops the bottom nav floating over modals and the batch bar.
11. **[main] Track copied state per button** on the Home referral box (both flip to "Copied!"); mark Treasury `source: 'external (Safe multisig)'` to kill the 404 GitHub link.
12. **[both] Add `aria-current="page"` + a `:focus-visible` ring to nav links**, `tabindex="-1"` to `#main-content` (main), and gate ErrorBoundary's raw stack trace behind DEV (naka).

---

## 5. What this frontend already does better than most DeFi apps (honest)

- **Honesty engineering is a genuine differentiator.** Dated honesty-pass comments, RealYieldProof self-gating to nothing until real ETH flows, ProtocolStats refusing to render a wall of zeros, "Scanning N/20,000" progressive states, and explicit "(based on X/Y loaded)" / "votes are local-only" disclosures — most meme-coin and even blue-chip DeFi frontends fake liveness; this one mostly refuses to. (The T4 regressions are the exception, not the rule.)
- **Error containment is exchange-grade.** Three-layer boundaries (root + route + per-page with `resetKeys=[pathname]`), the Naka `key={tab}` un-latch that verifiably stops one crashed tab bricking the rest, chunk-load auto-reload with a bounded retry guard — zero JS pageerrors across 23 routes × 4 viewport passes and full live sessions.
- **On-chain transaction safety rivals dedicated marketplaces.** `trades.js` and `fulfillSeaportOrder` ship a full pre-flight battery (chain guard, Seaport `getOrderStatus`, live `ownerOf` re-check, EIP-5792 atomic batching, 4001 rethrow); the main swap surface has best-in-class custom-token security (chain-scoped storage, on-chain re-verification, unlimited-approval block for unverified tokens) and a real 7-source meta-aggregator with Promise.allSettled + AbortController + monotonic requestId race-guard.
- **The math is honest where it counts.** Staking runway computed as balance − staked − unsettled (with the documented "no periodFinish" fix), boost preview matching the contract exactly, BigInt-precise gas math, token0-order-aware LP accounting, timezone-immune shared countdown.
- **Credibility gating from a single source that auto-un-gates on redeploy** — `isDeployed()` drives nav/footer/section visibility and flips features live the moment the operator sets a real address. Few protocols wire pre-deploy honesty this cleanly.
- **The transparency cluster (Risks / Privacy / Contracts / Treasury) is best-in-class.** Protocol-specific ACTIVE/MITIGATED risk cards with a full limits-and-caps table, plain-English privacy naming exact Supabase tables + retention, role-grouped contracts with status badges and zeroed addresses shown honestly, and a treasury that reads the revenue split live and self-detects address drift.
- **The art and brand work is real and well-engineered.** Deterministic art rotation + /art-studio overrides + hardened ArtImg, the card-collage splash with glitch shader and three coherent themes, GPU canvas disposal on unmount, rAF paused on visibilitychange — the personality is a genuine asset, not a liability.
- **Content depth on the Naka collection pages beats most NFT marketplaces.** Full-supply trait boards with floors and ultra-rare combo callouts, the JB rug-to-riches timeline with 20 legendary 1/1 cards and working Find-in-Gallery, the GNSS species encyclopedia — this is editorial work competitors don't bother with.
- **Responsive foundations are solid on the main app** — zero horizontal overflow on 20/21 routes, a thoughtful distinct 820 tablet layout, 44px tap targets, focus-trapped drawers, and a genuinely good mobile bottom-nav + More sheet.
