# Deep Audit v2 — VoteIncentives, GaugeController, MemeBountyBoard, CommunityGrants (2026-05-01)

**Scope:**
- `contracts/src/VoteIncentives.sol` (post-fix, 1489 lines)
- `contracts/src/GaugeController.sol` (post-fix, 728 lines)
- `contracts/src/MemeBountyBoard.sol` (post-fix, 723 lines)
- `contracts/src/CommunityGrants.sol` (post-fix, 1067 lines)

**Pre-conditions verified (pass-1 fixes correctly shipped at `a4a1e69`):**
- DEEP-GOV-01 — `min(historical, current)` clamp present at every vote-power read site:
  - VoteIncentives `vote()` L470-472, `commitVote()` L1315-1317, `revealVote()` L1387-1389.
  - GaugeController `vote()` L273-275, `revealVote()` L520-522.
  - MemeBountyBoard `voteForSubmission` L443-445.
  - CommunityGrants `voteOnProposal` L364-366. — verified shipped.
- DEEP-GOV-02 — `claimBribes` share==0 path now sets `anyClaimed = true` (L644); `claimBribesBatch` mirrors the same fix (L750-752) — verified shipped.
- DEEP-GOV-03 — `_getRelativeWeightAt` denominator scaling at GaugeController L612-617 — verified shipped (with caveat — see DEEP-GOV-V2-04).
- DEEP-GOV-04 — H12 freeze condition `inFreeze && topVotes > 0` at MemeBountyBoard L469-475 — verified shipped (with caveat — see DEEP-GOV-V2-08).
- DEEP-GOV-05 — ring-buffer rejects when full + within window at CommunityGrants L940-946 — verified shipped.
- DEEP-GOV-06 — `executeFeeReceiverChange` reverts `NoSpareForDryRun` when `spare == 0` at CommunityGrants L794 — verified shipped.
- DEEP-GOV-07 — GaugeController `revealVote` derives epoch defensively at L461-484 — verified shipped (with caveat — see DEEP-GOV-V2-06).
- DEEP-GOV-08 — `_validatePair` calls added to `vote()` (L455), `claimBribes` (L614), `claimBribesBatch` (L714), `revealVote` (L1380) — verified shipped (with caveat — see DEEP-GOV-V2-02).
- DEEP-GOV-09 — `absoluteCap` snapshotted at finalize (L316), enforced at `executeProposal` L479 / `retryExecution` L533 — verified shipped.
- DEEP-GOV-10 — `rollingDisbursedView()` non-mutating projection at L873-886 — verified shipped.
- DEEP-GOV-11 — `MIN_CANCEL_DELAY = 24 hours` at MemeBountyBoard L96 — verified shipped (with caveat — see DEEP-GOV-V2-09).
- DEEP-GOV-13 — `finalizeProposal` pre-validates fund availability at L414-431 — verified shipped.
- DEEP-GOV-14 — `executeRemoveGauge` reverts `GaugeHasActiveVotes` at L682 — verified shipped (with caveat — see DEEP-GOV-V2-07).
- DEEP-GOV-15 — `sweepExcessETH` routes through `WETHFallbackLib` at VoteIncentives L1177 — verified shipped.
- DEEP-LIB-H2 sibling — MemeBountyBoard `_sequencerBuffer` delegates to `SequencerCheck.getSequencerOutageBuffer` at L321 — verified shipped.
- MICROSCOPE C2 — `commitVote(epoch, hash, power)` enforces `committedPower[user][epoch] + power <= userPower` at VoteIncentives L1319-1320 — verified shipped (with caveat — see DEEP-GOV-V2-01).

---

## [DEEP-GOV-V2-01] `committedPower` is monotonic — pair-disable mid-epoch DoSes voters' commits with no escape
**Severity:** High
**File:** `contracts/src/VoteIncentives.sol:182, 1319-1320, 1380, 1391`
**Category:** gov

**Bug:** The MICROSCOPE C2 fix at L1319-1320 increments `committedPower[user][epoch]` on every successful `commitVote` but **never decrements it** anywhere — not on successful reveal (L1399 only flips `c.revealed`), not on bond forfeit (L1438), not on pair-disable abandonment. Combined with the new DEEP-GOV-08 `_validatePair` at L1380, this creates a permanent epoch-scoped lockup: a voter who commits 100% of their power to pair `P`, then sees `P` disabled by guardian/timelock before reveal, **can no longer reveal that commit (revert PairDisabled at L1380), AND cannot commit again with any positive power (revert EXCEEDS_POWER at L1319 because `committedPower == userPower`).** Their entire epoch's voting power is locked into a doomed reveal; bond is forfeited via `sweepForfeitedBond`.

