# Agent 12 — RevenueDistributor.sol distribution math (fresh-eyes audit)

Auditor: Audit Agent 12/100
Date: 2026-05-07
Scope: `contracts/src/RevenueDistributor.sol` (1429 lines), with cross-references to
`contracts/src/TegridyStaking.sol` and `contracts/src/TegridyRestaking.sol`.

Lens applied:
- Per-share precision and accumulator pattern integrity
- Donation / "first-depositor" inflation
- New depositor claiming pre-existing rewards
- Withdraw-without-harvest reward forfeit
- Cross-contract reentrancy via receive()
- Decimal mismatch and Math.mulDiv vs naive `*/`
- Flash-stake at distribute time
- Epoch double-claim and pause/unpause leakage
- Recover function pulling active rewards
- ETH push DoS

Methodology: read full contract; cross-checked the staking and restaking checkpoint
shapes; traced read/write paths through `claim`, `claimUpTo`, `_calculateClaim`,
`_pendingETH`, `proposeForfeitReclaim` / `executeForfeitReclaim`, `sweepDust`,
`autoReconcileDust`, `proposeClaimRecovery` / `executeClaimRecovery`,
`reconcileRoundingDust`, `withdrawPending`. Architecture is **NOT** Sushi-style
accumulator (no `accRewardPerShare` / `userRewardDebt`); it's **Curve FeeDistributor**:
per-epoch snapshots of `(totalETH, totalLocked, timestamp)` plus per-user
`votingPowerAtTimestamp` lookups. The classic accumulator-pattern attack surfaces
(donation-inflation, `mulDiv` precision) are **structurally not present** here.

---

## F-12-K Findings

### F-12-K-1 — Forfeit-reclaim leaves `epochClaimed[i]` unchanged → still-locked late claimers can be rugged into unfundable `pendingWithdrawals` (MEDIUM)

**Location:** `proposeForfeitReclaim` (~L1000), `executeForfeitReclaim` (~L1019),
`reclaimEligibleAmount` (~L961), interaction with `_calculateClaim` (~L777) and
`sweepDust` (~L869).

**Mechanism.**
`executeForfeitReclaim` reduces `totalEarmarked -= amount` and bumps `totalForfeited
+= amount` / `totalForfeitedReclaimed += amount`. It does **NOT** touch
`epochClaimed[i]` for any of the eligible-dust epochs. The eligible-dust pool is
computed across all epochs older than `block.timestamp - DUST_RECLAIM_GRACE` (14d).

The `_calculateClaim` per-epoch share formula is:
```
uint256 share     = (epoch.totalETH * effectivePower) / epoch.totalLocked;
uint256 remaining = epoch.totalETH > epochClaimed[i] ? epoch.totalETH - epochClaimed[i] : 0;
if (share > remaining) share = remaining;
```
Both sides reference `epoch.totalETH` (immutable post-distribution) and `epochClaimed[i]`
(the per-epoch high-water mark). `totalEarmarked` is **not** consulted at the
per-epoch share computation, so a long-locked staker who waits >14d before claiming
old epochs **still computes their full owed share** as if the forfeit-reclaim
never happened. Their cursor advances and `totalClaimed` is incremented.

The `sweepDust()` flow then computes:
```
uint256 unclaimed = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
uint256 reserved  = unclaimed + totalPendingWithdrawals;
uint256 dust      = balance > reserved ? balance - reserved : 0;
```
Since `totalEarmarked` was reduced by the forfeit amount, `unclaimed` is artificially
smaller, so a larger fraction of `address(this).balance` is treated as dust and shipped
to treasury.

**Concrete scenario (no owner-key compromise required):**
1. User A locks for 4 years with auto-MaxLock — perpetually-active staker who claims
   monthly to save gas.
2. Epoch K is distributed. A's share of epoch K is, say, 0.3 ETH out of 1 ETH
   `epoch.totalETH`. A's `votingPowerAtTimestamp(A, epoch.timestamp)` is non-zero.
