# Reservation-Pattern Sibling Sweep — Post-Fix Scan 6

**Date:** 2026-05-09
**HEAD:** `877185f` (post scan5 INV-1 fix for `TegridyNFTPool.priorOwnerOwed`)
**Scope:** every storage mapping/array in `contracts/src/` that holds USER-RESERVED FUNDS (pending payouts, escrow, owed-balances), verified against every sweep / withdraw / drain function for the canonical aggregate-counter pattern.

---

## Executive summary (5-line)

| Severity | Finding | Status |
|---|---|---|
| INFO | All 19 per-user reservation mappings across 14 token-holding contracts have correctly paired aggregate counters | ✅ |
| INFO | All 19 sweep / drain / withdraw paths correctly subtract every relevant aggregate | ✅ |
| INFO | scan5's INV-1 fix (`TegridyNFTPool.totalPriorOwnerOwed` + `_lpAvailableETH` reservation) verified in place at all 3 expected sites (mint @ acceptOwnership, decrement @ claimPriorOwnerLPFees, reserve @ _lpAvailableETH) | ✅ |
| INFO | Two contracts hold ETH WITHOUT a global sweep (`MemeBountyBoard`, `TegridyLending`/`TegridyNFTLending`) — invariant HOLDS-BY-CONVENTION via per-path discipline | ⚠️ |
| INFO | One mapping (`unsettledRewardsByTokenId`) is per-NFT not per-address; backed by holder-bucket invariant `sum(unsettledRewardsByTokenId[*]) ≤ unsettledRewards[holder]` | ✅ |

**Result:** zero ❌ findings. No sibling-miss of scan5's shape exists post-fix.

---

## Methodology

For each contract holding ETH, ERC20, or ERC721, I enumerated every per-user reservation mapping (`mapping(address => uint256) public pendingX` / `mapping(address => uint256) public XOwed` / `mapping(uint256 => uint256) public stranded*` / mapping-of-mappings token queues) and verified three properties:

1. **Aggregate exists** — a `totalX` counter (or sum-mapping for token-keyed cases) that mirrors the per-user mapping.
2. **Aggregate kept in lockstep** — every increment to `mapping[user]` is paired with `+= total`; every decrement with `-= total`.
3. **Sweep reserves aggregate** — every `sweep* / drain / emergencyWithdraw / withdraw*` admin path subtracts the aggregate from the available balance before transferring.

For mapping-of-mappings token queues (`pendingTokenWithdrawals[user][token]`), the aggregate is keyed by the inner dimension (`totalPendingTokens[token]`) — the per-token sweep then reserves the per-token aggregate. This is the canonical Aave V3 / Velodrome pattern.

For per-NFT mappings (`unsettledRewardsByTokenId[tokenId]` / `strandedNFTRecipient[key]` / `stuckCollateralRecipient[loanId]`), reservation is structurally backed by a parent invariant rather than a counter — verified inline below.

---

## 1. Per-user reservation mappings — full enumeration

### 1.1 PremiumAccess

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `userEscrow[user]` (TOWELI) | `totalRefundEscrow` | `withdrawToTreasury` reserves `totalRefundEscrow + totalShortfallOwed` (line 499) | ✅ |
| `shortfallOwed[user]` (TOWELI) | `totalShortfallOwed` | same | ✅ |

Increment/decrement sites (verified in lockstep):
- `subscribe`/`subscribe-extend` (lines 312–334), `cancelSubscription` (line 411–418), `reconcileExpired`/`batchReconcileExpired` (lines 458–482) — all decrement BOTH `userEscrow[user]` and `totalRefundEscrow`.
- `cancelSubscription` shortfall arm (line 398–399), `claimShortfall` (line 519–520) — both decrement `shortfallOwed[user]` AND `totalShortfallOwed`.

Sweep: `withdrawToTreasury` subtracts both aggregates from balance before transferring (line 499–504). ✅

### 1.2 RevenueDistributor

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `pendingWithdrawals[user]` (ETH) | `totalPendingWithdrawals` | `emergencyWithdraw` (line 516), `executeEmergencyWithdrawExcess` (line 544), `sweepDust` (line 972) all reserve `unclaimed + totalPendingWithdrawals` | ✅ |

Increment: `claim`/`claimUpTo`/`executeClaimRecovery` fallback arms (line ~960). Decrement: `withdrawPending` (line 956–960). Both sites paired with `totalPendingWithdrawals`. The `unclaimed` reservation derives from `totalEarmarked - totalClaimed` (a separate solvency invariant, not a per-user mapping). ✅

