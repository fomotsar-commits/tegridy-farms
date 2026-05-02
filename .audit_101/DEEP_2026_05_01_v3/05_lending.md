# Tegridy Farms — Deep Lending Audit, Pass 3 (2026-05-02)

**Targets:** `contracts/src/TegridyLending.sol` (1577 lines, post-recovery), `contracts/src/TegridyNFTLending.sol` (925 lines, post-recovery)
**Method:** Re-audit after the 11-finding recovery in commit `5769148` ("DEEP-LD v2 — Lending recovery + post-fix hardening"). Verified each advertised pass-1 + pass-2 fix actually landed; line-graphed the new struct fields and helpers; cross-checked sibling-miss closures by comparing the two contracts side-by-side; replayed the LD2-H1 sequencer-buffer scenario against the current code.

**Headline:** the recovery pulled TegridyLending out of the cluster-5 abyss (40 DEEP-LD markers vs. 0 pre-recovery, confirmed) and most pass-1 fixes are now correctly in place. **However, the recovery commit re-created the sibling-miss problem in the OPPOSITE direction**: 5 v2-pass findings advertised in the commit message either landed only on TegridyNFTLending (LD2-H2 flat floor, LD2-M3 treasuryAtCreate, LD2-H1 outage-buffer extension) or were never actually applied at all (LD2-M1 still stuck-state on cancel-rate-limit, LD2-L1/L2/L3 unchanged). And one new High emerged from the LD-M5 lockEnd hardening: borrowers with max-duration positions are now structurally locked out of max-duration loans.

---

## [LD3-H1] TegridyLending: LD2-H1 sequencer-outage-buffer extension NOT applied — borrower repay window still consumed by L2 outage
**Severity:** High
**File:** `contracts/src/TegridyLending.sol:715-818, 824-883`
**Category:** dos / oracle

**Bug:** The recovery commit applied the LD2-H1 fix (replace blocking `checkSequencerUp` on the borrower path with a `getSequencerOutageBuffer` deadline EXTENSION) to TegridyNFTLending only. **TegridyLending received nothing**:
- `repayLoan` (line 715-818): no `SequencerCheck` call of any kind, no outage-buffer addition to `effectiveDeadline + GRACE_PERIOD`.
- `claimDefaultedCollateral` (line 838): blocking `checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` only — no outage-buffer addition to the deadline check at line 851.

Net effect: during an L2 sequencer outage that consumes part of the loan's grace window, the lender is correctly blocked for `SEQUENCER_GRACE_PERIOD` post-resume, but **the borrower's repay deadline does NOT extend by the lost time**. The instant the lender's sequencer-grace expires, the borrower's deadline+GRACE_PERIOD has already passed, and `claimDefaultedCollateral` proceeds. This is the exact LD-M10 / LD2-H1 vector — closed on TegridyNFTLending, alive on TegridyLending.

**Attack / Impact:** Concrete walk-through (Arbitrum-style L2):
- Loan deadline = T. Grace ends at T+1h.
- L2 sequencer outage T-30min → T+30min (1h outage).
- Sequencer grace period elapses at T+1h30min.
- Borrower's `repayLoan` tx queued during outage processes at T+30min (resume). Deadline check: `block.timestamp (T+30min) > effectiveDeadline + GRACE_PERIOD (T+1h)` → false. Repay succeeds.
- Borrower's `repayLoan` tx queued AFTER outage at T+1h+1s. `block.timestamp (T+1h+1s) > T+1h` → true. Reverts with `DeadlineExpired`.
- Lender's `claimDefaultedCollateral` at T+1h+1s: `checkSequencerUp` reverts (within grace). At T+1h30min+1s: passes. Default claimed.
- **Borrower had 30min of usable repay window after outage. Lender effectively had unlimited time once their grace expired.**

