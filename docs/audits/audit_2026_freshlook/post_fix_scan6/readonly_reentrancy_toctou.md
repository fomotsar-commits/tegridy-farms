# Read-Only Reentrancy + TOCTOU Audit — HEAD `d5ca554`

**Date:** 2026-05-09
**Scope:** `contracts/src/**/*.sol` — read-only reentrancy via cross-contract view consumption + TOCTOU patterns where read-then-external-call-then-use sequences could be invalidated mid-flight.
**Mandate:** `memory/feedback_minimal_surface.md` — minimal-surface posture; only flag findings whose fix is sibling-canonical.

---

## Executive summary (5 lines)

| Severity | Class | File:line | Status |
|---|---|---|---|
| EXPLOITABLE | (none found) | — | — |
| THEORETICAL | Flash-stake amplification of `MIN_REFERRAL_STAKE_POWER` qualification gate (mitigation: 7d MIN_LOCK + 25% earlyWithdraw penalty makes attack uneconomic) | `ReferralSplitter.sol:380, 388, 641, 650, 679, 688` | NON-ISSUE — economically defended |
| THEORETICAL | Buyer's `onERC721Received` during `swapETHForNFTs` sees stale `accumulatedLPFees`/`accumulatedProtocolFees` (incremented after transfer loop) | `TegridyNFTPool.sol:301-317` | NON-ISSUE — no on-chain consumer of these views |
| THEORETICAL | Whitelisted-but-malicious collateral contract's `transferFrom` callback during `acceptOffer` could read mid-flight `loans[loanId]` (already pushed) before NFT actually escrowed | `TegridyNFTLending.sol:725-735`, `TegridyLending.sol:1166-1175` | NON-ISSUE — post-condition `ownerOf == address(this)` check reverts the whole tx, no funds at risk |
| INFO | All consumers of the targeted external views (`votingPowerAt`, `pendingETH`, `consult`, `getReserves`, `getPair`, `ownerOf`) verified consistent with the state at the time of the inner call | (table below) | ✅ |

**Conclusion:** zero EXPLOITABLE findings. The repo's read-only-reentrancy + TOCTOU posture is intact post-scan5. All the obvious vectors have been closed by prior audits with battle-tested patterns: CEI ordering, `nonReentrant` guards, post-condition `ownerOf` checks, snapshot-at-propose-time for two-phase governance, `min(historical, current)` clamps on flash-amplifiable reads, bounded-returndata transferFrom/ownerOf, and the BATCH-C H4 close (clear restaking-side state BEFORE `safeTransferFrom` so receiver hooks see post-transfer power).

---

## Methodology

For each external view function called from another contract during a state-mutating tx, I traced:

1. **Read-only re-entrancy:** during the inner call's hostile-callback window, can the view return state inconsistent with the post-transition expectation?
2. **TOCTOU:** read X → external call (which may invalidate X) → use X. Is the gap exploitable?
3. **Storage-write inversion:** writes that depend on values valid before but stale after an external call.
4. **Sibling cross-call live-read amplification:** every consumer of `staking.votingPowerOf` / `votingPowerAtTimestamp` checked for whether the read is at a deterministic snapshot timestamp (T-1, epoch boundary) or live. Live reads are flash-amplifiable.
5. **NFT receiver hooks during pool/escrow operations:** `safeTransferFrom` to `to` fires `to.onERC721Received` BEFORE the rest of the calling function completes — view consistency during this window.
6. **Cross-contract callback chains:** `A.foo() → B.bar() → C.baz()` reads back into `A`'s state. Stack-depth view consistency.

---

## 1. Per-view-function consumer analysis

### 1.1 `IStaking.votingPowerAtTimestamp(user, ts)` consumers

