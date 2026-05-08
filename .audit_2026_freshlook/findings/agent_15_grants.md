# Agent 15/100 — CommunityGrants.sol Fresh-Eyes Audit

**Scope:** `contracts/src/CommunityGrants.sol` (1250 LoC) — grant proposal flow,
voting, execution, refund accounting, fee-receiver timelock, cancel-approved
timelock, rolling disbursement cap. Library boundaries inspected:
`VotePowerOracle`, `WETHFallbackLib`, `TimelockAdmin`, plus
`TegridyStaking.holdsToken/userPositionCount/votingPower*` interface contracts.

**Method:** Fresh read of the source; did NOT consult prior audit `.md` history.
Inline comments reference earlier finding IDs (DEEP-GOV-01 / 05 / 06 / 09 / 13,
BATCH-A C3, BATCH-E H11/H12, M-G01, M-G02, M-13, NEW-G7, R014, GOV-ECON-01,
V2-GOV-11, etc.). Every issue surfaced below is rechecked against the inline
mitigation the comments claim is in place, and only reported if a concrete
bypass or new gap remains.

---

## F-15-K-01 — Captured-owner can route past the M-G01/H12 pause defenses by chaining `pause` → `proposeCancelApproved` → `executeCancelApproved` → `emergencyRecoverETH` (MEDIUM, defense-in-depth gap)

**Where:**
- `lapseProposal` (line 833): correctly `whenNotPaused` per BATCH-E H12.
- `executeCancelApproved` (line 763): permissionless executor, **NOT** `whenNotPaused`.
- `cancelCancelApproved` (line 801): `onlyOwner` — only the (captured) owner can abort the queue.
- `emergencyRecoverETH` (line 918): `whenPaused`, only protects `totalApprovedPending`.

**Mechanic:** the BATCH-E H12 fix added `whenNotPaused` to `lapseProposal` to
shut down a captured-key drain path:
> pause → block recipient execution → wait `EXECUTION_DEADLINE` (30d) →
> anyone calls `lapseProposal` → `totalApprovedPending` decremented → owner
> calls `emergencyRecoverETH` → freed ETH redirected to attacker.

The fix's commentary on lines 816-832 explicitly documents this loop and
states pause-gating `lapseProposal` "closes the loop." It does not. The
parallel path through the M-G01 cancel-approved timelock is functionally
equivalent and remains pause-independent:

1. Owner is captured.
2. Owner calls `pause()` → blocks `executeProposal`/`retryExecution` so the
   approved recipient cannot pull funds.
3. Owner calls `proposeCancelApproved(id)` (`onlyOwner`, no pause guard).
   24h timelock starts.
4. Captured owner ALSO controls `cancelCancelApproved` (`onlyOwner`), so
   nobody else can abort the queue while paused.
5. After 24h elapses, **anyone** calls `executeCancelApproved(id)` (line 763,
   no pause guard, no auth). Status flips to `Cancelled`,
   `totalApprovedPending -= proposal.amount`.
6. Owner calls `emergencyRecoverETH(attacker)` while still paused — the
   protection `withdrawable = balance - totalApprovedPending` no longer
   blocks the funds because step 5 freed them.

**Window:** 24h cancel-approved timelock (CANCEL_APPROVED_TIMELOCK = 24h).
Compared to the BATCH-E H12 path's 30d EXECUTION_DEADLINE wait, the M-G01
path is **30× faster** for a captured-owner drain.

**Why H12's stated rationale doesn't cover this:**
- H12 only added `whenNotPaused` to `lapseProposal`. It did not pause-gate
  `executeCancelApproved`.
- M-G01's stated purpose was to stop owner-INSTANT cancel of approved
  proposals. It correctly delayed cancellation by 24h. But making the
  EXECUTOR permissionless (line 747-748) was an anti-censorship choice —
  unfortunately it interacts adversely with pause: a captured owner WANTS
  the executor to be permissionless because anyone (including a sybil they
  control) can complete the loop without re-touching `onlyOwner` while
  paused.

**Severity:** MEDIUM — requires owner-key compromise (the stated threat
model for both H12 and M-G01). Once compromised, this path is materially
faster than H12's loop. Not a vulnerability for the honest-owner case; a
defense-in-depth regression of the H12 fix's spirit.

**Suggested mitigations (not implementing — audit-only):**
- Add `whenNotPaused` to `executeCancelApproved`. Mirrors H12's reasoning:
  while paused, all `totalApprovedPending`-decrementing paths must be
  frozen so `emergencyRecoverETH` cannot dilate its withdrawable surface.
