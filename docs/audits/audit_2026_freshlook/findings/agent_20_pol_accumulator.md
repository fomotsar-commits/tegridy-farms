# Agent 20/100 — POLAccumulator.sol fresh-eyes audit

Target: `contracts/src/POLAccumulator.sol` (964 lines)
Related read-only: `Toweli.sol`, `TegridyTWAP.sol`, `lib/SequencerCheck.sol`, `lib/WETHFallbackLib.sol`, `SwapFeeRouter.sol`
Lens: buy-and-LP slippage, MEV, treasury safety, LP lock guarantee.

---

## Summary

POLAccumulator is fundamentally well-hardened. The R015 / TWAP-anchored design replaces caller-supplied `minOut` floors with TWAP-derived ones for both `accumulate()` and `executeHarvestLP()`, the constructor cross-checks `lpToken == factory.getPair(...)`, sweeps are timelocked (48h ETH, 48h tokens), harvest caps at 10% / 30 days, sequencer + post-resume + bypass-cooldown gates are all wired into both write paths, and Toweli is plain ERC-20 (no fee-on-transfer surface to bleed through `addLiquidityETH`). LP token never leaves the contract except via the harvest path and the `lpToken` is structurally non-sweepable.

No new H or M class exploit found. Three L/INFO class findings below: dead-code governance state (`maxSlippageBps` / `backstopBps`), absence of an annual harvest cap, and an asymmetry between the deviation gate present in harvest but absent in the accumulate swap leg.

---

## F-20-1 (LOW / dead state) — `maxSlippageBps` and `backstopBps` are set via timelock but never read

**Where**: `POLAccumulator.sol:142, 147` declarations; mutators at `:322-345` (slippage) and `:520-569` (backstop). Comments at `:445` and `:675` claim these "continue to apply as additional belt-and-braces" / "configurable belt-and-braces floor."

**Trace**: a `Grep` over the file for both identifiers shows only declarations, the propose/execute/cancel surface, and the dev-comment claims — there is no read site inside `accumulate()` or `executeHarvestLP()` that uses either value. Pre-fix DEEP-DR-M-08 (commented at `:450`) deliberately removed the `slippageMin*`/`backstopMin*` derivations from the LP-add leg because they were keyed off the post-swap (attacker-controlled) `toweliAmount`. The storage and the entire timelock surface around them remained.

**Impact**:
- 5 storage slots + ~3 dispatch entry points the owner can interact with that have zero on-chain effect. Operators who read the contract surface (or read the `:445` and `:675` comments) will believe these knobs gate slippage; they do not. Real slippage is solely the TWAP-derived `(BPS - TWAP_SAFETY_BPS) / BPS` floor.
- Future code refactors that re-introduce a read against `maxSlippageBps` or `backstopBps` will wire a stale governance value into a critical path with no obvious red flag, because the propose/execute UX already exists.
- Gas / deploy bytecode bloat: ~6 entry points worth.

**Recommendation**: either (a) restore a read site that anchors the LP-add ETH-min to a TWAP-derived ETH floor and gates it through `maxSlippageBps`, or (b) delete the dead state + dispatch surface entirely and update the `:445` / `:675` comments to match the DEEP-DR-M-08 rationale ("removed; TWAP is the sole floor"). Option (b) matches what the code actually does today.

---

## F-20-2 (LOW / governance) — No annual cap on `executeHarvestLP`; 10%/30d compounds to ~70%/year

**Where**: `POLAccumulator.sol:626-644`. `MAX_HARVEST_BPS = 1000` (10% of `totalLPCreated` per call), `POL_HARVEST_DELAY = 30 days`.

**Trace**: each `proposeHarvestLP` is bounded only against `(totalLPCreated * 10%)`. After execution, `totalLPCreated -= lpAmount` (line `:692-694`), so the next proposal's cap is calculated against the post-burn supply. Twelve consecutive 30-day harvests hollow the POL position to ~28% (`0.9^12 ≈ 0.28`).

**Impact**: a captured / coerced owner key cannot drain in a single tx (the per-call cap + 30d timelock prevent that), but can monotonically erode the protocol-owned liquidity over months without any hard ceiling. The contract's NatSpec (`:60-67`) explicitly markets "LP tokens are held permanently — never withdrawn" / "Result: the protocol owns its own liquidity. Deeper pools..." which the harvest path quietly contradicts. The 30-day window does give monitoring + governance ample time to react per call, but there is no on-chain economic ceiling to stop a slow-rugging key holder.

**Recommendation**: add an annual harvest cap that resets on a calendar window (e.g. `MAX_ANNUAL_HARVEST_BPS = 2000` of an immutable snapshot of historical LP minted; rolling 365-day window). Alternatively, gate `executeHarvestLP` behind a community vote / multi-sig threshold higher than the rest of the owner surface.

---

## F-20-3 (INFO) — Accumulate swap leg has TWAP-floor but no spot-vs-TWAP deviation gate (harvest path does)

**Where**: `accumulate()` at `:418-436` vs `_twapHarvestMinOut` at `:931-937`.