| Consumer | Read site | Timestamp pinning | Class | Status |
|---|---|---|---|---|
| `RevenueDistributor._calculateClaim` | `RevenueDistributor.sol:850` | `epoch.timestamp` (set at distribute time as `block.timestamp - 1`, REV-M-01) | HISTORICAL pinned | ✅ Trace208 upperLookup excludes same-block stakes |
| `RevenueDistributor._calculateClaimReadOnly` | `RevenueDistributor.sol:1675` | `epoch.timestamp` | HISTORICAL pinned | ✅ |
| `RevenueDistributor._restakedPowerAt` | `RevenueDistributor.sol:634` (gas-capped at 50k) | `epoch.timestamp` | HISTORICAL pinned | ✅ |
| `GaugeController.vote` (powerAt) | `GaugeController.sol:411-416` | `epochStartTime(epoch) - 1` (BATCH-H M21) | HISTORICAL pinned | ✅ + `min(historical, current)` clamp at line 418 |
| `GaugeController.revealVote` (powerAt) | `GaugeController.sol:697-702` | `epochStartTime(epoch) - 1` | HISTORICAL pinned | ✅ + min-clamp at line 704 |
| `VoteIncentives.commitVote` | `VoteIncentives.sol:1522` | epochStartTime - 1 | HISTORICAL pinned | ✅ + min-clamp |
| `VoteIncentives.claimBribes` family | `VoteIncentives.sol:622-625` | snapshot timestamp | HISTORICAL pinned | ✅ |
| `MemeBountyBoard.voteOnSubmission` | `MemeBountyBoard.sol:424` | `bounty.snapshotTimestamp` (set at submitWork time) | HISTORICAL pinned | ✅ |
| `MemeBountyBoard.executeBounty` (gating) | `MemeBountyBoard.sol:477-480` | snapshot ts + min-clamp | HISTORICAL pinned | ✅ |
| `CommunityGrants.vote` | `CommunityGrants.sol:442-445` | snapshot ts + min-clamp | HISTORICAL pinned | ✅ |

**No live-reads on the AMOUNT axis.** Every consumer that scales economic outcomes by voting power reads at a pinned past timestamp or applies a `min(historical, current)` clamp. Flash-stake amplification of vote weight is not possible.

### 1.2 `IStaking.votingPowerOf(user)` (live) consumers

| Consumer | Read site | Use | Class | Status |
|---|---|---|---|---|
| `RevenueDistributor._getUserLockState` | `RevenueDistributor.sol:916` | live `votingPowerOf` returning aggregate, used as boolean lock-active gate | LIVE — boolean | ✅ Bound is "lock active" not amount; flash-stake gives only momentary access to the claim path which then reads HISTORICAL `votingPowerAtTimestamp` for amounts |
| `ReferralSplitter.recordFee` | `ReferralSplitter.sol:380, 388` | live `>= MIN_REFERRAL_STAKE_POWER` qualification gate | LIVE — boolean | NON-ISSUE — see §2.1 below |
| `ReferralSplitter.markBelowStake` | `ReferralSplitter.sol:641, 650` | live qualification check | LIVE — boolean | NON-ISSUE — see §2.1 |
| `ReferralSplitter.forfeitUnclaimedRewards` | `ReferralSplitter.sol:679, 688` | live qualification gate | LIVE — boolean | NON-ISSUE — see §2.1 |
| `GaugeController.vote/revealVote` (currentPower) | `GaugeController.sol:417, 703` | live, used only in `min(historical, current)` clamp | LIVE — clamped | ✅ Defense-in-depth, can only DOWN-clamp |
| `VoteIncentives.commit/reveal/claim` (currentPower) | `VoteIncentives.sol:625, 1525` | same min-clamp pattern | LIVE — clamped | ✅ |
| `CommunityGrants.vote` (currentPower) | `CommunityGrants.sol:445` | same | LIVE — clamped | ✅ |
| `TegridyStaking.kick` | `TegridyStaking.sol:1629` | sanity-check live aggregation | self-call | ✅ |

**`VotePowerOracle.powerOf` is correctly named `LiveUnsafe`** in the lib (`lib/VotePowerOracle.sol:54-99`) — every consumer that pairs a live read with an amount decision must also read `powerAt` and clamp to `min(historical, current)`. All 5 governance consumers do.

### 1.3 `IRevenueDistributor.pendingETH` / `pendingWithdrawals` consumers

| Read site | Consumer | Status |
|---|---|---|
| `RevenueDistributor.withdrawPending` | self | ✅ — internal to user pull pattern; nonReentrant; CEI |
| `RevenueDistributor.sweepDust / executeEmergencyWithdrawExcess / emergencyWithdraw` | self | ✅ — reserves `totalPendingWithdrawals` (per scan5 §1.2) |

