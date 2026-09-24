# Agent 33 — Fresh-Eyes Audit: TegridyLendingAdmin.sol

**Scope**: Captured-owner attack surface, parameter-bound bricking, sticky DoS levers in the timelocked admin sister contract.

**Files inspected**:
- `contracts/src/TegridyLendingAdmin.sol` (429 lines)
- `contracts/src/TegridyLending.sol` (relevant: 120-330, 660-825, 1640-1972)
- `contracts/src/base/TimelockAdmin.sol` (full)
- `contracts/src/base/OwnableNoRenounce.sol` (full)

---

## F-33-1 [HIGH] — `MAX_PRINCIPAL_FLOOR` missing: captured admin can brick offer creation by collapsing principal window to a single-wei range

**Where**: `TegridyLendingAdmin.sol:179-185` (`proposeMaxPrincipal`) and `TegridyLending.sol:1656-1662` (`applyMaxPrincipalChange`).

**Issue**:
Both validation paths require only `newCap > 0` and `newCap <= MAX_PRINCIPAL_CEILING (100,000 ether)`. There is **no lower floor** on `maxPrincipal`. By contrast, `minDuration` has `MIN_DURATION_FLOOR (4h)` and `maxDuration` has the asymmetric `> minDuration` constraint enforced at apply time.

A captured admin can therefore queue:
- `proposeMinPrincipal(MAX_MIN_PRINCIPAL = 1 ether)` (allowed; ceiling-bounded)
- `proposeMaxPrincipal(1 wei)` (allowed; only floor is `> 0`)

Both 48h timelocks; can be proposed in parallel. After 48h both execute — no further admin action needed. Offer creation now requires `msg.value >= 1 ether AND msg.value <= 1 wei`, which is unsatisfiable. `_createLoanOffer` (line 757-763) reverts every call.

**Captured-admin script**:
```
T=0   : proposeMinPrincipal(1 ether) ; proposeMaxPrincipal(1 wei)
T=48h : executeMinPrincipal       ; executeMaxPrincipal
T=48h+: All createLoanOffer / createLoanOfferWithExpiry calls revert.
        Existing loans + repay + claimDefaultedCollateral unaffected.
        New lending market frozen until the legitimate admin re-rotates the
        principal bounds (another 48h × 2).
```

