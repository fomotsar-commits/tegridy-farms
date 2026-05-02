# Deep Audit — TegridyRestaking + TegridyLPFarming
**Date:** 2026-05-01
**Scope:** `contracts/src/TegridyRestaking.sol` (1,422 LOC) + `contracts/src/TegridyLPFarming.sol` (511 LOC)
**Method:** Microscope follow-up — only NEW findings vs. prior batches A-J + the 04-30 microscope.
**Excluded (already documented):** H5 (claimAll over-credit), H7 (LPFarming zero-decay), H8 (emergencyForceReturn brick), M-S3 (revalidateBoost CEI), M-S5 (notifyRewardAmount duration bypass), and every `015_TegridyRestaking.md` / `010_TegridyLPFarming.md` finding.

---

## [DR-01] `claimPendingUnsettled` does not reserve `totalUnforwardedBase` / `totalActivePrincipal` (cross-user fund drain — sibling miss)
**Severity:** High
**File:** `contracts/src/TegridyRestaking.sol:784-802`
**Category:** reward / accounting / sibling-miss

**Bug:** `claimPendingUnsettled` pays the caller out of `rewardToken.balanceOf(address(this))` with no reservation logic, while `recoverStuckPrincipal` (`:884-889`) carefully reserves `totalUnforwardedBase + totalPendingUnsettled + othersPrincipal`. Same accounting model, asymmetric guards. Matches the post-remediation ledger's "half-installed mitigation" pattern (R014 / M-12 / M-30 / M-P01). Pre-fix this was the H-1 in `015_TegridyRestaking.md`; the microscope's "sibling search" recommendation never reached this entrypoint.

**Attack / Impact:** (1) Bob and Carol hold restaked NFTs. (2) Carol unrestakes during a concurrent `claimUnsettled()` race — her shortfall lands in `pendingUnsettledRewards[carol]` and `totalPendingUnsettled` rises. (3) Owner uses `proposeAttributeStuckRewards` + `execute` to credit Bob's `unforwardedBaseRewards`. (4) Carol calls `claimPendingUnsettled()` — `available = balance` includes Bob's attributed share AND every still-active restaker's principal; `payout = min(owed, available)` drains them. Bob's later `claimAll` reads `unforwardedBaseRewards[bob] - actual` math correctly but balance is gone, so `actual = remaining balance` and the rest silently zero-decrements `unforwardedBaseRewards[bob]`. Cross-user transfer with no event flagging the loss.

**Evidence:**
```solidity
// :784-801  — no reservation
uint256 available = rewardToken.balanceOf(address(this));
uint256 payout = owed > available ? available : owed;
pendingUnsettledRewards[msg.sender] = owed - payout;

// vs :884-889  — full reservation in sibling
uint256 othersPrincipal = totalActivePrincipal >= originalAmount
    ? totalActivePrincipal - originalAmount : 0;
uint256 reserved = totalUnforwardedBase + totalPendingUnsettled + othersPrincipal;
uint256 recoverable = balance > reserved ? balance - reserved : 0;
```

**Recommendation:** Mirror the `recoverStuckPrincipal` reservation:
```solidity
uint256 balance = rewardToken.balanceOf(address(this));
uint256 reserved = totalUnforwardedBase + totalActivePrincipal;
uint256 available = balance > reserved ? balance - reserved : 0;
```
Subtract msg.sender's own pending from `totalPendingUnsettled` only after computing `available`.

---

## [DR-02] `emergencyForceReturn` never decrements `totalActivePrincipal` (silently locks principal for honest recoverers)
**Severity:** High
**File:** `contracts/src/TegridyRestaking.sol:1056-1133`
**Category:** accounting / state-drift

