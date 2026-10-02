# DEEP Audit Pass 2 — Revenue / POL / Premium / Referral Stack
**Date:** 2026-05-01
**Scope:** RevenueDistributor (1298 LOC) · POLAccumulator (845 LOC) · PremiumAccess (593 LOC) · ReferralSplitter (665 LOC)
**Method:** Re-audit post-`f565c75` fixes (16 from pass 1 + 3 architectural closures: DEEP-DR-M-04 unified `claimedAtEpoch`, DEEP-DR-H-02 / M-R6 25% recovery cap, DEEP-DR-M-07 `setupComplete` enforcement)
**Baseline:** All pass-1 fixes verified landed; only NEW findings reported

---

## Executive summary

The `f565c75` batch closes every High and Medium from pass 1. The three architectural closures hold up under scrutiny: the unified `claimedAtEpoch[user][epoch]` mapping is set on EVERY normal-claim iteration (not just `share > 0`) and is checked in BOTH `proposeClaimRecovery` (fail-fast) and `executeClaimRecovery` (defense-in-depth); the 25% per-recovery cap is enforced at propose AND execute (the latter as a clamp, not revert, so a state-shift between propose and execute can't brick a legitimate recovery); and `setupComplete` now gates `recordFee`/`claim*`/`withdrawCallerCredit`/`forfeitUnclaimedRewards`/`markBelowStake`.

But the pass surfaces **9 NEW findings** clustered around three patterns:

1. **View-vs-write asymmetry** — `_pendingETH` (the view path) does NOT consult `claimedAtEpoch`, so `pendingETH(user)` can report phantom ETH that `claim()` won't actually pay.
2. **Cursor-stuck under all-recovered range** — when every epoch in the iteration range has `claimedAtEpoch == true`, `_calculateClaim` returns `totalOwed = 0` and `claim()` reverts BEFORE updating `lastClaimedEpoch`, leaving the cursor permanently parked.
3. **`bannedReferrers` only blocks selection, not earning** — banned referrers continue to accrue `pendingETH` from existing `referrerOf[user]` mappings and can still call `claimReferralRewards`, contradicting the implied-deprecation semantic.
4. **Forfeit-reclaim eligible pool intersects pending-recovery dust** — `reclaimEligibleAmount()` does NOT subtract the dust on epochs with `pendingRecoveryCount > 0`, so the owner can `proposeForfeitReclaim → executeForfeitReclaim → sweepDust` (sequenced) and starve a pending recovery's source pool.
5. **`totalRevenue` accounting drift after shortfall + extension** — `claimShortfall` does NOT decrement `totalRevenue` even though it pays out, and `cancelSubscription` only conditionally decrements (`if refundAmount <= totalRevenue`); combined with the new DR-M-06 extension flow which can add `consumedEscrow + cost` to revenue, the counter becomes a high-water-mark, not a balance.
6. **Wrong error type on `unbanReferrer`** — reverts `ZeroAddress()` when called for a non-banned address; misleading.
7. **`proposeBanReferrer` doesn't reject already-banned target** — owner can burn a 24h timelock slot on a no-op ban, and the second `proposeBanReferrer` for the same address overwrites pending state.
8. **Single-slot `pendingBanReferrer`** — only one ban can be in-flight at a time; concurrent ban proposals are serialized via the timelock key.
9. **MAX_RECOVERY_POWER_BPS = 25% leaves >25% holders permanently shorted** — a single-epoch corruption for a 30%+ holder can recover at most 25% via a single proposal; subsequent proposals revert because `claimedAtEpoch` is set on first execute. Documented architectural tradeoff but worth flagging operationally.

Total: **0 High · 4 Medium · 5 Low** — 9 findings.

---

## [DR2-M-01] `_pendingETH` view path does NOT consult `claimedAtEpoch` — phantom ETH reported after recovery
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:1242-1286`
**Category:** revenue · view

**Bug:** `_calculateClaim` (the WRITE path) was updated by DEEP-DR-M-04 to skip epochs with `claimedAtEpoch[user][i] == true` via a `continue` (line 688-690). The matching VIEW path `_pendingETH` was NOT updated and still iterates every epoch in `[lastClaimedEpoch[user], epochs.length)`, summing `share` regardless of whether the (user, epoch) was already settled via recovery.

**Attack / Impact:** UI displays "phantom" pending ETH for any user whose epochs were paid via `executeClaimRecovery`. Concretely: admin attests a recovery for Alice at epoch 5; recovery executes and stamps `claimedAtEpoch[Alice][5] = true`. Alice's frontend calls `pendingETH(Alice)` and gets back the recovery share (or some fraction of it, capped by `epoch.totalETH - epochClaimed[5]`). Alice clicks "Claim" — `claim()` runs `_calculateClaim`, the loop hits epoch 5 with `claimedAtEpoch == true`, `continue`s (no share added), returns `totalOwed = 0` for that epoch. If epoch 5 was the only "claimable" epoch in view, the entire `claim()` reverts `NothingToClaim` and Alice's UI shows a confusing error. Worse, an integrator polling `pendingETH` for batch settlement reads inflated values that never materialize as transfers.

The bug is most acute when the staking checkpoint at `epoch.timestamp` returns non-zero for the user (the "uncorrupted at epoch but corrupted later" scenario, or any path where admin uses recovery for liveness reasons rather than corruption).

**Evidence:**
```solidity
// RevenueDistributor.sol:1261-1284 — _pendingETH loop, NO claimedAtEpoch check
for (uint256 i = startEpoch; i < endEpoch; i++) {
    Epoch memory epoch = epochs[i];
    if (inGracePeriod && epoch.timestamp >= lockEnd) break;
    if (epoch.totalLocked > 0) {
        uint256 userPower = votingEscrow.votingPowerAtTimestamp(user, epoch.timestamp);
        if (userPower == 0 && isRestaked) {
            userPower = _restakedPowerAt(user, epoch.timestamp);
        }
        if (userPower > 0) {
            uint256 effectivePower = userPower > epoch.totalLocked ? epoch.totalLocked : userPower;
            uint256 share = (epoch.totalETH * effectivePower) / epoch.totalLocked;
            uint256 remaining = epoch.totalETH > epochClaimed[i] ? epoch.totalETH - epochClaimed[i] : 0;
            if (share > remaining) share = remaining;
            total += share;
        }
        // MISSING: if (claimedAtEpoch[user][i]) continue;
    }
}
```

**Recommendation:** Mirror the write-path skip at the top of the inner branch:
```solidity
if (claimedAtEpoch[user][i]) continue; // mirror _calculateClaim DR-M-04
```
Same fix for `pendingETHPaginated` (calls the same internal `_pendingETH`).

---

## [DR2-M-02] `_calculateClaim` cursor stuck when entire range is `claimedAtEpoch=true` — `claim()` reverts before advancing `lastClaimedEpoch`
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:540-602, 657-731`
**Category:** revenue

**Bug:** When every epoch in `[startEpoch, endEpoch)` has `claimedAtEpoch[user][i] == true` (a user with ≥1 recovered epochs and no fresh claimable epochs), the loop `continue`s through all of them, returns `totalOwed = 0`. The caller (`claim()` line 566 / `claimUpTo()` line 629) then reverts `NothingToClaim` BEFORE writing `lastClaimedEpoch[msg.sender] = actualEndEpoch`. The cursor stays parked.

**Attack / Impact:** The user's cursor never advances past the recovered range. Each subsequent `claim()` call re-iterates the same epochs, hits `continue` for each, reverts `NothingToClaim`. With `MAX_CLAIM_EPOCHS = 250`, a user with 250 consecutive recovered epochs is bricked from the cursor-advance path entirely. They must wait for at least one NEW claimable epoch to appear in the range so `totalOwed > 0` triggers the cursor write — but if the new epochs PUSH `endEpoch - startEpoch` past 250, `claim()` reverts `TooManyUnclaimedEpochs` and forces them onto `claimUpTo`, which has the same revert gate. The user is then dependent on having power AT the very next epoch, in a contiguous window of ≤250.

In practice the volume of recoveries is small, so 250-deep recovery clusters are unrealistic; but the architectural gap means future code that depends on `lastClaimedEpoch` (e.g. multi-epoch batch claim, snapshotted reward weighting) silently observes the stuck cursor. Also a UX issue: the user cannot "drain" the recovered range to advance their cursor before a real claimable epoch lands.

**Evidence:**
```solidity
// RevenueDistributor.sol:562-568
(uint256 totalOwed, uint256 actualEndEpoch) = _calculateClaim(...);
if (totalOwed == 0) revert NothingToClaim();   // ← reverts BEFORE the cursor write
lastClaimedEpoch[msg.sender] = actualEndEpoch;
```

**Recommendation:** When `totalOwed == 0` but `actualEndEpoch > startEpoch` (i.e. the loop iterated normally to the end without hitting the grace-period break), still advance the cursor, then revert. Pseudocode:
```solidity
if (totalOwed == 0) {
    if (actualEndEpoch > startEpoch) {
        lastClaimedEpoch[msg.sender] = actualEndEpoch;
    }
    revert NothingToClaim();
}
```
Or split the cursor-advance into a separate pure helper that doesn't depend on the `totalOwed > 0` predicate.

---

## [DR2-M-03] `bannedReferrers` set is consulted only by `setReferrer` / `updateReferrer` — banned referrers can still EARN and CLAIM
**Severity:** Medium
**File:** `contracts/src/ReferralSplitter.sol:208-253, 312-367, 387-407`
**Category:** referral · gov

**Bug:** The DEEP-DR-L-04 fix added `bannedReferrers[]` and a 24h-timelocked `proposeBanReferrer` / `executeBanReferrer` flow. The check fires only on `setReferrer` (line 214) and `updateReferrer` (line 236) — preventing NEW users from selecting a banned referrer. But:

1. **`recordFee` does NOT check `bannedReferrers[referrer]`** — pre-existing referees of the banned referrer continue to accumulate `pendingETH[bannedReferrer]` whenever they pay fees.
2. **`claimReferralRewards` does NOT check `bannedReferrers[msg.sender]`** — the banned referrer can still claim accumulated rewards (including post-ban accruals from #1).
3. **`forfeitUnclaimedRewards` does NOT integrate with the ban state** — to actually confiscate a banned referrer's `pendingETH`, the owner must STILL satisfy the existing pre-ban predicates: `referrerPower < MIN_STAKE` AND `lastBelowStakeTime >= 7d ago` AND `lastClaimTime >= 90d ago`. A banned referrer who maintains stake or who claims periodically is immune to forfeit.

So "banning" today is a soft selection-block, not the lifecycle-end intended by the pass-1 finding ("post-forfeiture cleanup can mark a referrer as ineligible permanently"). The 24h timelock and `proposeBanReferrer` ceremony imply a stronger semantic that the implementation doesn't deliver.

**Attack / Impact:** Operational mismatch. Off-chain ops who use `bannedReferrers` as a "kill switch" believe they've stopped a referrer's revenue stream; in fact the referrer continues to accrue and claim. Combined with the pre-existing `pendingETH[referrer]` / `lastClaimTime[referrer]` resets on claim, a banned referrer can "outlive" the ban indefinitely as long as they have one stake-qualified user upstream.

**Evidence:**
```solidity
// recordFee — no ban check (line 312)
function recordFee(address _user) external payable onlyApproved nonReentrant {
    require(setupComplete, "SETUP_NOT_COMPLETE");
    address referrer = referrerOf[_user];
    // ... (no bannedReferrers[referrer] check) ...
    if (referrerQualified) {
        pendingETH[referrer] += referrerShare;  // ← banned referrer still accrues
    }
}
// claimReferralRewards — no ban check (line 387)
function claimReferralRewards() external nonReentrant {
    require(setupComplete, "SETUP_NOT_COMPLETE");
    // ... (no bannedReferrers[msg.sender] check) ...
    pendingETH[msg.sender] = 0;     // ← banned referrer claims out
}
```

**Recommendation:** Pick one of two semantics and enforce it consistently.

A) **Ban = ineligible for new earnings** (closer to pass-1 intent):
```solidity
// In recordFee:
if (bannedReferrers[referrer]) {
    accumulatedTreasuryETH += referrerShare;
    return;
}
// In forfeitUnclaimedRewards: bypass the stake/inactivity gates if banned.
```

B) **Ban = pure selection-block** (current behavior): then narrow the NatSpec to clarify, drop the 24h timelock to a simple owner-only flag (the ceremony implies more authority than the code grants), and rename to `selectionBlocked` for clarity.