3. 14 days pass without A claiming (A's normal cadence). Epoch K is now in the
   `reclaimEligibleAmount` window. The full 1 ETH `(epoch.totalETH - epochClaimed[K])
   = 1 ETH` is treated as eligible dust because `epochClaimed[K]` is still 0.
4. Owner runs `proposeForfeitReclaim(1 ETH)` → 48h timelock → `executeForfeitReclaim`.
   `totalEarmarked -= 1 ETH`. `totalForfeitedReclaimed += 1 ETH`.
5. Owner runs `sweepDust()`. The 1 ETH that was on the contract for A's epoch K share
   is now wired to treasury (since `unclaimed` figure no longer includes it).
6. A calls `claim()`. `_calculateClaim` returns `totalOwed = 0.3 ETH` for epoch K
   (math is unchanged — `epoch.totalETH` and `epochClaimed[K]` are untouched).
   `claim()` advances `lastClaimedEpoch[A]` and tries `A.call{value: 0.3 ETH, gas: 10000}`.
   Contract balance is now insufficient → the raw call returns `success=false`.
7. The branch routes to `pendingWithdrawals[A] += 0.3 ETH`. A is "credited" with a
   debt the contract balance cannot cover.
8. A calls `withdrawPending()`. `WETHFallbackLib.safeTransferETHOrWrap(weth, A, 0.3 ETH)`
   is invoked. The raw 10k-gas call fails (still no balance). The WETH-wrap leg calls
   `IWETH(weth).deposit{value: 0.3 ETH}()` which **reverts** with out-of-funds. The whole
   transaction reverts; A cannot pull. A is permanently stuck.

**Severity: MEDIUM.**
- Owner-only and 48h-timelocked.
- Lifetime cap `MAX_LIFETIME_FORFEIT_BPS = 100 bps` (1% of `totalDistributed`) bounds
  cumulative loss.
- `MAX_AUTO_RECONCILE_EPOCHS` and `proposeForfeitReclaim`'s 10-ETH per-call cap do NOT
  bound the per-epoch-share leak; they bound the magnitude per cycle.
- The honest-owner failure mode (slow claimer rugged once, capped at 1% lifetime)
  is small but real. Under owner-key compromise this becomes a slow-drain of
  protocol revenue concentrated against the most-passive cohort of locked stakers
  (often the largest holders).

**Suggested mitigation (NOT applied — read-only audit).**
Either:
- (a) Walk the eligible epochs in `executeForfeitReclaim` and bump
  `epochClaimed[i] += min(remaining_i, share_of_amount_against_epoch_i)` so future
  `_calculateClaim` correctly reports those shares as already-consumed; OR
- (b) Hard-gate the eligible-dust pool to exclude epochs whose snapshot still has
  active stakers with positive `votingPowerAtTimestamp(user, epoch.timestamp)` —
  i.e. require `block.timestamp >= ep.timestamp + max_lock_duration` before an
  epoch is eligible (so genuinely no current staker can have power at that
  epoch). Option (a) is the smaller diff.

The existing `BATCH-L1 M32` half-credit window (lines 968-984) and the
`pendingRecoveryCount[i] > 0` skip (lines 980, 994) hint at exactly this concern,
but they bound only the eligibility-pool size, not the post-execute `epochClaimed[i]`
consistency. The post-execute step is missing.

---

### F-12-K-2 — `_pendingETH` (view) uses OR-fallback for restakers; `_calculateClaim` (write) uses additive — multi-source holders see understated claimable amount (LOW)

**Location:** `_pendingETH` ~L1396-1404 vs `_calculateClaim` ~L749-768.

**Mechanism.**
The write path (`_calculateClaim`) was patched in REV-RESTAKE-01 (commented at
lines 757-768) to make the user's per-epoch power additive across staking-side
and restaking-side sources:
```solidity
// _calculateClaim — write path (line 766)
if (isRestaker) {
    userPower += _restakedPowerAt(user, epoch.timestamp);
}
```
Multi-source holders (e.g., NFT-A staked directly + NFT-B held by the restaking
contract) get credit for both.

The view path (`_pendingETH`, used by `pendingETH()` and `pendingETHPaginated()`)
remains on the OR-fallback shape:
```solidity
// _pendingETH — view path (line 1402)
if (userPower == 0 && isRestaked) {
    userPower = _restakedPowerAt(user, epoch.timestamp);
}
```
For a multi-source holder whose staking-side `userPower > 0`, the view short-circuits
the restaking add and reports a `pendingETH` figure smaller than what `claim()` will
actually pay.

**Severity: LOW (UX/integrator bug, not a value loss).**
- Front-ends and integrators relying on `pendingETH(user)` undercount. Users still
  receive the full (additive) amount when they call `claim()`.
- No exploit path; no value is lost.
- The fix is to mirror line 766 verbatim into line 1402 (replace `if (userPower == 0
  && isRestaked) { userPower = ... }` with `if (isRestaked) { userPower += ... }`).

---

### F-12-K-3 — `autoReconcileDust` redirects expired-epoch dust into the latest epoch, but already-claimed users are locked out via `claimedAtEpoch` (LOW / fairness)

**Location:** `autoReconcileDust` (~L1105), `_calculateClaim` (~L735), `claim()`
(~L599), `claimedAtEpoch[user][i]` (~L136 storage).

**Mechanism.**
When `autoReconcileDust` rolls dust from a `>14d` source epoch into
`epochs[length-1]` (the current latest epoch):
- `epochs[destEpoch].totalETH += dust` — destination's total grows.
- Source `epochClaimed[i] = epoch.totalETH` — source marked fully consumed.

Any user who already claimed `destEpoch` (so `claimedAtEpoch[user][destEpoch] = true`)
is unconditionally `continue`'d past in `_calculateClaim`:
```solidity
if (claimedAtEpoch[user][i]) {
    continue;
}
```
They cannot re-visit `destEpoch` to capture the freshly-added dust. Users who happen
to claim `destEpoch` AFTER the auto-reconcile call will receive a share scaled by the
inflated `dest.totalETH`.

**Implication.** A perverse incentive exists: **delay your claim of the latest epoch
until after `autoReconcileDust` runs to capture the dust.** A patient whale can
systematically time `autoReconcileDust` calls (it's permissionless) immediately
before claiming, capturing dust that prompt claimers cannot.

**Severity: LOW.**
- Not an extraction primitive — the "captured" dust was already designated for
  active stakers (it's the un-claimed portion of an old epoch).
- Mild fairness issue: rewards drift from prompt to patient claimers.
- Mitigation would require routing dust into a NEW (synthetic) epoch with a
  fresh `claimedAtEpoch` slate, instead of mutating `epochs[length-1]` in place.

---

### F-12-K-4 — Live-fallback `totalBoostedStake()` not wrapped in try/catch — staking-side ABI break or revert path bricks distribute (LOW / liveness)

**Location:** `_distribute` ~L389-401.

**Mechanism.**
The historical lookup is defensive:
```solidity
try votingEscrow.totalBoostedStakeAtTimestamp(snapshotTime) returns (uint256 hist) {
    locked = hist;
} catch {
    locked = 0;
}
```
But the live fallback at L400 is bare:
```solidity
if (locked == 0) {
    locked = votingEscrow.totalBoostedStake();   // <-- can revert
}
```
If a future upgrade to the staking contract removes or breaks the `totalBoostedStake()`
public getter (or if the staking contract is paused in a way that causes reads to
revert — no current paths revert paused reads, but defensive coding implies the future
might), `_distribute()` will revert and protocol revenue distribution will be
permanently stuck until the staking contract is fixed/replaced via the
`RESTAKING_CHANGE` timelock (note: `RESTAKING_CHANGE` is for `restakingContract`,
NOT `votingEscrow` — `votingEscrow` is `immutable`).

**Severity: LOW / liveness.**
- Requires a future staking-side ABI break or a new revert path.
- `votingEscrow` is `immutable`, so recovery is via redeployment of RevenueDistributor
  (which is intentional: RevenueDistributor is not upgradeable).
- Easy mitigation: wrap line 400 in `try/catch` mirroring line 390-394.

---

## Notes / dead ends (kept brief)

- **No accumulator-pattern issues.** Architecture is per-epoch snapshot (Curve
  FeeDistributor), not Sushi MasterChef. There is no `accRewardPerShare`, no
  `rewardDebt`, no `PRECISION` constant, no donation-attack inflate-then-claim
  primitive. The new-depositor-claims-old-rewards class is structurally absent
  because shares are pinned at `epoch.timestamp` via Trace208 `upperLookup`.
- **Same-block dilution / flash-stake at distribute** is closed by REV-M-01: both
  `totalBoostedStake` denominator and per-user numerator use `block.timestamp - 1`
  with `Checkpoints.Trace208.upperLookup`, which excludes any same-block stake
  written at `block.timestamp`. Confirmed by reading
  `TegridyStaking._writeCheckpoint` (L1551) and `_writeTotalBoostedStakeCheckpoint`
  (L590) — both push at `block.timestamp`.
- **Cross-contract reentrancy via receive()** is closed by the documented
  `gas: 10000` stipend on every push (`claim`, `claimUpTo`, `executeClaimRecovery`,
  `withdrawPending` via `WETHFallbackLib`). Recipients that need more gas land in
  `pendingWithdrawals` and pull via the WETH-fallback path. `nonReentrant` is held
  on every external mutator. No cross-function reentry vector found.
- **Withdraw without harvest** is not applicable — the design has no "withdraw"
  semantics. Stake/lock state is in `TegridyStaking`; this contract only reads
  power. A user who lets their lock expire enters a 7-day grace period
  (`CLAIM_GRACE_PERIOD`), then loses access. Their share is recoverable for 14d
  after that via the dust-eligible window — see F-12-K-1 for the long-locked
  staker rug variant.
- **Epoch double-claim** is closed by the unified `claimedAtEpoch[user][i]` flag
  set by both the normal `claim()` loop AND `executeClaimRecovery`. The DEEP-DR-M-04
  / V2-DR-M-02 fix history shows this was a known concern that was fully patched.
- **Pause/unpause leakage** of reward indices is N/A — there is no per-user "index"
  to leak. The cursor is `lastClaimedEpoch[user]` plus the per-epoch
  `claimedAtEpoch[user][i]`. Pause halts user claims AND owner-side mutators
  (DEEP-DR-M-02) so unpause cannot retroactively widen the claimable window.
- **Recover function pulling active rewards** — `emergencyWithdraw` requires
  `totalBoostedStake == 0` (no active stakers); `emergencyWithdrawExcess` only
  withdraws balance over `totalEarmarked - totalClaimed + totalPendingWithdrawals`.
  These two paths are well-bounded. The forfeit-reclaim path (F-12-K-1) is the
  one that lacks the corresponding per-epoch high-water-mark update.
- **ETH push DoS** is closed by the pull-pattern fallback. A malicious recipient
  contract that reverts in `receive()` cannot block other claimers — the call
  fails locally, the user is credited to `pendingWithdrawals`, and the loop
  continues. WETH-wrap path uses ERC-20 transfer which cannot be blocked by the
  recipient.
- **Decimal mismatch** is N/A — only ETH is distributed (no ERC-20 reward path).
  The `tokenSweep` path is for stuck stray tokens, not active rewards.
- **Math.mulDiv vs naive `*/`** — naive `*/` is used at L772, L1318, L1407.
  Confirmed safe: `epoch.totalETH ≤ chain ETH supply ≈ 1.2e26 wei`,
  `effectivePower ≤ epoch.totalLocked ≤ TOWELI total supply * MAX_BOOST_BPS ≈
  1e27 * 4 = 4e27`. Product `≤ 4.8e53`, well below `2^256 ≈ 1.16e77`. No
  overflow risk.
- **`MAX_RECOVERY_POWER_BPS == MAX_AGGREGATE_RECOVERY_POWER_BPS`** at 2500. The
  per-proposal cap and aggregate cap are identical, so the aggregate cap only
  binds when multiple users have proposals on the same epoch (each individually
  ≤25% but summing to >25%). Comments (L186-192) read like the values were
  intended to differ; reviewing whether 2500/2500 is really the desired tightness
  or whether the agg should be looser (e.g., 5000) to accommodate split
  legitimate-recovery use cases is an out-of-scope policy decision.
- **`pendingForfeitAmount` re-entry overlap.** `proposeForfeitReclaim` overwrites
  `pendingForfeitAmount` without zeroing the prior `_executeAfter[FORFEIT_RECLAIM]`.
  TimelockAdmin's `_propose` semantics handle this (typically reverts on
  outstanding proposal); not investigated deeply but the patterns match the other
  proposal paths and the test suite would catch a regression.

---

## Summary

**1 MEDIUM finding (F-12-K-1):** `executeForfeitReclaim` accounting drift can rug
long-locked late claimers into unfundable `pendingWithdrawals`. Bounded to 1% of
lifetime distributions by `MAX_LIFETIME_FORFEIT_BPS` and a 48h timelock per cycle.
Fix is small (sync `epochClaimed[i]` post-execute or tighten `reclaimEligibleAmount`
to exclude epochs with active stakers).

**2 LOW findings:**
- F-12-K-2: view-vs-write mismatch on restaker fallback (additive in write path,
  OR-fallback in view path) — UI under-reports `pendingETH` for multi-source holders.
- F-12-K-3: `autoReconcileDust` rolls dust into `epochs[length-1]` which can already
  be claimed by some users — locks them out of the dust, mild fairness drift toward
  late claimers.

**1 LOW liveness:** F-12-K-4 — bare `votingEscrow.totalBoostedStake()` fallback
in `_distribute` is not try/catch-wrapped; future staking-ABI break can DoS
distribution.

No CRITICAL / HIGH findings in scope. The Curve-style architecture eliminates
the accumulator-pattern attack class entirely, and the same-block dilution
window is closed by the T-1 Trace208 reads on both numerator and denominator.

Output path: `.audit_2026_freshlook/findings/agent_12_revdist_math.md`
