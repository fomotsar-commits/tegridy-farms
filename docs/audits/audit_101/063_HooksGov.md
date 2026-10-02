# Agent 063 — Hooks/Governance Forensic Audit

**Scope:** `frontend/src/hooks/{useBribes,useGaugeList,usePremiumAccess,useRestaking,usePoints,useTegridyScore,usePriceHistory,usePriceAlerts,useToweliPrice,useTowelie,useRevenueStats}.ts` + paired tests.

**Mode:** AUDIT-ONLY. No code modified.

---

## Summary Counts

| Severity | Count |
|----------|-------|
| HIGH     | 4     |
| MEDIUM   | 9     |
| LOW      | 7     |
| INFO     | 6     |
| **Total**| **26**|

---

## HIGH

### H1. `useGaugeList` is fully stale across an epoch boundary — no listener for `GaugeAdded`/`GaugeKilled`/epoch advance
**File:** `useGaugeList.ts:32-37`
The hook fetches `getGauges` via `useReadContract` with `refetchInterval: 60_000`. There is **no** event subscription, no chain-id key, and no manual refetch exposed. When governance whitelists a new gauge (or kills one) mid-page-view, the user sees stale gauge weights/labels for up to 60 s, and during the window between epoch flip on-chain and frontend refetch, **`getGaugeWeight`/`getRelativeWeight`/`getGaugeEmission` return last-epoch values while the bribes hook may already report `currentEpoch` advanced**. Voting in this state targets a gauge whose weight readings are from the prior epoch — UX/eligibility ambiguity. No `useBlockNumber({ watch: true })` invalidation either.

