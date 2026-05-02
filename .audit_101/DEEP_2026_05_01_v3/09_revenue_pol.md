# DEEP Audit Pass 3 — Revenue / POL / Premium / Referral Stack
**Date:** 2026-05-02
**Scope:** RevenueDistributor (1357 LOC) · POLAccumulator (845 LOC) · PremiumAccess (625 LOC) · ReferralSplitter (720 LOC)
**Method:** Re-audit post-`71d25f3` fixes (10 from pass 2 — DR2-M-01 through M-05, L-01 through L-05). Verified all hot-spots; hunt for cross-feature interactions, lifecycle gaps, and accounting drifts the v2 closures introduced.
**Baseline:** All pass-2 fixes verified landed; only NEW findings reported.

---

## Executive summary

The `71d25f3` batch closes every Medium and Low from pass 2. Verification of the v2 hot-spots:

- **DR2-M-01 (`_pendingETH` claimedAtEpoch skip)** — VERIFIED. Line 1323 `if (claimedAtEpoch[user][i]) continue;` mirrors the write-path skip at line 711. Both `pendingETH` and `pendingETHPaginated` route through `_pendingETH`, so the fix covers all view callers. Phantom-ETH-after-recovery is closed.
- **DR2-M-02 (cursor advance on totalOwed == 0)** — VERIFIED. Lines 575-580 (`claim`) and 647-652 (`claimUpTo`) advance `lastClaimedEpoch[user]` to `actualEndEpoch` whenever `actualEndEpoch > startEpoch`, then revert `NothingToClaim`. The grace-period edge case (`actualEndEpoch == startEpoch` from first-iteration break at line 700-703) correctly leaves the cursor parked, since the user has no further claimable epochs anyway.
- **DR2-M-03 (`bannedReferrers` semantics)** — VERIFIED at the `recordFee` and `claimReferralRewards` entry points (lines 371-373, 422). New earnings route to `accumulatedTreasuryETH`; pre-ban balance can no longer be claimed. **But see DR3-M-01 below — the pre-ban `pendingETH[banned]` balance is now permanently locked because `forfeitUnclaimedRewards` was NOT taught to bypass its stake/inactivity gates for banned referrers, AND the balance is reserved against `sweepUnclaimable` via `totalPendingETH`.**
- **DR2-M-04 (`reclaimEligibleAmount` skips pending-recovery)** — VERIFIED at line 942 `if (pendingRecoveryCount[i] > 0) continue;` in both propose-time and execute-time eligible computation. **But see DR3-H-01 below — the inverse race (forfeit-reclaim executes BEFORE recovery is proposed) is NOT closed; sequencing forfeit→sweepDust→propose-recovery still allows owner-side DoS of legitimate recoveries because `executeForfeitReclaim` only decrements `totalEarmarked` rather than per-epoch `epochClaimed`.**
- **DR2-M-05 (timelocked-only path post-`completeSetup`)** — VERIFIED at line 468 `if (setupComplete) revert SetupAlreadyComplete();`. The 24h-timelocked `proposeApprovedCaller` path remains the only post-setup grant route. The pass-2 NatSpec correctly documents the operational lifecycle for router migrations.

The pass surfaces **6 NEW findings** clustered around three patterns:

1. **Cross-feature ordering hazards** — when two state-mutating subsystems share a fungible resource (ETH backing per-epoch dust, `totalRevenue` accounting), a fix in one path can be undermined by the SEQUENCE of operations in the other. DR3-H-01 (forfeit→sweep→recovery DoS) and DR3-M-02 (V2-DR-L-03 double-decrement) are both this pattern.
2. **Lifecycle dangling state** — the v2 fixes added new state (`pendingRecoveryCount`, `bannedReferrers`, `shortfallOwed`) without complete cleanup paths for every transition. DR3-M-01 (banned referrer pendingETH lock-in) and DR3-M-03 (expired recovery proposal blocks autoReconcileDust + reclaimEligibleAmount forever) are both this pattern.
3. **View-path divergence** — the v2 view-path skip in `_pendingETH` closed phantom ETH from completed recoveries, but other view-path divergences remain. DR3-L-01 (view doesn't account for `pendingRecoveryCount` reservations) and DR3-L-02 (view doesn't check `_isStakingPaused()` parity with claim path) follow this pattern.

Total: **1 High · 3 Medium · 2 Low** — 6 findings.

---

## [DR3-H-01] `executeForfeitReclaim` does NOT mark per-epoch dust consumed — sweep-then-recovery race bricks legitimate recovery payouts
**Severity:** High
**File:** `contracts/src/RevenueDistributor.sol:835-846, 967-990, 1214-1280`
**Category:** revenue · gov

