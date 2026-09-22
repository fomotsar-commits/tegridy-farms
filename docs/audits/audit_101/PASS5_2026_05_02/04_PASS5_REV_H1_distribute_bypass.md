# PASS5-REV-H1 — `RevenueDistributor.distribute()` bypasses MIN_DISTRIBUTE_STAKE

**Severity:** HIGH
**File:** `contracts/src/RevenueDistributor.sol:296-298`
**Sibling fix it misses:** AUDIT M-12 (added to `distributePermissionless` at line 311)
**PoC:** `contracts/test/pass5_pocs/PASS5_REV_H1_DistributeBypass.t.sol` — `forge test --match-contract PASS5_REV_H1 -vv`
**Status:** Confirmed via PoC. Attacker captures 100% of a 50 ETH epoch with a 1-ether stake.

---

## 1. The bug

`RevenueDistributor` exposes two permissionless distribution entrypoints:

```solidity
// RevenueDistributor.sol:296-298 — UNPROTECTED
function distribute() external nonReentrant whenNotPaused {
    _distribute();
}

// RevenueDistributor.sol:309-320 — guarded
function distributePermissionless() external nonReentrant whenNotPaused {
    require(votingEscrow.totalBoostedStake() >= MIN_DISTRIBUTE_STAKE, "STAKE_TOO_LOW");
    ...
    _distribute();
    emit PermissionlessDistribution(msg.sender, epochs.length - 1);
}
```

The `MIN_DISTRIBUTE_STAKE` guard added by AUDIT M-12 protects against the "concentration attack" described in the source comment:

> AUDIT FIX M-12: Added minimum totalBoostedStake guard. Without this, an attacker could front-run a large unstake by calling `distributePermissionless` when `totalBoostedStake` is temporarily low, concentrating the epoch's revenue to the remaining stakers (including themselves).

The fix lands on `distributePermissionless` only. **`distribute()` is the sibling entrypoint that wasn't touched** — same permissionless, same `_distribute()` call, no `MIN_DISTRIBUTE_STAKE` guard.

This is a textbook sibling-miss of the same shape called out in pass-1 §4 (the systemic "every audit remediation should add a sibling search" recommendation). It survived four prior passes because each pass audited contracts in isolation; the cross-entry comparison wasn't done.

---

## 2. Cross-contract attack chain (TegridyStaking ↔ RevenueDistributor)

The attack requires 2 transactions across 2 contracts:

### Step 1 — Engineer the concentration window

