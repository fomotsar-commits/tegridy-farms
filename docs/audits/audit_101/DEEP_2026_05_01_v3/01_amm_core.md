# Deep AMM Core Audit — Pass 3 (Post-V2 Re-Audit) — 2026-05-02

**Targets:** TegridyPair, TegridyFactory, TegridyFeeHook, TegridyTWAP
**Method:** Re-audit of the post-V2 code (commit `1eb487d`) for next-tier regressions and gaps from the 8 fixes shipped against pass-2 findings.
**Baseline:** `.audit_101/DEEP_2026_05_01_v2/01_amm_core.md` (1 High, 4 Medium, 2 Low, 1 Info).

---

## Pass-2 Verification Summary

| Pass-2 ID | Status | Notes |
|---|---|---|
| V2-AMM-H1 (consult anchor bypass) | **Closed** | `_getCumulativePricesOverPeriod` now reverts `OracleRebootstrapping` on `best.bypassed`. Outer guard tightened to `_count >= 2`. |
| V2-AMM-M1 (claimFees expired-proposal DoS) | **Closed (with new gap — see V3-M2)** | Now allows after `block.timestamp > readyAt + _proposalValidity()`. But `pendingSyncCredit[currency]` and `pendingSyncCreditSnapshot[currency]` are not cleared on expiry — affects only future proposals. |
| V2-AMM-M2 (harvest bootstrap kLast) | **Closed (with regression — see V3-L1)** | `bootstrap = (feeOn && kLast == 0)` re-allows kLast write. But `feeOn = false` path that USED to clear stale kLast is now blocked (revert before _mintFee state takes effect). |
| V2-AMM-M3 (sweepETH allowlist) | **Partially closed — see V3-H1** | Allowlist `{revenueDistributor, owner()}` blocks arbitrary EOA but `owner()` IS the compromised key in the threat model that M-32 was protecting against. Still an instant-drain primitive. |
| V2-AMM-M4 (harvest disabledPairs gate) | **Closed** | Harvest now gated symmetrically with mint/swap/sync/skim. |
| V2-AMM-L1 / L2 / INFO1 | **Closed** | NatSpec + dead-code cleanups landed. |

---

## Severity counts (this pass)

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 2 |
| Low | 2 |
| Info | 1 |

---

## [V3-H1] V2-AMM-M3 fix is incomplete — `sweepETH(owner())` is still an instant ETH drain primitive for a compromised owner
**Severity:** High
**File:** `contracts/src/TegridyFeeHook.sol:535-542`
**Category:** gov
**Pass-2 ref:** V2-AMM-M3 (regression of the regression)

**Bug:**
The V2 fix restored the M-32 allowlist concept but defined it as `{revenueDistributor, owner()}`. The original M-32 NatSpec is explicit that the design's threat model is **"a compromised owner"** — yet the new allowlist explicitly includes `owner()` as a permitted recipient. A captured owner can call `sweepETH(owner())` and instantly drain the entire ETH balance to themselves, bypassing the 48h `proposeDistributorChange` timelock that M-32 was originally designed to enforce.

The pass-2 V2-AMM-M3 finding correctly identified that the prior "arbitrary `to`" was an over-correction. The shipped fix restored the allowlist but kept `owner()` in it, ostensibly as a "fallback for the case where `revenueDistributor` is a reverting contract" — but `owner()` IS the compromised principal in M-32's threat model, so this fallback is the same instant drain by a different name.

**Attack / Impact:**
1. Owner key is compromised (the threat model M-32 is built on).
2. Attacker calls `sweepETH(attackerOwnedEOA)` — but only if `attackerOwnedEOA == owner()`, which it IS, since the attacker controls the owner key.
3. Entire ETH balance accumulated via the `receive()` payable function is drained instantly.
4. The 48h `proposeDistributorChange` timelock is structurally bypassed.

The OnlyOwner gate on `sweepETH` is the same gate the attacker has just defeated by stealing the key. Adding an allowlist that includes the attacker's own principal does nothing against the threat model the original M-32 was designed for.

**Evidence:**
```solidity
// TegridyFeeHook.sol:535-542 (post-V2)
function sweepETH(address to) external onlyOwner {
    // V2-AMM-M3: allowlist [revenueDistributor, owner()]
    if (to != revenueDistributor && to != owner()) revert InvalidSweepRecipient();
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_ETH");
    (bool success,) = payable(to).call{value: balance}("");
    if (!success) revert SweepFailed();
    emit ETHSwept(to, balance);
}
```
A captured owner can simply call `sweepETH(maliciousAttackerEOA_thatIsAlsoOwner)` and the allowlist passes (`to == owner()`).

