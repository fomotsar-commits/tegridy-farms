# Agent 21 — MemeBountyBoard Fresh-Look Audit

**Target:** `contracts/src/MemeBountyBoard.sol` (859 lines)
**Lens:** bounty escrow, voting, payout, submission/curation
**Date:** 2026-05-07
**Approach:** Read-only fresh-eyes; no audit-history files consulted.

---

## Summary table

| ID      | Severity | Status   | Title                                                                               |
| ------- | -------- | -------- | ----------------------------------------------------------------------------------- |
| F-21-1  | LOW      | LIKELY   | `sweepExpiredPayout` cannot pendingRefund-fallback; treasury contract recv. >50k bricks sweep |
| F-21-2  | LOW      | LIKELY   | `refundTimestamp` overwrite (latest-wins) is INCONSISTENT with `pendingPayoutTime` (earliest-wins) |
| F-21-3  | LOW      | LIKELY   | `BountyDisputed` event declared but never emitted (dead event, no on-chain disputes)|
| F-21-4  | LOW      | LIKELY   | Short-deadline (~1d) bounty: `effectiveCancelDelay` collapses, leaving 1h front-run window |
| F-21-5  | INFO     | DESIGN   | `voteToken` immutable but never read post-construct — confusion / dead state         |
| F-21-6  | INFO     | DESIGN   | `originalCreator == creator` always; double-check is redundant defense-in-depth     |
| F-21-7  | INFO     | NOTE     | Restaking-contract gap: between deploy and `setRestakingContract`, restakers count zero |
| F-21-8  | INFO     | DESIGN   | Sock-puppet completion floor: 4 wallets (1 submitter + 3 voters) × 1k TOWELI = 3.5k TOWELI total to fake a payout (documented L-B01) |
| F-21-9  | LOW      | LIKELY   | Event omission: `RefundCredited` is emitted on cancel paths but NOT on `cancelBounty` happy-path success |
| F-21-10 | INFO     | OK       | Reentrancy via 50k-gas `winner.call`: gas-bounded; cannot re-enter voteForSubmission/submitWork (cross-contract VotePowerOracle reads exceed budget) |

10 findings (1 medium-leaning low, 4 low, 5 info). **No HIGH or CRITICAL vulnerabilities surfaced.**

---

## F-21-1 — `sweepExpiredPayout` lacks pendingRefund-fallback; bricked by treasury contract that receive()s >50k gas

**Severity:** LOW
**Confidence:** LIKELY
**Location:** `MemeBountyBoard.sol:632-642`

### Description

`sweepExpiredPayout(address winner)` transfers an expired payout to `treasury` using:

```solidity
(bool ok,) = treasury.call{value: amount, gas: 50_000}("");
if (!ok) revert ETHTransferFailed();
```

If `treasury` is later rotated (via the 48h timelock) to a contract whose `receive()` consumes more than 50k gas (e.g., a Gnosis Safe with custom hooks, a vesting/treasury contract that re-records ETH on receive), every call to `sweepExpiredPayout` reverts hard. There is **no fallback to `pendingRefund` or to a WETH wrap** — unlike `withdrawPayout()` which uses `WETHFallbackLib.safeTransferETHOrWrap`.

### Impact

- DoS on payout sweeps until owner re-rotates `treasury` to a 50k-gas-tolerant address (48h timelock = 48h minimum DoS window).
- Honest winners are unaffected (they still have `withdrawPayout`).
- ETH is not at risk of loss — just stuck pending until treasury is fixed.

### Mitigation

Replace the raw `.call` with `WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, amount)`. This mirrors the `withdrawPayout` (line 652) and `sweepExpiredRefund` (line 814) patterns. Treasury would receive WETH if ETH path fails — no DoS, accounting still flows.

### Note

Lower-bound impact because:
1. Owner can re-rotate treasury after 48h.
2. WETH-only treasury still works for `sweepExpiredRefund` (which uses safeTransferETHOrWrap) but breaks for `sweepExpiredPayout`. **Inconsistent fallback semantics across siblings.**

