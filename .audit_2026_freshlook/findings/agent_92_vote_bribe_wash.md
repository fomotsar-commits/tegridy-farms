# Agent 92 — Vote-Bribe Wash-Trading / Curve-Wars Fresh-Eyes Hunt

**Lens:** wash-trading, sybil-vote, briber-coordination, curve-wars recursion against
`GaugeController.sol` (1054 lines) and `VoteIncentives.sol` (1789 lines, sister
`VoteIncentivesAdmin.sol` 208 lines).

**Code paths exercised:**
- `contracts/src/GaugeController.sol` — gauge weight voting, commit-reveal (24h reveal window)
- `contracts/src/VoteIncentives.sol` — bribe deposits, claim, refunds, commit-reveal (40/60% split)
- `contracts/src/VoteIncentivesAdmin.sol` — timelocked admin
- `contracts/src/TegridyStaking.sol` — `votingPowerOf`, `votingPowerAtTimestamp`, `EARLY_WITHDRAWAL_PENALTY_BPS = 2500`, `MIN_STAKE = 100e18`
- `contracts/src/lib/VotePowerOracle.sol` — additive staking + restaking voting-power read

**Scope:** code-level reasoning only; no .md history consulted (per instructions).

---

## Scenario inventory and verdicts

### F-92-1 — Sybil deposit + sybil vote + claim (net P/L) (DEAD-END)

**Scenario.** Attacker controls N "sybil" wallets. Each stakes >= 100 TOWELI for >= 7
days. Each commits and reveals a vote on a single bribed pair. Attacker also deposits
the bribe themselves, hoping to recover most of the bribe via the sybil claims.

**Capital required.** N * 100e18 TOWELI minimum + 7-day lock.

**Recipe**

1. attacker stakes via N wallets (cost: N * 100 TOWELI, all max-locked for 7d → 0.4x
   boost; voting power per wallet = 100 * 4000 / 10000 = 40 TOWELI-VP).
2. attacker deposits bribe of B tokens on (epoch, pair) from depositor wallet D.
3. attacker votes from each of the N sybil wallets on (epoch, pair).
4. epoch advances; attacker calls `claimBribes` from each sybil wallet.

**Why it fails.**

`VoteIncentives.depositBribe` line 708 sets
`depositedOnPair[msg.sender][epoch][pair] = true` for the depositor address D. The
`SelfBribeClaimForbidden` lockout in `claimBribes` line 805 ONLY checks
`depositedOnPair[msg.sender][...]`. The N sybil wallets are different addresses, so the
self-bribe lockout does NOT bind them — the sybils CAN claim.

So the lockout is NOT the wall here. The actual wall is economic:

- N wallets * 100 TOWELI staked + sybil VP fraction f = N * 40 / (N * 40 + honest VP)
- claim recovered = B * f * (1 − bribeFeeBps/10000) = 0.97 * B * f
- attacker's net: (recovered) − B = B * (0.97 * f − 1)

For attacker profit: f > 1 / 0.97 ≈ 1.031. **Impossible** — f is a fraction in [0, 1].

Best case (f=1, attacker is the only voter): recovered = 0.97 * B, **net loss = 0.03 *
B = the protocol fee** routed to treasury. So the protocol fee makes pure sybil-self-
claim a guaranteed loss. The `MIN_BRIBE_CLAIM_QUORUM = 100e18` further requires that
total VP on the pair exceed 100 TOWELI of voting power, which means at minimum `100 /
0.4 = 250 TOWELI staked at 7d-lock` to even open the claim window — a non-trivial
sunk-cost before the 0.97 * B − B math even starts.

**Verdict: PROTECTED.** Wash-cycle is loss-making by construction. Protocol fee is the
key wedge. Pattern matches Velodrome v2 / Aerodrome.

**Note.** If `bribeFeeBps` were ever set to 0 via timelock, the wash-cycle would be
break-even (not profitable). `applyFeeChange` line 1088 explicitly forbids
`newFee == 0` (`require(newFee > 0, "FEE_CANNOT_BE_ZERO")`), and the proposal-side
`VoteIncentivesAdmin.proposeFeeChange` line 84 also rejects 0. **Verified
defense-in-depth.**

---

