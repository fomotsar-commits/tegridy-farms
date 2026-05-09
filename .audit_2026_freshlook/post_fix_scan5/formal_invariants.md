# Formal Invariant Audit — HEAD `d5ca554`

**Date:** 2026-05-09
**Scope:** `contracts/src/**/*.sol`
**Approach:** enumerate every accumulator / share-system / escrow / pool / fee-split / bond pattern in `contracts/src/`, identify the canonical invariant it must satisfy, and verify the invariant holds via code-trace across every state-mutating path.

This is a **mathematical-property** audit, complementary to per-function adversarial-input audits. The unit of analysis is "what equation must always hold" rather than "what bad input can a function reject."

---

## Executive summary (5-line)

| Severity | Finding | File:line | Class |
|---|---|---|---|
| **HIGH (HOLDS-VIOLATED)** | `_lpAvailableETH` does not reserve `priorOwnerOwed[]`; new owner can drain prior-owner LP-fee escrow via `withdrawETH` / `removeLiquidity` / sells | `TegridyNFTPool.sol:884` | Solvency |
| INFO | All other 9 solvency invariants verified | (table below) | Solvency |
| INFO | All bond / escrow / emission / pause-cap / monotonicity / state-transition invariants verified | (tables below) | Multiple |

Single ❌ finding requires a fix to `_lpAvailableETH` + `_minLiquidityBuffer` — minimal-surface shape: add a single aggregate counter `totalPriorOwnerOwed` (or sum-mapping) and subtract it in `_lpAvailableETH`. ~6 LoC.

---

## Methodology

For each contract holding tokens or ETH, I enumerated every state-mutating path against three questions:

1. **Solvency:** does `contractBalance ≥ sum(outstanding obligations)` hold after the path mutates state?
2. **Conservation:** are all in-flows accounted for, and do all out-flows decrement an obligation?
3. **Reservation:** does every sweep / withdraw / recover function subtract every per-user / per-epoch reservation?

Aggregate counters are the canonical defense — every mapping-based pending-payout queue MUST have a sibling `totalXxx` counter that all sweep paths reserve against. The audit's main task was to confirm both (mapping has counter) AND (every sweep references the counter).

---

## 1. Solvency invariants — per contract

### 1.1 PremiumAccess (`PremiumAccess.sol`)

**Invariant:** `toweli.balanceOf(this) ≥ totalRefundEscrow + totalShortfallOwed`

| Path | Effect | Sweep reservation | Status |
|---|---|---|---|
| `subscribe` (new) | `+totalRefundEscrow += cost`; `+balance += cost` | n/a | ✅ |
| `subscribe` (extend) | clears old escrow, adds new (line 312–334) | n/a | ✅ |
| `cancelSubscription` | `-totalRefundEscrow -= escrowed`; `+totalShortfallOwed += shortfall` if balance-capped | n/a | ✅ |
| `claimShortfall` | `-totalShortfallOwed -= payout`; transfers TOWELI | reserves `totalRefundEscrow + (totalShortfallOwed - owed)` | ✅ |
| `reconcileExpired` / `batchReconcileExpired` | `-totalRefundEscrow -= escrow` (no transfer) | n/a | ✅ |
| `withdrawToTreasury` | transfers `balance - reserved` | reserves `totalRefundEscrow + totalShortfallOwed` (line 499) | ✅ |

✅ **HOLDS** — verified all 6 mutating paths. Reservation correctly includes both counters at the only sweep site.

---

### 1.2 RevenueDistributor (`RevenueDistributor.sol`)

**Invariant:** `address(this).balance ≥ (totalEarmarked - totalClaimed) + totalPendingWithdrawals + protocolDustPool`

The `protocolDustPool` is a subtle case: it's documented to be sweep-bound but the contract decrements `totalEarmarked` when routing dust to the pool, so it intentionally falls into the "sweepable surplus" — see comment at line 1322–1326. Below is per-path verification of the rest:

| Path | Effect | Sweep reservation | Status |
|---|---|---|---|
| `_distribute` | `+totalEarmarked += newETH`; `+totalDistributed += newETH`; `+epochs.push` | n/a | ✅ |
| `claim` / `claimUpTo` | direct: `+totalClaimed += totalOwed`; fallback: `+pendingWithdrawals += totalOwed`, `+totalPendingWithdrawals += totalOwed` | n/a | ✅ |
| `withdrawPending` | `-pendingWithdrawals -= amount`; `-totalPendingWithdrawals -= amount`; `+totalClaimed += amount` | n/a | ✅ |
| `executeClaimRecovery` | direct: `+totalClaimed += share`; fallback: same as `claim`. `+epochClaimed[epoch] += share` | n/a | ✅ |
| `emergencyWithdraw` | reserves `(totalEarmarked - totalClaimed) + totalPendingWithdrawals` (line 516) | ✅ | ✅ |
| `executeEmergencyWithdrawExcess` | reserves same (line 543–546) | ✅ | ✅ |
| `sweepDust` | reserves same (line 971–972) | ✅ | ✅ |
| `executeForfeitReclaim` | reserves additional gating: amount ≤ `reclaimEligibleAmount()` ≤ unclaimed dust whose 14d grace elapsed; lifetime cap (line 1212, 1234); per-epoch `pendingRecoveryCount` skip; `_consumeEligibleAndBumpClaimed` bumps `epochClaimed[i]` so future claims for those epochs see zero remaining | ✅ | ✅ |
| `autoReconcileDust` | `-totalEarmarked -= dust`; `+totalForfeited += dust`; `+protocolDustPool += dust` (line 1430–1437); halts at pending-recovery epochs (DEEP-DR-M-03) | n/a | ✅ |
| `reconcileRoundingDust` | requires `gap ≤ 1 ether`; sets `totalEarmarked = totalClaimed` | n/a | ✅ |
| `executeTokenSweep` | denies WETH (line 1024); sweeps non-WETH ERC20 to recipient | n/a (WETH-deny is the staker-pool reservation) | ✅ |

✅ **HOLDS** — verified across 11 mutating paths. The hardest case is the interplay between forfeit-reclaim (lifetime cap) + recovery (per-epoch in-flight count) + auto-dust (cursor-halt at pending-recovery), which compose correctly per code review.

---

### 1.3 SwapFeeRouter (`SwapFeeRouter.sol`)

**Invariant:** `address(this).balance ≥ accumulatedETHFees + totalPendingDistribution`

| Path | Effect | Sweep reservation | Status |
|---|---|---|---|
| token-fee path (`swapExactETHForTokens` etc.) | `+accumulatedETHFees += fee` | n/a | ✅ |
| `convertERC20FeesToETH` | converts on V2; adds to `accumulatedETHFees` | n/a | ✅ |
| `distribute` | direct: split to staker/POL/treasury via raw `.call`; fallback: `+pendingDistribution[recipient] += slice; +totalPendingDistribution += slice` | n/a | ✅ |
| `withdrawCallerCredit` (deferred dist pull) | `-pendingDistribution[recipient] -= amount`; `-totalPendingDistribution -= amount` | n/a | ✅ |
| `sweepETH` | reserves `accumulatedETHFees + totalPendingDistribution` (line 1420) | ✅ | ✅ |
| `sweepTokens` | reserves `accumulatedTokenFees[token]` per-token | ✅ | ✅ |

✅ **HOLDS** — verified across 6 mutating paths. The pull-pattern queue + aggregate counter pair is symmetric.

---

### 1.4 ReferralSplitter (`ReferralSplitter.sol`)

**Invariant:** `address(this).balance ≥ totalPendingETH + accumulatedTreasuryETH + totalCallerCredit`

| Path | Effect | Sweep reservation | Status |
|---|---|---|---|
| `recordFee` (qualified referrer) | `+pendingETH[ref] += share`; `+totalPendingETH += share`; `+callerCredit[caller] += remainder`; `+totalCallerCredit += remainder` | n/a | ✅ |
| `recordFee` (unqualified) | `+accumulatedTreasuryETH += share`; `+callerCredit[caller] += remainder`; `+totalCallerCredit += remainder` | n/a | ✅ |
| `recordFee` (banned referrer) | same as unqualified, V2-DR-M-03 skip ensures (line 405–407) | n/a | ✅ |
| `claimReferralRewards` | `-pendingETH[user] -= amount`; `-totalPendingETH -= amount` | banned check at line 456 | ✅ |
| `withdrawCallerCredit` | `-callerCredit[user] -= amount`; `-totalCallerCredit -= amount` | n/a | ✅ |
| `forfeitUnclaimedRewards` | `-totalPendingETH -= amount`; `+accumulatedTreasuryETH += amount` (no transfer; conserved) | n/a | ✅ |
| `withdrawTreasuryFees` | `-accumulatedTreasuryETH = 0`; transfers WETH-fallback | n/a | ✅ |
| `sweepUnclaimable` | reserves `totalPendingETH + accumulatedTreasuryETH + totalCallerCredit` (line 774) | ✅ | ✅ |

✅ **HOLDS** — verified across 8 mutating paths. All 3 reservation slots correctly summed at sweep.

