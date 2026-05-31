# V4 Upgrade — Adversarial Security Findings (2026-05-31)

> Fresh, no-mercy exploit hunt on the V4 code introduced this cycle (`src/v4/*`),
> ignoring all prior audit claims. Method: independent adversarial re-read + 2
> independent audit agents, **every finding verified against file:line** (per the
> verify-findings mandate — one agent finding was rejected as a false positive).
> **UNAUDITED code; these are launch blockers, not nits.**

## Verdict: 1 CRITICAL, 2 HIGH, 3 MEDIUM, 4 LOW. Do not deploy until C-1/H-1/H-2 are fixed.

> **UPDATE 2026-05-31 — C-1, H-1, H-2 FIXED + exploit tests (38 green).**
> - **C-1 FIXED:** `deposit` now requires the position's pool == canonical `allowedPoolId` AND full-range (via `getPoolAndPositionInfo` + `TickMath` usable-tick bounds). Tests: `test_C1_boostedStaker_rejectsForeignPool`, `test_C1_boostedStaker_rejectsNonFullRange` (both revert), happy-path full-range deposit still works.
> - **H-1 FIXED:** `_notifyBoostedLP` wraps the module call in `try/catch`. Test: `test_H1_revertingModuleDoesNotBlockLiquidity` (a reverting module no longer blocks add/remove).
> - **H-2 FIXED (and reassessed → defense-in-depth):** added the Synthetix `rewardRate*duration <= balanceOf` guard to both reward contracts. On deeper analysis the live-exploit severity was **overstated**: because `rewardRate` is derived from the `actual` transferred balance and `leftover` is bounded by prior funding, the contract is solvent *by construction* with a standard token — so the guard is hardening, not a live HIGH. Kept anyway (cheap, standard); the happy-path reward test still passes (guard doesn't false-revert).
>
> M-1/M-2/M-3 + LOWs remain open (tracked for the external audit). Suite: 38 passed.

---

## C-1 (CRITICAL) — Boosted-LP staker farms rewards with ANY position → total emission theft
`TegridyBoostedLPStaker.sol:115-125` (`deposit`). It reads only `getPositionLiquidity(tokenId)` and credits `liquidityOf += liq`. **It never checks the position belongs to the TOWELI/ETH pool, nor that the liquidity is in-range/productive.**
**Exploit:** attacker mints a V4 position in a junk pool they control (two worthless tokens), or a tight far-out-of-range position where `liquidity` *units* are enormous for ~$0 of capital, deposits the NFT, and farms the entire TOWELI emission stream pro-rata against honest LPs. Zero economic backing.
**Fix:** store the canonical `PoolKey`/`poolId` immutably; in `deposit`, require `positionManager.getPoolAndPositionInfo(tokenId)`'s PoolKey hash == the canonical poolId (the getter exists: `IPositionManager.sol:62`). Additionally weight by in-range liquidity (or restrict to the canonical full-range band) so out-of-range units can't farm.

## H-1 (HIGH) — A reverting boosted-LP module bricks ALL liquidity add/remove (and breaks the paused-exit invariant)
`TegridyV4Hook.sol:404-413` (`_notifyBoostedLP`) calls `ITegridyBoostedLP(m).onLiquidityChange(...)` with **no try/catch**, inside `_afterAddLiquidity`/`_afterRemoveLiquidity`. `onLiquidityChange` runs reward math + an external `staking.aggregateActiveBoostBps()` call.
**Exploit / failure:** if the wired module reverts (div-by-zero on empty supply, a bug, a paused/again-reverting staking dependency, or a malicious module wired by a compromised admin), **every LP add and remove reverts** — including emergency withdrawals while the hook is `paused`. This directly defeats the "swaps halt, liquidity exit stays open" safety design.
**Fix:** wrap the notify in `try/catch {}` (exactly like the premium-discount call already does at `:232`). The reward module must never be able to block core pool liquidity.

## H-2 (HIGH) — Reward insolvency: `rewardRate` is never bounded by the funded balance
`TegridyBoostedLPStaker.sol:164-185` and `TegridyBoostedLP.sol` (`notifyRewardAmount`). Canonical Synthetix `StakingRewards` asserts `rewardRate <= balanceOf(this) / duration` after funding; **both contracts omit it.**
**Exploit / failure:** repeated short-duration top-ups stack `leftover = (periodFinish-now)*rewardRate`, or owner miscalc, can set `rewardRate` such that total promised rewards exceed the contract's token balance → `earned()` accrues more than is held → late `getReward()` callers' `safeTransfer` reverts and their rewards are stuck.
**Fix:** after computing `rewardRate`, `require(rewardRate * rewardsDuration <= rewardToken.balanceOf(address(this)))`.

## M-1 (MEDIUM) — SwapRouter has no max-input slippage for exact-OUTPUT swaps
`TegridyV4SwapRouter.sol:86-95`. `outAmt` is the positive (output) leg and `minOut` only guards it. For an exact-output swap the output is fixed (= specified), so `minOut` is trivially satisfied; the **variable input** leg (settled from the user, `:82-83`) is unbounded.
**Exploit:** sandwich an exact-output swap → victim pays an unbounded amount of input. The NatSpec even admits "exact-input semantics" (`:54`).
**Fix:** add a `maxIn` param; check the negative (input) leg `inAmt <= maxIn`.

## M-2 (MEDIUM) — Permissionless `refreshBoost` + snapshot boost = stale-boost over/under-earning
`TegridyBoostedLPStaker.sol:139-151` / `TegridyBoostedLP.sol`. Boost is snapshotted into `effectiveBalanceOf` only on the LP's own deposit/withdraw/refresh; `refreshBoost(lp)` is permissionless.
**Exploit/grief:** an LP whose veToken boost has *decayed* keeps the higher effective balance (over-earning) until someone pokes them; conversely an attacker can poke a victim exactly at lock-expiry to cut their share. Share weights are gameable/inconsistent vs true current boost.
**Fix:** fold the boost read into reward accrual (snapshot boost-time alongside `userRewardPerTokenPaid`), or auto-decay on accrual.

## M-3 (MEDIUM) — Alt `TegridyBoostedLP` (hook-callback) double-counts; must stay disabled
`TegridyBoostedLP.sol` (`onLiquidityChange`) tracks a running per-LP sum with no per-position dedup, and attributes to the hook-resolved `lp`. If ever enabled (`hook.boostedLP != 0`) alongside the staker, a position is counted twice; PM-routed adds attribute to the PM.
**Fix:** keep `hook.boostedLP == 0` in production (VerifyV4 asserts this) and document the staker as the only path; or delete this contract before mainnet to remove the foot-gun.

## LOW
- **L-1** `TegridyV4SwapRouter.sol:67-68` refunds `address(this).balance` (not the per-call surplus) → any ETH donated/stuck in the router is swept to the next `swap()` caller (even msg.value==0). Matches PoolSwapTest; only donated ETH at risk. Fix: refund only `msg.value` consumed.
- **L-2** `TegridyV4Hook.sol:363-365` `distributeFees` reverts if a native-ETH sink (treasury/stakerSink) can't `receive()` → that currency's distribution griefs until the admin re-points (48h). Permissionless `sweepPOL` (claims) is the escape hatch, so funds aren't locked. Verify RevenueDistributor has `receive()` before wiring.
- **L-3** Stranded emissions: reward dust accrued while `totalEffectiveSupply==0`, and `*1e18/total` truncation, are never recoverable (no owner sweep).
- **L-4 (defense-in-depth)** Staker caches `positionLiquidity` at deposit. The exploit "owner modifies the escrowed position" is **blocked** (see rejected FP below), but re-reading `getPositionLiquidity` at withdraw is cheap insurance against any future PM behavior change.

## Rejected false positive (verified against ERC-721 semantics)
- *"A pre-deposit owner retains operator/approval and can `decreaseLiquidity` the escrowed position, making the cached liquidity stale."* **Rejected:** V4 `PositionManager` gates `modifyLiquidities` on the *current* token owner/approved; ERC-721 `transferFrom` clears the per-token approval, and operator approvals are per-owner (they don't follow the NFT to the staker). The staker approves no one. So an escrowed position cannot be modified by anyone. (Still, L-4 re-fetch is good hygiene.)

## Independently verified SAFE (two reviewers, checked vs v4-core)
- **POL `afterSwap` skim** (`TegridyV4Hook._afterSwap`): the `+feeAmount` return + `mint(claims=true)` net the hook delta to zero; the trader is charged `swapDelta - hookDelta`. Correct for exact-in AND exact-out; `bps <= 10000`, checked `toInt256().toInt128()`, abs-guarded. No drain, no brick, no overflow.
- **Premium discount auth**: applies only when `sender == trustedRouter` (`:230`); the router forces `hookData = msg.sender` captured **before** `unlock` (`TegridyV4SwapRouter.sol:64`), so no one can claim another's premium status. Malformed hookData gated by `length>=32` + try/catch.
- **`unlockCallback`** (hook & router): `onlyPoolManager`; destinations admin-set, not attacker-supplied; split conserves (`polAmt = bal - stakerAmt - treasuryAmt`); nested-unlock reentrancy reverts under the PM lock.
- **Router reentrancy**: `nonReentrant` covers the native refund + in-lock `take`.
- **Hook permission flags** match the implemented callbacks exactly.

## Priority
Fix **C-1** (reward theft), **H-1** (liquidity DoS / paused-exit break), **H-2** (insolvency) before this code goes anywhere near mainnet — they are exploitable today. Then M-1/M-2, then the external audit (`V4_AUDIT_HANDOFF.md`) which these findings feed into.
