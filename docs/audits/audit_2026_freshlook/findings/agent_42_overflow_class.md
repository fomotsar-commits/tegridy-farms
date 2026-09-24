# Agent 42 — Integer Overflow / Underflow / Downcast Audit

**Lens**: Integer Overflow / Underflow / Downcast across all `contracts/src/` Solidity contracts
**Date**: 2026-05-07
**Scope**: 31 contracts + 4 libs (excluding *.md history)

## Methodology

1. Grep'd every `unchecked { ... }` block, `uintN(value)` cast, `type(uintN).max` sentinel, `int128 -x` negation, and all packed struct slots.
2. Checked mathematical bounds vs. configured constants and realistic input domains.
3. Verified that wrapping (V2 cumulative-price pattern) is intentional vs. silent-bug.
4. Cross-checked OZ Math.mulDiv usage to confirm 512-bit intermediates rule out apparent overflows.

---

## F-42-1 — `int128(-int128.min)` self-revert in `TegridyFeeHook.afterSwap` (LOW / DoS)

**File**: `contracts/src/TegridyFeeHook.sol:382`
**Vulnerable expression**: `if (swapAmount < 0) swapAmount = -swapAmount;`
**Type**: `int128` negation, checked-math (Solidity ≥0.8).

**Class**: signed-integer downcast / negation overflow.

**Trigger input**: A V4 `BalanceDelta` whose `amount0()` or `amount1()` resolves to exactly `type(int128).min` (-2^127). In checked math, `-(-2^127)` overflows the int128 range and reverts with `Panic(0x11)`.

**Reachability**:
- The PoolManager packs deltas as `int128` halves of a `BalanceDelta`. A swap that consumes/produces exactly 2^127 raw units of one side hits this.
- 2^127 ≈ 1.7e38 raw token units. For an 18-decimal token that is ≈1.7e20 whole tokens — absurdly far above the `int256 amountSpecified` realistic envelope. For a low-decimal token the bar is lower but still well outside any organic flow.
- Reachable only with bespoke malformed-delta tokens (custom token contracts that lie about their own decimals/supply during a `unlock` callback).

**Consequence**: `afterSwap` reverts; the entire pool swap reverts. Single-pair griefing only — every other pool whose hook isn't this one keeps working. The contract already returns `int128(0)` on `paused()` / unapproved pool / zero-delta to *avoid* bricking organic flow, so this represents a missed edge case in the same defensive pattern.

**Suggested fix**: Wrap the negation in `unchecked { ... }` or use explicit `swapAmount = swapAmount == type(int128).min ? type(int128).max : -swapAmount;`. Severity is LOW because (a) the input is contrived, (b) the failure mode is revert (no value siphoned), and (c) the protocol already documents in the file that "reverting would block ALL pool swaps" — so the missing guard is more a stylistic inconsistency than a live exploit.

---

## F-42-2 — `consult()` checked-math overflow on extreme-decimals pairs (LOW / DoS)

**File**: `contracts/src/TegridyTWAP.sol:553`
**Vulnerable expression**: `amountOut = (amountIn * priceDiff) / (uint256(elapsed) * Q112);`
**Type**: uint256 multiplication in checked context.

**Class**: cumulative-price multiply before divide.

**Trigger input**: A pair with extreme decimal mismatch (e.g., a 24-decimal exotic token paired with USDC at 6 decimals — spot ratio ≈ 1e18 in raw form, multiplied by Q112 ≈ 2^112 yields per-second contribution of ~2^172). Over the maximum 12 h consult window, `priceDiff ≈ 2^188`. With `amountIn` of 1k whole tokens (≈ 2^80), `amountIn * priceDiff ≈ 2^268` → checked-math overflow → revert.

**Reachability**:
- `priceDiff` is `priceCumEnd - priceCumStart`, computed `unchecked` (line 550-552), which correctly models the V2 wrapping accumulator.
- The subsequent multiply on line 553 is **NOT** wrapped in `unchecked` — by design, since the result is the user-visible quote, but it inherits an overflow-revert mode from any priceDiff that didn't actually wrap.
- A "normal" 18:18 decimal pair stays well below uint256 even at MAX_OBSERVATIONS × MIN_PERIOD = 12 h. The DoS is bounded to "exotic-decimal pairs that someone listed".