---

### 1.5 VoteIncentives (`VoteIncentives.sol`)

**ETH invariant:** `address(this).balance ≥ totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH`
**Token invariant:** `IERC20(token).balanceOf(this) ≥ totalUnclaimedBribes[token] + totalPendingTokens[token] + (token == toweli ? totalCommitBonds : 0)`
**Bond invariant:** every commit posts `COMMIT_BOND` to `totalCommitBonds`; exactly one of {revealed (refund), forfeitedOnDisabledPair (refund), sweepForfeitedBond (forfeit)} per commit-slot.

| Path | Effect | Sweep reservation | Status |
|---|---|---|---|
| `depositBribe` | `+epochBribes[e][p][t] += net`; `+totalUnclaimedBribes[t] += net`; treasury fee → `accumulatedTreasuryETH/Tokens` | n/a | ✅ |
| `depositBribeETH` | similar with `totalUnclaimedETHBribes` | n/a | ✅ |
| `claimBribes` | `-totalUnclaimedBribes/-ETHBribes -= share`; direct: pays out; fallback: `+totalPendingETH/Tokens += share` | n/a | ✅ |
| `claimAllBribesForEpoch` | similar | n/a | ✅ |
| `withdrawPendingETH/Tokens` | `-totalPendingETH/Tokens -= amount`; transfers | n/a | ✅ |
| `withdrawTreasuryETH/Tokens` | `-accumulatedTreasuryETH/Tokens -= amount`; transfers | n/a | ✅ |
| `commitVote` | `+totalCommitBonds += COMMIT_BOND`; `+committedPower[user][epoch] += power`; pushes `CommitInfo` | n/a | ✅ |
| `revealVote` | `c.revealed = true`; `c.bond = 0`; `-totalCommitBonds -= bond`; refunds bond | n/a | ✅ |
| `forfeitCommitOnDisabledPair` | `c.revealed = true`; `c.bond = 0`; `-totalCommitBonds -= bond`; refunds bond; `-committedPower -= power` | n/a | ✅ |
| `sweepForfeitedBond` | `c.bond = 0`; `-totalCommitBonds -= bond`; bond → treasury | n/a | ✅ |
| `sweepExcessETH` | reserves all 3 ETH counters (line 1380) | ✅ | ✅ |
| `sweepToken` | reserves `totalUnclaimedBribes[t] + totalPendingTokens[t] + (toweli ? totalCommitBonds : 0)` (line 1392–1396) | ✅ | ✅ |

✅ **HOLDS** — bond invariant: each commit reaches exactly one terminal state. `c.bond = 0` is the idempotency flag (sweep refuses on `BondAlreadyClaimed`); `c.revealed = true` blocks reveal/forfeit replay. Solvency: every counter referenced at every sweep site.

---

### 1.6 CommunityGrants (`CommunityGrants.sol`)

**TOWELI invariant:** `toweli.balanceOf(this) ≥ totalRefundableDeposits`
**ETH invariant:** `address(this).balance ≥ totalApprovedPending`

| Path | Effect | Sweep reservation | Status |
|---|---|---|---|
| `submitProposal` | `+totalRefundableDeposits += refundable` (line 307); transfers PROPOSAL_FEE in | n/a | ✅ |
| `finalizeApproved` | `+totalApprovedPending += amount`; `-totalRefundableDeposits -= refundable` if revert; carry-over `totalApprovedPending` only if balance covers (line 494–514) | n/a | ✅ |
| `executeProposal` | `-totalApprovedPending -= amount`; `-totalRefundableDeposits -= refundable`; transfers ETH out | n/a | ✅ |
| `lapseProposal` / `cancelProposal` / `cancelApprovedProposal` | `-totalApprovedPending -= amount`; `-totalRefundableDeposits -= refundable`; refunds (path-specific) | n/a | ✅ |
| `forfeitProposalFee` | `-totalRefundableDeposits -= forfeit` (consumes deposit) | n/a | ✅ |
| `sweepFees` | reserves `totalRefundableDeposits` (line 896) | ✅ | ✅ |
| `emergencyRecoverETH` | reserves `totalApprovedPending` (line 909) | ✅ | ✅ |
| `executeFeeReceiverChange` (dry-run) | reads `balance - totalRefundableDeposits` (line 955) | ✅ | ✅ |

✅ **HOLDS** — verified across 8 mutating paths. Both invariants satisfied.

---

### 1.7 MemeBountyBoard (`MemeBountyBoard.sol`)

**Invariant:** `address(this).balance ≥ sum(bounty.reward where status==Open) + sum(pendingPayouts) + sum(pendingRefund)`

