# Agent 28 — TegridyLPFarming.sol Fresh-Eyes Audit

**Target:** `contracts/src/TegridyLPFarming.sol` (~571 lines)
**Lens:** fixed-schedule LP farming rewards, MAX_BOOST_BPS_CEILING, boosted Synthetix-style
**Date:** 2026-05-07
**Method:** clean-slate read of source + base contracts (TimelockAdmin, OwnableNoRenounce); cross-checked against Curve LiquidityGaugeV4 / Synthetix StakingRewards reference patterns; did not consult prior audit `.md` history.

---

## Findings Index

| ID | Severity | Title |
|----|----------|-------|
| F-28-1 | **CRITICAL** | `updateReward` modifier orders boost-cache refresh BEFORE `earned()`, retroactively crediting boost gains over the entire un-checkpointed period |
| F-28-2 | HIGH | `emergencyWithdraw` becomes uncallable if `tegridyStaking.aggregateActiveBoostBps` ever reverts — emergency exits are not failure-isolated from external dependency |
| F-28-3 | MEDIUM | `_withdrawInternal` calls `_getEffectiveBalance` a SECOND time after the modifier already recomputed — minor gas waste + double external call to staking |
| F-28-4 | LOW | `BASE_BOOST_BPS = 10000` floor effectively forgives any aggregate boost < 1.0x — staking positions returning sub-1.0x boost get the same effective balance as non-stakers |
| F-28-5 | LOW | `recoverERC20` does not exclude `tegridyStaking` LP-side tokens that may be donated; donated LP tokens are stuck (rec sweep blocked since address matches `stakingToken`) |
| F-28-6 | INFO | `totalRewardsFunded` is a public counter never read by any internal logic (dead state, monitoring-only) |
| F-28-7 | INFO | `pendingRewardsDuration` is not zeroed when `executeRewardsDurationChange` reverts on the `periodFinish` gate; only cleared on success or on explicit cancel |

---

## F-28-1 — CRITICAL: Retroactive boost-gain credit via `updateReward` modifier ordering

### Location
`contracts/src/TegridyLPFarming.sol:189-242` (updateReward modifier)

### Description

The `updateReward(address account)` modifier — applied to `stake`, `withdraw`, `getReward`, `exit`, `emergencyWithdraw`, `refreshBoost`, and `notifyRewardAmount` — refreshes the cached boost (`effectiveBalanceOf[account]`) BEFORE computing `rewards[account] = earned(account)`.

The relevant flow (lines 199-240 condensed):

```solidity
rewardPerTokenStored = rewardPerToken();              // [A] uses OLD totalEffectiveSupply
lastUpdateTime = lastTimeRewardApplicable();
if (account != address(0)) {
    uint256 raw = rawBalanceOf[account];
    if (raw > 0) {
        uint256 oldEff = effectiveBalanceOf[account];
        uint256 newEff = _getEffectiveBalance(account, raw);   // queries current staking-side boost
        if (oldEff != newEff) {
            totalEffectiveSupply = totalEffectiveSupply - oldEff + newEff;
            effectiveBalanceOf[account] = newEff;              // [B] cache updated to NEW boost
            emit BoostUpdated(account, oldEff, newEff);
        }
    }
    rewards[account] = earned(account);                        // [C] uses NEW eff
    userRewardPerTokenPaid[account] = rewardPerTokenStored;
}
```

`earned(account)` is `effectiveBalanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18 + rewards[account]` (line 256-260).

At [C], `effectiveBalanceOf[account]` is the **NEW** post-refresh value, while `userRewardPerTokenPaid[account]` is still the **OLD** baseline from the user's previous interaction (which may be days/weeks ago). The delta `(rewardPerToken() - userRewardPerTokenPaid[account])` therefore covers the entire un-checkpointed historical period, but is multiplied by the NEW effective balance — granting the new boost RETROACTIVELY for time during which the user's effective balance was different.

### The author's stated intent (lines 220-228)

The author notes the asymmetry as a one-direction trade-off:

> "Honest edge case: a user who held a high boost for the elapsed period and dropped it just before claiming gets credited at the LOWER boost — a small under-credit in exchange for closing the much larger stale-boost over-credit attack surface."

Only the **drop** direction (high → low → claim → under-credit) is acknowledged. The **gain** direction (low → high → claim → over-credit) is not addressed and is silently exploitable.