**Consequence**: `consult()` reverts on extreme-mismatch pairs even when reserves are healthy. Downstream consumers (TegridyLending oracle floor, POL accumulator, lending ETH valuation) hit fail-closed paths. Not a value-loss exploit — but a structural DoS surface for any extreme-decimal-mismatch listing.

**Suggested fix**: switch line 553 to `Math.mulDiv(amountIn, priceDiff, uint256(elapsed) * Q112)` so the OZ 512-bit intermediate handles any priceDiff size up to uint256.max without checked-math revert.

---

## F-42-3 — `unchecked` cumulative addition in `TegridyTWAP.update()` is intentional but undocumented for the bridging term (NOTE / DESIGN)

**File**: `contracts/src/TegridyTWAP.sol:319-330`
**Vulnerable expression**:
```
unchecked {
    elapsedSinceLastPairTouch = blockTs - pairBlockTs; // uint32 modular subtraction (correct)
}
...
unchecked {
    price0Cumulative = pairCum0 + (spotPrice0 * uint256(elapsedSinceLastPairTouch));
    price1Cumulative = pairCum1 + (spotPrice1 * uint256(elapsedSinceLastPairTouch));
}
```

**Type**: uint256 modular addition + uint256 multiplication wrapped in `unchecked`.

**Class**: Uniswap V2 pattern compatibility — confirmed intentional.

**Reachability**: Always taken on every `update()` call.

**Consequence**:
- The `unchecked` on the addition (line 326-330) is the V2 modular wrapping accumulator — consumers compute differences which remain correct under modulo 2^256. **Intentional.**
- BUT: `spotPrice0 * uint256(elapsedSinceLastPairTouch)` itself happens **inside** `unchecked`. With reserve0 = uint112.max and reserve1 = uint112.max, `spotPrice0 = (reserve1 * Q112) / reserve0` ≤ 2^224, then `× elapsedSinceLastPairTouch ≤ 2^32` = 2^256. So the multiply on its own can wrap. This is *also* by design but worth flagging because:
  - The wrap is asymmetric: `pairCum0 + wrapped_term` ≠ `pairCum0 + intended_value`. Consumers reading `priceCumEnd - priceCumStart` then "see" a phantom large step.
  - For sane real-world reserves this never reaches 2^256, but a malicious pair (impossible here — `factory.isPair` gate authenticates) or a real pair with a uint112.max-style donation attack could feed in a manipulated cumulative pre-update, then have the bridging term wrap on top.
  - The NEW-A1 FoT-output guard and the disabled-pair gate together prevent the pair from entering this state via swaps. So the realistic attack surface is bounded to direct pair-creator donation + immediate `sync()` — already gated by `disabledPairs` / `blockedTokens`.

**Suggested action**: NONE. Documented here for completeness. The pattern is canonical V2 and the bounds stay realistic on any factory-authenticated pair. Mentioned only because future maintainers may not realise the multiply leg is trusted-by-bound rather than trusted-by-construction.

---

## F-42-4 — `_getCumulativePricesOverPeriod` ring-buffer index uint8 wrap is bounded (NEGATIVE — verified safe)

**File**: `contracts/src/TegridyTWAP.sol:715-718`
**Expression**:
```
uint8 checkIdx = latestIdx >= uint8(i)
    ? latestIdx - uint8(i)
    : MAX_OBSERVATIONS - uint8(i - latestIdx);
```

**Verification**:
- `i` ∈ [1, effectiveCount), and `effectiveCount ≤ MAX_OBSERVATIONS = 48`. So `uint8(i)` ≤ 47, fits in uint8.
- Else branch: `latestIdx < i`, so `i - latestIdx > 0`. Worst-case `i - latestIdx = i ≤ 47`, then `uint8(47) ≤ MAX_OBSERVATIONS = 48`, so `MAX_OBSERVATIONS - uint8(...) ≥ 1`. No checked-math underflow.

