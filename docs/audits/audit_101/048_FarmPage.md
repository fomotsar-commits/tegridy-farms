# Agent 048 — FarmPage / Farm Hooks Forensic Audit

**Scope:**
- `frontend/src/pages/FarmPage.tsx`
- `frontend/src/components/farm/*` (FarmStatsRow, StakingCard, LPFarmingSection, BoostScheduleTable, LivePoolCard, UpcomingPoolCard, PoolStatusBadge, ILCalculator, poolConfig)
- Hooks: `useFarmActions.ts`, `useFarmStats.ts`, `useLPFarming.ts`, `useNFTBoost.ts`
- Adjacent context: `usePoolData.ts`, `usePoolTVL.ts`, `useUserPosition.ts`

**Counts:** HIGH 4 · MEDIUM 7 · LOW 6 · INFO 4 — total 21

---

## HIGH

### H1 — Account-switch race during pending tx (multiple hooks)
**Files:** `useFarmActions.ts:30-94`, `useLPFarming.ts:104-122`, `useUserPosition.ts:9-25`, `FarmPage.tsx:106-116`
**Pattern:** `useFarmActions`, `useLPFarming`, and `useUserPosition` re-key off `address` from `useAccount()`. If a user starts a stake/withdraw and then switches account (or the wallet auto-switches accounts), the `pendingStakeRef` (`useFarmActions.ts:31, 86`), `submittedDataRef` (`FarmPage.tsx:69, 112`), `lastActionRef` (`FarmPage.tsx:66`), and `receiptShownHashRef` (`FarmPage.tsx:67`) keep referring to the *previous* account's stake amount/lock duration. Receipt and analytics in `FarmPage.tsx:118-166` will report the wrong user's amount; `trackStake` in `useFarmActions.ts:48` will fire with stale data. There is no `useEffect` that resets these refs on `address` change. The `pos.tokenId` and `pos.stakedFormatted` read in `showReceipt` (`FarmPage.tsx:141, 150`) reflect the *new* account, while `submittedDataRef` reflects the *old* account — a divergent receipt is shown.
**Severity:** HIGH (data integrity, analytics pollution, possible UX confusion mid-flow)
**Fix:** add `useEffect` that resets all refs and inputs when `address` changes; ideally also blocks rendering of an in-flight receipt across account boundaries.

### H2 — Tx receipt not re-checked against original sender
**Files:** `useFarmActions.ts:33-52`, `useLPFarming.ts:18-69`
**Pattern:** `useWaitForTransactionReceipt({ hash })` does not bind to a user address. If the user disconnects mid-tx and reconnects with a different account, `isSuccess` still fires for the *old* hash and triggers `toast.success`, `trackStake`, `confetti.fire()` (`FarmPage.tsx:162`), and `lpFarm.refetch()` for the new account. The `refetch` in `useLPFarming.ts:66` then reads the new account's position and may show stale-but-confirmed UI (e.g. the new account thinks it just staked).
**Severity:** HIGH
**Fix:** capture `address` at submission time alongside the hash and bail out of effects if `address` no longer matches.

### H3 — `useNFTBoost` passes `address!` while query disabled (silent zero)
**File:** `useNFTBoost.ts:23-27`
**Pattern:** `args: [address!]` evaluates the non-null assertion before wagmi's `enabled` check. When `address` is `undefined`, `address!` becomes the string `"undefined"` in arg encoding (or wagmi may throw internally), and the `data` returns either undefined or contract failure. Worse: when the user *just connected*, the query may briefly call `balanceOf(undefined)` which silently fails — `holdsJBAC` defaults to `false` (`useNFTBoost.ts:32`), so the boost preview in `FarmPage.tsx:93` flashes the wrong number for one render. A user who triggers a stake during this window stakes with **+0 NFT bonus** even though they hold the NFT.
**Severity:** HIGH (financial UX — under-boosts a stake)
**Fix:** gate args with a sentinel (`address ? [address] : undefined`) like `useFarmActions.ts:23` does correctly.

### H4 — Stake amount fed to `parseEther` without normalization
**Files:** `FarmPage.tsx:104`, `useFarmActions.ts:74-92`, `StakingCard.tsx:315`
**Pattern:** `stakeNeedsApproval = pos.allowance < parseEther(stakeAmount)` will throw `InvalidDecimalNumberError` if the user pastes a value with more than 18 fractional digits or scientific notation (e.g. `1e3`). The input only sanitises to `[^0-9.]` and de-dupes dots (`StakingCard.tsx:315`), but does not trim trailing `.` or limit to 18 decimals. `parseEther('1.')` throws; `parseEther('1.0000000000000000001')` throws. The throw bubbles into render → entire FarmPage `ErrorBoundary` catches and replaces UI. Also: `useFarmActions.stake()` calls `parseEther(amount)` again without try/catch (`useFarmActions.ts:92`), and `useLPFarming.stake()` likewise (`useLPFarming.ts:111`).
**Severity:** HIGH (crash-class)
**Fix:** wrap parseEther in `safeParseEther` or `try/catch` and clamp to 18 decimals at input layer.

