# Agent 64 — Donation Attacks / Direct Transfer Manipulation

**Lens**: Can an attacker manipulate internal accounting by direct ERC20/ETH/NFT transfers (donations)? Includes selfdestruct, coinbase tip, FoT-haircut drift, NFT transferFrom (no callback), and reset-on-first-deposit.

**Methodology**: Enumerated every contract that uses `address(this).balance` or `IERC20.balanceOf(address(this))` for accounting, every `skim/sync/sweep/rescue/recover` function, every NFT receiver, every accumulator that compares balance vs reserved.

---

## Summary

The codebase is **well-defended against donation attacks**. Every contract that uses balance-based accounting either:
1. Reserves the legitimate state (totalStaked, totalEscrow, accumulated*Fees, totalUnclaimed*) and only sweeps the surplus, OR
2. Caps emission against a configured rate (rewardRate, bonusRewardPerSecond) so donations only accelerate a bounded payout, OR
3. Uses a balance-diff (`bal_after - bal_before`) pattern that is immune to pre-existing donations, OR
4. Closes the receive() path entirely (NFT pool blocks `safeTransferFrom` from non-authorized operators).

I found **zero exploitable donation-attack primitives** in the current bulletproofed state. Every potential drift either benefits the protocol/stakers (donations distributed pro-rata at rate) or is recoverable by a timelocked admin sweep.

Below are the specific findings — all are **dead-end / defensive observations** rather than live vulnerabilities. They document the defense in depth so future refactors don't regress.

---

## F-64-01 (DEAD-END / NEGATIVE) — TegridyStaking reward pool: donation acceleration is bounded by rewardRate

**File**: `contracts/src/TegridyStaking.sol:677` (`_accumulateRewards`)

**Site**:
```solidity
uint256 available = rewardToken.balanceOf(address(this));
uint256 reserved = _reserved();   // totalStaked + totalUnsettledRewards
if (available > reserved) {
    uint256 rewardPool = available - reserved;
    if (reward > rewardPool) reward = rewardPool;
}
```

**Vector**: Donate TOWELI directly to the staking contract. Available grows; reward pool grows.

**Result**: NOT exploitable. `reward = elapsed * rewardRate` is the primary cap. The `rewardPool` cap is only a floor (reduces reward when pool is shallow). A donation lifts the pool floor but doesn't raise the rate ceiling. Donated TOWELI is distributed pro-rata to active stakers at the configured rate over time. **Donations benefit stakers**, not exploit them.

**Defense in depth**: `_reserved() = totalStaked + totalUnsettledRewards` correctly sequesters principal + claimed-but-unpaid rewards. Donation cannot starve user claims.

---

## F-64-02 (DEAD-END / NEGATIVE) — TegridyRestaking bonus accumulator: rate-capped, donation-immune

**File**: `contracts/src/TegridyRestaking.sol:332-360` (`updateBonus` modifier)

**Site**:
```solidity
uint256 elapsed = block.timestamp - lastBonusRewardTime;
uint256 reward = elapsed * bonusRewardPerSecond;
uint256 available = bonusRewardToken.balanceOf(address(this));
if (reward > available) { reward = available; }
if (reward > 0) {
    accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
}
```

**Vector**: Donate `bonusRewardToken` directly. Available grows.

**Result**: NOT exploitable. `reward` is double-capped: `min(elapsed * rate, available)`. The rate is the binding cap in normal operation. Donation can only raise the floor on `available`, never the rate. Same posture as F-64-01.

**Constructor guard** (line 316): `if (_rewardToken == _bonusRewardToken) revert RewardTokenMatchesBonusToken();` — prevents reward/bonus token collision so balance reads can't double-count.

---

## F-64-03 (DEAD-END / NEGATIVE) — TegridyRestaking.recoverStuckPrincipal: reservation-aware

**File**: `contracts/src/TegridyRestaking.sol:1437-1442`