---

## F-21-2 — `refundTimestamp` is latest-wins; INCONSISTENT with `pendingPayoutTime` earliest-wins anchor

**Severity:** LOW
**Confidence:** LIKELY
**Location:**
- `cancelBounty:696` — `refundTimestamp[bounty.creator] = block.timestamp;` (overwrite)
- `refundStaleBounty:735` — same
- `emergencyCancel:756` — same
- `emergencyForceCancel:788` — same
- vs. `completeBounty:614` — `if (pendingPayoutTime[winner] == 0) pendingPayoutTime[winner] = block.timestamp;` (preserve earliest)

### Description

When a creator has multiple cancelled bounties crediting `pendingRefund` at different times, every new credit **overwrites** `refundTimestamp[creator]` with `block.timestamp`. This makes `sweepExpiredRefund` (line 808) gate on the LATEST credit, not the EARLIEST.

```solidity
require(refundTimestamp[_user] != 0 && block.timestamp >= refundTimestamp[_user] + REFUND_EXPIRY, "NOT_EXPIRED");
```

So if a creator has `Bounty A` cancelled 11 months ago (~$1000 of refund) and `Bounty B` cancelled 1 day ago (~$1 of refund), the consolidated `pendingRefund` cannot be swept until the OLDEST credit is at minimum `latest_credit_time + REFUND_EXPIRY` — adding up to 364 days of additional protection on the older funds.

By contrast, `pendingPayoutTime` uses an earliest-wins anchor (line 614 only writes if zero), so the sweep timer reflects the FIRST-credit time.

### Impact

- **Not a fund-loss vulnerability**: creator can withdraw at any time via `withdrawRefund`. Sweep is a 1-year safety net.
- **Effective protection-window asymmetry**: the refund path's sweep is delayed by repeat-credits, the payout path's is not.
- **Could be deliberate** if the design intent is "fresh credits reset the sweep timer to give creator a new full 1-year window," but the comment at line 614 explicitly says "preserves earliest-credit anchor on subsequent appends" — implying the OPPOSITE design philosophy was applied to the sister path.

### Mitigation

Change `refundTimestamp[bounty.creator] = block.timestamp;` to:
```solidity
if (refundTimestamp[bounty.creator] == 0) refundTimestamp[bounty.creator] = block.timestamp;
```
across all four cancel paths. Mirrors the M18 pendingPayoutTime pattern.

---

## F-21-3 — `BountyDisputed` event declared but never emitted; no on-chain dispute mechanism

**Severity:** LOW
**Confidence:** LIKELY
**Location:** `MemeBountyBoard.sol:188` (declaration)

### Description

```solidity
event BountyDisputed(uint256 indexed bountyId, address indexed disputer); // SECURITY FIX #15
```

The `DISPUTE_PERIOD = 2 days` constant is enforced in `completeBounty` as a delay between deadline and complete-eligibility (line 572). However, **there is no `dispute()` function**, and `BountyDisputed` is never `emit`ted anywhere in the contract.

