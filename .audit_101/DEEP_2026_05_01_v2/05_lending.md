# Tegridy Farms — Deep Lending Audit, Pass 2 (2026-05-01)

**Targets:** `contracts/src/TegridyLending.sol` (1428 lines, post-fix), `contracts/src/TegridyNFTLending.sol` (861 lines, post-fix)
**Method:** Re-audit after the ostensibly 19-finding remediation in commit `037da95`. Verified each pass-1 fix actually landed; line-graphed the Loan/Offer struct deltas; replayed the regression hot-spot scenarios called out in the brief; searched for new gaps the fix-pattern itself introduced.

**Headline:** the commit is **massively under-applied to TegridyLending**. The commit message claims fixes for LD-H3, LD-M2, M3, M6, M7, M8, M9, L1, L3, L4, L5 in TegridyLending. The actual diff against TegridyLending is **9 lines** — only DEEP-LIB-H3 (SequencerCheck on `claimDefaultedCollateral`) landed. **Eleven advertised TegridyLending fixes are absent from the source**. TegridyNFTLending received the bulk of the work and is in much better shape, though three new gaps appeared from the fix pattern itself.

---

## [LD2-C1] TegridyLending: 11 advertised pass-1 fixes are NOT in the source despite commit message
**Severity:** Critical (process / supply-chain integrity)
**File:** `contracts/src/TegridyLending.sol` (whole file)
**Category:** other / regression

**Bug:** `git show 037da95 -- contracts/src/TegridyLending.sol` shows **a single 9-line additive hunk** at line 780 (`SequencerCheck.checkSequencerUp` inside `claimDefaultedCollateral`). Every other fix the commit message claims for TegridyLending is **silently absent** from the working tree:

| Pass-1 finding | Claimed by commit | Actually applied? | Evidence |
|---|---|---|---|
| LD-H3 (createLoanOffer nonReentrant) | "TegridyLending.createLoanOffer gains nonReentrant" | **NO** | line 514: `external payable whenNotPaused returns ...` — modifier still missing |
| LD-M2 (pullEscrowRewards Math.mulDiv) | "switches to Math.mulDiv (overflow-safe)" | **NO** | line 1350: `payout = (owed * available) / total;` raw multiply intact |
| LD-M3 (isDefaulted view + grace) | "view now mirrors claim-path semantics" | **NO** (NFTLending only) | line 940: `block.timestamp > l.deadline` (no effectiveDeadline, no GRACE) |
| LD-M6 (minimum interest floor) | "minimum interest floor (24h-equivalent)" | **NO** (NFTLending only) | `MIN_INTEREST_DURATION` symbol does not exist in TegridyLending |
| LD-M7 (deadline check before mutation) | "TegridyLending.repayLoan deadline check moved BEFORE loan.repaid" | **NO** | lines 704 / 712: `loan.repaid = true` is STILL on line 704; the `effectiveDeadline + GRACE_PERIOD` check is STILL on line 712 (after the mutation) |
| LD-M8 (origination fee held until accept) | "origination fee held until acceptOffer (refundable on cancel)" | **NO** (NFTLending only) | line 535: `WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, originationFee)` STILL inside `createLoanOffer`; LoanOffer struct has no `originationFee` field |
| LD-M9 (sweepDonatedToweli) | "admin-only timelocked sweepDonatedToweli with reservation guard" | **NO** | symbol `sweepDonatedToweli` does not exist in TegridyLending |
| LD-M10 (SequencerCheck on repayLoan) | "applied here for symmetry" | **NO** (only NFTLending got it on repayLoan) | TegridyLending.repayLoan has no SequencerCheck call |
| LD-M1 (executeAcceptedCollateral active-loan gate) | "Lows: ... acceptOffer re-validates whitelist" | **NO** | line 1409-1417: still no `activeLoansAgainstCollateral` mapping; admin can de-whitelist mid-loan |
| LD-L3 (acceptOffer re-validates whitelist) | "acceptOffer re-validates whitelist" | **NO** | line 608: `ITegridyStaking staking = ITegridyStaking(collateralContract)` still no `if (!acceptedCollateralContracts[collateralContract]) revert ...` |
| LD-L4 (proposeMaxAprBps min-cap symmetric guard) | "proposeMaxAprBps min-cap symmetric guard" | **NO** | line 1106-1112: still only checks `_new > MAX_APR_BPS_CEILING` and `_new == 0` |
| LD-L5 (MIN_DURATION_FLOOR raised to 4h) | "MIN_DURATION_FLOOR raised to 4 hours" | **NO** | line 128: `uint256 public constant MIN_DURATION_FLOOR = 1 hours;` |