**Result**: Safe. Filed under "verified clean" so future agents don't re-flag.

---

## F-42-5 — `staleness = uint32(block.timestamp % 2^32) - latest.timestamp` correctly wraps (NEGATIVE — verified safe)

**Files**:
- `contracts/src/TegridyTWAP.sol:699-704` (canUpdate / consult staleness)
- `contracts/src/TegridyTWAP.sol:707-710` (target wraparound)
- `contracts/src/TegridyPair.sol:438-444` (pair-side timeElapsed)
- `contracts/src/SwapFeeRouter.sol:1937-1945, 2003-2007` (TWAP-floor elapsed)

**Pattern**: Always casts `block.timestamp % 2^32` to uint32 BEFORE subtracting `last.timestamp` (also uint32), inside `unchecked { }`. This is the year-2106 wrap-safe pattern from V2 — earlier versions of the codebase had a `uint256 - uint32` mismatch that broke at the rollover. All sites now follow the canonical pattern. Documented in the codebase comments at each site (`R012 H-3 / M-1`, `BATCH-I M5`, etc.).

**Result**: Safe.

---

## F-42-6 — `RevenueDistributor.receive()` `unchecked { totalETHReceived += msg.value; }` (NEGATIVE — verified safe)

**File**: `contracts/src/RevenueDistributor.sol:316`
**Pattern**: `msg.value` ≤ available ETH supply ≈ 1.2e26 wei. `totalETHReceived` would need 1e51 cumulative wei to overflow uint256 — physically impossible across the chain's lifetime.

**Result**: Safe — the `unchecked` is a gas optimisation, not an attack surface.

---

## F-42-7 — `uint16(boost)` cast in `TegridyStaking._applyNewBoost` and `stake/stakeWithBoost` is bounded (NEGATIVE — verified safe)

**Files**: `contracts/src/TegridyStaking.sol:757, 809, 2014`
**Pattern**: `uint16(boost)` where `boost ≤ MAX_BOOST_BPS + JBAC_BONUS_BPS = 40000 + 5000 = 45000`. uint16 max = 65535.

**Note**: The `BoostOverflow()` revert at line 2013 is defense-in-depth — verified that no code path can drive `boost` above ~45000.

**Result**: Safe.

---

## F-42-8 — `uint64(block.timestamp + _lockDuration)` lock-end cast (NEGATIVE — verified safe)

**Files**: `contracts/src/TegridyStaking.sol:756, 808, 863, 906, 942, 1032`
**Pattern**: `block.timestamp` realistic ≤ 2^33; `_lockDuration ≤ MAX_LOCK_DURATION = 4 × 365 days ≈ 2^27`. Sum ≤ 2^34, well below uint64 max ≈ 1.8e19.

**Result**: Safe — no risk of uint64 wrap until year ≈ 584 billion.

---

## F-42-9 — `uint32(_lockDuration)` and `uint32(MAX_LOCK_DURATION)` casts (NEGATIVE — verified safe)

**Files**: `contracts/src/TegridyStaking.sol:758, 810, 864, 905, 1033`
**Pattern**: `MAX_LOCK_DURATION = 4 × 365 days = 126,144,000 seconds`. uint32 max = 4,294,967,295. Headroom 34×.

**Result**: Safe.

---

## F-42-10 — `uint96(COMMIT_BOND)` cast in `VoteIncentives.commitVote` (NEGATIVE — verified safe)

**File**: `contracts/src/VoteIncentives.sol:1541`
**Pattern**: `COMMIT_BOND = 10e18` wei. uint96 max ≈ 7.9e28. Headroom 7.9e9×.

**Result**: Safe.

---

## F-42-11 — `uint64(totalPausedDuration)` cast in `TegridyNFTLending.acceptOffer` (NEGATIVE — verified safe)

**File**: `contracts/src/TegridyNFTLending.sol:575`
**Pattern**: `totalPausedDuration` is cumulative wall-clock seconds the lending contract was paused. uint64 max ≈ 1.8e19 seconds = 584 billion years. Even if the protocol is paused 100% of the time it can never realistically saturate uint64.

**Result**: Safe.