This is the "LD2-H1 sibling miss" class — closed on NFTLending, regressed on TegridyLending. The recovery commit message claims "LD2-H1 (HIGH) ... Sequencer outage no longer eats the borrower's repay window" but only applied the fix to NFTLending.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:715-718 (repayLoan)
function repayLoan(uint256 _loanId) external payable nonReentrant {
    if (_loanId >= loans.length) revert InvalidLoanId();
    Loan storage loan = loans[_loanId];
    // ... no SequencerCheck of any kind, no getSequencerOutageBuffer

// contracts/src/TegridyLending.sol:838-851 (claimDefaultedCollateral)
SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
// ... no outage-buffer addition:
if (block.timestamp <= effectiveDeadline(_loanId) + GRACE_PERIOD) revert DeadlineNotReached();
```
Compare TegridyNFTLending.sol:467-473 / 556-562 — both `repayLoan` and `claimDefault` use `getSequencerOutageBuffer` to extend the deadline.

**Recommendation:** Mirror the NFTLending fix on both TegridyLending entrypoints:
```solidity
// In repayLoan — replace bare deadline check with outage-buffered extension.
uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(sequencerFeed, SEQUENCER_GRACE_PERIOD);
if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) revert DeadlineExpired();

// In claimDefaultedCollateral — keep the existing checkSequencerUp gate AND add the outage-buffer extension.
uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(sequencerFeed, SEQUENCER_GRACE_PERIOD);
if (block.timestamp <= effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) revert DeadlineNotReached();
```

---

## [LD3-H2] TegridyLending: LD2-H2 APR-independent flat-floor NOT applied — same-block flash-loan loophole still alive on 0% APR offers
**Severity:** High
**File:** `contracts/src/TegridyLending.sol:741-751, 1009-1024`
**Category:** mev

**Bug:** The LD2-H2 fix (APR-independent `MIN_INTEREST_PRINCIPAL_BPS = 5` flat floor that defeats the 0% APR loophole) landed on TegridyNFTLending only. **TegridyLending's repayLoan + getRepaymentAmount apply only the LD-M6 duration-based floor** (`principal * aprBps * MIN_INTEREST_DURATION / (BPS * SECONDS_PER_YEAR)`). For `aprBps == 0`, this evaluates to **zero**, leaving the same-block flash-loan vector intact.

Default `minAprBps == 0` (line 152) → 0% APR offers are creatable → flash-borrowers can pay 0 interest at block N+1 against any 0-APR offer, paying only the gas + repayment overhead. This is the exact scenario the LD2-H2 finding identified for NFTLending and the recovery committed to fixing on both contracts.

**Attack / Impact:** Identical to the LD2-H2 walkthrough but applied to TegridyLending:
1. Borrower with one staked TegridyStaking position finds any 0-APR offer.
2. `acceptOffer` at block N. Receives principal in ETH.
3. `repayLoan` at block N+1 (12s later). `interest = calculateLoanInterest = ceil(principal * 0 * 12 / SECONDS_PER_YEAR) = 0`. `minInterest = ceil(principal * 0 * 1day / (BPS * SECONDS_PER_YEAR)) = 0`. **No flat floor**. Repays principal + 0.
4. Free ~12-second flash-borrow against the principal. Stack with concurrent DEX trades for unbounded MEV.

The asymmetry vs. NFTLending makes the loophole MORE attractive on TegridyLending because TegridyLending offers `MAX_PRINCIPAL_CEILING = 100_000 ether` (line 126) versus NFTLending's hard `MAX_PRINCIPAL = 1000 ether` (NFTLending.sol:30). 100x larger flash-loan capacity, same zero cost.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:741-751 (repayLoan)
uint256 interest = calculateLoanInterest(_loanId);
uint256 elapsed = pauseAdjustedElapsed(_loanId);
if (elapsed > 0) {
    uint256 minInterest = Math.mulDiv(
        principal * aprBps,                  // <-- aprBps == 0 → numerator == 0 → minInterest == 0
        MIN_INTEREST_DURATION,
        BPS * SECONDS_PER_YEAR,
        Math.Rounding.Ceil
    );
    if (interest < minInterest) interest = minInterest;
    // MISSING: flat floor like NFTLending.sol:494-495
    //   uint256 flatFloor = (principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS;
    //   if (minInterest < flatFloor) minInterest = flatFloor;
}
```
And line 1009-1024 (`getRepaymentAmount`) has the same gap — view returns 0 interest for 0-APR loans, misleading any frontend that reads the view to estimate repayment amount.

**Recommendation:** Port the flat-floor block from NFTLending verbatim. Add `uint256 public constant MIN_INTEREST_PRINCIPAL_BPS = 5;` at the contract top (mirror line 54 of NFTLending). In both `repayLoan` and `getRepaymentAmount`, after the LD-M6 mulDiv:
```solidity
uint256 flatFloor = (principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS;
if (minInterest < flatFloor) minInterest = flatFloor;
if (interest < minInterest) interest = minInterest;
```

