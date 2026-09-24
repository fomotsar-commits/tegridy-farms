# DEEP Audit — Revenue / POL / Premium / Referral Stack
**Date:** 2026-05-01
**Scope:** RevenueDistributor (1241 LOC) · POLAccumulator (880 LOC) · PremiumAccess (519 LOC) · ReferralSplitter (604 LOC)
**Method:** Verify post-MICROSCOPE_2026_04_30 fixes and hunt for missed siblings, regressions, and new vulns
**Baseline:** All 2026-04-29/30 fixes (REV-H-01/02, REV-M-01/02/03, M-P01/02, M-AUDIT-2026-1, PA-M-01/02, PA-L-01) — only NEW findings reported

---

## Executive summary

The recent batch of fixes (C5 unified `claimedAtEpoch`, REV-H-02 `pendingRecoveryCount`, M-R6 25% per-recovery cap, H15/H16 TWAP harvest anchoring + bypassed-flag enforcement, M-P01/M-R4 WETHFallbackLib parity, PA-M-01 escrow forfeit-on-extension) did close the headline issues. But the audit pass surfaces **15 NEW findings** clustered around:

1. **Pause asymmetry** — the M-7 sibling-search audit-pattern was not applied; multiple owner-mutating paths bypass `whenNotPaused`.
2. **Forfeit-reclaim grace mismatch** — `DUST_RECLAIM_GRACE` and `CLAIM_GRACE_PERIOD` collide, allowing the owner to reclaim ETH that legitimate grace-period claimers can still withdraw.
3. **Recovery payout ignores user-paused state** — `executeClaimRecovery` is permissionless and bypasses `_isStakingPaused()` checks the normal claim path enforces.
4. **autoReconcileDust skips epochs with pending recoveries but advances cursor past them** — residual dust on those epochs becomes permanently orphaned.
5. **PremiumAccess `cancelSubscription` insolvency window** — capped-by-balance fallback silently underpays during ongoing reconciliation drift.
6. **POLAccumulator slippageMin* derived from attacker-controlled `toweliAmount`** despite TWAP floor — TWAP saves the lower bound but the additive belt-and-braces is silently no-op'd under sandwich.
7. **ReferralSplitter: documented `setupComplete` operational gate is not enforced on `recordFee`/`claim*`** — pre-deploy state can credit pendingETH if owner accidentally triggers fee recording.
8. **executeForfeitReclaim does not re-check the lifetime cap** at execution time, only at proposal time.

Total: **2 High · 8 Medium · 5 Low** — 15 findings.

---

## [DR-H-01] `executeClaimRecovery` not gated by pause OR by staking-paused check
**Severity:** High
**File:** `contracts/src/RevenueDistributor.sol:1115-1170`
**Category:** revenue · gov

**Bug:** `claim()` and `claimUpTo()` both check `_isStakingPaused()` (M-10) and have `whenNotPaused`. `executeClaimRecovery` (a permissionless function — anyone can fire it after the 48h timelock) has neither modifier. If a discovered exploit caused both contracts to be paused, the timelocked recoveries will still execute, paying out ETH that may now reflect the very corruption the pause was triggered to investigate. The recovery uses pre-attested `power` so it's not technically reading corrupted state, but the operational surface contradicts the documented M-10 design intent ("block all claims when staking is paused — corrupted data could inflate voting power").

**Attack / Impact:** (1) Owner attests recovery 48h ago for user X, power 25%-of-totalLocked. (2) Major exploit discovered, both contracts paused. (3) Anyone calls `executeClaimRecovery(X, epoch)` — pays out 25% of epoch.totalETH despite the pause. (4) Owner cannot block this without going through a 48h `cancelClaimRecovery` chain, which during a live incident is too slow.

**Evidence:**
```solidity
// RevenueDistributor.sol:1115
function executeClaimRecovery(address user, uint256 epoch) external nonReentrant {
    PendingRecovery memory p = pendingRecoveries[user][epoch];
    if (p.executeAfter == 0) revert NoPendingRecovery();
    // No whenNotPaused, no _isStakingPaused() check
    if (block.timestamp < p.executeAfter) revert RecoveryNotReady();
```

**Recommendation:** Add `whenNotPaused` and an `if (_isStakingPaused()) revert StakingPaused();` line at the top of `executeClaimRecovery`. The recovery is admin-attested, but pause is the universal kill-switch — recoveries should respect it.

---

## [DR-H-02] `executeForfeitReclaim` re-checks eligible dust but NOT the lifetime cap at execute time
**Severity:** High
**File:** `contracts/src/RevenueDistributor.sol:909-923`
**Category:** revenue · gov