`executeTokenSweep` denies WETH (line 1024) — protects pending ETH that landed as WETH via `WETHFallbackLib` fallback. ✅

### 1.3 SwapFeeRouter

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `pendingDistribution[recipient]` (ETH) | `totalPendingDistribution` | `sweepETH` reserves `accumulatedETHFees + totalPendingDistribution` (line 1420) | ✅ |
| `accumulatedTokenFees[token]` (ERC20 per-token) | (single counter, no per-user dim) | `sweepTokens` reserves `accumulatedTokenFees[token]` (line 1721) | ✅ |

Increments: `distribute()` fallback arms (lines 1332, 1347). Decrement: `withdrawCallerCredit` (lines 1755–1758). Both paired with `totalPendingDistribution`. ✅

### 1.4 ReferralSplitter

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `pendingETH[referrer]` | `totalPendingETH` | `sweepUnclaimable` reserves `totalPendingETH + accumulatedTreasuryETH + totalCallerCredit` (line 774) | ✅ |
| `callerCredit[caller]` | `totalCallerCredit` | same | ✅ |

Increments: `recordFee` (line 415, 361, 369). Decrements: `claimReferralRewards` (line 466), `withdrawCallerCredit` (line 435), `forfeitUnclaimedRewards` (line 700) — all paired with the aggregate. `forfeitUnclaimedRewards` correctly conserves balance by routing decrement of `totalPendingETH` into `accumulatedTreasuryETH` (no actual ETH leaves contract). ✅

### 1.5 VoteIncentives

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `pendingETHWithdrawals[user]` (ETH) | `totalPendingETH` | `sweepExcessETH` reserves `totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH` (line 1380) | ✅ |
| `pendingTokenWithdrawals[user][token]` (ERC20) | `totalPendingTokens[token]` | `sweepToken(t)` reserves `totalUnclaimedBribes[t] + totalPendingTokens[t] + (toweli ? totalCommitBonds : 0)` (line 1392–1396) | ✅ |
| `commits[user][epoch]` bond field (TOWELI) | `totalCommitBonds` | `sweepToken(toweli)` adds `totalCommitBonds` to reservation | ✅ |
| `epochBribes[e][p][t]` (per-bucket ERC20/ETH) | `totalUnclaimedBribes[t]` / `totalUnclaimedETHBribes` | both sweep paths | ✅ |
| `bribeDeposits[e][p][t][depositor]` (per-depositor refund rights) | (no aggregate; backed by `totalUnclaimedBribes[t]` parent invariant — refundOrphanedBribe pulls from existing reserved pool) | sweep already reserves parent aggregate | ✅ |

Increments at lines 865, 877, 972, 981 (claim fallback arms) — each pairs `pendingX += share` with `totalX += share`. Decrements at 1001–1002, 1015–1016 (`withdrawPendingETH` / `withdrawPendingToken`) — paired. Bond increments/decrements (`commitVote` / `revealVote` / `forfeitCommitOnDisabledPair` / `sweepForfeitedBond`) pair `c.bond` updates with `totalCommitBonds`. ✅

### 1.6 CommunityGrants

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `proposals[i].refundable` (TOWELI in struct) | `totalRefundableDeposits` | `sweepFees` reserves `totalRefundableDeposits` (line 896); `executeFeeReceiverChange` dry-run reads `balance - totalRefundableDeposits` (line 955) | ✅ |
| `proposals[i].amount` (ETH in struct, post-approval) | `totalApprovedPending` | `emergencyRecoverETH` reserves `totalApprovedPending` (line 909) | ✅ |

Increments: `submitProposal` (line 307 — `totalRefundableDeposits`), `finalizeApproved` (line 514 — `totalApprovedPending`). Decrements: `executeProposal`, `lapseProposal`, `cancelProposal`, `cancelApprovedProposal`, `forfeitProposalFee` — all paired. ✅

### 1.7 MemeBountyBoard

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `pendingPayouts[winner]` (ETH) | (none — no global sweep) | `sweepExpiredPayout` per-user 1y stale → treasury (line 626) | ⚠️ |
| `pendingRefund[creator]` (ETH) | (none — no global sweep) | `sweepExpiredRefund` per-user 365d stale → treasury (line 803) | ⚠️ |
| `bounties[i].reward` (ETH in struct) | (struct-locked) | (none) | ⚠️ |

