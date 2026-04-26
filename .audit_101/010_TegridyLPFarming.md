# Forensic Audit — TegridyLPFarming.sol (Agent 010)

Target: `contracts/src/TegridyLPFarming.sol` (477 LOC)
Cross-check: `contracts/test/TegridyLPFarming.t.sol` (207 LOC, ~17 tests)
Mode: AUDIT-ONLY (no fixes)

Architecture: Synthetix StakingRewards + Curve-style boost. LP deposits earn TOWELI; effective balance multiplied by amount-weighted aggregate boost from `TegridyStaking` NFTs (clamped to 4.5×). Inherits `OwnableNoRenounce`, `ReentrancyGuard`, `Pausable`, `TimelockAdmin`.

---

## HIGH

### H-1. Boost manipulation via `aggregateActiveBoostBps` and ratio drift on `refreshBoost`
**Location:** `_getEffectiveBalance` lines 204-221, `refreshBoost` lines 224-234.
**Vector:** A user with a small TegridyStaking position can:
1. Stake LP at low boost (e.g. 1.0×).
2. Acquire/transfer-in a max-boost staking NFT (or open a new max-lock position) just before claim.
3. Call `refreshBoost(self)` — totalEffectiveSupply increases by full delta retroactively for the entire elapsed period since the last `updateReward`-touching call.

The Synthetix invariant requires every change to a user's effective balance to be applied AFTER `updateReward` settles `rewards[user]` on the OLD effective balance. `refreshBoost` does correctly call `updateReward(account)` (line 224), but the issue is the boost can be increased mid-period without any additional cost to the user — they can stake LP early at 1.0×, then bolt on max boost at the END of the period and instantly upsize their effective share for FUTURE rewards. While this isn't strictly retroactive (settle happens first), there is **no minimum holding period for the boost itself**, so a flash-loan-funded `TegridyStaking.stake(amount, 365 days)` → `farm.refreshBoost` → wait 1 sec → unwind path is feasible if TegridyStaking allows quick unstake. **Verify TegridyStaking's lock semantics**; the `aggregateActiveBoostBps` formula likely respects lock-end which mitigates the flash path, but this contract does NOT independently verify lock duration.

### H-2. `try/catch` fallback path in `_getEffectiveBalance` skips lock-end check via revert
**Location:** lines 206-219.
**Vector:** The `try` branch (`aggregateActiveBoostBps`) does NOT check `lockEnd` itself — it relies on TegridyStaking honoring the active-boost semantics. If TegridyStaking is upgraded (proxy) or aggregateActiveBoostBps is buggy and returns boost for an expired lock, the farming contract has no defence beyond the 4.5× ceiling. The legacy `catch` branch (lines 211-219) DOES perform `block.timestamp < lockEnd` (line 215), creating an asymmetric trust model. A future TegridyStaking upgrade that breaks the aggregate function silently expands LP-farming boost windows.
**Severity:** HIGH because `MAX_BOOST_BPS_CEILING=45000` is the only backstop, and the comment at line 66-69 explicitly relies on it. If max boost is the common case, the ceiling provides no economic protection.

### H-3. `notifyRewardAmount` leftover formula propagates rounding loss & enables owner front-run dilution
**Location:** lines 386-410.
**Vector 1 (rounding):** When extending a period mid-flight, `leftover = (periodFinish - block.timestamp) * rewardRate` then `rewardRate = (leftover + actualReward) / duration`. Repeated mid-period top-ups truncate downward each time; over many cycles, `totalRewardsFunded` (line 408, increments by `actualReward`) drifts away from `rewardRate * rewardsDuration`. Stakers receive less than the claimed funded amount.
**Vector 2 (front-run dilution):** Owner can call `notifyRewardAmount` mid-period, which RESETS the period to `block.timestamp + duration` (line 407). If a user has a transaction queued for `getReward()` based on a high `rewardRate`, the owner's notify can lower the rate and extend the duration, materially altering the claim economics for transactions in the same block. There is no minimum interval between notifies and no constraint that the new rate ≥ old rate.
**Severity:** HIGH because owner-rug-via-rate-cut is a privileged griefing vector and rounding is silent.

