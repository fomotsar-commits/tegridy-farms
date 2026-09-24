# Deep AMM Core Audit — 2026-05-01

**Targets:** TegridyPair, TegridyFactory, TegridyFeeHook, TegridyTWAP
**Method:** Deep review against current source + in-flight diffs (post-microscope)
**Baseline:** MICROSCOPE_2026_04_30 (5 Crit, 22 High, 39 Med) + prior agent reports (001, 003, 004, 013, 032). Re-finds excluded unless a NEW angle was found.

---

## Severity counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 5 |
| Low | 4 |
| Info | 2 |

---

## [D-AMM-H1] TWAP `lastSpot{0,1}` poisoned by permissionless dormancy-bypass observation
**Severity:** High
**File:** `contracts/src/TegridyTWAP.sol:319-347`
**Category:** oracle

**Bug:**
The microscope's H3 fix gates the **first-ever** observation behind `onlyOwner` to prevent flash-loan-anchored bootstrap manipulation. But the **dormancy-bypass path** (line 319-342) is permissionless and overwrites `lastSpot{0,1}[pair]` (lines 346-347) without any deviation check whenever `elapsed > DEVIATION_BYPASS_AFTER` (1 day). Any `lastSpot` written under bypass becomes the deviation-gate baseline for the next 24h of observations — and if it was anchored against flash-loaned reserves, the 50% deviation gate brick-locks any observation that reflects real spot.

**Attack / Impact:**
1. Pair becomes dormant for >1 day (legitimate or attacker-induced via guardian compromise / disable cycle).
2. Attacker flash-loans to push reserves to a 10× manipulated state.
3. Attacker calls `update(pair)` — `elapsed > 1 day`, deviation gate skipped, observation marked `bypassed=true`, **`lastSpot{0,1}` set to the manipulated spot**.
4. Attacker reverses flash loan (same block).
5. Honest user calls `update(pair)` 15 min later — new spot deviates by `(real - manipulated)/manipulated = 90%` from `lastSpot`, **`PriceDeviationTooLarge` reverts**.
6. Oracle is **bricked for 24 hours** (until next bypass triggers, which the attacker can re-poison).
7. Within that 24h window, `consult()` continues to return the post-bypass cumulative which integrates the brief manipulation, distorting any consumer that doesn't rigorously check `bypassed` + `lastBypassUsed` (and most won't — see the H16 cluster from the microscope).

This is a NEW angle on the microscope's H3: H3 closed only the first observation; the bypass path is the same anchor primitive without owner gating.

**Evidence:**
```solidity
// TegridyTWAP.sol:319-347
if (uint256(elapsed) <= DEVIATION_BYPASS_AFTER) {
    uint256 prev0 = lastSpot0[pair];
    uint256 prev1 = lastSpot1[pair];
    if (prev0 > 0) { ... deviation0 check ... }
    if (prev1 > 0) { ... deviation1 check ... }
} else {
    // bypass branch — NO deviation check, NO owner gate
    bypassed = true;
    lastBypassUsed[pair] = block.timestamp;
    emit DeviationBypassed(pair, elapsed, spotPrice0, spotPrice1);
}

// R012: capture the spot prices for the next deviation gate (H-1/H-2).
lastSpot0[pair] = spotPrice0;   // line 346 — runs in BOTH branches
lastSpot1[pair] = spotPrice1;   // line 347
```

**Recommendation:**
Either gate the bypass path behind `onlyOwner` (mirroring the H3 first-observation fix), OR mark the post-bypass observation as "provisional" by NOT updating `lastSpot{0,1}` until a follow-up non-bypass observation lands. Pattern of record: Curve oracle's `oracle_method` requires two consecutive in-tolerance reads before promoting a baseline. Alternative: require any post-bypass observation to be confirmed by a second observation (within MIN_PERIOD * 2) before `lastSpot` is rotated.

---

## [D-AMM-H2] `sync()` poisons TWAP cumulative on disabled pair (oracle bypass)
**Severity:** High
**File:** `contracts/src/TegridyPair.sol:303-306`, interacts with `TegridyTWAP.sol:268`
**Category:** oracle