---

## [LD3-H3] TegridyLending: LD2-M3 treasuryAtCreate snapshot NOT applied — treasury change between create and accept silently redirects fee
**Severity:** High (originally rated Medium in pass-2 LD2-M3, escalated here because TegridyLending offers max 100k ETH principal vs NFTLending's 1k → 100× exfiltration capacity)
**File:** `contracts/src/TegridyLending.sol:259-276, 689-692`
**Category:** other

**Bug:** Pass-2 LD2-M3 introduced an `address treasuryAtCreate;` snapshot field on the NFTLending Offer struct so a treasury change between offer creation and acceptance cannot silently redirect the lender's origination fee. **TegridyLending's LoanOffer struct has no equivalent field** — the recovery added `originationFee` (LD-M8) but not `treasuryAtCreate`.

At acceptOffer (line 689-692):
```solidity
if (originationFee > 0) {
    WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, originationFee);   // <-- live treasury read
    emit OriginationFeeCollected(lender, originationFee);
}
```
Live read of `treasury` — same vector LD2-M3 closed on NFTLending.

**Attack / Impact:** Captured-admin scenario (or genuine governance-vote treasury rotation):
1. T0: Lender posts 100k ETH offer with 2% origination fee = 2000 ETH held in offer.
2. T0+12h: Admin proposes treasury change to malicious address. 48h-timelocked.
3. T0+12h+48h: Admin executes. Treasury now points to attacker.
4. T0+60h+1s: Borrower accepts the offer. The 2000 ETH origination fee flows to the attacker's treasury — the lender saw "treasury = old address" at offer creation.

Adversarial vs. the lender's contract-level expectation. Pass-2 acknowledged the same vector on NFTLending was Medium because NFTLending's MAX_PRINCIPAL = 1000 ETH caps the worst case at 20 ETH. **TegridyLending allows MAX_PRINCIPAL_CEILING = 100_000 ether and MAX_ORIGINATION_FEE_BPS = 200**, so the worst-case redirect is **2000 ETH per offer** — 100× the NFTLending blast radius. Hence the High severity escalation.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:259-276 — LoanOffer struct missing treasuryAtCreate
struct LoanOffer {
    address lender;
    uint256 principal;
    uint256 aprBps;
    uint256 duration;
    address collateralContract;
    uint256 minPositionValue;
    uint256 minPositionETHValue;
    bool active;
    uint256 originationFee;
    // MISSING: address treasuryAtCreate;
}
```
Compare TegridyNFTLending.sol:103-108 which has `address treasuryAtCreate`.

**Recommendation:** Mirror the LD2-M3 fix from NFTLending verbatim:
1. Add `address treasuryAtCreate;` to `LoanOffer` struct.
2. In `createLoanOffer`, set `treasuryAtCreate: treasury` in the struct push.
3. In `acceptOffer`, cache `feeRecipient = offer.treasuryAtCreate; if (feeRecipient == address(0)) feeRecipient = treasury;` (migration safety for legacy offers).
4. Replace the live `treasury` read at line 690 with `feeRecipient`.

---

## [LD3-M1] LD2-M1 stuck-state NOT actually fixed — cancelRemoveCollection rate-limit can permanently brick WHITELIST_REMOVE channel
**Severity:** Medium
**File:** `contracts/src/TegridyNFTLending.sol:759-773`
**Category:** dos

**Bug:** The recovery commit message claims "LD2-M1 / M2 / M3 / M4 / M5 + LD2-L1 / L2 / L3: per spec." Verified against the source: **LD2-M1 is unchanged from pass-2**. The cancel-rate-limit logic at line 766-769 is identical to what LD2-M1 flagged as the stuck-state vector:

```solidity
if (cancelled != address(0)) {
    removalRetryCount[cancelled] += 1;
    if (removalRetryCount[cancelled] > REMOVAL_MAX_CANCELLATIONS) {
        revert RemovalCancelLimitReached();
    }
}
```

When `removalRetryCount[X] == 3` and admin attempts a 4th cancel, the increment to 4 triggers `revert RemovalCancelLimitReached()` — but the revert rolls back the entire transaction including the `_cancel` (line 760). So `_executeAfter[WHITELIST_REMOVE]` stays non-zero and `pendingWhitelistRemove` stays as X. **The proposal is stuck pending until validity (7 days) expires AND simultaneously can never be re-proposed during that window** (because `_propose` reverts with `ExistingProposalPending` when `_executeAfter[key] != 0`).

After validity expires (ready + 7 days < now), `_execute` reverts with `ProposalExpired`. `_propose` STILL reverts with `ExistingProposalPending` because `_executeAfter[key]` is non-zero (only `_cancel` and `_execute` clear it).

**Attack / Impact:** Adversarial sequencing — sustained or one-shot:
1. Admin proposes removal of X, cancels 3 times across normal governance lifecycle. `removalRetryCount[X] = 3`.
2. Admin proposes removal of X again to react to a real exploit. Active loans against X persist (legitimate borrowers, 365-day terms).
3. `executeRemoveCollection` reverts (`ACTIVE_LOANS_PRESENT`).
4. `cancelRemoveCollection` reverts (counter would go to 4).
5. Proposal stays pending until validity (7 days) expires. During this window, **no proposal for ANY collection's removal can be made** because the WHITELIST_REMOVE slot is occupied.
6. After validity expires, `_propose(WHITELIST_REMOVE)` STILL reverts with `ExistingProposalPending` because `_executeAfter` was never cleared.
7. **Permanent stuck state** until all active loans naturally settle (up to 365 days each) — at which point `executeRemoveCollection` can succeed, which clears state and resets counter.

Worse: during this stuck window, the protocol is exposed to whatever vulnerability the removal was intended to close. Cross-collection griefing surface is real.

**Evidence:** Line-by-line comparison between v2 finding text and current source confirms zero changes to the affected logic. The recovery commit message lied about closing this finding.

**Recommendation:** Adopt the v2 LD2-M1 recommendation verbatim — namespace the slot per-collection so a stuck X doesn't block proposing Y:
```solidity
// Replace WHITELIST_REMOVE constant with a per-collection key generator.
function _whitelistRemoveKey(address collection) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked("WHITELIST_REMOVE", collection));
}
// All propose/execute/cancel calls now use _whitelistRemoveKey(collection).
```
And/or: increment counter only on *successful* cancel (do the increment before `_cancel`, so the over-limit revert doesn't roll back the increment itself):
```solidity
if (cancelled != address(0)) {
    if (removalRetryCount[cancelled] >= REMOVAL_MAX_CANCELLATIONS) {
        revert RemovalCancelLimitReached();
    }
    removalRetryCount[cancelled] += 1;
}
_cancel(WHITELIST_REMOVE);  // moved AFTER the gate
```
The current order means the cancel always succeeds OR always reverts — no "you've used your budget" terminal state.

---

## [LD3-M2] LD-M5 LIQUIDATION_GRACE bricks max-duration loans — borrowers with `lockEnd == stake_start + MAX_LOCK` cannot take MAX_DURATION loans
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:207, 652-656`
**Category:** other

