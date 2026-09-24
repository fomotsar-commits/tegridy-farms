# Agent 031 — Slippage / MEV / Sandwich Forensic Audit

Scope: TegridyPair, TegridyRouter, SwapFeeRouter, TegridyFeeHook, POLAccumulator,
RevenueDistributor, TegridyLending, TegridyNFTPool, TegridyLaunchpadV2.

Methodology: every external swap entry point inspected for (a) caller-supplied
`amountOutMin` / `maxIn`, (b) deadline + cap, (c) reliance on spot reserves /
`getAmountsOut` as price source, (d) owner-controlled "execute" with weak
slippage caps, (e) JIT-LP / sandwich-around-internal-swap surface,
(f) tightness of `MAX_DEADLINE` and slippage caps. Test surface compared
against attack list.

------------------------------------------------------------------
## HIGH

### H-1 — TegridyLending `_positionETHValue` uses spot reserves as oracle
**File:** `contracts/src/TegridyLending.sol:715-723`, called from `:430`
**Vector:** Sandwich-manipulable in same tx. Borrower flash-pumps WETH side
of TegridyPair right before `acceptOffer`, satisfies `minPositionETHValue`
floor on a position whose true ETH value is below the lender's threshold,
then unwinds the pump after the loan transfer. Lender ends up holding NFT
collateral worth less than the loan principal.
**Evidence:** `TegridyLending_ETHFloor.t.sol:211 test_sandwich_sameBlockManipulation_succeeds`
already PROVES this attack succeeds. Comment at `:704-711` admits the issue
("IS sandwich-manipulable inside the same transaction").
**Mitigations partial:** lender opt-in (zero = disabled), 2h `MIN_DURATION_FLOOR`,
TWAP migration tracked in SECURITY_DEFERRED.md. None fix the in-tx attack.
**Severity:** HIGH (lender capital direct loss, on-chain proven exploit).
**Recommendation:** integrate TegridyTWAP read; require >=2 cumulativePrice
ticks of staleness; reject if delta(spot, twap) > 5%.

### H-2 — POLAccumulator `accumulate()` is a high-value MEV target the owner can self-sandwich
**File:** `contracts/src/POLAccumulator.sol:238-307`
**Vector:** Single transaction does (1) `swapExactETHForTokens` half the
ETH balance for TOWELI, then (2) `addLiquidityETH` with the remainder.
Caller-supplied `_minTokens` / `_minLPTokens` / `_minLPETH` are bounded
ONLY by `maxSlippageBps` (default 500 bps = 5%) and `backstopBps` (default
9000 bps = 90% of expected). The owner can call this from the public
mempool and a sandwich bot trivially extracts up to 5% of every
accumulation. Worse, a malicious owner can deliberately set `_minTokens`
near zero and run the ETH→TOWELI swap themselves.
**Mitigations partial:** `MAX_DEADLINE = 2 minutes`, 1h cooldown,
`MAX_ACCUMULATE_CAP = 100 ether`. The 5% slippage at 100 ETH = 5 ETH MEV
PROFIT per call, capped only by the cap.
**Severity:** HIGH (recurring extractable value; protocol-funded MEV bounty).
**Recommendation:** require Flashbots-Protect-only (verify `tx.origin == owner`
already removed per H-05 — can't reinstate; instead: split the swap
across blocks via a 2-step propose/execute, or quote against a TWAP and
revert on >50bps delta).

### H-3 — POLAccumulator `executeHarvestLP` removes 10% of POL with caller-supplied minOut
**File:** `contracts/src/POLAccumulator.sol:450-486`
**Vector:** Owner-only `removeLiquidityETH` lifts up to
`MAX_HARVEST_BPS = 10%` of `totalLPCreated` per call. `minToken`/`minETH`
are caller-supplied with NO floor (no `maxSlippageBps` defence here, unlike
`accumulate()`). On `MAX_DEADLINE = 2 minutes` window an MEV bot can
sandwich the LP burn (price shift the underlying pair, dump into the
post-burn pool). 10% of the POL position is LP-bug-class.
**Severity:** HIGH (large MEV extraction on each harvest).
**Recommendation:** reuse `maxSlippageBps` floor from `accumulate()` here;
also feed `minToken`/`minETH` from a TWAP read, not caller input.

### H-4 — SwapFeeRouter `convertTokenFeesToETH` gives caller full control of slippage on protocol fees
**File:** `contracts/src/SwapFeeRouter.sol:1089-1130`
**Vector:** Permissionless. Caller passes `minETHOut`. The protocol's
`accumulatedTokenFees[token]` is swapped to ETH at whatever price the
caller accepts. With a zero `minETHOut` and a sandwich, an attacker drains
~all value of the accumulated balance into MEV.
**Mitigations partial:** AUDIT NEW-A5 added `CONVERSION_COOLDOWN = 1 hour`
per token (line 113-114 and 1107). This raises the per-call cost but does
NOT prevent loss against a single accumulated balance.
**Severity:** HIGH on first attack against unconverted balance.
**Recommendation:** compute `minETHOut` floor on-chain from a TWAP / oracle;
reject `< 99%` of TWAP-implied output.

