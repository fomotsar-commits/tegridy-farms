# Forensic Audit 005 — TegridyStaking.sol

**Target:** `contracts/src/TegridyStaking.sol` (1,556 LOC)
**Auditor:** Agent 005 of 101
**Date:** 2026-04-25
**Scope:** AUDIT-ONLY (no code changes)
**Tests cross-checked:** TegridyStaking.t.sol (1,162L/83 tests), AuditFixes_Staking.t.sol (371L/17), Audit195_StakingCore.t.sol (946L/50), Audit195_StakingGov.t.sol (1,455L/94), Audit195_StakingRewards.t.sol (875L/38), RedTeam_Staking.t.sol (862L/34), FinalAudit_Staking.t.sol (879L/24). Total: 6,550 LOC / 340 tests.

---

## Summary
| Severity | Count |
|----------|-------|
| HIGH     | 2     |
| MEDIUM   | 4     |
| LOW      | 5     |
| INFO     | 4     |
| Test gaps| 5     |

---

## HIGH

### H-005-01 — `_accumulateRewards` rewardPerToken drift via `_reserved` shadow when `claimUnsettled` partially pays
**Location:** lines 463-481, 1054-1072.
**Hunt category:** reward math drift / claim race against rewardRate change.

`_accumulateRewards` clamps `reward` against `rewardPool = available - _reserved()` where `_reserved() = totalStaked + totalUnsettledRewards`. When a user's unsettled balance is partially paid in `_claimUnsettledInternal` (because `payout < amount`), `unsettledRewards[user]` and `totalUnsettledRewards` are decremented by `payout`, but the **untransferred remainder** (`amount - payout`) stays in `unsettledRewards[user]` with no totals tracking that residual against the pool. On the next `_accumulateRewards`, the contract treats those residual unsettled-but-uncovered tokens as "available reward pool" and credits them via `rewardPerTokenStored`, then the original recipient comes back later, succeeds in their second `claimUnsettled` (residual still set), and pulls those same tokens. Net: residual amount is paid twice (once into `rewardPerTokenStored` distribution, once back to the original recipient on retry). The cap path at 1054-1072 explicitly retains `unsettledRewards[_user] = amount - payout`, but the corresponding accounting reservation does not retain that delta.

**Recommended fix:** when partial payout happens, do **not** decrement `totalUnsettledRewards` by `payout` only — leave the residual reserved (`totalUnsettledRewards -= payout` is fine as long as `unsettledRewards[user]` is also zeroed). Either zero both and re-issue a `RewardsForfeited` event for the residual, or keep `totalUnsettledRewards` matching `sum(unsettledRewards)` exactly.

### H-005-02 — `_settleUnsettled` cap bypass leaks reward to active stakers, but `_getReward`'s rewardDebt advance still consumes the user's stake
**Location:** lines 941-985, 1431-1451.
**Hunt category:** reward math drift / partial-withdraw rounding loss to user.

In `_getReward`, `p.rewardDebt = accumulated` is committed before the shortfall fallback runs. If `_settleUnsettled` returns less than `shortfall` (cap hit), the per-position rewardDebt has already been advanced to the full accumulated value. The `RewardsForfeited` event fires, the comment claims forfeited amount "remains unreserved in the reward-pool balance and is re-accrued to all active stakers via the next `_accumulateRewards` cycle," but the **affected user has no claim on those tokens** going forward — their rewardDebt is already at the high-water mark. So a single user hitting the cap permanently transfers their already-earned reward into the pot for *other* stakers. This is the documented "fix" to M-3 according to the comment, but it's only correct if the affected user has no expectation of reclaim. There is no mechanism (such as reducing `rewardDebt` by the forfeited amount × ACC_PRECISION / boostedAmount) to make that user whole on a future fund-replenish. Effective UX: any user who hits the cap silently forfeits a portion of their reward to other stakers, even after the contract is refunded.

**Recommended fix:** instead of `p.rewardDebt = accumulated` at line 950 and forfeiting the shortfall, only advance rewardDebt by the actually-paid + actually-settled-into-unsettled amount, scaled back to boostedAmount × rewardPerTokenStored units. Alternatively, document that the cap is an intentional protocol-fee and the design is correct.

---

## MEDIUM

