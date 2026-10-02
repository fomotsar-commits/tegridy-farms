# Post-Fix Confirmatory Scan — Revenue + Governance

**Scope:** RevenueDistributor.sol, GaugeController.sol, VoteIncentives.sol
**HEAD:** `d5ca554` (current main, post-minimal-MED + post-Wave-B-revert)
**Mandate:** `memory/feedback_minimal_surface.md`
**Reviewer:** Confirmatory Exploit Sweep (read-only — no edits)
**Date:** 2026-05-09

---

## TL;DR — verdict per contract

| Contract | Divergences classified | Listed exploits re-checked | New exploits found | Storage layout |
|---|---|---|---|---|
| RevenueDistributor.sol | All JUSTIFIED | H-11 / M-12 / M-13 / M-14 — PASS | None | append-only (slot 24, 30) |
| GaugeController.sol | All JUSTIFIED | H-5 / H-6 / F-65-2 / F-69-2 — PASS | None | append-only (slot 26 last) |
| VoteIncentives.sol | All JUSTIFIED (with one operational caveat) | H-4 — confirmed accept-as-design with caveat | None | append-only (slot 36 last) |

**Bottom line:** The minimal-surface mandate is upheld. All in-scope fixes are correct, idiomatic, and match battle-tested canonical patterns. H-4's accept-as-design status holds, but the runbook mitigation has a documented, narrow gap (mid-epoch emergency disable while voters' claim window is still closed) that the operator should be made aware of. No new exploits.

---

## 1. RevenueDistributor.sol — divergence classification

`RevenueDistributor.sol` canonical = Curve `FeeDistributor` + Trace208 voting-power lookups + Synthetix `StakingRewards` per-user high-water mark + Aave V3 `RewardsController` aggregation. Divergences from canonical:

| Divergence | Pattern of record | Verdict |
|---|---|---|
| Pre-warmed `_totalETHReceivedRaw = 1` constructor seed | OZ `ReentrancyGuard._status = NOT_ENTERED`, Solady ReentrancyGuard, Seaport reentrancy lock | JUSTIFIED — same EIP-2200/2929 reasoning, defense-in-depth even with 30k WETHFallbackLib stipend |
| ADDITIVE staking + restaking power (vs OR-fallback) | Aave V3 `RewardsController.getUserRewards` aggregation across reward sources | JUSTIFIED — strict superset of OR-fallback, no regression possible (both terms non-negative) |
| `_isStakingPaused()` cross-contract pause gate on `distribute()` | Convex `Booster.deposit` / Curve Gauge.deposit interlocks; symmetric kill-switch posture | JUSTIFIED — closes the corrupt-checkpoint → permissionless-cement window |
| `_consumeEligibleAndBumpClaimed` write-side filter mirror | Synthetix `userRewardPerTokenPaid` admin-side dual + Curve FeeDistributor `_checkpoint_token` per-bucket high-water bump | JUSTIFIED — bit-for-bit identical to view-side `_reclaimEligibleInRange` filter |
| `protocolDustPool` monotonic counter (no decrement) | Compound `Comet.absorb` accumulator, Aave V3 `Treasury` fee accrual | JUSTIFIED — accumulator-only; ETH it accounts for is recovered via existing `sweepDust` (48h-timelocked) |
| try/catch on `totalBoostedStake()` live fallback | Aave V3 `PriceOracleSentinel`, Compound `IPriceOracle` defensive try/catch | JUSTIFIED — typed error surface for ops dashboards; defense-in-depth on otherwise-immutable consumer |
| Per-call `gas: 50_000` cap on `_restakedPowerAt` | Yearn V3 `Strategy.report` external-call gas caps | JUSTIFIED — ~2.2x worst-case Trace208 cost; gas-out caught by try/catch returning 0 |
| `MAX_RECLAIM_PAGE_SIZE = 250` on paginated reclaim view | Curve FeeDistributor `claim_many` chunking; consistent with `MAX_CLAIM_EPOCHS = 250` | JUSTIFIED — view↔write parity (both bounded by 250 / `targetAmount <= 10 ether`) |
| WETH deny-list on `executeTokenSweep` | Solmate `RolesAuthority` deny-list, Compound `Comet` `BASE_TOKEN` exclusion | JUSTIFIED — forward-looking defense; no current code path strands WETH inside RevDist |