### H2. Bribe deposit not refetched after an external claim — `useBribes` only auto-refetches on the **caller's** transaction
**File:** `useBribes.ts:256-270`
The `useEffect` watching `isSuccess`/`isTxError` calls `refetch()`/`refetchWhitelist()`/`refetchToweli()` only when the **current hook instance** sent the tx. If a user holds the page open and claims via another tab/wallet, claimable amounts and `pendingTokenWithdrawals` stay stale until the 60 s `refetchInterval` fires. More serious: a successful **deposit** by another user shifts the current-epoch totals (and the user's vote power calculation) without any re-read. No event-log subscription on `BribeDeposited`/`BribeClaimed`/`Voted`. Combined with H1, voters can dispatch `vote()` against pre-claim state.

### H3. `useRestaking` trusts a single RPC for share-price / pending-rewards — no oracle, no sanity bounds
**File:** `useRestaking.ts:17-32, 45-50`
`pendingTotal(user)` and `restakers(user)` are read once via `useReadContracts` with `refetchInterval: 30_000`. Returned tuples are accepted **verbatim** — no plausibility check (`pendingBonus <= totalBonusFunded - totalBonusDistributed`), no ceiling on `restakedBoosted` vs `restakedAmount`, no second-source confirmation. `formatEther(pendingBonus)` is then surfaced as `pendingBonusFormatted`. A buggy/compromised RPC (or a misconfigured proxy) can serve **arbitrary** pending values; the user clicks `claimAll()` against a phantom amount, the on-chain call reverts, and gas is wasted. There is no oracle/TWAP cross-check (compare to `useToweliPrice` style: `useToweliPrice` does have TWAP+Chainlink+spot triangulation; **`useRestaking` has none of that hardening**).

### H4. `useToweliPrice` write-through cache poisons baseline across origins
**File:** `useToweliPrice.ts:69-81, 218-226`
The hook reads `localStorage.getItem('tegridy_api_price')` on mount with **no origin/version key**. `safeSetItem('tegridy_price_baseline', ...)` writes baseline price unconditionally on first non-zero read. If the same browser previously visited a malicious clone (any subdomain or any localhost dev replica) that wrote `tegridy_api_price`, the cached price is loaded as `apiFallbackPrice`, displayed pre-fetch, and pinned as `prevPriceRef.current` — feeding `sessionPriceChange` math from attacker-controlled data until the GeckoTerminal fetch resolves. Same critique applies to `usePriceHistory` (`CACHE_KEY = 'tegridy_price_history'`) which `JSON.parse`s without HMAC/signature.

---

## MEDIUM

### M1. `usePoints` lets the client accumulate locally with **no server-side dedup** — leaderboard / eligibility risk
**File:** `usePoints.ts:120-124`, `lib/pointsEngine.ts:223-225` (recordAction is now a no-op stub but `streak`/`actions` arrays still mutate via reconcile path)
`recordAction(address, type, goldCardBoost)` writes to `localStorage` via `pointsEngine`. Although the comment claims "Points derived ONLY from on-chain metrics — no localStorage bonus" (line 102), **`reconcilePoints` adds `streakBonus` from `data.actions.filter(a => a.type === 'daily_visit')`** (`pointsEngine.ts:194-196`) and then the hook overwrites with `onChainPts` on line 102. Two bugs at once: (a) the localStorage-streak bonus IS computed and then thrown away — wasted CPU + leaks intent, and (b) badges via `getEarnedBadges(data, onChainMetrics)` (line 134-137) consume `data` which still carries client-faked `actions`/`streak`. Badge eligibility is **client-faked**.

### M2. `useTegridyScore` flash-of-zero — score renders before `firstInteractionTs` resolves
**File:** `useTegridyScore.ts:340-365`
`useMemo` returns immediately after mount with `firstInteractionTs = 0` (or the cached value), driving `loyaltyScore = 0` (line 113-114: `if (firstInteractionTs === 0) return 0`). Until the `eth_getLogs` round-trip on lines 315-336 completes (often >1 s on public RPCs), the user sees `Tier: Seedling` even when on-chain history would put them at `Tier: Master`. There is no `isLoading` flag exposed to consumers — the `TegridyScoreResult` interface has no loading state. UI should suppress render or show a skeleton; instead it shows wrong tier briefly.

### M3. `useTegridyScore` inner async batches lack abort propagation between batches
**File:** `useTegridyScore.ts:200-239`
The proposal-vote scanner loops `for (let i = 0; i < count; i += batchSize)` and `await Promise.all(...)` per batch. `cancelled` is checked once per batch (line 228). If `address`/`grantsDeployed`/`proposalCount` change mid-loop, all currently-in-flight promises still complete (no `AbortController` on the `readContract` calls). On a fast wallet-switch, accumulated `voted`/`proposed` counts get applied to the **wrong** address state (cancelled flag prevents the final `setVotedCount`, but RPC calls still fire and consume rate-limit budget — and the early returns are inconsistent: line 228 vs 234).

### M4. `useRevenueStats` & `usePremiumAccess` & `useBribes` all read `totalRevenue`/`totalDistributed` independently — risk of double-count if aggregated UI sums them
**Files:** `useRevenueStats.ts:23, 25`; `usePremiumAccess.ts:45`
`useRevenueStats` returns `totalDistributed` (Revenue Distributor) and `totalReferralsPaid` (Referral Splitter). `usePremiumAccess` returns `totalRevenue` (Premium Access). These are **distinct contracts**, but the formatted Number conversions (`formatWei(..., 18, 6)`) drop precision and there is no cross-hook reconciliation. A `DashboardPage` summing `totalDistributed + totalRevenue + totalReferralsPaid` to display "protocol revenue" would double-count any flow that hits both Premium and the Revenue Distributor (e.g., if Premium remits a cut into Distributor — verify in contracts). No documentation in the hook states the boundary.

### M5. `useToweliPrice` GeckoTerminal `fetch` fires unconditionally on mount — pre-consent third-party request
**File:** `useToweliPrice.ts:85-110`
The `useEffect` calls `fetch('https://api.geckoterminal.com/...')` on every mount, **regardless of analytics/cookie consent state**. GeckoTerminal logs the request URL with the user's IP. Every page that consumes `useToweliPrice` (Home, Trade, Dashboard, Farm, Premium…) leaks visit telemetry to a third-party before the user has opted in. EU GDPR-relevant. Compare: `lib/analytics.ts` has a flush gate (line 41: noop if `!ENDPOINT`) but no consent gate either.

### M6. `usePriceAlerts` `localStorage` is trusted across origins — quota DoS + spoofed triggers
**File:** `usePriceAlerts.ts:31-46, 60`
`loadAlerts()` parses `localStorage` without per-wallet/per-chain keying. A previous origin (or a different wallet on the same browser) populates the same `'tegridy-price-alerts'` key, and `usePriceAlerts(currentPrice)` reads it on mount. Worse: an attacker site at any origin (in the rare case of subdomain takeover) can write 20 alerts that fire `Notification` API on next legitimate visit. `MAX_ALERTS = 20` cap is enforced only on `addAlert`, not on what `loadAlerts` returns — `localStorage.setItem` raw bypasses the cap entirely.

### M7. `usePriceAlerts` `Notification.requestPermission()` triggered from price-update effect
**File:** `usePriceAlerts.ts:53`
When a price threshold crosses for the first time, `sendNotification` calls `Notification.requestPermission()` **without a user gesture**. Modern browsers (Chrome 80+, Safari 16+) silently reject this; the request is consumed without surfacing a prompt and the alert is permanently dead. Permission must be requested in response to a click (e.g., on `addAlert`).

### M8. `useBribes` claimable read uses **legacy single-pair** path; UI batches per-pair separately — divergence risk
**File:** `useBribes.ts:123-143`
Comment (line 124-125) admits: "Legacy single-pair claimable read — kept for back-compat with the test suite". `claimableData` is hard-coded to `TOWELI_WETH_LP_ADDRESS`. If the user holds claimable bribes on **other** pairs that the multi-pair UI shows as available, the legacy `claimableTokens` array will misrepresent total claimable. Consumers using `claimableTokens` (test suite, any external caller) get only the TOWELI/WETH slice — silent under-reporting.

### M9. `useTegridyScore` — `firstInteractionTs` cached without invalidation on chain-id switch
**File:** `useTegridyScore.ts:290-298, 329`
`localStorage.setItem(\`tegridy-score:first-interaction:${address.toLowerCase()}\`, ...)` keys only on address. Same address on Sepolia vs Mainnet vs L2 collides — Sepolia's earlier test stake gets cached and then read on Mainnet, inflating `loyaltyScore` to 100 on a brand-new mainnet user.

---

## LOW

### L1. `useBribes` `setInterval(update, 1000)` never debounces across hook re-mounts
**File:** `useBribes.ts:118-121`
Each render's `latestEpoch?.timestamp` change spins a new interval. While cleared on unmount, multiple consumers of `useBribes` (any page that uses cooldown) each create a 1 Hz timer.

### L2. `usePremiumAccess` — duplicate toast on combined approve+action sequence
**File:** `usePremiumAccess.ts:115-147`
Four separate `useEffect` hooks call `toast.success` / `toast.error`. If the user runs approve→subscribe back-to-back fast enough, three toasts fire. No throttle.

### L3. `useGaugeList` ignores `getGaugeWeight` failure modes silently — falls back to `0n`
**File:** `useGaugeList.ts:106-108`
A reverting `getGaugeWeight` call resolves to weight `0n`; the UI displays "0 emission" with no error indicator. Indistinguishable from "killed gauge".

### L4. `useRestaking` — no `address`-key on `useReadContracts` query — wallet switch races
**File:** `useRestaking.ts:17-32`
The `query.queryKey` is computed by wagmi from contracts/args, but the args reference `userAddr` which IS the address — OK in theory. However, the **transient** state during account switch (when `address` is briefly `undefined`, `userAddr` becomes the zero-address) reads a real on-chain `restakers(0x0)` row. If the contract has any sentinel value at the zero address, it leaks into UI for one frame.

### L5. `useToweliPrice` — `prevPriceRef` baseline persisted to localStorage but never read back
**File:** `useToweliPrice.ts:223-225`
`safeSetItem('tegridy_price_baseline', ...)` writes the session baseline, but no `useEffect` reads it to restore session continuity. Dead write; storage quota churn.

### L6. `useRevenueStats` `pendingETH` indexed at `data?.[5]` falls back to `referralPendingFromInfo` — mixed source
**File:** `useRevenueStats.ts:51-53`
If `pendingETH` read fails, falls back to tuple's third element; comment doesn't explain what `referralInfo[2]` represents on the contract side. Verify alignment with `REFERRAL_SPLITTER_ABI`.

### L7. `useTowelie` provider warning is `console.warn` on every consumer call without a provider
**File:** `useTowelie.ts:84-88`
Spammy in tests if any consumer is rendered outside the provider; better to warn once via a module-level flag.

---

## INFO

- **I1.** `useBribes`/`usePremiumAccess`/`useRevenueStats` all use 30–60 s `refetchInterval` — cumulative load. Consider `useBlockNumber({ watch: true })` invalidation pattern instead of polling.
- **I2.** `usePriceHistory.ts` does not key cache by network ID — Sepolia vs Mainnet candles collide on `tegridy_price_history`.
- **I3.** `useTegridyScore` returns `selfReported: []` always (line 366) — dead field.
- **I4.** `usePoints` line 153 disclaimer is correct and prominent; good. Keep.
- **I5.** `useToweliPrice` exposes both `apiPriceDiscrepant` and `priceDiscrepancy` — same boolean (line 234, 246). Pick one.
- **I6.** No tests exist for `useGaugeList`, `usePremiumAccess`, `usePoints`, `useTegridyScore`, `usePriceHistory`, `useTowelie`, `useRevenueStats`. Test coverage gap.

---

## Cross-Check vs Tests

- **`useBribes.test.ts`**: covers reads + writes + cooldown. No test for "external claim invalidates cache". No test for the legacy single-pair vs multi-pair divergence (M8). No test for chain-id switch.
- **`useRestaking.test.ts`**: thorough on derivation + write gates. Zero tests for RPC misbehavior / poisoned reads (H3). No second-source assertion.
- **`usePriceAlerts.test.ts`**: covers add/remove/dedup/cap. No test for `Notification.requestPermission()` failure (M7) and no test for cross-origin localStorage corruption (M6).
- **`useToweliPrice.test.ts`**: best coverage in the surface; tests TWAP override and Chainlink staleness. **No test for cache poisoning across origins (H4)** — `localStorage.clear()` only wipes the test's own writes, doesn't simulate prior-origin payload.

---

**END FINDINGS — Agent 063**
