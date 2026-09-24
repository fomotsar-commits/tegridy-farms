# Agent 11 — VoteIncentives.sol Vote-Snapshot / Double-Claim Audit

**Target:** `contracts/src/VoteIncentives.sol` (1789 lines)
**Related:** `contracts/src/lib/VotePowerOracle.sol`, `TegridyStaking.sol` (votingPowerOf / votingPowerAtTimestamp), `TegridyRestaking.sol` (`_boostedAmountAt`), `GaugeController.sol`
**Lens:** vote-weight snapshot vs live read, double-claim, cross-epoch reuse, address-vs-tokenId, EIP-712 replay, signed-claim, transferred-NFT replay, mapping collisions, killed gauge, multi-NFT split.

---

## F-11-1 — Stranded bribes + stranded votes when factory disables a pair AFTER snapshot/reveal (HIGH)

**Severity:** HIGH (functional fund / vote lock-up; not a theft, but a permanent freeze)
**Location:** `claimBribes` (line 777), `claimBribesBatch` (line 898), `revealVote` (line 1589), `refundUnvotedBribe` (line 1227-1264), `refundSubQuorumBribe` (line 1297-1331), `forfeitCommitOnDisabledPair` (line 1657-1725)

### Path
1. Briber deposits 10,000 USDC bribe in epoch `e` against pair `P` (line 651 `_validatePair(P)` passes — `P` is live).
2. `advanceEpoch()` snapshots `e` and finalizes the bribe pool (`epochBribesFinalized[e] = true`).
3. Voters legitimately vote on `P` during the vote window — `totalGaugeVotes[e][P]` grows past `MIN_BRIBE_CLAIM_QUORUM` (100e18).
   - In legacy mode: `vote()` (line 604) calls `_validatePair(P)` while `P` is live → recorded in `gaugeVotes[user][e][P]`.
   - In commit-reveal mode: `revealVote()` (line 1589) calls `_validatePair(P)` while `P` is live → same.
4. **AFTER the vote window closes** (or at any point the user has already revealed/voted), the factory's governance / guardian disables `P` via `factory.disabledPairs[P] = true`.
5. From this point onward, EVERY downstream code path that touches `P` reverts:
   - `claimBribes(e, P)` line 777 → `_validatePair(P)` → `revert PairDisabled` (line 1439).
   - `claimBribesBatch(...)` line 898 → same revert; the batch may also short-circuit before hitting other epochs depending on iteration order, gas-griefing legitimate batch claims even for unrelated epochs.
   - `refundUnvotedBribe(e, P, token)` line 1232 → `require(totalGaugeVotes[e][P] == 0, "PAIR_HAS_VOTES")` → reverts (votes ≥ quorum).
   - `refundSubQuorumBribe(e, P, token)` line 1305 → `require(totalVotes > 0 && totalVotes < MIN_BRIBE_CLAIM_QUORUM, "NOT_SUB_QUORUM")` → reverts (votes ≥ quorum).
   - `forfeitCommitOnDisabledPair(...)` line 1683 → `if (c.revealed) revert AlreadyRevealed();` — only works on UN-revealed commits. For users who already revealed (or any user in legacy `vote()` epochs), there is NO recovery path.

### Impact
- Bribes deposited on the pair are **permanently locked** (cannot be claimed by voters; cannot be refunded by depositors).
- Voters who allocated their `userTotalVotes[user][e]` budget to `P` have **lost that allocation** for epoch `e` — they cannot reclaim the power and re-cast it elsewhere because `userTotalVotes` is monotonic-per-epoch and capped at `userPower`.
- `totalUnclaimedBribes[token]` and `totalUnclaimedETHBribes` reservations keep growing — these reserved amounts are correctly excluded from `sweepToken`/`sweepExcessETH`, so the funds sit forever and are not even drainable to treasury through the legitimate sweep path. The result is a permanently dead allocation.
- The disable can be invoked by guardian (emergency, no timelock) or by governance, so this is reachable in normal operations — it is not solely a "captured admin" path.

