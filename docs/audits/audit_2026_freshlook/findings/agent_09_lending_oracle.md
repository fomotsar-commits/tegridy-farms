# Agent 09 — Fresh-Eyes Oracle / Pricing / LTV Audit on TegridyLending.sol

**Scope:** TegridyLending.sol (1972 lines), TegridyTWAP.sol (813 lines), lib/SequencerCheck.sol (365 lines)
**Lens:** Chainlink staleness, oracle decimals, TWAP manipulation, sequencer-down liquidation, LP-pricing, oracle override, LTV math

---

## Executive Summary

**TegridyLending.sol does NOT integrate Chainlink ETH/USD price feeds.** The protocol uses a **Gondi-style P2P design** where the **lender bears all collateral pricing risk** at offer creation. Pricing is restricted to:

1. An **OPTIONAL** ETH-denominated floor (`minPositionETHValue`) checked **only at `acceptOffer`** via TegridyTWAP — not at default/liquidation.
2. A raw `minPositionValue` (TOWELI amount) check from the staking position struct.
3. A Chainlink **L2 Sequencer Uptime feed** (NOT a price feed) for liquidation gating on Arbitrum/OP/Base.

There is **no LTV ratio**, **no liquidation price oracle**, and **no admin oracle override**. All of `pair`/`twap`/`toweli`/`weth`/`sequencerFeed` are **`immutable`** and cannot be hot-swapped.

The TWAP pricing surface is heavily hardened with:
- 30-min averaging window matching Aave V3 default
- 2h staleness gate (TWAP-side) + 4h sequencer-feed staleness (lending side)
- Sequencer post-resume grace gate (1h) on both ends of TWAP lookup window
- `lastBypassUsed` cooldown of `TWAP_PERIOD * 2` = 60min on lending side
- TWAP `OracleRebootstrapping` revert when latest OR anchor observation is `bypassed`
- Bootstrap-3-observations grace flagged `bypassed = true` so consult fails until 4th observation
- Factory-disabled-pair check on both `update()` and `consult()` (FRESH-EYES H-2/H-5)
- Per-pair `minReserveFloor` admin gate against single-trader low-TVL manipulation
- Pair-reset 24h-timelocked recovery primitive

After thorough review I found **no exploitable critical or high-severity oracle issue**. Two LOW notes and three INFO observations are listed below.

---

## Findings

### F-09-L1 — LOW — `consult()` upper-bound product can DoS the floor on extreme positions
**Severity:** LOW
**Location:** TegridyTWAP.sol:553 (`amountOut = (amountIn * priceDiff) / (uint256(elapsed) * Q112)`)
**Files:** `contracts/src/TegridyTWAP.sol`

The TWAP `consult()` computes `amountIn * priceDiff` in checked-math uint256. For an absurd-but-feasible position:
- `amountIn` = stake amount up to ~1e30 (if ever inflated to that supply)
- `priceDiff` = ~Q112 × 1800s × ratio ≈ 2^112 × ~2k

The product is `≤ ~2^112 × 2^11 × 1e30 ≈ 2^155`, comfortably below 2^256 for realistic TOWELI scales. Not exploitable today, but if an attacker engineered a super-imbalanced pair with `priceDiff` near maximum, then a borrower passing a bloated `_tokenId.amount` could DoS the floor check via `Panic(0x11)`. The lender simply re-creates the offer with `minPositionETHValue = 0` if persistent.

**Status:** Not actionable — bounded by TOWELI supply caps + 50% deviation gate keeping `priceDiff` small.

---

### F-09-L2 — LOW — Year-2106 timestamp wrap will mis-flag fresh observations as stale
**Severity:** LOW (theoretical, 80+ years out)
**Location:** TegridyLending.sol:1606-1608
**Files:** `contracts/src/TegridyLending.sol`

```solidity
ITegridyTWAP.Observation memory latest = twap.getLatestObservation(pair);
if (latest.timestamp > block.timestamp) revert OracleStale();
if (block.timestamp - latest.timestamp > TWAP_MAX_STALENESS) revert OracleStale();
```

`latest.timestamp` is `uint32` (year-2106 rollover); `block.timestamp` is `uint256`. Post-2106, freshly-stored uint32 timestamps wrap small (e.g. 100), while `block.timestamp` exceeds 2^32. The first check `latest.timestamp > block.timestamp` is FALSE (uint32 promoted < uint256), the second underflows the apparent gap as `2^32 + small_number` — bricks the floor check.

The TWAP file itself uses uint32 modular arithmetic correctly across the wrap (lines 561-573, 695-704). Lending's wrapper does NOT. Trivial future fix: cast `block.timestamp` to `uint32` before subtract, mirroring TWAP's pattern.

**Status:** Document-and-defer.

---

### F-09-INFO1 — INFO — Lender bears full collateral price-decline risk
**Location:** Comment at TegridyLending.sol:850-852
**Files:** `contracts/src/TegridyLending.sol`

> "the optional ETH floor (`minPositionETHValue`) is checked at acceptance, NOT at default."

This is a documented design choice (Gondi P2P pattern). Loan terms are fixed at acceptance and cannot be margin-called. A lender who quoted off ETH = $4k must wait through `claimDefaultedCollateral` even if TOWELI/ETH falls 90% mid-loan. **Behavior is intentional** but operationally important — protocol's UX should surface this clearly to lenders.

---

