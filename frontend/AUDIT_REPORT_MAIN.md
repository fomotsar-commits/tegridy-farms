# Tegridy Farms — Main App Frontend Audit (Synthesized)

Scope: the main Tegridy Farms app — shell/nav/footer/splash/transitions, Home, Farm, Swap+Liquidity, Dashboard, NFT-Finance hub, Community, Gallery, Learn (tokenomics/lore/security/faq), Activity (history/leaderboard/premium/changelog), Info (terms/privacy/risks/contracts/treasury), Admin, and responsive. Synthesized from 18 agents (live-browser at 3432px, exact-viewport Playwright at 390/820/1440px, and code-read at HEAD of `mvp-launch`). The Nakamigos/Tradermigos sub-app is a separate scope and is referenced only where its findings touch the shared shell.

Tags: **[verified]** = live/viewport and code agree · **[code-read]** = code only · **[live]** = browser only · **[fixed at HEAD — prod stale]** = code shows it fixed but prod still exhibits it · **[needs verification]** = high-sev but evidence not fully confirmed. Owner mandate honored: every suggestion is **additive** — no art or page section is ever removed.

---

## Cross-cutting issues (hit most/all pages)

These recur across the whole app; per-page sections below reference them rather than repeating.

- **[verified] [HIGH] SwapFeeRouter↔execution-venue mismatches break the core money paths.** Approval spender does not match the executing router (`useSwapAllowance.ts:113` vs `useSwap.ts:402-484`) so every ERC20-input swap reverts at gas-estimation; DCA + price-alert keepers quote Uniswap but execute via SFR on the empty native pool (`useDCA.ts:434/497`, `useLimitOrders.ts:320/402`) so every triggered swap reverts. Confirmed by two independent code agents (code:trade, code:shared-lib). Detail in Swap section.
- **[verified] [HIGH] Light theme is half-applied app-wide:** header turns Kenny-orange but page backgrounds/art stay dark, so navy headings + footer legal links go dark-on-dark and illegible on Home, Farm, Swap, Liquidity, Dashboard, NFT-Finance, Gallery, Community, Terms, Security, Leaderboard (live:shell-home, live:swap-liquidity, live:info-admin-perf, live:community-gallery, live:nft-finance; code corroboration `index.css:648-682`, `Footer.tsx:74`).
- **[verified] [MEDIUM] Towelie mascot avatar occludes the fixed "Protocol Active $price" status pill** in the bottom-right on every page (`LiveActivity.tsx:43` z-40 vs `TowelieAssistant.tsx:329` z-60, both `right-4 bottom-4` on md+). Observed live on Home/Swap/Gallery/NFT-Finance/Admin/Dashboard.
- **[verified] [MEDIUM] Dead RPC `eth.llamarpc.com` is still first-probed on prod** (503/521 on every load; failover to publicnode/ankr works). HEAD demotes it (`wagmi.ts:12-21`, dated 2026-06-11) → **[fixed at HEAD — prod stale]**. Plus `eth.merkle.io` is in the viem fallback list but blocked by the CSP `connect-src` (4+ console violations per page; up to 209 errors in 30s on heavy routes), and browser-side `api.geckoterminal.com` price fetch fails CORS on several routes.
- **[verified] [HIGH] First-visit splash is ~10–30s, unskippable mid-animation, ends in a mandatory CLICK/TAP TO ENTER, and replays every browser session** — including deep links to /terms, /risks, /swap (sessionStorage `tf_loaded` only). See the dedicated Splash section.
- **[code-read] [MEDIUM] Tab semantics are inconsistent and incomplete across the app:** three different patterns (aria-pressed buttons in Learn/Activity/Info hosts, role=tab without tablist/roving-tabindex in Community/NFT-Finance, mixed aria-selected+aria-pressed on Trade). None implements full WAI-ARIA arrow-key tabs; NFT-Finance `aria-controls` dangles to a tabpanel that doesn't exist when disconnected.
- **[code-read] [MEDIUM] "100% to stakers" fee-share is hardcoded in marketing copy** while the on-chain `stakerShareBps` is governance-mutable to 5,000 bps (`ProtocolStats.tsx:44`, `IncentivesStrip.tsx:36`, `ConnectPrompt.tsx:29`, footer). TreasuryPage already reads it live — others freeze it.
- **[verified] [MEDIUM] Hard wallet-connect wall hides all read-only data** on Farm, Dashboard, Swap, Liquidity, Community (all tabs), and NFT-Finance (all tabs). Best-in-class (Uniswap/Aave/Blur/NFTfi/Votium/Snapshot) render market data read-only and gate only the action.

---

## App Shell — nav / header / footer / 404 / providers

**What's already good:** Three-layer error containment (root + route + per-page ErrorBoundary with `resetKeys=[pathname]`), credibility gating from a single `isDeployed()` source that auto-un-gates on redeploy, FOUC-proof CSP-clean theme bootstrap, complete legacy-route redirects, per-route content-shaped skeletons, strong a11y groundwork (skip link, focus-trapped drawer, 44px targets, `:focus-visible`), and near-complete OG/JSON-LD/manifest metadata.

### Wrong
- **[verified] [MEDIUM] Bottom-right mascot covers the Protocol-Active price pill** (see cross-cutting; `LiveActivity.tsx:43` vs `TowelieAssistant.tsx:329`).
- **[code-read] [MEDIUM] Seasonal banner advertises a reward multiplier nothing implements — "Ape Month +10% NFT boost for all holders" auto-activates 2026-07-01** (`SeasonalEvent.tsx:4-23`; no event multiplier in `pointsEngine.ts`; on-chain JBAC boost is a fixed +0.5x). Violates the repo's own "render no number the chain can't back" rule.
- **[code-read] [MEDIUM] ESC during the splash also permanently dismisses the never-seen OnboardingModal** — both keydown handlers fire on one keypress; the most natural skip gesture destroys the first-run education flow (`Modal.tsx:71-77`, `OnboardingModal.tsx:49-52`, `AppLoader.tsx:131-144`).
- **[code-read] [MEDIUM] Fixed header ignores `env(safe-area-inset-top)`** while the app opts into iOS standalone (`apple-mobile-web-app-capable`, `viewport-fit=cover`, manifest `display:standalone`); status bar overlays the header on a notched iPhone (`TopNav.tsx:104`, `AppLayout.tsx:133`). The wrong-network banner handles it; the header doesn't.
- **[code-read] [MEDIUM] ActivityPage tab strip promotes "Gold Card" while `PREMIUM_ACCESS` is zeroed** — credibility gating (`navConfig`/Footer/BottomNav) isn't applied to the host (`ActivityPage.tsx:7-19`); /leaderboard, /history, /changelog all show a dead-end tab.
- **[live] [MEDIUM] "Dashboard" shows as active nav while on Home** (green underline at `/`) on prod; could not reproduce on HEAD → **[fixed at HEAD — prod stale]**, re-verify after deploy.
- **[code-read] [LOW] `TransactionReceipt.sanitize()` HTML-escapes strings React renders as text** → visible `&amp;`/`&#x27;` entities on receipts and shared images (`TransactionReceipt.tsx:17-25`, rendered as JSX text).
- **[code-read] [LOW] Share-to-X fallback URL is `tegridyfarms.io`** — not the prod domain (`TransactionReceipt.tsx:231`); use the canonical SITE_URL.
- **[code-read] [LOW] Drawer focus-restore steals focus to the hamburger on initial page load** (else-branch runs on first mount, `TopNav.tsx:91-100`) — SR announces "Open navigation menu" on every <640px load.
- **[code-read] [LOW] 640–767px reserves ~80px of bottom padding for a BottomNav that's hidden there** (`BottomNav.tsx:60` `sm:hidden` contradicts its R038 comment; `index.css:143-147` + `AppLayout.tsx:133`).
- **[code-read] [LOW] Light-mode override paints the footer copyright dark purple on the permanently-dark footer** (~1.5:1) (`Footer.tsx:74` vs `index.css:651-653`).
- **[code-read] [LOW] Meta/og description go stale across navigation** — `usePageTitle` only sets description `if (description)` with no cleanup; Farm/Admin/Contracts/Treasury pass none, so they inherit the prior page's description (`usePageTitle.ts:61-67`).
- **[code-read] [LOW] `animate-pulse-border` class has no definition** — the intended pulsing seasonal border never renders (Tailwind v4 emits nothing for unknown utilities) (`SeasonalEvent.tsx:99`).
- **[code-read] [LOW] 404 page canonicalizes the bogus URL and the SPA serves it HTTP 200** → soft-404 to crawlers (`App.tsx:88`, `usePageTitle.ts:52-56`); add noindex + skip canonical.