### Why prior fixes don't cover this
- `forfeitCommitOnDisabledPair` was added for V2-GOV-01/02 (un-revealed commits during a transient disable). It does **not** cover the post-reveal / legacy-vote case.
- The depositor-side refund pair (`refundUnvotedBribe`, `refundSubQuorumBribe`) intentionally requires the votes to be 0 or sub-quorum — the BATCH-A C1 commentary at line 1267 calls out the THREE-WAY REJECT TRAP and explicitly closes only the sub-quorum branch. The "votes ≥ quorum AND pair later disabled" branch is the **fourth leg** that none of the existing refund/escape paths cover.
- The validation gate was added to `vote()` and `claimBribes` together (DEEP-GOV-08) explicitly to prevent voters from wasting `userTotalVotes` on dead pairs — but the symmetric problem (votes were valid AT VOTE TIME, pair dies LATER) was not addressed.

### Suggested fix
Two-pronged:
1. In `claimBribes` / `claimBribesBatch` / `revealVote`, replace the unconditional `_validatePair` call with a softened version that reverts only on the registered-pair check (factory.getPair mismatch / pair has no code), and **does not** revert solely because `factory.disabledPairs[pair] == true`. Distinct flag (e.g. `_assertRegisteredPair(pair)`) preserves the deposit-time disable check while letting historical claims/reveals/votes settle.
2. Add a fourth refund leg `refundDisabledPairBribe(epoch, pair, token)` for the (votes ≥ quorum AND `factory.disabledPairs(pair)` AND vote window passed) case, gated by the same `UNVOTED_REFUND_GRACE` window. Mirrors `refundUnvotedBribe` / `refundSubQuorumBribe`.

The current contract has every accounting field needed (`bribeDeposits[e][p][t][user]`) — only the gate is missing.

---

## F-11-2 — Wrong typed error in `applyMinBribeAmountChange` (LOW / cosmetic)

**Severity:** LOW
**Location:** `applyMinBribeAmountChange` line 1347

```solidity
if (amount > MAX_MIN_BRIBE_AMOUNT) revert ZeroAmount(); // BATCH-H M13: reuse existing error
```

The natspec acknowledges the reuse, but using `ZeroAmount` for a "value-too-large" failure is a debugging footgun and confuses any monitoring tool that decodes the revert. Should be a typed error like `MinBribeTooLarge()` (no compatibility cost — this is an admin-only setter). Cited because BATCH-H M13 fixed the underlying DoS but left the error message poorly named.

---

## F-11-3 — `userTotalVotes` allocation locked for users who voted on a pair that later loses quorum (INFO / by design but worth flagging)

**Severity:** INFORMATIONAL
**Location:** `vote` line 632, `revealVote` line 1611, `claimBribes` line 801

When `MIN_BRIBE_CLAIM_QUORUM` is missed, `claimBribes` reverts with `BribePoolBelowQuorum`. The voter's `userTotalVotes[user][epoch]` was already incremented by their `power` when they voted/revealed; that allocation is **not** refundable. If they then realize at claim time that the pair they backed didn't reach quorum, they cannot redirect the allocation to another pair in the same epoch (the cap is monotonic and global per epoch).

This is consistent with Aerodrome / Velodrome semantics — the natspec at line 1291 explicitly acknowledges "Voters who voted on a sub-quorum pair CANNOT recover their voting allocation through this path" — but it interacts uncomfortably with F-11-1: a user can be **double-bitten** if they spread their vote across pair P (which gets quorum and then is disabled, → F-11-1) and pair Q (which fails quorum, → this finding). They lose the entire epoch's voting weight with no recovery.

---

## F-11-4 — Unrestake permanently nukes historical voting power (informational; user-shoots-self-in-foot)

**Severity:** INFORMATIONAL
**Location:** `TegridyRestaking._boostedAmountAt` line 504-506; `unrestake` deletes the `restakers[msg.sender]` entry (line 1078, 1468, 1559, 1771).

After `unrestake()`, `restakers[user].tokenId == 0`, so `_boostedAmountAt(user, ts)` short-circuits to 0 for **every** ts — including timestamps when the user WAS restaked and had non-zero voting power.

Sequence:
1. T1: user restakes — `_boostCheckpoints[user]` writes 200 at T1.
2. T (T1 < T < T2): epoch snapshots — VotePowerOracle.powerAt(user, T) = staking(0) + restaking(200) = 200.
3. T2: user unrestakes — `delete restakers[user]; _writeBoostCheckpoint(user, 0);`.
4. T+claim_window: user calls `vote(epoch=e_T, pair, 200)`.
   - `historicalPower = powerAt(user, T) = 0 (staking checkpoint at T was 0) + 0 (info.tokenId == 0 short-circuit) = 0`.
   - `currentPower = powerOf(user) = 200 (NFT now back in staking) + 0 = 200`.
   - `userPower = min(0, 200) = 0` → `revert NothingToClaim`.

