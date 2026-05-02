# Deep Audit v2 — TegridyRestaking + TegridyLPFarming (post-fix re-audit)
**Date:** 2026-05-01
**Scope:** `contracts/src/TegridyRestaking.sol` (1,500 LOC) + `contracts/src/TegridyLPFarming.sol` (503 LOC)
**Method:** Re-audit of commit `a04acbe` (closes 11 DEEP-DR findings). Looking for regressions, half-installed mitigations, and new gaps the v1 sweep missed.
**v1 status:** All 11 v1 findings (DR-01..DR-11) appear closed at the surface fixes describe. This pass focuses on (a) regressions from those fixes, (b) sibling / extended versions of the same bug class, and (c) new issues spotted during the focused re-read.

---

## [DR2-01] Stale-path `info.positionAmount = 0` overwrite leaks principal into `totalActivePrincipal` (DR-02 sibling miss across `unrestake`, `claimAll`, `refreshPosition`, `decayExpiredRestaker`)
**Severity:** High
**File:** `contracts/src/TegridyRestaking.sol:572, :689, :489, :1416` (the four stale-path principal overwrites) + `:755` (the broken decrement)
**Category:** accounting / state-drift / sibling-miss

**Bug:** DR-02 fixed `emergencyForceReturn` to decrement `totalActivePrincipal` by the user's CACHED `info.positionAmount` before delete. The fix did not extend to the four OTHER sites where the stale-path overwrites `info.positionAmount` with the staking-side `currentAmount` (which is `0` for any position that was force-closed via `emergencyExitPosition` while the NFT was held by this contract). After the overwrite, `totalActivePrincipal -= info.positionAmount` (`unrestake:755`) decrements `0`, leaving the OLD principal permanently leaked into `totalActivePrincipal`.

**Affected sites (all four perform the same overwrite-before-decrement antipattern):**
1. `claimAll` stale-path: `info.positionAmount = currentAmount` at `:572` — followed by no `totalActivePrincipal` update. The principal stays inflated forever.
2. `unrestake` stale-path: `info.positionAmount = currentAmount` at `:689` — then `totalActivePrincipal -= info.positionAmount` at `:755` subtracts `currentAmount` (0 if force-closed) instead of the cached `oldAmount` (`:688`).
3. `refreshPosition` stale-path: `info.positionAmount = newAmount` at `:489` — same.
4. `decayExpiredRestaker`: `info.positionAmount = currentAmount` at `:1416` (after R017 settlement) — same. Permissionless entrypoint, highest leverage.

**Attack / Impact:** Same blast radius as DR-02. A position is force-closed in TegridyStaking (`emergencyExitPosition`); the NFT is held by the restaking contract. Any honest user calls one of the four functions above. Their cached `positionAmount` (e.g., 10k TOWELI) is overwritten by `currentAmount = 0` BEFORE the conditional `totalActivePrincipal -= info.positionAmount` decrement runs, so the decrement subtracts 0 and the 10k leaks. Multiplied across N force-closed users, `totalActivePrincipal` accumulates phantom principal that drives `recoverStuckPrincipal`'s `othersPrincipal` calculation upward — silently DOS'ing legitimate force-closed recoveries (the entrypoint reverts with `NO_RECOVERABLE_BALANCE`). The DR-02 fix is the documented closure of this bug class for this contract; it was applied to one of five sites.

**Evidence:**
```solidity
// :686-692 (unrestake stale-path)  — overwrite BEFORE decrement
uint256 oldAmount = info.positionAmount;       // captured but only used in event
info.positionAmount = currentAmount;            // 0 for force-closed
info.boostedAmount = currentBoosted;
_writeBoostCheckpoint(msg.sender, currentBoosted);
totalRestaked = totalRestaked - oldBoosted + currentBoosted;
// (no totalActivePrincipal update here)
...
// :754-755  — decrement uses POST-overwrite value
totalActivePrincipal -= info.positionAmount;    // subtracts 0, leaks oldAmount
```

**Recommendation:** In every stale-path that overwrites `info.positionAmount`, also adjust `totalActivePrincipal`:
```solidity
totalActivePrincipal = totalActivePrincipal + currentAmount > oldPositionAmount
    ? totalActivePrincipal + currentAmount - oldPositionAmount
    : 0;
info.positionAmount = currentAmount;
```
And change `unrestake:755` / `emergencyWithdrawNFT:1061` to subtract the OLD cached value (capture before the stale-path runs). Add an invariant test: `totalActivePrincipal == sum(restakers[u].positionAmount over all active u)` after every state-mutating call, run against a fuzz that includes a force-closed sub-call.

