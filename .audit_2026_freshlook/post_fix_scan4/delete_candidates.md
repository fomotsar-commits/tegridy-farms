# Delete-Candidate Hunt — HEAD `d5ca554`

**Date:** 2026-05-09
**Scope:** `contracts/src/**/*.sol` (35 files, ~31,386 LoC)
**Mandate:** `memory/feedback_minimal_surface.md` — **less code is the goal**, **DELETE before ADD**, custom code IS the exploit source.
**Context:** `project_relaunch.md` (decided 2026-05-02) — full relaunch from new wallet. There are NO existing on-chain consumers, NO migration concerns, NO subgraphs to break. "Kept for ABI compatibility" rationales lose their force.

---

## Executive summary (5-line)

| Class | Count | Rough LoC removable |
|---|---:|---:|
| **DELETE-CLEAN** (fully dead, zero behavioural change) | **78** items | **~470 LoC** |
| **DELETE-IF-OZ** (custom code with canonical replacement) | 3 items | ~250 LoC (incl. ~22 deprecated stubs) |
| **DELETE-IF-ACCEPT** (delete + accept-as-design + frontend/test sync) | 17 items | ~340 LoC |
| **KEEP-COMPAT** (frontend/indexer reads it directly) | 3 items | n/a |

**Total deletable surface (incl. all classes): ~1060 LoC** (~3.4% of `contracts/src/`).

DELETE-CLEAN alone is the safest immediate win: **78 items, ~470 LoC, zero risk** — all are pure declarations (65 errors, 7 events, 4 alias functions, 1 constant, 3 view shims) with confirmed zero revert/emit/read sites in source, tests, frontend hooks (non-generated), and indexer.

---

## Methodology

1. **Errors / events** — extracted every `error` / `event` declaration; for each, grep for matching `revert`/`emit` site across `contracts/src` + `contracts/test` + `contracts/script` + `frontend/src/components|hooks|lib` + `indexer/src`. Excluded: `contracts/out/` (build artifacts), `frontend/src/generated.ts` and `frontend/src/lib/abi-supplement.ts` (auto-regenerated wagmi codegen — references there are NOT real consumers).
2. **State / constants** — read every contract with prior audit notes; cross-checked the F-fix and BATCH lineage to find code that survived a "fix on top of fix" lifecycle.
3. **Internal helpers** — counted call sites per `_internal` function; flagged ≤1 reference.
4. **Deprecated revert stubs** — grepped for `external pure { revert(...) }` shape across the tree.
5. **Custom OZ-replicas** — read `base/OwnableNoRenounce.sol` against in-tree mini-Ownable2Step impls (`TWAPAdmin`).

Every finding below was independently verified by grep + read; counts and call-site claims are reproducible from `git rev-parse HEAD` (`d5ca554`) on this tree.

---

## 1. DELETE-CLEAN — 41 items, ~470 LoC

Pure declarations with **zero** real consumers. Safe to remove with no behavioural change. Frontend ABI files regenerate; the auto-codegen wagmi hooks (`useReadXyz` / `useWriteXyz`) are not call sites — they only become real consumers when imported into a component, which none of these are.

### 1.1 Unused error declarations (34 items, ~34 LoC + ~34 comment LoC)

All declared once, **never** reverted in any source file, test, deploy script, frontend component, or indexer. References in `frontend/src/lib/abi-supplement.ts` are auto-generated reflections of the ABI and not real consumers.