The user is **silently disenfranchised** for any epoch they were restaked through. Voluntary action by the user, but a non-obvious one — most veTOKEN protocols preserve historical lookups against deleted records (e.g., Compound `getPriorVotes` uses checkpoint arrays keyed by block, not the live balance).

A minimal fix: keep `_boostCheckpoints[user]` populated past unrestake (which it already is — the checkpoint was written) and remove the early `if (info.tokenId == 0) return 0;` short-circuit, replacing it with a check that the timestamp is BEFORE the unrestake. Implementation detail: store an `unrestakeTime` per user, or use the latest 0-checkpoint key as the unrestake marker.

This is **not on the audit lens directly** but came up while validating that the snapshot semantics in VoteIncentives are sound — the snapshot READ is sound, but the user-experience side leaks vote power.

---

## Other vectors checked (clean)

| # | Vector | Result | Notes |
|---|---|---|---|
| 1 | **Live read of votingPower at claim** | CLEAN | `claimBribes` reads `gaugeVotes[user][epoch][pair]` (stored at vote/reveal time). No live read; flash-deposit boost cannot affect claim share. |
| 2 | **Address vs tokenId tracking — split position to multi-claim** | CLEAN | All maps keyed by `address` (msg.sender). `votingPowerOf(user)` aggregates ALL of user's NFTs via `_positionsByOwner[user]` enumerable set in TegridyStaking (line 528-547). Min-clamp `min(historical, current)` (line 622-626) prevents a transferred NFT from giving the recipient access to historical power. |
| 3 | **Same gauge claimed from multiple veTOWELI NFTs** | CLEAN | Address-level checkpoint sums across NFTs. No per-tokenId claim track. |
| 4 | **Reorg replay across epochs** | CLEAN | `MIN_EPOCH_INTERVAL = 7 days` and `lastEpochTime` update prevent replay of `advanceEpoch`. Reorged-out vote re-broadcast lands at same state. |
| 5 | **claimed mapping collision / hash truncation** | CLEAN | Standard nested mapping `claimed[user][epoch][pair][token]`. No hash truncation. |
| 6 | **Vote then transfer NFT — re-claim by new owner** | CLEAN | New owner `gaugeVotes[Bob][e][P] == 0`. New owner trying to vote() against epoch e: `historicalPower(Bob, e.timestamp) = 0` → `userPower = min(0, X) = 0` → `revert NothingToClaim`. Min-clamp closes this (DEEP-GOV-01). |
| 7 | **EIP-712 / signed-claim cross-chain replay** | N/A | No EIP-712 or signature path exists. Commit-reveal hash binds `block.chainid` and `address(this)` (line 1487) — chain-pinned. |
| 8 | **Bribe deposit on already-finalized epoch** | CLEAN | `epoch = epochs.length` (live bucket) + `require(!epochBribesFinalized[epoch], "EPOCH_FINALIZED")` defense-in-depth (lines 684, 735). The finalize flag flips atomically inside `advanceEpoch` (line 565) with the push, so the live bucket index post-push is always the new (un-finalized) one. R014 H-4 closure looks complete. |
| 9 | **Claim on epoch 0 / pre-genesis** | CLEAN | `if (epoch >= epochs.length) revert InvalidEpoch();` (line 770). Underflow-safe. snapshotTime calc uses `block.timestamp - 1` fallback only when `block.timestamp > 0` (line 543). |
| 10 | **Calling claim on a killed gauge** | See F-11-1 | Killed gauge → `_validatePair` reverts → claim impossible. **Becomes a stranded-fund issue when killed mid-epoch (see F-11-1).** |
| 11 | **claim(user, ...) where caller != user (permit-style)** | N/A | No delegated-claim path; all claims use `msg.sender` directly. Only `_safeTransferExternal` is callable externally and is `onlySelf`. |
| 12 | **Vote-power-at-time linear-interp boundary off-by-one** | CLEAN | `votingPowerAtTimestamp` uses OZ `Trace208.upperLookup(ts)` which returns value at largest key ≤ ts. `SNAPSHOT_LOOKBACK = 1h` ensures same-block / near-block stakes are excluded. |
| 13 | **Iteration over voted gauges DoS** | CLEAN | `MAX_BRIBE_TOKENS = 20` per (epoch, pair). `MAX_BATCH_ITERATIONS = 200` outer cap on `claimBribesBatch`. Functional. |
| 14 | **Self-bribe arbitrage (depositor claims own bribe via voting)** | CLEAN | `depositedOnPair[user][epoch][pair]` lockout (line 805) + `MIN_BRIBE_CLAIM_QUORUM` (line 801) + `MIN_BRIBE_AMOUNT` floor + protocol fee. Aerodrome-style closure. |
| 15 | **Commit-reveal multi-commit options arbitrage** | CLEAN | `committedPower` cap (line 1528) sums declared powers across commits and bounds at `min(historical, current)` AT COMMIT time. Reveal-side cap re-anchors on `committedPower` not a fresh resample (V2-GOV-10 fix at line 1606). |
| 16 | **Commit-reveal griefing of victim's commits via forced forfeit** | CLEAN | `forfeitCommitOnDisabledPair` is gated `msg.sender == user || msg.sender == owner()` (line 1674, G-01 fix). |
| 17 | **`receive()` open ETH path** | CLEAN | Accidentally-sent ETH lands in balance and is sweepable to treasury via `sweepExcessETH` (excess-only). Reservations correctly track unclaimed bribes + pending withdrawals + accumulated treasury fees. |
| 18 | **Reentrancy through token bribe** | CLEAN | `nonReentrant` on all entry points; CEI ordering: `claimed[user][epoch][pair][token] = true; totalUnclaimedBribes -= share` BEFORE any external transfer (lines 832-856). `_safeTransferExternal` is `external` and onlySelf — the try/catch wrapping doesn't break the reentrancy guard because the guard is at the outer claim layer. |
| 19 | **Restaker disenfranchisement (GOV-ECON-01 / C10)** | CLEAN | Fixed via `VotePowerOracle.powerAt`/`powerOf` additive read across staking + restaking. `restakingContract` setter is one-shot (line 1135-1140). |
| 20 | **Sub-quorum self-vote arb (briber bribes own pool with 1-wei VP)** | CLEAN | `MIN_BRIBE_CLAIM_QUORUM` requires ≥100e18 of voting power to be cast; combined with `depositedOnPair` lockout, briber can't claim back their own bribe. |
| 21 | **`refundOrphanedBribe` per-depositor clock** | CLEAN | BATCH-N2 M12 fix uses `lastBribeDepositPerUser[epoch][pair][token][msg.sender]` keyed per depositor; dust deposits cannot extend OTHER depositors' rescue clocks. |
| 22 | **claim-window gating before VOTE_DEADLINE** | CLEAN | BATCH-H M14: `if (block.timestamp <= _voteEnd) revert ClaimWindowNotOpen()` (line 791) prevents early-claimer over-share against still-growing `totalGaugeVotes` denominator. Branches correctly between legacy (`ep.timestamp + VOTE_DEADLINE`) and commit-reveal (`revealDeadline`). |
| 23 | **Sweep cannot drain bribes / pending / treasury fees / commit bonds** | CLEAN | `sweepExcessETH` reserves `totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH`. `sweepToken(toweli)` additionally reserves `totalCommitBonds` (NEW-G9). |
| 24 | **`MAX_MIN_BRIBE_AMOUNT` clamp on min-bribe setter** | CLEAN | `MAX_MIN_BRIBE_AMOUNT = 1e24` cap (line 1343) prevents captured admin from DoS'ing a token by setting min to type(uint256).max. (See F-11-2 for cosmetic error-naming nit.) |
| 25 | **commit/reveal window math, epoch.timestamp = block.timestamp - 1h** | CLEAN | `commitDeadline = ep.timestamp + 2.8d`; `revealDeadline = ep.timestamp + 7d`. `block.timestamp` at advanceEpoch is `ep.timestamp + 1h`, so commit window opens immediately and lasts ~2.8d - 1h ≈ 2.7d. Reveal window covers the remaining ~4.2d. Sane. |

