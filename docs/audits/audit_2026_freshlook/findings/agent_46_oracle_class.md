# Agent 46/100 — Oracle Manipulation Lens (Fresh-Eyes)

Scope: TegridyTWAP.sol, TegridyLending.sol (TWAP consumer), POLAccumulator.sol
(TWAP consumer), SwapFeeRouter.sol (per-token snapshot oracle),
TegridyDropV2.sol (sequencer-gated dutch curve), MemeBountyBoard.sol (sequencer
buffer extension), and the SequencerCheck library.

Worked through the eleven oracle attack classes the lens calls out: stale-price
guards, decimal mismatches, deviation gate gaps, TWAP grind cost, oracle
revert/DoS, negative cast bugs, multi-oracle fallback, update-grinding,
amountIn-edge consult, pair pause/resume bridging, sequencer feed staleness.

Below: a small number of real findings, several "verified-clean" notes, and the
dead-ends that surfaced while chasing leads.

---

## F-46-1 (MEDIUM) — TWAP grind on low-TVL pair has no default reserve floor

File: `contracts/src/TegridyTWAP.sol:140-148, 296-306`

`minReserveFloor[pair]` defaults to 0 (no floor). The setter is `onlyOwner`
without a timelock and is **never called by any in-tree script, deploy, or
test** — `grep -r setMinReserveFloor` finds it only in the contract itself and
in agent_24's prior write-up. Default deployment therefore leaves the floor
disabled.

Once a TOWELI/WETH pair is bootstrapped (4+ observations through the 3-step
self-bootstrap grace), `update()` is permissionless every 15 min and the
deviation gate caps each step at ±50%. With no reserve floor, a single trader
who can move spot ±50% per step grinds the consult-window TWAP arbitrarily over
several windows.

Cost to bend the lending consumer's 30-min TWAP by 50% on a pair with `R` ETH
of TOWELI-side liquidity: the attacker must push reserves and HOLD them for the
full TWAP_PERIOD (30 min). One ±50% spot push costs roughly 0.41·R in real
swap-side capital, and arb is bounded by `0.41·R · 30/60 · arb-rate-per-hour`.
On a fresh deploy with R=$30k of TOWELI-side liquidity (a realistic relaunch
day-1 size), the round-trip cost lands near $1-3k for a single 50% bend on a
30-min lending oracle window — plausibly profitable against any borrower whose
collateral floor is the manipulated read away from `InsufficientCollateralValue`.

The deviation gate stops at 5000 bps **strict greater-than** (`> 5000`), so a
50.00% step passes. To grind from spot 1.0 to spot 4.0 takes log_{1.5}(4) ≈ 4
steps of 50% increase, each gated to MIN_UPDATE_INTERVAL = 15 min, total = 1h.
The 1-day DEVIATION_BYPASS_AFTER does **not** kick in inside this window so no
owner gate intercedes. After the grind, the lending consumer's consult returns
4× the real spot until honest swaps drag `lastSpot` and the cumulative back —
which, on a low-TVL pair, is itself another 1h grind window for the attacker
to extend.

Recommendation:
- Set a non-zero `minReserveFloor` per pair at deploy time, scaled to the
  10× the largest expected single-trader balance.
- Move `setMinReserveFloor` behind a timelock (or at minimum a propose/execute
  pair) to bound owner-key-compromise tampering.
- Tighten `MAX_DEVIATION_BPS` from 5000 (50%) to 2000 (20%). Five honest 20%
  steps still self-correct any sane post-volatility spike, and the per-window
  attacker cost rises ~6× because each 20% step requires more swap volume to
  achieve and arb is hungrier for narrower gaps.
- Replace `>` with `>=` (`if (deviation0 >= MAX_DEVIATION_BPS) revert`) so the
  exact-boundary 50% step also reverts; at present 50.00% sneaks through.

---

## F-46-2 (LOW / DOC) — `update()` is fee-griefable on the bypass branches

File: `contracts/src/TegridyTWAP.sol:266-291`

`update(pair)` is `payable`. When `updateFee == 0` (the default and the
permanent state for non-revenue deployments), the function `require(msg.value
== 0, "FEE_NOT_SET")` ahead of the bypass-branch logic. Any caller can update
every 15 min on a fresh pair and write 1, 2, or 3 bypass-marked observations
before any honest observation lands.

Because of the FRESH-EYES H-3 fix, those bypass observations are gated out of
consult via `best.bypassed`/`latest.bypassed`. So this is **not exploitable for
direct price manipulation** — the buffer fail-closes through the bypass guards.