**Attack / Impact:** Coordinated griefing — a guardian (or timelocked governance) disables a popular pair after voters have committed to it. Every committed voter for that pair is silently locked out of the rest of the epoch. With the C2 cap forcing voters to declare large fractions of their power up-front (small fractions invite arb), most committers will lose 50-100% of their epoch participation. Bond forfeit (10 TOWELI per commit) is a small piece of the damage — the real loss is the missed bribe share and the vote influence on competing live pairs. Even un-coordinated: any pair disable has an asymmetric chilling effect on commit-reveal participation because voters know a single disable can permanently neuter their commits.

The audit comment at L1376-1379 acknowledges "voters who committed pre-disable can simply abandon the commit (forfeiting bond)" but this is materially false — they cannot abandon, they cannot recommit, they cannot rebalance. Bond forfeit + power forfeit + bribe forfeit, all from one external admin action.

**Evidence:**
```solidity
// L1319-1320 — committedPower only ever increases
require(committedPower[msg.sender][epoch] + power <= userPower, "EXCEEDS_POWER");
committedPower[msg.sender][epoch] += power;

// L1380 — reveal blocks disabled pair
_validatePair(pair);

// L1399-1413 — successful reveal does NOT decrement committedPower
c.revealed = true;
uint96 bond = c.bond;
c.bond = 0;
// ...
toweli.safeTransfer(msg.sender, bond);
```

**Recommendation:** Two complementary fixes:
1. Add a `cancelCommit(epoch, commitIndex)` path that lets a voter abandon a stuck commit ANYTIME between commit deadline and reveal deadline IF the pair has been disabled (gate on `factory.disabledPairs(committedPair)`). Decrement `committedPower[user][epoch]` and refund the bond. Pre-cancel-window cancellations forfeit bond as before.
2. Decrement `committedPower[user][epoch]` on `sweepForfeitedBond` so the locked-out voter's slot ages out cleanly — at minimum if cleanup happens before the next epoch the voter rejoins normally.

Pattern of record: Snapshot governance UI lets voters un-commit ahead of finalization; Curve veCRV has a "decay" model that auto-frees commits.

---

## [DEEP-GOV-V2-02] `commitVote` lacks `_validatePair` — DoS bond burn on disabled pairs
**Severity:** Medium
**File:** `contracts/src/VoteIncentives.sol:1298-1338`
**Category:** gov

**Bug:** DEEP-GOV-08's pair-validation was added to `vote`, `claimBribes`, `claimBribesBatch`, and `revealVote`, but explicitly NOT to `commitVote` because the pair is hashed (line `commitVote()` doesn't see the pair). Result: a voter can commit a hash for a pair that was disabled BEFORE the commit was placed. The contract accepts the commit, takes the 10 TOWELI bond, increments `committedPower`. At reveal, `_validatePair` reverts. The commit is dead; the bond is forfeited; the voter wasted a slot.

This is materially different from the DEEP-GOV-V2-01 case (disable AFTER commit) — here the disable was already on-chain at commit time, but the contract accepted the commit anyway because it can't see the pair. Off-chain UIs can warn, but a malicious tx-builder or a UI bug submits anyway, and the contract has no ability to refuse.

**Attack / Impact:** Bond grief on careless voters. A keeper script that commits batched votes (e.g., daily DAO-managed strategy) can lose multiple bonds if a pair is disabled mid-week. Aggregate bond loss is small but the gas + UX is annoying. More worryingly, a malicious indexer can publish a commit-hash recipe for a disabled pair to trick voters.

**Evidence:**
```solidity
// VoteIncentives.sol:1298-1320 — commitVote has no way to validate the hashed pair
function commitVote(uint256 epoch, bytes32 commitHash, uint256 power) external ... {
    // ... no _validatePair call ...
    require(committedPower[msg.sender][epoch] + power <= userPower, "EXCEEDS_POWER");
    committedPower[msg.sender][epoch] += power;
    // bond accepted regardless of whether the hashed pair is alive
}
```

