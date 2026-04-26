# Audit 024 — RevenueDistributor.sol (Forensic, AUDIT-ONLY)

Auditor: Agent 024 / 101
Target: `contracts/src/RevenueDistributor.sol` (819 lines)
Cross-checks: `RevenueDistributor.t.sol` (441 LOC), `Audit195_Revenue.t.sol` (877 LOC),
`FinalAudit_Revenue.t.sol` (873 LOC), `RedTeam_Revenue.t.sol` (1289 LOC).

The contract implements a Curve-style FeeDistributor with auto-checkpointed shares,
permissionless distribute, pull-pattern WETH fallback, 48h timelocks on all admin
levers, and a per-epoch `epochClaimed` cap (C-03 fix).

---

## HIGH

### H-1  Restaker fallback silently double-credits when staking checkpoint is non-zero post-restake (race window)
**Location:** `_calculateClaim` lines 536-543; `_restakedPowerAt` lines 399-406.
The fallback path executes only when `votingPowerAtTimestamp(user, ts) == 0`, but
`_restakedPowerAt` reads the *current* `boostedAmountAt`. If a user (a) has a
non-zero staking checkpoint at epoch.timestamp (e.g., they staked then restaked,
and the staking contract did NOT zero their checkpoint at transfer-in), they'll
be credited from staking. But if (b) at any later epoch the staking checkpoint
returns 0 (after restaking-NFT-transfer), the same user is now double-counted via
restaking. The contract's own comment at line 538 admits "Restakers' NFTs are
held by the restaking contract, so their staking checkpoint is zeroed on
transfer-in" — but this assumption is not enforced; if it's ever violated (e.g.,
staking refactor, multi-NFT contract), the result is silent over-credit.
**Mitigating factor:** the per-epoch `epochClaimed` cap limits TOTAL over-credit
to `epoch.totalETH`, but the FIRST claimer still sweeps disproportionate funds
relative to share, blocking legitimate claimers via `EpochExhausted`.
**Recommendation:** require `_isRestaked(user)` before consulting restaker fallback,
and emit a marker event when both sources return non-zero.

### H-2  Reward-index drift: `epoch.totalLocked` snapshot is the MIN of two reads, but claim-side denominator is *unilaterally* `epoch.totalLocked`
**Location:** `_distribute` lines 241-249; `_calculateClaim` line 547.
The distribute-side mitigation reads totalBoostedStake twice and stores the
minimum. This protects against same-tx INFLATION (denominator too high diluting
claimers). It does NOT protect against same-tx DEFLATION: an attacker who unstakes
in the same block as distribute, then restakes immediately after, can shrink the
denominator while their userPower (read at `block.timestamp - 1`) stays high.
Combined with the `effectivePower = min(userPower, epoch.totalLocked)` cap, a
single attacker can claim 100% of an epoch by transient denominator deflation.
**No test exercises same-block flash-unstake (DEFLATION) attack.**
The 4-hour distribute interval blunts but does not prevent this in a single tx.

### H-3  `pendingETH` view drifts from claim path: same `epochClaimed` snapshot can mislead UIs
**Location:** `_pendingETH` lines 766-807.
The view applies the per-epoch remaining cap (line 799-801) — good — but does NOT
mirror the actual-on-chain ordering. Two users calling `pendingETH` at the same
block both see the same `remaining`; whichever one calls `claim()` first sweeps
that remaining; the second user's UI showed available funds that no longer exist.
Frontends depending on this for UX can deceive users into spending gas for a
revert-or-zero claim. Add a per-user view that subtracts pessimistic concurrent
claims, or document this clearly in NatSpec.

---

## MEDIUM

### M-1  `effectivePower = min(userPower, epoch.totalLocked)` masks staking-checkpoint corruption
**Location:** line 546. If a single user's `votingPowerAtTimestamp` returns a
value > totalLocked (off-by-one in checkpoint, or future staking refactor bug),
the cap silently truncates instead of reverting. This hides bugs from
observability. Recommend `assert(userPower <= epoch.totalLocked)` or emit a
diagnostic event when truncation occurs.

