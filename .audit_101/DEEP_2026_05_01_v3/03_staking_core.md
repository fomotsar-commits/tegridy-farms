# Deep Audit (Pass 3) — TegridyStaking + TegridyStakingAdmin
**Date:** 2026-05-02
**Scope:** `contracts/src/TegridyStaking.sol` (1,891 LOC) + `contracts/src/TegridyStakingAdmin.sol` (340 LOC)
**Method:** Post-fix re-audit of commit `d6b1f5b` (DEEP-DS v2 cluster, 8 findings closed). Focus on: (a) DS2-01..DS2-08 fix verification, (b) regressions introduced by the v2 fix, (c) NEW issues missed in pass-1 + pass-2, (d) parity check between `kick()` and the rest of the reward surface (`_settleRewardsOnTransfer`, `withdraw`, `toggleAutoMaxLock`).
**Prior pass excluded:** DS-01..DS-13 (closed in `f7a0fc4`); DS2-01..DS2-08 (closed in `d6b1f5b`). Microscope cluster C3/C4/H4, M-S1..M-S8, audit M/H/C series, R014, NEW-S/NEW-L all per pass-1/pass-2 carry-over list. Pass-1 DEFER on DS-09 (whale rebate via own recycled fee) is left as-is per commit comment at L740-742.

---

## [DS3-01] `_settleRewardsOnTransfer` STILL silently drops the rewardPool shortfall — DS2-02 sibling-fix was promised in pass-2 and not delivered; every NFT transfer permanently strands the post-pool slice
**Severity:** High
**File:** `contracts/src/TegridyStaking.sol:1245-1279`
**Category:** reward / accounting

**Bug:** Pass-2 DS2-02 explicitly called for the same shortfall handling to be added to `_settleRewardsOnTransfer` ("Apply the same fix to `_settleRewardsOnTransfer` (pre-existing bug, same pattern, ... Both paths should mirror `_getReward`'s post-critique-5.1 ordering"). The `d6b1f5b` fix commit closed `kick()` only, leaving `_settleRewardsOnTransfer` unchanged. The function still: (a) caps `pending` to `rewardPool`, (b) routes ONLY `cappedPending` through `_settleUnsettled`, (c) silently drops `pending - cappedPending`, AND (d) advances `p.rewardDebt = accumulated` UNCONDITIONALLY at L1278 — past the dropped slice. This is the EXACT bug class that DS2-02 fixed in `kick()`, and that DS2-01 fixed in `kick()` (rewardDebt-past-forfeit). Both DS2 fixes were sibling-missed here.

**Attack / Impact:** Triggered on EVERY NFT transfer when the contract is under-funded (`rewardPool < pending`). Every secondary-market sale, every lending escrow round-trip, every restaking deposit / withdrawal silently destroys the seller's post-rewardPool slice with no event, no recovery. Per pass-2 DS2-02, "no event fires for the rewardPool shortfall." Lending integrations + restaking are HIGH-FREQUENCY transfer paths in production. With the `rewardPool` running low between `notifyRewardAmount` cycles (POLAccumulator harvest gaps, missed funding windows), each transfer permanently destroys reward value. Compounds: (1) the drop is invisible (no `RewardsForfeited` for the rewardPool shortfall, only for the unsettled-cap shortfall), (2) `p.rewardDebt = accumulated` advance means even after the pool is replenished the new owner cannot reach the lost slice, (3) frontend dashboards reading `RewardsForfeited` events to alert holders never fire on the rewardPool path.

**Evidence:**
```solidity
// L1245-1279 — _settleRewardsOnTransfer (UNCHANGED in d6b1f5b)
if (diff > 0) {
    uint256 pending = uint256(diff);
    uint256 available = rewardToken.balanceOf(address(this));
    uint256 reserved = _reserved();
    uint256 rewardPool = available > reserved ? available - reserved : 0;
    uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
    uint256 actualSettled = _settleUnsettled(from, cappedPending);
    uint256 forfeited = cappedPending - actualSettled;     // ← unsettled-cap shortfall ONLY
    if (forfeited > 0) emit RewardsForfeited(from, forfeited);
    // ← MISSING: pending - cappedPending (rewardPool shortfall) silently dropped
    // ← MISSING: KickRewardPoolShortfall-equivalent observability event
    if (actualSettled > 0) emit RewardPaid(from, tokenId, actualSettled);
    _touch(from);
}
p.rewardDebt = accumulated;     // ← advanced PAST the silently-dropped slice (DS2-01 sibling)

// vs kick L965-984 (post-DS2-02 fix)
uint256 shortfall = pending - cappedPending;
if (shortfall > 0) {
    uint256 actualSettledShortfall = _settleUnsettled(holder, shortfall);
    if (actualSettledShortfall > 0) totalSettled += actualSettledShortfall;
}
...
if (totalSettled > 0) {
    p.rewardDebt = p.rewardDebt + _safeInt256(totalSettled);   // ← advanced ONLY by credited slice
}
```

