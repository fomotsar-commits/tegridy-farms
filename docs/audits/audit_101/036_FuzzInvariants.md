# Agent 036 — Fuzz / Invariant Test Surface Audit

Scope: `contracts/test/FuzzInvariant.t.sol`, `contracts/test/FuzzV3.t.sol`, plus a sweep
of all `invariant_*` / `statefulFuzz_*` symbols across `contracts/test/`.

## 0. Test inventory

| File | Stateful invariants | Stateless fuzz tests | Targeted contracts |
|------|--------------------:|---------------------:|--------------------|
| `FuzzInvariant.t.sol` | 3 (`kNeverDecreases`, `minimumLiquidityLocked`, `reservesMatchBalances`) | 8 | `TegridyPair` only (via `PairHandler`) |
| `FuzzV3.t.sol` | 0 (none — file is misnamed; pure stateless fuzz) | 13 | `TegridyNFTPool`, `TegridyNFTPoolFactory`, `TegridyLending` |
| `Audit195_Referral.t.sol` | 1 unit test labeled "invariant" (not stateful) | — | `ReferralSplitter` |
| `Audit195_Revenue.t.sol` | 2 unit tests labeled "invariant" (not stateful) | — | `RevenueDistributor` |

Total stateful invariant functions in the entire codebase: **3** (all in `FuzzInvariant.t.sol`,
all guarding `TegridyPair`). 0 invariants for Staking, Restaking, Lending, NFTPool,
NFTLending, Distributor, GaugeController, VoteIncentives, Launchpad, Drop,
SwapFeeRouter, POLAccumulator, FeeHook, Toweli, MemeBountyBoard, CommunityGrants,
TWAP, Router, LPFarming, PremiumAccess, ReferralSplitter, TokenURIReader.

## 1. Configuration weaknesses (`foundry.toml`)

`foundry.toml` has **no `[fuzz]` or `[invariant]` profile section at all**. This means
defaults apply:

- `fuzz.runs = 256` (very low for property tests; industry standard ≥ 10_000)
- `invariant.runs = 256`, `invariant.depth = 500`, `invariant.fail_on_revert = false`
- `fail_on_revert = false` is the killer: silent reverts in handlers count as
  "passing" runs, so a handler that always reverts due to a bound issue inflates
  the call count without actually testing anything.

Recommendation: add a `[invariant]` block with `runs = 5000`, `depth = 50`,
`fail_on_revert = true`, and a `[fuzz] runs = 10000` block.

## 2. `PairHandler` attack-surface gaps (FuzzInvariant.t.sol §2)

`targetContract(address(handler))` whitelists the handler **but the handler only
exposes 3 functions**: `doSwapAForB`, `doSwapBForA`, `doMint`. The Pair has
`burn`, `skim`, `sync`, `transferFrom`/donation paths plus FeeHook flash-callback
re-entry surfaces — **none are reachable from the handler**. Concretely missing
handler actions:

- `doBurn(uint256 lpAmt)` — needed to exercise the `kLast` mint-fee accrual path.
- `doSkim(address)` / `doSync()` — donation drains and forced-resync race.
- `doDonate(uint256 a, uint256 b)` — direct ERC20 transfer to the pair (sandwich).
- `doFlashSwap(uint256 a0Out, uint256 a1Out, bytes data)` — the `data.length > 0`
  flash branch in `swap()` is never hit by the handler.
- `doFeeRecipientToggle()` — invariants don't exercise the `feeTo == address(0)` vs
  `feeTo != 0` branches that change `kLast` accrual semantics.
- Multi-actor support: `actor` is a single fixed address, so any invariant that
  depends on cross-actor accounting (e.g. LP-supply == sum of holders) is untested.

## 3. Critical missing invariants (per-contract)

Listed by contract; severity ranked H/M/L for production-blocking impact.

### TegridyPair (`src/TegridyPair.sol`)
1. **[H] `sumOfLPBalances == totalSupply`** — never asserted. With handler donations
   or transfers, an LP-token accounting bug would slip through.
