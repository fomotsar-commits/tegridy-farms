# Deep AMM Core Audit — Pass 2 (Post-Fix Re-Audit) — 2026-05-01

**Targets:** TegridyPair, TegridyFactory, TegridyFeeHook, TegridyTWAP
**Method:** Re-audit of the post-fix code (commit `1957f20`) for regressions, missed gaps, and side-effects from the 14 fixes claimed against pass-1 findings.
**Baseline:** `.audit_101/DEEP_2026_05_01/01_amm_core.md` (3 High, 5 Medium, 4 Low, 2 Info).

---

## Pass-1 Verification Summary

| Pass-1 ID | Status | Notes |
|---|---|---|
| D-AMM-H1 (TWAP bypass anchor) | **Closed** | `update()` now reverts `BypassObservationOwnerOnly()` on the dormancy-bypass branch. |
| D-AMM-H2 (sync/skim TWAP poison) | **Closed** | `sync()` and `skim()` now gated on `disabledPairs` + `blockedTokens`. |
| D-AMM-H3 (no recovery primitive) | **Closed** | `proposeAdminResetPair` / `executeAdminResetPair` (24h timelock). |
| D-AMM-M1 (claimFees races sync) | **Closed (with new gap — see V2-M1)** | `claimFees` reverts `SYNC_PENDING` while a sync proposal is non-zero. |
| D-AMM-M2 (lastHarvestAt griefing) | **Closed (with regression — see V2-M2)** | `harvest()` reverts `NO_FEE_TO_MATERIALIZE` on zero mint. |
| D-AMM-M3 (claimFees ignores pause) | **Closed** | `claimFees` and `executeSyncAccruedFees` are `whenNotPaused`. |
| D-AMM-M4 (sync exec live-read race) | **Closed** | Snapshot captured at `proposeSyncAccruedFees`, used at execute. |
| D-AMM-M5 (consult on bypass obs) | **Partially closed — see V2-H1** | Only checks `latest.bypassed`, not bypassed observations earlier in the lookup window. |
| D-AMM-L1 / L2 (no-op proposals) | **Closed** | `SAME_VALUE` / `SAME_GUARDIAN` guards added. |
| D-AMM-L3 (TWAP no nonReentrant) | **Closed** | `update()` and `withdrawFees()` are `nonReentrant`. |
| D-AMM-L4 (sweepETH brick) | **Closed (with regression — see V2-M3)** | `sweepETH(address to)` removed M-32's "always to revenueDistributor" protection. |
| D-AMM-INFO1 / INFO2 | **Closed** | NatSpec on hook mask + 30k gas cap on ERC777 staticcalls. |

---

## Severity counts (this pass)

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low | 2 |
| Info | 1 |

---

## [V2-H1] D-AMM-M5 fix is incomplete — `consult()` only checks the LATEST observation, not the lookup-window
**Severity:** High
**File:** `contracts/src/TegridyTWAP.sol:418-425, 572-654`
**Category:** oracle
**Pass-1 ref:** D-AMM-M5

**Bug:**
The fix adds an `OracleRebootstrapping` revert when `observations[pair][latestIdx].bypassed == true`. It does NOT inspect the `bypassed` flag of the OTHER observation that `_getCumulativePricesOverPeriod` selects (the `best` observation that anchors the start of the TWAP window). A consumer requesting `consult(pair, ..., period)` may legitimately have `latest.bypassed == false` (so the new gate passes) but the cumulative anchor at `latest.timestamp - period` lands on a `bypassed == true` observation — the resulting `priceCumEnd - priceCumStart` integrates the bypassed cumulative segment.

Concretely: an owner who is malicious or compromised admits one bypass observation at t0 (with manipulated reserves). Subsequent honest observations at t0 + 15min, +30min, … succeed (deviation gate against the bypass-set `lastSpot`). After ~16 observations the buffer's latest is non-bypassed, but a `consult(pair, ..., period = 4h)` whose `targetTimestamp` lands near t0 anchors against the bypass slot. The TWAP returned reflects 4h of cumulative integration that crosses the manipulated bypass point.

