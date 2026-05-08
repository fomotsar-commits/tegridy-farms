# Agent 17/100 — GaugeController.sol Fresh-Eyes Review

**Target:** `contracts/src/GaugeController.sol` (1054 lines)
**Lens:** vote weight tally / gauge add+kill / type weights / total-weight invariants / commit-reveal interactions with bribes / cap bypasses
**Scope note:** H-2 commit-reveal *protocol* design is owned by Agent 18; this report covers commit-reveal **only where it interacts with weight accounting and the per-gauge cap.**

---

## F-17-1 — HIGH — `MAX_WEIGHT_PER_GAUGE_BPS` cap fully bypassed via duplicate gauge entries in legacy `vote()`

**Location:** `vote()` body, lines 366-399 (per-gauge cap check at 379, allocation loop at 391-399).

**Root cause:** the validation loop checks `weights[i] > MAX_WEIGHT_PER_GAUGE_BPS` (5000 BPS) per index, but does not deduplicate `gauges[i]`. The allocation loop then sums into `gaugeWeightByEpoch[epoch][gauges[i]]` — duplicates accumulate.

**Exploit (zero-skill, single tx):**
```
gauges  = [GauntletGood, GauntletGood, GauntletGood, GauntletGood,
           GauntletGood, GauntletGood, GauntletGood, GauntletGood]   // 8x same gauge
weights = [1250, 1250, 1250, 1250, 1250, 1250, 1250, 1250]            // sum = 10000
```
Per-index validation passes (`weights[i] = 1250 <= 5000`, all gauges whitelisted, `sum == BPS`). The allocation loop adds `votingPower * 1250 / 10000` eight times to the same gauge. Result: **100% of voter's voting power on a single gauge**, defeating the C4 mitigation entirely.

**Why it matters:** the inline rationale at lines 370-378 explicitly states the cap was added to prevent the cross-contract whale flywheel ("a majority voter could direct 100% of emissions to a self-controlled gauge same epoch they win a 50% treasury grant on CommunityGrants"). That precise attack remains live.

**Fix:** add an O(n²) dedup pre-check (n ≤ 8 so cost is bounded), OR maintain a per-gauge cumulative-weight map and check `cumulative[gauges[i]] + weights[i] <= MAX_WEIGHT_PER_GAUGE_BPS`. Curve / Velodrome pattern: dedup-or-cumulative is mandatory whenever a per-vote per-gauge cap is claimed.

---

## F-17-2 — HIGH — `revealVote()` does not enforce `MAX_WEIGHT_PER_GAUGE_BPS` at all (cap bypass without even needing duplicates)

**Location:** `revealVote()` validation loop, lines 634-641. Compare to `vote()` validation loop at 367-381.

**Root cause:** `vote()` enforces three per-element rules: (a) `isGauge[gauges[i]]`, (b) `weights[i] != 0`, (c) `weights[i] <= MAX_WEIGHT_PER_GAUGE_BPS`. `revealVote()` enforces only (a) and (b). The cap check is *missing*.

**Exploit (no duplicates needed):**
```solidity
gauges  = [evilGauge]
weights = [10000]                 // 100% to one gauge
hash    = computeCommitment(self, tokenId, gauges, weights, salt, epoch)
```
1. Voter calls `commitVote(tokenId, hash)` — passes (no power-cap on commit; only validates lock/ownership/duplicate-commit).
2. During reveal window, `revealVote(tokenId, [evilGauge], [10000], salt)` — passes the validation loop (no cap), allocates full voting power to `evilGauge`.

**Why it matters:** commit-reveal is the *canonical* voting path now (cap was a post-commit-reveal addition; per the inline note at 370-378, "single-gauge votes still allowed up to 50%"). With this gap, the cap can be unconditionally bypassed by any voter who uses commit-reveal — i.e. the path that the comment block at 404-422 says is the recommended forward path.

**Note re duplicates:** `revealVote` *also* lacks dedup, so even if F-17-2 were fixed by adding the per-element cap check, F-17-1's duplicate-bypass would still work in revealVote. Both fixes are needed.

**Fix:** mirror `vote()`'s loop exactly:
```solidity
if (weights[i] > MAX_WEIGHT_PER_GAUGE_BPS) revert WeightAboveCap();
```
plus the dedup/cumulative check from F-17-1.

---

## F-17-3 — MEDIUM — `setRestakingContract` accepts EOA, irreversibly bricks restaker voting

**Location:** lines 1048-1053.