**Attack / Impact:** The commit message advertises a fully-remediated state that does not exist on disk. Anyone reading `git log` (auditors, integrators, deployers, the multisig signers reviewing the patch before signing the proposal that ships it) will believe the cluster is hardened. **Production deployment of this commit ships with the original pass-1 vulnerabilities intact** — H3 (createLoanOffer reentrancy gap), M2 (escrow-rewards order-dependency + overflow surface), M3 (mismatched isDefaulted view), M6 (12-second free flash loan via lender's offer), M7 (state-then-validate ordering), M8 (origination-fee silent tax on cancel), M9 (TOWELI lockup on direct donation), M10 (sequencer-asymmetric repay window), plus the four Lows.

**Evidence:** Compare commit message §"Mediums (highlights)" with `git show 037da95 -- contracts/src/TegridyLending.sol` — the diff is a SINGLE 9-line addition. Compare `wc -l contracts/src/TegridyLending.sol` (1428) versus the pass-1 baseline (1480) — the file got SHORTER by 52 lines (likely from an unrelated earlier commit), with no LD-* additions visible.

**Recommendation:** This is a **release-blocking** issue. Either:
1. Re-apply every advertised TegridyLending fix in a follow-up commit (this is the obvious recovery path), OR
2. Edit the original commit message to accurately reflect the single fix that landed and re-issue the under-application as 11 separate commits so the multisig can review them individually.

Until one of those happens, treat this commit as "DEEP-LIB-H3 (TegridyLending) + the entire DEEP-LD cluster (NFTLending only)". The "sibling-miss closures" framing in the commit message is the opposite of the truth — the commit *introduced new sibling misses* by porting fixes to NFTLending without applying them to TegridyLending.

---

## [LD2-H1] TegridyNFTLending.repayLoan: SequencerCheck blocks borrower repay window without compensating effectiveDeadline extension
**Severity:** High
**File:** `contracts/src/TegridyNFTLending.sol:435-440`
**Category:** dos / oracle

**Bug:** Pass-1 fix LD-M10 added `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` to **both** `repayLoan` (line 437) AND `claimDefault` (line 498). On `claimDefault` the gate is correct (mirror of TegridyLending.claimDefaultedCollateral) — the lender waits the post-resume grace window so the chain can catch up.

On `repayLoan` the gate is **wrong direction**: it blocks the borrower's only path to settle the loan during the SEQUENCER_GRACE_PERIOD (1h) post-resume, but `effectiveDeadline` does NOT extend by the same SEQUENCER_GRACE_PERIOD. Net result: the borrower's usable repay window can be entirely consumed by the sequencer outage + post-resume grace, with no compensating extension.

**Attack / Impact:** Concrete walk-through:
- Loan accepted at T=0 with `duration=30 days`. `deadline = T+30d`. `effectiveDeadline = deadline` (no pauses).
- L2 sequencer goes down at T+30d - 30min. block.timestamp continues advancing on L1.
- Sequencer resumes at T+30d + 30min (1h outage). The borrower's queued `repayLoan` tx is processed — and reverts via `SequencerGracePeriodNotOver`.
- During SEQUENCER_GRACE_PERIOD (1h after resume): `block.timestamp` is in [T+30d+30min, T+30d+90min]. `effectiveDeadline + GRACE_PERIOD = T+30d+1h`.
- For 30 minutes (T+30d+30min → T+30d+1h) the borrower's `repayLoan` reverts with `SequencerGracePeriodNotOver`.
- At T+30d+1h: `block.timestamp > effectiveDeadline + GRACE_PERIOD` → `repayLoan` now reverts with `LoanNotDefaulted`.
- After SEQUENCER_GRACE clears at T+30d+90min: `claimDefault` succeeds for the lender.
- **Borrower has zero usable repay time.** This is exactly the H-LIB-H3 scenario the symmetric SequencerCheck was supposed to close — the closure is one-sided.

Compare TegridyLending: it does NOT have SequencerCheck on `repayLoan`. So in TegridyLending, sequencer outage blocks `claimDefaultedCollateral` (good — lender waits grace) but NOT `repayLoan` (good — borrower can settle the moment sequencer resumes). NFTLending's symmetry is the regression.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:435-440
// AUDIT FIX: DEEP-LD-M10 — sequencer-grace check protects the repay
// path during L2 sequencer recovery. address(0) feed = no-op.
SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);  // <-- WRONG direction

