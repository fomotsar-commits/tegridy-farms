# Deep Audit — VoteIncentives, GaugeController, MemeBountyBoard, CommunityGrants (2026-05-01)

**Scope:**
- `contracts/src/VoteIncentives.sol` (1454 lines)
- `contracts/src/GaugeController.sol` (678 lines)
- `contracts/src/MemeBountyBoard.sol` (709 lines)
- `contracts/src/CommunityGrants.sol` (979 lines)

**Excluded (verified shipped, not re-listed):**
- MICROSCOPE C2 (multi-commit options arb) — verified `committedPower` cap at `VoteIncentives.sol:1292`
- MICROSCOPE C3 (snapshot-vs-possession) — current-power floor verified at every vote site (still bypassable; see DEEP-GOV-01)
- MICROSCOPE H12 (MemeBounty late-vote flip) — `TOP_FREEZE_WINDOW` verified at `MemeBountyBoard.sol:456-462` (introduced new bug; see DEEP-GOV-04)
- MICROSCOPE H13 (CommunityGrants single-tokenId) — replaced by address-level check at `CommunityGrants.sol:323`
- MICROSCOPE H14 (GaugeController no-quorum siphon) — `MAX_GAUGE_RELATIVE_WEIGHT_BPS` cap shipped (introduced new bug; see DEEP-GOV-03)
- MICROSCOPE M-G5 (claim-rounding-zero gas grief) — partial fix; full fix missing (see DEEP-GOV-02)
- 2c74159 (R016 M-1 disabled-pair bribe rejection) — verified at `_validatePair`; gap surfaces in DEEP-GOV-08
- 293d0b8 (cancelCommit 2*REVEAL_GRACE bound) — verified at `GaugeController.sol:427`
- M-B01 treasury setter — verified shipped; sibling treasury setter gaps in DEEP-GOV-15

---

## [DEEP-GOV-01] C3 current-power floor is binary; multi-NFT divestment to single-wei sentinel still bypasses
**Severity:** High
**File:** `contracts/src/VoteIncentives.sol:467, 1291, 1355`; `contracts/src/GaugeController.sol:277, 493`; `contracts/src/MemeBountyBoard.sol:437`; `contracts/src/CommunityGrants.sol:330`
**Category:** gov

**Bug:** Every governance vote site now contains the line `if (votingEscrow.votingPowerOf(msg.sender) == 0) revert ...` to close the C3 snapshot-vs-possession decoupling. This check is BINARY — it only rejects voters whose current power is exactly zero. A voter who held 100,000 TOWELI worth of voting power at snapshot but transferred 99.999% of their NFTs to a confederate after snapshot still has >0 current power (the 1-wei sentinel), so the floor check passes. They then apply the FULL pre-divest aggregate via `votingPowerAtTimestamp(msg.sender, snapshotTime)`. The microscope's recommended remedy explicitly noted this is the "one-line patch; long-term migrate to per-tokenId checkpoints" — the long-term fix has not landed.

**Attack / Impact:** A whale stakes 100k TOWELI in 50 small positions. Snapshot occurs. Whale transfers 49 positions to confederate (paying 49 × ERC721 transfer gas). Sentinel position remains. Both whale and confederate now vote on the SAME proposal — whale uses `votingPowerAtTimestamp` showing 100k, confederate uses their own historical (also 100k if they staked beforehand, OR zero if not). Even single-actor: whale alone applies 100k power to a vote despite holding only 1-wei equivalent at vote time. In CommunityGrants this drains the treasury; in GaugeController this directs emissions; in VoteIncentives this captures bribe pools; in MemeBountyBoard this picks winners. The C3 fix advertised "Closes the snapshot/possession decoupling" but only closes the trivial zero-divest case.

**Evidence:**
```solidity
// VoteIncentives.sol:462-467
uint256 userPower = votingEscrow.votingPowerAtTimestamp(msg.sender, ep.timestamp);
if (userPower == 0) revert NothingToClaim();
// AUDIT MICROSCOPE_2026_04_30 C3: current-power floor.
if (votingEscrow.votingPowerOf(msg.sender) == 0) revert NothingToClaim();
// ↑ Only rejects when user has ZERO current power, not when current << historical
```

**Recommendation:** Replace the binary floor with a min(historical, current) clamp:
```solidity
uint256 historical = votingEscrow.votingPowerAtTimestamp(msg.sender, snapshotTime);
uint256 current = votingEscrow.votingPowerOf(msg.sender);
uint256 power = historical < current ? historical : current;
if (power == 0) revert ...;
```
This applies the smaller of the two values, neutralizing post-snapshot divestment entirely. Pattern of record: Curve veCRV (non-transferable specifically because of this); Aave aTokens use min(checkpointed, balance) for delegate voting.

---

## [DEEP-GOV-02] M-G5 claim-rounding fix is incomplete; all-zero-share path reverts and rolls back the `claimed` writes
**Severity:** Medium
**File:** `contracts/src/VoteIncentives.sol:618-694, 727-784`
**Category:** gov