### Needs improvement
- **[code-read] [MEDIUM] `layoutId` shared-element tab animations are dead under `LazyMotion domAnimation`** — 5 callsites (Community, NFT-Finance, AMM, Lending, NFT-Lending) configure spring tab indicators that silently teleport; comment claims no layout animations are used (`App.tsx:214-221`). Switch to `domMax` or delete the props.
- **[code-read] [MEDIUM] 1000ms full-screen pointer-blocking glitch overlay fires on every navigation including in-page tab switches**, on top of a full `key={pathname}` remount that loses tab state and re-runs every query (`AppLayout.tsx:48-53,135`; `ActivityPage.tsx:45`, `LearnPage.tsx:39`).
- **[code-read] [MEDIUM] Desktop glitch transition fetches up to 16 full-res art images mid-transition with no preloading** (mobile path preloads 3; desktop doesn't) (`GlitchTransition.tsx:350-370`).
- **[code-read] [LOW] Back/forward always scrolls to top — no scroll restoration on POP** (`App.tsx:109-113`; remount defeats native restoration too).
- **[code-read] [LOW] "Protocol Active" pill is unconditional copy, not a health signal** — shows green during a full RPC outage (`LiveActivity.tsx:59-60`).
- **[code-read] [LOW] Raw `localStorage.getItem` in render/effect paths** can throw `SecurityError` when site data is blocked (`App.tsx:205`, `TopNav.tsx:21`; `safeGetItem` exists).
- **[code-read] [LOW] Dead nav exports + comment drift** in the IA single-source-of-truth (`navConfig.ts:102-106` `ALL_NAV` unused; stale comments).
- **[code-read] [LOW] Sitemap lists a redirect-only `/lending`, omits `/nakamigos`, and `lastmod` is frozen at 2026-04-19**.

### Missing vs objective (Uniswap/Aave-grade shell)
- **[code-read] Global pending-tx indicator** on the wallet chip (in-flight spinner/count) — receipts exist but nothing shows cross-page progress.
- **[code-read] Real network/health surface** (gas widget, degraded-mode banner driven by RPC health) instead of the static pill.
- **[code-read] Command palette / global search (Cmd+K)** for routes, tokens, docs.
- **[code-read] Per-page OG images** (hook supports `ogImage` but every route ships the same collage).
- **[code-read] "Add TOWELI to wallet" (`wallet_watchAsset`)** quick action next to the address-copy chip.
- **[code-read] aria-live route-change announcement** for SR users (SPA nav is silent).
- **[code-read] PWA completeness** (apple status-bar-style, iOS startup images, `<noscript>` fallback) if standalone stays enabled.

### Polish
- **[code-read] [POLISH] Toaster never offsets for the fixed 56px header** (`AppLayout.tsx:153-164`) — add `offset="72px"`.
- **[code-read] [POLISH] `#main-content` lacks `tabindex="-1"`** for reliable skip-link focus.
- **[code-read] [POLISH] Conflicting `min-w-0` + `min-w-[44px]` on BottomNav tabs** (`BottomNav.tsx:72`).
- **[code-read] [POLISH] `btn-primary:disabled` still carries the old purple inset highlight on the green button** (`index.css:280`).
- **[code-read] [POLISH] GlitchTransition lists #28 twice and uses per-frame `getImageData` without `willReadFrequently`** (Chrome slow-paths it).
- **[live] [LOW] More dropdown does not close on Escape** (only outside-click); wallet modal does.
- **[live] [LOW] No visible keyboard focus ring on nav links** (color-only active state; no `aria-current`).
- **[live] [POLISH] Light-mode theme-toggle glyph is near-invisible on the orange header**; Tradermigos navy-on-orange is weak.

---

## Home (landing)

**What's already good:** The art platform (deterministic rotation + /art-studio overrides + hardened ArtImg), the price pipeline (Chainlink staleness + TWAP divergence + API ±1% gate + versioned caches), and the honesty engineering (dated honesty-pass comments, RealYieldProof self-gates to nothing until real ETH flows, ProtocolStats never renders a wall of zeros, wallet-less YieldCalculator for disconnected visitors) are genuinely best-in-class for a meme-coin frontend.

### Wrong
- **[verified] [HIGH] Referral links are minted on a dead domain `tegridy.farm`** — `fetch('https://tegridy.farm/')` fails at DNS/network level; every shared link and pre-written tweet 404s (`ReferralWidget.tsx:71,94`). The canonical origin is used everywhere else; a third domain `tegridyfarms.io` appears in `TransactionReceipt.tsx:231`. The `?ref=` param is also only consumed when connected on Home, and the Buy CTA drops the query string — attribution leaks.
- **[code-read] [HIGH] YieldCalculator parses the comma-formatted APR string, contradicting its own contract** — `Number('28,567')=NaN` so the calculator labels itself "Baseline 12% APR" while the hero pill on the same screen shows "Base APR 28,567%" (`YieldCalculator.tsx:70` ignores `poolData.aprNum`; `aprCapped` is hardcoded `false`).
- **[code-read] [HIGH/improve] `index.html` preloads three NON-hero images (~494KB) while the real LCP hero (`/art/iphone/IMG_0148.jpg`) is not preloaded** and ArtImg emits no `fetchpriority`/`srcset`/`sizes` (`index.html:70-72`, `artOverrides.ts:76`).
- **[verified] [MEDIUM] "ETH Distributed" hero pill shimmers forever for disconnected visitors** — its source `useRevenueStats` is `enabled: !!address` (`useRevenueStats.ts:37`); RealYieldProof reads the same value wallet-lessly. The one number that proves the "every fee flows on-chain" pitch never loads. Watched 30s+ across loads on prod and HEAD.
- **[code-read] [MEDIUM] Evergreen Security card says "bounty live"** contradicting the 2026-06-11 honesty pass on the same page ("Responsible Disclosure — no funded pool yet") (`ProtocolStats.tsx:47`).
- **[code-read] [MEDIUM] "Fee Share 100% → stakers" hardcoded in two cards contradicts the hero's three-way split** and freezes a live on-chain parameter (`ProtocolStats.tsx:44,36`).
- **[code-read] [MEDIUM] Static OG/Twitter meta still carries the pre-honesty "100% of protocol revenue goes to stakers"** — crawlers/social cards re-publish the inflated claim (`index.html:31,45,52`).
- **[code-read] [MEDIUM] `usePoolData`/`useRevenueStats` reads lack the chainId pin/mainnet gate** `useFarmStats` got — wrong-network users see a half-broken hero (perpetual APR shimmer next to a pinned TVL pill).
- **[code-read] [LOW] TVL renders a false "0 TOWELI" when reads are disabled/failing** (the exact "wall of zeros" failure ProtocolStats was written to ban) (`useFarmStats.ts:36`).
- **[code-read] [LOW] "$JBM on Base" card links to a generic Uniswap swap page, not the token** (sibling cards deep-link correctly) (`HomePage.tsx:394`).
- **[code-read] [LOW] "54 original pieces" double-counts 3 works that exist in two file formats** (51 unique) — additive fix only (`HomePage.tsx:424`, `artConfig.ts:46-76`).
- **[code-read] [LOW] Two swap descriptions on the page disagree about the venue** ("Tegridy DEX, nine routes" vs "via Uniswap V2"); "Verifiable on Etherscan" predates source-verification landing (`HomePage.tsx:35,291,97`).

### Needs improvement
- **[code-read] [LOW] Six read-hook batches refetch the same contract values every 30–60s** (totalStaked/rewardRate fetched 3× each) — fold into one shared aggregate context.
- **[live] [LOW] Rotating Towelie quote is ~11px italic dark-gray over the busy mural** (needs zoom to read) and occasionally renders empty, shifting the trust badge.
- **[code-read] [LOW] `aria-live="polite"` on the 7s-rotating decorative quote** annoys SR users forever and the interval keeps firing in hidden tabs (`HomePage.tsx:128`).
- **[code-read] [LOW] YieldCalculator `role="radio"` buttons without the radio-group keyboard pattern**; the amount label says "TOWELI amount (USD equivalent)" over a $-prefixed USD input (`YieldCalculator.tsx:151,117`).
- **[live] [LOW] Both Copy buttons flip to "Copied!" when only one is clicked** (shared state).

### Missing vs objective (Uniswap/Dexscreener buy-page grade)
- **[code-read] USD-denominated TVL** (hero shows raw TOWELI; price is in context).
- **[code-read] 24h price-change % badge + sparkline tooltip/label** (data already fetched).
- **[code-read] Token-address strip with copy + "Add TOWELI to wallet"** — the single most common buy-page affordance.
- **[code-read] Market-stats strip (mcap/holders/liquidity)** with a Dexscreener/GeckoTerminal link-out (`GECKOTERMINAL_URL` exists, unused on Home).
- **[code-read] Live activity / recent-swaps ticker** to prove liveness for a just-relaunched protocol.
- **[code-read] FAQ teaser + docs/litepaper CTA** above the footer (FAQ_INTRO copy exists, never funneled).
- **[code-read] Social proof in the hero** (Twitter/Telegram/Discord only in the footer today).

### Polish
- **[code-read] [POLISH] No global `prefers-reduced-motion` handling** — one-line `<MotionConfig reducedMotion="user">` around the LazyMotion tree.
- **[code-read] [POLISH] Pre-volume ProtocolStats grid is lopsided** (4 cards in a 6-col row).
- **[code-read] [POLISH] Quote line reserves one line but long quotes wrap** → rhythmic 7s layout shift on mobile.
- **[code-read] [POLISH] Theme toggle has no effect on the hardcoded-dark landing page** (document the decision); gold CTA lacks hover/focus affordance; core-loop microcopy repeats itself.
- **[code-read] [POLISH] 4 of 15 home art surfaces ride deterministic rotation** — collision-free today but reshuffled by any pool edit; pin via /art-studio.

---

## Farm

**What's already good:** Honest staking runway math (rewards-remaining = balance − staked − unsettled, with the documented "no periodFinish" fix), boost preview that matches the contract exactly, `safeParseEtherPositive` in every write path, on-chain stake-cap/min pre-flight that blocks reverting stakes, pendingETH-forfeiture guard, and a real LP-farming skeleton + SOON panel. Sane 30/60s polling with no per-block refetch storms.

### Wrong
- **[code-read] [HIGH] Approve tx (and 5 other actions) fires a fake "stake" success receipt + confetti** — `handleStake` calls `actions.approve()` without setting `lastActionRef`, and the success effect defaults `actionType = 'stake'` (`FarmPage.tsx:107-122`); extendLock, toggleAutoMaxLock, revalidateBoost, claimUnsettled, emergencyExit all hit the same path. A first-time staker's approval shows a full stake receipt for nothing staked.
- **[verified] [HIGH] Copy claims the 25% early-exit penalty is "redistributed to stakers" — the contract sends 100% to treasury** (`StakingCard.tsx:448`, `BoostScheduleTable.tsx:105`, `copy.ts:74` vs `TegridyStaking.sol:1249-1271`). The same card's confirm dialog correctly says "sent to treasury" — it contradicts itself. A false financial claim that incentivizes locking under wrong assumptions. (Corroborated by Info-page agent: FAQ vs Risks penalty-destination conflict.)
- **[code-read] [MEDIUM] IL calculator computes LP value off deposit instead of HODL value — massively overstates loss** (tells LPs they lose money when price goes UP; at +50% it shows a $260 "loss" vs the correct $13 IL) (`ILCalculator.tsx:17-18`).
- **[code-read] [MEDIUM] Raw `parseEther(stakeAmount)` in the render path — page-killing crash reachable via Max with a dust balance** (`String(1e-16)` → exponent → `parseEther` throws → ErrorBoundary blanks the page) (`FarmPage.tsx:105`; `safeParseEther` exists and is used in the sibling card).
- **[code-read] [MEDIUM] `POOL_LAUNCH_TIMESTAMP` hardcoded to 2025-03-01** — fee-derived APR/volume understated ~50–100× post-relaunch (`usePoolTVL.ts:10`).
- **[code-read] [MEDIUM] LP "Est. APR" and "Reward Rate" ignore `periodFinish`** — show a positive headline APR and "X/day" after the Sept-4 emission cliff when `earned()` has stopped (`LPFarmingSection.tsx:39-47`).
- **[code-read] [MEDIUM] "Reward Pool" stat shows cumulative `totalRewardsFunded` as if it were remaining rewards** — the honest `rewardsRemaining` is computed and shown on Tokenomics but not here (`useFarmStats.ts:40` → `IncentivesStrip.tsx:33`).
- **[code-read] [LOW] type="number" + strip-regex mangles scientific notation** — typing `1e5` stakes `15` (`StakingCard.tsx:355`, also LPFarmingSection).
- **[code-read] [LOW] Approve confirmation wipes the typed stake amount** (`LPFarmingSection.tsx:25-30` clears on any `isSuccess` incl. approve).
- **[code-read] [LOW] Claim/unstake receipts read live position values at confirm time** — a 30s poll between submit and confirm yields a "claimed 0 TOWELI" receipt (`FarmPage.tsx:142,151`).
- **[code-read] [LOW] Swap-points `getLogs` scans 5M+ blocks from a pre-deploy `fromBlock` 18000000; failure swallowed to 0; `logAction` is a deprecated no-op** (`usePoints.ts:73-83`).

### Needs improvement
- **[verified] [MEDIUM] No refetch after tx success** — approve button stays "Approve TOWELI" up to 30s after approval (users sign a second pointless approval); position card appears up to 30s late (`FarmPage.tsx:119-167`, `useUserPosition.ts:25`). Live agent confirmed the LP "EST. APR — calculating…" badge never resolves.
- **[code-read] [MEDIUM] chainId pinning inconsistent across farm hooks** — wrong-chain wallet sees an empty "Stake" form instead of its real position (`usePoolData`/`useUserPosition`/`useRestaking`/`usePoints` unpinned).
- **[code-read] [MEDIUM] StakingCard a11y gaps** — unlinked label, color-only selection, no `aria-pressed` on lock options, no focus management in destructive confirm flows, no `aria-live` on claimable counters.
- **[live] [LOW] Sub-1× "Boost 0.61x" reads as a penalty** (schedule starts at 0.40×) — relabel "Lock multiplier" / normalize shortest lock to 1.0× (`FarmPage`, `BoostScheduleTable`).
- **[code-read] [LOW] Withdraw-LP input not validated against staked balance** — builds a reverting tx (stake side pre-checks; withdraw doesn't) (`LPFarmingSection.tsx:282-288`).
- **[code-read] [LOW] `rewardSanityBreach` exported but never consumed** — promised "Verify on-chain" prompt unimplemented; users see 0.0000 with no explanation (`useRestaking.ts:163`, `FarmPage.tsx:269-338`).
- **[code-read] [LOW] Headline TOWELI price + sparkline frozen at page-load for the session** when the native pair is empty, yet rendered next to a "live" PulseDot.
- **[code-read] [LOW] `LOCK_OPTIONS` duplicated in three files** — divergence risk for a financial parameter.

### Missing vs objective (Yearn/Beefy/Aave-grade farm)
- **[live+code] No TVL or USD context anywhere on the farm page** (5 chips are TOWELI-only; price is in context) — a farmer can't compute yield without TVL/USD.
- **[code-read] Zap** (single-token → LP+stake in one flow; currently 5 steps).
- **[code-read] Auto-compound / "claim & restake" action + APY-with-compounding view.**
- **[code-read] Emission runway / "rewards remaining + days left" on the Farm page itself** (data exists, only shown on Tokenomics).
- **[code-read] EIP-2612 permit / EIP-5792 batched approve+stake** (the EIP-5792 foundation exists, wired into nothing).
- **[code-read] Logged-out read-only view** — pre-connect visitors can't see boost schedule, pools, or stats (all public reads).
- **[code-read] Earnings history / profit calc / share-of-pool %; lock-expiry .ics/push reminders.**

### Polish
- **[code-read] [POLISH] Boosted rate labeled "APY" but the math is simple APR** (rest of page says APR) (`BoostScheduleTable.tsx:52`).
- **[code-read] [POLISH] "🔥 HOT" badge hardcoded on a currently-unseeded/empty pool** (`LivePoolCard.tsx:29`).
- **[code-read] [POLISH] 5s confirm auto-dismiss resets on every parent rerender** (`useAutoReset` deps include an unstable setter).
- **[code-read] [POLISH] Fallback 24h volume is invented from a guessed turnover ratio** — show "— no volume data yet" (`usePoolTVL.ts:93-102`).

---

## Swap + Liquidity

**What's already good:** A genuinely strong meta-aggregator (7 sources, Promise.allSettled, debounce + AbortController + monotonic requestId race-guard), a hardened serverless proxy (per-provider allowlists, fail-closed origin gate, rate limiting), best-in-class custom-token security (chain-scoped storage, on-chain re-verification, unlimited-approval block for unverified tokens), a 30s quote-staleness gate, honest browser-keeper disclaimers (DCA/Alerts say "not a keeper"), MEV-protection opt-in, fee-on-transfer auto-retry, canonical CoW GPv2 EIP-712, and outstanding art direction on ultrawide.

### Wrong
- **[live] [CRITICAL] Aggregator proxy function is missing from the prod deploy — all 7 quote sources silently dead.** Every `/api/{swapapi,lifi,kyber,openocean,paraswap}` and `/api/aggregator/paraswap/prices` returns the SPA `index.html` (200); `/api/odos`, `/api/cow` return 405; sibling functions `/api/etherscan`, `/api/v1` are live. HEAD has the catchall + rewrites → **[fixed at HEAD — prod stale]**. The "smart front-door" revenue architecture depends on these. Redeploy + add a 0-aggregators telemetry signal.
- **[verified] [CRITICAL] Approval spender is inverted vs the executing router — every ERC20 sell reverts.** `useSwapAllowance.ts:113` maps 'tegridy'→TegridyRouter else→SFR, but `useSwap.ts` executes 'tegridy'→SFR (pulls via `transferFrom(msg.sender)`) and 'uniswap'→UniswapV2Router. Today (empty native pool → route='uniswap'): approve SFR, swap calls Uniswap → `transferFrom` fails at gas estimation. After seeding (route='tegridy'): approve TegridyRouter, execute via SFR → also reverts. Git confirms the regression (43c3ddb/003445e postdate the allowance file). Two code agents agree.
- **[verified] [CRITICAL] Token-selector modal never becomes visible** (HEAD/dev) — dialog mounts but `opacity:0 scale(0.95)` never advances; the framer entrance never runs and `TokenSelectModal.tsx:261-263` omits `opacity:1` from the animate target. Same frozen-tween class as the Gallery lightbox and the swap tab-panes. Token selection is unusable.
- **[verified] [HIGH] Tab-pane entrance animation freezes mid-fade at opacity ~0.5–0.72** on Liquidity/DCA/Alerts (prod + HEAD) — forms render ghosted/unreadable over the art, look disabled (`info-admin-perf`).
- **[code-read+live] [HIGH] DCA + price-alert keepers quote Uniswap but execute via SFR→TegridyRouter on the empty native pool — every triggered swap reverts today** and is mispriced after seeding (`useDCA.ts:434/497`, `useLimitOrders.ts:320/402`); the deep-pool fix applied to `useSwap` was never propagated.
- **[live] [HIGH] Route Savings renders raw scientific notation** — "+4.6032…e+21% vs worst venue"; aggregator `amountOut` is wei but compared against human-formatted token amounts (`TradePage.tsx:98-108`).
- **[live] [HIGH] Route-details rows show raw wei** — "kyberswap 3.545…e+25" — `formatTokenAmount(q.amountOut)` without dividing by decimals (`TradePage.tsx:431`); users can't compare venues.
- **[code-read] [HIGH] Headline "You Receive" / "Best rate via X" / "Route Savings" advertise an aggregator price the app cannot execute** — there is no aggregator execution path; the user receives roughly the on-chain venue's output, so the spread above it is fictional (`useSwapQuote.ts:319`, `useSwap.ts:379-408`).
- **[code-read] [MEDIUM] Custom slippage input is unusable for fractional values** — `toFixed(2)` re-formats on every keystroke, so 0.3% / 3.5% (the exact values it was built for) can't be typed (`TradePage.tsx:314`).
- **[code-read] [MEDIUM] `refreshQuote()` doesn't re-fetch aggregator quotes** (ref mutation isn't an effect dep) and resets the staleness clock so the gate passes vacuously — a stale swap silently downgrades to on-chain-only (`useSwapQuote.ts:437-446`).
- **[code-read] [MEDIUM] Odos native-ETH quotes use the `0xEeee` sentinel where Odos expects the zero address** — the 'zero' normalization style returns `0xEeee` (`aggregator.ts:31-40`); Odos silently drops out for ETH→TOWELI, the headline pair.
- **[live] [MEDIUM] "Max: 100 ETH" not enforced — 200 ETH accepted** (HTML `max` only constrains spinners; same on Alerts) (`DCATab`).
- **[code-read] [MEDIUM] ETH→WETH wrap is a dead flow** — selectable, produces a 0 quote, would be rejected as a self-swap; the CoW path tells users to "wrap your ETH first" with no in-app way (`useSwapQuote.ts:25-36`, `LimitOrderTab.tsx:176`).
- **[verified] [MEDIUM] Light-mode heading text goes dark navy over the unchanged dark café art** on /liquidity + /swap (see cross-cutting).
- **[live] [LOW] Own-origin `HEAD /swap` returned 503** — worth a curl (link unfurlers/uptime monitors use HEAD).
- **[code-read] [LOW] "Compare all N+2 routes" count is wrong when a venue has no quote** (says 7, shows 6) (`TradePage.tsx:411`).
- **[code-read] [LOW] Price impact can show positive % when the aggregator quote beats the pool mid-price** (mixes aggregator exec price with Uniswap reserves) (`useSwapQuote.ts:381-387`).
- **[code-read] [LOW] `addCustomToken` skips on-chain verification on the wrong chain but still stores into the mainnet-scoped list** (`useSwap.ts:506-516`).

### Needs improvement
- **[verified] [HIGH] Everything gated behind connect logged-out** — no quotes/tokens/prices/pool data (the single biggest conversion/trust gap; Uniswap/Aave/Cow quote pre-connect). DCA tab ironically renders its full form logged-out, proving the pattern works.
- **[live] [HIGH] ~30s unskippable splash + CLICK TO ENTER before a deep-linked /swap renders** (see Splash section).
- **[code-read] [MEDIUM] "Savings vs worst venue" is computed against the protocol's own empty pool** — would advertise "+4500% savings" even after the wei fix; no "low liquidity" flag on the degenerate row (`useSwapQuote`).
- **[live] [MEDIUM] Background/card art pops in 5–10s late with no LQIP/fade** (most visible on /liquidity).
- **[code-read] [MEDIUM] Slippage/deadline not persisted; deadline has state but no UI at all** (`useSwap.ts:80-86`, `setDeadline` never called).
- **[code-read] [MEDIUM] On-chain quote reads fire per keystroke with no debounce, and never auto-refresh** — after 30s idle the first Swap click always bounces (`useSwapQuote.ts:88-95`).
- **[live] [LOW] Towelie nag bubbles re-open every ~15–20s** (cap to 1 per visit).
- **[live] [LOW] Towelie chat answer typewriters at ~5 chars/sec with no instant-complete.**
- **[live] [LOW] Flip-direction button clears the entered amount** (Uniswap transposes it).
- **[code-read] [LOW] User slippage not forwarded to aggregator quote requests** (always 0.5%) (`useSwapQuote.ts:233`).
- **[code-read] [LOW] `SWAP_FEE_BPS` hardcoded** — fee display + route comparison silently wrong if `feeBps` is retuned on-chain (`constants.ts:104`).
- **[code-read] [LOW] `useAddLiquidity` reads not chain-gated** — wrong-network users see "No pool exists … plant one" (`useAddLiquidity.ts:42-71`).
- **[code-read] [LOW] Two separate custom-token stores** (Swap vs Liquidity) with different security posture.
- **[code-read] [LOW] CoW path auto-approves `maxUint256` without the warning the swap surface mandates** (`useCowLimitOrder.ts:147-153`).
- **[code-read] [LOW] MEV-protection status not persisted** — re-offers "Add to wallet" every session.

### Missing vs objective (Uniswap/CoW/1inch-grade)
- **[code-read+live] No exchange-rate line, no USD values, no gas estimate** in the quote panel (aggregators return `estimatedGas`, never shown).
- **[code-read+live] No price chart / market context on /swap** (footer links out to GeckoTerminal; CSP already allowlists the embed; ultrawide has an empty column for it).
- **[live] No pool data on /liquidity** — no TVL/reserves/volume/fee-APR and the APR claim has no number.
- **[code-read] Max / 25-50-75% balance buttons** with native-ETH gas-reserve logic.
- **[code-read] Pre-trade confirmation/simulation** (rate, route diagram, fee breakdown, gas, typed-confirm gate for extreme impact).
- **[code-read] Quote auto-refresh countdown** (the 30s staleness machinery exists but isn't surfaced).
- **[code-read] Recent-trades / pool-activity module** (combats the empty-protocol feel; ~$266/day volume).
- **[code-read] Tx deadline control; EIP-5792 one-click approve+swap; real aggregator/CoW execution to capture the displayed savings.**

### Polish
- **[code-read] [POLISH] Big TOWELI numbers render without thousands separators** ("75000000.0000"); quote loading is a bare "…" not a skeleton; tiny balances show "0.0000".
- **[code-read] [POLISH] PriceChart comment claims a same-origin proxy but fetches GeckoTerminal cross-origin** (ITP-fragile); flip-button hover is JS-only (no keyboard affordance).
- **[code-read+live] [POLISH] Custom slippage on DCA/Alerts is an unlabeled bare field with a different range** (0.1–3% vs Swap's 0–20%); native `title` tooltips are unusable on touch.
- **[live] [POLISH] Feature named three ways** — "Alerts" tab → `?tab=limit` URL → "Price Alert" heading.

---

## Dashboard

**What's already good:** URL-as-source-of-truth tabs with a whitelist validator, toast dedup by tx hash, ETHRevenueClaim chain-pinning (R047 M1), a well-built `useLpPosition` (token0-order-aware, bigint-first, fail-closed pre-deploy), the honest `usePoolData` runway pass, a near-production PriceChart, and defensively-engineered UI atoms.

### Wrong
- **[code-read] [HIGH] Mounting the Dashboard can auto-fire DCA/limit-order wallet popups while the banner says "Go to Swap to execute"** — `useDCA`/`useLimitOrders` are mounted just for counts but `checkDue()`/poller call `writeContract` on mount (`DashboardPage.tsx:72`, `useDCA.ts:537`, `useLimitOrders.ts:442`). Unprompted signing request that contradicts the on-screen copy.
- **[code-read] [HIGH] Loans never refresh after load** — the 60s interval is a no-op identity `setState((p)=>p)`, and overdue status is computed from a frozen `now`; a loan crossing its deadline never flips to "overdue" (`useMyLoans.ts:117-167`). Same hook flagged by code:shared-lib.
- **[code-read] [HIGH] Earnings Projection extrapolates the bootstrap APR to 1 year, ignoring reward runway and omitting the disclaimer the hook provides** — the "1 Year" figure can exceed `rewardsRemaining` (`DashboardPage.tsx:451,756-771`; `pool.secondsRemaining`/`aprDisclaimer` unused).
- **[code-read] [MEDIUM] ETH + TOWELI balance reads not chain-pinned** — on a wrong network the portfolio prices the other chain's native token as ETH (`DashboardPage.tsx:67,81-87`; R047 M1 pins it 500 lines below).
- **[code-read] [MEDIUM] Portfolio Value silently drops all ETH/WETH legs when the oracle is stale, with no indicator on the headline** — mid-session the portfolio appears to "drop" by the full ETH balance (`DashboardPage.tsx:96-106`).
- **[code-read] [MEDIUM] Active limit orders mislabeled "price alerts"** directly above the real Price Alerts widget (`DashboardPage.tsx:326-335`).
- **[code-read] [MEDIUM] POL Accumulator "Coming Soon" card is dead code** — the contract is deployed so the gate hides it forever with nothing live in its place (`DashboardPage.tsx:372` vs `constants.ts:23`).
- **[code-read] [LOW] "ETH owed" shows principal only (no accrued interest) with raw 18-decimal `formatEther`** (`DashboardPage.tsx:647,677`).
- **[code-read] [LOW] "Claimable" skeleton gated on price loading, not position loading** — shows "0.00" or shimmers forever depending on which feed lands (`DashboardPage.tsx:217`).
- **[code-read] [LOW] ETHRevenueClaim error indicator is unreachable dead code** — RPC failure is indistinguishable from "nothing to claim" (`DashboardPage.tsx:613,624-626`).

### Needs improvement
- **[verified] [MEDIUM] Skeleton bait-and-switch** — first paint shows 8 stat cards + chart, then collapses to a bare connect prompt logged-out (`live:farm-dashboard`).
- **[verified] [MEDIUM] Connect CTA over busy camo art with no scrim** — heading/subtext washes out (Farm uses a proper dark card; Dashboard has none) (live, confirmed at 820 + 3432).
- **[code-read] [MEDIUM] Claim success never refetches the position** — Claimable stays stale up to 30s and the claim button is immediately re-clickable (sends a ~0 tx) (`DashboardPage.tsx:118-124`).
- **[code-read] [MEDIUM] Loans tab flashes "No outstanding loans" while loans are still loading** (`isLoading` exposed but unused) (`DashboardPage.tsx:513`).
- **[code-read+live] [MEDIUM] Disconnected view hides wallet-independent content** (price chart, TOWELI price, sparkline) — a near-empty void on ultrawide.

### Missing vs objective (DeBank/Zapper/Dexscreener-grade)
- **[code-read] Claim-all aggregation** (staking/ETH/referral/unsettled each have separate buttons; no unified "Claim all (~$X)").
- **[code-read] 24h/7d price-change chips** (OHLCV already fetched).
- **[code-read] Portfolio allocation + value-over-time chart; manual refresh + "updated Xs ago".**
- **[code-read] USD on the Loans tab + collateral collection name/thumbnail.**
- **[code-read] Live/streaming chart, volume pane, crosshair OHLC legend, 24h high/low.**
- **[code-read] CSV/PNG export of positions/P&L; net APY / earnings-to-date.**

### Polish
- (covered above; no additional polish-only items)

---

## NFT-Finance hub (Token Lending + NFT Lending + AMM + Launchpad + Restake)

**What's already good:** `isDeployed` gating on the highest-risk path (every write refuses on wrong chain AND checks deployed; NFT lending uses the shared FeatureNotDeployed placeholder), per-section connect-gate copy, repayment-quote freshness handled in both lending sections, a timezone-immune shared `useCountdown`, correct LTV units after the HIGH-049-1 fix, a genuinely well-engineered resumable launchpad wizard, strong scheme-allowlist security on metadata/links, and `useNFTDropV2` refetch-storm avoidance.

### Wrong
- **[code-read] [HIGH] AMM "My Pools" bypasses the `isDeployed` gate and shows owner/admin controls for ANY tracked address; "ownership verified on-chain" copy is false.** `MyPoolsTab` discards `deployed`, passes `isOwner` unconditionally, and `addLiquidity` with `value: parseEther(...)` to a pasted EOA succeeds on-chain and transfers ETH away (`AMMSection.tsx:2466-2557,1496,1511,2518`). The one gated control that fires value-bearing writes. Ships with the un-gate.
- **[code-read] [HIGH] OwnerAdminPanelV2 fires refetches in the render body — render/refetch loop after any successful admin tx** (`OwnerAdminPanelV2.tsx:84-88`). Latent (address zeroed) but ships with the un-gate.
- **[code-read] [HIGH] Launchpad wizard draft auto-save clobbers the saved draft ~500ms after open, so "Resume" restores an empty wizard** — the whole crash-recovery feature is defeated (`useWizardPersist.ts:74-91`).
- **[verified] [HIGH] Connect-wall copy promises live features, but all 4 sections are pre-deploy — honesty is revealed only AFTER connect** (bait-and-switch). Logged-out gate copy says "Connect to lend & borrow TOWELI" etc. while addresses are `0x0` and the "being audited" banners live only in the connected branch (`LendingPage.tsx:219-242`).
- **[code-read] [MEDIUM] Step5_Deploy dispatches during render + builds tx config (parseEther/BigInt) outside try/catch + no maxSupply/mintPrice validation** — `'1e4'`/`'0.0.5'` throws uncaught; deploy with `maxSupply 0` is possible (`Step5_Deploy.tsx:51-101`).
- **[code-read] [MEDIUM] NFT-Lending Repay button disappears the instant the local clock passes the deadline** — borrower can't repay during the on-chain grace period the copy promises (`NFTLendingSection.tsx:1091,948,80`; sibling LendingSection allows overdue repay).
- **[code-read] [MEDIUM] Token-Lending "Claim Collateral" shown during the grace period when the claim would revert** (`status==='overdue'` OR-ed instead of requiring `defaulted`) (`LendingSection.tsx:1640`).
- **[code-read] [MEDIUM] Token-Lending reads fire against `address(0)`** — `protocolFeeBps`/`offerCount`/`loanCount` have no `enabled: deployed` gate (sibling sections do) → wasted RPC + decode churn (`LendingSection.tsx:457,1743,1794`).
- **[code-read] [MEDIUM] `text-black` tokens on dark surfaces** — LTV "safe" color contradicts its own green bar; repaid badge, APR cells, labels near-invisible (find/replace casualty) (`LendingSection.tsx:168,249,822,900,1068,1124,1599`).
- **[code-read] [MEDIUM] No refetch of offer/loan lists after create/accept** — UI shows a stale market until reload (`LendingSection.tsx:715,1003`; NFTLendingSection same).
- **[verified] [MEDIUM] Restake is promised by this page's copy and `/restake` links, but no restake UI exists in any of the 4 sections** (it's on FarmPage; `/restake`→/nft-finance dumps users on the loan market). The lending prompt copy ("lend & borrow TOWELI") is also wrong (lenders supply ETH) (`LendingPage.tsx:19,32,55`, `App.tsx:151`). Live agent confirmed "Connect to lend & borrow TOWELI" gate.
- **[code-read] [MEDIUM] AMM tracked pools from the pre-relaunch deployment render an infinite skeleton — PoolCard has no error state** (`AMMSection.tsx:1483-1490`).
- **[code-read] [MEDIUM] Token-Lending LTV/Position Value silently show 0 when TOWELI price is unavailable** (the current unseeded-pool state) — reads as zero-risk instead of "price unavailable" (`LendingSection.tsx:1048-1055`).
- **[code-read] [MEDIUM] Launchpad CLOSED/DUTCH_AUCTION/CANCELLED all surface as "Paused"** — the exact mislabel the R071 note says was fixed; a live Dutch auction badges "Paused" (`launchpadShared.tsx:48-54`, `CollectionDetailV2.tsx:54`).
- **[code-read] [MEDIUM] Step4 reuses a stale Arweave quote after the user changes the image set** — upload fails mid-pipeline after the fund leg (`Step4_FundUpload.tsx:57-59`).
- **[live] [MEDIUM] NFT Finance ARIA: tabs reference tabpanels that don't exist when disconnected; no arrow-key tab nav** (`LendingPage.tsx:199,228`).
- **[live] [MEDIUM] document.title not set + raw "--%" protocol-fee placeholder** on the NFT-Finance page (prod, via /restake) — render the known fee constant.
- **[code-read] [LOW] AMM `autoTracked` never resets** — the 2nd pool deployed in a session is never auto-tracked/announced (`AMMSection.tsx:1958-1983`).
- **[code-read] [LOW] Stat labels disagree with the numbers** — "Total Offers" includes cancelled; "Active Loans" counts all loans ever (`LendingSection.tsx:451`, `NFTLendingSection.tsx:160`).
- **[code-read] [LOW] `useNFTDropV2` refund txs toast "Mint confirmed!" / "Mint failed"** (`useNFTDropV2.ts:225-236`).
- **[code-read] [LOW] Step2 computes "files not referenced in CSV" warnings then throws them away** (`Step2_Upload.tsx:27-50`).
- **[code-read] [LOW] Raw `parseEther`/`BigInt` on user input can throw uncaught in click handlers** (`LendingSection.tsx:746,765`, `OwnerAdminPanelV2.tsx:267,280`; `safeParseEther` unused here).
- **[code-read] [LOW] Lender earnings preview ignores the protocol fee its own stats card advertises; PnL assumes full-term interest** (`LendingSection.tsx:726-732,1417`).
- **[code-read] [LOW] AMM hardcoded "0.5%" protocol fee + permanent "after launch" placeholders** that won't update post-deploy (`AMMSection.tsx:421,998,2503`).
- **[code-read] [LOW] Launchpad "Total Revenue" = mintPrice × totalMinted** — wrong for Dutch-auction/repriced drops (`launchpadShared.tsx:272`).

### Needs improvement
- **[code-read] [LOW] Three different not-deployed gate patterns for sibling features** — inconsistent "not live" signals (`LendingPage.tsx:236`, `LendingSection.tsx:1855`, `AMMSection.tsx:2661`, `LaunchpadSection.tsx:98`).
- **[code-read] [LOW] Unbounded batch reads of every offer/loan ever created; no pagination** (Launchpad silently hard-caps at 20).
- **[code-read] [LOW] AMM expanded trade history re-runs two `getLogs` every block** while expanded (`AMMSection.tsx:1318`).
- **[code-read] [LOW] Nested inner tabs aren't URL-addressable** — dashboard "view your loan" links can't land on My Loans (`LendingPage.tsx:91`).
- **[code-read] [LOW] a11y gaps** — labels not associated, clickable rows/headers without keyboard support, inner tab bars lack tab roles, unlabeled steppers, TraitEditor dialog has no focus trap.
- **[code-read] [LOW] Owner Admin uses dev-grade inputs for money-critical actions** — bare unix timestamp, bps fields, native `window.confirm` (TypedConfirmation exists) (`OwnerAdminPanelV2.tsx:303,181,407`).
- **[live] [LOW] Inactive tab pills have no hover state**; overview omits a 4th Launchpad card and never renders the defined tab subtitles (so restaking is undiscoverable); "Dismiss overview" is a near-invisible 10px/30%-white control; overview card buttons lack accessible names.

### Missing vs objective (NFTfi/Gondi/Blur/Sudoswap/Zora-grade)
- **[code-read] No "My Offers" management / cancel-offer** — lender ETH escrowed with no UI path to recover it.
- **[code-read+live] Logged-out market browsing** (order book, pool explorer, drops list, countdowns — drop discovery is inherently a logged-out activity).
- **[code-read] NFT imagery/metadata + floor price where money changes hands** (collateral is bare "#tokenId"; pools are raw addresses; `nftMetadata.ts` + tokenURI reader already exist).
- **[code-read] Wallet inventory picker** instead of hand-typing token IDs (+ `ownerOf` pre-check).
- **[code-read] USD denominations almost everywhere** (`ethUsd` already in context).
- **[code-read] Global pool directory with sort** (Sudoswap-style) instead of paste-an-address.
- **[code-read] Pre-flight simulation + decoded revert reasons** (`revertDecoder.ts` unused here).
- **[code-read] Loan deadline alerts (push/ics) + shareable per-offer/per-loan deep links.**
- **[code-read] Dutch-auction price-decay countdown + next-price preview; hosted allowlist-proof lookup; pagination on offers/loans/collections.**

### Polish
- **[code-read] [POLISH] Per-LoanRow 1Hz re-renders for a minute-granularity display; dead exported showcase components ship in the chunk** (`useCountdown.ts:25`, `LendingSection.tsx:350-445`).
- **[code-read] [POLISH] Tab-switch history semantics contradict the comment; `aria-controls` points at nonexistent panels when disconnected** (`LendingPage.tsx:97,199`).
- **[live] [LOW] Background art pops in 5–14s after content with no placeholder; RPC `llamarpc` still probed on prod** (note: `OnChainProfile.jsx:158` / `WhaleIntelligence.jsx:363` hardcode llamarpc as their ONLY provider — no failover); splash-replay easter egg is an unlabeled 28px button overlapping the home logo.

### Discoverability
- **[verified] [MEDIUM] No desktop nav link to NFT Finance — the page is orphaned from header and footer** (mobile BottomNav has it; desktop only reaches it via Dashboard deep-links or URL). Add to the More menu + footer with a SOON badge while pre-deploy.

---

## Community (bribes + governance + grants + bounties + gauges)

**What's already good:** URL-as-source-of-truth tabs, chain-safety on every write (incl. the standout R-CHAINID guard that blocks commit-hash construction on the wrong chain so the bond can't be silently forfeit), GaugeVoting salt saved to localStorage BEFORE broadcasting, stored-XSS hardening (BiDi/Trojan-Source strip + URI allowlist), a Votium-grade bribes leaderboard (search/sort/skeleton/marginal-earn badge/batched claims/refund surfacing), and ErrorBoundary remount per section.

### Wrong
- **[code-read] [HIGH] Commit-reveal `commitIndex` is guessed and persisted before tx confirmation; the promised reconciliation is never implemented** — `voterCommits` is never read; a failed/rejected commit poisons every subsequent reveal index, and a wrong index reverts → the 10 TOWELI bond is forfeit (`VoteIncentivesSection.tsx:1290-1302`). Reveal also never removes the record on success (double-reveal).
- **[code-read] [HIGH/missing] Bounty funnel is broken end-to-end** — no UI to view submissions, vote, complete, cancel, or refund; the card promises "Community votes on submissions. Winner takes the reward." but no winner can be picked without raw Etherscan (`MEME_BOUNTY_BOARD_ABI` methods unused in `BountiesSection.tsx`).
- **[code-read] [MEDIUM] Legacy `/bounties` and `/bribes` redirect to bare `/community` and land on the wrong tab (Governance)** — page comment promises deep-links land right (`App.tsx:150,153`, `CommunityPage.tsx:43`).
- **[code-read] [MEDIUM] Active deadlines render "Ends just now" / "just now"** — `formatTimeAgo` returns "just now" for every future timestamp; the `.replace(' ago',' left')` hack never matches (`formatting.ts:42-44`, `GrantsSection.tsx:286`, `BountiesSection.tsx:260`).
- **[code-read] [MEDIUM] Claimables panel formats every bribe token with `formatEther` (18 dec) and shows raw addresses** — a 6-decimal token displays 10^12× too small; GaugeRow does it correctly with `whitelistMap` (`VoteIncentivesSection.tsx:474-478`).
- **[code-read] [MEDIUM] GaugeVoting tx errors are never surfaced** — `useWriteContract` `error` isn't destructured and the try/catch around the non-async write is dead code; wallet rejection/revert produces no toast (`GaugeVoting.tsx:109,217-277`).
- **[code-read] [LOW] Duplicate "Transaction confirmed" toasts** possible from the `isSuccess` effect re-running (no `reset()`/hash-latch) (`GaugeVoting.tsx:281-291`).
- **[code-read] [LOW] Nested `<button>` inside `<button>`** — SafeText "show more" inside the row-expand button (invalid HTML / a11y hazard) (`BountiesSection.tsx:241,250`).
- **[code-read] [LOW] `handleCreate` calls `parseEther`/`Number` on unvalidated inputs** — `'1e5'` throws uncaught; `0`/negative deadline passes to chain (`BountiesSection.tsx:86,81`; GrantsSection guards the same).

### Needs improvement
- **[verified] [HIGH] All four tabs are a hard connect-wall logged-out — zero read-only content** (793 chars total on the page); identical "Connect to participate" copy on every tab with no per-feature explanation. Tally/Snapshot/Votium/Hidden Hand all render markets/proposals read-only.
- **[code-read] [MEDIUM] No tx success/error feedback + no refetch after writes** in Governance/Bounties — votes/creates leave stale UI and a dangling "Voting FOR…" toast (`GrantsSection`/`BountiesSection`).
- **[code-read] [MEDIUM] Proposal lifecycle actions missing** — no Execute/Cancel/Lapse despite ABI support and "24h execution delay" copy (`GrantsSection.tsx`).
- **[code-read] [MEDIUM] Lists capped at the latest 10 with no pagination** — older proposals/bounties unreachable (`GrantsSection.tsx:51`, `BountiesSection.tsx:59`).
- **[code-read] [MEDIUM] Banner tells users to "export the salt" but no export affordance exists** (losing the salt is fatal) (`GaugeVoting.tsx:410`).
- **[code-read] [MEDIUM] Loading conflated with empty** — "No proposals/bounties yet" flashes while reads are in flight; no row skeleton (`GrantsSection.tsx:50,250`).
- **[code-read] [MEDIUM] Gauge rows show only truncated addresses** while the bribes tab resolves "TOWELI / WETH" labels via `useGaugeList` (`GaugeVoting.tsx:368`).
- **[code-read] [LOW] RescueBanner tells depositors to call `refundOrphanedBribe` "below" but provides no refund button** (`VoteIncentivesSection.tsx:217`).
- **[code-read] [LOW] Suspense fallback is dead code (static imports); gauges tab bypasses the FeatureNotDeployed pattern the other three use** (`CommunityPage.tsx:10,143,160`).
- **[code-read] [LOW] Heavy per-render read fan-out** (~17+ reads/gauge across 6 intervals; event watchers don't refresh section-level queries).
- **[code-read] [LOW] Tablist lacks the ARIA keyboard pattern + tab/panel wiring; the inactive-tab dimming ternary is dead code** (both branches `text-white`) (`CommunityPage.tsx:84-108`).

### Missing vs objective (Hidden Hand/Votium/Snapshot/Tally-grade)
- **[code-read] USD everywhere** ($/vote, $/veTOWELI, projected APR per gauge — THE headline number on every competitor).
- **[code-read] Round/epoch history explorer** (who bribed what, your earnings/claim history).
- **[code-read] Claim-all across gauges in one tx; per-entity deep links (`?gauge=`/`?proposal=`/`?bounty=`).**
- **[code-read] Snapshot integration** (delegation UI / off-chain proposal mirror) — entirely absent.
- **[code-read] Unclaimed-bribes nav badge + reveal-deadline reminders** (bond forfeiture is time-critical).
- **[code-read] Bounty board basics** (submission gallery, voting, winner display, creator dashboard, status filters).
- **[code-read] Voting-power ROI calculator** ("X TOWELI staked would earn Y from current bribes").

### Polish
- **[code-read] [POLISH] Gauge stat card hardcodes "per epoch (7 days)" while `EPOCH_DURATION` is read from chain** (`GaugeVoting.tsx:328`).
- **[code-read] [POLISH] Art-index reuse (Governance + Vote-Incentives share idx=1); premature toasts before signature** (`CommunityPage.tsx:153,159`).
- **[code-read] [POLISH] Zero-fee/pending-fee-to-zero render as missing data; first-voter advantage not surfaced** on bribed zero-vote gauges (`VoteIncentivesSection.tsx:282,163,555`).
- **[code-read] [POLISH] DepositCard approve→deposit two-click flow has no StepIndicator** (the component exists, unused).
- **[code-read] [POLISH] InfoTooltip can clip at viewport edges; tab switches use `replace` so Back doesn't traverse tabs.**
- **[live] [POLISH] Vote Incentives tab maps to `?section=bribes`** — leaks internal naming in shareable URLs.

### Discoverability
- **[verified] [HIGH/missing] /community is unreachable from any navigation surface (orphaned)** — header, More menu, and footer never list it; only direct URL reaches it. Add to the More "Engage" group + footer.

---

## Gallery

**What's already good:** ArtLightbox a11y (focus trap, Escape/Arrow keys, scroll lock, 44px targets), gallery cards are keyboard-operable, honest "votes are local-only" disclosure with per-address keying + quota-safe storage, zero broken images across all 54 pieces, and a tasteful art-first hover overlay.

### Wrong
- **[verified] [CRITICAL] Lightbox opens permanently invisible — entrance animation frozen at opacity 0** (`scale(0.975)` never advances; image loaded, buttons present, but the content wrapper is stuck). Reproduced 3× on prod + HEAD. The core interaction of the gallery is unusable (only Escape/backdrop-click close it). Same frozen-tween class as the swap token modal and tab-panes.
- **[verified] [MEDIUM] Light mode: "The Collection" h1 and footer legal links go dark-on-dark** (see cross-cutting).
- **[verified] [MEDIUM] Mascot button + tooltip occlude the "Protocol Active" price chip** (see cross-cutting).
- **[code-read] [LOW] Header copy "54 original hand-drawn pieces" misdescribes the collection** — 31 of 54 are the external Nakamigos drop (`GalleryPage.tsx:88`, `artConfig.ts:276`). Additive copy fix only.
- **[live] [LOW] Metadata sloppiness** — duplicate "Naka #7", mixed zero-padded/bare numbering + "#28b", every Naka shares "Fresh from the deck", "Sword of Love" caption is just "the sword of love".

### Needs improvement
- **[verified] [MEDIUM] Fast scrolling shows whole viewports of blank placeholder cells for 1s+** with abrupt pop-in (no shimmer/blur-up); Back-nav re-blanks cells.
- **[live] [MEDIUM] Prod banner promises votes but no voting UI exists in the prod build** — dev HEAD has the "▲ 0" affordance → **[fixed at HEAD — prod stale]**.
- **[code-read] [LOW] All 54 images `loading="lazy"` including above-the-fold; 800×800 size hint mismatches real aspect ratios** → CLS in the masonry columns (`GalleryPage.tsx:117-126`).
- **[code-read] [LOW] Lightbox doesn't restore focus to the opener on close, has no touch swipe, doesn't preload adjacent images** (`ArtLightbox.tsx:42-74`).
- **[code-read] [LOW] Vote affordance invisible to disconnected users; live re-sorting teleports the card you just voted for** (`GalleryPage.tsx:138,74`).
- **[live] [LOW] Full-resolution images served into ~374px slots** (5.5× oversampled; no srcset/thumbnails).

### Missing vs objective (OpenSea/Blur-grade gallery)
- **[live] No search/filter/sort/category controls** for a 54-piece collection.
- **[live] No per-piece permalink or `/gallery/:slug` route; no download/full-res view; no pinch-zoom or swipe in the lightbox.**
- **[live] Stable default order** (grid reshuffles between visits/re-renders — disorienting).

### Polish
- **[live] [POLISH] Background art speech-text bleeds behind UI panels** (leaderboard captions read as broken UI text).
- **[live] [POLISH] Mascot chat input is tiny (~180px) and pinned into the corner** — give it ~320px min-width above the mascot.
- **[live] [POLISH] Content fade-in after splash/nav renders text over unloaded art** (~3–4s half-transparent jank window).

---

## Learn tabs — Tokenomics / Lore / Security / FAQ

**What's already good:** Clean R007 tab-merge routing (all deep links select the right tab), JSON-LD FAQPage structured data with correct accordion ARIA + honest answers ("there is no paid third-party audit — we don't claim one"), the /premium cat-photo CRIT properly resolved to a branded inline-SVG glyph, and all 6 GitHub audit-artifact links resolve 200 to real files.

### Wrong
- **[verified] [HIGH] "Verified on Etherscan" is false — live contracts are NOT source-verified.** `SecurityPage.tsx:265` renders a hardcoded "✓ Verified" badge for every contract; `ContractsPage.tsx:310` says "All contracts are verified." Live curl returned the unverified prompt for TegridyStaking + SwapFeeRouter (key was invalid at deploy). A security page asserting verification that doesn't exist is the worst kind of trust bug.
- **[verified] [HIGH] Terms states the wrong protocol fee (0.30% vs actual 0.5%)** (`TermsPage.tsx:32` vs `constants.ts:108`; Risks says 0.5%). The legal doc misstates the live fee by 40%; "Last updated: April 2026" (pre-relaunch). Risks-vs-Terms 0.30%↔0.5% confirmed live.
- **[code-read] [HIGH] PremiumPage advertises -10/-20/-30% plan discounts the contract does not implement** — the Approve button shows the discounted figure but the wallet/charge is full; `canAfford` checks the discounted total so a user can pass the check and revert on `transferFrom` (`PremiumPage.tsx:14-19,63-67` vs `PremiumAccess.sol:250`). Unreachable today (address zeroed) but live the day it's restored.
- **[code-read] [MEDIUM] Leaderboard advertises dead points mechanics** — streaks, daily visits, claim points can never accrue (`recordAction`/`recordDailyVisit` are deprecated no-ops); Streak renders "0d 🔥" forever, the real scoring (lock-days + LP-balance) is undocumented (`LeaderboardPage.tsx:171-185`, `pointsEngine.ts:190-197`).
- **[code-read] [MEDIUM] Security/FAQ claim a team multisig / 3-of-5 pause guardian, contradicting the app's own Risks page** (single-EOA admin, no multisig yet) (`SecurityPage.tsx:333`, `FAQPage.tsx:59` vs `RisksPage.tsx:14`).
- **[verified] [MEDIUM] Immunefi partnership + $10k bounty tiers are fabricated** — the live agent curled `immunefi.com/bug-bounty/tegridyfarms/` → **404** (also linked at HEAD). Treasury Safe is documented empty (`SecurityPage.tsx:302-306`).
- **[code-read] [LOW] FAQ accordion open-state keyed by filtered indices** — search transfers "open" to a different question (`FAQPage.tsx:179`).
- **[code-read] [LOW] FAQ cites `GOVERNANCE.md`, which doesn't exist** in the repo (`FAQPage.tsx:59`).
- **[code-read] [LOW] Tokenomics flags POLAccumulator `live:false` although it was deployed in the relaunch** (`TokenomicsPage.tsx:44` vs `constants.ts:23`).
- **[code-read] [LOW] Lore: invalid DOM nesting (div inside `<ol>`) + asymmetric left padding from inline `paddingLeft:0`** (`LorePage.tsx:66,90`).
- **[code-read] [LOW] Security test-suite stats are stale ~3× undercount** ("38,794 lines / 34 files" vs 95 `.t.sol` files; FAQ says "1,500+ test suite") (`SecurityPage.tsx:139`).
- **[code-read] [LOW] FAQ vs Risks penalty-destination conflict** (FAQ "100% to stakers" vs Risks "non-recycled portion reaches treasury") — and the Farm copy is a third version (treasury is correct per contract).
- **[live] [MEDIUM] Tokenomics Supply Distribution chart renders empty — legend only, no pie/donut** (prod + HEAD; legend proves the data is present).

### Needs improvement
- **[code-read] [LOW] Tokenomics FDV counts burned supply** (~25.8% burned) — overstates FDV ~35%; the burn is a marketing asset the page hides (`TokenomicsPage.tsx:80`).
- **[code-read] [LOW] Leaderboard swap-count `getLogs` scans 4.7M blocks from a pre-deploy `fromBlock`** — silently zeros swap points/badges (`usePoints.ts:73-84`).
- **[code-read] [LOW] FAQ search input lacks an accessible name** (placeholder ≠ label).

### Missing vs objective (Dexscreener token-page / Aave security-page grade)
- **[code-read] Tokenomics: circulating supply / market cap (only FDV), burned-supply stat, holders count, "Add TOWELI to wallet", emissions-over-time chart, CoinGecko/DEXTools links.**
- **[code-read] Leaderboard: real multi-user ranking** (gated on the indexer; until then no social loop).
- **[code-read] Security: live verification-status read, security.txt, direct security contact (email/PGP), audit-firm timeline.**
- **[code-read] Cross-cutting: last-reviewed/updated stamps on Security/Contracts/FAQ** — the root condition that let the Verified-badge and fee-number rot go unnoticed.

### Polish
- **[code-read] [POLISH] No-op `hover:text-white` on multiple Tokenomics/Premium/Admin links** (zero hover feedback).

---

## Activity tabs — History / Leaderboard / Premium / Changelog

**What's already good:** HistoryPage hardening (zod schema on fresh AND cached rows, AbortController lifecycle, 5-min cache, day-grouping, client pagination, CSV export with proper quoting, BigInt-precise gas math), and honest empty/pending states throughout.

### Wrong
- **[code-read] [MEDIUM] History filter omits live contracts** (LP Farming, native Router/LP, staking/SFR admin sisters) while the footer claims "all Tegridy Farms protocol contracts" — LP stakes/claims and native-router adds silently never appear (`HistoryPage.tsx:201-206,559`).
- **[code-read] [MEDIUM] Changelog is 5+ weeks stale and omits the June 6 relaunch** — and contradicts other pages ("Deployed TegridyNFTLending" while Security shows it "Not deployed") (`ChangelogPage.tsx:17-124`).
- **[code-read] [LOW] Explorer links derived from the wallet's chainId while data is always mainnet** — a wallet on Base/Arbitrum yields dead basescan/arbiscan links for mainnet txs (`HistoryPage.tsx:171`, `PremiumPage` TxLink; AdminPage already pins canonical chain).
- **[code-read] [LOW] (Premium) discount mispricing + dead points mechanics** — see Learn section (PremiumPage discounts; Leaderboard streaks).

### Needs improvement
- **[code-read] [MEDIUM] HistoryPage duplicates ~140 lines from `lib/txHistory.ts` — already diverging** (the lib schema has an optional `from`; the inline copy doesn't) (`HistoryPage.tsx:22-166`).
- **[code-read] [LOW] No manual refresh while the 5-min cache is fresh** — a user who just transacted can't force a refetch; `handleRetry`'s AbortController is never aborted on unmount (`HistoryPage.tsx:184-196,282`).
- **[code-read] [LOW] PremiumPage has no renew/extend path for active subscribers** (contract supports extension); the two claim buttons share one tx state (`PremiumPage.tsx:245,413,438`).
- **[code-read] [LOW] Learn/Activity/Info tab bars use `aria-pressed` buttons, not tabs semantics; every tab click pushes history** (Back cycles tabs).

### Missing vs objective (Blur/OpenSea activity-feed grade)
- **[code-read] History: type/status filter chips, date-range filter, ERC-20 token-transfer view, USD column, pending-tx surfacing, live updates.**
- **[code-read] Leaderboard: top-N snapshot / percentile estimate until the indexer lands.**
- **[code-read] Changelog: per-release deep links/anchors, RSS/subscribe, generated-from-markdown source.**

### Polish
- **[verified] [POLISH] /premium lands on the "Gold Card" SOON tab instead of the live Points tab** — first impression is an empty feature; default to Points until PremiumAccess deploys (confirmed at 820 + 1440).

---

## Info tabs — Terms / Privacy / Risks / Contracts / Treasury

**What's already good:** This is the strongest cluster in the app. Risk Disclosure is genuinely best-in-class (protocol-specific ACTIVE/MITIGATED cards, full limits-and-caps table with rationale, dated June-11 honesty pass). Privacy is plain-English and concrete (names exact Supabase tables, retention, GDPR/CCPA). Contracts is exemplary (role-grouped, status badges, GitHub + Etherscan links, zeroed addresses shown honestly, byte-correct external deps). Treasury reads the revenue split live and self-detects address drift.

### Wrong
- **[verified] [MEDIUM] Swap fee contradicts itself across legal pages: 0.30% (Terms) vs 0.5% (Risks)** (see Learn — Terms fix).
- **[verified] [MEDIUM] Treasury described as "an EOA/multisig, not a smart contract" on Risks but listed as deployed `Treasury.sol` on Contracts** (`ContractsPage.tsx` Core list vs Risks card). One is stale — `contracts/src/Treasury.sol` does not exist (it's a Safe).
- **[verified] [MEDIUM] "Recent Treasury Transactions" permanently shows "momentarily unavailable"** (prod + HEAD) — no API call is even attempted; the feature is hard-disabled while the copy claims a transient outage.
- **[code-read] [HIGH] Linked `CONTRACTS.md` still lists pre-relaunch (abandoned) addresses as "Live"** — a user following the page's own "source of truth" gets the dead deployment (`ContractsPage.tsx:313`; `origin/main` is 234 commits behind).
- **[code-read] [MEDIUM] Obsolete "Wave 0" framing + stale multisig `0x0c41…8bfe`** in the Contracts legend/row notes — the relaunch superseded Wave 0; the real owner is a different Safe (`ContractsPage.tsx:330-345`).
- **[live] [MEDIUM] "All contracts are verified on Etherscan" could not be confirmed for the Wave-0 redeploys** (Blockscout returns no source for TegridyStaking/LP-Farming/SwapFeeRouter) — soften until the key is rotated and sources verified.
- **[code-read] [LOW] Treasury source link 404s** — `contracts/src/Treasury.sol` doesn't exist (mark `source: 'external (Safe multisig)'`) (`ContractsPage.tsx:73`).
- **[code-read] [LOW] Explorer links derived from wallet chainId while data is mainnet** (TreasuryPage; see Activity).
- **[live] [LOW] Jump-scroll (End key) leaves the viewport blank** — in-view fade-ins only fire on wheel scroll (`/terms`, `/security`); breaks find-in-page + anchors.
- **[live] [LOW] Light theme is incomplete on info pages** — only the header restyles (see cross-cutting).
- **[code-read] [LOW] Doc links point at `/blob/main/` while the default branch is `mvp-launch`** — main can drift stale and serve outdated audit/status info.

### Needs improvement
- **[live] [LOW] Treasury stat cards mix em-dash and zero for the same meaning** — "–" conventionally signals "failed to load", undermining the live-on-chain framing when the value is just zero.
- **[live] [LOW] 21,434% APR displayed raw as the headline** (`/` + `/farm`) — show a projected APR at a reference TVL alongside.
- **[live] [LOW] /admin gate has no inline connect action** (mirror Farm's gate button).
- **[live+code] [LOW] Privacy cites repo file paths inline without links** (hyperlink to GitHub; drop the stray "Basescan" mention — app is mainnet-only).

### Missing vs objective (Aave/Unispan transparency-page grade)
- **[code-read] Treasury: TOWELI/other token holdings (ETH-only today), historical balance chart, inflow/outflow categorization, runway-vs-opex view** (notable since self-sustain is the strategy).
- **[live] Treasury: any historical dimension** (snapshot-only "as of block #N").
- **[code-read] Contracts: ABI download/copy, deployment date + deploy-tx link per contract, per-contract watch helpers, diff/changelog on address rotation.**
- **[code-read] Cross-cutting: last-reviewed stamps** on Security/Contracts/FAQ.

### Polish
- **[live] [POLISH] Contract-address copy chip gives minimal feedback** (no clear toast/check).
- **[code-read+live] [POLISH] /contracts (31 rows) and /treasury confine to a narrow center column on ultrawide** — two-column per section / wider stat row at >2000px (additive, art untouched).
- **[code-read] [POLISH] TreasuryPage `useBlockNumber({watch:true})` keeps a per-block subscription alive for one caption line** (poll on the 60s cadence instead).

---

## Admin

**What's already good:** Genuinely strong security posture — fail-closed WrongChainScreen, `owner()` pinned to the canonical chain with 10s refetch, `refetchOwner()` forced before every write, chainId-pinned writes, TypedConfirmation typed-phrase gate, and no client-side allowlist to leak. Gate is clean disconnected (zero admin UI in the DOM, no spinner, no console spew).

### Wrong
- **[code-read] [MEDIUM] Premium Access card reads the zero address** — perpetual "..." stats and an Etherscan link to `0x0000…` (no `isDeployed` gate on the reads/card) (`AdminPage.tsx:197-200,382-387`).

### Needs improvement
- **[code-read] [MEDIUM] Pause/unpause success never refetches contract state; write errors are silent** — the ACTIVE/PAUSED pill keeps the pre-tx value until a window-refocus refetch; a rejection/gas-failure produces no toast (`AdminPage.tsx:188-210,90-95`).
- **[live] [POLISH] Gate card has no inline connect action** (mirror Farm's gate).

### Missing vs objective
- **[code-read] Timelock queue viewer** (page says pending ops are "managed via direct contract interaction").
- **[code-read] Recent-admin-events log; multi-contract pause panel** (pause covers only TegridyStaking).

### Polish
- **[code-read] [POLISH] Pending Fee renders "0 bps" instead of "None"; a comment says 30s refetch but the code is 10s** (`AdminPage.tsx:233,343`).

---

## Splash screens, skeletons & page-to-page transitions

This system is a recurring source of HIGH/CRITICAL findings and deserves its own verdicts.

### Splash screen (AppLoader) — verdict: keep the art, fix the gating
- **Duration:** ~10s minimum on mobile, ~15–25s on desktop, up to ~28–32s deep-linking to /swap (PORCH CHILL art → starfield → particle ring → CLICK/TAP TO ENTER → golden shatter). Several middle scenes are near-black for 4+ seconds. **[verified]**
- **Skippability:** **Not skippable mid-animation.** ESC is the only early skip and is keyboard-only (no touch equivalent), and ESC also permanently dismisses the unseen OnboardingModal **[code-read]**. Taps before "TAP TO ENTER" do nothing (`AppLoader.tsx:112,131-144`). The mandatory CLICK/TAP TO ENTER gate blocks even deep links. **[verified]**
- **Repeat-visit behavior:** sessionStorage `tf_loaded` only — so it **replays every new browser session and on every deep link** to /terms, /risks, /swap, even though `tegridy_first_visit` exists in localStorage. In-session reloads correctly skip it. A deliberate "Replay splash" easter-egg button exists (good). **[verified]**
- **Robustness bug:** a stalled image preload (no timeout in `preload.ts`) leaves an indefinite black screen with ESC/click inert — the RAF loop never starts (`AppLoader.tsx:205-218`). **[code-read]**
- **Asset bugs:** `/audio/ambient-loop.mp3` doesn't exist (guaranteed 404 per interaction); three splash JPGs (~500KB) are preloaded on every page view but the splash picks 4 random of 41. **[code-read]**
- **Exit:** the "glass shatter" shards lingered ~10s over live farm content on HEAD, covering stat cards. **[live]**
- **Fix (additive):** visible "Skip ▸" button from second 1 (mirror the existing mute button), any tap/keypress fast-forwards, auto-enter after the animation (no CLICK gate, or bypass for legal/info deep links), persist a once-ever localStorage flag, add a preload timeout, cap the shard exit ~1.5–2s with `pointer-events:none`, ship or remove the audio file.

### Skeletons — verdict: excellent where present, mismatched on Dashboard, absent on Swap
- **Dashboard** shows real shimmer skeleton cards — the best transition in the app — **but the logged-out skeleton advertises 8 stat cards + a chart that then collapse to a bare connect prompt** (bait-and-switch). **[verified]** While connection resolves, show a neutral spinner or the dimmed connect gate.
- **Swap route** has no skeleton: first frame is an almost-empty dark screen with a stray floating orange divider + ghost footer (~1–2s). **[verified]** Add the Dashboard-style skeleton to the swap chunk.
- **Community/Bounties/Grants** skeletons are dead code (static imports defeat the Suspense fallback); empty-vs-loading is conflated. **[code-read]**
- **Background/hero art pops in 5–14s late with no LQIP/fade** across Home, Swap, Liquidity, NFT-Finance, Gallery, Community. **[verified]** Add a blur-up/dominant-color placeholder to ArtImg.

### Page-to-page transitions — verdict: smooth SPA, but two frozen-tween bugs and an over-eager glitch overlay
- SPA client navigations are instant with pleasant framer fade/slide; scroll resets to top (back/forward also resets — no restoration). **[verified]**
- **Three "frozen tween" bugs share one root cause** (a framer entrance that starts then never settles to `opacity:1`): the **Gallery lightbox [CRITICAL]**, the **Swap token-selector modal [CRITICAL]**, and the **Swap tab-panes [HIGH]**. Fix the common animation-settle/`fill-forwards` issue once. **[verified]**
- A **1000ms full-screen pointer-blocking glitch overlay fires on every navigation including in-page tab switches**, on top of a `key={pathname}` remount that loses tab state and re-runs every query. **[code-read]** Exempt same-host tab nav and drop to ~400ms.
- The desktop glitch fetches up to 16 full-res images mid-transition with no preloading. **[code-read]**

---

## Responsive (iPhone 390 / iPad 820 / desktop 1440 / ultrawide 3432)

### Concrete layout breakages
- **[verified] [HIGH] Home horizontally overflows on iPhone — layout viewport expands to 414px on a 390px device** (all 20 other routes measure exactly 390/390). Culprit: a decorative div `absolute -left-6 -right-10 -top-8 -bottom-8` at width 422px (`HomePage.tsx:87`). Visible consequence: with the nav menu open, "Tegridy Score"/"Treasury"/the X close button render clipped past the viewport. **The only horizontal-overflow route in the app** — one-line `overflow-x-clip` fix.
- **[live] [MEDIUM] First-visit overlay pile-up on iPhone** — onboarding modal + consent banner + Towelie bubble at once; the consent Decline/Accept row sits at bottom 819–863 of an 896px viewport, inside the iOS home-indicator zone. Add `env(safe-area-inset-bottom)` + sequence the overlays.
- **[verified] [MEDIUM] Header ignores `env(safe-area-inset-top)`** in installed iOS standalone — status bar overlays the header (`TopNav.tsx:104`).
- **[live] [MEDIUM] Towelie bubble auto-pops on every route and occludes content** — calculator input, FDV value, story text, the "38,794 lines" stat, TVL cards, footer legal links, and it renders ON TOP of the opened nav drawer. On <640px: delay until idle, z-index below the drawer, offset above the tab bar.
- **[live] [MEDIUM] No path to Farm/Swap/Dashboard from the iPhone homepage menu** — the bottom tab bar is absent on `/` and the hamburger drawer holds only 4 secondary links (drawer is ~90% empty).
- **[verified] [MEDIUM] Subtitles set in white over busy/light artwork are illegible at 390px** on Security, FAQ, Dashboard, Swap, Liquidity, NFT-Finance (the dark cards on the same pages read fine — only over-art text suffers). Add a scrim/text-shadow band.
- **[live] [LOW] Translucent sticky sub-nav pill bar collides with H1s and ghosts underlying text** on Risks/Terms/Privacy at 390px — increase opacity/blur + `scroll-margin-top` on H1s.
- **[live] [LOW] NFT-Finance bottom chip row clips its 4th chip mid-word** with no scroll affordance at 390px.
- **[code-read] [POLISH] Info-page 5-tab bar is extremely tight on small phones** (~354px of buttons in ~358px); clips below 380px — allow horizontal scroll under ~380px.
- **[live] [POLISH] Leaderboard art-caption text bleeds behind the points panels** and tier rows fade under the sub-nav at 390px.

### iPad 820 / desktop 1440
- **[verified] No horizontal overflow anywhere at 820/820 and 1440/1440** across all routes. 820 gets a genuinely thoughtful tablet layout (full nav fits, stat tiles reflow 2-col); 1440 is the design sweet spot (proper 2-col tokenomics, all 5 farm tiles in one row) — the ultrawide problems below do not exist at 1440. **[verified]**
- **[live] [MEDIUM] Dashboard connect prompt is bare over camo art at 820** (Farm uses a dark card; Dashboard doesn't). **[verified]**

### Ultrawide 3432
- **[verified] [LOW] Non-art pages waste the ultrawide canvas** — /swap is a ~600px card in a black void; /community floats a ~450px card; /contracts and /treasury confine to a ~half-width column with huge side margins; /farm logged-out uses ~30% of width with an empty mid-band; /gallery caps at 3 columns with ~40% dead margins. Art-backed pages (Home/Farm/Dashboard) use the width beautifully. **Additive:** give Swap a side panel (chart/recent trades), let stat pages go 2-column, widen the gallery grid to 4–5 columns at ≥1600px, extend the mural/starfield to the void routes. (No art removed.)
- **[live] [POLISH] Mascot chat opens as a ~180px box in the corner** on a 1912px viewport — nearly invisible; give it a ~320px panel anchored above the mascot.

---

## TOP 15 priorities (impact-ranked)

1. **[CRITICAL] Redeploy prod from HEAD** — fixes the missing aggregator proxy (all 7 quote sources dead), the stale OpenSea/Gallery-votes builds, and the llamarpc demotion in one shot. Add a "0 aggregators responded" telemetry signal.
2. **[CRITICAL] Fix the approval-spender↔execution-venue mismatch** — every ERC20 sell currently reverts; derive the spender from the executing router via one shared helper + a test asserting `approve target === writeContract target` per route.
3. **[CRITICAL] Fix the three frozen-tween bugs** (Gallery lightbox, Swap token-selector modal, Swap tab-panes) — one shared `opacity:1`/`fill-forwards` settle fix unblocks the gallery and swap entirely.
4. **[HIGH] Fix the DCA + price-alert keepers** to quote and execute on the same venue (Uniswap-priced minOut sent through SFR on the empty native pool reverts every trigger).
5. **[HIGH] Pull the Immunefi $10k claim, the "Verified on Etherscan" badges, and the 0.30%-vs-0.5% Terms fee** — verified-false trust surfaces; derive verification live and read `SWAP_FEE_BPS` on-chain.
6. **[HIGH] Fix the Farm fake-stake receipt + the "penalty redistributed to stakers" copy** — set `lastActionRef` per action; correct the three strings to "treasury" (false financial claim).
7. **[HIGH] Add the visible "Skip" + auto-enter + once-ever localStorage to the splash** (and fix the preload-timeout black-screen + ESC-dismisses-onboarding bugs) — the ~10–30s unskippable gate on every session/deep link is where first-timers bounce.
8. **[HIGH] Stop the Dashboard from auto-firing DCA/limit wallet popups** (read-only count variant) and cap the Earnings Projection at the reward runway with the existing disclaimer.
9. **[HIGH] Surface read-only data pre-connect** on Farm, Dashboard, Swap, Liquidity, Community, and NFT-Finance — the single biggest conversion/trust gap; all are public reads.
10. **[HIGH] Fix the Home referral dead-domain `tegridy.farm`** and the forever-shimmering "ETH Distributed" hero pill — the one number that proves the on-chain-fees pitch.
11. **[HIGH] Fix the iPhone Home horizontal overflow** (`HomePage.tsx:87` decorative div → 414px) — one-line `overflow-x-clip`; also fixes the clipped nav menu.
12. **[HIGH] Gate the AMM "My Pools" track-any-address owner controls** behind `deployed` + on-chain `isPool` verification — the one gated control that fires value-bearing writes to a pasted EOA.
13. **[HIGH] Build the missing Community write-paths** — bounty submission/vote/complete funnel, proposal Execute/Cancel/Lapse, and fix the commit-reveal index/reconciliation (bond-forfeiture risk).
14. **[HIGH] Finish the light theme** (or scope it) — half-applied dark-on-dark headings/footer links app-wide read as a bug.
15. **[HIGH] Fix the Launchpad wizard draft-clobber** (empty "Resume") and the OwnerAdminPanel render/refetch loop before NFT-Finance un-gates.

## 10 quick wins (<1h each)

1. **Offset the Protocol-Active price pill `right-24` on md+** (or stack above the mascot) — fixes the bottom-right occlusion on every page.
2. **Fix `formatTimeAgo` future-timestamp handling** (`formatting.ts:42`) — kills "Ends just now" on every live proposal/bounty.
3. **Default `/premium` to the Points tab** until PremiumAccess deploys — stops landing on an empty SOON tab.
4. **Flip `POLAccumulator live:false → true`** (Tokenomics) and replace the Dashboard POL "Coming Soon" dead-code gate.
5. **Wire `pos.refetchAll()` into the Farm/Dashboard claim/approve success effects** — removes the 30s stale "Approve TOWELI" / double-claim window.
6. **Add `<MotionConfig reducedMotion="user">`** around the LazyMotion tree — one line, app-wide reduced-motion.
7. **Track copied state per button** on the Home referral box (both buttons currently flip to "Copied!").
8. **Mark Treasury `source: 'external (Safe multisig)'`** (Contracts) — stops the 404 GitHub link; fix the `0xEeee`→zero-address Odos `'zero'` branch (`aggregator.ts:35`).
9. **Update the Changelog with a June-2026 Relaunch entry** and refresh the Terms "Last updated" date + 0.5% fee.
10. **Add `aria-current="page"` + a `:focus-visible` ring to nav links**, and `tabindex="-1"` to `#main-content` for the skip link.
