# Audit 019 — CommunityGrants.sol

Agent 019 / 101-agent forensic audit. AUDIT-ONLY (no code changes).

Target: `contracts/src/CommunityGrants.sol` (724 lines)
Tests cross-checked: `contracts/test/CommunityGrants.t.sol`, `contracts/test/Audit195_Grants.t.sol`

Hunt list: approval gating bypass, fund drain via repeated grant claims, milestone/release race, multi-sig bypass, grant cancellation reentrancy, beneficiary spoofing via signature replay, owner emergency-withdraw rug, accounting drift on partial release, unsafeTransfer on rewardToken, deadline bypass, missing pause modifier on release, vote-power borrowing for grant approval.

---

## HIGH

### H-1. `retryExecution` releases ETH while contract is paused — pause modifier missing
**Location:** `CommunityGrants.sol:420-461`
**Hunt match:** "missing pause modifier on release"
**Severity:** HIGH

```solidity
function retryExecution(uint256 _proposalId) external onlyOwner nonReentrant {
    // ... NO whenNotPaused modifier
    // ... releases ETH via _transferETHOrWETH
}
```

`executeProposal` (line 369) is correctly gated with `whenNotPaused`. `retryExecution` (line 420) is **not**. Since `pause()` is the protocol's emergency brake (e.g., bug discovered, governance dispute), the owner — which is the same role permitted to call `retryExecution` — can still release ETH from the treasury during a pause that should freeze all outflows. This breaks the security invariant that `whenPaused` ⇒ no fund movement except `emergencyRecoverETH`, and creates an alternate path for the owner (or compromised owner key) to drain ETH that bypasses the explicit `whenPaused` audit trail of `emergencyRecoverETH`.

**PoC sketch:** approve-and-fail an attacker-controlled rejecter recipient → status becomes `FailedExecution` → owner calls `pause()` → owner replaces the attacker rejecter with a contract that now accepts (impossible, recipient is immutable in struct). The actual harm is that any **previously-failed** proposal that targets a recipient which has since become payable can be force-executed during a global pause. Combined with H-2 below (cancel-while-paused + emergency recover), this widens the rug surface.

**Recommendation:** Add `whenNotPaused` to `retryExecution`.

---

### H-2. `cancelProposal` while paused → owner rug via emergencyRecoverETH
**Location:** `CommunityGrants.sol:468-508` (cancel) + `565-575` (emergencyRecoverETH)
**Hunt match:** "owner emergency-withdraw rug" + "missing pause modifier on release"
**Severity:** HIGH (assuming single-key owner; MEDIUM if owner is timelocked multisig)

`cancelProposal` has no `whenNotPaused`. Per the C-02 patch, the owner can cancel **Approved** proposals, which decrements `totalApprovedPending` (line 485). `emergencyRecoverETH` lets the paused owner withdraw `balance - totalApprovedPending` (line 569).

**Rug recipe:**
1. Owner calls `pause()`.
2. For every Approved-but-unexecuted proposal `i`, owner calls `cancelProposal(i)` — `totalApprovedPending -= proposal[i].amount` (works while paused).
3. After all cancels, `totalApprovedPending == 0`, so withdrawable = full balance.
4. Owner calls `emergencyRecoverETH(ownerWallet)` and walks with the entire treasury.

Step 2 should not be possible during a pause; emergencyRecoverETH was designed to protect approved-pending ETH but the cancel-while-paused path defeats it. The NatSpec on `emergencyRecoverETH` (line 564) explicitly states *"Only withdraws ETH not committed to approved-but-unexecuted proposals"* — that invariant is violated.

**Recommendation:** Add `whenNotPaused` to `cancelProposal` (at minimum to the `Approved`-cancellation branch), or block `cancelProposal` of `Approved` proposals while paused.

---

### H-3. Lapse + cancel during pause sidestep emergencyRecoverETH invariant
**Location:** `CommunityGrants.sol:513-550` (lapseProposal) and 468-508 (cancelProposal)
**Hunt match:** "owner emergency-withdraw rug"
**Severity:** HIGH (sister of H-2)