Option (A) is the better fit given the existing `forfeitUnclaimedRewards` apparatus; the ban becomes the trigger that admin uses to permanently retire a referrer.

---

## [DR2-M-04] `reclaimEligibleAmount()` includes dust on pending-recovery epochs — admin can race forfeit-reclaim against recovery payout
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:904-913, 934-957, 1162-1228`
**Category:** revenue · gov

**Bug:** DEEP-DR-M-03 closed the autoReconcileDust race by HALTing the cursor at any epoch with `pendingRecoveryCount[i] > 0`. The matching gate on the FORFEIT-RECLAIM side was NOT installed: `reclaimEligibleAmount()` (line 904-913) loops every epoch and sums `epoch.totalETH - epochClaimed[i]` whenever `epoch.timestamp < block.timestamp - DUST_RECLAIM_GRACE`, regardless of `pendingRecoveryCount[i]`.

A pending recovery for epoch X reserves `share = (ep.totalETH * power) / ep.totalLocked` of the source pool (paid out on `executeClaimRecovery`). If admin's forfeit proposal includes that `share` in `eligible`, the owner can sequence:

1. `proposeClaimRecovery(user, X, power)` — 48h timelock starts. `pendingRecoveryCount[X] = 1`.
2. (any time before 48h elapses) `proposeForfeitReclaim(amount)` where `amount` includes epoch X's full unclaimed dust. 48h timelock starts.
3. After both timelocks: `executeForfeitReclaim()` — drops `totalEarmarked` by `amount`, then `sweepDust()` drains the actual contract balance to treasury.
4. `executeClaimRecovery(user, X)` — computes `share` from the pre-existing `epoch.totalETH`, but the contract balance is now insufficient. The `user.call{value: share, gas: 10000}` fails with out-of-funds, the entire tx reverts. The recovery is now permanently un-executable until ETH is replenished.

**Attack / Impact:** Owner-side DoS of legitimate recoveries. Compromise scenario: an attacker who briefly holds the owner key sequences (3) then (4) to brick recoveries before guardian-cancel can intervene. The user is then locked out of their attested share until treasury manually returns funds (a multi-multisig coordination event).

The "guardian rotates owner first" mitigation doesn't help if the proposals were queued from compromise; they all become executable after 48h.

**Evidence:**
```solidity
// reclaimEligibleAmount — no pendingRecoveryCount filter
function reclaimEligibleAmount() public view returns (uint256 eligible) {
    uint256 cutoff = block.timestamp > DUST_RECLAIM_GRACE ? block.timestamp - DUST_RECLAIM_GRACE : 0;
    for (uint256 i = 0; i < epochs.length; i++) {
        Epoch memory ep = epochs[i];
        if (ep.timestamp >= cutoff) continue;
        // MISSING: if (pendingRecoveryCount[i] > 0) continue;
        uint256 unclaimed = ep.totalETH > epochClaimed[i] ? ep.totalETH - epochClaimed[i] : 0;
        eligible += unclaimed;
    }
}
```

**Recommendation:** Subtract pending-recovery reservations from `eligible`. Two options:

A) **Skip pending-recovery epochs entirely** (simplest, mirrors autoReconcileDust HALT):
```solidity
if (pendingRecoveryCount[i] > 0) continue;
```

B) **Compute the recovery's reservation and subtract it**: more complex (requires iterating `pendingRecoveries[*][i]` for all users), unjustified given option A is sufficient.

Apply the same skip in the execute-time `eligible` re-check inside `executeForfeitReclaim` (line 941). Note: `proposeForfeitReclaim` would also need to be re-evaluated — admin can still propose against `eligible_now` but eligible can grow during the timelock as recoveries cancel. Acceptable.

---

## [DR2-M-05] Pre-`completeSetup` `setApprovedCaller(router, true)` + post-`completeSetup` recordFee is the documented happy path — but BAD ordering bricks rollback
**Severity:** Medium (operational / gov)
**File:** `contracts/src/ReferralSplitter.sol:312-318, 414-428`
**Category:** referral · gov

**Bug:** DEEP-DR-M-07 added `require(setupComplete, "SETUP_NOT_COMPLETE")` to `recordFee`. `completeSetup()` is forward-only — once flipped, it cannot be reverted. `setApprovedCaller` is also blocked after `completeSetup` (line 424). The ONLY post-completeSetup path to add an approved caller is the 24h-timelocked `proposeApprovedCaller` → `executeApprovedCaller`.

**Operational gap:** if deploy ops calls `completeSetup()` BEFORE wiring SwapFeeRouter, the only way to recover is the 24h timelock. That's by design. But there's a more subtle gap: after `completeSetup`, if the SwapFeeRouter contract is upgraded (proxy pattern) or migrated, the OLD router's approval persists in `approvedCallers[oldRouter]` until owner calls `revokeApprovedCaller(oldRouter)`. If the old router is malicious post-upgrade (compromised proxy admin), it can still call `recordFee` with attacker-controlled `_user`/`msg.value`.

The DEEP-DR-M-07 fix focuses on the pre-completeSetup window but doesn't address the post-completeSetup operational lifecycle. The 24h timelock for `proposeApprovedCaller` doesn't apply to `revokeApprovedCaller` (line 463-467, instant), so revoke is instant. Good. But ops needs to know to revoke; the contract does not detect a stale approval automatically.

**Attack / Impact:** Operational. A protocol upgrade that swaps SwapFeeRouter without revoking the old approval leaves a dangling capability. If the old router is later upgradable and compromised, it can credit referral state arbitrarily. Defense is operational vigilance.

**Evidence:**
```solidity
// recordFee — gated on setupComplete + onlyApproved
function recordFee(address _user) external payable onlyApproved nonReentrant {
    require(setupComplete, "SETUP_NOT_COMPLETE");
    // ... rest accepts arbitrary _user / msg.value from any approvedCallers ...
}
// setApprovedCaller — blocked after setupComplete
function setApprovedCaller(address _caller, bool _approved) external onlyOwner {
    if (setupComplete) revert SetupAlreadyComplete();
    approvedCallers[_caller] = _approved;
}
```

**Recommendation:** Add a pre-deploy operations checklist (or on-chain) that surfaces `approvedCallers[*]` enumeration. A tiny indexer view (`getApprovedCallers()` returning a copy of an off-chain enumerable set) would suffice. Alternatively: lifecycle events for approval changes are already emitted (`ApprovedCallerSet`); off-chain monitoring can subscribe.

A CONTRACT-LEVEL fix would be: on `proposeApprovedCaller(newCaller)` execution, automatically revoke the OLD caller — but this requires the contract to know which is "old," which it doesn't. So this is operational, not code.

---

## [DR2-L-01] `unbanReferrer` reverts `ZeroAddress()` for non-banned addresses — wrong typed error
**Severity:** Low
**File:** `contracts/src/ReferralSplitter.sol:631-635`
**Category:** referral · other

**Bug:** `unbanReferrer` reverts `ZeroAddress()` when called for an address that is not currently banned. The error is misleading — the address is not zero, it's just not banned. Off-chain monitoring keying on `ZeroAddress()` would flag this as an input-validation error rather than a state mismatch.

**Evidence:**
```solidity
function unbanReferrer(address _referrer) external onlyOwner {
    if (!bannedReferrers[_referrer]) revert ZeroAddress(); // ← wrong error
    bannedReferrers[_referrer] = false;
    emit ReferrerUnbanned(_referrer);
}
```

**Recommendation:** Add a typed error `NotBanned()` and use it:
```solidity
error NotBanned();
function unbanReferrer(address _referrer) external onlyOwner {
    if (!bannedReferrers[_referrer]) revert NotBanned();
    ...
}
```

---

## [DR2-L-02] `proposeBanReferrer` doesn't check if already-banned — wastes 24h timelock window on a no-op
**Severity:** Low
**File:** `contracts/src/ReferralSplitter.sol:605-610`
**Category:** referral · gov

**Bug:** `proposeBanReferrer` accepts any non-zero address, including one that is already in `bannedReferrers[]`. A successful execute is a no-op (the flag is already set). 24h of admin time and a timelock slot are spent for no effect.

**Evidence:**
```solidity
function proposeBanReferrer(address _referrer) external onlyOwner {
    if (_referrer == address(0)) revert ZeroAddress();
    // MISSING: if (bannedReferrers[_referrer]) revert AlreadyBanned();
    pendingBanReferrer = _referrer;
    _propose(BAN_REFERRER, BAN_REFERRER_DELAY);
    emit BanReferrerProposed(_referrer, _executeAfter[BAN_REFERRER]);
}
```

**Recommendation:** Add `if (bannedReferrers[_referrer]) revert AlreadyBanned();` (with new typed error). Symmetric: `unbanReferrer` already implicitly checks (DR2-L-01 identifies the wrong error type).

---

## [DR2-L-03] `cancelSubscription` shortfall path doesn't decrement `totalRevenue` — accounting drift after partial-refund + future shortfall claim
**Severity:** Low
**File:** `contracts/src/PremiumAccess.sol:355-419, 483-496`
**Category:** premium · other

**Bug:** When `cancelSubscription` records a shortfall (DEEP-DR-M-05 path), it pays the user `refundAmount = contractBalance` and decrements `totalRevenue` only by `refundAmount` (line 411-414), conditional on `refundAmount <= totalRevenue`. The shortfall portion (recorded in `shortfallOwed[user]`) is NOT decremented from `totalRevenue` at cancel time, AND `claimShortfall` (line 483-496) doesn't decrement `totalRevenue` either.

Combined with the new DR-M-06 extension flow which credits `consumedEscrow + cost` to `totalRevenue` per extension, `totalRevenue` becomes a high-water-mark counter rather than a current balance. After many extension+cancel+shortfall+claim cycles, `totalRevenue` may grossly overstate actual unspent revenue. Off-chain analytics depending on `totalRevenue` for revenue projections / dashboards will report inflated figures.

`withdrawToTreasury` does NOT consult `totalRevenue` (uses `balance - totalRefundEscrow - totalShortfallOwed`), so fund-safety is preserved. The drift is purely a bookkeeping issue.

**Evidence:**
```solidity
// cancelSubscription — only conditional decrement, only on the immediate refund
if (refundAmount > 0) {
    if (refundAmount <= totalRevenue) {
        totalRevenue -= refundAmount;
    }
    toweli.safeTransfer(msg.sender, refundAmount);
}
// claimShortfall — no totalRevenue decrement
function claimShortfall() external nonReentrant {
    ...
    shortfallOwed[msg.sender] = owed - payout;
    totalShortfallOwed -= payout;
    toweli.safeTransfer(msg.sender, payout);
    // MISSING: totalRevenue -= payout;
}
```

**Recommendation:** Decrement `totalRevenue` in `claimShortfall` (matching `cancelSubscription`'s pattern):
```solidity
if (payout <= totalRevenue) {
    totalRevenue -= payout;
}
```
And in `cancelSubscription`, decrement by FULL `escrowed - consumed_implicit` (not just the immediately-refunded portion) since the contract is committed to honoring the shortfall via `claimShortfall`.

---

## [DR2-L-04] DEEP-DR-H-02 25% recovery cap leaves >25% holders permanently un-recoverable beyond first cap
**Severity:** Low (architectural tradeoff, acknowledged)
**File:** `contracts/src/RevenueDistributor.sol:1102-1141, 1162-1228`
**Category:** revenue · gov

**Bug:** `MAX_RECOVERY_POWER_BPS = 2500` caps each individual recovery at 25% of `epoch.totalLocked`. The pass-1 design allows splitting into multiple proposals — but DEEP-DR-M-04 stamps `claimedAtEpoch[user][epoch] = true` on the FIRST `executeClaimRecovery` (line 1208). Subsequent `proposeClaimRecovery(user, epoch, ...)` calls revert `AlreadyClaimedNormally` (line 1112). So a single (user, epoch) recovery is a ONE-SHOT cap of 25%.

For a holder with >25% of epoch.totalLocked at the time of corruption (e.g. a treasury-class veNFT, a market-maker LP), the recovery delivers at most 25%. The remaining (e.g. up to 75% for a single-holder epoch) is permanently un-recoverable for that user via this path — it eventually flows through `forfeitUnclaimedRewards` to the protocol treasury.

**Attack / Impact:** Documented architectural tradeoff. The pass-1 master report explicitly chose this for blast-radius bounding. But the operational expectation that "a single corrupted holder can be made whole" is no longer guaranteed. A 30% holder corrupted at epoch X loses 5% of `ep.totalETH` permanently.

For the protocol's typical user distribution this is unlikely (median holder < 25%), but treasury/MM addresses are a real risk.

**Evidence:**
```solidity
// proposeClaimRecovery line 1112 — second proposal blocked after first execute
if (claimedAtEpoch[user][epoch]) revert AlreadyClaimedNormally();
```

**Recommendation:** Two options:

A) **Document the limit explicitly** in the contract NatSpec at `proposeClaimRecovery` and in user-facing docs: "Recovery is capped at 25% of epoch.totalLocked per user per epoch. Holders with >25% historical power must split their claim across multiple epochs (impossible if the corruption affected only one epoch)." Acknowledge the residual loss.

B) **Allow multiple proposals up to a cumulative cap**: track `recoveredPower[user][epoch]` and reject when `recoveredPower + power > recoveryCap`. The unified `claimedAtEpoch` flag is retained for normal-claim deduplication but does NOT block re-proposal. This requires adding a cumulative-recovered-share tracker AND a propose-time check that uses it instead of `claimedAtEpoch`. More complex but semantically correct.

---

## [DR2-L-05] `proposeBanReferrer` allows banning of `treasury`, `owner()`, or other privileged addresses — no whitelist
**Severity:** Low
**File:** `contracts/src/ReferralSplitter.sol:605-610`
**Category:** referral · gov

**Bug:** `proposeBanReferrer` only checks `_referrer != address(0)`. Owner can ban:
- `treasury` — would prevent treasury from being SET as a referrer (no functional impact, treasury is not a referrer in practice).
- `owner()` — same as above.
- Any contract address (e.g. a multisig, a vault) — could prevent that contract from receiving referrer-share payouts as a referrer.
- The protocol's own contract addresses (RevenueDistributor, POLAccumulator, ...) — no impact since they're not in the referral system.

**Attack / Impact:** Mostly cosmetic. Minor operational risk: a fat-finger or compromise during the 24h timelock window could ban an address whose ban has unexpected downstream effects (e.g., a wallet-as-a-service contract that holds many users' funds). The 24h timelock provides recovery time.

**Evidence:**
```solidity
function proposeBanReferrer(address _referrer) external onlyOwner {
    if (_referrer == address(0)) revert ZeroAddress();
    pendingBanReferrer = _referrer;
    ...
}
```

**Recommendation:** Optionally reject `_referrer == treasury` and `_referrer == owner()` to prevent obvious self-targeting. Probably not worth the gas — operational vigilance suffices.

---

## Summary

| ID | Severity | File | Title |
|---|---|---|---|
| DR2-M-01 | Med | RevenueDistributor.sol | `_pendingETH` view doesn't consult `claimedAtEpoch` — phantom ETH |
| DR2-M-02 | Med | RevenueDistributor.sol | cursor stuck when entire range is `claimedAtEpoch=true` |
| DR2-M-03 | Med | ReferralSplitter.sol | `bannedReferrers` only blocks selection — banned still earns / claims |
| DR2-M-04 | Med | RevenueDistributor.sol | `reclaimEligibleAmount()` ignores pending-recovery dust → starve recovery |
| DR2-M-05 | Med | ReferralSplitter.sol | post-`completeSetup` lifecycle gap for stale `approvedCallers` |
| DR2-L-01 | Low | ReferralSplitter.sol | `unbanReferrer` wrong typed error (`ZeroAddress`) |
| DR2-L-02 | Low | ReferralSplitter.sol | `proposeBanReferrer` no already-banned check |
| DR2-L-03 | Low | PremiumAccess.sol | `claimShortfall` / shortfall cancel doesn't decrement `totalRevenue` |
| DR2-L-04 | Low | RevenueDistributor.sol | 25% recovery cap permanently shorts >25% holders |
| DR2-L-05 | Low | ReferralSplitter.sol | `proposeBanReferrer` permits banning of treasury / owner / etc. |

**Most pressing:** DR2-M-01 and DR2-M-02 are the leftover sibling-search misses on the DEEP-DR-M-04 unified mapping fix — write-path was updated, view path and cursor-advance edge case were not. DR2-M-03 is a documentation-vs-implementation mismatch on the new ban feature; the 24h timelock implies more authority than the code grants. DR2-M-04 is a real cross-feature interaction the pass-1 audit missed: forfeit-reclaim and recovery share the same source pool but only one (autoReconcileDust) was taught to skip the other.

**Architectural verdict on the three closures:**
- **DEEP-DR-M-04 (claimedAtEpoch)** — write-path correct, view-path missing skip (M-01), cursor-advance edge case missing (M-02). 80% complete.
- **DEEP-DR-H-02 / M-R6 (25% cap)** — propose AND execute enforcement correct (the execute uses a clamp not a revert, which is the right choice for state-shift safety). The unintended consequence is single-holder >25% corrupted users get permanently shorted (L-04). 90% complete.
- **DEEP-DR-M-07 (setupComplete)** — all five required entry points gated correctly. The 24h timelocked re-add path is intact. The lifecycle gap (M-05) is operational, not architectural. 100% complete.

The pass-1 batch closed every High and Medium it targeted. The 9 NEW findings are all sibling-search misses (M-01, M-02, M-04) or operational/documentation gaps (M-03, M-05, L-04). No new fund-loss vector identified.