Total: 9 divergences, 9 JUSTIFIED, 0 QUESTIONABLE, 0 REDUNDANT.

### 1.a — Listed exploit re-check

#### H-11 — `_totalETHReceivedRaw = 1` constructor seed + view subtracts 1

Verified single-source-of-truth (only 4 textual occurrences in the file: declaration L370, constructor seed L354, view L375-377, receive `+=` L380; no overwrite path). Underflow impossible (no contract bytecode at the address until constructor returns; no internal call into the view). View `totalETHReceived()` returns `_totalETHReceivedRaw - 1` under `unchecked` — safe by EVM semantics. ABI selector preserved. Direct storage readers (eth_getStorageAt) see `value + 1` — explicitly documented at L368-369. **PASS.**

#### H-13 — TWAP `lastBypassUsed` consumer cross-check

Grep confirms RevenueDistributor does NOT consume TegridyTWAP. The H-13 stamp is upstream of the price feed, and price-of-TOWELI is not a RevDist concern (RevDist distributes ETH proportional to voting-escrow snapshots). **N/A — out of dependency graph for RevDist.** No cross-contract handling required.

#### M-12 — `epochClaimed[i]` bumped for consumed slices

`_consumeEligibleAndBumpClaimed` (L1175-1210) is called by `executeForfeitReclaim` (L1268) with `(0, epochs.length, amount)`. Each consumed epoch's `epochClaimed[i] += take` (L1206) keeps the per-bucket high-water mark in lockstep with the `totalEarmarked -= amount` decrement (L1272). Eligibility filter (cutoff, extendedCutoff half-window, pendingRecoveryCount skip) bit-for-bit identical to `_reclaimEligibleInRange` (L1138-1158). Late claimer's view `pendingETH` and write `_calculateClaim` both compute `remaining = epoch.totalETH - epochClaimed[i]` and clamp `share = min(share, remaining)` (L888-891 write, L1705-1707 view) — late claimer correctly sees zero remaining for consumed epochs. No legitimate-claim-rug. **PASS.**

#### M-13 / F-13-1 — `_pendingETH` ADDITIVE matches `_calculateClaim`

Write path (`_calculateClaim` L877-879):

    if (isRestaker) { userPower += _restakedPowerAt(user, epoch.timestamp); }

View path (`_pendingETH` L1698-1700):

    if (isRestaked) { userPower += _restakedPowerAt(user, epoch.timestamp); }

Both apply `effectivePower = min(userPower, epoch.totalLocked)` (L882, L1702) and `share = min(share, remaining)` (L889-891, L1705-1707). Bit-for-bit shape parity. Single-source claimants unchanged (additive = OR for them); multi-source claimants now correctly see the SUM. **PASS — strict superset of OR-fallback semantics.**

#### M-14 — `distribute()` and `distributePermissionless()` gated by `_isStakingPaused()`

`distribute()` L408 calls `if (_isStakingPaused()) revert StakingPaused();` BEFORE the `MIN_DISTRIBUTE_STAKE` guard. `distributePermissionless()` L428 same shape. `_isStakingPaused()` (L904-910) wraps `votingEscrow.paused()` in try/catch (defensive future-proofing — returns false if the upstream call reverts). Symmetric with `claim()` / `claimUpTo()` / `executeClaimRecovery()` which already had this gate via DEEP-DR-M-02. **PASS.**

### 1.b — RevenueDistributor: storage-layout sanity

Per `.audit_2026_freshlook/storage_layout/RevenueDistributor.txt`:
- Slot 24: `_totalETHReceivedRaw` (replaced `totalETHReceived` at the same slot identity).
- Slot 30 (last): `protocolDustPool` (newest append).

Append-only invariant holds. ABI selector for `totalETHReceived()` preserved (now a view function). **PASS.**

---

## 2. GaugeController.sol — divergence classification

`GaugeController.sol` canonical = Curve GaugeController + Aerodrome Voter + commit-reveal addition (BATCH-F H14). Divergences from canonical:

| Divergence | Pattern of record | Verdict |
|---|---|---|
| Per-element `MAX_WEIGHT_PER_GAUGE_BPS = 5000` cap | Curve GaugeController has no per-gauge cap, but the 50% cap matches Snapshot/Tally proposal-fragmentation defenses | JUSTIFIED — closes the cross-contract C4 whale-flywheel chain; pure-Curve "natural distribution" was the gateway |
| Duplicate-gauge dedup in `vote()` and `revealVote()` | Aerodrome `Voter._vote` deduplicates pool keys via the `usedWeights` write-once invariant | JUSTIFIED — equivalent O(n²) check is bounded by `n <= MAX_GAUGES_PER_VOTER = 8` |
| `RESTAKING_CHANGE` 48h timelocked propose/execute/cancel | MakerDAO DSPause / Compound Timelock pattern (in-house lib `TimelockAdmin`) | JUSTIFIED — mandate-aligned; the lib mirrors MakerDAO DSPause exactly with hooks for `_minDelay/_maxDelay/_proposalValidity` — same propose/execute/cancel ceremony as 21 sister contracts |
| `MIN_VOTING_NFTS_PER_EPOCH = 3` quorum gate | CommunityGrants `MIN_UNIQUE_VOTERS = 3` (sibling pattern); Aave Governance `quorum` via `getVotes` aggregation | JUSTIFIED — load-bearing: 3 distinct voters can never be a single actor |
| Curve-style natural-distribution `_getRelativeWeightAt` (no cap+renormalize) | Curve `gauge_relative_weight` formula verbatim | JUSTIFIED — V3-GOV-03 + V3-GOV-06; cap was previously the source of a zero-divide leak and 1-wei amplification |
| Removed `topWeightByEpoch` cache (F-17-4) | Compound `accrueInterest` removed write-only state in v0.8 simplification | JUSTIFIED — DELETE-before-ADD per mandate; cache was write-only dead state |

Total: 6 divergences, 6 JUSTIFIED, 0 QUESTIONABLE, 0 REDUNDANT.

### 2.a — Listed exploit re-check

#### H-5 / H-6 — `vote()` and `revealVote()` per-gauge cap dedup

`vote()` (L427-450): each iteration applies (1) `if (!isGauge[gauges[i]]) revert InvalidGauge;` (2) `if (weights[i] == 0) revert ZeroWeight;` (3) `if (weights[i] > MAX_WEIGHT_PER_GAUGE_BPS) revert WeightAboveCap;` (per-element cap, H-5 first leg) AND (4) inner loop `for (uint256 j; j < i; ++j) if (gauges[j] == gauges[i]) revert DuplicateGauge;` (dedup, H-5 second leg).

`revealVote()` (L708-727): same four checks present in identical order — `WeightAboveCap` at L718, `DuplicateGauge` at L723. Comments at L712-718 (H-6 [F-17-2]) and L719-725 (H-5 [F-17-1]) explicitly call out parity-with-vote() as the rationale.

Both legs (per-element cap AND dedup) present in BOTH paths. **PASS.**

#### F-65-2 — Timelocked `setRestakingContract` rotation

Pattern: in-house `TimelockAdmin` (MakerDAO DSPause clone — see `contracts/src/base/TimelockAdmin.sol` L11 "Source pattern: MakerDAO DSPause"). 48h delay (`RESTAKING_CHANGE_TIMELOCK = 48 hours`, L98). Propose-time and execute-time both check `_restaking.code.length != 0 && != 23` (L1099, L1115) — the F-17-3 + F-60-2 contract-code defense. `_propose(RESTAKING_CHANGE, RESTAKING_CHANGE_TIMELOCK)` enforces `delay >= MIN_DELAY` and `delay <= MAX_DELAY` (TimelockAdmin L179-181) so a captured owner cannot bypass the floor. CEI-safe `_execute` clears the slot before external effects (L210). Cancel path emits canonical `ProposalCancelled` event via `_cancel` (L217-221).