// Existing CEI ordering — gate-first, mutate-after.
if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD) revert LoanNotDefaulted();
```
The commit message admits the asymmetry — "Cluster 10 owns the sister addition to claimDefault — only the repay path is added here" — but then proceeds to add the gate to the WRONG path.

**Recommendation:** Remove the SequencerCheck from `repayLoan` entirely OR replace it with a deadline EXTENSION using `SequencerCheck.getSequencerOutageBuffer(sequencerFeed, SEQUENCER_GRACE_PERIOD)` added to `effectiveDeadline + GRACE_PERIOD`. The library already exposes `getSequencerOutageBuffer` (line 204 of SequencerCheck.sol) precisely for this "extend the deadline" use case — that is the correct primitive for the borrower side.

```solidity
// Suggested replacement at NFTLending.sol:437-440
uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(sequencerFeed, SEQUENCER_GRACE_PERIOD);
if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) revert LoanNotDefaulted();
```
The same outageBuffer must then be added to the `claimDefault` gate (line 505) so both sides see the extended deadline symmetrically.

---

## [LD2-H2] TegridyNFTLending.repayLoan + LD-M6 floor: same-block flash loan still possible when minAprBps == 0
**Severity:** High
**File:** `contracts/src/TegridyNFTLending.sol:445-453`
**Category:** mev

**Bug:** The LD-M6 minimum-interest floor is computed as `Math.mulDiv(principal * aprBps, MIN_INTEREST_DURATION, BPS * SECONDS_PER_YEAR, Ceil)` (line 447-452). When `aprBps == 0`, the floor evaluates to **zero** — `principal * 0 == 0`. The same-block defense reverts to just the `block.timestamp == startTime` gate (line 433), which is bypassed by waiting one block (~12s on Ethereum, ~250ms on Optimism).

By default `minAprBps == 0` (line 67), so 0% APR offers are creatable. A lender willing to post a 0% APR offer has no fee floor against flash-borrowers. The LD-M6 "fix" closes the vector ONLY for the subset of offers where the lender chose APR > 0.

**Attack / Impact:** Borrower with one whitelisted ERC-721 (e.g., a JBAC NFT) finds any 0% APR offer matching their NFT. Accepts at block N. Repays at block N+1 paying 0 interest (floor = 0 + raw interest = 0). Free 12-second flash-borrow against the principal, with the NFT serving only as anti-Sybil collateral. Combine with a sandwich of an oracle-adjacent trade in the same flash window for unbounded MEV.

Severity is High (not Medium) because (a) the original LD-M6 finding was Medium with the explicit assumption that the floor closed it, (b) this loophole is not just *theoretical* — anyone can create 0% offers under the default config, and (c) the rest of the flash-loan-ecosystem will arbitrage these offers within blocks of deployment.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:445-453
uint256 interest = calculateLoanInterest(_loanId);
uint256 minInterest = Math.mulDiv(
    principal * aprBps,                // <-- if aprBps == 0, numerator == 0, floor == 0
    MIN_INTEREST_DURATION,
    BPS * SECONDS_PER_YEAR,
    Math.Rounding.Ceil
);
if (interest < minInterest) interest = minInterest;
```

**Recommendation:** Either (a) make `minAprBps > 0` mandatory at construction (deploy with sane non-zero default like 50 bps) AND in `proposeMinApr` enforce `_newBps > 0`, OR (b) make the floor a flat principal-percentage rather than APR-relative: `minInterest = max(MIN_INTEREST_PRINCIPAL_BPS * principal / BPS, calculated)` with `MIN_INTEREST_PRINCIPAL_BPS = 5` (0.05% = 5 bps). The latter closes the loophole regardless of APR config.

---

