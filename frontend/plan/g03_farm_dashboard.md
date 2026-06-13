# Remediation Plan — g03_farm_dashboard (Farm page + Dashboard page)

Surface: `/farm` (FarmPage.tsx + farm components/hooks) and `/dashboard` (DashboardPage.tsx + dashboard hooks).
Verified at HEAD of `mvp-launch`. Every finding below was confirmed against the cited file:line before planning.

**Systemic note:** the single highest-leverage fix on this surface is a shared **"track last action before write, refetch after success, snapshot at submit"** pattern (T5). It closes F95, F102, F105, F106, F137 at once. The second-biggest is **chainId-pin parity** (T9) closing F103/F134/F149, and the third is the **logged-out read-only preview** (T7) closing F115/F138/F164/F169/F170/F175.

Two live-only items (F168 splash, F180 shatter) live in `components/loader/AppLoader.tsx`, which is app-wide, not farm/dashboard-specific — flagged but fixed once for the whole app.

---

## Batch: receipt-action-tracking
**Summary:** FarmPage's success effect defaults `lastActionRef ?? 'stake'`, so any write whose action wasn't tagged (approve, extendLock, toggleAutoMaxLock, revalidateBoost, claimUnsettled, emergencyExit) shows a fabricated stake receipt + confetti (T4/T5). Fix once: tag every write with its `ReceiptType`, add an `'approve'` branch (type already exists), and skip the receipt when `lastActionRef` is null instead of assuming stake. Snapshot claim/unstake values at submit time while here (F106 rides along).

### F95 — Approve (and 5 other actions) fire a fake 'stake' receipt + confetti
- **verdict:** fix-now · **rootCause:** T4 · **severity:** high · **effort:** M · **risk:** med
- **approach:** In `FarmPage.tsx`, set `lastActionRef.current` (and an `approve` snapshot) before each `actions.approve` call (line 110) and verify every other action handler sets its type. In the success effect (`FarmPage.tsx:119-167`) replace `const actionType = lastActionRef.current ?? 'stake'` with an early-return when null, add an `else if (actionType === 'approve')` branch using `RECEIPT_COPY.approve` (already in `lib/copy.ts:35`), and gate `confetti.fire()` to real `stake`/`claim` only (already does — keep it but ensure approve never reaches it). The 4 actions invoked from `StakingCard` (extendLock `:200`, toggleAutoMaxLock `:289`, revalidateBoost `:127`, claimUnsettled `:221`) write through `actions.*` without tagging — give each a `lastActionRef.current = '<type>'` at the call site (StakingCard already receives `lastActionRef` as a prop, line 62/68).
- **files:** `src/pages/FarmPage.tsx:110`, `src/pages/FarmPage.tsx:119-167`, `src/components/farm/StakingCard.tsx:127`, `:200`, `:221`, `:289`
- **test:** Manual: first-time staker hits Approve → confirm no receipt/confetti, only the existing toast. Stake → real stake receipt fires once. Extend-lock/auto-max/revalidate → no stake receipt. Add a unit test for a `resolveReceipt(actionType|null)` helper asserting `null → no showReceipt call`.
- **deps:** [] · **batchHint:** receipt-action-tracking

### F106 — Claim/unstake receipts read live position values at confirm time (race → "claimed 0")
- **verdict:** fix-now · **rootCause:** T5 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Mirror the existing stake snapshot pattern (`submittedDataRef`, `FarmPage.tsx:69-70,113`). In the claim onClick (`StakingCard.tsx:212`) and the withdraw/earlyWithdraw confirm onClicks (`:245`, `:279`) capture `pos.pendingFormatted` / `pos.stakedFormatted` into a ref at submit, and read that snapshot in the receipt effect (`FarmPage.tsx:142,151`) instead of the live `pos.*`.
- **files:** `src/pages/FarmPage.tsx:142`, `:151`, `src/components/farm/StakingCard.tsx:212`, `:245`, `:279`
- **test:** Manual: claim with a 30s poll mid-flight — receipt shows the pre-claim amount, not 0. Lands in the same commit as F95 (both touch the receipt effect).
- **deps:** [F95] · **batchHint:** receipt-action-tracking

---

## Batch: refetch-after-write
**Summary:** Success effects fire a toast but never refetch (T5), so allowance/position/pendingETH stay stale up to 30s and CTAs are immediately re-clickable (double-approve, double-claim). `useUserPosition.refetchAll` (`:66-68`) and `useRevenueStats.refetch` (`:95`) already exist — wire them into the isSuccess effects. `useRevenueStats` already does this correctly and is the reference pattern.

### F102 — No refetch after tx success (approve button stays "Approve TOWELI" up to 30s)
- **verdict:** fix-now · **rootCause:** T5 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** In `FarmPage.tsx` success effect (after `:121` hash-guard), call `pos.refetchAll()` and clear `stakeAmount` (`setStakeAmount('')`) after a confirmed stake. A single targeted refetch is not a poll storm. For LP, restore a one-shot `lpFarm.refetch()` in `useLPFarming.ts` success effect (`:93` deliberately removed it) gated to fire once per hash — or call it from `LPFarmingSection` on `isSuccess`.
- **files:** `src/pages/FarmPage.tsx:119-167`, `src/hooks/useLPFarming.ts:93`, `src/components/farm/LPFarmingSection.tsx:25-30`
- **test:** Manual: approve → CTA flips to "Stake & Lock…" within ~1 block, not 30s. Stake → form clears and "Your Position" appears promptly. No second-approval possible.
- **deps:** [] · **batchHint:** refetch-after-write

### F137 — Dashboard claim success never refetches; Claim button immediately re-clickable
- **verdict:** fix-now · **rootCause:** T5 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** In `DashboardPage.tsx` claim-toast effect (`:118-124`) add `pos.refetchAll()` after the toast. In `ETHRevenueClaim` (`:606-611`) trigger a refetch of the `pendingETH` read on `isClaimSuccess` (the `useReadContract` at `:588` exposes a `refetch`; destructure and call it). Mirror `useRevenueStats.ts:92-104` which already does `refetch()` on `isSuccess`.
- **files:** `src/pages/DashboardPage.tsx:118-124`, `:588`, `:606-611`
- **test:** Manual on Positions/Rewards tab: after "Rewards claimed successfully!" the Claimable card and Claim button drop to ~0 within a block; a second click is blocked. Same for Claim ETH.
- **deps:** [] · **batchHint:** refetch-after-write

### F105 — LP "Approve" confirmation wipes the typed stake amount
- **verdict:** fix-now · **rootCause:** T5 · **severity:** low · **effort:** S · **risk:** low
- **approach:** `LPFarmingSection.tsx:25-30` clears both inputs on any `lpFarm.isSuccess`, which fires for approve too (`useLPFarming.ts:24` covers every write). Track the last LP action (approve vs stake/withdraw) — either a small `lastLpAction` ref set in the button onClicks (`:241`, `:249`, `:285`) or expose the pending `functionName` from `useLPFarming` — and only clear inputs on stake/withdraw success, not approve.
- **files:** `src/components/farm/LPFarmingSection.tsx:25-30`, `:241`, `:249`, `:285`
- **test:** Manual: type LP amount → Approve LP → after confirm the amount is still in the box, ready to Stake.
- **deps:** [] · **batchHint:** refetch-after-write

---

## Batch: dashboard-loans-refresh
**Summary:** The loans data layer is frozen after first load (T5): the 60s interval is a no-op identity setState, the NFT effect has no interval at all, and overdue status is computed against a `now` frozen in a useMemo. One root fix (a `refreshNonce` tick + per-render `now`) makes both effects re-run and statuses flip live; the empty-state/loading and countdown findings ride the same area.

### F130 — Loans never refresh after initial load; status frozen against a stale timestamp
- **verdict:** fix-now · **rootCause:** T5 · **severity:** high · **effort:** M · **risk:** med
- **approach:** In `useMyLoans.ts` replace the no-op `setTokenLoading((p) => p)` interval (`:117-121`) with a `refreshNonce` state incremented every `REFETCH_MS`; add `refreshNonce` to **both** scan effects' deps (`:123`, `:163`) so each re-runs, and give the NFT effect its own interval (it has none). Recompute `now` so overdue flips live — either move `now` out of the useMemo to a per-render `Math.floor(Date.now()/1000)` keyed minute-tick state, or add a `minuteTick` state to the `outstanding` useMemo deps (`:226`). Fix the stale `60s refetch` header comment (`:8-9`).
- **files:** `src/hooks/useMyLoans.ts:117-123`, `:125-163`, `:165-167`, `:226`, `:8-9`
- **test:** Manual: create/repay a loan in a second tab → the Loans tab updates within ~60s without a page reload. Unit: a loan with `deadline = now+30s` flips `status` to `overdue` after the minute-tick advances past it. Extend an existing useMyLoans test if present.
- **deps:** [] · **batchHint:** dashboard-loans-refresh

### F136 — Loans tab flashes "No outstanding loans" while still loading (isLoading unused)
- **verdict:** fix-now · **rootCause:** T11 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** `useMyLoans` already returns `isLoading: tokenLoading || nftLoading` (`:230`). In `DashboardPage.tsx:513` gate: `myLoans.isLoading ? <Skeleton loans card> : loans.length > 0 ? <OutstandingLoans/> : <empty state>`. Reuse the existing `Skeleton` component (already imported, `:21`).
- **files:** `src/pages/DashboardPage.tsx:513`
- **test:** Manual on a wallet with loans: throttle RPC → the empty-state + borrow CTAs no longer flash during the chunked scan; a skeleton shows instead.
- **deps:** [] · **batchHint:** dashboard-loans-refresh

### F146 — LoanRow countdown bottoms out at "Due in 0h" and never flips to overdue while mounted
- **verdict:** fix-now · **rootCause:** T5 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Defense-in-depth even after F130: in `LoanRow` (`DashboardPage.tsx:715-720`) derive overdue locally from `remaining <= 0` rather than only `loan.status`, and show minutes when `remaining < 3600` (`${minutes}m`). The per-row minute tick (`:710-714`) already exists; just consume it for status too.
- **files:** `src/pages/DashboardPage.tsx:715-720`
- **test:** Manual: a loan within 1h shows "Due in 45m" then flips to "Overdue" at the deadline without reload.
- **deps:** [] · **batchHint:** dashboard-loans-refresh