`lapseProposal` is also missing `whenNotPaused`. Combined with H-2, **anyone** can lapse Approved/FailedExecution proposals whose execution deadline has passed during a pause, decrementing `totalApprovedPending` and unlocking treasury for the paused owner's `emergencyRecoverETH` to seize. Even an honest external lapser inadvertently enables the rug if the owner is malicious during the pause window.

**Recommendation:** Add `whenNotPaused` to `lapseProposal` (or restrict `emergencyRecoverETH` further).

---

## MEDIUM

### M-1. `createProposal` is not `nonReentrant` and external token call precedes state writes
**Location:** `CommunityGrants.sol:195-263`
**Hunt match:** "fund drain via repeated grant claims" / reentrancy on token hooks
**Severity:** MEDIUM

`createProposal` calls `toweli.safeTransferFrom` twice (lines 218, 219) **before** updating `totalRefundableDeposits` (line 221), `activeProposalCount` (line 259), and `lastProposalTimestamp` (line 260). It then calls `votingEscrow.userTokenId(msg.sender)` (line 233) — another external call.

If TOWELI is ever migrated to a token with hooks (e.g., ERC-777 / ERC-1363) or if the votingEscrow is malicious/upgradeable and reenters, an attacker could create N proposals in one tx — slipping past `MAX_ACTIVE_PROPOSALS=50`, the per-proposer `PROPOSAL_COOLDOWN`, and the available-balance cap (recomputed each call against the same balance). TOWELI today is plain ERC20, so this is latent — but the contract is constructed with arbitrary token/escrow addresses and the constructor only zero-checks. A malicious test/staging escrow yields immediate exploitability.

**Recommendation:** Add `nonReentrant` to `createProposal`, or move all state writes (`activeProposalCount++`, `lastProposalTimestamp`, push to `proposals`) **before** the external token transfers (CEI pattern).

---

### M-2. `proposeFeeReceiver` not paused-gated; combined with timelock allows rug to attacker treasury during pause
**Location:** `CommunityGrants.sol:581-588`
**Hunt match:** "owner emergency-withdraw rug" / multisig bypass
**Severity:** MEDIUM

While paused, the owner can `proposeFeeReceiver(attacker)` and after 48h `executeFeeReceiverChange()` (also not paused-gated). Subsequently, `sweepFees` (line 554, also missing `whenNotPaused`) sends accumulated TOWELI to the attacker. Because pause is meant to be the security stop-gap, a 48h timelock running through the pause is a bypass.

**Recommendation:** Add `whenNotPaused` to `executeFeeReceiverChange` and `sweepFees` (the `proposeFeeReceiver` call itself is benign since 48h of social signaling can react).

---

### M-3. `_transferETHOrWETH` partial-state on WETH-fallback failure: ETH is unwrapped but proposal stays Approved
**Location:** `CommunityGrants.sol:651-674`
**Hunt match:** "accounting drift on partial release"
**Severity:** MEDIUM

```solidity
try IWETH(weth).deposit{value: amount}() {
    bool sent = IWETH(weth).transfer(recipient, amount);
    if (!sent) {
        IWETH(weth).withdraw(amount); // unwrap back
        return false;
    }
    return true;
} catch { return false; }
```

If `IWETH.deposit` succeeds but `transfer` returns `false`, `withdraw(amount)` is called. If `withdraw` itself reverts (atypical but possible — e.g., paused WETH proxy, custodial WETH variant), the entire `try` block reverts and no `return false` is reached. The caller (`executeProposal`) treats a revert as success-flow short-circuit only via the `if (!_transferETHOrWETH(...))` branch — but a hard revert bubbles up, potentially leaving WETH wrapped in the contract with the proposal still `Approved`. There is no WETH sweep function. This produces silent accounting drift between `totalApprovedPending` (still counts) and the locked WETH the contract now holds.

