# TEGRIDDY FARMS -- 200-AGENT SECURITY AUDIT REPORT
## 150+ Agents Completed | 17 Contracts | Full Stack (Contracts + Frontend)
### Date: 2026-04-03

---

## EXECUTIVE SUMMARY

This audit deployed 150+ specialized AI agents across the entire Tegriddy Farms codebase (17 Solidity contracts, 10+ frontend hooks, deployment scripts). Each agent performed deep analysis on a specific attack surface, comparing against battle-tested code from Uniswap V2, Curve, Synthetix, OpenZeppelin, Compound, Aave, OlympusDAO, Votium, and Velodrome.

**Overall Assessment: The codebase is well-hardened for a team-owned DeFi protocol.** Multiple prior audit rounds are evident (60+ inline fix references). The core AMM math is a faithful Uniswap V2 port. The staking/reward system correctly adapts Synthetix and MasterChef patterns. Timelocked admin actions, CEI pattern, and OZ ReentrancyGuard are consistently applied.

**However, several CRITICAL and HIGH findings require attention before mainnet deployment.**

---

## FINDINGS BY SEVERITY

### CRITICAL (3)

| ID | Contract | Finding |
|----|----------|---------|
| C-1 | **MemeBountyBoard** | **ETH permanently locked when quorum met but voter diversity insufficient.** `completeBounty()` requires both `MIN_COMPLETION_VOTES` AND `MIN_UNIQUE_VOTERS`, but `refundStaleBounty()` and `emergencyForceCancel()` only check votes, not voter count. Creates a deadlock where ETH can never exit. |
| C-2 | **VoteIncentives** | **Aggregate bribe claims can exceed deposits.** `totalBoostedStake` (denominator) is read live while per-user power (numerator) uses historical checkpoints. Sum of all `(bribeAmount * userPower_i) / totalPower` can exceed `bribeAmount`, causing insolvency. |
| C-3 | **Deployment Scripts** | **Parameter mismatch between DeployFinal and DeployAuditFixes.** Fee rates (0.5% vs 0.3%), referral splits (20% vs 10%), and premium pricing (ETH vs TOWELI denomination) differ. Missing `completeSetup()` on ReferralSplitter in audit-fixes script leaves instant caller bypass open. |

### HIGH (12)

| ID | Contract | Finding |
|----|----------|---------|
| H-1 | **TegridyStaking** | `votingPowerAtTimestamp()` may use `upperLookup` instead of `lowerLookup` -- returns wrong historical values, affecting ALL governance/revenue/bribe calculations. |
| H-2 | **TegridyStaking** | JBAC NFT boost permanently acquirable via flash-borrow: borrow NFT, call `revalidateBoost()`, return NFT. Boost persists because only position owner can re-check. |
| H-3 | **TegridyStaking** | Expired locks retain phantom voting power in checkpoints -- no zero-checkpoint written at lockEnd. Users claim revenue/bribes after lock expiry. |
| H-4 | **TegridyStaking** | No `totalBoostedStake` checkpoint -- denominator in RevenueDistributor and VoteIncentives uses live value while numerators use historical checkpoints, causing systematic under/over-payment. |
| H-5 | **RevenueDistributor** | `claim()`/`claimUpTo()` forward unlimited gas on ETH transfer. `distribute()`/`distributePermissionless()` lack `nonReentrant`. Cross-contract reentrancy possible during claim callback. |
| H-6 | **VoteIncentives** | ERC20 bribe `safeTransfer` failure (blacklisted user, paused token) reverts entire claim for ALL tokens in that epoch/pair. `pendingTokenWithdrawals` mapping exists but is never written to. |
| H-7 | **VoteIncentives** | `MIN_BRIBE_AMOUNT = 0.001 ether` (1e15) applied uniformly -- blocks all non-18-decimal tokens (USDC requires 1B minimum, WBTC requires 10M minimum). |
| H-8 | **CommunityGrants** | No voting delay -- proposals can be created and voted on in the same block. No mandatory execution timelock for owner (can execute immediately after finalization). |
| H-9 | **CommunityGrants** | No minimum unique voter count for grant proposals -- single whale can pass any proposal. |
| H-10 | **POLAccumulator** | No on-chain oracle/TWAP validation for swap slippage. Relies entirely on caller-provided `_minTokens`. Compromised owner key = full sandwich extraction. |
| H-11 | **VoteIncentives** | `claimBribesBatch()` allows 500 epochs x 20 tokens = 10,000 iterations. Can exceed block gas limit, permanently blocking claims for users with many unclaimed epochs. |
| H-12 | **TimelockAdmin** | Ownership transfer (`Ownable2Step`) completely bypasses all timelocks. Compromised owner instantly transfers ownership to attacker. |