No EXTERNAL contract reads `pendingETH` from RevenueDistributor during a state-mutating tx. Read-only re-entrancy: not exposed.

### 1.4 `ITegridyTWAP.consult(pair, tokenIn, amountIn, period)` consumers

| Consumer | Read site | Class | Status |
|---|---|---|---|
| `TegridyLending._positionETHValue` | `TegridyLending.sol:1863` | TWAP — historical integral over period | ✅ — refuses post-bypass (`OracleRebootstrapping`), refuses on disabled pair, refuses on stale sequencer |
| `POLAccumulator._twapMinOut` | `POLAccumulator.sol:822, 909` | same | ✅ — same gates apply |
| `SwapFeeRouter._readCurrentCumulative` | `SwapFeeRouter.sol:1914` | reads `getReserves` + `priceXCumulativeLast` directly to bridge integral; nonReentrant context | ✅ — internal-to-call atomic read |

`consult` itself reads `cumulative_end - cumulative_start` over the period. Both anchors are HISTORICAL observations stored in `observations[pair][i]`. Same-block manipulation cannot affect the integral because the latest observation is gated on `MIN_PERIOD = 30 minutes` between updates AND the `bypassed` flag locks the buffer until honest re-bootstrap.

### 1.5 `IPair.getReserves()` consumers

| Consumer | Read site | TOCTOU concern | Status |
|---|---|---|---|
| `TegridyPair.swap/mint/burn` | self (multiple) | reads BEFORE updating reserves; CEI ordering with `_update(...)` BEFORE outbound transfers (M-02 fix) | ✅ |
| `TegridyRouter.getAmountsOut/In` | external view | view, no state mutation | ✅ |
| `TegridyRouter._getReserves` (for `_swap` / `_swapSupportingFeeOnTransferTokens`) | nonReentrant context | atomic read inside the swap loop | ✅ |
| `TegridyTWAP._captureCumulative` (update path) | observation write | reads + writes monotonic cumulative; post-bypass gate locks consumer | ✅ |
| `SwapFeeRouter._readCurrentCumulative` | nonReentrant call | atomic | ✅ |
| `POLAccumulator._twapMinOut` | nonReentrant call | atomic | ✅ |

**Zero consumers read `getReserves` during a hostile callback window.** Pair's `nonReentrant` + CEI updates eliminate the TegridyPair-side read-only-reentrancy class entirely (the M-02 / H-01 fixes already landed).

### 1.6 `IFactory.getPair(tokenA, tokenB)` consumers

| Consumer | Read site | Class | Status |
|---|---|---|---|
| `TegridyRouter._pairFor` | every swap entrypoint | static lookup | ✅ — followed by `disabledPairs(pair)` revert-on-disabled gate (line 512) |
| `SwapFeeRouter._readCurrentCumulative` | line 1910 | static lookup | ✅ |
| `POLAccumulator._lazyResolveLpToken` | line 280 | static lookup | ✅ |
| `VoteIncentives._verifyPair` | line 1431 | static lookup; verifies `factory.getPair(t0, t1) == pair` matches caller-supplied pair | ✅ — defends against fake-pair injection |

`getPair` is a deterministic mapping read; no time-of-check sensitivity (admin path only writes via `createPair`, which is idempotent on collisions).

### 1.7 `IERC721.ownerOf(tokenId)` consumers in mutating paths