**Bug:** `proposeForfeitReclaim` enforces `totalForfeitedReclaimed + _amount <= lifetimeCap`. `executeForfeitReclaim` re-runs the `gap` and `eligible` checks at execute time (defense-in-depth against the 48h race) but **does NOT re-check the lifetime cap**. Because `lifetimeCap = (totalDistributed * MAX_LIFETIME_FORFEIT_BPS) / 10_000` and `totalDistributed` can change between propose and execute, the cap re-check is missing on the path that the comment claims is "defense-in-depth against the race where epochs appear/are claimed during the 48h delay."

**Attack / Impact:** Less severe than a fund drain because `propose-time` cap closed the worst case, but it allows a slow-creep around the lifetime cap when proposals overlap epoch creation. With multiple sequential propose→cancel→propose cycles, the owner can prepare a proposal, immediately cancel/repropose if the cap shifts, and execute before the next correction. More importantly, **if `totalDistributed` is decremented or rolled back via a future code path** (e.g., a refund/forfeit hook), the cap could be exceeded retroactively.

**Evidence:**
```solidity
// RevenueDistributor.sol:909
function executeForfeitReclaim() external onlyOwner {
    _execute(FORFEIT_RECLAIM);
    uint256 amount = pendingForfeitAmount;
    uint256 gap = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
    if (amount > gap) amount = gap;
    uint256 eligible = reclaimEligibleAmount();
    if (amount > eligible) amount = eligible;
    // MISSING: lifetime cap re-check
    totalEarmarked -= amount;
    totalForfeited += amount;
    totalForfeitedReclaimed += amount;
    pendingForfeitAmount = 0;
    emit ForfeitReclaimed(amount);
}
```

**Recommendation:** Add at execute time:
```solidity
uint256 lifetimeCap = (totalDistributed * MAX_LIFETIME_FORFEIT_BPS) / 10_000;
if (totalForfeitedReclaimed + amount > lifetimeCap) {
    amount = lifetimeCap > totalForfeitedReclaimed ? lifetimeCap - totalForfeitedReclaimed : 0;
}
if (amount == 0) revert ForfeitExceedsLifetimeCap();
```

---

## [DR-M-01] `DUST_RECLAIM_GRACE` collides with `CLAIM_GRACE_PERIOD` — owner can reclaim epochs that grace-period claimers still own
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:178, 952, 881-890`
**Category:** revenue · gov

**Bug:** `CLAIM_GRACE_PERIOD = 7 days` allows users whose lock JUST expired to claim past epochs for 7 days after `lockEnd`. `DUST_RECLAIM_GRACE = 7 days` makes epochs older than 7 days eligible for owner forfeit-reclaim. The two clocks are NOT correlated — `reclaimEligibleAmount()` filters on `epoch.timestamp` (line 882), but a user's grace claim window depends on their `lockEnd`, which is unrelated to any specific epoch's timestamp.

A user whose lock expired yesterday (`lockEnd = T-1d`, grace until T+6d) is entitled to claim ALL past epochs. But epochs distributed 8 days ago (`epoch.timestamp = T-8d`) are now in the eligible pool for `proposeForfeitReclaim`. The 48h timelock is shorter than the user's remaining 6-day grace window, so the owner can race them.

**Attack / Impact:** (1) Alice's lock expires at T-1d. Grace claim period: T-1d → T+6d. (2) Alice has unclaimed ETH from epoch at T-8d. (3) Owner proposes forfeit-reclaim covering that dust at T+0. Timelock executes at T+2d. (4) Alice's call to `claim()` after T+2d finds `epochClaimed[i]` not yet bumped, but `totalEarmarked` has been reduced — share calc fine, but contract-balance under-reserved → claim falls into `pendingWithdrawals`. (5) Alice withdraws pending; reduces `totalPendingWithdrawals` but `totalClaimed` was bumped. With multiple users in this state, the contract becomes balance-insolvent.

**Evidence:**
```solidity
// CLAIM_GRACE_PERIOD = 7 days (line 178)
// DUST_RECLAIM_GRACE = 7 days (line 952)
function reclaimEligibleAmount() public view returns (uint256 eligible) {
    uint256 cutoff = block.timestamp > DUST_RECLAIM_GRACE ? block.timestamp - DUST_RECLAIM_GRACE : 0;
    for (...) {
        if (ep.timestamp >= cutoff) continue; // Filters on epoch.timestamp, NOT user lockEnd
        ...
    }
}
```

**Recommendation:** Set `DUST_RECLAIM_GRACE >= CLAIM_GRACE_PERIOD + max-lock-duration` (or at minimum `2 * CLAIM_GRACE_PERIOD`) so any user whose lock expired before the epoch was eligible has had their grace window close. Alternatively, make the eligible filter time-relative to the latest lock-expiry observed: stash `latestLockExpiry` on `_settleRewardsOnTransfer` events and use that as the floor.

---

## [DR-M-02] Pause sibling miss — `executeHarvestLP`, `executeSweepETH`, `executeForfeitReclaim`, `reconcileRoundingDust`, `sweepDust`, `executeTokenSweep`, `autoReconcileDust` all bypass `whenNotPaused`
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:412, 791, 821, 909, 939, 975` · `POLAccumulator.sol:553, 615, 718`
**Category:** gov · revenue