2. **[H] `K-monotonic on swap; K-grows-by-fees-only`** — `invariant_kNeverDecreases`
   only asserts `K >= kLast` (which only updates on mint/burn). The standard
   Uniswap V2 invariant is `K_after_swap >= K_before_swap * 1000^2 / (1000-fee)^2`,
   which catches fee-bypass bugs. Current check is too loose.
3. **[H] `LP_minted == sqrt(reserve0 * reserve1) - MIN_LIQUIDITY` on first mint** —
   no invariant pins this (only a stateless test that triggers the revert path).
4. **[M] `MINIMUM_LIQUIDITY locked at address(0) forever`** — never asserted that
   `balanceOf(address(0)) == 1000`.
5. **[M] No-free-mint** — sum of all transferred-in tokens to pair equals
   `_mint()` deltas (cannot mint without depositing). Critical for the donation /
   share-inflation attack class.
6. **[M] `kLast == 0` iff `feeTo == address(0)`** — the protocol-fee branch is
   never exercised.

### TegridyNFTPool (bonding curve, `src/TegridyNFTPool.sol`)
7. **[H] Price-monotonic invariant**: `spotPrice` strictly increases on buy
   (`+= delta * N`) and strictly decreases on sell (`-= delta * N`). Only
   stateless tests assert this; no stateful handler.
8. **[H] No-loss-on-roundtrip within fee tolerance**: `buyCost - sellPayout`
   must always equal `buyLPFee + buyProtoFee + sellLPFee + sellProtoFee`. Asserted
   for the all-or-nothing case but **never under interleaved buys/sells from
   multiple actors**.
9. **[H] Pool ETH balance >= sum of accrued protocol fees + LP claims** — solvency
   invariant; if a router bug overpays, pool goes underwater silently.
10. **[M] `heldTokenIds.length == NFT.balanceOf(pool)`** — accounting drift
    between internal book and ERC721 ledger.
11. **[M] `delta` and `spotPrice` never exceed declared caps after timelock**
    (ties to TF-15 / NEW-L8). Currently only `proposeDelta` boundary tested.

### TegridyLending (`src/TegridyLending.sol`)
12. **[H] Lending solvency**: `sum(active loan principals + accrued interest)
    <= treasury balance + escrowed collateral value`. Currently only `calculateInterest`
    arithmetic is fuzzed — no stateful invariant on the contract's solvency.
13. **[H] `collateralValue >= debtValue` for every active loan** at every step.
    `testFuzz_collateralSufficiency` is a tautology (`assertTrue(x >= y)` after
    forcing the relation). It tests nothing.
14. **[M] `loan.startTime <= block.timestamp` always**; `loan.endTime > startTime`
    always — never asserted.
15. **[M] `treasury.balance` only decreases via documented withdrawal selectors
    (no leak path)** — no excludeSelector list, so this can't even be tested.

### TegridyStaking (`src/TegridyStaking.sol`) — **0 invariants**
16. **[H] `totalStaked == sum(position.amount for active positions)`** — no
    `invariant_totalStaked`.
17. **[H] `accruedRewards <= unclaimedRewardPool`** — the rewards-pool overdraw
    invariant is missing. A miscount in `notifyRewardAmount` or `earned()`
    could drain extra tokens silently.
18. **[H] No-free-mint of position NFTs**: every minted `tokenId` must correspond
    to a transferred-in stake amount > 0.
19. **[M] Boost monotonicity**: `calculateBoost(d1) <= calculateBoost(d2)` for
    `d1 <= d2`, clamped by [MIN_BOOST, MAX_BOOST]. Stateless test exists but
    monotonicity is never explicitly asserted.
20. **[M] Early-withdraw penalty never exceeds `MAX_PENALTY_BPS`** — the
    `>=75%` check is one-sided.

### RevenueDistributor (`src/RevenueDistributor.sol`)
21. **[H] Vote-weight conservation across epochs**: `sum(claimable[user] over all
    users) <= totalDistributed - totalClaimed`. A vote-weight underflow would
    let a user claim more than their share.