This contract has **no aggregate counters** — invariant holds by construction:
- ETH only enters via `createBounty` (locks reward in struct).
- ETH only exits via `completeBounty` (sends reward), `cancelBounty/forceCancelBounty` (refunds), `withdrawPayout` (pull pattern), `withdrawRefund` (pull pattern), `sweepExpiredPayout/sweepExpiredRefund` (1y/365d expiry sweeps).
- There is **no global `sweepETH` admin function**; arbitrary excess ETH cannot be swept.

| Path | Effect | Status |
|---|---|---|
| `createBounty` | locks `msg.value` as `bounty.reward`, status=Open | ✅ |
| `completeBounty` | direct: pays reward; fallback: `+pendingPayouts[winner] += reward` | ✅ |
| `cancelBounty/forceCancelBounty` | direct: refunds reward; fallback: `+pendingRefund[creator] += reward` | ✅ |
| `withdrawPayout` | `-pendingPayouts[user] = 0`; transfers | ✅ |
| `withdrawRefund` | `-pendingRefund[user] = 0`; transfers | ✅ |
| `sweepExpiredPayout` | 1y stale → treasury; `-pendingPayouts[user] = 0` | ✅ |
| `sweepExpiredRefund` | 365d stale → treasury; `-pendingRefund[user] = 0` | ✅ |

⚠️ **HOLDS-BY-CONVENTION** — the absence of an aggregate counter or sweep means the invariant cannot be empirically checked at admin time. If a future change adds a `sweepETH` function, that path MUST sum bounty rewards + pending payouts + pending refunds. Today the invariant holds by the per-path discipline above.

---

### 1.8 TegridyLending (`TegridyLending.sol`) / TegridyNFTLending (`TegridyNFTLending.sol`)

**Invariant (ETH):** `address(this).balance ≥ sum(offers[i].principal + offers[i].originationFee where offers[i].active) + sum(loans[j].principal where !loans[j].repaid && !loans[j].defaultClaimed && lender-leg-pending)`

Per-loan accounting is per-struct; no aggregate counter.

| Path | Effect | Status |
|---|---|---|
| `createOffer` | locks `msg.value` into offer struct (effectivePrincipal + originationFee) | ✅ |
| `cancelOffer` | refunds `offer.principal + offer.originationFee` | ✅ |
| `acceptOffer` | sends `principal` to borrower, `originationFee` to treasury | ✅ |
| `repayLoan` | borrower sends `principal + interest` (msg.value); paid out to lender, treasury fee, overpayment refund | ✅ |
| `claimDefaultedCollateral` | sends NFT to lender (no ETH leg) | ✅ |
| `applySweepDonatedToweli` | reserves `totalEscrowRewardsOwed` (TOWELI-side; line 2208–2210) | ✅ |
| `sweepUnsolicitedNFT` | refuses NFTs in active escrow (line 2284–2298) | ✅ |

⚠️ **HOLDS-BY-CONVENTION** — no `sweepETH` exists, so no aggregate-reservation enforcement is needed. Invariant holds by the per-path discipline. The TOWELI-side `totalEscrowRewardsOwed` counter is the explicit aggregate for the per-tokenId reward bucket.

---

### 1.9 TegridyStaking (`TegridyStaking.sol`)

**Invariant (rewards):** `rewardToken.balanceOf(this) ≥ totalStaked + totalUnsettledRewards`
**Emission cap:** `cumulativeEmitted ≤ rewardRate × elapsed`

| Path | Effect | Reservation | Status |
|---|---|---|---|
| `stake / stakeWithBoost` | `+totalStaked += amount`; pulls TOWELI in | n/a | ✅ |
| `withdraw / earlyWithdraw` | `-totalStaked -= amount`; sends TOWELI out | n/a | ✅ |
| `getReward` | sends pending rewards; capped by `available - reserved` (line 686 in `_accumulateRewards`) | reserves `totalStaked + totalUnsettledRewards` (`_reserved` at line 481) | ✅ |
| `notifyRewardAmount` | adds to `totalRewardsFunded`; pulls TOWELI in | n/a | ✅ |
| `_accumulateRewards` | caps `reward = elapsed * rewardRate` to available pool (line 687); skips while paused | `_reserved` | ✅ |
| `claimUnsettledForTokenId` | per-tokenId pull from `unsettledRewardsByTokenId` (via lending escrow path) | reserves correctly via the Synthetix-pattern `(boostedAmount * acc / 1e18) - rewardDebt` math | ✅ |
| `sweepToken(tok)` | refuses `tok == rewardToken` (line 2106); transfers other balance | rewardToken-deny | ✅ |