**Recommendation:** Apply the DS2-01 + DS2-02 + DS2-03 pattern verbatim — same surface, same fix:
```solidity
if (diff > 0) {
    uint256 pending = uint256(diff);
    uint256 available = rewardToken.balanceOf(address(this));
    uint256 reserved = _reserved();
    uint256 rewardPool = available > reserved ? available - reserved : 0;
    uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
    if (pending > cappedPending) {
        emit TransferRewardPoolShortfall(from, pending, cappedPending);  // new event, kick-parity
    }
    uint256 totalSettled;
    if (cappedPending > 0) {
        uint256 actualSettled = _settleUnsettled(from, cappedPending);
        if (actualSettled > 0) {
            emit RewardPaid(from, tokenId, actualSettled);
            totalSettled += actualSettled;
        }
    }
    uint256 shortfall = pending - cappedPending;
    if (shortfall > 0) {
        uint256 actualSettledShortfall = _settleUnsettled(from, shortfall);
        if (actualSettledShortfall > 0) totalSettled += actualSettledShortfall;
    }
    uint256 forfeitedTotal = pending - totalSettled;
    if (forfeitedTotal > 0) emit RewardsForfeited(from, forfeitedTotal);
    if (totalSettled > 0) _touch(from);
    // Advance rewardDebt by ONLY the actually-credited slice (DS2-01 parity)
    p.rewardDebt = p.rewardDebt + _safeInt256(totalSettled);
} else {
    p.rewardDebt = accumulated;   // unchanged path: no settle, set anchor to current accumulated
}
```
The unconditional `p.rewardDebt = accumulated` at L1278 must be moved INSIDE the `else` branch — otherwise the DS2-01 fix is undone here. Same logic applies as in `kick()`: forfeited slice should not be anchored past.

---

## [DS3-02] `toggleAutoMaxLock` enable-path is the missed sibling for DS-06 + DS2-07 — expired position can be revived to MAX boost via `extendFee` payment, sidestepping the `LockExpired` guard added to `extendLock` and `revalidateBoost`
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:692-718`
**Category:** math / lock-mechanics

**Bug:** Pass-1 DS-06 added `if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();` to `extendLock`. Pass-2 DS2-07 added the same guard to `revalidateBoost` "for parity with DS-06's `extendLock` guard and `increaseAmount`." But the THIRD function in this family — `toggleAutoMaxLock` — was never patched. Its enable-branch performs the SAME revival pattern: charge extendFee → settle pre-expiry rewards via `_getReward` (which decays boostedAmount to 0) → set `lockEnd = MAX` → `_applyNewBoost(p, MAX_BOOST_BPS)` to RESTORE boost on the just-decayed expired position. Result: a holder can revive an expired position at MAX boost for the cost of `extendFeeBps × p.amount`, sidestepping the documented "use it or lose it" model that DS-06 codified. Since `extendFeeBps` defaults to 0, the revival is currently FREE.

**Attack / Impact:** Same shape as DS-06 / DS2-07 (rated Low / Low respectively). User benefits: (1) avoids withdraw → re-stake round-trip (saves gas + the 24h `TRANSFER_COOLDOWN` window that fresh stakes face for transfer purposes), (2) preserves original `stakeTimestamp` (lending integrations check `stakeTimestamp + TRANSFER_COOLDOWN`, so revived positions can be used as collateral immediately while fresh stakes must wait), (3) keeps the position's slot in `_positionsByOwner[user]` against the 50-cap. With `extendFeeBps == 0` (current default), the revival is gas-only. The asymmetry across the three sibling functions is the key issue — design intent per DS-06 was that all expiry-revival paths require `withdraw → stake` (paying full new-stake fees). `toggleAutoMaxLock` is the leak. Severity stepped up to Medium (vs DS2-07's Low) because: (a) two prior fix passes both flagged the parity family without catching this one — track-record of sibling-miss, (b) `toggleAutoMaxLock` is called more frequently than `revalidateBoost` (autoMaxLock is a documented UX feature; revalidateBoost is admin/edge), so the revival surface is larger in production.

**Evidence:**
```solidity
// L692-718 — toggleAutoMaxLock: NO expiry guard
function toggleAutoMaxLock(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
    if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
    Position storage p = positions[tokenId];
    bool wasOn = p.autoMaxLock;
    p.autoMaxLock = !wasOn;

    if (p.autoMaxLock) {
        _chargeExtendFee(tokenId, p.amount);    // pays fee on stale principal
        _getReward(tokenId, p);                  // decays boostedAmount to 0 if expired
        p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
        p.lockDuration = uint32(MAX_LOCK_DURATION);
        uint256 newBoost = MAX_BOOST_BPS;
        if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS;
        _applyNewBoost(p, newBoost);             // RESTORES boost on (now-decayed) expired position
    }
    ...
}

