# Agent 020 — MemeBountyBoard.sol Forensic Audit

**Target:** `contracts/src/MemeBountyBoard.sol` (520 lines)
**Cross-checked tests:** `contracts/test/MemeBountyBoard.t.sol`, `contracts/test/Audit195_Bounty.t.sol`
**Mode:** AUDIT-ONLY (no code changes)

---

## Hunt Scope Recap
1. Bounty claim race (two claimants front-running)
2. Creator cancel after submission
3. Claim-with-stale-signature
4. Owner judge-override rug
5. Prize splitting drift
6. Signature replay across bounties
7. Off-by-one on claimable window
8. Gas grief on enumeration
9. Unsafe transfer on prize token
10. Malicious URI in submission (XSS at frontend boundary)

---

## HIGH

### H-01 — Permissionless `completeBounty` race after grace period winner-flip
**Location:** lines 303–342 (`completeBounty`)
**Hunt match:** Bounty claim race (two claimants front-running)

After `deadline + DISPUTE_PERIOD + GRACE_PERIOD` (~32 days), `completeBounty` becomes permissionless. The contract still uses `topSubmissionVotes` and `topSubmissionId` as locked-in winner data, but voting is closed at `deadline`. So far OK — however, `voteForSubmission` (line 270) only checks `block.timestamp > bounty.deadline`. Between `deadline` and the call to `completeBounty`, an attacker watching the mempool can:

1. See `completeBounty(id)` enter the mempool with `submission #5` as `topSubmissionId`.
2. There is no race here because voting is already closed.

**Actual race:** Two callers both want to call `completeBounty` after grace expiry. First-tx wins. No financial loss to caller (winner is already determined), but griefer can replace the legit `creator` tx with their own using higher gas to claim "credit" / event ordering. Since payout flows to the locked-in `winner` only, **no fund-loss path here.**

**Verdict:** No exploitable claimant-race. Demote to LOW (event-spam / MEV ordering). Reclassified below as L-01.

### H-02 — `emergencyForceCancel` rug after legit submitters work, before quorum reached
**Location:** lines 442–461
**Hunt match:** Owner judge-override rug

Owner can `emergencyForceCancel` 7 days after deadline if `topSubmissionVotes < MIN_COMPLETION_VOTES` **AND** `totalBountyVotes < MIN_COMPLETION_VOTES * 2`. Because voters need 1000 TOWELI minimum, a low-engagement bounty (e.g., niche meme) where only 2 voters showed up totaling 5000 TOWELI is below `2 * 3000 = 6000`. Owner refunds creator after artists already did the work. **Artists get nothing, creator gets ETH back.**

Worst-case: a creator colludes with owner. Creator posts bounty → artists submit → creator quietly tells voters not to vote → after 7 days post-deadline, owner force-cancels → creator gets ETH back, artists ate the gas to submit and the opportunity cost.

**Mitigations present:** 7-day delay, vote threshold check. **Gap:** No artist compensation, no cooling-off after force-cancel, no rate-limit on creator's force-cancelled bounties. **Trust assumption on owner.**

**Severity:** HIGH if owner is unilateral; MEDIUM if owner is multisig. Per memory `project_wave0_pending.md`, the multisig `acceptOwnership` is still pending → currently HIGH.

### H-03 — `cancelBounty` race vs. `submitWork` (front-running submitter)
**Location:** lines 358–382, 232–256
**Hunt match:** Creator cancel after submission

`cancelBounty` reverts when `bounty.submissionCount > 0` (line 368). Good. But `MIN_CANCEL_DELAY = 1 hour` (line 57). An attacker scenario:

1. Honest artist watches mempool, prepares `submitWork`.
2. Creator sees public submissions (or even just predicts artist activity) and front-runs by calling `cancelBounty` after MIN_CANCEL_DELAY but before `submitWork`.
3. Artist's `submitWork` reverts with `BountyNotOpen`.

This is functionally OK — creator owns the ETH, can cancel pre-submission. But from an artist UX perspective, gas wasted. **Race window:** ANY moment `t > createdAt + MIN_CANCEL_DELAY` and `submissionCount == 0`.

**Severity:** MEDIUM (creator can cancel after artist clicked "submit" in UI but before tx mined). No fund loss to artist beyond gas. Reclassify to MEDIUM below as M-02.

---

## MEDIUM

### M-01 — Snapshot lookback bypass for fresh stakers
**Location:** lines 219–223
**Hunt match:** Claim-with-stale-signature analog (snapshot manipulation)