### M-2  `reconcileRoundingDust` has no timelock — owner can sweep up to 1 ETH per call
**Location:** lines 744-751. Unlike `forfeitReclaim` (10 ether, 48h timelock) or
`emergencyWithdrawExcess` (48h timelock), `reconcileRoundingDust` is callable
instantly with no timelock. Cap is 1 ETH per call but owner can spam-call across
many txs, accumulating a sweep larger than the gap intent allows. Recommend
either timelock or per-day rate limit (e.g., 1 ETH/24h).

### M-3  Grace-period race: user can extend lock between snapshot and claim to bypass `epoch.timestamp >= lockEnd` cut
**Location:** lines 530-533. The grace-period gate breaks the loop at the FIRST
epoch with `timestamp >= lockEnd`. A user whose lock just expired can re-lock
(post-snapshot) at a far-future lockEnd, then call `claim()` and get
`lockActive = true` — now claims ALL old epochs without grace cutoff. This may
be intended (re-lockers earn rewards) but no test covers the relock-after-expiry
+ retroactive-claim flow. Document or test.

### M-4  `MIN_DISTRIBUTE_STAKE` constant insufficient to defend against concentration on small protocols
**Location:** line 209. 1000e18 (≈1000 TOWELI). On a fresh protocol or after
mass-unstake event, an attacker holding say 1500e18 can call
`distributePermissionless` and sweep ~67% of the next ETH inflow. For a high-
value distribution this is non-trivial. Consider raising or making
governance-tunable with timelock.

