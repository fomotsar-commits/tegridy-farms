# Pass-5 Cross-Contract Chain Analysis: Stake → Restake → Vote → Bribe-Claim

**Status:** No PoC-backed findings. Full chain enumeration below.

This file documents the cross-contract analysis of the most-coupled five-contract chain in the protocol. Pass-5 traced 1 unit of staked TOWELI through every cross-contract call site to find amplification / double-counting / fallback exploits. The result is **clean**: the architecture's NFT-custody-as-state-singleton design isolates voting power per contract instance and prevents the "stake once, vote N times" attack class.

---

## 1. The five-contract chain

| Contract | Role | Reads from | Writes to |
|---|---|---|---|
| `TegridyStaking` | Mints `tsTOWELI` NFT, holds principal, computes boost, checkpoints voting power | TOWELI ERC20, JBAC NFT | self |
| `TegridyRestaking` | Holds tsTOWELI NFT for bonus rewards | `staking.positions`, `staking.holdsToken`, `staking.unsettledRewards` | `staking.getReward`, `staking.toggleAutoMaxLock`, `staking.claimUnsettled`, `staking.revalidateBoost` |
| `GaugeController` | Per-epoch gauge weight allocation | `staking.ownerOf`, `staking.positions`, `staking.votingPowerAtTimestamp`, `staking.votingPowerOf` | self |
| `VoteIncentives` | Bribe deposits + claims tied to gauge votes | `staking.totalBoostedStake`, `staking.votingPowerAtTimestamp`, `staking.votingPowerOf` | self |
| `RevenueDistributor` | Per-epoch ETH revenue claim | `staking.votingPowerAtTimestamp`, `staking.votingPowerOf`, `staking.totalBoostedStakeAtTimestamp`, `restaking.restakers`, `restaking.boostedAmountAt` | self |

---

## 2. Voting power propagation per 1 TOWELI staked

When Alice stakes 1 TOWELI for 1 year:

```
TegridyStaking (Alice's position):
  amount = 1 TOWELI
  boostedAmount = 1 × ~13025 = 13025 (1-year boost ≈ 13x)
  totalBoostedStake += 13025
  votingPowerOf(Alice) = 13025
  _writeCheckpoint(Alice) → push (block.timestamp, 13025)
  _writeTotalBoostedStakeCheckpoint() → push (block.timestamp, totalBoostedStake)
```

Then Alice's 13025 propagates to:

```
GaugeController (Alice votes for gauge G in epoch E):
  historical = votingPowerAtTimestamp(Alice, epochStart(E)) = 13025
  current = votingPowerOf(Alice) = 13025
  votingPower = min(13025, 13025) = 13025  ← DEEP-GOV-01 clamp
  gaugeWeightByEpoch[E][G] += 13025
  totalWeightByEpoch[E] += 13025

VoteIncentives (Alice votes for pair P in epoch E):
  historical = votingPowerAtTimestamp(Alice, ep.timestamp) = 13025
  current = votingPowerOf(Alice) = 13025
  userPower = min(13025, 13025) = 13025  ← DEEP-GOV-01 clamp
  userTotalVotes[Alice][E] += 13025
  totalGaugeVotes[E][P] += 13025

RevenueDistributor (when distribute creates epoch E):
  totalLocked = totalBoostedStakeAtTimestamp(T-1) = ... + 13025
  Alice's claim share = 13025 / totalLocked × epoch.totalETH
```

The same 13025 is **reused** across GaugeController + VoteIncentives + RevenueDistributor, but always under the `min(historical, current)` clamp and always proportional to the SAME underlying boostedAmount. Alice cannot inflate her share by voting in multiple contracts — she gets exactly 13025 of voting power per surface, proportional to her stake.

---

## 3. The restake state-singleton

When Alice transfers her tsTOWELI NFT to TegridyRestaking:

```
TegridyStaking._update(Alice, restaking, tokenId):
  → triggers _writeCheckpoint(Alice)
  → Alice's checkpoint at this block = 0 (NFT no longer in her wallet)
  → triggers _writeCheckpoint(restaking)
  → but restaking is a contract; its votingPowerOf is sum of NFTs it holds
  
After transfer:
  votingPowerOf(Alice) = 0
  votingPowerOf(restaking) = 13025 (now holds the NFT)
```

This means **Alice loses voting power in GaugeController and VoteIncentives** the moment she restakes. She CANNOT vote with her restaked stake. The `min(historical, current)` clamp returns 0 for any vote attempt.

The restaking contract itself doesn't expose vote/commitVote — so the 13025 is **stranded as voting power** during the restake window. This is by design.

For RevenueDistributor, the **fallback** at line 732-734 specifically rescues the restaker's revenue claim:

```solidity
if (userPower == 0 && isRestaker) {
    userPower = _restakedPowerAt(user, epoch.timestamp);
}
```