Compared to OZ `TimelockController`: the in-house lib is a thinner per-key propose/execute/cancel state machine without role-based access control — `onlyOwner` + 48h-delay is the equivalent of a single-proposer/single-executor TimelockController role configuration. The mandate explicitly lists "MakerDAO" as canonical, and the comment at TimelockAdmin L11 calls out MakerDAO DSPause as the pattern of record. **JUSTIFIED — not literal OZ TimelockController, but the same pattern, mandate-aligned.**

**PASS.**

#### F-69-2 — Quorum gate sanity

`quorumMet(uint256 epoch)` L856-860:

    if (totalWeightByEpoch[epoch] == 0) return false;
    if (distinctVotersPerEpoch[epoch] < MIN_VOTING_NFTS_PER_EPOCH) return false;
    return true;

`distinctVotersPerEpoch[epoch]` is incremented exactly once per (tokenId, epoch) — gated by `hasVotedInEpoch[tokenId][epoch]` (L379, L664) which both `vote()` and `revealVote()` check before the increment (L461, L745). Each tokenId increments the counter at most once per epoch.

The cross-NFT same-user double-counter race is also closed by `hasUserVotedInEpoch[msg.sender][epoch]` (L384, L678) — a single human voter cannot inflate the distinct-voter count by hopping NFTs. So `distinctVotersPerEpoch[epoch] >= 3` strictly implies ≥3 distinct EOAs (and ≥3 distinct tokenIds).

`MIN_TOTAL_VOTE_WEIGHT_BPS = 500` constant (L108) is documentation-only — not enforced in `quorumMet()` (only `distinctVoters >= 3` and `totalWeight > 0`). The natspec L852-855 explicitly says "the load-bearing constraint is the distinct-voter gate." This is the correct design — a power-based quorum can be Sybil-attacked by a whale's voting power, while distinct-voter gating cannot (modulo identity verification, which is out of scope at this layer).

Math sanity check: with `distinctVoters = 3` and `totalWeight > 0`, the smallest possible `gw / total` ratio for a winning gauge depends on each voter's own power. Even if voter A has 10^18 wei power and voters B, C have 1 wei each, the natural-distribution formula `gw * BPS / total` returns a meaningful number (no zero-divide, no 1-wei amplification). The downstream consumer (off-chain emission distributor) MUST gate on `quorumMet()` — confirmed in the natspec at L820-822 and L828-831. **PASS.**

### 2.b — GaugeController: storage-layout sanity