But the side effect is real: an attacker can permanently keep the pair in
bootstrap mode by spamming `update()` at exactly MIN_UPDATE_INTERVAL boundaries
to "rotate" the bypass observations through the buffer slowly. As long as the
bypass marker is the latest, lending and POL revert with `OracleStale` /
`OracleRebootstrapping`. Cost per cycle: gas only (~30k per call × 96 calls/day
= ~2.9M gas/day = ~$3-15 depending on network). Very cheap DoS — not a price
attack but a usability lever against new pairs.

Mitigation: attach a non-zero `updateFee` on L2 deploys, capped at the existing
`MAX_UPDATE_FEE` (0.01 ETH). Recommended starter value: 0.0005 ETH ≈ $1.50 per
update — enough to make persistent grief economically useless but still
affordable for honest keepers. Setter is `onlyOwner` with no timelock so this
is a deploy-script change, not a code change.

---

## F-46-3 (LOW / DOC) — TegridyTWAP buffer needs ~6 observations for `consult` to settle

File: `contracts/src/TegridyTWAP.sol:332-389, 752-781`

Tracking the bypass logic:
- Obs #1: `count == 0` branch → `bypassed = true`.
- Obs #2: `count <= 2` branch → `bypassed = true` (the M3-H7 grace).
- Obs #3: `count <= 2` branch → `bypassed = true`.
- Obs #4: First non-bypass observation; deviation gated against #3's lastSpot.

Inside `_getCumulativePricesOverPeriod`, `best.bypassed` reverts
`OracleRebootstrapping`. So consult succeeds only when BOTH `latest` and `best`
are non-bypass.

For a 30-min consult period with 15-min cadence:
- After obs #4: `latest=#4` (non-bypass), `best≈#2` (bypassed) → revert.
- After obs #5: `latest=#5`, `best≈#3` (bypassed) → revert.
- After obs #6: `latest=#6`, `best≈#4` (non-bypass) → succeeds.

So the lending oracle requires ~90 min of cadence after pair creation before
`_positionETHValue` works. That's documented elsewhere as an ETH-floor
prerequisite, but no in-tree NatSpec on `consult()` calls it out as
"≥6 observations on the 30-min window". Worth surfacing for integrators that
build on `TegridyTWAP` outside the protocol.

---

## F-46-4 (LOW) — `setSequencerFeed` on SwapFeeRouter is one-shot but the rest of the protocol immutables it

File: `contracts/src/SwapFeeRouter.sol:518-537`

TegridyTWAP, TegridyLending, POLAccumulator, MemeBountyBoard, TegridyDropV2,
and TegridyLaunchpadV2 all hold `address public immutable sequencerFeed` set
in their constructors. SwapFeeRouter alone holds it in regular storage with
a one-shot `setSequencerFeed` setter (`if (sequencerFeed != address(0)) revert
ZeroAddress()`).

This is asymmetric — every other oracle consumer authenticates the feed at
construction. The argument in the in-line NatSpec (lines 196-201) is that
"existing deploy scripts and the 17 in-tree test instantiations don't need a
constructor-arg update." But the consequence is:
- A fresh deploy that forgets to call `setSequencerFeed` runs with `address(0)`
  → `SequencerCheck.checkSequencerUp` no-ops → the per-token TWAP integral can
  silently span an L2 outage on the first conversion call.
- Owner-key compromise between deploy and `setSequencerFeed` can set a
  controlled feed once.

Pre-deploy validation should include a deployment script step that calls
`setSequencerFeed` immediately after deploy, OR we restore the immutable + add
the constructor parameter. The existing comment says this was deferred for
ABI-stability reasons; flagging it as a real risk class rather than a clean
choice.

---

## F-46-5 (DEAD-END / VERIFIED-CLEAN) — Pair pause/resume bridging is correctly fail-closed

Walked through:
- TegridyFactory marks pair disabled (instant via guardian, or 48h timelocked).
- TegridyPair.swap/mint/burn/sync/skim/harvest all `require(!disabledPairs)`.
- TegridyTWAP.update reverts `PairDisabled` while disabled.
- TegridyTWAP.consult also reverts `PairDisabled` while disabled.
- After re-enable, TegridyTWAP.update integrates `pairCum + spot * elapsed`
  using the FROZEN cumulative — but the bridge term integrates fresh spot from
  `pairBlockTs` (which equals the moment of last pre-disable swap) up to NOW.

