# V4 Migration Plan — Phase 7.x (Next-Wave)

> Branch: `next-wave/v4-migration` (off `mvp-launch`).
> Status: **PLAN ONLY — not active code.** Awaiting V2 mainnet launch + 30-day clean monitoring window at $100M TVL before this branch goes from plan to implementation.
> Approval given: 2026-05-23. Choice 1 = Option B (V2 now → V4 in Phase 7.x). Choices 2-5 = defaults (bundle / $1.2M staggered / V2-style NFTPool / fold FeeHook).
> **Updated 2026-05-30** with a battle-tested-library research pass (in-chat approval). Headline change: the OZ `uniswap-hooks` library now ships a `general/` folder of ready-to-use hooks (v1.1.1, 2025-11-27), so the **JIT guard is no longer custom code — it inherits OZ `LiquidityPenaltyHook` verbatim**, and two new conversion candidates (ReferralSplitter, LPFarming) plus two evaluated user-facing modules (AntiSandwich, LimitOrder) are recorded below. No deployable logic added — the trigger gate still holds.

## Thesis

Migrate the AMM layer (Factory + Pair + Router + TWAP + SwapFeeRouter + POLAccumulator) to a V4-native bundled hook on top of canonical Uniswap PoolManager. Keep everything else V2-style. Net effect: ~8k LoC eliminated, ~1.5k LoC of V4-native code added, ~75% surface reduction in the AMM layer specifically.

Drawn directly from 2025 production losses:
- **Cork ($11M, May 2025)**: missing `onlyPoolManager` auth + integration with stale periphery version that lacked an upstream auth check
- **Bunni ($8.3M, Sep 2025)**: rounding direction safe in isolation, unsafe under multi-operation sequencing in custom curve math
- **z0r0z V4 Router ($42k, Mar 2026)**: assembly trusting fixed calldata offset

**The pattern**: custom hook logic is the attack surface. Inherit OpenZeppelin canonical bases verbatim; never roll our own curve math, share math, or callback authorization.

## Trigger gate (do NOT start implementation until this is met)

| Condition | Status |
|---|---|
| V2 mainnet deployed via `mvp-launch` | pending |
| V2 audit complete (Spearbit + Sherlock + Certora) | pending |
| Restaking opened (Phase 7.0) | pending |
| TVL crossed $100M | pending |
| 30 consecutive days clean monitoring (no Forta alerts, no pause events) | pending |
| Multisigs holding stably (no signer rotations mid-period) | pending |
| **ALL of the above true** | **→ kick off V4 implementation** |

~~Until then, this branch holds only the plan and skeleton stubs.~~ **SUPERSEDED 2026-05-30:** the trigger gate was overridden in-chat; implementation has begun on this branch.