## [LD2-M1] TegridyNFTLending.cancelRemoveCollection: rate-limit can permanently brick the WHITELIST_REMOVE channel for a collection
**Severity:** Medium
**File:** `contracts/src/TegridyNFTLending.sol:695-709`
**Category:** dos

**Bug:** The LD-L2 fix introduces `removalRetryCount[collection]` and reverts cancellation with `RemovalCancelLimitReached` once the count exceeds `REMOVAL_MAX_CANCELLATIONS = 3`. The counter is reset to 0 only inside `executeRemoveCollection` (line 685). Once the limit is hit, the only way to clear the counter is to **successfully execute** a removal — which itself reverts (`ACTIVE_LOANS_PRESENT`) when there are active loans against the collection.

**Attack / Impact:** Adversarial sequencing scenario where a captured-or-coerced admin first burns the cancel budget on legitimate-looking proposals, then a permanent-DoS vulnerability is discovered in collection X mid-loan-cycle:
1. Admin proposes removal of X → discovers external complication → cancels (count = 1).
2. Repeat (count = 2, 3).
3. Ten loans against X are accepted between proposals (createOffer is only blocked DURING a pending proposal, not between proposals).
4. Admin proposes removal of X to react to a new exploit. Cannot cancel (count would go to 4 → revert). Cannot execute (active loans block executeRemoveCollection). **The proposal is stuck in pending state until all 10 loans naturally settle** (up to 365 days each).
5. Worse: during this stuck-pending window, `createOffer` still works for OTHER collections, but `_executeAfter[WHITELIST_REMOVE]` is non-zero — meaning if the admin wants to remove a *different* collection Y in the meantime, they cannot (the WHITELIST_REMOVE slot is occupied). **Cross-collection griefing**: locking the removal channel for the entire whitelist for a year.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:695-706
function cancelRemoveCollection() external onlyOwner {
    _cancel(WHITELIST_REMOVE);
    address cancelled = pendingWhitelistRemove;
    pendingWhitelistRemove = address(0);
    if (cancelled != address(0)) {
        removalRetryCount[cancelled] += 1;
        if (removalRetryCount[cancelled] > REMOVAL_MAX_CANCELLATIONS) {
            revert RemovalCancelLimitReached();
        }
    }
    emit CollectionRemovalCancelled(cancelled);
}
```
The check `> REMOVAL_MAX_CANCELLATIONS` after incrementing means after 3 successful cancels, the 4th attempt reverts entirely (rolling back the cancel itself). The proposal stays pending. Combined with the active-loan execution gate, this creates the stuck state.

**Recommendation:**
- Add a time-decay to the counter: reset to 0 if no `cancelRemoveCollection` was called for the collection in the past `WHITELIST_TIMELOCK * 4` (~96h). This preserves the spam defense without permanent lockout.
- Or, more simply: require `executeRemoveCollection` to succeed before counter increments past 0, and on the over-limit revert, allow override via a second governance call (e.g., `forceClearRemovalCounter(collection)` with a separate timelock).
- Also: track the WHITELIST_REMOVE slot per-collection so a stuck proposal for X doesn't block proposing removal of Y. Use `_propose(keccak256(abi.encodePacked(WHITELIST_REMOVE, _collection)), WHITELIST_TIMELOCK)` to namespace the timelock per-collection.

---

## [LD2-M2] TegridyNFTLending.repayLoan during long pause: minimum-interest floor punishes good-faith borrower
**Severity:** Medium
**File:** `contracts/src/TegridyNFTLending.sol:441-453`
**Category:** other

**Bug:** Pass-1 fix LD-H1 made `calculateLoanInterest` return zero when the loan was 100% paused since start (`pauseAdjustedElapsed >= raw → 0`). Pass-1 fix LD-M6 then floors `interest` at one-day-equivalent. **Combined**, a borrower repaying during a long pause is charged the full floor even though the protocol-paused window was the entire period of the loan and the borrower had no opportunity to use the principal productively (or perhaps couldn't, depending on which DEXes are paused).

Concrete scenario:
- T=0: borrower accepts 30-day loan, 1 ETH principal, 10% APR. principal sent.
- T=0+1s: contract paused (admin discovers a hot exploit elsewhere).
- T=10 days: contract still paused. Borrower wants to return principal early to free the NFT collateral and de-risk.
- `repayLoan` succeeds (no `whenNotPaused`). `pauseAdjustedElapsed = 0` (entire elapsed time was paused). `interest = 0`. **Floor activates: minInterest = ceil(1e18 * 1000 * 1d / (10000 * 365d)) ≈ 274 microether**.
- Borrower pays principal + 0.000274 ETH despite the loan being 100% pause-time.

Not catastrophic (~$0.50 at $1800/ETH), but it's a tax on legitimate during-pause repayment. The pass-1 LD-H1 ratione was specifically that borrowers should NOT be penalized for admin-caused dead time — LD-M6 partially walks that back without acknowledging the conflict.

**Attack / Impact:** Mild user-experience pain. More importantly: the LD-M6 + LD-H1 interaction was not analysed in the original spec, suggesting other interactions exist (e.g., `getRepaymentAmount` view returning the floor for paused-since-start loans, misleading frontend UIs). If the borrower automation reads `getRepaymentAmount` and the value is "1-day-floor" instead of "0", the borrower might incorrectly conclude the loan is accruing interest and rush a non-optimal repayment.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:445-453
uint256 interest = calculateLoanInterest(_loanId);    // <-- 0 when 100% paused
uint256 minInterest = Math.mulDiv(...);                // <-- 1-day-equivalent floor
if (interest < minInterest) interest = minInterest;    // <-- floor wins when interest == 0
```
And view-side mirror at line 600-611: same floor, same conflict.