**Site**:
```solidity
uint256 balance = rewardToken.balanceOf(address(this));
uint256 othersPrincipal = totalActivePrincipal >= originalAmount
    ? totalActivePrincipal - originalAmount : 0;
uint256 reserved = totalUnforwardedBase + totalPendingUnsettled + othersPrincipal;
uint256 recoverable = balance > reserved ? balance - reserved : 0;
uint256 payout = recoverable > originalAmount ? originalAmount : recoverable;
```

**Vector**: Donate TOWELI to inflate `recoverable` and exceed `originalAmount`.

**Result**: NOT exploitable. `payout` is hard-capped by `originalAmount` (line 1445), so donation cannot pay the recoverer more than they originally restaked. Donation dust stays in contract, distributed via standard reward accumulator on subsequent claims.

---

## F-64-04 (DEAD-END / NEGATIVE) — TegridyLending.applySweepDonatedToweli: properly reserves escrow

**File**: `contracts/src/TegridyLending.sol:1933-1942`

**Site**:
```solidity
function applySweepDonatedToweli(uint256 amount, address to) external onlyAdmin nonReentrant {
    if (to != treasury) revert InvalidSweepRecipient();
    uint256 bal = IERC20(toweli).balanceOf(address(this));
    if (bal < totalEscrowRewardsOwed || bal - totalEscrowRewardsOwed < amount) {
        revert InsufficientCollateralValue();
    }
    IERC20(toweli).safeTransfer(to, amount);
}
```

**Vector**: Donate TOWELI; trigger sweep. Owner gets the donation.

**Result**: WORKING AS INTENDED. `bal - totalEscrowRewardsOwed` is the legitimate "donation" surplus; sweep is gated to treasury (separately 48h-timelocked) and bounded by the surplus. Borrower escrow is fully covered. **No exploit; standard treasury reclaim.**

---

## F-64-05 (DEAD-END / NEGATIVE) — TegridyPair: skim/sync gated behind disabledPairs

**File**: `contracts/src/TegridyPair.sol:289-316`

**Site** (skim + sync):
```solidity
function skim(address to) external nonReentrant {
    require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
    require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
    ...
}
function sync() external nonReentrant {
    require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
    ...
    _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
}
```

**Vector**: AUDIT FIX D-AMM-H2 specifically closed the donate→disabled pair→sync→TWAP poisoning attack. Pre-fix, an attacker could donate to a disabled pair, call `sync()` to integrate skewed reserves into the cumulative-price accumulator, then wait for re-enable so the next `TegridyTWAP.update()` reads a poisoned cumulative.

**Result**: CLOSED. Both `skim()` and `sync()` are gated by `disabledPairs` AND `blockedTokens`. The Uniswap V2 first-mint inflation attack is also closed by the `MINIMUM_LIQUIDITY * 1000` floor in `mint()` (line 155) — first depositor must seed > 1M raw liquidity, making first-LP inflation economically infeasible.

---

## F-64-06 (DEAD-END / NEGATIVE) — TegridyNFTPool: NFT donations blocked by onERC721Received gate

**File**: `contracts/src/TegridyNFTPool.sol:782-801` + `690-700` (syncNFTs)

**Site**:
```solidity
function onERC721Received(...) external override returns (bytes4) {
    require(msg.sender == address(nftCollection), "WRONG_COLLECTION");
    bool authorizedOperator = operator == owner || operator == address(this) || operator == factory;
    bool authorizedSwapInflow = _swapInFlight && from == _swapCaller;
    require(authorizedOperator || authorizedSwapInflow, "UNAUTHORIZED_DEPOSIT");
    ...
}
```

**Vector A**: Random user `safeTransferFrom`s NFT to pool. **Blocked** by UNAUTHORIZED_DEPOSIT.

**Vector B**: Random user `transferFrom`s NFT to pool (no callback). NFT lands at pool but `_idToIndex[tokenId] == 0`. Inventory counter (`_heldIds.length`) doesn't change — no inconsistency.

**Vector B-followup**: Owner calls `syncNFTs([tokenId])` (line 690), which adds the donated tokenId to `_heldIds` only if `nftCollection.ownerOf(tokenId) == address(this)`. Owner gains free inventory (donation accepted by protocol). **Standard donation acceptance, not exploitable.**

