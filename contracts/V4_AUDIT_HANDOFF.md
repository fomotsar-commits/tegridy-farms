# V4 Migration — Auditor Handoff Package

> Project: Tegriddy Farms (token: TOWELI). Branch: `mvp-launch` (V4 work merged in).
> Status: **behaviorally tested, UNAUDITED, not deployed.** Built ahead of the project's
> own trigger gate (V2 mainnet live + audit + $100M TVL + 30 clean days) at owner
> direction. This package is the scope + trust model + open-items list for an external
> audit (target: Spearbit/Cantina + Certora FV, per `V4_MIGRATION_PLAN.md`).

## 1. What this is

The AMM layer (V2 fork: Factory/Pair/Router/TWAP/SwapFeeRouter/POLAccumulator) is
replaced by a Uniswap **V4** deployment: the canonical PoolManager + a bundled hook on
the TOWELI/ETH pool, plus periphery. Everything else (staking, governance, lending, NFT)
stays V2-style. See `V4_MIGRATION_PLAN.md` for the full thesis and the prior-loss
postmortems (Cork, Bunni, z0r0z) the design is built against.

## 2. Scope

**In scope (custom code — ~1,033 LoC, 4 contracts):**

| Contract | LoC | Role |
|---|---|---|
| `src/v4/TegridyV4Hook.sol` | 375 | Bundled hook: fee override + premium discount + JIT + pool-key allowlist + POL skim/fee-split + emergency pause |
| `src/v4/TegridyV4HookAdmin.sol` | 291 | Timelock (24h/48h) governance for every mutable hook param |
| `src/v4/TegridyBoostedLPStaker.sol` | 250 | **Sole** #3 boosted-LP path (escrow V4 position NFT, attribute to depositor); pool-id + full-range deposit gate (C-1) |
| `src/v4/TegridyV4SwapRouter.sol` | 117 | Trusted router that authenticates the user for the premium discount; `maxIn` slippage ceiling (M-1) |
| `script/DeployV4.s.sol`, `script/VerifyV4.s.sol` | — | Deploy (HookMiner CREATE2) + post-deploy invariant checks |

**Out of scope (treated as trusted / audited upstream):**
- `lib/v4-core` @ `d153b048`, `lib/v4-periphery` @ `7ebd04b` (canonical Uniswap).
- `lib/uniswap-hooks` @ v1.1.1 (OpenZeppelin) — we inherit `LiquidityPenaltyHook`
  verbatim and copy `BaseOverrideFee` / `BaseDynamicAfterFee` patterns.
- `lib/openzeppelin-contracts`, `solmate`, `solady`.
- All non-AMM Tegridy contracts (staking, RevenueDistributor, PremiumAccess, …) — read
  by interface/address only.

## 3. Build & run

```
cd contracts
forge build                                   # exit 0 (lint_on_build=false — see below)
forge test --match-contract TegridyV4HookTest # 35 tests
```

Environment quirks the auditor should know:
- **`lib/uniswap-hooks` is vendored as plain source** (not a submodule). Convert to a
  pinned submodule at integration.
- **Context remapping** in `foundry.toml`: `lib/v4-core/:solmate/=lib/solmate/` (the V4
  libs import `solmate/src/...`; our V2 uses `solmate/...`).
- **`lint_on_build = false`**: forge's linter doesn't honor the context remap and fails
  to *resolve* v4-core's internal `solmate/src/...` during lint (not a compile error).
  Compilation + tests are unaffected.
- **Dep bump**: v4-core was moved from the `v4.0.0` tag to dev commit `d153b048` (OZ
  hooks v1.1.1 needs `PoolOperation.sol`). ⚠️ **Must be reconciled against the deployed
  mainnet PoolManager ABI before deploy** (see Open Items).

## 4. Architecture & key design decisions

- **Cannot bundle OZ hooks by inheritance** (every one derives `BaseHook(poolManager)` →
  Solc 3364/6480). Resolution: inherit the one heavy hook (`LiquidityPenaltyHook`)
  verbatim; hand-write the rest, copying OZ patterns verbatim where they exist.
- **No internal oracle** — none exists verbatim in the pinned deps; the volatility fee
  was dropped. The admin-bounded base fee + optional premium discount stand.
