# Audit 004 — TegridyFeeHook.sol

**Agent:** 004
**Target:** `contracts/src/TegridyFeeHook.sol` (421 LOC)
**Cross-checks:** `contracts/test/TegridyFeeHook.t.sol`, `contracts/test/Audit195_PremiumHook.t.sol`
**Posture:** AUDIT-ONLY — no code changes.

Counts: HIGH=2, MEDIUM=4, LOW=4, INFO=4, TEST GAPS=6.

---

## HIGH

### H-1 — Fee credited to wrong currency on exact-output swaps (accounting drift vs PoolManager)
**File:** `contracts/src/TegridyFeeHook.sol:189-244`

For exact-output swaps (`amountSpecified > 0`), the hook charges the fee on whichever delta side is **positive** (input the user paid in), but the V4 PoolManager **always** applies `int128 hookDelta` against the **unspecified** currency. The contract then attempts to reconcile this in lines 240-243:

```solidity
bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
Currency creditCurrency = specifiedIsZero ? key.currency1 : key.currency0;
```

This formula is correct only for the exact-input path. For exact-output (`amountSpecified > 0`), `specifiedIsZero == zeroForOne` flips the meaning relative to `amount0/amount1` signs computed at lines 206-216 (where the fee value is taken from the **positive** delta = the specified currency). Result: the hook computes its **fee size** from the input/specified-currency delta but **credits** the unspecified-currency mapping, then the PoolManager actually deducts the int128 from the unspecified currency. `accruedFees[creditToken]` then increases by an amount denominated in the *other* token's units → permanent drift. `claimFees()` will eventually revert (PoolManager has no credit in that currency) or, worse, succeed against an unrelated balance and over-claim until `proposeSyncAccruedFees` is run.

**Impact:** Persistent fee accounting mismatch on every exact-output swap; revenue silently routed to the wrong currency bucket. Distinct from the documented C-04 fix (which only addressed which delta to read, not the credit-side currency).

**Likelihood:** HIGH — every exact-output swap.

---

### H-2 — Hook-fee return value is `int128`, but PoolManager expects unspecified-currency delta with sign-convention mismatch on exact-output
**File:** `contracts/src/TegridyFeeHook.sol:249`

The function returns `feeAmount` as a positive `int128` for both swap types. In Uniswap V4, the second return value of `afterSwap` is added to `BalanceDelta` of the unspecified currency: a positive value means the hook **takes** from the user, a negative value means the hook **pays** the user. For exact-output, V4 documentation requires the hook to return a value representing the unspecified-currency delta sign, **not** an absolute fee. By returning a positive value computed from the *specified* (input) currency on the exact-output branch, the hook either (a) double-charges the user (if the PoolManager treats the value at face) or (b) the swap settlement underflows and reverts. Combined with H-1, exact-output flows are broken.

**Impact:** Exact-output swap routing through this hook will either DoS or over-charge; protocol revenue/UX risk.

**Mitigation note:** Some V4 reference implementations only support exact-input on simple fee-skim hooks. If the design intent is exact-input only, the exact-output branch (190-217) should be removed and the hook should revert (or return zero) when `amountSpecified > 0`.

---

## MEDIUM

### M-1 — Reentrancy in `claimFees` is permissionless and pulls into `revenueDistributor`
**File:** `contracts/src/TegridyFeeHook.sol:275-282`

`claimFees` is `nonReentrant`, debits `accruedFees[currency]` before `poolManager.take(...)`, and is permissionless ("anyone can trigger"). The `take()` call sends tokens to `revenueDistributor`. Because `revenueDistributor` is owner-controlled (with timelock) but can be any contract, a malicious distributor (post-takeover or owner mistake) could:
- Receive ERC777-style `tokensReceived` callbacks → not blocked because `nonReentrant` covers only this contract, not cross-contract reentrancy into RevenueDistributor's own logic that calls back into the hook (e.g., `proposeSyncAccruedFees` from a compromised admin).
- The CEI is correct (state debit before external call) so the hook itself is safe; the residual risk lives in the distributor.

**Impact:** Defensive concern; the hook's own state machine survives, but composed reentrancy with a malicious distributor could drain via repeated claim+sync cycles. The 7-day SYNC_COOLDOWN limits velocity but does not eliminate the path.

---