**Result**: Inventory invariant `_heldIds.length == count of NFTs actually owned by pool` is preserved. No drift between counter and reality.

---

## F-64-07 (DEAD-END / NEGATIVE) — TegridyNFTPool ETH donations + receive() restriction

**File**: `contracts/src/TegridyNFTPool.sol:803-806`

**Site**:
```solidity
receive() external payable {
    if (msg.sender != factory) revert OnlyFactoryReceive();
}
```

**Vector**: Send ETH to pool from an EOA → REVERTS via OnlyFactoryReceive (DEEP-NFTPOOL-08 fix). Selfdestruct → no revert opportunity, ETH lands in `_lpAvailableETH()` budget = `balance - accumulatedProtocolFees - accumulatedLPFees`.

**Result**: Selfdestruct donation lifts `_lpAvailableETH()`, which loosens the buy/sell solvency check (line 877) but does NOT change the bonding-curve price formula. The donation just lets the pool service one extra max-batch sell at the existing price. Owner can withdraw donation via `withdrawETH` after the cooldown — standard donation acceptance.

---

## F-64-08 (DEAD-END / NEGATIVE) — TegridyDropV2.withdraw: totalProceeds-bounded, donations safe

**File**: `contracts/src/TegridyDropV2.sol:962-991`

**Site**:
```solidity
uint256 bal = address(this).balance;
uint256 distributable = totalProceeds < bal ? totalProceeds : bal;
```

**Vector**: AUDIT FIX M-7 documented the exact pattern — pre-fix, donations were drained alongside `totalProceeds` and the platformFeeBps applied on top, letting a donor front-run withdraw to inflate platform's take.

**Result**: CLOSED. Withdraw distributes `min(totalProceeds, balance)`. Donations are sequestered and only recoverable via the post-cancellation rescue path (1-year delay), which itself reserves `unclaimedRefundPool`.

---

## F-64-09 (DEAD-END / NEGATIVE) — RevenueDistributor.distributePermissionless: rate-limited, donation-friendly

**File**: `contracts/src/RevenueDistributor.sol:346-415`

**Site**:
```solidity
uint256 reserved = (totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0) + totalPendingWithdrawals;
uint256 balance = address(this).balance;
uint256 newETH = balance > reserved ? balance - reserved : 0;
```

**Vector**: Donate ETH (selfdestruct/coinbase) to inflate `newETH` and trigger an unscheduled distribution.

**Result**: NOT exploitable. Three guards:
1. `MIN_DISTRIBUTE_INTERVAL = 4 hours` (line 163) — rate-limits any caller including attacker.
2. `MIN_DISTRIBUTE_AMOUNT = 1 ether` (line 168) — sub-1-ETH donations fail.
3. Donation IS the new epoch's `totalETH`. It's distributed pro-rata to bonded stakers at the snapshot timestamp. Attacker burns ETH for the protocol's benefit.

The `totalEarmarked` denom and per-epoch `totalLocked` snapshot make share computation independent of contract balance — donations cannot retroactively dilute existing claims.

---

## F-64-10 (DEAD-END / NEGATIVE) — POLAccumulator.accumulate: TWAP-floored, owner-only, donation-friendly

**File**: `contracts/src/POLAccumulator.sol:412`

**Site**:
```solidity
uint256 ethBalance = address(this).balance;
if (ethBalance < 0.01 ether) revert InsufficientETH();
if (ethBalance > maxAccumulateAmount) ethBalance = maxAccumulateAmount;
```

**Vector**: Donate ETH to inflate `ethBalance`, force a swap-and-LP-add at attacker-favorable spot.

**Result**: NOT exploitable. `accumulate()` is `onlyOwner`. The TWAP-derived `_twapMinOut(weth, halfETH)` floor (line 423) makes the swap leg sandwich-resistant regardless of balance source. Donation just gives the protocol more LP. **Donation benefits POL.**

---

## F-64-11 (DEAD-END / NEGATIVE) — SwapFeeRouter.convertTokenFeesToETH{,FoT}: TWAP-floored, ethReceived measured by delta