**Bug:** This is the M-7 sibling miss in MICROSCOPE_2026_04_30 (§4 "half-installed mitigations"). The fix was never landed. `claim()` / `distribute()` correctly carry `whenNotPaused`, but every owner-side mutating path bypasses it. If pause is triggered for an exploit, owner can still drain via these paths during the pause window, AND the permissionless `autoReconcileDust` continues to run, advancing cursors and shifting funds between epochs while the contract is "paused".

**Attack / Impact:** Pause is the universal kill-switch. When triggered, every state mutator should freeze. Today, an attacker who has compromised the owner key can pause to halt user claims (preventing victims from withdrawing), then call `executeForfeitReclaim` / `executeHarvestLP` / `executeSweepETH` to drain to a treasury they control. The 48h timelock would have to be initiated PRE-pause, but a sophisticated attacker queues the proposals first and pauses last.

**Evidence:**
```solidity
// RevenueDistributor.sol:412 - no whenNotPaused
function executeEmergencyWithdrawExcess() external onlyOwner nonReentrant { ... }
// :791
function sweepDust() external onlyOwner nonReentrant { ... }
// :821
function executeTokenSweep() external onlyOwner { ... }
// :909
function executeForfeitReclaim() external onlyOwner { ... }
// :939
function reconcileRoundingDust() external onlyOwner { ... }
// :975
function autoReconcileDust() external nonReentrant ... { ... }
// POLAccumulator.sol:553
function executeSweepETH() external onlyOwner nonReentrant { ... }
// :615
function executeHarvestLP(...) external onlyOwner nonReentrant { ... }
// :718
function executeSweepTokens() external onlyOwner nonReentrant { ... }
```

**Recommendation:** Add `whenNotPaused` to ALL the listed functions. For owner-side functions, this is non-restrictive (owner can `unpause` first if a legitimate operation must proceed during a pause).

---

## [DR-M-03] `autoReconcileDust` advances cursor past pending-recovery epochs, leaving residual dust permanently orphaned
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:993-1041`
**Category:** revenue

**Bug:** The fix for REV-H-02 correctly skips epochs with `pendingRecoveryCount[i] > 0` (line 1021-1023). But the cursor-advance logic at line 1038 (`lastReconciledEpoch = lastTouched + 1`) advances PAST those skipped epochs. After the recovery executes and decrements `pendingRecoveryCount[i]` to 0, the cursor has already moved past — `autoReconcileDust` will not re-process epoch `i`, even if the recovery only consumed a fraction of the dust. Any residual dust on epoch `i` is permanently orphaned (`epochClaimed[i] < epoch.totalETH`, but no one will ever auto-reclaim it).

**Attack / Impact:** Not directly exploitable but is silent permanent fund loss. Over many recoveries with partial-payout dust residuals, the protocol accumulates unforfeitable trapped ETH. The comment at line 1015-1016 acknowledges this ("Cursor still advances past the skipped epoch — its residual dust is forfeit-orphaned, which is an acceptable tradeoff versus bricking the recovery") — but the tradeoff was made without considering the cumulative effect over hundreds of recoveries.

**Evidence:**
```solidity
// RevenueDistributor.sol:993-1041
for (uint256 i = cursor; i < endEpoch; i++) {
    Epoch memory epoch = epochs[i];
    if (epoch.timestamp + DUST_RECLAIM_GRACE > block.timestamp) {
        if (!anyEligible) revert GracePeriodActive();
        break;
    }
    anyEligible = true;
    lastTouched = i;
    if (pendingRecoveryCount[i] > 0) {
        continue; // Cursor still advances via lastTouched assignment above
    }
    ...
}
epochsProcessed = lastTouched + 1 - cursor;
lastReconciledEpoch = lastTouched + 1; // Skipped epochs are now permanently bypassed
```

**Recommendation:** Track skipped epochs in a dedicated `mapping(uint256 => bool) skippedDueToRecovery`. After all in-flight recoveries on an epoch resolve, allow a separate `recoverSkippedDust(epoch)` function that re-runs the dust-reconcile logic for a single skipped epoch. Or simpler: do NOT advance the cursor past skipped epochs — break the loop and require the keeper to re-call after recoveries resolve.

---

## [DR-M-04] `proposeClaimRecovery` permanent lockout when normal claim already advanced past epoch with zero share
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:1058-1098`
**Category:** revenue

**Bug:** `proposeClaimRecovery` reverts `AlreadyClaimedNormally` if `lastClaimedEpoch[user] > epoch`. This is correct for users who were paid for that epoch. But the normal-claim loop at line 666-711 marks `claimedAtEpoch[user][i] = true` ONLY when `share > 0`. If the user had ZERO historical voting power at epoch `i` (the very condition recovery was designed to fix), `claimedAtEpoch[user][i]` stays false, but `lastClaimedEpoch[user]` advances PAST `i`. The user is then permanently locked out from receiving recovery for epoch `i` even though they were never actually paid for it.

