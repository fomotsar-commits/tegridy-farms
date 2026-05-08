# Agent 13/100 — RevenueDistributor.sol Fresh-Eyes Audit

**Target:** `contracts/src/RevenueDistributor.sol` (1429 lines)
**Lens:** claim staleness, donation attacks, ETH/ERC20 receive paths, sweep functions
**Date:** 2026-05-07

---

## Findings

### F-13-1 — View/write divergence in restaker fallback (multi-source holders) — MEDIUM

**Lines:** 766-768 (`_calculateClaim`) vs 1402-1404 (`_pendingETH`)

**Write path (`_calculateClaim`, line 766-768):**
```solidity
if (isRestaker) {
    userPower += _restakedPowerAt(user, epoch.timestamp);
}
```
ADDITIVE — sums staking-side power and restaking-side power.

**View path (`_pendingETH`, line 1402-1404):**
```solidity
if (userPower == 0 && isRestaked) {
    userPower = _restakedPowerAt(user, epoch.timestamp);
}
```
OR-FALLBACK — only consults restaking when staking-side power is zero.

**Impact:** A multi-source holder (e.g., NFT-A in TegridyStaking + NFT-B in TegridyRestaking) will see `pendingETH(user)` UNDERSTATE their actual claim. The view returns only the staking-side share; the actual `claim()` payout sums both. Frontend/indexer/keeper integrations will miscount, causing user confusion and potential reconciliation drift in off-chain accounting. The write-path fix referenced in the comments (REV-RESTAKE-01) was applied to the claim path but **not mirrored to the view**.

**Fix:** Replace the view-path check at line 1402-1404 with the additive form:
```solidity
if (isRestaked) {
    userPower += _restakedPowerAt(user, epoch.timestamp);
}
```

**Severity:** MEDIUM — correctness/UX bug; not theft-vector but breaks the fundamental view/write parity invariant that integrators rely on. Can cause keepers (which read the view to decide whether to trigger claims) to skip valuable claims and force user-side claims to mis-display ETH owed.

---

### F-13-2 — `distribute()` / `distributePermissionless()` not gated by `_isStakingPaused()` — MEDIUM

**Lines:** 332-335, 346-357, 359-415

`claim()`, `claimUpTo()`, and `executeClaimRecovery()` all check `if (_isStakingPaused()) revert StakingPaused();` to refuse using corrupt-state checkpoint data after the staking contract is paused for a discovered exploit (M-10). However, `_distribute()` reads from the SAME staking contract:
- Line 390: `votingEscrow.totalBoostedStakeAtTimestamp(snapshotTime)` (denominator)
- Line 400: `votingEscrow.totalBoostedStake()` (fallback denominator)

These values will reflect the corrupt staking state during the pause. `_distribute()` writes them into `epochs[i].totalLocked` PERMANENTLY — once pushed, the share calculations for that epoch are forever locked to the corrupt denominator.

**Attack scenario:**
1. Attacker exploits TegridyStaking to inflate their `votingPowerOf`/`totalBoostedStake` impact.
2. Protocol team detects and pauses the staking contract.
3. While staking is paused, attacker calls `distributePermissionless()` (still permissionless, no pause gate). New epoch is created with corrupted denominator and a `totalETH` they can claim against later.
4. After staking unpause/recovery, attacker claims their inflated share against the locked-in corrupt denominator.

**Defense gap:** the pause-gate is half-applied — read paths (claims) refuse to use corrupt data, but write paths (distribute) freely cement it.

**Fix:** Add `if (_isStakingPaused()) revert StakingPaused();` at the top of `_distribute()` (or alternatively at the entry of both `distribute()` and `distributePermissionless()`).

**Severity:** MEDIUM — depends on the exploitability of the upstream staking contract; the pause gate exists precisely because such bugs exist in scope. The asymmetry undermines the kill-switch's purpose.

---

### F-13-3 — `reclaimEligibleAmount()` unbounded scan — LOW (long-tail DoS)

**Lines:** 961-997

`reclaimEligibleAmount()` is a public view that iterates `epochs.length` with no cap, called by both `proposeForfeitReclaim` (line 1007) and `executeForfeitReclaim` (line 1026). Per-iteration work: 1 SLOAD for `epochs[i]`, 1 SLOAD for `epochClaimed[i]`, 1 SLOAD for `pendingRecoveryCount[i]`, plus arithmetic.

At ~4-hour distribution cadence, 5000 epochs ≈ 833 days = 2.3 years. Beyond that point, `proposeForfeitReclaim` and `executeForfeitReclaim` may exceed block gas limit and the forfeit-reclaim path becomes inaccessible.

**Severity:** LOW — long-tail issue, easily mitigated via paginated reclaim (similar to `claimUpTo`). Documented as a forward-compat concern; not exploitable today.

---

### F-13-4 — `executeTokenSweep` sweeps full ERC20 balance with no token-deny-list — LOW (informational)

**Lines:** 901-911