---

## [DR2-02] DR-04 fix's `min(cached, current)` broken by `autoMaxLock` boost restoration via `staking.getReward` / `toggleAutoMaxLock` — RevenueDistributor over-credit reopens
**Severity:** High
**File:** `contracts/src/TegridyRestaking.sol:359-388` (`_boostedAmountAt`) + `contracts/src/TegridyStaking.sol:835-856` (`getReward` autoMaxLock branch) + `:662-689` (`toggleAutoMaxLock`)
**Category:** invariant-violation / cross-contract assumption-break

**Bug:** The DR-04 fix's clamp `min(checkpointed, staking.current)` rests on the documented assumption "boost monotonically decays over time, so the current value is a safe upper bound for any past timestamp ≤ now." That assumption is FALSE for `autoMaxLock` positions. After `staking.kick(tokenId)` zeroes `boostedAmount`, the very next `staking.getReward(tokenId)` (called by the restaking contract's `claimAll` at `:606`!) detects `p.autoMaxLock && p.boostedAmount == 0` and **re-applies MAX_BOOST** at `TegridyStaking:847-851`. The staking-side `boostedAmount` jumps from 0 back to MAX in the SAME `claimAll` transaction.

For any historical timestamp `ts ∈ (lockEnd, claimAll.block.timestamp)`, the user actually held boost = 0 (post-kick). But `_boostedAmountAt(user, ts)` returns:
- `cached` = trace `upperLookup(ts)` = pre-kick checkpoint = inflated boost X
- `current` = staking.positions(tokenId).boostedAmount = MAX (just restored)
- `min(cached, current)` = X (inflated)