**Recommendation:**
Mirror the original M-32 design: hard-code the recipient as `revenueDistributor`. For the "broken distributor" fallback case, add a SEPARATE timelocked path:
```solidity
function sweepETH() external onlyOwner {
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_ETH");
    (bool success,) = payable(revenueDistributor).call{value: balance}("");
    if (!success) revert SweepFailed();
    emit ETHSwept(revenueDistributor, balance);
}

// Separate timelocked recovery path for revenueDistributor brick scenario.
function proposeETHRecovery() external onlyOwner {
    _propose(ETH_RECOVERY, 48 hours);
}
function executeETHRecovery() external onlyOwner {
    _execute(ETH_RECOVERY);
    uint256 balance = address(this).balance;
    (bool ok,) = payable(owner()).call{value: balance}("");
    require(ok, "RECOVERY_FAILED");
}
```
Pattern: Maker DSPause emergency fund recovery uses a 48h timelock for any owner-directed treasury movement. Pattern: Compound Timelock requires 14d for `setPendingAdmin`-class operations precisely to bound a single key compromise's blast radius.

---

## [V3-M1] `harvest()` with `feeOn == false` reverts before `_mintFee`'s `kLast = 0` cleanup takes effect
**Severity:** Medium
**File:** `contracts/src/TegridyPair.sol:362-388`
**Category:** dos
**Pass-2 ref:** V2-AMM-M2 (regression — secondary side-effect of bootstrap fix)

**Bug:**
The V2-AMM-M2 fix added `bool bootstrap = (feeOn && kLast == 0);` to allow first-after-feeTo harvest to bootstrap `kLast`. But for the symmetric path — when `feeTo` was just UNSET — harvest now BREAKS the canonical Uniswap V2 cleanup pattern.

When `feeTo == address(0)` (feeOn turns off):
1. `_mintFee` enters the `else if (_kLast != 0) { kLast = 0; }` branch and tentatively sets `kLast = 0` in storage. Returns `feeOn = false`.
2. `bool bootstrap = (false && kLast == 0) = false` (because `feeOn` is false; `kLast` value is irrelevant).
3. `require(totalSupply() > supplyBefore || bootstrap, "NO_FEE_TO_MATERIALIZE")` reverts (no LP minted, bootstrap false).
4. **All state changes from this transaction revert, including `_mintFee`'s `kLast = 0` cleanup.**

The canonical Uniswap V2 invariant is that `kLast` MUST be cleared whenever `feeOn` transitions to false. Pre-V2-AMM-M2 harvest performed this cleanup correctly; post-V2 harvest is unable to do so. The cleanup still happens on the next `mint()` or `burn()`, so the staleness window is bounded — but harvest is no longer a valid path to perform it.

**Attack / Impact:**
1. Owner unsets `feeTo` (via factory governance). `kLast` is non-zero from prior protocol-fee accounting.
2. Time passes; no liquidity events occur on the pair (low-churn pair, weekend, etc.).
3. Off-chain keeper calls `harvest()` — it reverts `NO_FEE_TO_MATERIALIZE`. The keeper interprets this as "no fees to capture", which is correct, but the side-effect of NOT clearing `kLast` is silent.
4. Owner re-enables `feeTo` (different multisig, different address, etc.). `kLast` still holds the stale value from the prior feeOn cycle.
5. Next `mint()` or `burn()` calls `_mintFee` with `feeOn = true` and the **stale** `_kLast`. The fee math runs: `rootK = sqrt(currentReserves)`, `rootKLast = sqrt(staleKLast)`. If reserves grew during the feeOn=false interim (impossible without swaps; possible via skim/donation patterns), `rootK > rootKLast` and protocol LP is minted **for K-growth that was never accompanied by a 0.3% swap fee** — i.e., the protocol mints LP against donated balances, diluting honest LPs.

The exploit surface is bounded by the absence of swaps during the feeOn=false interim. But with the V2-AMM-H2 fix gating `sync()`, the only remaining donation path is direct `IERC20.transfer` to the pair (skim is also gated). A subsequent `mint()` from the same attacker (who donated) triggers the stale-baseline mint-fee LP, then the attacker burns their own LP to extract the reserves — a small amplification but real.

