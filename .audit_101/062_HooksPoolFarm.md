# Agent 062 — Frontend Hooks (Pool / Farm / NFT) Forensic Audit

Scope (9 files):
- `frontend/src/hooks/usePoolData.ts`
- `frontend/src/hooks/useFarmStats.ts`
- `frontend/src/hooks/useUserPosition.ts`
- `frontend/src/hooks/usePoolTVL.ts`
- `frontend/src/hooks/useLPFarming.ts`
- `frontend/src/hooks/useNFTBoost.ts`
- `frontend/src/hooks/useNFTDrop.ts`
- `frontend/src/hooks/useNFTDropV2.ts`
- `frontend/src/hooks/useFarmActions.ts`

Test siblings reviewed: `usePoolData.test.ts`, `useFarmStats.test.ts`, `useUserPosition.test.ts`, `useLPFarming.test.ts`, `useNFTBoost.test.ts`, `useNFTDrop.test.ts`, `useFarmActions.test.ts`. Note: **no test files exist for `usePoolTVL.ts` or `useNFTDropV2.ts`** — coverage gap.

Counts: **HIGH 4 · MEDIUM 9 · LOW 7 · INFO 5**

---

## HIGH

### H-062-01 — `useNFTBoost`: `enabled: !!address` but args use `[address!]` — read fires with `undefined` cast in arg array on first render
**File:** `useNFTBoost.ts:23-26`
The `enabled` guard prevents the call, but the `args: [address!]` non-null assertion masks the fact that on disconnect or first-pass before account hydrates, the contract entry has `args: [undefined]`. wagmi v2's `useReadContracts` will still fingerprint the entry and may produce a different cache shape per wallet vs no-wallet on rapid reconnects — combined with **no `chainId` in queryKey** (no chainId pinning anywhere in the hook) means a chain switch from L1→another network will continue to hammer the JBAC/Gold mainnet contract address until the cache invalidates. Net effect: stale boost-multiplier of `1.5` could leak from a pre-switch session into a post-switch UI state where the wallet has no JBAC on the new chain. Severity HIGH because it directly drives APR/share displays.

### H-062-02 — `useNFTDrop` / `useNFTDropV2`: missing `chainId` in queryKey → cross-chain cache poisoning
**Files:** `useNFTDrop.ts:16-27`, `useNFTDropV2.ts:43-59`
Neither hook scopes its `useReadContracts` query by chainId. The drop address `dropAddress` is parameterized but a malicious or stale router could pass the same address across chains (Sepolia, Base, etc.) where the contract may differ. Wagmi's queryKey for `useReadContracts` includes contract address+abi+functionName but **does not include the connected chainId by default** when the user switches networks mid-flight — the previously cached `mintPhase`, `currentPrice`, `paidPerWallet` results render on the new chain until refetch. This can mislead the user about cancellation status (HIGH because it gates the **refund** flow — a wrong `isCancelled=true` could let a user try to refund on a chain where the function reverts).

### H-062-03 — `usePoolTVL`: TVL multiplies user-influenceable reserves by ETH price with no sanity bounds
**File:** `usePoolTVL.ts:46-53`
`tvl = wethFloat * 2 * price.ethUsd` — if either `price.ethUsd` is corrupted (oracle attack, manipulated PriceContext) or `wethReserve` is reported huge (flash-loan/single-sided LP injection right before block read), `tvl` propagates straight into `vol24h` and `aprNum` without a cap before line 95's `MAX_APR` clamp. The APR cap exists, but TVL itself is uncapped and goes to formatting (`$XYZB`). Worse: the **ratio used to estimate volume** (`dailyVolumeRatio` 0.01–0.04 at line 84-88) is **branched on the manipulated `tvl`**, so an attacker can choose which ratio is hit. Also, `parseFloat(formatEther(wethReserve))` silently drops precision past 15 sig figs and can return `Infinity` if `wethReserve` exceeds `2^53/1e18` — no NaN/Infinity guard before multiplication.