### M-2 — Permissionless `claimFees` enables griefing via dust claims (gas-DoS on accounting)
**File:** `contracts/src/TegridyFeeHook.sol:275-282`

Anyone can call `claimFees(token, 1)` repeatedly, forcing 1-wei `poolManager.take` calls. Each call decrements `accruedFees`, emits `FeeCollected`, and incurs gas. Although tokens still go to the legitimate distributor, an attacker can:
- Spam thousands of dust claims pre-distribution to bloat event logs / off-chain indexers.
- Race a legitimate large claim by emptying `accruedFees` to zero in a frontrun, forcing the legitimate caller to ExceedsAccrued-revert.

**Impact:** Operational DoS, indexer noise. Mitigation: gate `claimFees` by minimum amount or require caller == distributor / owner / keeper.

---

### M-3 — `executeSyncAccruedFees` cooldown check uses `lastSyncExecuted[currency]` but is set AFTER state mutation, allowing a 0-cooldown bypass on first sync
**File:** `contracts/src/TegridyFeeHook.sol:300-312`

On the very first sync for a currency, `lastSyncExecuted[currency] == 0`, so `block.timestamp >= 0 + 7 days` is trivially true (since `block.timestamp >> 7 days` on any live chain). That's fine. But after a `cancelSyncAccruedFees` followed by `proposeSyncAccruedFees`, the 7-day cooldown is **only** vs `lastSyncExecuted`, NOT vs the previous proposal time. A compromised owner could rapid-fire propose → cancel → propose to bypass the *intent* of the cooldown if they ever execute even one sync (after that the 7-day window is enforced).

**Impact:** First sync after deployment has no effective cooldown protection — only the 24h timelock guards it. The H-01 fix removed the 50% cap relying on the cooldown, but the cooldown is single-use-relative. A compromised owner who has never synced can drop accruedFees to zero after just 24h.

---

### M-4 — `setFee` / `setRevenueDistributor` retained as `pure` revert stubs — gas waste and ABI ambiguity
**File:** `contracts/src/TegridyFeeHook.sol:331-333, 353-355`

These are kept "for test compat" but they remain in the deployed contract surface. They occupy bytecode, expose dead selectors that integrators may discover via 4byte and try to call (then revert), and they are not equivalent to truly removing them — wallets may still display them. Minor; better to remove from production deploy.

---

## LOW

### L-1 — Minimum-fee floor leaks fee on tiny dust swaps but skips the 1-wei minimum on amounts of exactly 1
**File:** `contracts/src/TegridyFeeHook.sol:220-232`

The block forces `feeAmount = 1` when `feeBps > 0` and computed fee is zero. But the `if (absRelevant > 1)` guard means a swap of exactly 1 unit pays zero fee. This is consistent and dust-friendly, but creates an exploitable vector if anyone wants to systematically swap in 1-unit chunks (only viable on tokens with very large nominal values, e.g., 18-decimals where 1 wei is meaningless — so practically benign, but flagged for completeness).

---

### L-2 — `int128` overflow check is correct but uses `uint128(type(int128).max)` — readable but wastes gas vs literal
**File:** `contracts/src/TegridyFeeHook.sol:196, 201, 209, 214`

`require(feeUint <= uint128(type(int128).max), "FEE_OVERFLOW");` — repeated 4 times. Could be hoisted to a constant. Style/gas only.

---

### L-3 — `sweepETH` reverts with `"NO_ETH"` if balance == 0 but allows owner to sweep arbitrarily often otherwise — no rate limit
**File:** `contracts/src/TegridyFeeHook.sol:411-417`

ETH always goes to the (timelocked) `revenueDistributor`, so this is fine for funds-flow, but a malicious owner could grief by triggering a sweep that calls a malicious distributor (set during a 48h timelock window) — the `call` value triggers fallback. Combined with M-1 reentrancy concerns into distributor.

---

### L-4 — `feeBps == 0` is allowed at runtime but minimum-fee floor still triggers the `feeAmount = 1` branch
**File:** `contracts/src/TegridyFeeHook.sol:220`

`if (feeAmount == 0 && feeBps > 0)` — correct guard, no actual bug. But during fee-zero periods (e.g., after `executeFeeChange(0)`), the entire block is properly skipped. Verified safe; flagged because tests don't cover the `feeBps==0 && nonzero swap` path.

---

## INFO

