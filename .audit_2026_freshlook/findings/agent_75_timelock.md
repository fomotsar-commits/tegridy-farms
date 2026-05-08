# Agent 75/100 — Timelock Bypass Fresh-Eyes Audit

**Lens:** Timelock bypass — queue replay, canceller abuse, expiry tricks, propose-cancel-repropose loops, owner rotation, admin replacement.

**Target:** `contracts/src/base/TimelockAdmin.sol` and 22 admin contracts that inherit it (and 2 contracts that hold inline non-library timelocks for admin-replacement: `TegridyStaking.sol`, `SwapFeeRouter.sol`).

**Methodology:** Read `_propose`/`_execute`/`_cancel`/`_forceCancel` paths in every consumer; mapped access control on each typed `propose*`/`execute*`/`cancel*` triplet; cross-checked owner rotation, admin-rotation, and guardian/canceller asymmetries; traced expiry boundaries and key-collision surfaces.

---

## F-75-1 — TegridyStaking.executeAdminReplacement has NO validity expiry window (HIGH)

**File:line:** `contracts/src/TegridyStaking.sol:1923-1935`
**Timelock function:** `executeAdminReplacement()` (custom inline timelock, NOT via `TimelockAdmin` library)
**Bypass:**

```solidity
function executeAdminReplacement() external onlyOwner {
    uint256 readyAt = adminReplacementReadyAt;
    if (readyAt == 0) revert Unauthorized();
    if (block.timestamp < readyAt) revert Unauthorized();
    address newAdmin = pendingStakingAdmin;
    if (newAdmin == address(0)) revert ZeroAddress();
    address oldAdmin = stakingAdmin;
    stakingAdmin = newAdmin;
    pendingStakingAdmin = address(0);
    adminReplacementReadyAt = 0;
    emit StakingAdminReplaced(oldAdmin, newAdmin);
}
```

There is NO `block.timestamp > readyAt + VALIDITY_WINDOW` check. Once the 48h delay has elapsed, the proposal is executable **forever** (until cancelled or executed). This is documented as a fix in the sister contract `SwapFeeRouter.executeAdminReplacement` (lines 1110-1115, "AUDIT FIX: DEEP-R-M01 — mirror TimelockAdmin's PROPOSAL_VALIDITY by enforcing a 7-day expiry window"), but `TegridyStaking` was missed in that fix-pass.

**Attack scenario:** Owner proposes `pendingStakingAdmin = X` where X is a today-friendly multisig. Years later X is decommissioned / its key custody lapses / the deploying address gets reused by an attacker via CREATE2 redeploy / multisig sigs leak. Anyone observing the long-stale `pendingStakingAdmin` slot can co-opt the discarded address (e.g. via CREATE2 collision in factory contracts, abandoned signer keys, expired-key custody). Owner — even a fresh, honest one — calls `executeAdminReplacement()` and the protocol transfers admin authority to a now-hostile contract. The 48h delay was meant to be a window to spot a malicious propose; an unbounded post-delay window converts every years-old pending proposal into a live trap.

**Pattern of record:** OZ TimelockController, Compound Timelock both enforce `gracePeriod` bounds. SwapFeeRouter's 7-day window matches the protocol's `PROPOSAL_VALIDITY` constant in `TimelockAdmin.sol:45`.

---

## F-75-2 — TegridyLending and VoteIncentives admin contracts cannot be rotated (HIGH)

**Files:line:**
- `contracts/src/TegridyLending.sol:134-140` (`setLendingAdmin`)
- `contracts/src/VoteIncentives.sol:145-151` (`setVoteIncentivesAdmin`)

**Timelock function:** N/A — there is **no** `proposeAdminReplacement` / `executeAdminReplacement` flow at all.
**Bypass:**

```solidity
function setLendingAdmin(address _admin) external onlyOwner {
    if (_admin == address(0)) revert ZeroAddress();
    if (lendingAdmin != address(0)) revert LendingAdminAlreadySet();
    require(_admin.code.length > 0, "ADMIN_MUST_BE_CONTRACT");
    lendingAdmin = _admin;
    emit LendingAdminSet(_admin);
}
```