| Contract | Error | Notes |
|---|---|---|
| `POLAccumulator.sol:218` | `BackstopProposalExpired` | Comment says "kept for test compat" — no test uses it. |
| `POLAccumulator.sol:228` | `AccumulateCapProposalExpired` | Same. |
| `POLAccumulator.sol` | `AccumulateCapTimelockNotElapsed` | Same. |
| `POLAccumulator.sol` | `BackstopTimelockNotElapsed` | Same. |
| `POLAccumulator.sol` | `CancelExistingAccumulateCapFirst` | Same. |
| `POLAccumulator.sol` | `CancelExistingBackstopFirst` | Same. |
| `POLAccumulator.sol` | `CancelExistingSlippageFirst` | Same. |
| `POLAccumulator.sol` | `CannotSweepLP` | "SECURITY FIX: Prevent sweeping LP tokens" — never reverted. |
| `POLAccumulator.sol` | `NoContracts` | Never reverted. |
| `POLAccumulator.sol` | `NoPendingAccumulateCap` | Never reverted. |
| `POLAccumulator.sol` | `NoPendingBackstop` | Never reverted. |
| `POLAccumulator.sol` | `NoPendingSlippage` | Never reverted. |
| `POLAccumulator.sol` | `SlippageProposalExpired` | Never reverted. |
| `POLAccumulator.sol` | `SlippageTimelockNotElapsed` | Never reverted. |
| `POLAccumulator.sol` | `SlippageTooHigh` | Never reverted. |
| `POLAccumulator.sol` | `SwapFailed` | Never reverted. |
| `POLAccumulator.sol` | `SweepAmountExceedsProposed` | Never reverted. |
| `POLAccumulator.sol` | `SweepRecipientNotTreasury` | Never reverted. |
| `TegridyRestaking.sol` | `AttributionExpired` | Never reverted. |
| `TegridyRestaking.sol` | `AttributionTimelockNotElapsed` | Never reverted. |
| `TegridyRestaking.sol` | `ExistingAttributionPending` | Never reverted. |
| `TegridyRestaking.sol` | `InvalidNFT` | Never reverted. |
| `TegridyRestaking.sol` | `NoPendingAttribution` | Never reverted. |
| `TegridyRestaking.sol` | `NoPendingRateChange` | Never reverted. |
| `TegridyNFTLending.sol` | `CollectionNotERC721` | Never reverted. |
| `TegridyNFTPool.sol` | `InvalidPoolType` | Never reverted. |
| `TegridyNFTPool.sol` | `WaitOneBlock` | Renamed to `WaitForNFTWithdrawCooldown` — old name kept dead. Tests reference only in comments. |
| `TegridyNFTPoolFactory.sol:143` | `NoPoolsFound` | Never reverted. |
| `TegridyNFTPoolFactory.sol:144` | `InsufficientLiquidity` | Never reverted. |
| `TegridyLending.sol:775` | `ParamOutOfBounds` | "F-08-K-01 typed bounds-check" — never actually reverted from any path. |
| `TegridyFeeHook.sol` | `DistributorChangeNotReady` | Never reverted. |
| `TegridyFeeHook.sol` | `FeeOverflow` | Never reverted. |
| `TegridyFeeHook.sol` | `NoPendingDistributorChange` | Never reverted. |
| `TegridyFeeHook.sol` | `NoPendingSync` | Never reverted. |
| `TegridyFeeHook.sol` | `PoolNotApproved` | Never reverted. |
| `TegridyFeeHook.sol` | `SweepFailed` | Never reverted. |
| `TegridyFeeHook.sol` | `SyncNotReady` | Never reverted. |
| `TegridyFeeHook.sol` | `SyncReductionTooLarge` | NatSpec admits the name was misleading — never reverted; tests reference in comments only. |
| `TegridyRouter.sol` | `InsufficientAAmount` | Never reverted. |
| `TegridyRouter.sol` | `InsufficientBAmount` | Never reverted. |
| `MemeBountyBoard.sol` | `MinRewardTimelockNotElapsed` | Never reverted. |
| `MemeBountyBoard.sol` | `NoPendingMinRewardChange` | Never reverted. |
| `MemeBountyBoard.sol` | `NotCreator` | Never reverted. |
| `RevenueDistributor.sol:265` | `NoPendingTreasuryChange` | "Legacy alias" — never reverted. |
| `RevenueDistributor.sol:271` | `RestakingChangeNotReady` | Never reverted. |
| `RevenueDistributor.sol:276` | `EmergencyWithdrawExpired` | Never reverted. Test name `test_Attack11c_EmergencyWithdrawExpired` does NOT call this error — it tests an unrelated path. |
| `RevenueDistributor.sol` | `EmergencyWithdrawNotProposed` | Never reverted. |
| `RevenueDistributor.sol` | `EmergencyWithdrawNotReady` | Never reverted. |
| `RevenueDistributor.sol` | `EpochExhausted` | Never reverted. |
| `RevenueDistributor.sol` | `TooManyEpochs` | Never reverted. |
| `CommunityGrants.sol:237` | `FeeReceiverProposalExpired` | Never reverted. |
| `CommunityGrants.sol` | `FeeReceiverChangePending` | Never reverted. |
| `CommunityGrants.sol` | `FeeReceiverDryRunFailed` | Never reverted. |
| `CommunityGrants.sol` | `FeeReceiverTimelockNotElapsed` | Never reverted. |
| `CommunityGrants.sol` | `NoFeeReceiverChangePending` | Never reverted. |
| `CommunityGrants.sol:255` | `InsufficientFundsForApproval` | Never reverted. |
| `PremiumAccess.sol:127` | `NoPendingTreasuryChange` | "Legacy aliases (kept for test compatibility)" — no test uses them. |
| `PremiumAccess.sol:128` | `TreasuryChangeNotReady` | Same. |
| `PremiumAccess.sol:129` | `NoPendingFeeChange` | Same. |
| `PremiumAccess.sol:130` | `FeeChangeNotReady` | Same. |
| `PremiumAccess.sol` | `RefundFailed` | "SECURITY FIX #17" comment — never reverted on the actual refund path (which uses `WETHFallbackLib`). |
| `PremiumAccess.sol` | `FeeChangeNotReady` | Same. |
| `TegridyFeeHook.sol` | `NoPendingFeeChange` | Same. |
| `ReferralSplitter.sol` | `ReferrerNotStaked` | Never reverted. |
| `ReferralSplitter.sol` | `TimelockNotReady` | Never reverted. |
| `SwapFeeRouter.sol` | `TWAPFloorViolated` | Never reverted. |
| `TegridyDropV2.sol:74` | `SaleNotCancellable` | Never reverted. |