✅ **HOLDS** — Synthetix-pattern emission cap is the canonical anchor. The pause-aware accumulator (line 678–699) crystallises pre-pause emission and freezes the window during pause. `_accumulateRewards`'s `available - reserved` clamp prevents over-emission below the reward-pool floor.

---

### 1.10 TegridyRestaking (`TegridyRestaking.sol`)

**Invariant (base):** `rewardToken.balanceOf(this) ≥ totalActivePrincipal + totalUnforwardedBase + totalPendingUnsettled`
**Invariant (bonus):** `bonusRewardToken.balanceOf(this) ≥ totalUnforwardedBonus + reservedBonusForActiveRestakers`

| Path | Effect | Reservation | Status |
|---|---|---|---|
| `restake` | `+totalActivePrincipal += positionAmount` | n/a | ✅ |
| `unrestake` | `-totalActivePrincipal -= positionAmount`; sweeps `unforwardedBaseRewards` | n/a | ✅ |
| `claimAll` | `+unforwardedBaseRewards / +unforwardedBonusRewards` if direct fails | counters incremented (`+totalUnforwardedBase / Bonus`) | ✅ |
| `_sweepUnforwardedBonus` | `-totalUnforwardedBonus -= attempt`; defensive re-add on revert (line 1379) | n/a | ✅ |
| `recoverStuckPrincipal` | reserves `totalUnforwardedBase + totalPendingUnsettled + othersPrincipal` (line 1663) | ✅ | ✅ |
| `attributeStuckRewards` | reserves `totalUnforwardedBase + totalActivePrincipal` (line 1336) | ✅ | ✅ |
| `sweepStuckRewards` | refuses `bonusRewardToken` and `rewardToken` (lines 1618–1620); routes others to `address(staking)` | both reward-token-denies | ✅ |

✅ **HOLDS** — verified across 7 mutating paths. The two-token reservation (base + bonus) is correctly factored.

---

### 1.11 TegridyFeeHook (`TegridyFeeHook.sol`)

**Invariant:** `accruedFees[currency]` tracks PoolManager-side ERC6909 credit; `address(this).balance` flows to `revenueDistributor` via the allowlisted `sweepETH`.

| Path | Effect | Status |
|---|---|---|
| `afterSwap` | `+accruedFees[creditToken] += feeUint` | ✅ |
| `claimFees` | `-accruedFees[currency] -= amount`; pulls from PoolManager | ✅ |
| `convertERC20FeesToETH` | `-accruedFees[currency] -= amount`; swaps via V2 router; receives ETH; `+balance` | ✅ |
| `executeSyncAccruedFees` | downward: clamps to actualCredit; upward: bound by propose-time PoolManager snapshot AND ≤ +10% per step (line 660) | ✅ |
| `sweepETH(to)` | refuses `to != revenueDistributor` (line 820); transfers full ETH balance via WETH fallback | ✅ |

✅ **HOLDS** — V3-AMM-H1 narrows the sweep allowlist to `revenueDistributor` only; H-5 + R014 caps the upward sync.

---

### 1.12 TegridyNFTPool (`TegridyNFTPool.sol`) ❌ **VIOLATION**

**Stated invariant:** `_lpAvailableETH = balance - (accumulatedProtocolFees + accumulatedLPFees)`

**Actual invariant required:** `_lpAvailableETH = balance - (accumulatedProtocolFees + accumulatedLPFees + sum(priorOwnerOwed))`

**Mutator that breaks the invariant:** `acceptOwnership` (line 568–584) snapshots `accumulatedLPFees → priorOwnerOwed[oldOwner]` and zeroes `accumulatedLPFees`. After this, the prior-owner ETH escrow is no longer reserved by `_lpAvailableETH`.

#### Exploit walkthrough

**Setup:**
- Pool has `accumulatedLPFees = 10 ETH` (Bob, the current owner, has earned this from LP fees).
- Pool balance = 100 ETH (total).
- Bob proposes Mallory as new owner, waits 48h, Mallory calls `acceptOwnership()`.

**Step 1 — `acceptOwnership` snapshot:**
- `priorOwnerOwed[Bob] += 10`
- `accumulatedLPFees = 0`
- `owner = Mallory`

**Step 2 — Mallory drains via `withdrawETH`:**
- `_lpAvailableETH = 100 - (accProtoFees + 0) ≈ 100 - protoFees` (line 884–889)
- `_minLiquidityBuffer` only depends on `spotPrice` (line 904–919), unchanged
- Mallory calls `withdrawETH(amount)` where `amount ≤ 100 - protoFees - minBuffer`
- Pool balance drops below 10 ETH

