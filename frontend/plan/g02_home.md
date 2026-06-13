# Remediation Plan — g02_home (Home / landing page)

Surface: `frontend/src/pages/HomePage.tsx` and its hooks/components. Verified at HEAD of `mvp-launch` on 2026-06-13. Every finding below was confirmed against the live source unless marked false-positive.

Systemic themes hit on this surface: **T3** (hardcoded constants drifting from on-chain truth), **T4** (overstated trust claims), **T6/T11** (raw-value / misleading-skeleton rendering), **T8** (always-on pollers / duplicate fetches), **T9** (chainId pinning inconsistent across read hooks), **T10** (a11y/keyboard), **T12** (hero art has no preload/LQIP).

---

## Batch: referral-link-continuity (F64, F92)

**Summary:** The `ReferralWidget` mints share links on `https://tegridy.farm` — a domain used nowhere else (canonical is `tegridyfarms.vercel.app`; `usePoints` builds `/swap?ref=`; `TransactionReceipt` falls back to a third domain `tegridyfarms.io`). Plus the `?ref=` param is only consumed when a wallet connects *while still on Home*, and the gold "Buy TOWELI" CTA drops the query string. One fix closes both: a shared origin + a sessionStorage capture-on-load that the Buy CTA and widget both read.

### F64 — Referral links minted on an unused domain (tegridy.farm)
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** In `ReferralWidget.tsx:71` replace the hardcoded `https://tegridy.farm/?ref=` origin with `window.location.origin` and the `/swap?ref=` scheme `usePoints.ts:129` already uses (single source of truth). Update the truncated display string `:94` to match. Keep the existing copy/tweet plumbing untouched.
- **files:** `src/components/ReferralWidget.tsx:71`, `src/components/ReferralWidget.tsx:94`, `src/components/ReferralWidget.tsx:75` (tweet URL derives from `referralLink`)
- **effort:** S
- **risk:** low
- **test:** Mount widget connected; assert copied link starts with `window.location.origin` and `/swap?ref=<addr>`; manual: copy link, paste in a fresh tab, confirm it resolves on the live host.
- **deps:** []
- **batchHint:** referral-link-continuity

### F92 — `?ref=` doesn't persist across navigation / Buy CTA drops it
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Add a tiny capture-on-load effect in `HomePage.tsx` (or a `useReferralCapture` hook reused app-wide): on first render read `?ref=` and stash a valid address in `sessionStorage` (key e.g. `tg_ref`). Make the "Buy TOWELI" `Link to="/swap"` (`HomePage.tsx:119`) append `?ref=<stashed>` when present, and have `ReferralWidget`'s mount-detection (`ReferralWidget.tsx:57-69`) fall back to the stashed value when `window.location.search` has none. Use the existing `safeGetItem/safeSetItem` helpers in `src/lib/storage.ts` rather than raw storage.
- **files:** `src/pages/HomePage.tsx:119`, `src/pages/HomePage.tsx` (new capture effect near line 68), `src/components/ReferralWidget.tsx:57-69`, `src/lib/storage.ts` (reuse)
- **effort:** M
- **risk:** med (attribution + navigation; verify it never overwrites an already-linked referrer — `hasReferrer` guard at `ReferralWidget.tsx:58` must still win)
- **test:** Unit: load `/?ref=0xabc...`, navigate to `/swap`, assert URL carries the param; connect on `/swap`, assert widget prefills referrer. Manual repro: arrive via ref link disconnected → click Buy → connect → confirm referrer prefilled.
- **deps:** [F64]
- **batchHint:** referral-link-continuity

---

## Batch: yield-calc-apr-contract (F65)