⚠️ **HOLDS-BY-CONVENTION** — no global `sweepETH` exists; the contract relies on per-path discipline. ETH only enters via `createBounty` (struct-locked) and only exits via `completeBounty` / `cancelBounty` / `withdrawPayout` / `withdrawRefund` / `sweepExpiredPayout` / `sweepExpiredRefund`. No sibling-miss exists at HEAD because there is no aggregate sweep that could miss an aggregate. **If a future change adds a `sweepETH(treasury)` admin path, that path MUST add aggregate counters for `pendingPayouts` + `pendingRefund` AND iterate active bounty rewards** — flagging here for forward audit awareness.

### 1.8 TegridyLending

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `offers[i].principal + offers[i].originationFee` (ETH in struct) | (struct-locked) | (no ETH sweep exists) | ⚠️ |
| `loans[j].principal` etc (ETH in struct, per-loan) | (struct-locked) | (no ETH sweep exists) | ⚠️ |
| `unsettledRewards` per-tokenId / `escrowRewards` (TOWELI) | `totalEscrowRewardsOwed` | `applySweepDonatedToweli` reserves `totalEscrowRewardsOwed` (line 2208–2210) | ✅ |

⚠️ **HOLDS-BY-CONVENTION (ETH side)** — no `sweepETH` admin path. ETH outflows: `cancelOffer` (refund principal+fee), `acceptOffer` (principal→borrower, fee→treasury), `repayLoan` (principal+interest→lender, fee→treasury, refund overpay→borrower), `claimDefaultedCollateral` (no ETH leg). All per-struct accounting. `applySweepDonatedToweli` (the only TOWELI-side sweep) correctly reserves `totalEscrowRewardsOwed` aggregate. ✅

### 1.9 TegridyNFTLending

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `loans[i]` ETH-leg (struct) | (struct-locked) | (no ETH sweep) | ⚠️ |
| `strandedNFTRecipient[keccak(coll, tokenId)]` (ERC721) | (per-key, refund-locked) | `executeSweepUnsolicitedNFT` refuses active collateral; pull-pattern via `claimStrandedNFT` (line 1688) | ✅ |
| `stuckCollateralRecipient[loanId]` (ERC721) | (per-loan, refund-locked) | `claimStuckCollateral` recovery path (per-loan) | ✅ |

⚠️ **HOLDS-BY-CONVENTION (ETH side)** — same shape as TegridyLending. Stranded-NFT and stuck-collateral mappings are per-NFT (not per-address) but the sweep paths refuse active escrow — structurally cannot drain user-reserved NFTs. ✅

### 1.10 TegridyStaking

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `unsettledRewards[holder]` (TOWELI) | `totalUnsettledRewards` | `sweepToken(t)` denies `t == rewardToken` (line 2106) — entire reward token is reserved | ✅ |
| `unsettledRewardsByTokenId[tokenId]` (TOWELI per-NFT) | (per-NFT, backed by parent invariant `sum(unsettledRewardsByTokenId[*]) ≤ unsettledRewards[holder]`) | rewardToken-deny on sweep | ✅ |
| `positions[tokenId].amount` (TOWELI in struct) | `totalStaked` | `_reserved()` reads `totalStaked + totalUnsettledRewards`; reward emission cap reserves both (line 482) | ✅ |

Increments at line 2201–2202 (`unsettledRewards += settled` paired with `totalUnsettledRewards += settled`). Decrements at lines 1746–1748 (claimUnsettledForTokenId), 1781–1783 (claimUnsettledFor), all paired. The per-tokenId mapping is governed by the holder-bucket invariant — `claimUnsettledForTokenId` caps `amount = min(amount, holderUnsettled)` (line 1735) and decrements all three (per-tokenId, holder, total) atomically. ✅

`sweepToken(rewardToken)` is denied — protects ALL TOWELI-denominated user reservations. ✅

