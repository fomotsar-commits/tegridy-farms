# V2 provenance — the named divergence allowlist

**What this directory is.** `TegridyPair.sol`, `TegridyFactory.sol` and `TegridyRouter.sol` are
forks of Uniswap V2. Until 2026-08-27 the canonical V2 source was not on disk, so every audit
comparison against it was reasoned from memory and drift into V2's audited surface was invisible
(`docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md`, remediation row 7). This directory makes the
lineage **mechanical**:

- `upstream/` — canonical `Uniswap/v2-core` @ `6a9e7c97860676e0992f22a49665760444c1cdf5` and
  `Uniswap/v2-periphery` @ `ed24991304291297c3b4a52818d02f46a17aa9a2`, sha256-pinned in
  `upstream.lock.json`. **Never edit these by hand** — the gate verifies the hashes first and
  refuses to compare against a tampered copy.
- `expected/*.expected.diff` — the **pinned divergence set**: the normalized diff of each contract
  against its upstream base. Generated, never hand-edited. This is the machine-readable allowlist.
- this file — the **human-readable allowlist**: every deliberate divergence named, with a one-line
  rationale and the test that pins it.

**The enforced property:** `scripts/check-v2-provenance.mjs` (CI: `Contracts CI / v2-provenance`)
recomputes the normalized diff on every PR and fails unless it is byte-identical to the pinned
snapshot. Any edit to the three contracts that survives normalization — one constant, one operator,
one require — turns the check red until the change is deliberately re-pinned, and re-pinning
produces a reviewable snapshot delta showing exactly which divergence from canonical V2 was added,
changed, or removed. Drift can still happen; it can no longer happen *invisibly*.

```bash
node scripts/check-v2-provenance.mjs                     # what CI runs (no network)
node scripts/check-v2-provenance.mjs --update-snapshots  # re-pin after a deliberate change
node scripts/check-v2-provenance.mjs --refresh           # pin-bump ritual only (network)
```

Re-pinning rule: **a snapshot update and its PROVENANCE.md entry travel in the same commit.**
An updated snapshot with no named entry is the invisibility problem this gate exists to end.

## What the normalizer folds away (and therefore CANNOT appear as a hunk)

Everything not on this list is treated as real divergence and must be pinned.

| Folded | Why it is safe to fold |
|---|---|
| Comments, whitespace, line-wrapping | Non-semantic; one-statement-per-line re-chunking makes the diff formatter-immune |
| `pragma` lines | The 0.5.16/0.6.6 → 0.8.26 compiler move is named below; the *consequences* (SafeMath removal etc.) still show as hunks |
| Quote style; upstream's `"UniswapV2: "` / `"UniswapV2Router: "` revert-message prefix | Message *content* differences remain visible |
| `uint`→`uint256`, `now`→`block.timestamp` | Exact compiler aliases |
| `UniswapV2Library.` call-site qualifier | Ours inlines the library; the declaration line stays visible |
| Identifier renames, whole-word only, per the `TARGETS` table in the script: `TegridyPair`→`UniswapV2Pair`, `TegridyFactory`→`UniswapV2Factory`, `ITegridyFactory(Router)`→`IUniswapV2Factory`, `TegridyRouter`→`UniswapV2Router02`, `FixedPointMathLib`→`Math`, and the router's inlined-library names (`_pairFor`→`pairFor`, `_getAmountOut`→`getAmountOut`, `_getAmountIn`→`getAmountIn`, `_getReserves`→`getReserves`, `_sortTokens`→`sortTokens`, `_calculateLiquidity`→`_addLiquidity`) | Renames are data-preserving; an *unmapped* Tegridy identifier deliberately shows up as drift. Renames never touch string literals |

Snapshot `up:`/`ours:` line numbers refer to the normalized streams, not source lines.

## Divergence catalog

Grouped, not lumped: the three drift classes the 2026-08-26 audit called out by name come first.
"Pinned by" = tests that fail if the divergent behaviour is reverted or broken.

### D1. Fee switch (Pair `_mintFee` + Factory governance)