The `lendingAdmin` (and `voteIncentivesAdmin`) is **set-once** with `LendingAdminAlreadySet` rejecting any subsequent rotation. If the admin contract becomes compromised (private key custody for the admin's own owner leaks; a bug surfaces in the admin contract; the admin contract's owner is permanently lost), there is **no path** to install a replacement other than redeploying the entire `TegridyLending` / `VoteIncentives` contract and migrating every loan / bribe.

This is a structural inconsistency with `TegridyStaking.proposeAdminReplacement` (which exists with 48h timelock, despite missing the validity window per F-75-1 above) and `SwapFeeRouter.proposeAdminReplacement` (correct 7-day timelock + 7-day expiry). The audit chain has a fix tagged AUDIT R014 H-2 on TegridyStaking and AUDIT SFR-M-04 on SwapFeeRouter explicitly justifying the replacement flow ("a buggy or compromised admin contract could never be rotated without redeploying"), but Lending/VoteIncentives still have the original one-shot pattern.

The risk is HIGH because the timelock bypass surface here is "replacement is impossible, so a captured admin owner has 48h windows on every proposal forever — the natural defense-in-depth (admin rotation) is not available."

---

## F-75-3 — Owner rotation does NOT cancel queued proposals; rotated owner inherits all pending state (MEDIUM)

**File:line:** `contracts/src/base/OwnableNoRenounce.sol:86-103` (`_transferOwnership`)
**Timelock function:** All `_propose`/`_execute` keys
**Bypass:**

`OwnableNoRenounce._transferOwnership` only enforces the contract-only-owner hook. There is no per-key cancellation hook. Concretely, when an owner calls `transferOwnership(newOwner)` then `acceptOwnership` is called by `newOwner`, the `_executeAfter[KEY]` slots populated by the OLD owner remain set.

**Attack scenario A (captured-then-rotated):** Owner A's signing key is partially compromised. The team detects this and rotates to Owner B via 2-step. But Owner A — between detection and rotation — already queued multiple malicious proposals with 48h delays:

- `proposeFeeChange(MAX_FEE_BPS)` on TegridyFeeHook
- `proposeTreasuryChange(attacker)` on RevenueDistributor
- `proposeMaxAprBps(MAX_APR_BPS_CEILING)` on TegridyLendingAdmin
- `proposeBackstopChange(0)` on POLAccumulator
- ...

After rotation, Owner B inherits the contract. The old proposals are still pending; B must remember to call every individual `cancel*()` for each one before the 48h timer fires. There is no atomic "clear-all-proposals-on-rotation" hook. Forgetting even one means the malicious proposal becomes executable by Owner B with no in-protocol obstruction (since `_execute` is `onlyOwner` — Owner B passes that check).

**Note:** TegridyFactory's `acceptFeeToSetter` (line 269-292) DOES `_forceCancel(FEE_TO_CHANGE)` on rotation, but only for the fee proposal — `TOKEN_BLOCK_CHANGE`, `PAIR_DISABLE_CHANGE`, and `GUARDIAN_CHANGE` are NOT cleared. A captured feeToSetter can propose `proposePairDisabled(criticalPair, true)` for the protocol's main pair, get rotated out via 2-step, and the new setter inherits a 48h-pending malicious disable proposal that they must affirmatively cancel.

**Pattern of record:** OZ TimelockController doesn't auto-cancel either, but its proposers/executors are roles, not single owners, and proposal IDs are deterministic so off-chain monitoring is straightforward. Tegriddy's per-key model with no replay-id is harder to monitor on rotation.

---

## F-75-4 — Captured feeToSetter can race the 48h timelock via emergencyDisablePair instant-disable (MEDIUM)

**File:line:** `contracts/src/TegridyFactory.sol:505-520` (`emergencyDisablePair`)
**Timelock function:** Bypasses `proposePairDisabled(pair, true)` 48h delay entirely.
**Bypass:**

```solidity
function emergencyDisablePair(address pair) external {
    require(pair != address(0), "ZERO_ADDRESS");
    require(
        msg.sender == guardian || msg.sender == feeToSetter,
        "NOT_GUARDIAN"
    );
    disabledPairs[pair] = true;
    ...
}
```

