# Design Doc — Boosted LP-Incentive Hook (#3)

> **CANONICAL PATH UPDATE (2026-05-31):** the production model is now the NFT-staker
> `contracts/src/v4/TegridyBoostedLPStaker.sol` (escrow the V4 position NFT, attribute
> to the depositor) — it reaches PM-routed LPs, which the hook-callback model below
> cannot. The hook-callback `TegridyBoostedLP` remains the optional direct-EOA path
> (`hook.boostedLP` stays 0 in prod so a position is never counted twice). See
> `V4_TRUSTED_ROUTER_DESIGN.md` Part B.
>
> Status: **IMPLEMENTED v1 (2026-05-31) at owner direction — UNAUDITED.** Built ahead
> of the audit gate. Code: `contracts/src/v4/TegridyBoostedLP.sol` (isolated module) +
> `TegridyV4Hook` liquidity-callback notify + `TegridyV4HookAdmin` timelock wiring.
> 29 hook-suite tests green. This doc remains the spec + the open-items list below.
> (Originally specced design-only; the riskiest custom surface, so kept in its own
> module rather than folded into the immutable core hook.)

## Why this exists

`TegridyLPFarming` (V2) is a Synthetix `StakingRewards` that stakes the **V2 pair's
ERC-20 LP token** and amplifies rewards `0.4×–4.5×` by the provider's
`aggregateActiveBoostBps` read from `TegridyStaking`. The Farm page promises exactly
this: *"Lock TOWELI… **boost your LP rewards**."*

**In V4 there is no ERC-20 LP token** — liquidity is PoolManager-internal. So this
mechanic *must* be rebuilt, and the V4-native form is a hook that accrues rewards in
the **liquidity callbacks**, weighted by veTOWELI boost.

## The key advantage: same pool, no fragmentation

Unlike AntiSandwich / LimitOrder / TWAMM-DCA (which all drive `_beforeSwap` and so
need their **own** pool), the boosted-LP accrual lives in `_afterAddLiquidity` /
`_afterRemoveLiquidity` — callbacks that **only `LiquidityPenaltyHook` uses today**.
So `TegridyV4Hook` can **override-and-extend** them (call `super` for the verbatim
JIT logic, then accrue rewards) on the **same TOWELI/ETH pool**. No second pool, no
split liquidity. This is why it's the most attractive of the "extra" hooks.

## Mechanism (Synthetix `rewardPerToken`, adapted to V4 liquidity)

Reuse the exact battle-tested math `TegridyLPFarming` already runs — only the
"balance" source changes (V4 position liquidity instead of staked LP tokens):

```
global:   rewardPerLiquidityStored, lastUpdateTime, rewardRate, periodFinish
per LP:   userRewardPerLiquidityPaid[owner][positionKey], rewards[owner][positionKey],
          boostedLiquidity[owner][positionKey]

_afterAddLiquidity(owner, key, params, delta, ...):
    super._afterAddLiquidity(...)            // VERBATIM JIT penalty (donate to in-range LPs)
    _updateGlobal()                          // accrue rewardPerLiquidityStored over elapsed time
    _settle(owner, positionKey)              // credit pending rewards at old boosted balance
    boost = staking.aggregateActiveBoostBps(owner)         // 0.4×–4.5×, clamp to MAX
    boostedLiquidity[owner][pk] += params.liquidityDelta * boost / BPS
    return super's (selector, feeDelta)

_afterRemoveLiquidity(owner, key, params, delta, ...): symmetric (decrease boosted balance)

getReward(positionKey): _settle then pay rewards[owner][pk] in the reward token
```

`positionKey = keccak256(owner, tickLower, tickUpper, salt)` (V4's position id).

## The hard part — in-range attribution

V4 liquidity is per-tick-range; strictly, **only in-range liquidity should earn**
(Aerodrome Slipstream tracks tick crossings to do this). That is materially more
complex and stateful.

**v1 recommendation: full-range only.** Restrict reward-eligible positions to the
canonical full-range tick band (the POL/meme-coin norm) and reward by
`boostedLiquidity × time`, ignoring concentration. Simple, matches how a meme pair's
deep liquidity actually sits. Defer tick-crossing in-range attribution to a v2 unless
concentrated liquidity becomes a real use case.

## Reward funding — and a nice flywheel

Two options:
1. **External emissions** (like V2 `notifyRewardAmount`): treasury funds a TOWELI
   reward budget. Simple, decoupled.
2. **Fund from the fee split (#1):** route a slice of `afterSwap` fees (a new
   `lpShareBps` alongside staker/treasury/POL) into the LP reward budget — **swap
   fees → LP rewards**, fully on-chain, no external funding. Elegant flywheel, but
   couples the modules (property-test non-interference — Bunni lesson).

Recommend starting with (1) for isolation; consider (2) once audited.

## Risks / audit notes

| Risk | Mitigation |
|---|---|
| Custom reward math (the prime exploit class) | Copy `TegridyLPFarming`'s Synthetix `rewardPerToken` verbatim; only swap the balance source. Property-fuzz. |
| Cross-module interaction (JIT penalty ↔ reward accrual ↔ POL skim) | Each keeps its own storage namespace; assert in CI that a liquidity op cannot change fee/POL state and vice-versa (Bunni non-interference invariant). |
| `aggregateActiveBoostBps` read griefing / boost-decay timing | Read at accrual time; mirror V2's lazy-decay handling. Clamp boost to the V2 `MAX_BOOST + JBAC` ceiling. |
| Gas on every liquidity op | `_updateGlobal` is O(1); acceptable. |
| Reward-token solvency | Pay only up to the funded budget (`periodFinish`/`rewardRate` cap, as Synthetix does). |
| `super` ordering with LiquidityPenaltyHook's returned `feeDelta` | Call `super` first, return its `BalanceDelta` unchanged; accrual must NOT alter the JIT delta. Test the JIT penalty still fires identically. |

## Scope boundary

- This is a **separate, audited workstream** — not folded into the Batch-7 commit.
- It is the one staking/liquidity hook with genuinely heavy custom surface; everything
  else (fee-split #1, discount #2) was thin enough to ship + test inline.
- Prereq: the core hook (Batches 1–7) audited first, so this builds on a verified base.
```