**Recommendation:** Skip the floor when the calculated `interest == 0` AND `pauseAdjustedElapsed > 0` is false (i.e., 100% paused since start). Suggested:
```solidity
uint256 elapsed = pauseAdjustedElapsed(_loanId);
if (elapsed > 0) {  // only floor non-zero-elapsed loans
    uint256 minInterest = ...;
    if (interest < minInterest) interest = minInterest;
}
```
This preserves the same-block flash-loan defense (which only matters when elapsed > 0) without taxing during-pause repayments.

---

## [LD2-M3] TegridyNFTLending.acceptOffer: treasury change between create and accept silently redirects fee
**Severity:** Medium
**File:** `contracts/src/TegridyNFTLending.sol:389-393`
**Category:** other

**Bug:** Pass-1 fix LD-M8 defers the origination fee transfer from `createOffer` to `acceptOffer`. The fee is held on the Offer struct (`offer.originationFee`). At acceptance (line 391), the fee is forwarded to the **current** `treasury` address — not snapshotted at offer creation. If `executeTreasuryChange` (which is 48h-timelocked) fires between an offer's creation and its acceptance, the fee is silently routed to the new treasury.

**Attack / Impact:** This is the exact scenario the brief flagged: "What if treasury changes mid-flight (offer created when treasury was X, executes when treasury is Y)?". The protocol never lies to the lender about where their fee is going — the fee is protocol revenue, not lender funds. **However**, two concrete downsides:

1. **Audit-trail asymmetry**: `OriginationFeeCollected(lender, originationFee)` at line 392 emits the fee amount but not the destination. Indexers attribute the fee to the treasury that was active at *acceptOffer block*, not the treasury the lender saw at create time. Forensic accounting (e.g., reconciling treasury inflows against historical lender activity) relies on indirect block-timestamp correlation.

2. **Adversarial admin front-running**: A captured admin proposes a treasury change to a malicious address. After the 48h timelock, between `executeTreasuryChange` and the next outside-observer noticing, all in-flight offers' origination fees flow to the malicious treasury at acceptOffer time. Lenders cannot withdraw their offers retroactively to escape the fee-redirect — they could `cancelOffer` and re-post to capture the new treasury they're agreeing to, but require active monitoring.