------------------------------------------------------------------
## MEDIUM

### M-1 — TegridyRouter `MAX_DEADLINE = 2 hours` allows stale intents
**File:** `contracts/src/TegridyRouter.sol:40, 47-50`
**Vector:** A signed off-chain swap intent with `deadline = now + 2h` can
sit in the mempool for ~2h. During that window any minOut tolerant of
moderate slippage can be sandwiched. Comment at `:38-39` says the bound
was raised from 30m to 2h "to avoid bricking swaps during sustained
congestion". The trade-off favors UX over MEV resistance.
**Severity:** MEDIUM (broadens MEV window for honest users).
**Recommendation:** keep 2h cap but document in UI; add EIP-2612-style
nonce so user can cancel cheaply.

### M-2 — Non-trivial `maxSlippageBps` ceiling on POLAccumulator is 10%
**File:** `contracts/src/POLAccumulator.sol:60-61, 161`
**Vector:** Owner can `proposeMaxSlippage(1000)` (=10%). At 100 ETH cap
that is up to 10 ETH MEV per accumulate. 24h timelock observable but no
upper-cap enforced beyond 1000 bps.
**Severity:** MEDIUM (governance lever can widen MEV window).
**Recommendation:** lower `MAX_SLIPPAGE_BPS_HARDCAP` to 200 (2%).

### M-3 — TegridyRouter uses `getAmountsOut()` as price source then enforces same minOut
**File:** `contracts/src/TegridyRouter.sol:172, 206`
**Vector:** `swapExactTokensForTokens` calls `amounts = getAmountsOut(amountIn, path)`
THEN `if (amounts[last] < amountOutMin) revert`. The check is
`getAmountsOut` reading current spot reserves at execution — the very
state that just got front-run. So the user's `amountOutMin` is the only
real defence; the in-function `amounts[last]` calculation is not protective.
This is the canonical Uniswap V2 design and is accepted, but the
inconsistency between the SwapFeeRouter wrapper (which does additional
post-swap output checks via balance delta) and core Router is worth
noting.
**Severity:** MEDIUM (Uniswap V2 canonical, but worth documenting).
**Recommendation:** add a balance-delta sanity check post-swap.

### M-4 — Lending grace period (1h) extends MEV manipulation window
**File:** `contracts/src/TegridyLending.sol:120, 524`
**Vector:** `GRACE_PERIOD = 1 hours` extends the window during which the
spot-reserve-based ETH-floor check from H-1 remains relevant for
related operations. Within the borrower's manipulation window, lenders
have no defensive recourse.
**Severity:** MEDIUM (compounds H-1).

### M-5 — TegridyFeeHook fee returns absolute value, no per-block sandwich check
**File:** `contracts/src/TegridyFeeHook.sol:167-249`
**Vector:** `afterSwap` charges `feeBps` on output amount. The user's
slippage check on the swapping router runs BEFORE the hook reduces output.
On exact-input swaps with tight `amountOutMin`, the hook reduces output
post-check, which is by design but means UI-displayed prices must include
hook fee; otherwise users see slippage they didn't budget for. Not exploit
but UX-MEV interaction.
**Severity:** LOW-MEDIUM.

### M-6 — TegridyPair `swap()` allows back-running via permissionless `harvest()`
**File:** `contracts/src/TegridyPair.sol:280-286`
**Vector:** New permissionless `harvest()` call materializes accrued
protocol fee LP tokens. An MEV searcher can back-run a large swap →
`harvest()` → claim a fraction of the LP fee accrual. Not loss to LPs
(this is just realising owed fee), but allows MEV searchers to compete
with each other for execution; the protocol always gets the LP, just
gas leaks to the searcher who calls. Not exploitable for capital loss.
**Severity:** INFO/LOW (gas-extractable, not capital).

------------------------------------------------------------------
## LOW

### L-1 — SwapFeeRouter FoT variants pass `amountOutMin = 0` to inner Uniswap
**File:** `contracts/src/SwapFeeRouter.sol:543-544, 608-610, 671-673`
**Vector:** Inner router's amountOutMin is zeroed out so balance-delta
post-swap check works. The contract's own check (`if (userAmount < amountOutMin)`)
is correct but happens AFTER the swap, so the actual swap is unprotected
inside the inner router. A revert at the post-check refunds nothing other
than the gas used (state changes already happened on the input side).
Battle-tested pattern (canonical Uniswap V2 FoT helpers do same), but
worth flagging.
**Severity:** LOW (canonical FoT pattern).