### F-92-2 — Self-bribe lockout bypass via fresh wallet (LOW)

**Scenario.** Attacker wants to bribe-and-claim. The `SelfBribeClaimForbidden`
lockout binds the depositor address. Attacker uses two distinct wallets:

- D — deposits the bribe.
- C — claims via votes (D and C are both attacker-controlled, but on-chain they're
  unlinked).

**Why it doesn't help.** Same as F-92-1. Even with C unconstrained by
`depositedOnPair`, the share C can claim is bounded by C's voting-power fraction `f`,
and `0.97 * f * B < B` for any f ≤ 1. The lockout is ALREADY redundant with the
protocol-fee economics.

The lockout's ACTUAL purpose is to harden the `MIN_BRIBE_CLAIM_QUORUM` corner: without
it, a briber with `>= MIN_BRIBE_CLAIM_QUORUM` of self-controlled VP could vote against
themselves and claim back `0.97 * 100% = 0.97 * B`. With the lockout, they must use a
separate claimer wallet with separate VP — which they could do via D ≠ C wallets, so
this is a soft mitigation only. The HARD mitigation is the `bribeFeeBps`.

**Verdict: SOFT MITIGATION CORRECT.** `SelfBribeClaimForbidden` is correct as a
defense-in-depth layer; the protocol fee is the real wall. No exploitable gap.

---

### F-92-3 — Voter coordination: small bribers + unanimous self-vote (LOW)

**Scenario.** Two attackers — Alice (briber-A, depositor wallet) and Bob (briber-B,
depositor wallet) — each deposits a tiny bribe on the same (epoch, pair). Both ALSO
control voter wallets V1, V2 with substantial VP. Both V1 and V2 vote unanimously on
that pair. Either Alice or Bob is BOTH a depositor AND a voter (via V1 = D-A or V2 =
D-B).

**Capital.** Two bribes (sum >= MIN_BRIBE_AMOUNT * 2 = 0.002 ETH or token-min) plus VP.

**Why this doesn't print.** If V1 == D-A or V2 == D-B, that voter is locked out. If V1
and V2 are fresh wallets distinct from D-A and D-B, then we're back to the F-92-1
pure-economic ratio: total claim = 0.97 * (B-A + B-B) * f, and f * 0.97 < 1.

Net: the only thing the "coordination" achieves is concentrating two bribers' bonds
into one pool — voters now pull from 0.97 * (B-A + B-B) instead of 0.97 * B-A and
0.97 * B-B separately. **Pure aggregation, no edge.**

**Verdict: NOT EXPLOITABLE.** The depositor lockout is per-(user, epoch, pair) so
multiple bribers on the same pair don't compound or unlock anything special.

---

### F-92-4 — Bribe pair X, vote pair Y (vote-misalignment arbitrage) (DEAD-END)

**Scenario.** Attacker deposits a bribe on pair X but votes on pair Y, hoping
that the bribe somehow sloshes between pools.

**Recipe.**

1. Briber D deposits B token on (epoch, X) → `epochBribes[epoch][X][token] = 0.97 * B`.
2. Voter V votes power p on (epoch, Y) → `gaugeVotes[V][epoch][Y] = p`.

**Why it doesn't work.** `claimBribes(epoch, X)` line 794 reads
`gaugeVotes[V][epoch][X]` — the user must have voted on pair X to claim X's bribes.
Voting on Y allocates power to `gaugeVotes[V][epoch][Y]` only.

Cross-pair claim is impossible by design. The (epoch, pair, token) keying is uniform
across `epochBribes`, `epochBribeTokens`, `claimed`, `gaugeVotes`, `totalGaugeVotes`,
`bribeDeposits`, `lastBribeDepositPerUser`, `depositedOnPair`. There's no path that
cross-references X-bribes to Y-votes.

**Side question: does GaugeController emission allocation leak to pair Y?**

`GaugeController.gaugeWeightByEpoch` is keyed on (epoch, gauge), and gauges are 1:1 with
pairs via `pairToGauge[pair] = gauge` (line 875). VoteIncentives.vote and
GaugeController.vote/revealVote are SEPARATE governance surfaces with separate
denominators — voting on the GaugeController allocates TOWELI emission, voting on
VoteIncentives unlocks bribe claims. They share data only at the pair address; gauge
weight and bribe-vote allocation are independent. So bribing X-bribers + voting
GaugeController on Y is also misaligned — the Y-gauge gets emission, not the X-bribe-
recipient.