`emergencyDisablePair` is callable by **either** guardian OR feeToSetter, with NO timelock. The 48h timelock on `proposePairDisabled(pair, true)` therefore provides ZERO protection in the disable direction — a captured feeToSetter can disable any pair (including the protocol's flagship pair) **instantly** via this path. The instant path was designed for guardian-only emergency response; surfacing the same authority on the captured-owner path defeats the timelock invariant for that direction.

The asymmetric design (`true → instant via emergency, false → 48h via timelock`) means a captured feeToSetter can DoS any pair instantly, but the recovery (re-enable) is timelocked at 48h. Combined with the LACK of guardian-cancel for `proposePairDisabled(pair, true)` proposals (only feeToSetter can cancel), the attack surface is: captured feeToSetter disables permanently or until guardian rotates the setter via the `proposeFeeToSetter` 48h flow.

**Note:** A guardian DOES have cancel power for re-enable proposals (line 515: "if pending value is false, force-cancel it") but has NO cancel power for disable proposals. Asymmetric cancel rights amount to a single-role veto: feeToSetter can disable forever; guardian cannot stop a same-direction proposal.

---

## F-75-5 — Expired-proposal "expirer" race in TegridyFeeHook.expireSyncAccruedFees (LOW)

**File:line:** `contracts/src/TegridyFeeHook.sol:713-723`
**Timelock function:** `expireSyncAccruedFees(address currency)` (permissionless cleanup)
**Bypass:** Boundary-condition / permissionless-state-clear hazard.

```solidity
function expireSyncAccruedFees(address currency) external {
    bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
    uint256 readyAt = _proposalReadyAt(key);
    require(readyAt != 0, "NO_PENDING_SYNC");
    require(block.timestamp > readyAt + _proposalValidity(), "NOT_EXPIRED");
    _cancel(key);
    pendingSyncCredit[currency] = 0;
    pendingSyncCreditSnapshot[currency] = 0;
    emit SyncCancelled(currency);
}
```

The check `block.timestamp > readyAt + _proposalValidity()` is strict-greater-than, but `_execute` (in `TimelockAdmin.sol:158`) uses `block.timestamp > readyAt + validity` for ProposalExpired — both are strict-`>`. This means at the **exact** boundary `block.timestamp == readyAt + validity`:
- `executeSyncAccruedFees` is still allowed (passes the `>` check, doesn't trip ProposalExpired)
- `expireSyncAccruedFees` is blocked (must be strictly greater)

This is consistent — no immediate exploit. BUT note that ANY external caller (no `onlyOwner`) can fire `expireSyncAccruedFees` the very block AFTER expiry. This means a valid-but-not-yet-executed proposal (one block past the validity window) is permissionlessly clobbered, including pendingSyncCredit and the snapshot. Combined with the 7-day SYNC_COOLDOWN check in `executeSyncAccruedFees`:

```solidity
require(block.timestamp >= lastSyncExecuted[currency] + SYNC_COOLDOWN, "SYNC_COOLDOWN");
```

A griefer can repeatedly let proposals lapse and immediately expire-cleanup them, forcing the owner to keep re-proposing. Each propose triggers a fresh 24h SYNC_DELAY plus 7-day cooldown — so the owner can be perpetually delayed by an external griefer who keeps cleaning up expired proposals. This is permissioned by design (the comment says "This function lets anyone clean up the expired state once the proposal validity window has lapsed.") but the second-order timing impact is worth flagging.

**Severity:** LOW — only impacts UX/timing for the sync-accrued-fees ceremony, not authorization.

---

## F-75-6 — VoteIncentivesAdmin.executeEnableCommitReveal is permissionless (LOW)

**File:line:** `contracts/src/VoteIncentivesAdmin.sol:201-204`
**Timelock function:** `executeEnableCommitReveal()` (no `onlyOwner`)
**Bypass:** Authority-mismatch — by-design but with subtle stale-proposal hazard.

```solidity
function executeEnableCommitReveal() external {
    _execute(COMMIT_REVEAL_ENABLE);
    voteIncentives.applyEnableCommitReveal();
}
```

The `propose` and `cancel` are `onlyOwner`, but `execute` is permissionless. The NatSpec says this preserves a legacy behavior. Idempotency on the apply-side (`if (commitRevealEnabled) return;`) makes it safe in steady state. But:

1. `proposeEnableCommitReveal` returns silently (line 188) when commitRevealEnabled is already true — `_executeAfter[COMMIT_REVEAL_ENABLE]` is NOT cleared on idempotent return. Imagine: owner proposed, then someone executed before the owner could cancel, then a new propose silently returns a no-op.

Actually wait — re-reading line 188: `if (voteIncentives.commitRevealEnabled()) return;` — this short-circuits BEFORE `_propose` is called. So `_executeAfter[COMMIT_REVEAL_ENABLE]` doesn't get touched. After a successful execute that flipped commitRevealEnabled to true, the slot was cleared by `_execute` itself, so no leftover. OK.

2. After permissionless execute, a future owner cannot toggle BACK. The flag is one-way (line 1771-1774 of VoteIncentives.sol). Permissionlessness means: an attacker watching mempool can front-run the owner's `cancel*` if owner regrets — owner queues at T=0, regrets at T=delay, attacker sees the cancel tx and front-runs with `executeEnableCommitReveal()`, locking commitRevealEnabled to true forever.

**Severity:** LOW — the toggle is forward-only by design, attacker only forces a state that owner had publicly committed to via propose. But `cancel` is meaningfully racy here, unlike sister timelocks where execute is also `onlyOwner`.

---

## F-75-7 — TegridyStakingAdmin proposals survive a stakingAdmin replacement (LOW)

**File:line:** `contracts/src/TegridyStaking.sol:1924-1935` (executeAdminReplacement) + `contracts/src/TegridyStakingAdmin.sol` (no on-rotation hook)
**Timelock function:** All TegridyStakingAdmin `propose*` flows
**Bypass:** Cross-contract state-staleness on admin rotation.

When `executeAdminReplacement` swaps `stakingAdmin = newAdmin`, the OLD admin contract still holds:
- `_executeAfter[REWARD_RATE_CHANGE]` etc. — its TimelockAdmin state
- `pendingRewardRate`, `pendingTreasury`, etc. — pending values

The new admin contract starts with fresh state. But the OLD admin contract's `executeRewardRateChange()` would still pass the `_execute` ProposalNotReady check after the 48h delay. The new admin, however, is the one wired as `stakingAdmin` — so calls from old admin to `staking.applyRewardRate(rate)` revert with `Unauthorized` (because `msg.sender != stakingAdmin`). So execution is BLOCKED but the state isn't cleaned.

**Risk:** If the rotation is later REVERSED (e.g. new admin contract has a bug, owner rotates BACK to old admin via another `executeAdminReplacement`), every old proposal is now BACK in scope and executable by anyone calling `executeRewardRateChange()` on the old admin — including proposals queued by an OLD CAPTURED owner before the original rotation. The "rotation cleared all queued state" mental model is wrong.

**Mitigation in contract:** None observed. Rotating BACK to a previously-active admin re-arms its dormant proposals.

**Severity:** LOW because the foot-gun requires (1) rotating to new admin, (2) discovering bug, (3) rotating BACK without first inspecting pending state on the old admin. But it's a real hazard for emergency-rollback procedures.

---

## F-75-8 — Cancel-and-repropose loop NOT rate-limited on most timelocks (LOW, mostly defensive observation)

**Timelock function:** Most `cancel*`/`propose*` triplets across all admin contracts.
**Bypass:** No-cooldown on propose-after-cancel.

Only `TegridyRestaking.proposeBonusRate` (line 1332-1346) and `TegridyRestaking.cancelBonusRateProposal` (line 1371-1381) implement an `BONUS_RATE_ACTION_COOLDOWN = 24 hours` rate-limit on consecutive propose actions. Every other `propose*` in the codebase allows the owner to cancel and immediately re-propose with a fresh delay.

For most parameter changes this is benign — re-proposing only EXTENDS the time before execution, never shortens it (the new propose's `block.timestamp + delay` is strictly greater than the previous). But the cancel-and-repropose loop combined with the LACK of a guardian-cancel power on most contracts means:

- A captured owner can perpetually keep a malicious proposal "live" by cancelling-then-re-proposing immediately if a guardian-equivalent ever cancels.
- Without a guardian-cancel hook on most TimelockAdmin children, this is moot — only the captured owner can cancel anyway, so there's no race partner. But the structural pattern is brittle if a future fix adds guardian-cancel.

For TegridyLendingAdmin and TegridyNFTLending, the cancel-and-repropose loop is rate-limited via `removalRetryCount[collateral]` and `COLLATERAL_REMOVAL_MAX_CANCELLATIONS = 3` (TegridyLending.sol:253). That's a partial mitigation — only for collateral-removal flow — and only counts STILL-LIVE cancels (per LD3-M3 fix at TegridyLendingAdmin.sol:392-407). Healthy.

**Severity:** LOW — pattern observation, no concrete exploit on current configuration.

---

## F-75-9 — `proposalExpired` boundary is consistent (NEGATIVE FINDING)

**File:line:** `contracts/src/base/TimelockAdmin.sol:152, 158`
**Status:** Verified safe.

Tested:
- `_propose` sets `_executeAfter[key] = block.timestamp + delay`. With `delay >= MIN_DELAY = 1 hour`, the proposal cannot become executable in the same block.
- `_execute` accepts `block.timestamp >= readyAt` (line 152: `if (block.timestamp < readyAt) revert ProposalNotReady`). `>=` is correct — at the exact boundary, execution is allowed. No off-by-one.
- `_execute` rejects `block.timestamp > readyAt + validity` (line 158). Strict `>` allows execution at the exact expiry instant. No off-by-one.
- `validity = max(_proposalValidity(), MIN_DELAY)` — defensive floor against a child override that returns 0 (line 156-157).

The "execute exactly at expiration" boundary check (Q2 in audit prompt) is correctly handled. No bypass on the boundary.

---

## F-75-10 — `MIN_DELAY-1` propose attack mitigated (NEGATIVE FINDING)

**File:line:** `contracts/src/base/TimelockAdmin.sol:130, 137`
**Status:** Verified safe.

```solidity
uint256 minD = _minDelay();
if (minD < MIN_DELAY) minD = MIN_DELAY;  // hard floor on hook return
...
if (delay < minD) revert DelayTooShort(delay, minD);
```

The protocol-wide hard floor (FRESH-EYES L) prevents a malicious or buggy `_minDelay()` override from returning 0. Even if a child returned 0, the floor clamps to MIN_DELAY = 1 hour. Every typed `propose*` call passes a hard-coded `*_DELAY` constant (24h, 48h, or higher). No call passes a user-controlled delay parameter.

**Audit-prompt Q6 (propose with MIN_DELAY-1 timing):** Cannot be triggered. All callers use constant delays >= MIN_DELAY.

---

## F-75-11 — `executeAfter` underflow attack vector mitigated (NEGATIVE FINDING)

**File:line:** `contracts/src/base/TimelockAdmin.sol:141`
**Status:** Verified safe.

```solidity
_executeAfter[key] = block.timestamp + delay;
```

Solidity 0.8+ default checked arithmetic protects against `block.timestamp + delay` overflow. Even at extreme `delay = MAX_DELAY = 30 days = 2_592_000`, plus current `block.timestamp` of ~1.7e9, the sum is far from `type(uint256).max`. No underflow path on `_execute` either: `block.timestamp < readyAt` revert is direct comparison, no subtraction.

**Audit-prompt Q7 (executeAfter underflow):** Cannot be triggered. `delay > MAX_DELAY` is rejected at line 139 (`if (delay > maxD) revert DelayTooLong`).

---

## F-75-12 — Queue-same-proposal-twice with different IDs attack (NEGATIVE FINDING)

**Status:** Verified safe.

Each typed `propose*` uses a single `bytes32 KEY` constant for fungible proposals (e.g. `FEE_CHANGE`) or a `keccak256(abi.encodePacked(KEY_DOMAIN, scopedTarget))` for per-target proposals (e.g. `keccak256("PAIR_RESET", pair)`). The `_propose` function rejects double-proposals on the same key (line 140: `if (_executeAfter[key] != 0) revert ExistingProposalPending`).

Could a child contract bypass by computing a colliding key? Only if `keccak256(abi.encodePacked(KEY, target))` collides on different (KEY, target) pairs. For unrelated keys this requires keccak256 collision (negligible). For the same KEY domain, encoding is canonical (`abi.encodePacked(bytes32, address)` is bijective).

**Audit-prompt Q3 (queue same proposal twice with different IDs):** Cannot be exploited via key collision. Each typed propose path has a unique key constant, and per-target proposals scope by canonical encoding.

---

## F-75-13 — Stale `_executeAfter[COMMIT_REVEAL_ENABLE]` after idempotent re-propose (DEAD-END / NIT)

**File:line:** `contracts/src/VoteIncentivesAdmin.sol:187-191`
**Status:** Investigated, no exploit.

`proposeEnableCommitReveal` short-circuits with `return` (no revert) when `commitRevealEnabled` is already true. This DOES preserve any previously-set `_executeAfter[COMMIT_REVEAL_ENABLE]`, BUT a successful prior `execute` would have cleared it via `_execute`. So the stale-state condition only arises if:

(a) Owner proposes
(b) Someone (permissionless executor) calls execute → _executeAfter cleared, commitRevealEnabled = true
(c) Owner re-proposes → silently returns (idempotent)

In this sequence the slot is correctly cleared in step (b), so step (c)'s silent return does not leak a stale slot.

**Severity:** Not an issue in practice. Confirming as a dead-end.

---

## F-75-14 — Permanent admin-replacement lockout via `pendingStakingAdmin = 0` race (DEAD-END / NIT)

**File:line:** `contracts/src/TegridyStaking.sol:1928-1929`
**Status:** Investigated, no exploit.

`executeAdminReplacement` reverts at line 1929 if `pendingStakingAdmin == address(0)`:

```solidity
address newAdmin = pendingStakingAdmin;
if (newAdmin == address(0)) revert ZeroAddress();
```

Could an attacker zero `pendingStakingAdmin` between propose and execute? `cancelAdminReplacement` is `onlyOwner`. No other path zeros it (the `_propose` flow always assigns before `_executeAfter`). So the only path to trip ZeroAddress at execute is:

- Propose with valid X
- Cancel (zeros both pendingStakingAdmin and adminReplacementReadyAt)
- Try to execute

But after cancel, `adminReplacementReadyAt == 0` is checked first (line 1926: `if (readyAt == 0) revert Unauthorized`), which fires before line 1929. So the ZeroAddress branch is unreachable defensive code.

**Severity:** None. Dead-end.

---

## F-75-15 — `_forceCancel` direct-write avoidance correctly migrated (NEGATIVE FINDING)

**File:line:** `contracts/src/TegridyFactory.sol:285-290`
**Status:** Verified — no remaining `_executeAfter[KEY] = 0` direct-writes outside the library.

Searched all 22 admin contracts for direct-write patterns `_executeAfter[KEY] = 0`. Only one historical case (TegridyFactory.acceptFeeToSetter) was identified in the audit history; that code now correctly calls `_forceCancel(FEE_TO_CHANGE)` per the DEEP-LIB-M5 fix. No other in-tree call directly writes the slot.

**Audit-prompt Q11 (force-cancel on rotation: cleared correctly):** Verified for the one feeToSetter rotation path. Other rotation flows (Owner2Step, AdminReplacement on Staking and SwapFeeRouter) do NOT clear pending state — see F-75-3 and F-75-7.

---

## F-75-16 — Multiple-admin / guardian cancel rights are NOT cross-cancellable (CONFIRMATION)

**Status:** Verified. Each `cancel*` requires the same authority as the corresponding `propose*` (typically `onlyOwner` or `feeToSetter`).

Specifically:
- TegridyFactory: feeToSetter is the sole canceller for `cancelFeeToChange`, `cancelTokenBlocked`, `cancelPairDisabled`, `cancelGuardianChange`, `cancelFeeToSetterProposal`. Guardian has NO cancel rights on TimelockAdmin proposals (only the special-case `cancelPairDisabled` for re-enable-direction proposals via `emergencyDisablePair` on line 514-518).
- All other admin contracts: single-owner cancel.

**Audit-prompt Q5 (multiple admins / guardians can cancel each other's proposals):** No such cross-cancel surface exists. If a future audit adds guardian-cancel to TimelockAdmin children, the propose-side rate-limit (F-75-8) would need attention because it's currently absent on most contracts.

---

## Summary Table

| ID | Severity | Issue | File:Line |
|------|----------|-----------|-----------|
| F-75-1 | HIGH | TegridyStaking.executeAdminReplacement no validity expiry | TegridyStaking.sol:1923-1935 |
| F-75-2 | HIGH | TegridyLending/VoteIncentives admin contracts cannot be rotated | TegridyLending.sol:134, VoteIncentives.sol:145 |
| F-75-3 | MEDIUM | Owner rotation does not auto-cancel pending proposals | OwnableNoRenounce.sol:86-103 |
| F-75-4 | MEDIUM | emergencyDisablePair lets feeToSetter bypass 48h disable timelock | TegridyFactory.sol:505-520 |
| F-75-5 | LOW | Permissionless expireSyncAccruedFees enables timing griefing | TegridyFeeHook.sol:713-723 |
| F-75-6 | LOW | Permissionless executeEnableCommitReveal allows cancel front-running | VoteIncentivesAdmin.sol:201-204 |
| F-75-7 | LOW | StakingAdmin proposals survive admin rotation, re-arm on rotation reversal | TegridyStaking.sol:1924-1935 + TegridyStakingAdmin.sol |
| F-75-8 | LOW | No propose-cancel-repropose cooldown on most timelocks (defensive observation) | All admin contracts except TegridyRestaking |
| F-75-9 | NEGATIVE | Boundary check at exact expiration is correct | TimelockAdmin.sol:152,158 |
| F-75-10 | NEGATIVE | MIN_DELAY-1 attack mitigated by floor | TimelockAdmin.sol:130-137 |
| F-75-11 | NEGATIVE | executeAfter underflow not reachable | TimelockAdmin.sol:141 |
| F-75-12 | NEGATIVE | Queue-same-proposal-twice mitigated by canonical key encoding | All admin contracts |
| F-75-13 | DEAD-END | Stale slot via idempotent re-propose, no exploit | VoteIncentivesAdmin.sol:187-191 |
| F-75-14 | DEAD-END | pendingStakingAdmin race, unreachable via order | TegridyStaking.sol:1928-1929 |
| F-75-15 | NEGATIVE | _forceCancel migration complete | TegridyFactory.sol:285-290 |
| F-75-16 | NEGATIVE | No cross-canceller surface (no guardian-cancel on TimelockAdmin children) | All admin contracts |

---

## Key Architectural Observations

1. **Three-tier inconsistency in admin replacement:** `SwapFeeRouter` (correct: 7d delay + 7d expiry); `TegridyStaking` (almost-correct: 48h delay, NO expiry — F-75-1); `TegridyLending`/`VoteIncentives` (no replacement at all — F-75-2). This was likely a per-contract retrofit that was applied unevenly.

2. **No on-rotation proposal cleanup hook in OwnableNoRenounce or TimelockAdmin.** Each contract that wants this (TegridyFactory does for FEE_TO_CHANGE only) implements its own. The structural risk is that any future timelocked parameter added to a contract must remember to add a force-cancel in the rotation paths.

3. **Asymmetric guardian rights in TegridyFactory.** Guardian can cancel re-enable proposals (DISABLE direction wins), but cannot cancel disable proposals (DISABLE direction also wins). Combined with `emergencyDisablePair` permissioning to feeToSetter, the 48h pair-disable timelock provides no real protection against a captured feeToSetter in the disable direction (F-75-4). Every other timelocked parameter (fee, treasury, guardian-change) does enforce the 48h delay properly.

4. **Permissionless execute on `executeEnableCommitReveal` is unique and likely an artifact** of the legacy pre-split contract. The other 80+ `execute*` functions in the codebase are all `onlyOwner`. Worth re-evaluating in light of front-running risk (F-75-6).

5. **The TimelockAdmin library itself is clean.** All bypass attempts via boundary conditions (F-75-9), MIN_DELAY underflow (F-75-10), executeAfter overflow (F-75-11), and key-collision (F-75-12) are correctly defended. Issues are all in CHILD contract integration patterns, not the library primitives.