**Bug:** Audit I-5 in `015_TegridyRestaking.md` flagged this as borderline-Medium and recommended escalation. After Batch G (H-8) shipped, `emergencyForceReturn` decrements `totalRestaked` (`:1104`) and writes the H-8 boost checkpoint to zero (`:1130`) — but still NEVER decrements `totalActivePrincipal`. The restaker's `info.positionAmount` stays counted in `totalActivePrincipal` forever even after `delete restakers[restaker]` (`:1117 / :1128`). This is the only NFT-exit path that omits this update; `unrestake` (`:721`), `emergencyWithdrawNFT` (`:977`), and `recoverStuckPrincipal` (`:909-913`) all do it.

**Attack / Impact:** Owner pauses + emergencyForceReturns Alice (10k principal). `totalActivePrincipal` stays 10k. Bob's later `recoverStuckPrincipal` computes `othersPrincipal = totalActivePrincipal - bobOriginal = 10k`, reserving 10k of Bob's recoverable pool for a phantom Alice position. With sufficient sequential force-returns, the reservation can exceed actual balance, permanently DOS'ing `recoverStuckPrincipal` for legitimate force-closed users. No griefing required — the bug is automatic.

**Evidence:**
```solidity
// :1103-1104 — only totalRestaked is updated
totalRestaked -= info.boostedAmount;
// :1116-1128 — restaker state deleted but totalActivePrincipal preserved
delete tokenIdToRestaker[tokenId];
delete restakers[restaker];
// totalActivePrincipal NOT touched — invariant violated
```

**Recommendation:** Insert `totalActivePrincipal -= info.positionAmount;` (with the same underflow guard as `recoverStuckPrincipal`) immediately after line 1104. Add an invariant test: `totalActivePrincipal == sum(restakers[user].positionAmount over active users)`.

---

## [DR-03] `decayExpiredRestaker` calls `_accrueBonus()` instead of `_accrueBonusChecked()` — monotonicity tripwire bypassed
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:1285-1341`
**Category:** defense-in-depth / sibling-miss

**Bug:** Every other accrual site in this contract uses `_accrueBonusChecked()` (`:449, :460, :543, :561, :662, :676`), the wrapper that snapshot/asserts `accBonusPerShare` is monotonically non-decreasing. `decayExpiredRestaker` at `:1329` calls the unchecked `_accrueBonus()` directly. The NatSpec at `:1383-1405` is explicit: "Replace every direct call to `_accrueBonus()` in stale-path / R017 code paths with this wrapper." This site was missed. `emergencyForceReturn` (`:1067-1078`) also inlines its own copy of the accrual logic, bypassing the wrapper entirely.

**Attack / Impact:** A malicious or buggy subclass overriding `_accrueBonus` (the function is `virtual` at `:1360` exactly to bait such overrides) can decrement `accBonusPerShare` during `decayExpiredRestaker` to siphon emission. The unchecked direct call does not trip `AccrueNotMonotone()`. Limited blast radius (requires upgrade), but the entire purpose of the `virtual`+`Checked` co-design is to plug this — and decay is a permissionless entrypoint, the highest-leverage one for an attacker.

**Evidence:**
```solidity
// :1329 — direct call, bypasses tripwire
_accrueBonus();
// vs :449, :543, :561, :662, :676 etc.
_accrueBonusChecked();
```

**Recommendation:** Replace `_accrueBonus()` at `:1329` with `_accrueBonusChecked()`. Refactor `emergencyForceReturn`'s inline accrual block (`:1067-1078`) to call `_accrueBonusChecked()` after settling the restaker. Add a forge invariant: every test that triggers decay/emergency-force-return runs with a malicious-subclass shim that decrements `accBonusPerShare` — must revert in all paths.

---

## [DR-04] `boostedAmountAt` checkpoint never updated by `staking.kick` — stale-decay window over-credits revenue distributor
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:120-122, :328-343`
**Category:** cross-contract view-staleness