`SNAPSHOT_LOOKBACK = 1 hours`. Voting power snapshot = `block.timestamp - 1 hour`. A user can:

1. See a bounty about to be created (e.g., creator funds wallet).
2. Stake 1000 TOWELI exactly 1 hour + 1 second before bounty creation.
3. Be eligible to vote.

Battle-tested DAOs (Compound, Nouns) use 1-block or N-block lookback (~12 sec). 1 hour is generous for L2s but allows precise timing attacks. With `block.timestamp - 1` fallback (line 221) when chain timestamp < 1 hour (unrealistic on mainnet, but possible on test forks / new chains) snapshot collapses to 1-second lookback → **flash-stake possible.**

### M-02 — Creator front-runs honest artist's `submitWork` with `cancelBounty`
*(Promoted from H-03 above)*

After `MIN_CANCEL_DELAY` (1h) and before any submission, creator can cancel mid-mempool. Artist tx reverts. Recommend longer delay (24h) and/or commit-reveal for submissions.

### M-03 — Vote-count overflow / griefing via stake-weighted accumulation
**Location:** line 284
**Hunt match:** Prize splitting drift / gas grief

`submissions[_bountyId][_submissionId].votes += voterPower;` — `voterPower` is `uint256` from staking contract. If staking returns `type(uint256).max` (malicious mock or bug), single voter overflows or pre-sets `topSubmissionVotes` to max, locking in their preferred submission. Real staking contract should cap this, but **cross-contract trust** — `MemeBountyBoard` does not validate `voterPower` upper bound. Coupled with `totalBountyVotes` (line 285), repeated max votes could cause arithmetic surprises, although Solidity 0.8.x would revert on overflow making this DoS not theft.

**Severity:** MEDIUM (DoS only; depends on staking contract integrity).

### M-04 — `refundStaleBounty` and `emergencyForceCancel` bypass when `totalBountyVotes` ≥ 2 * MIN_COMPLETION_VOTES but no single submission reaches quorum
**Location:** lines 398–417, 442–461
**Hunt match:** Owner judge-override / prize splitting drift

`emergencyForceCancel` adds extra check `totalBountyVotes >= MIN_COMPLETION_VOTES * 2` revert (line 448). `refundStaleBounty` does NOT have this check. So:

- 5 submissions, votes split 2500/2500/2500/2500/2500 → `totalBountyVotes = 12500e18`, `topSubmissionVotes = 2500e18`. No single submission meets `MIN_COMPLETION_VOTES = 3000e18`.
- After grace, ANYONE can call `refundStaleBounty` → creator gets ETH back even though community engaged.

5 artists did legit work, 5 voters voted, but vote-splitting prevents payout → creator wins by default. **Vote-splitting attack vector:** creator pushes friends to submit dummy entries that drain votes from the genuine winner. Combined with `MIN_UNIQUE_VOTERS = 3`, this is exploitable when small voter base.

### M-05 — `refundStaleBounty` permissionless griefing window
**Location:** lines 398–417

`refundStaleBounty` is callable by anyone. After grace period, with no quorum, any caller can fire it and refund creator. This is intended behavior, but combined with **vote-splitting (M-04)**, allows:

1. Creator + N colluders post bounty + dummy submissions.
2. Vote-split intentionally.
3. After grace, creator refunds.
4. Creator extracts free signal/work from real artists.

### M-06 — `pendingPayouts` permanent loss if WETH transfer fails AND `safeTransferETHOrWrap` reverts
**Location:** lines 346–352 + WETHFallbackLib lines 40–53
**Hunt match:** Unsafe transfer on prize token

`withdrawPayout` zeros `pendingPayouts[msg.sender]` BEFORE calling `safeTransferETHOrWrap`. The lib's WETH fallback path: `IWETH(weth).deposit{value: amount}()` then `IWETH(weth).transfer(to, amount)`. If `transfer` returns `false`, lib reverts `WETHTransferFailed`. The revert rolls back state including the zeroing — **so funds are NOT permanently lost** (test `test_withdrawPayout_failingWETH_reverts` confirms `pendingPayouts == REWARD` after revert).

**However:** if WETH `deposit` consumes ETH and the subsequent revert does NOT roll back the WETH balance (which it does in EVM, atomic tx), this is fine. **OK.** Demote to INFO (resilience confirmed by test).

### M-07 — `sweepExpiredRefund` rug when refund actually delayed by user
**Location:** lines 468–476