---

## Batch: chainid-pin-parity
**Summary:** Several read hooks/reads omit `chainId: CHAIN_ID` (T9) so a wrong-chain wallet reads its current chain and returns 0n/wrong values — a real position renders as the empty "Stake" form, and the dashboard prices another chain's native token as ETH. The R043/R047 pattern is already applied to sibling hooks; just extend it. Low blast radius (adding a pin can only make reads more correct).

### F103 — chainId pinning inconsistent across farm read hooks
- **verdict:** fix-now · **rootCause:** T9 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Add `chainId: CHAIN_ID` to every contract entry in the unpinned hooks: `usePoolData.ts:11-20`, `useUserPosition.ts:18-24` and `:37-42`, `useRestaking.ts:20-32`, `usePoints.ts:35-39` and `:55-57`. Pattern is verbatim from the already-pinned `useFarmStats.ts:18-22` / `useLPFarming.ts:42-53` / `usePoolTVL.ts:21-29`. Also gate `query.enabled` on `onMainnet` where the siblings do.
- **files:** `src/hooks/usePoolData.ts:11-20`, `src/hooks/useUserPosition.ts:18-24`, `:37-42`, `src/hooks/useRestaking.ts:20-32`, `src/hooks/usePoints.ts:35-39`, `:55-57`
- **test:** Manual: connect a wallet on Base/Polygon with a mainnet position → "Your Position" still resolves from mainnet (or shows the wrong-chain banner), never the fresh empty stake form sourced from the wrong chain.
- **deps:** [] · **batchHint:** chainid-pin-parity

### F134 — Dashboard ETH + TOWELI balance reads not chain-pinned (wrong-network portfolio mis-prices)
- **verdict:** fix-now · **rootCause:** T9 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Add `chainId: CHAIN_ID` to `useBalance` (`DashboardPage.tsx:67`) and the TOWELI `useReadContract` (`:81-87`). Matches the R047 M1 pin already used in `ETHRevenueClaim` (`:588-594`). Optionally gate both `enabled` on `onCorrectChain`.
- **files:** `src/pages/DashboardPage.tsx:67`, `:81-87`
- **test:** Manual: wallet on a non-mainnet chain → ETH Balance card and Portfolio Value don't multiply that chain's native balance by mainnet ETH/USD.
- **deps:** [] · **batchHint:** chainid-pin-parity

### F149 — pendingETH polled via three queries; the useRevenueStats batch isn't chain-pinned
- **verdict:** fix-now · **rootCause:** T9 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Add `chainId: CHAIN_ID` to every entry of the `useRevenueStats.ts:21-38` multicall (siblings `useFarmActions` and `ETHRevenueClaim` pin it). Optionally source `ETHRevenueClaim`'s pendingETH from `useRevenueStats.pendingRevenueBig` (`:113`) instead of a third independent read so it dedupes — but keep that change minimal/optional to avoid coupling the Rewards card to the 30s batch cadence.
- **files:** `src/hooks/useRevenueStats.ts:21-38`
- **test:** Manual: confirm pendingETH no longer fetched on the wrong chain; one fewer doomed read on a wrong-network dashboard load.
- **deps:** [] · **batchHint:** chainid-pin-parity

---

## Batch: logged-out-preview
**Summary:** Read-only public data (pools, TVL, APR schedule, price chart) is hidden behind the connect wall on both pages (T7). All the data hooks are connection-independent. Additively render the read-only sections pre-connect, keeping the existing art hero and ConnectPrompt for the action slot (owner mandate: additive only).

### F115 — Pre-connect farm visitors can't see boost schedule, pools, or stats
- **verdict:** fix-now · **rootCause:** T7 · **severity:** low · **effort:** M · **risk:** low
- **approach:** In the `!isConnected` branch (`FarmPage.tsx:171-186`) additively render `FarmStatsRow`, the Liquidity Pools grid (`LivePoolCard`), the LP-farming stats header, and `BoostScheduleTable` below `IncentivesStrip` — all read from connection-independent hooks already instantiated at the top of `FarmPage`. Keep `ConnectPrompt` for the action-card slot; swap stake/claim buttons inside reused components to a "Connect to stake" affordance where they'd otherwise be interactive.
- **files:** `src/pages/FarmPage.tsx:171-186`
- **test:** Manual logged-out `/farm`: TVL, pool card, boost/APR schedule render; only the stake form is gated. Compare against the connected view to confirm parity of read-only data.
- **deps:** [] · **batchHint:** logged-out-preview

### F169 — (live) Entire pool/farm content hidden behind connect wall
- **verdict:** fix-now · **rootCause:** T7 · **severity:** high · **effort:** M · **risk:** low
- **approach:** Same fix as F115 (this is the live-observed manifestation of the same code path). Once the disconnected branch renders the read-only sections, the live "only 5 chips + connect card" symptom is resolved. Note prod also needs a redeploy (T1) — the stale prod build pre-dates this fix.
- **files:** `src/pages/FarmPage.tsx:171-186`
- **test:** Live: logged-out `/farm` shows pools + APR + boost schedule (matches Aerodrome/Curve read-only behavior). Re-deploy after merge.
- **deps:** [F115] · **batchHint:** logged-out-preview

### F138 — Dashboard disconnected view hides wallet-independent content (price chart, TOWELI price, sparkline)
- **verdict:** fix-now · **rootCause:** T7 · **severity:** medium · **effort:** M · **risk:** low
- **approach:** In `DashboardPage.tsx:146-169` additively render `PriceChart` + a TOWELI-price stat card (both wallet-independent — `useToweliPrice`/`usePriceHistory` need no address) under the existing Connect CTA, keeping the jungle art hero untouched. Reuse the existing `PriceChart` and the summary-stat card markup.
- **files:** `src/pages/DashboardPage.tsx:146-169`
- **test:** Manual logged-out `/dashboard`: price card + chart render over the art; connect CTA still present.
- **deps:** [] · **batchHint:** logged-out-preview

### F170 — (live) Dashboard is an empty void when logged out
- **verdict:** fix-now · **rootCause:** T7 · **severity:** high · **effort:** M · **risk:** low
- **approach:** Live manifestation of F138. Implement F138 plus a small protocol-stats strip (TOWELI price, TVL, emissions, fee share) reusing `IncentivesStrip`/`FarmStatsRow` data hooks so logged-out visitors get readable density. Additive over the jungle art.
- **files:** `src/pages/DashboardPage.tsx:146-169`
- **test:** Live: logged-out `/dashboard` shows price + protocol stats. Re-deploy after merge.
- **deps:** [F138] · **batchHint:** logged-out-preview

### F164 — (best-in-class) Wallet-independent preview when disconnected
- **verdict:** duplicate · **rootCause:** T7 · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate of F138/F170 (dashboard) and F115/F169 (farm). Closed by the logged-out-preview batch — no separate work.
- **files:** `src/pages/DashboardPage.tsx:146-169`, `src/pages/FarmPage.tsx:171-186`
- **test:** Covered by F138/F169 tests.
- **deps:** [F138, F169] · **batchHint:** logged-out-preview

---

## Batch: emissions-runway-honesty
**Summary:** Multiple surfaces present emission/APR/reward figures without the runway/period-end context the hooks already compute (T3/T4) — they'll over-promise after the Sept-4 cliff. `usePoolData` exposes `secondsRemaining`/`aprDisclaimer`/`rewardsRemaining`; `useLPFarming` exposes `isActive`/`periodFinish`. Surface them.

### F100 — LP "Est. APR" and "Reward Rate" ignore periodFinish (shows live APR after emissions end)
- **verdict:** fix-now · **rootCause:** T3 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** `useLPFarming.ts:72-77` computes `rewardRatePerDay`/`rewardRatePerYear` from raw storage `rewardRate` which stays non-zero after `periodFinish`. Zero them when `!isActive` (`isActive` already computed at `:70`): `const rewardRatePerDay = isActive ? ... : 0`. In `LPFarmingSection.tsx:39-47` the `lpApr` memo then naturally returns ~0; render "period ended — awaiting refill" via the existing null branch (`:130-135`) when `!isActive && totalStaked > 0n`.
- **files:** `src/hooks/useLPFarming.ts:72-77`, `src/components/farm/LPFarmingSection.tsx:39-47`, `:144-145`
- **test:** Unit: set `periodFinish` in the past → `rewardRatePerDay === 0`, headline APR not positive. Manual: after period lapse the "X / day" reward rate and APR don't advertise live yield.
- **deps:** [] · **batchHint:** emissions-runway-honesty

### F101 — "Reward Pool" stat shows cumulative totalRewardsFunded as if remaining
- **verdict:** fix-now · **rootCause:** T3 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** `useFarmStats.ts:40` feeds `rewardPool` from `totalFunded` (cumulative, never decreases) into `IncentivesStrip` labeled "Reward Pool". The honest figure `pool.rewardsRemaining` already exists in `usePoolData.ts:79` and is on the page (`FarmPage` instantiates `usePoolData` at `:56`). Either pass `pool.rewardsRemaining` into `IncentivesStrip` (`FarmPage.tsx:180,209`) or relabel the chip to "Total Rewards Funded" (`IncentivesStrip.tsx:33`). Prefer surfacing rewardsRemaining for honesty.
- **files:** `src/hooks/useFarmStats.ts:40`, `src/components/farm/IncentivesStrip.tsx:33`, `src/pages/FarmPage.tsx:180`, `:209`
- **test:** Manual: "Reward Pool" reflects balance−staked−unsettled (matches TokenomicsPage `:203`), not the ever-growing cumulative figure.
- **deps:** [] · **batchHint:** emissions-runway-honesty