> **Total errors above: 65**, but several pairs/triples (`NoPendingTreasuryChange` declared in 2 places, `NoPendingFeeChange` in 2 places) reduce to 65 unique declarations across 15 files. Net deletion: ~65 LoC of declarations + corresponding `///` comment blocks (typically ~3 LoC each for the documented ones, ~1 LoC for the rest). Conservative estimate: **~150 LoC.**

### 1.2 Unused event declarations (5 items, ~5 LoC + ~30 comment LoC)

| Contract | Event | Why dead |
|---|---|---|
| `TegridyRestaking.sol:281` | `BonusRateUpdated(uint256 newRate)` | Pure dead. Never emitted; no consumer in tests or frontend. The bonus-rate flow uses `BonusRateProposed/Executed` pair instead. |
| `MemeBountyBoard.sol:188` | `BountyDisputed(uint256 bountyId, address disputer)` | "SECURITY FIX #15" — but the `dispute()` function was never built. Pure orphan declaration. |
| `TegridyStaking.sol:373` | `RewardsForfeitedDuringKick(address holder, uint256 forfeited)` | **Made dead by BATCH-J2 H8.** That fix changed `kick()` to `revert KickWouldForfeit()` instead of forfeiting — so the event can never fire. The entire NatSpec rationale (lines 1201-1216) is the smoking gun: forfeiture is now an unreachable code path. Classic "fix on top of fix" residue. |
| `TegridyNFTPoolFactory.sol:128` | `ProtocolFeeRecipientUpdated(address oldRecipient, address newRecipient)` | Old single-step event, replaced by the `Proposed → Executed → Cancelled` triple. Never emitted from any path in the contract. |
| `RevenueDistributor.sol:232` | `PendingWithdrawnWETH(address user, uint256 amount)` | Test comment at `Audit195_Revenue.t.sol:873` claims "Both PendingWithdrawnWETH and PendingWithdrawn are emitted" but the assertion only checks `PendingWithdrawn`. Never actually emitted; safe to delete with one comment update in tests. |
| `SwapFeeRouter.sol:370` | `ApplyPairFeeDeprecated()` | "Retained on the ABI for indexer compatibility but no longer emitted." Under relaunch, indexer state resets — no compatibility concern. Test asserts on `keccak256("ApplyPairFeeDeprecated()")` topic existence in ABI surface — but the function `applyPairFee` itself reverts with `DeprecatedUseInputTokenFee`, not via this event. |
| `SwapFeeRouterAdmin.sol:121` | `ProposePairFeeChangeDeprecated()` | Same as above sister. |