**Bug:** The pass-2 DR2-M-04 fix correctly excluded epochs with `pendingRecoveryCount[i] > 0` from `reclaimEligibleAmount()`, closing the case where a recovery is proposed BEFORE forfeit-reclaim. The INVERSE ordering — forfeit-reclaim executes BEFORE the recovery is proposed — was NOT addressed. `executeForfeitReclaim` is line-947-onwards bookkeeping ONLY: it decrements `totalEarmarked`, bumps `totalForfeited` and `totalForfeitedReclaimed`, and emits an event. It does NOT touch per-epoch `epochClaimed[i]`. The actual ETH backing per-epoch dust is fungible with the rest of the contract balance.

After `executeForfeitReclaim` reduces `totalEarmarked` by `amount`, the next `sweepDust()` sees a larger `dust = balance - (totalEarmarked - totalClaimed) - totalPendingWithdrawals` and ships the freed ETH to treasury. The per-epoch `epochClaimed[i]` is unchanged, so a NEW `proposeClaimRecovery(user, X, power)` (where epoch X had unclaimed dust) will succeed — its propose-time guards (`claimedAtEpoch[user][X] == false`, `epoch >= lastReconciledEpoch`, `power <= 25%`) all pass. After 48h, `executeClaimRecovery(user, X)` computes `share = (epoch.totalETH * power) / epoch.totalLocked`, capped by `epoch.totalETH - epochClaimed[X]` — math returns a non-zero share. The contract then attempts `user.call{value: share, gas: 10000}("")`. **The actual ETH was swept**: `address(this).balance < share`. The call fails (out-of-funds), share lands in `pendingWithdrawals[user]`. Subsequent `withdrawPending()` invokes `WETHFallbackLib.safeTransferETHOrWrap` which tries `.call{value}` → falls back to WETH wrap (`IWETH(weth).deposit{value: amount}`) → also reverts insufficient. **The user's recovery is permanently un-payable until ETH is replenished into the contract.**

This is a real DoS vector against legitimate corruption-recoveries, and it is owner-permissioned (the owner who sequences forfeit→sweep→propose-recovery is themselves the captured key in the standard threat model). A multisig that legitimately runs forfeit-reclaim sweeps in operations cycles is unaware that it has stranded any future recovery proposal whose epoch happened to overlap the `eligible` pool at execute time.

**Attack / Impact:** Owner-key compromise: attacker who briefly holds the owner key sequences `proposeForfeitReclaim → executeForfeitReclaim → sweepDust → proposeClaimRecovery(victim, X, power)`. After 48h the recovery is unpayable. Combined with the pass-2 DR-DR-H-01 pause-gating (recoveries respect pause), the user is locked out of even the WETH-fallback path. Off-chain remediation requires multisig-level treasury return.

Operational risk (no compromise): A multisig running the standard sweep cycle without coordinating with the recovery queue can strand a future legitimate recovery. The 48h timelock window for new recoveries makes this likely whenever ops cadence < 48h.

**Evidence:**
```solidity
// RevenueDistributor.sol:967-990 — only bookkeeping, no per-epoch markings
function executeForfeitReclaim() external onlyOwner whenNotPaused {
    _execute(FORFEIT_RECLAIM);
    uint256 amount = pendingForfeitAmount;
    // ... clamping ...
    totalEarmarked -= amount;
    totalForfeited += amount;
    totalForfeitedReclaimed += amount;
    pendingForfeitAmount = 0;
    emit ForfeitReclaimed(amount);
    // MISSING: per-epoch markdown of epochClaimed[i] = epoch.totalETH for the
    // epochs whose dust was just released. Without this, the released ETH is
    // sweep-vulnerable but per-epoch dust math still claims it's available.
}

// RevenueDistributor.sol:835-846 — sweep uses only totalEarmarked, not per-epoch state
function sweepDust() external onlyOwner nonReentrant whenNotPaused {
    uint256 unclaimed = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
    uint256 reserved = unclaimed + totalPendingWithdrawals;
    uint256 balance = address(this).balance;
    uint256 dust = balance > reserved ? balance - reserved : 0;
    // ...
    (bool success,) = treasury.call{value: dust}("");
    // ...
}
```

**Recommendation:** Iterate the eligible pool per-epoch inside `executeForfeitReclaim` and mark `epochClaimed[i] = epoch.totalETH` for each epoch whose dust was claimed by the forfeit. Once an epoch's dust is forfeit-claimed, subsequent `proposeClaimRecovery` for that same epoch must revert (e.g., add a `epochForfeited[uint256]` flag, or simply check `epochClaimed[epoch] == epoch.totalETH` in `proposeClaimRecovery`).