- Or, gate `cancelCancelApproved` with a guardian role distinct from owner
  so a non-captured guardian can abort the cancel-approved queue during
  incident response.
- Or, raise `CANCEL_APPROVED_TIMELOCK` to ≥ 7d to match the community
  reaction window the BATCH-E H12 commentary assumes (the 30d deadline
  there). 24h is below the realistic incident-response window for
  off-chain governance to coordinate a guardian response.

---

## F-15-K-02 — `_recordDisbursement` ring buffer (`MAX_DISBURSEMENTS = 100`) is a hard DoS surface against a high-throughput attack on a small grant cap (LOW-MEDIUM, conditional)

**Where:** `_recordDisbursement` (line 1118), `MAX_DISBURSEMENTS = 100`
constant (line 165), `RollingBufferFull` revert (line 1128).

**Mechanic:** the DEEP-GOV-05 fix correctly closed the silent-cap-bypass
where unconditional eviction of in-window entries deflated `rollingDisbursed`.
It does so by reverting `RollingBufferFull` when the buffer is full AND the
oldest entry is still inside `ROLLING_WINDOW = 30d`. Correct as-is for the
specific bypass it targets.

**Latent gap:** the buffer ceiling (100 entries) is reachable under
realistic governance load for protocols that approve many small grants.
Pipeline math:
- `MAX_ACTIVE_PROPOSALS = 50`
- `VOTING_PERIOD = 7d`
- `EXECUTION_DELAY = 1d` (post-deadline)
- A fully utilised pipeline can graduate ≈50 proposals per 7-8 day cycle,
  which is ~200 proposals per 30d window — **2× the buffer ceiling**.

Once 100 disbursements land within 30d, `executeProposal` and
`retryExecution` revert `RollingBufferFull` for every subsequent
already-Approved proposal until the oldest entry ages out. Each blocked
proposal still has `EXECUTION_DEADLINE = 30d` post-deadline before
`lapseProposal` can recover the deposit. So a recipient whose proposal
finalised right after the buffer filled may need to wait several days
into the rolling window for an in-window entry to age past 30d, and
`retryExecution` can fail until then.

**Severity:** LOW under current grant-volume assumptions (the protocol is
unlikely to hit 100+ executions in 30d in normal operation). MEDIUM under
governance attack: a malicious actor with deep TOWELI bags could pay
50 × `PROPOSAL_FEE` to fully saturate the active queue, drive grants
through to execution under cover of legitimate sybil voters, and use the
buffer fill as a secondary DoS vector against simultaneous legitimate
proposals.

**Mitigation hint:** size MAX_DISBURSEMENTS off `(MAX_ACTIVE_PROPOSALS *
ceil(ROLLING_WINDOW / VOTING_PERIOD)) ≈ 50 × 5 = 250` with safety margin,
e.g. 256 or 300. The mapping-backed ring buffer is gas-cheap to widen.

---

## F-15-K-03 — `MIN_UNIQUE_VOTERS = 3` is trivially defeated by sybil-splitting a TOWELI bag across three EOAs at minimum stake (LOW, governance design)

**Where:** `MIN_UNIQUE_VOTERS = 3` (line 154), `proposalUniqueVoters[id]++`
(line 466), `INSUFFICIENT_VOTERS` revert in `finalizeProposal` (line 500).

**Mechanic:** the comment at line 153-154 references "Nouns DAO pattern"
for the voter-diversity guard. Nouns DAO's actual diversity floor is much
higher than 3 (their treasury actions require many distinct delegate
votes). With MIN_UNIQUE_VOTERS = 3:

- A coordinated proposer wanting to push a 50%-treasury grant can:
  1. Split one TOWELI bag across 3 Sybil EOAs.
  2. Each Sybil stakes the bare minimum to exceed
     `MIN_ABSOLUTE_QUORUM / 3` boosted (≈1334e18, achievable with a 4×
     boost on ~333 raw TOWELI per Sybil).
  3. Each Sybil votes "for" — 3 unique voters check passes.
- Quorum / boost requirements are met because the same total stake
  could have come from one EOA; the diversity check only counts heads.

The MIN_ABSOLUTE_QUORUM = 4000e18 floor (revised in FRESH-EYES M-4 per
the comment at line 120-130) bounds the **total** voting power, not the
**actor count**. A single attacker controlling 4000e18 boosted veTOWELI
can cleanly pass both checks with three sock-puppets at any minimum.

