# Agent 61 — Rounding / Precision Loss / Dust Accumulation Audit

**Lens:** Rounding direction, precision loss, dust accumulation, share/asset conversion, BPS math, decimal scaling, liquidation/penalty math, mul-then-div precision.

**Scope:** All Solidity in `contracts/src/`.

**Method:** Grepped every `Math.mulDiv*`, `* / *`, `/ BPS`, `/ 10000`, `/ totalSupply`, `/ ACC_PRECISION` site, then read each in context to determine: who benefits from the rounding direction, whether dust is recoverable, whether `mulDiv` can round to zero for legitimate inputs.

---

## Findings

### F-61-1 — LP Farming reward-rate truncation strands dust each cycle (LOW, accepted-design)

**File:** `contracts/src/TegridyLPFarming.sol:481, 484`

```
rewardRate = actualReward / duration;
// or
rewardRate = (leftover + actualReward) / duration;
```

**Math:** `actualReward = N`, `duration = D`. `rewardRate = floor(N/D)`. Effective reward emitted over period = `D * floor(N/D) <= N`. Dust = `N mod D`, retained in contract balance.

**Direction:** Floors against stakers (they receive less than the full notified amount).

**Exploit/dust:** With max `MAX_REWARDS_DURATION = 90 days = 7,776,000 seconds`, up to ~7.78M wei stranded per call. `recoverERC20` blocks the reward token (line 559), and the leftover from the next `notifyRewardAmount` only carries the active rate × remaining time, so the truncation residue is structurally orphaned. `forfeitedRewards` only accounts for `emergencyWithdraw` forfeitures, NOT for divisor truncation.

**Severity:** LOW. The standard Synthetix pattern; per-cycle dust is bounded ~7.78M wei = 7.78e-12 TOWELI. Over ~10 years of weekly cycles ≈ 4 microTOWELI total. Worth flagging but not exploitable.

---

### F-61-2 — NFT Pool buyer/seller fees floor in user's favor (LOW)

**File:** `contracts/src/TegridyNFTPool.sol:830, 833, 860, 863`

```
lpFee       = baseCost  * feeBps         / BPS;   // floor
protocolFee = baseCost  * protocolFeeBps / BPS;   // floor
lpFee       = basePayout * feeBps         / BPS;  // floor
protocolFee = basePayout * protocolFeeBps / BPS;  // floor
```

**Math:** All four fee divisions floor.

**Direction:**
- **Buy path** (line 834): `inputAmount = baseCost + lpFee + protocolFee` — flooring fees REDUCES what the buyer pays. Favors user.
- **Sell path** (line 864): `outputAmount = basePayout - lpFee - protocolFee` — flooring fees INCREASES what the seller receives. Favors user.

**Exploit:** Per-trade dust of up to `feeBps + protocolFeeBps - 1` wei extracted from LP/protocol per swap. With many small swaps, attacker can split a large trade into many 1-wei-per-trade savings. Not lucrative on mainnet gas, but on L2 (Base) with gas <0.001¢ this becomes economic for high-frequency MEV.

**Mitigation:** Round fees UP (`Math.mulDiv(baseCost, feeBps, BPS, Math.Rounding.Ceil)`) or floor `outputAmount` directly via `outputAmount = (basePayout * (BPS - feeBps - protocolFeeBps)) / BPS` to bias the rounding into the protocol's favor.

**Severity:** LOW.

---

### F-61-3 — Lending repay: protocol fee on interest floors in lender's favor (LOW)

**File:** `contracts/src/TegridyLending.sol:1082`

```
uint256 fee = (interest * effectiveFeeBps) / BPS;
uint256 lenderAmount = principal + interest - fee;
```

**Math:** `interest` is computed via `Math.Rounding.Ceil` (good — favors protocol). But the protocol-fee split `fee = floor(interest * feeBps / BPS)` floors. So treasury gets dust LESS, lender gets dust MORE.

**Direction:** Favors lender (≈ user) over treasury (≈ protocol).