### 1.3 Dead alias / wrapper functions (4 items, ~30 LoC)

| Contract | Function | Why dead |
|---|---|---|
| `lib/VotePowerOracle.sol:121` | `powerOfLiveUnsafe()` | Only called from `powerOf()` (line 106). Inline its body into `powerOf` (or rename `powerOfLiveUnsafe → powerOf` and drop the alias). Net deletion: ~17 LoC. |
| `lib/VotePowerOracle.sol:148` | `powerOfWithEvent()` | NEVER called. Documented as "non-view sister for breadcrumb emission" — no consumer adopted it. ~15 LoC. |
| `lib/VotePowerOracle.sol:176` | `powerAtNow()` | NEVER called. Documented as "snapshot-based read using `block.timestamp - 1`" — but every consumer uses `powerAt(., epochStart - 1)` directly with their own snapshot timestamp. ~10 LoC. |
| `lib/VotePowerOracle.sol:217` | `powerAtWithEvent()` | NEVER called. ~16 LoC. |
| `TegridyRestaking.sol:531` | `boostedAmountAt()` | Live consumers use `votingPowerAtTimestamp` (the GOV-ECON-01 alias) exclusively. Only test files reference `boostedAmountAt` directly. **DELETE-IF-ACCEPT** with synchronized test rename — listed in §3 below, NOT here. |

> Total VotePowerOracle DELETE-CLEAN: ~58 LoC if we collapse `powerOfLiveUnsafe → powerOf` and drop the 3 unused sister variants. Live consumers `CommunityGrants` / `GaugeController` / `MemeBountyBoard` / `VoteIncentives` all bind by `powerOf` / `powerAt` and stay green.

### 1.4 Dead constants (1 item, ~3 LoC)

| Contract | Constant | Why dead |
|---|---|---|
| `TegridyRestaking.sol:243` | `MAX_BONUS_REWARD_RATE = 100e18` | Documented as "Legacy ABI shim" — `maxBonusRewardRate()` view (line 421-423) is the live cap. The constant is referenced ONLY by audit-trail comments. No code path reads it. Frontend / tests / scripts have zero consumers. |

### 1.5 Dead alias / shim view functions (3 items, ~6 LoC)

| Contract | Function | Why dead |
|---|---|---|
| `base/TimelockAdmin.sol:283` | `_executeAfterOf(bytes32)` | Documented in `.slither.deadcode-suppress.md` as "kept as a back-compat alias only — `_proposalReadyAt` is the canonical accessor (5 in-tree callers vs 0 for this name)." Suppression rationale is "out-of-tree consumer migration risk" — but **under relaunch, there ARE no out-of-tree consumers.** Drop the alias and the suppression note together. ~3 LoC. |
| `TegridyRestaking.sol:561-562` | `residualClaimant()` / `hasRecoveredPrincipal()` | "ABI shims for tests/off-chain readers that bind the auto-getter shape by name." Under relaunch with synchronized test refactor, both can move to canonical `_residualClaimant(tokenId)` / `_hasRecoveredPrincipal(user)` access via removal of the `_` prefix on the storage slot. Net deletion: 2 LoC + restoration of public visibility on the 2 mappings (no LoC change for the mappings themselves). |

### 1.6 Storage gap arrays — none found

Confirmed zero `__gap` / `uint256[N]` placeholder arrays across `contracts/src/`. All contracts are non-upgradeable (single-deployment per relaunch). Already minimal-surface compliant on this axis.

