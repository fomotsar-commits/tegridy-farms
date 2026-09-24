# Deep Audit — TegridyStaking + TegridyStakingAdmin
**Date:** 2026-05-01
**Scope:** `contracts/src/TegridyStaking.sol` (1,745 LOC) + `contracts/src/TegridyStakingAdmin.sol` (340 LOC)
**Method:** Microscope follow-up — only NEW findings vs. prior batches A-J + the 04-30 microscope (C3/C4/H4, M-S1..M-S8) + the 005_TegridyStaking sweep.
**Excluded (already documented):** the entire C3/C4/H4 stale-checkpoint cluster, M-S1 (emergencyWithdrawPosition updateReward), M-S2 (decay restaker notify), M-S3 (revalidateBoost CEI), M-S4..M-S8 generally, H-005-01/H-005-02 reward drift, M-005-01 notifier windfall, M-005-02 flash-stake-vote, M-005-03 stale checkpoint on getReward, M-005-04 _clearPosition userTokenId clobbering, M-005 `extendLock` UX. Also excluded: H-AUDIT-2026-1 (autoMaxLock + getReward stuck-state, fixed in d8ba708), M-AUDIT-2026-1/2/3, REV-M-01 (totalBoostedStake T-1 checkpoint), R014 M-9 inactivity gate.

---

## [DS-01] `withdraw()` calls `_decayIfExpired` BEFORE `_getReward` — defeats AUDIT M-01 fix; users who withdraw after lock expiry forfeit ALL pre-expiry rewards
**Severity:** Critical
**File:** `contracts/src/TegridyStaking.sol:765-783`
**Category:** reward / math

**Bug:** `withdraw()` runs `_decayIfExpired(tokenId, p)` at L771, which zeros `p.boostedAmount` if the lock has expired. Then at L773 it calls `_getReward(tokenId, p)` — but `_getReward` opens with `if (p.boostedAmount == 0) return 0;` (L1079), so it short-circuits and returns 0. The whole point of AUDIT M-01 was to compute pending rewards BEFORE decay (the comment at L1080-1082 explicitly says: *"Previously, _decayIfExpired was called first, setting boostedAmount=0 and causing all pending rewards for expired positions to be permanently lost"*). M-01 fixed this **inside** `_getReward` — but `withdraw()` still calls `_decayIfExpired` **before** `_getReward`, so the M-01 protection never fires on the most common exit path. `earned()` view (L486-499) shows the user pre-expiry rewards are pending; `withdraw()` then silently pays only principal.

**Attack / Impact:** Every user who lets their lock expire and then calls `withdraw()` — the documented happy path — permanently loses ALL accrued rewards from `lastClaim` to `lockEnd`. `test_withdraw_afterLockExpired` in `TegridyStaking.t.sol:216-229` actually documents this regression as if intentional ("V2: Expired locks earn 0 rewards"), yet the M-01 fix in `_getReward` claims to fix exactly this. `earned(tokenId)` returns the pre-expiry pending amount, then `withdraw()` pays 0 — a direct user-expectation violation. With even modest staking activity the protocol sequesters tens-of-thousands of TOWELI/year in unclaimable post-decay rewards (eventually re-attributable via `_accumulateRewards` to whoever interacts next, i.e. de-facto bonus to engaged stakers at the expense of disengaged ones).

**Evidence:**
```solidity
// L765-783 — withdraw()
function withdraw(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
    if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
    Position storage p = positions[tokenId];
    if (p.amount == 0) revert NoPosition();
    if (block.timestamp < p.lockEnd) revert LockNotExpired();
    // V2: Clean up expired boost before withdrawal
    _decayIfExpired(tokenId, p);   // ← zeros boostedAmount

    _getReward(tokenId, p);         // ← early-returns 0 because p.boostedAmount == 0

    _returnJbacIfDeposited(tokenId, msg.sender);
    uint256 amount = _clearPosition(tokenId, p);
    rewardToken.safeTransfer(msg.sender, amount);
    ...
}

// L1077-1090 — _getReward (M-01 ordering inside is correct)
function _getReward(uint256 tokenId, Position storage p) internal returns (uint256) {
    if (p.boostedAmount == 0) return 0;          // ← short-circuit hit by withdraw()
    ...
    int256 accumulated = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
    int256 diff = accumulated - p.rewardDebt;
    p.rewardDebt = accumulated;
    _decayIfExpired(tokenId, p);                  // ← M-01 ordering protected here only
```

**Recommendation:** Remove the L771 `_decayIfExpired` call from `withdraw()`. `_getReward` already runs decay AFTER computing rewards (the M-01 ordering). The pre-decay call here is a vestige from before M-01 and now causes the exact regression M-01 was supposed to close. Apply the same fix philosophy as `earlyWithdraw` (L788-816) and `executeEmergencyExit` (L1321-1357), neither of which pre-decays. After removal, the M-01 path inside `_getReward` correctly captures pre-expiry rewards, then decays, then `_clearPosition` finishes the exit.

---