---

## MEDIUM

### M1 — TVL claim without source-of-truth confirmation
**Files:** `useFarmStats.ts:14-32`, `usePoolTVL.ts:33-122`
**Pattern:** `useFarmStats.tvl` is rendered as `"X TOWELI"` (no USD), but the dashboard label is "Total Value Locked" — implies USD, gives token. `usePoolTVL.tvl` *does* compute USD but uses `price.ethUsd` from a context with no staleness gate (no `displayPriceStale` check before multiplication on line 47). If ETH price feed stalls, TVL silently drifts. There is **no on-chain TVL oracle anchor or sanity check** (e.g. compare to LP token supply × spot LP price). A user reads the TVL number as authoritative.
**Severity:** MEDIUM (visual data integrity)

### M2 — APR cache staleness window 60 s, no "stale" indicator
**Files:** `useFarmStats.ts:19`, `usePoolData.ts:19`, `useLPFarming.ts:35`
**Pattern:** `refetchInterval: 60_000` for staking; `30_000` for LP. The APR shown in `FarmStatsRow` and `BoostScheduleTable.tsx:23-24` is recomputed only when `usePoolData` refetches. If `rewardRate` or `totalBoostedStake` change on-chain (e.g. funder calls `notifyRewardAmount`), users see a stale APR for up to 60 s with no indicator. `aprDisclaimer` ("Current rate, subject to change") is generic, not staleness-aware. Yield projections in `StakingCard.tsx:373-388` ("30 Days / 90 Days / 1 Year") project off this stale APR — projected earnings can be off by an order of magnitude immediately after a reward funding event.
**Severity:** MEDIUM

### M3 — Boost UI silently relies on per-render `Date.now()` for lock countdown
**File:** `StakingCard.tsx:113-132`
**Pattern:** Lock-expiry countdown computes `Math.floor(Date.now() / 1000)` inside the IIFE on every render. There is no `setInterval` to refresh every minute; the countdown only updates when the parent re-renders (which happens on hover, refetch, or input change). A user staring at the page sees "5d 14h left" for minutes, until *something* triggers a re-render. Also no boost-expired UI: when `lockEnd` passes, the Date display flips to "Unlocked" but the on-chain boost **does not auto-decay** until `revalidateBoost` is called. The card renders the (now incorrect) on-chain boost (`pos.boostMultiplier`) until revalidation happens. This is what `Revalidate Boost` button is for (`StakingCard.tsx:91`), but the UI does not warn/highlight that the displayed boost is stale-vs-real.
**Severity:** MEDIUM (boost UI lets user act on stale boost)

### M4 — Optimistic clear of LP inputs on `isSuccess` without verifying which tx
**File:** `LPFarmingSection.tsx:22-27`
**Pattern:** `useEffect(() => { if (lpFarm.isSuccess) { setLpStakeAmount(''); setLpWithdrawAmount(''); } }, [lpFarm.isSuccess])`. `isSuccess` is shared across approve/stake/withdraw/claim/exit/emergencyWithdraw — any of those clearing the *withdraw* input prematurely. After an `approve` confirms, both stake + withdraw inputs are wiped, even though the user is mid-flow. Also conflates "the previous tx succeeded" with "the input was for that tx".
**Severity:** MEDIUM

### M5 — `pendingEthGuard` not enforced for `claimUnsettled` / `extendLock`
**File:** `useFarmActions.ts:177-194`
**Pattern:** `claimUnsettled` and `extendLock` skip the `pendingEthGuard`. `extendLock` is a non-burning operation so this is safe. But there's no guard on `revalidateBoost`. More subtly: the guard relies on `pendingEthRaw` from a 15 s refetch (`useFarmActions.ts:24`). A user who claims their ETH revenue ~5 s before withdrawing will hit the guard with stale `pendingEth > 0`, get blocked, and have to wait. No "refetch on click" or "live read".
**Severity:** MEDIUM

### M6 — Chain-mismatch guard missing on read paths
**Files:** `useFarmStats.ts`, `usePoolData.ts`, `useLPFarming.ts`, `useNFTBoost.ts`, `useUserPosition.ts`
**Pattern:** Write paths call `if (chainId !== CHAIN_ID) toast.error(...)`, but read hooks fire `useReadContracts` regardless of `chainId`. If a user is on the wrong chain, every read returns failure and `useFarmStats.tvl` shows `"–"` while `pool.apr` shows `0`, but no contextual "wrong chain — values N/A" message is attached to the cards (only the top-level `<WrongChainBanner/>` says it). The "Stake & Lock for X" button in `StakingCard.tsx:391` is *not* disabled on wrong chain — only the hook-level toast fires after click. User on wrong chain can construct a stake → click stake → toast → confused.
**Severity:** MEDIUM