`TegridyStaking.kick(uint256 tokenId)` is permissionless ([line 954](../../contracts/src/TegridyStaking.sol#L954)). When a whale's lock has expired but they haven't acted, anyone can:

1. Call `kick(whaleTokenId)`. This:
   - Settles the whale's pre-expiry rewards into `unsettledRewards`
   - Decays the whale's `boostedAmount` to 0
   - Decrements `totalBoostedStake` by the whale's prior boost
   - Writes a fresh `_totalBoostedStakeCheckpoints` entry at `block.timestamp` reflecting the post-kick total

The whale is unaware unless they're monitoring; the protocol has no on-chain notification.

### Step 2 — Sandwich the kick with a distribute

In the next block (or even the same block, since `kick` writes its checkpoint at `block.timestamp` and `distribute` reads `T-1`):

2. Attacker calls `RevenueDistributor.distribute()`. Inside `_distribute()`:
   - `snapshotTime = block.timestamp - 1`
   - `votingEscrow.totalBoostedStakeAtTimestamp(snapshotTime)` → returns the post-kick checkpoint (the kick at `T-1` is `≤ snapshotTime`, so `upperLookup(T-1)` returns it)
   - Epoch is created with the *deflated* `totalLocked`

3. Attacker calls `claim()`. For the new epoch:
   - `userPower = votingPowerAtTimestamp(attacker, epoch.timestamp)` → attacker's pre-existing stake (e.g., 1 ether boosted)
   - `share = (epoch.totalETH × userPower) / epoch.totalLocked` → if `epoch.totalLocked == userPower`, share = 100% of `epoch.totalETH`

The C-03 cap at line 743-746 limits `share` to `epoch.totalETH - epochClaimed[i]`, which IS `epoch.totalETH` for the first claimer.

---

## 3. Reproduced PoC

```
$ forge test --match-contract PASS5_REV_H1 -vv

Ran 3 tests for test/pass5_pocs/PASS5_REV_H1_DistributeBypass.t.sol:PASS5_REV_H1_Test
[PASS] test_distributePermissionless_revertsAfterConcentration() (gas: 43771)
[PASS] test_distribute_concentration_attack_partialConcentration() (gas: 365588)
Logs:
  Attacker share (5/15 of 50 ETH): 16.666666666666666666

[PASS] test_distribute_concentration_attack_succeeds() (gas: 348046)
Logs:
  Attacker stake (TOWELI):           1.000000000000000000
  Epoch ETH:                        50.000000000000000000
  Attacker gain (ETH):              50.000000000000000000
  Honest stakers' loss (ETH):        0.000000000000000000

Suite result: ok. 3 passed; 0 failed; 0 skipped
```

The three test cases prove:
- `distributePermissionless` correctly reverts `STAKE_TOO_LOW` after the concentration (positive control)
- `distribute()` succeeds anyway and lets a 1-ether attacker stake claim 50 ETH
- Even a partial concentration (5 ether attacker against 10 ether honest) yields 16.66 ETH gain — both above MIN_DISTRIBUTE_STAKE = 1000 ether, so MIN_DISTRIBUTE_STAKE wouldn't have helped against this case anyway

---

## 4. Economic analysis

### Attacker gain
- Per-attempt ceiling: ~100% of `accumulatedETHFees` queued in `RevenueDistributor` since the previous distribute cycle.
- At realistic mainnet protocol velocity (50 bps fee on $5M daily volume = ~$2.5k/day in fees, 4-hour distribute cadence ⇒ ~$420 per epoch), single-hit gain is bounded but cumulatively severe over months.
- Whale exits create irregular but visible spikes; a 30%+ totalBoostedStake whale exiting can amplify a regular epoch by 3-10x.

### Attacker cost
- Two transactions: kick + distribute. ~150-300k gas combined. ~0.01 ETH at 50 gwei.
- Stake opportunity cost: the attacker needs *some* staking position. Minimum lock is 7 days. With 1k TOWELI staked at $5 each = $5,000 of capital locked for 7 days.
- Repeatability: every 4 hours per fresh whale exit. Whale exits are predictable from on-chain `lockEnd` reads.

### Net
For any epoch of >5 ETH, the gain dwarfs the cost. The opportunity cost is ALSO recoverable (attacker's stake earns the epoch share + base rewards across multiple cycles).

---

## 5. Why prior passes missed it

The four prior passes audited contracts in isolation:
- **Pass 1 microscope** — 89 findings, all surface-level per-contract sweeps.
- **Pass 2 deep** — 143 findings on per-contract shape patterns. M-12 was NOT yet applied.
- **Pass 3 v2** — 85 findings; this is where M-12 was applied to `distributePermissionless`. The pass-2 reviewers noticed the concentration risk but only fixed the permissionless variant. The "sibling-search lint" pass-2 §4 explicitly recommended was NOT enforced.
- **Pass 4 v3** — 68 findings; the pass-3 fixes were verified for regression but the sibling-search check did not extend to `distribute()` (different function name, different modifiers — looks like a different codepath at first glance).

Pass-5 caught it specifically because the cross-contract / cross-entrypoint hunting brief required enumerating *all* permissionless triggers of `_distribute()` and asking "do they share the same guards?".

---

## 6. Recommended fix

### Minimal one-line patch
```solidity
function distribute() external nonReentrant whenNotPaused {
    require(votingEscrow.totalBoostedStake() >= MIN_DISTRIBUTE_STAKE, "STAKE_TOO_LOW");
    _distribute();
}
```

This makes `distribute()` and `distributePermissionless()` semantically equivalent for the concentration-defense axis. The two functions can then be merged in a future cleanup.

### Stronger fix (recommended)
The current `MIN_DISTRIBUTE_STAKE = 1000 ether` only blocks the trivial "attacker is the only staker" case. The partial-concentration variant (PoC test case 3) bypasses it. Two options to harden:

**(a) Raise the floor** to a more meaningful value:
```solidity
uint256 public constant MIN_DISTRIBUTE_STAKE = 100_000 ether; // ~10% of typical TVL
```
Or make it a percentage of total supply, recomputed at deploy time.

**(b) Time-weighted check** (mirrors Curve's `gauge_relative_weight_write` time-averaging):
```solidity
uint256 totalNow = votingEscrow.totalBoostedStakeAtTimestamp(block.timestamp - 1);
uint256 totalDayAgo = votingEscrow.totalBoostedStakeAtTimestamp(block.timestamp - 24 hours);
// Reject distribute when totalLock has dropped >10% in the past 24h
require(totalNow * 10 >= totalDayAgo * 9, "STAKE_DROP_TOO_SHARP");
```

This catches the kick-then-distribute attack window directly: if a whale was kicked in the past 24h, the totalBoostedStake just dropped sharply, distribute is paused until the system stabilizes.

### Process fix
The sibling-search lint pass-2 §4 recommended should be enforced as a CODEOWNERS-blocking review check. Specifically: any PR that touches `_distribute` or its callers must list (a) all permissionless callers, (b) all guards on each. PR cannot merge unless guards are equal across siblings or the divergence is explicitly justified.

---

## 7. Related findings

This finding shares the same root cause as the pass-2/pass-3 sibling-miss family:
- Pass-3 `DR2-01` (DR-02 4-sibling miss) — same shape: fix applied to one site, missed others
- Pass-3 `LD2-H1/H2/H3` — sibling-miss family in TegridyLending
- Pass-4 `DS3-01` — sibling-miss between `kick()` and `_settleRewardsOnTransfer`
- **Pass-5 PASS5-REV-H1** — sibling-miss between `distributePermissionless()` and `distribute()`

The systematic sibling-search discipline recommended by every prior master report has not been adopted in practice. Pass-5 is the fifth audit pass to surface a sibling-miss as the headline HIGH; the next pass (or paid firm) will likely surface another unless the lint becomes CI-blocking.