**File**: `contracts/src/SwapFeeRouter.sol:1586-1622, 1694-1718`

**Site**:
```solidity
uint256 ethBefore = address(this).balance;
router.swapExactTokensForETH(amount, effectiveMin, path, address(this), deadline);
uint256 ethReceived = address(this).balance - ethBefore;
...
accumulatedETHFees += ethReceived;
```

**Vector**: Selfdestruct ETH at SwapFeeRouter mid-swap to inflate `ethReceived` and pad `accumulatedETHFees`.

**Result**: NOT exploitable economically. Even if attacker burns own ETH via selfdestruct (which lands in `address(this).balance` between `ethBefore` and the post-swap read), the inflation flows directly into `accumulatedETHFees` which is distributed pro-rata to stakers/POL/treasury per the timelocked split. Attacker pays themselves zero — they donate ETH to stakers. There is no path where attacker can extract their donation.

Additionally, `nonReentrant` blocks the only callback-driven path to inject ETH (token transfer hook → external call → selfdestruct). Selfdestruct without a callback opportunity within the same tx requires the attacker to have pre-arranged an SELFDESTRUCT-bearing contract to fire mid-tx, which is detectable and economically irrational.

**Defense in depth**: TWAP-floor `effectiveMin` (`_enforceTWAPMinETHOut`) is anchored to the direct-pair cumulative-price snapshot, so even at a manipulated spot, the swap reverts if it can't clear the TWAP floor.

---

## F-64-12 (DEAD-END / NEGATIVE) — VoteIncentives bribe accounting: donation-immune

**File**: `contracts/src/VoteIncentives.sol:646-711, 768-887`

**Site (deposit)**:
```solidity
uint256 balBefore = IERC20(token).balanceOf(address(this));
IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
uint256 actualReceived = IERC20(token).balanceOf(address(this)) - balBefore;
```

**Site (claim)**: `share = (bribeAmount * userVoteForPair) / totalVotesForPair;` — operates on the per-(epoch, pair, token) ledger snapshot, not contract balance.

**Vector**: Donate the bribe token directly without `depositBribe`. Wallet share calculation is unaffected because `bribeAmount` reads the per-epoch ledger, not balance.

**Result**: NOT exploitable. Donations land in the contract but never enter `epochBribes[epoch][pair][token]`, so no claimer can pull them. They sit until owner calls `sweepToken` (which reserves `totalUnclaimedBribes[token] + totalPendingTokens[token] + totalCommitBonds for TOWELI`, line 1389) and sweeps the surplus to treasury. **Standard treasury donation reclaim.**

---

## F-64-13 (DEAD-END / NEGATIVE) — CommunityGrants.createProposal: donation lifts proposal cap

**File**: `contracts/src/CommunityGrants.sol:312-315`

**Site**:
```solidity
uint256 availableBalance = address(this).balance > totalApprovedPending
    ? address(this).balance - totalApprovedPending : 0;
if (_amount > (availableBalance * MAX_GRANT_PERCENT_BPS) / 10000) revert AmountTooLarge();
```

**Vector**: Donate ETH before `createProposal` to inflate `availableBalance` and request a larger grant than would otherwise be allowed.

**Result**: NOT exploitable economically. Even if attacker is the proposer:
1. They must hold a single staking position (line 351) — barrier to one-shot sybils.
2. Quorum + voter diversity (`MIN_UNIQUE_VOTERS`, `MIN_QUORUM_BPS`, `MIN_ABSOLUTE_QUORUM`) gate approval.
3. `EXECUTION_DELAY` + `PERMISSIONLESS_EXECUTION_DELAY` give the community time to react.
4. The 30-day rolling-disbursement cap (`MAX_ROLLING_DISBURSEMENT_BPS`) caps total drain at 30% of finalize-time balance per 30 days.

The proposer's own donation funds part of the grant they receive (via the inflated cap), but they MUST pass community vote first. Donating-then-stealing is a self-attack with the protocol's voters as the gatekeeper. **Not a viable economic exploit.**

---