The 1/6-of-K-growth protocol-fee **formula is canonical V2, verbatim** (`numerator =
totalSupply*(rootK-rootKLast)`, `denominator = rootK*5 + rootKLast`). The divergence is in the
*switch*: V2's instant `setFeeTo`/`setFeeToSetter` are replaced by 48h-timelocked
`proposeFeeToChange`/`executeFeeToChange` and a 24h two-step setter rotation; the V2-named setters
remain as reverting stubs.
**Rationale:** an instantly-redirectable fee sink is a one-key rug; the formula itself must never drift.
**Pinned by:** `AuditFixes_Pair.t.sol::test_mintFee_protocolShareIsSixteenth`,
`Audit195_Pair.t.sol::test_F19_mintFee_protocolGets1Sixth`,
`Audit195_Factory.t.sol::test_F12_proposeFeeToChange_full_lifecycle`,
`::test_F26_deprecated_setFeeTo_reverts`, `::test_F28_pending_feeTo_cleared_on_setter_transfer`.

### D2. kLast / harvest lifecycle — **real drift into V2's audited protocol-fee surface**

V2 refreshes unconditionally in `mint`/`burn`: `if (feeOn) kLast = reserve0*reserve1`. Ours
refreshes only when `feeOn && kLast != 0 && !disabledPairs(this)`, and the **first** `kLast` write
is moved into `harvest()` — a ~50-SLOC function with **no V2 equivalent** (5-minute
`HARVEST_INTERVAL`, bootstrap/cleanup/no-op branching, bootstrap gated to `feeToSetter`,
`ProtocolFeeHarvested` event). Consequence (audit §3.4): if `kLast` is never bootstrapped the
protocol collects zero fee, and re-enabling `feeTo` after a disable no longer self-heals.
**Rationale:** F-31-A/H-7 — an attacker bootstrapping `kLast` from 0 at a manipulated K suppresses
protocol fee accrual; R016-M1 — permissionless `_mintFee` materialisation on hot pairs without LP churn.
**Pinned by:** `TegridyPair.t.sol::test_NEWA7_harvestMintsFeeShareToFeeTo`,
`::test_NEWA7_harvestIdempotentWithoutVolume`, `::test_R016M1_harvestRateLimitWindow`,
`::test_R016M1_harvestKeeperCadenceMaterialisesFee`,
`FinalAudit_AMM.t.sol::test_AUDIT6_mintFeeManipulation`.
**Status:** pinned, **not blessed** — remediation row 9 (restore V2's unconditional refresh, delete
`harvest()`) is open. This entry records what ships; if row 9 lands, the snapshot delta will show
these hunks disappearing.

### D3. Guardian hooks (Factory circuit breaker reaching into the Pair hot path)

`disabledPairs`/`blockedTokens` registries in the factory, read by the pair on **every**
`mint`/`swap`/`skim`/`sync`/`harvest` (V2 pays zero external calls here); guardian role with
instant `emergencyDisablePair` (isPair-gated, 3/day rate limit, re-enable only via the 48h
timelock), 48h-timelocked guardian rotation requiring a multisig-class address.
**Rationale:** NEW-A2 — a malicious token flipping to FoT/hook mode post-listing drains a pair
faster than a 48h governance loop; D-AMM-H2 — ungated `sync`/`skim` on a disabled pair is a
TWAP-poisoning donation primitive.
**Pinned by:** `Audit195_Pair.t.sol::test_F5_swap_disabledPairReverts`,
`RedTeam_AMM.t.sol::test_ATTACK5_bypassDisabledPairs`,
`FinalAudit_AMM.t.sol::test_AUDIT3_disabledPairsGasOverhead`,
`TegridyFactory.t.sol::test_NEWA2_guardianEmergencyDisableInstant`,
`::test_NEWA2_randomCannotEmergencyDisable`,
`Audit195_Factory.t.sol::test_F01_constructor_rejects_zero_guardian`,
`base/DeployBaseMVP.t.sol::test_GuardianIsTheSafeFromBlockOneWithNoRotationQueued`.

### D4. TegridyPair — remaining named divergences