**Verdict: NO EDGE.** Cross-pair leakage doesn't exist in either contract.

---

### F-92-5 — Curve-wars: lock TOWELI, vote to gauge that emits TOWELI to your address, recursive (LOW)

**Scenario.** Classic Curve-wars flywheel. Alice locks 1M TOWELI for 4 years (4.0x
boost → 4M VP). She deposits LP into pool P. The gauge for pool P gets her vote. The
gauge therefore receives a slice of the next epoch's TOWELI emission. A keeper /
admin distributes that slice via `notifyRewardAmount` on `TegridyLPFarming`. Alice's
LP position farms a disproportionate share of those new TOWELI, which she then
re-locks to amplify her VP next epoch, and so on.

**Capital.** 1M TOWELI initial + 4-year lock + LP into pool P.

**Recursion check.** Yes, this is a real flywheel. It is the INTENDED mechanic of
gauge-controlled emissions (pattern of record: Curve, Convex, Aura). There are several
mitigations in place:

1. **Per-vote per-gauge cap (`MAX_WEIGHT_PER_GAUGE_BPS = 5000`)** at
   `GaugeController.vote` line 379. A single vote can put at most 50% of its power on
   one gauge — caller must spread across at least 2 gauges. Halves the maximum capture
   share per-vote.
2. **GaugeController has NO automatic payout** — `getGaugeEmission` is read-only.
   Distribution to LP farms is admin-mediated via `notifyRewardAmount`, so the gauge
   weight gives Alice INFLUENCE over a manually-curated payout, not an automatic
   pull. This is a soft governance control: a captured admin still distributes per
   gauge weight, but a sane admin has discretion.
3. **Boost cap of 4.0x with 4-year lock**: Alice can't compound her own boost in any
   single epoch beyond the 4.0x ceiling.
4. **`hasUserVotedInEpoch[user][epoch]`** gate (line 324) means even with N NFTs,
   Alice gets ONE vote per epoch with her aggregate VP. No multi-NFT amplification.

**Profitability math.** Alice's emission share each epoch is approx
`0.5 * E * (V_Alice / V_total)` where E is the epoch budget and the 0.5 factor reflects
the per-vote per-gauge cap (assuming Alice votes 50% to her gauge and 50% to the
mandatory secondary gauge — she also gets 0.5x emissions on the secondary gauge but
those don't farm her LP unless she's also LPing there).

For Alice to capture meaningfully, V_Alice / V_total must be high. With 1M TOWELI of
total VP-supply in stakes (post-genesis), Alice's 4M VP would be 80%, capturing 0.5 *
0.8 * E = 0.4 * E per epoch. That is 40% of all new TOWELI flowing to her LP every
week. **This is governance capture by stake, not exploitation** — it's the explicit
trade-off of Curve-style vote escrow systems.

**Verdict: BY-DESIGN BEHAVIOUR.** The flywheel exists; it is the same one Curve / Frax
veCRV / Aerodrome operate under. The protocol-level mitigations (per-gauge cap,
per-user-per-epoch single-vote, manual emission distribution, 4-year max lock) keep
the worst case at 50% emission per epoch with 80% stake — economically rational, not
exploitative.

**One nit (DEEP-GOV-03 was already fixed):** historically a per-gauge cap of 50% on
DOWNSTREAM relative weight was removed in the V3-GOV-03 patch in favour of natural
distribution (line 757, "no cap"). That decision is documented and intentional — the
upstream caps (per-vote per-gauge, per-user-per-epoch) are sufficient. I confirm that
removal didn't reintroduce a 1-wei amplifier path because the upstream
`min(historical, current)` clamp at line 358 + 631 prevents post-divest VP application.

---

### F-92-6 — Claim then unstake (no skin in game) (DEAD-END)

**Scenario.** Alice stakes for 7 days, votes, claims bribes immediately, then early-
withdraws to recover stake (eating the 25% penalty), with bribe value > penalty.

**Math.**