22. **[H] `address(this).balance >= sum(unclaimedShares)`** — solvency.
23. **[M] Epoch monotonicity**: `currentEpoch` only ever increments; never
    repeats or rolls back.

### TegridyRestaking (`src/TegridyRestaking.sol`) — **0 invariants**
24. **[H] `totalRestaked == sum(restakerBalances)`** — basic accounting.
25. **[H] Reward-pool solvency** as in Staking.

### GaugeController + VoteIncentives
26. **[H] `sum(gaugeWeights) == totalAllocatedWeight`** — no invariant.
27. **[H] `bribeBalance[gauge][token] >= sum(unclaimedBribes)`** — solvency.
28. **[M] No-double-claim per epoch per voter — never asserted as invariant.

### TegridyNFTLending (`src/TegridyNFTLending.sol`) — **0 invariants**
29. **[H] Loan-collateral consistency**: NFT escrowed iff loan active.
30. **[H] No reentrancy on default-claim path** — only stateless test.

### TegridyLaunchpadV2 / TegridyDropV2 / SwapFeeRouter / POLAccumulator /
###  PremiumAccess / Toweli / MemeBountyBoard / CommunityGrants / TWAP /
###  TegridyRouter / TegridyLPFarming / TegridyFeeHook / ReferralSplitter
**0 invariants each.** All rely on stateless unit tests. Notable gaps:
- **Toweli ERC20**: `totalSupply == sum(balanceOf)` never asserted (basic ERC20 invariant).
- **POLAccumulator**: `polReserves == token0.balanceOf(this) + token1.balanceOf(this) - pendingFees` — solvency.
- **TWAP**: `cumulativePrice` is monotonic non-decreasing — never asserted.
- **CommunityGrants**: `sum(grantBudgets) <= treasury.balance` — solvency.
- **MemeBountyBoard**: `sum(bountyEscrow) == sum(activeBounties.amount)` — solvency.
- **FeeHook**: `feeBps` always within [MIN, MAX] across timelock paths.
- **Router**: post-swap `tokenIn.balanceOf(router) == 0` and `tokenOut.balanceOf(router) == 0` (no funds stuck).

## 4. Handler-bound bugs in existing tests

- `PairHandler.doSwapAForB`/`doSwapBForA`: bound to `1e15` minimum which
  silently skips small-amount edge cases (rounding at fee boundaries) —
  combined with `fail_on_revert = false`, these reverts are invisible.
- `PairHandler` constructor mints `10_000_000_000 ether` to `actor`, but with
  `bound(amount, 1e15, r0/3)` we never approach reserve-overflow regimes
  (uint112 max). The handler will never produce the `Overflow` branch.
- `FuzzV3.t.sol` is misnamed — it contains zero stateful invariants. There is no
  invariant pinning the bonding curve under interleaved actors. Race conditions
  (e.g. two buys racing across the same `numItems`) cannot be caught.
- All "invariant_*" tests in `FuzzInvariant.t.sol` are `view` and only re-read
  state — fine, but they share a single `actor` so cross-user invariants
  (sum of LP balances) are mathematically trivial in this setup.

## 5. Recommended additions (priority order)

1. Add `[invariant] runs=5000 depth=50 fail_on_revert=true` to `foundry.toml`.
2. Replace `targetContract(handler)` with `targetSelector` whitelists and
   `excludeSelector` blacklists per contract; add a multi-actor harness.
3. Implement at least the H-severity invariants above per contract — ~25
   new `invariant_*` functions across 8 handlers.
4. Add `assume_no_revert` cheatcode-aware handlers so genuine bug reverts
   propagate while expected guards (e.g. `whenNotPaused`) don't.

## 6. Summary counts

- Files reviewed: 60 test files, 25 source contracts.
- Stateful invariant functions in repo: **3** (all guarding `TegridyPair`).
- Contracts with **0** invariants: 21 of 25.
- Critical (H) missing invariants identified: **17** across 9 contracts.
- Medium (M) missing invariants: **13**.
- Configuration deficiencies: 4 (`runs`, `depth`, `fail_on_revert`, missing profile).
