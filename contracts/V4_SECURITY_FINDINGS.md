# V4 Upgrade — Adversarial Security Findings (2026-05-31)

> Fresh, no-mercy exploit hunt on the V4 code introduced this cycle (`src/v4/*`),
> ignoring all prior audit claims. Method: independent adversarial re-read + 2
> independent audit agents, **every finding verified against file:line** (per the
> verify-findings mandate — one agent finding was rejected as a false positive).
> **UNAUDITED code; these are launch blockers, not nits.**

## Verdict: 1 CRITICAL, 2 HIGH, 3 MEDIUM, 4 LOW. Do not deploy until C-1/H-1/H-2 are fixed.

> **UPDATE 2026-05-31 (a) — C-1, H-1, H-2 FIXED + exploit tests (38 green).**
> - **C-1 FIXED:** `deposit` now requires the position's pool == canonical `allowedPoolId` AND full-range (via `getPoolAndPositionInfo` + `TickMath` usable-tick bounds). Tests: `test_C1_boostedStaker_rejectsForeignPool`, `test_C1_boostedStaker_rejectsNonFullRange` (both revert), happy-path full-range deposit still works.
> - **H-1 FIXED:** `_notifyBoostedLP` wraps the module call in `try/catch`. (Then superseded by M-3 removal — the notify path no longer exists at all; see below.)
> - **H-2 FIXED (and reassessed → defense-in-depth):** added the Synthetix `rewardRate*duration <= balanceOf` guard to the staker. On deeper analysis the live-exploit severity was **overstated**: because `rewardRate` is derived from the `actual` transferred balance and `leftover` is bounded by prior funding, the contract is solvent *by construction* with a standard token — so the guard is hardening, not a live HIGH. Kept anyway (cheap, standard); the happy-path reward test still passes (guard doesn't false-revert).
>
> **UPDATE 2026-05-31 (b) — M-1, M-3 + L-1 RESOLVED; M-2/L-2/L-3/L-4 ACCEPTED with reasoning. No new attack surface added.**
> Mandate: "resolve all of them and ensure you don't introduce new exploits." Where a naive "fix" would add MORE risk than the finding, the finding is resolved by *removal* or *documented acceptance*, not by bolting on fragile code.
> - **M-1 FIXED:** `TegridyV4SwapRouter.swap` gained a `maxIn` param; `unlockCallback` now tracks the negative (input) leg `inAmt` and reverts `TooMuchSpent` if `inAmt > maxIn`. Closes the unbounded-input sandwich on exact-OUTPUT swaps. Test: `test_trustedRouter_exactOutputMaxInReverts` (exact-output, `maxIn = 1 wei` → reverts). Existing exact-input tests pass `type(uint256).max`.
> - **M-3 RESOLVED BY REMOVAL:** deleted `TegridyBoostedLP.sol` (the hook-callback alt path) **and** stripped the hook's boosted-LP wiring (`ITegridyBoostedLP`, `boostedLP`, `setBoostedLP`, `_notifyBoostedLP`, the `_afterAddLiquidity`/`_afterRemoveLiquidity` overrides) + the admin's boostedLP timelock triplet. The double-count foot-gun is now impossible (only `TegridyBoostedLPStaker` exists), this also eliminates the H-1 root cause entirely, and shrinks the hook's hot path. This is the minimal-surface resolution (delete-before-add).
> - **L-1 FIXED:** router refund now returns only this call's surplus: `preBal = address(this).balance - msg.value` snapshotted before `unlock`, refund `bal - preBal`. Donated/stuck ETH is no longer swept to the next caller.
> - **M-2 ACCEPTED (documented):** folding boost into reward accrual (the "fix") requires reading `aggregateActiveBoostBps` *inside* `updateReward`, i.e. an external staking call on every accrual — turning a reverting/paused staking dependency into a getReward/withdraw DoS (the exact H-1 class we just removed). The snapshot model keeps accrual self-contained; permissionless `refreshBoost` already lets anyone correct a stale boost. Net: accepted for v1, re-pricing handled by the next external audit. Adding the call would introduce a worse exploit than the finding.
> - **L-2 ACCEPTED (documented):** `distributeFees` reverting when a native-ETH sink can't `receive()` is self-inflicted misconfiguration; the permissionless `sweepPOL` escape hatch means funds are never locked, and the admin can re-point sinks (48h). A "skip the bad sink" branch adds conditional value-routing complexity to a value-moving path — higher risk than the griefing it prevents. Operational check (verify sinks have `receive()` before wiring) instead of code.
> - **L-3 ACCEPTED (documented):** stranded reward dust (accrued while `totalEffectiveSupply==0`, plus `*1e18/total` truncation) is sub-cent and inherent to the verbatim Synthetix math. An owner "sweep dust" function is a generic rug vector (owner pulls reward token) — strictly worse than leaving dust. Not added.
> - **L-4 ACCEPTED (documented):** re-fetching `getPositionLiquidity` at withdraw is "cheap insurance," but the escrowed position provably cannot change (rejected-FP analysis: ERC-721 transfer clears approvals, staker approves no one). Re-fetching introduces a cache-vs-live mismatch underflow risk on withdraw for zero real benefit today. Cache kept.
>
> Net surface change this round: **−1 contract, −~70 LoC of hook/admin, +1 router param.** Suite re-run after these changes (see test file).
>
> **UPDATE 2026-05-31 (c) — follow-on hardening (not findings): notify-cooldown port + deploy/verify scripts.**
> - **Notify-cooldown ported** into `TegridyBoostedLPStaker.notifyRewardAmount` — 24h `NOTIFY_COOLDOWN`, verbatim from V2 `TegridyLPFarming` (F-93-2 anti-sandwich gate). Forfeit-residue capture + `reclaimForfeitedRewards` were **deliberately NOT ported** (see L-3: it would add the owner rug-surface that finding rejected, and the staker has no reward-forfeiting `emergencyWithdraw` to feed the bucket). Test: `test_boostedStaker_notifyCooldownReverts`.
> - **DeployV4** now also deploys `TegridyV4SwapRouter` + `TegridyBoostedLPStaker` (runbook steps 4-5; staker `allowedPoolId` derived in-script from the canonical pool key). **VerifyV4** now asserts: `pauseGuardian`, discount both-or-neither + router match, router↔hook PoolManager identity, and the staker's `owner` + immutable `allowedPoolId`. The impossible `hook.boostedLP()==0` check (field removed in M-3) was correctly NOT added.
> - Suite: **35 passed** (was 34; +1 cooldown test). Build exit 0.

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

## M-1 (MEDIUM) — SwapRouter has no max-input slippage for exact-OUTPUT swaps — ✅ FIXED (maxIn param + TooMuchSpent)
`TegridyV4SwapRouter.sol:86-95`. `outAmt` is the positive (output) leg and `minOut` only guards it. For an exact-output swap the output is fixed (= specified), so `minOut` is trivially satisfied; the **variable input** leg (settled from the user, `:82-83`) is unbounded.
**Exploit:** sandwich an exact-output swap → victim pays an unbounded amount of input. The NatSpec even admits "exact-input semantics" (`:54`).
**Fix:** add a `maxIn` param; check the negative (input) leg `inAmt <= maxIn`.

## M-2 (MEDIUM) — Permissionless `refreshBoost` + snapshot boost = stale-boost over/under-earning — ⚠️ ACCEPTED (fix would add a staking-call DoS; see top note)
`TegridyBoostedLPStaker.sol:139-151` / `TegridyBoostedLP.sol`. Boost is snapshotted into `effectiveBalanceOf` only on the LP's own deposit/withdraw/refresh; `refreshBoost(lp)` is permissionless.
**Exploit/grief:** an LP whose veToken boost has *decayed* keeps the higher effective balance (over-earning) until someone pokes them; conversely an attacker can poke a victim exactly at lock-expiry to cut their share. Share weights are gameable/inconsistent vs true current boost.
**Fix:** fold the boost read into reward accrual (snapshot boost-time alongside `userRewardPerTokenPaid`), or auto-decay on accrual.

## M-3 (MEDIUM) — Alt `TegridyBoostedLP` (hook-callback) double-counts; must stay disabled — ✅ RESOLVED BY REMOVAL (contract + hook wiring deleted)
`TegridyBoostedLP.sol` (`onLiquidityChange`) tracks a running per-LP sum with no per-position dedup, and attributes to the hook-resolved `lp`. If ever enabled (`hook.boostedLP != 0`) alongside the staker, a position is counted twice; PM-routed adds attribute to the PM.
**Fix:** keep `hook.boostedLP == 0` in production (VerifyV4 asserts this) and document the staker as the only path; or delete this contract before mainnet to remove the foot-gun.

## LOW
- **L-1 ✅ FIXED** `TegridyV4SwapRouter.sol` refunded `address(this).balance` (not the per-call surplus) → any ETH donated/stuck in the router was swept to the next `swap()` caller. Now snapshots `preBal = balance - msg.value` before `unlock` and refunds only `bal - preBal`. Donated ETH no longer at risk.
- **L-2 ⚠️ ACCEPTED** `distributeFees` reverts if a native-ETH sink (treasury/stakerSink) can't `receive()` → that currency's distribution griefs until the admin re-points (48h). Permissionless `sweepPOL` (claims) is the escape hatch, so funds aren't locked. Resolved operationally (verify RevenueDistributor has `receive()` before wiring) rather than adding skip-sink branching to a value-moving path.
- **L-3 ⚠️ ACCEPTED** Stranded emissions: reward dust accrued while `totalEffectiveSupply==0`, and `*1e18/total` truncation, are never recoverable. Inherent to verbatim Synthetix math; an owner dust-sweep is a generic rug vector (worse than sub-cent dust). Not added. **Verified 2026-05-31 vs V2 `TegridyLPFarming`:** its `forfeitedRewards`/`reclaimForfeitedRewards` bucket is fed mainly by LPFarming's reward-forfeiting `emergencyWithdraw` (real value); the staker has no such path, so it deliberately omits both residue-capture and the reclaim sweep (in-code note at the `rewardRate` calc).
- **L-4 ⚠️ ACCEPTED (defense-in-depth)** Staker caches `positionLiquidity` at deposit. The exploit "owner modifies the escrowed position" is **blocked** (see rejected FP below). Re-reading `getPositionLiquidity` at withdraw would add a cache-vs-live mismatch underflow risk for no benefit today; cache kept.

## Rejected false positive (verified against ERC-721 semantics)
- *"A pre-deposit owner retains operator/approval and can `decreaseLiquidity` the escrowed position, making the cached liquidity stale."* **Rejected:** V4 `PositionManager` gates `modifyLiquidities` on the *current* token owner/approved; ERC-721 `transferFrom` clears the per-token approval, and operator approvals are per-owner (they don't follow the NFT to the staker). The staker approves no one. So an escrowed position cannot be modified by anyone. (Still, L-4 re-fetch is good hygiene.)

## Independently verified SAFE (two reviewers, checked vs v4-core)
- **POL `afterSwap` skim** (`TegridyV4Hook._afterSwap`): the `+feeAmount` return + `mint(claims=true)` net the hook delta to zero; the trader is charged `swapDelta - hookDelta`. Correct for exact-in AND exact-out; `bps <= 10000`, checked `toInt256().toInt128()`, abs-guarded. No drain, no brick, no overflow.
- **Premium discount auth**: applies only when `sender == trustedRouter` (`:230`); the router forces `hookData = msg.sender` captured **before** `unlock` (`TegridyV4SwapRouter.sol:64`), so no one can claim another's premium status. Malformed hookData gated by `length>=32` + try/catch.
- **`unlockCallback`** (hook & router): `onlyPoolManager`; destinations admin-set, not attacker-supplied; split conserves (`polAmt = bal - stakerAmt - treasuryAmt`); nested-unlock reentrancy reverts under the PM lock.
- **Router reentrancy**: `nonReentrant` covers the native refund + in-lock `take`.
- **Hook permission flags** match the implemented callbacks exactly.

## Priority
**STATUS (2026-05-31):** C-1 ✅, H-1 ✅ (then removed with M-3), H-2 ✅, M-1 ✅, M-3 ✅ removed, L-1 ✅. M-2/L-2/L-3/L-4 ⚠️ accepted-with-reasoning (fixing would add a worse exploit than the finding — see top note). All exploitable-today items are closed; remaining items are documented design acceptances that the **external audit** (`V4_AUDIT_HANDOFF.md`) should independently re-price. This code remains **UNAUDITED** and behind the V2-launch + external-audit gate.