**Bug:** The LD-M5 fix raises the lockEnd requirement from `lockEnd >= deadline` to `lockEnd >= deadline + LIQUIDATION_GRACE` where `LIQUIDATION_GRACE = 7 days`. This is structurally incompatible with TegridyStaking's max-lock semantics:

- `MAX_DURATION` (admin-tunable, ceiling 3650 days) defines the longest possible loan duration.
- A borrower wanting a max-duration loan needs `lockEnd >= block.timestamp + MAX_DURATION + 7 days`.
- TegridyStaking's typical max-lock is 4 years (1460 days). A borrower who staked at exactly `lockDuration = 365 days` cannot take a 365-day loan: `lockEnd = stake_start + 365d`, so `lockEnd - deadline = stake_start + 365d - (now + 365d) = stake_start - now ≤ 0` (assuming `now > stake_start`). Even if borrower stakes RIGHT NOW for 365 days and immediately accepts a 365-day loan, `lockEnd = now + 365d` and `deadline + 7d = now + 365d + 7d`, so `lockEnd < deadline + 7d` → revert.

**Attack / Impact:** Many existing borrowers' stake positions become unusable as collateral for medium-to-long loans. This is a deployment-time UX cliff: any borrower with `lockEnd - now < 7 days + intended_loan_duration` is locked out. Pre-existing positions staked at exactly `lockDuration = loan_duration` (a natural choice) all break.