### F65 — YieldCalculator parses comma-formatted APR string; the `aprCapped` guard is dead
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: `usePoolData.ts:53` hardcodes `const aprCapped = false`, and `usePoolData.ts:49-52` explicitly documents consumers MUST use `aprNum` not `Number(apr)`. `YieldCalculator.tsx:70` does `Number(poolData.apr)` — at APR ≥ 10,000 the string is `"28,567"` → `Number()` = `NaN` → `aprIsLive=false` → calculator shows "Baseline 12% APR" while the hero pill shows the real 28,567%. Fix: use `poolData.aprNum`, and add an explicit sanity ceiling (since `aprCapped` is now a no-op signal) — e.g. fall back to `BASELINE_APR_PCT` when `aprNum > N` (pick a defensible N like 1,000% so bootstrap-inflated rates don't get multiplied by the up-to-4.5× boost uncapped at `YieldCalculator.tsx:80-83`). Drop the `!poolData.aprCapped` term from `:72`.
- **files:** `src/components/ui/YieldCalculator.tsx:70`, `src/components/ui/YieldCalculator.tsx:71-73`, `src/components/ui/YieldCalculator.tsx:110-111` (badge label), `src/components/ui/YieldCalculator.tsx:210-212` (footnote copy)
- **effort:** S
- **risk:** low
- **test:** Unit: feed `usePoolData` mock with `aprNum=28567` → assert calculator falls back to baseline and badge reads "Baseline"; feed `aprNum=45` → assert "Live 45.0% base APR" and projection uses 45×boost. Manual: load Home disconnected, confirm calculator badge and hero Base APR pill no longer contradict.
- **deps:** []
- **batchHint:** yield-calc-apr-contract

---

## Batch: hero-lcp-art (F66)

### F66 — index.html preloads 3 non-hero images; the real LCP hero art is not preloaded
- **verdict:** fix-now
- **rootCause:** T12
- **approach:** Confirmed: `index.html:70-72` preloads `mfers-heaven.jpg`/`mumu-bull.jpg`/`bobowelie.jpg` (~494 KB) — none is the hero. The hero is `home:0 → iph_0148 → /art/iphone/IMG_0148.jpg` (`artOverrides.ts:76`) rendered full-viewport at `HomePage.tsx:78`. Fix: preload `/art/iphone/IMG_0148.jpg` with `fetchpriority="high"`, drop/demote the 3 stale preloads, and add a `fetchpriority="high"` pass-through on the hero `ArtImg` (it spreads `...rest` so passing `fetchPriority="high"` from `HomePage.tsx:78` works without touching `ArtImg.tsx`). Ideally generate the preload href from the `artOverrides` map at build time so it can't drift again. Responsive variants (srcset/sizes) for the hero are a follow-on (`ArtImg.tsx:62-72` emits none today) — keep additive, don't remove the existing `<img>` path.
- **files:** `index.html:70-72`, `src/pages/HomePage.tsx:78` (add `fetchPriority="high"`), optionally `src/components/ArtImg.tsx:62-72` (srcset follow-on)
- **effort:** M
- **risk:** low
- **test:** Lighthouse/PageSpeed on the deployed build: confirm LCP element is the hero image and it's discovered via preload; DevTools Network: hero fetched at Highest priority, the 3 stale preloads gone. Verify hero still renders on a cold load.
- **deps:** []
- **batchHint:** hero-lcp-art

---

## Batch: honesty-claims-sync (F67, F68, F69, F84)

**Summary:** Four leftover trust/copy claims that the 2026-06-11 honesty pass (commit 7639fdf) missed or that live in surfaces the rendered hero rewrite didn't touch (static meta, a stats card, a marketing card). All are **T4** copy edits except F68 which can optionally read the live on-chain share. Land together so the page tells one story.

### F67 — Security card claims "bounty live", contradicting the honesty-pass trust badge
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Confirmed: `ProtocolStats.tsx:47` sub = `'findings resolved · bounty live'` while the trust badge below (`HomePage.tsx:356`) says "Responsible Disclosure" because the bounty has no funded pool. Change the sub to `'findings resolved · responsible disclosure'`.
- **files:** `src/components/ProtocolStats.tsx:47`
- **effort:** S
- **risk:** low
- **test:** Visual diff: Security card sub now matches the trust badge. (Optionally update the "82+" to track the badge's "82 Findings Resolved" wording — cosmetic.)
- **deps:** []
- **batchHint:** honesty-claims-sync

### F68 — "Fee Share 100% → stakers" hardcoded, contradicts hero three-way split and the live on-chain param
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** Confirmed: `ProtocolStats.tsx:44` and `:36` hardcode `100%`/`100% to stakers`, while the hero (`HomePage.tsx:96-97`) says fees flow "to stakers, the liquidity engine, and operations" and the split is a live governable param (`TreasuryPage.tsx:117-151` reads `stakerShareBps`, `abi-supplement.ts` has `proposeFeeSplit`). Minimal fix: reword the evergreen card to the hero's three-way framing (e.g. `'protocol fees → stakers, liquidity & ops, in ETH'`) and change the live `Real Yield Generated` sub at `:36` to drop the absolute "100%" claim. Better fix (if cheap): read `stakerShareBps` the way `TreasuryPage` does and render the live percentage. Default to the reword to keep blast radius low.
- **files:** `src/components/ProtocolStats.tsx:44`, `src/components/ProtocolStats.tsx:36`
- **effort:** S (reword) / M (live read)
- **risk:** low
- **test:** Visual: card no longer asserts a fixed 100% that contradicts the hero. If live-read taken: mock `stakerShareBps=7000` → assert "70%".
- **deps:** []
- **batchHint:** honesty-claims-sync

### F69 — Static OG/Twitter meta still says "100% of protocol revenue goes to stakers"
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Confirmed: `index.html:31` `og:description`, `:45` `og:image:alt`, and `:52` `twitter:description` carry pre-honesty-pass claims. Crawlers read the static HTML, not the rendered hero. Align all three with the honesty-pass wording ("Every protocol fee flows on-chain to stakers, the liquidity engine, and operations" / drop "100% of swap fees flow to stakers"). Note: the OG *image* `og.png` itself (`:37`) is rendered via `scripts/render-og-png.mjs` — if its baked text repeats the claim, regenerate it; flag for the owner if the source copy lives there.
- **files:** `index.html:31`, `index.html:45`, `index.html:52`
- **effort:** S
- **risk:** low
- **test:** Re-share the deployed URL through a card validator (Twitter/Discord) and confirm the new description; grep `index.html` for "100%" returns nothing in meta.
- **deps:** []
- **batchHint:** honesty-claims-sync

### F84 — Swap-venue copy disagrees on the page; "Verifiable on Etherscan" predates source-verify landing
- **verdict:** product-decision (copy) + operator-action (Etherscan verify)
- **rootCause:** T4
- **approach:** Two sub-issues. (1) Confirmed venue contradiction: `HOW_IT_WORKS` step 1 (`HomePage.tsx:35`) says "Tegridy DEX, nine routes checked" but the Protocol Overview Swap card (`HomePage.tsx:291`) says "via Uniswap V2" with stat "Uniswap V2 / Router". Align the Swap card to the smart-front-door story ("best of N routes" / native DEX + aggregators) — this is a one-line copy change in the card array, but pick the canonical phrasing with the owner since it touches positioning. (2) The hero/meta "Verifiable on Etherscan" (`HomePage.tsx:53`, `:97`; `index.html` already handled in F69) depends on whether source-verify actually landed post-relaunch (deploy record says it was pending). This is an **operator-action**: confirm verification status before leaning on the language; if still unverified, soften to "fee flows visible on-chain". Do NOT assert the claim is false — it's a dependency flag.
- **files:** `src/pages/HomePage.tsx:291` (Swap card desc + stat), `src/pages/HomePage.tsx:53`/`:97` (Etherscan wording, pending verify status)
- **effort:** S
- **risk:** low
- **test:** Visual: both swap descriptions tell one venue story. For Etherscan: operator checks etherscan.io shows verified source for the deployed contracts before the copy stays as-is.
- **deps:** []
- **batchHint:** honesty-claims-sync

---

## Batch: hero-stat-honesty (F70, F72, F71, F85)

**Summary:** The hero stat pills mishandle "no data / disabled read" vs "in-flight" — one shimmers forever for disconnected visitors (the exact audience), one prints a confident false `0 TOWELI`, and two read hooks lack the R043 chainId pin so a wrong-chain wallet half-breaks the hero. Fixing the chainId pin (F71) and the loading-vs-empty distinction (F70/F72) are the same surgical pass over `usePoolData`/`useRevenueStats`/the pill render in `HomePage.tsx`. F85 (USD TVL) is an additive enhancement to the same TVL pill.

### F70 — "ETH Distributed" pill shimmers forever for disconnected visitors
- **verdict:** fix-now
- **rootCause:** T11
- **approach:** Confirmed: `HomePage.tsx:181` sources the pill from `revenueStats.totalDistributed`, but `useRevenueStats.ts:37` gates the query `enabled: !!address` — so for disconnected visitors it never runs, stays `0`, and the `:189/:192` shimmer (`(!s.v || s.v === '–')`) latches forever. The same global value is already fetched wallet-lessly by `RealYieldProof.tsx:25-29` (`enabled: deployed`, chainId-pinned). Fix: source the hero pill from a wallet-less read of `totalDistributed` (either reuse `RealYieldProof`'s pattern via a small shared hook, or add a `chainId`-pinned `enabled: isDeployed` read to `useRevenueStats` for the global trio). Then render an honest `—` for the "no data yet" case instead of an eternal shimmer (reserve shimmer for genuinely in-flight). Base APR (`:180`) hits the same path pre-stake — same treatment.
- **files:** `src/hooks/useRevenueStats.ts:21-37`, `src/pages/HomePage.tsx:181`, `src/pages/HomePage.tsx:189`/`:192` (shimmer-vs-dash logic)
- **effort:** M
- **risk:** med (touches the shared revenue hook used by the ReferralWidget; keep user-scoped reads gated on `!!address`, only un-gate the global trio)
- **test:** Manual: load Home disconnected → ETH Distributed pill shows a value (or honest "—"), never an infinite shimmer. Unit: mock query disabled → assert pill renders "—" not the shimmer span.
- **deps:** []
- **batchHint:** hero-stat-honesty

### F72 — TVL renders a false "0 TOWELI" when reads are disabled/failing
- **verdict:** fix-now
- **rootCause:** T11
- **approach:** Confirmed: `useFarmStats.ts:36` returns `'0 TOWELI'` whenever `totalStaked === 0n`, but `totalStaked` defaults to `0n` (`:26`) on disabled/failed/wrong-network reads — indistinguishable from a true on-chain zero. This is the exact "wall of zeros reads as dead protocol" failure `ProtocolStats` was rewritten to ban. Fix: use the per-call status already in `data[0]?.status` — return `'–'` when the read didn't succeed (or the query is disabled/not-on-mainnet), and only print `'0 TOWELI'` on a genuine successful zero. The hero pill already maps `'–'` to a shimmer; pair with F70 so disabled→dash, not shimmer.
- **files:** `src/hooks/useFarmStats.ts:26`, `src/hooks/useFarmStats.ts:36`
- **effort:** S
- **risk:** low
- **test:** Unit: mock `data[0].status='failure'` → `tvl === '–'`; mock success with `0n` → `'0 TOWELI'`; mock success with stake → formatted count. Manual: connect to a non-mainnet chain → TVL shows "–", not "0 TOWELI".
- **deps:** []
- **batchHint:** hero-stat-honesty

### F71 — usePoolData & useRevenueStats reads lack the R043 chainId pin / mainnet gate
- **verdict:** fix-now
- **rootCause:** T9
- **approach:** Confirmed: `useFarmStats.ts:19-23` pins `chainId: CHAIN_ID` on every read and gates `enabled: isDeployed && onMainnet` (R043 H-062-02). `usePoolData.ts:11-21` has NO `chainId` on any of its 8 reads and no network gate; `useRevenueStats.ts:22-37` likewise on its reads (its *writes* are pinned at `:62/:72/:83`). Fix: add `chainId: CHAIN_ID` to every read entry in both hooks and, for `usePoolData`, add the `onMainnet` gate (`useChainId()` + `chainId === CHAIN_ID`) to `query.enabled` exactly like `useFarmStats`. For `useRevenueStats`, pin the reads; keep `enabled: !!address` for user reads but pin chainId so a wrong-chain wallet returns clean failures (which F70/F72 then render as "—").
- **files:** `src/hooks/usePoolData.ts:11-21`, `src/hooks/usePoolData.ts:21` (enabled), `src/hooks/useRevenueStats.ts:24-35`, `src/hooks/useRevenueStats.ts:37`
- **effort:** S
- **risk:** low
- **test:** Connect to Base/Sepolia → confirm hero pills don't show foreign-chain or half-broken values (APR/ETH-distributed degrade to "—", pinned TVL consistent). Unit: assert each read object includes `chainId: CHAIN_ID`.
- **deps:** []
- **batchHint:** hero-stat-honesty

### F85 — USD-denominated TVL missing (raw TOWELI count only)
- **verdict:** fix-now
- **rootCause:** T6
- **approach:** Confirmed: `useFarmStats.ts:36` returns TVL as a raw TOWELI count only; the price for conversion is already in `PriceContext` (`price.priceInUsd`, consumed at `useFarmStats.ts:14`). Additive: compute `tvlUsd = totalStaked * priceInUsd` and surface USD as primary with the TOWELI figure secondary (best-in-class pattern), reusing `formatCurrency`/`formatWei` from `src/lib/formatting.ts`. Render in the hero pill (`HomePage.tsx:178`) as e.g. "$12.3K · 1.2M TOWELI". Guard: show TOWELI-only when `priceInUsd <= 0` so a price outage doesn't print "$0".
- **files:** `src/hooks/useFarmStats.ts:36` (add `tvlUsd`), `src/pages/HomePage.tsx:178`
- **effort:** S
- **risk:** low
- **test:** Unit: stake + price mock → assert USD primary; price=0 → TOWELI-only, no "$0". Manual: confirm hero TVL pill shows USD with token secondary.
- **deps:** [F72]
- **batchHint:** hero-stat-honesty

---

## Batch: shared-protocol-stats-hook (F76)

### F76 — Six overlapping read-hook batches refetch the same contract values every 30–60s
- **verdict:** fix-now
- **rootCause:** T8
- **approach:** Confirmed: on one Home mount, `totalStaked`/`rewardRate`/`totalRewardsFunded` are each fetched in 3 separate `useReadContracts` batches (`useFarmStats.ts:19-21`, `usePoolData.ts:12-16`, `useProtocolStats.ts:30-32`), and `totalDistributed`/`totalClaimed`/`epochCount` in 2 (`useRevenueStats.ts:24-26`, `RealYieldProof.tsx:25-27`). Distinct contract arrays → distinct tanstack keys → no dedupe; this is the prod rate-limiter risk. Fix: fold the public protocol aggregates into one shared context/hook (mirror `PriceContext` which already does this for price) — a `ProtocolStatsProvider` doing a single chainId-pinned `useReadContracts` for the union of staking + revenue + SFR globals, with the per-surface hooks (`useFarmStats`, `usePoolData`, `useProtocolStats`, `useRevenueStats` globals, `RealYieldProof`) deriving their shapes from it. Keep user-scoped reads (pendingETH, referral) where they are. This is the highest-leverage fix on the surface and also reduces the F8 poller pressure.
- **files:** new `src/contexts/ProtocolStatsContext.tsx`, `src/hooks/useFarmStats.ts`, `src/hooks/usePoolData.ts:10-22`, `src/hooks/useProtocolStats.ts:25-35`, `src/hooks/useRevenueStats.ts:21-38` (global reads only), `src/components/RealYieldProof.tsx:23-30`, provider wired in `src/App.tsx` near `:221`
- **effort:** L
- **risk:** med (broad refactor across 5 consumers; land after the smaller chainId/honesty fixes so their behavior is settled, and keep each hook's public return shape identical so callers don't change)
- **test:** DevTools Network on Home: assert each global contract function is requested once per refetch interval, not 2–3×. Existing hook unit tests must still pass with identical return shapes; add a test that two consumers share one query key.
- **deps:** [F71]
- **batchHint:** shared-protocol-stats-hook

---

## Batch: motion-a11y (F77, F79)

**Summary:** Two motion/SR fixes that pair naturally: the rotating quote spams `aria-live` and keeps its interval alive in hidden tabs (T8 + T10), and there's no app-wide reduced-motion handling (T10). The `MotionConfig` one-liner also covers the quote cross-fade, so do them together.

### F77 — aria-live announces a joke every 7s; interval runs in hidden tabs
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** Confirmed: `HomePage.tsx:128` wraps the rotating quote in `aria-live="polite"` and the `:68-73` interval fires every 7s regardless of tab visibility or `prefers-reduced-motion`. Fix: drop `aria-live` (the quote is decorative — keep it visually), pause rotation when `document.hidden` (add a `visibilitychange` listener in the effect or bail in the tick), and skip rotation under `prefers-reduced-motion` (reuse the existing `useReducedMotion` pattern already used by `PulseDot`). Additive — no art/section removed.
- **files:** `src/pages/HomePage.tsx:128` (remove aria-live), `src/pages/HomePage.tsx:68-73` (visibility + reduced-motion guard)
- **effort:** S
- **risk:** low
- **test:** SR (VoiceOver/NVDA): no periodic quote announcements. Manual: backgrounder the tab → quote stops advancing; OS reduce-motion on → quote static.
- **deps:** []
- **batchHint:** motion-a11y

### F79 — No global prefers-reduced-motion handling for framer-motion
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** Confirmed: grep for `MotionConfig`/`reducedMotion` finds only `ParticleBackground.tsx` and `PulseDot`'s manual hook — nothing app-wide. Wrap the existing `LazyMotion` tree (`App.tsx:221`) in `<MotionConfig reducedMotion="user">`. One line, app-wide, covers all HomePage `whileInView` springs, the hero entrance, FlashValue scale bumps, and the quote cross-fade. Note T2 watch: under `LazyMotion`/`domAnimation` ensure entrance animations still settle to `opacity:1` (this surface uses `initial/animate` correctly, so MotionConfig is safe).
- **files:** `src/App.tsx:221`
- **effort:** S
- **risk:** low
- **test:** OS reduce-motion on → entrance/scroll animations are instant (no transform), content fully visible. Verify no element latches at `opacity:0`.
- **deps:** []
- **batchHint:** motion-a11y

---

## Batch: yield-calc-a11y (F78)

### F78 — role="radio" without the radiogroup keyboard pattern; amount label contradicts itself
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** Confirmed: `YieldCalculator.tsx:151-169` renders six `<button role="radio" aria-checked>` inside `role="radiogroup"` (`:147`) with no roving tabindex or arrow-key handling. Simplest correct fix per the codebase's lightweight style: drop the radio ARIA and use plain buttons with `aria-pressed={selected}` (toggle-button semantics that match the click-only interaction), removing the false promise of arrow-key navigation. Also fix the contradictory label `:117-118` "TOWELI amount (USD equivalent)" → "Amount to stake (USD)" (the `$`-prefixed input and hint `:136` confirm it's USD).
- **files:** `src/components/ui/YieldCalculator.tsx:147` (radiogroup→group/none), `src/components/ui/YieldCalculator.tsx:157-158` (role/aria-checked→aria-pressed), `src/components/ui/YieldCalculator.tsx:117-118` (label text)
- **effort:** S
- **risk:** low
- **test:** axe/Lighthouse a11y: no "radiogroup without arrow-key support" finding. SR: buttons announce pressed state correctly. Visual: label reads "Amount to stake (USD)".
- **deps:** []
- **batchHint:** yield-calc-a11y

---

## Batch: protocol-stats-grid (F80)

### F80 — Pre-volume state leaves a lopsided grid: 4 cards in a 6-column row
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: `ProtocolStats.tsx:50` slices to 6, but with 0 live items today only 4 evergreen cards exist, rendered in `:53` `lg:grid-cols-6` → 4 filled + 2 empty left-aligned columns. Fix: derive the `lg` column count from `items.length` (e.g. `lg:grid-cols-4` when 4 items) or add `justify-center` / `mx-auto max-w` to center the short row. Keep `md:grid-cols-3` for the in-between case. Additive styling only.
- **files:** `src/components/ProtocolStats.tsx:50-53`
- **effort:** S
- **risk:** low
- **test:** Visual at `lg` width with 0 live items → row is balanced/centered; with 6 items → full 6-up row unchanged.
- **deps:** []
- **batchHint:** protocol-stats-grid

---

## Batch: hero-quote-layout (F81)

### F81 — Quote line reserves one line but long quotes wrap → rhythmic CLS on mobile every 7s
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: `HomePage.tsx:128` reserves `min-h-[22px]` but `TOWELIE_QUOTES` (`copy.ts:111-119`) includes a 56-char line ("Wanna get high? Oh wait, wrong farm. Wanna get yield?") that wraps to two lines at 12px italic in the `max-w-xl` hero at ~360px, so the security badge below jumps every 7s. Fix: reserve two lines on mobile (`min-h-[40px]` or responsive `min-h-[40px] md:min-h-[22px]`), or single-line clamp the quote on mobile. Prefer reserving height — keeps all quotes intact (no copy removed).
- **files:** `src/pages/HomePage.tsx:128`
- **effort:** S
- **risk:** low
- **test:** Mobile viewport (~360px): cycle through all quotes, confirm the security badge below holds position (no layout shift). Lighthouse CLS on mobile improves.
- **deps:** []
- **batchHint:** hero-quote-layout

---

## Batch: home-polish-misc (F73, F74, F75, F82)

**Summary:** Small independent correctness/polish fixes that don't share machinery but are cheap and belong in one cleanup commit: a broken ecosystem deep-link, dead code, a double-counted art count, and three micro-polish items.

### F73 — "$JBM on Base" card links to a generic Uniswap swap page, not the token
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Confirmed: `HomePage.tsx:394` `href="https://app.uniswap.org/swap?chain=base"` with no `outputCurrency`, so users land on default ETH swap. Both sibling cards deep-link correctly (`:382` OpenSea, `:406` /lore). Fix is trivial *once we have the JBM token address* — append `?outputCurrency=0x...&chain=base`. **Blocker:** there is no JBM/$JBM address in `constants.ts` (grep confirms only TOWELI). This needs the owner to supply the canonical JBM token address (it's a Base community token born "from a bot glitch" per the copy) before coding. Mark product-decision; once provided, add a `JBM_ADDRESS` constant + deep link (S effort).
- **files:** `src/pages/HomePage.tsx:394`, `src/lib/constants.ts` (new `JBM_ADDRESS`)
- **effort:** S (after address provided)
- **risk:** low
- **test:** Click card → Uniswap opens with JBM preselected as output on Base.
- **deps:** []
- **batchHint:** home-polish-misc

### F74 — Dead fallback in effectiveToweliPrice; unused hook param
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: `HomePage.tsx:63` `price.priceInUsd > 0 ? formatCurrency(price.priceInUsd, 6) : stats.toweliPrice` — but `stats.toweliPrice` (`useFarmStats.ts:37`) is derived from the *same* `price.priceInUsd` (`'–'` when ≤0), so the fallback can never differ from `'–'`. Simplify to one expression: `price.priceInUsd > 0 ? formatCurrency(price.priceInUsd, 6) : '–'`. Also `usePriceHistory.ts:25` takes `_currentPrice` which is unused (already underscore-prefixed); `HomePage.tsx:59` passes `price.priceInUsd` for nothing — drop the param from the hook signature and the call site.
- **files:** `src/pages/HomePage.tsx:63`, `src/pages/HomePage.tsx:59`, `src/hooks/usePriceHistory.ts:25`
- **effort:** S
- **risk:** low
- **test:** Unit/typecheck passes; price renders identically (value when >0, "–" otherwise). `usePriceHistory()` called with no arg compiles.
- **deps:** []
- **batchHint:** home-polish-misc

### F75 — "54 original pieces" double-counts the same artwork in two file formats
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: `HomePage.tsx:424` renders `{GALLERY_ORDER.length} original pieces` = 54 (`artConfig.ts:276-302`: 23 pairs + 8). Duplicated subjects: `naka01`=/splash/new/1.avif vs `naka08`=1.jpg; `naka03`=7.avif vs `naka31`=7.jpg; `naka04`=28.avif vs `naka24`=28.jpg ("Naka #28"/"Naka #28b") → 3 doubles → 51 unique. Additive fix (owner mandate: keep all art): render a deduped count derived from unique source basenames rather than `GALLERY_ORDER.length`, e.g. a small `uniquePieceCount` computed by stripping the extension from each `src`. Keep both files in the gallery; only the displayed number changes.
- **files:** `src/pages/HomePage.tsx:424`, optionally a `uniquePieceCount` helper in `src/lib/artConfig.ts`
- **effort:** S
- **risk:** low
- **test:** Unit: `uniquePieceCount` returns 51 for current `GALLERY_ORDER`; Home renders "51 original pieces". Gallery still shows all files.
- **deps:** []
- **batchHint:** home-polish-misc

### F82 — Theme toggle no-op on landing; gold CTA lacks hover/focus; core-loop microcopy repeats
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Three micro-items, all confirmed. (1) `HomePage.tsx:77` hardcodes the dark shell `#060c1a` while `index.css` ships `[data-theme="light"]` variants and `TopNav` exposes `toggleTheme` — flipping to light only changes the nav. This is plausibly intentional (art-first page) but undocumented: add a code comment explaining the deliberate theme-invariance (do NOT restyle the art-backed hero). (2) `HomePage.tsx:119-123` "Buy TOWELI" `Link` has `transition-all` but no actual hover/focus change — add `hover:brightness-110` and a `focus-visible` ring (reuse the project's focus-ring utility). (3) `CORE_LOOP_STEPS[1]` (`HomePage.tsx:26`) label "Every swap skims a fee" + sub "a protocol fee on each swap" says the same thing twice — put the actual fee bps in the sub (read from `useProtocolStats`'s `feeBps`, or a constant if static). Fee number is a **T3** dependency — if not statically known, keep generic wording rather than hardcode.
- **files:** `src/pages/HomePage.tsx:77` (comment), `src/pages/HomePage.tsx:119-123` (CTA hover/focus), `src/pages/HomePage.tsx:26` (core-loop sub)
- **effort:** S
- **risk:** low
- **test:** Keyboard-tab to "Buy TOWELI" → visible focus ring; hover → brightness change. Visual: core-loop step 2 sub no longer repeats the label. Comment present at hero background.
- **deps:** []
- **batchHint:** home-polish-misc

---

## Batch: art-pinning (F83)

### F83 — 4 of 15 home art surfaces ride deterministic rotation; collision-free now but fragile
- **verdict:** operator-action
- **rootCause:** standalone
- **approach:** Confirmed: `artOverrides.ts:76-86` pins home:0,1,2,4,5,6,7,10,11,13,14; indexes 3, 8, 9, 12 fall back to rotation (currently resolve to naka19/24/25/28 with no collisions today). The no-duplicate guarantee only holds while all of a page's indexes come from rotation; any insert/remove in `ART_POOL_ALL` re-derives these 4 and can collide with an override. Fix is not code we write here — pin the remaining 4 home surfaces via the `/art-studio` tool (additive: assigns art, removes none), which writes the override map. Operator action so the studio's Vite save-middleware owns the write (per the art-studio save hazard).
- **files:** `src/lib/artOverrides.ts` (home:3, home:8, home:9, home:12 — written via /art-studio, not hand-edited)
- **effort:** S
- **risk:** low
- **test:** After pinning, all 15 home surfaces have explicit overrides; simulate an `ART_POOL_ALL` insertion and confirm no home surface changes.
- **deps:** []
- **batchHint:** art-pinning

---

## Batch: home-best-in-class-additions (F86, F87, F88, F89, F90, F91, F93, F94)

**Summary:** Best-in-class "missing affordance" findings — additive enhancements (none removes art/sections). Most are S, data already exists in context/constants. F94 overlaps the chainId work (F71) and should land after it. These are product-flavored, so a couple need an owner nod on placement, but the data plumbing is ready.

### F86 — 24h price-change % + sparkline tooltip/label missing
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `PriceContext` exposes `priceChange` (`PriceContext.tsx` value memo) but — important nuance — `useToweliPrice.ts:242` computes it as a **session** change (`sessionPriceChange`, delta since first render via `prevPriceRef`), NOT a true 24h change. The 24h OHLCV *is* fetched for the sparkline (`usePriceHistory` `ohlcv/hour?limit=24`). Best fix: derive the real 24h % from the sparkline series (`priceData[last]` vs `priceData[0]`) and render a colored badge next to the TOWELI Price pill (`HomePage.tsx:179-205`); add a "24h" label + a simple title/tooltip to the `Sparkline`. Avoid mislabeling the session change as 24h. Additive.
- **files:** `src/pages/HomePage.tsx:203-205` (badge near Sparkline), `src/components/Sparkline.tsx` (title/aria + 24h label)
- **effort:** S
- **risk:** low
- **test:** Mock 24-point series rising → green "+x.x% 24h"; falling → red. Hover sparkline → tooltip. Confirm the % matches first-vs-last of the series, not session delta.
- **deps:** []
- **batchHint:** home-best-in-class-additions

### F87 — Token contract address strip + "Add TOWELI to wallet" (wallet_watchAsset)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `TOWELI_ADDRESS` is in `constants.ts:2` but never surfaced on Home (only `/contracts`). Add an additive strip in the hero/ecosystem area: a copy-to-clipboard address chip (reuse the copy pattern from `ReferralWidget.tsx:77-92`) + an "Add TOWELI to wallet" button calling `wallet_watchAsset` via the wagmi/viem wallet client. Check the repo for an existing watchAsset helper before writing new (grep found none on this surface — likely net-new, keep it minimal/standard EIP-747 payload). Use `ETHERSCAN_TOKEN` (`constants.ts:131`) for the address link-out.
- **files:** `src/pages/HomePage.tsx` (new strip in hero or above ecosystem), `src/lib/constants.ts:2`/`:131` (reuse)
- **effort:** M
- **risk:** low
- **test:** Click copy → address in clipboard. Click "Add to wallet" with MetaMask → token-add prompt with correct symbol/decimals/logo. No-wallet → button hidden or graceful.
- **deps:** []
- **batchHint:** home-best-in-class-additions

### F88 — Market stats strip (mcap/holders/liquidity) + GeckoTerminal link-out
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** `GECKOTERMINAL_URL` is built (`constants.ts:134`) but unused on Home. The link-out is trivially additive. But "market cap / holders / liquidity" figures aren't in any current hook (holders especially needs an indexer/API) — surfacing real numbers needs a data source decision (GeckoTerminal API vs the pending Ponder/Dune indexer). Recommend: ship the **link-out** now (S, additive — a "View on GeckoTerminal ↗" chip near the price pill) and defer the live mcap/holders strip to the indexer milestone (product-decision on data source). Don't fabricate figures (T4 risk).
- **files:** `src/pages/HomePage.tsx` (GeckoTerminal link near price pill), `src/lib/constants.ts:134` (reuse)
- **effort:** S (link-out) / L (live strip, indexer-gated)
- **risk:** low
- **test:** Click chip → GeckoTerminal pool page opens. (Live strip deferred.)
- **deps:** []
- **batchHint:** home-best-in-class-additions

### F89 — Live activity feed / recent swaps ticker
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Best-in-class liveness proof, but there's no event/indexer source wired on Home today (the codebase notes Ponder/Dune are pending against relaunch addresses). A real "recent swaps/stakes" ticker depends on that indexer. Pre-indexer, the only honest option is Etherscan link-outs to the SFR/Staking contracts' tx lists (additive, no fabricated data — avoid T4 fake activity). Recommend deferring the rich ticker to the indexer milestone; optionally ship a simple "Latest activity on Etherscan ↗" link-out now. Needs an owner call on scope.
- **files:** `src/pages/HomePage.tsx` (optional Etherscan activity link-out)
- **effort:** L (real ticker, indexer-gated) / S (link-out)
- **risk:** low
- **test:** Link-out opens the contract's tx list. (Ticker deferred to indexer.)
- **deps:** []
- **batchHint:** home-best-in-class-additions

### F90 — FAQ teaser + docs/litepaper CTA above the footer
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: `FAQ_INTRO` copy exists (`copy.ts:100-104`) and an FAQ page exists, but Home never funnels to them. Additive: add a small FAQ teaser block (use the `FAQ_INTRO.headline`/`subheading`) with a `Link to="/faq"` (and a docs/litepaper CTA if a route exists) above the referral/footer area. Keep it consistent with the existing section styling (art-backed card or simple panel). No section removed.
- **files:** `src/pages/HomePage.tsx` (new teaser section before line 451), `src/lib/copy.ts:100-104` (reuse)
- **effort:** S
- **risk:** low
- **test:** Visual: FAQ teaser renders above footer; click → /faq. Verify the docs/litepaper link only renders if its route/asset exists.
- **deps:** []
- **batchHint:** home-best-in-class-additions

### F91 — No social proof (Twitter/Telegram/Discord) in hero or trust-badge row
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: social links live only in `Footer.tsx:47-49` (x.com/junglebayac, discord.gg/junglebay, t.me/tegridyfarms). Additive: surface the same three links as small icon-links in the trust-badge row (`HomePage.tsx:347-374`) or near the hero. Reuse the Footer's URL constants (extract to `constants.ts` if not already, so Home and Footer share one source — avoids T3 drift). No existing badge removed.
- **files:** `src/pages/HomePage.tsx:347-374` (add social icons), `src/components/layout/Footer.tsx:47-49` (source URLs / extract to constants)
- **effort:** S
- **risk:** low
- **test:** Visual: social icons render in trust row; each opens the correct external profile in a new tab with `rel="noopener noreferrer"`.
- **deps:** []
- **batchHint:** home-best-in-class-additions

### F93 — No "share this protocol" / OG-preview affordance beyond the connected-only referral tweet
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Confirmed: the only share UI is `ReferralWidget`'s tweet/copy, which renders only for connected users (`HomePage.tsx:452`). Additive: add a lightweight, always-visible "Share" affordance in the hero or trust row — a tweet-intent button using the canonical `window.location.origin` URL (align with F64's origin fix) and the OG card. Reuse the tweet-URL construction pattern from `ReferralWidget.tsx:72-75`. No referral attribution needed for the generic share.
- **files:** `src/pages/HomePage.tsx` (hero/trust-row share button), `src/components/ReferralWidget.tsx:72-75` (pattern reuse)
- **effort:** S
- **risk:** low
- **test:** Disconnected visitor sees a Share button; click → tweet intent prefilled with the canonical URL + OG card preview.
- **deps:** [F64]
- **batchHint:** home-best-in-class-additions

### F94 — Network-mismatch banner on landing stats
- **verdict:** fix-now
- **rootCause:** T9
- **approach:** Confirmed dependency on the chainId work: today a wrong-chain wallet silently degrades parts of the hero. Best-in-class pages show "viewing Ethereum data" / read mainnet regardless of wallet chain. After F71 pins all reads to `CHAIN_ID` (so reads stay mainnet-correct even on a foreign wallet chain), add a small dismissible banner near the hero stats when `useChainId() !== CHAIN_ID` saying "Showing Ethereum mainnet data — switch your wallet to interact." Reuse `useChainId`/`CHAIN_ID` already imported in `useFarmStats`. Additive, non-blocking.
- **files:** `src/pages/HomePage.tsx` (banner near hero stats, ~line 176)
- **effort:** S
- **risk:** low
- **test:** Connect to Base → banner appears, stats still show mainnet values (post-F71); switch to mainnet → banner gone. Disconnected → no banner.
- **deps:** [F71]
- **batchHint:** home-best-in-class-additions
