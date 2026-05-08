# Agent 24/100 — TegridyTWAP.sol Fresh-Eyes Exploit Hunt

**Target:** `contracts/src/TegridyTWAP.sol` (~813 lines)
**Related:** `TegridyPair.sol`, `TegridyLending.sol`, `POLAccumulator.sol`, `TegridyFactory.sol`, `lib/SequencerCheck.sol`
**Lens:** TWAP correctness, manipulation cost, observation array, integration safety
**Date:** 2026-05-07

---

## Summary table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| F-24-1 | MEDIUM | Post-resume reserve poisoning: disabled-pair re-enable bridges frozen manipulated spot over disable_duration | NEW |
| F-24-2 | LOW | `minReserveFloor[pair]` applies a single threshold to both reserves — misconfiguration footgun on cross-decimal pairs | NEW |
| F-24-3 | LOW | `lastBypassUsed` is not refreshed for `count <= 2` grace observations — consumer cooldowns can be evaded for the 2nd/3rd observation, but TWAP-side `best.bypassed` revert closes the actual exploit | INFO |
| F-24-4 | LOW | `consult()` revert on `(amountIn * priceDiff)` overflow is a silent DoS for extreme-imbalance pairs; arguably acceptable but undocumented at the public API | INFO |
| F-24-5 | INFO | Year-2106 timestamp-collision: a legitimate observation with `block.timestamp % 2^32 == 0` is treated as an empty slot | DEAD-END |
| F-24-6 | INFO | `getResumeTimestamp` vs uint32 `best.timestamp` — comparison is value-correct today, becomes over-restrictive (fail-closed) post-2106 rollover | DEAD-END |

---

## F-24-1 — Disabled-pair re-enable can bridge frozen manipulated spot into the TWAP cumulative

**Severity:** MEDIUM (conditional on disable event existing during a manipulated state)
**Location:** `TegridyTWAP.sol::update()` lines 266–355; bridging math at lines 312–330

### Setup

`update(pair)` is permissionless. When called, it reads:

1. `factory.isPair(pair)` — provenance check (R014).
2. `factory.disabledPairs(pair)` — refuses observations during disable (FRESH-EYES H-2, line 277).
3. `pair.getReserves()` → current spot `(reserve0, reserve1, pairBlockTs)`.
4. `pair.price0CumulativeLast()` / `price1CumulativeLast()` → frozen pair cumulative.
5. Bridges with `spot * (blockTs - pairBlockTs)` so the cumulative integrates the idle window.

The disable-time guard prevents observations DURING the disable. **It does not prevent the FIRST update *after* re-enable from integrating the frozen-during-disable spot times the entire disable_duration into the cumulative.**

### Flow

```
T1   : last legitimate _update on pair → blockTimestampLast = T1, lastSpot0 set to spot_T1.
T1+5 : attacker pushes reserves via a swap to a manipulated state spot_M  (≤50% deviation
       from spot_T1 to slip the deviation gate IF they update TWAP first; OR they don't
       call TWAP and simply leave the reserves ready).
T1+5 : (optional) attacker calls TWAP.update(pair). lastSpot0 := spot_M, slot stored.
T1+ε : guardian observes the manipulation and calls factory.emergencyDisablePair(pair)
       (instant, guardian-only). Pair frozen. swap/mint/burn/sync/skim all blocked.
       (OR: a separate, unrelated disable event freezes a pair whose reserves the
        attacker has already pre-positioned.)

[disable_duration: pair frozen with reserves at spot_M, pair.blockTimestampLast still = T1+5]

T_resume : multisig executes timelocked re-enable. disabledPairs[pair] = false.
T_resume + 1s : attacker front-runs any organic swap with TWAP.update(pair):
   reserve0/1   = manipulated values (frozen).
   pairBlockTs  = T1+5  (no _update happened during disable).
   spotPrice0   = manipulated.
   pair.price0CumulativeLast() = Cum_T1+5 (frozen).
   elapsedSinceLastPairTouch = T_resume + 1s − (T1+5) ≈ disable_duration.
   price0Cumulative observation = Cum_T1+5 + spot_M × disable_duration.

   Deviation gate: prev0 = lastSpot0 = spot_M (set by attacker pre-disable).
                   spotPrice0 = spot_M.        deviation = 0.   GATE PASSES.
                   bypassed = false.   Observation lands as a non-bypass slot.
```