The "dispute period" is therefore a passive 2-day cooldown — not an active dispute mechanism. Off-chain monitors that subscribe to `BountyDisputed` events (per the event's `indexed` signature) will never see them.

### Impact

- Pure event-bloat / dead code.
- Misleading documentation: `// SECURITY FIX #15` comment suggests active dispute system that does not exist.
- No security risk.

### Mitigation

Either remove the dead event, or add a `disputeBounty(uint256)` function that lets a stakeholder flag a bounty during the dispute window. The current code is honest about it being a passive delay — just delete the unused event for cleanliness.

---

## F-21-4 — Short-deadline (≈1d) bounty: `effectiveCancelDelay` collapses to `bountyDuration - 1h`, leaving 1-hour creator-front-run window for first submission

**Severity:** LOW
**Confidence:** LIKELY
**Location:** `cancelBounty:677-684`

### Description

The V2-GOV-09 mitigation scales the cancel delay for short-deadline bounties:

```solidity
uint256 bountyDuration = bounty.deadline - bounty.createdAt;
uint256 effectiveCancelDelay = MIN_CANCEL_DELAY;
if (bountyDuration < MIN_CANCEL_DELAY + 1 hours) {
    effectiveCancelDelay = bountyDuration > 1 hours ? bountyDuration - 1 hours : 0;
}
```

For a 1-day-deadline bounty (the protocol minimum):
- `bountyDuration = 24h`, which is `< 25h`.
- `effectiveCancelDelay = 24h - 1h = 23h`.

So the cancel window is `[createdAt + 23h, deadline=createdAt+24h]` — **1 full hour of cancel-eligible time**.

During that 1-hour window, the M-10 protection still applies: cancel reverts with `CannotCancelWithSubmissions` if `bounty.submissionCount > 0`. **But** for the FIRST submission, the race between the creator's `cancelBounty` tx and the artist's `submitWork` tx is undecided.

In a public mempool (Arbitrum, Base, Optimism, Ethereum), an artist who broadcasts `submitWork` at hour 23.5 can be observed by the creator's bot. The creator pays priority fee to land `cancelBounty` first, getting the refund. Artist's `submitWork` reverts (or runs against `BountyNotOpen` because cancellation flipped the status to Cancelled). **Artist loses gas; creator extracted the artist's reconnaissance signal (artist's intent to submit) for free.**

### Impact