| Divergence | One-line rationale | Pinned by |
|---|---|---|
| Solidity 0.8.26: SafeMath call-syntax → checked operators (visible in every formula hunk); `uint112(-1)` → `type(uint112).max` | Same arithmetic, compiler-checked | `FinalAudit_AMM.t.sol::test_AUDIT1_kInvariantNeverDecreasesViaSwap`, `invariants/PairInvariants.t.sol::invariant_kGrowsByFeesOnly` |
| K-invariant check: `1000**2` written as `1000000`, balances taken as `postBalance*` locals — algebraically identical to V2 | C-01: raw reserves, no normalization | same as above + `test/FuzzInvariant.t.sol::invariant_kNeverDecreases` |
| LP token: OZ `ERC20("Tegridy LP","TGLP")` replaces `UniswapV2ERC20` (whole-file deletion hunk), **dropping EIP-2612 permit** | OZ's audited ERC20; permit deferred (AUDIT NOTE #65) — this is why the router has no `*WithPermit` variants | structural; permit absence re-checked by `check-interface-selectors.mjs` (no declared permit selector anywhere) |
| `Math.sqrt` (babylonian) → solmate `FixedPointMathLib.sqrt`; `UQ112x112` library → inline `Q112 = 2**112` in `_update` | Battle-tested replacements (V3/V4/Seaport lineage) | `AuditR014_Oracle.t.sol::test_R014_pair_cumulativeAdvancesOnUpdate`, `::test_R014_twap_uint256CumulativePreservesHighBits` (accumulator semantics incl. unchecked wrap) |
| `lock()` hand-rolled mutex → OZ `ReentrancyGuard`; `_safeTransfer(SELECTOR)` → OZ `SafeERC20` | Audited primitives over bespoke ones | `RedTeam_AMM.t.sol::test_ATTACK11_reentrancyOnPair` |
| Flash swaps deleted: `require(data.length == 0, "NO_FLASH_SWAPS")`, `IUniswapV2Callee` import gone | Callback-with-stale-reserves surface removed outright | `Audit195_Pair.t.sol::test_F6_swap_flashDataRejected`, `FinalAudit_AMM.t.sol::test_BONUS_flashSwapAlwaysRejected`, `RedTeam_AMM.t.sol::test_ATTACK11b_flashSwapDisabled` |
| `swap`/`burn` inverted to CEI: reserves written **before** outbound transfers; `swap` post-transfer `FOT_OUTPUT_0/1` `>=` balance checks | H-01/M-02: ERC-777-style callbacks must not read stale reserves; `>=` (not `==`) keeps donations/aggregator top-ups legal | `RedTeam_AMM.t.sol::test_ATTACK11_reentrancyOnPair`, K/killed-invariant suite above |
| First mint: `MIN_INITIAL_TOKENS` (≥1000 each), `rawLiquidity > MINIMUM_LIQUIDITY*1000`, lock to `0xdead` instead of `address(0)` | First-depositor inflation attack made uneconomic; OZ ERC20 forbids mint-to-zero | `TegridyPair.t.sol::test_firstDeposit_minimumLiquidity_lockedToDead`, `FinalAudit_AMM.t.sol::test_AUDIT2_minimumLiquidityCannotBeCircumvented`, `FuzzInvariant.t.sol::invariant_minimumLiquidityLocked` |
| `mint`/`burn` recipient guards (`INVALID_TO`: zero/self), `ReservesZeroPostRebase` typed revert, one-shot `initialize` with zero-addr check + `Initialize`/`Skim` events, public `blockTimestampLast` | NEW-A10 mint-to-pair drain footgun; F-31-E rebase divide-by-zero; L-04/H-16 indexer surfaces | pair unit suite (`TegridyPair.t.sol`, `AuditFixes_Pair.t.sol`) |

### D5. TegridyFactory — remaining named divergences

| Divergence | One-line rationale | Pinned by |
|---|---|---|
| CREATE2 salt `keccak256(abi.encode(chainid, this, token0, token1))` ≠ V2's `abi.encodePacked(token0, token1)`; deploy via `TegridyFactoryLib.deployPair` (delegatecall, EIP-170) | BATCH-L4 M2 cross-chain collision/squat hardening; **integration break** — standard V2 `pairFor` prediction computes the wrong address, which is why the router resolves via `getPair` (D6) | `test/TegridyFactory.t.sol` createPair suite; executor-identity reasoning at `TegridyFactoryLib.sol:21-26` |
| `createPair` hardening: `MAX_PAIRS` ceiling, `NOT_CONTRACT` + EIP-7702 (code length 23) reject, best-effort ERC-777 probe, `PAIR_EXISTS` kept | R064 spam ceiling; A4-M-10 callback-token filter (speed bump, not a security control) | `Audit195_Factory.t.sol` createPair findings suite |
| `isPair` registry + `allPairsPaginated` | R014 O(1) pair authenticity for the TWAP; paginated reads for indexers | `AuditR014_Oracle.t.sol::test_R014_factory_isPairRegistry` |
| Inherits `TimelockAdmin` + EnumerableSet pending-proposal tracking/flush | H-08/M1: setter rotation must not inherit or OOG on the old setter's queued proposals | `Audit195_Factory.t.sol::test_M1_acceptFeeToSetter_succeeds_with_pending_proposals` |
| `feeToSetter` rotation runs on its own storage slots, **not** through `TimelockAdmin._propose` (no `ProposalCancelled` emission) | Pre-TimelockAdmin storage kept for layout stability; audit §3.5 flags the monitoring asymmetry — remediation row 13 open, pinned as-is | `Audit195_Factory.t.sol::test_F15/F16/F17` setter lifecycle |