## F-64-14 (DEAD-END / NEGATIVE) — TegridyLPFarming.notifyRewardAmount: donations stuck but not exploitable

**File**: `contracts/src/TegridyLPFarming.sol:476-495`

**Site**:
```solidity
uint256 balanceBefore = rewardToken.balanceOf(address(this));
rewardToken.safeTransferFrom(msg.sender, address(this), amount);
uint256 actualReward = rewardToken.balanceOf(address(this)) - balanceBefore;
...
rewardRate = (leftover + actualReward) / duration;
...
if (rewardRate > balance / duration) revert RewardTooHigh();   // balance includes donations
```

**Vector A (donate before notify)**: Donate TOWELI to LP farming. `balance / duration` cap relaxes (allows a higher rewardRate). But `notifyRewardAmount` is `onlyOwner`, so only owner can exploit, and they could just `safeTransferFrom` instead.

**Vector B (donation alone)**: TOWELI sits in contract. `rewardRate` is set by `(leftover + actualReward) / duration` (excludes donation). Donation never gets distributed because rewardRate doesn't account for it. After period ends, owner calls notifyRewardAmount with leftover=0 and the donated TOWELI stays stuck — `recoverERC20` blocks rewardToken sweep (line 559).

**Result**: Donations are *stuck forever* in LP farming. This is a griefing vector against the donor, not an attack on the protocol. Not an exploit per se, but worth noting that donated TOWELI to LP farming is irrecoverable. Owner could rotate to a new farming contract and abandon the old one if dust accumulates problematically.

**Severity**: Informational (donor self-harm only).

---

## F-64-15 (DEAD-END / NEGATIVE) — ReferralSplitter.sweepUnclaimable: triple-reserved

**File**: `contracts/src/ReferralSplitter.sol:777-789`

**Site**:
```solidity
uint256 balance = address(this).balance;
uint256 reserved = totalPendingETH + accumulatedTreasuryETH + totalCallerCredit;
uint256 sweepable = balance > reserved ? balance - reserved : 0;
```

**Vector**: Donate ETH; owner sweeps to treasury.

**Result**: WORKING AS INTENDED. Three reservation buckets (referrer pending, treasury accumulated, caller credit) protect every legitimate claim. Donations go to treasury via owner sweep. **Standard treasury reclaim.**

---

## F-64-16 (DEAD-END / NEGATIVE) — PremiumAccess.withdrawToTreasury: shortfall-aware

**File**: `contracts/src/PremiumAccess.sol:501-512`

**Site**:
```solidity
uint256 balance = toweli.balanceOf(address(this));
uint256 reserved = totalRefundEscrow + totalShortfallOwed;
uint256 withdrawable = balance > reserved ? balance - reserved : 0;
```

**Vector**: Donate TOWELI; owner sweeps.

**Result**: WORKING AS INTENDED. The DEEP-DR-M-05 fix ensures `totalShortfallOwed` (deferred refund obligations) is reserved alongside `totalRefundEscrow` (pro-rata refundable portion). Donation surplus → treasury. Standard reclaim.

---

## F-64-17 (DEAD-END / NEGATIVE) — TegridyFeeHook.sweepETH: revenueDistributor-only sink

**File**: `contracts/src/TegridyFeeHook.sol:836-845`

**Site**:
```solidity
function sweepETH(address to) external onlyOwner {
    if (to != revenueDistributor) revert InvalidSweepRecipient();
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_ETH");
    (bool success,) = payable(to).call{value: balance}("");
    ...
}
```

**Vector**: Donate ETH (selfdestruct/coinbase, since `receive()` is open); owner sweeps.

**Result**: WORKING AS INTENDED. AUDIT V3-AMM-H1 specifically removed `owner()` from the recipient allowlist — the only legal sink is `revenueDistributor`. Donations flow to stakers/POL/treasury via the standard distribution path. **Donations benefit stakers.**

---

## F-64-18 (DEAD-END / NEGATIVE) — TegridyStakingJbacVault: no balance accounting, irrelevant to donations

**File**: `contracts/src/TegridyStakingJbacVault.sol`