// vs L727-758 extendLock (post-DS-06):
if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();

// vs L1017-1024 revalidateBoost (post-DS2-07):
if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();

// vs L770-773 increaseAmount:
if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
```

**Recommendation:** Add the same `LockExpired` guard to `toggleAutoMaxLock`'s enable branch. Disable should remain free (no fee, no boost change), so the guard only fires when `!wasOn` (enabling):
```solidity
function toggleAutoMaxLock(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
    if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
    Position storage p = positions[tokenId];
    bool wasOn = p.autoMaxLock;
    if (!wasOn) {
        // AUDIT FIX: DS3-02 — parity with DS-06 (extendLock) + DS2-07 (revalidateBoost).
        // Enable-path revives an expired position to MAX boost without going through
        // withdraw → re-stake. Disable is unaffected.
        if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
    }
    p.autoMaxLock = !wasOn;
    ...
}
```
A holder whose autoMaxLock fired but who let the lock expire anyway (e.g., autoMaxLock was disabled then re-enabled later, or position created via `stake`-then-`toggleAutoMaxLock`) must withdraw + re-stake fresh. Closes the parity family with no further surface.

---

## [DS3-03] `kick()` emits `RewardPaid` for the unsettled-credit path — event semantic now permanently inconsistent across `_getReward` (real transfer), `_settleRewardsOnTransfer` (unsettled credit), and `kick()` (unsettled credit). Frontends + indexers will overcount immediate-payout volume by the kick + transfer paths
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:957` (kick) + `contracts/src/TegridyStaking.sol:1269` (_settleRewardsOnTransfer)
**Category:** other / event-semantic-drift

**Bug:** `RewardPaid` is documented (and historically used) as "reward tokens were transferred to the user." `_getReward` emits `RewardPaid(recipient, tokenId, cappedPending)` AFTER `rewardToken.safeTransfer(recipient, cappedPending)` at L1219-1220 — semantic correct. But `_settleRewardsOnTransfer` (L1269) emits `RewardPaid(from, tokenId, actualSettled)` after `_settleUnsettled(from, ...)` — NO TRANSFER, just an unsettled credit. The DS-02 fix (`f7a0fc4`) carried this misleading pattern into `kick()` (L957). Now THREE paths emit `RewardPaid` with two incompatible semantics. Frontends that show "your last payout: X" by reading `RewardPaid` events will display the unsettled credit as if it were a wallet receipt; users will see "I got 50 TOWELI" but their wallet balance is unchanged, requiring a second trip to `claimUnsettled()`. Indexers that sum `RewardPaid` to compute total distributed rewards will OVERCOUNT by the entire kick + transfer path volume.

**Attack / Impact:** Pure observability / UX regression — no fund loss. But the impact compounds with [DS2-06] (NatSpec drift): kicked holders ALREADY don't realize their rewards moved to unsettled; now their dashboard will SHOW a `RewardPaid` event suggesting the rewards arrived in their wallet when they didn't. User support burden + analytics drift. Indexers measuring "protocol revenue distribution rate" via `RewardPaid` aggregation will report inflated numbers. Lending integrations that gate borrower behavior on "recent claim activity" by reading `RewardPaid` events will be deceived into accepting a kicked position as "freshly claimed" when no actual claim happened.

**Evidence:**
```solidity
// L1219-1220 — _getReward (CORRECT semantic: transfer → emit)
if (cappedPending > 0) {
    rewardToken.safeTransfer(recipient, cappedPending);
    emit RewardPaid(recipient, tokenId, cappedPending);
}

// L1267-1270 — _settleRewardsOnTransfer (MISLEADING: unsettled credit → emit)
if (actualSettled > 0) {
    emit RewardPaid(from, tokenId, actualSettled);   // ← no transfer happened
}

// L955-959 — kick (DS-02 fix copied the misleading pattern)
uint256 actualSettled = _settleUnsettled(holder, cappedPending);
if (actualSettled > 0) {
    emit RewardPaid(holder, tokenId, actualSettled);   // ← no transfer happened
    totalSettled += actualSettled;
}
```

**Recommendation:** Three options, ranked by surgical-ness:

(a) **Cheapest** — replace `RewardPaid` with `RewardSettledToUnsettled(holder, tokenId, amount)` in both kick + `_settleRewardsOnTransfer`. Indexers update once. The event already exists for true transfers; reuse `UnsettledClaimed(user, amount)` (declared at L1295) only when the user actually claims via `claimUnsettled`. Add `RewardSettledToUnsettled` for the credit path. Three events with three distinct meanings: `RewardPaid` (real transfer at claim/getReward), `RewardSettledToUnsettled` (credited to unsettled), `UnsettledClaimed` (paid out from unsettled).

(b) **Defensive** — keep `RewardPaid` semantic + emit a sibling `RewardCreditedAsUnsettled(holder, tokenId, amount)` so old indexers keep working but new ones can disambiguate. Adds one event per call but preserves backward compat for indexers already deployed.

(c) **Documentation-only** — add a NatSpec note on `RewardPaid` event declaration (L234) explaining the dual semantic. Cheapest for the contract but pushes burden to integrators.

Recommend (a) — clean break, single source of truth, fixes the lying-event issue once. The `RewardPaid` event already has 18 months of off-chain history with the misleading `_settleRewardsOnTransfer` semantic; adding a fix-forward event is the cleanest closure.

---

## [DS3-04] DS2-01 fix promises that "forfeited portion stays claimable once room is freed" — the promise is FALSE for non-autoMaxLock holders post-full-forfeit kick; for autoMaxLock holders it's also FALSE because revival overwrites the saved rewardDebt anchor
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:909-913` (NatSpec) + `980-984` (implementation)
**Category:** docs / reward-irrecoverability

**Bug:** The DS2-01 fix advances `p.rewardDebt` by ONLY the actually-settled slice (good), and the NatSpec at L909-913 + L979-982 promises: *"the forfeited portion stays claimable once room is freed (cap raised, other users claim, or rewardPool replenished and another reward-touching path triggers reconciliation)."* This is FALSE for both branches:

(a) **Non-autoMaxLock holder**: post-kick, `p.boostedAmount = 0` (decayed) and `p.rewardDebt = old_pre_kick_value` (NOT advanced past the forfeit). The user's only paths to interact:
  - `getReward` → `_getReward` opens with `if (p.boostedAmount == 0) return 0;` (L1198) — short-circuits, no settle, no recovery.
  - `withdraw` → calls `_getReward` (returns 0), then `_clearPosition` deletes the position. The "saved" rewardDebt is gone; the forfeited slice is permanently lost.
  - `extendLock` / `increaseAmount` / `revalidateBoost` / `toggleAutoMaxLock(true)` → all reject expired positions post-DS-06 / DS2-07 / DS3-02. Cannot revive.
  - `earlyWithdraw` → reverts with `MustUseWithdraw` (lock has expired).
  - `emergencyExitPosition` / `executeEmergencyExit` → call `_getReward` (returns 0), then `_clearPosition`. Same write-off.

(b) **autoMaxLock holder**: post-kick, can call `getReward` which triggers the revival branch at L874-883: `p.lockEnd = MAX`, `_applyNewBoost(p, MAX_BOOST_BPS)`. But `_applyNewBoost` at L1705 does `p.rewardDebt = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);` — OVERWRITES the saved rewardDebt to the FRESH value at current RPT. The "saved" rewardDebt anchor is destroyed; the forfeited slice is gone for autoMaxLock holders too.

In both branches, the `cap raised → reconciliation` promise is hollow — there's no code path that retroactively settles the forfeited slice.

**Attack / Impact:** Soft impact (no theft beyond what DS2-01 already documented), but the documentation contract with users is broken. User experience: "Pass-2 audit fix says my pre-expiry rewards are recoverable — I'll wait until the cap clears, then retry." User waits, retries via `getReward` (returns 0 because boostedAmount == 0 OR overwritten anchor). Concludes the documented recovery doesn't work. Worse: governance / community trust regression because the audit closure claimed the bug was fixed when only the post-fix accounting was tightened — the underlying forfeit-irrecoverability remained. Sequence to reproduce:
1. `maxUnsettledRewards` is saturated (totalUnsettledRewards == max).
2. Bob's lock expires; he has 5k pre-expiry rewards.
3. Eve kicks. `forfeitedTotal = 5k`. `RewardsForfeitedDuringKick(bob, 5000)` fires. `p.rewardDebt` unchanged (per DS2-01 fix), `boostedAmount = 0` (per `_decayIfExpired`).
4. Other users claim, `totalUnsettledRewards` drops to 50% of cap.
5. Bob calls `getReward`. `_getReward` short-circuits (boostedAmount == 0). Returns 0.
6. Bob calls `withdraw`. Same. `_clearPosition` deletes his position. The 5k is gone.

**Evidence:**
```solidity
// L1198 — _getReward short-circuit blocks reconciliation
function _getReward(uint256 tokenId, Position storage p) internal returns (uint256) {
    if (p.boostedAmount == 0) return 0;     // ← blocks the "reconciliation" path
    ...
}