The 7-day buffer is intended for the LIQUIDATION_GRACE pattern (lender claims default → has 7 days to withdraw underlying) but the implementation imposes the buffer on EVERY loan, not just defaulted loans. A borrower who fully repays on time receives the NFT back — the 7-day buffer was never used. So the cost (bricked offers) is paid by every loan, the benefit (lender recovery window) is realized only on defaults.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:652-656
uint256 deadline = block.timestamp + duration;
if (lockEnd == 0 || lockEnd < deadline + LIQUIDATION_GRACE) {
    revert LockExpiresBeforeDeadline();
}
```
And `MAX_DURATION_CEILING = 3650 days` at line 131 means the worst-case requirement is `lockEnd >= now + 3657 days = ~10 years + 7 days`. Meanwhile staking positions cap at finite values.

**Recommendation:** Two non-conflicting options:
1. **Option A — Per-offer flag:** Let lenders opt in/out of LIQUIDATION_GRACE enforcement on each offer (`bool requireLiquidationGrace`). Lenders who want the cushion accept a smaller borrower pool; lenders willing to skip it widen their match surface.
2. **Option B — Smaller fixed buffer:** Reduce `LIQUIDATION_GRACE` to 1 day or 2 days. The original LD-M5 spec said "+7 days" as an example, not a hard requirement. Match the existing `GRACE_PERIOD = 1 hour` philosophy of "small but non-zero cushion."
3. **Option C — Conditional check:** Only require the buffer when the position's underlying TOWELI is non-trivial (e.g., `positionAmount > minPositionETHValue * 1.5x`) — matching the lender-protection intent without bricking dust positions.

Document the trade-off explicitly in lender NatSpec regardless of which fix lands.

---

## [LD3-M3] TegridyLending: LD-L2 cancel-rate-limit on collateral whitelist NOT ported — captured-admin can loop cancel-and-re-propose
**Severity:** Medium (Low if admin model is fully trusted)
**File:** `contracts/src/TegridyLending.sol:1568-1572`
**Category:** other

**Bug:** TegridyNFTLending received the LD-L2 cancel-rate-limit fix (`removalRetryCount[collection]` + `REMOVAL_MAX_CANCELLATIONS = 3`) on `cancelRemoveCollection`. **TegridyLending's `cancelAcceptedCollateral` has no equivalent** — there is no rate limit, no counter, no defense against the cancel-and-re-propose loop that LD-L2 was designed to close.

**Attack / Impact:** Captured-admin or coerced-admin sequencing:
1. Compromised admin wants to keep a flagged-as-malicious staking contract on the whitelist forever.
2. Honest co-signers / monitoring catches the malicious staking → forces a removal proposal.
3. Compromised admin cancels the proposal before it executes.
4. Loop steps 2-3 indefinitely. Removal never lands.

The defense exists for NFTLending (REMOVAL_MAX_CANCELLATIONS = 3) but not here — TegridyLending's collateral whitelist is governance-bypassable in the same way the original NFTLending was pre-LD-L2.

While the bug requires admin compromise (which is itself a breaking event), the LD-L2 framing was specifically about hardening against the cancel-loop variant of admin abuse. The asymmetry leaves one half of the lending cluster covered, the other half exposed.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:1568-1572 — no rate-limit
function cancelAcceptedCollateral() external onlyOwner {
    _cancel(ACCEPTED_COLLATERAL_CHANGE);
    pendingAcceptedCollateral = address(0);
    pendingAcceptedCollateralAdd = false;
}
```
Compare TegridyNFTLending.sol:759-773 which has the counter logic.

**Recommendation:** Port the LD-L2 fix (with the LD3-M1 stuck-state correction baked in — increment-before-cancel-before-revert order):
```solidity
mapping(address => uint256) public collateralRemovalRetryCount;
uint256 public constant COLLATERAL_REMOVAL_MAX_CANCELLATIONS = 3;

function cancelAcceptedCollateral() external onlyOwner {
    address cancelled = pendingAcceptedCollateral;
    bool wasRemoval = !pendingAcceptedCollateralAdd;
    if (wasRemoval && cancelled != address(0)) {
        if (collateralRemovalRetryCount[cancelled] >= COLLATERAL_REMOVAL_MAX_CANCELLATIONS) {
            revert RemovalCancelLimitReached();
        }
        collateralRemovalRetryCount[cancelled] += 1;
    }
    _cancel(ACCEPTED_COLLATERAL_CHANGE);
    pendingAcceptedCollateral = address(0);
    pendingAcceptedCollateralAdd = false;
}

// In executeAcceptedCollateral after acceptedCollateralContracts[collateral] = add:
if (!add) collateralRemovalRetryCount[collateral] = 0;
```

