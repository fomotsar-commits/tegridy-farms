# Tegridy Farms — Deep Lending Audit (2026-05-01)

**Targets:** `contracts/src/TegridyLending.sol` (1480 lines), `contracts/src/TegridyNFTLending.sol` (869 lines)
**Method:** Line-level forensic re-read after MICROSCOPE_2026_04_30, focused on (a) "half-installed mitigation" pattern (microscope §4) where a fix was applied to one entrypoint but a sibling was missed, (b) NEW vulnerabilities not in MICROSCOPE H9/H10/H11/M-L1..M-L8, and (c) cross-contract semantic drift between TegridyLending (token collateral) and TegridyNFTLending (NFT collateral).

---

## [LD-H1] Pause-asymmetry: TegridyNFTLending interest accrues during pause but `claimDefault` is whenNotPaused — H11 sibling miss
**Severity:** High
**File:** `contracts/src/TegridyNFTLending.sol:445-476`
**Category:** dos

**Bug:** MICROSCOPE H11 identified that TegridyLending taxed the borrower with interest accrual during admin pauses while simultaneously blocking the lender's `claimDefault` path. The fix in TegridyLending.sol (`calculateLoanInterest` / `pauseAdjustedElapsed`) excludes paused windows from the interest numerator. **TegridyNFTLending received the deadline-extension portion of the H11 fix (`effectiveDeadline`) but did NOT receive the interest-accrual portion**: `repayLoan` still calls plain `calculateInterest(principal, aprBps, startTime, block.timestamp)` without subtracting paused time.

**Attack / Impact:** Admin pauses for 30 days during a 60-day loan. Borrower attempts `repayLoan` on day 90 (within `effectiveDeadline + GRACE` because `effectiveDeadline = original deadline + 30d`). Interest = APR × 90 days, even though only 60 days were "active." Borrower over-pays 50% on interest while lender simultaneously could not have called `claimDefault` for the 30-day pause window. Pure tax on the borrower with no offsetting risk for the lender — the exact pattern H11 was supposed to close.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:470-475 (repayLoan)
uint256 interest = calculateInterest(
    principal,
    aprBps,
    startTime,
    block.timestamp     // <-- raw block.timestamp, no pause adjustment
);
```
Compare with TegridyLending.sol:706: `uint256 interest = calculateLoanInterest(_loanId);` — the proper fix.

**Recommendation:** Port the `pauseAdjustedElapsed` helper from TegridyLending. Replace the `calculateInterest` call in `repayLoan` and the `getRepaymentAmount` view with a `calculateLoanInterest(_loanId)` that uses pause-adjusted elapsed time. Mirror TegridyLending.sol:931-942.

---

## [LD-H2] TegridyNFTLending `effectiveDeadline` uses GLOBAL `totalPausedDuration` — H10 sibling miss
**Severity:** High
**File:** `contracts/src/TegridyNFTLending.sol:128-135, 793-816`
**Category:** other

**Bug:** MICROSCOPE H10 identified that TegridyLending originally added the *global* `totalPausedDuration` to every loan's deadline, so a 7-day pause from before deployment-day would retroactively extend a freshly-accepted loan's deadline by 7 days. The TegridyLending fix introduced a `pausedDurationAtStart` snapshot per loan. **TegridyNFTLending did NOT receive this fix** — line 812 still reads the global accumulator unconditionally.

**Attack / Impact:** Day 1: contract pauses, day 30: contract unpauses (`totalPausedDuration = 29d`). Day 31: borrower accepts a 7-day loan; `loan.deadline = day 38`. Day 39: `effectiveDeadline(loanId) = 38 + 29 = day 67`. Lender's `claimDefault` path is blocked until day 67+1h, despite the loan being legally defaulted on day 38. Borrower walks free for 29 extra days. This is exactly the H10 vector — confirmed alive in TegridyNFTLending.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:809-817
function effectiveDeadline(uint256 _loanId) public view returns (uint256) {
    if (_loanId >= loans.length) revert InvalidLoanId();
    uint256 base = loans[_loanId].deadline;
    uint256 pauseExt = totalPausedDuration;            // <-- GLOBAL accumulator
    if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
        pauseExt += block.timestamp - pauseStartTime;
    }
    return base + pauseExt;
}
```
The `Loan` struct (lines 89-101) does NOT have a `pausedDurationAtStart` field.

**Recommendation:** Add `pausedDurationAtStart` to the `Loan` struct. Snapshot `totalPausedDuration` at `acceptOffer` (line 415 area). Subtract it inside `effectiveDeadline` so only post-loan-start pause time extends the deadline. Direct port of TegridyLending.sol:280, :653, :1251-1253.

---

## [LD-H3] TegridyLending `createLoanOffer` lacks `nonReentrant` despite external ETH transfer
**Severity:** High
**File:** `contracts/src/TegridyLending.sol:515-568`
**Category:** reentrancy