**Recommendation:** Make the pair selectively "revealable" without applying votes — i.e., split reveal into two phases: (1) a free `previewReveal(epoch, commitIndex, pair, power, salt)` that validates everything except gauge accounting and returns success/failure, (2) the existing `revealVote` that runs the full path. UIs call (1) before submitting (2). Alternatively, give the voter a `cancelStuckCommit` path (covered in DEEP-GOV-V2-01) that handles both pre- and post-disable scenarios uniformly.

---

## [DEEP-GOV-V2-03] Removed gauge weight in past epochs is silently undercounted by `_getRelativeWeightAt` topWeight scan
**Severity:** Medium
**File:** `contracts/src/GaugeController.sol:600-621, 672-697`
**Category:** gov

**Bug:** The DEEP-GOV-14 fix prevents removing a gauge that has CURRENT-epoch votes (L682). But it permits removal when the gauge had votes in PAST epochs as long as the current epoch is clean. After removal:
- `gaugeList` no longer contains the removed gauge.
- `gaugeWeightByEpoch[pastEpoch][removedGauge]` is left intact (no purge).
- `_getRelativeWeightAt` (L600-621) iterates the **current** `gaugeList` to find `topWeight`, missing the removed gauge's historical contribution.

Consequence: any read of `getRelativeWeightAt(stillExistsGauge, pastEpoch)` after a gauge removal returns a value calibrated against an UNDERESTIMATED `topWeight`. If the removed gauge was the top in `pastEpoch`, the next-largest current-list gauge becomes the new "top" → its share is correctly capped to 50%, but **other gauges' shares are over-reported** because the denominator scaling logic is now applied to a smaller-than-actual top.

**Attack / Impact:** Off-chain accounting / dashboard mis-reporting for past epochs whenever a removal lands. No on-chain consumer reads past-epoch relative weights today (verified — only `getRelativeWeight(gauge)` of the current epoch is consumed by emission distribution, and that always reflects the live `gaugeList`). However, downstream emission rebate accounting, vote-incentives bribery analysis, and any future "vote your share of the past" model would silently mis-attribute. Owners who use historical relative-weight reads to justify back-pay or treasury allocations would over-pay surviving gauges.

The comment in DEEP-GOV-14 acknowledges "removal IS effective immediately" — true; but combining that with the fact that `_getRelativeWeightAt` is parameterized on past `epoch` and iterates only the current list creates an internally inconsistent past-epoch view.

**Evidence:**
```solidity
// GaugeController.sol:600-621
function _getRelativeWeightAt(address gauge, uint256 epoch) internal view returns (uint256) {
    uint256 total = totalWeightByEpoch[epoch];
    if (total == 0) return 0;

    uint256 topWeight;
    uint256 len = gaugeList.length;
    for (uint256 i; i < len; ++i) {
        uint256 w = gaugeWeightByEpoch[epoch][gaugeList[i]];
        if (w > topWeight) topWeight = w;
    }
    // ↑ if a gauge with the largest weight in `epoch` was REMOVED post-epoch,
    //   its weight is excluded from this scan but still present in `total`.
    //   topWeight is undercounted; surviving gauges' shares are over-reported
    //   when the denominator scaling fires (or wrongly fails to fire).
    ...
}
```

**Recommendation:** Either (a) maintain a per-epoch immutable gauge snapshot (`mapping(uint256 epoch => address[] snapshot)`) so historical reads iterate the gauge set as it was at that epoch's time, or (b) zero out `gaugeWeightByEpoch[currentEpoch][gauge]` in `executeRemoveGauge` and document that past-epoch reads of removed gauges are not supported (clear the surface explicitly rather than allowing silent drift). Option (a) is the principled fix; option (b) is the cheap one. Pattern of record: Curve `GaugeController` keeps a per-epoch gauge_types mapping, never removes historical state.

---

## [DEEP-GOV-V2-04] DEEP-GOV-03 option-b denominator scaling still leaks emissions at sub-90% top dominance
**Severity:** Medium
**File:** `contracts/src/GaugeController.sol:600-621`
**Category:** gov

**Bug:** The denominator-scaling fix (option-b) at L612-617 sets `effectiveTotal = max(total, 2 * topWeight)`, capping the top gauge to exactly 50%. The audit comment claims this preserves total ≈ BPS, but the math doesn't quite hold. Worked example with three gauges at weights `(0.6, 0.3, 0.1)` of total:
- `topWeight = 0.6 * total`, `2 * topWeight = 1.2 * total > total` → `effectiveTotal = 1.2 * total`.
- Top share: `0.6 * BPS / 1.2 = 5000` (50%, capped).
- Other gauges: `0.3 / 1.2 = 25%`, `0.1 / 1.2 = 8.33%`.
- **Sum: 50 + 25 + 8.33 = 83.3% of BPS — 16.7% LEAK.**