### F131 — Earnings Projection extrapolates bootstrap APR to 1yr, omits runway + disclaimer
- **verdict:** fix-now · **rootCause:** T4 · **severity:** high · **effort:** S · **risk:** low
- **approach:** `Projections` (`DashboardPage.tsx:451,756-771`) takes `apr={pool.aprNum}` with no context. Additively render `pool.aprDisclaimer` ("Bootstrap rate — falls as staking grows", `usePoolData.ts:84`) under the "Earnings Projection" heading, and flag horizons longer than `pool.secondsRemaining` (`:77`) — e.g. dim the 1-Year cell or append "~ runway ends in Nd at current rate" when `m*86400 > secondsRemaining`. Pass `secondsRemaining`/`aprDisclaimer` into `Projections` as props.
- **files:** `src/pages/DashboardPage.tsx:447-453`, `:756-771`
- **test:** Manual: projection grid shows the bootstrap disclaimer; the 1-Year figure is flagged when it exceeds the reward runway.
- **deps:** [] · **batchHint:** emissions-runway-honesty

### F123 — (best-in-class) Emission runway / rewards-remaining on the Farm page itself
- **verdict:** fix-now · **rootCause:** T3 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Data exists (`usePoolData.rewardsRemaining`/`secondsRemaining`) but is only on `/tokenomics`. Add a "reward period ends in Xd" / "rewards remaining: Y TOWELI" line to `IncentivesStrip` or `FarmStatsRow` (Synthetix-style). Lands naturally alongside F101.
- **files:** `src/components/farm/IncentivesStrip.tsx:26-37`, `src/hooks/usePoolData.ts:77,79`
- **test:** Manual: Farm page shows a runway countdown that matches `/tokenomics`.
- **deps:** [F101] · **batchHint:** emissions-runway-honesty

---

## Batch: stale-launch-constants
**Summary:** Pre-relaunch hardcoded blocks/timestamps (T3) deflate or zero on-chain-derived figures: the pool age anchors to 2025-03-01 and two log scans start at block 18M (Sep-2023, ~3y before the 2026-06-06 relaunch deploy).

### F99 — POOL_LAUNCH_TIMESTAMP hardcoded to 2025-03-01 (fee-derived APR/volume understated)
- **verdict:** fix-now · **rootCause:** T3 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** `usePoolTVL.ts:10` anchors `poolAgeDays` (`:77-82`) to 2025-03-01. Replace with the SwapFeeRouter deploy timestamp — add a `SWAP_FEE_ROUTER_DEPLOY_TS` (or block) constant in `constants.ts` next to the relaunch address comments (2026-06-06), or read the first-fee block. Until `totalETHFees > 0n` this branch is inert, so the fix only matters once fees accrue — but it must be correct before then.
- **files:** `src/hooks/usePoolTVL.ts:10`, `:77-82`, `src/lib/constants.ts` (new deploy-ts constant)
- **test:** Unit: with `totalETHFees>0`, `poolAgeDays` ≈ days-since-2026-06-06, so `dailyFees`/APR aren't divided by ~465.
- **deps:** [] · **batchHint:** stale-launch-constants

### F108 — usePoints swap-log scan from block 18M; failure swallowed to 0; logAction is a dead no-op
- **verdict:** fix-now · **rootCause:** T3 · **severity:** low · **effort:** S · **risk:** low
- **approach:** `usePoints.ts:77` `fromBlock: 18000000n` predates deploy; the `.catch(() => setSwapCount(0))` (`:81-83`) hides RPC range rejections. Pin `fromBlock` to the SwapFeeRouter deploy block (shared constant with F99/F143), or chunk the range. Separately, `FarmPage.tsx:159` calls `points.logAction(...)` → `pointsEngine.recordAction` which is `@deprecated` and returns unchanged data (`pointsEngine.ts:189-192`); delete the dead `logAction` call and the `logAction`/`recordAction` export usage on this page.
- **files:** `src/hooks/usePoints.ts:73-83`, `src/pages/FarmPage.tsx:159`, `src/hooks/usePoints.ts:110-114` (logAction export)
- **test:** Manual: swap-derived points populate for a wallet with on-chain swaps. Lint/build: no remaining `logAction` caller.
- **deps:** [] · **batchHint:** stale-launch-constants

### F143 — useTegridyScore scans Staked logs from block 18M (3y before relaunch deploy)
- **verdict:** fix-now · **rootCause:** T3 · **severity:** low · **effort:** S · **risk:** low
- **approach:** `useTegridyScore.ts:327` `fromBlock: 18000000n` — the ~5M-block range trips the catch (`:338-343`) that zeroes the loyalty score (10% weight). Pin `fromBlock` to the staking-contract deploy block (same shared constant introduced in F99).
- **files:** `src/hooks/useTegridyScore.ts:326-328`, `src/lib/constants.ts` (shared deploy-block constant)
- **test:** Manual: loyalty leg of the Tegridy Score resolves for a staker instead of silently 0.
- **deps:** [F99] · **batchHint:** stale-launch-constants

---

## Batch: input-parse-safety
**Summary:** Raw `parseEther` in a render path can blank the page (T6), and `type="number"` inputs mangle scientific notation. The repo's own `safeParseEther` exists for exactly the first hazard.

### F98 — Raw parseEther(stakeAmount) in render path — page-killing crash via Max with dust balance
- **verdict:** fix-now · **rootCause:** T6 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** `FarmPage.tsx:105` runs `parseEther(stakeAmount)` every render with no try/catch; a dust balance through the Max button (`StakingCard.tsx:347-349`) yields exponent notation and throws → whole page blanks via ErrorBoundary. Replace with `safeParseEther(stakeAmount) ?? 0n` (import from `lib/safeParseEther.ts:51`). `StakingCard` already guards the identical parse (`:93-98`), proving the hazard is known.
- **files:** `src/pages/FarmPage.tsx:105`, import from `src/lib/safeParseEther.ts`
- **test:** Manual: wallet with <1e-6 TOWELI → click Max → page does not blank. Unit: `stakeNeedsApproval` computation with input `'1e-16'` returns a bigint, doesn't throw.
- **deps:** [] · **batchHint:** input-parse-safety

### F107 — type="number" + strip-regex mangles scientific-notation input ("1e5" → "15")
- **verdict:** fix-now · **rootCause:** T6 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Change the three staking/LP inputs from `type="number"` to `type="text" inputMode="decimal"` (the existing `.replace(/[^0-9.]/g,'')` already enforces decimal shape; `type="number"` is what admits the `e`). Standard DeFi pattern.
- **files:** `src/components/farm/StakingCard.tsx:355`, `src/components/farm/LPFarmingSection.tsx:209-212`, `:270-273`
- **test:** Manual: type `1e5` → field holds `15`? No — with `type=text` the `e` is stripped to `15` only if typed char-by-char; verify pasting `1e5` strips to `15` consistently and the staked amount equals what's shown (no silent 100000→15). Add a unit test on the onChange sanitizer.
- **deps:** [] · **batchHint:** input-parse-safety

### F111 — Withdraw-LP input not validated against staked balance (builds a reverting tx)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** `LPFarmingSection.tsx:284` disables only on `<=0 || stakedBalance===0n`; an over-staked amount submits and reverts in-wallet. Add an `overStaked` check mirroring the stake-side `belowMin` pattern (`:221-236`): when `parseEther(lpWithdrawAmount) > lpFarm.stakedBalance`, disable with a "Max X LP" label.
- **files:** `src/components/farm/LPFarmingSection.tsx:282-288`
- **test:** Manual: enter more than staked → button disabled with "Max …" label, no wallet revert-fallback gas estimate.
- **deps:** [] · **batchHint:** input-parse-safety

---

## Batch: copy-truth-fixes
**Summary:** Three financial/labeling copy errors (T4) — the page contradicts the contract on penalty destination, mislabels limit orders, and calls a simple-APR figure "APY".

### F96 — Copy claims 25% early-exit penalty "redistributed to stakers" — contract sends 100% to treasury
- **verdict:** fix-now · **rootCause:** T4 · **severity:** high · **effort:** S · **risk:** low
- **approach:** Correct the three "redistributed to stakers" strings to say treasury, keeping the Towelie voice (additive copy edit, owner mandate respected). `TegridyStaking.sol:1271` transfers the penalty to `treasury`, and `StakingCard`'s own confirm dialog already says "sent to treasury" (`:270`) — the card contradicts itself.
- **files:** `src/components/farm/StakingCard.tsx:448`, `src/components/farm/BoostScheduleTable.tsx:105`, `src/lib/copy.ts:74` (`earlyExitTooltip`)
- **test:** Manual: all three surfaces say the penalty goes to the treasury; no "redistributed to stakers" remains (grep).
- **deps:** [] · **batchHint:** copy-truth-fixes

### F133 — Active limit orders mislabeled "price alerts" directly above the real Price Alerts widget
- **verdict:** fix-now · **rootCause:** T4 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** `DashboardPage.tsx:333` renders `{n} active price alert(s)` for `limitOrders.activeOrders.length` — these are limit orders, and the real `PriceAlertWidget` (different feature) sits ~6 lines below at `:341`. Change the string to "{n} active limit order(s)" and the sub-line ("Check Swap for details") stays valid.
- **files:** `src/pages/DashboardPage.tsx:333`
- **test:** Manual: card reads "active limit order(s)"; no two features share the name "price alerts" on one screen.
- **deps:** [] · **batchHint:** copy-truth-fixes

### F116 — Boosted rate labeled "APY" but the math is simple APR
- **verdict:** fix-now · **rootCause:** T4 · **severity:** polish · **effort:** S · **risk:** low
- **approach:** `BoostScheduleTable.tsx:52` and `:85` label `baseApr × boost` (straight-line, no compounding) as "APY", contradicting IncentivesStrip/FarmStatsRow/StakingCard which say "APR". Rename to "APR" in both the desktop and mobile branches.
- **files:** `src/components/farm/BoostScheduleTable.tsx:52`, `:85`
- **test:** Manual: boost schedule says "% APR" consistent with the rest of the page.
- **deps:** [] · **batchHint:** copy-truth-fixes

---

## Batch: fee-share-live
**Summary:** "100% to stakers" / "100% of protocol swap fees" are hardcoded (T3/T4) while `SwapFeeRouter.stakerShareBps` is governance-mutable down to 5,000 bps. Verified accurate today (`stakerShareBps == 10_000`) but drifts silently.