**Bug:** H-8 added per-restaker `Trace208` checkpoints, written by `_writeBoostCheckpoint(...)` ONLY at sites that mutate `info.boostedAmount` (restake, refresh, claimAll-stale, unrestake-stale, decayExpiredRestaker, revalidateBoost*, emergencyWithdrawNFT, emergencyForceReturn, recoverStuckPrincipal). When TegridyStaking's permissionless `kick(tokenId)` is called by an outside party (e.g., a Curve-style decay sweeper) it zeroes `boostedAmount` on the staking side AND writes the staking-side checkpoint, but does NOT call back into TegridyRestaking. The restaking checkpoint trace stays stuck on the pre-decay value. `RevenueDistributor._restakedPowerAt(user, ts)` (`:517-524`) calls `boostedAmountAt(user, ts)` and gets the inflated cached value for any `ts` between `lockEnd` and the next restaking-side mutation.

**Attack / Impact:** (1) Alice restakes a 1-year max-boost position. (2) Lock expires at T0. (3) Anyone calls `staking.kick(aliceTokenId)` at T1 = T0+1 (zeroes staking-side boost; restaking cache untouched). (4) Distributor creates an epoch at T2 = T1+1 day. (5) Alice's claim reads `_restakedPowerAt(alice, T2)` → restaking checkpoint upperLookup returns the pre-expiry inflated boost. She is paid for this epoch as if her lock were still active. Multiplied across however many epochs land before Alice (or anyone) calls a restaking-side mutation. The fix's NatSpec at `:514-516` claims "boost only decays over time, so this never over-credits" — false in the lazy-decay window.

**Evidence:**
```solidity
// :339-342 — upperLookup returns most-recent checkpoint <= _ts
if (_boostCheckpoints[_user].length() == 0) return info.boostedAmount;
return _boostCheckpoints[_user].upperLookup(SafeCast.toUint48(_timestamp));
// _writeBoostCheckpoint is never called from staking.kick
// info.boostedAmount stays stale until claimAll/refreshPosition/unrestake/decay
```

**Recommendation:** In `boostedAmountAt`, additionally read `staking.positions(info.tokenId).boostedAmount` and return `min(checkpointed, currentStaking)` — guarantees no over-credit even when the cache is lazy. Alternative: have `decayExpiredRestaker` made callable cheaply (e.g., add a permissionless wrapper that no-ops if cache is fresh) and require it as a precondition for revenue claims. Pattern of record: Curve `LiquidityGaugeV4.kick` paired with treasury sweeper bots.

---

## [DR-05] `executeRewardsDurationChange` lacks the `periodFinish` check that gates `proposeRewardsDurationChange`
**Severity:** Medium
**File:** `contracts/src/TegridyLPFarming.sol:451-465`
**Category:** timelock-bypass / asymmetric-guard

**Bug:** `proposeRewardsDurationChange` at `:453` requires `block.timestamp >= periodFinish` (no period active). `executeRewardsDurationChange` at `:459-465` has no such check — it can fire mid-period. The intent of the propose-side check is clearly "duration changes only outside an active reward period." The execute side punches through that intent: owner proposes during a quiet window, lets the 24h timelock elapse, then `notifyRewardAmount` to start a new period, then immediately `executeRewardsDurationChange` — `rewardsDuration` rotates while the period is live. The next `notifyRewardAmount` (immediately after, in the same multicall) consumes the new duration and applies it to the period that was just funded. This is M-3 in `010_TegridyLPFarming.md`, but flagged as "mostly cosmetic." It is not — combined with `notifyRewardAmount`'s leftover-rate formula, mid-period execute lets the owner extend a hostile rate's reach without the timelock that was supposed to prevent that.

**Attack / Impact:** Owner (multisig with one captured signer) routes a reward dilution: propose a 90-day duration during a quiet window, wait 24h, then `notifyRewardAmount(small_amount)` to start a tiny period, then immediately `executeRewardsDurationChange` to rotate the active period to 90 days. Stakers expecting a 7-day period now see their rewards stretched 13x with no fresh deposit by the owner. The timelock window is supposed to be the user's defense — it was bypassed.