## [DS-02] `kick()` zeros `boostedAmount` without first capturing the holder's pre-expiry rewards — permissionless reward-burn griefing
**Severity:** High
**File:** `contracts/src/TegridyStaking.sol:885-891`
**Category:** reward / griefing

**Bug:** The new `kick()` function (added to close MICROSCOPE C3/C4) is permissionless and runs `_decayIfExpired` directly after `_accumulateRewards`, with NO call to `_getReward(tokenId, p)` for the position owner. `_decayIfExpired` zeros `p.boostedAmount` and decrements `totalBoostedStake`, but DOES NOT advance `p.rewardDebt`. The owner's pre-expiry accrued rewards (everything between `rewardDebt` and `(p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION` at the moment of expiry) are now permanently unreachable: a subsequent `_getReward` hits `if (p.boostedAmount == 0) return 0;` (L1079), and `withdraw()` does the same (DS-01). The function's NatSpec (L878-883) claims **only** post-expiry inflated rewards are forfeited, but the implementation actually forfeits **every reward earned since the user's last claim or stake**, including the legitimate pre-expiry yield they were entitled to.

**Attack / Impact:** Any external party can grief any expired-but-uninteracted position the moment `block.timestamp >= lockEnd` to permanently destroy the holder's accrued yield. With a 7-day minimum lock and a typical mainnet user who claims weekly, the loss per kicked position is bounded by `(boostedAmount × rewardRate × elapsed) / totalBoostedStake` for the period since their last interaction — easily 1-7 days of yield, more for autoMaxLock users who would otherwise re-anchor on `getReward`. The attacker pays only base gas; the victim's principal is preserved but their rewards are zeroed. Combined with [DS-01], a malicious party can MEV-snipe expiring locks: kick them at `lockEnd + 1 second` so the victim is guaranteed reward loss whether they call `getReward` (sees `boostedAmount == 0`, pays 0), `withdraw` (DS-01), or anything else. autoMaxLock is also bypassed: an attacker who kicks before the next `getReward` strips the user's pre-expiry rewards even though the user opted into "set and forget — keep max boost perpetually."

**Evidence:**
```solidity
// L885-891
function kick(uint256 tokenId) external {
    Position storage p = positions[tokenId];
    uint256 prior = p.boostedAmount;
    _accumulateRewards();                         // bumps rewardPerTokenStored systemwide
    _decayIfExpired(tokenId, p);                  // zeros p.boostedAmount; rewardDebt UNCHANGED
    emit PositionKicked(tokenId, msg.sender, prior - p.boostedAmount);
}

// L328-335 — _decayIfExpired does not capture user rewards
function _decayIfExpired(uint256 tokenId, Position storage p) internal {
    if (p.boostedAmount > 0 && p.lockEnd > 0 && block.timestamp >= p.lockEnd) {
        totalBoostedStake -= p.boostedAmount;
        p.boostedAmount = 0;                      // ← user's entitlement is now unreachable
        _writeCheckpoint(ownerOf(tokenId));
        _writeTotalBoostedStakeCheckpoint();
    }
}
```

Curve's `LiquidityGaugeV4.kick(addr)` — the cited pattern of record (L866-868) — runs `_checkpoint_rewards(addr)` BEFORE adjusting working_balance, settling the user's reward bucket first. Tegridy's port omitted this step.

**Recommendation:** Settle the holder's pending rewards as **unsettled** (mirroring `_settleRewardsOnTransfer`'s C-04 pattern) before calling `_decayIfExpired`. Specifically, between L887 and L888, capture pre-decay accumulated, advance `rewardDebt` to that value, and route the diff through `_settleUnsettled(ownerOf(tokenId), cappedPending)`:

```solidity
function kick(uint256 tokenId) external nonReentrant {
    Position storage p = positions[tokenId];
    uint256 prior = p.boostedAmount;
    _accumulateRewards();
    if (prior > 0 && p.lockEnd > 0 && block.timestamp >= p.lockEnd) {
        address holder = ownerOf(tokenId);
        int256 accumulated = _safeInt256((prior * rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        p.rewardDebt = accumulated;
        if (diff > 0) {
            uint256 pending = uint256(diff);
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
            uint256 actualSettled = _settleUnsettled(holder, cappedPending);
            uint256 forfeited = pending - actualSettled;
            if (forfeited > 0) emit RewardsForfeited(holder, forfeited);
        }
    }
    _decayIfExpired(tokenId, p);
    emit PositionKicked(tokenId, msg.sender, prior - p.boostedAmount);
}
```
Add `nonReentrant` for parity with the rest of the user-facing surface; the prior justification ("only STATICCALL, no fund movement") no longer holds once `_settleUnsettled` is in the path. Also add `whenNotPaused` OR explicitly document why anti-grief access during pause is an intentional trade-off.

---

## [DS-03] Pause asymmetry: `kick()` runs while contract is paused, weaponising DS-02 against users who can't defend with `getReward`
**Severity:** High
**File:** `contracts/src/TegridyStaking.sol:885` (no `whenNotPaused`)
**Category:** other / pause-asymmetry