---

## [LD3-M4] LD2-L1/L2/L3 advertised "per spec" but NOT applied to NFTLending
**Severity:** Medium (process / bag-of-Lows)
**File:** `contracts/src/TegridyNFTLending.sol:303 (L1), 645-647 + 866-868 (L2), 126 (L3)`
**Category:** other / regression

**Bug:** Recovery commit message: "LD2-M1 / M2 / M3 / M4 / M5 + LD2-L1 / L2 / L3: per spec." Verified line-by-line:
- **LD2-L1** (live-rate origination fee at acceptOffer): **NOT applied**. Line 303 still computes `originationFee = (msg.value * originationFeeBps) / BPS` at create time and stores on the struct. The acceptOffer path (line 416) forwards the snapshotted fee, not a re-computed live-rate fee.
- **LD2-L2** (revert on `pausedDurationAtStart > totalPausedDuration` invariant violation instead of silent zero-return): **NOT applied**. Lines 645-647 (`pauseAdjustedElapsed`) and 866-868 (`effectiveDeadline`) still use `totalPausedDuration > loan.pausedDurationAtStart ? ... : 0` ternary that fail-silently. No `error PauseInvariantViolated` exists.
- **LD2-L3** (Loan struct gas-pack `pausedDurationAtStart` into uint64 / move next to bools): **NOT applied**. Line 126 still declares `uint256 pausedDurationAtStart` after the bools, wasting one storage slot per loan. ~20k extra gas per loan creation.

None individually critical, but the cumulative pattern of "advertised then absent" matches exactly the cluster-5 commit-vs-code divergence that pass-2 flagged as Critical.

**Attack / Impact:**
- LD2-L1: lenders pay yesterday's rate after a fee cut, harming UX fairness.
- LD2-L2: storage-corruption attack would degrade silently rather than fail-loud, complicating forensics.
- LD2-L3: gas waste — ~20k per loan creation, ~5k per loan read. At 1000 loans/year + 30 gwei → ~0.6 ETH/year burned.

**Evidence:** Line-numbered above. Each finding's referenced source matches the v2-pass evidence verbatim.

**Recommendation:** Either apply the three Lows per the v2 spec, OR amend the recovery commit retrospectively to drop the false claim. Preferred: ship the actual fixes — they are small, isolated, and well-specified in pass-2.

---

## [LD3-M5] TegridyLending.executeAcceptedCollateral / NFTLending.executeRemoveCollection: stuck-loan can permanently lock the propose slot (validity expires + non-zero `_executeAfter`)
**Severity:** Medium
**File:** `contracts/src/TegridyLending.sol:1554-1566`, `contracts/src/TegridyNFTLending.sol:737-752`
**Category:** dos

**Bug:** Both contracts now reject removal execution when active loans exist for the targeted collateral / collection. The active-loan check happens AFTER `_execute` clears `_executeAfter[key] = 0` (line 136 of TimelockAdmin), so the entire revert rolls back ALL state including the proposal-clearing.

Result: the proposal stays pending. Validity window keeps ticking. If the active loans don't settle within `(readyAt + 7 days) - now` seconds, the proposal expires (`_execute` reverts with `ProposalExpired`). Once expired:
- `_execute` permanently reverts.
- `_propose(KEY)` reverts because `_executeAfter[KEY] != 0` (`ExistingProposalPending`).
- **The only way out is `_cancel(KEY)`, but in the NFTLending case that runs into the LD3-M1 cancel-rate-limit if exhausted.**

For TegridyLending (no rate-limit on cancel), at least admin can cancel and re-propose. For NFTLending with `removalRetryCount[X] = 3`, the proposal is doubly stuck.