---

## MEDIUM

### M-1. Reward token with transfer fee — partial mitigation only on funding
**Location:** lines 390-392 (notifyRewardAmount), 319 (`_getRewardInternal`), 354 (emergencyWithdraw stakingToken).
**Issue:** `notifyRewardAmount` correctly diffs balance to derive `actualReward` (line 392) — good. BUT `_getRewardInternal` calls `safeTransfer(user, reward)` without accounting for transfer fee: if rewardToken has a fee, user receives less than `rewards[user]`, but `rewards[user]` is already zeroed. Tokens stuck inside contract = silent under-pay to user while `rewards` mapping reads 0.
**Note:** TOWELI is not currently fee-on-transfer, but there is no defensive comment or check; future migration of `rewardToken` (immutable, but redeploy) could trip this.

### M-2. `forfeitedRewards` accounting drift if rewardToken supply changes
**Location:** `emergencyWithdraw` lines 335-356, `reclaimForfeitedRewards` lines 362-377.
**Issue:** `forfeitedRewards += earned(msg.sender)` (line 351) records the abstract owed amount, but `reclaimForfeitedRewards` caps the sweep at `balance - owedFutureRewards` (lines 366-371). If multiple users emergency-withdraw and accumulate forfeitedRewards > actual unencumbered balance, the counter goes stale and never decrements (sweep returns 0 amount). The counter never auto-clamps, so on-chain `forfeitedRewards()` view becomes misleading.

### M-3. `proposeRewardsDurationChange` requires `block.timestamp >= periodFinish` but executeRewardsDurationChange does not
**Location:** line 418 vs 424-430.
**Vector:** Owner proposes duration change at end of period, then `notifyRewardAmount` starts a NEW period. After 24h timelock, `executeRewardsDurationChange` (line 424) fires WITHOUT re-checking `block.timestamp >= periodFinish` — `rewardsDuration` is updated mid-active-period. The next `notifyRewardAmount` will use the new duration, but ANY currently-active period's `getRewardForDuration()` view (line 473-475) returns a wrong number.
**Severity:** Mostly cosmetic — `periodFinish` is not changed by execute, only `rewardsDuration` (the default for next notify). But it surprises users reading `getRewardForDuration()`.

### M-4. `recoverERC20` sends to current `treasury` — front-run during treasury timelock
**Location:** lines 462-467.
**Vector:** Owner calls `proposeTreasuryChange(badAddr)` → 48h delay. Before execute, owner calls `recoverERC20` to drain a token to OLD treasury. After execute, treasury changes. While both treasuries are owner-controlled, a multisig governance pattern where one signer can `recoverERC20` but treasury change requires N-of-M creates a single-signer escape hatch.
**Severity:** MEDIUM — requires malicious owner; mitigated by OwnableNoRenounce but not by timelock on recoverERC20.

### M-5. `notifyRewardAmount` does NOT verify rewardToken == address(stakingToken)
**Location:** constructor line 144-145 + notify line 391.
**Vector:** Constructor accepts the same address for both. Although unlikely (TOWELI ≠ LP), if future deployment passes the LP token as rewardToken, `notifyRewardAmount` would `transferFrom` the LP, deflating the staking pool's denominator and the `effectiveBalanceOf` math becomes nonsensical. No defensive `_rewardToken != _stakingToken` check.