**Trace**:
- Harvest path computes `priceDelta = |spotEthPer1eToweli - twapEthPer1eToweli|` and reverts `ReservesDeviateFromTWAP()` if `priceDelta * BPS / twap > 50` (i.e. spot drifted >0.5% off TWAP).
- Accumulate's swap leg only enforces `swapMinOut = consult * 9950 / 10000`. It does NOT inspect pair reserves directly. The router-level revert (router will refund if `out < swapMinOut`) means a sandwich that pushes spot >0.5% below TWAP causes the swap to revert, so the loss bound is structurally the same 0.5% per leg as the harvest gate. However, the symmetry is incomplete: the harvest gate fails fast with a typed `ReservesDeviateFromTWAP` (recognised by monitoring), while the accumulate path fails inside the router's INSUFFICIENT_OUTPUT_AMOUNT (Uniswap-V2-canonical, not protocol-typed).

**Impact**: not a money-loss bug — the TWAP floor itself caps swap slippage to 0.5% versus TWAP. But monitoring infrastructure that watches for `ReservesDeviateFromTWAP` reverts as a sandwich-attempt early-warning will only see harvest-path attempts; accumulate-path sandwich attempts surface as generic UniswapV2 errors and are easy to miss in dashboards.

**Recommendation**: optional — add a pre-swap deviation gate inside `accumulate()` mirroring the harvest path's spot read so monitoring sees a uniform typed revert across both write paths. Belt-and-braces, not a fix for an exploitable vulnerability.

---

## Notes / dead-ends checked (no finding)

1. **Donation poisoning of buy size (`receive()` open to anyone)** — `:308-318`. ETH from anyone increments balance. `accumulate()` caps balance at `maxAccumulateAmount`. Donor cannot inflate beyond cap; donations effectively help the protocol buy more LP at TWAP-bounded price. Benign.
2. **Skim/sync pre-funding** — TegridyPair (not audited here, but referenced) is a custom V2 pair. The buy step uses `swapExactETHForTokens` through the router at TWAP-bounded `swapMinOut`; skim/sync of the pair before accumulation only changes spot, which is gated by the TWAP floor. Cannot be used to extract value beyond 0.5% per call.
3. **LP token swept** — `proposeSweepTokens` rejects `token == lpToken` at both proposer (`:746`) and executor (`:765`) sites. The `lpToken` itself is `immutable`, so the guard cannot be silently relaxed. LP lock is structurally enforced.
4. **`addLiquidityETH` token0/token1 ordering** — handled by the V2 router; POLAccumulator only passes `address(toweli)` and `value:` ETH. No manual ordering needed. Constructor verifies `lpToken == factory.getPair(toweli, WETH)` which means the pair already exists with correct ordering before deploy.
5. **WETH wrap/unwrap on `receive()`** — POLAccumulator's `receive()` accepts raw ETH; it never wraps. The router internally wraps `value` to WETH on `swapExactETHForTokens` and `addLiquidityETH`. WETH-fallback only used on the harvest treasury payout (`:706`), which is correct (treasury may be a contract).
6. **Fee-on-transfer interaction with TOWELI** — `Toweli.sol` is plain OZ ERC20 + ERC20Permit with a one-shot mint and `_update` override that only blocks post-construction mints. `transfer` is unmodified. No FoT surface, so `toweliAmount` returned from `swapExactETHForTokens` matches what arrives at the LP-add. Confirmed by reading `Toweli.sol:48-122`.
7. **Trigger frequency / griefing** — `accumulate()` has `ACCUMULATE_COOLDOWN = 1 hours` (`:170, :407`). Owner-only function, so no anon griefing. Even owner cannot accumulate more than once per hour, which prevents owner mistake / runaway loop. OK.
8. **MAX_DEADLINE = 1 minute** (`:139, :410, :668`) — narrows MEV sandwich window aggressively; ample for both Flashbots private-mempool and L2 inclusion. Defense-in-depth on top of the TWAP-derived floor.
9. **`forceApprove → 0` after both `addLiquidityETH` and `removeLiquidityETH`** — `:441, :475, :680, :685`. No leftover approval.
10. **K * toweliUnit overflow check in harvest** — `:941`: `Math.sqrt((K * toweliUnit) / twapEthPer1eToweli)`. Worst-case `K = uint112_max^2 ≈ 2.7e67`, `* 1e18` could overflow uint256 (max 1.16e77). But TOWELI total supply is `1e27`, so `toweliReserve <= 1e27` and `ethReserve` realistically `<= 1e25`. Real `K <= 1e52`, multiplied by `1e18` is `1e70`, well under uint256 max. Theoretical-only.
11. **Bypass-cooldown gate** (`:836-840, :875-879`) — both `_twapMinOut` and `_twapHarvestMinOut` reject reads for `TWAP_PERIOD * 2 = 60 minutes` after a bypass observation. Closes PASS7-POL-02 and prevents bootstrap/post-dormancy MEV.
12. **Post-resume staleness gate** (`:822-827, :863-867`) — `getResumeTimestamp + GRACE` cross-check defeats the H-6 staleness gap where `checkSequencerUp` passes but the latest observation predates resume.
13. **`ZERO_LP_MINTED` revert** (`:472`) — defends against the ghost-LP-credit case where `addLiquidityETH` returns `(_, _, 0)` despite consuming tokens.
14. **`treasury` change is 48h-timelocked** (`:165, :488-509`) — captured-key cannot redirect treasury without operator review window.
15. **Pause + nonReentrant + onlyOwner stacked on every value-moving path** — accumulate, executeHarvestLP, executeSweepETH, executeSweepTokens. Closed DEEP-DR-M-02.

---

## Output path

`C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\.audit_2026_freshlook\findings\agent_20_pol_accumulator.md`