- Min stake S = 100 TOWELI. Stake at 7d → 0.4x boost → 40 TOWELI-VP.
- Vote on bribed pair, fraction f = 40 / total_VP_on_pair.
- Claimable bribe = 0.97 * f * B.
- Early-withdraw penalty = 0.25 * 100 = 25 TOWELI.
- Net profit = 0.97 * f * B − 25 TOWELI cost (denominated in TOWELI-equivalent).

For a >= 7-day lock holder voting one epoch and dumping, profit requires
`0.97 * f * B > 25 TOWELI`. With small f (Alice = 40 VP vs total = 10,000 VP →
f = 0.004) and B = 1 ETH bribe, profit needs B in TOWELI-equivalent > 6440 TOWELI.

The KEY GUARD here is the `ClaimWindowNotOpen` revert at `claimBribes` line 791:
**claim only opens AFTER `voteEnd = epoch.timestamp + VOTE_DEADLINE` (= 7 days
post-snapshot, or revealDeadline for commit-reveal epochs).** And critically:

- `epochs.timestamp = block.timestamp - SNAPSHOT_LOOKBACK = T - 1 hour` at advance
  time.
- Vote window from T to T + 7 days.
- Claim opens at T + 7 days.

So Alice cannot claim until 7 days after the epoch's snapshot. Her lock minimum is
also 7 days, so she could in theory unstake the moment her lock expires AND the claim
window opens — but only if she happens to have started her stake at exactly the
epoch-start moment. In practice she has to wait at least one full lock cycle past the
voting deadline.

But more importantly: **`votingPowerAtTimestamp(user, epochStart - 1)` is the
historical lookup**, while she can claim at `T + 7 days`. The
`min(historical, current)` clamp at `vote()` line 622-626 says her vote power is
`min(historical_at_snapshot, current_at_vote_time)`. She votes during the 7-day
window. If she pre-emptively unstakes before voting, current = 0 and she reverts
NothingToClaim. If she votes first then unstakes, the recorded `gaugeVotes[V][epoch][pair]`
is locked in at vote time — she CAN unstake afterwards without losing her recorded
share. So:

- Day 0: stake (deposit 100 TOWELI, lock 7 days).
- Day 0–6: vote during the 7-day vote window (call site captures `min(historical_at_T-1h,
  current)` — both are her real 40 VP; vote registers).
- Day 7: lock expires. Withdraw normally with NO penalty.
- Day 7+: claim window opens. Claim her share.

That's the legitimate honest path — **no penalty needed**. Her cost is the
opportunity-cost of 100 TOWELI locked for 7 days. If `0.97 * f * B > opportunity-cost
of 100 TOWELI for 7 days`, she profits. Whether that is profitable is a matter of
bribe market efficiency, not an exploit.

**Sub-scenario: split stake into many 7d locks for high f.**

- Aggregate VP per EOA is capped by `hasUserVotedInEpoch[user][epoch]` to ONE vote
  per epoch (line 324). She'd need N distinct EOAs.
- Each EOA needs >= 100 TOWELI. So to get N * 40 VP, she needs N * 100 TOWELI.
- Her recovered claim ≤ 0.97 * (N * 40) / (N * 40 + honest_VP) * B. Same math as
  F-92-1 — bounded above by 0.97 * B.

She earns at most 0.97 * B − fees, against an opportunity cost of N * 100 TOWELI for
7 days. For small B (e.g., 1 ETH ≈ 0.01 TOWELI worth at typical altcoin pricing), this
is unprofitable. For large B, the bribe market is irrational and she's not exploiting,
she's the rational-counterparty bribers WANT.

**Verdict: NOT AN EXPLOIT.** The 7-day lock is the minimal skin-in-the-game, and the
`epoch.timestamp + VOTE_DEADLINE = 7d` claim gate aligns with it. Alice CAN claim
without burning the early-withdraw penalty — but only by waiting for her lock to
expire naturally. This is intended.

---

### F-92-7 — Bribe-with-stable, claim-emission-TOWELI, dump on AMM, sandwich (NOT-IN-CONTRACT)

**Scenario.** Briber deposits USDC on (epoch, pair). Voters claim USDC. Attacker is
the same wallet as the briber (not possible — `SelfBribeClaimForbidden`), or attacker
front-runs the claim and back-runs by dumping TOWELI on AMM.