`executeTokenSweep` allows the owner to sweep ANY ERC20 balance after a 48h timelock. There is no exclusion list (e.g., to prevent sweeping the protocol's own governance token or staking-NFT-related ERC20s). The contract briefly holds WETH only mid-`withdrawPending` (deposit + transfer in same tx), so no residual WETH normally accumulates; donated WETH could be swept (intended).

This is informational — the timelock + onlyOwner is the intended defense, and there's no clear attack path. Worth noting that if a future code path causes the contract to hold protocol-critical tokens (e.g., users accidentally send TOWELI), the owner has unilateral 48h-delayed authority to redirect them. Not a vulnerability, but a centralization surface.

**Severity:** INFORMATIONAL.

---

## Notes / Dead Ends

- **Direct ETH donation via selfdestruct/coinbase:** documented at line 311. Falls into next epoch via `_distribute`'s `balance - reserved` calculation. Not an attack against the protocol — donor loses ETH, stakers gain it. `totalETHReceived` divergence from `address(this).balance` is the off-chain monitor signal (informational).
- **Direct ERC20 donation:** doesn't affect ETH accounting. Owner can sweep via timelocked `executeTokenSweep`. No inflation attack.
- **Sandwich snapshot-stake-claim:** both numerator (`votingPowerAtTimestamp(user, T-1)`) and denominator (`totalBoostedStakeAtTimestamp(T-1)`) read at the same T-1 anchor. Same-block stake/withdraw is excluded from BOTH sides. Resistant.
- **Sandwich via `totalBoostedStake()` fallback (line 399-401):** the fallback only triggers when historical reads 0 OR reverts; in practice the staking contract's Trace208 checkpoint will return non-zero post-genesis. The `MIN_DISTRIBUTE_STAKE = 1000e18` guard further bounds concentration attacks.
- **Stale-checkpoint claim:** historical checkpoint at `epoch.timestamp` is immutable, so user unstaking AFTER the epoch doesn't dilute their claim. Resistant.
- **Distribute callable by anyone — gas grief:** `MIN_DISTRIBUTE_INTERVAL = 4h` + `MIN_DISTRIBUTE_AMOUNT = 1 ETH` + `MIN_DISTRIBUTE_STAKE = 1000e18` triple-gate makes spam expensive (≥6 ETH/day to fill epochs, cost-prohibitive for non-actor). Acceptable.
- **2-step propose/execute front-run on finalize:** all execute paths are owner-only (`executeTreasuryChange`, `executeRestakingChange`, `executeForfeitReclaim`, `executeEmergencyWithdrawExcess`, `executeTokenSweep`). No public finalize → no front-run vector.
- **Distribute with `totalShares=0`:** `if (locked == 0) revert NoLockedTokens();` (line 402). Guarded.
- **Claim returning amount but transferring different amount:** `totalOwed` is computed once and used for both the `.call{value: totalOwed}` and the `pendingWithdrawals[msg.sender] += totalOwed`. Single source. No bug.
- **Revoke/blacklist user from claim:** no admin function to selectively block claims. Resistant.
- **Pause-bypass via emergency:** `executeEmergencyWithdrawExcess`, `sweepDust`, `executeTokenSweep`, `executeForfeitReclaim`, `reconcileRoundingDust`, `autoReconcileDust` all have `whenNotPaused`. `emergencyWithdraw` (the totalLocked==0 path) does NOT — but it requires all stakers to have unstaked already, so by definition no live claimer can be rugged. Acceptable.
- **forwardETHToWETH / wrap function:** there is no explicit `forwardETHToWETH` function. The WETH wrap path is internal in `WETHFallbackLib.safeTransferETHOrWrap`, called only with the contract's own ETH (from `pendingWithdrawals[msg.sender]`). Caller funds are NEVER wrapped — only contract funds owed to caller. No misuse.
- **`unchecked` in `receive()`** (line 316): `totalETHReceived` overflow only at 2^256 wei, exceeds total ETH supply. Safe.
- **`emergencyWithdraw` rugging grace-period claimers:** requires `totalBoostedStake() == 0` (no stakers AT ALL); also subtracts `unclaimed = totalEarmarked - totalClaimed` and `totalPendingWithdrawals` from withdrawable. Grace-period users' shares stay reserved.
- **`autoReconcileDust` dust-routing-forward:** dust from old epochs is added to `epochs[destEpoch].totalETH` AFTER the destination was created. Users who claimed the destination epoch BEFORE the auto-reconcile got a smaller share than users claiming after. Race condition is acknowledged design (active stakers absorb stragglers' dust). Not a vulnerability.
- **Recovery `share == 0` after `remaining == 0`:** revert path leaves proposal alive in `pendingRecoveries` with `pendingRecoveryCount[epoch]` still bumped — blocks `autoReconcileDust` and `forfeitReclaim` for that epoch until proposal expiry (7 days post-`executeAfter`). Stuck-state acceptable; admin can `cancelClaimRecovery` to clean up.
- **Reentrancy via WETH wrap:** `withdrawPending` follows CEI (state cleared before call); WETH is trusted/immutable (set at construction); 10k-gas stipend on raw ETH leg. No reentrancy.

---

## Summary

**Findings:** 4 (1 MEDIUM correctness, 1 MEDIUM pause-gate gap, 1 LOW long-tail DoS, 1 INFORMATIONAL).

**Top concerns:**
1. **F-13-1** — view/write divergence in restaker fallback for multi-source holders. The write path was fixed (REV-RESTAKE-01) to be additive; the view path was not. Frontend/keeper/indexer integrations will misreport pendingETH for users with both direct-staking AND restaking positions.
2. **F-13-2** — `distribute()`/`distributePermissionless()` lack the `_isStakingPaused()` gate that `claim()` has. During a staking-contract pause-recovery window, the distribute path can still cement corrupt-state denominators into new epochs — undermining the M-10 kill-switch's defense.

**No critical vulnerabilities identified.** The donation/sweep/sandwich/staleness defenses are all in place and well-documented. The two MEDIUMs are sibling-search misses where prior fixes were not propagated to all paths sharing the same invariant.