**Bug:** The M-G5 fix at `VoteIncentives.sol:627-638` marks `claimed[user][epoch][pair][token] = true` even when `share == 0`, intended to prevent perpetual gas-griefing of small voters whose every share rounds to zero. But the function ends with `if (!anyClaimed) revert NothingToClaim();` (line 694), and `anyClaimed` is only set to `true` when `share > 0`. If EVERY token's share rounds to zero, the function reverts — the EVM rolls back all `claimed = true` writes from the share==0 branch, and the small voter can never escape the gas-griefing loop. Worse, the BATCH path (`claimBribesBatch`, line 736) does NOT have the M-G5 fix at all: `if (share == 0) continue;` skips without marking claimed.

**Attack / Impact:** A small voter (1000 TOWELI of voting power) participates in an epoch where bribe pools are large (1 ETH per pair, 20 tokens) but total gauge votes are huge (100M TOWELI). Their share = `1e18 * 1000 / 100_000_000` = 1e10 wei — non-zero, fine. But for a less popular pair where THEIR share alone is 100% of votes but total pair gauge votes is small enough that `bribeAmount * userVote / totalVotes` rounds to zero (e.g. 1 wei bribe * 1000 / 1500 = 0), every token rounds to zero AND the entire claim reverts. Voter pays gas every epoch, gets zero, has the `claimed` slot still unmarked. Gas grief in perpetuity.

**Evidence:**
```solidity
// VoteIncentives.sol:618-694 (claimBribes)
for (uint256 i = 0; i < tokens.length; i++) {
    ...
    if (share == 0) {
        claimed[msg.sender][epoch][pair][token] = true;  // M-G5 fix
        continue;
    }
    claimed[msg.sender][epoch][pair][token] = true;
    anyClaimed = true;
    ...
}
if (!anyClaimed) revert NothingToClaim();  // ← rolls back the M-G5 writes!

// VoteIncentives.sol:727-784 (claimBribesBatch) — no M-G5 fix at all
if (share == 0) continue;  // never marks claimed
```

**Recommendation:** In `claimBribes`, set `anyClaimed = true` in the share==0 branch as well so the `claimed` writes persist; OR drop the revert and just emit nothing. In `claimBribesBatch`, mirror the fix from `claimBribes`: `if (share == 0) { claimed[...] = true; continue; }`. The latter is the more correct pattern across both functions — the M-G5 invariant should be uniform.

---

## [DEEP-GOV-03] H14 per-gauge cap silently leaks emissions when one gauge dominates honest votes
**Severity:** High
**File:** `contracts/src/GaugeController.sol:574-579`
**Category:** gov

**Bug:** The H14 fix `MAX_GAUGE_RELATIVE_WEIGHT_BPS = 5000` clamps each gauge's relative weight to 50% of BPS. When the cap fires, the over-cap allocation is silently DROPPED rather than redistributed. Three pathological cases:
1. **Single gauge has all votes** (the H14 attack scenario): raw = 10000 → clamped to 5000 → 50% of `emissionBudget` is silently lost.
2. **Two-gauge 70/30 split** (organic preference): raw1=7000 capped to 5000, raw2=3000 → sum=8000 → 20% of `emissionBudget` lost.
3. **N-gauge skew where one is dominant**: every epoch where governance organically prefers one gauge over 50% leaks the over-cap budget.