**This scenario describes MEV, not a contract bug.** The claim emits ETH or ERC20 to
the voter (USDC, TOWELI, etc.). Whether that voter then dumps TOWELI on the AMM and
sandwiches their own dump is independent of the bribe contract. There's no direct
link.

**Indirect concern: dust dumping.** Voters whose share rounds to 0 are still marked
`claimed[V][e][p][t] = true` (line 832, DEEP-GOV-02 fix), which gas-griefs them but
doesn't lose principal. If a malicious whale could fragment a voter's share to dust,
they could effectively block them from earning. But share rounding follows
`(bribeAmount * userVote) / totalVotes`, which only rounds to 0 if `userVote <
totalVotes / bribeAmount`. For a 1 ETH bribe and 10,000 TOWELI-VP totalVotes, dust
threshold is `1e18 / 1e22 = 1e-4 = 0.0001 wei` per VP — only voters with < 0.0001 VP
round to 0, which is impossible given MIN_STAKE = 100 TOWELI / 0.4x boost = 40 VP.
**Not exploitable.**

**Verdict: OUT OF CONTRACT SCOPE.** Bribe market mechanics are correct.

---

### F-92-8 — Pool-killer: collude with whale to disable competitor's gauge (LOW)

**Scenario.** Attacker controls big whale Bob (60% of stake). Bob votes 50% of his
power to gauge X (his own preferred), 50% to gauge Y (a competitor's). Bob then asks
admin (or gets admin captured) to call `proposeRemoveGauge(Y)`. This requires a
24-hour timelock. After the timelock, `executeRemoveGauge(Y)` reverts because Y has
votes (Bob's own 50%). Use `executeRemoveGaugeNextEpoch(Y)` to disarm Y immediately
(pair mapping cleared, no future votes, no future bribes).

**Capital.** Bob = 60% of stake. Admin role required (timelock).

**Why this is "soft" only.**

1. `executeRemoveGauge` requires `gaugeWeightByEpoch[currentEpoch][gauge] == 0` —
   blocked by Bob's own vote. Bob would have to NOT vote for Y in the current epoch
   to enable the synchronous remove path.
2. `executeRemoveGaugeNextEpoch` (line 966) flips `isGauge[Y] = false` and clears
   `pairToGauge[pair]` IMMEDIATELY but lets the current-epoch vote weight stand.
   Y's emission for the current epoch is preserved; future epochs cannot vote on Y.
3. Both paths require admin (`onlyOwner`). A captured admin can already do anything;
   this isn't a unique exploit primitive.
4. `pendingGaugeRemove != 0` blocks `proposeRemoveGauge` for any other gauge until
   `executeRemoveGaugeFinalize` (permissionless) runs. So an attacker can stage at
   most ONE pending remove at a time — no ability to wholesale wipe gauges in one tx.

**Subtler wrinkle: `cancelRemoveGauge` (line 1013) DOESN'T clear pending state when
the propose was via `executeRemoveGaugeNextEpoch`.** Cross-checked: the
next-epoch path calls `_execute(GAUGE_REMOVE)` which consumes the timelock proposal,
so `cancelRemoveGauge` would revert with `NoPendingProposal` from `TimelockAdmin`.
`pendingGaugeRemove` stays set until `executeRemoveGaugeFinalize` runs (permissionless
once weight zeroes). This is the intended state machine — comment at line 894–905
documents it correctly. **No state-machine flaw.**

**Verdict: NOT A UNIQUE EXPLOIT.** Admin governance can disable competitor gauges,
but that's the timelock's purpose. No off-admin path lets a whale forcibly remove a
gauge.

---

### F-92-9 — Off-chain coordination cost; minimal whale capital (CONTEXT)

**Vector.** Realistic minimum to acquire majority gauge influence.

**Math.**

- Total VP at epoch e ≈ `totalBoostedStake` (read at advance via
  `votingEscrow.totalBoostedStake()`, line 531).
- For a whale to control 50% of `totalGaugeVotes[epoch][pair]`, they need 50% of the
  active stake voting on that pair — which depends on whether other holders even
  vote.
- In practice for new gauges, voter participation is low. A whale with 4-year-locked
  100k TOWELI (400k VP) could plausibly hit 50% of a single pair's votes for several
  epochs at relaunch.
- **Hard cap from `MAX_WEIGHT_PER_GAUGE_BPS = 5000`**: even a 100% whale cannot put
  more than 50% of his vote on one gauge per `vote()` call. So 400k VP whale's actual
  X-vote is bounded at 200k. With 1.0 default LP-farming rewardsDuration, this still
  captures an enormous slice for several epochs.
- **`MIN_BRIBE_CLAIM_QUORUM = 100 TOWELI-VP` floor**: a non-quorum bribe pool is
  refunded to depositors, which means a whale cannot drain a sub-quorum bribe by
  voting alone — it falls into `refundSubQuorumBribe` after 14d grace and the
  depositor recovers. Actually GOOD for the whale's victims.

**Realistic minimum capital for material capture:** ~10–50% of total active TOWELI
stake, locked 4 years, voting at the per-gauge cap each epoch. At post-genesis with
e.g. 5M total staked and 4x boost, capturing ~40% of pair votes via 50% per-gauge cap
needs ~5M VP supply * 0.4 / 4x = ~500K TOWELI locked 4yr. **High but not absurd**
for a determined whale; the per-vote per-gauge cap halves their max impact.

**Verdict: GOVERNANCE CONCENTRATION RISK NOT BUG.** Standard veToken risk; mitigations
are in place. Nothing further to flag at the contract level.

---

### F-92-10 — Vote-incentive market efficiency vs Aerodrome / Velodrome (CONTEXT)

**Where Tegridy's bribe market diverges from Aerodrome:**

| Property | Aerodrome | Tegridy VoteIncentives |
|---|---|---|
| Self-bribe lockout | **No on-chain** (relies on off-chain detection) | YES — `SelfBribeClaimForbidden` |
| Min-quorum gate | No (claims fail with rounding) | YES — `MIN_BRIBE_CLAIM_QUORUM = 100e18 VP` |
| Sub-quorum refund | None — bribe stranded | `refundSubQuorumBribe` after 14d grace |
| Unvoted-pair refund | After grace, by depositor | `refundUnvotedBribe` after 14d grace |
| Orphan-rescue (no advance) | Owner-only sweep | Permissionless per-depositor pull `refundOrphanedBribe` after 30d |
| Commit-reveal voting | Only on Hidden Hand v2 + Aerodrome | YES, native — both `GaugeController` and `VoteIncentives` |
| Snapshot lookback | 1 block | `SNAPSHOT_LOOKBACK = 1 hour` (much stronger) |
| Vote deadline crystallization | At epoch end | At `epoch.timestamp + 7d` (`ClaimWindowNotOpen` until then) |
| Per-vote per-gauge cap | None (Aerodrome) | `MAX_WEIGHT_PER_GAUGE_BPS = 5000` |
| Min-bribe floor | Per-token | Per-token + `DEFAULT_MIN_TOKEN_BRIBE = 1e15` fallback |

**Tegridy's posture is actually MORE conservative than Aerodrome.** Where Aerodrome's
laissez-faire approach lets bribers risk stranding bonds, Tegridy gives every
depositor at least one of three permissionless refund paths
(`refundOrphanedBribe`, `refundUnvotedBribe`, `refundSubQuorumBribe`). The lockout +
quorum + 7d snapshot lookback combine to make briber/voter manipulation strictly
worse-than-zero EV.

**One area of theoretical divergence concern: the protocol fee floor.** Aerodrome's
fee is configurable but the Tegridy fee CANNOT BE 0 (the `FEE_CANNOT_BE_ZERO` guard
at `applyFeeChange` line 1088 + the proposal-side check). This is GOOD — it prevents
the fee from being timelock-set to 0, which would re-enable the F-92-1 pure
sybil-cycle. **Aerodrome's fee can in principle go to 0** by governance, which IS a
known surface there. Tegridy is hardened against this.

**Where Tegridy is WORSE than Aerodrome (note, not finding):**

- The 7-day reveal window for `GaugeController` votes (24h reveal of 7d epoch) is much
  longer than Aerodrome's 4-day commit + 3-day reveal split. This gives committers
  more time to back out via `cancelCommit`. The cancel is gated by the
  `block.timestamp + 2 * REVEAL_GRACE >= revealOpens` (line 522, R016 M-1 fix) so
  see-then-cancel within a single block is impossible. Long cancel window means
  committers can cancel commitments based on observed deposit flow during the commit
  window — but since commits are HIDDEN by construction, no observer gains MEV. Net
  neutral.

- `VoteIncentives` uses 4d commit / 3d reveal (`COMMIT_RATIO_BPS = 4000` of
  `VOTE_DEADLINE = 7d`). NO cancel path on the bribe side — voters who commit must
  reveal or forfeit the 10 TOWELI bond. This is STRICTER than Aerodrome and prevents
  see-then-back-out.

**Verdict: BRIBE MARKET IS WELL-CALIBRATED.** No divergence-from-best-practice
findings.

---

## Notes / dead-ends explored that yielded nothing

### N-92-A. Cross-contract VP double-spend via restaking + staking

`VotePowerOracle.powerOf` (lib at line 64) sums staking + restaking power. The fix at
`votingPowerOf` line 532 of TegridyStaking forces the staking contract to return 0 for
the restaking address — preventing double-counting of the NFT custody. Verified — the
sum is correct: the restaking contract aggregates per-restaker VP via its own
bookkeeping, the staking contract returns 0 for the restaking-contract address, and
the oracle sums. **No double-spend.**

### N-92-B. Post-divest VP application via the snapshot/possession decoupling

`vote()` and `revealVote()` both apply `min(historical, current)` (lines 358, 631).
A voter who held 1M VP at snapshot and then divested 99.999% post-snapshot would now
read `min(1M, 1)` = 1 — no longer able to apply the historical aggregate. **Sealed.**

### N-92-C. Multi-NFT amplification via contract wallet

`hasUserVotedInEpoch[user][epoch]` (line 155) caps a contract holder of N NFTs to
one vote per epoch with the AGGREGATE power of all positions (line 324). Mirrors the
EOA `AlreadyHasPosition` guard (TegridyStaking line 1352). **No multi-NFT
amplification.**

### N-92-D. Bribe deposit on un-gauged pair → strand-then-claim

`depositBribe` line 652 + `depositBribeETH` line 721 both call `_requireGaugedPair`
which reads `pairToGauge` from `GaugeController`. A pair with no gauge cannot have
bribes deposited. **Bond cannot be stranded by depositing on a non-existent gauge.**

### N-92-E. EpochBribesFinalized race during advance → see-then-deposit

`advanceEpoch` line 553-565 atomically captures `newEpoch = epochs.length`, pushes the
EpochInfo, AND sets `epochBribesFinalized[newEpoch] = true` in the same transaction.
A briber's `depositBribe` reads `epochs.length` AFTER the push (= newEpoch + 1, the
next live bucket), so they cannot retroactively deposit into the just-finalized
bucket. The defense-in-depth `require(!epochBribesFinalized[epoch], "EPOCH_FINALIZED")`
in deposit paths confirms this. **Sealed.**

### N-92-F. `userActiveCommit` byte32 vs hash collision

`GaugeController.commitVote` line 481 stores the FULL commitment hash in
`userActiveCommit[user][epoch]`. A future cancel + recommit must use a different hash
(or the cancel reverts because the slot is non-zero). Not a collision risk because
hashes include `block.chainid`, `address(this)`, voter, tokenId, gauges, weights, salt,
and epoch — keccak256 collision-resistant. **No collision.**

### N-92-G. Bond sweep can drain TOWELI bonds via `sweepToken(toweli)`

`sweepToken` line 1389 reserves `totalCommitBonds` against `address(toweli)` (line
1396). Bonds in-flight cannot be swept. **Sealed — NEW-G9 fix is correct.**

### N-92-H. Treasury fee can re-enter via outgoing `safeTransfer`

`depositBribe` line 672 sends fee to treasury via `IERC20.safeTransfer` — a malicious
treasury contract that re-enters the bribe contract would face the
`nonReentrant` modifier at line 646. **Re-entrancy blocked.** The receive-side
`sweepExcessETH` (line 1378) uses `WETHFallbackLib.safeTransferETHOrWrap` with a 10k
gas stipend — not a full-gas `.call`, so a contract treasury cannot re-enter.

### N-92-I. Briber + Voter same EOA round-trip

A briber can be a voter with two wallets. If they're the SAME wallet, the
`SelfBribeClaimForbidden` lockout binds. With two wallets, they pay 3% fee on the
bribe and recover at most 0.97 of their bond − the voter's VP fraction's complement,
which never exceeds 0.97. **Always loss-making per F-92-1 math.**

### N-92-J. claimBribesBatch boundary off-by-one

Line 899 clamps `epochEnd > epochs.length → epochEnd = epochs.length`. Loop is
`for (uint256 e = epochStart; e < epochEnd; e++)`. Correct half-open interval. No off
by one.

### N-92-K. dustOf vs sweepable

`sweepToken(token)` reserves `totalUnclaimedBribes[token] + totalPendingTokens[token]`
(line 1392). `totalUnclaimedBribes` is decremented on every claim (line 855) but NOT
when share rounds to 0 (line 819–828 — DEEP-GOV-02 takes the rounding path without
decrementing the running total). So `totalUnclaimedBribes[token]` is a high-watermark
that PERMANENTLY reserves the dust. `dustOf(epoch, pair, token)` is observability-only
and not used for sweep accounting. **Sealed — sweep CANNOT touch dust because the
running total never decrements past it.**

### N-92-L. Batch-claim iteration cap

`MAX_BATCH_ITERATIONS = 200` (line 162) bounds the inner loop. With
`MAX_BRIBE_TOKENS = 20` per pair-epoch and `MAX_CLAIM_EPOCHS = 500` outer, theoretical
inner iterations could hit 10,000, but the inner-counter cap at line 964 reverts at
200 with `TOO_MANY_ITERATIONS`. Voters with many epochs may need to paginate. **DoS
not exploitable** because the voter can always claim per-epoch via
`claimBribes(epoch, pair)` instead.

### N-92-M. Vote on disabled pair

`vote()` line 604 calls `_validatePair(pair)` which now checks `factory.disabledPairs`
(line 1439). DEEP-GOV-08 fix. Reveal on disabled pair also validated at line 1589.
Disabled-pair voters can use `forfeitCommitOnDisabledPair` (line 1657) to recover bond
+ committedPower. **Sealed — V2-GOV-01 / V2-GOV-02 closed.**

### N-92-N. `forfeitCommitOnDisabledPair` permissionless griefer

Line 1674 (`if (msg.sender != user && msg.sender != owner()) revert Unauthorized()`)
restricts to commit-owner or contract-owner. G-01 fix. **Sealed — third-party griefer
cannot destroy a victim's commit during a transient disable.**

### N-92-O. min-bribe overflow via `MAX_MIN_BRIBE_AMOUNT = 1e24`

BATCH-H M13 cap at 1e24 (1M tokens at 18 decimals) prevents a captured admin from
DoSing all future deposits via type(uint256).max. **Sealed.**

---

## Final summary — finding count

- **Code-level findings (new):** 0 (the bribe market is well-hardened).
- **Context items (governance-concentration / by-design):** 2 (F-92-5 curve-wars
  flywheel and F-92-9 minimal-whale capital are governance-concentration risks
  inherent to vote-escrow design and are correctly mitigated by the per-vote
  per-gauge cap and per-user-per-epoch single-vote guards).
- **Comparison-favourable observations vs Aerodrome:** 1 (F-92-10).
- **Notes / dead-ends sealed:** 15 (N-92-A through N-92-O).

**Net verdict.** The vote-bribe wash-trading and curve-wars surface in
`GaugeController` + `VoteIncentives` is well-defended against direct exploitation. The
multi-layer defense (depositor lockout + min-quorum + sub-quorum refund + commit-
reveal + per-vote per-gauge cap + per-user-per-epoch + min-clamp + 1h snapshot
lookback + 7d claim-window crystallization + 3% irreducible protocol fee) makes every
profitable wash-trade arithmetic impossible without accepting strict net loss on the
protocol fee. The only remaining concentration risk is the standard veToken whale-
capture flywheel (F-92-5), which is BY-DESIGN inherent to vote-escrow systems and
already capped at 50% per-vote.

No code changes recommended from this lens.
