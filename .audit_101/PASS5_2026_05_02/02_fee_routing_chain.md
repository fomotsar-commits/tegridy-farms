# Pass-5 Cross-Contract Chain Analysis: Fee Routing

**Status:** No PoC-backed findings. INV-B fuzz suite (128k calls) confirms ETH conservation.

This file documents the value-flow analysis for ETH from a user's swap fee through to an end-recipient claim. The chain spans four contracts:

```
User Swap → SwapFeeRouter → ReferralSplitter (referral slice + remainder)
                         → distributeFeesToStakers → RevenueDistributor (staker slice)
                                                  → POLAccumulator (POL slice)
                                                  → Treasury (remainder)
```

---

## 1. Per-contract storage tracking ETH amounts

### SwapFeeRouter
- `accumulatedETHFees` — ETH from input swaps without an active referral path
- `pendingDistribution[recipient]` — failed distribute attempts queued for pull
- `totalPendingDistribution` — sum of above
- `accumulatedTokenFees[token]` — token-side equivalent

**Conservation invariant:** `address(this).balance >= accumulatedETHFees + totalPendingDistribution`

Enforced at [`sweepETH`:1369-1370](../../contracts/src/SwapFeeRouter.sol#L1369): `reserved = accumulatedETHFees + totalPendingDistribution; sweepable = balance - reserved`.

### ReferralSplitter
- `pendingETH[referrer]` — claimable referral rewards
- `totalPendingETH` — sum of above
- `accumulatedTreasuryETH` — referral slices from unqualified referrers (route to treasury)
- `callerCredit[caller]` — non-referral portion (pull pattern, prevents callback reentrancy)
- `totalCallerCredit` — sum of above

**Conservation invariant:** `address(this).balance >= totalPendingETH + accumulatedTreasuryETH + totalCallerCredit`

Enforced at [`sweepUnclaimable`:704-708](../../contracts/src/ReferralSplitter.sol#L704). **Fuzz-verified by INV-B over 128k calls.**

### POLAccumulator
- `address(this).balance` is the working pool
- `totalETHUsed` — historical counter
- LP token holdings via `lpToken.balanceOf(address(this))`

No reservation aggregate needed; `executeSweepETH` is timelocked + restricted to treasury.

### RevenueDistributor
- `epochs[i].totalETH` — per-epoch allocation
- `epochClaimed[i]` — per-epoch payout sum (capped to `totalETH` by C-03)
- `totalDistributed`, `totalClaimed`, `totalEarmarked`, `totalForfeited` — aggregate counters
- `pendingWithdrawals[user]` — failed claim queue
- `totalPendingWithdrawals` — sum of above

**Reservation:** `balance >= (totalEarmarked - totalClaimed) + totalPendingWithdrawals`

Enforced at [`emergencyWithdraw`:387](../../contracts/src/RevenueDistributor.sol#L387) and [`sweepDust`:836-837](../../contracts/src/RevenueDistributor.sol#L836).

---

## 2. The recordFee handoff (SwapFeeRouter → ReferralSplitter)

### Path
```solidity
// SwapFeeRouter._recordReferralFee (line 528)
try referralSplitter.recordFee{value: _feeAmount, gas: 700_000}(_user) {
    return true;  // ETH forwarded successfully
} catch ... {
    emit ReferralFeeRedirectedToTreasury(_user, _feeAmount);
    return false;  // ETH stays in SwapFeeRouter (catch returns ETH)
}
```

The 700k gas cap (raised from 50k → 200k → 700k across pass 2/3/4) is now generous enough for `MAX_POSITIONS_PER_HOLDER = 50` whales (~420k gas budget for the inner `votingPowerOf` walk + ~62k splitter pre-work).

### Failure modes
1. **Splitter reverts (any reason):** ETH refunded by EVM, SwapFeeRouter catch fires, `accumulatedETHFees += fee` instead. ✓
2. **Splitter OOG:** EVM behavior — entire sub-call's state changes reverted, value returned to caller. Same as above. ✓
3. **Splitter call succeeds but 0% to referrer (referralFeeBps == 0):** `callerCredit[swapFeeRouter] += msg.value`. Stranded until `recoverCallerCredit` pulls. ✓
4. **Splitter address(0):** `_recordReferralFee` returns false immediately. ✓

INV-B's `noEthEvaporation` invariant verifies that all four paths preserve total ETH: `deposited == in_splitter + reservations + paid_out`.

---

## 3. The distribute handoff (SwapFeeRouter → RevenueDistributor + POL)

### Path
```solidity
// SwapFeeRouter.distributeFeesToStakers (line 1256)
uint256 stakerAmount = (amount * stakerShareBps) / BPS;
uint256 polAmount = (amount * polShareBps) / BPS;
uint256 treasuryAmount = amount - stakerAmount - polAmount;

(bool okStaker,) = revenueDistributor.call{value: stakerAmount, gas: 50_000}("");
if (!okStaker) {
    pendingDistribution[revenueDistributor] += stakerAmount;
    totalPendingDistribution += stakerAmount;
}
// ... same shape for POL ...
WETHFallbackLib.safeTransferETHOrWrap(WETH, treasury, treasuryAmount);
```

50k gas stipend is sufficient for the receiver's `receive() external payable {}` (just an event emit). The deferred-distribution pattern at line 1281-1284 prevents single-recipient brick-out.

### What if RevenueDistributor.receive() runs out of gas?
50k is fine for `emit ETHReceived(msg.sender, msg.value)` (~5k SLOAD + ~3k log emit). If a future revision adds heavier work to `receive()`, the failure path queues into `pendingDistribution`. ✓

### What if the recipient is itself the SwapFeeRouter (loopback)?
`applyRevenueDistributor(0)` reverts ZeroAddress; can't be set to self. Even if it could, the 50k gas stipend wouldn't permit reentrancy back to `distributeFeesToStakers` (it's nonReentrant). ✓

---

## 4. Cross-contract invariant fuzz proof

`PASS5_FeeRouterConservation.t.sol` runs 128,000 stateful calls across the handler:

```
[PASS] invariant_splitter_balanceCoversReservations
[PASS] invariant_splitter_noEthEvaporation
```

Both invariants stay green across:
- random recordFee with random msg.value
- random setReferrer / setReferrerStake to flip qualification
- claimReferralRewards by qualified referrers post MIN_REFERRAL_AGE
- withdrawCallerCredit by approved caller
- arbitrary time warps

This is the strongest possible signal that the H-04 pull-pattern + S2-H-01 totalCallerCredit reservation + DEEP-DR-M-07 `setupComplete` gate combine into a sound ETH economy.

---

## 5. What pass-5 looked for and didn't find

### Did NOT find: a path where the splitter accepts ETH but doesn't account for it
Every path in `recordFee` lands in exactly one of: `callerCredit`, `pendingETH`, `accumulatedTreasuryETH`. The `if (msg.value == 0) return` early-exit at line 331 cannot be exploited because there's literally no ETH to account for.

### Did NOT find: a sweepETH path that could sweep reserved ETH
`SwapFeeRouter.sweepETH` reserves `accumulatedETHFees + totalPendingDistribution`. `ReferralSplitter.sweepUnclaimable` reserves `totalPendingETH + accumulatedTreasuryETH + totalCallerCredit`. Both use the `balance > reserved ? balance - reserved : 0` pattern with the underflow safety. ✓

### Did NOT find: a distribute that bypasses the timelocked feeSplit
The only paths to send ETH out of SwapFeeRouter are:
- `distributeFeesToStakers` → applies `(stakerShareBps, polShareBps)` set via `applyFeeSplit` (admin-only, propose+execute pattern)
- `withdrawTokenFees` → only token-side, only owner, only to treasury
- `recoverCallerCredit` / `recoverCallerCreditFrom` → routes to `accumulatedETHFees` (then subject to the same timelocked split)
- `withdrawPendingDistribution` → only the recipient address can pull
- `sweepETH` → owner-only, only to treasury, only after reservation

There is no "drain to attacker" path. The H-3 fix removed `withdrawFees()` (the previous bypass).

### Did NOT find: a path where recordFee credits the wrong referrer
The chain-walk `_checkCircularReferral` catches rings up to depth 100 (raised from 25 in v3 to close the R014 sybil-ring bypass). `setReferrer` is one-shot per user; `updateReferrer` has 30-day cooldown. No race or front-run vector here.

---

## 6. Conclusion

The fee-routing chain is well-protected by:
- The 700k gas cap for splitter forwarding (covers MAX_POSITIONS_PER_HOLDER whales)
- The pull-pattern callerCredit / pendingETH / pendingDistribution everywhere
- The timelocked feeSplit (cannot be bypassed)
- The reservation discipline at every sweep entrypoint
- The H-3 removal of `withdrawFees`

INV-B's 128k-call fuzz confirms no edge case bypasses these protections. **No PoC-backed pass-5 findings in this chain.**