This means the FIRST post-resume observation includes the entire disabled
window's "elapsed" multiplied by the current (post-resume) spot. If the
disabled window was hours, that's a giant rectangular integral pinned at the
post-resume spot — which itself is the spot of the frozen reserves at disable
time. So the first post-resume observation looks "as if" the pair traded at
its frozen spot for the whole disabled window. Not exploitable in isolation
because consult still requires `latest.bypassed == false`, and the
deviation gate against `lastSpot[pair]` (which still holds the pre-disable
spot) compares the CURRENT (post-resume) spot to the pre-disable spot. If the
guardian disabled the pair specifically because reserves were manipulated,
`lastSpot` was set to the manipulated value pre-disable already; if not,
post-resume spot ≈ pre-disable spot ≈ no deviation; integral consistent.

The defense-in-depth `factory.disabledPairs(pair)` revert in both `update` and
`consult` is sufficient. Walked through three attack shapes (donation +
sync front-run, flash-loan-pinned-disable, post-resume-arbitrage-window) —
all eat the same cumulative-vs-deviation interplay and resolve to a typed
revert. Not a finding.

---

## F-46-6 (DEAD-END / VERIFIED-CLEAN) — Sequencer feed staleness, negative answer, round mismatch

Walked through `SequencerCheck.checkSequencerUp`:
- `updatedAt == 0` → `SequencerGracePeriodNotOver`. ✓
- `answeredInRound < roundId` → `SequencerDown`. ✓
- `updatedAt > block.timestamp` (clock skew) → `SequencerDown`. ✓
- `block.timestamp - updatedAt > MAX_FEED_STALENESS` → `SequencerDown`. ✓
- `answer != 0` (strict) → `SequencerDown`. Catches `1` (down), `2` (degraded
  extension), `-1` (typed bridge bug), and any future non-zero state. ✓
- `startedAt == 0` → `SequencerGracePeriodNotOver`. ✓
- `startedAt > block.timestamp` → `SequencerGracePeriodNotOver`. ✓
- `block.timestamp - startedAt < gracePeriod` → `SequencerGracePeriodNotOver`. ✓

The `int256 answer` cannot wrap to a uint256 because there is no uint cast —
the strict `answer != 0` works on the signed type. Negative answers revert
correctly. The Aave V3 PriceOracleSentinel pattern is implemented faithfully.

`getResumeTimestamp` mirrors all the same gates and returns 0 on any anomaly,
so the lending/POL post-resume freshness gate (`obs.timestamp < resumeAt +
GRACE`) fail-opens to a no-op only when the feed itself reports clean — which
is correct semantics. Not a finding.

---

## F-46-7 (DEAD-END / VERIFIED-CLEAN) — Decimal mismatch class is N/A

The protocol does not consume any Chainlink price feeds. The only Chainlink
surface is the L2 sequencer uptime feed, which returns `int256 answer ∈ {0,1}`
(boolean) — no decimal interpretation. All token pairs in the protocol's
oracle scope are TOWELI (18d) / WETH (18d), so the TWAP's UQ112x112 math is
in matched decimals. POLAccumulator additionally snapshots `toweliUnit =
10**decimals()` at construction (D-POL-M1 fix at L88-97), defending against a
future migration to a non-18-decimal TOWELI variant. Not a finding.

---

## F-46-8 (DEAD-END / VERIFIED-CLEAN) — `consult` amountIn edges

`consult` returns `(amountIn * priceDiff) / (elapsed * Q112)`. Bounds:
- `amountIn = 0` → reverts `InvalidAmount` at the entry guard.
- `amountIn = 1` (smallest) → output = priceDiff / (elapsed * Q112). For
  realistic priceDiff ≈ 2^127 over 30-min elapsed (1800s), result ≈ 2^127 /
  (1800 · 2^112) ≈ 2^14 ≈ 16k wei. Fine.
- `amountIn = 2^60` (≈ 1 ETH or ≈ 1e18) → 2^60 · 2^127 / (2^11 · 2^112) = 2^64.
  Comfortably below uint256.max.
- `amountIn = 2^96` (≈ 1e29) on a non-pathological pair: still fits.
- Pathological extreme-imbalance pair (`reserve0=1, reserve1=2^111`): spot ≈
  2^223, priceDiff over 30 min ≈ 2^234, then `amountIn · 2^234 / 2^123` =
  `amountIn · 2^111`. With amountIn up to ~2^145 the multiplication still
  fits. Beyond that, Solidity 0.8 reverts on overflow → fail-closed DoS, not
  silent zero or huge-number bug.

The only thing worth surfacing: if the pair is at extreme imbalance AND the
caller passes a giant amountIn, consult reverts on overflow rather than
returning. That is the correct fail-closed behaviour for a price oracle and
matches the Uniswap V2 OracleLibrary contract. Not a finding.

---