The leaked budget is never minted (it's just multiplication: `emissionBudget * clampedWeight / BPS`), so consumers like `TegridyLPFarming.notifyRewardAmount` get LESS than the budget despite valid votes summing to BPS.

**Attack / Impact:** Token-economic damage: protocol pays for `emissionBudget` worth of TOWELI emissions each epoch (e.g., 100k TOWELI), but if any single gauge gets >50% of votes, only 80-90% is actually distributed. Over a year (52 epochs), if average over-cap loss is 10%, that's 520k TOWELI of un-emitted budget — silently retained or never minted. Consumers cannot detect this without summing all gauges' relative weights. Worse: the audit comment claims "over-emission against the budget cannot occur" — true, but UNDER-emission certainly can, and the comment masks the issue.

**Evidence:**
```solidity
// GaugeController.sol:574-579
function _getRelativeWeightAt(address gauge, uint256 epoch) internal view returns (uint256) {
    uint256 total = totalWeightByEpoch[epoch];
    if (total == 0) return 0;
    uint256 raw = (gaugeWeightByEpoch[epoch][gauge] * BPS) / total;
    return raw > MAX_GAUGE_RELATIVE_WEIGHT_BPS ? MAX_GAUGE_RELATIVE_WEIGHT_BPS : raw;
}
// Sum of relative weights: depends on per-gauge cap; can be < BPS
```

**Recommendation:** Use one of:
- (a) Renormalize: after capping the over-cap gauge to 5000, redistribute the excess proportionally to OTHER gauges. Preserves total = BPS.
- (b) Scale denominator: `effectiveTotal = max(total, 2 * gaugeWeight[topGauge])`, so a >50% gauge's share is exactly 50% but the remainder stays distributable.
- (c) Voter-side cap: enforce no SINGLE voter's allocated power per gauge can exceed (totalEpochPower * MAX_GAUGE_BPS / BPS). Penalizes the attacker rather than honest voters.

Pattern of record: Curve `GaugeController.gauge_relative_weight_write` does NOT cap; it relies on weight votes being naturally distributed. Aerodrome / Velodrome has per-gauge caps but renormalizes.

---

## [DEEP-GOV-04] MemeBountyBoard H12 freeze locks out submission #N when no pre-freeze votes existed
**Severity:** Medium
**File:** `contracts/src/MemeBountyBoard.sol:456-462`
**Category:** gov

**Bug:** The H12 freeze at `MemeBountyBoard.sol:456-462` blocks non-top submissions from leapfrogging in the final 24h (`TOP_FREEZE_WINDOW`). The check is `_submissionId == topSubmissionId[_bountyId]`. But at bounty creation, `topSubmissionId` defaults to 0 (mapping default). So during the freeze, only submission #0 can become the top — any submission #1, #2, ... whose votes overtake the (zero) top must wait for the post-freeze, but the deadline closes the voting window first. Result: bounties where (a) no votes happen pre-freeze AND (b) submission #0 doesn't exist OR doesn't get votes during freeze cannot complete — `topSubmissionVotes` stays at 0, `completeBounty` reverts `QuorumNotMet`, and `refundStaleBounty` returns ETH to the creator after grace.

**Attack / Impact:** Bounty creator can engineer this: post a bounty with a controlled "submission #0" (their own dummy address — wait, creator can't submit due to `CreatorCannotSubmit`). OK so the creator can't directly weaponize #0. But the natural exploit: creator stalls the community discussion until the 6th day of a 7-day deadline, then artists submit, then voters arrive at day 6.5 (in freeze). All votes go to whichever submission they prefer (probably NOT #0 if it's a poor entry). Top stays at 0. Bounty refunds.

Alternative exploit via voter coordination: an adversary can vote for submission #0 (any tiny submission) before freeze, locking it as the "frozen" top. Now in freeze, no other submission can displace it even with overwhelming votes.

**Evidence:**
```solidity
// MemeBountyBoard.sol:456-462
bool inFreeze = block.timestamp + TOP_FREEZE_WINDOW >= bounties[_bountyId].deadline;
if (newVotes > topSubmissionVotes[_bountyId]) {
    if (!inFreeze || _submissionId == topSubmissionId[_bountyId]) {
        topSubmissionVotes[_bountyId] = newVotes;
        topSubmissionId[_bountyId] = _submissionId;
    }
}
```
When `topSubmissionVotes == 0`, default `topSubmissionId == 0` — only submission #0 can promote.

**Recommendation:** Track `firstVoteAt[bountyId]` and special-case the freeze check: a submission CAN become top during freeze iff `firstVoteAt[bountyId] >= deadline - TOP_FREEZE_WINDOW`, OR `topSubmissionVotes == 0` (no prior leader to protect). Equivalent: change the freeze condition to `inFreeze && topSubmissionVotes > 0` so the protection only activates when there's actually a leader to freeze.

---

## [DEEP-GOV-05] CommunityGrants rolling-disbursement cap silently bypassed when ring buffer overflows
**Severity:** Medium
**File:** `contracts/src/CommunityGrants.sol:853-869, 793-809`
**Category:** gov

**Bug:** `MAX_DISBURSEMENTS = 100` ring buffer, `ROLLING_WINDOW = 30 days`. With up to 50 active proposals, plus retries, plus `permissionlessExecution`, a 30-day window can host >100 disbursements. When `_recordDisbursement` is called and the buffer is full (`nextTail == disbursementHead`), it EVICTS the oldest entry: `rollingDisbursed -= disbursementAmounts[disbursementHead]`. But that oldest entry might still be within the 30-day window. Result: the eviction silently removes its amount from `rollingDisbursed`, so the cap (`30% of balance per 30 days`) is bypassed for the evicted proposal's value.

**Attack / Impact:** A coordinated attacker queues 100 small approved proposals (just enough to fit the ring buffer), then queues 1 large proposal at the cap edge. After the 100th disbursement, the next disbursement evicts entry #1 from `rollingDisbursed`, freeing up its budget. A legitimate-looking 30% cap effectively becomes 30% × (1 + numEvicted/buffer_size). Cap can be soft-broken.

Even without coordination, the bug is real: rapid voting cycles will silently inflate the per-window cap. Audit comment claims "O(expired) not O(total) — gas cost bounded" — true for gas, but functional correctness is broken.

**Evidence:**
```solidity
// CommunityGrants.sol:858-863
if (nextTail == disbursementHead) {
    rollingDisbursed -= disbursementAmounts[disbursementHead];
    delete disbursementTimestamps[disbursementHead];
    delete disbursementAmounts[disbursementHead];
    disbursementHead = (disbursementHead + 1) % MAX_DISBURSEMENTS;
}
// ↑ Evicts oldest unconditionally — even if still within ROLLING_WINDOW
```

**Recommendation:** Reject new disbursements when the buffer is full and the oldest entry is still within `ROLLING_WINDOW`:
```solidity
if (nextTail == disbursementHead) {
    if (disbursementTimestamps[disbursementHead] >= block.timestamp - ROLLING_WINDOW) {
        revert RollingBufferFull(); // force caller to wait
    }
    // ... existing eviction
}
```
Or use an unbounded queue keyed by epoch index (storage cost is bounded by ROLLING_WINDOW / minDisbursementInterval naturally).

---

## [DEEP-GOV-06] CommunityGrants executeFeeReceiverChange dry-run silently skipped after `sweepFees`
**Severity:** Medium
**File:** `contracts/src/CommunityGrants.sol:729-763`
**Category:** gov

**Bug:** The R014-MEDIUM dry-run safeguard at `executeFeeReceiverChange` only fires when `spare = balance - totalRefundableDeposits >= 1`. But `sweepFees` (line 680-687) routinely drains all non-refundable TOWELI to the current `feeReceiver`. After a sweep, `balance == totalRefundableDeposits`, so `spare == 0`, the dry-run is SKIPPED, and the rotation completes without any blacklist/blackhole verification. The attack surface: an owner ready to install a malicious fee receiver simply calls `sweepFees` BEFORE `executeFeeReceiverChange` to bypass the validation.

**Attack / Impact:** Compromised owner:
1. Calls `proposeFeeReceiver(maliciousAddr)`.
2. Waits 48h.
3. Calls `sweepFees()` — drains existing fee buffer to current receiver.
4. Calls `executeFeeReceiverChange()` — `spare == 0`, dry-run skipped, swap proceeds even if `maliciousAddr` is a TOWELI-blacklisted blackhole.
5. Subsequent `sweepFees` to the malicious address either reverts (DoS for protocol) or completes (if "malicious" just means "unwanted recipient").

The audit comment acknowledges "this edge case is a no-op for any real deployment" — but the attack scenario above is a deployment-time race, not an edge case.

**Evidence:**
```solidity
// CommunityGrants.sol:736-756
uint256 balance = toweli.balanceOf(address(this));
uint256 spare = balance > totalRefundableDeposits ? balance - totalRefundableDeposits : 0;
if (spare >= 1) {
    // dry-run logic
    ...
}
// ↑ if spare == 0, this entire block is skipped — no validation
address oldReceiver = feeReceiver;
feeReceiver = proposed;
```

**Recommendation:** Always perform the dry-run, even if `spare == 0`. Pull 1 wei from `totalRefundableDeposits` (and re-credit on success) to fund the test transfer; OR mint/burn a 1-wei TOWELI-equivalent flag transfer (using a sentinel that's already at the contract); OR simply revert if `spare == 0` and force the owner to wait until fees accumulate.

---

## [DEEP-GOV-07] GaugeController reveal grace window is asymmetric — late reveals fail silently
**Severity:** Medium
**File:** `contracts/src/GaugeController.sol:454-463, 532-538`
**Category:** gov

**Bug:** `revealVote` derives `epoch` from `currentEpoch()` (line 454) and accepts reveals from `revealOpens - REVEAL_GRACE` until `revealCloses + REVEAL_GRACE` (lines 462-463). The lower-bound grace works correctly. But the UPPER bound is broken because `revealCloses == epochStartTime(epoch+1)`: any block.timestamp in `[revealCloses, revealCloses + REVEAL_GRACE]` causes `currentEpoch()` to return `epoch+1`, so `commitmentOf[tokenId][currentEpoch()]` looks up the NEXT epoch's slot, which is empty → reverts `NoCommitment`. The 5-minute trailing grace is dead code.

**Attack / Impact:** A validator whose clock runs ~30s behind during the reveal window will compute `block.timestamp` for a block stamped just-after `revealCloses` and BELIEVE they're in the grace zone. They submit a reveal expecting acceptance. The contract however looks up `commitmentOf[tokenId][epoch+1] == bytes32(0)` and reverts. Voter loses their vote, bond is forfeited via `sweepForfeitedBond` (callable post-revealDeadline). Even more concerning: the `isRevealWindowOpen()` view (line 532-538) reports `open = true` for `[revealOpens - REVEAL_GRACE, revealCloses + REVEAL_GRACE]`, lying to UIs that then submit doomed reveals.

**Evidence:**
```solidity
// GaugeController.sol:454, 460-466
uint256 epoch = currentEpoch();  // ← advances at revealCloses
uint256 revealOpens = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
uint256 revealCloses = epochStartTime(epoch) + EPOCH_DURATION;
if (block.timestamp + REVEAL_GRACE < revealOpens) revert RevealWindowNotOpen();
if (block.timestamp > revealCloses + REVEAL_GRACE) revert RevealWindowNotOpen();
// ... but currentEpoch() == epoch+1 in [revealCloses, revealCloses+REVEAL_GRACE]
//     so commitmentOf[tokenId][currentEpoch()] is the wrong slot.
```

**Recommendation:** Take `epoch` as a parameter (matching VoteIncentives' `revealVote` API), so the reveal can reference its commit's epoch even after `currentEpoch` advances. OR offset the epoch derivation: `uint256 epoch = block.timestamp >= revealCloses ? currentEpoch() - 1 : currentEpoch();` with bounds-check. Mirror `isRevealWindowOpen` to use the same logic so UI matches contract behavior.

---

## [DEEP-GOV-08] vote() / claimBribes() / commitVote() lack disabledPair check; voters waste power on dead pairs
**Severity:** Medium
**File:** `contracts/src/VoteIncentives.sol:444-477, 599-695, 1271-1311`
**Category:** gov

**Bug:** R016 M-1 added `factory.disabledPairs(pair)` to `_validatePair` so deposits are rejected for disabled pairs. But `vote()`, `claimBribes()`, `claimBribesBatch()`, `commitVote()`, and `revealVote()` all accept disabled pairs because they don't call `_validatePair`. Concrete sequence: briber deposits before pair P is disabled. Pair P is disabled mid-epoch (governance timelock or guardian emergency). Voters who already voted for P keep their `gaugeVotes[user][epoch][P]` non-zero. New voters in the same epoch CAN STILL vote for P (no disabled check), wasting their `userTotalVotes` allocation on a dead pair. Their power is now permanently allocated to a pair they cannot route swaps through, and the pre-existing bribes for P are claimable but the pair is dead.

**Attack / Impact:** Coordinated griefing — guardian disables a pair after bribers commit funds, before voters vote. Voters are unaware (no on-chain warning visible from a `vote()` call). They allocate power, lock their `userTotalVotes` against the dead pair, and cannot reuse that power for live pairs. Bribes paid for a dead pair are still claimed by the (now-zombie-committed) voters, but the actual emission/swap utility is zero. This degrades the bribe market signal and disincentivizes bribers from depositing in advance.

**Evidence:**
```solidity
// VoteIncentives.sol:444 — vote()
function vote(uint256 epoch, address pair, uint256 power) external whenNotPaused {
    if (epoch >= epochs.length) revert InvalidEpoch();
    if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
    if (pair == address(0)) revert InvalidPair();
    // ↑ no _validatePair() call — disabled pairs pass through
    ...
}

// VoteIncentives.sol:1271 — commitVote()
function commitVote(uint256 epoch, bytes32 commitHash, uint256 power) external ... {
    // ↑ no pair validation at all (it's hashed); reveal also doesn't validate
}
```

**Recommendation:** Add `_validatePair(pair)` to `vote()`, `claimBribes()`, and `revealVote()` (after the hash check). For `commitVote()`, validation is impossible (pair is hashed), but `revealVote` should call `_validatePair` immediately after the hash matches, BEFORE applying the gauge weight. Voters who committed pre-disable should be allowed to abandon their commit (additional cancel path) without forfeit.

---

## [DEEP-GOV-09] CommunityGrants `executeProposal` re-checks `MAX_GRANT_PERCENT_BPS` against current balance, allowing post-approval DoS
**Severity:** Medium
**File:** `contracts/src/CommunityGrants.sol:413-421, 473-481`
**Category:** gov

**Bug:** A proposal that passed `finalizeProposal` was approved against the contract's balance at finalization time. But `executeProposal` (line 421) and `retryExecution` (line 481) re-check `proposal.amount <= 50% * (currentBalance - otherApproved)`. If the contract's ETH balance drops between approval and execution (e.g. another proposal executes, or `emergencyRecoverETH` during pause and unpause), the cap re-evaluation reverts even though the proposal was validly approved. Combined with `EXECUTION_DEADLINE = 30 days` and `lapseProposal`, the proposal eventually lapses without payout — proposer's effort is wasted.

**Attack / Impact:** Coordinated double-spend on the cap: an attacker queues two large proposals A and B at the cap edge simultaneously. A finalizes first (approved); A executes immediately; the contract balance drops. B was also approved (passed all gates), but at execution time, `(balance - amountA_other) * 0.5 < amountB`, revert. B lapses after 30 days. Attacker successfully blocked B's recipient from receiving funds despite the community approving it. This is asymmetric — the loser is the community/recipient, not the attacker.

Even without active attack: organic ETH outflows (`sweepFees` doesn't move ETH, but `emergencyRecoverETH` does) can DoS in-flight proposals.

**Evidence:**
```solidity
// CommunityGrants.sol:413-421
if (address(this).balance < proposal.amount) revert InsufficientFunds();
uint256 otherApproved = totalApprovedPending > proposal.amount
    ? totalApprovedPending - proposal.amount
    : 0;
uint256 availableForGrant = address(this).balance > otherApproved
    ? address(this).balance - otherApproved
    : 0;
if (proposal.amount > (availableForGrant * MAX_GRANT_PERCENT_BPS) / 10000) revert AmountTooLarge();
// ↑ Re-check uses CURRENT balance — drops since approval cause revert
```

**Recommendation:** The `MAX_GRANT_PERCENT_BPS` check should be enforced at `createProposal` and locked into the proposal struct (as an absolute cap), then verified at execute time only against the absolute cap, not re-derived from current balance. Alternatively, accept the cap-bypass at execution time since `totalApprovedPending` already protects approved-but-unexecuted ETH from being double-counted. Either approach prevents the post-approval DoS.

---

## [DEEP-GOV-10] CommunityGrants `_pruneAndGetRollingDisbursed` is called from `executeProposal` (state-mutating); view consumers cannot read rollingDisbursed accurately
**Severity:** Low
**File:** `contracts/src/CommunityGrants.sol:424, 484, 793-809`
**Category:** gov

**Bug:** `_pruneAndGetRollingDisbursed()` is a state-mutating internal helper that prunes the ring buffer and returns the current rolling total. It's called only from `executeProposal` and `retryExecution`. There is no public view function exposing the post-prune value. The public state variable `rollingDisbursed` is stale until next mutation. Off-chain dashboards / governance UIs reading `rollingDisbursed` directly see incorrect values right after entries should have been pruned.

**Attack / Impact:** UI mis-reporting only. A governance UI showing "remaining 30-day budget" pulls `rollingDisbursed` directly, but post-prune state isn't reflected until the next `executeProposal`. Governance participants make decisions on stale data. Not a fund-loss vector; informational.

**Evidence:**
```solidity
// CommunityGrants.sol:793
function _pruneAndGetRollingDisbursed() internal returns (uint256) {
    // mutates state, returns current
}
// No public view equivalent exists.
```

**Recommendation:** Add `function rollingDisbursedView() external view returns (uint256)` that re-implements the prune logic in a view (no state mutation, just iteration). Pattern: OZ Checkpoints provides view-side projection of the same data.

---

## [DEEP-GOV-11] MemeBountyBoard `cancelBounty` MIN_CANCEL_DELAY = 1h enables artist front-run; submitter has no protection
**Severity:** Medium
**File:** `contracts/src/MemeBountyBoard.sol:527-551`
**Category:** gov

**Bug:** `MIN_CANCEL_DELAY = 1 hour` (line 86) is the only delay between bounty creation and creator-cancel eligibility. After 1h, the creator can cancel the bounty as long as `submissionCount == 0` (line 537). An honest artist who has gathered material, run their wallet through MIN_SUBMIT_BALANCE, and is ready to call `submitWork(...)` — but who broadcast their tx in a contention window — can have their submission front-run by the creator's `cancelBounty`. Creator pays 10k-stipend gas, gets full reward refund, artist's submission tx reverts with `BountyNotOpen`. This is the same pattern as the prior audit M-02 (creator front-runs honest artist) but unfixed — the comment at line 533 acknowledges the risk but doesn't mitigate.

**Attack / Impact:** Creators who change their mind (or want to brigade against early submitters) can wait for any artist's mempool submission, front-run with `cancelBounty`. Artists waste gas and lose attribution. Even more pernicious: a creator with insider info on which artists are about to submit (e.g., from off-chain Discord planning) can pre-cancel selectively. Repeat attackers create bounties that they cancel after artists do off-chain prep work.

**Evidence:**
```solidity
// MemeBountyBoard.sol:527-541
function cancelBounty(uint256 _bountyId) external nonReentrant {
    ...
    if (block.timestamp < bounty.createdAt + MIN_CANCEL_DELAY) revert CancelTooEarly();
    // SECURITY FIX M-10: Cannot cancel after receiving submissions
    if (bounty.submissionCount > 0) revert CannotCancelWithSubmissions();
    ...
}
```

**Recommendation:** Increase `MIN_CANCEL_DELAY` to 24h (matches industry standard for grant boards), AND add a 24h "intent-to-cancel" window: `proposeCancelBounty` → 24h → `executeCancelBounty`. During the window, artists can submit knowing the creator can't yank the bounty mid-tx. Pattern of record: Gitcoin Grants `proposeRefund`.

---

## [DEEP-GOV-12] MemeBountyBoard `voteToken` immutable is dead state; cross-contract refactor risk
**Severity:** Low
**File:** `contracts/src/MemeBountyBoard.sol:40, 242-260`
**Category:** other

**Bug:** `IERC20 public immutable voteToken` is set in the constructor but never read anywhere in the contract. All voting power resolution goes through `stakingContract.votingPowerAtTimestamp` (line 432). The `voteToken` variable is dead state — gas paid for nothing, ABI exposes a misleading getter that integrators may rely on for vote-eligibility checks. Worse, audit 020 INFO-08 acknowledged this dead state but it remains.

**Attack / Impact:** Future maintainers may "fix" `voteToken` to be readable, e.g., adding a fallback voter eligibility check based on TOWELI balance. This would silently change semantics — currently, only stakers can vote; with a fallback, anyone holding TOWELI could. Refactor risk only.

**Evidence:**
```solidity
// MemeBountyBoard.sol:40
IERC20 public immutable voteToken; // TOWELI — must hold tokens to vote (anti-sybil)
// ... no reads anywhere in the contract
```

**Recommendation:** Remove `voteToken` and update the constructor signature accordingly (breaking change — frontend/deploy scripts must update). Alternatively, add a NatSpec deprecation note: `/// @deprecated Use stakingContract for voting power. This field is retained for ABI compatibility only.` and revert any future PR adding reads.

---

## [DEEP-GOV-13] CommunityGrants finalizeProposal has no maximum-balance check; creates approved-but-unfundable proposals
**Severity:** Low
**File:** `contracts/src/CommunityGrants.sol:347-396`
**Category:** gov

**Bug:** `finalizeProposal` only checks vote tallies and quorum. It does NOT check that `address(this).balance >= proposal.amount`. A proposal can be approved when the contract has insufficient ETH; it then enters a deadlocked state where `executeProposal` reverts `InsufficientFunds`. Recipient must wait for the contract to receive enough ETH (via `receive()` from external sources) OR for the proposal to lapse after `EXECUTION_DEADLINE = 30 days`. Lapse refunds the deposit but not the recipient's wasted effort.

**Attack / Impact:** A proposer requests an amount that approaches the contract's expected balance. Between proposal creation and finalization (7 days), the protocol's revenue stream might decline, ETH balance drops, proposal becomes unfundable. The community spent voting power on a doomed proposal. Worse: if multiple proposals approve simultaneously and `totalApprovedPending` exceeds balance, none can execute.

**Evidence:**
```solidity
// CommunityGrants.sol:371-377
if (proposal.votesFor > proposal.votesAgainst) {
    proposal.status = ProposalStatus.Approved;
    totalApprovedPending += proposal.amount;
    // ↑ No balance check; can approve more than the contract holds
}
```

**Recommendation:** At `finalizeProposal`, when transitioning to Approved, verify `address(this).balance + futureExpectedRevenue >= totalApprovedPending` OR revert to `Rejected` if unfundable. Simpler: revert the entire approval and refund the deposit if `totalApprovedPending + amount > address(this).balance` at finalize time. Pattern: Compound Bravo `Timelock.queueTransaction` pre-validates ETH balance.

---

## [DEEP-GOV-14] GaugeController `executeRemoveGauge` doesn't decrement totalWeightByEpoch; mid-epoch removal dilutes survivors
**Severity:** Medium
**File:** `contracts/src/GaugeController.sol:630-647`
**Category:** gov

**Bug:** When `executeRemoveGauge` runs mid-epoch, it sets `isGauge[gauge] = false` and removes from `gaugeList`, but does NOT decrement `totalWeightByEpoch[epoch]` or zero out `gaugeWeightByEpoch[epoch][gauge]`. Voters who already voted for the removed gauge keep their weight in the `total` denominator. Result: `_getRelativeWeightAt(otherGauge)` returns `(otherGauge.weight * BPS) / total` where `total` still includes the dead gauge's weight. Sum of relative weights for surviving gauges is < BPS. Combined with DEEP-GOV-03, this multiplies the emission leak.

**Attack / Impact:** Owner times a gauge removal mid-epoch (after some users have voted for it). For all subsequent reads of `_getRelativeWeightAt`, every surviving gauge is diluted proportionally to the removed gauge's weight share. The 24h timelock provides advance notice but no semantic separation: removal IS effective immediately, dilution is immediate. This is the verbatim H-1 finding from audit 018, still unfixed (POST_REMEDIATION_LEDGER does not list it as remediated).

**Evidence:**
```solidity
// GaugeController.sol:630-647
function executeRemoveGauge() external onlyOwner {
    _execute(GAUGE_REMOVE);
    address gauge = pendingGaugeRemove;
    isGauge[gauge] = false;
    // ... remove from list, return
    // ↑ NO decrement of gaugeWeightByEpoch / totalWeightByEpoch
}
```

**Recommendation:** Either:
- (a) Atomically subtract: `totalWeightByEpoch[currentEpoch()] -= gaugeWeightByEpoch[currentEpoch()][gauge]; delete gaugeWeightByEpoch[currentEpoch()][gauge];` — but this corrupts past-epoch reads via `getRelativeWeightAt(gauge, pastEpoch)`.
- (b) Defer removal to next epoch boundary: `executeRemoveGauge` sets a pending flag, takes effect at `epochStartTime(currentEpoch+1)`. Pattern: Curve `change_gauge_weight` weight changes apply at next epoch.
- (c) Refuse removal if `gaugeWeightByEpoch[currentEpoch()][gauge] > 0`. Forces owner to wait until next epoch.

Option (b) is the standard. Curve protocol of record.

---

## [DEEP-GOV-15] VoteIncentives `sweepExcessETH` uses unbounded `.call`; cross-contract treasury can drain other state
**Severity:** Low
**File:** `contracts/src/VoteIncentives.sol:1142-1149`
**Category:** other

**Bug:** `sweepExcessETH` performs `(bool ok,) = treasury.call{value: sweepable}("")` with no gas limit. The function has `nonReentrant`, so direct VoteIncentives reentry is blocked. But `treasury` can be a contract that, during its `receive()`, calls into OTHER protocol contracts (RevenueDistributor, GaugeController, MemeBountyBoard, etc.) — none of which share the lock. Cross-contract invariant violations are observable.

Sibling: `sweepToken` uses `safeTransfer` (no gas concern). `withdrawTreasuryFees` uses `WETHFallbackLib.safeTransferETHOrWrap` which has stipend protection. Only `sweepExcessETH` lacks stipend.

**Attack / Impact:** Compromised owner installs a malicious treasury (timelock-protected, but a 48h window is enough to plan). Owner calls `sweepExcessETH`. Treasury's `receive()` calls `RevenueDistributor.distribute()` mid-sweep — if any cross-contract invariant relies on "VoteIncentives is not currently sweeping", it's broken. While this requires owner cooperation, the inconsistency with sibling sweeps is a defense-in-depth gap.

**Evidence:**
```solidity
// VoteIncentives.sol:1142-1148
function sweepExcessETH() external onlyOwner nonReentrant {
    uint256 balance = address(this).balance;
    uint256 reserved = totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH;
    uint256 sweepable = balance > reserved ? balance - reserved : 0;
    if (sweepable == 0) revert ZeroAmount();
    (bool ok,) = treasury.call{value: sweepable}("");  // ← unbounded gas
    require(ok, "SWEEP_FAILED");
}
```

**Recommendation:** Use `WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, sweepable)` for parity with `withdrawTreasuryFees`. The 10k stipend is sufficient for an EOA or simple multisig treasury; contract treasuries get WETH instead.

---

## [DEEP-GOV-16] CommunityGrants `executeWhitelistChange` doesn't clear `pendingWhitelistAction` post-execute
**Severity:** Info
**File:** `contracts/src/VoteIncentives.sol:933-959` (note: VoteIncentives, mis-attributed to grants in initial scan)
**Category:** other

**Bug:** `executeWhitelistChange` zeroes `pendingWhitelistToken` (line 937) but does not zero `pendingWhitelistAction`. The bool stays as the last-proposed action. No exploitable path (it's only read after a successful `_propose`, which always overwrites it), but inconsistent with the address-clearing pattern.

**Recommendation:** Add `pendingWhitelistAction = false;` after line 937 for hygiene.

---

## [DEEP-GOV-17] CommunityGrants `cancelProposal` fails-open if `_cancel` reverts but state already mutated
**Severity:** Info
**File:** `contracts/src/CommunityGrants.sol:521-557`
**Category:** other

**Bug:** `cancelProposal` is the legacy non-timelocked path for Active proposals. The function doesn't call `_cancel()` from TimelockAdmin (because there's no proposed cancel-active timelock entry). Instead, it directly mutates state. This is intentional, but worth noting that the M-G01 doc-style `cancelCancelApproved` aborts the timelock — there's no symmetric "abort cancel of Active" path because Active cancellation is instant. Defensive only; not exploitable.

---

## Summary

- **High:** 3 (DEEP-GOV-01, -03, -14)
- **Medium:** 7 (DEEP-GOV-02, -04, -05, -06, -07, -08, -09, -11)
- **Low:** 3 (DEEP-GOV-10, -12, -13, -15)
- **Info:** 2 (DEEP-GOV-16, -17)

**Top priorities:**
1. **DEEP-GOV-01** — replace binary current-power floor with min(historical, current) across 4 contracts
2. **DEEP-GOV-03** — H14 emission leak: renormalize or scale denominator in `_getRelativeWeightAt`
3. **DEEP-GOV-14** — gauge removal mid-epoch dilution (verbatim H-1 from audit 018, still unfixed)
4. **DEEP-GOV-04 / DEEP-GOV-07** — H12 freeze edge case + asymmetric reveal grace are both subtle correctness issues introduced by recent fixes
5. **DEEP-GOV-08** — 5+ vote/claim sites missing `_validatePair` despite `depositBribe` having it