### H-062-04 — `useLPFarming`: `refetchInterval: 30_000` plus auto-`refetch()` on every tx success → RPC storm under bot activity
**File:** `useLPFarming.ts:35, 60-69`
The hook polls every 30s **and** calls `refetch()` from the success-toast `useEffect` whenever `isSuccess && hash` flips. If a user batches multiple stake/withdraw/claim txns or a watcher script signs back-to-back, every confirmation triggers another full 10-call batch read on top of the 30s poll. There is no debounce, no `watch:false`, and no `gcTime`/`staleTime` configuration. Combined with the absence of a `chainId` key, on a public Alchemy/Infura key the project will rate-limit fast.

---

## MEDIUM

### M-062-01 — `usePoolData` APR computation: 60s `refetchInterval` plus on-focus refetch can show APR cached up to 60s after a `notifyRewardAmount` admin call
**File:** `usePoolData.ts:19`
Pool reward rate changes (admin restocks) won't surface for up to 60s. The hook also exposes `apr` as a string formatted to 2 decimals but never invalidates on chainId switch. Combined with the wallet-disconnected case (no chainId in cache key), an L2 user pulling the page sees L1 APR until poll fires.

### M-062-02 — `useFarmStats`: TVL formula assumes 1 TOWELI = 1 USD-display unit; price not multiplied into the displayed TVL
**File:** `useFarmStats.ts:29`
`tvl: ${Number(totalStakedStr).toLocaleString()} TOWELI` ignores `effectivePrice` entirely and always shows TOWELI count. Misleading because the field is *named* `tvl` (Total Value **Locked**, dollar concept) but reports a token count. Either rename or compute `totalStaked * price.priceInUsd`. Cross-check vs `usePoolTVL.tvl` which is in USD — the two hooks return wildly different conceptual values under the same field name.

### M-062-03 — `useUserPosition`: position read uses dummy `tokenId=1n` when `hasTokenId=false`, with `enabled` gate, but the contract entry array still references `tokenId=1n`
**File:** `useUserPosition.ts:38-41`
If wagmi's enabled-gate ever races, reading `getPosition(1)` of a stranger's tokenId would surface in the cache. The `enabled` flag is supposed to prevent it, but mixing the dummy-arg pattern with a shared queryKey means that if some other hook coincidentally reads `getPosition(1n)` (e.g. position-explorer admin tool), this hook would pick up that cached value. Use a sentinel that fails fast instead, or skip the call entirely with conditional contracts array.

### M-062-04 — `useUserPosition`: dual `useReadContracts` (lines 17 + 36) doubles the queryKey churn but shares no key — every render after `tokenId` flips spawns new key
**File:** `useUserPosition.ts:17, 36`
Each `useReadContracts` rebuilds its `contracts` array on every render with no `useMemo` wrapping. wagmi memoizes by deep-equality, but the inline objects are re-created — small overhead per render, becomes measurable on pages with rapid re-renders (e.g. polling charts). Same issue in `useLPFarming.ts:21-36`, `usePoolTVL.ts:19-31`, `useNFTDrop.ts:16-27`, `useNFTDropV2.ts:43-59`. Wrap `contracts` in `useMemo` keyed on `[address, chainId, deployedAddrs]`.

### M-062-05 — `useNFTDropV2`: `mintPhase` enum mapping diverges from `useNFTDrop` (5 phases vs 6) — silent contract-version mismatch
**File:** `useNFTDropV2.ts:79-90` vs `useNFTDrop.ts:41-51`
v2 says "no Closed enum, 4=Cancelled". v1 says "5=Cancelled, 4=Closed". Both hooks share the same `TEGRIDY_DROP_V2_ABI` import — if the ABI file actually still has the v1 enum but the code branches on v2 numbers, a real v1 contract mid-Closed state (=4) would render "Cancelled" in v2 and trigger a `canRefund=true` UI on a contract whose `refund()` will revert. Verify which ABI version backs `TEGRIDY_DROP_V2_ABI`.