### Attack scenario

1. Alice stakes `raw=1000` LP at T=0 with boost=1.0x. `effectiveBalance=1000`, `userRewardPerTokenPaid=0`.
2. Period funded with `rewardRate=10/sec`, sole staker. `totalEffectiveSupply=1000`.
3. Alice waits 30 days. Does **not** call any LP-farming function. `rewardPerTokenStored` and `lastUpdateTime` stay at their T=0 values.
4. Alice acquires a 4.5x boost on her staking NFT (lock extension + JBAC). This affects `tegridyStaking.aggregateActiveBoostBps(alice)` to return 45000 BPS, but does **not** trigger any callback into LP-farming.
5. Alice calls `refreshBoost(alice)` (or `getReward()`, or `stake(1)`, or `withdraw(1)`).
6. `updateReward(alice)` runs:
   - `rewardPerToken()` computes correct accumulator using OLD `totalEffectiveSupply=1000`. Growth ≈ `30days * 10 * 1e18 / 1000 = 2.592e22`.
   - `lastUpdateTime` advances to now.
   - `oldEff=1000`, `newEff=4500`, cache updated to 4500. `totalEffectiveSupply` += 3500.
   - `rewards[alice] = earned(alice) = 4500 * (2.592e22 - 0) / 1e18 = 1.166e8` TOWELI.
7. Total emitted over 30 days = `30 * 86400 * 10 = 2.592e7` TOWELI.
8. Alice claims `1.166e8` — **4.5× the actual emission**. Contract is now insolvent: `rewards[alice] (1.166e8) > balance (2.592e7)`.

### Why the bug exists

The intent of moving the boost-cache refresh into `updateReward` was to prevent the inverse attack (keeping inflated cache after losing boost on staking-side). The fix correctly anchors the cache to the current staking-side state. However, the **ordering** within the modifier is wrong: `earned()` uses the post-refresh `effectiveBalanceOf`, which means the new boost retroactively applies to the un-checkpointed delta `(rewardPerToken - userPaid)`.

The reference pattern (Curve LiquidityGaugeV4) does **not** apply boost changes retroactively. Curve uses a `kick(user)` callback **from veCRV** that fires whenever a user's veCRV balance changes; the kick triggers a checkpoint at the OLD boost BEFORE the new boost takes effect. This contract has no such callback — `tegridyStaking` has no awareness of LP-farming and never calls `refreshBoost` on boost mutations. So the gauge cache can drift in BOTH directions until the next user-side interaction.

### Severity rationale

- **Direct fund loss**: an attacker can mint up to `(MAX_BOOST_BPS_CEILING / BASE_BOOST_BPS - 1) = 3.5x` over-credit on every period of un-checkpointed time. Practical limit: the entire `(periodFinish - userLastInteraction) * rewardRate` of past emission gets multiplied by `boost_gain / oldBoost`.
- **Repeatable**: once Alice claims the over-credit, she can repeat the cycle by dropping boost, waiting, regaining boost, claiming again. The dropping path silently under-credits the period before the drop, but the gaining path over-credits — net positive for an attacker who times their interactions.
- **No prerequisites**: the staking-side boost mutation is permissionless (lock extension is a normal user op). The retroactive credit fires on the very next LP-farming interaction.
- **Affects honest users**: any user whose boost legitimately increased between LP-farming interactions silently over-claims. Aggregate effect: protocol distributes more rewards than `rewardRate * elapsed`, eventually leading to insolvency.

### Recommended fix

Reorder the modifier: compute `rewards[account] = earned(account)` and update `userRewardPerTokenPaid` BEFORE refreshing the boost cache. Sketch:

```solidity
if (account != address(0)) {
    rewards[account] = earned(account);                        // OLD eff applied to past delta
    userRewardPerTokenPaid[account] = rewardPerTokenStored;    // anchor

    uint256 raw = rawBalanceOf[account];
    if (raw > 0) {
        uint256 oldEff = effectiveBalanceOf[account];
        uint256 newEff = _getEffectiveBalance(account, raw);
        if (oldEff != newEff) {
            totalEffectiveSupply = totalEffectiveSupply - oldEff + newEff;
            effectiveBalanceOf[account] = newEff;              // future emissions only
            emit BoostUpdated(account, oldEff, newEff);
        }
    }
}
```