`consult()` at `T_resume + 1s` for a 30-min window:

* `latest` = the just-landed post-resume observation (non-bypass).
* `best` = some pre-disable observation (e.g., T1).
* `priceDiff = latest.price0Cumulative − best.price0Cumulative ≈ honest_swap_term + spot_M × disable_duration`.
* `elapsed = latest.timestamp − best.timestamp ≈ disable_duration + 5min`.
* `twap_price ≈ spot_M` (dominated by the disable-window bridging).

### Impact

The TWAP is poisoned to read the manipulated spot for as long as the post-resume observation remains the latest **AND** there is a non-bypass anchor to pair it with — up to `MAX_OBSERVATIONS × MIN_PERIOD = 12h` after the buffer would have rotated through the manipulation.

Downstream, `_positionETHValue` in `TegridyLending.sol` and the harvest-slippage gate in `POLAccumulator.sol` both call `twap.consult(pair, toweli, …, TWAP_PERIOD)`. A poisoned consult inflates TOWELI's quoted ETH-equivalent for `TWAP_PERIOD` consumers, enabling:

* **Lending:** borrow more ETH against TOWELI collateral than the honest oracle would permit; if `manipulated/honest = 1.5×`, a 50% over-borrow that liquidations may not catch up with before the imbalance unwinds.
* **POL harvest:** the LP-harvest `swap` minOut is derived from the manipulated TWAP, allowing a counterparty to underpay TOWELI without tripping `MEV_FLOOR_BPS`.

### Why FRESH-EYES H-2 (already landed) does not close this

The H-2 fix at `update()` line 277 refuses observations *during* `disabledPairs[pair] == true`. Once the timelocked re-enable executes and `disabledPairs[pair]` flips back to `false`, the next `update()` proceeds — and the bridging math at lines 320–330 unconditionally integrates `currentSpot × elapsedSinceLastPairTouch` even when `elapsedSinceLastPairTouch` spans an enforced freeze window. There is no first-post-resume gate.

### Why the deviation gate does not close this

The deviation gate (lines 393–404) compares `spotPrice0` to `lastSpot0[pair]`. If the attacker's pre-disable `update()` call was the LAST one before the disable, `lastSpot0[pair]` already equals the manipulated spot, so the post-resume deviation is 0 and the gate passes.

The `count <= 2` grace window does not help either — that branch is for fresh pairs, not post-disable replays.

### Why `lastBypassUsed`-based consumer cooldowns do not close this

`lastBypassUsed` is updated only at:

1. `count == 0` bootstrap (lines 352–354).
2. The owner-only dormancy-bypass path when `elapsed > DEVIATION_BYPASS_AFTER` (lines 432–435).

A normal post-resume `update()` whose `elapsed` is `≤ 1 day` does **not** touch `lastBypassUsed`, so the lender's `block.timestamp - lastBypass < TWAP_PERIOD * 2` cooldown at `TegridyLending.sol:1619` is silent on this poisoning class.

### Required conditions for the attack