The leak is monotonic in the top's dominance: top=51% leaks ~2%, top=70% leaks ~14%, top=99% leaks ~49%. The regression test in `Deep_Governance_2026_05_01.t.sol::test_GaugeRelativeWeight_renormalizes` at L266 explicitly asserts only `assertLe(g1w + g2w + g3w, 10000)`, NOT `assertEq` — the test acknowledges the residual leak.

**Attack / Impact:** Emission under-distribution scaled with vote concentration. Pre-DEEP-GOV-03, a 60-30-10 split leaked 50% (10000 - capped 5000). Post-fix it leaks 16.7%. Better, but not zero. Over a year of organic vote concentration (which ALWAYS happens in practice — Curve, Aerodrome both see top-gauge dominance), the protocol budgets emissions against `emissionBudget * gaugeRelativeWeight / BPS` and silently retains the residual. Token holders see the inflation but emission consumers don't see the value.

**Evidence:**
```solidity
// GaugeController.sol:619 — formula
uint256 raw = (gaugeWeightByEpoch[epoch][gauge] * BPS) / effectiveTotal;
// With effectiveTotal = 2*top, sum across all gauges = total / (2*top) * BPS
// For top = X% of total: sum = (1/(2X/100)) * BPS = (50/X) * BPS
// X=50: sum=100% (no scaling needed); X=60: sum=83%; X=70: sum=71%; X=80: sum=62.5%
```

**Recommendation:** Use option-a (true renormalization): cap top to 5000 BPS, then proportionally redistribute the over-cap to the remaining gauges so sum == BPS exactly. Pseudocode:
```solidity
uint256 cap = MAX_GAUGE_RELATIVE_WEIGHT_BPS;
uint256 topRaw = (top * BPS) / total;
if (topRaw <= cap) { /* normal */ } else {
    if (gauge == topGauge) return cap;
    uint256 excess = topRaw - cap;
    uint256 othersTotal = total - top;
    uint256 base = (gaugeWeightByEpoch[epoch][gauge] * BPS) / total;
    return base + (base * excess) / (othersTotal * BPS / total);
}
```
Pattern of record: Velodrome `gauge_relative_weight_write` uses true renormalization to keep sum invariant.

---

## [DEEP-GOV-V2-05] `_getRelativeWeightAt` is O(n) per read — gas DoS on consumer paths with full gaugeList
**Severity:** Medium
**File:** `contracts/src/GaugeController.sol:600-621`
**Category:** other

**Bug:** Every call to `_getRelativeWeightAt` (and therefore `getRelativeWeight`, `getRelativeWeightAt`, `getGaugeEmission`) now scans the entire `gaugeList` to find `topWeight`. With `MAX_TOTAL_GAUGES = 50`, that's up to 50 SLOAD operations per consumer call. Each SLOAD is 2100 gas (cold) or 100 gas (warm) — worst case ~105k gas just for the topWeight scan, on top of the actual relative-weight read.

Pre-DEEP-GOV-03 this function was O(1). Post-fix it's O(n), and the cost is paid by every consumer of relative weights, every block. If the protocol ships an emission distributor that loops through gauges (e.g., a gas-greedy farming reward notifier), a single distribution call can multiply this O(n) cost by N gauges → O(N²) overall.

**Attack / Impact:** Block-gas-limit DoS on emission distribution paths. Currently no on-chain consumer hits this loop, but the next time a gauge-based emission notifier is added (planned in roadmap), it will inherit a 50²=2500 SLOAD inner loop = ~250k gas just for topWeight scans.

**Evidence:**
```solidity
// GaugeController.sol:606-610 — repeated O(n) scan per call
uint256 len = gaugeList.length;
for (uint256 i; i < len; ++i) {
    uint256 w = gaugeWeightByEpoch[epoch][gaugeList[i]];
    if (w > topWeight) topWeight = w;
}
```