### M-062-06 — `usePoolTVL`: no `enabled` gate; reads fire even when LP address not deployed
**File:** `usePoolTVL.ts:19-31`
Only `hasFeeRouter` gates the optional 3 reads. The first 3 reads (`getReserves`, `token0`, `totalSupply`) fire unconditionally. If `TOWELI_WETH_LP_ADDRESS` is the placeholder zero address pre-launch, every render hits RPC and gets reverts. Add `enabled: checkDeployed(TOWELI_WETH_LP_ADDRESS)`.

### M-062-07 — `useFarmActions`: `pendingETH` poll at 15s — fastest in the bundle, no `chainId` lock
**File:** `useFarmActions.ts:24`
Most aggressive poll in the file group. `enabled: !!address` but no chainId guard — if user switches to a chain without `REVENUE_DISTRIBUTOR_ADDRESS` deployed, the call reverts every 15s, surfacing as 0n which silently disables the `pendingEthGuard`. Net effect: the audit-mandated TF-03 protection becomes a no-op on wrong chain.

### M-062-08 — `useNFTDrop` / `useNFTDropV2`: `mint()` cost `mintPrice * BigInt(quantity)` lacks max-quantity sanity bound
**Files:** `useNFTDrop.ts:64-72`, `useNFTDropV2.ts:162-175`
`BigInt(quantity)` happily accepts a JS number up to `Number.MAX_SAFE_INTEGER` (2^53-1) and **`Math.floor`-coerces fractional inputs** — passing `quantity=1e18` makes `totalCost` astronomically large; wallet popup would catch it but the `inFlight` guard cannot, and there's no max-per-tx clamp. Add `if (quantity <= 0 || !Number.isInteger(quantity) || quantity > 1000) reject`.

### M-062-09 — `useLPFarming`: `parseEther` on user input with no NaN guard
**File:** `useLPFarming.ts:99-130`
`approveLP`, `stake`, `withdraw` all call `parseEther(amount)` directly. `parseEther('not-a-number')` throws; no try/catch. A non-numeric string from a flaky form input crashes the hook. Compare to `useFarmActions.ts:71` which does `isNaN(parseFloat(amount))` — that pattern is missing here.

---

## LOW

### L-062-01 — `usePoolData`: APR calculation uses `Number(aprBps)/1e18` which lossy-converts; tested only at clean wei values
**File:** `usePoolData.ts:34-43`
`aprScaled = rewardRate * 31536000n * 10000n * 10n ** 18n` then `Number(aprBps)/1e18`. For mid-range APRs this works; for very small `rewardRate` (1 wei/sec) and small stake, the test passes. But if `aprBps > 2^53`, the `Number()` cast loses precision. The cap at `>9999%` triggers but the displayed value 100.00 loses ~3 sig figs near the boundary. Tests cover `1 wei/sec / 31_536_000 wei` (apr=100.00) and the cap, but nothing in between near `aprNum>1e9`.

### L-062-02 — `useFarmStats.ts:29`: rounding direction unspecified (uses default `Number().toLocaleString()`)
For TVL/rewards display: `formatWei(_, 18, 4)` gives 4-decimal string, `Number()` then `.toLocaleString()` defaults to half-even rounding for the locale. No explicit truncation toward zero — a user could see TVL appear larger than actual by 0.0001 TOWELI. Cosmetic but consistent with audit hunt-list.

### L-062-03 — `useUserPosition.ts:51`: `boostBps = Number(position[1])` truncates if bps > 2^53
Highly unlikely (BPS realistically <100k), but no clamp. `boostMultiplier = boostBps / 10000` then floats — fine. INFO-grade for normal use; LOW because a misbehaving contract returning huge value would render wild multiplier.