There is a related test in TegridyLending (`test_treasuryChangeMidLoan_feeGoesToNewTreasury`) that ALREADY confirms this is the expected behavior on the lending side. The pattern was apparently considered acceptable for in-flight LOANS but the LD-M8 deferral now extends the same ambiguity to in-flight OFFERS, which sit on the order book MUCH longer than active loans (an offer can live until cancelled; a loan settles within `MAX_DURATION = 365 days`).

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:389-393
// AUDIT FIX: DEEP-LD-M8 — forward origination fee to treasury at acceptance.
if (originationFee > 0) {
    WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, originationFee);   // <-- live treasury read
    emit OriginationFeeCollected(lender, originationFee);
}
```
There is no `treasuryAtCreate` field on the Offer struct.

**Recommendation:** Snapshot the treasury on the Offer struct at `createOffer`:
```solidity
struct Offer {
    ...existing fields...
    uint256 originationFee;
    address treasuryAtCreate;       // <-- new
}
```
At acceptOffer, forward to `offer.treasuryAtCreate` (or `treasury` if `offer.treasuryAtCreate == address(0)` for migration). Simultaneously emit the destination address in `OriginationFeeCollected(lender, treasury, fee)`. Closes the audit-trail and the front-running surface in one.

---

## [LD2-M4] TegridyLending: Loan struct has no `pausedDurationAtStart` despite commit-message claim — `effectiveDeadline` STILL uses GLOBAL accumulator
**Severity:** Medium (originally rated High in pass-1 as LD-H2, downgraded here because TegridyLending is not yet in production)
**File:** `contracts/src/TegridyLending.sol:263-274, 1221-1229`
**Category:** other

**Bug:** Re-confirmation of the inverse-direction sibling-miss. The commit message frames LD-H2 as a fix to NFTLending mirroring the existing TegridyLending H10 fix. However, **TegridyLending's `effectiveDeadline` (line 1221-1229) STILL uses the global `totalPausedDuration` accumulator without any per-loan `pausedDurationAtStart` snapshot**. The `Loan` struct (line 263-274) has no such field.

So the *original* H10 vector (microscope §H10 / pass-1 LD-H2) — pre-loan pause time retroactively extending fresh loan deadlines — is **alive in TegridyLending**, contradicting the commit message's claim that TegridyLending was the originator of the fix being ported to NFTLending.

**Attack / Impact:** Identical to the pass-1 LD-H2 walkthrough but with TegridyLending as the target instead of NFTLending. Day 1: pause. Day 30: unpause (`totalPausedDuration = 29d`). Day 31: borrower accepts 7-day loan. Day 38: nominal deadline. Day 39 → effectiveDeadline = 38 + 29 = day 67. Lender's `claimDefaultedCollateral` blocked until day 67 + GRACE. Borrower walks free for 29 extra days. Pre-loan pause time is laundered into post-loan deadline extension.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:1221-1229 (UNCHANGED since pass-1)
function effectiveDeadline(uint256 _loanId) public view returns (uint256) {
    if (_loanId >= loans.length) revert InvalidLoanId();
    uint256 base = loans[_loanId].deadline;
    uint256 pauseExt = totalPausedDuration;            // <-- GLOBAL accumulator, no per-loan snapshot
    if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
        pauseExt += block.timestamp - pauseStartTime;
    }
    return base + pauseExt;
}
```
Compare TegridyNFTLending.sol:798-809 which DID receive the snapshot fix. Asymmetry confirmed.

**Recommendation:** Add `pausedDurationAtStart` to TegridyLending's Loan struct. Snapshot at line 644 inside `loans.push(...)`. Subtract inside `effectiveDeadline`. Direct port of the LD-H2 fix that landed on NFTLending.

---

## [LD2-M5] TegridyLending.repayLoan: STILL uses raw `calculateInterest` (LD-H1 fix not ported back)
**Severity:** Medium (originally rated High in pass-1 as LD-H1)
**File:** `contracts/src/TegridyLending.sol:694-704`
**Category:** other

**Bug:** Pass-1 LD-H1 was framed as porting the existing TegridyLending H11 fix (calculateLoanInterest with pause-adjusted elapsed) to TegridyNFTLending. **In reality, TegridyLending NEVER had a `calculateLoanInterest` helper** — it has `calculateInterest(principal, aprBps, startTime, currentTime)` (line 904) which takes raw timestamps. `repayLoan` calls `calculateInterest(principal, aprBps, startTime, block.timestamp)` (line 694-699) — pure raw math, no pause adjustment.

So during admin pauses, TegridyLending borrowers DO accrue interest while the lender's `claimDefaultedCollateral` path is blocked — exactly the H11 vector the commit message claimed had been fixed long ago. The asymmetry is between the two CONTRACTS, but in the wrong direction from the commit message's framing.