**Step 3 — Bob's claim reverts:**
- Bob calls `claimPriorOwnerLPFees()` (line 629–635)
- `_sendETH(Bob, 10)` → `WETHFallbackLib.safeTransferETHOrWrap`
- Direct call leg: insufficient balance → fails
- WETH wrap leg: `IWETH(weth).deposit{value: 10}()` → fails (insufficient balance)
- `WETHTransferFailed` reverts → Bob is **permanently unable to claim**

**Sibling exploits via swap and `removeLiquidity`:**
- `swapNFTsForETH`'s `_validateSellLiquidity` uses `_lpAvailableETH` (line 880–881) — also doesn't reserve `priorOwnerOwed`. Active swap volume after a transfer can drain prior-owner escrow.
- `removeLiquidity` uses the same `_lpAvailableETH + _minLiquidityBuffer` gate (line 426–428).

#### Why this matters

- **Trigger:** every ownership transition with non-zero `accumulatedLPFees` opens this rug.
- **Likelihood:** ownership transitions are timelocked but legitimate (ownership-transfer market exists for Sudoswap-style pools). A new owner who is unaware of this bug — or actively malicious — will silently drain the prior owner.
- **Severity:** prior owner loses their entire `priorOwnerOwed` slot. Capped only by the pool's ETH balance at transfer time (which is exactly what was supposed to be reserved).

#### Minimal-surface fix

Add a single aggregate counter `totalPriorOwnerOwed` (mirroring `totalCommitBonds`, `totalPendingETH`, `totalUnclaimedETHBribes` patterns elsewhere in the codebase) and reserve it in `_lpAvailableETH`:

```solidity
// State (1 LoC)
uint256 public totalPriorOwnerOwed;

// In acceptOwnership snapshot (line 577–578), add (1 LoC):
priorOwnerOwed[oldOwner] += snapshot;
accumulatedLPFees = 0;
totalPriorOwnerOwed += snapshot;       // NEW

// In claimPriorOwnerLPFees (line 632–633), add (1 LoC):
priorOwnerOwed[msg.sender] = 0;
totalPriorOwnerOwed -= amount;          // NEW
_sendETH(msg.sender, amount);

// In _lpAvailableETH (line 884–889), update reservation (1 LoC):
function _lpAvailableETH() internal view returns (uint256) {
    uint256 bal = address(this).balance;
    uint256 reserved = accumulatedProtocolFees + accumulatedLPFees + totalPriorOwnerOwed;  // NEW
    if (bal <= reserved) return 0;
    return bal - reserved;
}
```

Net delta: **+4 LoC**. Sibling-port from `VoteIncentives.totalCommitBonds` / `ReferralSplitter.totalPendingETH` / `SwapFeeRouter.totalPendingDistribution` patterns — every other pull-pattern queue in this repo has the same shape.

---

## 2. Conservation invariants

For each contract holding an ERC721 NFT:

| Contract | Conservation form | Status |
|---|---|---|
| `TegridyLending` | `sum(offers held collateral NFTs in escrow) == sum(loans where !repaid && !defaultClaimed)` | ✅ — `acceptOffer` registers, `repayLoan/claimDefaultedCollateral` releases. `sweepUnsolicitedNFT` refuses active-escrow NFTs (line 2284–2298). |
| `TegridyNFTLending` | same shape | ✅ — same enforcement |
| `TegridyNFTPool` | `_heldIds` set membership matches actual `nftCollection.ownerOf == address(this)` | ⚠️ HOLDS-BY-CONVENTION — `syncNFTs` (line 694–704) is the reconciliation hatch for unsolicited NFT inflows. Pool clones can drift if NFTs are transferred-in directly without `onERC721Received` setting `_heldIds`. The `_swapInFlight` gate in `onERC721Received` prevents most cases; `syncNFTs` covers the rest. |
| `TegridyStaking` | `sum(positions[i].amount) == totalStaked` | ✅ — incremented on stake/extend, decremented on withdraw/earlyWithdraw paths |
| `TegridyRestaking` | `sum(restakers[u].positionAmount where active) == totalActivePrincipal` | ✅ — incremented on restake, decremented on unrestake/emergencyWithdrawNFT |

---

## 3. Share-supply invariants