**Bug:** `createLoanOffer` is `external payable whenNotPaused returns (uint256 offerId)` — note the absence of `nonReentrant`. The function performs `WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, originationFee)` (line 542) BEFORE pushing to the `offers[]` array (line 547). A malicious treasury contract whose `receive()` re-enters `createLoanOffer` (or any other state-mutating entry that doesn't carry `nonReentrant` itself) can observe a window where `offers.length` is the pre-call value but the lender's ETH has already been forwarded.

Compare with TegridyNFTLending.sol:282 which DOES have `nonReentrant` — direct asymmetry. The 10k gas stipend in WETHFallbackLib limits the blast radius (treasury can do ~3 SSTOREs), but the asymmetry indicates a missed fix and the stipend was deemed "borderline / DEFERRED" in M-7 (POST_REMEDIATION_LEDGER).

**Attack / Impact:** A malicious treasury (or a future treasury with `receive()` that re-enters via `cancelOffer` for a previously-created offer) can manipulate ordering. While 10k gas is tight, with sufficient warm-storage and event-only logic, an attacker could in principle call back into `cancelOffer` for a prior offer, refund themselves, then return — leaving `offers[]` in an inconsistent state. Even absent a concrete exploit, the asymmetry-against-the-sibling-pattern violates the protocol's "every ETH-out is nonReentrant" invariant called out in audit doc 006 §I-006-2.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:515-521
function createLoanOffer(
    uint256 _aprBps,
    uint256 _duration,
    address _collateralContract,
    uint256 _minPositionValue,
    uint256 _minPositionETHValue
) external payable whenNotPaused returns (uint256 offerId) {  // <-- no nonReentrant
```

**Recommendation:** Add `nonReentrant` modifier to `createLoanOffer` to mirror TegridyNFTLending.sol:282 and the rest of TegridyLending's ETH-paying surface (`cancelOffer`, `acceptOffer`, `repayLoan`, `claimDefaultedCollateral`).

---

## [LD-M1] TegridyLending `executeAcceptedCollateral` skips active-loan check — NEW-L3 sibling miss
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:1461-1469`
**Category:** other

**Bug:** TegridyNFTLending's `executeRemoveCollection` was hardened (NEW-L3) to refuse removal while `activeLoansOfCollection[collection] > 0`. The TegridyLending sibling, `executeAcceptedCollateral`, does NOT have this check. Admin can de-whitelist a TegridyStaking contract while loans are still in-flight against it.

The blast radius is bounded by the fact that downstream `acceptOffer` does NOT re-check the whitelist (line 615 just casts to `ITegridyStaking(collateralContract)` without re-checking), and `repayLoan` / `claimDefaultedCollateral` use `offers[offerId].collateralContract` directly. So existing loans complete correctly. **However**: pending offers that haven't been accepted now point at de-whitelisted collateral, and there's no event signalling "your offer is stranded" — lenders must manually `cancelOffer` to reclaim ETH. UI integrators reading `acceptedCollateralContracts[X]` will mark the offer as invalid while the on-chain offer struct still says `active = true`.

**Attack / Impact:** Admin de-whitelists a popular staking contract to degrade competitor protocol; existing offers get stranded mid-flight. No financial loss but UX-poisoning vector. More concretely, if a NEW staking contract is added to the lending whitelist (via the same proposeAcceptedCollateral path) and it's later identified as compromised, governance can flip it OFF, but in-flight loans against it will continue to settle through whatever the compromised contract returns from `transferFrom` / `unsettledRewards` — exactly the post-compromise window NEW-L3 was designed to close on the NFT side.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:1461-1469
function executeAcceptedCollateral() external onlyOwner {
    _execute(ACCEPTED_COLLATERAL_CHANGE);
    address collateral = pendingAcceptedCollateral;
    bool add = pendingAcceptedCollateralAdd;
    acceptedCollateralContracts[collateral] = add;   // <-- no active-loan gate
    pendingAcceptedCollateral = address(0);
    pendingAcceptedCollateralAdd = false;
    emit AcceptedCollateralChanged(collateral, add);
}
```
Compare TegridyNFTLending.sol:685-692.

**Recommendation:** Track `activeLoansAgainstCollateral[address]` in TegridyLending (mirror NFT lending's `activeLoansOfCollection`). On removal proposals, refuse to execute when count > 0; force admin to wait for the loans to settle.

---

## [LD-M2] `pullEscrowRewards` proportional payout uses raw `*` — overflow + claim-order dependency
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:1394-1420`
**Category:** math

**Bug:** Two distinct issues that compound:

1. **Raw multiply at line 1402**: `payout = (owed * available) / total;` This mirrors the M-L7 NFTPool finding (microscope §6 Lending). For the TOWELI token (1B fixed supply, 18 decimals = 1e27), if `owed = 1e25` and `available = 1e26`, `owed * available = 1e51` — within uint256 (max ~1.16e77) for these magnitudes, BUT if a single defaulted whale's escrow rewards approach `1e30` and `available` similarly, the product exceeds `1.16e77`. Use `Math.mulDiv` for the same defence-in-depth that NFT-CL-M2 applied to `calculateInterest`.

2. **Claim-order dependency (NEW)**: When `available < total`, the *first* claimant pulls `(owed_1 * available) / total`, leaving `available_2 = available - payout_1`. The *next* claimant computes against the new `total_2 = total - payout_1` and `available_2`. Two beneficiaries with identical `owed` claim wildly different amounts depending on who calls first. Specifically:
   - Loan A: owed = 100, Loan B: owed = 100, total = 200, available = 100.
   - A calls first: payout_A = `(100 * 100) / 200 = 50`. Now total = 150, available = 50.
   - B calls: payout_B = `(100 * 50) / 150 = 33`. owed_B = 67 left.
   - A calls AGAIN later (after `claimUnsettled` top-ups): payout_A2 may exceed remaining-owed proportional fairness because `total` shrinks faster than `available` recovers.

This isn't merely "first-mover" advantage — late callers can systematically receive less than their pro-rata share even after the contract is fully solvent, because `total` was already netted by earlier partial withdrawals.

**Attack / Impact:** If staking is briefly paused and `claimUnsettled` defers for a fraction of the escrow pool, the first borrower/lender to call `pullEscrowRewards` after un-pause receives a disproportionately large share. A vigilant whale who monitors `EscrowRewardsClaimDeferred` events can systematically front-run pullEscrowRewards calls to extract over-share.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:1394-1413
uint256 available = IERC20(toweli).balanceOf(address(this));
uint256 total = totalEscrowRewardsOwed;
uint256 payout;
if (available == 0 || total == 0) {
    payout = 0;
} else if (available >= total) {
    payout = owed;
} else {
    payout = (owed * available) / total;          // <-- raw multiply, also order-dependent
}
escrowRewardsOwed[_loanId] = owed - payout;
if (totalEscrowRewardsOwed >= payout) {
    totalEscrowRewardsOwed -= payout;
} else {
    totalEscrowRewardsOwed = 0;
}
```

**Recommendation:**
- Switch to `Math.mulDiv(owed, available, total, Math.Rounding.Floor)` for overflow safety.
- For the order-dependency, adopt a **Synthetix-style pull pattern**: maintain an `accRewardsPerOwed` accumulator that increments by `(newRewards * SCALE) / totalOwed` whenever rewards arrive, and pay each beneficiary `(owed * accRewardsPerOwed - userDebt) / SCALE`. This decouples payout from call-order.

---

## [LD-M3] `isDefaulted` view contradicts `claimDefaultedCollateral` truth across pause + grace
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:958-962`, `contracts/src/TegridyNFTLending.sol:615-619`
**Category:** other

**Bug:** Both `isDefaulted` views read raw `l.deadline` — they do NOT incorporate (a) the GRACE_PERIOD buffer or (b) the `effectiveDeadline` pause-extension. The actual default-claim path requires `block.timestamp > effectiveDeadline(loanId) + GRACE_PERIOD`. So `isDefaulted` returns TRUE during three windows where `claimDefaultedCollateral` / `claimDefault` will revert:
1. `(deadline, deadline + GRACE_PERIOD]` — the 1h grace window.
2. The current pause window (entire pause duration after the nominal deadline passed).
3. After unpause, until `effectiveDeadline + GRACE_PERIOD` is fully reached.

**Attack / Impact:** Front-end bots, indexers, and lender automation that monitor `isDefaulted` to trigger `claimDefaultedCollateral` will repeatedly send transactions that revert (gas waste, mempool noise). Worse, a competitor protocol's UI showing "X loans defaulted on Tegridy" shifts user perception of risk based on a metric that doesn't match on-chain truth. Already flagged as L-6 in agent 007 for NFT lending; here re-flagged because (a) TegridyLending also has it, (b) it's now compounded by the pause-extension semantics added later.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:958-962
function isDefaulted(uint256 _loanId) external view returns (bool) {
    if (_loanId >= loans.length) revert InvalidLoanId();
    Loan memory l = loans[_loanId];
    return !l.repaid && !l.defaultClaimed && block.timestamp > l.deadline;
    //                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                                       should be: block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD
}
```

**Recommendation:** Replace `block.timestamp > l.deadline` with `block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD` in both contracts. Aligns the view with the actual claim path's gate.

---

## [LD-M4] TegridyLending `createLoanOffer` allows offers against collateral with pending-removal proposal
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:515-568`
**Category:** other

**Bug:** TegridyNFTLending's `createOffer` (line 300-305) refuses to create new offers when `pendingWhitelistRemove == _collateralContract && _executeAfter[WHITELIST_REMOVE] != 0`. **TegridyLending's `createLoanOffer` does not have this check** for the `pendingAcceptedCollateral + !pendingAcceptedCollateralAdd` case. So during the 48h timelock window between propose-removal and execute-removal, lenders can still escrow capital against a collateral type governance has signalled "this is unsafe."

**Attack / Impact:** Admin proposes removal of collateral X at T0 due to discovered exploit. Between T0 and T0 + 48h, attackers (lenders + sock-puppet borrowers) race to spam fresh offers + accept them, locking in interest rates / terms before the removal. Combined with [LD-M1], the loans will continue to settle even after the removal executes — extending the post-compromise window the timelock was supposed to close.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:532-534 (createLoanOffer)
if (_collateralContract == address(0)) revert ZeroAddress();
// AUDIT R014: only governance-whitelisted staking contracts may back loans.
if (!acceptedCollateralContracts[_collateralContract]) revert CollateralNotAccepted();
// MISSING: equivalent of NFT lending's pending-removal block
```
Compare TegridyNFTLending.sol:300-305:
```solidity
if (
    pendingWhitelistRemove == _collateralContract
    && _executeAfter[WHITELIST_REMOVE] != 0
) {
    revert CollectionPendingRemoval();
}
```

**Recommendation:** Add equivalent block: refuse `createLoanOffer` when `pendingAcceptedCollateral == _collateralContract && !pendingAcceptedCollateralAdd && _executeAfter[ACCEPTED_COLLATERAL_CHANGE] != 0`.

---

## [LD-M5] Borrower can swap-in maliciously-mutated NFT position via same-block stake → acceptOffer race
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:596-673`
**Category:** other

**Bug:** `acceptOffer` reads `(positionAmount,, lockEnd,,,) = staking.getPosition(_tokenId)` at line 616, validates `positionAmount >= minPositionValue` and `lockEnd >= deadline`, then later calls `staking.transferFrom(msg.sender, address(this), _tokenId)` at line 657. There is no atomic guarantee that `positionAmount` doesn't change between these reads — but since `transferFrom` triggers `_settleRewardsOnTransfer` and not a pre-transfer position adjustment, it appears safe at first glance.

However: **a borrower can `extendLock` or `increaseAmount` via TegridyStaking IMMEDIATELY BEFORE calling `acceptOffer` in the same block** (TegridyStaking allows these as long as caller is `ownerOf`). Since the lender's offer was posted with a fixed `minPositionETHValue` floor, a borrower could rapidly inflate `positionAmount` (via increaseAmount with cheap TOWELI), pass the floor check at the inflated value, then once the loan starts and the NFT is in escrow, the borrower's previously-deposited TOWELI is locked. **At default, the lender receives the inflated position. But at repay, the borrower gets it back**.

This is not a new attack class but the protocol-side mitigation is "lender chooses risk." The audit-doc states this is acceptable. **The new finding here**: the same-block race ALSO interacts with the TWAP. If the borrower stakes 1 ETH-equivalent of TOWELI (at then-prevailing TWAP) right before accepting, the offer sees the fresh 1-ETH-equivalent value. Then borrower defaults at deadline. Lender gets the NFT but if TOWELI price has fallen 50% since loan-start, the realized collateral value is 0.5 ETH despite the floor being 1 ETH. **The TWAP read is at acceptance, not at default-claim time** — so the lender's protection against price decline is illusory.

**Attack / Impact:** Borrower stakes 100k TOWELI (~1 ETH at TWAP) immediately before `acceptOffer`. Offer's `minPositionETHValue = 1 ether` passes. Borrower receives 1 ETH principal. Defaults. Lender claims position; if TOWELI dropped 90% during loan, realized = 0.1 ETH. Lender's "ETH floor" gave false security — the floor was time-of-acceptance, not time-of-default.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:614-625
ITegridyStaking staking = ITegridyStaking(collateralContract);
(uint256 positionAmount,, uint256 lockEnd,,,) = staking.getPosition(_tokenId);
if (positionAmount < minPositionValue) revert InsufficientCollateralValue();

if (minPositionETHValue > 0) {
    uint256 ethValue = _positionETHValue(positionAmount);  // TWAP at acceptance
    if (ethValue < minPositionETHValue) revert InsufficientCollateralValue();
}
```

**Recommendation:**
- Document explicitly in lender NatSpec: "the ETH floor is enforced at acceptance, NOT at default. Lender bears price-decline risk over the loan duration."
- Optionally add a **lockEnd-time enforcement**: require `lockEnd >= deadline + LIQUIDATION_GRACE` (e.g., +7 days) so the lender can withdraw the underlying TOWELI themselves if needed.
- Or a **secondary floor check at default-claim**: `claimDefaultedCollateral` re-evaluates `_positionETHValue` and reverts if below e.g. 50% of original floor, refunding lender's principal from a backstop pool. (This is a major architectural shift — flag for design review.)

---

## [LD-M6] Same-block borrow-then-repay yields free flash loan via 1-wei-floor interest
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:683-777`, `contracts/src/TegridyNFTLending.sol:445-508`
**Category:** mev

**Bug:** Both contracts gate `repayLoan` with `if (block.timestamp == startTime) revert LoanTooRecent();` (TegridyLending:701, TegridyNFTLending:463) — same-block repay is blocked. **One block later (~12s on Ethereum mainnet)**, repay succeeds. With pro-rata interest at 12 seconds for a 1 ETH / 1000 BPS APR loan: `interest = ceil(1e18 * 1000 * 12 / (10000 * 365 * 86400)) ≈ 380 wei`. Effectively a 12-second free flash loan via NFT collateral.

The previous audit (007 §L-1) flagged this for TegridyNFTLending with an INFO/LOW severity. **What's new here**:
1. **TegridyLending also has it** (not previously flagged with this framing).
2. The `MIN_DURATION_FLOOR = 1 hours` (TegridyLending.sol:128) is admin-tunable down to 1h — making the disconnect even worse: the contract enforces a minimum LOAN DURATION but allows the borrower to exit after ~12s of paying ~380 wei, which is structurally identical to a flash loan against any single staking NFT the borrower owns.
3. **Combined with origination fee**: the lender's offer was charged origination fee at offer creation. Borrower flash-exits in 12s. Lender netted = principal − origination_fee × 0.05 × 12s/year ≈ negative net. **Lender pays the protocol 2% (max origination fee BPS) for the privilege of having their offer flash-borrowed back**.

**Attack / Impact:** Borrower with one staked NFT can exit + re-enter every minute, building a profile of borrower-side activity that lets them:
- MEV-extract via concurrent DEX trades using the principal in a 1-block sandwich.
- Grief lender by repeatedly accepting + repaying (each accept-repay cycle eats lender's offer slot for ~24s, denying real borrowers access).

While lender ultimately recovers principal + ~380 wei, the lender pays gas to handle the events. Persistent grief consumes lender's attention.

**Evidence:** Demonstrated as `test_sandwich_sameBlockManipulation_succeeds` in TegridyLending_ETHFloor.t.sol; the same primitive applies to plain repayment.

**Recommendation:** Enforce a minimum interest floor: `interest = max(calculatedInterest, principal * minInterestRateBps / BPS)` where `minInterestRateBps` is e.g. 24h-equivalent (if loan > 24h, per-day floor doesn't bite). This makes sub-day repayments uneconomical without breaking the long-loan UX. Pattern of record: most NFT lending platforms (Gondi, NFTfi) enforce a minimum payable interest of 1 day.

---

## [LD-M7] Grace-period check in `repayLoan` happens AFTER state mutation `loan.repaid = true`
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:711-719`
**Category:** other

**Bug:** Code order in `repayLoan`:
```
706: uint256 interest = calculateLoanInterest(_loanId);
707: uint256 totalRepayment = principal + interest;
708: if (msg.value < totalRepayment) revert InsufficientRepayment();
711: loan.repaid = true;                                                  // <-- state mutation
719: if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD) revert DeadlineExpired();  // <-- LATE check
```

The `revert` at line 719 will roll back state, so this is not a corruption issue. However, **CEI ordering convention is inverted**: state mutation occurs before all input validation completes. Defense-in-depth pattern says all input checks should pass before any storage write.

**Why it's still a real finding:**
1. **Subtle reentrancy surface**: Lines 712-718 are pure local-storage ops, but the `effectiveDeadline` view (line 719) reads `loans[_loanId].deadline` and `loan.pausedDurationAtStart` from storage. If a future change makes `effectiveDeadline` non-pure (e.g., an admin upgrade adds a hook), the state-then-check order could be exploited. The TegridyNFTLending sibling at line 468 has the gate BEFORE the loan.repaid mutation — direct asymmetry.
2. **Gas wasted on guaranteed-revert path**: Borrower attempting late repayment pays full gas for `calculateLoanInterest` (a non-trivial mulDiv) before the gate. Gates should be cheap-checks-first.

**Attack / Impact:** No current direct exploit. Defensive code hygiene gap. Listed as Medium because the asymmetry against NFT lending suggests a missed refactor.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:706-719
uint256 interest = calculateLoanInterest(_loanId);
uint256 totalRepayment = principal + interest;
if (msg.value < totalRepayment) revert InsufficientRepayment();

// CEI: state change before external calls
loan.repaid = true;

// SECURITY FIX: Enforce deadline + 1h grace period (AUDIT M-1).
// ...
// AUDIT R014: deadline reads `effectiveDeadline` so admin pauses extend both
// sides of the window symmetrically.
if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD) revert DeadlineExpired();
```
Compare TegridyNFTLending.sol:467-480:
```solidity
if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD) revert LoanNotDefaulted();

uint256 interest = calculateInterest(...);
uint256 totalRepayment = principal + interest;
if (msg.value < totalRepayment) revert InsufficientRepayment();

// CEI: state change before external calls
loan.repaid = true;
```

**Recommendation:** Move the `effectiveDeadline + GRACE_PERIOD` check BEFORE `loan.repaid = true`. Cheap-checks-first, mutate-after-validation. Aligns TegridyLending with TegridyNFTLending pattern.

---

## [LD-M8] Origination-fee not refunded on `cancelOffer` — silent admin tax on retracted offers
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:572-587`, `contracts/src/TegridyNFTLending.sol:345-359`
**Category:** other

**Bug:** Both contracts deduct `originationFee` from the lender's deposit at `createLoanOffer` / `createOffer` and immediately forward to treasury. When the lender later calls `cancelOffer`, the refund is `offer.principal` — the *post-fee* amount. **The origination fee is permanently lost** even though the offer was never accepted.

This was flagged as agent-006 H-006-3 with "HIGH (economic)" severity for TegridyLending, and as a long-tail item in the microscope (`cancelOffer` non-refund of origination fee — §7). Re-flagged here as Medium because:
1. **Microscope only mentioned NFT-side cancelOffer non-refund** — TegridyLending has the same bug, NOT yet remediated.
2. **Combined with admin's ability to bump originationFeeBps via 48h timelock**, a malicious admin can:
   - T0: Lender posts 100 ETH offer with `originationFeeBps = 0` (lossless).
   - T1: Admin proposes `originationFeeBps = 200` (2%).
   - T0 + 48h: Admin executes, fee now active. Pre-existing offers were charged 0 fee — fine.
   - Fresh offer at T0+48h+1s: Lender posts a 100 ETH offer, charged 2 ETH origination fee.
   - T0+48h+2s: Lender cancels. **Lender loses 2 ETH** despite the offer never matching.

The 48h timelock provides foresight, but lenders cannot reasonably monitor the timelock proposal queue continuously. The fee is effectively a non-refundable tax on offer-creation, which the contract NatSpec describes as "now every accepted offer pays a fee" (line 139) — **misleading**, since rejected/cancelled offers also pay.

**Attack / Impact:**
- Honest economic concern: lenders have a built-in cost for retracting offers, biasing them toward accepting suboptimal borrowers (including malicious ones) just to recoup origination fees.
- Adversarial admin: bump fee, wait for lenders to retract, harvest. With 1000 ETH max principal × 2% = 20 ETH per cancel.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:580-584 (cancelOffer)
offer.active = false;
uint256 refundAmount = offer.principal;        // <-- post-fee amount
WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, refundAmount);
```

**Recommendation:** Track the original `grossPrincipal` and `originationFee` in the `LoanOffer` struct. On `cancelOffer`, refund `grossPrincipal` and request origination fee back from treasury (this requires a treasury-cooperative refund — alternatively, defer the origination-fee transfer to acceptance time, holding it in the contract until then). Pattern of record: Aave's GHO discount mechanism defers fee accrual to repayment, never collects upfront.

---

## [LD-M9] `pullEscrowRewards` direct-donation drain via TOWELI griefing
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:1366-1420`
**Category:** other

**Bug:** The `pullEscrowRewards` payout uses `available = IERC20(toweli).balanceOf(address(this))` — the contract's TOWELI balance, not a tracked-deposits accumulator. Anyone can `IERC20(toweli).transfer(address(lendingContract), amount)` to pad the pool. The NatSpec (line 1355-1364) acknowledges donations are non-refundable and become public-good for current escrow holders.

**The new attack vector this enables**: A griefer who knows escrowRewardsOwed has a single small loanId (e.g., owed = 1 wei) can:
1. Transfer 1 ETH-equivalent TOWELI directly to the contract.
2. The single beneficiary gets 1 wei (because they're the only one with `owed > 0`).
3. The remaining `1 ETH - 1 wei` of TOWELI is stuck in the contract permanently (no sweep, no admin recovery — see [LD-L1]).

Equivalent: a malicious lender whose own loan defaulted can pre-load the contract with TOWELI to dilute the *next* defaulting loan's escrow share. While the contract conservatively distributes existing rewards, **direct donations cap-bound to existing owed entries**, so any mismatch (donation > sum-of-owed) creates dust that is neither claimable nor sweepable.

**Attack / Impact:** Permanent TOWELI lockup, funds drift out of supply. Not protocol-fund-loss but cumulative DoS on the staking ecosystem's TOWELI supply.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:1394-1419
uint256 available = IERC20(toweli).balanceOf(address(this));
uint256 total = totalEscrowRewardsOwed;
// ... payout calculation ...
escrowRewardsOwed[_loanId] = owed - payout;
// totalEscrowRewardsOwed -= payout
emit EscrowRewardsPaid(_loanId, recipient, owed, payout);
if (payout > 0) {
    IERC20(toweli).safeTransfer(recipient, payout);
}
```
After this call, `IERC20(toweli).balanceOf(address(this))` may exceed `totalEscrowRewardsOwed` (when donations arrived after totalEscrowRewardsOwed was decremented). The excess is unrecoverable.

**Recommendation:**
- Add an admin-callable `sweepDonatedToweli(address to)` that withdraws `IERC20(toweli).balanceOf(this) - totalEscrowRewardsOwed`. Timelocked.
- Or maintain a separate `totalEscrowedRewardsHeld` that tracks ONLY rewards arrived via `claimUnsettled`. Distribution math uses this tracked amount. Donations become trapped donations the protocol formally ignores. (Mirrors the NatSpec already.)

---

## [LD-M10] Sequencer-grace check absent on TegridyNFTLending despite identical L2 risk profile
**Severity:** Medium
**File:** `contracts/src/TegridyNFTLending.sol:1-869` (entire file)
**Category:** oracle

**Bug:** TegridyLending integrates `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` inside `_positionETHValue` (line 993) to refuse collateral valuation when the L2 sequencer is currently down or has just resumed. **TegridyNFTLending has no equivalent**. While TegridyNFTLending has no oracle (no ETH-floor check), it DOES have time-sensitive operations: `repayLoan` and `claimDefault` both gate on `effectiveDeadline + GRACE_PERIOD`.

**Attack / Impact:** During an L2 sequencer outage (e.g., Arbitrum 30-min outage 2024-01-09), `block.timestamp` continues to advance on L1 but L2 transactions cannot be submitted. When the sequencer comes back online and processes the queue, all queued txs see the post-outage `block.timestamp`. A loan that was on the brink of default at sequencer-pause time now arrives in the post-outage block with `block.timestamp >> effectiveDeadline + GRACE_PERIOD` — **the borrower's repayLoan tx and the lender's claimDefault tx are both in the queue, but only one wins based on tx ordering**.

Specifically:
- Borrower submits `repayLoan` 30s before sequencer outage. Tx queued.
- Sequencer paused for 1h. `block.timestamp` advances 1h.
- Lender submits `claimDefault` immediately upon seeing sequencer resume. Tx ordered by gas-price, may pre-empt borrower's queued tx.
- Borrower's repay reverts with `DeadlineExpired` because deadline + GRACE_PERIOD passed during outage.

The TegridyLending fix at line 993 mitigates this for the ETH-floor read but NOT for the deadline check. The bug exists symmetrically in TegridyLending too (deadline check doesn't consult sequencer), but the absence is more glaring in TegridyNFTLending because it has no Sequencer awareness at all.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol entire file: no SequencerCheck import or usage
```

**Recommendation:** Apply MICROSCOPE pattern: add `SequencerCheck.checkSequencerUp` to BOTH:
1. `repayLoan` and `claimDefault`/`claimDefaultedCollateral` deadline gates — extend `effectiveDeadline` by `SEQUENCER_GRACE_PERIOD` if the sequencer recently resumed.
2. The pause mechanism — when an L2 sequencer outage is detected, equivalent to an admin pause for deadline-extension purposes.

Alternatively, document explicitly: "L2 deployments must use a guardian script to pause the contract during sequencer outages."

---

## [LD-L1] No TOWELI sweep / rescue in TegridyLending — orphaned tokens permanently locked
**Severity:** Low
**File:** `contracts/src/TegridyLending.sol:1-1480` (entire file)
**Category:** other

**Bug:** Confirms M-L2 from MICROSCOPE_2026_04_30: TegridyLending holds TOWELI (the reward token) but has no admin-callable sweep/rescue. Combined with [LD-M9] above, any TOWELI excess (donations, dust from rounding-floor in pro-rata math, leftover from `claimUnsettled` race conditions) is permanently locked.

**Attack / Impact:** Cumulative TOWELI burn over protocol lifetime. Not a security loss but supply attrition.

**Evidence:** No `sweep*`, `rescue*`, `recoverERC20*` function in the contract. Compare to OpenZeppelin's `ERC20Recoverable` pattern.

**Recommendation:** Add admin-only timelocked `rescueToken(address token, uint256 amount, address to)` for `token != toweli`, and a more constrained `rescueExcessToweli(uint256 amount, address to)` that requires `IERC20(toweli).balanceOf(this) - totalEscrowRewardsOwed >= amount`.

---

## [LD-L2] TegridyNFTLending `executeRemoveCollection` loop-block: indefinite removal-DoS via fresh loans
**Severity:** Low
**File:** `contracts/src/TegridyNFTLending.sol:685-697`
**Category:** dos

**Bug:** `executeRemoveCollection` blocks while `activeLoansOfCollection[collection] > 0`. The proposal stays valid for `PROPOSAL_VALIDITY` (7 days) past readiness. Within those 7 days, IF active loans clear (all repaid or claimed), admin can re-execute. **However**: a malicious lender can post a NEW offer for the collection mid-window (`createOffer` is still allowed if `pendingWhitelistRemove` is set ONLY if `_executeAfter[WHITELIST_REMOVE] != 0`, which it is during the propose-execute window — so creation is blocked. Good.)

Wait — once the proposal becomes EXECUTABLE (after 24h timelock), line 80 of TimelockAdmin clears `_executeAfter[WHITELIST_REMOVE] = 0` only at execution time. Until then, `_executeAfter[WHITELIST_REMOVE]` is the ready-at timestamp, NOT zero. So `createOffer` correctly blocks new offers during the window.

The remaining loophole: **the WHITELIST_REMOVE proposal can be cancelled by admin** (line 700). After cancellation, `_executeAfter[WHITELIST_REMOVE] = 0` and `pendingWhitelistRemove = address(0)`. New offers for the (still whitelisted) collection are accepted. Admin must re-propose, restarting the 24h delay. **A coordinated attacker (admin + colluding lender) can cancel-and-repropose to perpetually keep a scam collection alive.** Less interesting since admin is the source of authority anyway, but the cancel-loop primitive is worth noting.

**Attack / Impact:** Adversarial governance pattern only. Not exploitable by non-admins.

**Recommendation:** Track a `removalRetryCount` and rate-limit cancellations to prevent loop-DoS. Or simply require that once `proposeRemoveCollection` is called, only an external timelock controller (not the same multisig that proposed) can cancel.

---

## [LD-L3] `acceptOffer` does NOT validate offer's collateralContract is still in `acceptedCollateralContracts`
**Severity:** Low
**File:** `contracts/src/TegridyLending.sol:596-673`
**Category:** other

**Bug:** TegridyLending's `acceptOffer` does not re-validate `acceptedCollateralContracts[collateralContract]` at acceptance time. Compare TegridyNFTLending.sol:385: `if (!whitelistedCollections[collateralContract]) revert CollectionNotWhitelisted();`. So if admin de-whitelists collateral type X (after 48h timelock), pre-existing offers for X can still be accepted by borrowers.

**Attack / Impact:** Already discussed in [LD-M1] as the loan-side-of-the-coin issue. Listed here as separate Low to emphasize the missing check at acceptance, separate from the missing check at offer-creation.

**Recommendation:** Add `if (!acceptedCollateralContracts[collateralContract]) revert CollateralNotAccepted();` at line 615 (after caching `collateralContract`). Mirrors NFT lending pattern.

---

## [LD-L4] `proposeMaxAprBps` allows brick of `createLoanOffer` if executed below `minAprBps`
**Severity:** Low
**File:** `contracts/src/TegridyLending.sol:1127-1133`
**Category:** other

**Bug:** Already flagged as L-006-6 in agent 006 audit. `proposeMaxAprBps` at line 1127 only checks `_new > MAX_APR_BPS_CEILING` and `_new == 0` — it does NOT check `_new >= minAprBps`. Admin can propose `maxAprBps = 100` while `minAprBps = 1000`. After execution, `createLoanOffer` reverts for any APR (`_aprBps < minAprBps` AND `_aprBps > maxAprBps` always true). **Confirmed as still alive on `main`.**

**Recommendation:** Add `if (_new < minAprBps) revert InvalidCapValue();` at line 1129. Also add the symmetric check in `proposeMinApr` (already exists at line 1312: `require(_newBps <= maxAprBps, "MIN_EXCEEDS_MAX")`) — the asymmetry is the bug.

---

## [LD-L5] `proposeMinDuration` admin-knob shrinks below minimum-loan-duration security claim
**Severity:** Low
**File:** `contracts/src/TegridyLending.sol:128, 1153-1158`
**Category:** other

**Bug:** Already flagged as M-006-3 in agent 006 audit. `MIN_DURATION_FLOOR = 1 hours` (line 128) does not match the security comment in `_positionETHValue` ("2-hour min-loan-duration bound"). With 1h floor, a borrower can lock in a TWAP-priced position, ride out 1h, and let the loan default — extracting any temporary TWAP overestimate. **Confirmed alive: line 128 still says `1 hours`.**

**Recommendation:** Raise `MIN_DURATION_FLOOR` to 4 hours minimum (1 day preferred) to match the documented security claim. Or update the doc to reflect the 1h reality.

---

## [LD-INFO1] Same-block `cancelOffer` race during pause: borrower-protective by design but undocumented for lenders
**Severity:** Info
**File:** `contracts/src/TegridyLending.sol:572-587`
**Category:** other

`cancelOffer` is not `whenNotPaused`-gated — lender can always retract. During a pause window combined with a malicious admin, the lender's "free exit" is the only side that retains liquidity (borrower can't accept, can't claim default). This is by design but undocumented in lender NatSpec. Listed for completeness; not a vulnerability per se.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 10 |
| Low | 5 |
| Info | 1 |
| **Total NEW** | **19** |

**Top-3 to fix first:**
1. **[LD-H1] + [LD-H2]** — TegridyNFTLending H10 + H11 sibling misses. The microscope's H10/H11 fixes were applied to TegridyLending only; NFT lending still has the original bugs alive. Direct port of the existing fixes.
2. **[LD-H3]** — TegridyLending.createLoanOffer missing `nonReentrant`. Single-modifier addition.
3. **[LD-M2]** — `pullEscrowRewards` order-dependency + raw multiply. Synthetix-pull pattern fix; impacts every loan settlement post-staking-pause.

**Pattern observed:** All three Highs are "half-installed mitigation" findings (microscope §4 pattern). The H10 + H11 fixes shipped only to TegridyLending; the `nonReentrant` modifier is asymmetrically applied. **Process recommendation**: every audit-fix on Lending should add a "sibling search" cross-checking TegridyNFTLending — and vice-versa — until the two contracts converge architecturally.