**Evidence:**
```solidity
// TegridyPair.sol:362-388 (post-V2)
bool feeOn = _mintFee(_reserve0, _reserve1);     // <-- may set kLast=0 in memory
bool bootstrap = (feeOn && kLast == 0);          // <-- bootstrap=false when feeOn=false
require(totalSupply() > supplyBefore || bootstrap, "NO_FEE_TO_MATERIALIZE");  // <-- reverts
// State revert: _mintFee's kLast=0 cleanup is undone.

// _mintFee (line 442-460):
if (feeOn) {
    if (_kLast != 0) { ... mint logic ... }
} else if (_kLast != 0) {
    kLast = 0;   // <-- this storage write is reverted by harvest's downstream require
}
```

**Recommendation:**
Allow the cleanup-only path through harvest, mirroring the bootstrap path:
```solidity
bool bootstrap = (feeOn && kLast == 0);
bool cleanup = (!feeOn && supplyBefore == totalSupply());  // _mintFee already cleared kLast in memory
require(totalSupply() > supplyBefore || bootstrap || cleanup, "NO_FEE_TO_MATERIALIZE");
```
Or restructure to gate ONLY on the steady-state no-op case (feeOn && kLast != 0 && rootK == rootKLast → no mint). The intent of D-AMM-M2 was to prevent griefing of the harvest cadence, not to block legitimate state-cleanup paths.

Pattern: Uniswap V2 `_mintFee` is called from mint AND burn precisely to ensure cleanup runs on the next liquidity event. By gating harvest with the strict `totalSupply()` check, the protocol now has THREE paths that handle the feeOn-toggle cleanup (mint, burn, harvest) but only TWO of them work — the asymmetry is the regression.

---

## [V3-M2] `claimFees` expired-proposal gate ignores stale `pendingSyncCredit` — racing attack on the next `proposeSyncAccruedFees`
**Severity:** Medium
**File:** `contracts/src/TegridyFeeHook.sol:329-342, 354-365`
**Category:** mev
**Pass-2 ref:** V2-AMM-M1 (new gap from the fix)

**Bug:**
The V2-AMM-M1 fix lets `claimFees` proceed once `block.timestamp > readyAt + _proposalValidity()` (the original sync proposal expired). However, `pendingSyncCredit[currency]` and `pendingSyncCreditSnapshot[currency]` are NOT cleared on expiry — only on `executeSyncAccruedFees` or `cancelSyncAccruedFees`. This creates a NEW racing window:

1. Owner proposes sync at t=0 with `actualCredit = X` (where X is significantly higher than current `accruedFees[currency]`, indicating undercount drift). `pendingSyncCredit[currency] = X`, `pendingSyncCreditSnapshot[currency] = onChain_at_t0`.
2. Owner is unable to execute (offline, multisig coordination, key rotation, etc.).
3. At t=24h+7d, the proposal expires. claimFees becomes unblocked.
4. Anyone calls `claimFees(currency, accruedFees[currency])` to drain the current low-watermark accruedFees to revenueDistributor. accruedFees → 0.
5. PoolManager's on-chain credit balance for the hook now drops by `accruedFees[currency]` (whatever was drained).
6. Owner finally comes back online and **re-proposes sync** with the correct `actualCredit`. They MUST first call `cancelSyncAccruedFees` to clear `_executeAfter[key]`, which clears `pendingSyncCredit/Snapshot` to 0.
7. They re-propose. New propose-time snapshot is captured against the now-DRAINED PoolManager balance. The legitimate drift correction is now bounded by the post-drain balance, not the pre-drain balance.

**Attack / Impact:**
The drift correction proposal is permanently undersized by exactly the amount that was drained during the expiry window. If the drift was a genuine under-count by N units (and accruedFees[currency] was at low-watermark M, with on-chain credit at M+N), then post-expiry-claimFees the on-chain credit is at N, and the drift correction can only set accruedFees up to N — recapturing the under-count exactly **but losing the M that was drained too early**. Net: protocol loses the M of fees that were drained at the low pre-correction accounting, since they were sent to revenueDistributor at less-than-actually-earned valuation.

This is a structural griefing of the drift correction mechanism. Combined with V2-M1's still-present "active malicious owner can re-propose every block" surface, an attacker who controls the owner key can:
- Forever-block claimFees by re-proposing,
- Or let the proposal expire and watch claimFees race the eventual correction.

Either way, drift correction is broken.