### MEDIUM (35+)

Key medium findings include:
- **TegridyStaking**: `ACC_PRECISION = 1e12` (should be 1e18) -- reward loss when totalBoostedStake is large relative to rewardRate
- **TegridyStaking**: NFT transfer rate limit bypassed by intermediary contracts (any contract, not just restakingContract)
- **TegridyStaking**: No `increaseAmount()` function (users cannot add tokens to existing positions)
- **TegridyStaking**: `earlyWithdraw()` has no guard against expired locks -- users can accidentally pay 25% penalty on already-unlockable positions
- **TegridyStaking**: Penalty is flat 25% regardless of time remaining (no time-proportional decay)
- **RevenueDistributor/VoteIncentives**: Epoch denominator (totalBoostedStake) read live, not checkpointed -- systematic dust leakage
- **TegridyFactory**: Blocklist not enforced on `mint()` -- users can add liquidity to pairs with blocked tokens
- **TegridyFactory**: `disabledPairs` not checked on `mint()` -- new deposits accepted to dead pairs
- **TegridyRouter**: MAX_DEADLINE of 30 minutes breaks aggregator integration (1inch, CowSwap use longer deadlines)
- **SwapFeeRouter**: `adjustedMin` overflow fallback silently weakens slippage protection
- **CommunityGrants**: `_transferETHOrWETH` uses unlimited gas forwarding (unlike the imported WETHFallbackLib)
- **PremiumAccess**: No `Pausable` -- cannot halt operations during emergency
- **PremiumAccess**: `hasPremiumSecure()` excludes NFT holders from on-chain fee discounts
- **TegridyFeeHook**: ERC20 fees sent to ETH-only RevenueDistributor -- tokens permanently stuck
- **VoteIncentives**: No actual gauge voting mechanism -- bribes distributed to ALL stakers, not just voters for the bribed pair
- **Multiple contracts**: Several ETH transfer functions use raw `.call{value}` without WETHFallbackLib (inconsistent with the rest of the codebase)
- **Frontend**: Custom token import has no safety warnings or validation (phishing vector)
- **Frontend**: Limit orders use manipulable AMM spot price for trigger conditions
- **Frontend**: 5% hardcoded slippage on DCA/limit orders is excessive

### LOW (60+) | INFORMATIONAL (40+)

See individual agent reports for complete listings. Key themes:
- Missing events on several admin operations
- Gas optimization opportunities (transient storage for reentrancy, duplicate cycle checks)
- ERC20 edge cases for fee-on-transfer and rebasing tokens
- Missing EIP-2612 permit on LP tokens
- Frontend stale data handling and error reporting gaps

---

## BATTLE-TESTED CODE ALIGNMENT

### What Already Uses Battle-Tested Code (KEEP)
| Component | Battle-Tested Source | Status |
|-----------|---------------------|--------|
| TegridyPair AMM math | Uniswap V2 | Faithful port, K-invariant identical |
| TegridyPair fee (0.3%) | Uniswap V2 | Byte-for-byte equivalent formula |
| TegridyPair _mintFee | Uniswap V2 (1/6 protocol share) | Exact formula match |
| LPFarming reward math | Synthetix StakingRewards | Verbatim core, improvements on top |
| OwnableNoRenounce | OpenZeppelin Ownable2Step | Trivial 5-line wrapper, correct |
| ReentrancyGuard | OpenZeppelin | Used across all 14 guarded contracts |
| SafeERC20 | OpenZeppelin | Consistent across all ERC20 interactions |
| ERC721 (Staking NFTs) | OpenZeppelin | Standard inheritance, correct _update override |
| Checkpoints | OpenZeppelin Trace208 | Correct usage for voting power history |
| TimelockAdmin | MakerDAO DSPause-inspired | Clean 87-line implementation, sound |

