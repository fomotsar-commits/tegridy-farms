# Deep Audit (Pass 2) — TegridyStaking + TegridyStakingAdmin
**Date:** 2026-05-02
**Scope:** `contracts/src/TegridyStaking.sol` (1,768 LOC) + `contracts/src/TegridyStakingAdmin.sol` (340 LOC)
**Method:** Post-fix re-audit of commit `f7a0fc4` (DEEP-DS cluster, 13 findings closed). Focus on: (a) DS-01 + DS-02 fix verification, (b) regressions introduced by the fix, (c) NEW issues missed in pass 1, (d) interaction effects between the new `kick()` permissionless primitive and the rest of the reward surface.
**Prior pass excluded:** DS-01..DS-13 (closed in `f7a0fc4`). Microscope cluster C3/C4/H4, M-S1..M-S8, audit M/H/C series, R014, NEW-S/NEW-L all per pass-1 carry-over list. Pass-1 DEFER on DS-09 (whale rebate via own recycled fee) is left as-is per commit comment at L710-712.

---

## [DS2-01] `kick()` advances `p.rewardDebt` to full `accumulated` BEFORE `_settleUnsettled` returns — when `maxUnsettledRewards` cap is saturated, kicked users **permanently lose** their pre-expiry rewards
**Severity:** High
**File:** `contracts/src/TegridyStaking.sol:888-901`
**Category:** reward / griefing

**Bug:** The DS-02 fix correctly settles the holder's pre-expiry rewards into `unsettledRewards[holder]` via `_settleUnsettled`, BUT `_settleUnsettled` is gated by `maxUnsettledRewards` (the global unsettled cap, default `100_000e18`). When `totalUnsettledRewards` is near the cap, `_settleUnsettled(holder, cappedPending)` returns less than `cappedPending` — sometimes zero. The `forfeited = cappedPending - actualSettled` slice is emitted via `RewardsForfeited` and **silently lost**. Crucially, `p.rewardDebt = accumulated;` was already executed at L888 BEFORE the settle attempt, so the holder's `rewardDebt` has been advanced past these forfeited rewards. They are unreachable forever, even if the cap is later raised. Compare to `_getReward` (the user-initiated path) which has the same issue — but `_getReward` is initiated by the holder at their discretion, while `kick()` is permissionless and adversary-initiated.