---

## F-42-12 — `SafeCast.toUint208(totalBoostedStake)` in checkpoint writes (NEGATIVE — verified safe)

**Files**: `contracts/src/TegridyStaking.sol:587, 1548`
**Pattern**: `totalBoostedStake` ≤ 4.5 × total_supply = 4.5 × 1e27 ≈ 2^92. uint208 max ≈ 4.1e62. Headroom 2^115.

**Result**: Safe.

---

## F-42-13 — `_getBuyPriceFull` / `_getSellPriceFull` linear curve overflow bounds (NEGATIVE — verified safe)

**File**: `contracts/src/TegridyNFTPool.sol:825, 857`
**Expression**: `numItems * spotPrice + delta * numItems * (numItems - 1) / 2`
**Bounds**:
- `numItems ≤ 100` (enforced at lines 270, 339).
- `spotPrice ≤ MAX_SPOT_PRICE = 1,000,000 ether ≈ 1e24`.
- `delta ≤ MAX_DELTA = 10 ether = 1e19`.
- Worst case: `100 × 1e24 = 1e26` (first term) + `1e19 × 100 × 99 / 2 ≈ 5e22` (second term) = ~1e26.
- uint256 max ≈ 1.16e77 — headroom 1e51×.

**Result**: Safe by design. The `MAX_SPOT_PRICE` cap was added explicitly to make `100 * spotPrice` safe — see comment at line 109-110.

---

## F-42-14 — `lending.calculateInterest` `_principal * _aprBps` checked-math behaviour (NEGATIVE — verified safe)

**Files**: `contracts/src/TegridyLending.sol:1494; TegridyNFTLending.sol:934, 948`
**Bounds**:
- `principal ≤ MAX_PRINCIPAL_CEILING = 100,000 ether = 1e23` (TegridyLending) / `MAX_PRINCIPAL = 1,000 ether = 1e21` (NFTLending).
- `aprBps ≤ maxAprBps = 50000`.
- Product ≤ `1e23 × 5e4 = 5e27`. uint256 max ≈ 1.16e77.
- Subsequent `Math.mulDiv(product, elapsed, BPS × SECONDS_PER_YEAR)` uses 512-bit intermediates — no overflow path.

**Result**: Safe.

---

## F-42-15 — `_dutchAuctionPriceWithoutSequencerCheck` underflow possibility (NEGATIVE — verified safe)

**File**: `contracts/src/TegridyDropV2.sol:645`
**Expression**: `uint256 priceDrop = dutchStartPrice - dutchEndPrice;`
**Verification**: Initialise enforces `if (p.dutchStartPrice <= p.dutchEndPrice) revert InvalidDutchAuctionConfig();` (line 424). Pending dutch-config rotations follow the same gate. So `dutchStartPrice > dutchEndPrice` always. `priceDrop` cannot underflow.

**Result**: Safe.

---

## F-42-16 — Solady / OZ libraries: SafeCast + Math.mulDiv usage is correct (NEGATIVE — verified safe)

**Pattern**: Every cumulative-style multiplication that could overflow if naive (e.g. lending interest `principal × apr × elapsed`, restaking `boost × accBonusPerShare`, RevenueDistributor `epoch.totalETH × effectivePower`) uses **OZ Math.mulDiv** which has a 512-bit intermediate. SafeCast is used at every storage-narrowing point (Trace208 push/upperLookup). No silent truncation paths found.

**Result**: Safe.

---

## F-42-17 — `int128(uint128(swapAmount))` in `TegridyFeeHook.afterSwap` (NEGATIVE — verified safe)

**File**: `contracts/src/TegridyFeeHook.sol:402-403`
**Expression**: `require(feeUint <= uint128(type(int128).max), "FEE_OVERFLOW"); int128 feeAmount = int128(uint128(feeUint));`

**Verification**: The `require` explicitly bounds `feeUint ≤ type(int128).max = 2^127 - 1` BEFORE the cast. The double-cast `uint128(uint256_val)` then `int128(uint128_val)` is the canonical safe path for narrowing a positive uint into an int of half-width — same bit pattern, never sign-flips because the high bit is gated to zero.