This matches the canonical Synthetix StakingRewards pattern and the per-period attribution intent. The drop-side under-credit also closes (since the past period is credited at the OLD boost before the new lower boost is cached). The remaining concern — staleness between staking-side mutation and the next LP-farming interaction — is a known Curve-style trade-off; the right cure is a `kick` callback wired from `tegridyStaking` to LP-farming, but the immediate retroactive credit must be fixed first.

### Note on staking-side symmetry

The author's comment claims this mirrors a "F-1 restaking-side fix". Without reading the staking-side code in this audit pass, I cannot confirm whether the staking-side has the same retroactive bug. Recommend Agent X auditing staking re-checks the F-1 fix's modifier ordering for the same critical issue.

---

## F-28-2 — HIGH: `emergencyWithdraw` reverts if staking ABI breaks; users lose emergency exit

### Location
`contracts/src/TegridyLPFarming.sol:408` (emergencyWithdraw with `updateReward(msg.sender)` modifier)
`contracts/src/TegridyLPFarming.sol:287-294` (`_getEffectiveBalance` — no try/catch on staking call)

### Description

`emergencyWithdraw` carries the `updateReward(msg.sender)` modifier (added per AUDIT NEW-S6 to avoid totalEffectiveSupply-shrink ordering bug). The modifier calls `_getEffectiveBalance(account, raw)` (line 231) which calls `tegridyStaking.aggregateActiveBoostBps(user)` (line 289).

The H12 / R016 M-1 fix deliberately removed the try/catch fallback, with rationale that any ABI mismatch should "loudly revert at the staking call instead of silently halving reward boost". This trade-off is correct for `getReward` / `stake` / `withdraw`, but breaks `emergencyWithdraw`'s contract — the function exists specifically to let users escape regardless of contract state.

If `tegridyStaking` ever returns malformed data, runs out of gas, has an upgrade bug, or reverts for any reason on the `aggregateActiveBoostBps` call path, **all LP-farming functions including `emergencyWithdraw` revert** — users cannot recover their LP.

### Severity rationale

- `tegridyStaking` is `immutable` in this contract — if the staking contract has a critical bug, this contract has no way to disconnect from it.
- Although staking is presumably non-upgradable Solidity (so the practical revert risk is low), `emergencyWithdraw` is the user's last-resort safety hatch. Tying it to an external call defeats its purpose.
- Pattern of record: MasterChef-class contracts (and most security-conscious clones) implement `emergencyWithdraw` with **zero external calls except the LP token transfer** specifically to ensure users can always exit.

### Recommended fix

Either:
1. Remove the `updateReward(msg.sender)` modifier from `emergencyWithdraw` and zero the user's reward state directly without re-running `earned()`. The original AUDIT NEW-S6 concern (subsequent claimers over-credited) can be addressed by a stand-alone `_syncReward()` call that does not touch boost.
2. Wrap the boost-refresh inside `updateReward` in a try/catch when called from `emergencyWithdraw` — if staking reverts, fall back to leaving `effectiveBalanceOf` as-is. This is messier but preserves the post-S6 ordering guarantee.

Option (1) is cleaner. The boost cache for an exiting user is irrelevant (they zero it anyway).

---

## F-28-3 — MEDIUM: Redundant `_getEffectiveBalance` call in `_withdrawInternal` post-modifier-fix

### Location
`contracts/src/TegridyLPFarming.sol:358-381` (`_withdrawInternal`)

### Description

The PASS7-LPFARM-M1 fix (lines 211-237) added boost-cache refresh inside `updateReward`. Subsequently, `_withdrawInternal` still performs its own `_getEffectiveBalance(user, newRaw)` call (line 374), which:
1. Re-reads `effectiveBalanceOf[user]` (which the modifier just wrote).
2. Makes a SECOND external call to `tegridyStaking.aggregateActiveBoostBps(user)`.