**Bug:**
`sync()` is permissionless, has no `disabledPairs`/`blockedTokens` gate, and calls `_update(balance0, balance1)` which advances `price0CumulativeLast` / `price1CumulativeLast` by `oldSpot * timeElapsed`. After `_update`, the new reserves can reflect attacker-donated balances. The next `sync()` (or any `_update` call) then integrates the **donation-skewed spot** into the cumulative for the new elapsed period. While the pair is `disabledPairs[pair] == true`, TWAP's `update(pair)` correctly reverts, but the pair-internal cumulative continues growing at the manipulated spot. After the pair is re-enabled, the very next `TegridyTWAP.update(pair)` reads the poisoned `price{0,1}CumulativeLast` and stores it as a legitimate observation.

**Attack / Impact:**
1. Pair gets disabled (legitimate maintenance, OR guardian-emergency, OR attacker uses unrelated pair-disable to set up).
2. During the disable, attacker `IERC20(token0).transfer(pair, X)` (donation primitive — no gate on receiving tokens).
3. Attacker calls `pair.sync()` at t1 — integrates pre-donation spot for the elapsed time, then updates reserves to (oldR0+X, oldR1). New spot is skewed.
4. Attacker waits 12h (the full TWAP buffer window).
5. Attacker calls `pair.sync()` at t2 = t1+12h — integrates the SKEWED spot for 12h. Cumulative now has 12h of manipulated price baked in.
6. Pair re-enabled.
7. Next `TegridyTWAP.update(pair)` reads `price0CumulativeLast` which contains 12h of poisoned integration. The bridge term (line 282-293 of TWAP) adds the current spot * elapsed-since-pair-touch, but the poisoned segment is already in `pairCum0`.
8. `consult(...)` returns a manipulated TWAP for any consumer reading the post-disable observation against pre-disable observations.

The microscope's M-AMM1 added the `disabledPairs`/`blockedTokens` check to `harvest()`. The same check was NOT added to `sync()` or `skim()` — exactly the "sibling search" pattern §4 of the microscope flagged. This finding cites a **NEW angle**: the resulting TWAP poisoning, not just balance/state inconsistency.

**Evidence:**
```solidity
// TegridyPair.sol:303-306
/// @notice AUDIT FIX H-02: Force reserves to match balances.
function sync() external nonReentrant {
    _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
}
```
`_update` always integrates the pre-update spot * elapsed regardless of whether the pair is gated. No `disabledPairs` / `blockedTokens` check is present.

**Recommendation:**
Mirror the M-AMM1 fix to `sync()` and `skim()`:
```solidity
function sync() external nonReentrant {
    require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
    require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
    _update(...);
}
```
Additionally, the TWAP should consider rejecting observations whose `pairCum{0,1}` jumped by more than X bps from the prior observation's pair-side cumulative — this catches the donation poisoning even if `sync` is left ungated. Pattern: Uniswap V3 `oracleCardinality` discrete-step protection.

---

## [D-AMM-H3] Bypass observation poisoning is permanent — buffer rotation impossible without manual intervention
**Severity:** High
**File:** `contracts/src/TegridyTWAP.sol:115-132, 295-358, 453-458`
**Category:** oracle

**Bug:**
Once the deviation-bypass path admits a manipulated observation (D-AMM-H1 above) the buffer `observations[pair][i]` retains it indefinitely — no admin path exists to evict, invalidate, or rotate the entry. The buffer is `uint8 idx` ring of `MAX_OBSERVATIONS = 48` slots, so a poisoned slot survives until 48 successful `update()` calls overwrite it (~12 hours minimum at MIN_PERIOD cadence, but in practice longer when the deviation gate bricks subsequent updates per D-AMM-H1).

**Attack / Impact:**
A single bypass-poisoning observation pollutes the cumulative for any `consult(period)` lookup that crosses it for the next 12+ hours. Combined with D-AMM-H1's brick condition (the lastSpot baseline is set to the manipulated value), the buffer can not naturally heal — every subsequent honest `update` call reverts deviation-too-large.

**Recovery requires owner intervention** — and there is **no owner setter** that can clear or reset observations / lastSpot / lastBypassUsed for a pair. The owner can change `feeRecipient`, `updateFee`, but cannot clear poisoned state. Re-deploying TegridyTWAP would be the only recovery path. Even then, every consumer must be re-pointed.