**Result**: Safe.

---

## F-42-18 — Stalkable `unchecked` blocks audited for completeness (NEGATIVE — list verified)

Total `unchecked` blocks found across `contracts/src/`:

| File | Lines | Verdict |
| --- | --- | --- |
| `TegridyTWAP.sol` | 319, 326, 367, 550, 570, 700, 707, 729, 800 | All V2 modular subtraction or wrapping accumulator — correct. |
| `TegridyPair.sol` | 440, 448 | V2 timeElapsed + wrapping price accumulators — correct. |
| `TegridyNFTLending.sol` | 573 (comment only) | No `unchecked` block at this site; comment refers to compiler-level cast; actual `uint64(totalPausedDuration)` is checked. |
| `RevenueDistributor.sol` | 316 | Trivially-safe ETH-receipt counter. |
| `SwapFeeRouter.sol` | 1938, 1942, 2005, 2023 | uint32 modular subtraction + paired wrap-safe priceDiff calc — correct V2 pattern. |
| `lib/SequencerCheck.sol` | 145, 163, 214, 221, 289, 296, 342 | All gated by directional checks (`if updatedAt > block.timestamp`) BEFORE the unchecked subtraction — correct. |

**Result**: All `unchecked` blocks are either V2-pattern modular arithmetic (intentional wrap) or have a preceding directional/range check that rules out the underflow.

---

## Notes / Dead-ends

- **Cross-pair price oracle wrap window (R014 V2 pattern)**: The TWAP cumulative wraps at 2^256, NOT at uint224 like classic Uniswap V2. The contract widened this deliberately (commented at line 86-91 of TegridyTWAP.sol). All consumer reads compute differences inside `unchecked { }` blocks. Verified that no consumer reads a cumulative directly without subtracting from a paired observation.

- **uint112 reserves vs uint256 balance**: `_update` requires `balance0 ≤ type(uint112).max && balance1 ≤ type(uint112).max`. Tokens with supply exceeding ~5.19e33 raw units cannot be paired here — this is documented at line 421. NOT an exploit, design constraint.

- **`swapAmount = -swapAmount` on int128**: The `type(int128).min` self-revert (F-42-1) is the only "live" finding among 18 cases inspected. Every other site is either validated against a configured cap (boost/lock/fees), gated by SafeCast, or designed-as-modular per V2 semantics.

- **No reward index overflow**: rewardPerTokenStored, accBonusPerShare, etc. all use ACC_PRECISION = 1e18 with realistic-bound rewardRate ≤ 100e18. Long-horizon (1000+ years) overflow surface absent; documented at TegridyStaking.sol:2105-2107.

- **No UQ112x112 truncation**: Unlike classic V2, this codebase stores cumulative slots as uint256 (line 86-91 of TegridyTWAP.sol). Truncation surface eliminated.

- **No int↔uint sign-flip via abi.decode**: No `abi.decode(data, (int...))` in user-supplied paths inspected. The closest is V4 `BalanceDelta` decoding from PoolManager, where the bounds are pre-validated by the manager itself.

- **Explored but no finding**: TegridyRouter, TegridyFactory, GaugeController, MemeBountyBoard, PremiumAccess, ReferralSplitter, Toweli — no `unchecked` blocks; all narrow casts go through OZ SafeCast or have preceding range checks.

---

## Summary

**Findings opened**:
- F-42-1 (LOW / DoS): `int128 -x` self-revert in `TegridyFeeHook.afterSwap` for `type(int128).min` deltas.
- F-42-2 (LOW / DoS): `consult()` checked-math overflow on extreme-decimals pairs (priceDiff × amountIn before division).

**Findings closed (verified safe)**: F-42-3 through F-42-18.

**Critical / High / Medium**: NONE. The integer-overflow surface on this codebase is unusually small and well-defended — every site uses either OZ Math.mulDiv (512-bit intermediates), SafeCast (revert-on-narrow), or canonical V2 wrapping patterns with explicit `unchecked` annotations.

**Path**: `.audit_2026_freshlook/findings/agent_42_overflow_class.md`