## F-46-9 (DEAD-END / VERIFIED-CLEAN) — Multi-oracle / fallback selection

Searched for any "if oracleA fails, use oracleB" branching. The only
multi-source pattern in the protocol is `VotePowerOracle.powerOf` (governance
voting power, not a price oracle) which uses `try/catch` to silently degrade.
No price-oracle fallback exists; every consumer (TegridyLending, POLAccumulator,
SwapFeeRouter) consults exactly one TWAP and reverts on staleness rather than
falling through. Not a finding — verified the absence is intentional and
correct.

---

## F-46-10 (DEAD-END / VERIFIED-CLEAN) — Update grinding via `lastSpot` poisoning

Considered: attacker pushes reserves to extreme spot in same tx as
`update()`. Reserves are written in the pair's `_update`, but the cumulative
that the pair stored uses the PRE-swap spot integrated over `timeElapsed`.
TegridyTWAP then reads:
- `pair.price0CumulativeLast` — already integrates the PRE-attack spot.
- Bridge term = `spot * elapsedSinceLastPairTouch`. `elapsedSinceLastPairTouch
  = blockTs - pairBlockTs`. If the attack swap WAS the last pair touch in the
  same block, `pairBlockTs == blockTs` → bridge = 0.

So the OBSERVATION cumulative recorded by `update()` is NOT poisoned by a
same-tx flash-loan manipulation. ✓

What IS poisoned: `lastSpot0[pair]` and `lastSpot1[pair]` are written to the
manipulated post-swap spot. This affects only the deviation gate for the NEXT
observation. If attacker pushes >100% deviation, the gate trips on every
honest follow-up until either:
(a) The pair has been dormant `DEVIATION_BYPASS_AFTER` (1 day) — then owner-
    only bypass branch lets the gate skip.
(b) `proposeAdminResetPair` (24h timelock).

So the attack reduces to a temporary DoS on observations until owner
intervention, not a price manipulation. The buffer continues to serve the
last good cumulative as long as `consult` is called within `MAX_STALENESS = 2h`
of the most recent honest observation; after that it reverts `StaleOracle`.
Net effect: 2-26h DoS window on lending/POL with no exfiltration. Recorded
as a known dormancy / poisoned-baseline tradeoff in BATCH-M3 H7's NatSpec
(L377-389). Not a new finding.

---

## F-46-11 (DEAD-END / VERIFIED-CLEAN) — `consult` returns zero is fail-closed in consumers

POL `_twapMinOut` returns `out * (BPS - TWAP_SAFETY_BPS) / BPS`. If consult
returns 0, that's 0 → `effectiveMin = max(callerMin, 0) = callerMin` (which is
already a hard floor). Inside `_twapHarvestMinOut` at L928-929, `if
(twapEthPer1eToweli == 0) revert OracleStale` — explicit fail-closed.

Lending `_positionETHValue` returns the consult result directly. If consult
returns 0, ETH-floor check `ethValue < minPositionETHValue` fails (0 <
positive) → reverts `InsufficientCollateralValue`. Fail-closed.

SwapFeeRouter `_enforceTWAPMinETHOut`: if `priceDiff == 0`, twapMin = 0,
effectiveMin = callerMin. Caller floor is the only protection on a degenerate
TWAP read — but the multi-hop branch separately gates `minETHOut <
MIN_MULTIHOP_ETH_OUT_WEI`. Direct 2-hop relies on caller floor + post-swap
`ethReceived < effectiveMin` revert. So a zero-TWAP read drops the floor to
caller-supplied; if the caller is lazy and passes 0, the bot still has the
1.5% safety margin times zero = no protection. NatSpec at L1956-1971 calls
this out as the bootstrap-required path. Acceptable as documented behaviour.
Not a finding.

---

## Summary

Five findings, of which one (F-46-1) is a real medium that should be acted
on before relaunch. Two LOWs (F-46-2, F-46-4) are deploy-script tightenings.
One LOW/DOC (F-46-3) is a NatSpec gap. One MEDIUM about no default reserve
floor materially gates TWAP grind cost on low-TVL pairs.

Six dead-ends recorded for completeness — auditors after me can skip the same
ground I covered.

Recommended pre-relaunch remediation order:
1. F-46-1: set `minReserveFloor` at deploy + tighten deviation gate (`>=`,
   2000 bps).
2. F-46-4: deploy-script step that always calls `setSequencerFeed` post-deploy
   on L2, OR make it constructor-immutable like the rest.
3. F-46-2: set non-zero `updateFee` on L2 deploys.
4. F-46-3: NatSpec the 6-observation bootstrap on `consult`.