### F-09-INFO2 — INFO — `update()` is permissionless when `updateFee == 0`
**Location:** TegridyTWAP.sol:266-291
**Files:** `contracts/src/TegridyTWAP.sol`

When `updateFee == 0` (default), anyone can call `update(pair)` (subject to `MIN_UPDATE_INTERVAL` = 15 min). Combined with `MAX_DEVIATION_BPS` = 5000 (50%), an attacker with sustained capital pressure can push two consecutive 50%-deviation observations to manipulate the 30-min average by ~25%.

Mitigants present:
- 50% per-update cap
- `minReserveFloor[pair]` admin lever (BATCH-N3 H6) against low-TVL pairs
- Bootstrap-3-observation grace (no consult value during bootstrap)
- Sequencer post-resume grace
- Factory pair-disable

**Status:** Standard Uniswap-V2-style TWAP risk. Conservative — the 30-min/50% combo matches Aave V3's stable-asset default.

---

### F-09-INFO3 — INFO — TWAP returns ETH-equivalent in 18-decimal wei; comparison is consistent
**Location:** TegridyLending.sol:912-914
**Files:** `contracts/src/TegridyLending.sol`

```solidity
if (minPositionETHValue > 0) {
    uint256 ethValue = _positionETHValue(positionAmount);
    if (ethValue < minPositionETHValue) revert InsufficientCollateralValue();
}
```

`positionAmount` is TOWELI 18-decimal wei from `Position.amount`. `_positionETHValue` returns ETH-equivalent 18-decimal wei via `consult(pair, toweli, amount, 30min)`. Lender's `minPositionETHValue` is also wei. Decimals are consistently 18d throughout — **no Chainlink 8d × 18d mismatch** because there is no Chainlink price feed.

---

## Dead-ends Investigated

- **Chainlink price feed integration (ETH/USD 0x5f4eC3...):** searched — NOT used anywhere. Only L2 sequencer uptime feeds.
- **Admin oracle override / setOracle / setPrice / forcePrice / emergencyPrice:** NONE. All oracle wiring (`pair`, `twap`, `toweli`, `weth`, `sequencerFeed`) is `immutable`.
- **Negative-answer downcast int256 → uint256:** sequencer feed uses `answer != 0` strict check (M-Lib3 fix); price feed not present. No vulnerable downcast path.
- **Decimals mismatch:** none — 18d throughout, no 8d mixing.
- **LP-token / fair-LP / Alpha Homora pricing:** not applicable — the collateral is a TegridyStaking ERC721 wrapping a raw TOWELI amount, not a LP token.
- **answeredInRound vs roundId:** SequencerCheck enforces `answeredInRound >= roundId` (line 134) PLUS `updatedAt != 0` PLUS `block.timestamp - updatedAt <= staleness` PLUS strict `answer == 0` — all defenses present.
- **Sequencer down → still allow borrow/liquidate:**
  - `acceptOffer → _positionETHValue → checkSequencerUp(4h)` — borrow path blocked when sequencer down/in-grace.
  - `claimDefaultedCollateral → checkSequencerUp(4h)` — liquidate path blocked.
  - `repayLoan → getSequencerOutageBuffer` — repay extended (asymmetric, lender-friendly via additional grace, borrower-friendly via deadline extension).
  All three legs gated correctly.
- **Switching between TWAP and spot:** never — `_positionETHValue` is the single pricing entrypoint and only uses TWAP.
- **TWAP window manipulation via flash-loan:** TWAP `consult` uses 30-min averaging + per-update 50%-deviation gate + bypass guards. Single-block / single-tx manipulation prevented.
- **First-observation manipulation:** FRESH-EYES H-3 (TegridyTWAP.sol:340-354) marks observation #1 as `bypassed = true`; consult will refuse until at least 4 honest observations are present.
- **Pair-disabled poisoning:** FRESH-EYES H-2 + H-5 (lines 277, 508) close both update and consult during disable window.
- **Captured-owner bypass-anchor poisoning:** AUDIT FIX D-AMM-H1 (line 432) gates dormancy bypass behind `onlyOwner`; PASS7-TWAP-01 (line 781) closes `!found && best.bypassed` carve-out.
- **Modular cumulative wrap:** `unchecked` subtraction in `consult` (line 551) and `_getCumulativePricesOverPeriod` (lines 700-731) handle the wrap correctly per Uniswap V2 pattern.
- **`positionAmount = 0` accept loop:** `lockEnd == 0` check (TegridyLending.sol:919) catches burned/empty positions; lender's risk choice if they set `minPositionValue = 0`.
- **Front-running TWAP refresh:** keeper-published observations are subject to the deviation gate AFTER the 4th observation; an attacker would need to push reserves AND wait MIN_UPDATE_INTERVAL between updates — not single-tx exploitable.

---

## Conclusions

The lending contract's pricing surface is **conservatively designed** and **deeply hardened** against oracle manipulation. The Gondi P2P pattern intentionally pushes collateral-pricing risk onto the lender (clearly documented). The optional TWAP-based ETH floor is enforced with multiple layers of defense (staleness, sequencer grace, dormancy bypass, bootstrap-3 grace, deviation gate, factory-disable, minReserveFloor).

No exploitable critical/high/medium oracle issues found. Two low-severity defensive notes (uint32-wrap in 2106; theoretical priceDiff DoS) are non-blocking.

**Total findings:** 2 LOW + 3 INFO + 0 CRITICAL/HIGH/MEDIUM.