**Attack / Impact:**
1. Owner-trust assumption is now load-bearing for ALL `consult()` reads spanning the bypass window. A captured owner can:
   1. Manipulate reserves (flash loan, donation primitive, etc.).
   2. Call `update()` once via the bypass branch — observation t0 is bypassed.
   3. Restore reserves; let the price drift back within 50% of t0 within 1 day.
   4. Honest keepers fill the rest of the buffer normally (deviation gate passes against the manipulated `lastSpot` baseline because the price is "close" to t0's manipulated value).
   5. Latest observation is non-bypassed → `consult()` returns a TWAP that integrates a manipulated start anchor.
2. Lending protocols and Dutch auctions reading `consult()` over a 1–4h window get a mispriced TWAP for as long as the bypass point sits in the consultable lookup range (up to MAX_OBSERVATIONS * MIN_PERIOD = 12h after the bypass).

**Evidence:**
```solidity
// TegridyTWAP.sol:418-425 — only checks `latest.bypassed`
if (_count > 0) {
    uint8 _latestIdx =
        observationIndex[pair] == 0 ? MAX_OBSERVATIONS - 1 : observationIndex[pair] - 1;
    if (observations[pair][_latestIdx].bypassed) revert OracleRebootstrapping();
}

// TegridyTWAP.sol:605-628 — `_getCumulativePricesOverPeriod` selects `best` from buffer
//   without inspecting `obs.bypassed`. The `best` observation can be a bypassed entry.
for (uint256 i = 1; i < effectiveCount; i++) {
    ...
    Observation memory obs = observations[pair][checkIdx];
    if (obs.timestamp == 0) continue;
    ...
    if (diff < (uint32(1) << 31)) {
        if (diff < bestDiff) {
            bestDiff = diff;
            best = obs;   // <- may have best.bypassed == true
            ...
        }
    }
}
```

**Recommendation:**
Track a per-pair "last bypassed observation timestamp" or scan the lookup result for `best.bypassed`:
```solidity
// In _getCumulativePricesOverPeriod, after selecting `best`:
if (best.bypassed) revert OracleRebootstrapping();
```
Or: refuse to serve `consult()` when `lastBypassUsed[pair] > latest.timestamp - period - <buffer>`. Pattern of record: Aave V3 PriceOracleSentinel uses a "last-disturbance" timestamp, not just the latest observation flag. The pass-1 recommendation already suggested "track a per-pair `bypassedCountInWindow`" — that recommendation was not implemented.

---

## [V2-M1] `claimFees(currency)` permanently locked by un-cancelled / expired sync proposals
**Severity:** Medium
**File:** `contracts/src/TegridyFeeHook.sol:311-320, 398-404`
**Category:** dos
**Pass-1 ref:** D-AMM-M1 (new gap introduced by the fix)

**Bug:**
The D-AMM-M1 fix gates `claimFees` on `_proposalReadyAt(syncKey) == 0`. The TimelockAdmin slot `_executeAfter[key]` is only cleared by `_execute(key)` or `_cancel(key)`. Both require `onlyOwner`. If the owner proposes a sync and then:
- Forgets to execute or cancel → after `SYNC_DELAY + PROPOSAL_VALIDITY = 24h + 7d = 8d`, the proposal is **expired**, but `_executeAfter[key]` is still non-zero. `claimFees(currency)` continues to revert `SYNC_PENDING` indefinitely.
- Becomes unavailable (multisig signer lockout) → no permissionless cancellation path.
- Is captured / malicious → can perpetually re-propose immediately after each cancel, indefinitely locking `claimFees(currency)` (the 7-day `SYNC_COOLDOWN` only applies to `executeSyncAccruedFees`, not to propose/cancel cycles).

**Attack / Impact:**
1. Honest-loss flavor: owner forgets a proposal → `claimFees(USDC)` is bricked until owner notices and cancels. RevenueDistributor receives no USDC fees during the window — could be unbounded.
2. Captured-owner flavor: attacker cycles `proposeSyncAccruedFees(currency, 1) → cancelSyncAccruedFees(currency)` every block. Cost: ~50k gas per cycle (cheap on L2). `claimFees(USDC)` never executes; `accruedFees[USDC]` grows unboundedly inside the hook; the hook eventually hits drift correction inability per the propose-time snapshot bound (which is also stale).
3. Combined with the `whenNotPaused` gate (also added in the fix): an attacker who pauses + maintains a perpetual sync proposal locks both ingest AND drain. Recovery requires owner to unpause AND cancel the sync.

**Evidence:**
```solidity
// TegridyFeeHook.sol:311-313
function claimFees(address currency, uint256 amount) external nonReentrant whenNotPaused {
    bytes32 syncKey = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
    require(_proposalReadyAt(syncKey) == 0, "SYNC_PENDING");
    ...

// base/TimelockAdmin.sol:131-138 — `_execute` clears _executeAfter
// base/TimelockAdmin.sol:143-147 — `_cancel` clears _executeAfter
// `_executeAfter[key]` remains non-zero after a proposal expires until owner intervenes.
```

**Recommendation:**
Use a "ready and not-expired" check, not a "non-zero" check:
```solidity
uint256 readyAt = _proposalReadyAt(syncKey);
require(
    readyAt == 0 ||
    block.timestamp > readyAt + _proposalValidity(),  // expired = treat as cancelled
    "SYNC_PENDING"
);
```
Or expose a permissionless `cancelExpiredSync(currency)` that anyone can call once the proposal has expired. Pattern: Compound Timelock allows anyone to cancel an expired proposal.

---

## [V2-M2] `harvest()` regression — `NO_FEE_TO_MATERIALIZE` blocks bootstrap of `kLast` after first feeTo enable
**Severity:** Medium
**File:** `contracts/src/TegridyPair.sol:340-358`
**Category:** dos
**Pass-1 ref:** D-AMM-M2 (regression)

**Bug:**
Pre-fix `harvest()` set `kLast = uint256(_reserve0) * uint256(_reserve1)` AFTER `_mintFee`, regardless of whether `_mintFee` minted any LP. This was the **bootstrap-via-harvest path** for `kLast` after `feeTo` was enabled (when `_mintFee`'s inner `if (_kLast != 0)` branch is false on the first call, so no LP is minted, but `kLast` was still set on return).

Post-fix `harvest()` adds `require(totalSupply() > supplyBefore, "NO_FEE_TO_MATERIALIZE")` BEFORE the `kLast` write. On the first call after `feeTo` is enabled (and `kLast == 0`), `_mintFee` mints zero (because of the inner `_kLast != 0` guard), `totalSupply()` is unchanged, and harvest reverts. **`kLast` is never bootstrapped via harvest.**

**Attack / Impact:**
After enabling `feeTo` on a previously fee-disabled pair (`feeTo` was zero or `kLast` was reset to 0), the protocol cannot use `harvest()` to start collecting fees. The protocol must wait for an organic `mint()` or `burn()` to bootstrap `kLast` (lines 169 and similar). On a low-churn pair with heavy swap volume, that bootstrap can be delayed indefinitely — the harvest keeper sees recurring `NO_FEE_TO_MATERIALIZE` reverts and may interpret this as "no fees to harvest" while real K-growth is silently being captured by LPs (not the protocol).

This is a **pure regression** of the M-AMM1 / 001 H-3 reasoning — the pre-fix code's "silent state mutation" was actually load-bearing for the bootstrap.

**Evidence:**
```solidity
// TegridyPair.sol:340-358 (post-fix)
function harvest() external nonReentrant {
    require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
    (uint112 _reserve0, uint112 _reserve1,) = getReserves();
    uint256 supplyBefore = totalSupply();
    bool feeOn = _mintFee(_reserve0, _reserve1);
    require(totalSupply() > supplyBefore, "NO_FEE_TO_MATERIALIZE");  // <-- reverts on bootstrap
    lastHarvestAt = block.timestamp;
    if (feeOn) {
        kLast = uint256(_reserve0) * uint256(_reserve1);   // <-- never reached on bootstrap
    }
}

// _mintFee (line 411-429) — when _kLast == 0, mints nothing.
```

**Recommendation:**
Allow the bootstrap path to set `kLast` even when no LP was minted, OR keep the strict revert but expose a separate `bootstrapKLast()` helper:
```solidity
function harvest() external nonReentrant {
    require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
    (uint112 _reserve0, uint112 _reserve1,) = getReserves();
    uint256 supplyBefore = totalSupply();
    bool feeOn = _mintFee(_reserve0, _reserve1);
    bool bootstrap = (feeOn && kLast == 0);
    require(totalSupply() > supplyBefore || bootstrap, "NO_FEE_TO_MATERIALIZE");
    lastHarvestAt = block.timestamp;
    if (feeOn) {
        kLast = uint256(_reserve0) * uint256(_reserve1);
    }
}
```
Pattern: Curve `claim_admin_fees()` differentiates "no fees yet" from "no admin set" and only reverts on the latter.

---

## [V2-M3] `sweepETH(address to)` regresses M-32's "always to revenueDistributor" protection
**Severity:** Medium
**File:** `contracts/src/TegridyFeeHook.sol:493-507`
**Category:** gov
**Pass-1 ref:** D-AMM-L4 (regression — fix overcorrected the recommendation)

**Bug:**
The original `sweepETH()` (M-32) hardcoded the recipient to `revenueDistributor` with the explicit comment: *"Always sends to revenueDistributor to prevent misuse by a compromised owner."* The pass-1 D-AMM-L4 recommendation was conservative: fall back to `owner` only if `revenueDistributor` reverts, OR add a two-step recovery. The shipped fix replaces the hardcoded recipient with an arbitrary owner-specified `to` address, which **erases M-32's protection entirely**.

A captured owner can now drain all ETH balance directly to themselves via `sweepETH(attackerAddress)`. The 48h `proposeDistributorChange` timelock no longer applies — this is an instant drain primitive.

**Attack / Impact:**
1. Owner key is compromised. ETH balance accumulated via the `receive()` payable function is drained instantly to the attacker.
2. The `revenueDistributor` rotation timelock (48h) was the design's intended protection — it still exists for token distributions but is now bypassable for the ETH balance.

**Evidence:**
```solidity
// TegridyFeeHook.sol:493-507 (post-fix)
/// @notice M-32: Recover accidentally sent ETH. Always sends to revenueDistributor
///         to prevent misuse by a compromised owner.            // <-- comment is now LIES
/// @dev    AUDIT FIX D-AMM-L4: accept an owner-specified recipient parameter ...
function sweepETH(address to) external onlyOwner {
    require(to != address(0), "ZERO_ADDR");
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_ETH");
    (bool success,) = payable(to).call{value: balance}("");   // <-- instant drain to ANY owner-specified address
    if (!success) revert SweepFailed();
    emit ETHSwept(to, balance);
}
```

**Recommendation:**
Revert to the original M-32 design with a fall-back path:
```solidity
function sweepETH() external onlyOwner {
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_ETH");
    (bool success,) = payable(revenueDistributor).call{value: balance}("");
    if (!success) {
        // Fallback only if revenueDistributor is broken
        (success,) = payable(owner()).call{value: balance}("");
        if (!success) revert SweepFailed();
        emit ETHSwept(owner(), balance);
        return;
    }
    emit ETHSwept(revenueDistributor, balance);
}
```
Or timelock the `to` parameter via `TimelockAdmin._propose / _execute` so a captured owner cannot instant-drain. Pattern: OpenZeppelin Address.sendValue with fall-back-only on first-call failure.

---

## [V2-M4] M-AMM1 still NOT fixed — `harvest()` continues to lack `disabledPairs` / `blockedTokens` gates
**Severity:** Medium
**File:** `contracts/src/TegridyPair.sol:340-358`
**Category:** sibling-miss
**Pass-1 ref:** D-AMM-H2 (related — confirms persistent miss)

**Bug:**
The microscope's M-AMM1 explicitly required adding `disabledPairs` + `blockedTokens` gates to `harvest()`. The remediation report (`MICROSCOPE_REMEDIATION_2026_05_01.md` line 81) claims this was applied: *"M-AMM1 | TegridyPair.harvest | Gates on `disabledPairs` + `blockedTokens` — same as mint/swap"*. The actual current source (line 340-358) **does NOT contain those gates**.

The pass-1 D-AMM-H2 fix correctly added the gates to `sync()` and `skim()`. Pre-existing `mint()` (line 130-131), `burn()` (intentionally ungated for LP exit), `swap()` (line 213) all have them. Only `harvest()` is missing.

**Attack / Impact:**
Original 001 H-3 attack still applies: once a pair is `disabledPairs[pair] == true`, anyone can call `harvest()` to mint LP to `feeTo` based on prior K-growth. If `feeTo` is a contract that auto-stakes/sells, it interacts with the disabled pair via LP redemption — bypassing the disable. Worse: post-D-AMM-H2 fix, `sync()` is now gated, so the only way an attacker can "wake" the pair is via harvest — and harvest will run `_mintFee` against pre-disable kLast and post-donation reserves, materializing protocol fees for K-growth that was attacker-donated.

This is structurally a **persistent regression** — claimed-fixed but not actually fixed.

**Evidence:**
```solidity
// TegridyPair.sol:340-358 — disabledPairs / blockedTokens gates ABSENT
function harvest() external nonReentrant {
    require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
    // ... no disabledPairs check, no blockedTokens check ...
}

// vs. TegridyPair.sol:289-291 (skim, post-D-AMM-H2 fix):
function skim(address to) external nonReentrant {
    require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
    require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
    ...
}
```

**Recommendation:**
Add the gates to `harvest()` (matches `sync` / `skim`):
```solidity
function harvest() external nonReentrant {
    require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
    require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
    require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
    ...
}
```

---

## [V2-L1] Owner can poison TWAP cumulative via repeated bypass observations
**Severity:** Low
**File:** `contracts/src/TegridyTWAP.sol:330-345`
**Category:** oracle (owner-trust)
**Pass-1 ref:** D-AMM-H1 (residual surface after the owner-only gate)

**Bug:**
The D-AMM-H1 fix correctly closes the permissionless dormancy-bypass-poisoning attack by gating the bypass branch behind `onlyOwner`. However, the bypass branch still:
- Writes `lastSpot{0,1}[pair]` to the (potentially manipulated) current spot.
- Records an Observation with the bridged-cumulative reflecting current (potentially manipulated) reserves.

A compromised owner who can wait `DEVIATION_BYPASS_AFTER` (1 day) of dormancy can use the bypass branch as a **legitimate primitive for poisoning the cumulative**, which the D-AMM-M5 fix only partially mitigates (see V2-H1 above). Combined with V2-H1, a captured owner can manipulate the TWAP for any consultable period that crosses the bypass point.

**Attack / Impact:**
1. Owner key compromised.
2. Attacker waits for natural dormancy on a pair (or induces it via guardian-emergency disable + 1d wait + re-enable).
3. Attacker pushes reserves to a manipulated state via flash loan or donation.
4. Attacker (as owner) calls `update(pair)` — bypass branch admits the manipulated cumulative.
5. Combined with V2-H1: subsequent honest observations fill the buffer; `consult()` returns a TWAP that integrates the manipulated bypass anchor, until the bypass point falls out of MAX_OBSERVATIONS * MIN_PERIOD = 12h.

**Recommendation:**
The bypass branch should require a **second confirming observation** before promoting `lastSpot{0,1}` and writing the cumulative. Curve's oracle uses two consecutive in-tolerance reads. Or: make the bypass observation purely "rebootstrap-only" — record the timestamp but defer cumulative writes to the next non-bypass observation. Even with V2-H1 fixed, this trust-minimization is worth adding because owner-trust assumptions on oracles are load-bearing for downstream lending / Dutch auction consumers.

---

## [V2-L2] `harvest()` precision check `totalSupply() > supplyBefore` ignores liquidity from `_mint(MINIMUM_LIQUIDITY)` rounding
**Severity:** Low
**File:** `contracts/src/TegridyPair.sol:351-353`
**Category:** other

**Bug:**
The precision check `require(totalSupply() > supplyBefore, "NO_FEE_TO_MATERIALIZE")` is the right pattern in principle, but `_mintFee`'s only `_mint` call has the inner guard `if (liquidity > 0) _mint(feeTo, liquidity)`. So `liquidity` rounded to 0 → no mint → revert. That's the intended D-AMM-M2 behavior.

The subtle issue: `_mintFee`'s LP calculation `liquidity = numerator / denominator` truncates to 0 when `numerator < denominator`. For a low-volume pair with small `rootK - rootKLast`, the per-call mint is 0 even when *real* fee growth has accumulated. The protocol is then permanently locked out of those small fee accruals — they remain in the LP supply ratio rather than ever materializing.

This is a precision-loss → silent-fee-loss issue compounded by the strict revert. Severity is bounded: the fee growth must be smaller than `denominator / totalSupply`, which on a typical pair is sub-wei and below the dust line anyway. But across many pairs and many calls, it accumulates.

**Recommendation:**
Optional: track `cumulativeRoundedDownLiquidity` and mint when it crosses 1 wei. Or accept this as expected precision loss (matches Uniswap V2 behavior). Documentation-only fix is acceptable.

---

## [V2-INFO1] D-AMM-M5 check is dead-code for `count == 1`
**Severity:** Info
**File:** `contracts/src/TegridyTWAP.sol:418-425`
**Category:** other

**Bug:**
The `consult` D-AMM-M5 guard runs when `_count > 0`, but `_getCumulativePricesOverPeriod` requires `count >= 2` (line 578: `if (count < 2) revert InsufficientObservations()`). When `count == 1`, the M5 check could revert `OracleRebootstrapping` first, but in practice `count == 1` only happens after a pair-reset or a single update, and the subsequent `_getCumulativePricesOverPeriod` would revert `InsufficientObservations` anyway. Net effect: ~150 gas wasted on the latestIdx computation when count == 1.

**Recommendation:**
Tighten the guard to `if (_count >= 2)` to match the downstream check, OR remove the guard and call `_getCumulativePricesOverPeriod` first then check the returned `latest.bypassed`. Cosmetic.

---

## Cluster-spanning patterns (this pass)

1. **Fix scope mismatch with recommendation.** Pass-1 D-AMM-L4 explicitly recommended a *fall-back* pattern with `revenueDistributor` as primary; the implemented fix replaced the hardcoded recipient with an arbitrary owner-specified address (V2-M3). Pass-1 D-AMM-M5 explicitly recommended tracking `bypassedCountInWindow` or scanning the full window; the implemented fix only checks `latest.bypassed` (V2-H1). Two of the most security-load-bearing pass-1 recommendations were partially implemented in ways that left exploitable surface.

2. **`_executeAfter[key] != 0` is the wrong gate primitive.** V2-M1 demonstrates that gating on "non-zero proposal slot" rather than "ready-and-not-expired" creates indefinite DoS surface. The D-AMM-M1 / D-AMM-M3 fixes both use this pattern. A `_isPendingAndValid(key)` helper in TimelockAdmin would close this class of issue across all child contracts.

3. **Persistent miss: M-AMM1's harvest gate is still not landed.** V2-M4 confirms the microscope's M-AMM1 finding — harvest needs disabledPairs / blockedTokens gates — was claimed fixed in the remediation report but the gates are NOT in the current source. The pass-1 D-AMM-H2 fix correctly added them to sync/skim but skipped the originally-flagged harvest. Recommend a pre-merge grep for every `disabledPairs[address(this)]` callsite to confirm parity across all state-mutating functions.

4. **Bootstrap-via-side-effect patterns silently break under "explicit revert" hardening.** V2-M2 shows that `harvest()`'s pre-fix silent state mutation (setting `kLast` even on zero-mint) was load-bearing for the post-feeTo-enable bootstrap. Hardening should preserve that path or expose an explicit replacement.

5. **Owner-trust assumptions accumulate.** D-AMM-H1's owner-only bypass gate, D-AMM-L4's owner-specified sweep recipient, and V2-L1's bypass cumulative poisoning all converge on a single point: the TWAP and FeeHook owners now have significantly more attack surface than pre-fix. None of these owners are timelocked beyond the existing per-operation timelocks. Consider moving the TWAP and FeeHook owners to a multisig-controlled timelock as a Wave 0 hardening item.
