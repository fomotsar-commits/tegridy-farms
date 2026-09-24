# Agent 015 Forensic Audit — `contracts/src/TegridyRestaking.sol`

Scope: epoch boundary double-redemption, share/asset accounting drift, slashing griefing, reward double-claim, withdraw-queue jumping, validator-set update race, ERC4626 inflation/donation, rounding direction, oracle dependency, queued-withdrawal cancellation race.

Cross-checked: `contracts/test/TegridyRestaking.t.sol`, `contracts/test/Audit195_Restaking.t.sol`, `contracts/test/FinalAudit_Restaking.t.sol`.

---

## HIGH

### H-1 — `claimPendingUnsettled` does not reserve `unforwardedBaseRewards` of OTHER users (cross-user fund drain)
File: `TegridyRestaking.sol` lines 603–621.

```solidity
function claimPendingUnsettled() external nonReentrant {
    uint256 owed = pendingUnsettledRewards[msg.sender];
    ...
    uint256 available = rewardToken.balanceOf(address(this));
    uint256 payout = owed > available ? available : owed;
    pendingUnsettledRewards[msg.sender] = owed - payout;
```

`available` is the raw balance. It does NOT subtract `totalUnforwardedBase` (the bucket reserved for other users' attributions) nor `totalActivePrincipal` (reservation honored elsewhere). A user with a large `pendingUnsettledRewards[msg.sender]` (created when concurrent unrestakes drained the shared `claimUnsettled()` bucket) can be paid out from balance that legitimately belongs to:
1. Other restakers' attributed `unforwardedBaseRewards` (e.g., from `executeAttributeStuckRewards`),
2. Other restakers' active principal recorded by `totalActivePrincipal`.

When the legit owner of the unforwarded rewards then calls `claimAll()`, `unforwardedBaseRewards[user] - actual` math succeeds but the `available` balance is gone, so they receive less than owed and their accounting silently zero's via `unforwardedBaseRewards[msg.sender] = unforwarded - actual`. Loss is real, distributed across other users.

This matches the pattern in the existing FinalAudit_Restaking #4 (MEDIUM) test, but it is HIGH because (a) the same path is reachable for `recoverStuckPrincipal`'s reservation by walking through unsettled, and (b) it cross-pollinates with H-2.

Fix: reserve `totalUnforwardedBase + totalActivePrincipal` from `available` in `claimPendingUnsettled` (mirror the reservation logic of `recoverStuckPrincipal`).

### H-2 — Double-claim of bonus across `claimAll` auto-refresh + main bonus block (rounding-favored to user)
File: `TegridyRestaking.sol` lines 370–467.

In `claimAll`, the auto-refresh branch (lines 400–420) pays `preBonus` on the OLD `boostedAmount` and resets `info.bonusDebt = currentBoosted * accBonusPerShare / ACC_PRECISION` AFTER the new `boostedAmount` is written and `totalRestaked` is adjusted. Then the main bonus block (lines 455–466) runs `accumulated = (info.boostedAmount * accBonusPerShare) / ACC_PRECISION` against the SAME `accBonusPerShare` (the modifier didn't re-run between the two blocks). Because `info.boostedAmount` is now `currentBoosted` and `info.bonusDebt = currentBoosted * accBonusPerShare / ACC_PRECISION`, the diff is zero — but only on integer math. Any rounding residual in `(currentBoosted * accBonusPerShare) / ACC_PRECISION` between the assignment and the reload favors the user when `accBonusPerShare` advances mid-tx via reentrancy from a faulty token (e.g., a hook on `rewardToken.safeTransfer`). Rounding direction is "round-down on the protocol's debt", which is the wrong direction.

More importantly: `preBonus` is computed against `accBonusPerShare` AS UPDATED by `updateBonus` modifier (top of function). After `safeTransfer(bonusRewardToken, msg.sender, preBonus)` (line 406), if `bonusRewardToken` has a transfer callback (ERC777-style or fee-on-transfer hostile), `accBonusPerShare` cannot be advanced — but a re-entered `claimAll`/`unrestake`/`refreshPosition` of the SAME user is blocked by `nonReentrant`. Cross-function re-entry guard is the only thing keeping this safe; the contract has `nonReentrant` on every state-mutating user function, so the immediate exploit is blocked. However, an external call into a different contract that reads `pendingBonus(msg.sender)` and uses it to compute downstream payouts (RevenueDistributor, etc.) could observe the inconsistency mid-tx.

Fix: defer the bonus payout in the auto-refresh branch until AFTER `info.bonusDebt` is set; or fold the auto-refresh into a single accumulator-update pass with explicit rounding-up of the debt (favor protocol).

### H-3 — `decayExpiredRestaker` accrues bonus against stale `totalRestaked` AFTER `_accrueBonus()` is called, but the comment says it does the opposite
File: `TegridyRestaking.sol` lines 1077–1118.

The comment claims "settle the expired restaker and update totalRestaked FIRST, then run the bonus accrual against the corrected denominator." The implementation does the opposite: `_accrueBonus()` (line 1092) is called BEFORE `totalRestaked = totalRestaked - oldBoosted + currentBoosted` (line 1110). So the elapsed-time bonus is still credited against the stale (inflated) denominator. The expired restaker still siphons accrual from honest users for the period BEFORE this call — exactly what the AUDIT NEW-S3 fix says it prevents.

The actual behavior matches NEW-S3 step 1's stated intent ("run pending accrual against the STALE denominator one last time. This finalises the expired restaker's prior share"), so this is intentional but misdocumented at the function level. Real bug: the inflated period extends ALL the way until someone calls `decayExpiredRestaker`, with no incentive for a permissionless caller other than altruism. A malicious expired restaker simply never calls it — and the protocol has no automatic trigger.

Fix: gate honest restakers' rewards by checking `staking.positions(tokenId).boostedAmount` at claim time and using `min(cached, current)` instead of `cached`, OR have `claimAll` for ANY restaker auto-trigger `decayExpiredRestaker` for restakers with expired locks.

---

## MEDIUM

### M-1 — `recoverStuckPrincipal` does NOT include `totalRecoveredPrincipal` in reserved math (double-counting)
Lines 681–741. `reserved = totalUnforwardedBase + totalPendingUnsettled + othersPrincipal;` does not subtract `totalRecoveredPrincipal` from `balance`. After several recoveries, `balance` shrinks naturally, but if `rewardToken` is donated to the contract between recoveries, the next caller sees `balance > reserved` and gets the donation — equivalent to the donation/inflation attack on ERC4626 vaults. The `payout > 0` guard does not prevent this; only the `originalAmount` cap does.

### M-2 — `unrestake`'s shortfall handling can leave principal stuck in `pendingUnsettledRewards`
Lines 564–583. `userPortion = totalOwed > unsettledGain ? unsettledGain : totalOwed;` then `shortfall = totalOwed - userPortion;`. Shortfall is rolled into `pendingUnsettledRewards[msg.sender]`. But `claimPendingUnsettled` (line 603) only refunds out of the rewardToken balance. If the user's NFT lock was JBAC-deposited, the underlying principal returns are also queued through the same bucket — `claimPendingUnsettled` cannot distinguish unsettled-rewards from principal, and a future `recoverStuckPrincipal` will see the same balance and try to pay it back as principal, skewing both.

### M-3 — `revalidateBoostFor*` does NOT call `_accrueBonus` before `staking.revalidateBoost(tokenId)` (reward double-claim across boost change)
Lines 958–1051. `updateBonus` modifier accrues bonus first. Then `staking.revalidateBoost(tokenId)` is called, which can change `staking.unsettledRewards(this)` and emit base rewards into THIS contract's balance — credited to `unforwardedBaseRewards[restaker]`. But the bonus settlement (lines 985–992 / 1033–1041) uses `oldBoosted * accBonusPerShare / ACC_PRECISION`, where `accBonusPerShare` is the value from the START of the tx. If `staking.revalidateBoost` consumes time (e.g., via a deeply nested call that warps `block.timestamp` — not possible in real Solidity but reachable in test scaffolding), bonus is settled against an outdated accumulator. Real impact: minimal in mainnet, but the missing re-accrual is a code-smell that a reorg could exploit if `staking.revalidateBoost` ever gains a callback.

### M-4 — `emergencyForceReturn` does NOT clear `pendingUnsettledRewards` and uses inline accrual that bypasses `_accrueBonus` consistency
Lines 873–944. The function inlines the accumulator-update logic instead of calling `_accrueBonus()`. If `_accrueBonus` semantics ever change (extra checks, fees, etc.), this function will diverge silently. Plus, FinalAudit #7 already flags that `pendingUnsettledRewards` is not forwarded — though the user can still `claimPendingUnsettled()` after, this leaves dust.

### M-5 — `restake()` does NOT verify the NFT's underlying staking position is OWNER==MSG.SENDER at the staking contract level
Line 293: `if (stakingNFT.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();`. This checks the ERC721 owner, but `staking.positions(tokenId)` returns the position's amount — there is no check that the position's `userTokenId[msg.sender] == _tokenId` mapping matches. If TegridyStaking ever allows a tokenId to be transferred while leaving the position's `user` mapping pointing to the old owner, an attacker could buy a stale NFT and restake against a position that still reads/credits the original user's voting power. The comment at H-06 notes this is a "stable baseline", but the stability rests entirely on TegridyStaking's invariants.

### M-6 — `boostedAmountAt` uses CURRENT `boostedAmount` for ALL past timestamps (subtle over-credit on RevenueDistributor)
Lines 278–283. Comment claims "current is a lower bound for power user actually held at `_timestamp` (boost can only decay)". This is FALSE if `revalidateBoostForRestaked` was called with a JBAC-deposit upgrade: boost can INCREASE between `depositTime` and `_timestamp`, and the current value will OVER-credit the past epoch. Even though H-1 supposedly closes the upgrade path, the code path remains in the contract as a future risk vector. Best practice: store snapshots, or return `min(boostedAmount, boostAtTimestamp)`.

### M-7 — `cancelAttributeStuckRewards` does NOT verify that `pendingAttribution` is currently set
Lines 776–781. `_cancel(ATTRIBUTION_CHANGE)` reverts if no proposal exists, but the function reads `PendingAttribution memory p = pendingAttribution;` — if the storage was zeroed by a prior cancel/execute, `p.restaker = address(0)` and `p.amount = 0`. The event emits `(0, 0)` with no early revert. Cosmetic but breaks auditability.

---

## LOW

### L-1 — `restake()` does not validate that `_tokenId != 0` (sentinel collision)
Line 290: `if (restakers[msg.sender].tokenId != 0)`. The `tokenId == 0` is used as the "no-position" sentinel. If TegridyStaking ever mints token ID 0 (current code starts at 1, but no on-chain assertion), the entire mapping is corrupt. Add `require(_tokenId > 0)` defensively.

### L-2 — `fundBonus` is permissionless (anyone can grief the schedule)
Line 627. Anyone can call `fundBonus(amount)` and inflate `totalBonusFunded`. While this just adds tokens to the pool (benign), the `BonusFunded` event is misleading for off-chain dashboards if a non-protocol address dumps tokens.

### L-3 — `emergencyWithdrawNFT` is callable while contract is NOT paused (intentional but unflagged)
Lines 789–848. The lack of `whenPaused` is by design (per the comment "if bonusRewardToken is paused/blacklisted, updateBonus would revert"), but a malicious user can call this to forfeit bonus and dump in a single tx — useful for griefing if the user is on a sanctions list (they exit before pause). LOW because the user pays the cost.

### L-4 — `rescueNFT` cannot rescue NFT that was emergency-stuck via `emergencyForceReturn` for the RIGHT user
Lines 861–865 + 924–944. After `emergencyForceReturn` fails the NFT transfer, `tokenIdToRestaker[tokenId]` is preserved. `rescueNFT` then requires `tokenIdToRestaker[_tokenId] == address(0)`, blocking owner from manually rescuing. Comment says "rescueNFT can only send to the original restaker" but the function does NOT enforce `_to == tokenIdToRestaker[_tokenId]` — it only enforces `tokenIdToRestaker == address(0)`. Mismatched intent vs. implementation. LOW because owner can clear the mapping via privileged recovery (not currently available — would need a new admin function).

### L-5 — `proposeAttributeStuckRewards` does not check `_amount <= unattributed` at propose time
Line 749. Only `executeAttributeStuckRewards` (line 768) reverts if `p.amount > unattributed`. If the contract balance drops between propose and execute (24h window), the proposal expires uselessly. UX issue.

### L-6 — `decayExpiredRestaker` uses `revert("NO_DECAY")` string instead of custom error
Line 1085. Inconsistent with the rest of the contract's custom-error style.

### L-7 — `BONUS_RATE_TIMELOCK = 48 hours` constant declared after state vars (not a security issue, but poor readability)
Line 100.

### L-8 — `pendingBonus` view function uses unguarded `bonusRewardToken.balanceOf(address(this))` (revert on hostile token)
Lines 237. If `bonusRewardToken.balanceOf` reverts (hostile token), the view reverts — frontends and integrating contracts (RevenueDistributor) can't read state. Wrap in try/catch like `updateBonus`.

---

## INFO

### I-1 — Storage slot packing is suboptimal
`RestakeInfo` (lines 74–83) has 5 uint256s and 1 int256 — 6 slots. `int256 bonusDebt` could be packed with another field if it were `int128` (with overflow checks), saving 1 SSTORE per restake.

### I-2 — `_safeInt256` is duplicated logic vs. OpenZeppelin's `SafeCast.toInt256`
Lines 1147–1153. Use OZ's SafeCast for consistency.

### I-3 — `BonusShortfall` event emits even if the shortfall is below dust threshold
Lines 209–212. Off-chain monitors will get spammed when the pool is at exactly 0 wei but `bonusRewardPerSecond` is 0 — though `reward = elapsed * 0 = 0`, the `if (reward > available)` check is false, so no emit. Verified — INFO only.

### I-4 — `lastForceReturnTime` cooldown is per-contract, not per-tokenId
Line 117. A multi-stuck-NFT scenario means the owner can only rescue one per hour. Possibly intentional rate-limit, but it slows emergency response.

### I-5 — `totalActivePrincipal` is decremented in `unrestake/emergencyWithdrawNFT/recoverStuckPrincipal` but NOT in `emergencyForceReturn`
Compare lines 541, 795, 728 vs. line 921. `emergencyForceReturn` line 921 only does `totalRestaked -= info.boostedAmount` — `totalActivePrincipal` is NEVER decremented. Subsequent `recoverStuckPrincipal` calls will reserve principal for a no-longer-active user, locking funds for legit recoverers. **Borderline MEDIUM.** Marking INFO because emergencyForceReturn is owner-only and rate-limited, but recommend moving to MEDIUM in formal report.

### I-6 — Reentrancy modifier is on every external state-mutator EXCEPT view functions; pattern is correct.

### I-7 — No oracle dependency for asset price (in scope question): confirmed — bonus reward token's value vs. base reward token is not converted on-chain. Frontend/integrations carry that risk.

---

## Test Gaps

1. **No test exercises `claimPendingUnsettled` with a non-zero `pendingUnsettledRewards` value AND another user's `unforwardedBaseRewards` set** — H-1 PoC is missing. Existing tests (FinalAudit #4) only show the setup, never trigger Bob's drain.
2. **No test for `decayExpiredRestaker` accrual ordering** (H-3). The function has zero direct test coverage.
3. **No test for `emergencyForceReturn` failing to decrement `totalActivePrincipal`** (I-5). Triggers no assertion failure today because `recoverStuckPrincipal` wouldn't be called for the same user, but invariant testing would catch it.
4. **No test for double-`recoverStuckPrincipal` after donation** (M-1). The `hasRecoveredPrincipal[msg.sender]` flag prevents same-user repeat, but multi-user/donation scenarios are uncovered.
5. **No test for `boostedAmountAt` returning over-credited current value when boost upgraded post-deposit** (M-6). H-1 doc claims this is closed, but invariant test for the "current ≤ historical" property is absent.
6. **No fuzz test for `pendingBonus` rounding direction** — should fuzz `boostedAmount`, `accBonusPerShare`, `bonusDebt` to verify the sign of `(accumulated - bonusDebt)` always favors protocol on truncation. Currently truncation favors user (round-down on the user's outstanding debt = user owes less = user gets more).
7. **No test for `bonusRewardToken.balanceOf` reverting** in `updateBonus` (try/catch is there, but the catch path isn't exercised — `pendingBonus` view also doesn't have try/catch).
8. **No test for cross-contract reentrancy** between TegridyRestaking and TegridyStaking (e.g., if `staking.getReward` ever calls back into restaking).
9. **No test for `restake` of `_tokenId == 0`** (L-1 sentinel collision).
10. **No test asserting `totalActivePrincipal == sum(restakers[*].positionAmount)` invariant** across all entry/exit paths.