// L1699-1707 — _applyNewBoost overwrites the saved anchor (autoMaxLock revival path)
function _applyNewBoost(Position storage p, uint256 newBoost) private {
    totalBoostedStake -= p.boostedAmount;
    if (newBoost > type(uint16).max) revert BoostOverflow();
    p.boostBps = uint16(newBoost);
    p.boostedAmount = (p.amount * newBoost) / BOOST_PRECISION;
    totalBoostedStake += p.boostedAmount;
    p.rewardDebt = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);  // ← OVERWRITES
    _writeTotalBoostedStakeCheckpoint();
}

// L909-913 — DS2-01 NatSpec promise (FALSE)
/// (a) `p.rewardDebt` advance is deferred until AFTER `_settleUnsettled`
///     returns and is advanced by ONLY the actually-credited slice. If the
///     unsettled cap was saturated, the un-credited rewardDebt anchor stays
///     where it was — so the holder retains a future claim path once the
///     cap is raised or other claims drain `totalUnsettledRewards`.
```

**Recommendation:** Either (a) make the NatSpec accurate, or (b) add an actual reconciliation path. (a) is the minimal honest fix:
```solidity
/// (a) `p.rewardDebt` advance is deferred until AFTER `_settleUnsettled`
///     returns and is advanced by ONLY the actually-credited slice. NOTE:
///     post-decay, `boostedAmount == 0` blocks `_getReward` reconciliation;
///     the forfeited slice is permanently irrecoverable for non-autoMaxLock
///     holders. autoMaxLock revival via `getReward` at L874-883 also
///     overwrites the saved `rewardDebt` anchor (`_applyNewBoost` at L1705).
///     Holders should call `getReward` BEFORE expiry to avoid this state.
```

(b) is the proper fix: add a `reconcileForfeited(tokenId)` function that, when called by the holder on a kicked-and-decayed position, computes `pending = (originalRewardDebt - currentRewardDebt) - 0` (or however we re-derive the lost slice) and routes it through `_settleUnsettled`. Tricky because the original pre-kick `rewardDebt` and the kick-time `accumulated` are not stored anywhere — would need to add a `forfeitedAtKick[tokenId]` storage slot to track the accumulated-but-not-settled amount. Adds ~20k gas per kick, recoverable via a one-shot reconciliation call. If chosen, also need to consider that `forfeitedAtKick` itself is subject to the same cap+pool gates on `reconcileForfeited`, so this is just deferring (not eliminating) the forfeit.

Recommend (a) — make the docs accurate. The holder's defensive action (call `getReward` before expiry) is reasonable; the contract should not promise more than it delivers.

---

## [DS3-05] `_settleRewardsOnTransfer` advances `p.rewardDebt = accumulated` UNCONDITIONALLY at L1278 — same DS2-01 bug pattern as kick(), persists post-fix; new owner inherits a debt anchor past silently-forfeited rewards, breaking M-01 ordering on the transfer path
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:1278`
**Category:** reward / accounting

**Bug:** Companion to [DS3-01]. Even if the `_settleUnsettled` shortfall fix is applied (DS3-01 recommendation), the existing L1278 line `p.rewardDebt = accumulated` runs UNCONDITIONALLY (outside the `if (diff > 0)` block). For transfers where `diff > 0` AND the unsettled cap is saturated AND the rewardPool was insufficient, the rewardDebt is moved past the forfeit. This is the EXACT bug pattern that DS2-01 closed in `kick()` ("`p.rewardDebt` advance is deferred until AFTER `_settleUnsettled` returns and is advanced by ONLY the actually-credited slice"). The transfer path bypasses the M-01 ordering protection: the new owner inherits a `rewardDebt` anchored at full `accumulated`, while only `actualSettled < cappedPending < pending` was actually credited to the seller. The forfeited slice is permanently unreachable by either party.

**Attack / Impact:** Compounds with [DS3-01]. On every NFT transfer with a saturated unsettled cap + insufficient rewardPool, a portion of the seller's pre-transfer rewards is double-lost: (a) not credited to unsettled (per [DS3-01]'s rewardPool shortfall drop), (b) anchored past in `rewardDebt` so the new owner cannot accrue against the forfeit period. Net effect: the protocol POCKETS the forfeited slice as `available - reserved` headroom that's now effectively trapped — no holder can ever reach it. Over time, the protocol contract balance slowly accumulates "ghost rewards" that never settle to anyone. Quantitatively bounded by `forfeitsPerTransfer × transfersPerDay × daysSinceLastNotify`. With high lending+restaking activity (frequent NFT round-trips) and gappy `notifyRewardAmount` cycles (POLAccumulator harvest variability), this can be 1-5% of protocol-wide reward emission per quarter.