| Consumer | Read site | Pre/Post | TOCTOU defense | Status |
|---|---|---|---|---|
| `TegridyLending.acceptOffer` | line 1120 (pre-transfer) | pre | post-condition check at line 1175 (`ownerOf != address(this) ⇒ revert CollateralNotEscrowed`) | ✅ TOCTOU closed |
| `TegridyNFTLending.acceptOffer` | line 687-689 (pre, bounded) + line 733 (post, bounded) | both | symmetric pre+post | ✅ |
| `TegridyLending.repayLoan` | line 2093 (in `pullEscrowRewards` branch) — try/catch | live read | gate use of result behind own conditional | ✅ |
| `TegridyLending._safeOutboundTransferStaking` | line 1556+ (post-transfer) | bounded-returndata via `SafeERC721Call.safeOwnerOfBounded` | post-condition | ✅ |
| `TegridyNFTLending._safeOutboundTransfer` | similar | bounded post-condition | ✅ |
| `TegridyNFTLending.claimDefault` | line 733 | post-transfer | post-condition | ✅ |
| `GaugeController.vote/commitVote/revealVote` | lines 369, 532, 682 | pre | direct equality check `ownerOf != msg.sender ⇒ revert` | ✅ — followed by historical + live power read with min-clamp |
| `TegridyStaking.*` (multi-call sites) | lines 856, 899, 941, 991, 1016, 1056, 1142, 1283, 1494, 1795, 1812, 1835, 1849, 1861 | pre | direct equality check | ✅ — local read; no external call between |
| `TegridyRestaking.restake` | line 694 | pre | direct equality + then immediately `safeTransferFrom` from msg.sender (atomic in same tx) | ✅ |
| `TegridyRestaking.claimResidualForTokenId` | line 1451 | live | conditional return-early when `currentOwner != address(this) && currentOwner != msg.sender` | ✅ — drains via gated `claimUnsettledForTokenId` which has its own `_isTrackedHolder` check |
| `TegridyNFTPool.syncNFTs` | line 714 (try/catch) | live | only adds to `_heldIds` if `current == address(this)` | ✅ |

All `ownerOf` reads in state-mutating paths are either (a) immediately followed by a direct check that reverts on inequality, or (b) used only as a conditional gate followed by a different authoritative drain function with its own auth.

### 1.8 NFT receiver hooks during pool/escrow operations

#### 1.8.1 `TegridyNFTPool.swapETHForNFTs` (`TegridyNFTPool.sol:270`)

Sequence under audit:
1. `_swapInFlight = true`, `spotPrice += delta * numItems` (line 286, 299) — state set
2. Loop: `nftCollection.safeTransferFrom(this, msg.sender, tokenId)` — fires buyer's `onERC721Received` (line 305)
3. AFTER loop: `accumulatedProtocolFees += protocolFee`, `accumulatedLPFees += lpFee` (lines 308-317)

During buyer's hook (between iterations):
- `accumulatedLPFees` / `accumulatedProtocolFees` are STALE (still pre-this-swap values) ✗
- `_heldIds` partially decremented ✗
- `spotPrice` already updated ✓

**Read-only-reentrancy concern:** could a buyer's hook read these views and act on the stale value? Cross-contract consumers of these views:
- `TegridyNFTPool.{accumulatedLPFees, accumulatedProtocolFees, priorOwnerOwed, totalPriorOwnerOwed}`: searched repo-wide — **zero external contracts read these.** Only the pool itself (`_lpAvailableETH`, `claimLPFees`, `claimProtocolFees`, etc.) consumes them, and the pool is `nonReentrant`.
- `getPoolInfo()`, `getHeldCount()`, `getBuyQuote()`, `getSellQuote()`, `isTokenHeld()`: consumed only from view-only context (`TegridyNFTPoolFactory.getBestBuyPool` family — which itself is `view`).

