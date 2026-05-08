# Agent 69 — Governance Attack Lens (Fresh-Eyes Audit)

**Scope**: GaugeController.sol, VoteIncentives.sol, CommunityGrants.sol, MemeBountyBoard.sol, RevenueDistributor.sol, plus the staking-side `votingPowerOf` / `votingPowerAtTimestamp` aliasing in TegridyStaking.sol & TegridyRestaking.sol, and the shared `lib/VotePowerOracle.sol`.

**Date**: 2026-05-07
**Mode**: read-only fresh eyes; no .md history consulted; no edits.

---

## Summary

| ID     | Sev    | Title                                                                                      |
|--------|--------|--------------------------------------------------------------------------------------------|
| F-69-1 | MED    | Sequencer-down asymmetry: GaugeController + VoteIncentives + CommunityGrants lack outage-grace while MemeBountyBoard has it |
| F-69-2 | MED    | GaugeController has no minimum-voter / minimum-total-weight quorum — a 1-wei voter directs 100% of emission share when no other voter shows up |
| F-69-3 | MED    | Sybil-bribe-self via separate depositor address bypasses `depositedOnPair` lockout |
| F-69-4 | LOW    | `EpochInfo.totalPower` in VoteIncentives is captured at LIVE block.timestamp but `snapshotTime` is at `T - SNAPSHOT_LOOKBACK` — asymmetric (cosmetic; field is unused in claim math) |
| F-69-5 | LOW    | `extendLock` re-applies a higher boost on the same lock end, increasing voting power for an already-active vote/commit on past epochs (no exploit due to historical snapshot, but flag for hardening) |
| F-69-6 | INFO   | GaugeController `vote()` / `revealVote()` requires `tegridyStaking.ownerOf(tokenId) == msg.sender` — restakers cannot vote on gauges (intentional but needs explicit user-facing documentation) |
| F-69-7 | INFO   | MemeBountyBoard's `MIN_VOTE_BALANCE = 1000 ether` excludes any staker below 1000 raw TOWELI at 1x boost or 250 TOWELI at 4x — the "low-bar" docstring claim is misleading |
| F-69-8 | INFO   | The "exit-from-restake mid-epoch" boundary is sound, but creates a transient zero-power window for the user during the same-block transfer that prevents same-block voting (verified safe) |

---

## F-69-1 — MEDIUM — Sequencer-Down Asymmetric Defense

**Files**:
- contracts/src/GaugeController.sol — no sequencer feed
- contracts/src/VoteIncentives.sol — no sequencer feed
- contracts/src/CommunityGrants.sol — no sequencer feed
- contracts/src/MemeBountyBoard.sol:251–334 — has `SEQUENCER_OUTAGE_BUFFER` + `_sequencerBuffer()` helper that extends grace windows on `refundStaleBounty` and `emergencyForceCancel`

**Mechanism**:
MemeBountyBoard pulls sequencer-uptime info via `SequencerCheck.getSequencerOutageBuffer` and adds the `SEQUENCER_OUTAGE_BUFFER` (1h) to its grace windows so an outage doesn't cause honest creators/voters to lose work to a window that elapsed entirely while the chain was offline. The other three governance contracts have no equivalent.

**Manipulation**:
On L2, if the sequencer is unavailable for the duration of one of the following windows, governance breaks asymmetrically:
- **GaugeController reveal window (24h)**: a sequencer outage that overlaps the entire 24h reveal window means committers cannot reveal at all. Their commitments expire (no slot to consume since they never get a chance), bonds are NOT lost in GaugeController (no bond mechanism — only VoteIncentives has bonds), but their vote allocation is destroyed — gauge weights for that epoch are determined entirely by whoever could reveal (validators with priority access, archive nodes, etc.) once the sequencer resumes.
- **VoteIncentives reveal window (3d, 60% of VOTE_DEADLINE)**: same outage. Voters who committed lose their 10-TOWELI bond AND their vote application. `sweepForfeitedBond` after `revealDeadline` sends bonds to treasury — even though the sequencer-driven impossibility, not voter laziness, caused the missed reveal.
- **CommunityGrants 7d voting period**: votes blocked while sequencer down. A proposal that passes quorum based on votes cast before the outage can still be finalized; one that needed late votes is silently denied. No grace.