### F109 — "100% to stakers" fee-share claims hardcoded while split is governance-mutable to 50%
- **verdict:** fix-now · **rootCause:** T3 · **severity:** low · **effort:** M · **risk:** low
- **approach:** Read `stakerShareBps` on-chain — add one entry to the existing `usePoolTVL.ts` multicall (`:25-29` already reads SwapFeeRouter views like `feeBps`) and surface the live percentage. Render `stakerShareBps/100 + '% to stakers'` in `IncentivesStrip.tsx:36`; for `ConnectPrompt.tsx:29` either parametrize the copy or soften to "the protocol's swap-fee share routes to stakers" so it can't drift. Accurate today, so this is drift-prevention, not a current lie.
- **files:** `src/hooks/usePoolTVL.ts:25-29`, `src/components/farm/IncentivesStrip.tsx:36`, `src/components/ui/ConnectPrompt.tsx:29`
- **test:** Manual: set `stakerShareBps` to 5000 on a fork → the chip reads "50% to stakers" without a frontend change.
- **deps:** [] · **batchHint:** fee-share-live

---

## Batch: pool-card-honesty
**Summary:** The live pool card hard-codes a "HOT" badge and invents a 24h-volume number from a guessed turnover ratio (T4) on an unseeded pool — the exact vaporware signal poolConfig was cleaned up to avoid.

### F117 — "🔥 HOT" badge hardcoded on a currently-unseeded/empty pool
- **verdict:** fix-now · **rootCause:** T4 · **severity:** polish · **effort:** S · **risk:** low
- **approach:** `LivePoolCard.tsx:29` renders `<PoolStatusBadge status="hot" />` unconditionally. Derive from `poolData`: `status="live"` once `poolData.tvl > 0` (or `isLoaded && tvlFormatted !== '–'`), and hide the badge otherwise. `usePoolTVL` already returns `tvl`/`isLoaded`.
- **files:** `src/components/farm/LivePoolCard.tsx:29`
- **test:** Manual: unseeded pool (dash TVL) shows no HOT badge; once seeded it shows "live".
- **deps:** [] · **batchHint:** pool-card-honesty

### F119 — Fallback 24h volume invented from a guessed turnover ratio
- **verdict:** fix-now · **rootCause:** T4 · **severity:** polish · **effort:** S · **risk:** low
- **approach:** `usePoolTVL.ts:93-102` synthesizes `vol24h = tvl × {1-4%}` when no fee data exists; `LivePoolCard.tsx:44` shows it as "Est. 24h Vol". Per the honesty bar, return a sentinel ("— no volume data yet") until `totalSwaps`/`totalETHFees` exist — `totalSwaps` is already read at multicall index 4 but unused (`:71`); wire it into the gate. Keep the real fee-derived branch (`:74-92`) intact.
- **files:** `src/hooks/usePoolTVL.ts:71`, `:93-102`, `:111-117`, `src/components/farm/LivePoolCard.tsx:44`
- **test:** Manual: with zero swaps the card shows "no volume data yet", not a fabricated $ figure; once swaps occur the real number renders.
- **deps:** [] · **batchHint:** pool-card-honesty

---

## Batch: price-liveness
**Summary:** Headline price + sparkline + chart fetch once per mount with no refresh interval (T8/T11) — frozen for the session while a `PulseDot`/"Live" implies liveness; the PriceContext memo also drops three TWAP/swap-safety flags so consumers read stale values.

### F110 — Headline TOWELI price + sparkline frozen at page-load for the whole session
- **verdict:** fix-now · **rootCause:** T8 · **severity:** low · **effort:** S · **risk:** low
- **approach:** `useToweliPrice.ts:112-138` (GeckoTerminal fallback) and `usePriceHistory.ts:31-127` both fetch once (empty dep array) with no interval. Add a visibility-aware `setInterval` (~60s, matching on-chain reads) that re-runs the fetch while the pair is unseeded / API is the source. Guard against tab-hidden churn (`document.visibilityState`) to respect the prod rate-limiter.
- **files:** `src/hooks/useToweliPrice.ts:112-138`, `src/hooks/usePriceHistory.ts:31-127`
- **test:** Manual: leave `/farm` open with unseeded pair → price/sparkline refresh ~every 60s, not frozen; hidden tab pauses the poll.
- **deps:** [] · **batchHint:** price-liveness

