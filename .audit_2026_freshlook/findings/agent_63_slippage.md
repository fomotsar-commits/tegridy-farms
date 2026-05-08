# Agent 63 / 100 — Slippage Parameter Abuse (Fresh Eyes)

Lens: zero `amountOutMin` permissibility, oracle-derived bound bypass, multi-hop per-leg coverage,
deadline mempool warehousing, internal-protocol unprotected swaps, remove-liquidity zero defaults,
oracle decimal mismatch, TWAP manipulability as pseudo-protection.

Working dir: `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms`
Files reviewed (deep): `SwapFeeRouter.sol` (2064L), `TegridyRouter.sol` (570L),
`POLAccumulator.sol` (964L), `TegridyFeeHook.sol` (849L), `TegridyPair.sol`,
`TegridyNFTPool.sol`. Files spot-checked: `TegridyRestaking.sol` (no swap path),
`TegridyLending.sol` (no swap path), `TegridyNFTLending.sol`, `Factory`, `TegridyTWAP`.

---

## F-63-1 (LOW / INFO) — TegridyNFTPool: deadline has no upper-bound cap → mempool warehousing window

**File:** `contracts/src/TegridyNFTPool.sol:257-262` (`swapETHForNFTs`) and
`contracts/src/TegridyNFTPool.sol:326-331` (`swapNFTsForETH`).

**Pattern:** Both swap entries enforce `if (block.timestamp > deadline) revert Expired();`
but DO NOT enforce a `deadline <= block.timestamp + MAX_DEADLINE` upper bound. Compare with
`TegridyRouter.MAX_DEADLINE = 2 hours`, `SwapFeeRouter.MAX_DEADLINE = 2 hours`,
`POLAccumulator.MAX_DEADLINE = 1 minutes`, `TegridyFeeHook.convertERC20FeesToETH` (30 min).

**Risk:** A wallet that signs txs with `deadline = type(uint256).max` ("set and forget") is
exposed to indefinite mempool warehousing. Searcher can park the tx and submit it after a
favorable price drift inside the pool. The `maxTotalCost` / `minOutput` user-supplied bound is
the primary defence — but a tx signed today with a generous bound that is appropriate for
today's spot becomes a free option for the searcher when spot moves toward that bound.

**Mitigating factor:** Spot price within the pool only moves as a function of `swapETHForNFTs`
(spot += delta · n) and `swapNFTsForETH` (spot -= delta · n). It does not drift with the
broader market — only with on-pool flow. So a warehoused buy fires only after another
on-pool buy raises the price toward `maxTotalCost`. Realistic exposure: a coordinated
keeper that floods the pool to push spot just below the warehoused user's `maxTotalCost`
and triggers their tx as the last-block-included swap.

**MEV cost estimate:** Per-tx ≤ (`maxTotalCost` − `inputAmount_at_signing`). Typically
single-digit basis points if user sets `maxTotalCost = inputAmount + 1%`; up to the full
slippage tolerance otherwise.

**Suggested fix (cheap):** Mirror the `TegridyRouter.ensure(deadline)` shape:
```solidity
if (block.timestamp > deadline) revert Expired();
if (deadline > block.timestamp + 2 hours) revert DeadlineTooFar();  // new
```
2-hour cap matches the rest of the protocol's deadline policy (SwapFeeRouter,
TegridyRouter). Documented incompatibility with multi-day intent-based aggregator
patterns (CowSwap, 1inch) but NFT pools rarely route through those — same justification
already in `TegridyRouter` natspec L41-L68.

**Status:** Low / fresh-eyes finding. Same-shape gap was previously found and fixed for
the SwapFeeRouter / TegridyRouter; never propagated to NFT pool.

---

## F-63-2 (INFO) — Caller-facing SwapFeeRouter entries accept `amountOutMin = 0`

**Files:** `contracts/src/SwapFeeRouter.sol:686-724` (`swapExactETHForTokens`),
`727-790` (`swapExactTokensForETH`),
`793-835` (`swapExactTokensForTokens`),
plus the three `*SupportingFeeOnTransferTokens` variants (858-1035).

**Pattern:** None of the user-facing swap entries floor `amountOutMin > 0`. A wallet that
mistakenly signs with `amountOutMin = 0` (sloppy frontend, or an intentionally permissive
preset) submits a tx with no slippage protection. The post-swap recheck
(`if (userAmount < amountOutMin) revert SlippageExceeded();`) is satisfied at any
positive output when `amountOutMin = 0`.

**Multi-hop multi-leg amplification:** The router's path may be up to 10 hops
(`if (path.length < 2 || path.length > 10) revert InvalidPath()`). Slippage compounds
geometrically across hops on illiquid intermediates. With a single end-of-path
`amountOutMin = 0` bound, a searcher splits the sandwich across the most-illiquid leg,
realising the full theoretical 99%+ extraction even though headline pool depth on the
endpoints looks fine.

