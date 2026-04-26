# Agent 018 — GaugeController.sol Audit

Target: `contracts/src/GaugeController.sol`
Cross-checks: `contracts/test/GaugeController.t.sol`, `contracts/test/GaugeCommitReveal.t.sol`
Hunt: vote-weight manipulation, commit-reveal griefing, reveal deadline bypass, gauge-add front-run, weight normalization drift, overflow on cumulative weight, owner gauge-remove rugging, missing sanity caps, vote-period boundary attacks, vote duplication via proxy, time-weighted average voting power exploits.

---

## HIGH

### H-1: Owner can rug active votes via `executeRemoveGauge` mid-epoch (already-voted gauges silently lose weight tracking)
File: `GaugeController.sol:486-503`

When a gauge is removed mid-epoch via `executeRemoveGauge()`, voters who already cast votes for that gauge in the current epoch keep their `gaugeWeightByEpoch[epoch][gauge]` recorded, but:
- `getRelativeWeight()` continues to compute `(gaugeWeight * BPS) / totalWeight` against `totalWeightByEpoch[epoch]` for a now-disabled gauge. Total is NOT decremented when a gauge is removed.
- Future voters in the same epoch can no longer vote for it (`isGauge[g] == false` causes `InvalidGauge` revert), but the totalWeight already includes the removed gauge's votes.
- Net effect: **all remaining gauges are diluted** because the removed gauge's votes still count toward the denominator. `sum(getRelativeWeight(g)) < BPS`. Emission budget is under-distributed.