**Evidence:**
```solidity
// :451-457
function proposeRewardsDurationChange(uint256 _newDuration) external onlyOwner {
    if (block.timestamp < periodFinish) revert PreviousPeriodNotComplete(); // ← gate
    ...
}
// :459-465
function executeRewardsDurationChange() external onlyOwner {
    _execute(REWARDS_DURATION_CHANGE);
    rewardsDuration = pendingRewardsDuration; // ← no equivalent gate
    ...
}
```

**Recommendation:** Add `if (block.timestamp < periodFinish) revert PreviousPeriodNotComplete();` to `executeRewardsDurationChange`, OR cancel any pending duration proposal whenever `notifyRewardAmount` starts a new period. Synthetix-pattern of record: `setRewardsDuration` requires `block.timestamp > periodFinish` at the SETTER side, not just the proposal side.

---

## [DR-06] `emergencyForceReturn`'s inline accrual reads `bonusRewardToken.balanceOf` without try/catch — bricks the "emergency" path
**Severity:** Medium
**File:** `contracts/src/TegridyRestaking.sol:1067-1078`
**Category:** emergency-handler-fragility

**Bug:** The `updateBonus` modifier (`:246-274`) and `_accrueBonus` (`:1360-1381`) both wrap `bonusRewardToken.balanceOf(address(this))` in a try/catch fallback (returns 0 on revert). The inline accrual block in `emergencyForceReturn` (`:1067-1078`) does NOT — it calls `bonusRewardToken.balanceOf(address(this))` directly. If `bonusRewardToken` is paused, blacklisted, or upgraded to revert on `balanceOf`, the entire emergency-force-return reverts. This is the one path the owner needs when everything else is broken — and it's gated by `whenPaused`, so users have NO escape route.

**Attack / Impact:** Hostile or upgraded `bonusRewardToken.balanceOf` reverts. Owner pauses (maybe in response). All user-facing exits (`unrestake`, `claimAll`, `refreshPosition`) revert via the `updateBonus` modifier (the try/catch returns 0 but the function still tries to `safeTransfer` later). `emergencyWithdrawNFT` works because it doesn't touch `_accrueBonus`. `emergencyForceReturn` is supposed to be the owner's last-resort tool — but it reverts inside the inline accrual block. NFTs trapped, no admin recovery. `adminRescueStuckNFT` cannot help because `tokenIdToRestaker` is still set.

**Evidence:**
```solidity
// :1069-1077  — no try/catch
if (block.timestamp > lastBonusRewardTime) {
    uint256 elapsed = block.timestamp - lastBonusRewardTime;
    uint256 reward = elapsed * bonusRewardPerSecond;
    uint256 available = bonusRewardToken.balanceOf(address(this));  // ← bricks
    if (reward > available) reward = available;
    ...
}
// vs :251-256 in updateBonus
try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
    available = bal;
} catch { available = 0; }
```

**Recommendation:** Refactor the inline accrual block to call `_accrueBonusChecked()` instead (which delegates to the try/catch-protected `_accrueBonus`). This also closes DR-03 for this entrypoint.

---

## [DR-07] `proposeBonusRate` can be re-proposed before old proposal expires via `cancelBonusRateProposal` — defeats time-budget
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:820-842`
**Category:** timelock-meta

**Bug:** Standard TimelockAdmin pattern requires owner to `_cancel()` before `_propose()` again (`:66 ExistingProposalPending`). `cancelBonusRateProposal` (`:837-842`) is `onlyOwner` with no cooldown. A captured-key attacker can `propose → cancel → propose → cancel → ...` to keep the protocol's bonus rate state churning for the full 7-day proposal validity window across all attempts. Side effects: each propose emits `BonusRateProposed`, polluting off-chain dashboards. The cancel+repropose loop also resets the 48h timelock countdown — there's no monotonic clock that tracks "owner has been trying to bump rate for X days." A multisig signer with one compromised key can effectively veto any rate change indefinitely (cancel-on-bump) without the other signers being able to enact a counter-rate without first re-cancelling and re-proposing themselves.

**Attack / Impact:** Multisig with compromised signer: legitimate signers want to lower bonusRate to ZERO during a security incident. Compromised signer cancels every proposal. Attack persists until the compromised signer is removed. All cancel/propose cycles are atomic — there's no in-flight signal a user can act on.

**Evidence:**
```solidity
// :837-842
function cancelBonusRateProposal() external onlyOwner {
    _cancel(BONUS_RATE_CHANGE);
    // no cooldown, no event of "this is the Nth cancel today"
    pendingBonusRate = 0;
    emit BonusRateCancelled(cancelledRate);
}
```

**Recommendation:** Track `lastBonusRateActionAt` and require ≥24h gap between any propose+cancel sequence. Lower priority since bonusRate change is a defensive parameter, not an offensive one.

---

## [DR-08] `pendingBonus` view returns stale-inflated value for expired-but-not-decayed restaker — frontend trust signal corrupted
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:279-296`
**Category:** view-staleness