### M-005-01 — `notifyRewardAmount` allows whitelisted notifier to time fund-then-claim "windfall" within same block
**Location:** lines 1199-1210; tested at RedTeam_Staking `test_DEFENDED_firstRestakerNoWindfall`.
**Hunt category:** claim race against rewardRate change.

`notifyRewardAmount` simply increases `totalRewardsFunded` and the contract's TOWELI balance — it does NOT call `_accumulateRewards()`. The next user who interacts triggers `_accumulateRewards`, which now sees the entire delta as part of `available - _reserved()` and bumps `rewardPerTokenStored` proportionally to `(elapsed × rewardRate)` capped to `rewardPool`. Because `rewardRate` is constant, the "newly funded" tokens flow into the pool gradually over time — but on first interaction after funding, `rewardPool` jumps and the next `_accumulateRewards` distributes `min(elapsed × rate, rewardPool)` to existing stakers. A whitelisted notifier who is also a staker can: (1) time the funding immediately before a rate-up window, then (2) `getReward` to capture a disproportionate slice. The S5 fix moved `notifyRewardAmount` from permissionless to notifier-only, which mitigates third-party exploit but does NOT prevent a malicious notifier from self-dealing. NEW-S5 comment mentions this risk but the check is just `rewardNotifiers[msg.sender]`.

**Recommendation:** require notifyRewardAmount to come from the operations multisig only, or implement Synthetix-style `periodFinish` so newly-notified rewards stream linearly over a defined period rather than immediately bumping the pool.

### M-005-02 — `votingPowerOf` skips expired positions but `aggregateActiveBoostBps` shares same logic — flash-stake-then-vote possible within MIN_LOCK_DURATION
**Location:** lines 356-375, 397-414, 509-545 (stake), 705-722 (withdraw); tested in Audit195_StakingGov.
**Hunt category:** governance vote-power manipulation via flash stake.

`votingPowerOf` returns boosted voting power for any position with `nowTs < p.lockEnd`, including positions just minted in the same block (stakeTimestamp == block.timestamp). MIN_LOCK_DURATION is 7 days, so a flash-stake **cannot** be unwound within the same tx (no withdraw path until lock expiry, only earlyWithdraw with 25% penalty). However, governance snapshots that read `votingPowerOf` at the moment of vote casting will count freshly-minted positions immediately. If the governance contract uses `votingPowerAtTimestamp(user, ts)` with `ts` set to a snapshot block in the past, this is safe; if it uses live `votingPowerOf`, an attacker can borrow TOWELI, stake for 7 days at minimum boost, vote, then `earlyWithdraw` after the vote and pay 25% penalty if the vote outcome is worth it. The 7-day floor and 25% penalty raise the bar but don't eliminate it.

**Recommendation:** governance integration MUST use `votingPowerAtTimestamp(user, snapshotTs)` — never live `votingPowerOf`. Add a comment on the live function warning against snapshotless use, or remove the live function altogether.

### M-005-03 — `_decayIfExpired` writes a checkpoint but `getReward` doesn't, leaving stale voting power across reward claims
**Location:** lines 311-317, 758-769.
**Hunt category:** stale lastUpdateTime under DoS / governance vote-power manipulation.

`_decayIfExpired` (called from `_getReward`) zeroes a position's `boostedAmount` if its lock has expired, then writes a checkpoint. But `getReward` itself does NOT call `_writeCheckpoint(msg.sender)` afterwards. If the user owns multiple positions (contract wallet path), only one position's checkpoint gets re-written. `_writeCheckpoint` recomputes `votingPowerOf` (sum across all positions), so this is fine on the surface — but if the user has the autoMaxLock branch at lines 766-768, the lock is extended without recalculating boost via `_applyNewBoost`. The boost stays at whatever was last set, which may be stale relative to the new `lockDuration`. A user who triggered autoMaxLock years ago at MAX_BOOST is fine, but a user who toggled in/out of autoMaxLock could have boost mismatched against `lockDuration`. The voting-power checkpoint will still reflect cached boostBps so this isn't a vote-power exploit, but it can create reward-math inconsistency across positions.

**Recommendation:** in `getReward`, if `p.autoMaxLock`, also re-call `_applyNewBoost(p, MAX_BOOST_BPS + (p.hasJbacBoost ? JBAC_BONUS_BPS : 0))` to keep boost consistent with the auto-extended lockDuration.