**Evidence:**
```solidity
// TegridyFeeHook.sol:329-342 (post-V2)
function claimFees(address currency, uint256 amount) external nonReentrant whenNotPaused {
    bytes32 syncKey = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
    uint256 readyAt = _proposalReadyAt(syncKey);
    require(
        readyAt == 0 || block.timestamp > readyAt + _proposalValidity(),
        "SYNC_PENDING"  // ← passes once expired, even though pendingSyncCredit retains stale state
    );
    ...
}

// TegridyFeeHook.sol:354-365 — propose checks SAME_VALUE against accruedFees, not pendingSyncCredit
function proposeSyncAccruedFees(address currency, uint256 actualCredit) external onlyOwner {
    require(actualCredit != accruedFees[currency], "SAME_VALUE");  // ← stale pendingSyncCredit irrelevant
    ...
    pendingSyncCreditSnapshot[currency] = poolManager.balanceOf(...);  // ← live read at re-propose time
    ...
}
```
The propose-time snapshot is captured fresh, so the SECOND proposal correctly sees the post-drain balance. The bug is that the FIRST proposal's expiry permitted the drain in the first place.

**Recommendation:**
On expiry, treat the proposal as if cancelled — but expose a permissionless `cancelExpiredSync(currency)` that anyone can call to clean up `pendingSyncCredit/Snapshot`. Pattern: Compound Timelock allows anyone to observe expiration. Alternative: latch the propose-time snapshot in `claimFees` so that during the expired-but-stale-state window, the accruedFees floor is the snapshot, not the current value:
```solidity
function claimFees(...) external ... {
    uint256 readyAt = _proposalReadyAt(syncKey);
    bool expired = readyAt != 0 && block.timestamp > readyAt + _proposalValidity();
    require(readyAt == 0 || expired, "SYNC_PENDING");
    if (expired) {
        // Honor the original drift correction's lower bound until it's formally cancelled.
        uint256 floor = pendingSyncCredit[currency];
        require(accruedFees[currency] - amount >= floor, "BELOW_PENDING_SYNC_FLOOR");
    }
    ...
}
```
This preserves the drift-correction integrity even during the expiry-then-resync window.

---

## [V3-L1] V2-H1 `best.bypassed` revert leaves `consult()` permanently bricked when the bypass observation has rotated into the oldest slot
**Severity:** Low
**File:** `contracts/src/TegridyTWAP.sol:655-678`
**Category:** oracle (recovery)
**Pass-2 ref:** V2-AMM-H1 (residual after the buffer-window guard)

**Bug:**
After the V2-H1 fix lands, any `consult()` whose lookup window crosses a bypass observation reverts `OracleRebootstrapping`. The bypass observation's slot rotates out of the consultable range after at most `MAX_OBSERVATIONS * MIN_PERIOD = 12 hours`. **However**, the `_getCumulativePricesOverPeriod` `!found` fallback path uses the OLDEST observation in the buffer as `best`. If the oldest is the bypass observation (e.g., right after reset, or in a sparse-update scenario), every `consult()` reverts — even if there are 47 newer non-bypass observations, the lookup falls through to the oldest because none of the newer observations precedes `targetTimestamp`.

This concretely happens when:
1. Owner admits a bypass observation (legitimate post-dormancy rebootstrap).
2. Honest keepers fill subsequent slots.
3. A consumer calls `consult(pair, ..., period)` with `period > elapsed_since_bypass`.
4. The loop scans for an observation BEFORE `targetTimestamp = latest.timestamp - period`. None of the post-bypass observations are old enough. The bypass observation IS old enough, BUT the loop's `obs.timestamp == 0 ? continue` doesn't fire (bypass obs has a real timestamp), and the wrap-aware diff-check selects the bypass as `best`.
5. V2-H1 reverts.

**Attack / Impact:**
The intended behavior of `OracleRebootstrapping` is "wait at most 12h for the bypass to roll out". But when consumers query with periods that REACH the bypass window, the revert persists for as long as their `period` setting requires. A 4h TWAP consumer is bricked for 4h after a legitimate bypass; an 11h TWAP consumer is bricked for 11h.

The owner's recourse is `proposeAdminResetPair` / `executeAdminResetPair` (24h timelock from D-AMM-H3). For a high-stakes consumer (lending protocol), 11h of price-feed unavailability is a service-level incident. The recovery primitive (24h reset) is LONGER than the natural recovery (≤12h), so it doesn't help.

