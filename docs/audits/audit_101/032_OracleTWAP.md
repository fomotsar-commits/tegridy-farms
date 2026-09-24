# Agent 032 — Oracle / TWAP Cross-Dependency Forensic Audit

**Scope:** TegridyTWAP.sol + every consumer (TegridyLending, TegridyNFTLending, PremiumAccess, POLAccumulator, anywhere calling getPrice/consult). Grep for "AggregatorV3", "Chainlink", "latestRoundData", "consult".
**Methodology:** AUDIT-ONLY. No fixes attempted.

---

## 0. Inventory & Cross-Dependency Map

| Contract | Imports TWAP? | Calls `consult()` / `update()`? | Oracle source actually used | Risk inheritance |
|---|---|---|---|---|
| `TegridyTWAP.sol` | n/a (oracle) | n/a | self | source contract |
| `TegridyLending.sol` | NO | NO | **AMM spot reserves** via `_positionETHValue` (line 715) | **No oracle protection** — ETH-floor uses raw `getReserves()` |
| `TegridyNFTLending.sol` | NO | NO | none — comment says "Key design: NO oracle — lender evaluates risk themselves (Gondi pattern)" (line 22) | not affected |
| `PremiumAccess.sol` | NO | NO | none (no price logic) | not affected |
| `POLAccumulator.sol` | NO | NO | only mentions TWAP in a doc comment (line 227) — caller must pass `_minTokens` from off-chain TWAP/Chainlink. Defaults to spot-derived backstop. | **No oracle protection** at the contract layer; relies on caller-provided slippage + Flashbots |
| `TegridyStaking.sol` | NO | NO | none | not affected |
| `TegridyPair.sol` | NO | NO | comment explicitly disables on-chain TWAP (line 88) — points consumers at TegridyTWAP/Chainlink | source AMM |
| `TegridyRestaking, TegridyRouter, TegridyFactory, TegridyDropV2, TegridyLaunchpadV2, TegridyLPFarming, TegridyFeeHook, RevenueDistributor, ReferralSplitter, SwapFeeRouter, GaugeController, VoteIncentives, MemeBountyBoard, CommunityGrants, Toweli, TegridyNFTPool*, TegridyTokenURIReader` | NO | NO | none | not affected |

**Key macro finding:** TegridyTWAP is deployed (see `broadcast/DeployTWAP.s.sol/...`) but has **ZERO production consumers** in the contract tree. It is dead-code-on-chain from a security-coupling standpoint, except as a target for a manipulator who could later position themselves to be the trusted updater the moment a real consumer wires in. Conversely, TegridyLending's ETH-floor path bypasses the oracle entirely and reads raw spot reserves.

No `AggregatorV3`, `Chainlink`, or `latestRoundData` consumer exists anywhere in `contracts/src` — so feed-stale, sequencer-uptime, negative-price, decimals-mismatch, getRoundData-revert, and multi-feed aggregation drift do not apply to current code paths. They become live the moment any contract integrates Chainlink, and the absence of an `IPriceOracle` abstraction means each future integration will likely re-implement the boilerplate from scratch.

---

## HIGH

### H-1 — TegridyLending ETH-floor reads spot AMM reserves (oracle-bypass, sandwich-manipulable)
**File / line:** `contracts/src/TegridyLending.sol:715-724` (`_positionETHValue`)
**Class:** Single-source oracle / fallback that's manipulable.
**Detail:** The `minPositionETHValue` ETH-denominated collateral floor uses `ITegridyPair(pair).getReserves()` directly — instantaneous spot. The contract-internal docstring (line 705-711) acknowledges this is sandwich-manipulable in the same transaction and points at `docs/SECURITY_DEFERRED.md` for the deferred TWAP integration. Despite TegridyTWAP existing on-chain and exposing `consult()` for exactly this purpose, the lending contract never imports it. An attacker can:
1. flash-loan-pump the TOWELI/WETH pair so `wethReserve/toweliReserve` doubles,
2. accept a borrower-favourable loan whose `minPositionETHValue` would otherwise gate it out,
3. unwind in the same tx — the position now sits at ~50% of the asserted floor.
**Compounded by:** the very mitigation cited (the 2 h `minDuration` floor) is irrelevant here — the manipulation happens at `acceptOffer` time, not over the loan term.
**Consumer impact:** Direct loss of lender principal; affects any lender who set a non-zero `minPositionETHValue`.
**Recommendation:** Wire `TegridyTWAP.consult(pair, toweli, toweliAmount, 30 minutes)` in `_positionETHValue`. Until then, document that `minPositionETHValue` is advisory.