### M-005-04 — `earlyWithdraw` and `executeEmergencyExit` use `_clearPosition` which always sets `userTokenId[msg.sender] = 0`, even if the caller owns multiple positions via contract wallet
**Location:** lines 1419-1429, 727-754, 1142-1177.
**Hunt category:** lock-period bypass / governance vote-power manipulation.

`_clearPosition` blindly does `userTokenId[msg.sender] = 0` regardless of how many positions `msg.sender` owns in `_positionsByOwner`. For a contract wallet (Safe, vault, restaking) holding 2+ positions, calling `withdraw` on one will null out `userTokenId[holder]` while the other position(s) still exist in `_positionsByOwner`. Voting-power aggregation continues to work (uses the set), but legacy single-pointer integrators reading `userTokenId[holder]` will see 0 even though positions remain. Tests do exercise multi-NFT holders for Safes via restaking, but specifically test only the aggregation path, not the post-`withdraw-one` state of `userTokenId`.

**Recommendation:** in `_clearPosition`, only set `userTokenId[msg.sender] = 0` if `_positionsByOwner[msg.sender].length() == 1` (i.e., this is the last one). Otherwise update it to one of the remaining positions (the latest set member would be a reasonable choice).

---

## LOW

### L-005-01 — `extendLock` allows extending past current `block.timestamp + MAX_LOCK_DURATION` only by checking `_newLockDuration > p.lockDuration`, not against `block.timestamp + _newLockDuration`
**Location:** lines 642-665. Edge case: if a position was created with `lockDuration=2yr` and 1.5yr has passed, calling `extendLock(2.5yr)` sets lockEnd to `block.timestamp + 2.5yr`, which is fine (LockEnd advances). But the check `_newLockDuration <= p.lockDuration` rejects ANY extension where the new requested duration is shorter than the original — even if the resulting absolute lockEnd would be longer than the current one. A position originally at 4yr with 3.5yr remaining can't be "extended" to 1yr-from-now even if that's longer than today's remaining lock. Effectively requires users to always specify the FULL duration from now, with the floor being the original duration. Counter-intuitive UX but not exploitable.

**Recommendation:** check `block.timestamp + _newLockDuration > p.lockEnd` instead of `_newLockDuration > p.lockDuration` to allow any forward extension.

### L-005-02 — `_returnJbacIfDeposited` sets `strandedJbacOwner` BEFORE the try-catch; if the catch path runs, `strandedJbacTokenId` is set but if it succeeds, both are deleted — race window exists if reentered via JBAC
**Location:** lines 1372-1390. The `safeTransferFrom` triggers `onERC721Received` on `to`, which can reenter. The `nonReentrant` guard on the parent (withdraw/earlyWithdraw/etc) prevents reentry, but `claimStrandedJbac` itself is also `nonReentrant`. The state ordering (`strandedJbacOwner[tokenId] = to;` before transfer) means if a reentrant call somehow reached this contract via a different entry, it would see stranded data. Mitigated by the `nonReentrant` on all entry points, but the pre-transfer assignment is inconsistent with the typical CEI pattern.

**Recommendation:** move `strandedJbacOwner[tokenId] = to;` into the catch block, only setting it if the transfer fails.

### L-005-03 — `MAX_REWARD_RATE = 100e18` capped at constructor and `proposeRewardRate`, but rate change has 48h timelock; recyclePenalty into rewardPerTokenStored has no rate cap
**Location:** lines 149, 1215-1228, 1526-1530. `_creditRewardPool` (called from earlyWithdraw / executeEmergencyExit penalty paths) directly adds to `rewardPerTokenStored` without going through the `MAX_REWARD_RATE` cap. A coordinated mass-exit could spike rewardPerTokenStored arbitrarily high in a single block, allowing a co-conspirator staker to claim massive rewards. Bounded by total penalty pool size which is bounded by total stakes, but still a non-rate-limited reward stream.

**Recommendation:** if the recycled-penalty mechanism is enabled (penaltyRecycleBps > 0), consider streaming the recycled portion via a `periodFinish` window rather than instantaneous credit.