RevenueDistributor reads X for an epoch in the kick-window and pays the user as if their lock were still active. Pre-fix v1's DR-04 attack is reopened — only the trigger is different. Now the trigger is the user's own `claimAll` (not someone else's `kick`).

**Attack / Impact:** (1) Alice restakes a max-lock position with `autoMaxLock = true`, boost = X. (2) Lock expires at T0. (3) Distributor creates an epoch at T2. Alice does not interact. (4) `staking.kick(aliceTokenId)` runs at T1 < T2 (permissionless decay sweeper). Restaking checkpoint stays at X — but now `_boostedAmountAt(alice, T2) = min(X, 0) = 0`. ✓ DR-04 fix works for THIS distributor lookup. (5) Alice (or anyone — `claimAll` is unrestricted to caller) calls `restaking.claimAll()`. The stale-path correctly writes a NEW checkpoint at `block.timestamp` of value 0. Then `staking.getReward(info.tokenId)` re-applies MAX boost on the staking side (autoMaxLock branch). (6) Distributor reads `_boostedAmountAt(alice, T2)` AGAIN for a re-claim or a separate epoch lookup — now returns `min(prev_checkpoint_X, MAX) = X`. Over-credit. The protection assumed staking-side decay is monotonic; autoMaxLock breaks that.

Same exposure surface as DR-04, but the fix's monotonicity-of-`current` assumption fails specifically when the restaking contract's own `claimAll` triggers the restoration. The fix is incomplete.

**Evidence:**
```solidity
// TegridyRestaking:606 — claimAll calls staking.getReward
try staking.getReward(info.tokenId) returns (uint256 baseEarned) { ... }

// TegridyStaking:844-853 — autoMaxLock RESTORES boost when decayed
if (p.autoMaxLock) {
    p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
    p.lockDuration = uint32(MAX_LOCK_DURATION);
    if (p.boostedAmount == 0 && p.amount > 0) {
        uint256 newBoost = MAX_BOOST_BPS;        // ← non-monotonic restore
        if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS;
        _applyNewBoost(p, newBoost);
    }
}
```

**Recommendation:** The clamp must use the per-checkpoint historical max rather than the live staking value. Either (a) clamp by `staking.positions(...).lockEnd` — if `lockEnd < ts`, return 0 (the position WAS expired at ts, regardless of subsequent restoration) — or (b) write a checkpoint at value 0 when kick is detected at next-touch, then NEVER read `current` for `_boostedAmountAt`. Pattern of record: Curve `LiquidityGaugeV4.working_balances` snapshots boost at refresh time and never queries live source for historical lookups.

---

## [DR2-03] DR-09 fix turns "first-staker forfeit" into "first-staker windfall" — empty-period emission now MEV-extractable by sandwich
**Severity:** High
**File:** `contracts/src/TegridyLPFarming.sol:172-187` (`updateReward`)
**Category:** reward-math / inversion / MEV
**Note:** This is a regression — the DR-09 fix flips the failure mode from "silently forfeit" to "first-staker captures."

**Bug:** Pre-fix, the modifier always advanced `lastUpdateTime = lastTimeRewardApplicable()`. During an empty period (`totalEffectiveSupply == 0`), the elapsed emission was forfeited (no denominator to credit). DR-09 added `if (totalEffectiveSupply > 0)` to gate the advance, so `lastUpdateTime` is FROZEN during empty windows. The next first-staker's `userRewardPerTokenPaid = rewardPerTokenStored` snapshots the PRE-empty-period value, then their next claim's `rewardPerToken()` includes the entire empty-window elapsed × rate / NEW_totalEffectiveSupply. Result: the first-staker captures every wei the empty window emitted.

This is a HIGH because it's a permissionless, capital-efficient MEV extraction. An attacker monitors the pool. When `totalEffectiveSupply` decays to 0 (last staker exits or emergencyWithdraws), they wait for the empty window to accumulate, then sandwich: stake N (becoming sole staker), call `getReward` to lock in the empty-period bonus, withdraw N. The cost is gas + 1-block exposure to other stakers entering the same block; the prize is `(elapsed_empty * rewardRate)` — potentially hours of emission for a flash-loan-funded LP token deposit.

**Attack / Impact:** (1) Owner funds 1000 TOWELI over 7 days at `notifyRewardAmount`; `lastUpdateTime = T0`. (2) The pool's last staker exits at T1 (totalEffectiveSupply → 0). (3) From T1 to T2, no stakers — emission accrues nowhere because `rewardPerToken()` returns `rewardPerTokenStored` unchanged. **`lastUpdateTime` stays at T1** because of the new gate. (4) Attacker stakes a tiny LP amount at T2. Their `userRewardPerTokenPaid = rewardPerTokenStored` (snapped at T1). (5) Time advances to T3 = T2 + 1 block. Attacker calls `getReward()`. `rewardPerToken() = rewardPerTokenStored + (T3 - T1) * rewardRate * 1e18 / totalEffectiveSupply`. Their earned = `effectiveBalanceOf[attacker] * (rewardPerToken() - userRewardPerTokenPaid[attacker]) / 1e18 = (T3 - T1) * rewardRate / 1` (since attacker is sole staker). For a 12h empty window at 1 TOWELI/sec = 43,200 TOWELI captured by the attacker for two blocks of presence. Pre-fix this would have been 0 (empty period was forfeit).

**Note:** The original DR-09 finding correctly identified the forfeiture as undesirable observability gap and recommended TWO options: (a) emit a `RewardsForfeitedDuringEmptyPeriod` event, or (b) preserve `lastUpdateTime` until first stake. The patch chose (b), but option (b) is the more aggressive fix — it changes economics, not just observability. Option (a) would have closed the visibility gap without creating a sandwich vector. Synthetix's reference implementation chose forfeiture deliberately to prevent exactly this attack.

**Evidence:**
```solidity
// :179-181 — gate skips lastUpdateTime advance during empty windows
if (totalEffectiveSupply > 0) {
    lastUpdateTime = lastTimeRewardApplicable();
}
// :193-198 — rewardPerToken includes the elapsed empty period once a staker arrives
function rewardPerToken() public view returns (uint256) {
    if (totalEffectiveSupply == 0) return rewardPerTokenStored;
    return rewardPerTokenStored + (
        (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18 / totalEffectiveSupply
    );
}
```

**Recommendation:** Revert to the unconditional `lastUpdateTime = lastTimeRewardApplicable()` AND add the missing observability event:
```solidity
modifier updateReward(address account) {
    rewardPerTokenStored = rewardPerToken();
    if (totalEffectiveSupply == 0 && lastUpdateTime < lastTimeRewardApplicable()) {
        uint256 forfeit = (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate;
        if (forfeit > 0) emit RewardsForfeitedDuringEmptyPeriod(forfeit);
    }
    lastUpdateTime = lastTimeRewardApplicable();
    ...
}
```
Pattern of record: Synthetix `StakingRewards` (forfeit + observability via off-chain monitoring of `rewardRate * elapsed > totalDistributed`).

---

## [DR2-04] `claimAll` stale-path + `staking.getReward` autoMaxLock interaction silently zeroes restaker's bonus accrual until next `refreshPosition`
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:545-601` (`claimAll` stale-path) + `:606` (`staking.getReward` call)
**Category:** state-desync / silent-failure

**Bug:** When a restaked autoMaxLock position has been kicked (boost decayed to 0 on staking side), `claimAll`'s stale-detect block writes `info.boostedAmount = 0` and the boost checkpoint to 0 (`:573-574`). Then `staking.getReward(info.tokenId)` (`:606`) restores the staking-side `boostedAmount` to MAX via the autoMaxLock branch. After the call, the staking position has MAX boost, but the restaking cache says 0. The user is dropped from `totalRestaked` (already, in `:575`) and accrues zero bonus until they manually call `refreshPosition` to re-sync.

**Attack / Impact:** Honest user with autoMaxLock=true position, restaked. Lock expires; kick fires. User calls `claimAll()` to receive base+bonus rewards. They get the kick-period base reward via `staking.getReward` (which also re-applies MAX boost). They get a small post-kick bonus settlement. From that point on, their `info.boostedAmount = 0` so they earn 0 bonus emission — even though their staking position has MAX boost active. The user must manually call `refreshPosition` to re-enter the bonus accrual, but the system gives no signal that this is needed (no event, no view returns "0 bonus pending" because `pendingBonus` returns 0 honestly). The user silently watches their bonus APR drop to zero.

This is a Medium because the fix is one extra step (`refreshPosition`), but the discovery surface is poor: most users will not notice until they compare to other restakers' rates.

**Evidence:**
```solidity
// :573-574 — stale-path zeroes the cache and checkpoint
info.boostedAmount = currentBoosted;            // = 0 after kick
_writeBoostCheckpoint(msg.sender, currentBoosted);
// :606 — staking.getReward restores boost to MAX (autoMaxLock branch)
try staking.getReward(info.tokenId) returns (uint256 baseEarned) { ... }
// info.boostedAmount stays 0; user is silently dropped from accrual
```

**Recommendation:** Re-read `staking.positions(info.tokenId).boostedAmount` AFTER the `staking.getReward` call to detect autoMaxLock-induced restoration; if non-zero, set `info.boostedAmount = newBoosted` and write a fresh checkpoint. Same pattern in `unrestake` for symmetry (already handled by the toggleAutoMaxLock disable, but defense-in-depth).

---

## [DR2-05] DR-07 cooldown blocks IMMEDIATE defensive cancel of a captured-key propose for 24h
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:885-926`
**Category:** governance / asymmetric-defense

**Bug:** The DR-07 fix gates BOTH `proposeBonusRate` and `cancelBonusRateProposal` behind a 24h cooldown from `lastBonusRateActionAt` (last propose OR cancel timestamp). This stops the propose+cancel churn loop the v1 finding documented. Side effect: it also blocks the FIRST cancel within 24h of a propose. So when an attacker with one captured signer proposes a malicious rate, the legitimate signers cannot cancel for 24h. The 48h timelock continues to count down, leaving only 24h cancel window. This halves the defensive responsiveness of the multisig.

**Attack / Impact:** Captured signer proposes `pendingBonusRate = MAX_BONUS_REWARD_RATE = 100e18` at T0. `lastBonusRateActionAt = T0`. Legitimate signers detect the rate-proposal event at T0+1h. They try `cancelBonusRateProposal()` — REVERTS with `BonusRateActionCooldown` (need T0 + 24h). They wait. They cancel at T0+24h. Then they want to propose a defensive `pendingBonusRate = 0` — REVERTS again because `lastBonusRateActionAt = T0+24h` and the cooldown gate blocks until T0+48h. So the defensive cycle is propose-malicious → wait 24h → cancel → wait 24h → propose-defensive → wait 48h timelock → execute. Total: 4 days of attacker rate having a chance to land before defensive rate can timelock through.

Pre-fix the cycle was: propose-malicious → IMMEDIATE cancel → IMMEDIATE propose-defensive → 48h timelock → execute. Total: 48h. The fix made the defensive case 2x slower while making the malicious churn case impossible (good). Trade-off is asymmetric.

**Evidence:**
```solidity
// :890-893 — gate applies to all proposes (not just churn case)
if (lastBonusRateActionAt != 0 &&
    _executeAfter[BONUS_RATE_CHANGE] == 0 &&
    block.timestamp < lastBonusRateActionAt + BONUS_RATE_ACTION_COOLDOWN) {
    revert BonusRateActionCooldown();
}
// :917-920 — same gate on cancel
if (lastBonusRateActionAt != 0 &&
    block.timestamp < lastBonusRateActionAt + BONUS_RATE_ACTION_COOLDOWN) {
    revert BonusRateActionCooldown();
}
```

**Recommendation:** Cancel should NOT be gated by the cooldown — the multisig must be able to cancel any pending proposal immediately. Restrict the cooldown to consecutive PROPOSALS. The churn vector this prevents is not "propose then cancel" (that's normal defensive use), it's "propose, cancel, propose, cancel..." which is just consecutive proposals. Replace the cancel-side check with a `_lastProposeAt` separate state field:
```solidity
uint256 public lastBonusRateProposeAt;  // ONLY tracks proposes, not cancels
function proposeBonusRate(uint256 _rate) ... {
    if (lastBonusRateProposeAt != 0 && block.timestamp < lastBonusRateProposeAt + 24 hours)
        revert BonusRateActionCooldown();
    lastBonusRateProposeAt = block.timestamp;
    ...
}
function cancelBonusRateProposal() external onlyOwner {
    // No cooldown — defensive cancel is always allowed
    _cancel(BONUS_RATE_CHANGE);
    ...
}
```

---

## [DR2-06] `pendingBonus` view (and so `_boostedAmountAt`-routed lookups) reverts when `bonusRewardToken.balanceOf` reverts — frontend & integrators silently break
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:283-304` (`pendingBonus`) + `:359-388` (`_boostedAmountAt`)
**Category:** view-fragility

**Bug:** `pendingBonus` at `:291` calls `bonusRewardToken.balanceOf(address(this))` directly without try/catch. The `_accrueBonus` mutator at `:1443-1447` wraps this same call in try/catch (DR-06 fix). The view did not get the same treatment. If `bonusRewardToken` is paused/blacklisted/upgraded to revert on `balanceOf`, ALL `pendingBonus` reads revert — every frontend dashboard, every off-chain indexer, every contract-level integrator that calls this view. Same concern applies to `pendingTotal` which delegates.

**Attack / Impact:** Hostile or compromised `bonusRewardToken`. `pendingBonus` stops functioning. Frontends crash. Integrators (e.g., a yield aggregator displaying combined bonus + base) break their UIs. No financial loss; observability and integration breakage. Pre-existing issue, but the DR-06 fix established the protect-with-try/catch pattern for the same call — applying it to the view is a one-line consistency fix.

**Evidence:**
```solidity
// :291 — view reverts on hostile bonus token
uint256 available = bonusRewardToken.balanceOf(address(this));
// vs :1443-1447 in _accrueBonus
try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
    available = bal;
} catch { available = 0; }
```

**Recommendation:** Apply the same try/catch wrap in `pendingBonus`. Consider extracting a shared `_safeBonusBalance() internal view returns (uint256)` helper to eliminate the duplicated guarded-balance pattern (currently in `updateBonus` modifier, `_accrueBonus`, and one missing site in `pendingBonus`).

---

## [DR2-07] `_boostedAmountAt` under-credits historical lookups for users who unrestake-then-restake with a SMALLER position
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:359-388`
**Category:** view-staleness / edge-case

**Bug:** The DR-04 clamp `min(cached, current)` assumes `current` is a safe upper bound for any past timestamp. This holds for one continuous restake (boost only decays). It FAILS when a user unrestakes, then restakes a different position with smaller `boostedAmount`. For epochs in the OLD restake's window, the trace `upperLookup` returns the (large) old boost, but `current` is the (small) new boost. `min` returns the small new boost — under-crediting the user for the old period.

**Attack / Impact:** Alice restakes position A with boost = 100 from T0 to T1. Unrestake at T1 (checkpoint = 0). Alice restakes position B with boost = 50 at T2. RevenueDistributor lookup for ts ∈ (T0, T1): trace = 100, current = 50, `min` returns 50. Alice loses half her revenue share for old epochs. Permissionless, no attack required — automatic regression of DR-04 for the multi-position user flow.

This is Low because it requires the user to unrestake AND re-restake with a smaller position (uncommon), and the loss is a missed payout (not a fund drain). But it's a real silent reduction in entitlement.

**Evidence:**
```solidity
// :387 — clamp under-credits when current < cached_at_old_period
return cached < current ? cached : current;
```

**Recommendation:** Track per-restake-cycle separately, or use the trace-only value for historical lookups while validating with a per-position `lockEnd` check (return 0 if `lockEnd_at_ts < ts`). Since this requires deeper refactor, accept the under-credit as documented behavior and emit an event when a restake-cycle starts so off-chain consumers can stitch together the historical view.

---

## [DR2-08] DR-11 `holdsToken` check is correct but adds duplicate revert path — single typed error covers two distinct cases, reducing forensic clarity
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:398-405`
**Category:** observability / error-typing

**Bug:** The DR-11 fix added `if (!staking.holdsToken(msg.sender, _tokenId)) revert NotNFTOwner();` immediately after the existing `if (stakingNFT.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();`. Both revert with the same `NotNFTOwner()` typed error. Off-chain monitors (Tenderly alerts, etcetera.) cannot distinguish "ERC721 ownership mismatch" from "staking-side per-owner-set divergence." The latter is the future-compat scenario the fix is designed to detect — it's rare and would be very valuable to alert on if it ever fires (signals a TegridyStaking ABI/semantics drift).

**Attack / Impact:** Pure observability. A future TegridyStaking upgrade that introduces the wrapper-of-ownership scenario the DR-11 fix protects against would be silently caught by `NotNFTOwner()` instead of a distinct error like `StakingPositionSetMismatch()`. Diagnosis would require contract-level instrumentation rather than alert-rule pattern matching.

**Evidence:**
```solidity
// :398-405 — both checks share the same error
if (stakingNFT.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();
if (!staking.holdsToken(msg.sender, _tokenId)) revert NotNFTOwner();  // ← same error, different cause
```

**Recommendation:** Add a distinct typed error for the staking-side check, e.g. `error StakingOwnershipDesync()`. Keep the one-line semantic but make the failure surface diagnosable.

---

## Summary

| ID | Severity | Surface | One-liner |
|---|---|---|---|
| DR2-01 | High | Restaking | DR-02 sibling miss across `unrestake`/`claimAll`/`refreshPosition`/`decayExpiredRestaker` — `info.positionAmount = 0` overwrite leaks principal into `totalActivePrincipal` |
| DR2-02 | High | Restaking | DR-04 clamp's "boost is monotonically decaying" assumption breaks under autoMaxLock restoration — RevenueDistributor over-credit reopens via the user's own `claimAll` |
| DR2-03 | High | LPFarming | DR-09 fix flips first-staker forfeit into a first-staker windfall — empty-period emission becomes MEV-extractable via sandwich |
| DR2-04 | Medium | Restaking | `claimAll` + autoMaxLock interaction silently zeroes restaker's bonus accrual until manual `refreshPosition` |
| DR2-05 | Medium | Restaking | DR-07 cooldown blocks IMMEDIATE defensive cancel — halves multisig defensive responsiveness |
| DR2-06 | Low | Restaking | `pendingBonus` view lacks the try/catch on `bonusRewardToken.balanceOf` that DR-06 added to `_accrueBonus` — view-side fragility |
| DR2-07 | Low | Restaking | DR-04 clamp under-credits for unrestake→smaller-restake flows |
| DR2-08 | Low | Restaking | DR-11 staking-side check shares a typed error with the ERC721 check — reduces forensic clarity |

**Three High, two Medium, three Low — eight new findings.**

The two High Restaking findings (DR2-01, DR2-02) are direct **regressions** of the v1 fix scope: DR2-01 is the same bug class as DR-02 in four sibling sites that the patch missed; DR2-02 invalidates the assumption underpinning the DR-04 clamp. DR2-03 is a regression of DR-09's economic behavior — the patch closed the observability gap but introduced a sandwich vector. DR2-04 / DR2-05 are second-order interactions that the per-finding fix scope did not consider holistically. DR2-06 / DR2-07 / DR2-08 are observability / forward-compat gaps surfacing from the fix patterns.

The single highest-leverage second-pass fix is **DR2-01** — extend the DR-02 decrement to all four stale-path sites (use cached OLD `info.positionAmount`, not the post-overwrite value) AND add the invariant test the v1 report requested. **DR2-02** is the most architecturally significant — it indicates the DR-04 fix needs a per-checkpoint-historical-max model rather than a live-clamp model, because `autoMaxLock` is a non-monotonic restoration source the v1 sweep did not enumerate.