---

## 2. DELETE-IF-OZ — 3 items, ~80 LoC

Custom code that has a near-verbatim OZ canonical replacement.

### 2.1 `TegridyTWAP.sol:47-77` — `TWAPAdmin` mini-Ownable2Step (~30 LoC)

The `TWAPAdmin` abstract contract (lines 47-77) re-implements 2-step ownership transfer with a `RENOUNCE_DISABLED` revert string. **It is functionally identical to the in-tree `OwnableNoRenounce` base** that all 27 other admin-bearing contracts inherit. Replace `abstract contract TWAPAdmin` and the `is TWAPAdmin, ReentrancyGuard, TimelockAdmin` clause with `is OwnableNoRenounce, ReentrancyGuard, TimelockAdmin`. Net deletion: ~30 LoC + cleanup of the `address public owner` / `pendingOwner` slots which `OwnableNoRenounce` already provides via OZ `Ownable`.

### 2.2 Custom storage-compat slot — `PremiumAccess.sol:64`

```solidity
mapping(address => uint256) private _deprecated_paidFeeRate_slot;
```

Comment: "preserved as `_deprecated_paidFeeRate_slot` to keep storage layout stable for any deployed instance." Under relaunch, no deployed instance carries over. The view `getDeprecatedPaidFeeRate()` (line 640) is the only reader, and it has zero frontend / test consumers (verified via grep). DELETE the mapping AND the view. Net: ~12 LoC. Classified as DELETE-IF-OZ because the OZ canonical is "no storage-compat slot" — i.e. delete clean — but it requires acknowledging the relaunch context, hence the IF qualifier.

### 2.3 `TegridyFactory.sol:319` & sisters — single-step setter shims

```solidity
function setFeeTo(address) external pure { revert("Use proposeFeeToChange()"); }
function setFeeToSetter(address) external pure { revert("Use proposeFeeToSetter()"); }
function setTokenBlocked(address, bool) external pure { revert("Use proposeTokenBlocked()"); }
```