**Attack / Impact:** Any third party can FORCE a holder into the forfeit branch by timing a `kick()` when `totalUnsettledRewards` is close to `maxUnsettledRewards`. Concrete sequence: (1) `maxUnsettledRewards = 100k`, `totalUnsettledRewards = 99.5k` (close to cap due to other users' transfers/kicks). (2) Bob's lock expires; he has 5k pre-expiry rewards. (3) Eve calls `staking.kick(bobTokenId)` → `cappedPending = 5k`, `unsettledRoom = 500`, `actualSettled = 500`, `forfeited = 4500`. (4) Bob's `p.rewardDebt` is now advanced past the full 5k — he has lost 4.5k forever. Bob can claim the 0.5k via `claimUnsettled`, but the 4.5k is gone. Even if Bob calls `getReward` later (which would re-decay the position via the autoMaxLock revival path or otherwise), the `rewardDebt` anchor blocks him from re-earning what was forfeited. Recoverability is zero. The attacker pays only the kick gas; the victim eats the loss. With even moderate adoption this is a constant drain.

**Evidence:**
```solidity
// L878-904 — kick()
function kick(uint256 tokenId) external nonReentrant whenNotPaused {
    Position storage p = positions[tokenId];
    if (p.amount == 0) revert NoPosition();
    uint256 prior = p.boostedAmount;
    if (prior == 0 || p.lockEnd == 0 || block.timestamp < p.lockEnd) revert NoOpKick();
    _accumulateRewards();
    address holder = ownerOf(tokenId);
    int256 accumulated = _safeInt256((prior * rewardPerTokenStored) / ACC_PRECISION);
    int256 diff = accumulated - p.rewardDebt;
    p.rewardDebt = accumulated;            // ← advanced FULL accumulated, before settle
    if (diff > 0) {
        uint256 pending = uint256(diff);
        uint256 available = rewardToken.balanceOf(address(this));
        uint256 reserved = _reserved();
        uint256 rewardPool = available > reserved ? available - reserved : 0;
        uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
        if (cappedPending > 0) {
            uint256 actualSettled = _settleUnsettled(holder, cappedPending);
            uint256 forfeited = cappedPending - actualSettled;  // ← LOST
            if (forfeited > 0) emit RewardsForfeited(holder, forfeited);
            ...
        }
    }
    _decayIfExpired(tokenId, p);
    emit PositionKicked(tokenId, msg.sender, prior - p.boostedAmount);
}

// L1625-1643 — _settleUnsettled
function _settleUnsettled(address user, uint256 amount) private returns (uint256 settled) {
    if (amount == 0) return 0;
    uint256 unsettledRoom = totalUnsettledRewards < maxUnsettledRewards
        ? maxUnsettledRewards - totalUnsettledRewards : 0;
    settled = amount > unsettledRoom ? unsettledRoom : amount;   // ← cap can return less
    ...
}
```

**Recommendation:** Set `p.rewardDebt` to reflect ONLY the actually-credited portion. Two options:

(a) Defer the rewardDebt advance until after the settle and only advance proportionally:
```solidity
uint256 actualSettled = _settleUnsettled(holder, cappedPending);
// Advance rewardDebt only by the amount actually settled — preserves the holder's claim
// to the forfeited slice if cap is later raised or another path can settle it.
p.rewardDebt = p.rewardDebt + _safeInt256(actualSettled + (rewardPool - cappedPending) /* pool shortfall is also unrecoverable */);
```

(b) Simpler & more aligned with `_getReward`: don't kick if the unsettled cap is full. Revert with a typed error so kickers can retry later:
```solidity
if (cappedPending > 0) {
    uint256 unsettledRoom = totalUnsettledRewards < maxUnsettledRewards
        ? maxUnsettledRewards - totalUnsettledRewards : 0;
    if (cappedPending > unsettledRoom) revert UnsettledCapWouldForfeit();
    ...
}
```
Option (b) is the safer default — the kick is anti-grief plumbing; if it can't preserve the holder's rewards, it should not run. The architectural finding C3/C4 (stale checkpoint trace) is still closed by `getReward`/`withdraw`/`extendLock` etc. holding the user-initiated decay path.

---

## [DS2-02] `kick()` does NOT route the `rewardPool` shortfall to `_settleUnsettled` — when the contract is under-funded, kicked users lose **EVERY post-rewardPool reward** silently
**Severity:** High
**File:** `contracts/src/TegridyStaking.sol:889-901`
**Category:** reward / accounting

**Bug:** Inside `kick()`, `cappedPending = min(pending, rewardPool)` caps the unsettled credit by the available reward pool. The shortfall `pending - cappedPending` is **silently dropped** — there is no follow-up `_settleUnsettled(holder, shortfall)` call, no `RewardsForfeited` event for it, and no mechanism for the holder to ever reclaim it. Compare to `_getReward` (L1121-1128) which explicitly handles this case:
```solidity
uint256 shortfall = pending - cappedPending;
if (shortfall > 0) {
    uint256 actualSettled = _settleUnsettled(recipient, shortfall);
    uint256 forfeited = shortfall - actualSettled;
    if (forfeited > 0) emit RewardsForfeited(recipient, forfeited);
}
```
The DS-02 fix replicated `_settleRewardsOnTransfer`'s pattern (which has the SAME bug) instead of `_getReward`'s post-fix pattern. Since `_getReward`'s shortfall handling was added explicitly to close "battle-tested critique 5.1", the kick fix should have inherited it.

**Attack / Impact:** Whenever the contract is under-funded (a real ops scenario — POLAccumulator harvest cycles, missed `notifyRewardAmount` calls, or a paused-rewardToken edge case where `available - reserved < accrued`), kicks against expired positions will silently lose the unfunded portion of the holder's pre-expiry yield. Combined with [DS2-01], an under-funded protocol PLUS a saturated unsettled cap means kicked users can lose 100% of their pre-expiry rewards with zero observability beyond the partial `RewardsForfeited` event (which only covers the unsettled-cap shortfall, NOT the rewardPool shortfall). **No event fires for the rewardPool shortfall in `kick()`.**

**Evidence:**
```solidity
// kick L889-901 — only cappedPending is processed
if (diff > 0) {
    uint256 pending = uint256(diff);
    uint256 available = rewardToken.balanceOf(address(this));
    uint256 reserved = _reserved();
    uint256 rewardPool = available > reserved ? available - reserved : 0;
    uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
    if (cappedPending > 0) {
        uint256 actualSettled = _settleUnsettled(holder, cappedPending);
        uint256 forfeited = cappedPending - actualSettled;       // ← unsettled-cap shortfall (emits)
        if (forfeited > 0) emit RewardsForfeited(holder, forfeited);
        if (actualSettled > 0) emit RewardPaid(holder, tokenId, actualSettled);
    }
    // ← MISSING: pending - cappedPending (rewardPool shortfall) is silently dropped
}

// _getReward L1121-1128 — has the proper shortfall handling
uint256 shortfall = pending - cappedPending;
if (shortfall > 0) {
    uint256 actualSettled = _settleUnsettled(recipient, shortfall);
    uint256 forfeited = shortfall - actualSettled;
    if (forfeited > 0) emit RewardsForfeited(recipient, forfeited);
}
```

**Recommendation:** Add the `_getReward` shortfall path to `kick()`:
```solidity
uint256 shortfall = pending - cappedPending;
if (shortfall > 0) {
    uint256 actualSettledShortfall = _settleUnsettled(holder, shortfall);
    uint256 forfeitedShortfall = shortfall - actualSettledShortfall;
    if (forfeitedShortfall > 0) emit RewardsForfeited(holder, forfeitedShortfall);
}
```
Apply the same fix to `_settleRewardsOnTransfer` (pre-existing bug, same pattern, same NEW-S5 reward-rate timing risk). Both paths should mirror `_getReward`'s post-critique-5.1 ordering.

---

## [DS2-03] `kick()` does NOT call `_touch(holder)` after crediting `unsettledRewards[holder]` — defeats the DS-04 fix on the parallel kick path; permits 90-day inactivity-gate bypass via owner-side `claimUnsettledFor`
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:889-901` (no `_touch(holder)`)
**Category:** gov / inactivity-gate

**Bug:** The DS-04 fix added `_touch(from)` to `_settleRewardsOnTransfer` to satisfy the R014 M-9 invariant: "every reward-touching path that materially affects unsettled rewards for `user` must `_touch(user)`." The DS-02 fix added a parallel `_settleUnsettled(holder, ...)` call inside `kick()` — which materially affects `unsettledRewards[holder]` — but did NOT add the corresponding `_touch(holder)`. Result: a holder whose only protocol activity is being kicked never has their `lastActivityAt` updated; the contract owner can call `claimUnsettledFor(holder)` 90 days after the kick (or immediately if `lastActivityAt[holder] == 0` from a never-active user) and force-claim the holder's unsettled rewards to the holder's wallet. Same vector class as DS-04, on a new code path.

**Attack / Impact:** Owner force-claim, not theft (rewards still go to `_user` per `_claimUnsettledInternal`). But violates the user-protection design intent of the inactivity gate — Bob expected to claim on his own schedule; instead the owner can force-execute his pending claim at an inopportune time (e.g., during a reward-token incident where Bob was waiting for resolution before claiming). With [DS2-01] as backdrop, an attacker-with-owner-rights could: (1) kick to credit unsettled, (2) immediately claimUnsettledFor to force-payout — bypassing the user's right to time their own claim.

**Evidence:**
```solidity
// kick L889-901: writes unsettledRewards[holder] but no _touch(holder)
if (cappedPending > 0) {
    uint256 actualSettled = _settleUnsettled(holder, cappedPending);
    ...
    // ← MISSING: _touch(holder)
}

// vs _settleRewardsOnTransfer L1164-1168 (post-DS-04 fix):
_touch(from);  // ← present

// vs claimUnsettledFor owner branch L1216-1222
if (msg.sender == owner()) {
    if (lastActivityAt[_user] + USER_INACTIVITY_GATE >= block.timestamp) revert Unauthorized();
    _claimUnsettledInternal(_user);
    return;
}
```

**Recommendation:** Add `_touch(holder)` inside `kick()`'s `if (diff > 0)` block (or equivalently, at the bottom of the function after the decay):
```solidity
if (diff > 0) {
    ...
    if (cappedPending > 0) {
        uint256 actualSettled = _settleUnsettled(holder, cappedPending);
        ...
        if (actualSettled > 0 || forfeited > 0) _touch(holder);
    }
}
```
The R014 M-9 invariant comment at L1077-1083 should be updated to explicitly enumerate the `kick` path.

---

## [DS2-04] `_accumulateRewards` continues to credit `rewardPerTokenStored` during a pause window — when the pause lifts, the next claimer captures the entire pause-period emission
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:513-531`
**Category:** reward / pause-asymmetry

**Bug:** With the DS-05 fix (`notifyRewardAmount` now `whenNotPaused`) and DS-03 fix (`kick` now `whenNotPaused`), the pause surface is more symmetric — but `_accumulateRewards` itself is unchanged. The function uses `block.timestamp - lastUpdateTime` to compute elapsed reward emission. During a pause, no entrypoint advances `lastUpdateTime` (all reward-touching paths are gated). When the pause lifts, the FIRST `_accumulateRewards` call (via `getReward` / `withdraw` / `notifyRewardAmount` etc.) sees an `elapsed` covering the entire pause duration and credits the full `elapsed * rewardRate` worth of `rewardPerTokenStored` to whoever's `boostedAmount` is non-zero at unpause-time. The first claimer captures a disproportionate slice of "rewards emitted while frozen."

**Attack / Impact:** Concrete sequence: (1) Owner pauses for 30 days for an incident. (2) During pause, `lastUpdateTime` stays at pre-pause time T0; no rewards accrued in storage. (3) Pause lifts at T0+30d. (4) Alice front-runs everyone with a `getReward` call at T0+30d+1s — `_accumulateRewards` computes `elapsed = 30d`, `reward = 30d * rewardRate` (capped at rewardPool), `rewardPerTokenStored += reward / totalBoostedStake`. Alice's `_getReward` immediately captures her share of this credit. Subsequent claimers in the same block also capture pro-rata. Users who can't act fast (e.g., autoMaxLock without a getReward call yet) lose nothing — they get pro-rata too — but the optical impact is "pause didn't actually pause emission, just deferred and lump-sum'd it." Could be disputed in governance as either a feature (frozen state, time-based emission honored) or a bug (pause should freeze emission too, mirroring Synthetix `RewardsDistributionRecipient.notifyRewardAmount` reset on call).

This is a NEW finding NOT documented in any prior pass. Pre-DS-05, the same scenario could be amplified by mid-pause `notifyRewardAmount` calls (the DS-05 motivation). With DS-05 fixed, the pure-emission-during-pause case remains.

**Evidence:**
```solidity
// L513-531 — _accumulateRewards: uses raw elapsed, no pause awareness
function _accumulateRewards() private {
    uint256 _totalBoosted = totalBoostedStake;
    if (block.timestamp > lastUpdateTime && _totalBoosted > 0) {
        uint256 elapsed = block.timestamp - lastUpdateTime;     // ← spans pause window
        uint256 reward = elapsed * rewardRate;
        ...
        if (reward > 0) {
            rewardPerTokenStored += (reward * ACC_PRECISION) / _totalBoosted;
        }
    }
    lastUpdateTime = block.timestamp;
}
```

**Recommendation:** If pauses are intended to freeze emission (recommended), add pause-aware accumulator state:
```solidity
uint256 public pausedAt;
function _pause() internal override {
    super._pause();
    _accumulateRewards();   // crystallise pre-pause emission
    pausedAt = block.timestamp;
}
function _unpause() internal override {
    super._unpause();
    lastUpdateTime = block.timestamp;   // skip pause-window emission
    pausedAt = 0;
}
```
This mirrors Compound's `Comptroller.setMintPaused` pattern. If pauses are intended NOT to freeze emission (acknowledged design choice), document it explicitly in the `pause()` NatSpec — currently it just says "Pause the contract (owner only)" with no mention of reward-emission semantics. Either way, the current ambiguity should be closed.

---

## [DS2-05] `_clearPosition` repointing picks `set.at(0)` (oldest position) — overrides the M-5 "latest position" semantic for the legacy `userTokenId` pointer, may cause off-chain integrators to read stale lock data
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:1604-1621`
**Category:** other / state-consistency

**Bug:** The DS-13 fix added `userTokenId[msg.sender] = set.at(0)` after `_burn`, replacing the prior unconditional zero-write. This is correct for "preserve a non-zero pointer for multi-NFT holders," but `EnumerableSet.UintSet.at(0)` returns whichever tokenId currently lives at index 0 — which depends on insertion/removal swap-and-pop history, not on insertion order. Pre-DS-13 (before M-5), `userTokenId[holder]` always reflected the MOST RECENTLY received tokenId (per the `_update` logic at L1067: `userTokenId[to] = tokenId`). Post-DS-13, after a clear, the pointer can flip to an OLDER tokenId. Legacy single-pointer integrators (frontends, indexers, other contracts) that read `staking.userTokenId(holder)` to find "the user's primary position" may now see a position that is older, has different lockEnd, or is itself expired — leading to wrong UX decisions ("you have no expirable position" when one is about to expire).

**Attack / Impact:** Off-chain integrator regressions, NOT a direct fund-loss. But: a contract that reads `staking.userTokenId(safe)` to gate logic ("if `userTokenId(safe) != 0`, treat them as an active staker") will see correct non-zero values, but the position metadata they read may be wrong. For example, a vault that pulls `(amount, boostBps, lockEnd, ...)` from `getPosition(userTokenId(safe))` to compute boost-weighted shares will get the OLDEST position's boost — silently penalizing the vault's depositors. The aggregate-aware path (`votingPowerOf`, `aggregateActiveBoostBps`) is correct; only legacy single-pointer integrators are affected.

**Evidence:**
```solidity
// L1611-1618 — repoint logic
_burn(tokenId);
EnumerableSet.UintSet storage set = _positionsByOwner[msg.sender];
if (set.length() > 0) {
    userTokenId[msg.sender] = set.at(0);  // ← arbitrary surviving index, NOT "latest"
}
```
The `_update` invariant at L1067 sets `userTokenId[to] = tokenId` on every inbound, so semantically `userTokenId` was "most recent received." Post-DS-13, after a clear, that semantic breaks.

**Recommendation:** Pick the **most recently received** surviving position rather than `set.at(0)`. Track most-recent in storage:
```solidity
// Add: mapping(address => uint256) public lastReceivedTokenId;
// In _update on the to-side: lastReceivedTokenId[to] = tokenId;
// In _clearPosition: userTokenId[msg.sender] = lastReceivedTokenId[msg.sender] is in set ? lastReceivedTokenId[msg.sender] : set.at(set.length()-1);
```
Or simpler — use `set.at(set.length() - 1)` (last-inserted by EnumerableSet semantics, though still subject to swap-pop reordering). Or just document that `userTokenId(holder)` post-DS-13 is "any surviving position" and integrators should migrate to `_positionsByOwner` views (`userPositionCount`, iterate via subgraph). Update DS-13 NatSpec at L1598-1603 to call out this caveat.

---

## [DS2-06] `kick()` is permissionless and pause-symmetric, but its NatSpec promises "anti-dilution cleanup" — actual emergent behaviour is "force-claim Bob's pre-expiry rewards into unsettled, where Bob now bears the unsettled-cap and rewardPool shortfall risk"
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:858-904` (NatSpec mismatch)
**Category:** other / docs-drift

**Bug:** The L858-877 NatSpec describes `kick()` as "Force the lazy-decay path on an expired position whose owner has not interacted since `lockEnd`" — framed as a benign anti-dilution primitive. But the post-DS-02 implementation also moves the holder's pre-expiry rewards into `unsettledRewards[holder]`, exposing them to: (a) the unsettled-cap shortfall ([DS2-01]), (b) the rewardPool shortfall ([DS2-02]), (c) the inactivity-gate bypass ([DS2-03]), (d) the user's own `claimUnsettled`-tx gas burden, and (e) any forced-pause where unsettled cannot be claimed (via the `whenNotPaused` on `claimUnsettled`). A holder who would otherwise claim via `getReward` (immediate transfer) is downgraded to claim-via-unsettled (deferred, capped, paused-blocked). The NatSpec should call out that `kick()` is **not** a no-op for the holder — it materially shifts their reward-receipt mechanics.

**Attack / Impact:** Documentation-trust regression, not a direct exploit. But the lack of warning means integrators / dashboard authors / users may fail to anticipate the post-kick reward path and miss `RewardsForfeited` / `unsettledRewards` accounting in their views. Combined with [DS2-01] / [DS2-02] / [DS2-03], the actual semantics diverge sharply from the documented "decay-only cleanup."

**Recommendation:** Update the NatSpec to explicitly state:
```solidity
/// @notice CALLER NOTICE: Kick MOVES the holder's pre-expiry rewards from "directly
///         claimable via getReward" to "unsettled, claimable via claimUnsettled"
///         (paused-blockable, capped, may forfeit if either cap saturates). Holders
///         who want full control should call `getReward` BEFORE their lock expires.
///         This function exists to close the C3/C4 stale-checkpoint window when the
///         holder is unreachable or unwilling to act.
```
Bonus: surface a pre-kick view `simulateKick(tokenId) returns (uint256 paid, uint256 forfeitedToUnsettledCap, uint256 forfeitedToRewardPool)` so kickers can avoid kicks that would forfeit. Adds ~50 LOC, gated by frontend value not on-chain criticality.

---

## [DS2-07] `revalidateBoost` on an EXPIRED legacy-grandfathered position transiently re-applies a downgraded boost, granting one block of post-expiry rewards
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:916-959`
**Category:** math / lock-mechanics

**Bug:** `revalidateBoost` does NOT reject expired positions (no `LockExpired` check, unlike `extendLock` post-DS-06 and `increaseAmount`). When the JBAC-downgrade branch fires (L945-957), the flow is: (a) `_getReward` settles pre-expiry rewards correctly per M-01 — internally decays boostedAmount to 0; (b) `p.hasJbacBoost = false`; (c) `_applyNewBoost(p, newBoost)` recalculates `p.boostedAmount = (p.amount * newBoost) / BOOST_PRECISION` — **restoring boost to the downgraded value on an EXPIRED position**. The position's `lockEnd` is unchanged (still in the past), so the next `_getReward` call would re-decay. But between this revalidate and the next interaction, the position contributes to `totalBoostedStake` again. Worse: the user's `rewardDebt` is anchored at `p.boostedAmount * rewardPerTokenStored / ACC_PRECISION` (per `_applyNewBoost` L1592). On the user's NEXT `_getReward`, they earn rewards for the elapsed time at the downgraded boost — a free post-expiry one-block earnings window.

**Attack / Impact:** Edge case. Triggers only when a legacy grandfathered position (`hasJbacBoost=true && jbacDeposited=false`) loses its JBAC AND is past lockEnd. Rare overlap. Bounded reward extraction is `(p.amount * downgradedBoost / BOOST_PRECISION) * (rewardRate * timeUntilNextDecay) / totalBoostedStake` — typically pennies. But the asymmetry is real: same flow on `extendLock` is now blocked (DS-06 fix), but `revalidateBoost` was missed.

**Evidence:**
```solidity
// L945-957 — revalidateBoost downgrade branch, no expiry guard
if (p.hasJbacBoost && !currentlyHoldsJbac) {
    _getReward(tokenId, p);             // decays inside if expired
    p.hasJbacBoost = false;
    uint256 newBoost = calculateBoost(p.lockDuration);
    _applyNewBoost(p, newBoost);        // RESTORES boost on (now-decayed) expired position
    _writeCheckpoint(positionOwner);
    emit BoostRevalidated(tokenId, false, p.boostedAmount);
}
```
Compare to extendLock L707 (post-DS-06): `if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();`

**Recommendation:** Add the same expiry guard to `revalidateBoost` — a holder whose JBAC was lost AND whose lock has expired should withdraw + re-stake fresh, not get a free post-expiry boost slot:
```solidity
if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
```
Place the check after the `p.amount == 0` guard. This is a one-line addition that closes parity with the DS-06 / increaseAmount pattern.

---

## [DS2-08] `applyLendingContract(false)` revoke check uses `balanceOf(_lending)` — count includes ALL ERC721 NFTs at that address, not just staking NFTs. A non-staking NFT held by `_lending` would block revoke
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:1517-1521`
**Category:** gov / cleanup

**Bug:** The DS-10 fix uses `balanceOf(_lending) > 0` to detect "lending contract still escrows staking NFTs." But `balanceOf` is the standard ERC721 view returning the count of NFTs FROM THIS COLLECTION held at the address. Since `TegridyStaking` IS the ERC721 collection, this returns the staking-NFT count. **However**, the comment says "while the lending contract still holds escrowed staking NFTs" — this is technically correct since `balanceOf` here only counts staking NFTs (not other collections). So the bug is NOT what it seems on first read.

**Real issue**: a STALE position (`p.amount == 0` after a `_clearPosition` ran on a tokenId held by `_lending`) — wait, `_clearPosition` calls `_burn`, which removes the NFT from the holder's balance. So `balanceOf` decrements correctly. So the check is sound for actual escrow.

**The actual edge case**: if the lending contract sends a staking NFT to itself (ownerOf(tid) == _lending) but the position was already withdrawn AND somehow the NFT wasn't burned — impossible in current code, but defensive flag.

Downgrading severity: the DS-10 fix is essentially correct; this is a false alarm on closer inspection. Keep this entry as a documentation-clarity note: the NatSpec should explicitly say `balanceOf` here means "staking-NFT count at the lending address" since the contract IS the ERC721. Single-line clarity tweak.

**Recommendation:** Update the NatSpec at L1512-1516 to explicitly note `balanceOf` is `IERC721(staking).balanceOf(_lending)` (i.e., this contract's own ERC721 balance) and not a generic NFT count. No code change needed.

---

## Summary

**Severity distribution (NEW pass-2 only — exclusive of pass-1 closed findings):**

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 2     |
| Medium   | 2     |
| Low      | 4     |

**One-line per finding:**

- **DS2-01** [High] `kick()` advances rewardDebt before settle — when `maxUnsettledRewards` saturated, kicked users permanently lose their pre-expiry rewards (kick is adversarial-initiated, unlike `_getReward`)
- **DS2-02** [High] `kick()` does not route the rewardPool shortfall to `_settleUnsettled` — entire post-pool slice silently dropped, no event, no recovery (regression vs `_getReward`'s post-fix shortfall handling)
- **DS2-03** [Medium] `kick()` no `_touch(holder)` — defeats DS-04's R014 M-9 invariant on the parallel kick path; permits owner-side `claimUnsettledFor` 90-day-gate bypass
- **DS2-04** [Medium] `_accumulateRewards` continues crediting `rewardPerTokenStored` during pause — entire pause-period emission lump-distributed to first post-unpause claimer
- **DS2-05** [Low] `_clearPosition` repoint picks `set.at(0)` (oldest), not "latest received" — breaks M-5 single-pointer semantic for legacy integrators
- **DS2-06** [Low] `kick()` NatSpec frames as benign anti-dilution; actual behavior shifts holder rewards to capped/paused-blockable unsettled — docs drift
- **DS2-07** [Low] `revalidateBoost` no expiry guard — legacy-grandfathered position past lockEnd gets transient downgraded-boost re-application; one block of post-expiry yield. Asymmetric with DS-06 (extendLock now guarded) and increaseAmount.
- **DS2-08** [Low] `applyLendingContract(false)` `balanceOf` semantic — NatSpec clarity tweak only; no code change required.

**Single-PR closures (high leverage):**
1. **DS2-01 + DS2-02 + DS2-03 + DS2-06** — `kick()` reward-preservation hardening: (a) revert on unsettled-cap overflow OR proportional rewardDebt advance, (b) route rewardPool shortfall through `_settleUnsettled`, (c) `_touch(holder)`, (d) NatSpec update. Same surface, four fixes.
2. **DS2-04** — pause-aware `_accumulateRewards` (or NatSpec acknowledgement of design choice).
3. **DS2-05 + DS2-07** — small parity fixes (DS-13 repoint semantics + revalidateBoost expiry guard).

**Verification of DS-01 (Critical) fix:**
- `withdraw()` correctly settles rewards via `_getReward` BEFORE clearing position. PASS.
- `_getReward` correctly decays AFTER settling (M-01 ordering preserved). PASS.
- `kick()` correctly settles holder's pre-expiry rewards into unsettledRewards. PASS — but with three quality issues (DS2-01, DS2-02, DS2-03) on the settle path itself.
- All other entry points (`emergencyWithdrawPosition`, `executeEmergencyExit`, `earlyWithdraw`, `emergencyExitPosition`) verified as NOT pre-decaying before settlement. `emergencyWithdrawPosition` explicitly forfeits rewards (acknowledged in NatSpec). All others call `_getReward` first which has the M-01 ordering. PASS.
- DS-04 `_settleRewardsOnTransfer` `_touch(from)` fires correctly inside `if (diff > 0)`; `from = address(0)` is impossible because `_settleRewardsOnTransfer` is only called when `from != address(0) && to != address(0)`. PASS.
- DS-05 `notifyRewardAmount whenNotPaused` correctly applied. PASS — but see DS2-04 for the broader pause-emission concern.
- DS-06 `extendLock` rejects expired correctly. PASS. Note: `revalidateBoost` not similarly guarded — see DS2-07.
- DS-07 `kick()` NoOpKick guard handles `lockEnd == 0` (never-locked) via the `p.lockEnd == 0` clause at L882. PASS.
- DS-10 `applyLendingContract(false)` blocks revoke correctly. PASS — see DS2-08 for NatSpec clarity.
- DS-12 `setStakingAdmin` `_admin.code.length > 0` correctly catches EOA typo. Test deploys must construct admin contract first (test setup at `Deep_Staking_2026_05_01.t.sol:46-47` does this correctly). PASS.
- DS-13 `_clearPosition` repoint preserves a non-zero pointer for multi-NFT holders. PASS — but see DS2-05 for the "oldest vs latest" semantic concern.