### F144 — PriceContext memo dep list omits twapPriceInEth / twapOverrideActive / priceSafeForSwaps
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** `PriceContext.tsx:15-29` memoizes `price` but the dep array (`:17-28`) drops `twapPriceInEth`, `twapOverrideActive`, `priceSafeForSwaps` (returned at `useToweliPrice.ts:277-279`). When only those flip, the memo returns the previous object and swap surfaces read stale safety flags. Add the three fields to the dep array.
- **files:** `src/contexts/PriceContext.tsx:17-28`
- **test:** Unit/manual: on a fork where TWAP starts overriding spot but USD lands the same via API, `priceSafeForSwaps` propagates to consumers (Dashboard doesn't read them but swap pages do — verify no regression there).
- **deps:** [] · **batchHint:** price-liveness

### F152 — PriceChart comment claims a same-origin proxy it doesn't use; dead _currentPrice param
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** S · **risk:** low
- **approach:** `PriceChart.tsx:46-47` comments "same-origin proxy" directly above a direct cross-origin `api.geckoterminal.com` fetch (`:47`). Fix the stale comment to describe the actual direct-fetch + retry + embed fallback. Separately, `usePriceHistory.ts:25` `_currentPrice` is ignored and `DashboardPage.tsx:78`/`FarmPage.tsx:62` pass `price.priceInUsd` for nothing — either drop the param (and the two call-site args) or implement live-tick appending (see F154). Minimal fix: drop the dead param + correct the comment.
- **files:** `src/components/chart/PriceChart.tsx:46-47`, `src/hooks/usePriceHistory.ts:25`, `src/pages/DashboardPage.tsx:78`, `src/pages/FarmPage.tsx:62`
- **test:** Build: no unused-param warning; comment matches code. Manual: chart still loads via the embed fallback on Safari ITP.
- **deps:** [] · **batchHint:** price-liveness

---

## Batch: dashboard-stale-display
**Summary:** Dashboard render-time honesty bugs (T6/T11) — silent oracle-zeroing of the headline, mis-gated skeletons, unreachable error states, and raw formatEther.

### F135 — Portfolio Value silently drops all ETH legs when the oracle is stale, no indicator on the number
- **verdict:** fix-now · **rootCause:** T6 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** `DashboardPage.tsx:96-106` zeroes the ETH + WETH legs when `price.oracleStale`, with no cue on the headline counter — the user sees their portfolio "drop" by their ETH balance. Additively show a stale badge next to the Portfolio Value counter (`:204`) when `price.oracleStale`, or keep the last-good `ethUsd` with the stale flag rather than zeroing. Reuse the existing "Stale" chip styling already used on the TOWELI Price card (`:249-252`).
- **files:** `src/pages/DashboardPage.tsx:96-106`, `:202-209`
- **test:** Manual: force `oracleStale` → Portfolio Value shows a "Stale" badge instead of silently shrinking by the ETH value.
- **deps:** [] · **batchHint:** dashboard-stale-display

### F141 — "Claimable" card skeleton gated on price loading, not position loading
- **verdict:** fix-now · **rootCause:** T11 · **severity:** low · **effort:** S · **risk:** low
- **approach:** `DashboardPage.tsx:217` sets `loading: !price.isLoaded` for the Claimable card, but `pendingTotal` comes from `useUserPosition`, not price. Gate the value's skeleton on `pos.isLoading` (`useUserPosition.ts:93`) and keep `price.isLoaded` only for the USD sub-line. Prevents "0.00" while the position loads and an eternal skeleton when the price feed is unavailable but the TOWELI amount is known.
- **files:** `src/pages/DashboardPage.tsx:217`
- **test:** Manual: with a known position but failed price feed, Claimable shows the TOWELI amount (no perpetual skeleton); with price loaded but position pending, it shows a skeleton not "0.00".
- **deps:** [] · **batchHint:** dashboard-stale-display

### F142 — ETHRevenueClaim error indicator is unreachable dead code
- **verdict:** fix-now · **rootCause:** T11 · **severity:** low · **effort:** S · **risk:** low
- **approach:** `DashboardPage.tsx:613` wraps the whole card in `if (pending > 0)`, so on a read error (`pendingETH` undefined → `pending = 0` at `:600`) the component returns null (`:640`) and the `pendingError` dot (`:624-626`) can never render — RPC failure is indistinguishable from "nothing to claim". Render a small error row when `pendingError && !pending` (before the `pending > 0` early return) so claimable ETH can't vanish behind an RPC failure.
- **files:** `src/pages/DashboardPage.tsx:600`, `:613`, `:624-626`, `:640`
- **test:** Manual: force a `pendingETH` read error → an error row/dot appears instead of the card silently disappearing.
- **deps:** [] · **batchHint:** dashboard-stale-display

### F140 — "ETH owed" shows principal only (no accrued interest) and uses raw formatEther
- **verdict:** fix-now · **rootCause:** T6 · **severity:** low · **effort:** M · **risk:** low
- **approach:** `OutstandingLoans` (`DashboardPage.tsx:647`) sums `l.principal` only; the true repayment is `principal + accrued interest` (the per-row `aprBps` at `:742` is never accrued). Either accrue `principal * aprBps * elapsed / year / 10000` into the owed total, or relabel "owed" → "principal". Also replace raw `formatEther` (`:677`, `:682`, `:741`) with `formatWei(value, 18, 4)` (`lib/formatting.ts:61`) to bound decimals.
- **files:** `src/pages/DashboardPage.tsx:647`, `:677`, `:682`, `:741`
- **test:** Manual: ETH-owed shows a bounded 4-decimal figure; if accruing interest, it exceeds bare principal by the expected amount; otherwise the label reads "principal".
- **deps:** [F130] · **batchHint:** dashboard-stale-display

---

## Batch: dca-execution-honesty
**Summary:** Mounting the Dashboard to show DCA/limit-order counts also mounts the executor pollers, which auto-fire wallet popups on the Dashboard while the copy says "Go to Swap to execute" (T4) — and double the RPC load (T8). One fix (read-only summary hooks) addresses both.

### F132 — Mounting Dashboard can auto-fire DCA/limit-order wallet popups; copy says "Go to Swap"
- **verdict:** fix-now · **rootCause:** T4 · **severity:** high · **effort:** M · **risk:** med
- **approach:** `DashboardPage.tsx:72-73` mounts `useDCA()`/`useLimitOrders()` only for counts, but both run executor pollers: `useDCA.ts:537-563` calls `checkDue()` on mount + every 30s → `executeDCASwap` → `writeContract` (popup), and `useLimitOrders.ts:441-522` polls and calls `executeOrder` → `writeContract`. Extract read-only `useDCASummary`/`useLimitOrderSummary` that parse the same localStorage payloads without pollers or `writeContract`, and consume those on the Dashboard so execution stays on `/swap`. (Cheaper alternative if a split is too large: make the copy honest — "a swap prompt will appear here when due" — but the read-only split is the correct fix and also closes F147.)
- **files:** `src/pages/DashboardPage.tsx:72-73`, new `src/hooks/useDCASummary.ts` + `useLimitOrderSummary.ts` (or guard the executor effects behind a `readOnly` flag in the existing hooks)
- **test:** Manual: a wallet with a due DCA schedule lands on `/dashboard` → no unprompted wallet signing request; the banner count still shows; execution only happens on `/swap`.
- **deps:** [] · **batchHint:** dca-execution-honesty

### F147 — Two ~550-line executor hooks mounted only to render two badge counts
- **verdict:** duplicate · **rootCause:** T8 · **severity:** low · **effort:** M · **risk:** low
- **approach:** Same root cause and same fix as F132 — the read-only summary hooks remove the dashboard's getAmountsOut RPC loops and BroadcastChannel plumbing. No separate work; closed by dca-execution-honesty.
- **files:** `src/pages/DashboardPage.tsx:72-73`
- **test:** Covered by F132; additionally confirm the dashboard no longer fires getAmountsOut every 15s.
- **deps:** [F132] · **batchHint:** dca-execution-honesty

---

## Batch: pol-accumulator-live
**Summary:** A deploy-gated "Coming Soon" card is now permanently hidden because the contract is deployed, with nothing live in its place (T1/T3).

### F139 — POL Accumulator "Coming Soon" card is dead code (contract deployed; gate hides it forever)
- **verdict:** fix-now · **rootCause:** T3 · **severity:** medium · **effort:** M · **risk:** low
- **approach:** `DashboardPage.tsx:372` `{!isDeployed(POL_ACCUMULATOR_ADDRESS) && (...)}` — `POL_ACCUMULATOR_ADDRESS` is a real non-zero address (`constants.ts:23`, RELAUNCH 2026-06-06) and `isDeployed` is a zero-address check (`:112-114`), so the condition is permanently false and the card (+ its art slot idx=8) never renders. Add a live POL widget for the deployed branch — read accumulated LP / last buy from the POL accumulator contract — while keeping the existing Coming Soon card for the `!isDeployed` case (additive; art slot preserved). If the POL contract's read ABI isn't wired yet, this becomes part product-decision (which metrics to show); minimum viable: show "POL active" with accumulated LP balance.
- **files:** `src/pages/DashboardPage.tsx:372-388`, possibly new `src/hooks/usePOLAccumulator.ts`
- **test:** Manual: a deployed POL accumulator surfaces live accumulated-LP stats; an undeployed one still shows Coming Soon.
- **deps:** [] · **batchHint:** pol-accumulator-live

---

## Batch: accessibility
**Summary:** Keyboard/ARIA gaps across both pages (T10): unlinked labels, color-only selection, non-functional ARIA tabs, missing focus rings, menu Escape, near-invisible verified label, dead hover states.

### F104 — Farm staking accessibility gaps (label, color-only selection, no aria-pressed, no focus mgmt)
- **verdict:** fix-now · **rootCause:** T10 · **severity:** medium · **effort:** M · **risk:** low
- **approach:** In `StakingCard.tsx`: add `htmlFor`/`id` linking the "Amount" label (`:345`) to the input (`:355`); add `role="radiogroup"` + `aria-pressed`/`aria-checked` to the lock-duration buttons (`:368-378`) and extend-lock buttons (`:180-190`) plus a non-color selected indicator (checkmark or thicker border, not just background); focus the Cancel button when each confirm panel opens (`:236`, `:262`, `:303`); add `aria-live="polite"` to the AnimatedCounter claimable values (`:120,124,136`). Note the 5s auto-dismiss (`FarmPage.tsx:90-91`) can remove a focused dialog — pause it while the panel has focus (ties to F118).
- **files:** `src/components/farm/StakingCard.tsx:345`, `:355`, `:180-190`, `:368-378`, `:236`, `:262`, `:303`, `:120-136`
- **test:** Keyboard-only: Tab reaches the amount input via its label; arrow/space toggles lock tiers with audible state; opening a confirm moves focus to Cancel. Screen-reader: claimable updates are announced.
- **deps:** [] · **batchHint:** accessibility

### F145 — Dashboard tabs implement role attributes but not the ARIA tabs pattern
- **verdict:** fix-now · **rootCause:** T10 · **severity:** low · **effort:** M · **risk:** low
- **approach:** `DashboardPage.tsx:265-288` (tablist) and the panels (`:292`, `:356`, `:511`, `:538`) have `role="tab"`/`aria-selected`/`role="tabpanel"` but no `id`/`aria-controls` pairing, no roving `tabIndex`/arrow-key handling, and panels aren't focusable. Add `id` + `aria-controls`/`aria-labelledby` pairs, an `onKeyDown` ArrowLeft/ArrowRight roving-focus handler on the tablist with `tabIndex={-1}` on inactive tabs, and `tabIndex={0}` on the active panel.
- **files:** `src/pages/DashboardPage.tsx:265-288`, `:292`, `:356`, `:511`, `:538`
- **test:** Keyboard: arrow keys move between tabs; Tab from the tablist lands in the active panel; SR announces controls relationship.
- **deps:** [] · **batchHint:** accessibility

### F150 — Hardcoded stat colors, no-op hover classes, near-invisible "On-chain verified" label, missing aria-expanded
- **verdict:** fix-now · **rootCause:** T10 · **severity:** polish · **effort:** S · **risk:** low
- **approach:** Multiple small fixes: raise `TegridyScoreMini.tsx:85` "On-chain verified" from `text-white/15` to `/50+` (contrast); give the no-op `hover:text-white` links a real delta (e.g. `text-white/70 hover:text-white`) at `DashboardPage.tsx:194,197,302,428,493,497`; `PriceChart.tsx:322-323` give selected/unselected timeframe buttons distinct text colors; add `aria-expanded={open}` to `PriceAlertWidget.tsx:27`. The inline `#22c55e` stat colors (`DashboardPage.tsx:228/238/241/247/254`) are the established kyle-green theme used page-wide — optionally move to a CSS-var token, but treat as low-priority polish, not a behavioral bug.
- **files:** `src/components/TegridyScoreMini.tsx:85`, `src/pages/DashboardPage.tsx:194`, `:197`, `:302`, `:428`, `:493`, `:497`, `src/components/chart/PriceChart.tsx:322-323`, `src/components/PriceAlertWidget.tsx:27`
- **test:** Manual: hover deltas visible; verified label legible; timeframe selection has a text-color delta; SR announces alerts widget expanded/collapsed.
- **deps:** [] · **batchHint:** accessibility

### F177 — (live) More dropdown does not close on Escape
- **verdict:** fix-now · **rootCause:** T10 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Site-wide header (not farm/dashboard-specific). Wire Escape and focus-out to close the More menu (Gallery/Tegridy Score/Tokenomics/Treasury) for keyboard parity — the wallet modal already closes on Escape. Find the header/nav "More" dropdown component (likely `src/components/Header*` or `Navbar`) and add an `onKeyDown` Escape handler + outside-focus close.
- **files:** header/nav dropdown component (locate via `More`/`Gallery` menu markup — outside the g03 file set; flag to the nav owner)
- **test:** Keyboard: open More → Escape closes it.
- **deps:** [] · **batchHint:** accessibility

### F178 — (live) No visible keyboard focus indicators on nav links
- **verdict:** fix-now · **rootCause:** T10 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Site-wide. Add a global `:focus-visible` outline (e.g. 2px green) to nav links, buttons, and footer links — a single CSS rule in the global stylesheet (`index.css`/`app.css`). The visually-hidden "Replay splash" first focus stop already exists; subsequent stops just need a ring.
- **files:** global stylesheet (e.g. `src/index.css` / `src/styles/*.css`) — outside the g03 file set; flag to the theme owner
- **test:** Keyboard: Tab through nav → each stop shows a focus ring.
- **deps:** [] · **batchHint:** accessibility

---

## Batch: dashboard-empty-states
**Summary:** Missing empty/affordance states on the Dashboard (T11/standalone) — no all-claimed framing on Rewards, unsettled rewards invisible, restaking sanity-breach notice unimplemented, confirm-timer reset bug.

### F148 — Rewards tab: no empty state when nothing to claim; unsettledRewards invisible
- **verdict:** fix-now · **rootCause:** T11 · **severity:** low · **effort:** M · **risk:** low
- **approach:** `DashboardPage.tsx:537-573` renders only `ReferralWidget` when `pendingTotal < 0.01 && pendingETH === 0`. Add a friendly "all claimed" empty card, and surface unsettled rewards: `useUserPosition` exposes `unsettledRewards`/`unsettledFormatted` (`:89-90`) and `useFarmActions` exposes `claimUnsettled` — add an Unsettled Rewards row (amount + Claim Unsettled) when `pos.unsettledRewards > 0n`, mirroring the Farm-page treatment (`StakingCard.tsx:217-224`).
- **files:** `src/pages/DashboardPage.tsx:537-573`
- **test:** Manual: wallet with unsettled rewards sees the Unsettled row + Claim button on the Rewards tab; a fully-claimed wallet sees a friendly empty card not a blank tab.
- **deps:** [] · **batchHint:** dashboard-empty-states

### F112 — restaking.rewardSanityBreach exported but never consumed (promised "Verify on-chain" prompt)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** `useRestaking.ts:163-165` exports `rewardSanityBreach` for a UI "Verify on-chain" prompt, but the Farm restaking panel (`FarmPage.tsx:269-338`) never reads it — on breach the hook zeroes values (`:72-73`) so users see 0.0000 with no explanation. Render a small "reward data failed sanity check — verify on Etherscan" notice when `restaking.rewardSanityBreach` is true. **Caveat:** `TEGRIDY_RESTAKING_ADDRESS` is currently `address(0)` (deferred — `useRestaking.isDeployed === false`), so the whole panel is gated off (`FarmPage.tsx:269`) and this is latent until restaking deploys. Implement the notice now so it's correct when restaking goes live.
- **files:** `src/pages/FarmPage.tsx:269-338`
- **test:** Unit/manual on a fork where the RPC quotes impossible rewards (`rewardSanityBreach === true`) → the verify-on-chain notice renders instead of silent 0.0000. (Gated until restaking is deployed.)
- **deps:** [] · **batchHint:** dashboard-empty-states

### F118 — 5s confirm auto-dismiss timer resets on every parent rerender
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** S · **risk:** low
- **approach:** `FarmPage.tsx:81-82` `setConfirm` is a new identity each render; `useAutoReset.ts:13-17` lists `setter` in deps, so every FarmPage rerender (15s/30s polls, price ticks) clears and re-arms the 5000ms timeout — the withdraw confirm can outlive 5s unpredictably. Wrap `setConfirm` in `useCallback` (stable identity), or key `useAutoReset`'s effect off a timestamp captured when the confirm opened rather than the setter identity. (Coordinate with F104 — the same auto-dismiss can yank a focused dialog.)
- **files:** `src/pages/FarmPage.tsx:81-82`, `src/hooks/useAutoReset.ts:13-17`
- **test:** Manual: open the withdraw confirm → it dismisses at ~5s deterministically regardless of background polls; no premature/late dismissal.
- **deps:** [] · **batchHint:** dashboard-empty-states

---

## Batch: lock-options-dedupe
**Summary:** A financial parameter (LOCK_OPTIONS) is copy-pasted in three files (standalone) — divergence risk.

### F113 — LOCK_OPTIONS duplicated in three files
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Export the 7-entry `LOCK_OPTIONS` array once from `lib/constants.ts` (next to `MIN/MAX_LOCK_DURATION`) and import it in all three consumers, deleting the local copies (`FarmPage.tsx:40-48`, `StakingCard.tsx:19-27`, `BoostScheduleTable.tsx:8-16`). DRY a financial param so a future tier edit can't desync the form/picker/table.
- **files:** `src/lib/constants.ts` (new export), `src/pages/FarmPage.tsx:40-48`, `src/components/farm/StakingCard.tsx:19-27`, `src/components/farm/BoostScheduleTable.tsx:8-16`
- **test:** Build passes; the three surfaces render identical tiers; add a tier to the shared array → it appears in all three.
- **deps:** [] · **batchHint:** lock-options-dedupe

---

## Batch: usd-denomination
**Summary:** Best-in-class gap (T6-adjacent): no USD values across the staking/position/loans flow despite live price in context. Yearn/Beefy/Aave dual-denominate. Group the USD-subtext work into one PR; price is already on both pages.

### F114 — No USD values anywhere in the position/stake flow despite live price in context
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** `useTOWELIPrice` is already consumed on `FarmPage` (`:61`) and in `LPFarmingSection`. Add `≈$` subtexts under Staked (`StakingCard.tsx:120`), Claimable (`:136`), Effective stake (`:398`), and the Projected Earnings grid (`:413-427`) using `formatCurrency(amount * price.priceInUsd)`. Add a USD TVL figure to `FarmStatsRow` — `useFarmStats.ts:36` returns "X TOWELI"; multiply by `price.priceInUsd` for a $ TVL.
- **files:** `src/components/farm/StakingCard.tsx:120`, `:136`, `:398`, `:413-427`, `src/components/farm/FarmStatsRow.tsx:18`, `src/hooks/useFarmStats.ts:36`
- **test:** Manual: each TOWELI figure has a $ subtext; TVL shows a USD equivalent.
- **deps:** [] · **batchHint:** usd-denomination

### F120 — (best-in-class) USD denominations everywhere (staked/claimable/projected/TVL)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate of F114 (same work, restated as a best-in-class gap). Closed by usd-denomination.
- **files:** see F114
- **test:** Covered by F114.
- **deps:** [F114] · **batchHint:** usd-denomination

### F157 — (best-in-class) Loan rows lack USD values, collateral identification, repay-amount preview
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** `LoanRow` (`DashboardPage.tsx:732-753`) shows ETH/APR/token# only. Thread `price.ethUsd` (available in the parent) into `OutstandingLoans`/`LoanRow` for $ sub-labels; resolve `loan.collateralContract` (`useMyLoans.ts:213`, currently unused) to a collection label/thumbnail for NFT loans; compute total repayment from `principal + aprBps + elapsed` (shares the accrual math with F140).
- **files:** `src/pages/DashboardPage.tsx:643-705`, `:732-753`, `src/hooks/useMyLoans.ts:213`
- **test:** Manual: each loan row shows a USD sub-label, collateral identity for NFT loans, and a total-repayment figure.
- **deps:** [F130, F140] · **batchHint:** usd-denomination

### F162 — (best-in-class) USD values on the Loans tab + collateral identification
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate of F157. Closed by the same change.
- **files:** see F157
- **test:** Covered by F157.
- **deps:** [F157] · **batchHint:** usd-denomination

---

## Batch: portfolio-completeness
**Summary:** Best-in-class portfolio gaps (T3-adjacent, product): headline USD omits claimables, no allocation breakdown/history, no refresh/last-updated affordance, no claim-all. These are net-new features — most need a small product decision on scope/placement but are additive and low-risk.

### F153 — Portfolio Value excludes claimable ETH revenue, referral ETH, and unsettled TOWELI
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** `portfolioUsd` (`DashboardPage.tsx:99-106`) omits `pendingETH` (rendered in ETHRevenueClaim), `revenueStats.referralPending` (ReferralWidget), and `pos.unsettledRewards` — all user-owned claimables shown elsewhere on the same page. Add the ETH-denominated claimables (`× ethUsd`, guarded by `!oracleStale` like the other ETH legs) and unsettled TOWELI (`× priceInUsd`) to the sum, with a small "incl. $X claimable" sub-line under the headline.
- **files:** `src/pages/DashboardPage.tsx:99-106`, `:202-209`
- **test:** Manual: a wallet with pending ETH revenue sees it reflected in Portfolio Value + the "incl. $X claimable" sub-line.
- **deps:** [] · **batchHint:** portfolio-completeness

### F155 — No manual refresh affordance or last-updated indicator anywhere on the dashboard
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Add a small refresh icon-button next to Portfolio Value (`DashboardPage.tsx:202-209`) that fires `pos.refetchAll()` + `revenueStats.refetch()` (+ lp/price refetches), with a relative "updated Xs ago" stamp via `formatTimeAgo` (`lib/formatting.ts:42`, already exists). Track a `lastRefreshed` timestamp in state, updated on each successful refetch.
- **files:** `src/pages/DashboardPage.tsx:202-209`
- **test:** Manual: clicking refresh re-reads positions/revenue and the timestamp resets to "just now".
- **deps:** [] · **batchHint:** portfolio-completeness

### F161 — (best-in-class) Manual refresh + last-updated indicator
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Duplicate of F155. Closed by the same control.
- **files:** see F155
- **test:** Covered by F155.
- **deps:** [F155] · **batchHint:** portfolio-completeness

### F156 — (best-in-class) No portfolio composition breakdown or historical value
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** `portfolioUsd` blends six sources but never shows the split. Add an allocation bar (Staked/Wallet/LP/Claimable %) under Portfolio Value — all inputs already computed in this component. Historical value needs a data source (persist periodic localStorage snapshots for a session-history sparkline). The allocation bar is fix-now-able; the history sparkline needs an owner decision on whether session-only localStorage history is acceptable vs an indexer.
- **files:** `src/pages/DashboardPage.tsx:99-106`, `:202-259`
- **test:** Manual: allocation bar sums to 100% and matches the six legs.
- **deps:** [F153] · **batchHint:** portfolio-completeness

### F160 — (best-in-class) Portfolio allocation breakdown + value-over-time chart
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate of F156. Closed together.
- **files:** see F156
- **test:** Covered by F156.
- **deps:** [F156] · **batchHint:** portfolio-completeness

### F158 — (best-in-class) Claim-all aggregation across staking/ETH/referral/unsettled
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** med
- **approach:** Each claimable has a separate button across tabs. A unified "Claim all (~$X)" requires sequencing 3-4 writes (no single on-chain multicall claim exists across these contracts) — either a sequential prompt chain or an EIP-5792 batch (the repo has the 5792 foundation per memory). Needs an owner decision on UX (sequential signing vs batched) before coding. Minimum viable without a decision: a "unified claimables total (~$X)" readout, which is fix-now (depends on F153's sum).
- **files:** `src/pages/DashboardPage.tsx` (Rewards tab `:537-573`, header `:202-209`)
- **test:** Manual: unified claimables total renders; (claim-all flow pending product decision).
- **deps:** [F153] · **batchHint:** portfolio-completeness

### F167 — (best-in-class) Net APY / earnings-to-date summary
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** low
- **approach:** Cumulative claimed rewards and effective APY on the user's own position aren't derivable from current reads — they need historical claim events (indexer or `getLogs` over claim events). Needs an owner decision on data source (indexer vs bounded getLogs) before coding; not a code-only fix at HEAD.
- **files:** `src/pages/DashboardPage.tsx` (Positions/Rewards), new earnings-history hook
- **test:** N/A until data source chosen.
- **deps:** [] · **batchHint:** portfolio-completeness

---

## Batch: chart-features
**Summary:** Best-in-class chart/price gaps (standalone): 24h change, live updates, volume/high-low. Cluster the chart work; `usePriceHistory` already fetches 24 hourly closes.

### F154 — No 24h price change (only since-session-start), no volume/high-low, no live candle updates
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** `usePriceHistory` already fetches 24 hourly closes — derive 24h% from `history[0]` vs last and surface it next to the session-start delta (`DashboardPage.tsx:254`). Add a visibility-aware `setInterval` refetch of the active `PriceChart` timeframe (currently fetch-once until timeframe change). Volume pane / OHLC crosshair / 24h high-low strip are larger additions (lightweight-charts supports a volume histogram natively) — do the 24h% + refetch now, defer the volume/crosshair to a follow-up.
- **files:** `src/hooks/usePriceHistory.ts`, `src/pages/DashboardPage.tsx:254`, `src/components/chart/PriceChart.tsx`
- **test:** Manual: a 24h% chip renders and matches history endpoints; the chart refreshes on an interval.
- **deps:** [] · **batchHint:** chart-features

### F159 — (best-in-class) 24h price change chips
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Duplicate of F154 (the 24h% portion). Closed together.
- **files:** see F154
- **test:** Covered by F154.
- **deps:** [F154] · **batchHint:** chart-features

### F163 — (best-in-class) Live/streaming chart, volume pane, crosshair OHLC, 24h high/low
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate/superset of F154 (the live-updates + volume + OHLC portions). Track under chart-features; the heavier volume/crosshair work is the deferred follow-up noted in F154.
- **files:** see F154
- **test:** Covered by F154 (and follow-up).
- **deps:** [F154] · **batchHint:** chart-features

---

## Batch: best-in-class-farm-features
**Summary:** Net-new Farm features (standalone, product-decision-weighted) — zap, auto-compound, permit/batch, earnings history, tx lifecycle, watch-asset, lock reminders, deep links. These are roadmap items, not bugs; grouped so the owner can prioritize. Most need a product decision on scope; none block launch.

### F121 — (best-in-class) Zap: single-token → LP+stake in one flow
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** med
- **approach:** Beefy-standard zap. Memory's user-value research explicitly puts "custom zap" on the AVOID list and gates the LP auto-compounder on verbatim opt-in — so this needs an owner decision and a battle-tested router (not custom marshalling) before any code. Flag, don't build.
- **files:** new flow (out of g03 scope until decided)
- **test:** N/A until scoped.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F122 — (best-in-class) Auto-compound display / "claim & restake" action
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** med
- **approach:** Per memory, the LP auto-compounder is a Tier-2 verbatim opt-in feature, not yet built. A "claim & restake" two-step is lighter and uses existing `claim` + `restake` writes, but still needs a product decision on whether to surface compounding APY (risks over-promising). Flag for roadmap.
- **files:** new (out of g03 scope until decided)
- **test:** N/A until scoped.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F124 — (best-in-class) EIP-2612 permit / EIP-5792 batched approve+stake
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** med
- **approach:** Repo already has the EIP-5792 foundation (memory: commit 38ac420). Wire batched approve+stake into the Farm stake path to remove the cold 2-tx flow + 30s allowance-poll dead zone (which F102 mitigates but doesn't eliminate). Gate behind wallet capability detection with the existing 2-tx fallback. This is real code work but needs care (wallet support varies) — medium risk.
- **files:** `src/pages/FarmPage.tsx:107-116` (handleStake), `src/hooks/useFarmActions.ts`, existing 5792 helper
- **test:** Manual on a 5792-capable wallet: approve+stake in one batch; on a non-capable wallet, falls back to the 2-tx flow.
- **deps:** [F102] · **batchHint:** best-in-class-farm-features

### F125 — (best-in-class) Earnings history / profit calc / share-of-pool %
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** low
- **approach:** Same data-source problem as F167 — total claimed / cumulative yield needs claim-event history (indexer or bounded getLogs). Share-of-pool % is derivable now (`stakedAmount / totalStaked`) and is fix-now-able; the history/profit chart needs an owner decision on data source. Split: do share-of-pool now, defer history.
- **files:** `src/components/farm/StakingCard.tsx` (share %), new earnings-history hook (deferred)
- **test:** Manual: share-of-pool % renders for a staker.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F126 — (best-in-class) Tx lifecycle affordances (gas estimate, simulation preview, pending explorer link)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Surface the explorer link at submit (not only success), and add a gas estimate via `usePublicClient().estimateContractGas` / `useEstimateGas` before stake/withdraw. A full simulated-outcome preview is heavier (needs `simulateContract`) — do the explorer-link-at-pending + gas estimate now, defer simulation. Additive to the existing tx-state UI.
- **files:** `src/pages/FarmPage.tsx` (stake/withdraw handlers), `src/components/farm/StakingCard.tsx` action buttons
- **test:** Manual: pending tx shows an explorer link immediately; a gas estimate appears before signing.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F127 — (best-in-class) Add-to-wallet (wallet_watchAsset) buttons for TOWELI and LP token
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Add small "Add to wallet" buttons next to TOWELI/LP balances that call `wallet_watchAsset` via the connected provider (`useWalletClient().watchAsset` in viem). Token address/decimals/symbol/logo are in `constants.ts`/`poolConfig.ts`. Pure additive UX.
- **files:** `src/components/farm/StakingCard.tsx` (near balance `:352`), `src/components/farm/LPFarmingSection.tsx` (near Wallet LP `:179-181`)
- **test:** Manual: clicking adds TOWELI/LP to MetaMask's asset list.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F128 — (best-in-class) Lock-expiry reminders (.ics export or push alert)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** The on-page countdown exists (`StakingCard.tsx:149-168`). An `.ics` calendar export is fix-now (generate a downloadable VEVENT from `pos.lockEnd`). Push alerts are a Tier-1 roadmap item (memory) needing the notification infra decision. Do `.ics` now; defer push to the alerts roadmap.
- **files:** `src/components/farm/StakingCard.tsx:139-168` (add .ics download button)
- **test:** Manual: download an `.ics` whose event time equals the lock-expiry date.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F129 — (best-in-class) Deep links / shareable state + "share your APR" card
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Pre-filling the stake form from `/farm?lock=1y&amount=1000` is a fix-now-able URL-param read (mirror Dashboard's `?tab=` pattern at `DashboardPage.tsx:59-66`). A referral-style "share your APR" growth card is a product/marketing decision. Do the deep-link prefill now; defer the share card.
- **files:** `src/pages/FarmPage.tsx:72-74` (read search params into stake state)
- **test:** Manual: `/farm?lock=1y&amount=1000` pre-fills the form.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F165 — (best-in-class) Share/export affordances (CSV/PNG of positions/P&L, per-position deep-link)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** CSV/PNG export of positions/P&L is a net-new feature with no current consumer; per-position deep-links overlap with F129. Needs an owner decision on whether export is in scope for the dashboard. Flag for roadmap.
- **files:** new (out of g03 scope until decided)
- **test:** N/A until scoped.
- **deps:** [] · **batchHint:** best-in-class-farm-features

### F166 — (best-in-class) Notifications for claimable thresholds (ETH revenue/referral/loan-due)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** A Towelie nudge exists for staking rewards (`DashboardPage.tsx:131-139`); extending it to ETH revenue/referral/loan-due is straightforward (same `useTowelie().say` pattern keyed off the respective pending values) and is fix-now-able for in-page nudges. True push notifications need the alerts infra decision (memory Tier-1). Do in-page nudges now; defer push.
- **files:** `src/pages/DashboardPage.tsx:131-139` (add nudges for pendingETH/referralPending/loan-due)
- **test:** Manual: a wallet with pending ETH revenue gets a Towelie nudge to claim it.
- **deps:** [] · **batchHint:** best-in-class-farm-features

---

## Batch: live-rpc-transport
**Summary:** Live network finding (T8-adjacent): the primary RPC is down (HTTP 521) and every read fans out to 3 providers, wasting ~60 doomed requests per load. This is the prod rate-limiter risk territory.

### F172 — (live) Primary RPC eth.llamarpc.com is down (HTTP 521); every load fires failing preflights
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** med
- **approach:** Drop or down-rank `eth.llamarpc.com` in the wagmi/viem transport list (likely `src/lib/wagmi.ts` / `config.ts` / a `transports` array), or add health-check-based exclusion. Also review whether the 3× fan-out per read (publicnode/ankr/llamarpc) is intended `fallback()` rank vs parallel — `fallback()` should try in order, not fire all three; if it's firing all three (~176 fetches per logged-out load), reconfigure to ranked fallback to cut the rate-limiter load. Medium risk: transport changes affect every read site, so verify failover still works.
- **files:** wagmi/viem transport config (locate via `llamarpc` / `fallback(` — outside the g03 file set; flag to the infra owner)
- **test:** Network panel on a `/farm` load: no llamarpc 521 preflights; total read fetches drop substantially; data still renders via publicnode/ankr.
- **deps:** [] · **batchHint:** live-rpc-transport

---

## Batch: live-splash (app-wide, not farm/dashboard-specific)
**Summary:** Live first-visit splash issues in `components/loader/AppLoader.tsx` (T10/T12) — affects `/farm` and `/dashboard` first visits but the fix is one shared component. The splash already correctly plays once per session (`sessionStorage tf_loaded`) and supports ESC-to-skip, but has no visible skip button and a lingering exit animation.

### F168 — (live) First-visit splash is ~15-20s, no visible skip, ends in a mandatory CLICK TO ENTER gate
- **verdict:** fix-now · **rootCause:** T10 · **severity:** high · **effort:** M · **risk:** med
- **approach:** Keep the art (additive, owner mandate). In `AppLoader.tsx`: add a visible "Skip intro" button from second 1 (next to the existing Mute button `:634-657`) that triggers the existing `skip` phase (`:548`); make any click/keypress jump straight to the click-to-enter (`hold`) gate — currently `handleClick` only exits during `hold`/`textForm`/`vortex` (`:112`), so a mid-art click is ignored; allow earlier phases to fast-forward to `hold`. Consider trimming the near-black `art` middle scenes (`T_ART_COUNT=4`, `T_ART_DURATION=2600` → ~10.4s of art alone; reduce count or duration). Total pre-gate time is ~15s+ (`T_VOID_END 1500` + art 10400 + shatter/vortex/text), matching the live observation. Note: the finding said localStorage; the actual gate is `sessionStorage tf_loaded` (`:31,536`) — it replays per session, which is the intended "once per session" behavior, not a bug.
- **files:** `src/components/loader/AppLoader.tsx:109-128`, `:548-581`, `:634-657`, `src/components/loader/constants.ts:53-54`
- **test:** Live/local: a "Skip intro" button is visible from t≈1s; clicking it or pressing any key jumps to the gate; first-visit time-to-content drops well under 20s. Re-deploy (prod is stale).
- **deps:** [] · **batchHint:** live-splash

### F180 — (live) Splash exit "shatter" lingers ~10s, leaving shards over page content
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** `T_EXIT_FINALIZE=2000` (`constants.ts:62`) is the safety cap, but the ragdoll shards (`tickRagdollShards`, `AppLoader.tsx:533`) can visually persist if `allDone` doesn't resolve. Cap the shard exit at ~1.5-2s, set `pointer-events:none` on the exit DOM (`buildExitDOM`), and ensure the hard removal timeout (`:534` finalize / `exitDOMState.cleanup()`) can never strand fragments over content (force-remove the overlay on finalize regardless of shard state).
- **files:** `src/components/loader/AppLoader.tsx:529-545`, `src/components/loader/phases/exit.ts` (buildExitDOM / tickRagdollShards), `src/components/loader/constants.ts:62`
- **test:** Local: after CLICK TO ENTER, shards clear within ~2s and never overlay/intercept clicks on the farm content.
- **deps:** [] · **batchHint:** live-splash

---

## Batch: live-misc-polish
**Summary:** Smaller live UI findings on these pages (T12/T10/standalone) — CTA scrim, art pop-in, avatar overlap, light-mode scope, boost labeling, ultrawide layout, tooltips, skeleton bait-and-switch.

### F171 — (live) Dashboard connect CTA text overlaid on busy art with no scrim — subtext unreadable
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** The `!isConnected` dashboard branch (`DashboardPage.tsx:152-166`) renders the CTA directly over the jungle art with no backdrop card, while `/farm` uses `ConnectPrompt`'s dark `rgba(6,12,26,0.82)` backdrop-blur card. Add the same dark panel behind the dashboard CTA (additive — art stays visible around it). Easiest: wrap the CTA `m.div` in the `ConnectPrompt` card styling or reuse `ConnectPrompt` with a dashboard surface.
- **files:** `src/pages/DashboardPage.tsx:152-166`, reference `src/components/ui/ConnectPrompt.tsx:68-81`
- **test:** Live: subtext is legible over light areas of the art.
- **deps:** [] · **batchHint:** live-misc-polish

### F173 — (live) Skeleton bait-and-switch: loading shows 8 stat cards + chart, then collapses to bare connect prompt
- **verdict:** fix-now · **rootCause:** T11 · **severity:** medium · **effort:** S · **risk:** low
- **approach:** While connection status resolves (wallet auto-reconnect), the dashboard briefly renders the connected-state skeleton grid, then swaps to the tiny connect gate. Show a neutral spinner or the connect-gate (dimmed) during the resolving window instead of the connected skeleton — gate the skeleton render on a "connection resolved" signal (wagmi `useAccount().isReconnecting` / `status`), not just `isConnected`. Largely mitigated by the F138/F170 logged-out preview (which gives the logged-out user real content), but the resolving-flash should still be addressed.
- **files:** `src/pages/DashboardPage.tsx:146-169` (resolving branch)
- **test:** Live: cold reload while connected → no flash of a skeleton that then disappears.
- **deps:** [F138] · **batchHint:** live-misc-polish

### F174 — (live) "Light mode" toggle only recolors the navbar orange; body/cards/footer stay dark
- **verdict:** product-decision · **rootCause:** standalone · **severity:** medium · **effort:** M · **risk:** med
- **approach:** Site-wide header control. Either theme the content surfaces too (a real light theme — large, risky) or relabel/restyle the control as an accent toggle so it doesn't read as a broken light mode. Owner decision on intent (is it meant to be a full theme switch?). Also check green-on-orange nav contrast (active link + Connect button) against WCAG AA. Out of g03 file scope; flag to the theme owner.
- **files:** header/theme toggle component + theme tokens (outside g03 file set)
- **test:** Per decision: either content surfaces theme correctly, or the control is clearly an accent toggle with AA-passing contrast.
- **deps:** [] · **batchHint:** live-misc-polish

### F176 — (live) Towelie avatar overlaps the Protocol Active price chip, hiding the price
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Site-wide floating chip + avatar (likely a global layout/footer widget). Stack the "Protocol Active $…" chip above/left of the Towelie avatar (or shift the avatar down-right) so the price is never occluded, and label the price ("TOWELI $0.000041") so a bare $ next to "Protocol Active" isn't ambiguous. Locate the chip/avatar in the global layout (Towelie widget / footer status chip — outside g03 file set; flag to layout owner).
- **files:** global Towelie/status-chip component (outside g03 file set)
- **test:** Live: price fully visible at all viewport widths; price has a TOWELI label.
- **deps:** [] · **batchHint:** live-misc-polish

### F179 — (live) Jungle artwork pops in abruptly ~2-3s after connect text; button appears separately
- **verdict:** fix-now · **rootCause:** T12 · **severity:** low · **effort:** S · **risk:** low
- **approach:** The disconnected dashboard hero shows three visual states on cold load (text-only → text+button → art appears). Fade the art in on load (opacity transition keyed on the image's `onLoad`) and render the Connect button together with the heading so the CTA block appears as one unit. `ArtImg` already reserves dimensions — add a blur-up/opacity transition. (Mostly resolved once F138/F170 add content, but the art fade-in is still worth doing.)
- **files:** `src/pages/DashboardPage.tsx:146-169`, `src/components/ArtImg.tsx` (opacity-on-load)
- **test:** Live: art fades in smoothly; heading + button appear together, not in separate flashes.
- **deps:** [] · **batchHint:** live-misc-polish

### F181 — (live) LP Farming "EST. APR — calculating…" badge never resolves
- **verdict:** fix-now · **rootCause:** T11 · **severity:** low · **effort:** S · **risk:** low
- **approach:** `LPFarmingSection.tsx:133` shows "calculating…" when `lpApr === null` but `totalStaked !== 0n`. The memo (`:39-47`) returns null when pool data / price isn't loaded or `lpSupply`/`staked` are 0 — if it never resolves (pool too new, price unavailable, or the dead llamarpc transport from F172 blocking the read), the spinner-state latches forever. Change the persistent "calculating…" to a terminal "N/A — pool bootstrapping" after a timeout or when the inputs are known-unavailable (e.g. `price.priceInUsd <= 0` or `poolTVL.isLoaded && poolTVL.tvl === 0`). Verify the read isn't blocked by F172.
- **files:** `src/components/farm/LPFarmingSection.tsx:130-135`, `:39-47`
- **test:** Live: an un-calculable APR shows "N/A — pool bootstrapping", not a permanent "calculating…".
- **deps:** [F172] · **batchHint:** live-misc-polish

### F182 — (live) Sub-1x "Boost" values read as a penalty (Boost 0.61x, schedule starts at 0.40x)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** "Boost 0.61x" implies earning 39% LESS than baseline even though it's a 0.4-4.0 multiplier scale. Relabel as "Lock multiplier" (in `StakingCard.tsx:123` Boost card, `BoostScheduleTable` header, and the `calculateBoost` display surfaces) OR normalize the display so the shortest lock = 1.0x while keeping the marketing "MAX BOOST 4.0x" consistent. Normalization changes the numbers users see across the page — needs an owner decision (relabel vs renormalize) to stay consistent with the "4.0x max boost" marketing and the on-chain bps. Relabel is the low-risk additive option.
- **files:** `src/components/farm/StakingCard.tsx:123`, `src/components/farm/BoostScheduleTable.tsx:32-33`, `src/lib/boostCalculations.ts`
- **test:** Per decision: the label no longer reads as a penalty; "MAX BOOST 4.0x" marketing stays consistent with the schedule.
- **deps:** [] · **batchHint:** live-misc-polish

### F184 — (live) Ultrawide farm layout: content band uses ~30% of a 3432px viewport; dead side-zones
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** M · **risk:** low
- **approach:** On wide breakpoints, widen the stat ribbon (`IncentivesStrip` — add TVL/price to reach 6-7 chips) and use the empty mid-band between the connect card and footer for the boost-schedule table or pool preview. Additive, art untouched. Lands naturally with the F115/F169 logged-out preview (which fills the mid-band with read-only content).
- **files:** `src/pages/FarmPage.tsx:171-186` (disconnected layout), `src/components/farm/IncentivesStrip.tsx:38-40` (grid cols)
- **test:** Live at 3432px: stat ribbon + read-only content fill the canvas; no large dead bands.
- **deps:** [F115] · **batchHint:** live-misc-polish

### F185 — (live) Farm stat chips have no tooltips or click-through
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** S · **risk:** low
- **approach:** Add hover tooltips with formula/source to the `IncentivesStrip` chips (Reward Pool / Daily Emissions / Fee Share — APR already has the inline bootstrap caveat) and link relevant chips to detail pages (Fee Share → `/tokenomics`). Use `title=`/an existing tooltip primitive; wrap clickable chips in `Link`.
- **files:** `src/components/farm/IncentivesStrip.tsx:26-66`
- **test:** Manual: hovering Reward Pool/Daily Emissions/Fee Share shows a source/formula tooltip; Fee Share links to tokenomics.
- **deps:** [] · **batchHint:** live-misc-polish

### F183 — (live, /swap incidental) Disconnected swap card is a large empty box with a left-stuck Connect button
- **verdict:** false-positive · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Explicitly out of scope — the finding itself notes "/swap was not in my assignment." Not a Farm/Dashboard issue; the swap surface belongs to a different group (g02/swap). Marked false-positive **for this surface** (it's a real /swap finding, just not g03). Route to the swap-surface plan.
- **files:** `src/pages/SwapPage.tsx` (or equivalent — not in g03 scope)
- **test:** N/A for g03; verify under the swap-surface plan.
- **deps:** [] · **batchHint:** live-misc-polish