**Evidence:**
```solidity
// TegridyTWAP.sol:655-678
if (!found) {
    uint8 oldestIdx;
    if (count >= MAX_OBSERVATIONS) {
        oldestIdx = observationIndex[pair];   // wrapped buffer: next-to-write IS oldest
    } else {
        oldestIdx = 0;
    }
    best = observations[pair][oldestIdx];
    if (best.timestamp == 0 || best.timestamp == latest.timestamp) revert InsufficientObservations();
}

// V2-AMM-H1: blanket bypass-revert regardless of whether `best` was selected by the loop
//             OR by the !found fallback.
if (best.bypassed) revert OracleRebootstrapping();
```

**Recommendation:**
On the `!found` fallback, narrow the period to start from the OLDEST NON-BYPASS observation rather than reverting:
```solidity
if (!found) {
    // Scan for oldest non-bypass observation in the buffer.
    bool foundFallback = false;
    for (uint256 i = effectiveCount - 1; i > 0; i--) {
        uint8 idx = ...;
        Observation memory obs = observations[pair][idx];
        if (obs.timestamp != 0 && !obs.bypassed) {
            best = obs;
            foundFallback = true;
            break;
        }
    }
    if (!foundFallback) revert OracleRebootstrapping();
}
```
This reduces the brick window to "until the bypass observation has rolled out of the buffer entirely", recovering serve-ability earlier for consumers with long periods.

Alternative: add a `consultClampPeriod(pair, ..., maxPeriod)` variant that clamps the period to the largest available non-bypass anchor, with the actual elapsed returned to the consumer.

---

## [V3-L2] `lastSpot{0,1}` poisoning by owner-bypass still bricks honest `update()` for up to `DEVIATION_BYPASS_AFTER` (1 day)
**Severity:** Low
**File:** `contracts/src/TegridyTWAP.sol:330-365`
**Category:** oracle (owner-trust)
**Pass-2 ref:** V2-AMM-L1 (residual concretization)

**Bug:**
The V2-AMM-L1 NatSpec acknowledged that a captured owner can admit a manipulated bypass observation but argued the `consult` side is protected by V2-H1. The NatSpec did not address the **`update()` side**: after a bypass observation, `lastSpot{0,1}[pair]` is set to the (potentially manipulated) spot. Subsequent honest `update()` calls within `DEVIATION_BYPASS_AFTER` (1 day) compare against this manipulated baseline. If real spot drifts >50% from the manipulated value, every honest `update()` reverts `PriceDeviationTooLarge`, **bricking the buffer for up to 1 day** until the next bypass-window opens.

Combined with V2-H1: `consult()` cannot serve manipulated price (good), but `update()` cannot record fresh observations either (bad — the buffer becomes stale-only). After `MAX_STALENESS = 2h`, even non-manipulated `consult()` reads revert `StaleOracle`.

The recovery primitive `executeAdminResetPair` (D-AMM-H3 fix) has a 24h timelock — longer than the 2h staleness window. So between hour 2 and hour 24 post-bypass, the oracle is **completely unavailable** for the affected pair, with no faster recovery.

**Attack / Impact:**
1. Owner key compromised.
2. Attacker triggers natural dormancy on a pair (or waits for it).
3. Attacker pushes reserves to manipulated state via flash-loaned swap or attacker-donation-then-sync-on-attacker-controlled-pair (note: V2-H2 closed sync gating, but attacker can still donate to legitimate pair and call its swap function to integrate the donation into reserves).
4. Attacker (as owner) calls `update(pair)` via the bypass branch — observation admitted, lastSpot poisoned.
5. Attacker reverts the manipulation; real spot returns to "normal" but is now >50% from the manipulated lastSpot.
6. Honest keepers' `update()` reverts for the next 1 day.
7. After 2 hours, `consult()` reverts `StaleOracle`. Lending oracles, Dutch auctions: no oracle for 22+ hours.
8. Owner (legitimate or compromised) calls `proposeAdminResetPair`. 24h later, can execute reset.

The brick window is **22 hours of full oracle unavailability**, with no permissionless or sub-24h recovery primitive.

**Evidence:**
```solidity
// TegridyTWAP.sol:357-365 (bypass branch)
if (msg.sender != owner) revert BypassObservationOwnerOnly();
bypassed = true;
lastBypassUsed[pair] = block.timestamp;
emit DeviationBypassed(pair, elapsed, spotPrice0, spotPrice1);
...
// Lines 364-365 (always run, in BOTH bypass and non-bypass branches):
lastSpot0[pair] = spotPrice0;   // ← manipulated value persists for 1 day
lastSpot1[pair] = spotPrice1;
```

