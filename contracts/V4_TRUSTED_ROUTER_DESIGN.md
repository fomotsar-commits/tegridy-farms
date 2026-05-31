# Design Doc — Trusted Tegridy Router (the user-identity piece for #2 / #3)

> Status: **Part A IMPLEMENTED (2026-05-31, UNAUDITED); Part B = design rec.** The
> missing piece that lets the premium fee discount (#2) and boosted-LP rewards (#3)
> actually reach end users. Sits on `next-wave/v4-migration`.
> Part A (trusted SWAP router) → `contracts/src/v4/TegridyV4SwapRouter.sol`.
> Part B (boosted-LP attribution) → `contracts/src/v4/TegridyBoostedLPStaker.sol`
> (NFT-staker, the canonical #3 path). 35 hook-suite tests green. Both UNAUDITED.

## The problem it solves

A V4 hook's callbacks receive `sender` = **whoever called `PoolManager.swap` /
`modifyLiquidity`** — i.e. the *router*, never the end-user EOA. So any per-user hook
logic (the #2 discount, the #3 boost) needs the authenticated user from elsewhere.

`TegridyV4Hook` already only trusts a user address in `hookData` **when
`sender == trustedRouter`**. That's safe *iff* a router exists that:
1. is the actual `PoolManager` caller (so it's the `sender` the hook sees), and
2. writes the **authenticated** user into `hookData` — never a caller-supplied,
   spoofable address.

This doc specs that router. **Key invariant: the router sets `hookData =
abi.encode(msg.sender)` — the immediate caller — and NEVER accepts a user-address
argument.** You can only ever claim the discount/boost for *your own* address's
holdings, so there's nothing to spoof.

> Why not UniversalRouter? It forwards *user-supplied* `hookData` and is the `sender`,
> so trusting it would let anyone pass a premium holder's address → spoofable. The
> whole point is a router that *forces* `hookData = msg.sender`.

## Part A — Trusted SWAP router (#2 discount). Clean. Recommended.

A minimal, pool-specific swap router. Per swap:
1. `swap(zeroForOne, amountSpecified, sqrtPriceLimit, minOut, deadline)` — user calls directly.
2. Enforce `deadline`, pull input via Permit2/transferFrom, `poolManager.unlock(...)`.
3. In `unlockCallback`: `poolManager.swap(key, params, abi.encode(msg.sender_at_entry))`
   — the hook sees `sender == thisRouter` + `hookData = the user` → applies the
   premium discount in `_getFee`. Settle deltas, enforce `minOut`, refund.

**Threat model / properties**
- *Spoofing*: impossible — `hookData` is the immediate caller, captured at entry
  (cache it before `unlock`; do not read `msg.sender` inside the callback, which is
  the PoolManager). Worst case if buggy: a discount leaks (LPs underpaid slightly) —
  economic, not theft.
- *Slippage/griefing*: standard router hygiene — `minOut`, `deadline`, no leftover
  approvals, reentrancy guard on entry.
- *Smart-contract wallets / AA*: `msg.sender` = the SC wallet = the user's account.
  Boost/premium tie to that account. Fine.
- *Aggregator-routed swaps* (1inch/0x → not this router): get **no discount** (sender
  isn't the trusted router). Acceptable + documented; the frontend routes through
  this router to grant the benefit.
- Immutable; pinned; audited. `trustedRouter` set on the hook via the
  `TegridyV4HookAdmin` 24h/48h timelock.

This is real but contained periphery (~one swap path + unlock/settlement). It does
**not** replace UniversalRouter for general trading — it's the *Tegridy-pool* path
the app uses when it wants to grant the discount.

## Part B — Boosted-LP attribution (#3). The trusted-router approach DOESN'T fit cleanly.

For #3 the hook resolves `lp` the same way, but liquidity has a custody problem the
swap path doesn't:

- If the trusted router *executes the add-liquidity*, the **V4 position is owned by
  the router**, not the user — so the user can't manage/withdraw it via the canonical
  PositionManager. A custom router holding everyone's positions = a custody +
  complexity + risk sink. Bad.
- If the user adds via the canonical **PositionManager** (the normal path, position =
  their PM NFT), then `sender == PositionManager` (not the trusted router), so the
  hook attributes to the PM → base 1× rewards. The boost never reaches the user.

So the hook-callback + trusted-router model (what `TegridyV4Hook` is wired for today)
only works for the *rare* direct-EOA LP. **For the common PM-routed path it does not
deliver the boost.**

### Recommendation for #3: external PositionManager-NFT staker (model B)

Pivot #3's attribution to the original Aerodrome/Curve gauge model, which the V4 plan
already listed as the alternative:

- User **deposits their V4 PositionManager NFT** into `TegridyBoostedLP` (the module
  escrows it, exactly as the V2 `LPFarming` escrowed LP tokens).
- The module reads the position's liquidity from the PositionManager and attributes
  rewards to the **depositor (`msg.sender`)** — provable identity, no router, no
  hookData, no spoofing. Boost = `aggregateActiveBoostBps(depositor)`.
- Withdraw returns the NFT.

This removes the hook-callback path for #3 entirely (cleaner): the hook stays a pure
AMM hook; boosted-LP becomes a standard NFT staker. Tradeoff: users must deposit their
position NFT (one extra tx), exactly like staking LP tokens in V2 — familiar UX.

> The `onLiquidityChange` hook path already built is still useful as the **direct-EOA**
> accrual path, but model B should be the headline for PM-routed liquidity. Decide one
> as canonical before audit to avoid double-counting (a position must accrue via
> exactly one path).

## Trust model & integration

| Item | Decision |
|---|---|
| Who sets `trustedRouter` | `TegridyV4HookAdmin` (48h timelock) |
| Router mutability | Immutable; redeploy + re-point to upgrade |
| Authentication | `hookData = immediate caller`, captured pre-unlock; never an argument |
| Blast radius if router is buggy | Economic leak (discount/over-boost), not theft — but audit it |
| Boosted-LP canonical path | **Model B (NFT staker)** for PM-routed; hook-callback for direct-EOA |

## Non-goals
- Not a general-purpose / multi-pool router (use UniversalRouter for everything else).
- Not custody of LP positions in the swap router.
- No new trust in `tx.origin` (anti-pattern; breaks AA).

## Recommendation & sequencing
1. **Build the trusted SWAP router (Part A) first** — it cleanly unlocks #2 and is
   contained. Audit it with the core hook.
2. **For #3, switch the canonical path to the NFT-staker (Part B)** before relying on
   boosted-LP in production; keep the hook-callback path as the direct-EOA accrual or
   drop it to avoid double-counting.
3. All of this still sits behind the **V2-launch + external-audit gate** — these are
   periphery specs, not a green light to deploy.
```