**Bug:** During a pause (e.g., a security freeze, or an in-progress migration), every reward-touching user entrypoint is gated `whenNotPaused`: `getReward`, `withdraw`, `extendLock`, `increaseAmount`, `revalidateBoost`, `claimUnsettled`, `claimUnsettledFor`. But `kick()` (L885) is permissionless AND has no pause guard. The L870-876 NatSpec defends this as "anti-dilution cleanup must work in any operational mode" — but combined with DS-02, this is the worst possible combination: a malicious party can kick expiring positions during a pause when the holder has zero defensive options (cannot call `getReward` to extend autoMaxLock or claim pre-expiry rewards). Even after unpause, the rewards are unreachable per DS-02.

**Attack / Impact:** Concrete sequence: (1) Owner pauses (e.g., for an incident response). (2) Alice's lock expires at `T = pauseStart + 3 days`. Pre-pause she planned to `getReward` to extend autoMaxLock and harvest. (3) Eve calls `staking.kick(aliceTokenId)` at `T+1s`. `_decayIfExpired` runs, Alice's pre-expiry rewards are now stranded per DS-02. (4) Pause lifts; Alice calls `getReward` → returns 0 (boostedAmount == 0). The `if (p.boostedAmount == 0 && p.amount > 0)` branch at L842 reactivates the position with MAX boost going forward, but the pre-expiry rewards are gone. The user's only recourse is to keep claiming weekly, which defeats autoMaxLock's "set and forget" promise.

**Evidence:** L562, 612, 665, 700, 729, 765, 788, 830, 903, 1186, 1202, 1251 all carry `whenNotPaused` or `whenPaused`. L885 (`kick`) has neither. Compare to `revalidateBoost` (L902-903) which the team explicitly added `whenNotPaused` to *because* it can manipulate boost during pause — `kick` does the same boost manipulation, with worse rewards consequences than revalidate.