### L-2 — POLAccumulator `proposeMaxSlippage` allows up to 1000 bps
**File:** `contracts/src/POLAccumulator.sol:161`
**Vector:** Range check `_bps < 100 || _bps > 1000` permits 10%. With 24h
timelock observability, a rogue/compromised owner that has waited 24h can
push slippage to 10% before next accumulate.
**Severity:** LOW (timelocked).

### L-3 — TegridyNFTPool `swapNFTsForETH` lacks per-item price floor
**File:** `contracts/src/TegridyNFTPool.sol:232-264`
**Vector:** Only `minOutput` (total). Attacker can sandwich a large multi-NFT
sell. Mitigated because user can split sells; not a contract bug per se.
**Severity:** LOW.

------------------------------------------------------------------
## INFO

- `TegridyPair.swap` is canonical UniV2 — no flash-swap, no callback. K-check
  on raw reserves (line 220). Solid baseline.
- `TegridyRouter.swapExactTokensForTokens` etc. — all paths have
  `amountOutMin`/`amountInMax` plus `deadline`/`MAX_DEADLINE = 2h`.
- TegridyLaunchpadV2 has NO swap path — purely a clone factory. Out of scope.
- RevenueDistributor reads no spot reserves and performs no swaps.
- TegridyFeeHook fee math is reserve-independent (uses delta from PoolManager).
- Owner-triggered "execute" surfaces audited:
  - `accumulate()` — caller minOut + 2m deadline + 1h cooldown (covered H-2).
  - `executeHarvestLP` — caller minOut + 2m deadline (covered H-3).
  - `convertTokenFeesToETH` — caller minOut + 1h cooldown (covered H-4).

------------------------------------------------------------------
## Test-Coverage Gaps (FuzzInvariant.t.sol / FuzzV3.t.sol / RedTeam_AMM.t.sol)

**Present:**
- `RedTeam_AMM.test_ATTACK9_sandwichAttack` — informational, on the
  Router. Confirms amountOutMin = 0 is exploitable (by design).
- `TegridyNFTPool_Sandwich.test_sandwich_*` — 4 tests covering buy/sell
  slippage on the bonding-curve pool.
- `TegridyLending_ETHFloor.test_sandwich_sameBlockManipulation_succeeds`
  — DOCUMENTS the H-1 attack but doesn't gate it.
- `FuzzInvariant.invariant_kNeverDecreases` — protects K (good).

**MISSING (recommended new tests):**
1. `test_POL_accumulate_sandwich_extractsValue` — invoke
   `POLAccumulator.accumulate` with adversarial reserves; assert
   ATTACKER_PROFIT == 0 (currently fails).
2. `test_POL_executeHarvestLP_sandwich` — same for harvestLP.
3. `test_SwapFeeRouter_convertTokenFeesToETH_zeroMinOut_sandwich` —
   prove H-4. Set `minETHOut = 1`, sandwich, assert protocol loss.
4. `test_lending_acceptOffer_floor_TWAPDefence` — once TWAP is wired,
   should revert when spot != TWAP.
5. `test_router_FoT_innerZeroMinOut_sandwich` — exercise the L-1
   inner-zero-minOut surface. Confirm post-check rolls back fully.
6. `invariant_swap_outputBalanceMatchesGetAmountsOut` — cross-validate
   `getAmountsOut` against actual delta in TegridyPair.
7. `test_Pair_harvest_backrun_LPSlippage` — back-run harvest after a
   swap; verify no LP receives a worse share than before harvest.

**FuzzV3.t.sol contains NO swap-related sandwich/MEV invariants** — the file
is mostly bonding-curve and lending math. Adding the above 7 tests closes
the slippage/MEV coverage gap.

------------------------------------------------------------------
## Counts

- HIGH: 4
- MEDIUM: 6
- LOW: 3
- INFO: 6
- Test-coverage gaps: 7

Top-5 most exploitable (by ROI for an attacker):
1. **H-2 POLAccumulator.accumulate** sandwich — recurring 5% of every
   `accumulate()` call up to 100 ETH cap; bot-extractable.
2. **H-1 TegridyLending spot-reserve floor** — proven attack in
   existing test; lender direct capital loss.
3. **H-3 POLAccumulator.executeHarvestLP** — 10% of position per call
   with no slippage cap floor.
4. **H-4 SwapFeeRouter.convertTokenFeesToETH** — first-mover attacker
   can sandwich any converted token-fee balance.
5. **M-1 TegridyRouter MAX_DEADLINE = 2h** — broad sandwich window for
   every user trade.
