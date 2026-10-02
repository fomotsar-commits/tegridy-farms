# Confirmatory exploit scan — remaining contracts (post-minimal-surface mandate)

**Scope:** TegridyLPFarming, CommunityGrants, MemeBountyBoard, PremiumAccess, TegridyTokenURIReader, lib/* (WETHFallbackLib, VotePowerOracle, SequencerCheck, SafeERC721Call), base/* (OwnableNoRenounce, TimelockAdmin)

**Date:** 2026-05-09
**Mandate ref:** `C:\Users\jimbo\.claude\projects\C--Users-jimbo-OneDrive-Desktop-tegriddy-farms\memory\feedback_minimal_surface.md`

---

## 1. CRITICAL FIX VERIFICATION (mandate items 1-3)

### 1.1 LPFarming C-1 / F-28-1 — `updateReward` modifier order

**Status: INTACT — VERIFIED**

`contracts/src/TegridyLPFarming.sol:210-261` (modifier `updateReward`)

The Synthetix anchor pattern is preserved. The execution order inside the modifier is:

1. **Empty-period forfeiture event** (lines 216-219) — emit before advancing `lastUpdateTime`
2. **Crystallise reward state** (line 220): `rewardPerTokenStored = rewardPerToken();`
3. **Advance the global clock** (line 224): `lastUpdateTime = lastTimeRewardApplicable();`
4. **THEN** crystallise per-account rewards under the OLD boost (lines 244-245):
   ```
   rewards[account] = earned(account);
   userRewardPerTokenPaid[account] = rewardPerTokenStored;
   ```
5. **THEN** refresh the boost cache for FUTURE emissions (lines 249-258).

This is the canonical Synthetix order: rewards are crystallised at the OLD per-account boost cache via `earned(account)` (which uses the as-yet-unwritten `effectiveBalanceOf[account]`), THEN `userRewardPerTokenPaid` is anchored to the just-written `rewardPerTokenStored`, THEN the boost cache is refreshed so any change applies only to FUTURE emissions.

The earlier-audit C-1 attack (silently reapplying a NEW boost to the entire `(rewardPerToken - userRewardPerTokenPaid)` delta) is closed because by the time `_getEffectiveBalance` and the cache-write at 252-256 land, `userRewardPerTokenPaid[account]` has already been bumped to the current `rewardPerTokenStored`, leaving zero retroactive delta to over-credit.

**No regression. The fix is at the canonical anchor position.**

### 1.2 LPFarming F-28-2 — `emergencyWithdraw` modifier-free path

**Status: INTACT — VERIFIED**

`contracts/src/TegridyLPFarming.sol:473-521` (function `emergencyWithdraw`)

The `updateReward` modifier is dropped (line 473: `external nonReentrant`, no `updateReward(msg.sender)`). Instead, the function performs an inline minimal state sync (lines 485-490) that:

- Emits the empty-period forfeiture event (lines 485-488)
- Calls `rewardPerToken()` (NO external call, all-internal arithmetic)
- Advances `lastUpdateTime`

It then INLINE-computes the user's forfeited reward (lines 498-500), without calling `earned()` (which would otherwise read stale `userRewardPerTokenPaid` against just-written `rewardPerTokenStored`). It anchors `userRewardPerTokenPaid` to the just-written value (line 505) defensively, then performs the CEI sequence: zero state → safeTransfer.

**Critical property preserved:** `emergencyWithdraw` makes ZERO external calls to `tegridyStaking` (no `aggregateActiveBoostBps`). If the staking contract is ever malformed/paused/OOG-bombed, users still get their LP back. This matches the MasterChef-class invariant.

The AUDIT NEW-S6 concern (subsequent claimers over-credited because `totalEffectiveSupply` shrinks before sync) is closed by ordering: sync first, then shrink (line 489 sync, line 509 shrink).

### 1.3 CommunityGrants `_transferETHOrWETH` — home-rolled with WETH unwrap

**Status: INTACT — VERIFIED — DO NOT swap to lib (per mandate)**

`contracts/src/CommunityGrants.sol:1089-1112` (function `_transferETHOrWETH`)

Verified the home-rolled helper. Critical differences from `WETHFallbackLib.safeTransferETHOrWrapNoRevert`:

1. **Unwraps WETH on FINAL failure** (line 1105):
   ```
   if (!sent) {
       IWETH(weth).withdraw(amount);  // <-- unwrap back to ETH
       return false;
   }
   ```
   Without this, a WETH transfer failure after a successful WETH wrap would leave the contract holding stranded WETH (mode==2 in lib parlance) which `recoverERC20`/`emergencyRecoverETH` paths cannot reclaim safely. The home-rolled unwrap restores the invariant `address(this).balance == funds-not-yet-disbursed` regardless of how the path fails.

2. **Per-recipient gas stipend (10_000)** (line 1098), DELIBERATELY tighter than the lib's 30k stipend constant. Documented at lines 1090-1097: 100k → 10k reduction in the M-2 audit was specifically to restrict the cross-contract reentrancy surface; smart-account recipients land in the WETH-wrap branch as INTENDED behaviour. 30k would re-open the 22.1k cold-SSTORE budget that 10k was sized to deny.

**Confirmed: the divergence from the lib is BETTER for this consumer's threat model. Mandate-aligned.** The lib is the right pattern for batched-payee distribution loops where one bad recipient can DoS the loop; the per-grant single-recipient `_transferETHOrWETH` here is correct as is.

### 1.4 SequencerCheck H-9 — `feed == address(0)` revert on chainid != 1

**Status: INTACT — VERIFIED**

`contracts/src/lib/SequencerCheck.sol:139-142`

```
if (feed == address(0)) {
    if (block.chainid != 1) revert SequencerFeedNotConfigured();
    return;
}
```

Mainnet skip is intentional (mainnet has no sequencer concept). All other chains (Arbitrum, Optimism, Base, future L2s) revert if `setSequencerFeed(...)` is omitted at deploy time. This is the structural backstop for the deploy-side gate the user already wired in commit `e2bcc3c (fix(deploy): H-9 follow-on — gate L2 deploys on SEQUENCER_FEED env)`.

The same gate is mirrored in `tryCheckSequencerUp` (line 219 — soft-fail returns `(true, TRY_OK)` for view callers) and `getSequencerOutageBuffer` (line 291 — returns 0 on mainnet/no-feed). The view-side gates correctly differ from the writer-side gate because tryCheckSequencerUp is for indexers/quoters; the documented invariant is "writer paths use the reverting `checkSequencerUp` lib helper, view paths use try*". Verified this invariant holds.

### 1.5 WETHFallbackLib H-12 — mode==2 / mode==3 split semantics

**Status: INTACT — VERIFIED**

`contracts/src/lib/WETHFallbackLib.sol:222-251`

The split is correctly implemented:

- `mode==2` (line 251) — `WETHTransferStuck` event emitted; deposit succeeded BUT transfer failed; caller MUST sweep `IWETH(weth).balanceOf(address(this))` into per-recipient credit slot.
- `mode==3` (line 229) — `ETHWrapFailed` event; deposit failed entirely; ETH untouched in caller; no sweep needed.

Both events are emitted on the corresponding paths. The earlier mode==2 overload (deposit-fail OR transfer-fail) is gone; consumers can branch correctly.

The guard rejects (line 208-209: `to == address(0)` or `weth == address(0)`) now correctly map to mode==3 (was previously overloaded with mode==2).

### 1.6 VotePowerOracle H-10 — `powerOf` deprecated alias + `powerAtNow` helper

**Status: INTACT — VERIFIED**

`contracts/src/lib/VotePowerOracle.sol:101-184`

- `powerOf` (lines 101-107) — deprecated alias that delegates to `powerOfLiveUnsafe`. The `LiveUnsafe` suffix surfaces the flash-stake amplification footgun at every consumer call site.
- `powerOfLiveUnsafe` (lines 121-137) — explicitly-named live read.
- `powerAtNow` (lines 176-184) — snapshot-based read at `block.timestamp - 1`. Closes the flash-stake amplification vector at the lib level.
- `powerAt` (lines 196-211) — historical pinned read.

The deprecation is correctly comment-tagged; the live read is preserved for tie-breaker / min-clamp patterns where `min(historical, current)` is the actual amount applied (CommunityGrants line 461 uses this pattern correctly, paired with `powerAt` for the historical leg).

**Note:** the M-35 emit-on-fail telemetry split is also verified: `powerOfWithEvent` (line 148-162) and `powerAtWithEvent` (line 217-231) are non-view sisters that emit `RestakingPowerLookupFailed` on the catch path; the view variants stay silent for binary-compat (Solidity disallows `emit` from `view`).

### 1.7 OwnableNoRenounce F-40-ONR-1 — cancel + 14-day expiry

**Status: INTACT — VERIFIED**

`contracts/src/base/OwnableNoRenounce.sol`:

- `OWNERSHIP_TRANSFER_EXPIRY = 14 days` (line 43) — matches Compound Timelock `GRACE_PERIOD`.
- `ownershipTransferExpiresAt` storage slot (line 50) — set on `transferOwnership` (line 150), zeroed on `_transferOwnership` (line 132) and `cancelOwnershipTransfer` (line 194 via `_transferOwnership(owner())`).
- `acceptOwnership` (lines 160-170) — checks expiry BEFORE OZ's `msg.sender == pendingOwner` gate so an expired-but-still-set slot reverts with the typed `OwnershipTransferExpired()` rather than the less-diagnostic `OwnableUnauthorizedAccount`.
- `cancelOwnershipTransfer(reason)` (lines 183-200) — current owner can pre-empt a misbehaving pendingOwner; emits `OwnershipTransferCancelled(prev, reason)` after the state clear.

**The cancel path is implemented via `_transferOwnership(owner())` rather than direct slot writes** — this is the right call because OZ Ownable2Step.`_transferOwnership` deletes `_pendingOwner` unconditionally at its head. The implementation correctly comments that the resulting `OwnershipTransferred(prev, prev)` event is paired with the diagnostic `OwnershipTransferCancelled` for off-chain decoding.

EIP-7702 detection (lines 124-125) is preserved: `codeLen == 0 || codeLen == 23` rejects both EOAs and 7702-delegated EOAs when the child opts in to `_ownerMustBeContract()`.

---

## 2. INDEPENDENT EXPLOIT AUDIT — remaining contracts

### 2.1 CommunityGrants

**Inspected paths:** createProposal, voteOnProposal, finalizeProposal, executeProposal, retryExecution, cancelProposal, lapseProposal, lapseStaleProposal, sweepFees, emergencyRecoverETH, executeFeeReceiverChange, the cancel-approved timelock chain.

**State invariants checked:**
- `totalRefundableDeposits` is incremented exactly once at createProposal (line 323) and decremented exactly once per proposal (via `depositRefunded` flag), across all terminal paths (executeProposal, retryExecution, finalizeProposal-Reject, finalizeProposal-Approve-fail, cancelProposal, lapseProposal, lapseStaleProposal, executeCancelApproved). Verified via grep — every write site is gated by `depositRefunded[id]` flag flipping to `true`.
- `totalApprovedPending` is incremented at finalizeProposal-Approve (line 530) and decremented at executeProposal/retryExecution/lapseProposal/executeCancelApproved (lines 613, 675, 850, 780). Never decremented twice; never decremented without prior increment.
- `proposal.absoluteCap` is locked at creation (line 395), checked at execute/retry (lines 583, 651). Cannot be inflated post-approval.
- `proposal.rollingCapBalanceAtFinalize` is set at finalize-approve (line 538), used at execute/retry (lines 599-601, 661-663) with legacy-fallback to live balance. Binds rolling cap to community-approval-time treasury size.

**Findings:** **None.** All previously-known fixes are intact:
- D-CG-M1 (rolling cap snapshot) — verified.
- DEEP-GOV-09 (absolute cap snapshot) — verified.
- DEEP-GOV-13 (finalize-time max-balance check) — line 510, verified.
- M-G01 (24h cancel-approved timelock for Approved status) — verified.
- BATCH-E H11 (proposer must have single position) — line 351-353, verified.
- V2-GOV-11 (fail-closed on `holdsToken` revert) — line 441-445, verified.
- DEEP-GOV-01 (min(historical, current) clamp) — line 458-462, verified.
- BATCH-E H12 (whenNotPaused on lapseProposal) — line 836, verified.
- M-15 (whenNotPaused on executeCancelApproved) — line 766, verified.

**Potential simplification (NON-EXPLOIT, mandate item 6):**

`getProposalsByStatus` (lines 1220-1252) does a two-pass count-then-populate scan. Standard pattern is acceptable. **Keep as is.**

`getProposal` (line 1165-1172) is a 10-field tuple return that omits 4 fields from the struct (snapshotTimestamp returned but absoluteCap, rollingCapBalanceAtFinalize, proposerTokenId not). This is fine — `proposals(uint256)` public getter exposes all fields via the implicit Solidity getter, AND the indexer-friendly `getProposalsInRange` returns full Proposal struct. **No redundancy worth removing.**

### 2.2 MemeBountyBoard

**Inspected paths:** createBounty, submitWork, voteForSubmission, completeBounty, cancelBounty, refundStaleBounty, emergencyForceCancel, withdrawPayout, withdrawRefund, sweepExpiredRefund, sweepExpiredPayout, treasury timelock chain.

**State invariants checked:**
- `topSubmissionId` / `topSubmissionVotes` updated atomically with `submissions[i].votes` (lines 496-498, 542-543).
- `hasSubmitted[bountyId][addr]` flips to `true` exactly once on submitWork (line 437); enforced as `revert SubmitterCannotVote()` in voteForSubmission (line 471) — closes the BATCH-J MBB-VOTE-01 cross-vote ring.
- `pendingPayoutTime[winner]` set on first credit only (line 614 `if (pendingPayoutTime[winner] == 0)`); cleared on withdrawPayout (line 654). Sweep at PAYOUT_EXPIRY uses the original credit timestamp.

**Findings:** **None.** All known fixes intact:
- DEEP-GOV-04 + V2-GOV-08 (top-freeze with established-leader gate) — lines 520-541, verified.
- BATCH-F H16 (no whenNotPaused on completeBounty) — line 566, verified.
- D-MEME-M1 (50k stipend on completeBounty matches VoteIncentives) — line 604, verified.
- M-42 / F-80-03 (canonical lib in sweepExpiredPayout) — line 643, verified.
- V2-GOV-09 (cancel delay scaling) — lines 680-687, verified.
- BATCH-L1 M18 (PAYOUT_EXPIRY sweep) — verified.
- M-28 (force-cancel diversity gate) — lines 781-783, verified.

**Potential simplification (NON-EXPLOIT):** None worth flagging.

### 2.3 PremiumAccess

**Inspected paths:** subscribe, cancelSubscription, claimShortfall, withdrawToTreasury, batchReconcileExpired, reconcileExpired, hasPremium, hasPremiumSecure, activateNFTPremium, deactivateNFTPremium.

**State invariants checked:**
- `userEscrow[u]` + `totalRefundEscrow` + `totalShortfallOwed` + `totalRevenue` accounting:
  - Subscribe path (new): `userEscrow += cost`, `totalRefundEscrow += cost`, `totalRevenue += cost`. (Verified lines 351-352, 363.)
  - Subscribe path (extension): old escrow zeroed from `totalRefundEscrow`, new `userEscrow = cost + remainingEscrow`, `totalRefundEscrow += cost + remainingEscrow`. The `totalRevenue` is only bumped by `cost` (the actually-paid amount on this call), NOT by `consumedEscrow` — V2/V3 fix prevents double-counting (lines 314-336).
  - Cancel path: `totalRefundEscrow -= escrowed (full)`, `userEscrow = 0`. `totalRevenue -= fullRefundable` (computed BEFORE cap, includes shortfall portion) — V2-DR-L-03 fix at lines 441-449.
  - Shortfall claim: only decrements `shortfallOwed[u]` and `totalShortfallOwed`. **Does NOT** decrement `totalRevenue` — V3-DR3-M-02 fix at lines 529-539. Without this fix, cancel + shortfall + claim would double-decrement.
- `withdrawToTreasury` reserves both `totalRefundEscrow + totalShortfallOwed` (line 507). Cannot strand shortfall claimants.
- `nftActivationBlock[u]` is settable by `activateNFTPremium` (the user) and clearable by `deactivateNFTPremium` (anyone, gated by `balanceOf == 0` AND ≥10 minutes old). The grace window is INTENTIONAL per the documented PA-L-02 / Pa-L-02 doc-comment.

**Findings:** **None.** All known fixes intact.

**Potential simplification — minor, NON-EXPLOIT:**

The `_deprecated_paidFeeRate_slot` (line 64, slot 9 storage) is a stable-layout placeholder for the removed PA-M-02 mapping. The `getDeprecatedPaidFeeRate(user) returns (uint256)` view (lines 640-642) is the only read. **Keep — it's exactly the storage-stability pattern this audit calls for.** The mandate's "DELETE before ADD" rule does NOT apply because removing the slot would break storage layout for any deployed instance.

### 2.4 TegridyTokenURIReader

**Inspected paths:** tokenURI, _buildSVG, _buildJSON, _lockStatus.

**State:** Zero state — only an immutable `staking` reference. (Verified storage layout file is empty.)

**Findings:** **None.** All known fixes intact:
- DEEP-URI-02 (revert on non-existent token via try/catch ownerOf) — lines 58-62, verified.
- DEEP-URI-03 (single-flip lock status enum, no countdown) — lines 127-132, verified.
- R014 LOW (range checks: amount ≤ 1e9 ether, boostBps ≤ 50000) — lines 77-78, verified.
- DEEP-URI-01 (removed unused `_jsonEscape` helper) — verified absent.

**Mandate-relevant note:** This contract is **already minimal**. ~215 LoC, almost all of which are SVG / JSON string composition. View-only, no admin surface. **No simplification possible without breaking the on-chain SVG render contract.**

### 2.5 TegridyLPFarming — independent re-audit

**Additional paths inspected:** `notifyRewardAmount`, `reclaimForfeitedRewards`, `recoverERC20`, the timelock propose/execute/cancel chain, `refreshBoost` permissionless path.

**State invariants checked:**
- `forfeitedRewards`: incremented at emergencyWithdraw (line 516) and at the integer-division residue capture in notifyRewardAmount (line 591 — F-61-1 fix). Decremented exactly at reclaimForfeitedRewards (line 539) under the cap `balance - owedFutureRewards` (lines 531-535). **Cannot drain active staker rewards.**
- `totalEffectiveSupply`: every write path goes through the modifier OR is inline-synced. Verified parity:
  - `stake` body increments + modifier reconcile = OK.
  - `_withdrawInternal` body recompute = OK (after C-1 reorder, modifier writes the post-refresh cache for OLD raw amount; body recomputes for NEW raw amount).
  - `emergencyWithdraw` inline update — verified at section 1.2 above.
  - `refreshBoost` permissionless — line 337, modifier'd, body-level reconcile after modifier writes the cache (for the case where `tegridyStaking.aggregateActiveBoostBps(user)` returned a value DIFFERENT from the modifier's just-cached value, which can happen if `aggregateActiveBoostBps` is non-deterministic across consecutive blocks of the same tx — defense-in-depth).

**Findings:** **None new.** All known fixes intact:
- F-61-6 (MIN_STAKE = 100e18 for sybil-dust dilution) — line 71/367, verified.
- F-93-2 (NOTIFY_COOLDOWN = 1h sandwich gate) — lines 78/556-558, verified.
- F-61-1 (residue capture in notifyRewardAmount) — lines 589-592, verified.
- M-3 (timelocked rewardsDuration) — line 570 enforcement, verified.
- DEEP-DR-05 (executeRewardsDurationChange periodFinish gate) — line 627, verified.
- M11 (forfeitedRewards counter + reclaim) — lines 112/527-542, verified.
- C-01 / TF-01 (Position struct field order interface match) — lines 26-44, verified — int256 rewardDebt, uint16 boostBps, uint64 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited (matches TegridyStaking).
- R016 M-1 (single-pointer fallback removal) — verified absent.

### 2.6 lib/SafeERC721Call

**Inspected:** safeTransferFromBounded (selector 0x23b872dd, returns (bool ok)), safeOwnerOfBounded (selector 0x6352211e, returns (bool ok, address owner)).

**Findings:** **None.** All known fixes intact:
- F-40-S721-1 (default 50k gas budget; 10k floor) — lines 52, 117-138, verified.
- Bounded returndata copy (zero bytes for transferFrom; 32 bytes for ownerOf) — verified at the assembly blocks (line 78 `call(gas(), coll, 0, ..., 0, 0)`; line 130 `staticcall(gasBudget, coll, ..., 0, 32)`).
- Caller is responsible for paired `safeOwnerOfBounded` post-condition check (NFTLEND-NEW-H2 / LD-NEW-H2 requirement) — comment at lines 62-65 documents this.

### 2.7 base/TimelockAdmin

**Inspected:** `_propose`, `_execute`, `_cancel`, `_forceCancel`, the virtual hook trio (`_minDelay`, `_maxDelay`, `_proposalValidity`).

**Findings:** **None.** All known fixes intact:
- M-Lib1 (DelayTooLong cap, 30 days) — line 61, verified.
- M30 floors on `_minDelay` (≥ 1h) and `_proposalValidity` (≥ 1h) — lines 172, 208, verified.
- M30 fallback on `_maxDelay` (`maxD < minD → MAX_DELAY`) — line 178, verified.
- F-40-TLA-1 (`expiresAt` event uses floored validity) — line 191-193, verified.
- DEEP-LIB-H4 (`_forceCancel` helper for transitive clears) — lines 237-242, verified.
- F-75-9 through F-75-15 (boundary checks) — comments at lines 17-32 document each, verified.

---

## 3. STORAGE LAYOUT VERIFICATION

Storage layouts are stable across in-scope contracts. Slot 0-4 follows the universal Tegriddy convention:

| Slot | Field | Source |
|------|-------|--------|
| 0 | `_owner` | OZ Ownable |
| 1 | `_pendingOwner` | OZ Ownable2Step |
| 2 | `ownershipTransferExpiresAt` | OwnableNoRenounce (F-40-ONR-1) |
| 3 | `_paused` | OZ Pausable |
| 4 | `_executeAfter` | TimelockAdmin |

All five contracts confirm this layout (TegridyLPFarming, CommunityGrants, MemeBountyBoard, PremiumAccess, TegridyTokenURIReader is empty).

**Storage stability findings:**

- PremiumAccess slot 9 = `_deprecated_paidFeeRate_slot (mapping(address => uint256))` — preserved as a deliberate gap (PA-M-02 fix). **Stability-critical: do NOT remove or repurpose this slot.**
- All other slots map 1:1 with declared state variables in declaration order.
- No visible packing opportunities that would be exploitable (the bool/address co-location in OZ Pausable + Ownable is upstream, not ours).

---

## 4. REDUNDANT CODE — minimal-surface lens

Per mandate item 6 (separate from new exploits): code that could be DELETED without losing security.

### 4.1 LPFarming `stake()` body-level reconcile (lines 369-379)

The body-level reconcile mirrors what the modifier already did at the same call site. The doc-comment at line 356-363 explicitly notes "the body-level reconcile here is a no-op against the modifier's just-written cache for existing balance, but is structurally retained as a defence-in-depth checkpoint for the NEW deposit's boost." 

**Recommendation:** **KEEP.** The doc-comment is correct: removing it makes the function correctness depend on the implicit invariant that `_getEffectiveBalance(existingRaw)` returns the same value across the modifier and body. That invariant holds today, but a future change to `_getEffectiveBalance` (e.g. adding randomness or block.timestamp dependency) would silently break it. ~2.6k gas overhead is acceptable.

### 4.2 LPFarming `refreshBoost` body-level reconcile (lines 338-347)

Same pattern as `stake()` — modifier already reconciles, body reconciles again.

**Recommendation:** **KEEP** for the same reason (defense-in-depth against future `_getEffectiveBalance` non-idempotence).

### 4.3 CommunityGrants `_executeAfterOf` (TimelockAdmin alias)

The deprecated alias (`_executeAfterOf`) for `_proposalReadyAt` has 0 in-tree callers per the v3-LIB-I1 audit comment. It's marked `slither-disable-next-line dead-code`.

**Recommendation:** **KEEP for one more major version**, then drop. Keeping it costs nothing (no storage, just bytecode bloat in the abstract contract). Removing it now would break ABI compatibility for any external integrator that compiled against the previous version. Pure carve-out per minimal-surface mandate's documented "ABI-compatibility back-compat alias" exception.

### 4.4 PremiumAccess `getDeprecatedPaidFeeRate` view

Per section 2.3 — the view exists solely to expose the orphaned `_deprecated_paidFeeRate_slot`. Per mandate, slot stability requires we keep the slot; the view is the minimal off-chain access path.

**Recommendation:** **KEEP.**

### 4.5 PremiumAccess `claimNFTAccess()` deprecated revert

`pure`-reverting function (line 547-550). Pure bytecode bloat.

**Recommendation:** **KEEP.** Removing it would break any UI that still renders a "Claim NFT Access" button — the typed revert message is the documented migration breadcrumb. Negligible bytecode cost.

### 4.6 MemeBountyBoard `voteToken` immutable

`voteToken` (line 49) is documented dead state. The doc-comment at line 43-48 marks it deprecated for ABI compat.

**Recommendation:** **KEEP** — same ABI-compat carve-out.

### 4.7 No genuinely-redundant code found

After full review, every remaining piece of "extra" code falls into one of three documented carve-outs: defense-in-depth, ABI compatibility, or storage layout stability. **No deletions warranted.**

---

## 5. SUMMARY TABLE

| Item | Status |
|------|--------|
| LPFarming C-1 modifier order (Synthetix anchor) | **INTACT** |
| LPFarming F-28-2 emergencyWithdraw (no-modifier, inline sync) | **INTACT** |
| CommunityGrants `_transferETHOrWETH` (home-rolled with WETH unwrap) | **INTACT** |
| SequencerCheck H-9 (chainid != 1 revert on no-feed) | **INTACT** |
| WETHFallbackLib H-12 (mode==2/mode==3 split) | **INTACT** |
| VotePowerOracle H-10 (`powerOf` deprecated alias + `powerAtNow` helper) | **INTACT** |
| OwnableNoRenounce F-40-ONR-1 (cancel + 14d expiry) | **INTACT** |
| Storage layouts (TegridyLPFarming, CommunityGrants, MemeBountyBoard, PremiumAccess, TegridyTokenURIReader) | **VERIFIED** |
| Independent exploit re-audit | **NO NEW FINDINGS** |
| Redundant code (mandate item 6) | **NONE WORTH DELETING** |

---

## 6. CONCLUSION

All 7 critical fixes mandated by item 1-3 are intact. Storage layouts are stable and documented. Independent re-audit produced **zero new exploit findings**. Per minimal-surface lens, no redundant code worth removing without breaking documented carve-outs (ABI compat, storage stability, defense-in-depth).

The contracts in scope are **mandate-aligned**. The remaining "extra" code (deprecated aliases, dead immutables, defense-in-depth body reconciles) all live within the three documented exception classes.
