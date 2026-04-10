# Tegriddy Farms — 40-Agent Security Audit Report

**Date:** 2026-03-29
**Auditor:** Claude Opus 4.6 (40 parallel agents)
**Scope:** All 13 Solidity contracts, test suites, deploy scripts, foundry config, frontend hooks
**Agents Completed:** 40 of 40

---

## Executive Summary

The Tegriddy Farms protocol has undergone multiple prior audit rounds, as evidenced by extensive inline fix annotations. The codebase demonstrates strong defensive patterns (ReentrancyGuard, Ownable2Step, timelocks, SafeERC20, CEI pattern). However, **significant issues remain** across contract logic, cross-contract integration, deployment scripts, test coverage, and frontend hooks.

### Finding Totals (All Layers)

| Severity | Count |
|----------|-------|
| **Critical** | 0 |
| **High** | 15 |
| **Medium** | 83 |
| **Low** | 95 |
| **Info** | 49 |

### Test Coverage Crisis

| Metric | Value |
|--------|-------|
| **Missing test cases** | 200+ |
| **Untested public functions** | ~50% across community/bounty/referral/revenue contracts |
| **False-assurance tests** | 8+ (tests that pass but don't validate correctness) |
| **Missing invariants** | 12+ critical invariants with zero coverage |

---

## HIGH Severity Findings

### H-01: Balance-Delta Reward Accounting Vulnerable to MEV (TegridyRestaking)
**Location:** `TegridyRestaking.sol` — `claimAll()` lines 348-358
**Description:** When `claimAll()` calls `staking.claim(info.tokenId)`, rewards are sent to the restaking contract. The contract measures the difference via `balanceOf(this) - baseBefore`. If another transaction in the same block sends rewardToken to the contract (e.g., another user's revalidateBoost triggers _claimRewards for a different position), the balance delta is inflated. Cross-user reward theft via MEV sandwich.
**Fix:** Track expected reward amounts explicitly rather than relying on balance deltas, or have the staking contract return the claimed amount.

### H-02: JBAC Boost Always Stripped From Restaked Positions (TegridyRestaking)
**Location:** `TegridyRestaking.sol` — `revalidateBoostForRestaked()` line 754
**Description:** `TegridyStaking.revalidateBoost()` checks `jbacNFT.balanceOf(ownerOf(tokenId))`. When restaked, the owner is the restaking contract, not the user. Calling revalidateBoost always strips JBAC bonus from restaked positions, regardless of the user's actual holdings.
**Fix:** Staking contract should check JBAC balance of the original depositor, not the NFT's current owner.

### H-03: `reconcileRoundingDust()` Can Steal Unclaimed ETH (RevenueDistributor)
**Location:** `RevenueDistributor.sol` lines 808-818
**Description:** Owner can zero out the gap between `totalEarmarked` and `totalClaimed` when gap <= 0.1 ETH. If registered users have unclaimed epochs totaling <= 0.1 ETH, the owner can mark their entitlements as "dust" and sweep them. The 0.1 ETH threshold (raised from 0.01 ETH) widens this attack surface.
**Fix:** Only allow when `totalRegisteredLocked == 0`, or require all registered users have `lastClaimedEpoch == epochs.length`.

### H-04: Proposer Self-Recipient Enables Fee-Subsidized ETH Extraction (CommunityGrants)
**Location:** `CommunityGrants.sol` lines 127-168
**Description:** No restriction preventing proposer from being the recipient. Combined with 50% fee refund on rejection, a wealthy attacker with majority voting power can systematically drain the treasury.
**Fix:** Add cooldown between proposals from same proposer, or require recipient != proposer.

### H-05: `retryPayout` and `rescueFailedPayout` Are Dead Code (MemeBountyBoard)
**Location:** `MemeBountyBoard.sol` lines 314-374
**Description:** `BountyStatus.FailedPayout` is never set anywhere. Both functions are unreachable dead code.
**Fix:** Remove dead code or reintroduce a code path that sets FailedPayout.

### H-06: `withdrawRefund` Has No WETH Fallback — Funds Permanently Stuck (MemeBountyBoard)
**Location:** `MemeBountyBoard.sol` lines 405-411
**Description:** `withdrawPayout` correctly falls back to WETH, but `withdrawRefund` simply reverts with `ETHTransferFailed()`. Creator refunds can be permanently locked.
**Fix:** Add same WETH fallback pattern used in `withdrawPayout`.

### H-07: Deploy Script Missing Ownership Transfer to Multisig (DeployFinal.s.sol)
**Location:** `DeployFinal.s.sol` lines 19-57
**Description:** All four contracts remain owned by deployer EOA after deployment. No in-script ownership transfer. Creates a window where compromised deployer key can rug every contract.
**Fix:** Move ownership transfers inside `vm.startBroadcast()` block, atomic with deployment.

### H-08: Stale Registration Persists for Restaked Positions — Revenue Dilution (Cross-Contract)
**Location:** `RevenueDistributor.sol` `_isRestaked()` + `pokeRegistration()`, `TegridyRestaking.sol`
**Description:** When a user restakes, `_isRestaked()` returns true, causing `pokeRegistration()` to silently return without updating `registeredLockAmount`. If the underlying position decreases (early withdrawal, penalty), the stale inflated registration dilutes all other registered users' epoch shares indefinitely.
**Fix:** `_isRestaked()` check should also compare `positionAmount` from restaking against `registeredLockAmount` and allow poke-down when actual position is smaller.

---

## Top 20 MEDIUM Severity Findings

### M-01: SwapFeeRouter Routes Through Uniswap, Not TegridyRouter (Deploy Script)
`SwapFeeRouter` is constructed with Uniswap V2 Router address, bypassing `TegridyFactory` pairs entirely. Fundamental architectural concern.

### M-02: Fee-on-Transfer Token Accounting Mismatch (SwapFeeRouter)
`withdrawTokenFees` doesn't use balance-before/after pattern. Fee-on-transfer tokens cause permanent accounting drift.

### M-03: `adjustedMin` Overflow Sets `type(uint256).max` Causing Guaranteed Revert (SwapFeeRouter)
Large `amountOutMin` values silently convert valid swaps to unconditional reverts.

### M-04: `removeLiquidity` Missing `to != pair` Validation (TegridyRouter)
Burning LP tokens with `to == pair` donates them to remaining LPs. The check exists on `addLiquidity` but not `removeLiquidity`.

### M-05: Fee-on-Transfer ETH Swap Drains Entire Router WETH Balance (TegridyRouter)
`swapExactTokensForETHSupportingFeeOnTransferTokens` reads entire WETH balance, not just the swap output.

### M-06: Unsettled Rewards Inflation on Insufficient Pool (TegridyStaking)
NFT transfers store uncapped `pending` in `unsettledRewards` when pool is underfunded, potentially starving active stakers.

### M-07: Inconsistent Reservation Logic Between `claimUnsettled()` and `claimUnsettledFor()` (TegridyStaking)
Different formulas for `otherReserved` create asymmetric payout behavior.

### M-08: Emergency Exits Don't Update `lastRewardTime` (TegridyStaking)
Creates reward accounting drift — next interaction over-distributes for the skipped period.

### M-09: `distribute()` Has No Cooldown — Epoch Spam Griefing (RevenueDistributor)
Anyone can create hundreds of epochs with 0.001 ETH each, DOS'ing `claim()` via `TooManyUnclaimedEpochs`.

### M-10: Stale Registrations Dilute Revenue (RevenueDistributor)
Expired-lock users still counted in `totalRegisteredLocked` until manually poked.

### M-11: `withdrawPending()` Permanently Reverts for Non-ETH-Receivable Contracts (RevenueDistributor)
No rescue mechanism for stuck pendingWithdrawals.

### M-12: Bypassable ERC-777 Detection (TegridyFactory)
`_rejectERC777` can be trivially bypassed by not implementing ERC-165 or not registering with ERC-1820.

### M-13: No Mechanism to Disable Malicious Pairs (TegridyFactory)
Once created, pairs cannot be paused, removed, or flagged as unsafe.

### M-14: `setMaxSlippage` Has No Timelock (POLAccumulator)
Inconsistent with `backstopBps` which has 24h timelock. Compromised owner + MEV = value extraction.

### M-15: Entire ETH Balance Used in Single Transaction (POLAccumulator)
No batching cap. Large accumulations create high MEV targets.

### M-16: `sweepETH` Can Drain All Protocol Revenue (POLAccumulator)
48h timelock but no cap on amount or restriction on recipient.

### M-17: NFT Activation Timestamp Weak on L2 (PremiumAccess)
Same-second bypass possible on chains with coarse timestamp granularity.

### M-18: `sweepUnclaimable` Missing WETH Fallback (ReferralSplitter)
Inconsistent with other ETH-sending functions in the same contract.

### M-19: `withdrawCallerCredit` Missing WETH Fallback (ReferralSplitter)
SwapFeeRouter caller credits can become permanently locked if router is replaced.

### M-20: Aggregator Quote Displayed But Uniswap Executed (Frontend useSwap)
Users see favorable aggregator price but swap routes through Uniswap V2 at worse rate. `minimumReceived` based on wrong quote causes reverts.

---

## Deployment Script Critical Issues

| ID | Severity | Issue |
|----|----------|-------|
| F1 | HIGH | No ownership transfer to multisig in DeployFinal |
| F2 | HIGH | Factory feeToSetter remains deployer EOA |
| F6 | HIGH | POLAccumulator and TegridyFeeHook not deployed |
| F7 | HIGH | Timelock race condition + copy-paste error in instructions |
| F9 | MEDIUM | SwapFeeRouter points to Uniswap V2 Router, not TegridyRouter |
| F10 | MEDIUM | Incomplete console instructions — missing `staking.executeRestakingContract()` |
| F8 | MEDIUM | PremiumAccess lacks Pausable (only contract without it) |

---

## Test Coverage Summary

### Per-Contract Test Gaps

| Contract | Functions Tested | Untested | Gap |
|----------|-----------------|----------|-----|
| TegridyPair | ~40% | skim, sync, all revert paths, all swap edge cases | 30 missing tests |
| TegridyRouter | ~30% | removeLiquidity, all exact-output swaps, all fee-on-transfer swaps | 15+ critical missing |
| TegridyFactory | ~50% | ERC-777 rejection, most timelocks, zero-address checks | 10+ missing |
| SwapFeeRouter | ~40% | withdrawFees, all timelocks, maxFeeBps, path validation | 15+ critical missing |
| TegridyStaking | ~35% | Emergency exits, claimUnsettled, reward settlement on transfer | 10+ critical missing |
| TegridyRestaking | ~30% | refreshPosition, revalidateBoost, emergencyForceReturn | 10+ critical missing |
| RevenueDistributor | ~61% | distributePermissionless, pokeRegistration, emergencyWithdraw | 7 untested functions |
| CommunityGrants | ~50% | lapseProposal, sweepFees, emergencyRecover, fee receiver timelock | 8 untested functions |
| MemeBountyBoard | ~56% | refundStaleBounty, emergencyForceCancel, all pull-pattern withdrawals | 7 untested functions |
| ReferralSplitter | ~50% | withdrawCallerCredit, forfeitRewards, all timelocked caller mgmt | 10 untested functions |
| PremiumAccess | — | reconcileExpired, deactivateNFTPremium, hasPremiumSecure | Multiple gaps |
| POLAccumulator | — | All timelock functions, sweepTokens | Multiple gaps |
| TegridyFeeHook | — | afterSwap (core function!), claimFees, sync timelocks | Multiple gaps |

### False-Assurance Tests (Tests That Pass But Don't Validate)

1. `test_router_hasNonReentrant` — does sequential swaps, not reentrancy
2. `test_mintFee_protocolShareIsSixteenth` — only checks `> 0`, not the 1/6 ratio
3. `test_forceApprove_usedNotBareApprove` — mock doesn't enforce USDT behavior
4. `test_burn_redeemLP` — asserts `> 0`, not proportional to deposit
5. `test_mint_subsequent` — asserts `> 0`, not proportional
6. `test_rewards_accrue` — 1 ETH tolerance hides boost math errors
7. `test_claim_rewards` — `> 900` is too loose a bound
8. `test_emergencyWithdraw_forfeitsRewards` — `assertGe(uint256, 0)` is vacuous

### Missing Critical Invariants

1. `totalBoostedStake == sum(boostedAmounts)` (TegridyStaking)
2. `totalStaked == sum(positions.amount)` (TegridyStaking)
3. `totalEarmarked >= totalClaimed` (RevenueDistributor)
4. `totalRegisteredLocked == sum(registeredLockAmount)` (RevenueDistributor)
5. `totalRefundEscrow == sum(userEscrow)` (PremiumAccess)
6. `LP.totalSupply == sum(balances) + MINIMUM_LIQUIDITY` (TegridyPair)
7. K never decreases including burn path (PairHandler missing `doBurn`)
8. `accruedFees[token]` monotonically increases between claims (TegridyFeeHook)
9. LP token balance never decreases (POLAccumulator — permanent liquidity)
10. `address(this).balance >= totalEarmarked - totalClaimed + totalPendingWithdrawals` (RevenueDistributor)

---

## Reentrancy Analysis — System-Wide (All 13 Contracts)

**Result: ZERO critical/high/medium reentrancy vulnerabilities.** The protocol's reentrancy defenses are comprehensive:

| Defense | Status |
|---------|--------|
| `nonReentrant` on all user-facing state-changing functions | Present in all 13 contracts |
| CEI pattern in AMM pair (swap, burn, mint) | Correctly followed (audit fixes M-02, H-01) |
| Flash swaps disabled | `require(data.length == 0)` in TegridyPair |
| Read-only reentrancy | Fixed — reserves updated before transfers |
| Cross-contract reentrancy (Restaking <-> Staking) | Safe — separate ReentrancyGuard instances |
| ERC-777 rejection at factory | Best-effort but present |
| Pull patterns for ETH | Used throughout (pendingWithdrawals, pendingPayouts, callerCredit) |
| WETH fallback on ETH transfers | Consistent (except MemeBountyBoard.withdrawRefund — see H-06) |

**Only finding:** CommunityGrants.executeProposal does ETH transfer before state update (Low — mitigated by nonReentrant).

---

## Positive Security Observations

The codebase demonstrates significant security maturity in several areas:

- **ReentrancyGuard** applied consistently across all state-changing functions
- **Ownable2Step** used everywhere (prevents accidental ownership transfer)
- **SafeERC20** used consistently for all token transfers
- **Timelocks** with proposal expiry on all admin changes (24h-48h delays)
- **CEI pattern** followed in swap/burn functions
- **Flash swap disabled** in TegridyPair (eliminates major attack class)
- **WETH fallback pattern** for ETH transfers (mostly — see H-06, M-18, M-19)
- **Solidity 0.8.26** built-in overflow protection
- **Pull-pattern** for fee accumulation prevents treasury DoS
- **`maxFeeBps` parameter** protects users from fee front-running
- **Deadline caps** (MAX_DEADLINE of 30 minutes)
- **Cyclic path detection** in router
- **`forceApprove` + revocation** handles USDT-style tokens

---

## Cross-Contract Interaction Findings

### Architecture Dependency Graph
```
SwapFeeRouter --> TegridyRouter --> TegridyFactory --> TegridyPair
SwapFeeRouter --> ReferralSplitter --> TegridyStaking (votingPowerOf)
TegridyFeeHook --> PoolManager (Uniswap V4) --> RevenueDistributor
TegridyStaking <--> TegridyRestaking (bidirectional)
RevenueDistributor --> TegridyStaking (locks, votingPowerOf)
CommunityGrants --> TegridyStaking (votingPowerAt, totalBoostedStake)
MemeBountyBoard --> TegridyStaking (votingPowerAt)
POLAccumulator --> Uniswap V2 Router
```

| # | Severity | Finding | Affected Contracts |
|---|----------|---------|--------------------|
| X-01 | HIGH | Stale registration persists for restaked positions — `_isRestaked()` returns true so `pokeRegistration()` silently returns, inflated `registeredLockAmount` dilutes all epoch shares | RevenueDistributor, TegridyStaking, TegridyRestaking |
| X-02 | MEDIUM | Paused staking prevents `revalidateBoost()` in restaking — stale JBAC boost persists indefinitely during pause, user who sold JBAC keeps +0.5x bonus | TegridyStaking, TegridyRestaking |
| X-03 | MEDIUM | Race condition in shared `unsettledRewards` bucket — concurrent unrestakes in same block cause first user's rewards to be claimed by second user's `claimUnsettled()`, stuck in restaking contract | TegridyStaking, TegridyRestaking |
| X-04 | MEDIUM | Referral fee forwarding fails silently when ReferralSplitter is reentrancy-locked — fee goes to treasury instead of referrer | SwapFeeRouter, ReferralSplitter |
| X-05 | MEDIUM | Owner-controlled `proposeSyncAccruedFees()` can destroy accrued hook fees — no on-chain verification of provided `actualCredit` | TegridyFeeHook, RevenueDistributor |
| X-06 | MEDIUM | Stake-and-register inflation — well-capitalized attacker registers large lock, early-withdraws, stale registration dilutes others for weeks until poked | RevenueDistributor, TegridyStaking |
| X-07 | MEDIUM | Two-step `accumulate()` (swap then LP) is a compound sandwich target across both operations | POLAccumulator |
| X-08 | LOW | Boost revalidation access control depends entirely on restaking contract gating | TegridyStaking, TegridyRestaking |
| X-09 | LOW | Single owner key can initiate parallel treasury redirections across all 13 contracts simultaneously | All contracts |
| X-10 | LOW | `block.number` snapshots unreliable on L2 for governance voting — not migrated to timestamps like PremiumAccess | CommunityGrants, MemeBountyBoard, TegridyStaking |

---

## Access Control Audit — Full Matrix

### Privilege Summary (All 13 Contracts)

| Contract | Owner Pattern | Timelock | Pause | Centralization Risk |
|----------|--------------|----------|-------|---------------------|
| TegridyFactory | feeToSetter (2-step) | 48h + 7d expiry | No | Low |
| TegridyPair | None (immutable factory) | N/A | No | None |
| TegridyRouter | None (stateless) | N/A | No | None |
| TegridyFeeHook | Ownable2Step | 24-48h | Yes | Low |
| SwapFeeRouter | Ownable2Step | 24-48h | Yes | Medium |
| TegridyStaking | Ownable2Step | 48h | Yes (with emergency exits) | Medium |
| TegridyRestaking | Ownable2Step | 24-48h | Yes (with emergency exits) | Low |
| RevenueDistributor | Ownable2Step | 48h + 7d expiry | Yes (claims still work) | Medium-High |
| CommunityGrants | Ownable2Step | 48h + 7d expiry | Yes | Medium |
| MemeBountyBoard | Ownable2Step | N/A on minBounty | Yes | Low |
| POLAccumulator | Ownable2Step | 24-48h (except slippage) | No | Medium |
| PremiumAccess | Ownable2Step | 24-48h + 7d expiry | No | Low |
| ReferralSplitter | Ownable2Step | 24-48h (post-setup) | No | Medium |

### Access Control Findings

| # | Severity | Contract | Issue |
|---|----------|----------|-------|
| AC-01 | MEDIUM | RevenueDistributor | Owner can `emergencyWithdrawExcess()` immediately without timelock — surplus ETH (not yet earmarked) can be withdrawn, including ETH intended for future distribution |
| AC-02 | LOW | POLAccumulator | `setMaxSlippage()` has no timelock — owner can instantly change from 1% to 10%, enabling sandwich of own `accumulate()` call |
| AC-03 | LOW | MemeBountyBoard | `setMinBountyReward()` has no timelock — inconsistent with timelocked pattern elsewhere |
| AC-04 | INFO | TegridyStaking | `reconcilePenaltyDust()` has no timelock but is safety-guarded (< 1 token or < 0.01% of totalStaked) |
| AC-05 | INFO | RevenueDistributor | `emergencySweepToken()` has no token restrictions — any ERC20 accidentally sent can be taken by owner |
| AC-06 | INFO | RevenueDistributor | `claim()` and `distribute()` correctly lack `whenNotPaused` — users can always claim earned ETH during pause |

### Overall Centralization Risk: MODERATE

The owner can pause most contracts, redirect treasuries (48h delay), and change fees (24h-48h delay, bounded by MAX). The owner **cannot** directly steal staked tokens, LP tokens, or earmarked revenue. All contracts use Ownable2Step, all critical params have timelocks with proposal expiry, and emergency exits work during pause.

**Key recommendation:** Deploy with a multisig (3/5 or 4/7 Gnosis Safe) as owner. Consider OZ TimelockController as an additional governance layer, particularly for RevenueDistributor emergency functions.

---

## Priority Fix Order

### Immediate (Before Deployment)
1. **H-07**: Add atomic ownership transfer in deploy scripts
2. **H-08**: Fix stale registration for restaked positions in RevenueDistributor
3. **F9**: Clarify SwapFeeRouter routing (Uniswap vs TegridyRouter intent)
4. **H-01**: Fix balance-delta reward accounting in TegridyRestaking
5. **H-02**: Fix JBAC boost check for restaked positions
6. **X-03**: Fix shared unsettledRewards race condition in concurrent unrestakes
7. **H-06**: Add WETH fallback to MemeBountyBoard.withdrawRefund
8. **H-05**: Remove dead code (retryPayout/rescueFailedPayout)
9. **M-20**: Fix aggregator quote vs execution mismatch in frontend

### High Priority (Before Mainnet)
8. **H-03**: Tighten reconcileRoundingDust threshold
9. **M-09**: Add cooldown to distribute() in RevenueDistributor
10. **M-04**: Add `to != pair` check in removeLiquidity
11. **M-05**: Use balance-before/after for fee-on-transfer WETH drain
12. **M-02**: Fix fee-on-transfer accounting in withdrawTokenFees
13. **M-14**: Add timelock to setMaxSlippage in POLAccumulator
14. **M-18/M-19**: Add WETH fallbacks in ReferralSplitter

### Required (Test Coverage)
15. Write tests for all emergency exit paths
16. Write tests for all pull-pattern withdrawal functions
17. Write invariant tests for top 10 missing invariants
18. Fix 8 false-assurance tests
19. Add fuzz tests with expanded input ranges
20. Test all audit-fix annotations (currently unvalidated)

---

---

## Economic / Tokenomics Attack Vectors

| ID | Severity | Attack Vector | Estimated Impact |
|---|---|---|---|
| E-01 | HIGH | **Penalty redistribution self-dealing** — Whale stakes from 2 addresses, early-withdraws from main, secondary captures nearly all penalty. Repeated on L2 for rounding profit accumulation. | Dust per tx, meaningful at scale |
| E-02 | HIGH | **Stale registration dilution** — Expired-lock users inflate `totalRegisteredLocked`, diluting active stakers' revenue share by 10-30%. Sybil-amplifiable with 100+ expired registrations. | 10-30% revenue dilution |
| E-03 | HIGH | **POLAccumulator sandwich** — `accumulate()` swaps full ETH balance in one tx. With 5% max slippage on 10 ETH = 0.5 ETH extractable per sandwich. Private mempool required but not enforced on-chain. | Up to 5% per accumulation |
| E-04 | MEDIUM | **Restaking incentive misalignment** — Bonus rewards use raw amount, not boosted amount. Rational actors always choose minimum lock for restaking, undermining lock duration incentives. | Structural weakness |
| E-05 | MEDIUM | **Epoch registration frontrunning** — Register with large lock just before distribution, claim after 1-epoch delay, unregister. Only protection is 1-epoch wait. | Disproportionate capture |
| E-06 | MEDIUM | **Sybil self-referral** — Create second address as own referrer, route all swaps through it. 10-30% of swap fees flow back to self. | 10-30% fee leakage |
| E-07 | MEDIUM | **Governance serial drain** — 50% cap per proposal but serial proposals drain geometrically: 50% → 75% → 87.5% → ~100% across 5-6 proposals. | Full treasury drain with voting majority |
| E-08 | MEDIUM | **NFT lock bypass market** — Secondary market for locked position NFTs. Discount < 25% penalty makes early exit cheaper than earlyWithdraw(). | Softens lock enforcement |
| E-09 | LOW | **Flash loan JBAC boost at stake time** — Flash-borrow JBAC NFT during `stake()`, bonus cached permanently. +0.5x boost for flash loan fee. | Permanent boost for one-time cost |
| E-10 | LOW | **SwapFeeRouter bypass** — Sophisticated users interact directly with TegridyRouter, paying only 0.3% instead of up to 1.3%. Protocol fee entirely optional. | Zero protocol fee for direct users |
| E-11 | INFO | **Unsustainable emission model** — If reward pool isn't replenished from protocol revenue, staking exhibits Ponzi dynamics where early stakers profit at late stakers' expense. | Conditional death spiral |

---

## Gas Optimization — Top Opportunities (32 found)

| Priority | ID | Location | Optimization | Est. Savings |
|----------|-----|----------|-------------|--------------|
| HIGH | G-01/02 | TegridyRouter._swap() | Cache `_pairFor()` results, eliminate redundant STATICCALL lookups | ~12,000 gas/swap |
| HIGH | G-13 | TegridyStaking | Pack Position struct (6 slots → 4): `lockEnd` uint64, `boostBps` uint16, `lockDuration` uint32 | ~8,400 gas/stake |
| HIGH | G-17 | TegridyPair._safeTransfer | Remove redundant `code.length` check (validated at factory) | ~5,200 gas/swap |
| HIGH | G-05 | TegridyStaking | Cache `rewardToken.balanceOf(this)` — called 2-3x per tx | ~5,200 gas/claim |
| MEDIUM | G-09 | CommunityGrants | Replace `_countActiveProposals()` loop with counter variable | Up to 210,000 gas |
| MEDIUM | G-08 | TegridyStaking._claimRewards | Pass `msg.sender` instead of re-calling `ownerOf()` | ~2,600 gas/claim |
| MEDIUM | G-18 | TegridyStaking._writeCheckpoint | Pass voting power instead of re-computing from storage | ~2,100-5,200 gas |
| MEDIUM | G-06 | All contracts | Add `unchecked` blocks for loop counters, safe subtractions | ~200-500 gas/call |
| LOW | G-23 | SwapFeeRouter | Remove `totalSwaps` counter (derive from events) | ~5,000 gas/swap |
| LOW | G-31 | SwapFeeRouter | Skip `forceApprove(router, 0)` revoke when fully consumed | ~5,000 gas/swap |

**Total hot-path savings:** ~11,000-14,000 gas per swap, ~9,000-16,000 per stake/withdraw, ~5,000-10,000 per claim.

---

## Frontend Hooks — Additional Findings (Staking/Stats/Premium Hooks)

### From `useFarmActions`, `useFarmStats`, `useNFTBoost`, `usePoints`, `usePoolData`, `useTegridyScore`, `useToweliPrice`, `useUserPosition`, `usePoolTVL`, `usePremiumAccess`, `useRevenueStats`

| # | Severity | Hook | Issue |
|---|----------|------|-------|
| FE-01 | MEDIUM | usePremiumAccess, useRevenueStats | Shared writeContract race condition — concurrent approve+action overwrites pending state |
| FE-02 | MEDIUM | usePoolTVL | Fabricated APR (always 5.475%) and volume (TVL*5%) displayed as live data |
| FE-03 | MEDIUM | useTegridyScore | Score fully manipulable via localStorage; displayed with authoritative ranks ("Top 1%") |
| FE-04 | MEDIUM | useUserPosition | `needsApproval` boolean incorrect for partial allowances (non-zero but insufficient) |
| FE-05 | LOW | useNFTBoost | Uncapped bigint-to-Number conversion |
| FE-06 | LOW | useFarmActions | Unsanitized error message in toast (defense-in-depth concern) |
| FE-07 | LOW | useToweliPrice | Drifting price change baseline — not pegged to session start or 24h |
| FE-08 | LOW | useTegridyScore | Fabricated percentile display with no statistical basis |
| FE-09 | LOW | useFarmActions | Missing validation in approve() — can crash on empty/non-numeric input |
| FE-10 | LOW | usePremiumAccess, useRevenueStats | Missing useEffect dependencies for toast callbacks |
| FE-11 | INFO | useFarmStats + useToweliPrice | Duplicate GeckoTerminal API fetch with localStorage cache race |

---

## Frontend Infrastructure & Configuration Findings

### From `vite.config.ts`, `vercel.json`, `package.json`, `index.html`, `App.tsx`, layout components, loader/animations

| # | Severity | Area | Issue |
|---|----------|------|-------|
| FI-01 | MEDIUM | index.html / vercel.json | CSP uses `unsafe-inline` for scripts — XSS vectors not blocked by policy |
| FI-02 | MEDIUM | contracts.ts | `POL_ACCUMULATOR_ADDRESS` is `0x0000...0000` — any call to it burns ETH or reverts |
| FI-03 | MEDIUM | constants.ts / useSwap | `AGGREGATOR_API` trusted without response validation — malicious quote injection possible |
| FI-04 | MEDIUM | wagmi.ts / tokenList.ts | Unlimited token approval (`MaxUint256`) requested by default — wallet drain on compromised contract |
| FI-05 | LOW | vercel.json | Missing `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` headers |
| FI-06 | LOW | vite.config.ts | Source maps enabled in production build (aids reverse engineering) |
| FI-07 | LOW | package.json | Several dependencies outdated; no `overrides` for known CVEs |
| FI-08 | LOW | App.tsx | No global error boundary wrapping wallet provider — unhandled rejection crashes entire app |
| FI-09 | LOW | TopNav.tsx | External link to token page opens without `rel="noopener noreferrer"` |
| FI-10 | INFO | BottomNav.tsx | Active route detection uses `startsWith` — nested routes highlight wrong tab |

---

## Frontend Contexts & State Management Findings

### From `contexts/`, `pointsEngine.ts`, `storage.ts`

| # | Severity | Area | Issue |
|---|----------|------|-------|
| FC-01 | MEDIUM | pointsEngine.ts | Points fully client-side with localStorage — trivially gameable via console |
| FC-02 | MEDIUM | useTegridyScore context | Score derived from forgeable localStorage data, displayed as authoritative |
| FC-03 | MEDIUM | storage.ts / referral | Self-referral not blocked — referral code stored in localStorage with no server validation |
| FC-04 | LOW | SwapContext | Swap state not cleared on wallet disconnect — stale data on reconnect |
| FC-05 | LOW | storage.ts | No data migration strategy — schema changes break existing users silently |

---

## Frontend Loader & Animation Findings

### From `AppLoader.tsx`, `audio.ts`, `geometry.ts`, `phases/`, `GlitchTransition.tsx`, `ParticleBackground.tsx`

| # | Severity | Area | Issue |
|---|----------|------|-------|
| FA-01 | MEDIUM | audio.ts | `AudioContext` created but never closed — leaks on every page load (Chrome limits to ~6) |
| FA-02 | MEDIUM | ParticleBackground.tsx | `devicePixelRatio` applied cumulatively on resize — canvas scales exponentially |
| FA-03 | MEDIUM | phases/textForm.ts | `getImageData()` allocates new buffer every frame at 60fps — 3.6MB/s GC pressure |
| FA-04 | LOW | AppLoader.tsx | No `cancelAnimationFrame` on unmount — animation loop continues in background |
| FA-05 | LOW | GlitchTransition.tsx | Multiple overlapping `requestAnimationFrame` loops during rapid navigation |
| FA-06 | LOW | geometry.ts | Particle count not capped — high-DPI displays create 50k+ particles |
| FA-07 | LOW | phases/hold.ts | Magic numbers throughout animation timing (no named constants) |
| FA-08 | LOW | ParticleBackground.tsx | Window resize handler not debounced — fires 60+ times during drag-resize |
| FA-09 | LOW | audio.ts | Hardcoded gain ramp timing not adjusted for AudioContext sample rate |
| FA-10 | INFO | AppLoader.tsx | Loader blocks interaction for fixed 4s minimum even on fast connections |

---

## Frontend UI Components Findings

### From `DCATab.tsx`, `LimitOrderTab.tsx`, `TokenSelectModal.tsx`, `TransactionReceipt.tsx`, `TegridyScore.tsx`, `TegridyScoreMini.tsx`

| # | Severity | Component | Issue |
|---|----------|-----------|-------|
| FU-01 | MEDIUM | TransactionReceipt.tsx:261,265 | Unsanitized token names in receipt hero block — `sanitize()` applied elsewhere but missed here |
| FU-02 | MEDIUM | TransactionReceipt.tsx:364-366 | Unsanitized `txHash` in text fallback clipboard copy — bypasses `sanitizeTxHash()` validation |
| FU-03 | LOW | DCATab.tsx:38 | Floating-point precision loss in DCA total cost (`parseFloat * parseInt`) |
| FU-04 | LOW | DCATab.tsx, LimitOrderTab.tsx | No upper bound enforcement on numeric inputs — `Infinity` possible |
| FU-05 | LOW | TokenSelectModal.tsx:137-143 | Imported token symbol not length-limited — malicious contract returns 1000-char symbol |
| FU-06 | LOW | TokenSelectModal.tsx:217-218,280 | Direct DOM manipulation in `img.onError` bypasses React reconciliation |
| FU-07 | LOW | TokenSelectModal.tsx (consumer) | Custom tokens not re-validated on reload from localStorage |
| FU-08 | INFO | TransactionReceipt.tsx | Receipt data not verified against on-chain state — fake receipts shareable via "Copy Image" |
| FU-09 | INFO | TegridyScore.tsx, TegridyScoreMini.tsx | Score values not clamped to [0,100] — SVG ring renders incorrectly on overflow |

---

## Frontend Pages Findings

### From `BountyPage.tsx`, `GrantsPage.tsx`, `SwapPage.tsx`, `DashboardPage.tsx`, `HomePage.tsx`, `FarmPage.tsx`, `LiquidityPage.tsx`, `TokenomicsPage.tsx`, `RestakePage.tsx`, `LeaderboardPage.tsx`, `PremiumPage.tsx`

| # | Severity | Component | Issue |
|---|----------|-----------|-------|
| FP-01 | MEDIUM | BountyPage.tsx:40-49 | No minimum reward validation on bounty creation — dust bounties spam the board |
| FP-02 | MEDIUM | SwapPage.tsx:371-381 | Unlimited approval toggle lacks prominent risk warning — understates drain risk |
| FP-03 | MEDIUM | DashboardPage.tsx, HomePage.tsx | Missing `useNetworkCheck()` — write transactions (claim rewards, register) execute on wrong chain |
| FP-04 | LOW | BountyPage.tsx:198 | Bounty description no length limit — unicode/homoglyph phishing text on-chain |
| FP-05 | LOW | GrantsPage.tsx:189 | Proposal description rendered without length limit — same phishing vector |
| FP-06 | LOW | SwapPage.tsx:539-546 | Raw RPC error messages displayed — may leak node URLs or internal details |
| FP-07 | LOW | SwapPage.tsx / TokenSelectModal | Custom imported tokens persist in localStorage indefinitely without re-warning |
| FP-08 | LOW | GrantsPage.tsx:201-213 | Missing loading states for vote/finalize — shared `isPending` across all buttons, no receipt |
| FP-09 | LOW | FarmPage.tsx:544, LiquidityPage.tsx:197-225 | Scientific notation and negative values accepted in amount inputs |
| FP-10 | LOW | DashboardPage.tsx:39, HomePage.tsx:28 | localStorage `JSON.parse` without schema validation — inflated price display |
| FP-11 | INFO | Multiple pages | External links correctly use `rel="noopener noreferrer"` — no action needed |

**Positive observations:** No `dangerouslySetInnerHTML` usage, EIP-55 checksum validation on address inputs, high-impact swaps require explicit confirmation ("FAFO Mode"), slippage capped at 5% with progressive warnings.

---

## Frontend Charts, History, Gallery & Lore Findings

### From `PriceChart.tsx`, `HistoryPage.tsx`, `GalleryPage.tsx`, `LorePage.tsx`

| # | Severity | Component | Issue |
|---|----------|-----------|-------|
| FG-01 | MEDIUM | HistoryPage.tsx:69-79 | Unbounded Etherscan API response fields stored in localStorage — quota exhaustion / perf degradation |
| FG-02 | MEDIUM | HistoryPage.tsx:69 | Etherscan API key exposed in client-side fetch URL (visible in DevTools Network tab) |
| FG-03 | LOW | PriceChart.tsx | No error boundary wrapping chart — `createChart` exception crashes entire page |
| FG-04 | LOW | PriceChart.tsx:17-18,67 | Unbounded in-memory OHLCV cache with no LRU eviction |
| FG-05 | LOW | PriceChart.tsx:53-64 | NaN/Infinity not filtered from GeckoTerminal OHLCV data before passing to chart library |
| FG-06 | LOW | HistoryPage.tsx, GalleryPage.tsx | localStorage `JSON.parse` without schema validation — corrupted data causes runtime errors |
| FG-07 | INFO | PriceChart.tsx:213 | iframe sandbox acceptable but CSP `frame-src` should restrict to geckoterminal.com |

**Clean:** LorePage.tsx (fully static), GalleryPage.tsx (no XSS vectors), no `dangerouslySetInnerHTML` usage anywhere.

---

## Updated Finding Totals (All Layers)

| Layer | Critical | High | Medium | Low | Info |
|-------|----------|------|--------|-----|------|
| Smart Contracts | 0 | 7 | 47 | 52 | 38 |
| Deploy Scripts | 0 | 4 | 3 | 0 | 0 |
| Economic Attacks | 0 | 3 | 5 | 2 | 1 |
| Cross-Contract | 0 | 1 | 6 | 3 | 0 |
| Access Control | 0 | 0 | 1 | 2 | 3 |
| Frontend Hooks | 0 | 0 | 4 | 6 | 1 |
| Frontend Pages | 0 | 0 | 3 | 7 | 1 |
| Frontend UI Components | 0 | 0 | 2 | 5 | 2 |
| Frontend Charts/History | 0 | 0 | 2 | 4 | 1 |
| Frontend Infra/Config | 0 | 0 | 4 | 5 | 1 |
| Frontend Contexts/State | 0 | 0 | 3 | 2 | 0 |
| Frontend Loader/Anim | 0 | 0 | 3 | 7 | 1 |
| **Total** | **0** | **15** | **83** | **95** | **49** |

---

*Report generated by 40 parallel Claude Opus 4.6 audit agents examining 13 smart contracts (~5,000+ lines of Solidity), 15 test files, 2 deploy scripts, foundry config, cross-contract interactions, access control matrix, frontend pages, hooks, UI components, charts, infrastructure, contexts, and animations.*