**Bug:** `pendingBonus` reads `restakers[_user].boostedAmount` (`:280, :293`), the cached value. When the staking-side lock has expired but no restaking-side mutation has run (no `claimAll`/`unrestake`/`decayExpiredRestaker`), the cached boost is stale-inflated. The view returns inflated pending. After H5 made `claimAll` self-correct, the actual settlement is correct — but the view is not. Any frontend, indexer, or integrating contract that reads `pendingBonus` between lock expiry and the next decay sees a value that will silently shrink when `kick`+`claimAll` runs.

**Attack / Impact:** Frontend shows user "100 TOWELI bonus pending." User clicks claim → `staking.kick` decays boost → claimAll's stale path shrinks `boostedAmount` → user receives 30 TOWELI (only the period before `lastBonusRewardTime`). User reports a stolen-funds bug. Trust regression. Non-financial.

**Evidence:**
```solidity
// :293
int256 accumulated = _safeInt256((info.boostedAmount * currentAcc) / ACC_PRECISION);
// info.boostedAmount is the stale-inflated cache, not staking-current.
```

**Recommendation:** In `pendingBonus`, also read `staking.positions(info.tokenId).boostedAmount` and use `min(cached, current)`. Same pattern as DR-04. Cheap because view-only.

---

## [DR-09] LP-farming first-stake sets `userRewardPerTokenPaid` AFTER `rewardPerTokenStored` advances — first staker forfeits genesis emission
**Severity:** Low
**File:** `contracts/src/TegridyLPFarming.sol:170-179, :270-292`
**Category:** reward-math / first-depositor

**Bug:** The Synthetix `updateReward` modifier at `:170-179` advances `rewardPerTokenStored` BEFORE the body runs. For a first staker (account != 0, but rawBalanceOf == 0), `rewards[account] = earned(account)` returns 0 (effectiveBalanceOf is 0). Then `userRewardPerTokenPaid[account] = rewardPerTokenStored` — the user's anchor is the latest `rewardPerToken()` value. So far so good. BUT: at this point `lastUpdateTime` was set to `lastTimeRewardApplicable()` and `rewardPerToken()` advanced based on the OLD `totalEffectiveSupply` (zero or the prior shape). After the modifier, the `stake` function ADDs to `totalEffectiveSupply`. The effect: any micro-period emission between `lastUpdateTime` and `block.timestamp` is paid out before the first staker's effective lands in the denominator. If `totalEffectiveSupply` was zero before the first stake, `rewardPerToken()` returns `rewardPerTokenStored` (no division); `lastUpdateTime` advances. That elapsed emission is silently forfeited (no one accrues it). For each subsequent first-after-empty period, the same forfeiture repeats.

**Attack / Impact:** Owner funds 1000 TOWELI over 7 days. No one stakes for 6 days. First staker on day 6 deposits → `rewardPerToken()` returns the stored value (denominator was 0 → unchanged), `lastUpdateTime` advances to now. The staker's anchor = `rewardPerTokenStored`. From day 6 to day 7, only 1/7 of the rewards are distributed. The 6/7 that elapsed in zero-supply state vanishes. This is consistent with classic Synthetix design (and noted as "forfeited during empty periods" in the bonus modifier at `:267-272` of the restaking contract), but here there is no `BonusShortfall`-style event surfacing the loss for off-chain monitors. `totalRewardsFunded` stays at the funded amount, but `rewardRate * elapsed` math will undercount what was actually paid out by the empty-period delta.