### D6. TegridyRouter — remaining named divergences

| Divergence | One-line rationale | Pinned by |
|---|---|---|
| **Anchored:** `quote`, `getAmountOut` (997/1000), `getAmountIn` (+1 rounding), `getAmountsOut/In`, `sortTokens`, `_swap` hop loop — line-for-line `UniswapV2Library` modulo 0.8 | The money math must be verbatim V2 | `Audit195_Router.t.sol::test_Finding8_GetAmountOut_OverflowReverts`, `TegridyPair.t.sol::test_swap_kInvariantHoldsAfterSwap`, K suite |
| `pairFor`: CREATE2 init-code-hash prediction → `factory.getPair` STATICCALL + `PairDisabled` revert | Salt divergence (D5) makes address prediction wrong by construction; lookup also decouples router from pair bytecode and inherits the circuit breaker on every hop | `Audit195_Router.t.sol::test_Finding16_DisabledPairSwapReverts` |
| `ensure()` adds `MAX_DEADLINE = 2 hours` upper bound | L-1/R016-M1: stale-order footgun; **documented integration break** for CoW/1inch/Safe/0x flows (NatSpec :44-67) | `Audit195_Router.t.sol::test_Finding7_DeadlineTooFar_Reverts`, `RedTeam_AMM.t.sol::test_ATTACK20_routerDeadlineLimits` |
| Dropped from Router02: all `*WithPermit` variants; `removeLiquidityETHSupportingFeeOnTransferTokens` | LP token has no permit (D4); the missing FoT-ETH exit is audit §3.6 / remediation row 15 — **open gap, pinned honestly** | permit: selector guard as in D4; FoT-ETH exit: none (tracked in row 15) |
| Added guards: zero/self/pair recipient rejection (H-09 incl. last-hop pair), `_validatePathNoCycles` O(n²) pre-check, `PathTooLong` (10), `IDENTICAL_CONSECUTIVE_TOKENS` | H5: cyclic paths stranded tokens mid-revert; H-09: output-to-pair donation | `Audit195_Router.t.sol` findings suite, `RedTeam_AMM.t.sol` attack suite |
| `addLiquidity*` atomic create-or-find (canonical Router02 shape restored 2026-05-30); `_addLiquidity` split into `_calculateLiquidity` (creation hoisted to caller) | H2 structural: no inter-tx gap to front-run the first mint | `Audit195_Router.t.sol` liquidity suite; `RedTeam_AMM.t.sol` first-mint attack coverage |
| ETH legs: `TransferHelper.safeTransferETH` → `WETHFallbackLib.safeTransferETHOrWrap`; `assert(IWETH.transfer)` → `require(..., "WETH_TRANSFER_FAILED")` | M-03: contract callers without `receive()` must not strand funds; L-08: no gas-eating asserts. WETHFallbackLib itself is audit §3.2 / row 3 — open | router ETH-refund tests in `Audit195_Router.t.sol` |
| `nonReentrant` on every entrypoint, `Swap`/`LiquidityAdded`/`LiquidityRemoved` events, custom errors, `receive()` gated `ONLY_WETH` | H-15 observability; gas; defence-in-depth | `AuditFixes_Pair.t.sol::test_router_hasNonReentrant` |

## Scope limits (what this gate does NOT check)

- **Imported bodies** (OZ ERC20/SafeERC20/ReentrancyGuard/EnumerableSet, solmate
  FixedPointMathLib, `TegridyFactoryLib`, `WETHFallbackLib`, `TimelockAdmin`): out of the three
  target files. OZ is a tracked file-copy and solmate/solady are pinned submodules with their own
  H-37 ritual; the base-contract files have their own audits.
- **Deployed bytecode vs source**: this gate proves source lineage; compile/deploy parity is the
  Contracts CI build + `VerifyMVP` deploy gate's job.
- `UniswapV2OracleLibrary.sol` is vendored + hash-pinned but not yet a diff target — it is the
  upstream for remediation row 8 (`SwapFeeRouterConvertLib` re-anchor). Add it to `TARGETS` when
  that lands.