### M7 — Pause-state display incomplete
**Files:** `useUserPosition.ts:31`, `StakingCard.tsx:258-285`
**Pattern:** `isPaused` is read but only surfaces the **Emergency Exit** button. There is no banner saying "Staking contract is paused — new stakes/claims temporarily disabled". A connected user with no existing position will see the normal stake form and their click will revert. The `useFarmActions.stake/claim/extendLock/etc` calls do not pre-check `isPaused`. Also: LP farming has no `paused()` check at all (`useLPFarming.ts` doesn't read pause state).
**Severity:** MEDIUM

---

## LOW

### L1 — Decimal-format drift assumption on TOWELI
**Files:** `useFarmActions.ts:73, 92`, `useLPFarming.ts:100, 111, 129`, `useFarmStats.ts:25`
**Pattern:** Comment in `useFarmActions.ts:72` says "TOWELI uses 18 decimals; if token decimals change, use parseUnits". This is fine for now, but **no programmatic check** ties this to the contract's actual `decimals()` call. If TOWELI is ever upgraded/replaced, all amount math drifts silently.

### L2 — `formatTokenAmount(effectiveStake.toString(), 0)` truncates badly
**File:** `StakingCard.tsx:354`
**Pattern:** `effectiveStake = amtNum * totalBoostBps / 10000` → JS float. Calling `formatTokenAmount(effectiveStake.toString(), 0)` flattens to 0 decimals; for small amounts (< 1 TOWELI) this displays "0".

### L3 — `jbacCount`/`goldCardCount` clamp to MAX_SAFE_INTEGER quietly
**File:** `useNFTBoost.ts:43-44`
**Pattern:** Silent clamp without warning. ERC721 balances above 2^53 are pathological but if surfaced via UI the count would lie.

### L4 — Accessibility: card backgrounds + low-contrast greens
**Files:** `FarmStatsRow.tsx:33-43`, `LivePoolCard.tsx:35-44`, `UpcomingPoolCard.tsx:35-37`, `BoostScheduleTable.tsx:51-53`
**Pattern:** Stat values rendered in `#22c55e` (kyle-green) over a busy `<ArtImg/>` background. Even with `text-shadow: 0 1px 6px rgba(0,0,0,0.95)` the contrast is < 4.5:1 in some art frames. No `aria-label` on stat tiles describing label+value pair (screen reader reads "TVL" and value as separate, in some render trees).

### L5 — Yield projections don't account for emission decay or supply-cap
**File:** `StakingCard.tsx:373-388`
**Pattern:** Linear extrapolation `amtNum * (boostedApr/100) * (days/365)` assumes flat APR for 365 days. Real APR drops as totalBoostedStake grows. Disclaimer below ("Rates change with total staked") is in `text-white/30 text-[9px]` — visually de-emphasized.

### L6 — `refetchOnWindowFocus: true` causes flicker without optimism
**Files:** `useFarmStats.ts:19`, `useUserPosition.ts:25, 41`, `usePoolData.ts:19`, `useLPFarming.ts:35`, `usePoolTVL.ts:30`
**Pattern:** Every read refetches on focus → values briefly flash `–`/0 while reload is in flight (no `keepPreviousData`).

---

## INFO

### I1 — `useEffect` deps eslint-disabled in `FarmPage.tsx:165-166`
The disable is justified (refs capture values), but creates fragility — future refactor that removes refs could miss the closure issue.

### I2 — `boostDisplay` math mixes integer-bps and float TOWELI
`FarmPage.tsx:92-98` — small precision loss for very long locks at very small stake amounts. Cosmetic.

### I3 — `LPFarmingSection.tsx:188` swallows parseEther error silently
`try { ... } catch { /* invalid input */ }` — fine, but means user is told "stake" is enabled when in fact `parseEther` will throw on click.

### I4 — `usePoolData.aprCapped = '>9999'` magic-string never tested
Cosmetic edge case if APR exceeds 999999%.

---

## Top-3 Summary

1. **H1/H2 — account-switch & cross-account receipt race** (data integrity + analytics)
2. **H3 — `useNFTBoost` calls balanceOf with `address!`** while query technically disabled, causing transient zero-boost render that under-boosts stakes
3. **H4 — `parseEther(stakeAmount)` crashes on edge inputs** (trailing dot, >18 decimals, scientific) → ErrorBoundary swallows entire page

---

*Audit-only, no edits applied.*
