# Audit 017 — VoteIncentives.sol

**Agent:** 017 / 101 (Forensic, AUDIT-ONLY)
**Target:** `contracts/src/VoteIncentives.sol`
**Cross-checked:** `contracts/test/VoteIncentives.t.sol`, `contracts/test/GaugeCommitReveal.t.sol`
**Date:** 2026-04-25

---

## Counts

| Severity | Count |
| --- | --- |
| HIGH | 3 |
| MEDIUM | 4 |
| LOW | 4 |
| INFO | 5 |

---

## HIGH

### H-017-1 — Snapshotted epochs with zero gauge votes permanently lock all deposited bribes
**File:** `VoteIncentives.sol`, `claimBribes` L507-588, `refundOrphanedBribe` L879-901
**Class:** funds-locked / missing finalize.

`refundOrphanedBribe` is gated by `require(epoch >= epochs.length, "EPOCH_ALREADY_SNAPSHOTTED")`. Once `advanceEpoch()` runs against an epoch's slot, the refund path is permanently closed for that epoch. If, during the 7-day `VOTE_DEADLINE`, no voter calls `vote()`/`revealVote()` for a bribed pair (or the bribe is for a niche pair the LP cohort ignores), then:

* `claimBribes` reverts on `totalVotesForPair == 0 → NothingToClaim`.
* `refundOrphanedBribe` reverts on `EPOCH_ALREADY_SNAPSHOTTED`.
* `sweepToken`/`sweepExcessETH` cannot touch the funds (reserved by `totalUnclaimedBribes`/`totalUnclaimedETHBribes`).

Result: depositor's bribe is permanently bricked in contract storage, **with no admin or depositor recovery path**. This is a realistic outcome for any pair without organic voter interest — exactly the long tail bribers target.

**Recommendation:** add a post-deadline (`block.timestamp > epochs[epoch].timestamp + VOTE_DEADLINE`) per-depositor refund branch when `totalGaugeVotes[epoch][pair] == 0`. This preserves the no-owner-drain invariant but unlocks the only failure mode the current `refundOrphanedBribe` doesn't cover.

---

### H-017-2 — Legacy `vote()` epochs fully expose see-bribes-then-vote arbitrage
**File:** `VoteIncentives.sol`, L371-395 (`vote`).
**Class:** gauge front-run / bribe arbitrage.

`commitRevealEnabled` defaults `false`. Until owner runs the propose+24h+execute flip, every snapshotted epoch records `usesCommitReveal == false` and reaches `vote()`. `vote()` allows users to allocate power any time within 7 days after snapshot, which means:

1. Briber A deposits 10 ETH to pair P at T-1.
2. `advanceEpoch()` at T snapshots `usesCommitReveal=false`.
3. Voter watches mempool. At T+6.99d (just before deadline) sees: gauge votes for P = 0, gauge votes for Q = 100k. Switches all power to P → captures the entire 10 ETH undiluted.
4. Other voters who voted earlier for Q get nothing extra from P.

The H-2 commit-reveal mitigation explicitly references this attack but is gated behind a still-toggled-off admin switch (verified: no test ever enables it in `setUp`; only `_enableCommitReveal()` does it). All currently produced epochs are exposed.

The `MIN_EPOCH_INTERVAL = 7 days == VOTE_DEADLINE` makes this slightly worse: the entire interval between snapshots IS the voting window, with no enforced quiet period.

**Recommendation:** auto-enable commit-reveal at deployment (constructor sets `commitRevealEnabled=true`), or shrink `VOTE_DEADLINE` so the see-and-react window is sub-block. Failing that, document operationally that legacy epochs MUST not accept material bribes.

---

### H-017-3 — Token-list slot DoS: 20× 1-wei ERC20 deposits brick MAX_BRIBE_TOKENS for a pair-epoch
**File:** `VoteIncentives.sol`, `depositBribe` L404-456, `MIN_BRIBE_AMOUNT` L80, `minBribeAmounts` L223.
**Class:** bribe griefing / DoS.

