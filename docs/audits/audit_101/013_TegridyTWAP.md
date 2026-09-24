# Forensic Audit 013 — TegridyTWAP.sol

**Auditor:** Agent 013
**Target:** `contracts/src/TegridyTWAP.sol` (365 LOC)
**Tests:** `contracts/test/TegridyTWAP.t.sol`
**Scope:** TWAP manipulation, observation buffer, staleness, period gates, cumulative math, FixedPoint, oracle bricking, granularity, owner privileges.
**Date:** 2026-04-25

---

## SUMMARY

| Severity | Count |
|----------|-------|
| HIGH     | 3     |
| MEDIUM   | 5     |
| LOW      | 4     |
| INFO     | 3     |

---

## HIGH

### H-1. Deviation guard reads CUMULATIVE-derived prevSpot but compares to SPOT — first 2 observations have zero deviation gate
**Location:** `update()`, lines 164–188.

The deviation check requires `count >= 2` AND `prev.timestamp > 0`. Therefore the **second** observation is admitted **without any deviation check** (because `count == 1` when recording obs #2). An attacker who is the very first to call `update()` immediately after deployment (count=0) and then does a flash-loan swap before calling again 15 min later (count=1 at deviation check entry, but skipped) can lock in a wildly distorted second observation. Once two observations exist the guard activates, but the **second** becomes the baseline `prev` for obs #3, meaning the guard now compares incoming spot against an already-poisoned `prevSpot0`. A 50%-deviated baseline lets a 99.9% manipulated spot pass (ratio relative to a poisoned prev is small).

**Impact:** Direct TWAP manipulation when oracle is fresh / sparsely observed — a critical bootstrap window. Real-world: lending protocols that deploy the TWAP and start consulting after only 2–3 observations get a poisonable oracle.

**Fix:** Require `count >= 1` for deviation check (compare against last observation's spot, derived from raw reserves at last update — but reserves aren't stored). Better: store `lastSpot0` per-pair to compare incoming spot vs. last spot directly, gating from observation #2 onward.

**Test gap:** No test seeds *exactly* 1 prior observation and pushes a 99% deviation as obs #2. `test_update_revertsOnLargePriceDeviation` seeds 3, masking this.

---

### H-2. `prevSpot0` reconstructed only from `price0` cumulatives — `price1`-direction deviation is unguarded
**Location:** Lines 176–184.

The deviation check computes `prevSpot0 = (last.price0Cumulative - prev.price0Cumulative) / prevElapsed` and compares to `spotPrice0` only. There is **no symmetric check on `spotPrice1`/`prevSpot1`**. While in pure constant-product math `price1 = 1/price0`, the check uses **integer division** for both directions independently, and the reverse-direction `consult()` returns `priceDiff = priceCumEnd - priceCumStart` for `price1Cumulative`. A carefully crafted reserve manipulation where `reserve0` is large (so `spotPrice0` change is small in BPS) but `reserve1` flips dramatically can pass the price0 gate while poisoning price1 cumulatives. Particularly viable when reserves are highly unbalanced.

**Impact:** `consult(pair, tokenB, ...)` (the reverse direction) can be manipulated even when the forward direction passes the guard.

**Fix:** Mirror the deviation check on `spotPrice1` vs. derived `prevSpot1`, OR (preferred) gate on both directions OR'd.

**Test gap:** All deviation tests use `_swapAForB` (forward direction). No test exercises a reverse-direction-only manipulation pattern.

---

### H-3. Staleness check uses raw `block.timestamp - latest.timestamp` (uint32-truncated) — wrap-around at year 2106 produces negative diff that underflows revert and serves stale prices as fresh
**Location:** Line 318.

```solidity
if (block.timestamp - latest.timestamp > MAX_STALENESS) revert StaleOracle();
```

`block.timestamp` is `uint256`. `latest.timestamp` is `uint32`. Solidity 0.8 implicitly upcasts the `uint32` to `uint256` — so `block.timestamp - latest.timestamp` is a `uint256` subtraction. After the year-2106 wrap, `latest.timestamp` (which was stored as `block.timestamp % 2^32`) is a small number while `block.timestamp` (uint256) keeps growing — meaning `block.timestamp - latest.timestamp` becomes **enormous**, always > MAX_STALENESS, and the oracle **bricks** for that pair (every consult reverts StaleOracle indefinitely until an `update()` succeeds — but `update()` itself does not wrap `latest.timestamp` correctly for `canUpdate()` either: `block.timestamp - last.timestamp` in `canUpdate()` has the same uint32→uint256 mismatch, line 256). Once an `update()` succeeds (which it will, eventually), things normalize. **Net effect**: post-2106, every TegridyTWAP consumer that sees ~70 years of staleness across the wrap effectively bricks until manual unstick.

**Impact:** Future-bricking. Lower urgency than 2026, but multi-decade liabilities matter for a protocol marketed as long-term.

**Fix:** Cast `block.timestamp` to `uint32` before subtraction in BOTH `consult()` (line 318) and `canUpdate()` (line 256), so unchecked modular semantics apply. Or use a uint256 timestamp throughout.

**Test gap:** No test covers a `vm.warp` past 2106-01-01.

---

## MEDIUM

### M-1. Observation buffer overwrite during `_getCumulativePricesOverPeriod` search — `obs.timestamp == 0` check is the ONLY freshness signal
**Location:** Lines 325–341.

The search loop skips entries where `obs.timestamp == 0` (uninitialized slot). However, in the 2106 wrap window, a legitimately-stored observation can have `timestamp == 0` (when `block.timestamp % 2^32 == 0`). That observation will be silently skipped, biasing TWAP toward older data. Also, the `if (obs.timestamp <= targetTimestamp)` comparison breaks across the uint32 wrap — observations stored just before the wrap have huge timestamps; those after have tiny ones, and the linear scan picks the wrong one.

**Impact:** Incorrect TWAP for a ~15-minute window every 136 years; in practice, **immediate concern** if any chain has timestamp offsets putting the wrap in the foreseeable horizon.

**Fix:** Use modular comparison or store uint256 timestamps.

---

### M-2. `_getCumulativePricesOverPeriod` falls back to `oldestIdx` of `0` when count < MAX_OBSERVATIONS — but slot 0 may have been overwritten in a prior buffer cycle
**Location:** Lines 343–352.

If `count >= MAX_OBSERVATIONS`, oldest is `observationIndex[pair]` (correct circular tail). If `count < MAX_OBSERVATIONS`, it falls back to `oldestIdx = 0`. But `count` only ever increments — it never decreases. After 49 updates on a pair, count = 49, oldest is `observationIndex[pair]` (correct). After 100 updates, count = 100, oldest is also `observationIndex[pair]`. Fine. But `count < MAX_OBSERVATIONS` covers *only* the very first 47 updates. So `oldestIdx = 0` is correct for that window. **However**, no `count` reset means there is no "evict on stale data" path. After deploying and updating 5 times, then leaving the oracle dormant for 2 years, count remains 5, the 5 observations are 2 years stale, and `consult` reverts StaleOracle — but a single fresh `update()` will create a new observation at idx=5. Now count=6, but slots 0–4 hold ancient data. **The deviation check** at line 167 reads `prev = obs[prevIdx]` which is `obs[4]` — 2 years stale. `prevElapsed` will be large but valid; `prevSpot0` is the *historical* price. If real price has moved 10x, the new spot will revert PriceDeviationTooLarge — **the oracle is now self-bricking** because no fresh observation can ever exceed the deviation threshold against ancient data.

**Impact:** Dormant pair revival is impossible without a price within 50% of historical. Permanent DoS for paused/abandoned pairs that resume trading.

**Fix:** When `block.timestamp - last.timestamp > MAX_STALENESS_FOR_DEVIATION` (e.g., 1 day), skip the deviation check and accept the new observation as a fresh baseline.

---

### M-3. `update()` accepts msg.value == 0 path, but `accumulatedFees += updateFee` still increments when fee is 0 — wait, it's gated by `if (updateFee > 0)`. **However**, the require on `msg.value == 0` reverts with a string and not the `InsufficientFee` selector; tests checking error selectors will not catch unintended ETH sends.
**Location:** Lines 119–131.

Minor; cosmetic / test-fragility. Not a security finding per se.

---

### M-4. `setUpdateFee` allows the owner to **front-run** an `update()` by raising the fee from 0 to MAX_UPDATE_FEE in the same block, griefing legitimate updaters who sent only the previously-required value
**Location:** Lines 278–283.

A keeper bot designed for fee=0 will send `msg.value=0`. Owner sets fee=0.01 ETH. Keeper's tx reverts with `InsufficientFee`. The **owner-pinned period bypass** vector mentioned in the hunt list applies adjacently: the owner cannot directly manipulate periods, but can effectively pause updates by setting an unaffordable-for-the-bot fee. While the cap (0.01 ETH) limits griefing severity, on cheap-gas chains 0.01 ETH per update is prohibitive.

**Impact:** Owner-caused DoS of TWAP refreshes; downstream consumers see stale/missing data.

**Fix:** Add a timelock on `setUpdateFee` (e.g., 24-hour delay). The TWAPAdmin already implements 2-step ownership but no timelock on the fee itself.

---

### M-5. Refund path uses raw `.call{value: excess}` to `msg.sender` with no reentrancy guard — and the call is made BEFORE `accumulatedFees += updateFee` is technically locked in storage because the slot was already updated
Actually re-reading: `accumulatedFees += updateFee` happens BEFORE the refund call (line 121 < line 125). Storage update is committed before external call. State inconsistency on reentrancy: **a malicious `msg.sender` can re-enter `update()` from its receive() handler.** The reentrant call sees the same `canUpdate(pair) == true` (it hasn't been written yet — the new observation is recorded *after* the refund). However, the reentrant call requires `msg.value >= updateFee` again — meaning the attacker pays the fee twice and receives a refund of the inner excess. State writes happen sequentially. **The actual issue:** `observationIndex[pair]` and `observationCount[pair]` and `observations[pair][idx]` are all updated AFTER the refund. A reentrant `update()` will revert because `canUpdate` checks `last.timestamp` of the (already-set, but not by this call) prior observation — actually `canUpdate` reads from storage which hasn't been written yet either. So reentrancy lets the attacker record TWO observations from a single outer call, both at the same `block.timestamp`. The second write would set `idx + 1` with `elapsed = blockTs - blockTs = 0` and accumulate nothing — but it **shifts the buffer index**, wasting a slot and potentially knocking real observations out of range.

**Impact:** Buffer poisoning by index advancement (low-bandwidth DoS).

**Fix:** Add `nonReentrant` modifier to `update()`, or use Checks-Effects-Interactions (move the refund call to the very end of the function, after all storage writes).

---

## LOW

### L-1. `MAX_OBSERVATIONS = 48` × `MIN_PERIOD = 15 min` = 12-hour window — but `MAX_STALENESS = 2 hours`. **Granularity vs windowSize mismatch.** A keeper that updates every 15 minutes (the minimum) has 48 observations spanning 12 hours, but `consult()` rejects anything older than 2 hours. So 8 of the 48 buffer slots are *guaranteed unreachable* by `consult`. Wasted storage; a smaller MAX_OBSERVATIONS or larger MAX_STALENESS would align granularity to window. **Note:** the period-too-long check rejects `period > 12 hours`, so a consumer can request up to 12h, but the staleness cap on `latest.timestamp` (not on `best.timestamp`) means the period can extend back through stale observations.

### L-2. `withdrawFees()` is callable by anyone — pulls to `feeRecipient` (or owner). Permissionless trigger is fine, but no event ordering guarantee against the recipient's call handler. If `feeRecipient` is a contract, it could re-enter `withdrawFees` — but `accumulatedFees = 0` is set before the call (CEI compliant). Safe. **Actual issue:** if `feeRecipient` is a contract that always reverts on receive, **all accumulated fees are permanently locked** (require(ok) reverts). Only the owner can unbrick by changing recipient — which they can do. So: dependent on owner liveness.

### L-3. `Observation.timestamp` stored as uint32 (Uniswap V2 inheritance), but the surrounding contract uses `block.timestamp` as uint256. Any cast/comparison inconsistency is a footgun. Already noted in H-3 and M-1.

### L-4. `getObservationCount` returns `min(count, MAX_OBSERVATIONS)` — useful for UI. But `observationCount(pair)` (the auto-generated public getter on the mapping) returns the unbounded count. External consumers may use the wrong getter.

---

## INFO

### I-1. Unchecked accumulation matches Uniswap V2 design — intentional and correct (modular wrap).
### I-2. `MAX_DEVIATION_BPS = 5000` (50%) is generous; many production TWAPs use 10–20%. Tradeoff: lower = more rejection of legit volatility, higher = weaker manipulation gate. Acceptable as a default.
### I-3. The contract is `abstract TWAPAdmin` + `contract TegridyTWAP`. The split is purely organizational. Admin functions live on the concrete contract via inheritance. Fine.

---

## TEST GAPS (consolidated)

1. **No test for bootstrap manipulation (1→2 observations, deviation skipped on second)** — see H-1.
2. **No test for reverse-direction-only price1 manipulation** — see H-2.
3. **No test for uint32 timestamp wrap (year 2106 / large genesis offset chains)** — see H-3, M-1.
4. **No test for stale-pair revival** (deviation guard self-bricks dormant pairs) — see M-2.
5. **No test for reentrancy in `update()` refund path** — see M-5.
6. **No test for `withdrawFees()` to a reverting `feeRecipient`** — see L-2.
7. **No fuzz test on `consult` with cumulative-overflow boundary** (price0Cumulative just below uint224 max).
8. **No test for the 8 unreachable buffer slots** beyond MAX_STALENESS.
9. **No test verifying `setUpdateFee` followed by an immediate update at old fee value** — keeper griefing.
10. **No invariant test:** `observationCount` monotonically increases; `observationIndex < MAX_OBSERVATIONS`.

---

## TOP-3 RECOMMENDATIONS

1. **Fix bootstrap deviation gap (H-1):** activate deviation check from observation #2 onward by storing `lastSpot0` directly.
2. **Mirror deviation check to price1 direction (H-2):** prevents reverse-side manipulation.
3. **Add reentrancy guard to `update()` (M-5)** and timelock to `setUpdateFee` (M-4) to close fee-driven DoS.