**Recommendation:** Cache `topWeight` per epoch as a storage variable, updated incrementally during `vote()` and `revealVote()` (when a gauge's weight grows past the current top, update the cached top). Then `_getRelativeWeightAt` is O(1) again. Storage slot per epoch is cheap relative to per-call compute.

Implementation sketch:
```solidity
mapping(uint256 => uint256) public topWeightByEpoch;
mapping(uint256 => address) public topGaugeByEpoch;

// In vote() / revealVote():
gaugeWeightByEpoch[epoch][gauge] += allocatedPower;
if (gaugeWeightByEpoch[epoch][gauge] > topWeightByEpoch[epoch]) {
    topWeightByEpoch[epoch] = gaugeWeightByEpoch[epoch][gauge];
    topGaugeByEpoch[epoch] = gauge;
}
```

---

## [DEEP-GOV-V2-06] `isRevealWindowOpen` view diverges from `revealVote` epoch-derivation in trailing grace
**Severity:** Low
**File:** `contracts/src/GaugeController.sol:447-555, 562-568`
**Category:** other

**Bug:** The DEEP-GOV-07 fix made `revealVote` defensively look back to `prev = nowEpoch - 1` when (a) the user has no commit in the current epoch, (b) the user has a commit in the previous epoch, AND (c) we're within `REVEAL_GRACE` of the new epoch boundary. But `isRevealWindowOpen()` at L562-568 still uses `currentEpoch()` directly and reports `epoch = currentEpoch()`, `revealOpensAt`/`revealClosesAt` for the CURRENT epoch.

Off-chain UIs reading `isRevealWindowOpen()` during the trailing-grace minutes will see `epoch = N+1`, but the contract internally accepts a reveal targeting epoch N. UIs may compute the wrong on-chain calldata (e.g., compute commitment hash with the wrong epoch parameter — except the commit was bound to epoch N at commit time, so the hash check would reject the wrong-epoch reveal).

**Attack / Impact:** UI-only mis-reporting, leads to user-visible "no commit found" error during the grace window. Voters who don't realize the trailing grace exists will think their commit was lost. Defensive only; no funds at risk.

**Evidence:**
```solidity
// GaugeController.sol:562-568
function isRevealWindowOpen() external view returns (uint256 epoch, bool open, ...) {
    epoch = currentEpoch();  // ← always current, even in trailing-grace
    revealOpensAt = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
    revealClosesAt = epochStartTime(epoch) + EPOCH_DURATION;
    open = block.timestamp + REVEAL_GRACE >= revealOpensAt
        && block.timestamp <= revealClosesAt + REVEAL_GRACE;
}
```

**Recommendation:** Mirror the same epoch-derivation logic from `revealVote`: take an optional `tokenId` parameter so the view can check whether the user has a commit in the current vs. previous epoch and report the correct active epoch.

---

## [DEEP-GOV-V2-07] DEEP-GOV-14 enables veto-by-voter — single keeper can permanently block gauge removal
**Severity:** Low
**File:** `contracts/src/GaugeController.sol:672-697`
**Category:** gov

**Bug:** `executeRemoveGauge` reverts `GaugeHasActiveVotes` when the target gauge has any current-epoch votes. `PROPOSAL_VALIDITY = 7 days` — equal to one epoch. So the owner has exactly one epoch (from `executeAfter` to `executeAfter + 7d`) to find a moment when no votes exist. **A single voter calling `vote()` at the start of every epoch can keep the gauge "perpetually voted on", causing every owner removal proposal to expire unused.** Owner must constantly re-propose; if even one re-proposal misses the no-votes window, the gauge stays.

Combined with `GAUGE_TIMELOCK = 24 hours`, owner needs at minimum 24h between re-proposals. Practical removal cadence shrinks to ~6 days/epoch where the owner needs the gauge to have zero votes throughout.

**Attack / Impact:** Voter-side veto on gauge removal — possibly intentional (community can resist owner removing popular gauges) but un-documented. A coordinated voter group can make removal of a controversial gauge effectively impossible. Owner's only recourse: pause the contract entirely, or wait out the voter's NFT lock to expire.

**Evidence:**
```solidity
// GaugeController.sol:672-697
function executeRemoveGauge() external onlyOwner {
    _execute(GAUGE_REMOVE);
    address gauge = pendingGaugeRemove;
    if (gaugeWeightByEpoch[currentEpoch()][gauge] > 0) revert GaugeHasActiveVotes();
    // ... rest of removal
}
```

**Recommendation:** Defer removal to next epoch boundary (option-b from the DEEP-GOV-14 audit recommendation): change `executeRemoveGauge` to set a "removal effective at epoch N" flag rather than acting immediately. After epoch N starts, the gauge is officially gone and any votes in epoch N revert with `InvalidGauge`. Pattern of record: Curve `GaugeController.kill_gauge` schedules removal at the next epoch boundary, blocking new votes immediately.

Alternative: shorten the deferred-block window — instead of "no votes this epoch", use "no votes in the last X hours" so a single early-epoch vote doesn't lock out the entire week.

---

## [DEEP-GOV-V2-08] DEEP-GOV-04 freeze still locks in early-leader sock-puppets — quorum DoS
**Severity:** Low
**File:** `contracts/src/MemeBountyBoard.sol:469-475`
**Category:** gov

**Bug:** The DEEP-GOV-04 fix changed the freeze condition to `inFreeze && topVotes > 0`. This correctly closes the "no leader at freeze" lockout. But the **adversarial-coordination** attack from the original DEEP-GOV-04 still works:
1. Attacker votes for submission #X (their own choice / sock-puppet) BEFORE the 24h freeze window.
2. Submission #X is now `topSubmission` with attacker's `MIN_VOTE_BALANCE` (1000 TOWELI) of votes.
3. Freeze window opens. All subsequent votes for any OTHER submission accumulate per-submission tally but cannot promote.
4. Even if a legitimate submission gathers 100,000 TOWELI of votes during freeze, it stays at #2.

`completeBounty` requires `topSubmissionVotes >= MIN_COMPLETION_VOTES = 3000 TOWELI`. So if attacker's lock-in is only 1000 TOWELI, completion will revert and the bounty heads to `refundStaleBounty` (33-day timeout). Bounty creator gets refunded; intended winner gets nothing.

The fix prevents the all-zero lockout but leaves the early-leader lockout intact. Worth noting because the audit doc framed DEEP-GOV-04 as fully closed.

**Attack / Impact:** Bounty griefing. An attacker with >= MIN_VOTE_BALANCE staked can DoS any bounty by voting for an unwanted submission in the first 6 days, then ignoring it. The winner can't be promoted, the creator's reward sits locked for 33 days, the artist effort is wasted.

**Evidence:**
```solidity
// MemeBountyBoard.sol:469-475
bool inFreeze = block.timestamp + TOP_FREEZE_WINDOW >= bounties[_bountyId].deadline;
if (newVotes > topSubmissionVotes[_bountyId]) {
    if (!inFreeze || topSubmissionVotes[_bountyId] == 0 || _submissionId == topSubmissionId[_bountyId]) {
        topSubmissionVotes[_bountyId] = newVotes;
        topSubmissionId[_bountyId] = _submissionId;
    }
}
```

**Recommendation:** Track the leader's age — only protect the leader during freeze if the leader was established at least `TOP_FREEZE_WINDOW` BEFORE freeze. A leader voted in less than 24h before freeze isn't actually "established", and protecting it just enables sock-puppet pre-positioning. Equivalently, require `topSubmissionVotes >= MIN_COMPLETION_VOTES` for the freeze to apply — so a tiny leader can still be displaced. Pattern: Snapshot uses "established" thresholds for late-vote protection.

---

## [DEEP-GOV-V2-09] DEEP-GOV-11 24h cancel delay makes 1-day-deadline bounties uncancellable
**Severity:** Low
**File:** `contracts/src/MemeBountyBoard.sol:62, 96, 541-552`
**Category:** other

**Bug:** `MIN_DEADLINE_DURATION = 1 day` (L62) and `MIN_CANCEL_DELAY = 24 hours` (L96, raised from 1h in DEEP-GOV-11). For a bounty created with the minimum-allowed deadline (`now + 1 day`), the cancel window opens at `createdAt + 24h` — by which time `block.timestamp > deadline`, so `cancelBounty` reverts `CannotCancelAfterDeadline` (L545). **Minimum-deadline bounties are now permanently uncancellable.** Creator's only recourse: `refundStaleBounty` after `deadline + DISPUTE_PERIOD + GRACE_PERIOD = 1 + 2 + 30 = 33 days`.

Pre-DEEP-GOV-11 (with 1h `MIN_CANCEL_DELAY`), 1-day-deadline bounties had ~23h of cancel window. Post-fix: 0 minutes.

**Attack / Impact:** UX regression — creator with a urgent / mistakenly-posted short-deadline bounty has no fast cancel path, must wait 33 days to recover ETH. Not exploitable, but a strict downgrade from the prior contract behavior.

**Evidence:**
```solidity
// MemeBountyBoard.sol:62, 96
uint256 public constant MIN_DEADLINE_DURATION = 1 days;
uint256 public constant MIN_CANCEL_DELAY = 24 hours;
// L545, L548 — after fix: cancel window for min-deadline bounty is empty
if (block.timestamp > bounty.deadline) revert CannotCancelAfterDeadline();
if (block.timestamp < bounty.createdAt + MIN_CANCEL_DELAY) revert CancelTooEarly();
```

**Recommendation:** Either raise `MIN_DEADLINE_DURATION` to ≥ 2 * `MIN_CANCEL_DELAY` (so creators always have a non-empty cancel window), or scale `MIN_CANCEL_DELAY` as `min(24h, deadline - createdAt - 1h)` so short-deadline bounties retain a small cancel window. The original DEEP-GOV-11 attack only requires a delay long enough to discourage front-run cancels (≥ 1 block); a 24h window is conservative on long bounties but pathological on short ones.

---

## [DEEP-GOV-V2-10] DEEP-GOV-V2 follow-up — `committedPower` clamp is asymmetric vs `userTotalVotes`
**Severity:** Low
**File:** `contracts/src/VoteIncentives.sol:1319-1320, 1391`
**Category:** gov

**Bug:** `commitVote` enforces `committedPower[user][epoch] + power <= userPower` where `userPower = min(historical_at_commit, current_at_commit)`. `revealVote` enforces `userTotalVotes[user][epoch] + power <= userPower` where `userPower = min(historical_at_reveal, current_at_reveal)`. These two caps use DIFFERENT mappings (`committedPower` vs `userTotalVotes`), so a commit that satisfies the C2 cap may STILL fail the reveal cap if the voter's `current` power has dropped between commit and reveal.

Example: user commits 80 power (committedPower=80, userPower=100). Between commit and reveal they divest, dropping current to 60. Reveal recomputes userPower=min(100, 60)=60. `userTotalVotes(=0) + 80 <= 60` → false → revert. Bond forfeit. The commit was valid at commit-time but invalid at reveal-time. The voter has no way to know in advance and no recovery path.

Dual to DEEP-GOV-V2-01 — users get burned twice: at commit time the C2 cap was met, but the dynamic min-clamp at reveal time fails them. There's no on-chain way to detect this in advance.

**Attack / Impact:** Voter-loss from mid-epoch divestment. A voter who unstakes (or a multi-NFT holder who transfers an NFT) between commit and reveal loses BOTH their bond and their commit slot for the epoch. The commitment is permanently dead.

**Recommendation:** Pick ONE source of truth and use it consistently. Either:
- (a) At reveal, check against `committedPower[user][epoch]` (the commit-time cap), trusting the commit-time min-clamp — accept reveal even if current power has since dropped. This forfeits the divestment-protection.
- (b) At commit, snapshot `userPower` into a per-user-per-epoch storage slot and use that at reveal too. This makes the cap stable.
- (c) On reveal failure due to power-drop, route the commit to a "stuck-bond refund" path (companion to DEEP-GOV-V2-01).

Option (b) is cleanest. Pattern: Compound Bravo `castVote` snapshots `getPriorVotes` once per proposal, used everywhere downstream.

---

## [DEEP-GOV-V2-11] CommunityGrants `holdsToken` try/catch falls back to known-broken single-pointer check
**Severity:** Low
**File:** `contracts/src/CommunityGrants.sol:348-356`
**Category:** gov

**Bug:** The proposer-self-vote check at L348-356 does:
```solidity
try votingEscrow.holdsToken(msg.sender, proposal.proposerTokenId) returns (bool h) {
    holds = h;
} catch {
    holds = (votingEscrow.userTokenId(msg.sender) == proposal.proposerTokenId);
}
require(!holds, "PROPOSER_POSITION_CANNOT_VOTE");
```

The catch branch falls back to the single-pointer `userTokenId` check — which is **the very bypass M13 (multi-NFT contract holders) was designed to close**. If the staking contract is mid-upgrade and reverts on `holdsToken`, the fallback opens the original sybil-vote vector for one upgrade window: the proposer routes one NFT to a sybil address, sybil's `userTokenId` no longer matches the proposer's snapshot, the fallback says "doesn't hold" → vote allowed.

Modern OZ Ownable + 2-step upgrades take 24-48h. If `holdsToken` reverts during that window, the protection silently degrades. Worse: the comment says "the staking contract is mid-upgrade" — but `holdsToken` could also revert for other reasons (gas exhaustion, return-data length, OOG in nested call) that don't involve upgrades.

**Attack / Impact:** Edge-case re-opening of the M13 sybil-vote primitive during staking-contract upgrades or during any condition that causes `holdsToken` to revert. Treasury funds at risk over the bypass window.

**Evidence:**
```solidity
// CommunityGrants.sol:348-356
if (proposal.proposerTokenId != 0) {
    bool holds;
    try votingEscrow.holdsToken(msg.sender, proposal.proposerTokenId) returns (bool h) {
        holds = h;
    } catch {
        holds = (votingEscrow.userTokenId(msg.sender) == proposal.proposerTokenId);
    }
    require(!holds, "PROPOSER_POSITION_CANNOT_VOTE");
}
```

**Recommendation:** Remove the fallback. If `holdsToken` reverts, the safe behavior is to reject the vote (`revert HoldsTokenCheckFailed()`), not to silently degrade to a known-broken check. The staking contract upgrades through its own timelock; the upgrade window is always announced. Voters are not entitled to vote during the upgrade if it means weakening sybil resistance.

---

## [DEEP-GOV-V2-12] CommunityGrants `_recordDisbursement` only writes after a successful `_pruneAndGetRollingDisbursed` — buffer-full DoS bypassable via failed transfers
**Severity:** Info
**File:** `contracts/src/CommunityGrants.sol:460-505, 935-957`
**Category:** gov

**Bug:** `executeProposal` flow:
1. `_pruneAndGetRollingDisbursed()` (L482) — prunes expired entries, returns current rolling.
2. Cap check (L484).
3. `_transferETHOrWETH` (L487) — if it returns false, revert and return.
4. `_recordDisbursement` (L494) — only if transfer succeeded.

If the transfer fails (returns false at L490), the proposal is moved to `FailedExecution` — but the disbursement is NOT recorded. Repeated failed-execution attempts via `retryExecution` re-prune and re-cap-check, but never actually record. So an attacker could in principle queue disbursements via failed-transfer recipients to "test" how much budget is available without consuming the rolling window.

This is more theoretical than practical (`_transferETHOrWETH` falls through to WETH wrap, which is unlikely to fail), but worth noting as a defensive observation. The buffer-full DoS introduced by DEEP-GOV-V2-05's parent (DEEP-GOV-05) is the inverse: legitimate disbursements DoS the rolling window, but failed disbursements never count toward it.

**Recommendation:** Add `_recordDisbursement` to the FailedExecution path too — record the *attempt*, not the success. This way the rolling window tracks committed-budget rather than disbursed-budget. But note this would also change the semantic of `MAX_ROLLING_DISBURSEMENT_BPS` from "maximum disbursed in 30 days" to "maximum committed in 30 days". Pick one and document it.

---

## Summary

- **High:** 1 (DEEP-GOV-V2-01 — committedPower lockup on pair-disable)
- **Medium:** 4 (DEEP-GOV-V2-02 commit-side validation, V2-03 past-epoch topWeight scan, V2-04 emission leak persists, V2-05 O(n) gas)
- **Low:** 6 (V2-06 isRevealWindowOpen view, V2-07 voter veto on removal, V2-08 sock-puppet leader lock, V2-09 1-day-deadline cancel hole, V2-10 commit/reveal cap asymmetry, V2-11 holdsToken catch fallback)
- **Info:** 1 (V2-12 failed-transfer rolling-window bookkeeping)

**Top priorities:**
1. **DEEP-GOV-V2-01** — `committedPower` monotonic lockup is a real fund-loss / DoS primitive. The C2 fix needs a companion abandon-stuck-commit path, OR `committedPower` decremented on bond forfeit.
2. **DEEP-GOV-V2-04** — DEEP-GOV-03 still leaks emissions at any non-50% top dominance. Switch to true renormalization (option-a) to make the budget invariant hold.
3. **DEEP-GOV-V2-03** — Past-epoch relative-weight reads silently mis-attribute when a gauge is removed. Either snapshot per epoch or document the limitation explicitly.
4. **DEEP-GOV-V2-05** — O(n) topWeight scan on every relative-weight read becomes O(N²) once an emission distributor consumes it. Cache per-epoch top.
5. **DEEP-GOV-V2-11** — `holdsToken` try/catch fallback degrades sybil resistance to known-broken behavior on revert. Remove the fallback; fail closed.
