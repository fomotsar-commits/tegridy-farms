# Deep Audit (Pass 3) — TegridyRestaking + TegridyLPFarming
**Date:** 2026-05-02
**Scope:** `contracts/src/TegridyRestaking.sol` (1,689 LOC) + `contracts/src/TegridyLPFarming.sol` (518 LOC)
**Method:** Post-fix re-audit of commit `f9a3656` (DEEP-DR v2 cluster, 8 findings closed). Focus on: (a) DR2-01..DR2-08 fix verification, (b) regressions introduced by the v2 fix, (c) new issues missed in pass-1 + pass-2, (d) cross-checks where the DR2 patches interact.
**Prior pass excluded:** DR-01..DR-11 (closed in `a04acbe`); DR2-01..DR2-08 (closed in `f9a3656`). H5/H7/H8/M-S3/M-S5/015_TegridyRestaking.md/010_TegridyLPFarming.md/microscope-04-30 carry-overs per pass-1 list.

---

## [DR3-01] DR2-02 fix is a NET REGRESSION — `_boostedAmountAt` now returns inflated cached for autoMaxLock positions in the kick window EVEN BEFORE any restoration, which the v1 DR-04 clamp had correctly closed
**Severity:** High
**File:** `contracts/src/TegridyRestaking.sol:430-433` (the new `if (autoMaxLock) return cached;` branch)
**Category:** invariant-violation / regression / over-credit
**Note:** The v2 finding correctly identified that `min(cached, current)` fails AFTER `getReward` restores boost. The applied fix (skip clamp when autoMaxLock=true) closes that case but OPENS the pre-restoration window the v1 fix had already closed.

**Bug:** v1 DR-04 closed the lazy-decay over-credit by clamping `min(cached, current)`. v2 DR2-02 noted this clamp fails for autoMaxLock positions because `staking.getReward` restores boost from 0 to MAX in the same `claimAll` transaction (so `current` is no longer a safe upper bound). The patch's response is to short-circuit at line 433: `if (autoMaxLock) return cached;`. But `cached` is `_boostCheckpoints[user].upperLookup(_timestamp)` — i.e., the most-recent restaking-side checkpoint with key ≤ _timestamp. Restaking-side checkpoints are written ONLY at restaking-side mutations (restake / refresh / claimAll-stale / etc.). For an autoMaxLock user that hasn't been touched since deposit, the only checkpoint is at `depositTime` with the original boost X. **`upperLookup(any _ts ≥ depositTime)` returns X — even for `_ts` deep into the post-kick zero-boost window.**