**Root cause:** the one-shot setter validates `_restaking != address(0)` and `restakingContract == address(0)` but does not validate `_restaking.code.length > 0` (or EIP-7702 `code.length != 23` per the OwnableNoRenounce hardening). Setting it to an EOA causes `VotePowerOracle.powerOf` / `powerAt` to silently swallow the restaking-side read in the `try/catch`, so all restakers' aggregated voting power is permanently lost.

**Reference inconsistency:** `VoteIncentives.setGaugeController` at line 123 *does* enforce `require(_gaugeController.code.length > 0, "GC_MUST_BE_CONTRACT")`. Same pattern, missing here.

**Why MEDIUM:** owner footgun, but it's *one-shot* (`RestakingAlreadySet` at line 1050). A typo at deploy time is unrecoverable — the contract must be redeployed and every consumer re-wired.

**Fix:** add `require(_restaking.code.length > 0, "RESTAKING_MUST_BE_CONTRACT")` (or the typed-error EIP-7702-aware variant from `OwnableNoRenounce._transferOwnership` lines 99-100).

---

## F-17-4 — LOW — `topWeightByEpoch` / `topGaugeByEpoch` are write-only dead state (gas waste)

**Location:** state declarations at 132-133; `_updateEpochTop` at 798-804; called from `vote()` (line 398) and `revealVote()` (line 663).

**Root cause:** the inline NatSpec at 745-756 claims `_getRelativeWeightAt` reads the cache to be "O(1) per call instead of O(n) over the entire `gaugeList`." But the actual `_getRelativeWeightAt` body at 757-793 was rewritten (per the V3-GOV-03+V3-GOV-06 comment block) to use only `totalWeightByEpoch[epoch]` and `gaugeWeightByEpoch[epoch][gauge]` — neither `topWeightByEpoch` nor `topGaugeByEpoch` is read anywhere in the contract or any other in-tree consumer (`Grep` confirms 5 hits, all writes inside this contract).

**Cost:** each `vote()` / `revealVote()` does up to 8 redundant SSTOREs on `topWeightByEpoch[epoch]` and `topGaugeByEpoch[epoch]` — first call ~22.1k gas (cold-warm), subsequent ~5.1k (warm). Over 50 gauges and 1000 voters per epoch, this is ~tens of millions of gas/epoch wasted.

**Fix:** remove the `_updateEpochTop` calls and the two storage variables, OR re-introduce reads in `_getRelativeWeightAt` if a per-epoch top-weight is intentionally retained for some future cap mechanism. The NatSpec at 745-756 is also stale and contradicts the body.

---

## F-17-5 — INFO — `revealVote` epoch-derivation guard `block.timestamp >= nowEpochStart` is always true

**Location:** lines 560.

**Observation:** `nowEpoch = currentEpoch() = (block.timestamp - genesisEpoch) / EPOCH_DURATION`, and `nowEpochStart = genesisEpoch + nowEpoch * EPOCH_DURATION`. By integer-division identity, `block.timestamp >= nowEpochStart` always holds when `nowEpoch > 0` (and trivially when `nowEpoch == 0`). The guard simplifies to `nowEpoch > 0`.

**Impact:** none — the function still behaves correctly because the `block.timestamp <= graceBoundary` gate at 573 does the real lookback gating. But the comment at 561-567 implies the guard is doing work. Cleanup-only.

---

## F-17-6 — INFO — `executeRemoveGaugeNextEpoch` blocks all subsequent gauge removals until finalize

**Location:** `proposeRemoveGauge` at 902 (`if (pendingGaugeRemove != address(0)) revert GaugeRemovePending()`); `executeRemoveGaugeNextEpoch` at 966-984 leaves `pendingGaugeRemove` set per the comment at 981-982.

**Observation:** while a deferred-prune is staged (between `executeRemoveGaugeNextEpoch` and `executeRemoveGaugeFinalize`), the owner cannot stage another removal. Up to 7 days of admin lockout if the gauge had current-epoch votes when the next-epoch path was taken.

**Why INFO:** the synchronous `executeRemoveGauge` path is still available for any gauge with zero current-epoch weight, so the lockout is bounded to the specific case of "two gauges need removal, both have current-epoch votes." Documented owner power; not exploitable. Possibly worth rearchitecting to a queue/set of pending-removes for very-high-gauge-churn deployments.

---

## F-17-7 — INFO — `proposeEmissionBudgetChange` accepts `type(uint256).max` which would brick `getGaugeEmission` view

**Location:** lines 1020-1024 / 736-738.