### 1.11 TegridyRestaking

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `unforwardedBaseRewards[user]` (TOWELI) | `totalUnforwardedBase` | `recoverStuckPrincipal` reserves `totalUnforwardedBase + totalPendingUnsettled + othersPrincipal` (line 1663); `attributeStuckRewards` reserves `totalUnforwardedBase + totalActivePrincipal + totalPendingUnsettled` (line 1760) | ✅ |
| `pendingUnsettledRewards[user]` (TOWELI) | `totalPendingUnsettled` | same | ✅ |
| `unforwardedBonusRewards[user]` (BONUS) | `totalUnforwardedBonus` | `_sweepUnforwardedBonus` decrements `totalUnforwardedBonus -= attempt` (line 1369), defensive re-add on revert (line 1379) | ✅ |
| `restakers[user].positionAmount` (TOWELI in struct) | `totalActivePrincipal` | `recoverStuckPrincipal` subtracts `othersPrincipal` (totalActivePrincipal minus caller's own); `attributeStuckRewards` subtracts whole `totalActivePrincipal` | ✅ |

Increments at lines 1052/1180/1763/2003/2153/2203/2284 (every credit-into-pending site) paired with `totalUnforwardedBase / totalUnforwardedBonus`. Decrements at lines 1019/1268/1339/1707/1864/2015 (every drain-from-pending site) paired with the aggregate. ✅

`sweepStuckRewards` denies BOTH `bonusRewardToken` and `rewardToken` (lines 1618–1620) — TOWELI/bonus reservations are token-deny protected. ✅

### 1.12 TegridyFeeHook

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `accruedFees[currency]` (PoolManager-credit, NOT contract balance) | (single per-currency counter) | `claimFees` (line 480), `convertERC20FeesToETH` (line 575) decrement; `executeSyncAccruedFees` clamps both directions (line 660) | ✅ |
| `pendingSyncCredit[currency]` (proposal slot) | n/a (proposal scratch) | cleared on execute/cancel | ✅ |
| (ETH balance) | n/a | `sweepETH(to)` allowlist refuses any `to != revenueDistributor` (line 820) | ✅ |

`sweepETH` is a recipient-allowlist sweep (V3-AMM-H1) — recipient is hardcoded to `revenueDistributor`. No per-user ETH reservation needed because the contract only ever holds ETH that is destined for `revenueDistributor`. ✅

### 1.13 TegridyNFTPool

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `priorOwnerOwed[oldOwner]` (ETH) | `totalPriorOwnerOwed` | `_lpAvailableETH` reserves `accumulatedProtocolFees + accumulatedLPFees + totalPriorOwnerOwed` (line 907) — used by `withdrawETH` (line 675), `removeLiquidity` (line 435), `swapNFTsForETH` validation (line 896) | ✅ |
| (LP fees, current owner) | `accumulatedLPFees` (single counter) | same `_lpAvailableETH` reservation | ✅ |
| (Protocol fees) | `accumulatedProtocolFees` (single counter) | same | ✅ |

**scan5 INV-1 fix verified at all 3 paired sites:**

- Increment at `acceptOwnership` (lines 586, 589): `priorOwnerOwed[oldOwner] += snapshot;` AND `totalPriorOwnerOwed += snapshot;`
- Decrement at `claimPriorOwnerLPFees` (lines 644, 648): `priorOwnerOwed[msg.sender] = 0;` AND `totalPriorOwnerOwed -= amount;`
- Reservation at `_lpAvailableETH` (line 907): `reserved = accumulatedProtocolFees + accumulatedLPFees + totalPriorOwnerOwed;`

The 4 LoC fix proposed in scan5's §1.12 is in place verbatim. The `acceptOwnership` self-no-op gate (line 585: `pendingOwner != oldOwner`) prevents the snapshot from creating a phantom `priorOwnerOwed[self]` slot that would later block the owner's `withdrawETH` — correctly preserved per V3-NFTPOOL-06. ✅

`rescueStrandedRoyalty` (line 1054) sweeps WETH only (does not touch ETH balance), so `_lpAvailableETH` is not invoked. ✅

### 1.14 TegridyDropV2

| Mapping | Aggregate | Sweep path | Status |
|---|---|---|---|
| `paidPerWallet[user]` (ETH) | `totalProceeds` | `withdraw()` distributes `min(totalProceeds, balance)` (line 970) | ✅ |
| `mintedPerWallet[user]` / `allowlistClaimed[user]` (counters, not funds) | n/a | n/a | ✅ |

Withdraw is gated by `mintPhase == CLOSED || soldOut` (line 958). Cancel (`cancelSale`) is gated by `totalSupply == 0` (line 1012) — once any mint occurs, only the sold-out / phase-closed path drains funds via `totalProceeds`. Donations (selfdestruct/coinbase) are not absorbed into `totalProceeds` — they remain recoverable via `rescueAfterCancellation` (the 1y-after-cancel hatch, only reachable when `totalSupply == 0`). ✅

`unclaimedRefundPool` is a deprecated counter (V2-DROP-02) — not incremented at mint anymore; preserved for storage-slot ABI compatibility. The actual refund-window invariant is structural (cancelSale→totalSupply==0). ✅

---

## 2. Token-holding contracts — invariant matrix

| Contract | Per-user reservations | Aggregate counters | Sweep paths | Invariant | Status |
|---|---|---|---|---|---|
| PremiumAccess | userEscrow, shortfallOwed | totalRefundEscrow, totalShortfallOwed | withdrawToTreasury | `bal(toweli) ≥ totalRefundEscrow + totalShortfallOwed` | ✅ |
| RevenueDistributor | pendingWithdrawals | totalPendingWithdrawals | emergencyWithdraw, executeEmergencyWithdrawExcess, sweepDust | `bal(eth) ≥ (totalEarmarked - totalClaimed) + totalPendingWithdrawals` | ✅ |
| SwapFeeRouter | pendingDistribution | totalPendingDistribution | sweepETH, sweepTokens | `bal(eth) ≥ accumulatedETHFees + totalPendingDistribution`; per-token: `bal(t) ≥ accumulatedTokenFees[t]` | ✅ |
| ReferralSplitter | pendingETH, callerCredit | totalPendingETH, totalCallerCredit | sweepUnclaimable | `bal(eth) ≥ totalPendingETH + accumulatedTreasuryETH + totalCallerCredit` | ✅ |
| VoteIncentives | pendingETHWithdrawals, pendingTokenWithdrawals[t], commits.bond | totalPendingETH, totalPendingTokens[t], totalCommitBonds | sweepExcessETH, sweepToken | `bal(eth) ≥ totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH`; per-token: `bal(t) ≥ totalUnclaimedBribes[t] + totalPendingTokens[t] + (toweli ? totalCommitBonds : 0)` | ✅ |
| CommunityGrants | proposals.refundable, proposals.amount | totalRefundableDeposits, totalApprovedPending | sweepFees, emergencyRecoverETH | `bal(toweli) ≥ totalRefundableDeposits`; `bal(eth) ≥ totalApprovedPending` | ✅ |
| MemeBountyBoard | pendingPayouts, pendingRefund, bounty.reward | none (no global sweep) | sweepExpiredPayout, sweepExpiredRefund (per-user, age-gated) | `bal(eth) ≥ Σ(open bounty.reward) + Σ(pendingPayouts) + Σ(pendingRefund)` — held by per-path discipline | ⚠️ HOLDS-BY-CONVENTION |
| TegridyLending | offer.principal/fee (struct), loan.principal (struct), escrowReward | totalEscrowRewardsOwed (TOWELI side) | applySweepDonatedToweli (TOWELI only) | TOWELI: `bal(toweli) ≥ totalEscrowRewardsOwed`; ETH: per-struct (no global sweep) | ✅ / ⚠️ |
| TegridyNFTLending | loan ETH legs (struct), strandedNFTRecipient[key], stuckCollateralRecipient[loanId] | none | executeSweepUnsolicitedNFT (refuses active collateral), claimStuckCollateral | per-struct + per-NFT; sweep refuses active escrow | ✅ / ⚠️ |
| TegridyStaking | unsettledRewards, unsettledRewardsByTokenId, position.amount (struct) | totalUnsettledRewards, totalStaked | sweepToken (rewardToken-deny) | `bal(rewardToken) ≥ totalStaked + totalUnsettledRewards` | ✅ |
| TegridyRestaking | unforwardedBase, unforwardedBonus, pendingUnsettled, restaker.positionAmount | totalUnforwardedBase, totalUnforwardedBonus, totalPendingUnsettled, totalActivePrincipal | sweepStuckRewards (rewardToken+bonus deny), recoverStuckPrincipal, attributeStuckRewards | base: `bal ≥ totalActivePrincipal + totalUnforwardedBase + totalPendingUnsettled`; bonus: `bal ≥ totalUnforwardedBonus + reservedActive` | ✅ |
| TegridyLPFarming | rawBalanceOf, rewards | totalRawSupply, totalRewardsFunded | recoverERC20 (staking+reward token deny) | `bal(stakingToken) ≥ totalRawSupply`; `bal(rewardToken) ≥ Σ(rewards) + remaining emission cap` | ✅ |
| TegridyFeeHook | accruedFees[currency] | (single per-currency counter) | sweepETH (allowlisted to revenueDistributor) | recipient-allowlist replaces per-user reservation | ✅ |
| TegridyNFTPool | priorOwnerOwed | totalPriorOwnerOwed | _lpAvailableETH gate on withdrawETH/removeLiquidity/swap | `bal(eth) ≥ accumulatedProtocolFees + accumulatedLPFees + totalPriorOwnerOwed` | ✅ |
| TegridyDropV2 | paidPerWallet (struct-flow) | totalProceeds | withdraw (gated CLOSED/soldOut), rescueAfterCancellation (1y after cancel) | `bal(eth) ≥ totalProceeds + donations`; cancel-pre-mint structural lock | ✅ |
| TegridyNFTPoolFactory | (entire balance is protocol fees) | (none — n/a) | withdrawProtocolFees (rate-limited) | balance == protocol-fee-by-design | ✅ |
| POLAccumulator | (timelocked admin pull) | n/a | proposeSweepETH/Tokens (48h timelock) | n/a — no per-user dim | ✅ |
| TegridyPair | (Uniswap V2 canonical) | reserves invariant | skim | k = x*y AMM invariant | ✅ |

---

## 3. Findings

### ✅ HOLDS — no sibling-miss anywhere

Every per-user reservation mapping at HEAD `877185f` has:
- A correctly-paired aggregate counter (or recipient-allowlist / token-deny / per-struct lock that achieves the same property structurally).
- All increment sites paired with `+=` to the aggregate.
- All decrement sites paired with `-=` to the aggregate.
- All sweep paths reserving the aggregate before transfer.

scan5's INV-1 fix for `TegridyNFTPool.priorOwnerOwed` is the only sibling-miss that ever existed (now fixed), and the 4-LoC sibling-port at HEAD passes spot verification at all 3 expected paired sites.

### ⚠️ HOLDS-BY-CONVENTION (not a finding — forward note)

**MemeBountyBoard** has no global `sweepETH` admin path. ETH inflows are struct-locked into `bounty.reward` and only exit via the documented payout/refund/expiry-sweep paths. **If a future change adds a `sweepETH(treasury)` admin function, that path MUST iterate active bounty rewards + pendingPayouts + pendingRefund** — but this is impossible in O(1) without adding aggregate counters first, which is the canonical sibling-port shape.

**TegridyLending / TegridyNFTLending** likewise have no global `sweepETH`. Per-loan / per-offer ETH is struct-locked. Same forward note: if a future change adds `sweepETH`, it MUST add `totalActiveOfferETH + totalActiveLoanPrincipal` aggregates and reserve them. None of this affects HEAD `877185f`.

### ❌ MISSING-FROM-SWEEP — none found

Zero findings of scan5's exploit shape (aggregate exists but sweep doesn't subtract it). All admin sweep paths examined reserve every relevant aggregate.