**Evidence:**
```solidity
// TegridyTWAP.sol:115-132 — storage; no clear/reset paths exposed
mapping(address => Observation[MAX_OBSERVATIONS]) public observations;
mapping(address => uint8) public observationIndex;
mapping(address => uint256) public observationCount;
mapping(address => uint256) public lastSpot0;
mapping(address => uint256) public lastSpot1;
mapping(address => uint256) public lastBypassUsed;

// Search the rest of the file: no `function clearObservations`, no
// `resetLastSpot`, no `function admin*Pair`. Owner can only set updateFee
// and feeRecipient. No emergency reset path exists.
```

**Recommendation:**
Add an owner-gated emergency reset path:
```solidity
function adminResetPair(address pair) external onlyOwner {
    delete observationIndex[pair];
    delete observationCount[pair];
    delete lastSpot0[pair];
    delete lastSpot1[pair];
    delete lastBypassUsed[pair];
    // Note: observations[pair][...] slots remain but are gated by observationCount
    emit PairReset(pair);
}
```
Add a 24h timelock for safety. Pattern: Chainlink's deprecated-feed migration path. The reset alone closes D-AMM-H1's brick scenario without re-deploying. (D-AMM-H2's prevention still requires the sync gate.)

---

## [D-AMM-M1] `claimFees` permissionless drain on `currency` lock-out window
**Severity:** Medium
**File:** `contracts/src/TegridyFeeHook.sol:299-306` × `:312-317, 334-365`
**Category:** gov

**Bug:**
`claimFees(currency, amount)` is permissionless — any address can drain `accruedFees[currency]` to the `revenueDistributor` in arbitrary chunks. The microscope's M-AMM2 / 004 M-2 noted dust-spam, but the **NEW angle** is the interaction with `executeSyncAccruedFees`: a malicious/compromised owner who proposes a downward sync to 0 will execute it 24h later, but `claimFees` is permissionless and racing-callable in the meantime. Sequence:
1. Owner proposes `syncAccruedFees(currency, 0)` — pending state.
2. Bot races to `claimFees(currency, accruedFees[currency])` to flush funds out before the sync.
3. After `claimFees`, `accruedFees[currency] = 0`. The sync then `executeSyncAccruedFees` succeeds (sets to 0 again, idempotent).

This is benign (funds went to revenueDistributor either way). But the inverse — owner proposes a downward sync as an emergency response to detected drift, and a third party (or the owner themselves making an honest mistake) calls `claimFees` for an amount BETWEEN actualCredit and claimedAfterDriftCorrection — drains the **legitimate-but-soon-to-be-corrected** balance to revenueDistributor before the sync downward executes. RevenueDistributor receives more than its fair share.

**Attack / Impact:**
RevenueDistributor receives drift-correction-pending fees that were earmarked for accounting reconciliation. After the sync execution, the on-chain credit balance is intact but `accruedFees` is desynced from what the distributor already pulled. Forensics become harder.

**Evidence:**
```solidity
// TegridyFeeHook.sol:299-306
function claimFees(address currency, uint256 amount) external nonReentrant {
    if (amount > accruedFees[currency]) revert ExceedsAccrued();
    accruedFees[currency] -= amount;
    poolManager.take(Currency.wrap(currency), revenueDistributor, amount);
    emit FeeCollected(currency, amount);
}

// TegridyFeeHook.sol:312-317 — propose
function proposeSyncAccruedFees(address currency, uint256 actualCredit) external onlyOwner {
    bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
    pendingSyncCredit[currency] = actualCredit;
    _propose(key, SYNC_DELAY);
    ...
}
```

**Recommendation:**
While a sync proposal is pending for a `currency`, lock `claimFees(currency, ...)`:
```solidity
function claimFees(address currency, uint256 amount) external nonReentrant {
    bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
    require(_proposalReadyAt(key) == 0, "SYNC_PENDING");
    ...
}
```
Pattern: Compound's COMP claim is paused during governance-pending parameter changes. Alternatively, restrict `claimFees` to an authorized keeper / distributor / owner.

---

## [D-AMM-M2] `harvest()` bumps `lastHarvestAt` even on no-op harvests, enabling griefing of the 5-minute cadence
**Severity:** Medium
**File:** `contracts/src/TegridyPair.sol:330-346`
**Category:** dos

**Bug:**
`harvest()` writes `lastHarvestAt = block.timestamp` at line 340 BEFORE `_mintFee` runs at line 342. If `_mintFee` mints zero (because `feeTo == address(0)`, OR `rootK == rootKLast`, OR `liquidity` rounds to 0), the function STILL succeeds and bumps the harvest interval forward by 5 minutes. A griefer can call `harvest()` exactly at every `lastHarvestAt + 5min` to:
- Block legitimate keepers from materializing protocol fees on a high-volume pair (their tx fails `HARVEST_TOO_SOON`).
- Permanently capture all dust-rounded fee growth (each call advances `kLast` to current K via line 344, but mints 0 LP because numerator/denominator rounds to 0 between two close-cadence calls).

This compounds with 001 audit's M-2 (dust harvest griefing): in M-2 the issue is **kLast bumped without minting**; in this finding the issue is **lastHarvestAt bumped without minting**, which gates legitimate keepers.

The microscope's R016 M-1 NatSpec argued harvest-MEV is uneconomic. But the griefing here doesn't require profitability — it only requires the **denial** of the protocol's fee materialization, which is profitable to **anyone holding LP** (since unrealized fees-in-K dilute their LP proportionally less).

**Attack / Impact:**
LPs with significant pool share grief harvest by spamming at the 5-min cadence. The protocol's `feeTo` materialization permanently lags. Every 5-min call costs the griefer ~50k gas (the function does state writes); on a cheap-gas chain this is cents per call, ~$80/day to brick harvest indefinitely.

**Evidence:**
```solidity
// TegridyPair.sol:330-346
function harvest() external nonReentrant {
    require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
    require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
    require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
    lastHarvestAt = block.timestamp;   // <-- bumps even if _mintFee mints zero
    (uint112 _reserve0, uint112 _reserve1,) = getReserves();
    bool feeOn = _mintFee(_reserve0, _reserve1);
    if (feeOn) {
        kLast = uint256(_reserve0) * uint256(_reserve1);
    }
}
```

**Recommendation:**
Only bump `lastHarvestAt` if a non-zero fee LP was actually minted:
```solidity
function harvest() external nonReentrant {
    require(...);
    require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
    (uint112 _reserve0, uint112 _reserve1,) = getReserves();
    uint256 supplyBefore = totalSupply();
    bool feeOn = _mintFee(_reserve0, _reserve1);
    require(totalSupply() > supplyBefore, "NO_FEE_TO_MATERIALIZE");
    lastHarvestAt = block.timestamp;
    if (feeOn) kLast = uint256(_reserve0) * uint256(_reserve1);
}
```
Or move the `lastHarvestAt` write to AFTER a successful mint, with an `onlyMinted` guard. Pattern: Curve `claim_admin_fees` aborts on zero-mint without state mutation.

---

## [D-AMM-M3] FeeHook `claimFees` does not respect `paused()` — drains fees while hook is supposedly halted
**Severity:** Medium
**File:** `contracts/src/TegridyFeeHook.sol:299-306, 199-201`
**Category:** gov

**Bug:**
`afterSwap` correctly returns 0 when `paused()` (line 199-201) — no new fees accrue. But `claimFees`, `proposeSyncAccruedFees`, `executeSyncAccruedFees`, `cancelSyncAccruedFees`, `proposeFeeChange`, `executeFeeChange`, `proposeDistributorChange`, `executeDistributorChange`, and `sweepETH` are all callable during `paused()`. The pause is intended as a circuit breaker (per L-05 NatSpec), but its scope is narrow: only the fee-collection ingestion path is paused.

**Attack / Impact:**
Owner discovers a critical bug, calls `pause()`. RevenueDistributor (or a malicious downstream contract) is identified as compromised. Owner attempts to redirect fees by calling `proposeDistributorChange(safeAddress)` — works, 48h timelock. **In the interim, anyone calls `claimFees(currency, accruedFees[currency])` and drains the balance to the still-compromised distributor.** Pause didn't help. The owner's only recourse is `sweepETH` (which only works for ETH, not currency tokens).

**Evidence:**
```solidity
// TegridyFeeHook.sol:299-306 — no whenNotPaused
function claimFees(address currency, uint256 amount) external nonReentrant {
    if (amount > accruedFees[currency]) revert ExceedsAccrued();
    accruedFees[currency] -= amount;
    poolManager.take(Currency.wrap(currency), revenueDistributor, amount);
    ...
}
```

**Recommendation:**
Add `whenNotPaused` to `claimFees` (and consider `executeSyncAccruedFees`, since drift-corrections during a pause are also unsafe). Better: split the pause into `pauseAfterSwap()` and `pauseClaim()` so operators can pause ingest separately from drains. Pattern: OpenZeppelin Pausable + role-gated subsystem flags (e.g., Aave's "freeze" vs "pause" distinction).

---

## [D-AMM-M4] FeeHook `executeSyncAccruedFees` reads `poolManager.balanceOf` AT execute time, not at propose time — front-runnable downward racing
**Severity:** Medium
**File:** `contracts/src/TegridyFeeHook.sol:334-365`
**Category:** mev

**Bug:**
The H-5 mitigation (R014 upward-sync ceiling) bounds upward syncs by `poolManager.balanceOf(this, currency)` read at **execute** time. The owner proposes `actualCredit` 24h+ in advance. But during the 24h window, anyone can call `claimFees(currency, ...)` to drain the on-chain credit balance — at execute time, the now-reduced `onChainCredit` may be **lower than the originally proposed `actualCredit`**, so `revert AboveOnChainCredit()`. The legitimate sync proposal is consequently DoSed.

**Attack / Impact:**
Owner detects under-counting drift on `accruedFees[USDC]` (e.g., 1000 actual vs 950 stored). Proposes sync up to 1000. Attacker calls `claimFees(USDC, 950)` — distributor receives 950 USDC, on-chain credit drops to 50. 24h later, `executeSyncAccruedFees(USDC)` reverts because 1000 > 50. The owner's drift-correction is permanently blocked unless they re-propose with each cancel-and-retry costing another 24h.

Combined with D-AMM-M1, this is a structural pattern: every owner-initiated correction is racing-vulnerable to permissionless `claimFees`.

**Evidence:**
```solidity
// TegridyFeeHook.sol:344-358
if (actualCredit > old) {
    uint256 onChainCredit = poolManager.balanceOf(
        address(this),
        CurrencyLibrary.toId(Currency.wrap(currency))
    );
    if (actualCredit > onChainCredit) revert AboveOnChainCredit();
    if (old > 0) {
        uint256 increase = actualCredit - old;
        uint256 maxIncrease = (old * MAX_SYNC_INCREASE_BPS) / 10000;
        if (increase > maxIncrease) revert SyncIncreaseTooLarge();
    }
}
```

**Recommendation:**
Snapshot `onChainCredit` at propose time and store it alongside `pendingSyncCredit[currency]`. At execute time, require `actualCredit <= snapshottedOnChainCredit`. This decouples the sync target from in-flight `claimFees` activity. Pattern: Compound's pending-cap-based proposals.

Alternative: lock `claimFees(currency)` while a sync proposal is pending for that currency (see D-AMM-M1's recommendation — single fix closes both).

---

## [D-AMM-M5] TWAP `consult` can return manipulated price for up to MIN_PERIOD when only-bypass-observation is in window
**Severity:** Medium
**File:** `contracts/src/TegridyTWAP.sol:395-430, 515-597`
**Category:** oracle

**Bug:**
`consult(pair, ...)` returns `(amountIn * priceDiff) / (uint256(elapsed) * Q112)` where `priceDiff = priceCumEnd - priceCumStart` and `priceCumStart` is the closest observation BEFORE `latest.timestamp - period`. If the only observation in the lookup window is a `bypassed=true` entry (D-AMM-H1 / H3 prevent honest follow-ups for ≥1 day), then `consult` happily returns a price derived entirely from the bypass cumulative. The `bypassed` flag is set on the OBSERVATION, but `consult` does NOT inspect it — it only checks `staleness` against `MAX_STALENESS = 2h` (which the bypass observation passes since it was recorded recently).

The microscope flagged M-AMM4 ("`consult()` doesn't surface `bypassed` flag in return value"). This finding is the **active concretization**: not just informational drift, but an actual price-feed bug for any consumer that doesn't poll `getLatestObservation()` separately.

**Attack / Impact:**
1. Attacker triggers D-AMM-H1 — bypass observation poisoned with manipulated spot.
2. The follow-up observations are all bricked by the deviation gate (D-AMM-H1).
3. After ~2h, the previous-non-bypass observation falls out of the staleness window.
4. The buffer effectively contains: `[..., honest_old, BYPASSED_POISONED]` where `honest_old` is now too stale.
5. `consult(pair, period=15min)` returns `(latestCum - bestCum) / elapsed`. `latest = poisoned`. `best = (the poisoned obs is the only non-stale one — but consult finds an older one in the buffer)`. If `best.timestamp == latest.timestamp`, revert. If best is stale-but-in-window, the diff is dominated by the poisoned cumulative.

**Evidence:**
```solidity
// TegridyTWAP.sol:395-430 — consult does NOT check `bypassed` on either obs
function consult(address pair, address tokenIn, uint256 amountIn, uint256 period) external view returns (uint256 amountOut) {
    SequencerCheck.checkSequencerUp(...);
    if (factory.disabledPairs(pair)) revert PairDisabledOracle();
    if (amountIn == 0) revert InvalidAmount();
    if (period == 0) revert InvalidAmount();
    if (period > uint256(MAX_OBSERVATIONS) * MIN_PERIOD) revert PeriodTooLong();
    ...
    (uint256 priceCumStart, uint256 priceCumEnd, uint32 elapsed) =
        _getCumulativePricesOverPeriod(pair, isToken0, period);
    // No `if (latest.bypassed) revert` here, no `if (best.bypassed) ...`
    ...
}
```

**Recommendation:**
At minimum, in `consult` revert if `latest.bypassed == true` (force consumers to wait for a confirming observation):
```solidity
Observation memory latest = observations[pair][latestIdx];
if (latest.bypassed) revert OracleRebootstrapping();
```
Even better: track a per-pair `bypassedCountInWindow` and revert if any observation in [latest - period, latest] is bypassed. Pattern: Aave V3 PriceOracleSentinel + the microscope's section §3 H16 fix template (`_safeConsult`).

---

## [D-AMM-L1] FeeHook `executeSyncAccruedFees` has no `actualCredit != old` no-op guard
**Severity:** Low
**File:** `contracts/src/TegridyFeeHook.sol:334-365`
**Category:** gov

**Bug:**
`proposeSyncAccruedFees(currency, actualCredit)` allows `actualCredit == accruedFees[currency]` — a perfect no-op proposal. Execute path runs through the timelock ceremony, sets `lastSyncExecuted[currency] = block.timestamp`, advancing the 7-day cooldown for FREE. A captured/compromised owner can use this to **bypass the SYNC_COOLDOWN restriction**: propose a no-op sync, execute it, then immediately propose a real downward sync (still 24h later but no longer 7 days).

**Wait** — re-reading line 337: `require(block.timestamp >= lastSyncExecuted[currency] + SYNC_COOLDOWN, "SYNC_COOLDOWN");` — the cooldown gate is on **execute**. So executing a no-op does ADVANCE `lastSyncExecuted`, locking the next execute by another 7 days. That's the OPPOSITE of an attack — it's actually self-restricting. So the no-op is harmless to safety but wastes a proposal slot for 7 days.

The actual concern: an attacker who is the OWNER (compromised) can propose a no-op deliberately to **delay legitimate sync recovery** by 7 days. Combined with D-AMM-M4 racing, this gives 7 days of windows for `claimFees` to drain mis-counted balances.

**Evidence:**
```solidity
// TegridyFeeHook.sol:312-317 — no SAME_VALUE check on actualCredit vs accruedFees[currency]
function proposeSyncAccruedFees(address currency, uint256 actualCredit) external onlyOwner {
    bytes32 key = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
    pendingSyncCredit[currency] = actualCredit;
    _propose(key, SYNC_DELAY);
    emit SyncProposed(currency, actualCredit, _executeAfter[key]);
}
```

**Recommendation:**
Add `require(actualCredit != accruedFees[currency], "SAME_VALUE")` in propose. Mirrors the L-03 fix from the microscope's TegridyFactory.

---

## [D-AMM-L2] TegridyFactory `proposeGuardianChange` allows same-guardian no-op proposals
**Severity:** Low
**File:** `contracts/src/TegridyFactory.sol:438-443`
**Category:** gov

**Bug:**
`proposeGuardianChange(_newGuardian)` does not require `_newGuardian != guardian`. Identical to the L-03 in the 003 audit (proposeFeeToChange) but for the GUARDIAN_CHANGE timelock. A no-op proposal occupies the proposal slot for 48h, blocking legitimate rotations.

**Evidence:**
```solidity
// TegridyFactory.sol:438-443
function proposeGuardianChange(address _newGuardian) external {
    require(msg.sender == feeToSetter, "FORBIDDEN");
    pendingGuardian = _newGuardian;
    _propose(GUARDIAN_CHANGE, GUARDIAN_CHANGE_DELAY);
    emit GuardianChangeProposed(guardian, _newGuardian, _executeAfter[GUARDIAN_CHANGE]);
}
```

**Recommendation:**
Add `require(_newGuardian != guardian, "SAME_GUARDIAN");` in propose. Pattern: every other propose function in TegridyFactory has this guard except this one.

---

## [D-AMM-L3] TegridyTWAP `withdrawFees` uses raw `.call` to fee recipient — reentrant via permissionless trigger
**Severity:** Low
**File:** `contracts/src/TegridyTWAP.sol:487-495`
**Category:** reentrancy

**Bug:**
`withdrawFees()` is permissionless. State write `accumulatedFees = 0` happens BEFORE the external call (CEI compliant). But there's no `nonReentrant`, and the contract does not inherit `ReentrancyGuard`. A malicious feeRecipient (set by owner; could be a contract) could re-enter `withdrawFees` from its receive handler — but with `accumulatedFees == 0`, the inner call reverts `NoFees()`. So no immediate drain.

**However**: combined with `update()`'s `accumulatedFees += updateFee` (which does NOT clear before refund), if a malicious **caller** has a fallback that triggers `withdrawFees`, they can extract their own freshly-deposited fee back. Sequence:
1. Caller (a contract with fallback) calls `update(pair)` with `msg.value = 2 * updateFee`.
2. Inside `update`: `accumulatedFees += updateFee`. Now contains caller's fee.
3. Refund call sends `excess = updateFee` to caller. Caller's fallback fires.
4. Inside fallback: caller calls `withdrawFees()` — it DOES have `accumulatedFees > 0` (the fee just deposited). Pulls to feeRecipient. **But this is the legitimate behavior — fees go to feeRecipient as designed.** The caller doesn't gain anything.

So no exploit. But the **lack of any reentrancy guard** is fragile — future code changes could break the CEI. Defense-in-depth recommendation.

**Evidence:**
```solidity
// TegridyTWAP.sol:487-495
function withdrawFees() external {
    uint256 amount = accumulatedFees;
    if (amount == 0) revert NoFees();
    accumulatedFees = 0;
    address to = feeRecipient == address(0) ? owner : feeRecipient;
    (bool ok,) = to.call{value: amount}("");
    require(ok, "WITHDRAW_FAILED");
    emit FeesWithdrawn(to, amount);
}
```

**Recommendation:**
Inherit `ReentrancyGuard` on `TegridyTWAP` and add `nonReentrant` to both `update()` and `withdrawFees()`. Update is the bigger concern — see 013 M-5 (microscope did not re-propose this). Pattern: every other Tegridy contract handling ETH inherits OZ ReentrancyGuard.

---

## [D-AMM-L4] FeeHook `sweepETH` always sends to current `revenueDistributor`, no override for unblocked recovery
**Severity:** Low
**File:** `contracts/src/TegridyFeeHook.sol:464-470`
**Category:** gov

**Bug:**
If the `revenueDistributor` becomes a reverting contract (e.g., bug, or the owner accidentally `proposeDistributorChange`'d to a contract that always reverts on receive), `sweepETH()` permanently fails because `(success, ) = payable(revenueDistributor).call{value: balance}` returns `success=false` → revert. Owner's only recourse is `proposeDistributorChange` (48h timelock) before they can sweep. Meanwhile, all `receive()` ETH is locked.

**Evidence:**
```solidity
// TegridyFeeHook.sol:464-470
function sweepETH() external onlyOwner {
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_ETH");
    (bool success,) = payable(revenueDistributor).call{value: balance}("");
    if (!success) revert SweepFailed();
    emit ETHSwept(revenueDistributor, balance);
}
```

**Recommendation:**
Add an owner-specified recipient parameter:
```solidity
function sweepETH(address to) external onlyOwner {
    require(to != address(0), "ZERO_ADDR");
    ...
}
```
Or fall back to `owner` if `revenueDistributor` reverts. Pattern: OpenZeppelin Address.sendValue with two-step recovery.

---

## [D-AMM-INFO1] FeeHook flag-bit check `0x3FFF` is correct today but tightly couples to V4 hook-flag count — future flag additions silently bypass exclusivity
**Severity:** Info
**File:** `contracts/src/TegridyFeeHook.sol:129`
**Category:** other

**Bug:**
`require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");`

`0x3FFF` masks the lower 14 bits. Uniswap V4 currently has 14 hook flags (BEFORE_INITIALIZE through AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA, bits 0-13). Future V4 versions may add more flag bits (15, 16, ...). A hook address with such a higher-bit flag set would PASS this check (since `& 0x3FFF` masks it away), but a future PoolManager that respects bit 14 would invoke the unintended hook. This is forward-incompat with V4 evolution.

**Evidence:**
The microscope H1 fix used 0x3FFF to be safe today. But it doesn't future-proof against V4 adding flag bits 14+.

**Recommendation:**
Use `Hooks.permissionsToFlags(...)` from v4-core / v4-periphery if available, or hardcode the maximum mask conservatively (e.g., `0xFFFF` for the full 16-bit V4 flag space, even if currently only 14 bits are used). Pattern: defensive-future-proof pin.

---

## [D-AMM-INFO2] TegridyFactory `_rejectERC777` staticcalls token without gas cap — gas-bomb tokens grief permissionless `createPair`
**Severity:** Info
**File:** `contracts/src/TegridyFactory.sol:294-338`
**Category:** dos

**Bug:**
`_rejectERC777` invokes `token.staticcall(...)` for `supportsInterface` and `granularity` without a gas cap. A malicious token can implement these to consume nearly all available gas, OOG-griefing legitimate `createPair` callers who under-estimate gas. The audit 003 M-2 already flagged this; reflagging for completeness — no fix shipped.

**Evidence:**
```solidity
// TegridyFactory.sol:298-313
(bool ok, bytes memory result) = token.staticcall(
    abi.encodeWithSelector(0x01ffc9a7, bytes4(0xe58e113c))
);
...
(bool grOk, bytes memory grResult) = token.staticcall(
    abi.encodeWithSelector(bytes4(keccak256("granularity()")))
);
```

**Recommendation:**
Cap at `staticcall{gas: 30_000}`. Pattern: OpenZeppelin Address.functionStaticCall has gas safeguards.

---

## Cluster-spanning patterns

1. **Permissionless drains race admin corrections.** D-AMM-M1, M3, M4 all flow from the FeeHook design where `claimFees` is permissionless and admin paths (`pause`, `proposeSync`, `proposeDistributor`) take effect with delay. The single architectural fix: **lock `claimFees(currency)` while any pending state for that currency is in flight**, OR gate `claimFees` to a keeper allowlist.

2. **Bypass anchor poisoning is the new bootstrap attack.** D-AMM-H1, H3, M5 are all manifestations of the same fact: the dormancy-bypass observation behaves as an anchor for the deviation gate but lacks the H3-fix's owner-only protection. The single architectural fix: **gate the bypass branch behind `onlyOwner`** OR require a confirming observation before promoting `lastSpot`.

3. **`disabledPairs` half-installed coverage.** Microscope's M-AMM1 added the gate to `harvest()` but missed `sync()` and `skim()` (still missing in current source). D-AMM-H2 weaponizes this for TWAP poisoning, not just balance griefing — highlighting that the microscope's "sibling search" recommendation from §4 is still not fully landed. Recommend: a single search pass for every `factory.disabledPairs(...)` call site to confirm parity across mint/burn/swap/sync/skim/harvest.

4. **No buffer-rotation / emergency reset path on TegridyTWAP.** D-AMM-H3 highlights an architectural gap: poisoned state has no recovery primitive. Combined with H1, H2, this means a single successful manipulation (or a single-block legit-but-unlucky event) requires re-deploying the oracle. Add an `adminResetPair(pair)` with timelock as a recovery path.