**Result**: Vault holds JBAC NFTs against per-staking-tokenId mappings. No `address(this).balance` or ERC20-balance-of-self accounting for distribution. NFT inventory is per-tokenId-keyed, not count-based. **Out of scope for donation lens.**

---

## F-64-19 (DEAD-END / NEGATIVE) — MemeBountyBoard: bounty-keyed accounting, no balance reads

**File**: `contracts/src/MemeBountyBoard.sol`

**Result**: Each bounty stores `reward = msg.value` at creation; payouts read `bounty.reward` directly, never `address(this).balance`. Donations sit in contract but never affect any bounty's payout. Owner sweep via `sweepExpiredRefund` operates on per-bounty reward fields, not balance. **Donation-immune by design.**

---

## F-64-20 (DEAD-END / NEGATIVE) — TegridyTWAP.update: pair-derived cumulatives, donation-irrelevant

**File**: `contracts/src/TegridyTWAP.sol:266-330`

**Vector**: Donate to TWAP contract directly.

**Result**: NOT exploitable. TWAP reads `pair.getReserves()` and `pair.price{0,1}CumulativeLast()` — pair state, not TWAP balance. The contract holds only `accumulatedFees` (from `updateFee` payments), reserved separately. Pair-side donations were already covered in F-64-05.

---

## Notes / Dead-ends explored

1. **Selfdestruct in Cancun**: post-EIP-6780, `selfdestruct` in non-creation contexts doesn't actually destroy the contract but DOES still transfer ETH. Donation vector still active. All findings above account for this.

2. **Coinbase tip**: `block.coinbase.call{value: ...}("")` from a paid block builder can target any contract. For Tegriddy contracts on a target chain (Base / Optimism / Arbitrum), the validator/sequencer is a single trusted party, and there's no economic incentive to dump ETH on a random Tegriddy contract. Even if it happens, F-64-09 / F-64-11 / F-64-17 routes mean donations flow to stakers/POL/treasury, not attacker.

3. **FoT haircut drift**: every place the codebase uses `safeTransferFrom`-then-balance-diff (TegridyStaking notifyRewardAmount, LP farming notifyRewardAmount, VoteIncentives depositBribe, SwapFeeRouter swap variants, RevenueDistributor donations, TegridyNFTPool LP) measures the actual received amount via balance-diff and uses THAT for accounting. Not the requested amount. Defended.

4. **Reset-on-first-deposit**: I scanned for any `if (totalX == 0) initialize/reset` pattern. The only reset-on-first-deposit case is RevenueDistributor's `lastDistributeTime` advance when `totalRestaked == 0` (TegridyRestaking H-01 fix line 354) — explicitly designed to forfeit empty-period emission so the first-restaker doesn't get a reward dump. Donation-safe.

5. **NFT count vs internal counter**: TegridyNFTPool's `_heldIds.length` is the only count-based NFT accounting. `syncNFTs` (owner-only) reconciles donations to actual `ownerOf` reality before adding. No drift possible.

6. **POL tokens donated to a pair**: addressed in F-64-05 — Uniswap V2 first-mint inflation closed by `MINIMUM_LIQUIDITY * 1000` floor.

7. **Reward token == accumulator + held**: every `available - reserved` pattern correctly subtracts the principal/escrow/pending bucket, so donations are surplus and either get rate-distributed or sweep-reclaimed.

---

## Conclusion

**The donation-attack surface is closed.** Every audit fix I encountered in this lens (D-AMM-H2, M-7 in DropV2, DEEP-DR-M-05 in PremiumAccess, V3-AMM-H1 in FeeHook, DS2-04 / DEEP-DS-08 in Staking, etc.) was specifically designed to handle the donation vector, and they hold up under fresh-eyes scrutiny. The codebase consistently uses one of three patterns:
1. `available - reserved` with reserved tracking every legitimate obligation
2. Rate-capped accumulators where donation only lifts the floor on `available`
3. Balance-diff measurements (`bal_after - bal_before`) for FoT-immunity

No live exploit found. F-64-14 (LP farming donation gets stuck) is the only informational finding worth tracking — not exploitable, just user self-harm.