---

## Notes / dead-ends

- **Looked hard at Trace208 upperLookup semantics** — confirmed `upperLookup(key)` returns value at **largest key ≤ key**, not strictly less than. With `SNAPSHOT_LOOKBACK = 1h` the same-block stake → checkpoint key is at block T, snapshotTime = T - 1h, so `upperLookup(T-1h) < T → 0`. Safe.
- **Looked for cross-chain replay surface in commit-reveal** — `computeCommitHash` packs `block.chainid` and `address(this)` (line 1487). Cross-chain / cross-deployment replay impossible.
- **Tried to construct an attack via FoT (fee-on-transfer) bribe token** — the FoT path uses balance-diff (`actualReceived = balanceAfter - balanceBefore`) for the deposit (line 657). The fee transfer to treasury happens BEFORE the per-depositor bookkeeping is recorded, so the depositor's `bribeDeposits[...][msg.sender]` tracks `netBribe = actualReceived - fee`. If the FoT also charges on the fee transfer, treasury receives slightly less than `fee` — but the depositor's record is unchanged. Not exploitable for over-claim.
- **Looked at the `committedPower` / `userTotalVotes` interaction on reveal** — line 1608: `require(userTotalVotes[user][epoch] + power <= cap, "EXCEEDS_POWER")` where `cap = committedPower[user][epoch]`. If a user commits 100, then commits another 50, `committedPower = 150`. They reveal 100 → `userTotalVotes = 100`. Then reveal the 50 → `userTotalVotes + 50 = 150 ≤ 150`. Correct sum.
- **Looked at `lastBribeDepositPerUser` vs `bribeDeposits` invariant on partial refund** — both zeroed in `refundOrphanedBribe` / `refundUnvotedBribe` / `refundSubQuorumBribe`. The `epochBribes[e][p][t]` is decremented by `amount` — but `bribeDeposits[e][p][t][user]` is set to 0 not decremented. Since the refund grants the FULL deposit amount to the caller, this is correct (caller can't refund twice; their share = 0 after).
- **Looked at `epochBribes` decrement on refunds** — `epochBribes[epoch][pair][token] = remaining > amount ? remaining - amount : 0;` (lines 1196, 1253, 1320). Defensive against drift. Could in principle drift below zero in theory — the floor-to-zero clamp prevents underflow. But if an attacker could repeatedly call refund with `amount > remaining`, they could… no, `bribeDeposits[epoch][pair][token][msg.sender]` is the upper bound on `amount` and is zeroed first. Tight.
- **Looked at the `totalIterations` cap in batch claim placement** — increment AFTER the `if (share == 0) continue` zero-share skip, so dust-only iterations don't count toward the 200 cap (line 938-942). But share-nonzero iterations + state-write iterations DO count. Correct.
- **Tried to construct a flash-stake / instant-vote attack using SNAPSHOT_LOOKBACK boundary** — would need to stake ≥1h before advanceEpoch, which gives the network time to react and removes the "atomic flash-loan-then-vote" primitive. Combined with TRANSFER_COOLDOWN = 24h on the staking NFT and TRANSFER_RATE_LIMIT = 1h, the snapshot-influence attack surface is closed.
- **Tried `enableCommitReveal()` / `applyEnableCommitReveal()` re-entry** — `enableCommitReveal()` (line 1786) reverts unconditionally with `UseProposeEnableCommitReveal` — pure deprecation. `applyEnableCommitReveal()` (line 1771) is `onlyAdmin` (admin-contract gated) and idempotent (`if (commitRevealEnabled) return;`). Forward-only by design. Sound.
- **Looked at `commitRevealEnabled = true` default** — H14 fix at line 275. Means new deployments have commit-reveal active from epoch 0. The legacy `vote()` path is dead-code for fresh deploys — only kept for backward-compat with epochs created before the flag was flipped on a hypothetical pre-fix deploy. For this audit's purposes, all production epochs will be commit-reveal.
- **Looked at the `commitVote` block.timestamp window check** — `if (block.timestamp <= ep.timestamp) revert CommitWindowNotOpen()` (line 1511). Since `ep.timestamp = block.timestamp - SNAPSHOT_LOOKBACK = block.timestamp - 1h` is set inside `advanceEpoch`, every commit comes >1h after `ep.timestamp`. Defensive guard, fires only on weird genesis-time conditions.
- **Spot-checked `withdrawTreasuryFees`** — `onlyOwner nonReentrant`, uses `WETHFallbackLib.safeTransferETHOrWrap` to handle contract-treasury that rejects ETH. Sound.