**Severity:** LOW — this is a known design trade-off (the comment at
line 498-499 acknowledges the "whale capture" framing). Splitting a bag
across 3 addresses requires no economic loss to the splitter (they
retain control of all three). No code change is the right call without
a parallel sybil-resistance primitive (proof-of-personhood, PoH-gated
veTOWELI, etc.). Reported here only because the comment understates the
attack surface — the cited Nouns pattern presumes a much larger and
genuine delegate set.

**Note:** RAISING MIN_UNIQUE_VOTERS won't help (sybils scale linearly).
Real defenses require either off-chain registry verification or
quadratic-voting-style identity gating, both out of scope for this
contract.

---

## F-15-K-04 — `executeFeeReceiverChange` dry-run uses 1 wei, which is a trivial floor; a proposed receiver that imposes a higher per-transfer minimum can pass dry-run yet break `createProposal` (LOW, parameter)

**Where:** `executeFeeReceiverChange` (line 956), specifically the
`uint256(1)` dry-run amount on line 975.

**Mechanic:** the R014-MEDIUM dry-run guards against the most common
black-hole failure modes (transfer reverts entirely, returns false). It
does NOT catch:
- A receiver that accepts ≤ 1 wei but reverts on transfers ≥ N wei
  (some compliance-gated tokens or fee-on-transfer receivers).
- A receiver that has a per-block transfer cap (rare ERC20 wrappers).
- A receiver that requires a specific allowance pattern that 1-wei
  test doesn't expose.

If any of these is the new receiver, `createProposal` will revert on its
`safeTransferFrom(msg.sender, feeReceiver, nonRefundable)` step (line 320),
permanently DoS-ing all new proposals until the owner rotates to a working
receiver via the 48h fee-receiver timelock — during which **no proposals
can be created at all**.

**Severity:** LOW — exotic receiver types only; standard EOAs and treasury
multisigs all pass any reasonable dry-run amount. Mitigation would be to
test with a more realistic amount (e.g., `nonRefundable / 1000` or a fixed
1e18) so the dry-run pressures the receiver near operational levels.

---

## F-15-K-05 — `cancelProposal` does NOT check the proposer is still alive at cancel time; a sybil-griefer who proposed and then transferred their staking NFT can still call `cancelProposal` themselves to forfeit-burn to feeReceiver (NOTE / dead-end)

**Where:** `cancelProposal` (line 699), `isProposer = msg.sender == proposal.proposer` (line 709).

**Mechanic:** the M-6 fix correctly redirects the 50% refundable to
feeReceiver on cancellation, removing the slot-churn griefing incentive
(documented at line 717-725). I checked whether a proposer who has since
restaked their position can still cancel: yes, they can (the cancel path
is address-keyed, not stake-keyed). They get nothing back; the protocol
keeps the deposit. This is **intended behaviour** per the M-6 commentary
("voluntary cancellation deserves no refund"). Not a finding.

**Why I checked:** the proposer-must-have-single-position check at create
time (line 351) might suggest cancel should also check `userPositionCount`.
It does not, but the economic outcome is correct (proposer forfeits the
deposit on cancel regardless of stake state), so no bypass exists.

**Status:** dead-end / not a bug.

---

## F-15-K-06 — `proposeFeeReceiver` does not check `_newFeeReceiver != feeReceiver`; same-receiver proposals waste a 48h timelock cycle (NOTE / UX)

**Where:** `proposeFeeReceiver` (line 934).

**Mechanic:** owner can call `proposeFeeReceiver(currentFeeReceiver)` and
the contract dutifully queues it. After 48h, `executeFeeReceiverChange`
runs the dry-run, succeeds, and rotates `feeReceiver = currentFeeReceiver`
(no-op). Wasted gas + 48h delay. No security impact — the dry-run still
runs and the fee plumbing is unchanged. UX nit.

---

## F-15-K-07 — `proposeCancelApproved` does not invalidate when the proposal's `EXECUTION_DEADLINE` has already lapsed; both `executeCancelApproved` and `lapseProposal` race for the same terminal state (NOTE / no double-spend)

**Where:** `proposeCancelApproved` (line 750), `executeCancelApproved` line 763,
`lapseProposal` line 833.