- DoS on first submitter for ≈1d bounties; loss of submission gas.
- No fund loss to the artist (they didn't deposit; only paid revert gas).
- For longer-deadline bounties (e.g., 7-day): cancel-eligible window starts at hour 24, leaving hours 0-24 for safe submissions and hours 24-168 for races. The race window scales linearly with bounty duration but is bounded.
- DEEP-GOV-11 already widened MIN_CANCEL_DELAY from 1h to 24h to mitigate this. The 1-day-bounty edge case is the residual.

### Mitigation

Either:
1. Raise `MIN_DEADLINE_DURATION` to `MIN_CANCEL_DELAY + 1 hour = 25 hours` so all bounties have at least 1h of submission-protected window.
2. Accept the 1d edge case and document explicitly that `1d` bounties have a known front-run primitive in the final hour.

The audit comment at lines 668-682 acknowledges the trade-off but doesn't quantify the residual race window for the minimum-duration case.

---

## F-21-5 — `voteToken` immutable retained but never read; ABI-noise / confusion

**Severity:** INFO
**Confidence:** OK
**Location:** `MemeBountyBoard.sol:49`

### Description

```solidity
IERC20 public immutable voteToken; // TOWELI — must hold tokens to vote (anti-sybil)
```

The natspec at lines 43-48 explicitly marks it as deprecated dead state:
> AUDIT FIX: DEEP-GOV-12 — voteToken is dead state; all voting power resolution goes through `stakingContract.votingPowerAtTimestamp`. This field is retained for ABI compatibility only.

So it is acknowledged. No security impact. But it's worth flagging that:
1. The constructor still requires `_voteToken != address(0)`, so deployers must pass a real address.
2. ABI consumers reading `voteToken()` may believe it's the canonical anti-Sybil token; it isn't.

### Mitigation

Document via NatSpec on the public getter (not just the storage slot) that this is a back-compat alias. Or remove in a future ABI-breaking version.

---

## F-21-6 — `originalCreator == creator` invariant; double-check at line 476 is defense-in-depth (no creator-mutation logic exists)

**Severity:** INFO
**Confidence:** OK
**Location:** `voteForSubmission:476`

### Description

```solidity
if (msg.sender == bounties[_bountyId].originalCreator || msg.sender == bounties[_bountyId].creator) revert CreatorCannotVote();
```

The contract has NO setter for `bounty.creator` — it is set once in `createBounty` (line 392) and never written elsewhere. The `originalCreator` field (line 408) snapshots the same value. They are byte-identical for the lifetime of every bounty.

The double-check is acknowledged in the audit comment as future-proofing. No security impact today.

### Note

Dead-code static analysis may flag `originalCreator` as redundant. The contract author explicitly chose to keep it; this is acceptable defensive coding.

---

## F-21-7 — Restaking-contract setup window: between deploy and `setRestakingContract`, restakers' voting power = 0

**Severity:** INFO
**Confidence:** NOTE
**Location:** `setRestakingContract:354-359`, `voteForSubmission:483-487`

### Description

`restakingContract` is **storage** (not immutable), set via the one-shot `setRestakingContract`. Until owner calls this, `restakingContract == address(0)`.

`VotePowerOracle.powerAt` and `VotePowerOracle.powerOf` skip the restaking lookup when `restaking == address(0)`. So during the setup window, **only staking-side power counts**. Users who restaked their staking NFT have `staking.votingPowerOf(user) == 0` (the restaking address holds the NFT). They cannot:
- Submit work (`MIN_SUBMIT_BALANCE` check fails).
- Vote (`MIN_VOTE_BALANCE` check fails).

If owner is slow to call `setRestakingContract`, restakers are silently disenfranchised across any bounty created in the gap. The bounty's snapshotTimestamp is locked at creation, so even after `setRestakingContract` is set, **bounties created during the gap continue to use a snapshot at which restakers had 0 staking-side power AND 0 restaking-side power (because `restaking == address(0)` then)**.

### Impact

- Operational/governance issue: deploy → setRestakingContract latency translates to disenfranchisement of all restakers for any bounty created in that window.
- No fund loss; no permanent damage to the protocol — just user-experience degradation in the bootstrap window.

### Mitigation

- Document the deploy runbook to call `setRestakingContract` BEFORE any bounty is created.
- Or make `restakingContract` immutable in the constructor and require it be set at deploy time (breaks the "deploy before restaking exists" pattern).
- Or wire `restakingContract` to a deterministic CREATE2 address known at staking deploy time.

---

## F-21-8 — Sock-puppet completion floor: 4 distinct addresses + 3.5k TOWELI total = fake completion

**Severity:** INFO
**Confidence:** OK / DESIGN-DOCUMENTED
**Location:** Multiple (`MIN_SUBMIT_BALANCE`, `MIN_VOTE_BALANCE`, `MIN_COMPLETION_VOTES`, `MIN_UNIQUE_VOTERS`)

### Description

Quorum constants:
- `MIN_VOTE_BALANCE = 1000 ether` (TOWELI per voter)
- `MIN_COMPLETION_VOTES = 3000 ether` (aggregate per bounty)
- `MIN_UNIQUE_VOTERS = 3`
- `MIN_SUBMIT_BALANCE = 500 ether` (per submitter)

Submitters cannot vote (line 471 SubmitterCannotVote). Creator cannot vote (line 476). So the minimum collusion for fake completion = **1 creator address + 1 submitter address (500 TOWELI) + 3 voter addresses (3 × 1000 = 3000 TOWELI) = 4 sock-puppet addresses + 3500 TOWELI staked + bounty reward in ETH**.

Result: creator pays themselves a kickback by routing the bounty payout to the submitter sock-puppet.

### Impact

This is **explicitly documented** in the L-B01 NatSpec at lines 59-68:
> The thresholds exist solely to filter pure zero-cost spam... All ECONOMIC anti-Sybil enforcement happens elsewhere (MIN_COMPLETION_VOTES, MIN_UNIQUE_VOTERS, snapshot-based voting power).

But MIN_COMPLETION_VOTES is the very threshold the attacker meets here. The defense relies on **economic discouragement**: 3500 TOWELI of stake-locked capital + gas. For tiny bounties (close to `minBountyReward = 0.001 ETH`), the locked-stake opportunity cost ($X for 7 days while collecting voting on bounties) likely exceeds the recovered reward.

Severity is INFO because:
1. Attacker recovers their own bounty reward minus gas (zero-sum).
2. No third party loses funds.
3. Real attack value is content-laundering (minting "verified by community" stamps on owned content). For meme-board UX, this is acceptable.

### Note

If higher-value bounties become common (>$100), the economic-disincentive thinning. Owner could ratchet `minBountyReward` up to make 3500 TOWELI worth less than the floor. But that contradicts the meme-UX accessibility goal. Acceptable trade-off as documented.

---

## F-21-9 — `cancelBounty` happy-path success does not emit `RefundCredited`; only fail-path does

**Severity:** LOW
**Confidence:** LIKELY
**Location:** `cancelBounty:692-700`

### Description

```solidity
(bool success,) = bounty.creator.call{value: bounty.reward, gas: 10000}("");
if (!success) {
    pendingRefund[bounty.creator] += bounty.reward;
    refundTimestamp[bounty.creator] = block.timestamp; // M-09: Track refund time
    emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
}

emit BountyCancelled(_bountyId);
```

When ETH-send succeeds, only `BountyCancelled(bountyId)` is emitted. No event records the **amount** refunded. Off-chain indexers must fetch the bounty's `reward` field separately.

The `WETHFallbackLib` ETH path emits `ETHTransferred(to, amount)` on success — but the lib is NOT used in `cancelBounty` (it uses raw `.call{gas:10000}` directly). So **no amount-bearing event** fires on the cancel happy path.

### Impact

- Indexer infrastructure must do a join query: `BountyCancelled.bountyId` → `bounties[bountyId].reward` via eth_call. Adds latency and RPC load.
- If bounty later has its `reward` field zeroed (it never is in current code, but a future migration might), the historical refund amount becomes unreadable.
- The fail-path emits `RefundCredited(bountyId, creator, amount)` — clean indexable trail. Asymmetric across success/fail.

### Mitigation

Emit `RefundCredited(_bountyId, bounty.creator, bounty.reward);` unconditionally before/after the call. Move it to the top of the function (after status flip) for atomic accounting.

Or: switch `cancelBounty` (and `refundStaleBounty`, `emergencyCancel`, `emergencyForceCancel`) to use `WETHFallbackLib.safeTransferETHOrWrap` which emits `ETHTransferred` on success. Mirrors the M-B01 / DEEP-LIB-L1 indexer-symmetry rationale already applied to other paths.

---

## F-21-10 — Reentrancy via 50k-gas `winner.call`: gas-bounded; not exploitable (NOTE / OK)

**Severity:** INFO
**Confidence:** OK
**Location:** `completeBounty:604`

### Description

`completeBounty` sends ETH with a 50k gas stipend. `nonReentrant` blocks re-entry into all guarded payout/cancel functions. Non-guarded entry points (`voteForSubmission`, `submitWork`, `createBounty`) could in principle be re-entered, but:

- `voteForSubmission` makes 2 cross-contract calls to `VotePowerOracle.powerAt` + `powerOf`, each ≥30k gas. After receive() base costs and call overhead, available gas inside the inner call is < 40k → out-of-gas → revert.
- `submitWork` makes 1 cross-contract call to `VotePowerOracle.powerAt` ≥ 30k → similar OOG.
- `createBounty` requires `msg.value >= minBountyReward`. The receive() callback runs against MemeBountyBoard's own balance, but `payable` requires explicit value — the callback cannot send ETH back to MemeBountyBoard without an additional call burning more gas than the 50k stipend.

**Net:** the 50k stipend bounds the attacker to receive() + minimal logging; no governance or fund-flow impact reachable.

### Note

This is a defense-in-depth confirmation. The DEEP-MEME-M1 audit already considered this when bumping 10k → 50k. No action needed.

---

## Notes / dead-ends explored

1. **Vote-then-unstake reuse across bounties** — Each bounty's snapshot is independent. To vote on bounty B, you need stake at B's snapshot (T_B - 50min). Unstaking after voting on A doesn't help reuse that stake on B unless you maintain stake until T_B - 50min. Net: not exploitable.

2. **Force a permanent tie at top** — Strict `newVotes > topSubmissionVotes` means a tied submission can't replace the leader. Both submissions could be voted to equal levels, but the next voter breaks the tie. With public mempool, anyone can vote → no permanent tie. Not exploitable.

3. **`address(0)` winner** — `submitter = msg.sender` in `submitWork`; Solidity disallows `msg.sender == address(0)`. So `winner` is never zero. Safe.

4. **`bounty.snapshotTimestamp == block.timestamp - 1` fallback** — Only triggers when `block.timestamp < SNAPSHOT_LOOKBACK = 3000s`. In real prod chains, block.timestamp is ≥10^9. So the fallback is testnet-only. Not a real-world concern.

5. **Sequencer outage extending GRACE_PERIOD asymmetrically** — `completeBounty` does NOT use `_sequencerBuffer()`; `refundStaleBounty` and `emergencyForceCancel` DO. This is intentional: completeBounty pays the WINNER, who shouldn't be punished by outage; the other two extract funds from a possibly-meritorious bounty so honest voter protection is needed. Correct asymmetry.

6. **`MIN_REWARD_CHANGE` ratcheting attack** — Owner can raise `minBountyReward` to 1 ETH (capped). Kills meme UX but doesn't drain or freeze anything. Owner risk only.

7. **`getBounty` view function returns `creator/reward/deadline` even after cancel/complete** — Storage isn't cleared. Minor gas overhead; not exploitable.

8. **`hasVotedOnSubmission` mapping kept for back-compat** — Line 144 mapping is set in voteForSubmission (line 494) but never read for any decision. Dead state by design.

9. **Off-chain content (URI/IPFS) censorship** — `contentURI` is a string, stored permanently. Once submitted, no one can mutate or delete. There is no censorship surface; URI is immutable. Submitter could submit malicious content, but on-chain enforcement is impossible.

10. **`cancelBounty` allows owner to cancel any bounty (without submissions)** — Line 665. Owner risk: captured key can grief by cancelling open bounties. Bounded by M-10 (no submissions). Documented owner power.

11. **Vote-bounty mapping `hasVotedOnBounty[_bountyId][msg.sender]` is set true but never reset** — A voter who voted then "uncasts" (impossible in current code, no uncast function) — irrelevant.

---

## Appendix — sanity audit of constants

- `MIN_DEADLINE_DURATION = 1 day` — OK, gives at least 1d window for submissions.
- `MAX_DEADLINE_DURATION = 180 days` — OK, prevents indefinite ETH lock.
- `MIN_CANCEL_DELAY = 24 hours` — OK, scaled for short bounties.
- `EMERGENCY_FORCE_CANCEL_DELAY = 7 days` — OK, after grace.
- `DISPUTE_PERIOD = 2 days` — OK (passive cooldown only).
- `GRACE_PERIOD = 30 days` — OK, creator deadline before public completion.
- `TOP_FREEZE_WINDOW = 1 day` — OK, with V2-GOV-08 established-leader gate.
- `SNAPSHOT_LOOKBACK = 250 blocks * 12s = 3000s ≈ 50min` — OK, anti-flash-stake.
- `MIN_VOTE_BALANCE = 1000 ether` / `MIN_COMPLETION_VOTES = 3000 ether` / `MIN_UNIQUE_VOTERS = 3` — coordinated; minimum 3 voters × 1000 = 3000 = quorum exactly. **Acceptable per L-B01 design intent.**
- `MAX_SUBMISSIONS_PER_BOUNTY = 100` — bounded; no DoS.
- `REFUND_EXPIRY = PAYOUT_EXPIRY = 365 days` — OK.
- `TREASURY_CHANGE_DELAY = 48 hours` — OK, sibling of POLAccumulator and CommunityGrants.

All constants pass sanity checks.

---

**End report.**