**Pre-DR2-02 behavior** (v1 DR-04 clamp):
- Post-kick / pre-getReward: `cached=X`, `current=0` → `min(X,0)=0` ✓ (correct: user had 0 boost during this window)
- Post-kick / post-getReward (autoMaxLock restored): `cached=X`, `current=MAX` → `min(X,MAX)=X` ✗ (the v2 finding's bug)

**Post-DR2-02 behavior** (autoMaxLock returns cached):
- Post-kick / pre-getReward: `cached=X`, autoMaxLock=true → returns X ✗ **NEW REGRESSION**
- Post-kick / post-getReward: `cached=X` (still depositTime checkpoint, since the post-getReward checkpoint is at `block.timestamp > _ts`), autoMaxLock=true → returns X ✗ (the v2 bug is NOT actually closed either)

The fix neither closed the v2 case nor preserved v1 protection — both code paths now return the same wrong answer. Net effect: the over-credit window the v1 DR-04 fix closed has been REOPENED in autoMaxLock cases regardless of whether anyone has triggered restoration.

**Attack / Impact:** Alice restakes a max-lock position with `autoMaxLock=true` and boost = X at T0. Lock expires at T_lockEnd. RevenueDistributor creates an epoch at T_epoch = T_lockEnd + N. No one has called `claimAll`, `staking.kick`, or any restaking-side mutation. Distributor calls `boostedAmountAt(alice, T_epoch)`:
- `cached = upperLookup(T_epoch) = X` (only checkpoint is at T0)
- `staking.positions(...).autoMaxLock = true`
- New branch returns `cached = X`

Alice receives revenue share for T_epoch as if her position were still at full boost. Pre-DR2-02, this lookup returned `min(X, current)`. If `staking.kick` had run at T_kick < T_epoch, `current = 0` and the lookup correctly returned 0. Now it returns X. RevenueDistributor pays Alice from the pool, diluting all other restakers' shares. Permissionless, no attack required — fires automatically for any inactive autoMaxLock holder.

**Evidence:**
```solidity
// L430-433 — DR2-02 fix
if (autoMaxLock) return cached;  // ← cached can be the depositTime checkpoint X
                                  //    even when staking.boostedAmount has been
                                  //    zeroed by kick() and not yet restored.

// L1140-1147 in RevenueDistributor — caller path
uint256 effectivePower = userPower > epoch.totalLocked ? epoch.totalLocked : userPower;
uint256 share = (epoch.totalETH * effectivePower) / epoch.totalLocked;
// share is computed against an inflated effectivePower; other restakers' shares dilute.
```

**Recommendation:** The v2 finding's recommendation (a) was correct: clamp by `staking.positions(...).lockEnd` — if `lockEnd < _timestamp`, return 0 (the position WAS expired at `_timestamp`, regardless of any subsequent restoration). Combine with the existing `min(cached, current)` clamp for non-autoMaxLock positions:
```solidity
uint256 lockEndAtRead;
try staking.positions(info.tokenId) returns (
    uint256, uint256 stakingBoosted, int256, uint256 lockEnd, uint256, uint256, bool _autoMaxLock, bool, uint256, uint256, bool
) {
    current = stakingBoosted;
    autoMaxLock = _autoMaxLock;
    lockEndAtRead = lockEnd;
} catch { return cached; }

// If the position's lock had expired at _timestamp, the user was decayed at _timestamp
// regardless of subsequent restoration.
if (lockEndAtRead > 0 && lockEndAtRead < _timestamp) return 0;

return cached < current ? cached : current;
```
The lockEnd-of-now isn't perfectly historical (autoMaxLock could have extended it after _timestamp), but a non-zero `lockEnd ≤ _timestamp` is provably "expired at _timestamp" regardless of later events. Add an invariant test: an autoMaxLock position kicked at T_k, looked up at T_k+1day before any restoration, returns 0.

---

## [DR3-02] `claimAll` DR2-04 post-getReward sync mutates `info.boostedAmount` / `info.bonusDebt` / `totalRestaked` BEFORE the `staking.positions` re-read for `positionAmount` — if the second read reverts, the partial mutation is silently swallowed by the outer try/catch
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:725-760`
**Category:** state-desync / partial-update

**Bug:** The DR2-04 fix does TWO `staking.positions` calls back-to-back inside ONE try block: line 725 (returns `postClaimBoosted`) and line 741 (returns `postClaimAmount`). Between them, four state mutations have already happened:
- `info.boostedAmount = postClaimBoosted` (L730)
- `_writeBoostCheckpoint(msg.sender, postClaimBoosted)` (L731)
- `totalRestaked = totalRestaked - oldB + postClaimBoosted` (L732)
- `info.bonusDebt = _safeInt256((postClaimBoosted * accBonusPerShare) / ACC_PRECISION)` (L737)

If the second `staking.positions` call at L741 reverts (e.g., the staking contract is mid-upgrade, `positions` ABI changes, an inline reentrancy guard fires), the outer `catch` at L757 swallows it silently. The four mutations above persist; the principal sync is skipped. The cache is now half-updated: `boostedAmount` matches staking, but `positionAmount` may not, and `totalActivePrincipal` is stale relative to the new principal (it could be off by `postClaimAmount - oldP`).

**Attack / Impact:** Same staking contract; the second call should normally always succeed if the first did. But the `try` boundary is asymmetric. Future hardening of the staking contract that introduces a check-then-revert pattern in `positions` (e.g., a getter modifier) could trigger this. Lower probability than DR3-01, but the partial-update pattern is the same shape as the v2 DR2-01 sibling-miss class — half-applied state mutations leak into invariants. The fix is one-line trivial.

**Evidence:**
```solidity
// L725-760 — both reads inside ONE try block
try staking.positions(info.tokenId) returns (
    uint256, uint256 postClaimBoosted, ...
) {
    if (postClaimBoosted > 0 && postClaimBoosted != info.boostedAmount) {
        // ← four state mutations here (L729-737) ALREADY ran
        info.boostedAmount = postClaimBoosted;
        _writeBoostCheckpoint(msg.sender, postClaimBoosted);
        totalRestaked = totalRestaked - oldB + postClaimBoosted;
        info.bonusDebt = _safeInt256(...);
        // SECOND call to staking.positions — if THIS reverts, outer catch swallows.
        (uint256 postClaimAmount,,,,,,,,, ,) = staking.positions(info.tokenId);
        // ← principal sync only happens if the read succeeds
        ...
    }
} catch {
    // Silently swallows — cache may be half-updated
}
```

**Recommendation:** Reuse the FIRST tuple's `postClaimAmount` (read it from the same destructure as `postClaimBoosted`) instead of issuing a second call. Single-line refactor:
```solidity
try staking.positions(info.tokenId) returns (
    uint256 postClaimAmount, uint256 postClaimBoosted, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
) {
    if (postClaimBoosted > 0 && postClaimBoosted != info.boostedAmount) {
        // ... boost sync
        if (postClaimAmount != info.positionAmount) {
            // ... principal sync (no second staking call)
        }
    }
} catch { ... }
```

---

## [DR3-03] `emergencyWithdrawNFT` retains the unguarded `totalActivePrincipal -= info.positionAmount` — DR2-01's sibling-search missed the SIXTH site, breaking the emergency-exit underflow guard that the other five sites now enforce
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:1232`
**Category:** sibling-miss / emergency-handler-fragility
**Note:** The DR2-01 commit message lists "five sites" — this audit identifies a sixth. The other five (`unrestake`, `claimAll`, `refreshPosition`, `decayExpiredRestaker`, `emergencyForceReturn`) all use the underflow-guarded form. `emergencyWithdrawNFT` is the lone holdout.

**Bug:** Every other principal-decrement site in the contract uses the same underflow-guarded pattern after DR2-01:
```solidity
if (originalAmount <= totalActivePrincipal) {
    totalActivePrincipal -= originalAmount;
} else {
    totalActivePrincipal = 0;
}
```
`emergencyWithdrawNFT` at L1232 still uses the bare:
```solidity
totalActivePrincipal -= info.positionAmount;
```
In Solidity 0.8+ default, this reverts on underflow. If for any reason `info.positionAmount > totalActivePrincipal` at this point (e.g., a future code path drift, an invariant break from a hypothetical concurrent mutation, or a re-deployed-contract migration), the emergency exit BRICKS — the user cannot get their NFT back. `emergencyWithdrawNFT` is the user's last-resort path when all reward math is broken; it MUST not revert on accounting drift.

**Attack / Impact:** No direct attack today — current invariants keep `info.positionAmount ≤ totalActivePrincipal`. But the v2 DR2-01 finding documented that DR-02's "five-site" decrement claim was off by FOUR at first publication; this audit notes it's still off by one. Same code-search pattern, same scope misalignment. Defense-in-depth fix is one-line. Pre-existing issue (predates DR2-01) but DR2-01's stated scope was "every site that overwrites `info.positionAmount`" — `emergencyWithdrawNFT` doesn't overwrite, it deletes, so technically out of scope for DR2-01 — but it DOES decrement `totalActivePrincipal`, which is the protected invariant.

**Evidence:**
```solidity
// L1232 — bare subtraction, reverts on underflow
totalActivePrincipal -= info.positionAmount;

// vs L1366-1370 (emergencyForceReturn) — guarded
if (info.positionAmount <= totalActivePrincipal) {
    totalActivePrincipal -= info.positionAmount;
} else {
    totalActivePrincipal = 0;
}
```

**Recommendation:** Apply the same underflow-guarded pattern at L1232. Add an invariant test that runs `emergencyWithdrawNFT` against a fuzz-injected `totalActivePrincipal < info.positionAmount` and asserts the call succeeds (not reverts).

---

## [DR3-04] `emergencyForceReturn` settles bonus on STALE cached `info.boostedAmount` and never anchors `info.bonusDebt` post-payout — admin-only over-credit window for any cached-stale position
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:1331-1343`
**Category:** stale-cache / accounting

**Bug:** After `_accrueBonusChecked()` at L1331, `emergencyForceReturn` settles bonus pending using `info.boostedAmount` directly (L1334-1343) WITHOUT first re-syncing the staking-side boost. If the staking lock has expired and either `kick` ran or the cached `info.boostedAmount` is otherwise stale-inflated relative to the current staking-side boost, the settlement pays out against the inflated value. The `_accrueBonusChecked()` call uses the SAME inflated `totalRestaked` (since this user's stale `boostedAmount` is in the running total), so accBonusPerShare grows slower than it should — partial offset, but the per-user payout still over-credits because the same inflated boost is the per-user multiplier.

Additionally: `info.bonusDebt` is NOT updated to `accumulated` after the payout at L1339. The CEI pattern is "anchor before transfer." Here, transfer happens with no anchor, then `delete restakers[restaker]` at L1389 zeroes the debt. Same-block, the only protection is `nonReentrant`. If a malicious bonus token re-enters via callback during `safeTransfer` and somehow bypasses nonReentrant (e.g., through a different entrypoint), the un-anchored debt could be exploited. Low likelihood given OZ's nonReentrant, but the CEI violation is the same shape as the bugs DR-01/02 closed.

**Attack / Impact:** Owner-only path (whenPaused + onlyOwner). The over-credit happens any time admin force-returns a stale-cached position. Severity bounded by admin trust + bonus pool size. The CEI violation is a defense-in-depth concern.

**Evidence:**
```solidity
// L1331-1343 — settlement uses cached info.boostedAmount, no re-sync, no debt anchor
_accrueBonusChecked();

if (info.boostedAmount > 0) {
    int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
    int256 diff = accumulated - info.bonusDebt;
    uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
    // ← MISSING: info.bonusDebt = accumulated  (CEI violation)
    if (bonusPending > 0) {
        bonusRewardToken.safeTransfer(restaker, bonusPending);  // ← external call w/o anchor
        ...
    }
}
```

**Recommendation:** Before the settlement block, re-sync from staking:
```solidity
try staking.positions(tokenId) returns (
    uint256, uint256 currentBoosted, ...
) {
    if (currentBoosted < info.boostedAmount) {
        uint256 oldB = info.boostedAmount;
        info.boostedAmount = currentBoosted;
        _writeBoostCheckpoint(restaker, currentBoosted);
        totalRestaked = totalRestaked - oldB + currentBoosted;
    }
} catch { /* fall through with cached */ }
```
And anchor the debt before transfer:
```solidity
info.bonusDebt = accumulated;  // anchor BEFORE external call
if (bonusPending > 0) bonusRewardToken.safeTransfer(restaker, bonusPending);
```

---

## [DR3-05] DR2-01 fix introduces a `recoverStuckPrincipal` brick when the permissionless `decayExpiredRestaker` zeroes a force-closed user's cached `info.positionAmount` — original-deposit anchor lost
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:1138, :1147, :1151` (consumer) + `:1605` (mutator)
**Category:** UX-griefing / state-anchor-loss

**Bug:** `recoverStuckPrincipal` derives the maximum-recoverable amount from `info.positionAmount` (line 1138, then capped at line 1147). If `info.positionAmount` has been zeroed by a prior call to `claimAll`, `refreshPosition`, `unrestake`'s stale-path, or `decayExpiredRestaker` (all of which now correctly sync `info.positionAmount = currentAmount` via the DR2-01 fix), then `originalAmount = 0`, `payout = 0`, and the function reverts with `NO_RECOVERABLE_BALANCE` (L1151). The user has no other entrypoint to recover their stuck principal — they're permanently locked out of the funds the restaking contract holds on their behalf.

`decayExpiredRestaker` is the highest-leverage trigger because it's permissionless. Anyone monitoring the chain can call it the moment a position is force-closed (currentBoosted=0 != cached info.boostedAmount) — the call zeroes both info.boostedAmount AND info.positionAmount via the DR2-01 sync. The victim must then somehow recover principal with `info.positionAmount = 0`.

This is NOT a v2-fix-introduced regression — pre-fix, `claimAll` and friends ALREADY overwrote `info.positionAmount` to 0 (and then leaked 10k into totalActivePrincipal, the bug DR2-01 closed). The brick existed before DR2-01. But DR2-01's fix added decayExpiredRestaker to the list of mutators that zero `info.positionAmount`, increasing the grief surface — it's now permissionless instead of user-self-triggered.

**Attack / Impact:** (1) Alice's restaked position is force-closed via emergencyExitPosition (currently only reachable via emergencyForceReturn → external user path → user calls staking.emergencyExitPosition; rare but possible). (2) Alice has not yet called recoverStuckPrincipal. (3) Attacker (anyone) calls `restaking.decayExpiredRestaker(alice)`. The DR2-01 sync at L1605 sets `info.positionAmount = currentAmount = 0`. (4) Alice calls `recoverStuckPrincipal` — REVERTS. Her TOWELI principal sits in the contract's balance, unrecoverable through any user path. Owner could only recover via `sweepStuckRewards` (which blocks rewardToken sweep) or a custom rescue path that doesn't exist.

**Evidence:**
```solidity
// L1605 (decayExpiredRestaker) — permissionless zeroes info.positionAmount
info.positionAmount = currentAmount;  // = 0 for force-closed

// L1138, 1147, 1151 (recoverStuckPrincipal) — depends on info.positionAmount as the anchor
uint256 originalAmount = info.positionAmount;  // = 0 after the above
...
uint256 payout = recoverable > originalAmount ? originalAmount : recoverable;
require(payout > 0, "NO_RECOVERABLE_BALANCE");  // ← always reverts
```

**Recommendation:** Add a separate `originalPrincipal` field to `RestakeInfo` set ONCE at restake-time and never overwritten (only deleted on full unrestake/recover/emergencyExit). Use it as the anchor in `recoverStuckPrincipal` instead of the running `info.positionAmount`:
```solidity
struct RestakeInfo {
    uint256 tokenId;
    uint256 positionAmount;     // running (synced)
    uint256 originalPrincipal;  // immutable per-restake-cycle (NEW)
    uint256 boostedAmount;
    int256 bonusDebt;
    uint256 depositTime;
    uint256 unsettledSnapshot;
}
```
Set in `restake()`: `originalPrincipal: amount`. Read in `recoverStuckPrincipal()`: `uint256 originalAmount = info.originalPrincipal;`.

---

## [DR3-06] `pendingBonus` view returns inflated value for autoMaxLock positions in the kick window — DR3-01 sibling on the user-facing surface (not RevenueDistributor)
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:319` (uses `_boostedAmountAt`)
**Category:** view-staleness / observability
**Note:** Same root cause as DR3-01 — the autoMaxLock branch in `_boostedAmountAt` returns cached without staleness-clamping. The user-facing surface is documented separately because the impact (frontend confusion vs. revenue over-credit) and the recommended hardening (consistent display vs. claim-time reconciliation) differ.

**Bug:** `pendingBonus(_user)` at L319 calls `_boostedAmountAt(_user, block.timestamp)` to compute the historical-clamped boost. With the DR2-02 fix, autoMaxLock=true positions return cached unconditionally. So `pendingBonus` shows the inflated cached value for any autoMaxLock user in the post-lockEnd / pre-claimAll window. Frontend dashboards display "you have N TOWELI pending" where N is computed against an inflated effectiveBoost, but the actual `claimAll` payout (which uses live `info.boostedAmount` AFTER the staking-side restoration) may differ. For autoMaxLock-MAX positions (X = MAX) the inflated and the claim-time boost happen to coincide, so the displayed value matches actual payout. For autoMaxLock positions that were below MAX before the kick (e.g., user manually toggled autoMaxLock with a smaller boost configuration), they diverge.

**Attack / Impact:** Pure observability. Frontends display a number that may not match the next claim. Not financial. Documenting because it's the same exact code path as DR3-01 — closing DR3-01 with a `lockEnd`-based clamp also closes this one.

**Evidence:**
```solidity
// L319
uint256 effectiveBoost = _boostedAmountAt(_user, block.timestamp);
// _boostedAmountAt at L433 returns cached for autoMaxLock=true
```

**Recommendation:** Closes automatically with the DR3-01 fix. No separate change needed.

---

## [DR3-07] DR2-03 forfeit-event emits the OLD `rewardRate` during `notifyRewardAmount` even when the new period is about to set a fresh rate — observability monitor double-counts forfeits across period boundaries
**Severity:** Low
**File:** `contracts/src/TegridyLPFarming.sol:182-202`
**Category:** event / observability

**Bug:** When `notifyRewardAmount` is called after a period drained with no stakers (`totalEffectiveSupply == 0` and `block.timestamp >= periodFinish`), the modifier fires:
1. `lastTimeRewardApplicable() = periodFinish` (since block.timestamp ≥ periodFinish).
2. `forfeit = (periodFinish - lastUpdateTime) * rewardRate` — uses the OLD `rewardRate` from the just-ending period. Correct.
3. Emits `RewardsForfeitedDuringEmptyPeriod(forfeit)`.
4. `lastUpdateTime = periodFinish`.
5. Function body sets `rewardRate = leftover + actualReward / duration` and `lastUpdateTime = block.timestamp`.

The emitted forfeit value is correct for the JUST-ENDED period. But subsequent calls within the same NEW (now-funded) period that spans an empty window will ALSO emit a forfeit event using the new `rewardRate`. An off-chain monitor summing `RewardsForfeitedDuringEmptyPeriod` events to compute "total emission lost to empty windows" needs to know whether each event corresponds to the period before-or-after a `notifyRewardAmount` call. The event payload (`uint256 amount`) is insufficient. Synthetix's reference `StakingRewards` does NOT emit a forfeit event — the gap was identified in DR-09 v1; the v2 fix added the event but didn't include enough context to distinguish period boundaries.

**Attack / Impact:** Pure observability. Off-chain refund/redistribution scripts that read this event need additional indexing (they must correlate with `RewardAdded` events for period boundaries). Not financial. Lower priority because the math STILL adds up correctly — the issue is just that the event is per-call-instance, not per-period.

**Evidence:**
```solidity
// L188-190
if (totalEffectiveSupply == 0 && lastUpdateTime < lastTimeRewardApplicable()) {
    uint256 forfeit = (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate;
    if (forfeit > 0) emit RewardsForfeitedDuringEmptyPeriod(forfeit);
}
```

**Recommendation:** Extend the event to include period-bracket context:
```solidity
event RewardsForfeitedDuringEmptyPeriod(uint256 amount, uint256 fromTimestamp, uint256 toTimestamp, uint256 rateAtForfeit);
```
Off-chain consumers can then deduplicate / bracket forfeits by their (from, to) range without correlating against `RewardAdded`.

---

## Summary

| ID | Severity | Surface | One-liner |
|---|---|---|---|
| DR3-01 | High | Restaking | DR2-02 fix is a NET regression — `_boostedAmountAt` returns inflated cached for autoMaxLock positions in the kick window EVEN BEFORE restoration; v1 DR-04 had correctly closed this case |
| DR3-02 | Medium | Restaking | `claimAll` DR2-04 sync mutates state BEFORE the second `staking.positions` re-read; if that read reverts, the partial mutation is silently swallowed by the outer try/catch |
| DR3-03 | Medium | Restaking | `emergencyWithdrawNFT` retains unguarded `totalActivePrincipal -= info.positionAmount` — DR2-01's sibling-search missed the SIXTH site |
| DR3-04 | Medium | Restaking | `emergencyForceReturn` settles bonus on stale cached boost without re-sync, AND fails to anchor `info.bonusDebt` post-payout (CEI violation) |
| DR3-05 | Medium | Restaking | DR2-01's permissionless `decayExpiredRestaker` sync of `info.positionAmount` to 0 (for force-closed positions) bricks `recoverStuckPrincipal` — original deposit anchor lost |
| DR3-06 | Low | Restaking | `pendingBonus` view-side sibling of DR3-01 — inflated for autoMaxLock kick window; closes automatically with DR3-01 fix |
| DR3-07 | Low | LPFarming | DR2-03 forfeit event lacks per-period context (rate / from-to-timestamps); off-chain consumers cannot deduplicate across period boundaries without joining `RewardAdded` events |

**One High, four Medium, two Low — seven new findings.**

The single High (DR3-01) is the most consequential — it is a NET REGRESSION introduced by the v2 fix scope. The DR2-02 patch closed the case it was aimed at (well, actually it didn't even close that case — see the trace analysis in the body) but reopened the broader case the v1 DR-04 clamp had successfully closed. Recommended fix is to switch to the lockEnd-anchored clamp the v2 finding originally suggested as option (a), which closes BOTH the v1 DR-04 case AND the v2 DR2-02 case AND DR3-01 in one change.

DR3-02 / DR3-03 / DR3-04 / DR3-05 are all the same shape: the v2 fix scope was tight ("five sites for DR2-01", "post-getReward sync for DR2-04", "settle on cached for emergency exit") but the supporting invariants and sibling code paths were not enumerated. DR3-03 explicitly counts a sixth site the v2 commit message claimed wasn't there. DR3-05 is the gnarliest — DR2-01 fixed a leak but introduced a permissionless griefing vector that locks out `recoverStuckPrincipal` for force-closed users. The recommended fix (separate `originalPrincipal` anchor) is a small structural change but would close the entire grief class.

The single highest-leverage second-pass v3 fix is **DR3-01** — switch `_boostedAmountAt` to lockEnd-anchored clamping. Closes DR3-01, DR3-06, AND keeps the DR-04 / DR2-02 protection for the original cases. Should be paired with a forge invariant test that fuzzes "autoMaxLock holder + kick at random T_kick + epoch lookup at random T_ts ∈ (T_kick, claimAll.timestamp)" and asserts return value is 0 for all T_ts > lockEnd.