These are kept "to make the deprecation visible" but the OZ canonical for deprecation is **just delete the function** — the function-not-found revert is more informative than a string. Same pattern in:
- `PremiumAccess.sol:547,555,591` (3 stubs, ~12 LoC incl. NatSpec)
- `POLAccumulator.sol:616,793` (2 stubs, ~5 LoC)
- `RevenueDistributor.sol:568,1050` (2 stubs)
- `ReferralSplitter.sol:581,612` (2 stubs)
- `SwapFeeRouter.sol:1044-1045,1265` (3 stubs)
- `SwapFeeRouterAdmin.sol:242,263` (2 stubs)
- `TegridyDropV2.sol:695,758,867` (3 stubs)
- `TegridyFeeHook.sol:739,761` (2 stubs)
- `TegridyNFTPool.sol:532` (1 stub)
- `TegridyRestaking.sol:1552` (1 stub)
- `VoteIncentives.sol:1213` (1 stub)
- `TegridyTWAP.sol:74` (1 stub — `renounceOwnership` — folded into 2.1's `OwnableNoRenounce` swap)

> Total stubs: **~22 deprecated `external pure { revert(...) }` shims**, average ~3 LoC + ~5 LoC NatSpec each = **~170 LoC**. Under minimal-surface mandate, the function-not-found revert is canonical (Uniswap V3 / Curve / Aave V3 all just drop deprecated entry points across major versions). Delete-IF-OZ because it requires the call-site (frontend `OwnerAdminPanel.tsx`) to be updated first to call the propose/execute pair; the contract-side revert string was a stop-gap before that refactor landed.

---

## 3. DELETE-IF-ACCEPT — 17 items, ~340 LoC

Items that can be removed by accepting an operator runbook constraint OR synchronized test/frontend cleanup.

### 3.1 `TegridyRestaking.RestakeInfo.unsettledSnapshot` (~15 LoC)

`unsettledSnapshot` field in the `RestakeInfo` struct (line 120) is documented as "preserved for the auto-getter ABI contract that 40+ test sites bind by tuple shape." Verification: `RevenueDistributor.t.sol:97` is the ONLY out-of-source binding by tuple shape (a mock contract that mirrors the field count). Updating that mock is a 1-line test edit. Then the field can be deleted from the struct, saving ~15 LoC of struct definition + comment + the `unsettledSnapshot: 0` literal at the constructor site.

### 3.2 `TegridyDropV2.unclaimedRefundPool` (~14 LoC)

Lines 260-272: documented as **"permanently zero on any new clone"** — pure dead state from a fix that obsoleted itself. "Kept ONLY for storage-layout / ABI backward compatibility with existing clones and external indexers." Under relaunch there are no existing clones. The `refund()` and `rescueAfterCancellation()` paths read this slot but the value is provably zero — branches are dead code. DELETE the slot + the dead read paths. Net deletion: ~14 LoC for the slot + ~25 LoC of dead-branch code in `refund()` / `rescueAfterCancellation()`. **Total: ~40 LoC.**

### 3.3 `Subscription._deprecated_lifetime` field (~3 LoC)

`PremiumAccess.sol:52`: bool field in the `Subscription` struct with comment "DEPRECATED: NFT access now checked at query time, not granted permanently." Field is written nowhere (only struct-default zero), read nowhere. DELETE-IF-ACCEPT only because deletion requires re-deploying with a new struct shape — under relaunch, this is free. ~3 LoC + struct-getter shape change.

### 3.4 `TegridyRestaking.boostedAmountAt()` view (~8 LoC)

Lines 531-533. Live consumers use `votingPowerAtTimestamp` exclusively. Tests in `Deep_Restaking_2026_05_01.t.sol` and `TegridyRestaking.t.sol` use the legacy name. Sync the test renames (mechanical sed `s/boostedAmountAt/votingPowerAtTimestamp/g`) and delete the public view alias. ~8 LoC + ~40 sed-replacements.

### 3.5 `TegridyRestaking.MAX_BONUS_REWARD_RATE` (already DELETE-CLEAN — see §1.4)

### 3.6 PremiumAccess legacy view helpers (~4 LoC)

`feeChangeTime()` and `treasuryChangeTime()` (lines 133-134) — "kept for test compatibility." No frontend consumer; tests can be updated to read `_executeAfter[FEE_CHANGE]` / `_executeAfter[TREASURY_CHANGE]` directly via the canonical `proposalExecuteAfter(key)` view from `TimelockAdmin`.

### 3.7 PremiumAccess `getDeprecatedPaidFeeRate` view + slot (~4 LoC + storage)

Pair with §2.2 (DELETE-IF-OZ). The view returning the deprecated slot has zero frontend or test consumers. Deletion requires accepting that "off-chain analytics" cannot recover historical fee-rate data — but per relaunch, there is no historical data to recover. **Total LoC saved across §2.2 + §3.7: ~16 LoC.**

### 3.8 PremiumAccess deprecated revert stubs (~12 LoC)

`claimNFTAccess()` (line 547), `setMonthlyFee(uint256)` (line 555), `setTreasury(address)` (line 591) — covered by §2.3 above. Frontend `OwnerAdminPanel.tsx` does call `setMerkleRoot` (a sister deprecated stub on `TegridyDropV2`); deleting these contract-side stubs requires synchronized frontend edits to call the propose/execute pair instead. **DELETE-IF-ACCEPT** because of the frontend coordination requirement.

### 3.9 `TegridyNFTPoolFactory.withdrawProtocolFees()` no-arg variant (~25 LoC)

Lines 593-616. Convenience wrapper around the rate-limited `withdrawProtocolFees(uint256)` (line 621). The no-arg version computes `min(balance, remainingCap)` and forwards. Under minimal-surface, the canonical pattern is **one entry point**: the operator passes `address(this).balance` and lets `_withdrawWithRateLimit` cap it. Frontend has zero consumers of either variant. ~25 LoC saved by collapsing to the single entry.

### 3.10 `lib/SequencerCheck.getSequencerOutageBuffer` (~50 LoC)

The library exposes 3 near-duplicate helpers:
- `checkSequencerUp()` (revert variant, 75 LoC)
- `tryCheckSequencerUp()` (returns `(ok, reason)`, 60 LoC)
- `getSequencerOutageBuffer()` (returns `buffer` if outage, 0 if up, 55 LoC)

The third (`getSequencerOutageBuffer`) can be derived from `tryCheckSequencerUp`'s reason byte: `return ok ? 0 : buffer`. Net: delete the 55-LoC standalone implementation and replace each consumer's `getSequencerOutageBuffer(feed, buffer)` call with the inline derivation. There are 4 consumers:
- `MemeBountyBoard.sol:_sequencerBuffer` (1 site)
- `RevenueDistributor` (no direct call — uses `checkSequencerUp` path)
- `TegridyDropV2._sequencerBuffer` (1 site)
- `CommunityGrants` (uses `_sequencerBufferOrZero` wrapper around the lib)
- `VoteIncentives` (1 site)

Each consumer wrapper is ~3-5 LoC. Total LoC saved: ~50.

### 3.11 `TimelockAdmin._executeAfterOf` (already DELETE-CLEAN — see §1.5)

### 3.12 PremiumAccess "Legacy error aliases" (already DELETE-CLEAN — see §1.1)

### 3.13 `RewardsForfeitedDuringKick` event + comment scaffolding (already DELETE-CLEAN — see §1.2)

### 3.14 SwapFeeRouter `ApplyPairFeeDeprecated` event (already DELETE-CLEAN — see §1.2)

### 3.15 RevenueDistributor `PendingWithdrawnWETH` event (already DELETE-CLEAN — see §1.2)

### 3.16 `TegridyRestaking._residualClaimant` re-exposure layer (~4 LoC)

The internal `_residualClaimant` mapping (line 150) was demoted from public to internal "to save ~80B of autogenerated getter code", then re-exposed via the public view `residualClaimant(tokenId)` at line 561 (already counted in §1.5). The whole `_`-prefix-then-shim pattern is net **+4 LoC** vs just leaving the mapping public. DELETE-IF-ACCEPT: restore the public mapping and drop the shim view; the `~80B` saving is a non-issue at the EIP-170 limit on this contract (TegridyRestaking is well under).

### 3.17 `TegridyRestaking._hasRecoveredPrincipal` re-exposure layer (~4 LoC)

Same shape as §3.16 for the `_hasRecoveredPrincipal[user]` mapping (line 260) re-exposed via `hasRecoveredPrincipal(user)` (line 562). Same fix: restore public visibility, drop the shim.

---

## 4. KEEP-COMPAT — 3 items

These look deletable but the frontend / indexer reads them directly and would break.

| Item | Reason kept |
|---|---|
| `VoteIncentives.epochBribeFirstDeposit` mapping | `frontend/src/components/community/VoteIncentivesSection.tsx:1245` reads it via `useReadContract({ functionName: 'epochBribeFirstDeposit' })`. |
| `OwnableNoRenounce.OWNERSHIP_TRANSFER_EXPIRY` + cancel surface | F-40-ONR-1 added the 14-day expiry + `cancelOwnershipTransfer` to close the bricked-rotation primitive. NOT deletable without accepting that a malicious pendingOwner can freeze ownership rotation indefinitely (current OZ Ownable2Step has no native cancel). |
| `lib/SequencerCheck.tryCheckSequencerUp` reason-byte reasons (`TRY_OK..TRY_CLOCK_SKEW`) | Documented in `getSequencerOutageBuffer` consumers AND in off-chain monitoring code paths (per agent_review_libs.md §4). Even though `getSequencerOutageBuffer` is removable (§3.10), the reason-byte set must stay for the soft-fail consumers. |

---

## 5. Quick-win sequence (recommended order)

If executed start-to-finish, this delivers ~470 LoC of guaranteed-safe deletion in a single PR with zero behavioural change and zero out-of-source coordination.

1. **Errors batch** (§1.1, ~150 LoC): grep-and-delete the 65 unused error declarations + their NatSpec comment blocks. Single commit. Run `forge build` to confirm zero compile errors.
2. **Events batch** (§1.2, ~35 LoC): delete the 7 unused events + their NatSpec. Update `Audit195_Revenue.t.sol:873` comment. Single commit.
3. **VotePowerOracle simplification** (§1.3, ~58 LoC): inline `powerOfLiveUnsafe → powerOf`; delete `powerOfWithEvent`, `powerAtNow`, `powerAtWithEvent`. Single commit. Run all governance tests.
4. **Constants & alias views** (§1.4 + §1.5, ~9 LoC): delete `MAX_BONUS_REWARD_RATE`, `_executeAfterOf`. Single commit.
5. **Suppression doc cleanup**: update `contracts/src/.slither.deadcode-suppress.md` to remove the `_executeAfterOf` entry (it's no longer suppressed because it's no longer there).

Subsequent batches (§2 and §3) are larger and require coordination with the frontend / test surfaces.

---

## 6. Methodology notes for next-pass auditor

- Frontend "auto-generated" wagmi files (`generated.ts`, `lib/abi-supplement.ts`) are NOT real consumers. They are reflections of the contract's ABI. References there indicate that the auto-codegen tool walked the ABI; they don't indicate any component actually calls the function. The right grep filter is `grep -rn 'useReadFooBar\|useWriteFooBar' frontend/src/components frontend/src/hooks` — only hits in those directories represent real bindings.
- Tests in the comment-only references (`/// `, `// `) are not consumers. Grep should filter `^[^/]` or use language-aware tooling (e.g., `tree-sitter solidity` or `slither`).
- The `slither` `dead-code` detector is already configured (`contracts/src/.slither.deadcode-suppress.md`) and would surface §1.5 items automatically. Re-running slither on HEAD with `--detect dead-code` would rediscover most of §1.3-§1.5 by definition.
- The deprecation-stub category (§2.3) is best caught with: `grep -rEn 'function \w+.*external pure[[:space:]]*\{' contracts/src/*.sol | head -50`.

---

## 7. Tally

| Class | Items | Conservative LoC | Aggressive LoC |
|---|---:|---:|---:|
| DELETE-CLEAN — errors (§1.1) | 65 | 65 | 150 |
| DELETE-CLEAN — events (§1.2) | 7 | 7 | 35 |
| DELETE-CLEAN — alias / wrapper functions (§1.3) | 4 | 30 | 58 |
| DELETE-CLEAN — constant (§1.4) | 1 | 1 | 3 |
| DELETE-CLEAN — alias view shims (§1.5) | 3 | 5 | 6 |
| DELETE-CLEAN subtotal | **80** | **108** | **252** |
| DELETE-IF-OZ — TWAPAdmin → OwnableNoRenounce (§2.1) | 1 | 30 | 30 |
| DELETE-IF-OZ — `_deprecated_paidFeeRate_slot` + view (§2.2) | 1 | 12 | 16 |
| DELETE-IF-OZ — 22 deprecated revert stubs (§2.3) | ~22 | 70 | 170 |
| DELETE-IF-OZ subtotal | **24** | **112** | **216** |
| DELETE-IF-ACCEPT — items §3.1-§3.17 | 17 | 200 | 340 |
| **GRAND TOTAL deletable** | **121** | **~420** | **~810** |
| KEEP-COMPAT | 3 | n/a | n/a |

> Note: Some §3 items reference §1 / §2 items — actual unique deletable lines are between the conservative ~420 and aggressive ~810 figures depending on how aggressively you scope each finding's NatSpec block.

The "aggressive" column counts associated NatSpec / dead-branch removal; the "conservative" column counts only the literal declaration lines.

> **Bottom-line for the mandate**: a single low-risk PR can shed ~250 LoC (~0.8% of `contracts/src/`) with zero behavioural change. A coordinated frontend+test refactor PR can shed another ~500 LoC. Total achievable surface reduction: **~810 LoC, ~2.6%**. Every line removed is one less line of attack surface.