**Why this is INFO not HIGH:** This matches Uniswap V2 router behaviour — the user's
wallet is the canonical place to set this bound. No protocol funds are at risk; only the
user's own input. Industry consensus is that protocol-level "amountOutMin > 0" floors
break legitimate flows (e.g. one-leg pure WETH→USDC on a thick pair where the user
quoted off-chain for 0% slippage = passing 0 is "fine" from the user's perspective).

**MEV cost estimate (worst case):** Up to 100% of input − 1 wei on a degenerate path.
Realistic on a 3-hop path with a manipulated middle: 5%-30% per call. Bounded by the
pool's reserve depth at attack time.

**Suggested mitigation (defence-in-depth, optional):** Emit a structured event when
`amountOutMin == 0` is supplied so an off-chain monitor can flag affected wallets. NOT
worth a hard revert; would break too much legit traffic.

---

## F-63-3 (INFO) — `adjustedMin` formula admits `adjustedMin = 0` when `amountOutMin = 0`

**File:** `contracts/src/SwapFeeRouter.sol:756-765`.

**Pattern:** In `swapExactTokensForETH`, the formula
```solidity
adjustedMin = (amountOutMin * BPS + BPS - effectiveFee - 1) / (BPS - effectiveFee);
```
With `amountOutMin = 0`, `effectiveFee = 50` (bps), `BPS = 10_000`:
`adjustedMin = (0 + 9_949) / 9_950 = 0`.
The inner `router.swapExactTokensForETH(actualReceived, 0, ...)` then runs with no
slippage protection. The post-swap `if (userAmount < amountOutMin) revert SlippageExceeded();`
check trivially passes for any `userAmount >= 0`.

**Note:** This is the same root cause as F-63-2 (caller-supplied 0 is permitted) but
called out separately because the `adjustedMin` math is the place where one might
plausibly add a "non-zero floor" without breaking the fee-compensation property. The
existing `revert AdjustedMinOverflow()` branches at 757 (effectiveFee >= BPS) and 761
(amountOutMin too large) show the codebase is already willing to revert in pathological
cases. Adding a `if (amountOutMin == 0) revert ZeroMinOut();` here would harden the
fee-bearing path without changing semantics for callers that already pass non-zero.

**Severity:** Info / consistency. The protocol already enforces `MIN_MULTIHOP_ETH_OUT_WEI`
floor on owner-only `convertTokenFeesToETH` multi-hop branches (line 1572 / 1682) but
the user-facing entries are deliberately permissive.

---

## F-63-4 (INFO / DOCUMENTED) — POLAccumulator.accumulate: `_minLPETH` has no TWAP floor

**File:** `contracts/src/POLAccumulator.sol:460-471`.

**Pattern:** The LP-add ETH-side minimum is taken purely from caller-supplied `_minLPETH`
without TWAP anchoring. Owner can pass `_minLPETH = 0`.

**Verdict:** Code-comment at line 458-459 articulates the threat-model justification:
*"`remainingETH` is ground truth (the ETH we are depositing) — we cannot be sandwiched
out of ETH we own. No TWAP floor needed."* Confirmed correct by tracing
`addLiquidityETH`'s execution: the contract sends exactly `remainingETH` value, the
router consumes only the optimal amount given current reserves and refunds the rest;
`amountETHMin` only protects against the optimal-quote forcing a different ratio than
the caller wanted. Owner-only entry; under owner-key compromise the slippage gap is the
least of the protocol's worries. **No finding.** Listed only to document that this
parameter was reviewed and intentionally unfloored.

---

## F-63-5 (NEGATIVE) — TegridyRouter `addLiquidity*` / `removeLiquidity*` accept zero mins

**Files:** `contracts/src/TegridyRouter.sol:96-198` (all four entries).

**Pattern:** `addLiquidity`, `addLiquidityETH`, `removeLiquidity`, `removeLiquidityETH`
all permit `amountAMin = amountBMin = amountTokenMin = amountETHMin = 0`. Standard V2
pattern.

**Verdict:** This is the canonical Uniswap V2 router shape; user wallet sets the bound.
No finding.

---

## F-63-6 (NEGATIVE) — TWAP-derived bounds in POLAccumulator / SwapFeeRouter cannot be
relaxed by caller

**Files:** `POLAccumulator.sol:423-424, 460-461, 676-678` (TWAP floors); 
`SwapFeeRouter.sol:1958-2037` (`_enforceTWAPMinETHOut`).

**Pattern reviewed:** Both TWAP-derived floors have the structure
`effectiveMin = max(callerMin, twapFloor)`. Caller can only TIGHTEN.

**Manipulability of the TWAP itself:**
- Period: 30 min in POLAccumulator (`TWAP_PERIOD = 30 minutes`); MIN_TWAP_PERIOD enforced
  in SwapFeeRouter.
- Bypass-cooldown gate: both contracts refuse to consume a TWAP read for `TWAP_PERIOD * 2`
  after a bypassed observation (POLAccumulator.sol:828-840, SwapFeeRouter mirror).
- Sequencer-resume staleness gate: TWAP read refused if latest observation predates
  `resumeAt + grace`.
- Direct-pair-only anchor: multi-hop conversions are owner-only and don't consult TWAP at
  all (no manipulable indirect-pair anchor).

**Verdict:** TWAP-as-pseudo-protection failure mode (cheap manipulation of the oracle
itself) is closed. Sequencer + bypass-cooldown gates make a single-block manipulation
impossible to consume; manipulating across `TWAP_PERIOD` (30 min) requires sustained
spread that arbitrage closes. **No finding.**

---

## F-63-7 (NEGATIVE) — Internal-protocol swap callers all enforce TWAP/min floors

**Sites reviewed:**
- `SwapFeeRouter.convertTokenFeesToETH` (line 1510): TWAP floor + `MIN_MULTIHOP_ETH_OUT_WEI`
- `SwapFeeRouter.convertTokenFeesToETHFoT` (line 1638): same
- `POLAccumulator.accumulate` (line 400): TWAP floor on swap leg + LP-add token leg
- `POLAccumulator.executeHarvestLP` (line 655): per-leg TWAP-derived floors on
  `removeLiquidityETH`
- `TegridyFeeHook.convertERC20FeesToETH` (line 555): owner-gated, 1e14 wei floor,
  30-min deadline cap

**Verdict:** No internal-protocol swap site is missing slippage protection.
**No finding.**

---

## F-63-8 (NEGATIVE) — TegridyRestaking, TegridyLending have no swap paths

**Files:** `TegridyRestaking.sol`, `TegridyLending.sol` — searched for `swap`, `router`,
`amountOutMin`, `compound`, `harvest`, `IUniswapV2Router`, `IUniswapV3Router`. None found.
TegridyRestaking is a position-restaker that proxies into TegridyStaking's `getReward` /
`claimUnsettledForTokenId` — claims native TOWELI rewards, no swap leg.
TegridyLending is debt-account; liquidation does not auto-swap collateral.
**No finding.**

---

## F-63-9 (NEGATIVE) — Oracle decimal mismatch

**Files reviewed for oracle reads:** `POLAccumulator._twapMinOut` (line 819),
`SwapFeeRouter._enforceTWAPMinETHOut` (line 1958).

**Pattern:** `POLAccumulator` snapshots `toweliUnit = 10**toweli.decimals()` at construction
(line 97) and uses it as the TWAP consult unit, explicitly avoiding the hardcoded-1e18 bug
(see comment block at line 88-96 — `AUDIT FIX D-POL-M1`). `SwapFeeRouter._enforceTWAPMinETHOut`
operates on `amountIn` directly via Q112 fixed-point math (`twapEthOut = amountIn * priceDiff
/ (elapsed * Q112_SFR)`) which is decimal-agnostic. **No finding.**

---

## Summary

| Finding | Severity | File | Loc |
|---------|----------|------|-----|
| F-63-1  | LOW      | TegridyNFTPool.sol         | 257-262, 326-331 |
| F-63-2  | INFO     | SwapFeeRouter.sol          | 686-1035         |
| F-63-3  | INFO     | SwapFeeRouter.sol          | 756-765          |
| F-63-4  | DOC-ONLY | POLAccumulator.sol         | 460-471          |
| F-63-5  | NEGATIVE | TegridyRouter.sol          | 96-198           |
| F-63-6  | NEGATIVE | (TWAP gating)              | multiple         |
| F-63-7  | NEGATIVE | (internal swaps)           | multiple         |
| F-63-8  | NEGATIVE | TegridyRestaking/Lending   | n/a              |
| F-63-9  | NEGATIVE | (oracle decimals)          | n/a              |

**One actionable finding (F-63-1, LOW):** TegridyNFTPool deadline cap missing — sibling
miss with the documented `MAX_DEADLINE` policy on every other Tegridy swap entry. Cheap
two-line fix; mirrors `TegridyRouter.ensure(deadline)` shape.

**Two info-level documentation items (F-63-2, F-63-3):** Caller-supplied `amountOutMin = 0`
is admitted on user-facing SwapFeeRouter entries. Industry-standard for V2 routers; not
worth blocking but a structured event on `amountOutMin == 0` would aid off-chain monitoring
of high-risk callers.

**No HIGH/MEDIUM findings under the slippage lens.** The protocol's TWAP-floor architecture
(`effectiveMin = max(caller, twap)`), sequencer-resume gating, bypass-cooldown gating,
and dual-direction multi-hop owner-gate make all internal-protocol swap legs robust to
the canonical sandwich-via-zero-min vector. Documented exposure is bounded to the
user-facing entries (where industry standard applies) and the NFT pool deadline cap.

Notes / dead-ends explored:
- Inspected `addLiquidity` ratio-skew via FoT factory token. The factory rejects ERC777 at
  pair creation (`_rejectERC777`); the pair re-checks `balanceOf(this) == postBalance`
  per-swap (line 272-273). FoT inputs are absorbed cleanly via the
  `*SupportingFeeOnTransferTokens` variants. Not a slippage finding.
- Checked TegridyNFTLending — uses `loan.deadline` as the *loan repayment* deadline
  (with sequencer-pause extensions), not a swap deadline. Out of scope.
- VoteIncentives `VOTE_DEADLINE = 7 days` is the voting commit window — out of scope.