### M-5  `block.timestamp - 1` snapshot at line 244 is not safe at genesis
**Location:** line 244 — `snapshotTime = block.timestamp > 0 ? block.timestamp - 1 : 0`.
The ternary handles `block.timestamp == 0`, but on a real chain that's
unreachable, and the L2 case (block.timestamp can equal previous block's) means
two distribute calls in adjacent blocks share the same `snapshotTime`. Combined
with `votingPowerAtTimestamp` upper-lookup semantics, this can collide checkpoints
across consecutive epochs. Low practical impact but a subtle invariant break.

### M-6  Owner emergency-sweep: `executeForfeitReclaim` reduces `totalEarmarked` without ANY claim-window check
**Location:** lines 719-728. Comment says "users who let their locks expire
without claiming leave ETH permanently trapped" — but there's no check that the
target ETH is from epochs whose grace period actually expired. Owner can call
this and shrink `totalEarmarked` for FRESH epochs, then `sweepDust` to drain
funds that legitimate claimers would otherwise receive. The 10-ether-per-call
cap + 48h timelock soften but do not eliminate this rug vector. Recommend
requiring proof (epoch ID + lockEnd > grace) before allowing forfeit accounting.

### M-7  `pause()` only blocks user-facing claims/distribute — owner admin actions still work
**Location:** lines 409-416 and `whenNotPaused` modifiers on `claim/claimUpTo/distribute/distributePermissionless`. Pause does NOT
block `executeForfeitReclaim`, `executeEmergencyWithdrawExcess`, `sweepDust`,
`reconcileRoundingDust`, or `executeTokenSweep`. If pause is triggered due to
a discovered exploit, owner can still drain via these paths during the pause
window. Recommend adding `whenNotPaused` to all owner-rug-capable paths or
introducing a separate `EMERGENCY_PAUSE` that locks owner sweeps too.

### M-8  No claim deadline / expiry — unbounded `epochs.length` growth and view-DoS
**Location:** epochs array unbounded; `claim()` reverts if more than 500
unclaimed but `claimUpTo(maxEpochs)` does not have an upper limit per epoch
gas budget. With future staking-contract gas regressions, even 500-epoch claims
may exceed block gas, locking inactive users out forever. Consider per-user
last-active-tracking or epoch archival.

---

## LOW

### L-1  `totalForfeited` is incremented but never used in any invariant or external view
**Location:** lines 97, 725, 748. Tracked but invisible to off-chain observers.
Add a getter or include in events.

### L-2  `epochCount() - 1` underflow in `distributePermissionless` if epochs.length == 0
**Location:** line 221. After `_distribute()`, `epochs.length >= 1` is guaranteed
(push happened). Safe in current flow but fragile to future refactors.

### L-3  `PendingWithdrawalCredited` event emitted regardless of whether credit changed value
**Location:** line 462. If a contract claims twice via the failure path, two
events are emitted with the *cumulative* `totalOwed` value, which is misleading
for indexers expecting incremental amounts.

### L-4  `MAX_VIEW_EPOCHS` and `MAX_CLAIM_EPOCHS` both set to 500 — no asymmetry for view vs write
**Location:** lines 103-104. Views can be tuned higher safely (off-chain). Tying
them couples gas-cost decisions across pure and stateful paths.

### L-5  `sweepDust` and `reconcileRoundingDust` both emit `DustSwept(treasury, amount)` — indexer ambiguity
**Location:** lines 652 and 750. Different paths, same event. Add a discriminator.

### L-6  No fee-on-transfer reward token concern (ETH-native) — but `executeTokenSweep` does not handle FoT
**Location:** line 680 — `IERC20.safeTransfer` on whole balance. If treasury or
sweep-target is on a deny-list of an FoT token, the call reverts and the
proposal must be re-issued. Recommend allow partial sweep.

---

## INFO

### I-1  No multi-token distribution accounting risk — contract handles ETH only via `epochs[].totalETH`. No collisions possible.

### I-2  Integer overflow: all cumulative reward math uses `uint256`. Solidity 0.8.26 reverts on overflow. `epoch.totalETH * effectivePower` could theoretically overflow if both >= 2^128, but ETH supply makes this unreachable.

### I-3  `WETHFallbackLib.safeTransferETHOrWrap` provides DoS-resistance: blocklisted recipients are wrapped to WETH instead of reverting the whole tx. Verified on inspection; coverage in `test_withdrawPending_weth_fallback`.

### I-4  Reentrancy: `nonReentrant` on all stateful externals. `claim()` uses 10k-gas stipend (Solmate pattern) for cross-contract reentrancy hardening — line 456, 500.

### I-5  Owner cannot renounce (`OwnableNoRenounce`) — this is intentional but means treasury-rug surface persists indefinitely.

### I-6  Restaker-fallback comment at line 396-398 acknowledges "current boostedAmount is a lower bound for historical power" — sound, but means restakers may be UNDER-credited if their boost was higher in the past. Acceptable trade-off, documented.

---

## TEST GAPS

1. **No test for same-block flash-deflation of `totalBoostedStake`** during `distribute()` (H-2 attack vector).
2. **No test for restaker double-credit when staking checkpoint also returns non-zero** (H-1).
3. **No test for relock-after-expiry retroactive-claim** (M-3).
4. **No test for `executeForfeitReclaim` against fresh epochs (M-6 rug)**.
5. **No test for owner sweep paths during `paused()` state** (M-7).
6. **No invariant test for `sum(epochClaimed[i]) <= sum(epoch.totalETH)`** across all claims.
7. **No fuzz test for `_calculateClaim` with random userPower / totalLocked / per-epoch-claimed combinations**.
8. **No test for `lastDistributeTime` collision in `block.timestamp == lastDistributeTime + interval` exact-equality** (off-by-one).
9. **No test for `MIN_DISTRIBUTE_STAKE` exactly at threshold (1000e18)** — boundary check.
10. **No test verifying `pendingETH` view matches `claim()` output for users with restaker-only voting power** (cross-validation).

---

## SUMMARY

| Severity | Count |
|----------|-------|
| HIGH     | 3 |
| MEDIUM   | 8 |
| LOW      | 6 |
| INFO     | 6 |
| TEST GAP | 10 |

Most-pressing remediation: H-2 (flash-deflation race) and M-6 (forfeit-reclaim
rug) deserve fix + tests before next deploy. Other items are defense-in-depth.
