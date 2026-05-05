# PASS7-LENDING-04 — directPaid + legacy double-claim regression

**Severity:** HIGH
**Surface:** `TegridyLending.pullEscrowRewards`
**Introduced by:** PASS7-LENDING-03 deferred-slice tracking fix (commit `b6b356d`, file `contracts/src/TegridyLending.sol` lines ~1018–1028)
**Surfaced by:** `Pass7_LendingExtSolvency.invariant_p7a_toweliCoversEscrowOwed` (new in this remediation pass — `contracts/test/invariants/Pass7_LendingExtSolvency.t.sol`)
**Date opened / closed:** 2026-05-04 (same-day surface + remediation)

## 1. What the bug is

`pullEscrowRewards` has two parallel payout legs:

1. **Direct path** (`TegridyLending.sol:1832-1838`): when the NFT is no longer escrowed at lending, call `staking.claimUnsettledForTokenId(loan.tokenId, recipient)` — drains the per-tokenId staking bucket directly to the recipient and returns the amount in `directPaid`.
2. **Legacy pro-rata path** (`TegridyLending.sol:1840-1888`): pay the recipient `mulDiv(escrowRewardsOwed[loanId], lending.toweliBalance, totalEscrowRewardsOwed, Floor)`.

PASS7-LENDING-03 added a deferral-tracker in `repayLoan` / `claimDefaultedCollateral` that, when the two-phase per-tokenId pull deferred (paused staking), records the un-claimable slice into `escrowRewardsOwed[_loanId]` so the recipient can recover it later via `pullEscrowRewards`. Once staking unpauses, the recipient's `pullEscrowRewards` call:

- Direct path succeeds — drains the parked slice from the staking bucket DIRECTLY to recipient. `directPaid = K`.
- Legacy path sees `available = lending.toweliBalance = 0` (the staking bucket flowed PAST lending, not into it), so `payout = 0`.
- Decrement step: `escrowRewardsOwed[_loanId] -= 0`, `totalEscrowRewardsOwed -= 0`. **Both stay at K.**

The recipient has been paid K via `directPaid`, but the legacy ledger still records K as owed to them. Any subsequent TOWELI inflow to lending (donation, sibling loan's `priorShare`, sweep return) lets the same recipient call `pullEscrowRewards` a second time and drain the inflow via the legacy pro-rata path — same slice paid twice.

## 2. Trigger preconditions (operational, not adversarial)

1. Staking gets paused at any point during a loan's lifetime. Admin pause is a routine operational lever (emergency response, audit, upgrade).
2. The borrower repays — or the lender claims default — during the pause window. The deferral-tracker records `escrowRewardsOwed[_loanId] += myDeferred`.
3. Staking unpauses.
4. Recipient calls `pullEscrowRewards` once. `directPaid` succeeds, legacy ledger does not reconcile.
5. Any future TOWELI inflow to lending. PoC uses a direct `transfer` to lending, but every `priorShare` from a sibling loan settling on a different `tokenId` lands in lending's TOWELI balance the same way.
6. Recipient calls `pullEscrowRewards` a second time — drains the inflow via legacy pro-rata.

## 3. PoC

[`contracts/test/PASS7_LENDING_04.t.sol`](../contracts/test/PASS7_LENDING_04.t.sol) — `test_PASS7_LENDING_04_directPaid_legacy_double_claim`. Pre-fix logs show alice receiving 10,000 ether twice for an actual 10,000 ether accrual (1× via `directPaid`, 1× via legacy pro-rata against a 10,000-ether donation).

## 4. Fix

In `pullEscrowRewards`, immediately after `uint256 owed = escrowRewardsOwed[_loanId];`, reconcile the legacy ledger against `directPaid` so both decrement in lockstep:

```solidity
if (directPaid > 0 && owed > 0) {
    uint256 reconcile = directPaid > owed ? owed : directPaid;
    escrowRewardsOwed[_loanId] = owed - reconcile;
    if (totalEscrowRewardsOwed >= reconcile) {
        totalEscrowRewardsOwed -= reconcile;
    } else {
        totalEscrowRewardsOwed = 0;
    }
    owed = escrowRewardsOwed[_loanId];
}
```

Reconcile is `min(directPaid, owed)` — the directPaid economically pays off the same slice that was booked into `escrowRewardsOwed` at deferral. Decrementing them together keeps the legacy ledger honest. Subsequent TOWELI inflows to lending no longer create a phantom debt.

Closed at [`TegridyLending.sol:1845-1869`](../contracts/src/TegridyLending.sol#L1845).

## 5. Why this didn't get caught earlier

- PASS7-LENDING-03 unit test (`PASS7_LENDING_03.t.sol`) covers the **happy path** of snapshot-and-delta where Alice's deferred slice flows out via the legacy pro-rata path against lending's TOWELI balance — it never exercises the direct path on the same loan.
- Pass-6 `LendingInvariants` and `Pass6_LendingSolvency` had no pause/unpause handler actions; the deferral-tracker code path was never exercised under invariant testing.
- The bug is a state-desync between two payout legs that LOOK independent but economically alias the same slice. Static analysis can't see this — it's a semantic invariant.

## 6. Regression coverage

- [`PASS7_LENDING_04.t.sol`](../contracts/test/PASS7_LENDING_04.t.sol) flipped from "asserts bug" to "asserts fix": post-fix, the second pullEscrowRewards reverts `NoEscrowRewards` and the donation is untouched.
- [`Pass7_LendingExtSolvency.t.sol`](../contracts/test/invariants/Pass7_LendingExtSolvency.t.sol) — new stateful invariant suite extending Pass-6 with pause/unpause + claimStuckCollateral handler actions. Three properties:
  - **P7A-1** ETH solvency holds across pause cycles
  - **P7A-2** TOWELI backing for `totalEscrowRewardsOwed` (the property that surfaced this bug)
  - **P7A-3** `stuckCollateralRecipient` implies loan settled

## 7. Audit-tracked count delta

Before this remediation: 418 findings closed across the 7-pass lineage. After: **419 findings** (this is the 14th pass-7 closure, but the 1st surfaced post-pass-7 by the new invariant suite). Severity bucket update for pass-7: 1 CRITICAL + **7 HIGH** (was 6) + 4 MEDIUM + 1 LOW + 1 INFO.