**Mechanic:** I checked the race: if proposer sees `EXECUTION_DEADLINE` is
about to elapse on an Approved proposal AND the owner queues a
cancel-approved (24h timelock), both terminal paths converge on the same
state transition (Approved → Rejected/Cancelled, refund proposer, decrement
`totalApprovedPending`).

- `executeCancelApproved` requires `proposal.status == Approved` AND
  `!depositRefunded[id]` AT EXECUTION (lines 769-770). If `lapseProposal`
  fires first, status flips to Rejected and `depositRefunded[id] = true`
  → `executeCancelApproved` reverts NotApproved/AlreadyRefunded.
- `lapseProposal` likewise re-checks status (`Approved || FailedExecution`)
  AND `!depositRefunded` AT EXECUTION (lines 838-841).

Either ordering is safe. No double-refund possible. The leaky timelock
slot in `_executeAfter[_cancelApprovedKey(id)]` survives a lapse-first
race; subsequent `cancelCancelApproved(id)` clears it. Not a bug, just an
operational quirk.

**Status:** dead-end / verified safe.

---

## F-15-K-08 — `_transferETHOrWETH` failure mode if WETH `withdraw` reverts (NOTE / atomic, dead-end)

**Where:** `_transferETHOrWETH` (line 1086).

**Mechanic:** I checked the path where `IWETH(weth).deposit{value: amount}()`
succeeds, then `IWETH(weth).transfer(recipient, amount)` returns false
(recipient on WETH blacklist), then `IWETH(weth).withdraw(amount)` is
invoked outside the outer try/catch.

- If `withdraw` reverts, the entire `_transferETHOrWETH` reverts, the
  outer `executeProposal` reverts, EVM unwinds the deposit. ETH stays in
  the contract. Status stays Approved. Recipient retries via
  `retryExecution` (or owner intervenes). No funds stuck.
- If `withdraw` succeeds, `_transferETHOrWETH` returns false, status flips
  to FailedExecution. Recipient or anyone-after-delay can `retryExecution`.

Canonical WETH9's `withdraw` uses `payable(msg.sender).transfer(amount)`
(2300-gas stipend). This contract's `receive()` only emits `ETHReceived`
— well within 2300 gas. So the `withdraw` won't revert from gas in
practice on canonical chains. The contract is also constructed with an
immutable `weth` address (constructor line 284), so a malicious WETH
swap is precluded.

**Status:** dead-end / verified safe.

---

## F-15-K-09 — Snapshot lookback `block.timestamp - 1` fallback when `block.timestamp < SNAPSHOT_LOOKBACK` works but is only relevant in test/genesis (NOTE / dead-end)

**Where:** `createProposal` snapshot fallback (line 371-373).

**Mechanic:** `block.timestamp >= SNAPSHOT_LOOKBACK ? block.timestamp - SNAPSHOT_LOOKBACK : block.timestamp - 1`.
The fallback path is only reachable when `block.timestamp < 3600` (less
than 1h since Unix epoch), which is impossible on any real-world chain
post-1970. The comment at line 365-373 acknowledges this is for test/fork
environments. Real-network execution always takes the lookback branch.

**Concern checked:** the `block.timestamp - 1` fallback for
`votingPowerAtTimestamp` could collide with `_totalBoostedStakeCheckpoints.upperLookup(0)`
returning a stale or zero value if no checkpoint has been written yet.
On a fresh deployment with no stakes, all reads return 0 → quorum cannot
be met → `finalizeProposal` reverts QuorumNotMet → proposer can
`cancelProposal` to pull half deposit. Correct fail-closed behaviour. No
exploit, no fund loss.

**Status:** dead-end / verified safe in real-network conditions.

---

## F-15-K-10 — `getProposalsInRange` returns full `Proposal[]` including 2KB descriptions; deliberate L-G03 INDEXER-HELPER (NOTE)

**Where:** `getProposalsInRange` (line 1194).

**Mechanic:** acknowledged in inline NatSpec at lines 1183-1190 as
indexer-only. Off-chain callers must page; on-chain consumers should
not call this. View-only, no security impact. Not a finding, just
re-confirming the documented constraint.

**Status:** as-documented.

---

## Summary Table

