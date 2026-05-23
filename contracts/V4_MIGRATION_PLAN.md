# V4 Migration Plan — Phase 7.x (Next-Wave)

> Branch: `next-wave/v4-migration` (off `mvp-launch`).
> Status: **PLAN ONLY — not active code.** Awaiting V2 mainnet launch + 30-day clean monitoring window at $100M TVL before this branch goes from plan to implementation.
> Approval given: 2026-05-23. Choice 1 = Option B (V2 now → V4 in Phase 7.x). Choices 2-5 = defaults (bundle / $1.2M staggered / V2-style NFTPool / fold FeeHook).

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

Until then, this branch holds only the plan and skeleton stubs. Implementation lives elsewhere.

## Scope: what's in, what's out

### IN — V4-native rebuild

| Replacing | With | LoC delta |
|---|---|---|
| TegridyFactory | Canonical Uniswap V4 PoolManager singleton (`0x000000000004444c5dc75cb358380d2e3de08a90` mainnet) | -1.1k → 0 (deployed by Uniswap Labs) |
| TegridyPair | V4 pool config (full-range, constant-product XYK, dynamic-fee enabled) | -2.0k → 0 (config-only) |
| TegridyRouter | Uniswap UniversalRouter | -1.7k → 0 (external) |
| TegridyTWAP | OZ `BaseOracleHook` + `OracleHookWithV3Adapters` (V3-compat adapter for existing oracle consumers) | -1.7k → ~80 LoC integration |
| SwapFeeRouter | OZ `BaseOverrideFee` module inside bundled hook | -2.5k → ~150 LoC |
| SwapFeeRouterAdmin | Folded into TegridyV4HookAdmin | -800 → 0 (consolidated) |
| POLAccumulator | `afterSwap` BeforeSwapDelta skim + batched LP minter (PositionManager NFT to treasury) | -1.6k → ~200 LoC |
| TegridyFeeHook (owner-stranded V4 hook from prior wave) | Replaced entirely by TegridyV4Hook (fresh CREATE2 deploy from new address) | -1.0k → folded into new |

**Total: -12.4k V2 LoC → +~1.5k V4 LoC.** -88% on the AMM/fee/POL/TWAP layer.

### OUT — unchanged (V2 patterns remain)

| Contract | Reason |
|---|---|
| Toweli (ERC20) | Token mechanics — orthogonal to AMM |
| TegridyStaking + JbacVault + StakingAdmin + Restaking | Voting power, NFT positions, JBAC boost — orthogonal |
| RevenueDistributor + ReferralSplitter | Fee distribution math — orthogonal (reads V4 native ETH instead of WETH) |
| TegridyTokenURIReader | NFT URI rendering — orthogonal |
| TegridyLending + LendingAdmin + NFTLending (deferred) | P2P NFT lending — reads V4 oracle via V3-adapter, otherwise unchanged |
| TegridyNFTPool + Factory (deferred) | Stays Sudoswap LSSVM-style. V4's two-ERC20 currency model is bad fit for NFT bonding curves. No production V4 NFT-AMM exists. |
| TegridyLPFarming (deferred) | Stays external Aerodrome-pattern staker that holds V4 PositionManager NFTs. No battle-tested LP farming hook exists. |
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
                  ┌──────────┬───────┴───────┬──────────┐
                  ▼          ▼               ▼          ▼
            FeeModule    POLModule      OracleModule   JITGuard
            (OZ          (afterSwap     (OZ            (5-block
            BaseOverride skim + batch)  BaseOracleHook minimum
            Fee)                        adapter)       hold)
                  │          │               │
                  ▼          ▼               ▼
           RevDistributor  PositionMgr     V3-style consumers
           (existing,      NFT → Treasury  (Lending, off-chain
            native ETH)                     dashboards)

       TegridyV4HookAdmin (~150 LoC) — timelocked param governance
                              │
                              ▼
                          MULTISIG (cold 4-of-7)
                          PAUSE_GUARDIAN (hot 3-of-5)
```

### Module isolation rules (Bunni lesson)

Bunni's $8.3M loss was multi-op rounding interaction across modules sharing state. We avoid this by:
1. **Each module gets its own storage namespace** — `feeAccumulator`, `polAccumulator`, `oracleObservations`, `jitTimestamps` never cross-write.
2. **No shared math.** Fee skim arithmetic does not touch POL accumulator; POL accumulator does not touch oracle observations.
3. **Invariant tests assert non-interference**: a sequence of fee-only operations cannot change POL state, and vice versa. Property-fuzz this in CI.
4. **No custom curves.** Constant-product full-range LP only. We don't have LDFs to round.

### Auth + access (Cork lesson)

1. **Inherit OZ `BaseHook` verbatim.** Provides `onlyPoolManager`, return-data encoding, permission validation in constructor. Never override `_unlockCallback`.
2. **Pool-key allowlist.** `beforeInitialize` only accepts pools whose `(currency0, currency1, tickSpacing)` matches the whitelisted set. Catches the Cork "attacker deploys their own pool with our hook" class.
3. **`Hooks.validateHookPermissions(this, expected)` in constructor** — fails deploy if mined address bits don't match expected lifecycle flags.
4. **Pin OZ version + monitor upstream.** Cork's specific failure was an old periphery version lacking an auth check added later. We pin `OpenZeppelin/uniswap-hooks@vX.Y.Z` and treat any minor bump as triggering re-audit.
5. **`onlyPauseGuardian` modifier from base/PauseGuardian.sol** carries over from MVP — same emergency-pause pattern wired on day 1.

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
| JIT liquidity on POL | TOB-BUNNI-9 class | `beforeRemoveLiquidity` requires `block.number > addedAt + MIN_HOLD_BLOCKS` (5 default) for protocol-owned positions. |
| Custom-curve flash-loan vectors | Bunni $8.3M | We have no custom curve. Constant-product XYK only. |
| Native ETH dual-representation | OZ Core Audit critical (CELO/MATIC) | Whitelist supported currencies. Implement `receive()`. Validate `msg.value == 0` for ERC20-only flows. |
| Permit2 integration bugs | ChainSecurity 2022 (long fixed) | Use `SignatureTransfer` (one-shot), verify expiry on-chain, chainId bind. |
| Oracle hook manipulation | Composable Security writeup | Use `TruncGeoOracle` truncation (capped per-block tick movement). Hook must be non-upgradeable + ownerless for downstream lending consumers. |
| Hook upgradeability | Multiple audit findings | **Hook is immutable.** Parameter changes via TegridyV4HookAdmin timelock only. No proxy. |

## Pinned dependencies

To be set at implementation time. Until kickoff, treat these as targets to verify before pinning:
- `OpenZeppelin/uniswap-hooks` — current master is v1.1.x-RC2 (Sep 2025). Pin to whichever version is the latest released stable + audited at implementation time. **Cork's lesson: re-audit on any version bump.**
- `Uniswap/v4-core` — pin to deployed canonical PoolManager address per chain.
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

## Approvals captured (2026-05-23)

| Question | Choice |
|---|---|
| Timing | **Option B** — V2 now, V4 in Phase 7.x |
| Hook bundling | **Bundle** with isolated module storage |
| Total audit budget | **$1.2M staggered** over 2 cycles |
| NFTPool | **V2-style (Sudoswap LSSVM)** — defer V4 NFT-AMM until production reference exists |
| TegridyFeeHook | **Fold into new TegridyV4Hook** — clean CREATE2 redeploy from new address |