**Attack / Impact:** Same blast radius as LD3-M1 but reachable WITHOUT the rate-limit ceiling — just need active loans to persist through the 7-day post-ready validity window. With 365-day max loan duration, the window is overwhelmingly likely to stay populated.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:1554-1561
function executeAcceptedCollateral() external onlyOwner {
    _execute(ACCEPTED_COLLATERAL_CHANGE);          // <-- clears _executeAfter to 0
    address collateral = pendingAcceptedCollateral;
    bool add = pendingAcceptedCollateralAdd;
    if (!add && activeLoansAgainstCollateral[collateral] > 0) {
        revert("ACTIVE_LOANS_PRESENT");            // <-- rolls back the clear
    }
    ...
}
```

**Recommendation:** Restructure `executeAcceptedCollateral` / `executeRemoveCollection` so the active-loan check happens BEFORE `_execute`:
```solidity
function executeAcceptedCollateral() external onlyOwner {
    address collateral = pendingAcceptedCollateral;
    bool add = pendingAcceptedCollateralAdd;
    // Pre-flight check — gate before consuming the proposal.
    if (!add && activeLoansAgainstCollateral[collateral] > 0) {
        revert("ACTIVE_LOANS_PRESENT");   // proposal stays pending, validity ticks
    }
    _execute(ACCEPTED_COLLATERAL_CHANGE);  // now consume the proposal
    acceptedCollateralContracts[collateral] = add;
    pendingAcceptedCollateral = address(0);
    pendingAcceptedCollateralAdd = false;
    emit AcceptedCollateralChanged(collateral, add);
}
```
Same shape on NFTLending.executeRemoveCollection. This doesn't fix the underlying "what if loans never settle" UX problem (admin still must wait for loans to finish), but it removes the additional "and validity window expires while you're trying" landmine — admin can now successfully execute the moment loans clear, anytime within the 7-day window from when readiness was reached.

Even better: add a typed error `error ActiveLoansPresent(address collateral, uint256 count)` so the revert is searchable and the count is exposed for off-chain monitoring.

---

## [LD3-L1] TegridyLending.getOffer + getLoan view do NOT expose new struct fields — UI integrators see truncated state
**Severity:** Low
**File:** `contracts/src/TegridyLending.sol:897-919, 933-948`
**Category:** other

**Bug:** The recovery commit added `originationFee` to `LoanOffer` and `pausedDurationAtStart` to `Loan`. **The typed view functions `getOffer` and `getLoan` were not updated** to expose them:
- `getOffer` (line 897-919) returns 8 tuple elements — the original 7 fields plus `active`. Missing: `originationFee`.
- `getLoan` (line 933-948) returns 10 tuple elements. Missing: `pausedDurationAtStart`.

Off-chain integrators (frontend, indexers, automation bots) reading via the typed views see truncated state and cannot reconcile:
- The lender's actual deposit (`principal + originationFee`, refundable on cancel) vs. the view-returned `principal` (effective amount post-fee).
- The loan's effective deadline computation, which depends on `pausedDurationAtStart`.

The auto-generated Solidity getter for `loans(uint256)` and `offers(uint256)` *does* expose all fields (because public arrays generate full tuple getters), but most ABIs and TypeScript bindings are wired to the explicit `getOffer`/`getLoan` views.

**Attack / Impact:** No security loss. Pure transparency / reconciliation gap. Frontend bugs likely.

**Evidence:** Line-by-line comparison of struct definitions vs. view return tuples — fields explicitly listed in the recovery diff but absent from the explicit views.

**Recommendation:** Extend the typed views to return all struct fields. Aligns the contract's "explicit-is-better" view surface with its actual stored state. Backward-compatible expansion (Solidity allows adding tuple elements at the end).

---

## [LD3-L2] TegridyLending.executeAcceptedCollateral uses `revert("ACTIVE_LOANS_PRESENT")` string instead of typed error
**Severity:** Low
**File:** `contracts/src/TegridyLending.sol:1559-1561`, `contracts/src/TegridyNFTLending.sol:741-743`
**Category:** other

**Bug:** Both `executeAcceptedCollateral` (TegridyLending) and `executeRemoveCollection` (NFTLending) revert with `revert("ACTIVE_LOANS_PRESENT")` — a Solidity string revert. Every other revert in the same file uses typed errors (`error CollateralNotAccepted();`, `error InvalidLoanId();`, etc.).

Off-chain monitoring relies on typed error selectors (`bytes4`) to identify revert causes. The string-revert form generates a Panic-like error data prefix (`Error(string)` selector + ABI-encoded string) that is harder to filter on, takes more gas to emit, and inflates the contract bytecode by the full string literal.

**Attack / Impact:** Gas waste (~50 bytes of bytecode per occurrence, ~50 gas at revert site). Operational overhead in tooling.

**Recommendation:** Replace with a typed error. Suggested:
```solidity
error ActiveLoansPresent(address collateral, uint256 count);