### L-062-04 — `usePoolTVL.ts:67`: `Math.max(now - POOL_LAUNCH_TIMESTAMP, 86400)` floors pool age to 1 day
If clock is wrong (`now < POOL_LAUNCH_TIMESTAMP`), the diff is negative and `Math.max` saves it, but the `POOL_LAUNCH_TIMESTAMP = new Date('2025-03-01').getTime() / 1000` is a hardcoded literal — when the **real** pool launch differs from this constant, all APR estimates skew. Should read pool creation block from the pair contract.

### L-062-05 — `useNFTDrop.ts:37`: `Number(formatWei(mintPrice, 18, 8))` — `formatWei` returns a fixed-decimal string; `Number()` on `"0.00000000"` returns 0 which then displays as "0 ETH". For sub-1e-8 prices this is misleading. Use BigInt-based comparison for "is paid" branches.

### L-062-06 — `useNFTBoost.ts`: no polling interval set → defaults to wagmi's default (no poll). On mint of new JBAC NFT, the boost won't update until next page load or window-focus refetch (wagmi default = on-focus only). Document or add a 30s poll.

### L-062-07 — `useLPFarming` / `useFarmActions`: `setTimeout(reset, 4000)` and `setTimeout(reset, 0)` — fire-and-forget timers without cleanup if component unmounts. Memory-leak warning in StrictMode dev. `useNFTDrop/V2` returns the cleanup correctly. Inconsistent.

---

## INFO

### I-062-01 — Test coverage gaps
- **`usePoolTVL.ts`**: zero tests. Highest-complexity hook in the group (90 LOC, multi-branch APR/vol calc). Would catch H-062-03 reliably.
- **`useNFTDropV2.ts`**: zero tests despite divergent enum mapping (M-062-05).
- **`useFarmStats.test.ts:135`**: documents that `1 wei` → "0 TOWELI" — call out: this is a **wei-rounding artifact**, the test name even says "documents the current behaviour". Worth promoting to LOW: a user with 0.00001 TOWELI staked sees zero TVL.

### I-062-02 — Naming collision: `tvl` field
`useFarmStats.tvl` returns TOWELI count string; `usePoolTVL.tvl` returns dollar number. Two hooks, same field name, different units. Caller-side mistakes likely.

### I-062-03 — `usePoolTVL.ts:29`: `as any` cast bypasses wagmi's tuple-narrowing — comment justifies it but suppresses ABI mismatches at compile time. If `SWAP_FEE_ROUTER_ABI` adds/removes a function, the indexes (3,4,5) silently shift.

### I-062-04 — All read hooks set `refetchOnWindowFocus: true`. Combined with multiple hooks open on a page, focusing the tab fires N batched reads. Consider centralizing into a single context if all consumers share a single staking contract.

### I-062-05 — `useFarmActions.ts:64`: error message slicing strips URLs but doesn't strip the `0x` revert reason hex — a contract revert message containing user address would leak it into the toast. Sanitization is partial.

---

## Summary table

| ID | Severity | File | Line | Issue |
|---|---|---|---|---|
| H-062-01 | HIGH | useNFTBoost.ts | 23-26 | No chainId in queryKey → cross-chain boost leak |
| H-062-02 | HIGH | useNFTDrop[V2].ts | 16/43 | No chainId in queryKey → wrong-chain refund UI |
| H-062-03 | HIGH | usePoolTVL.ts | 46-53 | Unbounded TVL math, no NaN/Infinity guard |
| H-062-04 | HIGH | useLPFarming.ts | 35,69 | refetch on every tx + 30s poll → RPC storm |
| M-062-01..09 | MEDIUM | (multiple) | — | Stale data windows, missing memoization, sanity bounds |
| L-062-01..07 | LOW | (multiple) | — | Precision, rounding, polling defaults |
| I-062-01..05 | INFO | (multiple) | — | Coverage gaps, naming, casts |

Top-5: H-062-01, H-062-02, H-062-03, H-062-04, M-062-05.