**Recommendation:** Wrap the entire WETH path in a single try/catch (`try { deposit; transfer; if (!sent) withdraw; } catch { return false; }`), or add a permissioned WETH sweeper.

---

### M-4. `voteOnProposal` deadline check uses `>` allowing exactly-at-deadline votes; finalize uses `<=` — minor race
**Location:** `CommunityGrants.sol:276` (vote: `if (block.timestamp > proposal.deadline) revert`) vs `321` (finalize: `if (block.timestamp <= proposal.deadline) revert`)
**Hunt match:** "deadline bypass" / "milestone/release race"
**Severity:** MEDIUM

At `block.timestamp == deadline`, voting is permitted **and** finalize is rejected — consistent. But the test `test_voting_canVoteAtDeadline` confirms this is intentional. The asymmetry creates a 1-second wide window where a coordinated voter (e.g., MEV bot) can flip a result by voting in the same block as `deadline`, then finalize in the next block. This is intended-but-weakly-defended last-second voting; standard governance would extend the voting window if a vote arrives in the final block ("vote extension" / "look-back"). Without extension, a whale can hide their vote until block.timestamp == deadline (the voting period is 7 days; in practice, attackers monitor the deadline).

**Recommendation:** Add a "late vote bumps deadline by N seconds" extension, OR change `>` to `>=` (consistent strict-less-than semantics). This is informational because the existing 1-day VOTING_DELAY + 1-day EXECUTION_DELAY blunts attacks; but classical Bravo-style governance sometimes lacks vote-extension and is exploited.

---

### M-5. `proposalUniqueVoters` is not decremented on cancel/lapse — accounting drift on view consistency
**Location:** `CommunityGrants.sol:302` increment; never decremented
**Hunt match:** "accounting drift on partial release"
**Severity:** LOW→MEDIUM (view-only, but informs frontends)

If a proposal accumulates 5 unique votes and is then cancelled, `proposalUniqueVoters[id]` permanently retains the count. This is informational only (no on-chain decision uses it post-cancel), but on-chain analytics or off-chain governance dashboards built on this mapping can misreport.

**Recommendation:** Either reset on cancel/lapse, or document that the count is final.

---

### M-6. `cancelProposal` of Active by proposer does NOT release `totalApprovedPending` (proposal isn't Approved yet) but the order of state changes can underflow `totalRefundableDeposits` if `depositRefunded` was incorrectly set elsewhere
**Location:** `CommunityGrants.sol:490-491`
**Severity:** LOW→MEDIUM

```solidity
uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2;
totalRefundableDeposits -= refundable;
```

This decrement is unguarded — if any future code path sets `depositRefunded[id]` without also incrementing `totalRefundableDeposits` (e.g., a bookkeeping bug in a future patch), this underflows on the next cancel. Given Solidity 0.8 reverts on underflow, this is correct today; the audit note flags fragile invariants where the only enforcement is "we always pair the increment in createProposal with exactly one decrement". Recommend tracking refundable per-proposal explicitly (`uint256 refundableHeld[id]`) so the invariant is self-checking.

---

### M-7. Owner can sandwich a proposal between `pause` ↔ `unpause` and rush execute — execution_delay + pause interaction
**Location:** `executeProposal:378` (`require(block.timestamp >= proposal.deadline + EXECUTION_DELAY)`)
**Severity:** LOW→MEDIUM

`EXECUTION_DELAY=1 day` is enforced on wall-clock. Owner pausing between deadline and `deadline+EXECUTION_DELAY` does not extend the delay clock — when unpaused, owner can immediately execute (since the check is against `block.timestamp`, not "elapsed time outside pause"). This means a pause is not a "speed-bump" for execute — it's a yes/no gate. Token holders that expected a pause to extend their reaction time will be surprised. Document or compute `EXECUTION_DELAY` against `lastUnpausedAt`.

---

## LOW

### L-1. `sweepFees` lacks `whenNotPaused` — owner can move TOWELI fees while paused
Pairs with M-2. Recommend `whenNotPaused`.