**Attack / Impact:** Identical to pass-1 LD-H1 walkthrough but applied to TegridyLending instead of NFTLending. Admin pauses for 30 days during a 60-day loan. Interest = APR × 90 days at repay. Borrower over-pays 50% on interest. The MICROSCOPE H11 framing — "TegridyLending was fixed" — is **false against the current source**.

**Evidence:**
```solidity
// contracts/src/TegridyLending.sol:694-699
uint256 interest = calculateInterest(
    principal,
    aprBps,
    startTime,
    block.timestamp     // <-- raw block.timestamp, no pause adjustment
);
```
And `getRepaymentAmount` (line 927-932) has the same bug — view returns un-adjusted interest.

**Recommendation:** Port the `calculateLoanInterest` + `pauseAdjustedElapsed` helpers from NFTLending (lines 569-595). Replace `calculateInterest` calls in `repayLoan` and `getRepaymentAmount` with the pause-aware variant. **This is a one-for-one port — the helpers exist on the sibling, just not yet on TegridyLending.**

---

## [LD2-L1] TegridyNFTLending.acceptOffer: snapshot of `originationFee` allows old-rate lock-in for stale offers
**Severity:** Low
**File:** `contracts/src/TegridyNFTLending.sol:285-299, 349`
**Category:** other

**Bug:** The LD-M8 deferral stores `originationFee` on the Offer struct at create-time. The fee is calculated against the *then-current* `originationFeeBps`. If admin later raises the fee (48h timelock), pre-existing offers ride out the old rate.

This is largely the intended behavior (lenders agreed to the fee they saw). **But the inverse case is awkward**: if admin LOWERS the fee (e.g., from 2% to 0%), pre-existing offers still pay the old 2%. A lender who wants the new lower rate must `cancelOffer` (refunded full deposit) and re-post (charged 0% under new rate). This is a benign re-issuance pattern, but the lender pays gas for the round-trip and loses queue position.

**Attack / Impact:** Lenders posting offers shortly before a known-imminent fee reduction get a worse deal than lenders posting after. Sophisticated lenders monitor `OriginationFeeProposed` events and time their offers accordingly. Less-sophisticated lenders (the median user) suffer. Not a security bug, but a fairness / UX gap.

**Evidence:**
```solidity
// contracts/src/TegridyNFTLending.sol:286-298
uint256 originationFee = (msg.value * originationFeeBps) / BPS;       // <-- snapshot at create
uint256 effectivePrincipal = _principal - originationFee;
offers.push(Offer({
    ...
    originationFee: originationFee   // <-- old rate locked in
}));
```

**Recommendation:** Two options:
1. Calculate the fee at `acceptOffer` against current `originationFeeBps` (live read) — symmetric with how `treasury` is read live (see LD2-M3). This means `cancelOffer` would refund full `principal` (the current path) since no fee was actually charged.
2. Add an admin-callable `recomputeOfferFee(offerId)` that snapshots a new fee at the request of the lender (or auto-accept on `cancelOffer`-then-`createOffer` if the lender provides a hint). Riskier and more code.

Option 1 is the cleaner fix — it makes the fee always-live and removes the snapshot-staleness vector entirely. The protocol still earns revenue (fee is paid at accept time, just at the live rate) and lenders see consistent treatment.

---

## [LD2-L2] TegridyNFTLending.pauseAdjustedElapsed: defensive `pausedDurationAtStart > totalPausedDuration` check returns 0 instead of reverting
**Severity:** Low
**File:** `contracts/src/TegridyNFTLending.sol:583-595`
**Category:** other

**Bug:** Lines 588-590 contain a defensive check: `pausedSinceStart = totalPausedDuration > loan.pausedDurationAtStart ? totalPausedDuration - loan.pausedDurationAtStart : 0`. This guards against an impossible underflow case — `totalPausedDuration` is monotonically non-decreasing, so it can NEVER be less than the snapshot taken at loan-create time. If this branch is ever taken, **something is structurally broken** (storage corruption, upgrade-script error, governance attack).

The current code silently returns 0, treating the broken state as "no pause has occurred since loan start." This is fail-open behavior — borrower interest = full raw elapsed time despite the broken pause accounting. A more secure stance: revert with a typed error like `PauseAccountingInvariantViolated` so the broken-state condition is loudly surfaced rather than silently producing arbitrary interest figures.