Owner can sweep refunds 365 days after credit. If user is a contract that stopped working (e.g., multisig members lost keys), legit refund is owner-grabbed forever. **Acceptable for stale fund recovery, but no notification mechanism / final grace window after sweep proposal.** Consider 30-day pre-sweep "warning" event.

---

## LOW

### L-01 — `completeBounty` permissionless event-ordering race after grace
*(Demoted from H-01.)* No fund loss; only event/MEV ordering. Acceptable.

### L-02 — `withdrawRefund` emits no event
**Location:** lines 385–391
**Confirmed by test:** `Audit195_Bounty.t.sol::test_withdrawRefund_noEventEmitted`

No `RefundWithdrawn` event. Indexers cannot track. Add event for parity with `withdrawPayout → PayoutWithdrawn`.

### L-03 — `getBounty` does not return `createdAt` or `snapshotTimestamp`
**Location:** lines 493–499

Frontend cannot show full bounty state without reading `bounties()` directly via storage slot. Add fields to view.

### L-04 — `submitWork` allows any URI string up to 2000 bytes — XSS at frontend boundary
**Location:** lines 232–256, line 248 (`contentURI`)
**Hunt match:** Malicious URI in submission (XSS at frontend boundary)

`contentURI` is stored verbatim. Frontends MUST sanitize before rendering. URI like `javascript:alert(1)` or `data:text/html,<script>...` would be stored. **Contract is fine** (no on-chain XSS), but **frontend rendering is the attack surface.** Recommend off-chain validator: only accept `ipfs://` / `https://` / `ar://` prefixes. Add comment in contract explicitly warning frontend devs.

### L-05 — `MAX_SUBMISSIONS_PER_BOUNTY = 100` enables sub-block griefing
**Location:** line 47, 243
**Hunt match:** Gas grief on enumeration

100 submissions × ~50k gas each = 5M gas. A sybil cluster (each holding 500 TOWELI, threshold = `MIN_SUBMIT_BALANCE`) can fill all 100 slots, DoSing real submitters. `MIN_SUBMIT_BALANCE = 500 ether TOWELI` is some defense, but not enough on cheap L2s. No per-creator cap or rate limit.

### L-06 — `bounties` array enumeration: no on-chain helper, frontend must paginate
**Location:** line 80, 482

`bountyCount()` exists but no `getBountiesPaginated`. Frontend reads bounty-by-bounty. With 10k+ bounties, RPC load is high. INFO/LOW.

### L-07 — Off-by-one tolerance on deadline / dispute / grace boundaries
**Location:** lines 238, 270, 307, 309, 312, 365, 402, 446
**Hunt match:** Off-by-one on claimable window

- `submitWork` reverts when `block.timestamp > deadline` (line 238) → submission allowed AT deadline. Test `test_deadline_submitAtExactDeadline_reverts` warps to `dl+1`, not `dl`.
- `voteForSubmission` reverts when `block.timestamp > deadline` (line 270) → vote allowed AT deadline.
- `completeBounty` reverts when `block.timestamp <= deadline` (line 307) → must be strictly greater.
- `completeBounty` second guard `block.timestamp < deadline + DISPUTE_PERIOD` (line 309) → dispute closes AT exactly `deadline + 2 days`.

**Window analysis:** At `t = deadline`, both `submitWork`/`voteForSubmission` accept, `completeBounty` rejects. Consistent. At `t = deadline + DISPUTE_PERIOD`, `completeBounty` accepts. Consistent. **No off-by-one bug.** Boundary is `<= deadline` for action-allowed semantics. ✅ Verified.

### L-08 — `cancelBounty` owner backdoor
**Location:** line 363

`msg.sender != bounty.creator && msg.sender != owner()` → owner can cancel any open bounty before deadline + with no submissions, refunding creator (NOT owner). Looks legit, but **owner-cancellation right** combined with `MIN_CANCEL_DELAY` for creator means owner can cancel at `t=0` while creator must wait 1h. Asymmetric.

---

## INFO

### I-01 — Hunt: Signature replay across bounties — N/A
No signatures used. EIP-712 / signed claim is not in this contract. ✅

### I-02 — Hunt: Stale-signature claim — N/A
No signatures. ✅

### I-03 — Hunt: Prize splitting drift — Partial finding
No multi-winner splitting logic; single-winner takes all. Vote-splitting allows DoS but not drift in payout calculation. See M-04.