- **POL** skims the unspecified currency in `_afterSwap` as ERC-6909 claims (custody
  stays in the PoolManager), then `distributeFees` redeems + routes to staker/treasury/POL.
- **Per-user logic needs a trusted router** — a V4 hook's `_beforeSwap`/liquidity
  `sender` is the router, not the user. `TegridyV4SwapRouter` forces
  `hookData = msg.sender` (unspoofable). For LP rewards the NFT-staker keys off the
  depositor (also unspoofable).

## 5. Roles, trust model, deploy order

| Role | Who | Powers |
|---|---|---|
| `paramAdmin` | `TegridyV4HookAdmin` (owned by cold multisig) | All hook param changes, behind 24h/48h timelock. IMMUTABLE on the hook. |
| `owner` (admin) | cold 4-of-7 multisig | Proposes/executes timelocked changes; instant pause pass-throughs |
| `pauseGuardian` | hot 3-of-5 multisig | **Pause-only**, instant (`guardianPause`). Cannot unpause. |
| `trustedRouter` | `TegridyV4SwapRouter` | The only `sender` whose `hookData` the hook trusts for the discount |

**Deploy order** (hook's `paramAdmin` is immutable): (1) deploy `TegridyV4HookAdmin`;
(2) HookMiner-mine + CREATE2-deploy `TegridyV4Hook` with `paramAdmin = admin`;
(3) `admin.setHook(hook)`; (4) `admin.transferOwnership(multisig)`; (5) post-deploy:
allowlist the pool key, initialize (dynamic-fee flag), seed POL, wire `trustedRouter` /
`premiumAccess` (or leave 0), set `pauseGuardian`, `multisig.acceptOwnership`. (DeployV4
also deploys `TegridyV4SwapRouter` + `TegridyBoostedLPStaker` in-script — steps 4-5,
non-hook-coupled — and VerifyV4 asserts their wiring incl. the staker's allowedPoolId.)

## 6. Highest-priority audit focus

1. **POL `_afterSwap` delta accounting** (`TegridyV4Hook._afterSwap` + `unlockCallback` +
   `distributeFees`) — the take/delta math (copied from OZ `BaseDynamicAfterFee`), the
   claims→real-currency redemption, and split conservation (no value created/stuck). This
   is the Bunni/Cork class; top priority.
2. **`TegridyV4SwapRouter` settlement** — copied from `PoolSwapTest`; verify settle/take
   correctness, native-ETH refund, slippage, and that `hookData = msg.sender` is captured
   pre-`unlock` (z0r0z calldata-trust class). No assembly used.
3. **Cross-module non-interference** (Bunni) — fee/POL/discount/JIT must not corrupt
   each other's state under multi-op sequencing (the boosted-LP staker is now a fully
   separate contract that never touches hook state). Needs property/invariant fuzzing
   (we have unit + a few fuzz tests only — see §8).
4. **Premium discount auth** — confirm the discount is unreachable except via
   `trustedRouter`, and that a misbehaving `PremiumAccess` cannot brick swaps (try/catch).
5. **Boosted-LP reward math** (`TegridyBoostedLPStaker`) — Synthetix `rewardPerToken`
   adaptation, reward-token solvency vs `rewardRate` (H-2 guard), boost re-snapshot,
   escrow safety, and the pool-id + full-range deposit gate (C-1 — rejects foreign-pool
   and out-of-range positions).
6. **HookMiner permission-bit correctness** — `getHookPermissions()` must match the mined
   address bits (VerifyV4 asserts `Hooks.validateHookPermissions`).

## 7. Known issues / v1 limitations / open items (honest list)

- **Dep bump — RECONCILED 2026-05-31 (ABI-safe).** Diff of v4-core `v4.0.0` (`e50237c`,
  the audited mainnet release) → `d153b048` (our pin) on all hook-facing surfaces
  (`Hooks.sol`, `IHooks.sol`, `IPoolManager.sol`, `PoolOperation.sol`, types) shows
  **only a source relocation** of `SwapParams`/`ModifyLiquidityParams` from `IPoolManager`
  into `PoolOperation.sol`. Permission-flag bits, callback selectors, and struct field
  layouts are **identical** → our hook is ABI-compatible with the deployed mainnet
  PoolManager; HookMiner mines to the bits the live PoolManager checks. Residual final
  sign-off: diff our pinned interfaces vs the **verified Etherscan source** of
  `0x000000000004444c5dc75cb358380d2e3de08a90` to confirm mainnet == v4.0.0 (cheap; do at audit).
- **PauseGuardian set post-deploy** (not in constructor) → brief window with no guardian
  until wired. Document in the deploy runbook.
- **Premium discount reach**: only swaps via `TegridyV4SwapRouter` get it; aggregator-
  routed swaps (1inch/0x) do not (acceptable, documented). Disabled until wired.
- **Boosted-LP single path** (was M-3 double-count risk): the hook-callback
  `TegridyBoostedLP` and the hook's boosted-LP wiring were **DELETED** (M-3). The
  NFT-staker `TegridyBoostedLPStaker` is the sole #3 path — double-counting is now
  structurally impossible.
- **Boosted-LP v1 scope**: per-LP *aggregate* liquidity (not per-position); full-range
  **enforced** at deposit (C-1; no in-range tick attribution, unlike Aerodrome
  Slipstream); emissions-funded.
- **`notifyRewardAmount` (the staker)** has the Synthetix solvency guard
  (`rewardRate*duration ≤ balance`, H-2), amount-floor (`MIN_NOTIFY_AMOUNT`), duration
  bounds (`[1d, 365d]`), and the 24h anti-sandwich `NOTIFY_COOLDOWN` (ported verbatim
  from V2 LPFarming F-93-2). LPFarming's forfeit-residue capture + `reclaimForfeitedRewards`
  are DELIBERATELY NOT ported: that bucket's value in LPFarming comes from its
  reward-forfeiting `emergencyWithdraw`, which this staker has no equivalent of, so the
  bucket would only ever hold sub-nano truncation dust — and a reclaim sweep is exactly
  the owner rug-surface L-3 rejected. (Slither FPs annotated inline: `reentrancy-no-eth`
  on `deposit`, `divide-before-multiply` on the solvency check.)
- **Exact-output swaps** through the router are bounded by a `maxIn` slippage ceiling
  (M-1 FIXED — `unlockCallback` reverts `TooMuchSpent` when the input leg exceeds
  `maxIn`), alongside the `minOut`-on-output floor for exact-input.
- **Reward-token = TOWELI assumption** for the boosted-LP staker (transfer-tax-free; it
  is, but confirm).
- **TegridyV4HookAdmin**: the triplets (discount/split/sinks) mirror the audited base
  `TimelockAdmin` pattern; verify the value-binding is sufficient (no execute-time
  bounds bypass — hook re-validates on execute). (The boostedLP triplet was removed with M-3.)

## 8. Test coverage & gaps

- **35 tests** (`test/v4/TegridyV4Hook.t.sol`), via v4-core `Deployers` + `HookMiner`.
  Covers: allowlist rejection, dynamic-fee gate, admin gating + timelock flows, POL
  accrual/sweep/redeem + native-ETH + exactOutput + multi-swap, POL conservation fuzz
  (256 runs), fee-bounds fuzz, premium discount (incl. anti-spoof + floor), fee-split
  routing + conservation, pause (halt swaps / exit open / guardian-pause-only), trusted
  router (output/slippage/deadline/exact-output-maxIn/discount-path), NFT-staker
  (deposit/withdraw + C-1 foreign-pool & non-full-range rejection + notify-cooldown).
- **Gaps for the audit/Certora**: no broad invariant suite (cross-module
  non-interference, POL-never-exceeds-output), no mainnet-fork tests, reward-rounding
  edge cases, multi-position NFT-staker accounting, boost-decay timing. Recommend
  Certora FV on the §6 invariants.

## 9. References
- `V4_MIGRATION_PLAN.md` — full scope, batch log, risk register, audit budget.
- `V4_BOOSTED_LP_HOOK_DESIGN.md` — #3 design + the NFT-staker canonical-path note.
- `V4_TRUSTED_ROUTER_DESIGN.md` — user-identity problem + router/staker resolution.
- V4 work merged into `mvp-launch`; security fixes in `89b5785` (C-1/H-1/H-2) and
  `8afb9a4` (M-1/L-1 fixed, M-3 removed, M-2/L-2/L-3/L-4 accepted). See
  `V4_SECURITY_FINDINGS.md` for the full per-finding status.