**Evidence:**
```solidity
// L1254-1278 — _settleRewardsOnTransfer
if (diff > 0) {
    uint256 pending = uint256(diff);
    ...
    uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
    uint256 actualSettled = _settleUnsettled(from, cappedPending);
    uint256 forfeited = cappedPending - actualSettled;
    ...
}
// AUDIT FIX: Set rewardDebt AFTER the reward pool check to ensure correct accounting
p.rewardDebt = accumulated;     // ← UNCONDITIONAL — moves past forfeit slice
```

The L1277 comment ("Set rewardDebt AFTER the reward pool check") was correct for the pre-DS2 era when there was no concept of "track forfeit and resume later." Post-DS2-01, the kick() pattern is the new standard: advance rewardDebt by ONLY what was credited. `_settleRewardsOnTransfer` was missed.

**Recommendation:** Restructure the `if (diff > 0)` branch to mirror kick():
```solidity
if (diff > 0) {
    uint256 pending = uint256(diff);
    ...
    uint256 totalSettled;
    if (cappedPending > 0) {
        uint256 actualSettled = _settleUnsettled(from, cappedPending);
        if (actualSettled > 0) {
            emit RewardPaid(from, tokenId, actualSettled);   // see DS3-03 — consider new event
            totalSettled += actualSettled;
        }
    }
    uint256 shortfall = pending - cappedPending;             // DS3-01 fix
    if (shortfall > 0) {
        uint256 actualSettledShortfall = _settleUnsettled(from, shortfall);
        if (actualSettledShortfall > 0) totalSettled += actualSettledShortfall;
    }
    uint256 forfeitedTotal = pending - totalSettled;
    if (forfeitedTotal > 0) emit RewardsForfeited(from, forfeitedTotal);
    if (totalSettled > 0) _touch(from);
    // DS3-05 fix: advance rewardDebt by ONLY the credited slice
    p.rewardDebt = p.rewardDebt + _safeInt256(totalSettled);
} else {
    // No pending — anchor at current accumulated for the new owner
    p.rewardDebt = accumulated;
}
```
DS3-01 + DS3-05 should ship in a single PR — they're the same surface and the same bug pattern. With these in place, NFT transfers acquire reward-preservation parity with the post-DS2 kick path.

---

## [DS3-06] `kick()` does NOT `_writeCheckpoint(holder)` between settle and decay — voting power checkpoint is written by `_decayIfExpired` AFTER the settle; if `_settleUnsettled` is ever extended to mutate `boostedAmount` (e.g., partial decay, slashing, future critique-5.X), the missing intermediate checkpoint will create stale-trace bugs
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:953-994`
**Category:** other / forward-looking-defensive

**Bug:** Defensive flag, not a live exploit. In the current `kick()`, `_settleUnsettled` does NOT modify `p.boostedAmount` — it only writes `unsettledRewards[holder]` and `totalUnsettledRewards`. So no intermediate checkpoint is needed. `_decayIfExpired` at L994 then zeroes `boostedAmount` and writes the checkpoint. Correct for current semantics. HOWEVER, the kick path now has multiple effects on the holder's reward state (rewardDebt advance + unsettled credit + decay), and the team's track record (DS-02 → DS2-01/02/03 → DS3-01/05) shows that this surface gets re-touched. Any future change to `_settleUnsettled` or `_decayIfExpired` that mutates `boostedAmount` between L953-993 will create a stale-checkpoint window where the holder's voting power trace shows the OLD value while their position's `boostedAmount` is mid-mutation. The R014 H-2 cluster + REV-M-01 (totalBoostedStake checkpoint) showed the cost of this in the prior batches.

**Attack / Impact:** No live exploit. Forward-looking defensive flag. Cost to add: one `_writeCheckpoint(holder)` call (~5-20k gas if power changed, 0 if unchanged per NEW-S7). Cost to NOT add: future audit will rediscover this when the surface is touched again.

**Evidence:** Compare to other paths that intersperse settle and boost mutation:
- `_applyNewBoost` (L1699-1707) writes BOTH `_writeCheckpoint` and `_writeTotalBoostedStakeCheckpoint` after the boost change.
- `_decayIfExpired` (L337-344) writes both.
- `_settleRewardsOnTransfer` writes via the `_update` flow which calls `_writeCheckpoint(from)` and `_writeCheckpoint(to)` (L1156, L1171).

`kick()` writes the checkpoint ONLY via `_decayIfExpired`'s internal call. The settle does not write. If the settle ever needs to write (e.g., partial decay during settle), the surface is silent.

**Recommendation:** Add an explicit `_writeCheckpoint(holder)` AFTER `_decayIfExpired` and BEFORE the `emit PositionKicked`, and document it as load-bearing for future settle extensions:
```solidity
_decayIfExpired(tokenId, p);
// AUDIT FIX: DS3-06 — defensive checkpoint after settle+decay, in case
// future _settleUnsettled extensions mutate boostedAmount.
_writeCheckpoint(holder);
emit PositionKicked(tokenId, msg.sender, prior - p.boostedAmount);
```
NEW-S7 makes this a no-op when `votingPowerOf(holder)` is unchanged from the latest checkpoint, so the gas cost is bounded to the case where `_decayIfExpired` actually fired (prior > 0 → now 0). Idempotent; cheap.

---

## [DS3-07] Pause-aware `_accumulateRewards` (DS2-04) skips RPT bump while paused but the `unpause()` `lastUpdateTime = block.timestamp` reset is not protected against a re-entered `unpause` by a future hook — paired with `_unpause()` it's a TOCTOU window
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:575-578`
**Category:** other / forward-looking-defensive