**Why this matters now**: This protocol's relaunch (per `project_relaunch.md`) targets an L2 deployment. Aave V3's standard sequencer-grace pattern is the industry baseline. MemeBountyBoard adopted it; the three more critical governance surfaces did not.

**Recommended hardening (out of scope, flagged for follow-up)**:
- Mirror `SequencerCheck.getSequencerOutageBuffer` into reveal-window gates in GaugeController + VoteIncentives.
- Extend CommunityGrants `VOTING_PERIOD` and `EXECUTION_DELAY` reads through the same helper when sequencer-feed is wired.
- The propose/execute timelocks in `TimelockAdmin` already rely on raw `block.timestamp`; the sequencer issue compounds when a timelocked critical change executes during an outage window with no voters available.

---

## F-69-2 — MEDIUM — Single-Voter Emission Capture in GaugeController

**Files**:
- contracts/src/GaugeController.sol:303–402 (`vote`)
- contracts/src/GaugeController.sol:543–667 (`revealVote`)
- contracts/src/GaugeController.sol:757–793 (`_getRelativeWeightAt`)
- contracts/src/GaugeController.sol:359, 632 (`votingPower == 0` is the only floor)

**Govt mechanism**:
`_getRelativeWeightAt(gauge, epoch) = (gaugeWeight * BPS) / totalWeight`. There is no minimum total-weight gate, and no minimum number-of-distinct-voters gate. The per-vote `MAX_WEIGHT_PER_GAUGE_BPS = 5000` (50%) cap forces a voter to spread across at least 2 gauges, but does NOT bound the total emission share captured by a single voter — across N gauges, one voter still controls 100% of `totalWeight`.

**Manipulation**:
1. Attacker stakes 1 wei of TOWELI for 7 days (minimum lock; `boostBps = 4000` = 0.4x). Voting power ≈ 0.4 wei.
2. Attacker is a legitimate LP-staker in two whitelisted gauges (gauge X, gauge Y) — small position is fine, even 1 wei of LP works in many gauge implementations.
3. No other voter shows up this epoch (low-engagement protocol, holiday weekend, post-launch ramp).
4. Attacker votes 50/50 on gauges X and Y. `gaugeWeightByEpoch[epoch][X] = 0.2 wei`. `totalWeightByEpoch[epoch] = 0.4 wei`. `_getRelativeWeightAt(X, epoch) = 0.2 * 10000 / 0.4 = 5000 BPS = 50%`.
5. `getGaugeEmission(X) = emissionBudget * 5000 / 10000 = 50% of emissionBudget`. Same for Y.

When an emission distributor consumes `getGaugeEmission` to route TOWELI emissions to LP stakers in gauges X/Y, the attacker captures 100% of the epoch's emission budget proportional to their LP share in X/Y. Their cost: 1 wei of TOWELI locked for 7d + the LP-position cost.

**Why the existing defenses don't help**:
- `min(historical, current)` clamp: attacker is a genuine 1-wei staker, both reads return ~0.4 wei. No clamp triggered.
- `committedPower` cap: applies to commit-reveal in VoteIncentives, not gauge controller. (GaugeController has its own commit-reveal but no committedPower equivalent — the cap is reached only at reveal-time `votingPower` re-clamp.)
- Per-vote per-gauge `MAX_WEIGHT_PER_GAUGE_BPS = 5000`: forces ≥2 gauges, doesn't reduce total share captured.
- Per-user `hasUserVotedInEpoch`: prevents same user voting twice; doesn't prevent the user being THE ONLY voter.

**Note**: No on-chain consumer of `getGaugeEmission()` was found in the current source tree (search returned only `GaugeController.sol` itself). The risk is forward-looking: any future emission distributor that reads `getGaugeEmission` inherits this single-voter capture surface unless it adds its own quorum gate.