**Evidence:**
```solidity
// :202-207 — rewardPerToken() returns stored if totalEffectiveSupply == 0
function rewardPerToken() public view returns (uint256) {
    if (totalEffectiveSupply == 0) return rewardPerTokenStored;
    ...
}
// :171-172 — lastUpdateTime advances regardless
rewardPerTokenStored = rewardPerToken();
lastUpdateTime = lastTimeRewardApplicable();
// emission for the empty period is silently forfeited
```

**Recommendation:** Either (a) emit a `RewardsForfeitedDuringEmptyPeriod(amount)` event when `lastUpdateTime` advances on zero-supply, or (b) preserve `lastUpdateTime` until first stake. (b) matches the restaking contract's `_accrueBonus` design pattern (`:267-272`: only advance when `totalRestaked > 0`). Currently restaking does the right thing but LP farming does not — fix the LP-farming side for parity.

---

## [DR-10] `_writeBoostCheckpoint` is called with the cached `boostedAmount`, not the freshly-read staking value — checkpoints can be one-step-behind
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:120-122, :369-384`
**Category:** view-staleness

**Bug:** `restake()` at `:384` calls `_writeBoostCheckpoint(msg.sender, boostedAmount)` where `boostedAmount` is the value just read from `staking.positions(_tokenId)` at `:356` — fresh, good. But subsequent sites pass `info.boostedAmount` AFTER it has been written: `:443` (`refreshPosition`) and `:536` (`claimAll-stale`) and `:657` (`unrestake-stale`) and `:1204` and `:1254` (`revalidateBoost*`) — all use the freshly-assigned value. OK so far.

The subtle bug is in `decayExpiredRestaker` at `:1321` and `emergencyWithdrawNFT` at `:983` and `emergencyForceReturn` at `:1130`. In `decayExpiredRestaker`, the order is: settle → assign `info.boostedAmount = currentBoosted` → write checkpoint → shrink totalRestaked → accrue → re-anchor debt. The checkpoint timestamp is `block.timestamp`, but `currentBoosted` may already be 0 (decay completed). That writes "boost was 0 at block.timestamp" which is correct. But the previous checkpoint (before decay) shows the inflated boost up to its timestamp. RevenueDistributor `upperLookup(ts)` for any `ts ∈ [previousCheckpointTime, block.timestamp - 1]` returns the inflated boost. Same exposure window as DR-04, but this surface specifically discusses the gap between decay-trigger and checkpoint-write — they're atomic in the function, but the entire interval `[lockEnd, block.timestamp]` reads the previous (inflated) checkpoint.

**Attack / Impact:** Same as DR-04. This finding documents the second-order effect: even after H-8 fix, the checkpoint write does not invalidate the prior inflated checkpoint for the lazy-decay window. RevenueDistributor `upperLookup` uses `<=` semantics, so the inflated value is returned for every lookup with `ts < block.timestamp`. Fix is the same as DR-04 (clamp by current staking value).

**Evidence:**
```solidity
// :1320-1322
info.boostedAmount = currentBoosted;
_writeBoostCheckpoint(_restaker, currentBoosted);  // writes 0 at block.timestamp
totalRestaked = totalRestaked - oldBoosted + currentBoosted;
// previous checkpoint at lockEnd-N shows inflated value; upperLookup(lockEnd+5) returns inflated
```

**Recommendation:** Same as DR-04. Alternative: when `decayExpiredRestaker` runs, additionally write a "retroactive" checkpoint at `lockEnd` with value 0. Solidity Trace208 doesn't support retroactive insertion (keys must be monotonic), so the practical fix is the `min(checkpointed, staking.current)` clamp in `boostedAmountAt`.

---

## [DR-11] `restake()` does not enforce `staking.holdsToken(msg.sender, _tokenId)` — bypasses TegridyStaking's per-owner-set authority
**Severity:** Low
**File:** `contracts/src/TegridyRestaking.sol:349-387`
**Category:** cross-contract authority

**Bug:** `restake` checks `stakingNFT.ownerOf(_tokenId) != msg.sender` at `:353`. TegridyStaking's `holdsToken(user, tokenId)` view at `:474-476` was added (per AUDIT M13) because `userTokenId[user]` is a stale single-pointer for multi-NFT contract holders, and `ownerOf` gives correct ERC721 truth. So the current check IS semantically correct for the simple "owner = msg.sender" case. The risk emerges if a future TegridyStaking upgrade changes ownership semantics (e.g., adds a transferable position-share or wraps via a proxy) — `ownerOf` would still return the wrapper. Defense-in-depth would use `staking.holdsToken(msg.sender, _tokenId)` which queries the per-owner enumerable set (the source of truth post-M13). Single-line hardening with no behavioral change today.

**Attack / Impact:** Pure forward-compat — no current attack. Documenting because the `holdsToken` view exists exactly for this consumer pattern, and the restaking contract is its most natural user.

**Recommendation:** Add `if (!staking.holdsToken(msg.sender, _tokenId)) revert NotNFTOwner();` after the `ownerOf` check. Cheap belt-and-suspenders.

---

## Summary

| ID | Severity | Surface | One-liner |
|---|---|---|---|
| DR-01 | High | Restaking | `claimPendingUnsettled` cross-user drain — sibling miss of `recoverStuckPrincipal` reservation |
| DR-02 | High | Restaking | `emergencyForceReturn` never decrements `totalActivePrincipal` — locks honest recoverers |
| DR-03 | Medium | Restaking | `decayExpiredRestaker` uses unchecked `_accrueBonus()` instead of `_accrueBonusChecked()` |
| DR-04 | Medium | Restaking | `boostedAmountAt` checkpoints stale through `staking.kick` lazy-decay window |
| DR-05 | Medium | LPFarming | `executeRewardsDurationChange` lacks the `periodFinish` gate that `proposeRewardsDurationChange` has |
| DR-06 | Medium | Restaking | `emergencyForceReturn` inline accrual lacks try/catch — bricks the emergency path on hostile bonus token |
| DR-07 | Low | Restaking | `cancelBonusRateProposal` has no cooldown — captured-signer can churn rate proposals |
| DR-08 | Low | Restaking | `pendingBonus` view returns stale-inflated boost for expired-not-decayed positions |
| DR-09 | Low | LPFarming | First-staker after empty period silently forfeits emission with no event |
| DR-10 | Low | Restaking | `_writeBoostCheckpoint` second-order: prior inflated checkpoint stays readable until next mutation |
| DR-11 | Low | Restaking | `restake` could harden via `staking.holdsToken` defense-in-depth |

**Two High, four Medium, five Low — eleven new findings.**

The two Highs (DR-01, DR-02) are both "half-installed mitigation" / "sibling miss" patterns — same shape as the post-remediation ledger's documented process gap. DR-03 + DR-06 are tripwire bypasses on the *defense-in-depth* surface co-designed with the `virtual` marker on `_accrueBonus` (per AUDIT NFT-CL-L5 NatSpec). DR-04 + DR-10 are the lazy-decay ↔ checkpoint trace gap that H-8 partially closed but never extended to permissionless `staking.kick` callbacks. DR-05 is the standard "asymmetric guard" pattern flagged across the protocol (cf. R014 H9, M-12 H17). DR-07 / DR-08 / DR-09 / DR-11 are forward-compat / observability hardening.

The single highest-leverage fix is **DR-04** — adding `min(checkpointed, staking.current)` to `boostedAmountAt`. Closes DR-04, DR-08, and DR-10 in one line.