Mitigation: require gauge removal to take effect only at the start of the next epoch (analogous to Curve's `change_gauge_weight` boundary), OR decrement `totalWeightByEpoch[epoch] -= gaugeWeightByEpoch[epoch][gauge]` and zero the gauge weight on removal, OR refuse removal if current-epoch weight > 0.

The 24-hour timelock provides advance notice but does not technically prevent the rug — owner can wait for the reveal window to end and remove a winning gauge before downstream emission distributors read `getRelativeWeight()`. If any consumer reads weights for a past epoch via `getRelativeWeightAt`, the dilution persists historically.

Severity: **HIGH** (owner action; trust-minimization ask is to make timelock + boundary semantics atomic).

### H-2: `cancelAddGauge`/`cancelRemoveGauge` do not clear pending state on `_cancel` failure path; replay possible if proposal expires
File: `GaugeController.sol:474-477, 505-508`

`cancelAddGauge` calls `_cancel(GAUGE_ADD)` which reverts with `NoPendingProposal` if no pending exists, then sets `pendingGaugeAdd = address(0)`. However, when `_cancel` reverts, `pendingGaugeAdd` retains the stale value. **More concerning**: if a proposal expires (>7 days past `executeAfter`), `_execute` reverts with `ProposalExpired` and there is no path to re-propose without first cancelling — but `cancelAddGauge` works fine in that case because `_executeAfter[GAUGE_ADD]` is still non-zero, so the cancel succeeds. State machine is functionally correct. **Downgrade to LOW after rechecking** — leaving here as a noted INFO.

Severity: **LOW** (re-classified — see L-2).

---

## MEDIUM

### M-1: Commit-reveal griefing — committer never reveals, NFT-owner cannot vote that epoch
File: `GaugeController.sol:303-327`

A user `commitVote()`s, then never reveals. `commitmentOf[tokenId][epoch]` stays set, and `hasVotedInEpoch[tokenId][epoch]` is never flipped. So far this is fine — that NFT just gets no vote.

However, **if the NFT is sold/transferred mid-epoch** (during the commit window), the new owner cannot commit because `commitmentOf[tokenId][epoch] != bytes32(0)` causes `AlreadyCommitted` revert. The new owner is locked out of voting with that NFT for the rest of the epoch even though they own it. The original committer can also no longer reveal (ownership check at reveal time fails), so the vote is dead. **Buyer assumption that NFT carries vote rights is broken silently** for one epoch.

Mitigation: on NFT transfer, allow new owner to overwrite a pending commitment (track committer separately and let new owner cancel/replace), OR document that buying a staking NFT mid-commit-window forfeits voting that epoch.

Test gap: no test in `GaugeCommitReveal.t.sol` covers the transfer-mid-commit scenario.

Severity: **MEDIUM**.

### M-2: `commitVote` lock-end check is insufficient — lock can expire before reveal window
File: `GaugeController.sol:320-321, 366-367`

`commitVote()` validates `block.timestamp < lockEnd`. But the reveal window opens 6 days later. A position with `lockEnd ∈ [commitTime, revealOpens + REVEAL_WINDOW]` will pass commit's check, then fail reveal's `LockExpired` revert. Vote is silently dropped despite a successful commit, and the user has no on-chain way to recover. Worst case: a voter with full voting power at epoch start commits expecting to influence emissions, but their NFT lock expires day 5/7 — vote is lost.

Mitigation: in `commitVote`, require `lockEnd >= epochStartTime(epoch) + EPOCH_DURATION` (i.e., lock must outlive the entire epoch), so any valid commit is guaranteed revealable.

Test gap: not covered.

Severity: **MEDIUM**.

### M-3: Voting power snapshot reads pre-genesis returns 0 — `votingPowerAtTimestamp(user, 0)` is brittle
File: `GaugeController.sol:222`

`votingPowerAtTimestamp(msg.sender, epochStartTime(epoch))` for `epoch == 0` resolves to `epochStartTime(0) == genesisEpoch == (block.timestamp / 7d) * 7d` at deploy time. Stakers who staked **before** the gauge controller was deployed have checkpoints at their stake timestamp. If `genesisEpoch < stakerCheckpointTimestamp`, `upperLookup(genesisEpoch)` returns 0 because the most-recent checkpoint at-or-before genesis doesn't exist for that user. They silently revert `ZeroVotingPower` for epoch 0.

The test suite **explicitly hides this** via `vm.warp(block.timestamp + 7 days)` at line 68 to skip epoch 0. Production deploy will exhibit the same: stakers who staked between genesisEpoch's start-of-week and the contract deploy block will have checkpoints AFTER `epochStartTime(0)` and **cannot vote in epoch 0**.

Mitigation: skip epoch 0 by setting `genesisEpoch = ((block.timestamp / 7d) + 1) * 7d` (next week start) so all existing stakers have valid checkpoints for epoch 0's start. OR fall back to live `votingPowerOf` when `votingPowerAtTimestamp` returns 0 AND user has any active position.

Severity: **MEDIUM**.

### M-4: Epoch-start snapshot does NOT prevent flash-stake/vote/unstake when staker has prior checkpoint
File: `GaugeController.sol:220-223`

The TF-04 fix correctly snaps voting power to `epochStartTime(epoch)`. However, `votingPowerAtTimestamp` uses `upperLookup` — it returns the **most recent** checkpoint `<= ts`. If a user already has any prior position with a checkpoint before epoch start, that prior power is what's read. They can still flash-stake more later in the epoch, vote (still bounded by epoch-start power, OK), but the **`amount > 0 && lockEnd > now` check is on the FLASH POSITION, not the snapshot position**. A user could:
1. Hold expired/zero-amount position A (checkpoint exists with old power).
2. Stake position B (new position, big amount, new lockEnd).
3. `vote(tokenIdB, ...)` — passes `LockExpired` check (uses tokenId B's lockEnd), passes `votingPower != 0` (snapshot from position A's old checkpoint, may be non-zero if position A had power at epoch start), votes with **stale snapshot power**.

This is unlikely to be profitable (snapshot power is bounded), but the lock-validity check uses a **different position's lockEnd** than the snapshot uses to attribute power. Architectural inconsistency. The lockEnd check should probably reference the snapshot semantics (was-active-at-epoch-start) rather than the live tokenId.

Severity: **MEDIUM** (correctness/consistency rather than direct exploit).

### M-5: No sanity cap on per-gauge weight or `totalWeightByEpoch`; cumulative overflow theoretically possible
File: `GaugeController.sol:69, 242-243, 388-389`

`totalWeightByEpoch[epoch]` accumulates `votingPower` across all voters. With `MAX_TOTAL_GAUGES = 50`, `MAX_GAUGES_PER_VOTER = 8`, and ~unbounded voters, `votingPower` is up to `type(uint256).max` per voter. In Solidity 0.8.26, addition will revert on overflow rather than wrap, so funds are not stolen, but **a single attacker with `votingPower ≈ type(uint256).max` could DoS the entire gauge by voting first**. Subsequent voters' `gaugeWeightByEpoch[epoch][gauge] += allocatedPower` would overflow. Not exploitable in practice (TOWELI supply is finite), but no upper bound check.

Severity: **LOW** (theoretical; downgrade) — see L-3.

---

## LOW

### L-1: `getRelativeWeightAt` allows reading future-epoch (epoch > currentEpoch) — returns 0
File: `GaugeController.sol:431-435`

No bounds check on `epoch`. Caller passing a future epoch gets 0 silently. Not exploitable, but downstream consumers reading "next epoch's weight" will misbehave if they don't validate. INFO-level.

### L-2: `cancelAddGauge` / `cancelRemoveGauge` clear pending pointers AFTER `_cancel`; if `_cancel` reverts, pointer persists
File: `GaugeController.sol:474-477`

If owner calls `cancelAddGauge()` when no proposal exists, `_cancel` reverts but `pendingGaugeAdd` retains stale value. Next `proposeAddGauge` overwrites it cleanly, so functionally OK. Cosmetic.

### L-3: `MAX_TOTAL_GAUGES = 50` × `MAX_GAUGES_PER_VOTER = 8` interaction with array iteration
File: `GaugeController.sol:39-40, 493-498`

`executeRemoveGauge` does a linear swap-and-pop. At 50 gauges, ~50 SLOAD/SSTORE = ~5k-10k gas. Acceptable. `getGauges()` returns a 50-entry array — fine for view calls.

### L-4: `votingPowerOf` per-EOA but `hasUserVotedInEpoch` keyed by `msg.sender`; smart-wallet-routed votes from different `tx.origin` accounts but same wallet collapse to one vote
File: `GaugeController.sol:206, 237`

The C2 fix protects against a contract holder amplifying votes across multiple NFTs it owns. But `hasUserVotedInEpoch[msg.sender][epoch]` keys on the calling address. Two **distinct** EOAs each owning one staking NFT can each vote — fine. A single Safe holding 5 NFTs votes once with aggregated power — also fine, this is the intended fix. **However**: a user could deploy 5 EOAs, transfer one NFT to each, and each EOA votes independently. The per-user guard does not prevent multi-EOA Sybil. This is a fundamental property of NFT-based voting and not a bug, but it's worth documenting that the C2 mitigation does NOT bound voting by economic weight per human — only by NFT-holding contract.

### L-5: `commitmentOf` and `committerOf` not cleared on commit-then-no-reveal; storage bloat over time
File: `GaugeController.sol:323-324`

Stale `commitmentOf[tokenId][pastEpoch]` entries persist forever (no reveal = no clear). At 8B users × ~52 epochs/year × 32 bytes = ~13 GB of dead state on a public chain. Practically irrelevant for this scale, but no cleanup path. INFO.

---

## INFO

### I-1: `MAX_GAUGES_PER_VOTER = 8`, `MAX_TOTAL_GAUGES = 50` — hardcoded with no admin lever
Documented; acceptable. Mention in deployment runbook.

### I-2: `pause()` does not pause `executeAddGauge` / `executeRemoveGauge` / emission budget execution
Owner timelock actions can still fire while the contract is paused. This is intentional (owners need to manage during emergencies) but worth documenting. Voting (`vote`, `commitVote`, `revealVote`) IS pause-gated.

### I-3: `getTokenVotes` returns last-vote allocations regardless of epoch
File: `GaugeController.sol:438-440`. View returns `_tokenVotes[tokenId]` which holds whichever epoch's vote was last applied. No epoch annotation. Frontend-only concern.

### I-4: Commit-reveal hash binds to `block.chainid` and `address(this)` (good), but salt entropy is voter-supplied — reusing salt across epochs leaks no info but also gains nothing
Acceptable.

### I-5: `currentEpoch()` underflow if `block.timestamp < genesisEpoch`
File: `GaugeController.sol:168-170`. Cannot happen in practice (genesisEpoch is set in constructor at `block.timestamp`-aligned), but worth a static-analyzer suppression note.

---

## TEST GAPS

1. **No test for gauge-removal mid-epoch dilution** (H-1). Add: vote, remove gauge, check `sum(getRelativeWeight) == BPS`.
2. **No test for transfer-during-commit-window lockout** (M-1). Add: commit, transfer NFT, new owner attempts to commit and reveal — should clarify expected behavior.
3. **No test for lock expiring between commit and reveal** (M-2). Add: stake with short lock, commit, warp past lockEnd but inside reveal window, reveal — assert behavior.
4. **No test for epoch-0 voting from prior-deploy stakers** (M-3). Currently masked by `vm.warp(+7 days)` in `setUp`. Add: stake immediately after deploy at `genesisEpoch`, attempt to vote in epoch 0, assert behavior.
5. **No test for stale-snapshot exploit** (M-4). Add: position A (active), then expire A, stake position B fresh, vote with B — verify behavior.
6. **No test for `getRelativeWeightAt` future epoch** (L-1).
7. **No test for `executeAddGauge` after `MAX_TOTAL_GAUGES` reached** (L-3 boundary).
8. **No fuzz test on weight normalization** — invariant `sum(getRelativeWeight(g) for g in gauges) == BPS` when totalWeight > 0.
9. **No test for gauge-add front-run via cancel race** — owner proposes A, racer (owner-only, so N/A externally; only relevant if multisig signers race).
10. **No test asserting `hasUserVotedInEpoch` blocks contract holder with N NFTs from amplifying** (the C2 fix has no positive-coverage test).
11. **No test for paused vote(): `commitVote`/`revealVote` should also revert when paused** (whenNotPaused is present, but no explicit revert assertion).

---

## SUMMARY

- **HIGH**: 1 (gauge-remove mid-epoch dilutes denominator)
- **MEDIUM**: 4 (commit-reveal grief on transfer; commit-time lock window insufficient; epoch-0 snapshot blind spot; flash-stake snapshot/lock-check inconsistency)
- **LOW**: 5
- **INFO**: 5
- **TEST GAPS**: 11