### H-2 — TWAP `update()` is permissionless and can be sandwiched to drift the moving average
**File / line:** `contracts/src/TegridyTWAP.sol:118-219`
**Class:** TWAP single-block manipulation / single-source oracle.
**Detail:** `update(pair)` has no auth and no MEV-protected scheduler. The `MAX_DEVIATION_BPS = 5000` (50%) deviation guard caps a single observation, but an attacker can trivially:
- mempool-watch for a victim consult-then-act tx,
- in their own bundle: buy on the pair, call `update(pair)` (deviation guard accepts up to 49.99%), sell — and the tampered observation persists for the rest of the buffer window.
- repeat at 15-minute cadence (4 times/hour, 8 times in the 2 h `MAX_STALENESS` window) — each tick allowed up to 50% from its predecessor, so geometric drift to **>5x** is reachable inside one staleness window without ever tripping the guard.
**Counter-argument:** the deviation check uses the *previous spot price reconstructed from cumulative deltas* — but spot is itself the manipulation target, so the guard only catches attackers who fail to also manipulate the prior tick. A sustained adversary holding the position across ticks is unbounded.
**Consumer impact:** Any future consumer of `consult()` (POLAccumulator's documented use case) inherits a 5x drift attack at the cost of MEV+gas.
**Recommendation:** Either (a) make `update()` callable only by an authorised relayer / bots whitelist, (b) require the caller to commit-reveal the observation, or (c) reduce `MAX_DEVIATION_BPS` to e.g. 500 (5%) and accept that legitimate volatile pairs may need more frequent updates.

### H-3 — `block.timestamp − last.timestamp` math mixes uint256 and uint32 → wrap-window bypass
**File / line:** `TegridyTWAP.sol:256` (`canUpdate`) and `:318` (staleness in `_getCumulativePricesOverPeriod`)
**Class:** Stale-price acceptance / wrap unhandled.
**Detail:** `last.timestamp` and `latest.timestamp` are `uint32` (Uniswap V2 inheritance). `block.timestamp` is `uint256`. The expressions `block.timestamp - last.timestamp` and `block.timestamp - latest.timestamp` perform *uint256* arithmetic — Solidity *does not* down-cast block.timestamp. The audit comment at line 156-163 acknowledges the wrap exposure inside the deviation check and uses `unchecked` modular subtraction there, but this fix was **not propagated** to `canUpdate` (line 256) or the staleness gate (line 318).
**Behaviour after uint32 wrap (year 2106 — sooner on chains with non-Unix-epoch timestamps such as some testnets / future L2s with custom genesis):** suppose `block.timestamp = 2^32 + 100` and `last.timestamp = 2^32 - 1` stored as `uint32(0xFFFFFFFF) = 4294967295`. Subtraction yields `2^32 + 100 − 4294967295 = 101` (correct by accident in this example) — but if `last.timestamp` is e.g. `5` (newly written post-wrap), the diff is `2^32 + 95` ≈ 4 billion seconds, which *passes* the `>= MIN_PERIOD` and *trips* the staleness revert constantly, locking up `consult()` for the buffer's lifetime, AND `canUpdate` returns `true` continuously, allowing a single attacker to fill the entire 48-slot buffer in <1 second of wall time (no `MIN_PERIOD` actually enforced after wrap).
**Consumer impact:** Long-tail liveness DoS plus a 12-hour window during which deviation-guard observation cadence collapses to "as fast as the attacker can submit txs."
**Recommendation:** Mirror the line 172-174 pattern: `uint32 elapsed; unchecked { elapsed = uint32(block.timestamp) - last.timestamp; }` in both `canUpdate` and the staleness check.

---

## MEDIUM

### M-1 — Decimals mismatch silently produces wrong amountOut
**File / line:** `TegridyTWAP.sol:222-246`
**Class:** Decimals mismatch between feeds.
**Detail:** `consult()` returns `(amountIn * priceDiff) / (elapsed * Q112)`. The UQ112x112 fixed-point ratio is computed from raw reserves *without normalising to a common decimal* (line 138-139). For a TOWELI(18)/USDC(6) pair, the cumulative encodes `reserve_usdc / reserve_toweli` already off by 10^12, so `amountIn=1e18` of TOWELI yields `~price * 1e18` rather than `~price * 1e6` of USDC. No documented decimals invariant for accepted pairs; `update()` does not validate `IERC20(token).decimals()`. Until consumers are deployed this is dormant, but a deploying integrator pointing it at any non-18/18 pair gets a 6- or 12-order-of-magnitude misprice silently.
**Recommendation:** Either (a) require both tokens to be 18 decimals at update-registration time and revert otherwise, or (b) expose a separate `consultNormalised()` that takes `tokenInDecimals/tokenOutDecimals`.

### M-2 — First-observation deviation guard is unconditional pass
**File / line:** `TegridyTWAP.sol:164-188`
**Class:** TWAP single-block manipulation (bootstrap).
**Detail:** The deviation check only runs when `count >= 2`. The very first observation written to a pair is therefore unconstrained — whoever wins the race to call `update(pair)` immediately after deployment (or after a long buffer-empty period) sets the seed. Combined with permissionless `update()`, this lets a flash-loan attacker pre-poison a pair that the protocol intends to integrate later. The audit-fix comment at line 150-151 only addresses ongoing deviation, not bootstrap.
**Recommendation:** Bootstrap the seed observation through an owner-only `seedObservation(pair)` that is callable once per pair, then permit permissionless updates only after seeding.

### M-3 — TWAP buffer is 12 h max, `MAX_STALENESS = 2 h`, `consult(period)` capped at 12 h — but no **minimum period** enforced
**File / line:** `TegridyTWAP.sol:222-246` and constants line 68-72
**Class:** TWAP window too short.
**Detail:** A consumer can pass `period = 1` (one second) and the function will route through `_getCumulativePricesOverPeriod` to the closest-but-prior observation — which may be `latest.timestamp - 1` if the buffer happens to contain such a near-zero-elapsed pair, returning a near-spot value that's effectively unprotected. While `if (elapsed == 0) revert InsufficientObservations()` (line 355) catches the degenerate case, it does not enforce a *minimum elapsed*. A 30-second elapsed window between two observations is just as exploitable as raw spot.
**Recommendation:** Enforce `period >= MIN_PERIOD` (15 min) at the top of `consult()`. Reject anything shorter than the configured minimum smoothing window.

### M-4 — POLAccumulator's slippage backstop derives from spot, not TWAP — defeats the "use TWAP" doc
**File / line:** `contracts/src/POLAccumulator.sol:225-296`
**Class:** Manipulable fallback when caller supplies low `_minTokens`.
**Detail:** The docstring (line 226-227) tells the operator "set `_minTokens` based on TWAP/Chainlink prices, not spot." But the on-chain backstop (`backstopMinToken`, `backstopMinETH`, lines 278-279) is computed off the *router-returned* swap output and the *current ETH balance* — both of which are sandwich-manipulable. If the operator scripts call accumulate with a low `_minTokens` (or worse, copies an example with `_minTokens = 0`, which line 244 forbids — but `1` passes), the backstop alone cannot stop a sandwich. Backstop's own MIN_BACKSTOP_BPS = 5000 (50%) means a 50% sandwich is permissible *by the contract*.
**Recommendation:** Either (a) integrate `TegridyTWAP.consult()` for the backstop floor, or (b) raise `MIN_BACKSTOP_BPS` to 9000 (10% slippage cap as a hard floor).

### M-5 — `update()` accepts excess ETH, refunds via `.call` — refund failure reverts the observation write
**File / line:** `TegridyTWAP.sol:122-127`
**Class:** Liveness / single-source.
**Detail:** When `updateFee > 0`, the contract refunds `excess = msg.value - updateFee` via `msg.sender.call`. If the caller is a contract that reverts on receive (or a Safe with no receive hook), the entire `update()` reverts (line 126: `if (!ok) revert InsufficientFee()`). A protocol relayer running in a Safe cannot keep the buffer fresh. Combined with Risk H-2, an attacker can exploit this to wedge legitimate updaters out and front-run with their own EOA.
**Recommendation:** Use `Address.sendValue` only for the *exact* fee, require `msg.value == updateFee` exactly, and expect callers to compute fee precisely. Or use a pull pattern (track per-caller credit, withdrawable later).

---

## LOW

### L-1 — `withdrawFees` is permissionless (anyone can trigger), payout pattern is fine but event log is publicly noisy
**File / line:** `TegridyTWAP.sol:294-302`
**Detail:** Anyone may call `withdrawFees()`; payout goes to `feeRecipient` (or `owner` if unset), so this is not a theft vector — but a griefer can spam the call to clutter logs and burn gas, and front-run an admin's intended withdrawal-amount accounting if any off-chain bot reads `accumulatedFees` between blocks. No reentrancy guard.
**Recommendation:** Add `onlyOwner` or at least `onlyOwnerOrFeeRecipient`, plus `nonReentrant`.

### L-2 — `setFeeRecipient` allows zero check but no two-step
**File / line:** `TegridyTWAP.sol:286-291`
**Detail:** Owner can change recipient instantly. If owner is compromised, fee redirection is one-tx. Other admin paths in the protocol use 24-48 h timelocks; this one is missing.
**Recommendation:** Mirror `TimelockAdmin` pattern used in `POLAccumulator`.

### L-3 — `getLatestObservation` has no staleness gate
**File / line:** `TegridyTWAP.sol:260-265`
**Detail:** External callers can read `latest` via this view and perform their own pricing without the `MAX_STALENESS` enforcement that `consult()` provides. A naive integrator who reads the latest observation directly will not get the protection the contract advertises.
**Recommendation:** Either revert on stale, or rename to `getLatestObservationUnchecked` and document explicitly.

### L-4 — `MAX_OBSERVATIONS = 48` is hardcoded; no migration path
**File / line:** `TegridyTWAP.sol:69`
**Detail:** Storage layout is `mapping(address => Observation[48])`. If a future audit reveals the buffer should be longer (e.g., to support `period > 12h`), there is no upgrade path — a redeploy is required, breaking existing observers' pair history.
**Recommendation:** Document explicitly or move to a dynamic array with capacity-set on first update.

### L-5 — `getObservationCount` returns clamped count, but storage `observationCount` is unbounded
**File / line:** `TegridyTWAP.sol:268-271` vs `:216`
**Detail:** Cosmetic — `observationCount[pair] += 1` grows unboundedly even after the buffer wraps. Eventually wraps at uint256 (centuries-away) but creates a subtle integration trap if a downstream contract reads it directly.
**Recommendation:** Cap at `MAX_OBSERVATIONS` in storage too, or add an explicit comment.

---

## INFO

- **Chainlink-class controls absent throughout.** The protocol declares "use Chainlink" as a fallback for TWAP (TegridyPair lines 22-33) but no contract instantiates an `AggregatorV3Interface`. Therefore: heartbeat checks, `latestRoundData` answer-validation (negative/zero), `getRoundData` revert handling, sequencer-uptime feed checks for L2 deployments, and multi-pair aggregation drift checks are **all not applicable to current code** — but are *guaranteed* future-tax once anyone integrates Chainlink, since no `IPriceOracle` interface or library exists to centralise the boilerplate. Recommend introducing `OracleLib.sol` with `safeLatestPrice(AggregatorV3Interface, uint256 heartbeat)` before the first Chainlink integration ships.
- **TegridyNFTLending's intentional no-oracle design** (line 22) is sound for the Gondi-style peer-to-peer NFT loan market — recorded for completeness, not a finding.
- **PremiumAccess** has no price logic — recorded for completeness.
- **TegridyTWAP coverage in `contracts/test/TegridyTWAP.t.sol`** is functional (deviation, staleness, period bounds) but does NOT test: post-uint32-wrap behaviour, decimals mismatch, first-observation seed manipulation, or sandwich-via-permissionless-update. Recommend new tests for each.

---

## Severity Summary

| Severity | Count | IDs |
|---|---|---|
| HIGH | 3 | H-1, H-2, H-3 |
| MEDIUM | 5 | M-1, M-2, M-3, M-4, M-5 |
| LOW | 5 | L-1, L-2, L-3, L-4, L-5 |
| INFO | 4 | (Chainlink absence, NFT-lending intent, PremiumAccess intent, test gaps) |

**Top-3 fixes (impact-weighted):**
1. Wire `TegridyTWAP.consult()` into `TegridyLending._positionETHValue` (H-1) — closes the only live ETH-floor manipulation path.
2. Auth-gate `TegridyTWAP.update()` and/or tighten `MAX_DEVIATION_BPS` (H-2) — kills permissionless drift cascade once any consumer integrates.
3. Replace mixed-width timestamp arithmetic in `canUpdate` and the staleness check (H-3) — preempts a 12-h buffer collapse at the uint32 wrap.

— Agent 032