// In the function:
if (!add && activeLoansAgainstCollateral[collateral] > 0) {
    revert ActiveLoansPresent(collateral, activeLoansAgainstCollateral[collateral]);
}
```
Same change on NFTLending.executeRemoveCollection.

---

## [LD3-INFO1] LD-M5 LIQUIDATION_GRACE is unused in claimDefaultedCollateral — buffer is enforced at acceptance only
**Severity:** Info
**File:** `contracts/src/TegridyLending.sol:207, 824-883`
**Category:** other

The `LIQUIDATION_GRACE = 7 days` constant is referenced exactly once: `acceptOffer` line 654 (`lockEnd < deadline + LIQUIDATION_GRACE`). The lender's `claimDefaultedCollateral` does NOT check that `lockEnd >= block.timestamp + LIQUIDATION_GRACE` at claim time — by then `lockEnd` may have passed (or be very close). The buffer is enforced at acceptance to ensure the lender has at LEAST 7 days post-deadline to use the collateral, but never re-validated. The lender's actual usable window is `lockEnd - block.timestamp_at_claim`, which can be anywhere from `7 days - GRACE_PERIOD` (immediate claim at deadline+grace) down to `0+` (lender claims at the last moment of lockEnd). This is fine in design but undocumented in NatSpec — explicitly noting "the 7d buffer is between deadline and lockEnd, not between claim time and lockEnd" prevents lender misunderstanding.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 5 |
| Low | 2 |
| Info | 1 |
| **Total NEW** | **11** |

**Top-3 to fix first:**
1. **[LD3-H1]** + **[LD3-H2]** + **[LD3-H3]** — Port the LD2-H1 (sequencer outage buffer), LD2-H2 (flat floor), and LD2-M3 (treasuryAtCreate snapshot) fixes from TegridyNFTLending to TegridyLending. All three are direct sibling-miss closures; the recovery commit advertised the fixes broadly but applied them only to NFTLending. The 100× principal-ceiling differential makes TegridyLending the higher-leverage attack surface for both LD3-H2 and LD3-H3, justifying the High severity for what would be Mediums on NFTLending.
2. **[LD3-M1]** — Fix the LD2-M1 cancel-rate-limit stuck-state for real this time. Commit-message claimed "per spec" but source is unchanged. Combine with LD3-M5 (pre-flight active-loan gate) to close both the rate-limit lockout and the validity-window-expires lockout in one pass.
3. **[LD3-M2]** — Re-tune `LIQUIDATION_GRACE` (or make per-offer-optional). The current 7-day buffer structurally locks out borrowers with `lockEnd == stake_start + max_lock_duration` from max-duration loans, an unintended UX cliff.

**Pattern observed (third pass in a row):** the cluster has converged on a stable architectural divergence between TegridyLending and TegridyNFTLending. Each remediation cycle picks ONE side to fix, leaves the sibling missing the same fix, and then the next cycle catches it as a new finding. Pass-1 found "TegridyLending fixed, NFTLending missed" (3 highs). Pass-2 found "NFTLending got the new fixes, TegridyLending missed all 11" (1 critical + sibling-miss inversion). Pass-3 finds "TegridyLending mostly recovered, but NFTLending's v2 fixes (LD2-H1/H2/M3) didn't get back-ported, AND the v2 commit message lied about LD2-M1/L1/L2/L3" (3 highs + bag of mediums and lows).

The structural fix is a shared `TegridyLendingCore` abstract base contract holding `pauseAdjustedElapsed`, `calculateLoanInterest`, `effectiveDeadline`, `MIN_INTEREST_DURATION`, `MIN_INTEREST_PRINCIPAL_BPS`, the active-loan-counter pattern, and the LD2-H1 outage-buffer-extended-deadline helper. Until that refactor lands, every audit cycle will continue to surface fresh sibling-miss findings — the underlying primitive (two sister contracts evolving in parallel) guarantees regression.