### I-1 — Hook addresses all other lifecycle hooks as no-ops correctly
**File:** `contracts/src/TegridyFeeHook.sol:128-164, 252-262`

`beforeSwap`, `beforeInitialize`, etc. all return their selectors. **However**, the hook flag bitmask `0x0044` declares only `afterSwap | afterSwapReturnsDelta`, so V4 will not actually call `beforeSwap` (line 160-164) or any other hook. The presence of the function bodies is harmless interface compliance (`IHooks`) but dead code at runtime — only `afterSwap` is reachable per V4 hook-mask semantics.

### I-2 — Fee scale is basis points (denom 10000), consistent with SwapFeeRouter and TegridyPair
Cross-check confirms `MAX_FEE_BPS = 100` (1%) and basis-points denom of 10000 matches `SwapFeeRouter.MAX_FEE_BPS` cap. No ppm/bps scaling drift.

### I-3 — Storage slot calculation in tests uses `slot 7` for `accruedFees` mapping
**Test:** `Audit195_PremiumHook.t.sol:721-725`, `TegridyFeeHook.t.sol:255`

Tests hard-code mapping slot 7. If a future refactor reorders state vars (e.g., adds a new state var above), these tests silently mutate the wrong storage. Layout-bound tests are fragile but not a contract bug.

### I-4 — No multi-hop double-charging path identified in this contract alone
The hook charges per-pool per-swap. Multi-hop double-charging would require the Router to traverse a pool with this hook twice; that's a Router-level concern. Cross-checked SwapFeeRouter — no double-application observed in this contract.

---

## TEST GAPS (high-priority)

1. **No live PoolManager integration test** — the entire afterSwap fee-computation path (lines 167-249) is exercised only through the `paused()` early-return branch in `Audit195_PremiumHook.t.sol:605-616`. The exact-input vs exact-output divergence (H-1, H-2) is **completely uncovered**.
2. **No exact-output (`amountSpecified > 0`) test** at all — the bug surface is unguarded by tests.
3. **No test for the 1-wei minimum-fee floor** (lines 220-232) — covers neither the `feeBps>0 && computed==0` branch nor the `absRelevant<=1` skip.
4. **No reentrancy test against a malicious distributor** — M-1 risk surface unverified.
5. **No fuzz test for `accruedFees` invariant** — `accruedFees[token]` should equal what `poolManager` credits the hook; this is the central drift surface.
6. **No test for `claimFees` permissionless griefing** — M-2 unverified.
7. **No test for first-ever sync bypassing cooldown intent** — M-3 unverified (`lastSyncExecuted` starts at zero).
8. **No assertion that `IHooks.beforeSwap` pure stub is unreachable** given the 0x0044 bitmask — I-1 not enforced.

---

## CROSS-CHECK SUMMARY

- `TegridyFeeHook.t.sol`: 26 tests, all admin/timelock surface. Zero swap-mechanics coverage.
- `Audit195_PremiumHook.t.sol`: hook tests H-01..H-09 cover access control, pause, claim revert, sync timelock, sweep — but not the fee-computation core.
- `SwapFeeRouter.sol`: independent fee path (basis points, MAX 100 = 1%, same scale). No shared state — both compute their own fees independently. **Cross-check: any swap routed via SwapFeeRouter into a TegridyFeeHook-attached V4 pool will be charged TWICE** (once by router, once by hook). This is by-design only if intentional; flagged as **MEDIUM design concern** but outside this file's scope.
- `TegridyPair.sol`, `TegridyRouter.sol`: do not reference TegridyFeeHook directly — the V4 hook is invoked by the V4 PoolManager, not by Tegridy's own AMM. Confirmed isolated.

---

## SUMMARY OF RECOMMENDATIONS (audit-only — for follow-up agents)

1. **HIGH PRIORITY:** Verify exact-output afterSwap delta math against canonical V4 PoolManager via Foundry fork-test before any redeploy.
2. Restrict `claimFees` caller to keeper/distributor or add minimum-amount guard.
3. Initialize `lastSyncExecuted[currency]` to `type(uint256).max` or `block.timestamp` in constructor to enforce cooldown on first use.
4. Remove pure-revert legacy setters from production bytecode; keep only in tests via shim.
5. Add fork-test invariant: `accruedFees[token] <= poolManager.balanceOf(hook, currency)` after each swap.