The recompute itself is not buggy (it correctly scales the post-modifier eff by the new raw amount), but the second external call doubles the gas cost of every withdraw and adds a redundant cross-contract dependency. Same applies to `stake()` body lines 320-329 (post-modifier-fix the body's reconcile-block is a no-op since the modifier already did it).

### Severity rationale

Not exploitable, but increases gas cost for every user withdraw and stake by ~one external view call (~2.6k gas). On chain with high traffic, this is meaningful. Also, it widens the surface for a (theoretical) staking-side revert during withdraw — see F-28-2.

### Recommended fix

Drop the redundant reconcile-block in both `stake()` (lines 320-329) and `_withdrawInternal()` (lines 372-378 can be simplified to recompute newEff via proportional scaling: `newEff = effectiveBalanceOf[user] * newRaw / rawBalanceOf[user]`). The modifier-side recompute is the canonical source.

Caveat: if F-28-1 is fixed by re-ordering the modifier, the body-side recompute should be **kept** in `stake()` and `withdraw()` to apply the new boost going forward (since the modifier no longer does it). The redundancy disappears on its own once F-28-1 is fixed.

---

## F-28-4 — LOW: `BASE_BOOST_BPS = 10000` floor erases sub-1.0x boost positions

### Location
`contracts/src/TegridyLPFarming.sol:287-294` (`_getEffectiveBalance`)

### Description

```solidity
uint256 boostBps = BASE_BOOST_BPS;  // 10000
uint256 aggBps = tegridyStaking.aggregateActiveBoostBps(user);
if (aggBps > BASE_BOOST_BPS) {
    boostBps = aggBps > MAX_BOOST_BPS_CEILING ? MAX_BOOST_BPS_CEILING : aggBps;
}
```

If `aggregateActiveBoostBps(user)` returns a value `<= 10000` (e.g., 5000 = 0.5x), the contract uses `boostBps = 10000` (1.0x). Two consequences:

1. A staker with sub-1.0x boost is rewarded as if they had no staking position at all — same as a non-staker.
2. There is no path by which a staking position can REDUCE a user's LP-farming effective balance below 1.0x of raw.

If the TegridyStaking contract's design ever produces sub-1.0x aggregate boost (e.g., weighted average across positions, some positions having decay), this contract silently treats them as 1.0x. The `BASE_BOOST_BPS` floor is intentional but worth flagging.

### Severity rationale

Not a vulnerability. Design choice that may diverge from staking-side expectations. Worth confirming alignment with TegridyStaking's intended boost range.

---

## F-28-5 — LOW: Donated stakingToken / rewardToken are unrecoverable

### Location
`contracts/src/TegridyLPFarming.sol:557-562` (`recoverERC20`)

### Description

`recoverERC20` reverts on `stakingToken` and `rewardToken` to prevent owner from draining user funds. However, this means tokens accidentally transferred directly to the contract (bypassing `stake` or `notifyRewardAmount`) are stuck:

- LP tokens donated directly: increase `stakingToken.balanceOf(this)` but not `totalRawSupply`; recoverable by no one.
- TOWELI tokens donated directly: become free reward funding (next `notifyRewardAmount` reads `balance` and includes them); benign.

Donated LP tokens specifically are stuck-as-dust. Not exploitable for theft, just an irritant.

### Severity rationale

Not a security issue — this is the standard Synthetix-pattern trade-off. Logged for completeness.

---

## F-28-6 — INFO: `totalRewardsFunded` is monitoring-only

### Location
`contracts/src/TegridyLPFarming.sol:106` (state) and `contracts/src/TegridyLPFarming.sol:494` (write)

### Description

`totalRewardsFunded` is incremented by `actualReward` on every `notifyRewardAmount`, but no internal function reads it. It exists for off-chain monitoring / event-stream replay. Not a bug; logged so future refactors don't accidentally remove it under "dead state" pruning.

---

## F-28-7 — INFO: `pendingRewardsDuration` not cleared on revert path

### Location
`contracts/src/TegridyLPFarming.sol:518-525` (`executeRewardsDurationChange`)

### Description

```solidity
function executeRewardsDurationChange() external onlyOwner {
    if (block.timestamp < periodFinish) revert PreviousPeriodNotComplete();
    _execute(REWARDS_DURATION_CHANGE);
    uint256 old = rewardsDuration;
    rewardsDuration = pendingRewardsDuration;
    pendingRewardsDuration = 0;
    emit RewardsDurationUpdated(old, rewardsDuration);
}
```

If the `periodFinish` gate fires, the proposal stays pending and `pendingRewardsDuration` stays set. Owner can retry after periodFinish. The proposal still expires after PROPOSAL_VALIDITY (7 days). After expiry, owner must `cancel` to clear. Off-by-one risk: if owner forgets to cancel and proposes a new value, `_propose` reverts with `ExistingProposalPending`. This is a TimelockAdmin invariant, not specific to this contract, but worth noting that `pendingRewardsDuration` carries stale data until owner explicitly cancels.

### Severity rationale

Not exploitable. Operational footgun for owner.

---

## Notes / Dead-ends

The following lenses were checked and found clean:

- **Donation attack on `accRewardPerShare`** — N/A, this contract uses Synthetix `rewardPerTokenStored`, not MasterChef-style `accRewardPerShare`. Donations to `rewardToken` balance increase potential rewardRate but are bounded by `MAX_REWARD_RATE` cap and `notifyRewardAmount` solvency check.
- **Reward token = staking token** — explicitly rejected in constructor (line 158, `RewardEqualsStakingToken`).
- **Harvest reentrancy** — `getReward` and `_getRewardInternal` are guarded by `nonReentrant` at the public entry point. Reward token is immutable TOWELI (no callback risk in honest threat model).
- **Forfeited-rewards reclaim cap math (`reclaimForfeitedRewards`)** — verified via invariant `balance >= sum(rewards[active]) + owedFutureRewards + forfeitedRewards`. Cap = `balance - owedFutureRewards >= forfeitedRewards`, so sweeping `forfeitedRewards` cannot starve active claimers. Safe.
- **0-deposit user calls harvest** — `_getRewardInternal` short-circuits on `reward == 0`. No griefing surface (each call is `nonReentrant` + standard gas cost).
- **Owner front-running rewardRate change** — `notifyRewardAmount` is gated by `rewardsDuration` check (line 474) and the timelocked `RewardsDurationChange` (line 502). Rate change is bounded by `MAX_REWARD_RATE = 100e18 / sec` and `balance / duration` solvency. No instant rate-jack.
- **`recoverERC20` bypass via aliased token contracts** — both `stakingToken` and `rewardToken` are checked by address equality (lines 558-559). No spoofable wrapper.
- **Pending reward overflow on long stakes** — back-of-envelope: `rewardPerTokenStored` max growth ~7.776e26 per max-rate period; `effectiveBalanceOf * delta / 1e18` fits uint256 even for trillions of years.
- **Empty-period MEV (DR2-03)** — already addressed by reverting DR-09 v1 and adding the `RewardsForfeitedDuringEmptyPeriod` event. Synthetix's deliberate forfeit is preserved.
- **Duration change mid-period (DEEP-DR-05)** — `executeRewardsDurationChange` correctly mirrors the `periodFinish` gate from the propose side.
- **MasterChef rewardToken=stakingToken footgun (FRESH-EYES H-1)** — already blocked by `RewardEqualsStakingToken`.
- **Multi-NFT undercount (H12 / R016 M-1)** — already addressed by `aggregateActiveBoostBps`. Fallback removed.
- **C-01 ABI alignment** — `Position` struct decode order matches TegridyStaking exactly per source comments. Separately defended by `MAX_BOOST_BPS_CEILING = 45000`.
- **Pause coverage** — `stake` is paused-gated; `withdraw`, `getReward`, `exit`, `emergencyWithdraw`, `refreshBoost` are NOT — intentional, users always can exit.

---

## Summary

**1 CRITICAL + 1 HIGH + 1 MEDIUM + 4 LOW/INFO.**

The critical finding (F-28-1) is the highest priority: the `updateReward` modifier ordering retroactively credits boost gains over the entire un-checkpointed period, which is directly exploitable by any user who times boost increases between LP-farming interactions. The fix is a 5-line reorder of the modifier (compute rewards under OLD boost → anchor userPaid → then refresh cache for future periods). This is the canonical Synthetix StakingRewards order; the team's PASS7-LPFARM-M1 patch correctly identified the stale-cache problem but solved it in the wrong direction.

F-28-2 (HIGH) is a defensive concern — emergencyWithdraw should not depend on the staking contract's external view function being callable. Practical risk is low (staking is immutable Solidity, presumably bug-free) but the principle of failure isolation matters for emergency exits.

The remaining findings are minor (gas inefficiency, design notes, operational footguns).