1. The pair must be (or become) disabled while reserves are in a manipulator-favourable state. Either (a) malicious / mistaken guardian disable, or (b) the manipulator pre-positions reserves and a legitimate disable happens to land before arbitrageurs correct.
2. `lastSpot0[pair]` must equal the manipulated spot at the moment of disable (so the deviation gate doesn't trip on resume). Achieved by calling `update()` while reserves are manipulated *and* before the disable lands.
3. Disable_duration ≤ `DEVIATION_BYPASS_AFTER` (1 day) — otherwise the dormancy-bypass branch fires post-resume, the resulting observation is `bypassed = true`, and `consult()` correctly fail-closes.

Condition (1) is the rate-limiter: this is not a self-funding attack — it requires guardian/multisig collusion or a fortuitous disable. With the current timelock + multisig assumption it is not high-probability, but it represents a "free sustain" of an existing manipulation: where without the disable the attacker pays `arb-out × disable_duration` to keep reserves imbalanced, with the disable they pay zero.

### Suggested mitigations

Pick one (in increasing order of operational cost):

1. **Stamp `enabledAt[pair]` on the factory** (or expose `disabledAt[pair]` so re-enable time can be derived) and reject post-resume observations until enough time has passed for arbitrageurs to correct, OR mark the first post-resume observation `bypassed = true`. Cleanest fix; mirrors the existing `SequencerCheck.getResumeTimestamp` pattern that the contract already implements at line 793–798.
2. **Treat `pair.blockTimestampLast` lag as a bypass trigger:** if `blockTs - pairBlockTs > MAX_STALENESS` AND `count > 0`, force `bypassed = true` at line 332. Same shape as the existing dormancy-bypass branch but defined on pair-touch staleness rather than observation-buffer staleness. (Note: this also catches the more general "pair was idle but not disabled" case where the bridging integrates the same kind of multi-hour spot-times-elapsed term.)
3. **Operational:** require the multisig to call `executeAdminResetPair(pair)` immediately after every re-enable so the buffer is freshly bootstrapped (slot 0 = bypass; consult fail-closes for 12h). 24h timelock on PAIR_RESET makes this awkward — would need a faster recovery primitive.

Mitigation 2 is the strongest fail-closed default and matches the contract's existing fail-closed posture (latest.bypassed, best.bypassed, sequencer-grace anchor check). It also subsumes a separate concern not raised here but adjacent: any pair that has been *idle* (not disabled, just no swaps) for hours has the same bridging-spot risk. Today only `DEVIATION_BYPASS_AFTER = 1 day` covers that — anything between MAX_STALENESS (2h) and 1 day is bridged unconditionally.

---

## F-24-2 — `minReserveFloor` is single-valued; misconfiguration footgun on cross-decimal pairs

**Severity:** LOW (owner-set, owner-aware)
**Location:** `TegridyTWAP.sol::update()` lines 303–306; `setMinReserveFloor` line 144–148

```solidity
uint256 floor0 = minReserveFloor[pair];
if (floor0 != 0 && (uint256(reserve0) < floor0 || uint256(reserve1) < floor0)) {
    revert ReservesBelowFloor();
}
```

A single `floor0` is checked against BOTH `reserve0` and `reserve1`. For an 18-decimal / 6-decimal pair (e.g., a hypothetical TOWELI/USDC pool):

* `reserve0` (TOWELI 18) might be 1e21 (1000 TOWELI).
* `reserve1` (USDC 6) might be 1e9 (1000 USDC).

A floor of `1e21` would let in any USDC reserve smaller than 1e21 (which is the entire space — USDC reserves can never reach 1e21). A floor of `1e9` provides essentially no protection on the TOWELI side (1e9 = 1e-9 of a TOWELI). The owner cannot pick one threshold that meaningfully gates both.

Today's protocol uses a single TOWELI/WETH 18:18 pair, so this footgun is currently dormant. Surfacing only because the BATCH-N3 H6 fix doc says "Aerodrome uses analogous per-pool oracle approval lists; we use a numeric threshold" — the "numeric threshold" formulation does not generalise to arbitrary pairs the factory might be allowed to spawn. If a USDC- or BTC-decimal pair ever ships, this check needs to take TWO floors (`floor0`, `floor1`) or a `(floor, decimals0, decimals1)` triple normalised to a common denom.

### Suggested fix

Either:

```solidity
mapping(address => uint256) public minReserveFloor0;
mapping(address => uint256) public minReserveFloor1;
```

…or document that `minReserveFloor` MUST be set only on equal-decimal pairs.

---

## F-24-3 — `lastBypassUsed` not updated for `count <= 2` grace; consumer cooldowns are silent on the 2nd/3rd observation

**Severity:** LOW (TWAP-side `best.bypassed` revert closes the actual exploit)
**Location:** `TegridyTWAP.sol::update()` lines 388–389 (count<=2 branch)

The `count <= 2` branch sets `bypassed = true` on the slot but does NOT update `lastBypassUsed[pair]`:

```solidity
if (count <= 2) {
    bypassed = true;
} else if (...)
```

vs. the bootstrap and dormancy-bypass branches which DO update `lastBypassUsed`.

Consumer code in `TegridyLending.sol::_positionETHValue` and `POLAccumulator.sol::_twapMinOut` reads `lastBypassUsed` and refuses to use the TWAP for `TWAP_PERIOD * 2` (60 min) afterward. This cooldown protects against the bootstrap and dormancy-bypass cases but is **silent for grace observations 2 and 3**.

In practice the actual consult would still revert on `best.bypassed` at TegridyTWAP.sol:781, so the exploit window is closed at the TWAP layer. But the typed-error contract that consumers rely on (`OracleStale` from the lender, `BadOracle` from POL) is bypassed in favour of the inner `OracleRebootstrapping` revert. Off-chain monitoring that keys off the typed errors would miss the rebootstrap signal.

### Suggested fix

Update `lastBypassUsed[pair] = block.timestamp;` inside the `count <= 2` branch as well so consumer-side staleness/bypass cooldowns are accurate:

```solidity
if (count <= 2) {
    bypassed = true;
    lastBypassUsed[pair] = block.timestamp;   // <<< add
}
```

The downstream consult guard becomes redundant for that case but redundancy is desirable here.

---

## F-24-4 — `(amountIn * priceDiff)` checked-math overflow is a silent DoS on extreme-imbalance pairs

**Severity:** LOW (DoS, not poisoning)
**Location:** `TegridyTWAP.sol::consult()` line 553

```solidity
amountOut = (amountIn * priceDiff) / (uint256(elapsed) * Q112);
```

`priceDiff = priceCumEnd − priceCumStart` is a uint256 mod-2^256 difference. For "normal" pairs, `priceDiff ≈ spot × elapsed` where `spot ≤ 2^224 (Q112-scaled)` and `elapsed ≤ 12h`, so `priceDiff` stays under ~2^144. The checked multiplication `amountIn × priceDiff` then needs `amountIn < 2^112`, which is satisfied for 1e18-scale tokens.

For extreme-imbalance pairs (large reserves of an 18-decimal token paired with a tiny reserve of a low-decimal token), `priceDiff` can approach 2^200+. With `amountIn` near 2^60 (≈ 1e18), the multiplication can hit 2^260+ and revert with `Panic(0x11)` — turning `consult()` into an unconditional revert for any meaningfully-sized `amountIn`.

Currently no such pair exists in the protocol (TOWELI/WETH is 18:18). Surfacing because the comment at line 87–91 advertises uint256 widening as "elimination of truncation risk on extreme-imbalance pairs" — extreme-imbalance pairs DO succeed in storage but FAIL in `consult()` arithmetic at large `amountIn`.

### Suggested mitigation

Either:

1. Document that `consult()` is bounded by `amountIn × spot_at_max × elapsed < 2^256`. The lending consumer hard-caps amounts at NFT staking position size, but POL passes `toweliUnit` (typically 1e18) and `(K * toweliUnit) / twapEthPer1eToweli` — for a manipulated-low TWAP this could produce a huge effective amountIn-equivalent.
2. Use `FullMath.mulDiv(amountIn, priceDiff, uint256(elapsed) << 112)` (V3 OracleLibrary pattern) so the intermediate product doesn't need to fit in 256 bits.

---

## F-24-5 (DEAD-END) — Year-2106 timestamp-zero collision

`obs.timestamp == 0 continue` at line 721 treats slot-zero timestamp as "unwritten." If `block.timestamp % 2^32 == 0` ever holds at exactly the rollover instant (~year 2106), a legitimate observation could be skipped. 1-second window in an 80-year horizon and the protocol presumably has been redeployed by then. Ignored.

---

## F-24-6 (DEAD-END) — uint32(best.timestamp) vs uint256(resumeAt + GRACE) post-rollover

```solidity
if (resumeAt != 0 && uint256(best.timestamp) < resumeAt + SEQUENCER_GRACE_PERIOD) {
    revert OracleRebootstrapping();
}
```

`best.timestamp` is uint32 (wraps at 2^32 ≈ year 2106). `resumeAt` is full uint256 (block.timestamp scale). Today (2026, block.timestamp ≈ 1.78e9 < 2^32) the comparison works because both fit in uint32 range. Post-2106 rollover, `best.timestamp` wraps to a small value while `resumeAt + GRACE` is a 4.29e9+ value — making the comparison always true and over-reverting (fail-closed). Not an exploit; a 80-year-out correctness drift. Ignored.

---

## Notes & dead-ends visited

| Vector | Disposition |
|--------|-------------|
| Observation array overflow / pointer wrap | OK. `(idx+1) % 48` is sound; `latestIdx − i` wrap math at line 716–718 verified for all i, latestIdx combos. |
| Single-block manipulation on a fresh pair | OK. First 3 observations are `bypassed = true`; consult fail-closes via `best.bypassed`. Mounted `count <= 2` grace specifically prevents bootstrap-induced self-bricking. |
| `update()` callable by anyone — spam | OK. `MIN_UPDATE_INTERVAL = 15min` rate-limits per pair; updateFee opt-in further raises cost. |
| `update()` rate-limit bypass via different blocks | OK. `canUpdate` reads the latest slot's timestamp regardless of who/which block. |
| Pair tokens swapped (token0 vs token1) | OK. `consult` at line 537–541 reads `pair.token0()/token1()` fresh and matches `tokenIn`. `isToken0` then routes to the right cumulative. |
| Cumulative price wraparound (uint224 in V2 oracle) | Hardened to uint256 by R014 (line 86–91). Subtraction is `unchecked` (line 549–552) to preserve modular semantics; correct. |
| Truncation in time-delta math | Wrapped uint32 subtraction is `unchecked` everywhere it appears (canUpdate, _getCumulativePricesOverPeriod, update). Verified. |
| `lastBypassUsed` abuse to disable TWAP then attack | The dormancy-bypass branch is owner-only (`BypassObservationOwnerOnly` at line 432). Bootstrap path can't be triggered by a non-owner without first triggering `adminResetPair` (24h timelocked owner action). No permissionless flip. |
| Multiple pairs — wrong pair returned | All read paths key off `pair` parameter; storage is mapping(pair => …). No cross-pair leakage observed. |
| Cross-decimal handling | Bridging math is decimal-agnostic on the pair side; consumer side (POL, lending) uses `toweliUnit = 10**decimals()` correctly (POLAccumulator.sol:290). See F-24-2 for a separate cross-decimal floor concern. |
| `withdrawFees` ETH lock-in | `(bool ok,) = to.call{value: amount}(""); require(ok)` reverts on send failure, which reverts the prior `accumulatedFees = 0`. Owner can rotate `feeRecipient` to recover. OK. |
| `consult` re-entry | `external view`; pair calls (`token0/token1/getReserves/price{0,1}CumulativeLast`) are view. No reentry surface. |
| `update` re-entry via excess-refund | Guarded by `nonReentrant`; refund is the last external call before the writes. Even without the guard, all writes are CEI-correct. OK. |
| `proposeAdminResetPair` race with attacker `update()` | Reset only zeroes pointers and lastSpot/lastBypassUsed; observations array retains stale data. After reset, the next update's bridging is bootstrap-only (`bypassed=true`), and consult fail-closes for ≥4 observations. Stale slots are never reached because `effectiveCount` caps the loop. OK. |
| `consult` with `period == MAX_OBSERVATIONS * MIN_PERIOD` | Boundary inclusive (`if (period > …) revert`). For a partially-filled buffer the !found fallback hits slot 0 (bypassed bootstrap), revert OracleRebootstrapping. Fail-closed. OK. |
| Pair pause: `consult()` serves last value | NO. `factory.disabledPairs(pair) revert PairDisabled` at line 508 in consult. (See F-24-1 for the post-resume gap, which is the only related concern that matters.) |
| Initialization seed gaming | First observation always `bypassed = true`; first 3 are bypassed (count<=2 grace). 4th onward is deviation-gated. Consumer guards on `lastBypassUsed` and `best.bypassed` close the pre-buffer-rotation window. OK. |

---

## Conclusion

One MEDIUM finding (F-24-1, post-resume disable-window bridging) and three LOW findings (F-24-2, F-24-3, F-24-4) worth addressing. No CRITICAL or HIGH-severity exploits found; the contract has clearly absorbed multiple prior audit waves and the bypass/anchor double-guard pattern is sound. The remaining residual is the disable-window bridging interaction with the cross-contract trust boundary at the factory, which is a category not previously hit by FRESH-EYES H-2/H-5 (which guard the during-disable interval, not the immediately-post-resume interval).