`MIN_BRIBE_AMOUNT = 0.001 ether` is **only** enforced in `depositBribeETH`. The ERC20 path (`depositBribe`) only enforces `minBribeAmounts[token]` IF the owner has explicitly populated that mapping (no setter currently exists in this file — see also setter-missing INFO below). With a default of 0, `depositBribe` accepts a 1-wei deposit of any whitelisted token, which:

1. Pushes that token into `epochBribeTokens[epoch][pair]` (length+=1).
2. Counts toward `MAX_BRIBE_TOKENS = 20`.

20 cheap whitelisted-token deposits (whitelist contains TOWELI by construction; whatever else owner adds) fully exhausts the slot list for `epoch=epochs.length`, the FUTURE epoch. Legitimate bribers in the same epoch then revert with `TooManyBribeTokens`. The attacker repeats every epoch for ~$0 cost.

The dust still incurs gas + the 3% fee on dust → economic cost ≈ gas. On L2 deployments (target chain not declared in this file but factory pattern suggests EVM L2) this is sub-cent per attack epoch.

**Recommendation:** apply a **default** non-zero `MIN_BRIBE_AMOUNT_TOKEN` floor to `depositBribe` (e.g., scaled by token decimals via the existing `minBribeAmounts` mapping but with a non-zero default fallback), AND add a setter for `minBribeAmounts` (currently no public function writes to that mapping — see INFO). Pattern: Velodrome's per-pool minBribe.

---

## MEDIUM

### M-017-1 — `epochBribes`/`bribeDeposits` mismatch on partial refund leaves ghost slots
**File:** `refundOrphanedBribe` L879-901.

When a single depositor refunds, `bribeDeposits[...][msg.sender] = 0` and `epochBribes[...] -= amount`. But `epochBribeTokens[epoch][pair]` is NEVER pruned. If all depositors of a token refund, the token address persists in the array. On a hypothetical post-fix path that lets an orphaned epoch be re-deposited or that someone races into the same `epochs.length` index, the dead token stays counted toward `MAX_BRIBE_TOKENS`. Not directly exploitable in the current state machine because the orphaned epoch index becomes "snapshotted" on next advance (the deposit slot moves), but a future refactor could trip on it.

**Recommendation:** prune `epochBribeTokens[epoch][pair]` when `epochBribes[epoch][pair][token] == 0` after refund.

---

### M-017-2 — `refundOrphanedBribe` does not refund the 3% fee already paid to treasury
**File:** `depositBribe` L424-430, `depositBribeETH` L468-474, `refundOrphanedBribe` L879-901.

Fee on deposit is irreversible (treasury already credited). Depositor whose bribe is orphaned (epoch never advanced for 30+ days) recovers `netBribe` only. Treasury keeps the 3% on a service that was never rendered (no voters, no claimers). Misaligned incentives — treasury profits from epoch stagnation it controls (admin holds the keeper role implicitly).

**Recommendation:** track `bribeFeesPerDeposit[epoch][pair][token][depositor]` and refund the fee component on `refundOrphanedBribe`. If treasury already drained ETH via `withdrawTreasuryFees`, the contract may not have ETH to cover — design choice: either reverse-credit on `refundOrphanedBribe` (revert if insufficient) or reduce `accumulatedTreasuryETH` synchronously.

---

### M-017-3 — `currentEpoch()` / deposit-into-future-epoch race vs `advanceEpoch`
**File:** `currentEpoch` L354-356, `depositBribe` L433, `advanceEpoch` L325-351.

Briber inspects `currentEpoch() == N`, broadcasts `depositBribe(pair, token, amt)`. Permissionless `advanceEpoch()` lands first → `epochs.length` jumps to N+1 → briber's deposit lands in slot N+1 (now the future, not the just-snapshotted one). Voters who already voted on N get nothing from this bribe; voters on N+1 do, but those voters may not yet exist. Briber loses negotiated influence. No on-chain warning — the deposit silently re-targets the next epoch.