`_restakedPowerAt` reads from `TegridyRestaking.boostedAmountAt(user, ts)`, which is the user's CACHED restaking-side boost (with `min(cached, current)` clamp during kick-window). So Alice still claims her revenue share from `RevenueDistributor` — she just can't vote.

---

## 4. Could the same TOWELI be counted twice?

Pass-5 hunted for any code path where 1 TOWELI of stake propagates as 2× into a downstream calculation.

**Findings — none.** The state-singleton design means:

| Surface | Power source for Alice |
|---|---|
| `GaugeController.vote()` | `staking.votingPowerOf(Alice)` — 0 if NFT is in restaking |
| `VoteIncentives.vote()` | `staking.votingPowerAtTimestamp(Alice, ep.timestamp)` — 0 if NFT was already in restaking at ep.timestamp |
| `RevenueDistributor._calculateClaim` (no restake) | `staking.votingPowerAtTimestamp(Alice, epoch.timestamp)` |
| `RevenueDistributor._calculateClaim` (restaked) | falls through to `restaking.boostedAmountAt(Alice, epoch.timestamp)` ONLY when staking power = 0 |

The fallback in `RevenueDistributor` is gated by `userPower == 0`. The two sources are **mutually exclusive** — Alice gets her share from one or the other, never both.

For epochs *during* a restake-then-unrestake cycle:
- Pre-restake epochs: claimed via `votingPowerAtTimestamp(Alice, ts)` — non-zero (NFT was in her wallet).
- Restake-window epochs: claimed via fallback — `boostedAmountAt(Alice, ts)` (NFT in restaking).
- Post-unrestake epochs: claimed via `votingPowerAtTimestamp(Alice, ts)` again — non-zero.

The transitions are correctly handled by `info.depositTime` checks in `_boostedAmountAt` (returns 0 if `depositTime > _timestamp`). No epoch can be claimed twice.

---

## 5. Could a sandwich-restake game RevenueDistributor's denominator?

The denominator is `totalBoostedStakeAtTimestamp(T-1)` at distribute-time. This snapshot includes the NFT regardless of which address owns it (because the staking-side `totalBoostedStake` is sum of `position.boostedAmount` not sum-by-owner). Restaking doesn't change `totalBoostedStake` — the NFT stays in its position; the OWNER changed but the position metadata is unchanged.

So there's no denominator manipulation via restake. The only denominator manipulation vector is whale unstake / kick — which IS PASS5-REV-H1's attack chain, and is the headline finding.

---

## 6. Could a flash-borrow-vote-repay loop bypass the snapshot?

`vote()` reads `votingPowerAtTimestamp(msg.sender, epochStart(epoch))`. The `epochStart` for the current epoch is BEFORE the flash-borrow could land (epochs are 7-day buckets). Even if attacker borrows 100k TOWELI at block T, stakes for 7 days at T+1, and votes at T+2:
- `epochStart(currentEpoch())` is at most 7 days ago
- attacker's checkpoint is at T+1 (post-stake)
- `votingPowerAtTimestamp(attacker, epochStart(currentEpoch()))` reads `upperLookup(epochStart)`. If epochStart > T+1, returns 0; if epochStart ≤ T+1, returns the new power but only if there's a checkpoint at or before epochStart.

For a fresh staker, the checkpoint is at T+1 = stake time. If `epochStart < T+1` (epoch started before stake), returns 0. If `epochStart >= T+1` (impossible — epochStart is in the past), returns the new power.

Net: a fresh staker can NEVER vote in the current epoch (because the checkpoint at stake-time is AFTER the epoch start). They must wait for the NEXT epoch.

This is the **TF-04 fix** working as intended: vote power is pinned to epoch-start, and same-epoch staking yields zero voting power.

---

## 7. The bribe-claim race

`VoteIncentives.claimBribe(epoch, pair)` reads `userTotalVotes[msg.sender][epoch]` and `totalGaugeVotes[epoch][pair]`. Both are written at vote-time and immutable after the vote-deadline. Claims after vote-deadline can happen anytime; the bribe pool is also immutable post-`advanceEpoch` (the H-4 finalization).

No race window exists between vote and claim that could amplify a user's share. The only "race" would be different users claiming sequentially, draining the bribe pool — but that's normal and expected.

---

## 8. Conclusion

The five-contract chain is robust. The `min(historical, current)` clamp at every voting site (DEEP-GOV-01) plus the NFT-custody state-singleton design plus epoch-start snapshot semantics combine to prevent every "vote with N copies of the same TOWELI" attack class.

The only real finding in this domain is PASS5-REV-H1, which is NOT a double-count attack — it's a denominator-deflation attack via the kick→distribute sandwich, exploiting the missing MIN_DISTRIBUTE_STAKE check on `distribute()`.