The proposal-validity window for un-cancelling is 7d on each, but `cancelMaxPrincipal` is owner-only (the captured admin won't cancel themselves). Net DoS until key recovery + 48h rotation cycle.

**Why this is worse than ceiling-only**:
The ceiling already bounds upward damage (admin can't make principal exceed 100k ETH, an obvious raid). But the floor-less downward path is just as damaging: dropping `maxPrincipal` below `minPrincipal` totally blocks offer creation. The asymmetric defense leaves a free DoS lever.

**Fix**: introduce `MAX_PRINCIPAL_FLOOR` (e.g., `0.01 ether`) and enforce in both `proposeMaxPrincipal` and `applyMaxPrincipalChange`:
```solidity
uint256 public constant MAX_PRINCIPAL_FLOOR = 0.01 ether; // bricking-resistant floor
if (newCap < MAX_PRINCIPAL_FLOOR) revert InvalidCapValue();
```
Symmetric pattern to `MIN_DURATION_FLOOR`.

**Severity**: HIGH — pure DoS, no fund loss, but indefinite freeze of the lending market is a kill switch a captured admin should not have. 48h-after-second-execute, recovery requires legitimate-admin key + 48h+48h timelock.

---

## F-33-2 [MEDIUM] — `proposeSweepDonatedToweli` doesn't pin `_to` to current treasury; collapses claimed 96h chained-timelock to 48h

**Where**: `TegridyLendingAdmin.sol:314-321` (`proposeSweepDonatedToweli`); audit-fix comment at `TegridyLending.sol:1921-1929` claims a 96h chained-timelock defense (BATCH-G H22).

**Issue**:
The audit-fix comment on `applySweepDonatedToweli` (line 1921-1929) describes the defense as:
> "the captured key must additionally rotate `treasury` first (+48h) — chaining two timelocks, so the effective drain window grows from 48h to 96h"

This relies on the assumption that the sweep proposal can only be queued with `_to == current treasury`. That assumption is **not enforced at propose time**. `proposeSweepDonatedToweli` only checks `_to != address(0)`. The `_to == treasury` gate is enforced ONLY in `applySweepDonatedToweli` at execute time.

Captured-admin script that drains in 48h, not 96h:
```
T=0   : proposeTreasuryChange(X)              // 48h timelock
        proposeSweepDonatedToweli(amount, X)  // 48h timelock, X ≠ live treasury — passes (only !=0 checked)
T=48h : executeTreasuryChange()    → treasury = X
        executeSweepDonatedToweli  → applySweep checks `to == treasury == X` → passes → drains.
```

The proposes are independent (different keys), so they can run in parallel. The only sequencing constraint is execute order at T=48h. Net drain window: 48h (the longer of the two equal timelocks), not 96h as documented.

**Fix**: pin `_to` at propose time:
```solidity
function proposeSweepDonatedToweli(uint256 _amount, address _to) external onlyOwner {
    if (_amount == 0) revert ZeroAmount();
    if (_to == address(0)) revert ZeroAddress();
    if (_to != lending.treasury()) revert InvalidSweepRecipient(); // <-- pin to live treasury at propose
    pendingSweepAmount = _amount;
    pendingSweepTo = _to;
    _propose(SWEEP_DONATED_TOWELI, CAP_CHANGE_TIMELOCK);
    emit SweepDonatedToweliProposed(_amount, _to, _executeAfter[SWEEP_DONATED_TOWELI]);
}
```

This forces the captured admin to (a) rotate treasury (48h), (b) execute treasury rotation, (c) THEN propose sweep with `_to = new treasury` (48h), (d) execute. Sequential = 96h actual, matching the audit-fix comment's intent.

**Severity**: MEDIUM — the sweep amount is bounded by `bal - totalEscrowRewardsOwed` (actual TOWELI surplus over escrow reservations), but with TOWELI farming live the surplus can be sizeable. 48h vs 96h halves the time available for off-chain monitors / guardian action / community veto. Also: the discrepancy between docstring claim ("96h") and actual behaviour (48h) is a documentation-vs-code drift that off-chain alerting may rely on.

---

## F-33-3 [MEDIUM] — `acceptedCollateralRemovalPending` ignores proposal expiry; expired-but-uncancelled proposal perma-blocks offer creation

**Where**: `TegridyLendingAdmin.sol:424-428`. Used at `TegridyLending.sol:778-780` to gate `_createLoanOffer`.

**Issue**:
The view returns `true` whenever `_executeAfter[KEY] != 0 && pendingAcceptedCollateral == _collateral && !pendingAcceptedCollateralAdd`. There is no expiry check: an EXPIRED removal proposal (i.e., past `readyAt + _proposalValidity()`) keeps `_executeAfter != 0` until someone calls `cancelAcceptedCollateral`.

`cancelAcceptedCollateral` is `onlyOwner`. A captured admin who proposes removal and walks away leaves the collateral perma-blocked from new offers — the proposal can no longer be EXECUTED (timelock library reverts `ProposalExpired` after `readyAt + 7d`), but the BLOCK on `_createLoanOffer` is purely keyed on `_executeAfter[KEY] != 0` and persists indefinitely.

The `cancelAcceptedCollateral` path itself already distinguishes still-live vs expired proposals (line 400: `bool stillLive = readyAt != 0 && block.timestamp <= readyAt + _proposalValidity();`). The view does NOT mirror that check.

Captured-admin DoS:
```
T=0   : proposeAcceptedCollateral(stakingX, false)  // remove proposal
        → All createLoanOffer against stakingX immediately blocked.
T=48h : Cannot execute (active loans against stakingX) — slot stays pending.
T=9d  : Proposal expires. Cannot be executed any more, but slot still pinned.
        → Block on offer creation persists until an owner cancel.
```

If the captured admin doesn't cancel, the block persists until rightful admin recovers the key.

A legitimate admin can cancel free of charge on an expired proposal (the `stillLive` carve-out skips the rate-limit), but if the captured admin retains the key, they have no incentive to cancel.

**Fix**: mirror the `cancelAcceptedCollateral` `stillLive` semantics in the view:
```solidity
function acceptedCollateralRemovalPending(address _collateral) external view returns (bool) {
    uint256 readyAt = _executeAfter[ACCEPTED_COLLATERAL_CHANGE];
    if (readyAt == 0) return false;
    if (block.timestamp > readyAt + _proposalValidity()) return false; // expired ≠ pending
    return pendingAcceptedCollateral == _collateral && !pendingAcceptedCollateralAdd;
}
```

After this fix, the captured-admin DoS is bounded to the `_propose → readyAt + _proposalValidity()` window (≈9 days max), automatically self-clearing once the proposal expires.

**Severity**: MEDIUM — only blocks NEW offer creation against the affected collateral; existing loans, repayments, and claims continue unaffected. But "permanently freezes new lending against staking-position collateral until key recovery" is a meaningful per-collateral kill switch beyond the documented 9-day window.

---

## F-33-4 [LOW] — Counter `collateralRemovalRetryCount` only resets on successful REMOVAL, not on successful re-ADD

**Where**: `TegridyLending.sol:1962` (`applyAcceptedCollateralChange`).

**Issue**:
```solidity
if (!add) collateralRemovalRetryCount[collateral] = 0;
```

The reset triggers only when a **removal** is executed. If a captured admin maxes out the `COLLATERAL_REMOVAL_MAX_CANCELLATIONS = 3` cycle on a collateral that subsequently gets re-added (e.g., legitimate operator re-adds the contract after cleaning up), the retry counter persists at 3. Future legitimate removal proposals against that collateral can be propose+execute'd, but if the legitimate admin needs to cancel a still-live one (e.g., to fix a parameter mistake), they hit `RemovalCancelLimitReached` immediately.

Not exploitable for fund loss, but a captured-admin can pre-emptively burn the cancel budget on every whitelist entry (3 cancels × 5 minutes each = 15 minutes total work), then walk away. Future legitimate operations on those collaterals lose the cancel budget for the lifetime of each collateral's whitelist entry.

**Fix**: Also reset on successful add (treats add as "fresh start"):
```solidity
if (!add) collateralRemovalRetryCount[collateral] = 0;
else if (!acceptedCollateralContracts[collateral]) {
    // resetting on TRANSITION false→true so re-additions are clean
    collateralRemovalRetryCount[collateral] = 0;
}
acceptedCollateralContracts[collateral] = add;
```

Or more simply: reset on every successful apply (any `add` value), since the counter is only meaningful between successful state changes.

**Severity**: LOW — operational/UX issue. No fund risk; legitimate operator can still execute removals, just can't cancel them mid-flight after the captured admin pre-burned the budget.

---

## F-33-5 [LOW] — Dead interface declaration `resetCollateralRemovalRetryCount` never implemented or called

**Where**: `TegridyLendingAdmin.sol:48` (interface `ITegridyLendingApply`):
```solidity
function resetCollateralRemovalRetryCount(address coll) external; // onlyAdmin (called via apply path)
```

The function is declared in the interface but:
- Never implemented in `TegridyLending.sol` (grep returns 0 matches).
- Never called from `TegridyLendingAdmin.sol`.

The reset is performed inline inside `applyAcceptedCollateralChange` (line 1962). The interface declaration is leftover from an earlier refactor.

**Fix**: delete the dead interface entry to avoid future maintainers wiring it up by accident or being confused by the inconsistency.

**Severity**: LOW — pure code-hygiene; no security impact today, but a dead interface entry is a foot-gun for future refactors (if someone re-implements it, they may double-reset or skip the inline path).

---

## F-33-6 [INFO] — Captured-admin grief loop on whitelist via expired-cancel-free path

**Where**: Combined behaviour of `cancelAcceptedCollateral` (line 395-412) and the expiry-blind `acceptedCollateralRemovalPending` (line 424-428).

**Issue (already partially captured by F-33-3 + F-33-4)**:
The `stillLive` carve-out in `cancelAcceptedCollateral` was added (per the docstring "FRESH-EYES L carve-out") to prevent counting **expired-cancel** events against the rate-limit budget. While defensible as a UX policy ("don't punish good operators for forgetting to cancel"), it gives a captured admin a free-cycle attack:

```
loop forever:
    proposeAcceptedCollateral(X, false)   // T=0: blocks new offers against X
    wait 7d + 48h                         // proposal expires; new offers still blocked
    cancelAcceptedCollateral()             // expired ≠ stillLive → no counter bump → unblocks
```

Each iteration: 9 days of perfect offer-creation blockade against any collateral. No counter ever increments. No timelock ever triggers. With multiple whitelisted collaterals, the captured admin can run the loop in parallel (one collateral per propose-cycle since the KEY is shared).

Note this is a per-key bottleneck: only ONE removal proposal can be pending across all collaterals (the `ACCEPTED_COLLATERAL_CHANGE` key is shared). So in practice, the captured admin can only block ONE collateral at a time, but they can rotate which collateral is blocked every 9 days for free. Over a year, that's ~40 days of offer-blockade per collateral spread across the whitelist.

**Fix overlap**: F-33-3 (mirror `stillLive` in the view) already kills this attack — once the proposal expires, the view returns false and offers are unblocked, so the cancel becomes a UX nicety rather than a DoS-relief lever.

**Severity**: INFO — if F-33-3 is fixed, this is fully mitigated as a side-effect. Standalone severity LOW (offers blocked but loans/repay/claims unaffected).

---

## Notes / dead-ends

- **Pause power**: Lives on `TegridyLending.pause/unpause`, not on the admin sister. Already bounded by `MAX_PAUSE_BLOCK_LIQUIDATION = 7d` (BATCH-J3 H10). After 7d of paused, lender claims proceed even while paused. Borrower repayLoan never blocked by pause. This is solid.
- **No interest model swap**: confirmed by grep — `setInterest|swap.*interest|setOracle|forceL|adminLiquidat|migrate|upgrade` returns 0 matches in `TegridyLending.sol`. The interest formula is hard-coded in `calculateLoanInterest` and not parameterizable. No engine swap. No oracle override (TWAP is `immutable`).
- **No admin-liquidate / force-liquidate**: confirmed absent. Default claim is permissionlessly callable by the lender post-deadline.
- **No reserve factor**: protocol fee is the only "cut", capped at MAX_PROTOCOL_FEE_BPS=10%. Already snapshotted at offer creation (BATCH-D H9) so live changes don't retroactively tax in-flight loans. Good.
- **`setLendingAdmin` is set-once** on the lending side (line 134-140). Once set, cannot be rotated. If the admin contract gets compromised AFTER deploy, the lending contract is permanently bound to it — only mitigation is to deploy a new lending contract. Worth noting but documented as intentional ("operational rotation use a new TegridyLending deploy" — line 119-120 NatSpec).
- **`OwnableNoRenounce.renounceOwnership` reverts**, blocking accidental renouncement. EOA-vs-contract owner enforcement is `_ownerMustBeContract = false` by default — not opted in here. EOA owner is allowed.
- **TimelockAdmin floors and ceilings**: `_minDelay()` floored at 1h, `_maxDelay()` floored at MAX_DELAY=30d, `_proposalValidity()` floored at 1h. Defense against malicious child overrides. Intact.
- **Cap parameter ranges (other than F-33-1)** are correctly floored/ceilinged: protocol fee ≤ 10%, origination fee ≤ 2%, min APR ≤ 10%, min principal ≤ 1 ETH, min duration ∈ [4h, 7d], max duration ≤ 10y. No further DoS levers found among these.
- **Apply-side defense in depth**: every `applyXxx` re-validates against the same constants. Race conditions between concurrent proposes (e.g., `pendingMinAprBps` vs `pendingMaxAprBps`) are caught by apply-time re-checks against live state. Confirmed working — no exploitable order-of-execution attacks.
- **Owner of admin vs owner of lending**: can be different. If they diverge (e.g., lending owner is multisig-A, admin owner is multisig-B), each controls its own surface. Pause is on multisig-A; parameter timelocks are on multisig-B. This is structurally sound but worth confirming during deploy that both keys are equally-trusted.
- **Signature/replay**: no signature-based admin paths. All admin actions are direct onlyOwner. No replay surface.
- **No collateral whitelist add without grace period**: but this is intentional — the 48h timelock IS the grace period. Adds and removes both wait 48h. OK.
- **No collateral remove with active borrows path**: `executeAcceptedCollateral` pre-checks `activeLoansAgainstCollateral > 0` and reverts. Defense-in-depth re-check on apply side. Confirmed safe — borrowers are not exposed to a "whitelist yanked under them" while their loan is active.

---

## Summary

| Finding | Severity | Type |
|---------|----------|------|
| F-33-1 | HIGH   | DoS — captured admin bricks offer creation by collapsing principal window (no `MAX_PRINCIPAL_FLOOR`) |
| F-33-2 | MEDIUM | Sweep `_to` not pinned at propose; chained-timelock collapses 96h→48h, contradicting BATCH-G H22 docstring |
| F-33-3 | MEDIUM | `acceptedCollateralRemovalPending` ignores expiry; expired proposal perma-blocks offer creation |
| F-33-4 | LOW    | Cancel-rate-limit counter doesn't reset on re-add, persists across collateral lifecycle |
| F-33-5 | LOW    | Dead interface entry `resetCollateralRemovalRetryCount` never implemented or called |
| F-33-6 | INFO   | Captured-admin loop via expired-cancel-free path; subsumed by F-33-3 fix |

**Recommended fix priority**: F-33-1 (HIGH bricking lever) → F-33-3 (expiry blind view) → F-33-2 (96h vs 48h) → F-33-4 → F-33-5.