**Recommendation:** add `expectedEpoch` parameter to `depositBribe`/`depositBribeETH`. Revert with `EpochMismatch` if `epochs.length != expectedEpoch`. Mirror Aave's deadline-on-deposit pattern.

---

### M-017-4 — `vote()`/`revealVote` cap-exceed uses `require` string, missing custom error & `EXCEEDS_POWER` not in errors block
**File:** L388, L1103.

`require(... <= userPower, "EXCEEDS_POWER")` — string-based revert defeats the custom-error gas-and-clarity policy used elsewhere. More substantively, callers cannot match it via selector in tests (the suite doesn't test the edge case where `userTotalVotes + power == userPower + 1`). Combined with M-017-3, a briber who is also the voter could budget power across epochs incorrectly without a typed-error early warning.

**Recommendation:** add `error ExceedsPower(uint256 currentTotal, uint256 add, uint256 cap);` and replace both `require` sites.

---

## LOW

### L-017-1 — Dead state: `epochBribeFirstDeposit` written but never read
**File:** L197 declaration, L447-449 / L490-492 writes. No reader.

Bookkeeping leftover from the previous "first-deposit triggers rescue" design. With `epochBribeLastDeposit` now driving the rescue gate (correctly, per AUDIT NEW-G2), `epochBribeFirstDeposit` is gas-paid storage with zero read sites in the contract. Verified across the file: no reads.

**Recommendation:** delete the variable and its writes.

---

### L-017-2 — `enableCommitReveal()` deprecated stub is `view` — owner could call it cheap as part of failed-flow detection but it pollutes the ABI
**File:** L1192-1194.

`function enableCommitReveal() external view onlyOwner { revert("USE_PROPOSE_ENABLE_COMMIT_REVEAL"); }`. `view` + `revert` is an unusual pairing. ABI consumers may special-case this. Minor.

**Recommendation:** drop `view`, keep the descriptive revert (other deprecated stubs in this file already do, e.g., L907).

---

### L-017-3 — `sweepExcessETH` and `sweepToken` do not validate `treasury != address(0)` at sweep time
**File:** L925-949.

If a treasury rotation is partially applied (timelocked) and then-current `treasury == address(0)` for any reason (constructor enforces non-zero, and `proposeTreasuryChange` enforces non-zero, so realistically unreachable), sweep would burn funds. Defensive only.

**Recommendation:** assert `treasury != address(0)` at the top of both sweeps.

---

### L-017-4 — `commitVote` accepts arbitrary `commitHash` (including `bytes32(0)`)
**File:** L1035-1063.

Unlike `GaugeController.commitVote` (which has a `ZeroCommitment` error — see test `test_commit_revertsOnZeroHash`), this contract's `commitVote` does not reject `bytes32(0)`. A user could grief themselves with a hash that nobody can match (`computeCommitHash` cannot return 0 over realistic inputs, but a malicious frontend could). Not exploitable against others — only against the user's own bond — and `sweepForfeitedBond` cleans up post-deadline. Still inconsistent with `GaugeController.sol`.

**Recommendation:** mirror the GaugeController check: `if (commitHash == bytes32(0)) revert ZeroCommitment();`.

---

## INFO

### I-017-1 — `setMinBribe` setter for `minBribeAmounts` is missing
The mapping is declared (L223), read in `depositBribe` (L418-421), but the contract has **no** function to write it. The mapping is effectively `0` for all tokens forever. The H-7 fix is therefore inert in its current implementation. Combined with H-017-3, this is the latent path that makes the dust-DoS realistic.

**Recommendation:** add `setMinBribeAmount(address token, uint256 minAmount) external onlyOwner` (timelocked or not — choice depends on threat model). The audit comment at L416-421 references this as "defense in depth" but the setter is absent.

---

### I-017-2 — `MIN_DISTRIBUTE_STAKE = 1000e18` blocks epoch advancement at low-TVL bootstrap
At very low total boosted stake (< 1000 TOWELI), `advanceEpoch` reverts `NoStakers`. Bribes deposited during this window pile into the un-snapshotted future epoch and may eventually become eligible for `refundOrphanedBribe`. Acceptable, but worth surfacing to UI.

---

### I-017-3 — `MAX_CLAIM_EPOCHS=500` and `MAX_BATCH_ITERATIONS=200` interaction
A user with 500 voted epochs and 0 tokens per epoch passes the `>500` check but iterates 500 outer-loop times. Each outer loop with `tokens.length == 0` does no inner iterations, so `totalIterations` stays low. No DoS, but worth a fuzz test.

---

### I-017-4 — `commitDeadline`/`revealDeadline` boundary at `block.timestamp == cd`
Neither commit nor reveal accepted at the exact `cd` second. Window: commit `(snapshot, cd]`, reveal `(cd, rd]`. The strict-inequality boundary creates a 1-second no-action zone at `cd`. Cosmetic.

---

### I-017-5 — `accumulatedTreasuryETH` untouched on `refundOrphanedBribe`
Per M-017-2, fees stay in treasury accumulator on refund. The accumulator can drift below the depositor-fee invariant if M-017-2 is implemented naively.

---

## Test Gaps

| # | Missing test | Rationale |
| --- | --- | --- |
| T-1 | "Snapshotted-epoch with no votes locks bribes" | Confirms H-017-1. Deposit, advance, no vote, warp >7d, expect both `claimBribes` revert AND `refundOrphanedBribe` revert. |
| T-2 | "20× 1-wei deposits → MAX_BRIBE_TOKENS DoS" | Confirms H-017-3. Whitelist 21 tokens, deposit 1 wei of each, expect 21st deposit `TooManyBribeTokens`. Suite has `test_maxBribeTokensCap` but uses 100e18 deposits — masks the dust angle. |
| T-3 | "Front-run advanceEpoch shifts deposit to next epoch" | Confirms M-017-3. Two-tx test with `vm.startStateRecord`/`vm.expectEmit`, asserting deposit lands on `epochs.length` AFTER advance. |
| T-4 | "Legacy vote() last-second arbitrage" | Confirms H-017-2. Two voters, one votes early, attacker votes at `snapshot + VOTE_DEADLINE - 1`, asserts attacker captures full bribe share. |
| T-5 | "Refund preserves 3% fee — treasury keeps fee on orphaned epoch" | Confirms M-017-2. Currently nothing tests the asymmetry. |
| T-6 | "`bytes32(0)` commit hash" | Confirms L-017-4 (and locks in the missing check if added). |
| T-7 | "EXCEEDS_POWER edge cases" | Confirms M-017-4. Test `userTotalVotes + power == userPower` (allowed) vs `... + 1` (revert). |
| T-8 | "Permissionless `advanceEpoch` minimum-power boundary" | Confirms I-017-2. `totalBoostedStake == MIN_DISTRIBUTE_STAKE - 1` reverts; `== MIN_DISTRIBUTE_STAKE` passes. |
| T-9 | "ERC20 minBribeAmounts setter missing" | Confirms I-017-1. `vi.minBribeAmounts(token)` always 0 because there's no public path to set it. |
| T-10 | "Multiple commits same hash, separate indexes" | Edge case: confirm `commitVote` allows duplicate hashes, both reveal independently, both bonds refunded. |

---

## Summary

VoteIncentives is well-defended against the simple attack vectors (FoT via balance-diff, USDT via try/catch+`_safeTransferExternal`, owner-drain via per-depositor pull, mempool front-run via commit-reveal). The remaining surface is **coverage**: the commit-reveal mitigation only matters if owner flips the switch, and the orphaned-bribe pull only works while the epoch is unsnapshotted. The combination of these two leaves a real lock-in window (H-017-1) and a real arbitrage window (H-017-2) that depends on operational discipline rather than code-enforced safety. Add the no-vote refund branch, ship commit-reveal on by default, and add a non-zero default ERC20 `MIN_BRIBE_AMOUNT` (H-017-3) and the surface tightens substantially.