### L-005-04 — `claimUnsettledFor` allows owner to claim on behalf of any user, but the user receives the funds (no fund redirection). Owner can force a claim transaction, paying gas, and pin the user's balance — an annoyance vector, not theft.
**Location:** lines 1048-1052. Owner-as-caller funnels rewards to the rightful recipient, but the user's `unsettledRewards[user]` is consumed. No way for the user to opt out of forced claims. Minor UX concern.

### L-005-05 — `tokenURI` returns "" by default (line 1465-1466); marketplace integrations that fetch metadata on-chain will see empty strings until governance sets a baseURI
**Location:** line 1465. Documented but easy to miss.

---

## INFO

### I-005-01 — `votingPowerOf` returns `0` for `restakingContract`, which forces all governance integrations to special-case the restaking path. Document this prominently in the integration guide.

### I-005-02 — `_writeCheckpoint` skips push when power is unchanged (NEW-S7 fix). This breaks any external system that watches for checkpoint events as a "transfer happened" signal — only state-change events are emitted now. `Transfer` event from ERC721 still fires, so the no-op is observable.

### I-005-03 — `_safeInt256` uses `uint256(type(int256).max)` comparison. Solidity 0.8.26 does this safely, but the comment about overflow in 1000+ years assumes `rewardRate ≤ 100e18` and `boostedAmount ≤ 4.5×totalSupply`. If MAX_REWARD_RATE is ever bumped, recompute the bound.

### I-005-04 — `MAX_POSITIONS_PER_HOLDER = 100` — gas cost of `votingPowerOf` at the cap is ~260k according to comment line 126. EIP-150 / 63/64 rule at 30M gas means callers should be able to call this from external contracts even at cap. Worst-case: 50 positions cost ~130k, doubles to ~260k at 100. Solid bound.

---

## Test gaps

1. **No invariant test for `totalUnsettledRewards == sum(unsettledRewards)`.** The H-005-01 finding hinges on this invariant being silently broken by partial-payout. Add a Foundry invariant.
2. **No fuzz test for `_settleUnsettled` cap-saturation across multiple users.** The H-005-02 forfeiture path is exercised once in `Audit195_StakingRewards.test_claimUnsettled_partialPayout_leavesRemainder`, but no test verifies that forfeited tokens redistribute correctly to the *other* stakers and not back to the affected user.
3. **No test for `_clearPosition` correctness when caller owns multiple positions via Safe wallet.** M-005-04 path is unexercised — Safe-wallet flow with 3+ positions, withdraw one, verify `userTokenId[safe]` and the remaining positions stay intact.
4. **No test for `extendLock` UX when current lockDuration > remaining lockEnd time.** L-005-01 case unexercised; need a test that locks for 4yr, fast-forwards 3.5yr, and asserts a 1yr extension is rejected.
5. **No fuzz test for recycle-penalty + getReward race within same tx.** L-005-03: test that an attacker who triggers recycle (via earlyWithdraw of a co-conspirator's position) and immediately claims doesn't get disproportionate reward.

---

## Cross-check status
| Test file | Coverage notes |
|-----------|----------------|
| TegridyStaking.t.sol | Solid coverage of stake/withdraw/getReward happy-path; 36 reward/rate tests |
| AuditFixes_Staking.t.sol | Targeted regression tests for prior audit fixes (M-04, M-05, H-1) |
| Audit195_StakingCore.t.sol | Core stake math and boost calculation; lacks per-holder cap fuzz |
| Audit195_StakingGov.t.sol | Voting-power aggregation; no flash-stake-then-vote test against M-005-02 |
| Audit195_StakingRewards.t.sol | Reward arithmetic; partial-payout tested but invariant gap remains (H-005-01) |
| RedTeam_Staking.t.sol | Adversarial scenarios; flash-loan JBAC / direct-transfer inflation defended |
| FinalAudit_Staking.t.sol | Late-stage audits; covers penalty rounding, dust |

**Risk profile:** the contract has been heavily audited (≥20 prior fix tags visible: H-1, H-01, M-3, M-04, M-05, M-21–M-24, C-02, C-04, C-05, L-06, L-13, L-23, L-28, etc.). The remaining HIGH findings are subtle accounting drifts that require invariant testing rather than unit testing to catch. Recommend adding Foundry invariant suites focused on `totalUnsettledRewards` and `rewardPerTokenStored` monotonicity.