**Recommended hardening (out of scope)**:
- Add `MIN_TOTAL_WEIGHT_FOR_DISTRIBUTION` (e.g., `MIN_DISTRIBUTE_STAKE / 10`) on `_getRelativeWeightAt` — return 0 (or an even-distribution fallback) when `totalWeight < threshold`.
- Add `MIN_DISTINCT_VOTERS` (e.g., 3, mirroring CommunityGrants' MIN_UNIQUE_VOTERS) as a precondition for any non-trivial relative-weight read.

---

## F-69-3 — MEDIUM — Sybil-Bribe-Self Bypasses `depositedOnPair` Lockout

**Files**:
- contracts/src/VoteIncentives.sol:317–327 (`depositedOnPair` mapping definition)
- contracts/src/VoteIncentives.sol:646–711 (`depositBribe`) and 715–759 (`depositBribeETH`) — set `depositedOnPair[msg.sender]` to true
- contracts/src/VoteIncentives.sol:805 (`if (depositedOnPair[msg.sender][epoch][pair]) revert SelfBribeClaimForbidden;`)
- contracts/src/VoteIncentives.sol:923 (same check in batch claim)

**Govt mechanism**:
The `depositedOnPair` lockout closes the trivial self-bribe-and-claim cycle for the SAME address. A briber `B` cannot vote on the pair they bribed; their claim reverts `SelfBribeClaimForbidden`. The intent (per the natspec at line 318) is to prevent "the path where a briber votes with their own VP and claims their own bond back proportionally."

**Manipulation**:
The lockout is keyed on `msg.sender` of the deposit — not on any KYC / on-chain identity link between depositor and voter. A trivial sybil setup defeats it:
1. Address `S` (sybil, no other on-chain footprint) holds a bribe of 10000 USDC. `S` calls `depositBribe(pairX, USDC, 10000e6)`. Net 9700 USDC after 3% fee. `depositedOnPair[S][epoch][pairX] = true`.
2. Address `A` (attacker, controls `S` off-chain) holds 100 TOWELI (just at MIN_BRIBE_CLAIM_QUORUM = 100e18 boosted equivalent — achievable at 25 TOWELI raw + 4x boost OR 100 raw + 1x boost).
3. `A` votes pair X with full 100e18 power. `gaugeVotes[A][epoch][pairX] = 100e18`. `totalGaugeVotes[epoch][pairX] = 100e18` (assuming no other voters; otherwise A's share is proportionally smaller).
4. After VOTE_DEADLINE, `A` calls `claimBribes(epoch, pairX)`. `depositedOnPair[A][epoch][pairX] = false` (A never deposited as A) → check passes. `share = 9700 * 100e18 / 100e18 = 9700 USDC` paid to A.

Net cost to attacker: 300 USDC fee + ~25 TOWELI staked at 4x lock (recoverable after lock end). Net gain: 9700 USDC bribe-self return + control of pair X's gauge vote.

**Why existing defenses don't help**:
- `MIN_BRIBE_CLAIM_QUORUM = 100e18`: attacker satisfies it with min stake of 25 TOWELI at 4x boost. Set too low to be a meaningful sybil deterrent.
- `SelfBribeClaimForbidden`: keyed on `msg.sender`, defeated by separate address.
- Multiple-voter cliff: if there are OTHER honest voters on pair X, they take a share of the 9700 USDC. The attack's profitability is bounded by `userVoteForPair / totalVotesForPair`. But on contested pairs the attacker still gets a proportional chunk back at 0% loss to other depositors.

**Severity assessment**: MEDIUM — not a direct theft, but breaks the documented intent of the depositor lockout. Combined with low MIN_BRIBE_CLAIM_QUORUM, allows a self-bribe-self-recover cycle whose only cost is the protocol fee. On contested pairs where the attacker holds significant `userVoteForPair` share, this is a useful subsidy on directional emission control.

**Recommended hardening (out of scope)**:
- Tie the lockout to a longer-lived identity than `msg.sender` (e.g., a hash of `tx.origin + block.coinbase` is poor; better is a registered-staker mapping).
- Raise `MIN_BRIBE_CLAIM_QUORUM` to a level where the cost-of-stake to satisfy it is a meaningful deterrent — Aerodrome's analogous gate is set proportional to total system stake, not a fixed constant.
- Consider a "voter-must-not-be-related-to-depositor" check via on-chain transfer-graph analysis (off-chain attestation; not free).

---

## F-69-4 — LOW — VoteIncentives.advanceEpoch Stores Asymmetric Snapshot

**File**: contracts/src/VoteIncentives.sol:528–570

**Govt mechanism**:
```solidity
uint256 totalPower = votingEscrow.totalBoostedStake(); // LIVE
uint256 snapshotTime = block.timestamp - SNAPSHOT_LOOKBACK; // 1h ago
epochs.push(EpochInfo({ totalPower: totalPower, timestamp: snapshotTime, ... }));
```

The `totalPower` stored in `EpochInfo` is the LIVE `totalBoostedStake()` at the moment of `advanceEpoch`, while `snapshotTime` is `block.timestamp - 1h`. Voters compute their per-user power at `snapshotTime` (correctly historical). The denominator and numerator are temporally mismatched.

**Manipulation**:
Cosmetic — `epoch.totalPower` is NOT consumed by any vote/claim/preview path. The actual claim denominator is `totalGaugeVotes[epoch][pair]` (sum of vote allocations), not `epoch.totalPower`. The natspec at line 65 documents the share formula as `(votingPowerAtTimestamp(user, epoch.timestamp) / epoch.totalPower) * bribeAmount` — this is OUT OF DATE with the v2 gauge-vote model where actual claims use `totalGaugeVotes` instead.

**Severity**: LOW — no on-chain exploit. The risk is downstream: any future code path or off-chain analytic that reads `EpochInfo.totalPower` and treats it as a historical denominator will be off by up to 1 hour of stake/unstake activity. Worth flagging for code-cleanup.

**Recommended hardening**:
- Either remove `totalPower` from `EpochInfo` (dead data) or pin it to `votingEscrow.totalBoostedStakeAtTimestamp(snapshotTime)` for symmetry with `RevenueDistributor._distribute` (line 390 of RevenueDistributor.sol uses the historical reader).

---

## F-69-5 — LOW — `extendLock` Increases Boost Without Re-Snapshotting Past Votes

**File**:
- contracts/src/TegridyStaking.sol:884–916 (`extendLock`)
- contracts/src/TegridyStaking.sol:1546–1552 (`_writeCheckpoint` — push-only Trace208)

**Govt mechanism**:
`extendLock` charges a fee, then bumps `lockDuration`/`lockEnd` and re-applies a higher boost via `_applyNewBoost`. After the call, `_writeCheckpoint(msg.sender)` pushes a new Trace208 entry with the higher voting power AT block.timestamp.

**Past epochs are unchanged** — the historical Trace208 reads at past timestamps return the OLD (lower) power. So extending lock does NOT retroactively inflate past votes.

**Manipulation flag (forward-looking)**:
A whale near a critical CommunityGrants deadline can:
1. Wait until just before voting closes on a 50%-treasury-grant proposal.
2. `extendLock` to increase their boost from 1x to 4x — voting power 4× live.
3. Vote with the now-4× power.

Per the snapshot rules:
- CommunityGrants: `proposal.snapshotTimestamp = createdAt - 1h`. Voter power = `min(historical at snapshotTimestamp, current)`. The `extendLock` happened AFTER snapshot → historical = pre-extend (1x). min = 1x. Defended.
- VoteIncentives: same min-clamp logic. Defended.
- GaugeController: `epochStartTime(epoch) - 1` as snapshot key. Lock-extend after epoch start does not retroactively inflate past power. Defended.

**Severity**: LOW — defended by the universal `min(historical, current)` clamp. Flagged here for completeness because the attack pattern (mid-window lock-extension) is one of the documented governance whale patterns and the defense relies entirely on the snapshot clamp being applied at every consumer. A future fork that drops the clamp at any one consumer reopens the path.

---

## F-69-6 — INFO — Restakers Cannot Vote on Gauges (Intended)

**File**: contracts/src/GaugeController.sol:309 (`if (tegridyStaking.ownerOf(tokenId) != msg.sender) revert NotTokenOwner;`)

**Govt mechanism**:
GaugeController's `vote()` and `commitVote()` both require `tegridyStaking.ownerOf(tokenId) == msg.sender`. After a user restakes, `ownerOf(tokenId) == restakingContract`, not the user. The user CANNOT vote on gauges with their restaked NFT — even though `VotePowerOracle.powerAt` returns positive power for them via the restaking-side fallback.

**Why this is INFO not a finding**:
The protocol's voting power for restakers comes from the restaking-side `boostedAmountAt`. But GaugeController explicitly requires direct NFT ownership for the token-id-based commitment binding. This is a deliberate design choice: gauge votes commit on a (tokenId, voter) pair so the historical owner-set correlation can be verified. Restakers participate in gauge votes via the restaking contract's own delegated mechanism (if one is ever wired) — currently they don't.

**Action**: Document this in user-facing docs / restaking UI. Restakers should be told their gauge-vote rights are temporarily forfeited for the duration of the restake, in exchange for the bonus yield. The other three governance surfaces (VoteIncentives, CommunityGrants, MemeBountyBoard) all DO accept restaker votes via the additive `VotePowerOracle.powerOf` path.

---

## F-69-7 — INFO — MemeBountyBoard MIN_VOTE_BALANCE Threshold Misleading

**File**: contracts/src/MemeBountyBoard.sol:69 (`MIN_VOTE_BALANCE = 1000 ether`)
**Docstring claim**: contracts/src/MemeBountyBoard.sol:59–68 (`AUDIT L-B01`) says "MIN_VOTE_BALANCE (1000 TOWELI) are intentionally LOW-BAR thresholds. The product intent is community-meme accessibility — a token holder with under-$10 worth of TOWELI should be able to participate."

**Govt mechanism**:
`voterPower = min(historical, current)` where both reads return BOOSTED amount. To pass `voterPower >= 1000e18`:
- 1000 raw TOWELI at 1x boost (= 0.4x for 7d minimum lock → 1000 * 0.4 = 400 fails).
- 2500 raw TOWELI at 1x base → 2500 * 0.4 = 1000 passes (4-year lock at minimum).
- 250 raw TOWELI at 4x boost (4-year max lock → 1000 boosted) passes.

**Issue**:
The docstring claim ("under-$10 worth of TOWELI") is misleading. At any reasonable TOWELI valuation post-launch, 250 TOWELI for 4 years OR 2500 TOWELI for 7 days is FAR more than $10 of locked capital cost. The actual gating is closer to "100s of TOWELI committed to a multi-year lock," which is a meaningful financial hurdle, not a low-bar accessibility filter.

This isn't a security issue per se — it's a documentation/UX mismatch. Flag for governance docs cleanup.

---

## F-69-8 — INFO — Restake Boundary Same-Block Window (Verified Safe)

**Files**:
- contracts/src/TegridyStaking.sol:1305–1378 (`_beforeTokenTransfer` + `_afterTokenTransfer`)
- contracts/src/TegridyRestaking.sol:504–590 (`_boostedAmountAt`)
- contracts/src/lib/VotePowerOracle.sol:64–101

**Mechanism reviewed**:
At the block where user `U` restakes NFT `N`:
- Staking `_writeCheckpoint(U)` pushes `(block.timestamp, 0)` (post-transfer power == 0).
- Restaking `_writeBoostCheckpoint(U, boostedAmount)` pushes `(block.timestamp, boostedAmount)`.

For OZ `Trace208.upperLookup(T)` queries:
- At `T == block.timestamp`: staking returns 0 (latest push at T with value 0). Restaking returns `boostedAmount` (latest push at T with that value).
- VotePowerOracle adds: `0 + boostedAmount = boostedAmount`. ✓ matches expected.

**For `T == block.timestamp - 1`** (e.g., GaugeController's `epochStartTime(epoch) - 1` snapshot if that boundary happens to be exactly the restake block):
- Staking `upperLookup(T-1)` returns the value at the previous push — pre-restake `boostedAmount` (user still held NFT before this block).
- Restaking `upperLookup(T-1)`: `info.depositTime > T-1` is true (depositTime == T) → returns 0.
- Sum = `boostedAmount + 0 = boostedAmount`. ✓ matches expected.

No double-count, no zero-window. Verified safe. Flagged only because it required careful trace.

---

## Notes / Dead Ends

### Investigated and dismissed:

1. **Multi-NFT vote splitting via per-tokenId guard**: `hasVotedInEpoch[tokenId]` PLUS `hasUserVotedInEpoch[user]` PLUS `userPositionCount(proposer) == 1` (CommunityGrants) close the multi-NFT amplification ring. Verified by tracing transfer-then-vote scenarios end-to-end.

2. **Vote-then-transfer-NFT**: After voting, `hasVotedInEpoch[tokenId][epoch]` blocks new owner from re-voting. The vote stays applied with the original voter's snapshot power. Works as intended.

3. **Lending hop voting power steal**: `_writeCheckpoint(from)` is unconditional on transfer (not exempt for lending hops). User's voting power → 0 immediately on lend-deposit. Verified at TegridyStaking.sol:1366.

4. **VoteIncentives `vote` lacks nonReentrant**: Confirmed — `vote(uint256,address,uint256)` at line 590 has only `whenNotPaused`. No external state-mutating calls inside; only view calls into staking/restaking via `VotePowerOracle`. No reentrancy surface. Same for `MemeBountyBoard.voteForSubmission` at line 454.

5. **`epoch.totalLocked` denominator skew across epochs in RevenueDistributor**: `_distribute` uses `totalBoostedStakeAtTimestamp(T-1)` as denominator. `_calculateClaim` uses `votingPowerAtTimestamp(user, epoch.timestamp)` plus `_restakedPowerAt(user, epoch.timestamp)` for numerator. Both share the `T-1` snapshot key per REV-M-01. Verified consistent.

6. **`forfeitCommitOnDisabledPair` caller restriction**: The G-01 fix at VoteIncentives:1665–1674 restricts callers to `msg.sender == user || msg.sender == owner()`. Closes the disabled-pair-then-reenable victim-commit-destroy attack. Verified.

7. **GaugeController `executeRemoveGauge` mid-epoch**: Refuses removal when current-epoch weight > 0. The `executeRemoveGaugeNextEpoch` escape path disables future votes immediately while preserving current-epoch emission distribution. Verified at GaugeController.sol:925, 966.

8. **CommunityGrants `holdsToken` fail-closed**: Reverts `HoldsTokenCheckFailed` if `votingEscrow.holdsToken(...)` reverts (per V2-GOV-11). Removes the legacy single-pointer fallback that was the M13 bypass. Verified at line 444.

9. **MIN_BRIBE_CLAIM_QUORUM as 1-wei-bribe defense**: A 1-wei voter cannot pass `totalVotesForPair >= MIN_BRIBE_CLAIM_QUORUM` (= 100e18). They need ≥100 raw TOWELI at 1x boost OR ≥25 raw TOWELI at 4x boost. Verified.

10. **Cross-protocol VP donation chain (lend NFT → bribe → vote → claim)**: Borrower's NFT is held by lending contract. Borrower's `votingPowerOf` = 0 (per-owner-set excluded). Cannot vote. Lending contract isn't governance-trusted as a voter (no `vote()` function). Verified safe.

### Not investigated (out of scope):
- TegridyLPFarming consumption of gauge weights (no on-chain consumer found in src/).
- Off-chain emission distributor that may read `getGaugeEmission` (not in scope, but flagged in F-69-2).
- Sequencer-feed wiring quality on the live deployment (depends on chain choice, not source).