### L-2. `_transferETHOrWETH` 10k stipend will silently fail for receivers using EIP-1559 / EIP-4844 fee-bumping fallback hooks — covered by FailedExecution + retry, but worth documenting recipient incompatibility expectations in NatSpec.

### L-3. `MAX_ACTIVE_PROPOSALS=50` cap is enforced at create-time only; activeProposalCount is decremented on terminal states — but a stuck `FailedExecution` proposal **continues to occupy a slot until the executor lapses it**, since `executeProposal` does NOT decrement on the failed branch (see line 401, return). This is intentional but means a malicious recipient that toggles between rejecting and accepting ETH can permanently consume one of 50 slots until lapsed at deadline+30d. Combined with cooldowns, an attacker with 50 sybil addresses can DOS proposal creation for 30+ days. Mitigated by the proposal fee (50×42,069 TOWELI = 2.1M TOWELI, expensive).

### L-4. `proposeFeeReceiver` does not zero-check that `_newFeeReceiver != feeReceiver` — owner can pointlessly re-propose the same address. Cosmetic.

### L-5. No event emitted for `lapseProposal` deposit redirection on blacklist (the `DepositRedirectedToFeeReceiver` event covers it, but the event uses the same id space as the original `ProposalFeeRefunded` — make sure indexers handle both).

### L-6. `getProposal` view does not return `proposerTokenId` — frontends cannot read the snapshotted NFT. Needs an extension getter for completeness. (`proposals(_id)` public mapping covers it via tuple destructuring as the test uses, but explicit getter would be clearer.)

### L-7. `MIN_UNIQUE_VOTERS=3` is enforced at finalize but **not** at execute. If MIN_UNIQUE_VOTERS were ever decreased via a code change, in-flight Approved proposals would be honored even though they no longer satisfy the new threshold. Not exploitable today (constants are immutable), but document the expectation.

---

## INFO

### I-1. Hunt items found CLEAN (no issue)
- **Approval gating bypass:** `executeProposal` correctly checks `proposal.status != ProposalStatus.Approved`. State machine is monotonic per proposal (no Approved→Active reversion).
- **Fund drain via repeated grant claims:** `depositRefunded[id]` is checked in cancel/lapse and `proposal.status` transitions block re-execution. The C-01 fix to the cap-recomputation in `executeProposal`/`retryExecution` is correctly excluding own-proposal amount.
- **Beneficiary spoofing via signature replay:** No EIP-712 / signature-based vote relay exists — votes are direct calls. No replay surface.
- **Multi-sig bypass:** No multi-sig logic in this contract; `onlyOwner` is via OZ `Ownable2Step` (`OwnableNoRenounce`). The bypass surface lives in pause/cancel paths (covered above as H-2/H-3).
- **Grant cancellation reentrancy:** `cancelProposal` is `nonReentrant`. The `try toweli.transfer` is the only external call and it's after state changes.
- **Vote-power borrowing for grant approval:** `votingPowerAtTimestamp(_, snapshotTimestamp)` queries historical power BEFORE proposal creation (`block.timestamp - 1 hour`). Post-snapshot acquisitions provide no power. The `holdsToken`/`userTokenId` proposer-check (`PROPOSER_POSITION_CANNOT_VOTE`) prevents proposer-NFT laundering.
- **unsafeTransfer on rewardToken:** TOWELI uses `SafeERC20.safeTransfer` for refunds-to-feeReceiver (lines 357, 361, 500, 504, 541, 545) — correct. Refunds-to-proposer use raw `toweli.transfer` wrapped in `try/catch` to gracefully redirect on blacklist (lines 353, 496, 537) — also acceptable.
- **Milestone/release race:** No milestone logic; grants are single-shot ETH transfers.
- **Cancellation reentrancy after refund:** `cancelProposal` sets `proposal.status = ProposalStatus.Cancelled` and `depositRefunded[id] = true` BEFORE the `toweli.transfer` (lines 491-493 vs 496). CEI compliant.