### I-04 — Stake-weighted vote precision
`voterPower` adds raw 18-decimal token amounts. No scaling. With `MIN_VOTE_BALANCE = 1000 ether`, sums are safe within `uint256` for any realistic scenario.

### I-05 — `topSubmissionVotes` strict-greater tie-break
Line 290: `>` not `>=`. First submission to reach a vote count keeps top spot. Documented behavior. ✅

### I-06 — `_warpPastGrace` test arithmetic
`Audit195_Bounty.t.sol` line 141: `vm.warp(block.timestamp + SEVEN_DAYS + 2 days + 30 days + 1)`. Uses **incremental** warp (additive from current `block.timestamp`), not absolute deadline arithmetic. May behave incorrectly if `_create()` is called at non-zero `block.timestamp`. Tests pass because foundry starts at `block.timestamp = 1`, so `deadline = 7 days + 1`, then warp adds another `7 + 2 + 30 + 1 = ~39 days` from current → `t = ~39 days + 1`, but `deadline + 2 + 30 = 7 + 2 + 30 = 39 days + 1`. Edge-case fragile. Test passes but easy to break.

### I-07 — Constructor staking address never validated for IStakingVote interface
Line 161: `IStakingVote(_stakingContract)` cast without ERC-165 / interface check. If wrong address provided, `votingPowerAtTimestamp` reverts on every vote → contract dead. Owner has no recovery (no setter). Mitigated by `address(0)` check (line 158). Acceptable single-point trust.

### I-08 — `voteToken` immutable but unused
`IERC20 public immutable voteToken` — only used as a getter? Actual vote checks go through `stakingContract.votingPowerAtTimestamp`. `voteToken` is never read in any code path. Dead state. Either remove or wire into a fallback voter check.

---

## Test Gaps

### TG-01 — No fuzz on `topSubmissionVotes` accumulation across many submissions
Tests cover 2 submissions max + tie-break. No 100-submission scenario testing gas, no fuzz on vote distribution.

### TG-02 — No test for vote-splitting griefing (M-04)
No test where votes are spread across 5 submissions such that none meets quorum but total > 2 × quorum.

### TG-03 — No test for `refundStaleBounty` after vote-splitting attack
Specific case: split votes such that `totalBountyVotes` is high but `topSubmissionVotes` is below quorum, then verify `refundStaleBounty` succeeds (or argue it shouldn't).

### TG-04 — No invariant test on totalBountyVotes consistency
`totalBountyVotes[id] == sum(submissions[id][i].votes)` — no test asserts this invariant.

### TG-05 — No test for owner asymmetric cancel (L-08)
Owner cancelling another user's bounty within `MIN_CANCEL_DELAY` is not tested.

### TG-06 — No test for `voteToken` dead state (I-08)
No assertion that `voteToken` is read anywhere in the vote flow.

### TG-07 — No test for malicious URI patterns (L-04)
No test for `javascript:`, `data:`, `file://` URIs being stored.

### TG-08 — No test for stale snapshot manipulation (M-01)
No test where staker stakes exactly `SNAPSHOT_LOOKBACK + 1s` before bounty creation.

### TG-09 — No multi-bounty isolation test for `pendingPayouts`
`test_multipleBounties_isolated` covers vote isolation; no test confirms `pendingPayouts` is per-recipient (not per-bounty), so two bounties paying same winner accumulate.

### TG-10 — No fuzz on `_deadline` near `MAX_DEADLINE_DURATION`
Edge `block.timestamp + 180 days` tested but no fuzz around it.

---

## Summary

- **HIGH:** 1 (H-02 owner force-cancel rug, demoted others)
- **MEDIUM:** 7 (M-01 to M-07)
- **LOW:** 8 (L-01 to L-08)
- **INFO:** 8 (I-01 to I-08)
- **Test Gaps:** 10

### Top 3 Findings
1. **H-02** — `emergencyForceCancel` lets owner refund creator after artists worked, when vote-splitting kept total under `2 * MIN_COMPLETION_VOTES`. Trust assumption on owner is HIGH severity until multisig accepts ownership (Wave 0 pending).
2. **M-04** — Vote-splitting via dummy submissions allows creator to bypass quorum and reclaim ETH via `refundStaleBounty` after legit work was performed. No counter-mitigation.
3. **M-02** — Creator can front-run honest artist's `submitWork` after `MIN_CANCEL_DELAY = 1h`. Artist gas wasted; advantage to creator.

---

*Audit-only. No code changes per agent mandate.*