**Exploit/dust:** Per-loan dust of up to `feeBps - 1` wei (e.g., for `protocolFeeBps = 500`, up to 499 wei per loan). Across thousands of loans, accumulates as a ~free shaving for lenders.

**Mitigation:** `fee = Math.mulDiv(interest, effectiveFeeBps, BPS, Math.Rounding.Ceil)`. Same fix mirrored in `TegridyNFTLending.sol:689`.

**Severity:** LOW.

---

### F-61-4 — VoteIncentives bribe shares: dust permanently locked (DOCUMENTED)

**File:** `contracts/src/VoteIncentives.sol:818`

```
uint256 share = (bribeAmount * userVoteForPair) / totalVotesForPair;
```

**Math:** Standard pro-rata floor. `sum(shares) <= bribeAmount`. Dust = `bribeAmount - sum(shares)`.

**Direction:** Favors no one — dust is locked in contract permanently. Comment at lines 847-848 acknowledges: *"the dust budget — it belongs to no one and is permanently locked in the contract"*.

**Exploit/dust:** Per-(epoch, pair, token) triple, up to `voters - 1` wei locked. Across many triples this sums substantially. The `sweepToken` path is gated to NEVER touch this dust by `totalClaimedBribes` accounting.

**Severity:** DESIGNED — but flagged because the dust is permanent and accumulating. A dedicated `sweepDust(epoch, pair, token)` callable AFTER the claim grace window (e.g., 1 year) closes, sending `bribeAmount - totalClaimedBribes[epoch][pair][token]` to treasury, would recover this. Pattern of record: Aerodrome's `BribeVotingReward.notifyRewardAmountForToken` reset.

---

### F-61-5 — GaugeController vote allocation floors per-gauge (LOW)

**File:** `contracts/src/GaugeController.sol:392, 657`

```
uint256 allocatedPower = (votingPower * weights[i]) / BPS;
```

**Math:** Per-gauge weight allocation. `weights` MUST sum to BPS (line 382), so `sum(votingPower * weight_i / BPS)` should equal `votingPower`. But each individual division floors, so `sum(allocated)` = `votingPower - dust` where `dust < gauges.length` wei.