### I-2. Recommended hardening (non-bugs)
- Index `proposalUniqueVoters` events for off-chain analytics.
- Consider a `MAX_PROPOSAL_AMOUNT_ABSOLUTE` ceiling on top of `MAX_GRANT_PERCENT_BPS` for catastrophic-balance scenarios.
- Add a circuit-breaker that auto-pauses if `rollingDisbursed > 50% balance` rather than just reverting.

### I-3. ProposerMissingStakingPointer validation only at creation
The NEW-G7 fix ensures `proposerTokenId != 0` at create. But after creation, if `userTokenId` is later set to 0 for the proposer, the `holdsToken` check at vote time correctly catches transfer-out via per-owner set membership. The legacy fallback (`userTokenId(msg.sender) == proposerTokenId`) only fires if `holdsToken` reverts (mid-upgrade). All paths are sound.

---

## TEST GAPS

The following scenarios are **not** covered by `CommunityGrants.t.sol` or `Audit195_Grants.t.sol`:

1. **`retryExecution` while paused** — no test asserts behavior. (Confirms H-1.)
2. **`cancelProposal(Approved)` by owner while paused, then `emergencyRecoverETH`** — no test exercising the rug path. (Confirms H-2.)
3. **`lapseProposal` while paused** — no test. (Confirms H-3.)
4. **Reentrancy via TOWELI hook in `createProposal`** — no malicious-token mock fixture.
5. **Reentrancy via `votingEscrow` external call (`userTokenId`)** — no malicious-escrow mock that reenters during creation.
6. **WETH `deposit` succeeds but `transfer` reverts AND `withdraw` reverts** — no MockWETH that exercises the partial-failure path in `_transferETHOrWETH`.
7. **`sweepFees` while paused** — no test confirms or denies (currently allowed; M-2/L-1).
8. **`proposeFeeReceiver` + `executeFeeReceiverChange` during pause** — no test.
9. **Activeness invariant under FailedExecution slot occupation** — no test asserts that 50 stuck FailedExecution proposals block creation (L-3 DOS scenario).
10. **`getProposal` does not return `proposerTokenId`** — no view tests for full struct symmetry (L-6).
11. **Fee receiver self-rotation (proposing same as current)** — no test.
12. **Vote at `block.timestamp == deadline` followed by another voter "racing" to flip result before finalize** — no test on M-4 timing edge.
13. **`_transferETHOrWETH` returns false but proposal status not updated symmetrically** — covered partially by `test_lifecycle_failedExecution_retry` but not the WETH-fallback-failure-then-unwrap path.
14. **`cancelProposal` of Approved proposal frees `totalApprovedPending` AND verifies `emergencyRecoverETH` recovers it** — `test_emergencyRecover_protectsApprovedPending` shows the protection BUT not the cancel-then-recover bypass.
15. **FailedExecution → cancel by proposer should revert** — currently the code only allows `Active` for proposer cancel (line 481 path only matches Active OR Approved-by-owner). Test missing for proposer attempting to cancel FailedExecution.

---

## SUMMARY COUNTS

- HIGH: 3 (H-1 retryExecution missing pause; H-2 cancel-while-paused enables emergency-recover rug; H-3 lapse-while-paused enables same)
- MEDIUM: 7 (M-1 createProposal reentrancy CEI; M-2 fee-receiver flow not pause-gated; M-3 partial WETH-failure drift; M-4 deadline `>` race; M-5 voter-count drift; M-6 fragile invariant; M-7 pause does not extend EXECUTION_DELAY)
- LOW: 7
- INFO: 3 (covering 12 hunt items found CLEAN)
- TEST GAPS: 15 scenarios uncovered

**Top 3 priorities:**
1. **H-1** (retryExecution missing `whenNotPaused`) — owner can release ETH during a security pause.
2. **H-2** (cancelProposal not pause-gated → emergencyRecoverETH rug of approved-pending ETH).
3. **M-1** (createProposal not `nonReentrant`; CEI violated against the TOWELI/escrow external calls).