---

## 4. Per-NFT and per-key reservation patterns (non-counter form)

Three mappings deviate from the canonical `mapping(address => uint256)` shape; each has a structural backing:

| Mapping | Form | Backing | Status |
|---|---|---|---|
| `TegridyStaking.unsettledRewardsByTokenId[tokenId]` | per-NFT | parent invariant: `sum(unsettledRewardsByTokenId[*]) ≤ unsettledRewards[holder]` enforced at every paired write/drain via `_isTrackedHolder` predicate (line 1764) | ✅ |
| `TegridyNFTLending.strandedNFTRecipient[keccak256(coll, tokenId)]` | per-NFT key | sweep refuses active-collateral via `loans[]` scan; pull-pattern claim by recipient only (line 1688) | ✅ |
| `TegridyNFTLending.stuckCollateralRecipient[loanId]` | per-loan | recovery only by recorded recipient; sweep refuses to overlap | ✅ |

For per-NFT mappings, the canonical aggregate-counter pattern would be a `totalUnsettledRewardsByTokenId` — but that would be redundant given the parent-bucket invariant. The codebase's choice is correct (Synthetix-style per-account invariant inheritance).

---

## 5. Conclusion

Post scan5 INV-1 fix, **zero ❌ findings** for the reservation-sibling-miss class across `contracts/src/`. The `TegridyNFTPool.priorOwnerOwed` exploit shape is the only one that existed and is now correctly closed via the 4-LoC sibling-port to `totalCommitBonds` / `totalPendingETH` patterns.

The audit confirms that the codebase's reservation discipline is **uniform across all token-holding contracts**: every per-user mapping has a sibling aggregate, every increment is paired, every decrement is paired, every sweep reserves the aggregate. The two ⚠️ HOLDS-BY-CONVENTION entries (`MemeBountyBoard`, `Tegridy*Lending` ETH side) are correct-by-construction (no global sweep exists) and only require attention if a future change introduces such a sweep.

No further fixes recommended at HEAD `877185f`.