**Bug:** `unpause()` calls `_unpause()` (which flips `paused()` to false) THEN sets `lastUpdateTime = block.timestamp`. If `_unpause()` triggers any hook or external call (it doesn't in OZ Pausable, but a future override could), the hook could call `_accumulateRewards()` between `_unpause()` and the explicit reset. At that moment, `paused()` is FALSE (just unpaused), so `_accumulateRewards` enters the bump branch with `lastUpdateTime` STILL at the pre-pause / pause-time value. The full pause window's `elapsed * rewardRate` lands on RPT, exactly the windfall DS2-04 was supposed to prevent. The explicit reset then runs but the damage is done.

This is forward-looking — current OZ Pausable's `_unpause()` is a 2-line state mutation with no hook. But the comment at L572-574 acknowledges "Defense-in-depth — `_accumulateRewards` already advances `lastUpdateTime` while paused, but resetting here keeps the contract correct even if a future change introduces a code path that skips the unconditional advance." The dual-defense recognizes the brittleness; reorder the unpause for true defense-in-depth.

**Attack / Impact:** No live exploit (no current hook). Future-proofing flag. If TegridyStaking ever inherits a custom Pausable subclass with hooks (e.g., to integrate with a global `PauseManager`), or if a future Solidity upgrade adds hooks to standard library functions, the order matters.

**Evidence:**
```solidity
// L575-578 — current order
function unpause() external onlyOwner {
    _unpause();                                 // ← flips paused = false
    lastUpdateTime = block.timestamp;           // ← reset AFTER unflip; window between is the risk
}
```

**Recommendation:** Reset `lastUpdateTime` BEFORE `_unpause()`. The accumulator gate uses `paused()` which is still TRUE during the reset, so a hypothetical hook in `_unpause()` reading `_accumulateRewards` would see the correct frozen-emission state:
```solidity
function unpause() external onlyOwner {
    lastUpdateTime = block.timestamp;     // reset while still paused
    _unpause();                            // now post-reset, safe to flip
}
```
Alternative: call `_accumulateRewards()` AFTER `_unpause()` — it's now in the un-paused state with `lastUpdateTime = pre-unpause` so it would credit the pause window. So the BEFORE order is correct. Add a paired NatSpec note about ordering rationale.

---

## Summary

**Severity distribution (NEW pass-3 only — exclusive of pass-1 + pass-2 closed findings):**

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 1     |
| Medium   | 4     |
| Low      | 2     |

**One-line per finding:**

- **DS3-01** [High] `_settleRewardsOnTransfer` STILL drops rewardPool shortfall — DS2-02 sibling-fix promised in pass-2, not delivered. Every NFT transfer permanently strands the post-pool slice when the contract is under-funded.
- **DS3-02** [Medium] `toggleAutoMaxLock` enable-path is the missed DS-06/DS2-07 sibling — expired position revives to MAX boost via extendFee payment, sidestepping `LockExpired` guard.
- **DS3-03** [Medium] `RewardPaid` event emitted from `kick()` + `_settleRewardsOnTransfer` for unsettled credits (no real transfer) — semantic now permanently inconsistent across three paths; frontends + indexers will overcount.
- **DS3-04** [Medium] DS2-01 fix's "claimable once room is freed" promise is FALSE for both non-autoMaxLock (boostedAmount == 0 short-circuit) and autoMaxLock (revival overwrites saved rewardDebt anchor) holders. NatSpec is misleading.
- **DS3-05** [Medium] `_settleRewardsOnTransfer` `p.rewardDebt = accumulated` advance at L1278 is UNCONDITIONAL — same DS2-01 bug pattern, persists post-fix. Forfeited rewards become "ghost rewards" trapped in the contract.
- **DS3-06** [Low] `kick()` no `_writeCheckpoint(holder)` between settle and decay — defensive forward-looking flag; current code is correct, future settle extensions would create stale-trace.
- **DS3-07** [Low] `unpause()` resets `lastUpdateTime` AFTER `_unpause()` — TOCTOU window between unflip and reset. No live exploit (OZ Pausable has no hooks), forward-looking defensive ordering.

**Single-PR closures (high leverage):**
1. **DS3-01 + DS3-05** — `_settleRewardsOnTransfer` shortfall + rewardDebt parity with kick(). Same surface, same fix. Closes the DS2-02 sibling-miss explicitly called out in pass-2.
2. **DS3-02** — `toggleAutoMaxLock` `LockExpired` guard. One-line addition; closes the DS-06 / DS2-07 / DS3-02 expiry-revival parity family.
3. **DS3-03 + DS3-04** — event-semantic + NatSpec hygiene. Either rename `RewardPaid` to a transfer-only event (DS3-03 option a) and add `RewardSettledToUnsettled`, or add NatSpec explaining the dual semantic. Update DS2-01 NatSpec to remove the false "claimable once room is freed" promise.
4. **DS3-06 + DS3-07** — defensive flags; ship if PR-3 is open and incremental hardening is welcome.

**Verification of DS2-01..DS2-08 fixes:**
- **DS2-01** kick() rewardDebt advance after settle: PARTIAL. Correct accounting for the credited slice; FALSE NatSpec promise about future recoverability of the forfeited slice (see DS3-04). The rewardDebt-not-advanced-past-forfeit semantic itself is sound.
- **DS2-01 parity check on withdraw()**: PASS. `withdraw()` calls `_getReward` which advances `p.rewardDebt = accumulated` UNCONDITIONALLY, then `_clearPosition` deletes the position. The debt advance is moot because the position is gone. No rewardDebt leak (the leak is only relevant for surviving positions). However, **`_settleRewardsOnTransfer` is the missed parity sibling — see DS3-05**.
- **DS2-02 KickRewardPoolShortfall event**: PASS for `kick()`. **FAIL for `_settleRewardsOnTransfer`** — see DS3-01. The pass-2 recommendation explicitly named both paths; only one was fixed.
- **DS2-03 `_touch(holder)` in kick**: PASS. Fires inside `if (totalSettled > 0)` block. Sibling-search of all `unsettledRewards[*]` write sites:
  - L955 (`_settleUnsettled` in kick) → `_touch(holder)` at L991 ✓
  - L967 (`_settleUnsettled` shortfall in kick) → `_touch(holder)` at L991 ✓ (same block)
  - L1230 (`_settleUnsettled` shortfall in `_getReward`) → `_touch(recipient)` is NOT called inside `_getReward`; relies on caller to `_touch(msg.sender)` (e.g., L885 in `getReward`, L756 in `extendLock`, L793 in `increaseAmount`). When `recipient != msg.sender` (e.g., NFT held by lending escrow whose `recipient = ownerOf(tokenId)` is NOT msg.sender), `_touch(recipient)` is NOT fired. **Defensive flag — but bounded because lending+restaking paths are the only `recipient != msg.sender` cases and both have their own activity-tracking.**
  - L1261 (`_settleUnsettled` in `_settleRewardsOnTransfer`) → `_touch(from)` at L1275 ✓
  - All other `unsettledRewards[*] +=` writes: only L1755 inside `_settleUnsettled` itself. Caller-site responsible for `_touch`. PASS.
- **DS2-04 pause-aware `_accumulateRewards`**: PASS for the documented threat model. Forward-looking defensive flag on unpause ordering — see DS3-07.
- **DS2-05 `_clearPosition` repoint to `set.at(setLen - 1)`**: PASS for the multi-NFT case. **Edge case**: when `set.length() == 0` after burn (only-position case), the `if (setLen > 0)` guard correctly skips the repoint; `userTokenId[msg.sender]` was already zeroed by `_update` at L1155. No off-by-one. PASS.
- **DS2-06 NatSpec drift on kick()**: PASS — explicit caller-notice block added at L923-929.
- **DS2-07 `revalidateBoost` `LockExpired` guard**: PASS for `revalidateBoost`. **FAIL for `toggleAutoMaxLock`** — see DS3-02. The pass-2 recommendation said "parity with `extendLock` + `increaseAmount`"; the third sibling `toggleAutoMaxLock` was missed in BOTH pass-2's recommendation AND the d6b1f5b fix.
- **DS2-08 `applyLendingContract` NatSpec**: PASS — clarity tweak at L1624-1629 added.

**Carry-over from prior passes (still open per the team's deferral list):**
- **DS-09 (whale rebate via own recycled fee)**: still DEFERRED at L740-742. No action this pass.