A simpler patch that preserves the bookkeeping pattern: in `proposeClaimRecovery`, re-check that the epoch's `share = epoch.totalETH - epochClaimed[epoch]` is at least the would-be recovery share AND that the contract balance is sufficient. This shifts the failure to propose-time (where it's at least visible) rather than execute-time (where it's a silent DoS).

Best fix: per-epoch `epochClaimed[i] = epoch.totalETH` in the executeForfeitReclaim path, OR a per-epoch `epochForfeited[uint256]` flag set during the iteration. The propose-time check then becomes `if (epochForfeited[epoch]) revert EpochAlreadyForfeited();`.

---

## [DR3-M-01] Banned referrer's pre-ban `pendingETH` is permanently locked — `forfeitUnclaimedRewards` predicates were not taught the ban-state shortcut
**Severity:** Medium
**File:** `contracts/src/ReferralSplitter.sol:602-629, 692-706`
**Category:** referral · gov

**Bug:** The pass-2 DR2-M-03 fix correctly stopped a banned referrer from earning new `pendingETH` (route to `accumulatedTreasuryETH` at line 371-373) and from claiming pre-ban balance (revert at line 422). But it did NOT teach `forfeitUnclaimedRewards` to bypass the original stake/inactivity predicates for banned referrers. The function still requires:

```solidity
referrerPower < MIN_REFERRAL_STAKE_POWER
&& lastBelowStakeTime[_referrer] != 0
&& block.timestamp >= lastBelowStakeTime[_referrer] + BELOW_STAKE_GRACE_PERIOD  // 7 days
&& block.timestamp >= lastClaimTime[_referrer] + FORFEITURE_PERIOD              // 90 days
```

A banned referrer with stake above MIN can NEVER satisfy these predicates (the first check, `referrerPower >= MIN_REFERRAL_STAKE_POWER`, is enough). Their `pendingETH[banned]` balance stays in `totalPendingETH` indefinitely. Worse, `sweepUnclaimable` at line 692-706 reserves `totalPendingETH + accumulatedTreasuryETH + totalCallerCredit` against the contract balance — so the corresponding ETH backing the locked pendingETH is also un-sweepable.

The 24h-timelocked ban ceremony combined with the pass-2 "ban = lifecycle-end" semantic implies that admin can permanently retire a referrer; in practice the implementation only PARTIALLY retires them. The locked balance is an attack surface (an unbanned-then-claimed referrer suddenly drains old earnings) AND an accounting drift surface (off-chain dashboards see `totalPendingETH` rising indefinitely with no off-ramp).

**Attack / Impact:** Operational fund-lock. An owner who bans a stake-qualified referrer believes they have terminated that referrer's earning + claiming. In fact:
1. New earnings route to treasury (correct, V2 fix).
2. Old earnings are PERMANENTLY trapped in `pendingETH[banned]` (incorrect — the ban implies confiscation but the code only blocks claim).
3. `sweepUnclaimable` cannot sweep the corresponding ETH because `totalPendingETH` reserves it.
4. Only `unbanReferrer` can release the lock — but unbanning re-enables the referrer to claim, defeating the ban's purpose.

The intended owner workflow is now under-specified: there is no on-chain path to confiscate-then-keep-banned. The owner must either accept the permanent ETH-lock OR unban-then-claim-on-behalf (impossible — claim is `msg.sender` only).

**Evidence:**
```solidity
// ReferralSplitter.sol:602-629 — gates unchanged from pre-ban era
function forfeitUnclaimedRewards(address _referrer) external onlyOwner nonReentrant {
    require(setupComplete, "SETUP_NOT_COMPLETE");
    uint256 amount = pendingETH[_referrer];
    if (amount == 0) revert NothingToClaim();
    uint256 referrerPower; /* ... try/catch ... */
    if (
        referrerPower >= MIN_REFERRAL_STAKE_POWER ||
        lastBelowStakeTime[_referrer] == 0 ||
        block.timestamp < lastBelowStakeTime[_referrer] + BELOW_STAKE_GRACE_PERIOD ||
        block.timestamp < lastClaimTime[_referrer] + FORFEITURE_PERIOD
    ) revert ForfeitureConditionsNotMet();
    // MISSING: if (bannedReferrers[_referrer]) bypass the gates above.
    // ...
}
```

**Recommendation:** Allow `forfeitUnclaimedRewards` to bypass the stake/inactivity predicates for banned referrers:

```solidity
function forfeitUnclaimedRewards(address _referrer) external onlyOwner nonReentrant {
    require(setupComplete, "SETUP_NOT_COMPLETE");
    uint256 amount = pendingETH[_referrer];
    if (amount == 0) revert NothingToClaim();

    // V3 FIX: Banned referrers bypass the stake/inactivity gates — the 24h
    // timelocked ban already provided community review window, no further wait
    // is needed to confiscate.
    if (!bannedReferrers[_referrer]) {
        uint256 referrerPower; /* ... try/catch ... */
        if (
            referrerPower >= MIN_REFERRAL_STAKE_POWER ||
            lastBelowStakeTime[_referrer] == 0 ||
            block.timestamp < lastBelowStakeTime[_referrer] + BELOW_STAKE_GRACE_PERIOD ||
            block.timestamp < lastClaimTime[_referrer] + FORFEITURE_PERIOD
        ) revert ForfeitureConditionsNotMet();
    }

    pendingETH[_referrer] = 0;
    totalPendingETH -= amount;
    accumulatedTreasuryETH += amount;
    emit RewardsForfeited(_referrer, amount);
}
```

This completes the ban lifecycle: ban → forfeit-on-banned → sweep to treasury via existing `withdrawTreasuryFees` path.

---

## [DR3-M-02] V2-DR-L-03 fix double-decrements `totalRevenue` on shortfall path — accounting drift in the OPPOSITE direction
**Severity:** Medium
**File:** `contracts/src/PremiumAccess.sol:411-433, 500-528`
**Category:** premium · accounting

**Bug:** The V2-DR-L-03 fix tried to close the high-water-mark drift in `totalRevenue` by decrementing the FULL pre-cap refundable amount in `cancelSubscription` (line 423-431) AND ALSO decrementing `payout` in `claimShortfall` (line 521-525). The two decrements are NOT mutually exclusive — both fire on the SAME shortfall lifecycle:

1. **At cancel** (escrowed=10, contractBalance=3, refundAmount=10→3, shortfall=7): `fullRefundable = 10`. `totalRevenue -= 10` (or capped to 0).
2. **At claimShortfall** (later, when balance is restored, payout=7): `totalRevenue -= 7`.

**Total decrement: 17 for a user who paid `cost = 10` originally.** The original `subscribe()` increment (`totalRevenue += cost = 10`) is now over-shadowed by the cancel + claim decrement of 17. After many cycles, `totalRevenue` drifts NEGATIVE — clamped to 0 by the underflow guard, but conceptually an under-count vs the previous high-water-mark drift it was meant to fix.

The intent of V2-DR-L-03 was: "the contract is committed to honor the shortfall, so debit it at cancel time." That's correct IF and ONLY IF claimShortfall does NOT also decrement (it should see the debit as already applied). The current code does both.

**Attack / Impact:** Pure accounting drift. `withdrawToTreasury` does NOT consult `totalRevenue` (uses `balance - totalRefundEscrow - totalShortfallOwed`) so fund-safety is preserved. But off-chain dashboards reading `totalRevenue` for revenue projections / KPIs report inflated drawdowns. After enough shortfall cycles, `totalRevenue == 0` while actual revenue is still substantial — making dashboards report zero growth.

The scope is bounded by the volume of shortfall events (which require contract-balance-insolvency, ordinarily rare), but the fix path was specifically designed to handle that flow, so the drift accumulates exactly when shortfall flows are common.

**Evidence:**
```solidity
// PremiumAccess.sol:423-431 — cancel decrements by fullRefundable (pre-cap)
uint256 fullRefundable = totalDuration == 0 ? escrowed : (escrowed * remainingTime) / totalDuration;
if (fullRefundable > escrowed) fullRefundable = escrowed;
if (fullRefundable <= totalRevenue) {
    totalRevenue -= fullRefundable;     // ← debits 10
} else {
    totalRevenue = 0;
}

// PremiumAccess.sol:521-525 — claimShortfall ALSO decrements by payout
if (payout <= totalRevenue) {
    totalRevenue -= payout;             // ← debits 7 MORE for same user
} else {
    totalRevenue = 0;
}
```

**Recommendation:** Pick ONE decrement point and remove the other.

**Option A (recommended)** — debit at cancel by FULL refundable, do NOT decrement in claimShortfall:
```solidity
// Remove the totalRevenue decrement from claimShortfall (lines 511-525).
// The full pre-cap refund was already debited at cancel.
```

**Option B** — debit at cancel by IMMEDIATE refundAmount only, decrement at claimShortfall by payout (this is the pre-V2 behavior — the original bug DR2-L-03 was that claimShortfall DIDN'T decrement, so the V2 fix added BOTH decrements rather than just the missing one):
```solidity
// In cancelSubscription (line 423-431), revert to pre-V2 behavior:
if (refundAmount <= totalRevenue) {
    totalRevenue -= refundAmount;
}
// Keep the V2 decrement in claimShortfall — it's the second leg of the same payment.
```

Option A is cleaner conceptually (the contract's commitment is recognized at cancel time, regardless of when the user pulls funds). Option B is more balance-aligned (decrement happens when funds actually leave the contract).

---

## [DR3-M-03] Expired claim-recovery proposals dangle `pendingRecoveryCount[epoch] > 0` forever — bricks `autoReconcileDust` AND `reclaimEligibleAmount` for that epoch
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:1196-1204, 1214-1280, 1072-1118`
**Category:** revenue · gov

**Bug:** `pendingRecoveryCount[epoch]` is incremented in `proposeClaimRecovery` (line 1184) when the slot was empty, and decremented in TWO paths:
- `cancelClaimRecovery` (line 1202)
- `executeClaimRecovery` (line 1263)

`executeClaimRecovery` reverts `RecoveryExpired()` when `block.timestamp > p.executeAfter + PROPOSAL_VALIDITY` (line 1226). After expiry, the proposal is unexecutable. **No path decrements `pendingRecoveryCount[epoch]` on expiry.** The owner must manually call `cancelClaimRecovery(user, epoch)` to clean up. If the owner is unaware of the expired proposal (e.g., admin rotation, indexer gap), `pendingRecoveryCount[epoch]` stays > 0 forever.

Consequences:
1. **`autoReconcileDust`** (line 1094-1097) HALTs at the first epoch with `pendingRecoveryCount > 0`. The cursor never advances past the expired-recovery epoch. The dust on every subsequent epoch is permanently un-reconcilable via this path.
2. **`reclaimEligibleAmount`** (line 942) skips the same epoch. The dust on it is permanently outside the forfeit-reclaim eligible pool.
3. Since `autoReconcileDust` is permissionless and was supposed to be the "anyone can keep the protocol moving" path, an expired-recovery slot effectively bricks the dust-recovery flywheel until the owner manually cancels.

The existing pass-1 DR-H-02 / R014 H-5 design assumed every recovery would either execute or cancel within the 48h+7d window. Expiration was treated as a benign "the proposal becomes ineffective" outcome. The `pendingRecoveryCount` sibling-state was added later (REV-H-02) and inherited the same assumption — but its consumers (autoReconcileDust, reclaimEligibleAmount) treat the count as authoritative state.

**Attack / Impact:** Permissionless griefing. An attacker who controls a referee address (already in the recovery target pool, e.g., a contract address whose corruption was previously attested) doesn't need to do anything special — they just wait for the recovery to expire without execute/cancel, and the protocol is silently bricked at that epoch. Even without adversarial intent, an admin who proposes a recovery, observes that the user no longer wants it (or the indexer found the corruption was self-correcting), and forgets to call `cancelClaimRecovery` — same effect.

The owner can recover by manually calling `cancelClaimRecovery(user, epoch)` for each expired proposal. But there is no on-chain enumeration of pending recoveries (the mapping is sparse) — off-chain monitoring must surface the list, and an outdated indexer means stale state lingers.

**Evidence:**
```solidity
// RevenueDistributor.sol:1226 — Expired only reverts, doesn't clean up state
function executeClaimRecovery(address user, uint256 epoch) external nonReentrant whenNotPaused {
    /* ... */
    if (block.timestamp > p.executeAfter + PROPOSAL_VALIDITY) revert RecoveryExpired();
    /* ... pendingRecoveryCount[epoch] -= 1 on success path only ... */
}

// RevenueDistributor.sol:1094-1097 — autoReconcileDust HALTs forever
if (pendingRecoveryCount[i] > 0) {
    if (!anyEligible) revert NoEpochToReconcile();
    break;
}

// RevenueDistributor.sol:942 — reclaimEligibleAmount excludes the epoch forever
if (pendingRecoveryCount[i] > 0) continue;
```

**Recommendation:** Add a permissionless sweep helper that prunes expired proposals, OR fold the prune into `cancelClaimRecovery` so anyone (not just owner) can call it for an expired proposal:

```solidity
/// @notice Permissionless pruning of an expired recovery proposal — releases the
///         pendingRecoveryCount for that epoch so autoReconcileDust /
///         reclaimEligibleAmount can resume processing.
function pruneExpiredRecovery(address user, uint256 epoch) external {
    PendingRecovery memory p = pendingRecoveries[user][epoch];
    if (p.executeAfter == 0) revert NoPendingRecovery();
    if (block.timestamp <= p.executeAfter + PROPOSAL_VALIDITY) revert RecoveryNotExpired();
    delete pendingRecoveries[user][epoch];
    pendingRecoveryCount[epoch] -= 1;
    emit ClaimRecoveryExpired(user, epoch);
}
```

This is the same pattern Compound uses for expired Timelock transactions. The function is permissionless because pruning an EXPIRED proposal is universally safe — the proposal was already unexecutable.

---

## [DR3-M-04] `revokeApprovedCaller` does NOT cancel any in-flight `proposeApprovedCaller` for the same address — propose→revoke→execute re-grants
**Severity:** Medium
**File:** `contracts/src/ReferralSplitter.sol:476-511`
**Category:** referral · gov

**Bug:** `revokeApprovedCaller` (line 507) is the documented "instant revoke" escape hatch — owner calls it to immediately strip an approved caller's privileges. It sets `approvedCallers[caller] = false` but does NOT touch `pendingCallerGrant[caller]` or the corresponding `_executeAfter[key]` slot. If a `proposeApprovedCaller(caller)` was queued and a 24h timelock has elapsed, the in-flight grant can still be EXECUTED (line 488-495), re-approving the caller.

Operational sequence:
1. Owner: `proposeApprovedCaller(C)`. `pendingCallerGrant[C] = true`. `_executeAfter[key] = T + 24h`.
2. Owner: `revokeApprovedCaller(C)`. `approvedCallers[C] = false` (was already false, no-op). `pendingCallerGrant[C]` STILL true.
3. After 24h: anyone (including a guardian who thought the revoke was the final word) can call `executeApprovedCaller(C)`. Wait — actually only `onlyOwner` can call it. So the captured-key attacker re-executes, re-approving.

Or more realistically: owner is rotating routers. They `proposeApprovedCaller(NEW_ROUTER)`, then attempt to revoke an unrelated `OLD_ROUTER` — but typo'd the address and revoked NEW_ROUTER instead. The 24h timelock continues, NEW_ROUTER is approved on execute, but the owner thinks the revoke was permanent.

**Attack / Impact:** Operational footgun, NOT a direct exploit. The 24h timelock window is the protective barrier. But the asymmetry between propose (24h-delayed) and revoke (instant, no companion-cancel) means an instant-revoke is NOT actually instant for a queued grant — the grant survives the revoke and re-executes after the timelock.

A captured-owner key can deliberately exploit this: queue grant, "revoke" to lull guardian, re-execute after 24h. The 24h window exists for guardian intervention, but the guardian's only tool is `cancelApprovedCallerGrant` (line 498) which is `onlyOwner` — so the guardian must be the same multisig that's compromised. Effectively the timelock does NOT protect against the captured-owner sequence.

**Evidence:**
```solidity
// ReferralSplitter.sol:507-511 — revoke ignores pending grant
function revokeApprovedCaller(address _caller) external onlyOwner {
    if (_caller == address(0)) revert ZeroAddress();
    approvedCallers[_caller] = false;
    emit ApprovedCallerSet(_caller, false);
    // MISSING: if (pendingCallerGrant[_caller]) cancel the in-flight grant
}

// ReferralSplitter.sol:488-495 — execute ignores approved-state
function executeApprovedCaller(address _caller) external onlyOwner {
    require(pendingCallerGrant[_caller], "NO_PENDING_GRANT");
    bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
    _execute(key);                              // ← reverts if proposal is missing
    pendingCallerGrant[_caller] = false;
    approvedCallers[_caller] = true;            // ← unconditionally re-grants
    emit ApprovedCallerSet(_caller, true);
}
```

**Recommendation:** Have `revokeApprovedCaller` ALSO `_forceCancel` any in-flight `pendingCallerGrant[caller]`:

```solidity
function revokeApprovedCaller(address _caller) external onlyOwner {
    if (_caller == address(0)) revert ZeroAddress();
    approvedCallers[_caller] = false;
    // V3 FIX: also cancel any in-flight grant proposal so the revoke is
    // semantically "permanent until next propose" — closes the propose-revoke-
    // execute resurrection race under captured-owner sequencing.
    if (pendingCallerGrant[_caller]) {
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        _forceCancel(key);
        pendingCallerGrant[_caller] = false;
        emit CallerGrantCancelled(_caller);
    }
    emit ApprovedCallerSet(_caller, false);
}
```

`_forceCancel` is the new TimelockAdmin helper (DEEP-LIB-H4) that emits the canonical event when state is cleared. This makes revoke truly permanent and matches the "instant revoke = safe" mental model the contract NatSpec promises.

---

## [DR3-L-01] `_pendingETH` view does NOT subtract pending-recovery reservations — over-reports for users on epochs with in-flight recoveries
**Severity:** Low
**File:** `contracts/src/RevenueDistributor.sol:1295-1345`
**Category:** revenue · view

**Bug:** The pass-2 V2-DR-M-01 fix added `if (claimedAtEpoch[user][i]) continue;` to `_pendingETH` so the view doesn't report phantom ETH AFTER a recovery EXECUTES. But for the window between propose and execute (48h timelock), the view does NOT account for the recovery's reservation:

- User Y has a pending recovery on epoch X for `share_Y = (epoch.totalETH * power_Y) / epoch.totalLocked`. `pendingRecoveryCount[X] = 1`. `epochClaimed[X]` is unchanged.
- User Z's `pendingETH(Z)` is computed by `_pendingETH`. Loop hits epoch X: `claimedAtEpoch[Z][X] == false` (Z is unrelated to Y's recovery). `share_Z = (epoch.totalETH * power_Z) / epoch.totalLocked`. The C-03 cap reads `remaining = epoch.totalETH - epochClaimed[X]` — which doesn't yet reflect Y's reserved share.
- `_pendingETH(Z)` returns `share_Z + ...`. UI shows that figure.
- Y's recovery executes 48h later. `epochClaimed[X] += share_Y`.
- Z calls `claim()`. Loop hits epoch X. `claimedAtEpoch[Z][X] = true` (now stamped). `remaining = epoch.totalETH - epochClaimed[X]` — now smaller by `share_Y`. C-03 cap kicks in: `share_Z = remaining` (smaller than the view promised).

The user-facing impact is mild — claim succeeds with a slightly smaller payout, no fund-loss. But the UI/UX divergence is real: a frontend integrator displaying `pendingETH(user)` and "claim now to receive X" shows a number larger than the actual transfer. Worse, an integrator polling `pendingETH(user)` for batch settlement budgets reads inflated numbers.

The over-report is bounded by `sum(pending recoveries on epoch X) / epoch.totalLocked * epoch.totalETH`, which is at most 25% of `epoch.totalETH` per recovery (per the MAX_RECOVERY_POWER_BPS cap), but cumulative across N recoveries on the same epoch.

**Attack / Impact:** UI/UX divergence and integrator-visible bookkeeping drift. Not a fund-loss vector.

**Evidence:**
```solidity
// RevenueDistributor.sol:1336-1339 — view applies C-03 cap from current epochClaimed
uint256 remaining = epoch.totalETH > epochClaimed[i]
    ? epoch.totalETH - epochClaimed[i] : 0;
if (share > remaining) share = remaining;
total += share;
// MISSING: subtract reserved share from in-flight pending recoveries on epoch i.
//   uint256 reserved = sum_{user': pendingRecoveries[user'][i].executeAfter > 0}
//                          (epoch.totalETH * pendingRecoveries[user'][i].power) /
//                          epoch.totalLocked;
//   if (share + reserved > remaining) share = remaining > reserved ? remaining - reserved : 0;
```

**Recommendation:** Two options:

**Option A** — additive-aware view (gas-heavy, requires per-epoch enumeration of pending recoveries which is O(unique users) — currently impractical without an enumerable mapping).

**Option B (simpler)** — document the limitation in `pendingETH` NatSpec:

```solidity
/// @notice Calculate pending ETH claimable by a user.
/// @dev    The returned value DOES NOT subtract reserved shares from pending
///         claim-recovery proposals on the same epochs. If recoveries are
///         in-flight on any of the user's unclaimed epochs, the actual
///         `claim()` payout may be smaller (capped by the C-03 per-epoch
///         remaining check). This is bounded by 25% of each epoch's totalETH
///         per recovery (MAX_RECOVERY_POWER_BPS) and is visible only on
///         epochs with `pendingRecoveryCount[epoch] > 0`. Off-chain consumers
///         should treat this as an upper bound, not a precise figure.
function pendingETH(address user) external view returns (uint256) {
    return _pendingETH(user, MAX_VIEW_EPOCHS);
}
```

Option B is the recommended pragma since the fix in Option A requires significant data structure changes (an enumerable per-epoch user set).

---

## [DR3-L-02] `_pendingETH` view does NOT mirror `claim()` `_isStakingPaused` check — UI shows positive while claim reverts
**Severity:** Low
**File:** `contracts/src/RevenueDistributor.sol:541-545, 620-622, 1295-1345`
**Category:** revenue · view

**Bug:** `claim()` at line 545 and `claimUpTo()` at line 622 both revert `StakingPaused()` when `_isStakingPaused()` returns true (the staking contract is paused, indicating possible exploit). `_pendingETH` does NOT mirror this check — the view returns a non-zero figure while the corresponding claim reverts. UI/UX divergence at exactly the moment the protocol is in incident-response mode (when accurate UI is most important).

**Attack / Impact:** Pure UX. During an incident-pause, users see "claim N ETH" buttons that revert when clicked. Confusing for end users; misleads off-chain monitoring systems that might infer "claimable balance is liquid" when in fact it's paused.

**Evidence:**
```solidity
// RevenueDistributor.sol:545 — claim() blocks during staking-pause
if (_isStakingPaused()) revert StakingPaused();

// RevenueDistributor.sol:1310 — _pendingETH only checks lock state, not pause state
if (!lockActive && !inGracePeriod) return 0;
// MISSING: if (_isStakingPaused()) return 0;
```

**Recommendation:** Mirror the pause check in `_pendingETH`:

```solidity
function _pendingETH(address user, uint256 maxEpochs) internal view returns (uint256) {
    // V3 FIX: Mirror the claim() pause check so UI doesn't promise claims that
    // would revert. Both _isStakingPaused (staking contract paused) AND this
    // contract's own paused state should zero the view (claim() has whenNotPaused
    // too, but the modifier doesn't apply to view functions).
    if (paused() || _isStakingPaused()) return 0;
    /* ... rest unchanged ... */
}
```

Note: `paused()` is the OZ Pausable accessor — already a public getter on this contract. The `_isStakingPaused` helper is internal. Both reads are gas-cheap.

---

## Summary

| ID | Severity | File | Title |
|---|---|---|---|
| DR3-H-01 | High | RevenueDistributor.sol | executeForfeitReclaim doesn't mark per-epoch dust — sweep→propose-recovery DoS |
| DR3-M-01 | Med | ReferralSplitter.sol | Banned referrer pendingETH permanently locked — forfeit predicates not bypassed |
| DR3-M-02 | Med | PremiumAccess.sol | V2-DR-L-03 double-decrements totalRevenue on shortfall path |
| DR3-M-03 | Med | RevenueDistributor.sol | Expired recovery proposals dangle pendingRecoveryCount forever |
| DR3-M-04 | Med | ReferralSplitter.sol | revokeApprovedCaller doesn't cancel in-flight grant — propose-revoke-execute re-grants |
| DR3-L-01 | Low | RevenueDistributor.sol | _pendingETH view over-reports during in-flight recoveries |
| DR3-L-02 | Low | RevenueDistributor.sol | _pendingETH view doesn't mirror staking-pause check |

**Most pressing:** DR3-H-01 is a real owner-sequenceable DoS of legitimate recovery payouts; the v2 DR2-M-04 fix only closed the propose-recovery-then-forfeit ordering, not the inverse. DR3-M-02 is a regression introduced by the v2 V2-DR-L-03 fix — it overshot the pass-1 high-water-mark drift and now drifts in the opposite direction. DR3-M-03 is a permissionless-griefing surface against the `autoReconcileDust` flywheel that's operationally subtle.

**Architectural verdict on the v2 closures:**
- **DR2-M-01 (`_pendingETH` claimedAtEpoch skip)** — VERIFIED correct. The pass-1+pass-2 unified mapping pattern now spans write + view paths consistently.
- **DR2-M-02 (cursor advance on totalOwed == 0)** — VERIFIED correct. Both `claim` and `claimUpTo` advance the cursor in the all-recovered-range case; the grace-period edge case is correctly handled via `actualEndEpoch == startEpoch` short-circuit.
- **DR2-M-03 (`bannedReferrers` semantics)** — INCOMPLETE. New earnings + claim are blocked, but the pre-ban `pendingETH` balance is permanently locked because forfeit predicates were not taught the ban shortcut. See DR3-M-01.
- **DR2-M-04 (`reclaimEligibleAmount` skips pending-recovery)** — INCOMPLETE for inverse ordering. The propose-recovery-then-forfeit ordering is closed; the forfeit-then-sweep-then-propose-recovery ordering is not. See DR3-H-01.
- **DR2-M-05 (timelocked-only post-`completeSetup`)** — VERIFIED correct. The timelocked path remains the only post-setup grant route. The companion `revokeApprovedCaller` has a separate pending-grant-cancel gap. See DR3-M-04.
- **V2-DR-L-03 (totalRevenue accounting)** — REGRESSED. Over-corrected the high-water-mark drift; now drifts in the opposite direction. See DR3-M-02.

The pass-2 batch closed every High and Medium it targeted. The 6 NEW findings cluster around three patterns: cross-feature ordering hazards (H-01, M-02), lifecycle dangling state (M-01, M-03), and view-path divergence (L-01, L-02). No new direct-fund-loss vector identified, but DR3-H-01 represents a real owner-sequenceable DoS that should be closed before next deploy.