**Direction:** Lost voting power (effectively favors no gauge — depresses ALL of the user's allocations slightly).

**Exploit:** A user's effective voting weight is reduced by up to `gauges.length - 1` wei. With small voting power and many gauges, the user's emission slice rounds to zero on every gauge — they consume gas with zero economic effect.

**Severity:** LOW. Bounded by gauge count.

---

### F-61-6 — TegridyLPFarming has no minimum stake (LOW)

**File:** `contracts/src/TegridyLPFarming.sol` — no `MIN_STAKE` constant, unlike `TegridyStaking.MIN_STAKE = 100e18`.

**Math:** A user can call `stake(1)` (1 wei of LP). With `boostBps = BASE_BOOST_BPS (10000)`, `effective = (1 * 10000) / 10000 = 1`. Position eligible for rewards.

**Direction:** Per-user dust accumulation. Each tiny staker adds 1 wei to `totalEffectiveSupply` denominator — over many such stakers the denominator inflates, diluting honest stakers' shares.

**Exploit:** Sybil dilution: attacker forks 10,000 EOAs with `stake(1)` each, growing `totalEffectiveSupply` by 10,000 wei. Per-user reward `earned = effective * (rewardPerToken - userPaid) / 1e18`. With `effective = 1`, every accrual rounds to 0 (assuming `rewardPerToken delta < 1e18`). Attacker spent gas for zero reward, but they **did** dilute the denominator → all other stakers lose the diluted slice. Cost: 10,000 × 80,000 gas ≈ 800M gas (~$8 on Base @ 1 gwei). Not economic at typical TVL but pollutes accounting.

**Severity:** LOW.

**Mitigation:** Add `MIN_STAKE` (e.g., 1e15 wei = 0.001 LP) to match the staking contract's defense.

---

### F-61-7 — `_getEffectiveBalance` floors boost on tiny stakes (INFO)

**File:** `contracts/src/TegridyLPFarming.sol:287-294`

```
uint256 boostBps = ...;
return (rawAmount * boostBps) / BOOST_PRECISION;  // floor
```

**Math:** With `rawAmount = 1`, `boostBps = 14999` (~1.5x), `effective = floor(1 * 14999 / 10000) = 1`. The boost is silently dropped.

**Direction:** User loses boost on micro-stakes.

**Exploit:** None — simply pushes minimum-economic-stake threshold above 1 wei. Inelegant but not exploitable.

**Severity:** INFO.

---

### F-61-8 — POL Accumulator TWAP-floor rounds to zero on micro-LP (INFO)

**File:** `contracts/src/POLAccumulator.sol:945-949`

```
uint256 shareToken = (lpAmount * fairToweli) / totalSupply;     // floor
uint256 shareETH   = (lpAmount * fairEth)    / totalSupply;     // floor
floorToken = (shareToken * (BPS - TWAP_SAFETY_BPS)) / BPS;       // floor
floorETH   = (shareETH   * (BPS - TWAP_SAFETY_BPS)) / BPS;       // floor
```

**Math:** Cascading floor on a small `shareToken/shareETH` can yield 0, defeating the per-leg TWAP-safety floor. The user-supplied min remains, so this is defense-in-depth only — but it means the *system* floor offers no protection on micro-harvests.

**Direction:** Defense-in-depth disabled on micro-LP burns.

**Exploit:** Only matters if `lpAmount * fairX < totalSupply`. With `lpAmount = 1` and a 10M-unit LP supply, sharefXxx = 0, floors = 0. Caller's `minToken/minETH = 0` would then leave the call sandwich-able. But `removeLiquidityETH` would also return tiny amounts, capping the attacker's profit.

**Severity:** INFO. The `totalLPCreated * MAX_HARVEST_BPS / 10000` cap (line 639) limits per-call harvest proportion, so micro-harvests aren't reachable in practice.

---

### F-61-9 — TegridyStaking `_getReward` accumulator dust per accrual (INFO)

**File:** `contracts/src/TegridyStaking.sol:686, 2209`

```
rewardPerTokenStored += (reward * ACC_PRECISION) / _totalBoosted;
// and
rewardPerTokenStored += (amount * ACC_PRECISION) / totalBoostedStake;
```

**Math:** Each `_accumulateRewards` cycle leaves `(reward * ACC_PRECISION) mod _totalBoosted` wei of `reward` unaccounted in `rewardPerTokenStored`. With ACC_PRECISION = 1e18, dust per accrual is `< _totalBoosted / 1e18` of `reward` — at 1B-unit total stake, loss per accrual is `< 1e9 / 1e18 = 1e-9` of reward. Sub-wei.

**Direction:** Dust stays in contract; not credited to anyone.

**Severity:** INFO. ACC_PRECISION = 1e18 is the modern standard (Synthetix, AAVE). Negligible.

---

### F-61-10 — Lending pro-rata escrow payout uses Floor with `owed - payout` carryforward (DESIGNED)

**File:** `contracts/src/TegridyLending.sol:1886`

```
payout = Math.mulDiv(owed, available, total, Math.Rounding.Floor);
```

**Math:** Floor rounding is correct here for solvency: `sum(payouts) <= available`. Dust carries forward via line 1892 (`escrowRewardsOwed[_loanId] = owed - payout`), so user can re-claim later when more rewards arrive. Eventually paid in full.

**Direction:** Correct — protocol favored on each call, user made whole over time.

**Severity:** DESIGNED. Confirming this is intentional.

---

### F-61-11 — POLAccumulator `Math.sqrt(K * toweliUnit / twap)` can hit zero before sqrt (LOW)

**File:** `contracts/src/POLAccumulator.sol:941`

```
uint256 fairToweli = Math.sqrt((K * toweliUnit) / twapEthPer1eToweli);
```

**Math:** If `K * toweliUnit < twapEthPer1eToweli`, the inner division returns 0, then `sqrt(0) = 0`. Defended by `if (fairToweli == 0) revert OracleStale()`. But this conflates *price impossibly high* with *oracle stale* in the error message — not a real precision bug.

**Direction:** Reverts cleanly, no economic impact.

**Severity:** INFO (cosmetic — error message accuracy).

---

### F-61-12 — `_splitPenalty` ceiling rounds in stakers' favor — verified correct (NOTED)

**File:** `contracts/src/TegridyStaking.sol:2194, 2157`

```
recycled = numerator == 0 ? 0 : (numerator + BPS - 1) / BPS;
```

**Math:** Ceiling division on penalty recycle. Sub-wei dust on small penalties favors stakers (recycle pool) rather than treasury. Documented as AUDIT M-24.

**Direction:** Favors stakers correctly when `penaltyRecycleBps > 0`.

**Severity:** DESIGNED. Confirmed correct rounding direction.

---

## Notes / Dead-ends

- `TegridyPair.sol:159-160, 189-190` — standard Uniswap V2 mint/burn floor. Dust enriches the LP pool (favors remaining LPs), industry standard.
- `RevenueDistributor.sol:772, 1318, 1407` — `share = (totalETH * power) / totalLocked` floors. Dust carried forward via `epochClaimed[epoch]` and recovered by `autoReconcileDust`. Designed.
- `TegridyTWAP.sol:553` — TWAP price floors. Used as min-out floor → favors protocol. Correct.
- `SwapFeeRouter.sol:760` — `(amountOutMin * BPS + BPS - effectiveFee - 1) / (BPS - effectiveFee)` is **ceiling division** of `amountOutMin * BPS / (BPS - effectiveFee)`. Bias upward correctly tightens slippage protection. Correct.
- `SwapFeeRouter.sol:1321` — `treasuryAmount = amount - stakerAmount - polAmount` recovers all dust into treasury. Correct.
- `ReferralSplitter.sol:363, 372` — `referrerShare` floor + `remainder = msg.value - referrerShare` exact. No dust. Correct.
- `TegridyDropV2.sol:980-981` — same dust-free pattern. Correct.
- `CommunityGrants.sol:318-319` — `nonRefundable = PROPOSAL_FEE / 2; refundable = PROPOSAL_FEE - nonRefundable;` handles odd amounts deterministically. Correct.
- `TegridyNFTPool.sol:825, 857` — `numItems * (numItems - 1) / 2` and `numItems * (numItems + 1) / 2` are always exact (consecutive-integer product is always even). Correct.
- `TegridyLending.sol:783, 897` — origination fee floors → borrower's `effectivePrincipal` rounds up by 1 wei. Tiny user-favored dust, structural.
- `TegridyStaking.sol:994, 1797` — penalty floors → user receives 1 wei of dust per early-withdrawal, structural.
- `TegridyLending.sol:1055, 1548` and `TegridyNFTLending.sol:676, 989` — `flatFloor = (principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS` floors → user pays 1 wei less floor interest. Tiny.
- All `Math.mulDiv(..., Math.Rounding.Ceil)` interest sites in lending use 512-bit intermediate, so no overflow risk. Correct.
- `TegridyFeeHook.sol:389-396` — has explicit 1-wei floor for non-zero feeBps. Correct.

---

## Summary

12 findings total. No CRITICAL or HIGH rounding-direction bugs. All identified rounding biases are bounded sub-wei or low-tens-of-wei per operation, reflecting battle-tested patterns from Synthetix / Curve / Uniswap V2.

The two highest-impact findings are:
1. **F-61-2** — NFT Pool fees floor in user's favor on both buy and sell paths. Fixable with `Math.Rounding.Ceil` on the fee multiplications.
2. **F-61-3** — Lending repay protocol-fee-on-interest floors in lender's favor. Fixable with `Math.Rounding.Ceil`.

The most economically meaningful structural finding is **F-61-4** (VoteIncentives bribe dust permanently locked) — explicitly designed but accumulates across (epoch, pair, token) triples; recommend adding a long-window `sweepDust` callable at e.g. 1 year post-epoch.

No round-to-zero free-action exploits found — all fee paths have either 1-wei floors (TegridyFeeHook, SwapFeeRouter) or use ceiling rounding (lending interest).