**Recommendation:**
On the bypass branch, do NOT update `lastSpot{0,1}` until a CONFIRMING non-bypass observation lands within MIN_PERIOD * 2 of the bypass. Keep the prior `lastSpot` in place during the rebootstrap window so honest updates can continue to refresh against the pre-bypass baseline:
```solidity
if (uint256(elapsed) <= DEVIATION_BYPASS_AFTER) {
    // ... deviation check ...
    lastSpot0[pair] = spotPrice0;
    lastSpot1[pair] = spotPrice1;
} else {
    // bypass branch: do NOT overwrite lastSpot. Defer to the next non-bypass observation.
    if (msg.sender != owner) revert BypassObservationOwnerOnly();
    bypassed = true;
    lastBypassUsed[pair] = block.timestamp;
    emit DeviationBypassed(pair, elapsed, spotPrice0, spotPrice1);
    // skip the lastSpot writes below
    // ...
}
```
This way an honest keeper can immediately refresh against the pre-bypass baseline (assuming spot is back within deviation tolerance), restoring update() within MIN_PERIOD instead of waiting 1 day.

Alternative: shorten `executeAdminResetPair` timelock to MAX_STALENESS (2h) so reset always recovers before the staleness brick is observable. But shortening admin timelocks has its own governance trade-offs.

---

## [V3-INFO1] Bootstrap path on a zero-reserve pair allows infinite `lastHarvestAt` advancement with no fee materialization
**Severity:** Info
**File:** `contracts/src/TegridyPair.sol:362-388`
**Category:** other

**Bug:**
On a brand-new pair (post-`initialize`, pre-first-`mint`), reserves are 0 and `kLast == 0`. If `feeTo` is set, `harvest()` succeeds via the bootstrap path:
1. `_mintFee(0, 0)` returns `feeOn = true`, `_kLast == 0`, no LP minted.
2. `bootstrap = (true && 0 == 0) = true`.
3. `require` passes. `lastHarvestAt = block.timestamp`. `kLast = 0 * 0 = 0`.
4. **`kLast` is still 0**. Next harvest 5 minutes later succeeds the same way.

Result: every 5 minutes, `harvest()` can be called by anyone on a zero-reserve pair to no-op-bump `lastHarvestAt`. The pair has no fees to materialize, but the call succeeds and emits Sync (well, no — harvest doesn't emit Sync). No actual harm; just wasted gas for any calling griefer and a potentially confusing sequence in off-chain indexers that interpret successful harvest calls as "fees materialized".

**Recommendation:**
Add a `require(totalSupply() > 0, "PAIR_NOT_INITIALIZED")` early in `harvest()` to skip the bootstrap path on uninitialized pairs. Cosmetic.

---

## Cluster-spanning patterns (this pass)

1. **The `owner()` allowlist is not a meaningful protection against owner compromise.** V3-H1 demonstrates this for `sweepETH`. The same anti-pattern would apply if other "owner-or-X" allowlists are added in the codebase. The protection requires `revenueDistributor`-only with a SEPARATE timelocked path for the broken-distributor fallback.

2. **Bootstrap-path fixes need to address symmetric counterparts.** V2-AMM-M2 fixed the feeOn=true bootstrap path but inadvertently broke the feeOn=false cleanup path (V3-M1). When introducing path-dependent bootstrap flags, check ALL state transitions of the gating variable.

3. **Expiry semantics are still under-defined in TimelockAdmin's child contracts.** V3-M2 shows that "proposal expired" doesn't mean "state cleaned up" — `pendingSyncCredit/Snapshot` retain stale values until explicit cancel. A canonical `_isProposalLive(key)` helper that returns `true ⇔ proposal exists AND not expired` would let callers reason about expiry consistently across all child contracts.

4. **Recovery primitives must be FASTER than the staleness window they're protecting against.** V3-L2 shows that `executeAdminResetPair` (24h) is LONGER than `MAX_STALENESS` (2h), so the recovery doesn't actually help the consumer-side staleness brick. Future emergency recovery paths should target sub-2h delays for oracle-class operations, even if it means using a different governance gate (e.g., a separate "oracle guardian" multisig with shorter timelock).

5. **Bypass observations should be observation-class, not state-mutation-class.** V3-L2 (and V2-AMM-L1's NatSpec) both highlight that the bypass observation mutates `lastSpot{0,1}`, which is what makes it a brick primitive. Treating bypass observations as "rebootstrap data points" that don't mutate the deviation gate baseline (only mutate the cumulative buffer) would resolve V3-L2 entirely without any new admin paths.