**Attack / Impact:** Not adversarial but a real silent rug: any user whose checkpoint was corrupted at epoch `i` AND who calls `claim()` BEFORE the admin proposes recovery has irreversibly forfeited their epoch-`i` share. This is a UX trap — the user's only signal would be a `Claimed(user, totalOwed=0)` event, which they would interpret as "I already claimed everything I'm owed."

**Evidence:**
```solidity
// RevenueDistributor.sol:1068-1069
if (claimedAtEpoch[user][epoch]) revert AlreadyClaimedNormally();
if (lastClaimedEpoch[user] > epoch) revert AlreadyClaimedNormally();
// vs. _calculateClaim line 702-707 - claimedAtEpoch is only set when share > 0
if (share > 0) {
    epochClaimed[i] += share;
    totalOwed += share;
    claimedAtEpoch[user][i] = true; // NOT set when share == 0
}
```

**Recommendation:** Change the propose-time check from `lastClaimedEpoch[user] > epoch` to `claimedAtEpoch[user][epoch]`. The unified mapping is the source of truth — `lastClaimedEpoch` is just a cursor. As-is, the recovery path is gated by a stale cursor that doesn't reflect actual payout.

---

## [DR-M-05] PremiumAccess `cancelSubscription` `contractBalance` cap silently shorts users in the FoT/insolvency window
**Severity:** Medium
**File:** `contracts/src/PremiumAccess.sol:347-376`
**Category:** premium

**Bug:** `cancelSubscription` caps `refundAmount` to `contractBalance` (line 348-351). State writes (`userEscrow[msg.sender] = 0`, `totalRefundEscrow -= escrowed`, `sub.expiresAt = block.timestamp`) execute UNCONDITIONALLY at line 354-368 regardless of whether the cap fired. **If the contract is balance-insolvent** (e.g., FoT token shrinkage during deposits, owner accidentally calling `withdrawToTreasury` while `totalRefundEscrow` is stale, malicious admin race), the user's escrow is fully zeroed but they only receive a partial refund. There is NO mechanism to record the shortfall — `userEscrow[user]` is now 0, so the user has no on-chain claim against the missing refund.

**Attack / Impact:** A first cancel under insolvent state correctly receives `contractBalance`. A subsequent user's cancel sees `contractBalance = 0` (or near 0), state writes still happen, refund is 0 — total loss. The first user's partial refund + subsequent users' zero refunds means the protocol silently expropriates legitimate refundable escrow.

**Evidence:**
```solidity
// PremiumAccess.sol:347-376
uint256 contractBalance = toweli.balanceOf(address(this));
if (refundAmount > contractBalance) {
    refundAmount = contractBalance;
}
// State writes happen REGARDLESS of cap firing
sub.expiresAt = block.timestamp;
if (isActiveSubscriber[msg.sender]) { ... }
if (escrowed <= totalRefundEscrow) {
    totalRefundEscrow -= escrowed; // Decrements by FULL escrowed, even if refund was capped
} else {
    totalRefundEscrow = 0;
}
userEscrow[msg.sender] = 0; // FULLY zeroed even if shortfall

if (refundAmount > 0) {
    if (refundAmount <= totalRevenue) {
        totalRevenue -= refundAmount;
    }
    toweli.safeTransfer(msg.sender, refundAmount);
}
```

**Recommendation:** Either revert when the cap fires (force admin intervention), OR record `shortfall = escrowed - refundAmount` in a `mapping(address => uint256) shortfallOwed` and let users `claimShortfall()` once balance restored. Also add an event `RefundShorted(user, expected, actual)` so off-chain monitoring can detect the condition immediately.

---

## [DR-M-06] PremiumAccess: `subscribe` extension forfeits unconsumed escrow to `totalRevenue`, but cap on `withdrawToTreasury` makes it a flag-day rug
**Severity:** Medium
**File:** `contracts/src/PremiumAccess.sol:285-287, 426-432`
**Category:** premium

**Bug:** PA-M-01 fix (correctly) forfeits the unconsumed remainder of an extended subscription's old escrow into `totalRevenue` (line 286). But `withdrawToTreasury` only checks `balance - totalRefundEscrow`, NOT `balance - totalRefundEscrow - sumOf-other-reservations`. After PA-M-01, when a user extends, their old `userEscrow` is moved out of `totalRefundEscrow` but stays in `balance`. The owner can immediately call `withdrawToTreasury` to extract the forfeited remainder. **This converts what was meant to be earned-revenue (a slow drip into `totalRevenue` accounting) into an instant withdrawal, with no timelock, no event budget, no cap.**