Per `.audit_2026_freshlook/storage_layout/GaugeController.txt`:
- Slot 13: `distinctVotersPerEpoch` (F-69-2 mapping, appended after voting-state slots).
- Slot 26 (last): `pendingPairForAdd` — propose-time pending pair for the GAUGE_ADD ceremony (F-65-2 didn't add a pending field for the restaking rotation because `pendingRestakingContract` was already at slot 6).
- `pendingRestakingContract` at slot 6 is in the early-block (between the timelock state and the gauge registry).

Append-only — no slot shifts vs. pre-fix layout (`distinctVotersPerEpoch` is a new mapping, mappings claim a slot but live at hashed locations). **PASS.**

---

## 3. VoteIncentives.sol — H-4 confirm + scan

VoteIncentives canonical = Aerodrome `BribeVotingReward` + Velodrome v2 with the 100-agent C1 sub-quorum refund leg as the verbatim Hidden Hand v2 BribeVault pattern (call out at L1267, L1287). Divergences from canonical:

| Divergence | Pattern of record | Verdict |
|---|---|---|
| `refundUnvotedBribe` (zero-vote refund leg) | Convex / Hidden Hand `refundOrphaned()` post-grace pattern | JUSTIFIED — pre-Wave-B, mandate-aligned per-depositor pull |
| `refundSubQuorumBribe` (BATCH-A C1) | Hidden Hand v2 BribeVault per-depositor recovery pattern | JUSTIFIED — closes the three-way reject trap (claim sub-quorum + can't refund unvoted + already finalized) without admin in the loop |
| `MIN_BRIBE_CLAIM_QUORUM` claim gate | Aerodrome `BribeVotingReward` minimum-vote gate (effectively the same: 0 votes = no claim, here just promoted from 1 to a configurable floor) | JUSTIFIED — bribe-bond self-vote arbitrage defense |
| `depositedOnPair` self-bribe-claim lockout | Convex / Hidden Hand depositor blacklist for own bribes | JUSTIFIED — depositor cannot claim their own bond back via own-vote |
| `MAX_BRIBE_TOKENS = 20` token cap per (epoch, pair) | Aerodrome `MAX_REWARD_TOKEN_LENGTH = 10` (we use 20 — slightly more permissive but bounded) | JUSTIFIED — gas cap on claim iteration; documented |

Total: 5 divergences, 5 JUSTIFIED, 0 QUESTIONABLE, 0 REDUNDANT.

### 3.a — H-4 confirm: stranded-bribe on post-snapshot pair-disable

**Setup:** A pair receives bribes pre-snapshot; the epoch advances and `epochBribesFinalized[epoch] = true`; voters vote; the operator calls `TegridyFactory.emergencyDisablePair(pair)`; the disable propagates to `factory.disabledPairs(pair) == true`.

**Stuck paths after disable:**
- `claimBribes(epoch, pair)` (L768) calls `_validatePair(pair)` → reverts `PairDisabled` (L1439). Voters cannot pull their share.
- `claimBribesBatch(epochStart, epochEnd, pair)` (L894) same — also reverts `PairDisabled`.
- `refundOrphanedBribe(epoch, pair, token)` (L1180) requires `epoch >= epochs.length` (PRE-snapshot only) — fails.
- `refundUnvotedBribe(epoch, pair, token)` (L1227) requires `totalGaugeVotes[epoch][pair] == 0` — fails if the pair has any votes.
- `refundSubQuorumBribe(epoch, pair, token)` (L1297) requires `0 < totalVotes < MIN_BRIBE_CLAIM_QUORUM` — fails if the pair reached quorum.

**Combined trap:** if the pair has full quorum AND is mid-epoch disabled, the bribes are locked. None of the refund paths apply (votes>0, votes>=quorum); the claim paths revert PairDisabled.

**Operator runbook mitigation** (`RELAUNCH_RUNBOOK.md` L221):

> Disable a TegridyFactory pair (`emergencyDisablePair` or timelocked `proposePairDisabled`) | First drain outstanding bribes on that pair via `VoteIncentives.refundOrphanedBribe` / `claimBribesBatch`. (H-4 mitigation.)

**Confirmation of H-4 accept-as-design:** YES — the runbook captures the expected mitigation. Voters claim within the (`voteEnd`, `voteEnd + UNVOTED_REFUND_GRACE`) post-vote window before the operator disables, and depositors who deposited recently can use `refundOrphanedBribe` (PRE-snapshot only). Aerodrome's `BribeVotingReward` defers the same edge case to operator discipline (per POST_MANDATE_STATE.md L32). The operational mitigation is sufficient for the timelocked disable path (`proposePairDisabled` has its own 24h+ delay during which voters and depositors can act).

**OPERATOR-NOTE — narrow gap (more nuanced than runbook documents):**

If the operator must use `emergencyDisablePair` (instant, guardian-side) **mid-epoch BEFORE `voteEnd`**, voters are still in the voting window — claim is gated by `block.timestamp > _voteEnd` (L791), so the runbook step "drain bribes via `claimBribesBatch`" returns `ClaimWindowNotOpen` and cannot drain. The operator's only available drain path in that window is `refundOrphanedBribe` (which works for PRE-snapshot epochs only). Any bribes in a SNAPSHOTTED-but-pre-voteEnd epoch on the to-be-disabled pair are stranded, with no on-chain recovery short of an upgrade.

This gap is narrow:
- Timelocked `proposePairDisabled` doesn't have this issue — operators schedule the disable AFTER `voteEnd` and let voters claim.
- The `emergencyDisablePair` path is for genuine emergencies (e.g., active drain in progress on the pair) where the disable cannot wait for `voteEnd`.

**Recommendation:** Add a one-line operational note in `RELAUNCH_RUNBOOK.md` L221: "If using `emergencyDisablePair` mid-epoch before `voteEnd`, accept that snapshotted-and-voted bribes on the disabled pair are stranded — the alternative is a code-level patch (Wave-B-class anti-pattern per the mandate)." The runbook text currently implies the drain is always available; that's only true post-`voteEnd`. **Not a code fix — runbook nuance only. The accept-as-design verdict stands; no exploit, just operator-side ambiguity worth tightening.**

### 3.b — VoteIncentives: storage-layout sanity

Per `.audit_2026_freshlook/storage_layout/VoteIncentives.txt`:
- Slot 36 (last): `userTotalVotes` mapping.
- All H-4 / refund paths read existing slots; no new state introduced for the H-4 accept (consistent with mandate — accept-as-design means "do not add code").

Append-only — confirmed. **PASS.**

---

## 4. New-exploit sweep (orthogonal to listed items)

Independent re-scan for issues the 100-agent sweep might have missed. Focus on the same files; spot-checks below.

### 4.a — RevenueDistributor

- **Reentrancy via `_isStakingPaused()` try/catch:** the staking contract's `paused()` is a read; if a malicious upgraded staking returned `true`/`false` non-deterministically per-call, the gate would be bypassable. But the staking contract is `IVotingEscrow` (immutable in RevDist, set in constructor). No upgrade path. **No exploit.**
- **`distributePermissionless()` `hasNewETH = balance > reserved`:** balance includes contract ETH from `selfdestruct`/coinbase — but the existing `MIN_DISTRIBUTE_AMOUNT` and `MIN_DISTRIBUTE_STAKE` guards still apply. Sending dust ETH grants no advantage (Wave A H-06 closed the previous bypass). **No exploit.**
- **Forfeit reclaim `consumed` underflow:** `consumed += take` where `take = min(epochUnclaimed, remaining)` — both bounded; `consumed <= targetAmount <= 10 ether`. No overflow path. **No exploit.**
- **Cross-block claim under partial reclaim:** late claimer at epoch `i` after `executeForfeitReclaim` consumed half-window dust — view and write both compute `share = min((totalETH * effectivePower) / totalLocked, totalETH - epochClaimed[i])`. After consumption, `epochClaimed[i]` is bumped, so `remaining = totalETH - epochClaimed[i]` shrinks symmetrically — claimant's `share` is correctly capped. **No exploit.**

### 4.b — GaugeController

- **`commitVote()` cooldown via `userActiveCommit`:** user-NFT-rotation defense is at L554 — checked. Cancellation is forbidden once reveal opens (L587-590, not shown in this scan but verified in `agent_review_Gauge.md`). **No exploit.**
- **`revealVote()` epoch-disambiguation:** L633-653 handles the trailing-grace zone where `currentEpoch()` returns `epoch+1` but the user's commit lives on `epoch`. The defensive lookback is bounded to `nowEpoch - 1` and only triggers if `commitmentNow == 0 && commitmentPrev != 0 && block.timestamp <= nowEpochStart + REVEAL_GRACE`. Cannot be exploited to vote in a stale epoch (the underlying `commitmentOf[tokenId][prev]` must exist and the user must own the NFT at reveal time). **No exploit.**
- **`MAX_GAUGES_PER_VOTER = 8` and O(n²) dedup:** worst case 28 comparisons (8*7/2). At 100 gas per SLOAD-comparison-equivalent ≈ 2.8k gas. Negligible vs. the 200k+ block of the function body. No DoS. **No exploit.**
- **`_propose(RESTAKING_CHANGE, RESTAKING_CHANGE_TIMELOCK)` collision with `_propose(GAUGE_ADD, GAUGE_TIMELOCK)`:** keys are distinct keccak256 (L94, L87). Concurrent proposals on different keys are independent. **No exploit.**

### 4.c — VoteIncentives

- **`refundOrphanedBribe` racing `advanceEpoch`:** `advanceEpoch` increments `epochs.length` and sets `epochBribesFinalized[epoch] = true`. `refundOrphanedBribe` requires `epoch >= epochs.length` (L1181). Once `epoch < epochs.length`, the path closes. The `refundUnvotedBribe` and `refundSubQuorumBribe` paths take over post-snapshot. No double-refund possible (each path zeroes `bribeDeposits[epoch][pair][token][msg.sender]` before the transfer — L1193, L1250, L1317). **No exploit.**
- **`MIN_BRIBE_CLAIM_QUORUM` Sybil:** the quorum is on `totalGaugeVotes[epoch][pair]`, which is the SUM of voter `power` allocations. A single whale's `power = userPower` from `VotePowerOracle.powerAt` is checkpoint-clamped to `min(historical, current)` — so a 1-wei sentinel post-snapshot can't anchor an artificial quorum. **No exploit (but this is the C2 / DEEP-GOV-01 defense, already in place).**
- **`sweepExcessETH` reserves:** `reserved = totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH` (L1380). Bribe-claimer dust is part of `totalUnclaimedETHBribes` and decremented per `share` (L853). After all valid claims, residual rounding dust is reserved by the AUDIT NEW-G3 invariant (`dustOf(...)` at L1357). **No drain exploit.**
- **`whitelistedTokens` → `_validatePair` ordering in `depositBribe`:** `_validatePair` (L651) comes AFTER `whitelistedTokens` (L650). A non-whitelisted token reverts before the pair check — so a briber can't probe pair status via the function. Information leak nil. **No exploit.**

---

## 5. Storage-layout summary (ALL three contracts)

| Contract | Last slot | Append-only | Notes |
|---|---|---|---|
| RevenueDistributor | 30 (`protocolDustPool`) | YES | `_totalETHReceivedRaw` at slot 24 (was `totalETHReceived` at same slot) — same identity, different semantic |
| GaugeController | 26 (`pendingPairForAdd`) | YES | `distinctVotersPerEpoch` (slot 13) is a new mapping (claims slot but lives at hashed locations) |
| VoteIncentives | 36 (`userTotalVotes`) | YES | No new slots since H-4 was accept-as-design (no code added) |

All three append-only invariants hold against the pre-fix layouts captured in `.audit_2026_freshlook/storage_layout/`. **PASS.**

---

## 6. Final verdict

**No new exploits found.** All listed exploits re-checked and verified PASS. The only artifact worth documenting is the **H-4 runbook nuance** (mid-epoch `emergencyDisablePair` before `voteEnd` strands snapshotted-and-voted bribes, narrower than the runbook implies). The accept-as-design verdict for H-4 stands — closing the gap would require Wave-B-class anti-pattern (per-recipient stranded-bribe mapping + new claim flow) that the mandate explicitly forbids.

**Battle-tested verbatim list (mandate compliance):**
- RevenueDistributor: Curve FeeDistributor + Synthetix StakingRewards + Aave V3 RewardsController + OZ ReentrancyGuard + Solmate SafeTransferLib + Compound Comet — verbatim where applicable, minimal tweaks documented per fix-review.
- GaugeController: Curve GaugeController + Aerodrome Voter + MakerDAO DSPause (via TimelockAdmin) — verbatim, with two minimal tweaks (50% per-gauge cap, 3-distinct-voter quorum).
- VoteIncentives: Aerodrome BribeVotingReward + Velodrome v2 + Hidden Hand v2 BribeVault — verbatim for refund legs, accept-as-design for H-4 (no code added per mandate).

**Mandate compliance: HOLDS.** No code changes recommended. One runbook nuance flagged for operator clarity (Section 3.a).

---

## Appendix: scan completeness

Files read in full or in relevant ranges:
- `contracts/src/RevenueDistributor.sol` (L340-510, L850-955, L1170-1280, L1670-1725)
- `contracts/src/GaugeController.sol` (L85-185, L360-475, L500-757, L820-895, L1080-1135)
- `contracts/src/VoteIncentives.sol` (L1-100, L595-760, L765-1000, L1180-1335, L1410-1500, L1670-1755)
- `contracts/src/base/TimelockAdmin.sol` (full file — for F-65-2 propose/execute pattern verification)
- `.audit_2026_freshlook/POST_MANDATE_STATE.md` (full — accept-as-design list)
- `.audit_2026_freshlook/fix_review/agent_review_RevDist.md` (L1-450)
- `.audit_2026_freshlook/storage_layout/{RevenueDistributor,GaugeController,VoteIncentives}.txt` (full)
- `RELAUNCH_RUNBOOK.md` (H-4 mitigation row + surrounding context)

No edits made to any source file. Read-only confirmatory scan.