### What Should Be Replaced/Added
| Component | Current | Recommended Battle-Tested Alternative |
|-----------|---------|--------------------------------------|
| CommunityGrants governance | Custom | Add OZ Governor voting delay + execution timelock (NOT full replacement) |
| VoteIncentives claims | On-chain proportional math | Merkle distributor (Votium pattern) for gas + correctness |
| VoteIncentives epochs | 1-hour permissionless advance | Fixed weekly cadence (Velodrome pattern) |
| POLAccumulator price check | Caller-provided minimums | On-chain Chainlink/TWAP oracle floor |
| ReentrancyGuard | OZ storage-based | OZ ReentrancyGuardTransient (EIP-1153, saves ~2100 gas/call) |
| TegridyPair LP permit | Not implemented | OZ ERC20Permit (enables aggregator integration) |
| JBAC boost check | Cached at revalidation | Check at claim time (Azuki staking pattern) |

---

## TOP 10 PRIORITY FIXES

1. **Fix MemeBountyBoard deadlock** (C-1): Add `uniqueVoterCount` check to `refundStaleBounty()` and `emergencyForceCancel()` -- 2 lines of code, prevents permanent ETH lock.

2. **Fix VoteIncentives insolvency** (C-2): Either checkpoint `totalBoostedStake` historically OR decrement `epochBribes` on each claim (Velodrome pattern) OR switch to Merkle distribution.

3. **Fix checkpoint lookup function** (H-1): Verify whether `upperLookup` vs `lowerLookup` is correct for the OZ version in use. If wrong, this breaks ALL governance, revenue, and bribe calculations.

4. **Add nonReentrant to distribute()** (H-5): One-line fix on RevenueDistributor -- add `nonReentrant` to `distribute()` and `distributePermissionless()`.

5. **Fix JBAC boost persistence** (H-2): Either make `revalidateBoost()` permissionless (anyone can strip invalid boosts) OR check JBAC ownership at claim time.

6. **Add ERC20 claim fallback in VoteIncentives** (H-6): Wrap `safeTransfer` in try/catch, credit to `pendingTokenWithdrawals` on failure. The mapping already exists at line 116 but is never used.

7. **Fix MIN_BRIBE_AMOUNT for non-18-decimal tokens** (H-7): Use per-token minimum or remove for ERC20 deposits (whitelist provides spam protection).

8. **Add voting delay to CommunityGrants** (H-8): Add `VOTE_DELAY = 1 days` between proposal creation and voting start. ~5 lines of code.

9. **Add execution timelock for all callers** (H-8): Remove owner's ability to bypass the 3-day execution delay. All executions should wait at least 24 hours.

10. **Resolve deployment script conflicts** (C-3): Consolidate to a single canonical deployment script. Add `completeSetup()` call to ReferralSplitter.

---

## RUG PULL RISK ASSESSMENT

**Overall: LOW to LOW-MEDIUM.** No contract allows the owner to directly access user-deposited funds. All parameter changes are timelocked (24-48h). LP tokens in POLAccumulator are permanently locked. Emergency exits are always available to users. The main risk vectors are:
- Instant pause/unpause across all contracts (DoS, not fund theft)
- Fee diversion after 48h timelock (extractable value = accumulated fees only)
- Ownership transfer bypasses timelocks entirely (H-12)

**Recommendation:** Transfer all contract ownership to a 3-of-5 Gnosis Safe multisig. Add a 7-day timelock to ownership transfers.

---

## ECONOMIC MODEL ASSESSMENT

**Key concerns:**
1. TOWELI is net inflationary with no burn mechanism -- staking rewards are externally funded
2. No gauge voting mechanism -- VoteIncentives bribe market is a general dividend, not directed vote incentives
3. Early withdrawal penalty (25%) goes to treasury, not remaining stakers
4. POL flywheel is sound but manually operated (no keeper automation)
5. Death spiral risk exists but is bounded by POL permanence and penalty mechanisms

**Recommendation:** Implement gauge voting (bribes only claimable by voters for the bribed pair), add a burn mechanism (portion of penalties/fees), and automate POL accumulation via Chainlink Keepers.

---

## METHODOLOGY

- **150+ specialized agents** covering: reentrancy, math/overflow, access control, flash loans, MEV/frontrunning, gas DoS, ERC20 edge cases, economic model, cross-contract interactions, formal invariants, battle-tested code comparison, deployment safety, frontend security, and more
- **Launched in batches of 5** to manage rate limits
- Each agent read the full source code of its target contracts
- Findings cross-referenced against real DeFi exploits (Cream, Harvest, bZx, Curve, Euler, Mango, etc.)
- All recommendations reference specific battle-tested implementations

---

*Report compiled from 150+ individual agent audit reports. Full individual reports available in the task output files.*