**Observation:** `_newBudget` is unbounded. `getGaugeEmission(gauge)` computes `(emissionBudget * relWeight) / BPS`. With `emissionBudget = type(uint256).max` and any `relWeight > 0`, the multiplication overflows and the view reverts. Off-chain emission distributors that rely on this view would fail.

**Why INFO:** owner-only, 48-hour-timelocked, and the only consumer of `getGaugeEmission` is off-chain (no in-tree on-chain emission distributor reads it; `Grep` confirms zero on-chain consumers besides this contract). Pure footgun, recoverable via another timelocked propose.

---

## Dead-ends checked (no finding)

- **Reentrancy** at vote / commitVote / revealVote / cancelCommit: all `nonReentrant`; external calls are to staking/restaking via `VotePowerOracle` which is a `view` library — STATICCALL prevents reentrant state writes. Try/catch around restaking absorbs misbehavior. Clean.
- **NFT-transfer / ownership-flip mid-epoch:** legacy `vote()` and `revealVote()` both re-check `ownerOf(tokenId) == msg.sender` at action time. Transferring forfeits the vote; receiver cannot reveal because `committerOf[tokenId][epoch] != receiver`. Per-user `hasUserVotedInEpoch` is keyed on the *caller*, so a fresh receiver can vote independently with a different NFT only.
- **Multi-NFT amplification (C2 vector):** `hasUserVotedInEpoch[user][epoch]` correctly applied at `vote`, `commitVote` (reveal-time check), and `revealVote`. Closed.
- **Same-block-stake-then-vote (TF-04 boundary):** `epochStartTime(epoch) - 1` snapshot lookup excludes same-block stakes per OZ Trace208 `upperLookup`. Closed.
- **Restaker disenfranchisement (GOV-ECON-01 / C10):** additive read via `VotePowerOracle.powerAt/powerOf` in both vote sites. Closed.
- **Past-epoch top-weight invariant (V2-GOV-03):** the renamed cache is irrelevant since it's now dead state (F-17-4), but the actual current `_getRelativeWeightAt` is pure read-mostly and tolerant of post-epoch gauge removal.
- **Killed-gauge bribe interaction (cross to VoteIncentives):** `pairToGauge` mapping is cleared on both removal paths (lines 932-936, 976-980). VoteIncentives `_requireGaugedPair` (line 132 of VoteIncentives.sol) gates `depositBribe` on the mapping, so post-removal new bribes are rejected. Pre-existing bribes are out of scope (Agent 10 covers VoteIncentives).
- **Self-add gauge:** `proposeAddGauge` is `onlyOwner`. Voter cannot self-add.
- **EOA / non-contract gauge:** rejected at propose (`gauge.code.length == 0` revert at 839). Re-check at execute would be belt-and-suspenders but not exploitable post-Cancun (selfdestruct can't zero existing code).
- **Type-weight inflation:** no Curve-style "gauge type weights" exist in this contract — emissions are weighted directly per-gauge by vote tally over `totalWeightByEpoch[epoch]`. No type-sum invariant to violate.
- **Vote-loop gas DoS at vote/claim:** `MAX_GAUGES_PER_VOTER = 8` and `MAX_TOTAL_GAUGES = 50` cap inner loops. `gaugeList` swap-and-pop on remove keeps it dense. No unbounded iteration.
- **`commitVote` spam:** per-tokenId and per-user active-commit guards limit a user to one outstanding commit per epoch. No bond required, but no DOS surface either.
- **`cancelCommit` race:** `userActiveCommit` keyed by `msg.sender`, atomic. Time gate `block.timestamp + 2*REVEAL_GRACE >= revealOpens` correctly closes one full grace before any reveal can be admitted (R016 M-1 fix preserved).
- **`onERC721Received` hook:** GaugeController never custodies the staking NFT — vote-with-NFT reads ownership via `ownerOf`. No hook abuse surface.

---

## Recommended priorities

1. **F-17-1 + F-17-2 (HIGH)** — these compose: dedup is needed for `vote()`, full per-element cap mirror is needed for `revealVote`, and dedup is needed for `revealVote` too. Single PR, minimal risk, high impact (restores the entire C4 mitigation).
2. **F-17-3 (MEDIUM)** — one-line `code.length > 0` check on `setRestakingContract`. Closes the irreversible-footgun gap to match `setGaugeController`.
3. **F-17-4 (LOW)** — gas waste cleanup; rip out dead state and `_updateEpochTop` OR re-wire reads in `_getRelativeWeightAt`. The stale NatSpec at 745-756 should be fixed either way.