**Attack / Impact:** The PA-M-01 fix description acknowledges this is intentional ("user paid for it, the protocol earned it"). But there is no rate-limit on `withdrawToTreasury`. Owner can drain the forfeited remainder in the SAME block as the user's extension, while the user is still inside the contract's mental model of "I'm subscribed for an extra month." The user has zero refund right against this new revenue.

The user-mental-model failure: a user who extends 1 day before their old subscription's expiry now forfeits ~99% of the old escrow as revenue. They believed they were "topping up" but are actually paying ~2x for the extension.

**Evidence:**
```solidity
// PremiumAccess.sol:285-287
if (remainingEscrow > 0) {
    totalRevenue += remainingEscrow;
}
// :426-432
function withdrawToTreasury() external onlyOwner nonReentrant {
    uint256 balance = toweli.balanceOf(address(this));
    uint256 withdrawable = balance > totalRefundEscrow ? balance - totalRefundEscrow : 0;
    if (withdrawable > 0) {
        toweli.safeTransfer(treasury, withdrawable);
    }
}
```

**Recommendation:** Pro-rate the extension's "consumed" portion ONLY (`escrow * elapsed / oldDuration`) into `totalRevenue`, and credit the unconsumed portion BACK to user via `userEscrow[msg.sender] += remainingEscrow` before adding `cost`. Mirror Curve's vesting-rollover pattern.

---

## [DR-M-07] ReferralSplitter `recordFee`/`claim*`/`withdrawCallerCredit` not gated by `setupComplete`
**Severity:** Medium
**File:** `contracts/src/ReferralSplitter.sol:300-362, 31-37`
**Category:** referral · gov

**Bug:** The contract's L-R02 NatSpec (line 31-37) explicitly states "until `setupComplete` is set, every external `record*` / `claim*` call reverts." But the implementation does NOT enforce this — `recordFee` (line 300), `claimReferralRewards` (line 368), `withdrawCallerCredit` (line 354), and `forfeitUnclaimedRewards` (line 535) all execute regardless of `setupComplete`. The only check is on `setApprovedCaller` (line 403). If the owner accidentally calls `setApprovedCaller(routerAddress, true)` BEFORE wiring the rest of the protocol — and a user happens to call any path that triggers `recordFee` — the contract starts crediting referral state with potentially-corrupted intent (e.g., before TWAP is wired into POL, before treasury is the final multisig).

**Attack / Impact:** Operational. A misdeploy by ops creates `pendingETH[referrer]` entries that survive the eventual `completeSetup()`, distorting referrer stats and giving early actors free pendingETH. Combined with a permanent referrer-link (line 196 — `AlreadyReferred`), early registrations cannot be reset.

**Evidence:**
```solidity
// ReferralSplitter.sol:300 — no setupComplete check
function recordFee(address _user) external payable onlyApproved nonReentrant { ... }
// :368
function claimReferralRewards() external nonReentrant { ... }
// :354
function withdrawCallerCredit() external nonReentrant { ... }
// L31-37 NatSpec contradicts implementation
```

**Recommendation:** Add `require(setupComplete, "SETUP_NOT_COMPLETE");` to `recordFee`, `claimReferralRewards`, `withdrawCallerCredit`, `forfeitUnclaimedRewards`, and `markBelowStake`. If the lockstep is intentionally non-blocking, REMOVE the L-R02 NatSpec.

---

## [DR-M-08] `accumulate()` `slippageMinToken` math incorrect under extreme TWAP/spot divergence — protocol over-pays for LP
**Severity:** Medium
**File:** `contracts/src/POLAccumulator.sol:406, 412-416`
**Category:** oracle · revenue

