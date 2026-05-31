# V4 Deploy Runbook + V2↔V4 Dual-AMM Migration Plan

> For the **V4-live-at-relaunch** strategy (2026-05-31). Slots into the existing
> `RELAUNCH_RUNBOOK.md` as the V4 section. **Prep only — do NOT execute before the
> hard prerequisites below are met.** Contracts: `next-wave/v4-migration`.

## 0. Hard prerequisites (all must be true before mainnet deploy)

1. **External audit of the 5 V4 contracts is clean** (`V4_AUDIT_HANDOFF.md` scope). Relaunch blocker.
2. **Dep-pin reconciled**: `lib/v4-core @ d153b048` ABI matches the *deployed* mainnet
   PoolManager `0x000000000004444c5dc75cb358380d2e3de08a90` (or re-pin + re-run tests).
3. **Branch merged** into the launch line; `forge build` exit-0; 35 tests green on the merge.
4. **3 disjoint multisigs** ready: `TREASURY` ≠ `MULTISIG` (cold 4-of-7) ≠ `PAUSE_GUARDIAN` (hot 3-of-5).
5. Reward-token budget for `TegridyBoostedLPStaker` decided (TOWELI emissions amount + duration).

## 1. Deploy sequence (scripted in `DeployV4.s.sol`, extended)

| # | Action | Notes |
|---|---|---|
| 1 | Deploy `TegridyV4HookAdmin` | owner = deployer EOA initially |
| 2 | HookMiner-mine + CREATE2-deploy `TegridyV4Hook(pm, blockOffset, admin, minFee, maxFee, baseFee, maxPolBps, polBps, polRecipient)` | mined address MUST match the 9 permission flags; constructor `validateHookAddress` reverts otherwise |
| 3 | `admin.setHook(hook)` | one-time wiring |
| 4 | Deploy `TegridyV4SwapRouter(pm)` | the trusted router for #2 |
| 5 | Deploy `TegridyBoostedLPStaker(TOWELI, staking, positionManager, MULTISIG)` | canonical #3; owner = MULTISIG |
| 6 | `admin.transferOwnership(MULTISIG)` | Ownable2Step → step 12 accepts |

**Genesis config (the timelock nuance — plan for it):** the hook launches functional
from its constructor (base fee + POL skim). But the **fee split, premium discount, and
boosted-LP wiring are timelocked** (24–48h via the admin). `pauseGuardian` is *instant*
(`admin.hookSetPauseGuardian`, owner-only). So:

| # | Action | Timing |
|---|---|---|
| 7 | `MULTISIG.acceptOwnership()` on admin | — |
| 8 | `admin.hookSetPauseGuardian(PAUSE_GUARDIAN)` | instant |
| 9 | Propose: `proposeFeeSplit`, `proposeFeeSinks(stakerSink=RevenueDistributor, treasury)`, `proposeDiscountConfig(premiumAccess, swapRouter, discountBps)`, `proposeBoostedLP`(if using the hook-callback path — **leave UNSET; use the NFT-staker**), allowlist `proposePoolAllowed(key)` | during the **pre-public window** |
| 10 | After the 24–48h delays elapse: `executeFeeSplit` / `executeFeeSinks` / `executeDiscountConfig` / `executePoolAllowed` | features go live |
| 11 | `manager.initialize(key, sqrtPriceX96)` — dynamic-fee flag set, `hooks = TegridyV4Hook`, tickSpacing 60 | requires the pool key allowlisted first (step 10) |
| 12 | Seed POL: `TREASURY` adds full-range liquidity via PositionManager; NFT held by treasury | gives the pool depth at launch |
| 13 | Fund `TegridyBoostedLPStaker.notifyRewardAmount(amount, duration)` from `MULTISIG` | starts LP emissions |
| 14 | Run `VerifyV4` + manual checklist | all green before announcing |

> Sequence steps 9–10 **before** the pool is public so every feature is live at launch
> rather than 24–48h late. If acceptable to launch base-fee-only and turn on
> split/discount later, steps 9–10 can trail.

## 2. VerifyV4 + manual post-deploy checklist
- `Hooks.validateHookPermissions(hook, hook.getHookPermissions())` ✓ (VerifyV4)
- `hook.paramAdmin() == admin`, `admin.hook() == hook`, `admin.owner() == MULTISIG` ✓
- fee bounds ordered, `polSkimBps <= maxPolSkimBps`, `polRecipient != 0` ✓
- `hook.trustedRouter() == swapRouter`, `hook.premiumAccess() == PremiumAccess` (if discount on)
- `hook.boostedLP() == 0` (NFT-staker is canonical — **do not double-count**)
- `hook.pauseGuardian() == PAUSE_GUARDIAN`
- pool initialized, dynamic-fee flag set, POL position owned by `TREASURY`
- a tiny test swap through `TegridyV4SwapRouter` succeeds; a test LP deposit into the staker accrues

## 3. V2↔V4 dual-AMM migration

Both pools live simultaneously; **no admin drain, no snapshot-reissue — user-initiated only.**

| Phase | Window | Action |
|---|---|---|
| T+0 | launch | V4 pool live + POL-seeded. Staking/LP reward weight skewed V2 (e.g. 95/5) so V2 liquidity isn't stranded. |
| T+0→14d | wk 1–2 | Front-end "Migrate to V4" modal (Enso-pattern atomic, or manual remove-V2 → add-V4). Weights → 50/50. |
| T+14→30d | wk 3–4 | Front-end routes **new swaps to V4** (via `TegridyV4SwapRouter` so the premium discount applies). Weights → 5/95. |
| T+30d | month 1 | V2 LP rewards off; V2 adds blocked at router level. **V2 withdrawals stay open forever.** |
| T+90d | month 3 | V2 deprecated; contracts stay live + verified. |

**Liquidity-fragmentation risk (the main downside of dual-AMM):** two pools = split
depth = worse prices until migration completes. Mitigate by (a) seeding V4 POL up front,
(b) the reward-weight ramp pulling LPs to V4, (c) routing swaps to whichever pool quotes
better during the overlap (or just to V4 once its depth leads).

## 4. Frontend integration (so #2/#3 actually reach users)
- **Swaps** route through `TegridyV4SwapRouter.swap(...)` (not raw UniversalRouter) — that's what makes the premium discount apply (it authenticates the user into `hookData`). Aggregator-routed swaps won't get the discount; acceptable.
- **LP** deposits the V4 PositionManager NFT into `TegridyBoostedLPStaker.deposit(tokenId)` to earn veTOWELI-boosted rewards; `getReward` / `withdraw` flows.
- **Dual-pool UI** during migration: show V2 + V4, the "migrate" CTA, and reward-weight status.

## 5. What's prep-able now vs blocked
- **Now (no audit dep):** this runbook, the branch-merge, the frontend integration spec/build, dep-pin reconciliation check.
- **Blocked on the audit:** the actual mainnet deploy (steps 1–14). Do not execute ahead of a clean audit.
```