| Contract | Invariant | Status |
|---|---|---|
| `TegridyStaking` (Solady ERC721) | OZ/Solady-canonical: `totalSupply() == sum(balanceOf(u))` | ✅ — Solady ERC721 is a canonical implementation, no overrides change this |
| `Toweli` | OZ ERC20 + Permit canonical | ✅ — no custom mint/burn override |
| `TegridyDropV2` | clone tokens use OZ ERC20 standard | ✅ |

---

## 4. Emission caps

**Synthetix StakingRewards anchor:** `cumulativeEmitted ≤ rewardRate × elapsed`

| Contract | Pause-aware? | Pool-bound? | Status |
|---|---|---|---|
| `TegridyStaking` | ✅ DS2-04 (line 678–699) | ✅ `available - reserved` clamp (line 685–690) | ✅ |
| `TegridyRestaking` | ✅ pauseAware | ✅ pool-bound on bonus side via available-balance clamp | ✅ |
| `TegridyLPFarming` | ✅ same pattern | ✅ same | ✅ |

---

## 5. Reservation invariants

Every sweep / withdraw / recover function MUST subtract every per-user / per-epoch reservation. Detailed table in §1 above. Summary:

| Contract / function | Reserves all expected counters? |
|---|---|
| `PremiumAccess.withdrawToTreasury` | ✅ (refundEscrow + shortfallOwed) |
| `RevenueDistributor.sweepDust / executeEmergencyWithdrawExcess / emergencyWithdraw` | ✅ (unclaimed + pending) |
| `RevenueDistributor.executeForfeitReclaim` | ✅ (bounded by reclaimEligibleAmount + lifetime cap) |
| `RevenueDistributor.executeTokenSweep` | ✅ (WETH-deny) |
| `SwapFeeRouter.sweepETH / sweepTokens` | ✅ |
| `ReferralSplitter.sweepUnclaimable` | ✅ (3 counters) |
| `VoteIncentives.sweepExcessETH / sweepToken` | ✅ (incl. `totalCommitBonds` for TOWELI) |
| `CommunityGrants.sweepFees / emergencyRecoverETH` | ✅ |
| `MemeBountyBoard` | n/a (no global sweep) |
| `TegridyLending / TegridyNFTLending` | n/a (no global ETH sweep) |
| `TegridyLending.applySweepDonatedToweli` | ✅ (totalEscrowRewardsOwed) |
| `TegridyStaking.sweepToken` | ✅ (rewardToken-deny) |
| `TegridyRestaking.sweepStuckRewards` | ✅ (rewardToken-deny + bonusRewardToken-deny) |
| `TegridyNFTPool.withdrawETH / removeLiquidity` | ❌ **MISSING `priorOwnerOwed`** (see §1.12) |
| `TegridyNFTPool.rescueStrandedRoyalty` | ✅ (only sweeps WETH balance, doesn't touch ETH balance) |
| `TegridyNFTPoolFactory.withdrawProtocolFees` | ✅ (rate-limited; entire balance is protocol fees by design) |
| `POLAccumulator.executeSweepETH` | ✅ (timelocked; no per-user reservation needed) |
| `TegridyFeeHook.sweepETH` | ✅ (allowlisted recipient = revenueDistributor) |

---

## 6. Time / epoch monotonicity

| Contract | Pattern | Status |
|---|---|---|
| `RevenueDistributor.epochs[i].timestamp` | `_distribute` writes `block.timestamp - 1`; lastDistributeTime gates next call | ✅ — strictly increasing within a single tx; protected by MIN_DISTRIBUTE_INTERVAL |
| `TegridyStaking._totalBoostedStakeCheckpoints` | OZ Checkpoints.Trace208; key = `block.timestamp`; library refuses non-monotonic writes | ✅ |
| `TegridyStaking._checkpoints[user]` | same | ✅ |
| `TegridyLending.pauseHistory` | append-only on `_unpause`; only when `block.timestamp > start` | ✅ — strictly later episodes |
| `TegridyNFTLending.pauseHistory` | same | ✅ |
| `*.lastUpdateTime` | always advances to `block.timestamp` (never backwards) | ✅ |

---

## 7. State-transition invariants

For every status enum, allowed transitions must be enforced.

### CommunityGrants `Proposal.status`: Active → Approved/Rejected → Executed/Cancelled/FailedExecution

- `vote` requires `status == Active` (deadline check)
- `finalizeApproved` transitions Active → Approved (line ~514)
- `finalizeRejected` transitions Active → Rejected
- `executeProposal` transitions Approved → Executed (line ~597)
- `cancelProposal/cancelApprovedProposal` transitions either → Cancelled
- `lapseProposal` transitions Approved (with stale review window) → Cancelled
- `retryExecution` only on FailedExecution

✅ — every transition has an explicit `proposal.status == X` precondition before mutation. No path mutates from terminal states (Executed/Cancelled).

### MemeBountyBoard `Bounty.status`: Open → Completed/Cancelled

- `submitWork`, `voteOnSubmission` require `status == Open`
- `completeBounty` transitions Open → Completed (line ~575)
- `cancelBounty/forceCancelBounty` transitions Open → Cancelled

✅ — terminal states blocked correctly.

### TegridyLending Loan: not-repaid && not-defaultClaimed → repaid XOR defaultClaimed

- Two separate flags (no enum); checked at every entry of repayLoan and claimDefaultedCollateral via `if (loan.repaid) revert; if (loan.defaultClaimed) revert`

✅ — exactly one terminal flag is set per loan; both `repaid && defaultClaimed` is impossible.

### VoteIncentives CommitInfo: not-revealed && bond>0 → (revealed XOR bond=0 via sweep)

✅ — see §1.5 bond invariant.

---

## 8. Cross-contract reflective invariants

### `staking.totalSupply / votingPowerOf`

| Consumer | Reads | Status |
|---|---|---|
| `RevenueDistributor._calculateClaim` | `votingPowerAtTimestamp(user, T-1)` + restaking fallback (additive, line 868) | ✅ — multi-source holders correctly summed |
| `VoteIncentives.commitVote` | `VotePowerOracle.powerAt + powerOf` (additive) | ✅ |
| `CommunityGrants.vote` | `VotePowerOracle.powerAt` | ✅ |
| `MemeBountyBoard.voteOnSubmission` | `VotePowerOracle.powerAt` | ✅ |
| `ReferralSplitter.recordFee/markBelowStake/forfeitUnclaimedRewards` | `stakingContract.votingPowerOf + restakingContract.votingPowerOf` (additive) | ✅ |

✅ — every consumer either uses the additive `VotePowerOracle.powerAt` helper OR explicitly adds the restaking-side voting power. No silent dropouts of restakers' power. RestakingContract is GOV-ECON-01 / C10 compliant across all 5 governance consumers.

### `TegridyStaking.lendingEscrowedAmount`

`isLendingContract[lender]` exempts the lending-escrow holder from transfer cooldowns (line 1366). The reflective check is: `staking.balanceOf(lendingContract) ≥ sum(loans[i].tokenId where lending currently holds collateral)`.

✅ — `LD-NEW-H2` post-condition check (lending-side line 1175) verifies the escrow transfer succeeded; staking-side EnumerableSet maintains the membership.

---

## 9. Pause-cap monotonicity

`_cumulativePausedInWindow` (TegridyLending and TegridyNFTLending):

- `pauseHistory` is append-only, written only in `_unpause` when `block.timestamp > pauseStartTime`
- Each push has `startedAt = old pauseStartTime`, `endedAt = block.timestamp` — both strictly later than the previous episode (because pause→unpause→pause→unpause is the only way to add entries)
- `_cumulativePausedInWindow` correctly intersects each episode with the rolling 30-day window

✅ — verified for both contracts.

---

## 10. Bond escrow (VoteIncentives commit-reveal)

Already covered in §1.5 — every commit posts `COMMIT_BOND`; exactly one of {revealVote (refund), forfeitCommitOnDisabledPair (refund), sweepForfeitedBond (forfeit)} per commit-slot. `c.bond = 0` is the idempotency anchor; `c.revealed = true` blocks reveal/forfeit replay.

✅ — bond invariant: `totalCommitBonds == sum(c.bond where !c.revealed && c.bond > 0)` holds across all 4 mutating paths (commit/reveal/forfeit-disabled/sweep).

---

## Summary

**❌ Violated invariants:** 1
**⚠️ Holds-by-convention:** 3 (MemeBountyBoard global ETH, Lending/NFTLending global ETH, TegridyNFTPool conservation via `syncNFTs`)
**✅ Holds:** all other ~40 enumerated invariants across 12 contracts, 60+ mutating paths

### The single ❌

`TegridyNFTPool._lpAvailableETH` (line 884–889) does not reserve `priorOwnerOwed[]`. Every ownership transition with non-zero `accumulatedLPFees` opens a permanent rug of the prior owner's LP-fee escrow. Fix: +4 LoC adding `totalPriorOwnerOwed` aggregate and including it in the `_lpAvailableETH` reservation. Sibling-port from the `totalCommitBonds` / `totalPendingETH` patterns elsewhere in the repo.

This finding is the formal-invariant analog to a sweep-reservation bug. It does not require malicious input — only a legitimate ownership transition followed by a routine `withdrawETH` call.