**Status: NON-ISSUE.** The intermediate inconsistency exists but no on-chain consumer reads these views during a state-mutating tx. The `_swapInFlight` flag + `_swapCaller` gate (V2-NFTPOOL-01) closes the only known callback re-entry vector (buyer's hook stuffing arbitrary tokenIds into `_heldIds`).

#### 1.8.2 `TegridyNFTPool.swapNFTsForETH` (line 339)

The pool RECEIVES NFTs from seller; pool is recipient, so its OWN `onERC721Received` fires. The hook is `_swapInFlight && from == _swapCaller` gated, accepting the seller's inflow only. Seller's hook NEVER fires here (seller is the sending party in `safeTransferFrom`). No cross-contract callback exposed. ✅

#### 1.8.3 `TegridyRestaking.unrestake` / `emergencyForceReturn`

During `safeTransferFrom(this, restaker, tokenId)`:
1. Restaking-side state already cleared: `delete restakers[user]`, `_writeBoostCheckpoint(user, 0)`, `totalRestaked -= ...`, `tokenIdToRestaker[tokenId]` preserved-but-doesn't-affect-vote-power (BATCH-C H4 close, line 2046-2061 in `emergencyForceReturn`, line 1199-1202 in `unrestake`)
2. Solady's `_beforeTokenTransfer` runs (settles rewards), ownership writes to `restaker`, `_afterTokenTransfer` runs (writes both checkpoints), THEN `restaker.onERC721Received` fires
3. At hook time: `staking.votingPowerOf(restaker)` returns the post-transfer aggregate (includes the just-transferred NFT's voting power). `restaking.votingPowerOf(restaker)` returns 0 (state cleared pre-transfer). `VotePowerOracle.powerOf(restaker, staking, restaking)` therefore returns the correct staking-only post-transfer value — no double-count.

**This is the BATCH-C H4 fix shape exactly.** The fix is in. ✅

#### 1.8.4 `TegridyDropV2.mint`

`_safeMint` fires `to.onERC721Received` AFTER counters updated (lines 557-562 BEFORE `_safeMint` at line 573, AUDIT R023 / M-02 close).

At hook time:
- `totalSupply`, `mintedPerWallet[msg.sender]`, `paidPerWallet[msg.sender]`, `totalProceeds` all reflect post-mint values ✓
- `ownerOf(newId)` reflects post-mint ✓
- Allowlist counters incremented ✓

External consumers of these views: none read in state-mutating context. ✅

#### 1.8.5 `TegridyStakingJbacVault.returnJbac`

`jbacNFT.safeTransferFrom(this, to, jId)` fires `to.onERC721Received` AFTER `jbacTokenId[user] = 0` is cleared (vault-side state cleared pre-transfer). ✅

### 1.9 Cross-contract callback chains

**`A.foo() → B.bar() → C.baz()` patterns audited:**

1. **Lending repay → staking transfer → restaking residual claim chain:** TegridyLending.repayLoan → `_safeOutboundTransferStaking` → staking's `_afterTokenTransfer` → `_writeCheckpoint`. Lending is `nonReentrant`. Staking-side checkpoint write doesn't recursively call into lending. ✅

2. **Restaking unrestake → staking transferFrom → bonus/base claim:** TegridyRestaking.unrestake → `safeTransferFrom` → restaker's `onERC721Received` (potentially hostile). Restaking is `nonReentrant`; restaker's hook can't re-enter. Staking checkpoints are post-transfer-correct. Restaking-side state is pre-transfer-cleared. ✅

3. **Hook claimFees → WETHFallbackLib → revenueDistributor.receive():** TegridyFeeHook.claimFees → ETH transfer via WETHFallbackLib → revenueDistributor's receive() emits + bumps `_totalETHReceivedRaw` only. No re-entry into hook. ✅

4. **POL accumulate → router swap → pair swap → token transfer:** POLAccumulator.accumulate → router.swapExactETHForTokens → pair.swap → token outbound to POL → POL holds tokens. POLAccumulator is `nonReentrant`. Pair is `nonReentrant`. Token transfer to POL fires no callback (TOWELI is OZ ERC20). ✅

---

## 2. Live-read patterns (potentially flash-amplifiable) — case analysis

### 2.1 ReferralSplitter `>= MIN_REFERRAL_STAKE_POWER` qualification gate (lines 380-394, 641-654, 679-693)

`votingPowerOf(referrer)` is read LIVE three places. The threshold is binary (1000 TOWELI equivalent voting power).

**Theoretical attack:** referrer flash-stakes during their own forfeit attempt to clear the threshold and block forfeit. But:

- `MIN_LOCK_DURATION = 7 days` (`TegridyStaking.sol:89`)
- `earlyWithdraw` exit costs 25% penalty (`TegridyStaking.sol:1027`)
- To clear 1000 TOWELI voting power at minimum 0.4x boost, attacker must lock 2,500 TOWELI for 7 days
- Penalty for early-exit: 625 TOWELI

**Economic analysis:** the attack DOES NOT NET PROFITS — it's a self-inflicted ~25% loss to block one forfeit operation. The forfeit is owner-only; if it reverts, the owner can retry. Each retry forces another 25% bleed. This is uneconomic and self-terminating.

Additionally: `recordFee` qualification gate (line 380-394) — flash-staking to qualify for ONE recordFee call gives only `referrerShare` (a slice of fee). For typical fee tiers (10-30% of swap fee), the attacker would need referrerShare > 625 TOWELI of stake-penalty-equivalent to break even. Not realistic.

**Status: NON-ISSUE — economically defended by 25% earlyWithdraw penalty + 7d MIN_LOCK_DURATION. Adding a min-clamp here (mirror governance pattern) would be defense-in-depth; the codebase has not done so because the qualification is binary not amount-scaled, so the existing `min` clamp doesn't naturally apply.**

### 2.2 `RevenueDistributor._getUserLockState` live aggregation (line 916)

```solidity
try votingEscrow.votingPowerOf(user) returns (uint256 power) { ... }
```

This is read LIVE only to detect "lock active" boolean status (not for the claim AMOUNT — amounts are HISTORICAL via `_calculateClaim`). A flash-staker can momentarily flip the lock-active gate, but:
- `_calculateClaim` reads `votingPowerAtTimestamp(user, epoch.timestamp)` for amount — pinned to past
- Restaker fallback `_restakedPowerAt(user, _ts)` is also historical Trace208

So: a flash-staker who stakes for one block and calls `claim()` would pass the lock-active gate but receive ZERO from `_calculateClaim` (historical lookup returns 0 for epochs before the stake). **NON-ISSUE.**

### 2.3 GaugeController `min(historical, current)` clamp

Both `vote` and `revealVote` apply `min(historical, current)` on the voting power (`GaugeController.sol:418, 704`). A live amplification can only DOWN-clamp the user's allocation, not up-clamp. Defense-in-depth pattern (DEEP-GOV-01) holds.

---

## 3. Storage-write inversion patterns

Searched for: `read external value → external call → write` where the written value depends on a stale pre-call read.

### 3.1 TegridyLPFarming.notifyRewardAmount (lines 572-602)

```solidity
uint256 balanceBefore = rewardToken.balanceOf(address(this));
rewardToken.safeTransferFrom(msg.sender, address(this), amount);
uint256 actualReward = rewardToken.balanceOf(address(this)) - balanceBefore;
// ... computes rewardRate from `actualReward` ...
totalRewardsFunded += actualReward;
```

The `actualReward` delta is read AFTER the transferFrom completes. If the reward token had a transfer hook that increased our balance (e.g., dividend airdrop in same block), the delta would credit the airdrop too. But:
- `notifyRewardAmount` is `onlyOwner nonReentrant`
- Rewardtoken is TOWELI (OZ ERC20, no hooks)
- Even if rewardToken were FoT, the delta is the post-transfer truth — no inversion

**Status: ✅ correct delta-pattern.**

### 3.2 SwapFeeRouter convertERC20FeesToETH (lines 1908-1942)

```solidity
uint256 ethBefore = address(this).balance;
router.swapExactTokensForETH(...);
uint256 ethReceived = address(this).balance - ethBefore;
```

Same delta-pattern. The router callback (or recipient hook) cannot re-enter SwapFeeRouter (`nonReentrant`). **Status: ✅.**

### 3.3 TegridyRestaking.unrestake — pre-transfer pull then post-transfer pull (lines 1212, 1244)

```solidity
try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p) { prePaid = _p; }
// ... safeTransferFrom (fires _settleRewardsOnTransfer hook) ...
try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p2) { postPaid = _p2; }
```

The two-step pull captures (a) the pre-transfer accumulated residue, then (b) the just-credited final-period accrual from `_settleRewardsOnTransfer`. Both pulls use `claimUnsettledForTokenId` which atomically reads `unsettledRewardsByTokenId[tokenId]` and decrements — no inversion possible. **Status: ✅.**

### 3.4 TegridyFeeHook.executeSyncAccruedFees (snapshot pattern)

`proposeSyncAccruedFees` snapshots `poolManager.balanceOf(this, currency)` at propose time (line 615). `executeSyncAccruedFees` (24h later) bounds the upward sync by the SNAPSHOTTED value. This explicitly defeats the read-then-call inversion: a same-tx race between `claimFees` and `executeSyncAccruedFees` cannot manipulate the bound. (D-AMM-M4 fix.) **Status: ✅.**

---

## 4. Sibling cross-call live-read findings (consolidated)

Per mandate: "TegridyStaking, TegridyRestaking, TegridyLending, TegridyLPFarming, GaugeController, RevenueDistributor, MemeBountyBoard, CommunityGrants, ReferralSplitter, VoteIncentives all read voting power from staking. For each: is the read at a deterministic snapshot timestamp (block.timestamp - 1 or epoch boundary), or live? Live reads are flash-amplifiable."

| Consumer | Snapshot? | Class | Status |
|---|---|---|---|
| TegridyStaking | self-aggregation only | n/a | ✅ |
| TegridyRestaking | tracks own boost via Trace208 (`_writeBoostCheckpoint`); historical reads via `boostedAmountAt` | HISTORICAL | ✅ |
| TegridyLending | reads `staking.getPosition(tokenId)` (struct, not vote-power) for collateral validation. No vote-power read. | n/a | ✅ |
| TegridyLPFarming | doesn't read voting power (independent rewards system) | n/a | ✅ |
| GaugeController | `powerAt(user, epochStartTime - 1)` HISTORICAL + `powerOf(user)` LIVE — clamped via `min(historical, current)` | mixed, clamped | ✅ DEEP-GOV-01 |
| RevenueDistributor | `votingPowerAtTimestamp(user, epoch.timestamp)` per-epoch HISTORICAL | HISTORICAL | ✅ |
| MemeBountyBoard | `powerAt(user, snapshotTimestamp)` HISTORICAL + `powerOf` LIVE for execute gate (not amount) | mixed, amount-side historical | ✅ |
| CommunityGrants | `powerAt(user, snapshotTimestamp)` HISTORICAL + `powerOf` LIVE-clamped | mixed, clamped | ✅ |
| ReferralSplitter | LIVE `votingPowerOf` only (binary qualification) | LIVE — binary gate | NON-ISSUE — economically defended (§2.1) |
| VoteIncentives | `powerAt(user, snapshotTimestamp)` HISTORICAL + `powerOf` LIVE-clamped | mixed, clamped | ✅ |

**Summary:** every consumer that scales economic outcomes by voting power reads HISTORICAL or applies a min-clamp. The single LIVE-ONLY consumer (`ReferralSplitter`) uses voting power as a binary qualification gate, not an amount; flash-stake economics make the attack uneconomic.

---

## 5. NFT receiver hook windows — exhaustive enumeration

| Hook fires in | State at hook time | Cross-contract consumer? | Status |
|---|---|---|---|
| `TegridyNFTPool.swapETHForNFTs` (buyer hook) | `accumulatedLPFees`/`accumulatedProtocolFees` PRE-this-swap; `_heldIds` partially decremented; `spotPrice` post-update | none | ✅ NON-ISSUE |
| `TegridyNFTPool.swapNFTsForETH` (pool's own hook) | gated to `_swapCaller` only | self only | ✅ |
| `TegridyNFTPool.removeLiquidity` (owner hook) | `_heldIds` partially decremented before next | none consume | ✅ |
| `TegridyNFTPool.withdrawNFTs` (owner hook) | same | none consume | ✅ |
| `TegridyDropV2.mint` (recipient hook) | counters POST-mint (R023/M-02 fix) | none consume in mutating paths | ✅ |
| `TegridyStakingJbacVault.returnJbac` | `jbacTokenId[user] = 0` cleared pre-transfer | none consume | ✅ |
| `TegridyRestaking.unrestake` (restaker hook) | restaking-side state cleared pre-transfer (BATCH-C H4); staking-side post-transfer correct | governance consumers via `VotePowerOracle.powerOf` — sees correct staking-only post-transfer power, no double-count | ✅ |
| `TegridyRestaking.emergencyWithdrawNFT` (restaker hook) | same | same | ✅ |
| `TegridyRestaking.emergencyForceReturn` (restaker hook) | BATCH-C H4 close at line 2046-2061: `delete restakers[restaker]` + `_writeBoostCheckpoint(restaker, 0)` BEFORE `safeTransferFrom` | same | ✅ |
| `TegridyRestaking.rescueNFT` (recipient hook) | `tokenIdToRestaker[tokenId]` preserved; recipient must be original restaker | safe | ✅ |
| `TegridyRestaking.claimStrandedRestakeNFT` (recipient hook) | `strandedRestakeRecipient[tokenId]` cleared pre-transfer | safe | ✅ |

---

## 6. Final findings table

| Severity | Finding | File:line | Class | Status |
|---|---|---|---|---|
| EXPLOITABLE | (none) | — | — | — |
| THEORETICAL | NFT receiver hook window in `swapETHForNFTs` sees stale `accumulatedLPFees` / `accumulatedProtocolFees` | `TegridyNFTPool.sol:301-317` | view-window inconsistency | NON-ISSUE — no on-chain consumer of these views |
| THEORETICAL | Whitelisted-but-malicious collateral contract's `transferFrom` callback could read `loans[loanId]` mid-flight | `TegridyNFTLending.sol:704-735`, `TegridyLending.sol:1134-1175` | mid-flight loan record | NON-ISSUE — post-condition `ownerOf == address(this)` revert protects fund flows |
| THEORETICAL | Flash-stake amplification of `MIN_REFERRAL_STAKE_POWER` qualification gate | `ReferralSplitter.sol:380, 388, 641, 650, 679, 688` | live-read binary gate | NON-ISSUE — 7d MIN_LOCK + 25% earlyWithdraw makes attack uneconomic |
| INFO | All `votingPowerAtTimestamp` consumers verified HISTORICAL-pinned | (table §1.1) | live-read amplification | ✅ |
| INFO | All `consult()` consumers verified TWAP-historical | (table §1.4) | flash-loan price | ✅ |
| INFO | All `getReserves` consumers either CEI-correct or atomic in nonReentrant context | (table §1.5) | read-only-reentrancy | ✅ |
| INFO | All `ownerOf` reads in mutating paths paired with post-condition or local equality check | (table §1.7) | TOCTOU | ✅ |
| INFO | All NFT receiver hooks fire in CEI-clean order (counters/state pre-transfer) | (table §5) | hook-window inconsistency | ✅ |
| INFO | BATCH-C H4 close (restaking-side state cleared BEFORE NFT transfer) is the canonical defense | `TegridyRestaking.sol:1199-1202, 2046-2061` | double-vote | ✅ |
| INFO | Two-phase governance with snapshot-at-propose-time used in `TegridyFeeHook.proposeSyncAccruedFees` (D-AMM-M4 close) | `TegridyFeeHook.sol:615-618, 642-740` | two-phase TOCTOU | ✅ |

---

## Conclusion

Zero EXPLOITABLE read-only-reentrancy or TOCTOU findings. The repo's posture against this class:

1. **Snapshot-at-past-timestamp** for every economic-amount consumer of vote power
2. **`min(historical, current)` clamps** for every governance amount-decision read
3. **CEI** with state mutations BEFORE external calls / NFT transfers (R023/M-02, BATCH-C H4, D-AMM-M4)
4. **Post-condition `ownerOf` checks** after `transferFrom` (LD-NEW-H2, FRESH-EYES H-3)
5. **Bounded-returndata** `transferFrom` / `ownerOf` (`SafeERC721Call`)
6. **Sequencer-gate + bypass-flag** for TWAP consumption
7. **`nonReentrant`** on every state-mutating external entry
8. **`_swapInFlight` + `_swapCaller`** gates on NFT-pool deposits (V2-NFTPOOL-01)
9. **Aggregate-counter reservation** in `_lpAvailableETH` including `totalPriorOwnerOwed` (post-scan5 INV-1)

The single LIVE voting-power consumer (`ReferralSplitter`) is binary-gate only and economically defended by the 25% earlyWithdraw penalty + 7d MIN_LOCK_DURATION. No fix recommended — adding a min-clamp here would not change the attack economics and would add code complexity without security benefit (minimal-surface mandate).

The cross-state solvency invariant violation that scan5 flagged (`priorOwnerOwed` not reserved in `_lpAvailableETH`) does NOT have a sibling read-only-reentrancy or TOCTOU vector in this scan; the closest analog (NFT-receiver-hook window in `swapETHForNFTs`) has no on-chain consumer reading the inconsistent views. The repo's defense layers are sufficient.