**Bug:** `slippageMinToken = mulDiv(toweliAmount, 10000 - maxSlippageBps, 10000)` is derived from the post-swap `toweliAmount`. The TWAP floor `twapMinLPToken` is computed from `_twapMinOut(weth, remainingETH)`. The final minimum is `max(slippage, backstop, twap)`. **If TWAP > spot (e.g., a recent down-move that hasn't fully reflected in TWAP)**, then `twapMinLPToken` exceeds `toweliAmount`, and `addLiquidityETH` reverts because `amountTokenDesired (toweliAmount) < amountTokenMin (twapMinLPToken)`. **If TWAP < spot** (which is the legitimate-pump scenario), the swap returned MORE TOWELI than TWAP would predict; `slippageMin*` = 95% of that, but `twapMin*` = 99.5% of (TWAP-implied TOWELI for remainingETH). When TWAP-implied is lower than actual `toweliAmount`, the TWAP floor is LESS protective than slippage.

The min-of-maxes pattern correctly takes the tightest bound, BUT the pattern depends on `toweliAmount` being a fair signal — under sandwich, `toweliAmount` is degraded and so is `slippageMin*`. The TWAP floor is the only attacker-independent floor, and `TWAP_SAFETY_BPS = 50` (0.5%) is tight enough that any volatility within TWAP_PERIOD causes false reverts.

**Attack / Impact:** Not a drain, but a DoS-on-volatility: legitimate accumulate calls revert during normal market moves of >0.5% over 30 minutes. Owner is forced to either widen `TWAP_SAFETY_BPS` (weakening protection) or accept a stalled accumulator. **Per the M-1/H-1 history, `MIN_BACKSTOP_BPS = 9000` (10% slippage) and `TWAP_SAFETY_BPS = 50` (0.5%) imply the backstop is the wide-band guard and TWAP is the tight floor — but the relationship between them depends on `toweliAmount` being trustworthy.**

**Evidence:**
```solidity
// POLAccumulator.sol:406-416
uint256 slippageMinToken = Math.mulDiv(toweliAmount, 10000 - maxSlippageBps, 10000);
uint256 slippageMinETH = Math.mulDiv(remainingETH, 10000 - maxSlippageBps, 10000);
uint256 backstopMinToken = Math.mulDiv(toweliAmount, backstopBps, 10000);
uint256 backstopMinETH = Math.mulDiv(remainingETH, backstopBps, 10000);
uint256 minToken = _minLPTokens;
if (slippageMinToken > minToken) minToken = slippageMinToken;
if (backstopMinToken > minToken) minToken = backstopMinToken;
if (twapMinLPToken > minToken) minToken = twapMinLPToken;
```

**Recommendation:** Replace the `slippageMin*` and `backstopMin*` (which are anchored to the post-swap `toweliAmount`) with TWAP-anchored equivalents: `slippageMin = mulDiv(twapImpliedTokenForRemainingETH, 10000 - maxSlippageBps, 10000)`. This makes ALL floors attacker-independent. Or, given they're now redundant with `twapMinLPToken`, remove the slippage/backstop floors on the LP-add leg entirely.

---

## [DR-M-09] `proposeForfeitReclaim` checks `reclaimEligibleAmount()` at propose-time but `eligible` is recomputed at execute-time — proposal can succeed at propose, then race to grow eligible at execute
**Severity:** Medium
**File:** `contracts/src/RevenueDistributor.sol:892-923`
**Category:** revenue · gov

**Bug:** `proposeForfeitReclaim` checks `_amount <= reclaimEligibleAmount()`. `executeForfeitReclaim` re-checks AND CAPS to `eligible` at execute. The asymmetry means: owner proposes 1 ETH (current eligible), but during the 48h delay, more epochs age past `DUST_RECLAIM_GRACE`, growing eligible to 5 ETH. The execute path will still drain only `min(amount, gap, eligible) = 1 ETH` because `pendingForfeitAmount = _amount` is locked at propose time. But the inverse race exists: if eligible SHRINKS during the 48h (because users grace-claimed), the execute caps `amount` down — fine.

**The actual issue:** there's no propose-time check of `lifetimeCap` against the EXECUTE-time `totalDistributed`. Combined with DR-H-02, an owner can chain: propose → cancel → propose → cancel → … until the lifetime cap allows the proposed amount, then execute. Because `_propose` rejects re-proposals (`ExistingProposalPending`), the chain requires `cancelForfeitReclaim → proposeForfeitReclaim`, each of which is two calls. Over a 30-day window of growing `totalDistributed`, the owner can drain cumulative amounts > 1% of the average `totalDistributed`. The cap math is "cumulative reclaimed / current totalDistributed ≤ 1%" — but `totalDistributed` ratchets monotonically up.

**Attack / Impact:** Slow rug. A consistently-growing protocol with predictable distribution cadence allows the owner to extract dust at the lifetime-cap rate indefinitely, NOT bounded by initial distribution.

**Evidence:** See DR-H-02 evidence; also the propose-time cap formula at line 902:
```solidity
uint256 lifetimeCap = (totalDistributed * MAX_LIFETIME_FORFEIT_BPS) / 10_000;
if (totalForfeitedReclaimed + _amount > lifetimeCap) revert ForfeitExceedsLifetimeCap();
```

**Recommendation:** Track lifetime-cap as `MAX_LIFETIME_FORFEIT_TOKEN` immutable absolute amount (e.g., 100 ETH lifetime cap) instead of percentage of (growing) `totalDistributed`. OR snapshot `totalDistributed` at first-ever forfeit-reclaim and use that frozen value as the cap denominator.

---

## [DR-L-01] PremiumAccess `_deprecated_paidFeeRate_slot` retained as `private mapping`, but Solidity does not zero-init the slot — storage layout is preserved BUT existing on-chain state is orphaned with no read path
**Severity:** Low
**File:** `contracts/src/PremiumAccess.sol:64`
**Category:** premium · other

**Bug:** PA-M-02 removed the read/write of `paidFeeRate` from `subscribe`/`cancelSubscription`. The mapping was renamed to `_deprecated_paidFeeRate_slot` and made `private`. For an existing deployment that has `paidFeeRate[user] = 1000e18` written for historical subscribers, the data is now permanent and inaccessible — there is no view function. Future code that re-uses the slot (the comment warns against this, but there's no enforcement) would corrupt historical state.

**Attack / Impact:** Pure data-loss / forensics — historical subscribers' stamped fee rate is now unreadable on-chain. Off-chain analytics can't distinguish "subscribed at 1000 TOWELI/mo" vs "subscribed at 500 TOWELI/mo" for users present in the legacy state.

**Evidence:**
```solidity
// PremiumAccess.sol:64
mapping(address => uint256) private _deprecated_paidFeeRate_slot;
```

**Recommendation:** Add a read-only view: `function getDeprecatedPaidFeeRate(address user) external view returns (uint256) { return _deprecated_paidFeeRate_slot[user]; }`. Or, if no reads are needed, document the orphaning as Info and keep the slot zero-init for fresh deployments.

---

## [DR-L-02] `executeSweepETH` no `block.timestamp >= deadline` cap — pending sweep can be replayed weeks later
**Severity:** Low
**File:** `contracts/src/POLAccumulator.sol:553-563`
**Category:** revenue

**Bug:** `proposeSweepETH` queues an amount and a 48h timelock. Once executable, the proposal stays valid until `_executeAfter[SWEEP_ETH_CHANGE] + PROPOSAL_VALIDITY` (7 days). Within that 7-day window, the executor can choose any moment to fire — including moments when more ETH has accumulated at the contract. The amount is locked to the propose-time figure, which is correct, but the EXECUTION time is unbounded within the 7-day window. If the proposal was made in good faith for 1 ETH and 6 days later the contract holds 10 ETH due to fee inflows, the 1 ETH sweep is still valid — but a later admin's review may not realize the proposal had matured into a fundamentally different operational context.

**Attack / Impact:** Operational only. Owner-key compromise scenarios: attacker who briefly holds the key can race to execute a months-old proposed sweep before guardian-cancel catches it.

**Evidence:** Standard `_execute` semantics in TimelockAdmin — `block.timestamp > readyAt + PROPOSAL_VALIDITY` is the only validity gate.

**Recommendation:** Add `executionDeadline` parameter to `proposeSweepETH`: store both `executeAfter` and `executeBefore`. Force tighter execution windows (e.g., 24h after maturity). Mirrors Compound Timelock's `gracePeriod`.

---

## [DR-L-03] `_calculateClaim` does not advance `lastClaimedEpoch` past zero-power epochs, accumulating gas overhead for users with sparse history
**Severity:** Low
**File:** `contracts/src/RevenueDistributor.sol:666-712`
**Category:** revenue · other

**Bug:** The loop iterates from `startEpoch` (= `lastClaimedEpoch[user]`) to `endEpoch` (= `epochs.length`). For epochs where `userPower == 0`, the inner `if (share > 0)` branch is never entered, but the outer iteration still runs. `actualEndEpoch = endEpoch` (no early-exit), so `lastClaimedEpoch[user]` becomes `endEpoch`. **This is correct for advancing the cursor**, but if the user is restaked-only and the entire epoch range had `votingPowerAtTimestamp = 0` and `_restakedPowerAt > 0`, every iteration calls `try restakingContract.boostedAmountAt(user, ts)` — a CALL into the restaking contract. With `MAX_CLAIM_EPOCHS = 250` and a restaker with 250 unclaimed epochs, that's 250 CALLs.

**Attack / Impact:** Gas inefficiency only. R064 already lowered `MAX_CLAIM_EPOCHS` from 500 → 250 explicitly because of binary-search + try/CALL gas. But the comment doesn't acknowledge the second-CALL (restaker fallback) that now ADDS to that cost.

**Evidence:**
```solidity
// :683-689
userPower += _restakedPowerAt(user, epoch.timestamp);
// _restakedPowerAt internally does try restakingContract.boostedAmountAt(...)
```

**Recommendation:** Cache the restaker's full epoch-range boostedAmount with a single batch call (`boostedAmountAtBatch(user, timestamps[])`), or short-circuit: skip `_restakedPowerAt` if `_isRestaked(user)` returns false.

---

## [DR-L-04] `setReferrer` does not check that `_referrer` themselves are not banned (forfeited)
**Severity:** Low
**File:** `contracts/src/ReferralSplitter.sol:193-215`
**Category:** referral

**Bug:** A referrer who has been forfeited via `forfeitUnclaimedRewards` (their pending was sent to treasury) is still a valid `_referrer` target. New users can `setReferrer(forfeitedReferrer)`, and `recordFee` will credit them via `pendingETH[forfeitedReferrer] += referrerShare` once they meet the stake gate again. There is no "banned referrer" set.

**Attack / Impact:** Operational/UX — attackers with a long-since-abandoned referrer account can suddenly resume earning by re-staking. Tracking the lifecycle of a referrer requires off-chain indexing.

**Evidence:** `setReferrer` only checks self-cycle and circular-chain.

**Recommendation:** Add `mapping(address => bool) public bannedReferrers;` and a `banReferrer(address)` admin path (timelocked) so post-forfeiture cleanup can mark a referrer as ineligible permanently.

---

## [DR-L-05] PremiumAccess `subscribe` extension at `block.timestamp < sub.startedAt + MIN_HOLDING_PERIOD` is allowed, but `cancelSubscription` enforces it — asymmetry can be exploited for fee-rate arbitrage
**Severity:** Low
**File:** `contracts/src/PremiumAccess.sol:227, 332`
**Category:** premium

**Bug:** `subscribe` (extension branch) does NOT enforce `block.timestamp >= sub.startedAt + MIN_HOLDING_PERIOD`. A user can subscribe at fee rate F0, immediately extend at the same rate F0 (locking it in), and now their `userEscrow` reflects rate F0 even if owner increases the fee minutes later. Combined with PA-M-01's reset of `startedAt = block.timestamp` on extension, the user effectively front-runs the fee change.

`cancelSubscription` requires `block.timestamp >= sub.startedAt + MIN_HOLDING_PERIOD`. So they can't cancel for 24h. But they CAN gain premium gating during that 24h. If owner is in mid-process of `proposeFeeChange → executeFeeChange` with a 24h delay, an attacker subscribes + extends in the SAME block to lock in the old rate for the full new period.

**Attack / Impact:** Rate-lock arbitrage. Bounded by 24h holding + the new-period commitment. Mostly economic-design issue.

**Evidence:**
```solidity
// :227 — subscribe has no MIN_HOLDING_PERIOD check
function subscribe(uint256 months, uint256 maxCost) external nonReentrant whenNotPaused { ... }
// :332 — cancelSubscription does
if (block.timestamp < sub.startedAt + MIN_HOLDING_PERIOD) revert MinHoldingNotMet();
```

**Recommendation:** Add `require(isNewSub || block.timestamp >= sub.startedAt + MIN_HOLDING_PERIOD, "TOO_SOON_TO_EXTEND");` to `subscribe`. Closes the same-block extend-during-fee-change path.

---

## Summary

| ID | Severity | File | Title |
|---|---|---|---|
| DR-H-01 | High | RevenueDistributor.sol | executeClaimRecovery bypasses pause + staking-paused checks |
| DR-H-02 | High | RevenueDistributor.sol | executeForfeitReclaim missing lifetime-cap re-check |
| DR-M-01 | Med | RevenueDistributor.sol | DUST_RECLAIM_GRACE collides with CLAIM_GRACE_PERIOD |
| DR-M-02 | Med | RevenueDistributor.sol + POLAccumulator.sol | Pause sibling miss across 9 owner mutators |
| DR-M-03 | Med | RevenueDistributor.sol | autoReconcileDust orphans dust on recovery-skipped epochs |
| DR-M-04 | Med | RevenueDistributor.sol | proposeClaimRecovery permanent-lockout via stale lastClaimedEpoch cursor |
| DR-M-05 | Med | PremiumAccess.sol | cancelSubscription contractBalance cap silently shorts users |
| DR-M-06 | Med | PremiumAccess.sol | extension forfeit + instant withdrawToTreasury = no-timelock revenue extraction |
| DR-M-07 | Med | ReferralSplitter.sol | setupComplete documented but not enforced on user paths |
| DR-M-08 | Med | POLAccumulator.sol | slippageMinToken anchored to attacker-controlled toweliAmount |
| DR-M-09 | Med | RevenueDistributor.sol | propose-vs-execute lifetime cap asymmetry enables slow rug |
| DR-L-01 | Low | PremiumAccess.sol | orphaned `_deprecated_paidFeeRate_slot` data |
| DR-L-02 | Low | POLAccumulator.sol | executeSweepETH validity window unbounded |
| DR-L-03 | Low | RevenueDistributor.sol | restaker fallback CALLs in zero-power loops |
| DR-L-04 | Low | ReferralSplitter.sol | no banned-referrer set |
| DR-L-05 | Low | PremiumAccess.sol | subscribe extension bypasses MIN_HOLDING_PERIOD |

**Most pressing:** DR-H-01 (pause bypass on executeClaimRecovery) and DR-H-02 (lifetime cap re-check) deserve fix + tests before next deploy. DR-M-01, DR-M-02, DR-M-04, DR-M-05 are real semantic gaps that follow the audit pattern of "half-installed mitigation." DR-M-03 is a sneaky perpetual fund-orphan vector.

The contracts have done excellent work on the headline issues (C5/H15/H16/H17/PA-M-01) but the M-7 sibling-search audit-pattern from MICROSCOPE_2026_04_30 has not been applied to the new fixes. The post-PA-M-01 extension-forfeit-into-totalRevenue path is the most concerning silent regression — it converts user funds into ungated owner revenue without any timelock, monitoring event, or off-chain cap.