Same issue applies to `effectiveDeadline` at line 802-804 — same defensive ternary, same silent-zero behavior.

**Attack / Impact:** Latent. If a future admin `delegatecall`s into a malicious upgrader that corrupts `totalPausedDuration` or `pausedDurationAtStart`, the contract degrades silently. Not exploitable absent the prior compromise.

**Recommendation:** Add a typed `error PauseInvariantViolated();` and revert in both helpers when `loan.pausedDurationAtStart > totalPausedDuration`. Fail-loud is the correct posture for unreachable defensive branches.

---

## [LD2-L3] TegridyNFTLending: Loan struct gas-pack opportunity — `pausedDurationAtStart` appended after bools wastes a slot
**Severity:** Low (gas)
**File:** `contracts/src/TegridyNFTLending.sol:94-110`
**Category:** other

**Bug:** Layout of the new Loan struct:
```
slot 0: borrower (address, 20 bytes)
slot 1: lender (address, 20 bytes)
slot 2: offerId (uint256)
slot 3: tokenId (uint256)
slot 4: collateralContract (address, 20 bytes)
slot 5: principal (uint256)
slot 6: aprBps (uint256)
slot 7: startTime (uint256)
slot 8: deadline (uint256)
slot 9: repaid (bool, 1 byte) + defaultClaimed (bool, 1 byte) — packs into 1 slot
slot 10: pausedDurationAtStart (uint256, 32 bytes)
```
The two bools each occupy a single byte but live in their own slot since `pausedDurationAtStart` follows. By moving `pausedDurationAtStart` BEFORE the bools (or by using `uint96` for pausedDurationAtStart — pause duration in seconds fits comfortably in 96 bits = 2.5 quintillion years), one storage slot per loan can be saved.

**Attack / Impact:** Pure gas. ~20k gas per loan creation, ~5k per loan read. At 1000 loans/year and gas-price of 30 gwei, savings ≈ 0.6 ETH/year.

**Recommendation:** Pack `pausedDurationAtStart` into a uint64 next to the bools:
```solidity
struct Loan {
    address borrower;
    address lender;
    uint256 offerId;
    uint256 tokenId;
    address collateralContract;
    uint256 principal;
    uint256 aprBps;
    uint256 startTime;
    uint256 deadline;
    bool repaid;
    bool defaultClaimed;
    uint64 pausedDurationAtStart;  // 8 bytes — fits in same slot as bools
}
```
uint64 supports 584 billion years of pause duration — comfortably overkill.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 2 |
| Medium | 5 |
| Low | 3 |
| **Total NEW** | **11** |

**Top-3 to fix first:**
1. **[LD2-C1]** — Re-apply the 11 advertised TegridyLending fixes that did NOT land in commit `037da95`. Treat the original commit as having shipped only DEEP-LIB-H3. **Release-blocking.**
2. **[LD2-H1]** — TegridyNFTLending.repayLoan: replace SequencerCheck with `getSequencerOutageBuffer` deadline extension. The current closure direction nullifies the borrower's repay window during sequencer recovery — exactly the H-LIB-H3 scenario.
3. **[LD2-H2]** — Defeat the 0-APR loophole in the LD-M6 floor: enforce `minAprBps > 0` OR add a flat `MIN_INTEREST_PRINCIPAL_BPS` floor that activates regardless of APR.

**Pattern observed:** The cluster has a **commit-message-vs-code divergence problem**. The 11 missing TegridyLending fixes were either dropped during rebase, lost during partial revert, or never written but the message was prepared in advance. Process recommendation: run `git diff HEAD^ HEAD -- contracts/src/<target>.sol | grep '^[+-]' | wc -l` against the commit body's bullet list before signing — a 9-line diff cannot deliver 11 advertised fixes.

**Sibling-miss inversion:** Pass-1 found "fixes shipped only to TegridyLending; NFTLending missed". The remediation commit inverted this: now the fixes shipped only to TegridyNFTLending while TegridyLending kept its original holes. Net: same architectural divergence between the two contracts, just with the polarity flipped. The two contracts will need to converge on a shared base library (e.g., `TegridyLendingCore` abstract contract holding `pauseAdjustedElapsed`, `effectiveDeadline`, `MIN_INTEREST_DURATION`) before the sibling-miss class of finding can be permanently closed.