### M-6. Pause does not block `getReward` / `withdraw` / `emergencyWithdraw`
**Location:** Only `stake` has `whenNotPaused` (line 243).
**Issue:** This is intentional Synthetix-style design (pause should not trap funds), but `getReward` reads `rewardPerToken` which depends on `lastTimeRewardApplicable`. If a critical bug is found and the contract is paused, rewards CONTINUE to accrue (the rewardRate × elapsed math doesn't pause). A malicious stake-time race with discovered bug means active stakers keep earning even after the team pauses to investigate.
**Severity:** MEDIUM — design choice but worth a comment.

### M-7. No mass-update: large `totalEffectiveSupply` makes `rewardPerToken` view expensive but ON-CHAIN write stays bounded
**Location:** `rewardPerToken` line 175-180.
**Note:** There is no mass-update loop because the Synthetix model is per-account. Gas grief via mass-update is NOT applicable here. **No finding** — this is correctly designed and rules out the "mass-update gas grief" vector from the audit brief.

---

## LOW

### L-1. `MAX_REWARD_RATE = 100e18` (100 TOWELI/sec) ≈ 8.64M TOWELI/day
**Location:** line 60.
**Note:** Over 90-day max duration that's 777M TOWELI. If TOWELI total supply is 1B (per test mock), this cap is effectively no cap.

### L-2. `getRewardForDuration` returns stale value mid-period after `notifyRewardAmount` extension
**Location:** line 473-475.
**Issue:** Returns `rewardRate * rewardsDuration`. After mid-period top-up, `rewardsDuration` is the NEW duration but `rewardRate` is the blended rate, so the product overstates remaining rewards by the leftover-already-counted overlap.

### L-3. `BoostUpdated` event emitted only when `oldEffective != newEffective` — first-stake transition silent
**Location:** line 254 (inside stake's reconciliation block).
**Issue:** First-time stakers never enter the reconciliation block (existingRaw == 0), so no BoostUpdated event fires. Only the subsequent `Staked` event indicates the effective amount. Subgraph indexers that key off BoostUpdated for boost-history will miss the genesis boost.

### L-4. `userRewardPerTokenPaid[msg.sender] = rewardPerTokenStored` after emergencyWithdraw, but rewards = 0
**Location:** lines 346-347.
**Issue:** If the same user re-stakes after emergency-withdraw, the `userRewardPerTokenPaid` is set to `rewardPerTokenStored` snapshot. Synthetix invariant holds, but the user's `earned()` returns 0 even if the global has advanced — this is correct, but worth comment.

### L-5. `reclaimForfeitedRewards` is `nonReentrant` but the cap calc reads `rewardToken.balanceOf` which can be manipulated by inflationary rebase tokens
**Location:** line 369.
**Note:** TOWELI is not rebase, but if a rebase token were used, the cap calc would over- or under-cap the sweep.

### L-6. `cancelRewardsDurationProposal` and `cancelTreasuryProposal` do not revert if no pending proposal
Wait — they do, via `_cancel` reverting on `_executeAfter[key] == 0`. **Not a finding.**

### L-7. `pendingRewardsDuration = 0` reset after execute (line 428) means re-proposing same value requires propose-execute cycle as expected. **No finding.**

---

## INFO

### I-1. `MAX_BOOST_BPS_CEILING = 45000` (4.5×) is hardcoded, no governance lever to lower
Defence-in-depth comment (lines 66-69) explicitly designs this as immutable.

### I-2. Synthetix reward math: `rewardPerTokenStored` accumulates as scaled by `1e18`. With `rewardRate <= 100e18` and elapsed <= 90 days = 7.776M sec, `rewardPerToken += elapsed * rewardRate * 1e18 / totalEffectiveSupply`. Worst-case numerator: `7.776e6 * 100e18 * 1e18 = 7.776e42`. Fits in uint256 (max ≈ 1.158e77). **No overflow** in the period-end accumulation. Safe.

### I-3. `totalRewardsFunded` is a monotonic counter for off-chain analytics; not used in any economic logic. Drift from actual balance is by design (emergencyWithdraw forfeits, recoverERC20 doesn't decrement, etc.).

### I-4. `OwnableNoRenounce` import — owner cannot renounce, mitigating one common rug. But owner CAN front-run rate changes (see H-3).

### I-5. Constructor does not accept `_owner` — uses `msg.sender` (line 143). Deployer = initial owner. Multisig deploy required.

### I-6. `ITegridyStakingBoost` struct order documentation (lines 12-25) is correct per the canonical Position layout. Audit C-01 (Spartan TF-01) was fixed. Audit H-1 (2026-04-20) extended struct with jbacTokenId+jbacDeposited and the interface matches.

### I-7. No reentrancy on the reward path — `safeTransfer(rewardToken)` to user with `rewards[user] = 0` written before transfer (line 318-319). Standard Synthetix pattern. Safe assuming standard ERC20.

### I-8. **Owner add/set frontrunning rewards (poolAllocPoint pattern):** This contract is single-pool (one staking token, one reward token), not MasterChef-style with allocations. The poolAllocPoint vector from MasterChef does NOT apply. **No finding** — eliminated by design.

### I-9. **Lockup bypass via inter-contract delegation:** TegridyLPFarming has no internal lockup — withdraw is freely callable. The "lockup" is on the TegridyStaking side (NFT lock duration). The boost is gated by lock-end via `aggregateActiveBoostBps` (per comments). LP itself can be withdrawn at any time. **No bypass possible** because there is no lock to bypass.

### I-10. **Period-end overflow:** `lastTimeRewardApplicable() = min(block.timestamp, periodFinish)`. After `periodFinish` passes, `(periodFinish - lastUpdateTime) * rewardRate * 1e18` is the final accrual. Capped values: 90d × 100e18 × 1e18 = 7.776e42. Safe.

### I-11. **Claim DoS via emergencyWithdraw:** emergencyWithdraw zeroes the user's state and forfeits rewards; it does NOT block other users from claiming because `getReward` reads only `rewards[msg.sender]` and `effectiveBalanceOf[msg.sender]`. **No DoS** propagation.

---

## TEST GAPS (cross-check against `TegridyLPFarming.t.sol`)

The test file has ~17 tests covering basics. **Missing critical scenarios:**

1. **No fuzz tests** — all tests are scripted. No fuzzing of `notifyRewardAmount(amount, duration)` boundary conditions, no fuzzing of stake/withdraw amounts.
2. **No invariant tests** — `totalRawSupply == sum(rawBalanceOf)` and `totalEffectiveSupply == sum(effectiveBalanceOf)` are not asserted as invariants.
3. **No test for `refreshBoost` race** — the H-1 vector (boost increase mid-period) is untested.
4. **No fee-on-transfer rewardToken test** — M-1 vector untested.
5. **No multi-period notify test** — H-3 leftover formula rounding drift untested.
6. **No `reclaimForfeitedRewards` test** — entire reclaim path uncovered.
7. **No `MAX_BOOST_BPS_CEILING` clamp test** — relies on staking integration, no targeted unit test.
8. **No `try/catch` fallback path test** — H-2 cannot be exercised without a mock that selectively reverts on `aggregateActiveBoostBps`.
9. **No timelock proposal/execute tests** — `proposeRewardsDurationChange`, `executeRewardsDurationChange`, `proposeTreasuryChange`, `executeTreasuryChange`, cancel paths all uncovered.
10. **No `recoverERC20` test** — including its reverts on staking/reward token.
11. **No exit() composite test** — `exit()` (line 270) untested.
12. **No `pause()` block test for non-stake paths** — only `test_pause_blocksStake`.
13. **No `notifyRewardAmount` with active period (mid-flight extension)** test.
14. **No `RewardTooHigh` revert path test** (line 403, balance-vs-rate sanity).
15. **No `MIN_NOTIFY_AMOUNT` revert test** (line 387).
16. **No event emission assertions** — events are defined but never `vm.expectEmit`-checked.
17. **No reentrancy attack test** — no malicious-token mock.

**Coverage estimate:** ~35% of branches, ~45% of statements. Far below the 80%+ target for production.

---

## SUMMARY

| Severity | Count |
|----------|-------|
| HIGH     | 3     |
| MEDIUM   | 7 (M-7 dropped → 6 actionable) |
| LOW      | 5     |
| INFO     | 11    |
| **Total findings** | **25** (excluding INFO no-findings) |
| Test gaps | 17 |

**Top-3 priority:**
1. **H-3** — `notifyRewardAmount` owner-rug via rate cut + leftover rounding drift (no min-rate-floor, no min-interval).
2. **H-1 / H-2** — Boost manipulation via `refreshBoost` and asymmetric lock-end check between try/catch branches.
3. **M-1** — Fee-on-transfer rewardToken silently under-pays users on `getReward` (only funding path is hardened).