| Batch | Scope | Status |
|---|---|---|
| 1 | Fee+JIT core — inherit `LiquidityPenaltyHook` verbatim + verbatim `BaseOverrideFee` copy; vendor OZ hooks v1.1.1; bump v4-core/periphery | ✅ compiles (700b269) |
| 2 | Pool-key allowlist (`_beforeInitialize`, Cork defense) + admin-configurable bounded fee | ✅ compiles |
| 3 | ~~Oracle + volatility fee~~ **DROPPED 2026-05-30** (no verbatim oracle in pinned deps; internal oracle = too much custom surface; Batch 2's bounded admin fee stands). **POL `_afterSwap` skim (3c) ✅ compiles** — flat-bps skim of the unspecified currency, accrued as ERC-6909 claims (custody stays in PoolManager), swept to treasury. take/delta mechanics copied verbatim from OZ `BaseDynamicAfterFee`. **UNTESTED** — afterSwap delta math is the highest-risk code; needs Batch 5 tests + audit. | ✅ 3c compiles |
| 4 | `TegridyV4HookAdmin` timelock (propose/execute/cancel for baseFee / polSkim / polRecipient / pool-allowlist; mirrors `SwapFeeRouterAdmin`) wired via one-time `setHook` (hook's `paramAdmin` is immutable → admin precedes hook). Plus claims→native-ETH redemption (`redeemPOL` + `unlockCallback`: burn claims → take real currency → treasury). ✅ compiles + tested. **PauseGuardian wiring still deferred.** | ✅ (11 tests green) |
| 5 | HookMiner CREATE2 mining + DeployV4/VerifyV4 + full test/invariant suite | 🟡 partial — behavioral test harness GREEN (7 tests: allowlist rejection, dynamic-fee gate, admin gating + bounds, **POL accrual + sweep conservation / no leak**). Deploy scripts + fuzz/invariant suite + edge cases (exactOutput POL, native-ETH currency, multi-swap) still pending. |

⚠️ Still **NOT deployable or audited.** The sections below are the original (pre-override) spec and remain the target for the work.

## Scope: what's in, what's out

### IN — V4-native rebuild

| Replacing | With | LoC delta |
|---|---|---|
| TegridyFactory | Canonical Uniswap V4 PoolManager singleton (`0x000000000004444c5dc75cb358380d2e3de08a90` mainnet) | -1.1k → 0 (deployed by Uniswap Labs) |
| TegridyPair | V4 pool config (full-range, constant-product XYK, dynamic-fee enabled) | -2.0k → 0 (config-only) |
| TegridyRouter | Uniswap UniversalRouter | -1.7k → 0 (external) |
| TegridyTWAP | OZ `BaseOracleHook` + `OracleHookWithV3Adapters` (V3-compat adapter for existing oracle consumers) | -1.7k → ~80 LoC integration |
| SwapFeeRouter | Hand-written fee override (6-line verbatim copy of OZ `BaseOverrideFee` — cannot be inherited alongside the JIT hook; see Architecture correction) | -2.5k → ~20 LoC |
| SwapFeeRouterAdmin | Folded into TegridyV4HookAdmin | -800 → 0 (consolidated) |
| POLAccumulator | `afterSwap` BeforeSwapDelta skim + batched LP minter (PositionManager NFT to treasury) | -1.6k → ~200 LoC |
| TegridyFeeHook (owner-stranded V4 hook from prior wave) | Replaced entirely by TegridyV4Hook (fresh CREATE2 deploy from new address) | -1.0k → folded into new |

**Total: -12.4k V2 LoC → +~1.5k V4 LoC.** -88% on the AMM/fee/POL/TWAP layer.

### OUT — unchanged (V2 patterns remain)

| Contract | Reason |
|---|---|
| Toweli (ERC20) | Token mechanics — orthogonal to AMM |
| TegridyStaking + JbacVault + StakingAdmin + Restaking | Voting power, NFT positions, JBAC boost — orthogonal |
| RevenueDistributor | Fee distribution math — orthogonal (reads V4 native ETH instead of WETH). Hook *feeds* it via afterSwap; distribution stays off-path. |
| ReferralSplitter | **PROMOTED to conversion candidate (2026-05-30)** — see "New conversion candidates" below. Credit-side moves into `afterSwap`; claim/accounting stays. |
| TegridyTokenURIReader | NFT URI rendering — orthogonal |
| TegridyLending + LendingAdmin + NFTLending (deferred) | P2P NFT lending — reads V4 oracle via V3-adapter, otherwise unchanged |
| TegridyNFTPool + Factory (deferred) | Stays Sudoswap LSSVM-style. V4's two-ERC20 currency model is bad fit for NFT bonding curves. No production V4 NFT-AMM exists. |
| TegridyLPFarming (deferred) | **PROMOTED to conversion candidate (2026-05-30)** — it *must* change form anyway (V4 has no ERC20 LP token to stake). External PositionManager-NFT staker vs. a liquidity-incentive hook — comparison in "New conversion candidates" below. |
| TegridyLaunchpadV2 (deferred) | Adopts Doppler hook (Pantera-backed, Zora/Paragraph using it) as a dependency instead of being rewritten. |
| GaugeController + VoteIncentives + VoteIncentivesAdmin (deferred) | Governance layer — orthogonal |
| TegridyDropV2 + CommunityGrants + MemeBountyBoard + PremiumAccess (deferred) | All orthogonal to AMM mechanics |

## Architecture

```
                Uniswap V4 Canonical PoolManager
                                     │
                                     ▼
                       TegridyV4Hook (~600 LoC, single contract)
                                     │
        ┌──────────┬───────────┬─────┴──────┬───────────────────┐
        ▼          ▼           ▼            ▼                   ▼
   FeeModule   POLModule   OracleModule   JIT protection    [evaluated — user-facing]
   (hand-      (CUSTOM —   (OZ Base-      (OZ Liquidity-    AntiSandwichHook +
   written 6-  afterSwap   OracleHook +   PenaltyHook       LimitOrderHook
   line copy   skim+mint)  V3 adapter)    VERBATIM —        (SEPARATE POOL —
   of OZ Base- (Batch 3)   (Batch 3)      the ONE inherited cannot bundle;
   OverrideFee)                           base)             see correction)
        │          │           │
        ▼          ▼           ▼
  RevDistributor PositionMgr  V3-style consumers
  (native ETH)   NFT→Treasury (Lending, dashboards)

  ⚠ Only ONE OZ hook can be inherited (single BaseHook constructor). We inherit
  LiquidityPenaltyHook verbatim; the fee override is a 6-line verbatim COPY of
  BaseOverrideFee. See "Architecture correction" below.

       TegridyV4HookAdmin (~150 LoC) — timelocked param governance
                              │
                              ▼
                          MULTISIG (cold 4-of-7)
                          PAUSE_GUARDIAN (hot 3-of-5)
```

### Architecture correction (2026-05-30, discovered at compile-time)

The original "bundle several OZ hooks by multiple inheritance" design **does not compile and cannot**. Every OZ hook (`BaseOverrideFee`, `LiquidityPenaltyHook`, `AntiSandwichHook`, …) derives from `BaseHook`, whose constructor takes the PoolManager. Inheriting two of them produces:
- Solidity error **3364** "Base constructor arguments given twice" (both call `BaseHook(poolManager)`), and
- Solidity error **6480** shared-callback ambiguity on `_beforeSwap` / `_afterInitialize`.

The OZ library is designed for **one hook per pool**, not bundling. Since V4 allows exactly one hook address per pool and a meme coin wants one deep pool, the resolution (shipped in Batch 1, `TegridyV4Hook` compiles) is:

1. **Inherit the single heaviest OZ hook verbatim** — `LiquidityPenaltyHook` (carries the real JIT fee-withholding accounting we must not reimplement).
2. **Hand-write the lightweight concerns** as overrides in the same contract, copying the OZ pattern verbatim where one exists:
   - Fee override = 6-line verbatim copy of `BaseOverrideFee` (`_afterInitialize` dynamic-fee assert + `_beforeSwap` returning `fee | OVERRIDE_FEE_FLAG`).
   - POL skim/mint = custom `_afterSwap` (Batch 3).
   - Pool-key allowlist = custom `_beforeInitialize` (Batch 2).
3. **`AntiSandwichHook` / `LimitOrderHook` cannot share this pool** (both fight `_beforeSwap`/fee). If adopted, each runs on its OWN pool.

Net custom surface vs. the (impossible) all-verbatim ideal: the fee-override copy + POL + allowlist. This is the true minimal-surface answer given the library's constraints.

### Module isolation rules (Bunni lesson)

Bunni's $8.3M loss was multi-op rounding interaction across modules sharing state. We avoid this by:
1. **Each module gets its own storage namespace** — `feeAccumulator`, `polAccumulator`, `oracleObservations` never cross-write. JIT protection lives entirely inside OZ `LiquidityPenaltyHook`'s own storage — we inherit, we don't reach into it.
2. **No shared math.** Fee skim arithmetic does not touch POL accumulator; POL accumulator does not touch oracle observations.
3. **Invariant tests assert non-interference**: a sequence of fee-only operations cannot change POL state, and vice versa. Property-fuzz this in CI.
4. **No custom curves.** Constant-product full-range LP only. We don't have LDFs to round.

### Auth + access (Cork lesson)

1. **Inherit OZ `BaseHook` verbatim.** Provides `onlyPoolManager`, return-data encoding, permission validation in constructor. Never override `_unlockCallback`.
2. **Pool-key allowlist.** `beforeInitialize` only accepts pools whose `(currency0, currency1, tickSpacing)` matches the whitelisted set. Catches the Cork "attacker deploys their own pool with our hook" class.
3. **`Hooks.validateHookPermissions(this, expected)` in constructor** — fails deploy if mined address bits don't match expected lifecycle flags.
4. **Pin OZ version + monitor upstream.** Cork's specific failure was an old periphery version lacking an auth check added later. We pin `OpenZeppelin/uniswap-hooks@v1.1.1` and treat any minor bump as triggering re-audit.
5. **`onlyPauseGuardian` modifier from base/PauseGuardian.sol** carries over from MVP — same emergency-pause pattern wired on day 1.

## Battle-tested library adoption (2026-05-30 research pass)

A research pass against the live V4-hook ecosystem (OZ `uniswap-hooks` source; Angstrom / Bunni / Doppler / Flaunch / Zora / Clanker docs and postmortems) produced one decisive change and two new modules to evaluate. **All adoptions are verbatim OZ inheritance — consistent with the minimal-surface mandate.**

### OZ `uniswap-hooks` ships ready-to-use hooks now

As of v1.1.1 (latest release 2025-11-27), the library's `general/` folder ships four production hooks we can inherit verbatim instead of writing custom logic:

| OZ hook | What it does | Our use |
|---|---|---|
| `LiquidityPenaltyHook` | Penalizes LP fee collection on quick add→remove (JIT), *donates* the penalty to in-range LPs. `blockNumberOffset` param. Available since v0.1.1 — most mature of the set. | **ADOPT — replaces our planned CUSTOM 5-block JIT guard.** Strictly on-mandate: delete custom code, inherit verbatim. Rewards honest LPs instead of merely blocking. Caveat: low-liquidity/long-tail pools can be multi-account-bypassed → use a larger `blockNumberOffset`. |
| `AntiSandwichHook` | Guarantees no swap fills better than start-of-block price → sandwich bots can't profit off retail. Umbra Research design, available since v1.1.0. | **EVALUATE — pilot.** Biggest retail-UX win (helps every swapper). NOT plug-and-play: protects only the `zeroForOne` direction, can hit `MemoryOOG` on large moves with small tick spacing, and reduces arb so start-of-block price drifts from market. Needs its own audit-pass + a `_handleCollectedFees` impl. |
| `LimitOrderHook` | On-chain limit orders at ticks outside current range; cancellable until filled. | **EVALUATE — product expansion.** "Buy the dip at X / sell at target" natively in the pool — the V2 fork cannot do this. |
| `ReHypothecationHook` | Lends out idle LP liquidity for extra yield. | **REJECT for now.** Exactly the rehypothecation surface that cost Bunni v2 $8.3M. Defer indefinitely. |

This **corrects the prior assumption** (in the skeleton header) that the JIT guard had to be custom. It does not — only the POL skim/mint module stays custom, shrinking the bespoke surface further.

### Meme-coin composability (confirmed — no action)

The research's strongest strategic point: a fee-on-transfer / reflection ERC20 breaks Uniswap's invariant (the "K" revert), breaks 1inch/0x aggregators, and is rejected by most CEX deposit flows — so any tax/burn/buyback logic belongs at the **hook**, never in the token. **Verified `Toweli` is already a clean fixed-supply ERC20 with no transfer logic — already compliant. No action.** If a buyback/burn flywheel is ever wanted, the canonical pattern is an `afterSwap` fee slice driving buy orders via OZ `LimitOrderHook` (the Flaunch "Progressive Bid Wall" shape) — recorded as a future option, not adopted now.

## New conversion candidates (2026-05-30) — evaluate at kickoff

Promoted from the "OUT — unchanged" table. Both are genuine "better as a hook"; neither is locked.

**1. ReferralSplitter → fold the credit-side into `afterSwap`.** Today `recordFee(address user)` is called by a *trusted approved caller* (the fee router) in a separate step — an extra trust assumption + coordination point. In V4, `afterSwap` reads the referrer and credits them atomically in the same swap, removing the privileged `recordFee` caller entirely. The claim/accounting half stays a normal contract. This is a **trust-surface reduction** — on-mandate. Audit note: referrer is read from `hookData`; prove it cannot be spoofed to redirect credit.

**2. TegridyLPFarming → liquidity-incentive hook vs external NFT-staker.** It currently stakes the V2 pair's ERC20 LP token, which **does not exist in V4** — so it must be rebuilt regardless. Compare at kickoff:
- *External PositionManager-NFT staker* (prior default): user locks the position NFT; familiar Synthetix-style accounting; custody + transfer friction.
- *Liquidity-incentive hook* (`afterAddLiquidity`/`afterRemoveLiquidity` accrual by liquidity-seconds, Aerodrome-Slipstream shape): user **keeps** their position and still earns; no NFT custody. But more hook surface and **no verbatim source** → bespoke accounting (custom-risk).
- *Recommendation*: default to the external staker unless a verbatim reference ships; revisit if OZ or Aerodrome publishes a CL-gauge hook.

## Rejected frontier options (2026-05-30 research) — for the record

So future scans don't re-litigate these:

| Option | What it is | Why rejected |
|---|---|---|
| Angstrom (Sorella) | MEV-recapture DEX, returns arb to LPs | LIVE mainnet but a **closed validator-network venue, not an importable hook** — you'd deploy on *their* DEX. The LVR it fights barely applies to a meme coin (no deep CEX reference price to arbitrage). |
| Bunni v2 am-AMM | Auction-managed fees + Surge Fee, ~59% of V4-hook volume | First-party DEX/venue, not a verbatim library; auction-griefable on thin volume; high complexity = audit surface. Adopt only as an external venue, if ever. |
| CoW AMM | Batch-auction LVR recapture | Not a V4 hook — Balancer/CoW infra, off our V4 path. |
| "MEV tax" (priority-ordering) | Tax `tx.gasprice − basefee` in-hook | Requires a priority-ordered chain (L2/Unichain). Does **not** work on Ethereum L1 PBS. |
| veToken in-swap fee discount | `beforeSwap` lowers fee for veTOWELI holders | Real value, but **no verbatim source — pure custom code.** Defer; if ever built, it's the one small audited custom read. |

**Net:** the LVR/MEV-recapture frontier is venue-migration, not hook-adoption, and is a poor fit for a sandwich-driven meme pair. The right minimal-surface answer is the OZ verbatim stack above.

## Migration sequencing — V2 → V4 with TVL ramp

Recommended pattern (Uniswap's own V2→V3 model, Enso-tooled atomic migration for users):

| Phase | Window | Action |
|---|---|---|
| Pre-deploy | T-90d | Audit cycle complete (Spearbit + Cantina + Certora). HookMiner mines address. Treasury seeds POL. |
| T+0 | Day 0 | Deploy V4 pool with `TegridyV4Hook`. Staking-side reward weights skewed V2 (95/5). |
| T+0 → T+14d | Week 1-2 | Front-end adds "Migrate to V4" modal (Enso-pattern, atomic, user-initiated). Reward weights flip to 50/50. |
| T+14d → T+30d | Week 3-4 | Front-end routes new swaps to V4. Reward weights 5/95. |
| T+30d | Month 1 | V2 LP rewards disabled. V2 adds blocked at router level (V2 withdrawals remain open forever). |
| T+90d | Month 3 | V2 deprecated. Contracts stay live + verified for posterity. |

**No admin-drain.** No snapshot-and-reissue. User-initiated migration only. Respects the 3-multisig trust model.

## Audit budget

Same shape as the V2 audit (Spearbit + Contest + Certora), V4-specialist tier:

| Provider | Scope | Cost |
|---|---|---|
| Spearbit (via Cantina) | Bundled hook, focus on delta accounting + Cork-class auth + cross-hook contagion | $250k (4 wks × 4-5 researchers) |
| Cantina contest | Post-Spearbit fix code, 2-3 weeks | $100k-$150k pool |
| Certora FV | Hook-side invariants: per-module non-interference, fee accumulator conservation, POL solvency, TWAP monotonicity-under-truncation | $150k-$250k |
| **Total V4 cycle** | | **$500k-$650k** |

Skip Sherlock for V4 (Watson pool for V4 concentrates on Cantina, not Sherlock).
Skip Trail of Bits (premium not justified vs Spearbit's V4 portfolio — they ran the $2.35M Uniswap V4 contest).
Skip OpenZeppelin firm audit (long queue; they're the upstream library author, conflict-adjacent).

**2-year total (V2 + V4) ≈ $1.2M** staggered across two audit cycles. vs $850k single V4 cycle if we'd gone Option A.

## V4-specific risk register (net-new attack surface vs V2-fork)

Documented in `TRUST_ASSUMPTIONS_MVP.md` under a future "V4 surface" section before any implementation work starts.

| Class | Precedent | Defense |
|---|---|---|
| Hook callback auth gap | Cork $11M (May 2025) | Inherit OZ `BaseHook`. `onlyPoolManager` everywhere. Never override `_unlockCallback`. |
| Custom math precision (multi-op) | Bunni $8.3M (Sep 2025) | No custom curves. No share math. Property-fuzz multi-op sequences in CI. |
| Pool-key spoofing | Cork variant | `beforeInitialize` allowlist on `(currency0, currency1, tickSpacing)`. |
| Hook permission byte encoding | Multiple Hookathon findings | HookMiner + `Hooks.validateHookPermissions` in constructor + CI check on init-code hash. |
| Cross-hook contagion | Cork class | Reject callbacks for any pool where `key.hooks != address(this)`. |
| Locker re-entry | Bunni v2 pre-fix near-miss | OZ `BaseHook` + nonReentrant on entry. Never call untrusted external contracts inside `unlockCallback`. |
| Donate griefing | Theoretical (Composable Security) | Disable `beforeDonate`/`afterDonate` permission bits (we don't need them). |
| JIT liquidity | TOB-BUNNI-9 class | **OZ `LiquidityPenaltyHook` verbatim** (was a custom 5-block hold). Penalizes quick add→remove via `blockNumberOffset`, donates penalty to in-range LPs. Caveat: low-liquidity/long-tail pools are multi-account-bypassable → use a larger `blockNumberOffset` there. |
| Custom-curve flash-loan vectors | Bunni $8.3M | We have no custom curve. Constant-product XYK only. |
| Native ETH dual-representation | OZ Core Audit critical (CELO/MATIC) | Whitelist supported currencies. Implement `receive()`. Validate `msg.value == 0` for ERC20-only flows. |
| Permit2 integration bugs | ChainSecurity 2022 (long fixed) | Use `SignatureTransfer` (one-shot), verify expiry on-chain, chainId bind. |
| Oracle hook manipulation | Composable Security writeup | Use `TruncGeoOracle` truncation (capped per-block tick movement). Hook must be non-upgradeable + ownerless for downstream lending consumers. |
| Hook upgradeability | Multiple audit findings | **Hook is immutable.** Parameter changes via TegridyV4HookAdmin timelock only. No proxy. |
| Anti-sandwich one-directional gap | OZ `AntiSandwichHook` design note | Only `zeroForOne` is protected. If adopted: order currency0/currency1 so the *protected* side is the retail-buy direction, and bound the `MemoryOOG` risk via tick-spacing choice before mainnet. Pilot-only until its own audit pass. |
| Limit-order fee accounting | OZ `LimitOrderHook` IMPORTANT note | Fees can accrue on partially-filled/cancelled orders. Rely on OZ accounting verbatim; property-fuzz cancel/refill/partial-fill sequences in CI. |

## Pinned dependencies

To be set at implementation time. Until kickoff, treat these as targets to verify before pinning:
- `OpenZeppelin/uniswap-hooks` — **pin `v1.1.1` (latest release, 2025-11-27)** (re-verify newest stable at kickoff). Adopted verbatim: `base/BaseHook`, `fee/BaseOverrideFee`, `general/LiquidityPenaltyHook` (JIT), oracle base. Evaluated: `general/AntiSandwichHook`, `general/LimitOrderHook`. Rejected: `general/ReHypothecationHook` (Bunni surface). NOTE: `master` is ahead at an unreleased v1.2.0 — do NOT build off master. OZ labels the library experimental/"as-is" → it runs through our own V4 audit cycle regardless. **Cork's lesson: re-audit on any version bump.**
- `Uniswap/v4-core` — **bumped 2026-05-30 from the `v4.0.0` tag (`e50237c`) to `d153b04`** to match OZ uniswap-hooks v1.1.1 (which imports `PoolOperation.sol`, absent in v4.0.0). `Uniswap/v4-periphery` bumped `686f621` → `7ebd04b`. ⚠️ These are dev commits, not release tags — **reconcile against the deployed mainnet PoolManager ABI before any deploy.** Also: `uniswap-hooks` is currently vendored as a plain dir under `lib/uniswap-hooks/`; convert to a pinned submodule at integration. Otherwise pin to deployed canonical PoolManager address per chain.
- `Uniswap/v4-periphery` — pin to released version that includes the auth-check upstream fix (post-Feb 2025).
- `Doppler` (if launchpad migration adopts it) — pin to audited stable.

## Files in this branch (skeleton only — NOT for deploy)

| File | Purpose |
|---|---|
| `contracts/V4_MIGRATION_PLAN.md` | This document. Canonical plan. |
| `contracts/src/v4/TegridyV4Hook.sol` | Skeleton bundled hook (compiles, no logic). Marks the module boundaries and inheritance. |
| `contracts/src/v4/TegridyV4HookAdmin.sol` | Skeleton admin (compiles, no logic). |
| `contracts/script/DeployV4.s.sol` | Skeleton deploy script with HookMiner integration outline. |
| `contracts/script/VerifyV4.s.sol` | Skeleton verify script with V4-specific invariant list (TBD). |

## What I will NOT do on this branch

- Implement actual hook logic. That waits for the trigger gate.
- Touch any file under `contracts/src/` outside `contracts/src/v4/` subdirectory.
- Touch any file under `contracts/script/` other than the two V4-prefixed scripts.
- Change `mvp-launch` branch. V4 migration is fully isolated.

> The 2026-05-30 research update touched only this plan doc and the two skeleton header comments. No logic was added; the skeleton constructors still `revert SkeletonOnly()`. The trigger gate is unchanged.

## Approvals captured (2026-05-23)

| Question | Choice |
|---|---|
| Timing | **Option B** — V2 now, V4 in Phase 7.x |
| Hook bundling | **Bundle** with isolated module storage |
| Total audit budget | **$1.2M staggered** over 2 cycles |
| NFTPool | **V2-style (Sudoswap LSSVM)** — defer V4 NFT-AMM until production reference exists |
| TegridyFeeHook | **Fold into new TegridyV4Hook** — clean CREATE2 redeploy from new address |

## Approvals captured (2026-05-30 research pass)

| Question | Choice |
|---|---|
| Scope of "apply the research" | **Update plan + skeletons only** — no deployable logic; trigger gate still holds |
| JIT guard | **Replace custom 5-block hold with OZ `LiquidityPenaltyHook` verbatim** |
| AntiSandwich / LimitOrder | **Evaluate as user-facing modules** (pilot + own audit pass) — not auto-adopted |
| ReHypothecationHook | **Reject** (Bunni $8.3M rehypothecation surface) |
| ReferralSplitter / LPFarming | **Promote to conversion candidates** — evaluate at kickoff |
| Frontier MEV-recapture (Angstrom / Bunni am-AMM / CoW / MEV-tax) | **Reject** — closed venues not libraries; poor fit for a sandwich-driven meme pair |
| Toweli composability | **No action** — already a clean fixed-supply ERC20 (no transfer tax) |
