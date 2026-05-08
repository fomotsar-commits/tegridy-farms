# Agent 77 — Aerodrome / Velodrome / Curve Pattern Divergences

**Lens:** Compare GaugeController.sol, VoteIncentives.sol, RevenueDistributor.sol against canonical Aerodrome v3 / Velodrome v2 / Curve veCRV-FeeDistributor implementations and find behavioral divergences that produce exploitable economic edges.

**Scope:** Vote weight semantics, epoch-boundary handling, self-claim restrictions, bribe deposit timing windows, off-by-one checkpoint reads.

---

## F-77-1 — Bribe deposits target the SAME epoch they will be claimed in (vs. Aerodrome n+1) [HIGH]

**File:** `contracts/src/VoteIncentives.sol:676` (`depositBribe`), `:733` (`depositBribeETH`), `:528-570` (`advanceEpoch`)

**Pattern in Tegridy:**
```
depositBribe → epoch = epochs.length         // LIVE (un-finalized) bucket
advanceEpoch → epochs.push(...)
              epochBribesFinalized[newEpoch] = true   // SAME index
vote(epoch)   → reads bribe pool for epoch already finalized
claimBribes(epoch) → distributes bribe pool to voters of THAT epoch
```

**Pattern in Aerodrome v3 / Velodrome v2 (canonical):**
> "Fees that accrue during epoch `n` will be distributed to voters of that pool in epoch `n+1`." [Aerodrome SPECIFICATION.md]
> "External bribes are rewarded per epoch rather than streamed, and are claimable only after the next epoch starts." [Cube Exchange / Velodrome docs]

In Aerodrome `BribeVotingReward.notifyRewardAmount(token, amount)` records the bribe under `tokenRewardsPerEpoch[token][nextEpochStart]`, where `nextEpochStart = (block.timestamp / WEEK + 1) * WEEK`. The vote in epoch `n` is paid against bribes deposited DURING epoch `n` and claimable in epoch `n+1`.

**Divergence:** Tegridy collapses this into a single epoch index. Voters in epoch `e` receive the bribes deposited DURING the `[lastEpochTime, advanceEpoch]` window — i.e. bribers for epoch `e` deposit into the same bucket voters claim from in epoch `e`.

**Why this is fine ON PAPER (and why VoteIncentives' code-comments think it is fine):** because `depositBribe` rejects on `epochBribesFinalized[epochs.length]` (line 684) — a briber cannot retroactively add to a finalized epoch. So the bribe-set-at-vote-time semantic IS preserved.

**Why it is NOT fine in practice — the late-deposit MEV/arbitrage edge:**

In Aerodrome, voters in epoch `n` cast votes WITHOUT KNOWING what bribes will appear in epoch `n+1`'s pool. (Bribers can drop in until the literal end of `n`, and those flow to `n+1`'s claimable.) This means a voter must commit on direction without seeing the full bribe surface — partial information game.

In Tegridy: `advanceEpoch()` is permissionless. A briber + voter coalition can:

1. Front-run `advanceEpoch()` with a giant `depositBribe(myPair, …)` so it lands in the LIVE bucket at index `epochs.length`.
2. Same block — call `advanceEpoch()` (no MIN_EPOCH_INTERVAL bypass; honest keepers won't have called yet because `MIN_EPOCH_INTERVAL` just elapsed). Bucket flips to finalized.
3. Wait `commitDeadline` (or `VOTE_DEADLINE` in the legacy path), then in the reveal window cast a vote on `myPair`.
4. Watch competitors who never knew the bribe was even in the bucket — they reveal their pre-existing commit hashes, but the commit was made BEFORE the briber's deposit landed, so they had to commit blind.

The commit-reveal protocol HIDES the voter's choice. It does NOT hide the briber's deposit. A briber can therefore **deposit AFTER seeing the commit transactions in the mempool** but BEFORE the reveal window opens, knowing only honest voters who happened to commit-reveal on their pair will share the bribe. In Aerodrome the bribe-to-`n+1` lag means commits in epoch `n` can never see epoch `n+1`'s bribes (they arrive AFTER the vote concludes).

The `MIN_BRIBE_CLAIM_QUORUM` and `SelfBribeClaimForbidden` gates close pure self-bribe. They do NOT close: briber-controlled-VP voting in tandem with a paid-off voter cohort whose commits land in any pair, with the briber deciding LAST whether to deposit on that pair based on which commits won the day.

**Mitigation reference:** Aerodrome `BribeVotingReward.notifyRewardAmount` writes to `tokenRewardsPerEpoch[token][_getEpochStart(block.timestamp) + WEEK]`. Apply the same lag here: `depositBribe` writes to `epochs.length + 1` not `epochs.length`. Voters in `epoch` see bribes from `epoch - 1`'s deposit window. The `epochBribesFinalized` flag on the deposit-target index is no longer needed because voters never read the live bucket.

**Note:** Tegridy's `epochBribeFirstDeposit` (BRIBE_RESCUE_DELAY) implies the original design intent was to keep bribes in their deposit epoch. The whole `refundOrphanedBribe` machinery is built around that assumption. Switching to n+1 lag rebases ALL that logic — non-trivial, but the security delta is real.

**Sources:**
- Aerodrome SPECIFICATION.md (fees/bribes accrue in `n`, claimed in `n+1`).
- Velodrome v2 BribeVotingReward.sol — `notifyRewardAmount` indexes `_getNextEpochStart(block.timestamp)`.

---

## F-77-2 — `commitDeadline` is 40% of VOTE_DEADLINE (2.8 d) — voters who commit late see other voters' on-chain reveals before their own [MEDIUM-HIGH]

**File:** `contracts/src/VoteIncentives.sol:1459-1462` (`commitDeadline`), `:1466-1469` (`revealDeadline`), `:1572-1573` (`revealVote` window)

**Pattern in Tegridy:**
```
commitWindow = [epoch.timestamp,            epoch.timestamp + 0.4*VOTE_DEADLINE]   // 2.8d
revealWindow = (epoch.timestamp + 0.4*VOTE_DEADLINE, epoch.timestamp + VOTE_DEADLINE]  // 4.2d
```
`commitVote()` reverts `CommitDeadlinePassed` after 2.8d, but `revealVote()` accepts reveals during the entire 4.2d window. Therefore early reveals (T+2.8d…T+3d) are visible while late commits would still be possible if the commit window were open.

**Divergence vs. Aerodrome:**
Aerodrome / Velodrome do not use commit-reveal at all — votes are public throughout the epoch with a 1h-after-flip lockout. The commit-reveal here is a Tegridy-specific addition designed around bribe arbitrage from TF-04 / H-2. The commit/reveal split is only safe if commits and reveals are STRICTLY DISJOINT (no commit can be made AFTER any reveal). The `commitDeadline < revealStart` invariant holds here because both equal `epoch.timestamp + 0.4*VOTE_DEADLINE`.

**However:** the design has a different leak — the commit window of 2.8d is plenty of time for a briber to deposit late in commit window, after observing aggregate `committedPower` accumulation but before the contents are revealed. The committedPower increment (line 1529) is publicly readable.

A briber can:
1. Wait until commitDeadline - 1h (T+2.8d minus 1h).
2. Read `committedPower[address]` for known whales.
3. Estimate which whales committed how much (committedPower is the sum across their commits — a precise number).
4. Deposit a bribe targeting whichever pair has the most aggregate `committedPower` declared (because aggregate committedPower correlates with willingness-to-vote, and the briber can guess whales by power signature).

This is weaker than the F-77-1 attack but illustrates that the per-user committed-power leak (introduced for the C2 multi-NFT cap) is observable on-chain.

**Mitigation:** Tighten commit window to a smaller fraction of VOTE_DEADLINE (e.g., `COMMIT_RATIO_BPS = 1500` = 1d) so bribers have less time to act on `committedPower` signals. Aerodrome's 1h-pre-flip whitelist-only voting is precedent for keeping the late part of the epoch out of bribers' reach.

---

## F-77-3 — `advanceEpoch()` is permissionless with NO post-finalize cooldown — same-block deposit-then-finalize is admitted [MEDIUM]

**File:** `contracts/src/VoteIncentives.sol:528-570` (`advanceEpoch`)

**Pattern in Tegridy:**
```solidity
function advanceEpoch() external whenNotPaused {
    if (block.timestamp < lastEpochTime + MIN_EPOCH_INTERVAL) revert EpochTooSoon();
    ...
    epochs.push(...);
    epochBribesFinalized[newEpoch] = true;
}
```
`MIN_EPOCH_INTERVAL = 7 days` means epochs are weekly. A briber can:
- Block N: `depositBribe(myPair, …, hugeAmount)` — lands in `epochs.length`.
- Block N+1 (or even same block via tx-ordering): `advanceEpoch()` — flips finalized.
- Voters who committed before block N had no idea this bribe would arrive.

**Pattern in Aerodrome:** The Voter contract's `distribute()` is also permissionless, BUT bribe deposits target `getEpochStart(block.timestamp) + WEEK` (the NEXT epoch). So even a same-block deposit→distribute sequence routes the bribe to the future epoch, and any voter who already voted in the current epoch is unaffected.

**Why this is independent of F-77-1 even though they look related:** F-77-1 is about the bribe-epoch indexing (`n` vs. `n+1`). F-77-3 is the same-block atomicity: even if you fix F-77-1 to route bribes to `epochs.length + 1`, a briber depositing AT `lastEpochTime + 7 days - 1 second` and triggering advance the next block still has the same window. The difference is that under n+1 indexing, that bribe falls into the FUTURE epoch (where new voters will form their commits) — economically equivalent to a public bribe announcement at epoch start. Under n indexing, the bribe is captured by COMMITS-ALREADY-FROZEN voters, which is the unsafe case.

**Mitigation:** This is fundamentally fixed by F-77-1.

---

## F-77-4 — Voter `userTotalVotes` cap allows post-divest re-vote leakage on multi-call vote() [MEDIUM]

**File:** `contracts/src/VoteIncentives.sol:622-637` (legacy `vote()`)

**Pattern in Tegridy:**
```solidity
uint256 historicalPower = VotePowerOracle.powerAt(msg.sender, ep.timestamp, …);
uint256 currentPower = VotePowerOracle.powerOf(msg.sender, …);
uint256 userPower = historicalPower < currentPower ? historicalPower : currentPower;  // min-clamp
require(userTotalVotes[msg.sender][epoch] + power <= userPower, "EXCEEDS_POWER");
```
`userPower` is recomputed on EVERY vote() call. A user holding 1000 power at snapshot can:
- Call 1: `userPower = 1000`, vote 500 on PairA.
- Call 2 (later block, same epoch): `userPower = 1000` again (still snapshot), vote 500 on PairB.

This is the intended behavior: split power across pairs. **But what about restakers?**

VotePowerOracle.powerAt + powerOf are ADDITIVE across staking + restaking. A user who:
1. Has staking position with 1000 power at `ep.timestamp`.
2. Restakes the NFT after `ep.timestamp` — staking checkpoint zeros out for `ts > stake_time`, but `votingPowerAtTimestamp(user, ep.timestamp)` returns 1000 (historical pin).
3. The restaking contract starts emitting non-zero `votingPowerAtTimestamp(user, ep.timestamp)` immediately on deposit (TegridyRestaking aliases — needs verification).

**If TegridyRestaking's `votingPowerAtTimestamp(user, ep.timestamp)` returns the boosted amount EVEN WHEN ep.timestamp PRECEDES the user's restake**, then `historicalPower = staking_at_T + restaking_at_T = 1000 + 1000 = 2000` — the user just doubled their voting power post-snapshot.

**Risk source:** the additive pattern in VotePowerOracle assumes the staking-side and restaking-side checkpoints are MUTUALLY EXCLUSIVE (a user's NFT is in exactly one place). When the restaking contract's `votingPowerAtTimestamp` does not enforce `ts >= depositTime`, additive sum DOUBLE-COUNTS.

**Pattern in Aerodrome:** managed NFT (Aerodrome's restaking equivalent) has `_balanceOfNFTAt(_managedTokenId, _ts)` which sums depositor balances ONLY for those who deposited BEFORE `_ts`. If a user deposits at T2, their power doesn't appear in any `_balanceOfNFTAt` query for T1 < T2.

**Verification needed:** Does TegridyRestaking's `votingPowerAtTimestamp` and `boostedAmountAt` correctly gate on `depositTime <= ts`? RevenueDistributor.sol:543 just `try restaking.boostedAmountAt(user, ts)` — no client-side filter. If the server-side function doesn't gate, double-counting occurs.

**Mitigation suggestion:** VotePowerOracle.powerAt should compute `min(staking_at_ts, total_at_ts) + restaking_at_ts` where `restaking_at_ts` is gated by depositTime. Or the consumers need to enforce the depositTime gate themselves.

---

## F-77-5 — `claimBribes` lock-out via `SelfBribeClaimForbidden` is per-(user,epoch,pair) but does NOT prevent two-account collusion [LOW-MEDIUM]

**File:** `contracts/src/VoteIncentives.sol:803-805`, `:707` (depositedOnPair), `:708`

**Pattern in Tegridy:**
```solidity
if (depositedOnPair[msg.sender][epoch][pair]) revert SelfBribeClaimForbidden();
```
The flag is set on `depositBribe[ETH]` for `msg.sender = depositor` per (epoch, pair). It blocks the depositor's OWN address from claiming on the same (epoch, pair). It does NOT block:
- A second EOA owned by the same actor from voting on the same pair and claiming.
- A multi-sig acting on behalf of the briber.

This is the canonical "bribe wash trade" — Aerodrome / Velodrome have the SAME limitation; the depositor lockout is effectively decorative. Real protection comes from the `MIN_BRIBE_CLAIM_QUORUM` (100e18 VP) requirement, which forces external honest voting to dilute the briber's cohort.

**Why call it out anyway:** the contract comment at lines 320-326 reads "...even a depositor who only bribed token A is locked out of token B claims on the same pair, since cross-token swaps would re-open the round-trip. Strict per-(epoch, pair) granularity is preserved across the whole epoch lifecycle." This OVERSTATES the protection. A two-account briber bypasses the entire flag.

**Suggested doc-only fix:** clarify in the natspec that `depositedOnPair` is a defense against single-account self-bribe round-trip, NOT a defense against two-account collusion, and that quorum is the actual economic backstop.

---

## F-77-6 — GaugeController and VoteIncentives use DIFFERENT epoch indexing — voter must mentally translate [INFO/LOW]

**File:** `contracts/src/GaugeController.sol:286-288` (`currentEpoch`), `contracts/src/VoteIncentives.sol:573-575` (`currentEpoch`)

**Pattern:**
- GaugeController: `currentEpoch() = (block.timestamp - genesisEpoch) / EPOCH_DURATION` — derives from block.timestamp.
- VoteIncentives: `currentEpoch() = epochs.length` — derives from how many `advanceEpoch()` calls have happened.

These are NOT the same number. If `advanceEpoch()` lags 3 days behind, GaugeController's currentEpoch advances at 7d boundaries while VoteIncentives' lags. The two governance systems can be out of phase by an arbitrary amount.

**Impact:** Off-chain UIs trying to display "epoch N gauge weight + epoch N bribes" need to correlate by timestamp, not by index. This is doable but error-prone. The pair-mapping `pairToGauge` couples the two contracts but doesn't synchronize their epoch counters.

**Pattern in Aerodrome / Velodrome:** ONE epoch counter, derived from `WEEK = 7 days` on `block.timestamp`. Voter, FeesVotingReward, BribeVotingReward, and Minter ALL agree on the same epoch number for the same `block.timestamp`.

**Mitigation:** Use timestamp-derived epoch in BOTH contracts. The current design intentionally allows VoteIncentives' epoch to lag (so dust bribes don't auto-finalize a half-empty epoch), but you can keep that property by gating `advanceEpoch()` on `currentEpochByTimestamp() > epochs.length` and still use the timestamp epoch as the canonical index.

---

## F-77-7 — RevenueDistributor `_calculateClaim` adds restaker power UNCONDITIONALLY when isRestaker — over-credits dual-position users at boundary [LOW]

**File:** `contracts/src/RevenueDistributor.sol:766-768`

**Pattern in Tegridy:**
```solidity
if (isRestaker) {
    userPower += _restakedPowerAt(user, epoch.timestamp);
}
```
`isRestaker` is computed at line 718 as a CURRENT (not historical) flag (`_isRestaked(user)` reads `restakers[user]` live). For an epoch where the user was not yet a restaker (epoch.timestamp < their restake deposit), `userPower += _restakedPowerAt(user, ep.timestamp)` should return 0 from the restaking contract's historical lookup IF `boostedAmountAt` correctly gates on depositTime.

**Risk:** Same as F-77-4. If TegridyRestaking's `boostedAmountAt(user, ts)` returns the user's CURRENT boosted amount when `ts < depositTime` (rather than zero), this over-credits the user.

`_restakedPowerAt` comment claims (line 538-540): *"the current boostedAmount is a lower bound for historical power (boost only decays over time), so this never over-credits"*. This is FALSE for `ts < depositTime` — at that timestamp the user had ZERO restaking power, not "current minus decay".

**Verification needed:** Read TegridyRestaking.boostedAmountAt — does it bail with 0 for `ts < restakers[user].depositTime`?

**If yes:** F-77-4 and F-77-7 are doc-only.
**If no:** these are real over-credit issues admitting double-vote / double-claim.

---

## Notes / Dead-ends

- **Curve veCRV upper_lookup off-by-one:** The repo uses OZ's `Checkpoints.Trace208` (per the H-21 / REV-M-01 comments). OZ's `upperLookup(key)` returns the value at the largest key `<= key`. Tegridy uses `epochStartTime(epoch) - 1` consistently to exclude same-block stakes — matches the documented Curve convention. No off-by-one found.
- **Velodrome 2022 C4 #168 (bribes stuck epoch 0):** Tegridy is not vulnerable — `advanceEpoch()` requires `totalBoostedStake >= MIN_DISTRIBUTE_STAKE` (1000e18) which prevents bricked-genesis-epoch ambiguity. The first vote-able epoch will be epoch 0 with at least 1000e18 stake.
- **Velodrome 2022 C4 #171 (bribes lost forever if not collected current period):** Tegridy is not vulnerable — bribes accumulate in `epochBribes[epoch][pair][token]` and are never auto-cleared between epochs. Each (epoch, pair, token) bucket is independent.
- **Velodrome 2022 C4 #138 (DoS via malicious tokens in notifyRewardAmount):** Tegridy mitigates via `whitelistedTokens` (line 650 of `depositBribe`).
- **Aerodrome June 2022 "infinite claim" disclosure:** that bug stemmed from a `_writeCheckpoint` race in early Velodrome and is not present here — Tegridy uses OZ Trace208 not the bespoke checkpoint linked-list.
- **Curve gauge_controller `change_gauge_weight` deferred-to-next-epoch:** Tegridy's `executeRemoveGaugeNextEpoch` (GaugeController.sol:966) is the equivalent — verified pattern match.
- **Curve veCRV non-transferability vs. Aave aTokens min(checkpointed, balance):** the DEEP-GOV-01 min-clamp is correctly applied — verified at GaugeController.sol:358, VoteIncentives.sol:626, :1526.

---

## Summary

| ID | Severity | Path |
|----|----------|------|
| F-77-1 | HIGH | bribe deposits target same epoch as claim (Aerodrome uses n+1) |
| F-77-2 | MED-HIGH | `committedPower` leaks vote-direction signal during 2.8d commit window |
| F-77-3 | MEDIUM | `advanceEpoch()` permissionless + no post-finalize cooldown |
| F-77-4 | MEDIUM | VotePowerOracle additive sum may double-count if restaking `votingPowerAtTimestamp` doesn't gate on depositTime |
| F-77-5 | LOW-MED | `SelfBribeClaimForbidden` is single-EOA only; collusion bypasses it (doc) |
| F-77-6 | INFO/LOW | GaugeController and VoteIncentives use different epoch indexes |
| F-77-7 | LOW | `_restakedPowerAt` comment claims lower-bound but is wrong for ts<depositTime |

**Top priority for review:** F-77-1 (bribe-epoch indexing). The same-epoch claim semantics combined with permissionless `advanceEpoch` collapses the bribe arbitrage closure that Aerodrome / Velodrome rely on. The commit-reveal layer hides votes but does NOT hide bribe deposits, so a sophisticated briber can wait for commit transactions before depositing — exactly what the n+1 lag in Aerodrome was designed to prevent.

**Sources:**
- [Aerodrome SPECIFICATION.md (n+1 distribution)](https://github.com/aerodrome-finance/contracts/blob/main/SPECIFICATION.md)
- [Aerodrome Voter.sol](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Voter.sol)
- [Velodrome v2 contracts](https://github.com/velodrome-finance/contracts)
- [Velodrome 2022 C4 #168 — Bribe Rewards Stuck](https://github.com/code-423n4/2022-05-velodrome-findings/issues/168)
- [Velodrome 2022 C4 #171 — Bribe Rewards Not Collected Lost](https://github.com/code-423n4/2022-05-velodrome-findings/issues/171)
- [Velodrome 2022 C4 #138 — DoS via malicious tokens](https://github.com/code-423n4/2022-05-velodrome-findings/issues/138)
- [Velodrome Security Vulnerability Disclosure (June 2022)](https://medium.com/@VelodromeFi/security-vulnerability-disclosure-1aa193bffa7a)
- [Curve voting-escrow docs](https://docs.curve.finance/curve_dao/voting-escrow/voting-escrow/)