**Recommendation:** Either fix DS-02 first (then `kick` can stay pause-independent because the user's rewards are preserved), OR add `whenNotPaused` to `kick`. The first option is preferable: `kick`'s value as an anti-dilution primitive is real, but only if it doesn't double as a reward-burn primitive. With DS-02 fixed, pause-independent kick is safe and even desirable.

---

## [DS-04] `_settleRewardsOnTransfer` does not call `_touch(from)` — owner-side `claimUnsettledFor` 90-day inactivity gate is bypassed for transfer-only users
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:1126-1165` (no `_touch(from)`); contrast L1057 (`_touch(to)` is called)
**Category:** gov / inactivity-gate

**Bug:** `_settleRewardsOnTransfer` is the ONLY mutation site that credits `unsettledRewards[from]` from a non-claim path (NFT transfer settles seller's rewards into unsettled). However, it never calls `_touch(from)` despite `from` being the recipient of those unsettled rewards. The R014 M-9 invariant — that "every reward-touching entrypoint that materially affects unsettled rewards for the user" must `_touch(user)` (L1067-L1069 NatSpec) — is silently violated. Result: `from`'s `lastActivityAt` may stay at 0 (default) or its pre-transfer value, allowing `claimUnsettledFor(from)` by the contract owner to bypass the 90-day inactivity gate at L1211.

**Attack / Impact:** (1) Bob receives a staking NFT for the first time at `T0` (e.g., as buyer of a secondary-market position). His `_touch(bob)` was set in `_update`'s `to` branch, fine. (2) Bob holds for 89 days. (3) At `T0+89d` Bob transfers the NFT to a third party — `_settleRewardsOnTransfer` settles Bob's pending rewards into `unsettledRewards[bob]` but does NOT update `lastActivityAt[bob]`. Bob's last `_touch` was `T0`. (4) At `T0+90d`, the contract owner calls `claimUnsettledFor(bob)`. `lastActivityAt[bob] + 90d == T0 + 90d == block.timestamp`, so `>=` evaluates true and the owner-branch reverts — actually correct here. **BUT** consider the case where `from` is a brand-new EOA who NEVER staked but received the NFT directly (unusual but possible): `lastActivityAt[from] = 0`, and the L1057 `_touch(to)` only fired on the inbound side. After they transfer the NFT out, `_settleRewardsOnTransfer` credits `unsettledRewards[from]` and never `_touch`es. `lastActivityAt[from]` is still `0`. Owner can immediately call `claimUnsettledFor(from)` at any point because `0 + 90d < block.timestamp` evaluates true. Force-claim is sent to `from`'s wallet — not theft, but bypasses the user-protection design intent and can grief a user mid-key-rotation.

**Evidence:**
```solidity
// L1126-1165 — _settleRewardsOnTransfer credits `from` but does NOT _touch(from)
function _settleRewardsOnTransfer(uint256 tokenId, address from) private {
    _accumulateRewards();
    Position storage p = positions[tokenId];
    int256 accumulated = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
    int256 diff = accumulated - p.rewardDebt;
    _decayIfExpired(tokenId, p);
    if (diff > 0) {
        ...
        uint256 actualSettled = _settleUnsettled(from, cappedPending);  // ← writes unsettledRewards[from]
        ...
    }
    p.rewardDebt = accumulated;
    // NO _touch(from) here
}

// L1042-1058 — _update only _touch(to), not _touch(from)
if (to != address(0)) {
    ...
    userTokenId[to] = tokenId;
    _writeCheckpoint(to);
    _touch(to);                                  // ← only `to` is touched
}
```

**Recommendation:** Add `_touch(from)` inside the `if (diff > 0)` branch of `_settleRewardsOnTransfer`, OR at the bottom of `_update` if `from != address(0)`. The R014 M-9 invariant is "any path that creates unsettled rewards for `from` should refresh `from`'s activity timestamp."

---

## [DS-05] `notifyRewardAmount` lacks `whenNotPaused` — funding-during-pause + `_accumulateRewards` enables a notifier-controlled mid-pause reward stream
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:1399-1407`
**Category:** reward / pause-asymmetry

**Bug:** During a pause, `getReward` / `withdraw` / `extendLock` / `claimUnsettled` are all blocked. But `notifyRewardAmount` (L1399) and `kick` (L885) are NOT. Because `notifyRewardAmount` carries `updateReward`, calling it advances `lastUpdateTime` and bumps `rewardPerTokenStored` against whatever `totalBoostedStake` exists at that moment. A notifier (owner or whitelisted) can deposit during pause, the deposit accrues to current stakers via `rewardPerTokenStored`, and after unpause the first claimer captures a disproportionate slice — exactly the timing-attack risk the M-AUDIT-2026-2 `updateReward` add was supposed to defend against, except that fix only protects post-`_accumulateRewards` math, not the pre-/post-pause boundary. Combined with DS-03 (kick during pause), an adversarial-but-whitelisted notifier could: (1) kick a competitor's expired position to shrink `totalBoostedStake`, (2) immediately `notifyRewardAmount` while pause prevents anyone from running their own `_accumulateRewards`, (3) once unpaused, claim against the now-favorable `rewardPerTokenStored / totalBoostedStake` ratio.

**Attack / Impact:** Requires `rewardNotifiers` whitelist abuse OR owner-key compromise. The current allowlist is restricted (NEW-S5), so this is conditional on the notifier set growing — exactly the threat model the M-AUDIT-2026-2 NatSpec at L1390-1397 already acknowledges ("if the notifier set ever expands... a notifier could back-run their own funding"). The pause-asymmetry exposes a related window: even WITH `updateReward`, allowing notifications during pause means the pre-pause state of `totalBoostedStake` can be re-shaped via DS-03 kicks, then notifications land against the manipulated denominator.

**Evidence:**
```solidity
// L1399 — no whenNotPaused
function notifyRewardAmount(uint256 _amount) external nonReentrant updateReward {
    if (msg.sender != owner() && !rewardNotifiers[msg.sender]) {
        revert NotRewardNotifier();
    }
    ...
}

// vs L562 stake / L765 withdraw / L830 getReward — all whenNotPaused
```

**Recommendation:** Add `whenNotPaused` to `notifyRewardAmount`. Funding during pause should not be possible — pauses exist to freeze ALL state mutation. If operators need to fund during a long pause for budgetary reasons, they can unpause briefly. Pairs with the DS-03 fix (kick) for full pause hygiene.

---

## [DS-06] `extendLock` permits reviving an EXPIRED-and-decayed position by paying fee on stale principal — fee-payer captures a free re-anchor
**Severity:** Medium
**File:** `contracts/src/TegridyStaking.sol:700-724`
**Category:** math / lock-mechanics

**Bug:** `extendLock` does NOT check whether the lock has already expired. The check `_newLockDuration <= p.lockDuration` (L704) ensures the new duration is longer than the original, but does NOT prevent extension on a position whose `lockEnd` has already passed. After an expired position has been decayed (via prior `kick` or via `_getReward` inside this same call), its `boostedAmount = 0`. Then `_applyNewBoost(p, newBoost)` recomputes from `p.amount`, restoring full boost going forward. The position is effectively re-staked with the original principal, paying only the `extendFeeBps × p.amount` fee. Compared to `increaseAmount` which explicitly rejects expired positions at L738 (`if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();`), `extendLock` is asymmetric — and crucially, the user paid no penalty for letting the lock expire while still drawing voting power and (via DS-01/DS-02) forfeiting rewards.

**Attack / Impact:** A staker can let a position expire, sit dormant, then revive it via `extendLock(_newLockDuration > p.lockDuration)` without going through `withdraw → re-stake`. The economic hit avoided: the 25% `EARLY_WITHDRAWAL_PENALTY` is sidestepped (lock has expired so they could `withdraw` for free anyway, no value extraction here) — but there is a subtler issue: between `lockEnd` and the revival, the user occupied a slot in `_positionsByOwner[user]` (against the 50-cap), held a rewardDebt anchor at the LAST-update value (so the revived position re-emerges with a SMALLER rewardDebt than a fresh stake of the same amount would have anchored — they receive any post-decay `rewardPerTokenStored` growth they didn't pay denominator for during the dormant period). The advantage is small per user but accumulates across all dormant-revivers.

**Evidence:**
```solidity
// L700-724 — no expiry check
function extendLock(uint256 tokenId, uint256 _newLockDuration) external nonReentrant whenNotPaused updateReward {
    if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
    Position storage p = positions[tokenId];
    if (p.amount == 0) revert NoPosition();
    if (_newLockDuration <= p.lockDuration) revert LockNotExtended();
    if (_newLockDuration > MAX_LOCK_DURATION) revert LockTooLong();
    // NO expiry check, unlike increaseAmount L738

    _chargeExtendFee(tokenId, p.amount);
    _getReward(tokenId, p);                       // returns 0 if expired (via DS-02 short-circuit)
    p.lockDuration = uint32(_newLockDuration);
    p.lockEnd = uint64(block.timestamp + _newLockDuration);
    ...
    _applyNewBoost(p, newBoost);                  // re-anchors rewardDebt cleanly; restores boost
}

// L729-738 — increaseAmount DOES check
function increaseAmount(uint256 tokenId, uint256 _additionalAmount) external nonReentrant whenNotPaused updateReward {
    ...
    if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
    ...
}
```

**Recommendation:** Add the same expiry check to `extendLock`:
```solidity
if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
```
A user who let their lock expire should `withdraw` then `stake` fresh, paying full fees on the new entry. Mirrors `increaseAmount` and matches the documented model where expired positions are "use it or lose it" (per `test_withdraw_afterLockExpired` comment).

---

## [DS-07] `kick()` emits `PositionKicked` with `prior - p.boostedAmount` even on a no-op (non-existent or unexpired token), enabling event-spam griefing of indexers
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:885-891`
**Category:** other / event-spam

**Bug:** `kick(tokenId)` does NOT validate that `tokenId` exists, has been staked, or has expired. Calling `kick(0)` or `kick(2**256-1)` reads `positions[tokenId]` (returns the zero struct), runs `_accumulateRewards` (state-changing on `lastUpdateTime`), runs `_decayIfExpired` (no-op because `p.boostedAmount == 0`), and emits `PositionKicked(tokenId, msg.sender, 0)`. An attacker can spam `kick(arbitraryId)` calls indefinitely, polluting indexer event streams and bloating subgraph storage. The `_accumulateRewards` write to `lastUpdateTime` is also wasteful but bounded.

**Attack / Impact:** Pure spam vector. Indexers that fan out on `PositionKicked` events (e.g., to alert position owners) will trigger on phantom token IDs. Frontend dashboards showing "kick history" will show endless spurious entries. No fund loss; no governance impact. Bounds: each call costs ~50k gas (one `_accumulateRewards` SSTORE + log emit) so the attacker pays. But on L2s with cheap gas this is pennies per million spam events.

**Evidence:**
```solidity
function kick(uint256 tokenId) external {
    Position storage p = positions[tokenId];      // ← returns zero struct for non-existent
    uint256 prior = p.boostedAmount;              // 0
    _accumulateRewards();                         // SSTORE on lastUpdateTime
    _decayIfExpired(tokenId, p);                  // no-op (boostedAmount == 0 short-circuit)
    emit PositionKicked(tokenId, msg.sender, prior - p.boostedAmount);  // emits with 0
}
```

**Recommendation:** Either revert or skip the event when no decay actually happens. The cleanest fix tracks the change explicitly:
```solidity
function kick(uint256 tokenId) external {
    Position storage p = positions[tokenId];
    if (p.amount == 0) revert NoPosition();       // catch non-existent + already-cleared
    uint256 prior = p.boostedAmount;
    if (prior == 0 || p.lockEnd == 0 || block.timestamp < p.lockEnd) revert NoOpKick(); // or just skip-emit
    _accumulateRewards();
    _decayIfExpired(tokenId, p);
    emit PositionKicked(tokenId, msg.sender, prior - p.boostedAmount);
}
```
Adds a `NoOpKick` error and saves ~20k gas per spam call by reverting fast. Also fixes the event-spam.

---

## [DS-08] `notifyRewardAmount` accepts FoT-quirky `transferFrom` without measuring delta — `totalRewardsFunded` drifts permanently
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:1399-1407`
**Category:** math / accounting

**Bug:** `notifyRewardAmount` does `rewardToken.safeTransferFrom(msg.sender, address(this), _amount); totalRewardsFunded += _amount;`. If the reward token ever ships with a transfer fee (FoT) or rebasing semantics, `_amount` is the pre-fee credit while the contract receives strictly less. `totalRewardsFunded` is now an over-estimate forever. This is dormant today (TOWELI is a vanilla ERC20) but creates a fragile dependency: any future migration to a wrapped/fee-bearing reward token silently breaks accounting. Compare to TegridyRestaking's `_creditUnforwarded` and POLAccumulator's `harvest` paths which both measure `balanceAfter - balanceBefore` deltas.

**Attack / Impact:** Currently zero (TOWELI is non-FoT). Becomes a slow-bleed if reward token semantics ever shift — `totalRewardsFunded` is purely informational and not consumed by reward math, so this is more an accounting hygiene flag than an exploitable bug.

**Evidence:**
```solidity
function notifyRewardAmount(uint256 _amount) external nonReentrant updateReward {
    if (msg.sender != owner() && !rewardNotifiers[msg.sender]) revert NotRewardNotifier();
    if (_amount < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall();
    rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
    totalRewardsFunded += _amount;                // ← assumes _amount actually arrived
    emit RewardAdded(_amount);
}
```

**Recommendation:** Defensive delta-measure pattern — even though the immediate token isn't FoT, the contract is non-upgradeable and the `rewardToken` is `immutable`, but there's no harm in:
```solidity
uint256 balBefore = rewardToken.balanceOf(address(this));
rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
if (received < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall();
totalRewardsFunded += received;
emit RewardAdded(received);
```
Adds ~3k gas; future-proofs the accounting. Also moves the `MIN_NOTIFY_AMOUNT` check after delta — guarantees the actual deposit meets the floor.

---

## [DS-09] `_chargeExtendFee` reads stale `p.amount` AFTER `_getReward` has potentially changed nothing — but BEFORE `_applyNewBoost` recomputes `boostedAmount` against the just-bumped RPT
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:700-724` and `665-692`
**Category:** math / fee-leak

**Bug:** In `extendLock` (and `toggleAutoMaxLock` enable path), the order is: `_chargeExtendFee(tokenId, p.amount)` → `_getReward(tokenId, p)` → set new lockDuration/lockEnd → `_applyNewBoost`. Inside `_chargeExtendFee`, the recycled slice is immediately credited via `_creditRewardPool(recycled)` which bumps `rewardPerTokenStored` against the OLD (pre-extend) `totalBoostedStake`. The extender's CURRENT boostedAmount is in that denominator, so they capture pro-rata `boostedAmount / totalBoostedStake` of their own recycled fee back through the subsequent `_getReward`. For a whale who is X% of the pool, X% of their recycled fee is rebated to themselves — meaning the actual "fee paid to other stakers" is `(1 - X%) × recycled`, not `recycled`. This is documented behavior (mirroring AUDIT C6 penalty-recycle), but it weakens M-AUDIT-2026-1's promise that the extend fee compensates dilution-to-other-stakers.

**Attack / Impact:** Whale-only economic edge. Quantitative example: Bob holds 50% of `totalBoostedStake` and extends his lock to MAX, recycling 100% of his 1000 TOWELI fee. `_creditRewardPool(1000)` bumps RPT by `1000 × ACC_PRECISION / totalBoostedStake`. Bob's pre-extend `boostedAmount` is half of that denominator, so `_getReward` pays him `1000 × 0.5 = 500` TOWELI back. Net fee paid to other stakers: 500 TOWELI, not 1000. The headline "100% recycle" rate over-states impact for whales. Doesn't represent theft (Bob earns this share via legitimate boost), but the design assumption that "the fee compensates other stakers" is only ~half-true at high concentration.

**Evidence:**
```solidity
// L1651-1667 — _chargeExtendFee credits BEFORE _getReward
function _chargeExtendFee(uint256 tokenId, uint256 positionAmount) internal {
    ...
    if (recycled > 0) {
        rewardToken.safeTransferFrom(msg.sender, address(this), recycled);
        _creditRewardPool(recycled);              // ← bumps RPT against OLD totalBoostedStake (includes extender's old boost)
    }
    ...
}

// L700-724 — extendLock order
_chargeExtendFee(tokenId, p.amount);              // bumps RPT (includes extender's boost)
_getReward(tokenId, p);                           // pays extender pro-rata of their OWN bump
p.lockDuration = ...; p.lockEnd = ...;
_applyNewBoost(p, newBoost);                      // re-anchors rewardDebt at post-credit RPT
```

**Recommendation:** Either (a) redirect the recycled slice through `_decayIfExpired`-style "exclude the contributor" math (subtract `p.boostedAmount` from denominator before crediting), or (b) make the recycled credit happen AFTER `_applyNewBoost` so the extender's NEW boost is the only contribution they could earn against (but they'd still earn against their new boost). The cleanest semantic is to credit recycle ONLY to *other* stakers — split the recycled fee like `recycled × (totalBoostedStake - p.boostedAmount) / totalBoostedStake` to the pool, with the residual either burned or routed to treasury. For the protocol's current scale this is an edge optimization; document it as known behavior if not fixed.

---

## [DS-10] `applyLendingContract(addr, false)` (revoke) has no safety check that no NFTs are currently escrowed at `addr` — disabling a live lending integration bricks borrower repay
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:1507-1510`
**Category:** gov / cleanup

**Bug:** `applyLendingContract(addr, false)` (called from the timelocked `executeLendingContract` on the admin) blindly flips `isLendingContract[addr] = false`. After this, `addr` is no longer in the cooldown/rate-limit exemption set OR the EOA-guard relaxation path (L1021). If a borrower deposited an NFT to `addr` BEFORE the revoke and the loan is still active at revoke time, the eventual repay/default-claim has to round-trip the NFT back to the borrower — and that round-trip now hits `TransferCooldownActive` if `block.timestamp < positions[tokenId].stakeTimestamp + TRANSFER_COOLDOWN` OR the EOA `AlreadyHasPosition` guard if the borrower has re-staked since.

**Attack / Impact:** Owner-foot-gun via the timelock admin. The 48h delay gives a window to abort, but if missed (e.g., lending integrator goes offline silently), borrowers' NFTs become permanently stuck at the lending contract — value loss on the user side. The R014 H-2 rationale for whitelist replaceability was "rotate without redeploying"; the symmetric concern (cleanup before revoke) was not addressed.

**Evidence:**
```solidity
// L1507-1510 — no safety check
function applyLendingContract(address _lending, bool _approved) external onlyAdmin {
    if (_lending == address(0)) revert ZeroAddress();
    isLendingContract[_lending] = _approved;
}

// L1017-1022 — once revoked, the from-side relaxation no longer applies
if (
    to != address(0) &&
    userTokenId[to] != 0 &&
    to.code.length == 0 &&
    !isLendingContract[from]                     // ← this is now false post-revoke
) revert AlreadyHasPosition();
```

**Recommendation:** Add a "drain" requirement before flipping `false`:
```solidity
function applyLendingContract(address _lending, bool _approved) external onlyAdmin {
    if (_lending == address(0)) revert ZeroAddress();
    if (!_approved && balanceOf(_lending) > 0) revert PendingLendingPositions();
    isLendingContract[_lending] = _approved;
}
```
`balanceOf(_lending)` is the standard ERC721 view returning the count of staking NFTs held by `_lending`. If non-zero, revoke is blocked. Borrowers must repay/default first, then admin revokes. If the lending contract is non-cooperative (bricked), the owner's escape hatch is to *grandfather* the existing positions via a separate per-tokenId-pair allowlist — not within scope here, but flag for design.

---

## [DS-11] `kick` reentrancy guard absent — combined with proposed DS-02 fix, becomes load-bearing
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:885`
**Category:** reentrancy

**Bug:** `kick()` is NOT marked `nonReentrant`. The current implementation is reentrancy-safe (only STATICCALL via `rewardToken.balanceOf` and pure storage writes). However, the recommended DS-02 fix introduces a `_settleUnsettled` path which itself is internal/no-callouts, AND eventually if any future improvement adds an actual `safeTransfer` (e.g., to immediately pay the holder rather than route through unsettled), the absence of `nonReentrant` becomes a live vector — a malicious receiver in the holder's address could re-enter via `claimUnsettled` (which IS `nonReentrant` so this specific path is OK) or a bridged-token receive callback. Pre-emptively adding the guard now is cheap and matches the rest of the user-facing surface.

**Attack / Impact:** No live exploit today; defensive hardening for the DS-02 follow-up.

**Evidence:** L885 has no modifier between `external` and the function body; compare every other state-mutating user entrypoint (L562, 612, 665, 700, 729, 765, 788, 830, 903, 1186, 1202, 1251, 1270, 1295, 1309, 1321, 1399, 1515, 1560) — all carry `nonReentrant`.

**Recommendation:** Add `nonReentrant` modifier to `kick()`. Also matches the M-S8 microscope critique pattern (transfer functions should have outer reentrancy guards).

---

## [DS-12] `setStakingAdmin` first-time setter has no safety bound — a one-shot fat-finger to a malicious or self-owned EOA permanently captures the entire admin-parameter ceremony
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:1419-1424`
**Category:** gov

**Bug:** `setStakingAdmin(_admin)` is callable exactly once by the owner with no checks beyond `_admin != 0` and `stakingAdmin == 0`. If the owner accidentally sets it to a self-owned EOA or a contract without the proper `applyXxx` interface, every timelocked admin path is bricked instantly and the only way out is `proposeAdminReplacement` (48h timelock) — assuming the wrong-but-valid contract still allows that flow to execute. There is no sanity check that `_admin` is a contract, nor that it implements `ITegridyStakingApply`. A typo that points at an EOA passes silently; subsequent `applyXxx` calls would `staticcall` an EOA's empty code and revert at the dispatch level, but the admin pointer is now stuck.

**Attack / Impact:** Ops mistake severity. The R014 H-2 rationale ("buggy or compromised admin contract could never be rotated") created `proposeAdminReplacement` to defend against this exact scenario, so recovery is possible — but it costs 48h of frozen admin parameter ceremony plus all the gas wasted on the migration. On testnet/mainnet rollouts where the deploy script is human-authored, a one-character typo is a non-zero risk.

**Evidence:**
```solidity
function setStakingAdmin(address _admin) external onlyOwner {
    if (_admin == address(0)) revert ZeroAddress();
    if (stakingAdmin != address(0)) revert Unauthorized();
    stakingAdmin = _admin;                        // ← no other validation
    emit StakingAdminReplaced(address(0), _admin);
}
```

**Recommendation:** Add a contract-existence check + interface ping:
```solidity
if (_admin.code.length == 0) revert NotAContract();
try ITegridyStakingApply(_admin).MAX_REWARD_RATE() returns (uint256) {} catch { revert WrongInterface(); }
```
The interface ping is cheap (~3k gas) and catches "right address, wrong contract" mistakes. Same defense should apply to `applyRestakingContract` (L1501-1504) and `applyLendingContract` enable path (L1507-1510), though those already go through 48h timelocks so the recovery window exists.

---

## [DS-13] `_clearPosition` always sets `userTokenId[msg.sender] = 0` — multi-position holders (Safes, vaults) lose the legacy single-pointer index even when other positions remain
**Severity:** Low
**File:** `contracts/src/TegridyStaking.sol:1587-1598`
**Category:** other / state-consistency

**Bug:** Same as `005_TegridyStaking.md` M-005-04 — `_clearPosition` blindly does `userTokenId[msg.sender] = 0` regardless of `_positionsByOwner[msg.sender].length()`. After M-5 (full aggregation), most external integrators correctly read via `_positionsByOwner` / `votingPowerOf` / `aggregateActiveBoostBps`, but legacy single-pointer integrators reading `userTokenId[holder]` will see zero even when the holder still owns other staking NFTs. This was acknowledged in the prior audit but not fixed; flagged here because the M-5 aggregation expansion did not retroactively patch this site.

**Attack / Impact:** External integrator bug, not a fund-loss vector. Legacy frontend / indexer code reading `staking.userTokenId(holder)` will silently misreport "no position" when a Safe holds 3 positions and one is withdrawn. This contradicts the M-5 fix's claim that multi-NFT holders are now first-class citizens.

**Evidence:**
```solidity
function _clearPosition(uint256 tokenId, Position storage p) private returns (uint256 amount) {
    amount = p.amount;
    totalStaked -= amount;
    totalBoostedStake -= p.boostedAmount;
    delete positions[tokenId];
    delete emergencyExitRequests[tokenId];
    userTokenId[msg.sender] = 0;                  // ← always zeros, ignores _positionsByOwner
    _burn(tokenId);
    _writeCheckpoint(msg.sender);
    _writeTotalBoostedStakeCheckpoint();
}
```

**Recommendation:**
```solidity
EnumerableSet.UintSet storage set = _positionsByOwner[msg.sender];
// _burn already removed tokenId from set in _update
if (set.length() == 0) {
    userTokenId[msg.sender] = 0;
} else if (userTokenId[msg.sender] == tokenId) {
    // Point at one of the remaining positions for legacy single-pointer readers
    userTokenId[msg.sender] = set.at(0);
}
```

---

## Summary

**Severity distribution (NEW only — exclusive of microscope C3/C4/H4 cluster, M-S1..M-S8, prior audit findings):**

| Severity | Count |
|----------|-------|
| Critical | 1     |
| High     | 2     |
| Medium   | 3     |
| Low      | 7     |

**One-line per finding:**

- **DS-01** [Critical] `withdraw` pre-decays before `_getReward` → defeats AUDIT M-01 → all post-expiry users lose pending rewards
- **DS-02** [High] `kick()` zeros boostedAmount without settling owner's pre-expiry rewards → permissionless reward-burn
- **DS-03** [High] `kick()` runs during pause → weaponises DS-02 against users who can't defend with `getReward`
- **DS-04** [Medium] `_settleRewardsOnTransfer` doesn't `_touch(from)` → bypasses 90-day inactivity gate for transfer-only users
- **DS-05** [Medium] `notifyRewardAmount` lacks `whenNotPaused` → mid-pause reward-rate manipulation window
- **DS-06** [Medium] `extendLock` doesn't reject expired positions → free re-anchor, asymmetric with `increaseAmount`
- **DS-07** [Low] `kick()` event-spam on phantom token IDs → indexer pollution
- **DS-08** [Low] `notifyRewardAmount` doesn't measure delta → FoT-token accounting drift (forward-looking)
- **DS-09** [Low] `_chargeExtendFee` credits before `_getReward` → whale recaptures pro-rata of their own recycled fee
- **DS-10** [Low] `applyLendingContract(false)` no escrow check → revoking strands NFTs at the lending contract
- **DS-11** [Low] `kick()` lacks `nonReentrant` → load-bearing once DS-02 fix lands
- **DS-12** [Low] `setStakingAdmin` no contract/interface check → typo permanently bricks ceremony
- **DS-13** [Low] `_clearPosition` clobbers `userTokenId` → multi-NFT holders lose legacy pointer (revival of `005` M-005-04)

**Single-PR closures (high leverage):**
1. **DS-01 + DS-02 + DS-03 + DS-11** — fix the `withdraw`/`kick` reward-decay ordering and add `nonReentrant`/`whenNotPaused` to `kick`. One coherent reward-preservation fix.
2. **DS-05 + DS-08** — `notifyRewardAmount` defensive hardening (pause + delta-measure).
3. **DS-04 + DS-13** — `_touch`/`userTokenId` consistency cleanup.