| ID | Severity | Class | Status |
|---|---|---|---|
| F-15-K-01 | MEDIUM | Defense-in-depth gap | NEW (parallel path to BATCH-E H12) |
| F-15-K-02 | LOW-MED | DoS / governance load | NEW (latent under high throughput) |
| F-15-K-03 | LOW | Governance design | Documents weakness in cited "Nouns" pattern |
| F-15-K-04 | LOW | Parameter / dry-run | NEW (1-wei floor too small) |
| F-15-K-05 | NOTE | Dead-end | Verified intended behaviour |
| F-15-K-06 | NOTE | UX | Same-receiver no-op |
| F-15-K-07 | NOTE | Dead-end | Race verified safe |
| F-15-K-08 | NOTE | Dead-end | WETH withdraw revert verified atomic |
| F-15-K-09 | NOTE | Dead-end | Test-only fallback |
| F-15-K-10 | NOTE | Documented | L-G03 indexer-helper |

**One MEDIUM** (F-15-K-01: captured-owner pause + cancel-approved drain
parallel to the H12 path).
**One LOW-MEDIUM** (F-15-K-02: ring-buffer ceiling under high throughput).
**Two LOW** (F-15-K-03: voter-diversity sybil; F-15-K-04: 1-wei dry-run).
Six notes / verified dead-ends.

No CRITICAL or HIGH findings. No re-entrancy, no payout retarget, no
EIP-712 replay (no signatures used here — all proposal flow is on-chain
state-machine driven), no recipient-zero, no proposer self-vote bypass,
no rolling-cap silent bypass, no double-refund, no double-execute. The
defense-in-depth gap in F-15-K-01 is the one finding that warrants
follow-up.

---

## Lens checklist (every prompt bullet, accounted for)

- **Proposal creation cost / spam:** PROPOSAL_FEE = 42_069 TOWELI, 50%
  forfeited on cancel → spam economically bounded. MAX_ACTIVE_PROPOSALS
  = 50 cap. ✓ no finding.
- **Voting weight snapshot:** OZ-Governor pattern, denominator and
  numerator share `snapshotTimestamp`, proposer's NFT pinned at create
  time. BATCH-A C3 fix verified. ✓ no finding.
- **Milestone marking / multisig:** N/A — this is a single-payout grant
  vault, no per-milestone gating in the contract. Approval = single
  on-chain quorum vote. ✓ scope mismatch in lens prompt.
- **Cancel→re-execute / state race:** verified F-15-K-07 (no
  double-spend), executeCancelApproved CEI in TimelockAdmin._execute
  prevents replay.
- **Payout ETH vs ERC20:** ETH-only payout with WETH fallback for
  contract recipients. Recipient set at create time, immutable
  per-proposal. ✓ no retarget.
- **EIP-712 replay:** no signatures used in this contract. N/A.
- **Milestone expiration:** EXECUTION_DEADLINE = 30d → `lapseProposal`
  refunds proposer (Approved/FailedExecution) or `lapseStaleProposal`
  forfeits to feeReceiver (Active never reached quorum). ETH never rugged
  forever — `totalApprovedPending` always reconciles. ✓ no finding.
- **Currency:** hardcoded TOWELI for fees, ETH for grants, immutable WETH
  for fallback. ✓ no finding.
- **Recipient validation:** zero-address check at create time.
  Self-recipient blocked (`_recipient != msg.sender` line 299). Contract
  recipients fall through to WETH-wrap branch. ✓ no finding.
- **Grant rescission:** approved → cancel-approved 24h timelock; rejected
  → 50% refund; cancelled → 50% forfeited to feeReceiver. Rounding handled
  by `nonRefundable = PROPOSAL_FEE / 2; refundable = PROPOSAL_FEE - nonRefundable`
  for odd amounts. ✓ no finding.
- **Re-entrancy:** all mutating paths `nonReentrant`. ETH transfer uses
  10k-gas stipend (Solmate pattern). TOWELI is plain ERC20Permit (no
  hooks). CEI in TimelockAdmin._execute. ✓ no finding.
- **Veto power:** owner-side veto via `cancelProposal` (Active only,
  instant) and `proposeCancelApproved` (Approved, 24h delay). Owner
  cannot indefinitely block legitimate Active proposals because
  `MAX_ACTIVE_PROPOSALS` counts active slots; cancellation is one-shot
  per proposal. ✓ no griefing finding (owner veto is the documented
  governance role).
- **Stake-to-create + slash:** PROPOSAL_FEE is split nonRefundable
  (immediate to feeReceiver) + refundable (held; refund on Rejected,
  forfeit on Cancelled/lapseStale). Split is exact (handles odd amounts
  correctly). ✓ no finding.

---

End of report.
