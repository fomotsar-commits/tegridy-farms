# Slither Triage — mvp-launch (2026-05-23)

Run command: `slither . --config-file slither.config.json` (from `contracts/`).
Tool: Slither 0.11.5 + crytic-compile 0.3.11. Config: `contracts/slither.config.json`.

## Summary

```
Total findings: 97
By impact:
  High:          0
  Medium:        0
  Low:          96
  Informational: 1
```

| Detector | Count | Verdict |
|---|--:|---|
| `reentrancy-benign`    | 39 | accepted pattern — all entry-points guarded |
| `calls-loop`           | 36 | accepted pattern — all loops bounded |
| `reentrancy-events`    | 11 | accepted pattern — events after guarded ext-calls |
| `missing-zero-check`   |  6 | accepted pattern — intentional sentinels or implicit checks |
| `events-maths`         |  4 | accepted pattern — events emitted at admin-layer wrapper |
| `boolean-equal`        |  1 | accepted style — intentional, audit-commented |

**0 code patches required.** Each class is documented below with the verification trail.

## Per-class verification

### reentrancy-benign (39) + reentrancy-events (11) — accepted

Cross-checked every flagged function for guard coverage:

| Guard | Count |
|---|--:|
| `nonReentrant` directly on flagged function | 23 |
| `onlyOwner` / `onlyAdmin` / `onlyStaking` / `onlyPauseGuardian` | 9 |
| Implementation has `nonReentrant whenNotPaused` (Slither matched the interface decl) | 4 |
| Internal helper; all callers `nonReentrant` | 13 |
| V2-standard `createPair` init pattern (external call into trusted CREATE2'd pair) | 1 |

Concretely verified:

- `SwapFeeRouter.swapExact{ETH,Tokens}For{ETH,Tokens}*` impls at lines 739/876/942/1004 all carry `nonReentrant whenNotPaused`. The 4 "unguarded" matches were Slither folding interface declarations (lines 16/23/29/36) into the warning text.
- `TegridyRestaking._sweepUnforwardedBonus` callers: `claimPendingBonusPayout`, `claimAll`, `unrestake`, `claimPendingUnsettled`, `emergencyForceReturn`, `emergencyWithdrawNFT`, `recoverStuckPrincipal` — all `external nonReentrant`.
- `TegridyStaking._clearPosition` callers: `withdraw`, `earlyWithdraw`, `executeEmergencyExit`, `emergencyExitPosition`, `emergencyWithdrawPosition` — all `external nonReentrant`.
- `TegridyStakingJbacVault.returnJbac` carries `onlyStaking` (caller is TegridyStaking, itself `nonReentrant`).
- `TegridyFactory.createPair`: V2-standard, the external call is `IUniswapV2Pair(pair).initialize()` on a brand-new CREATE2'd contract of known bytecode. No funds at risk; not reentrancy-exploitable.

The 11 `reentrancy-events` findings are all "event emitted after external call" — cosmetic ordering, not exploitable when the call site is `nonReentrant`-guarded (which they all are).

### calls-loop (36) — accepted, all loops bounded

| Source | Findings | Bound |
|---|--:|---|
| `TegridyRouter._swap` / `_swapSupportingFeeOnTransferTokens` / `_pairFor` | 27 | User-supplied `path[]` length (V2 standard, gas-economically bounded ≈ 20 hops) |
| `RevenueDistributor._pendingETH` / `_calculateClaim` / `_restakedPowerAt` | 8 | `MAX_VIEW_EPOCHS` = `MAX_CLAIM_EPOCHS` = 250 (R064-pinned, see `test/R064_PaginationBounds.t.sol::test_MAX_CLAIM_EPOCHS_is_250`). `_restakedPowerAt` additionally caps the external call gas at 50 000 wei (F-50-8 fix). |
| `TegridyFactory.allPairsPaginated` window iteration | 1 | `MAX_PAIRS` = 10 000 (R064 ceiling) + paginated window |

### missing-zero-check (6) — accepted

| Site | Line | Verdict |
|---|--:|---|
| `POLAccumulator` constructor `_sequencerFeed` | 259 | **R062**: `address(0)` permitted for mainnet/non-L2 deployments (disables Chainlink L2 Sequencer Uptime gate). Inline comment at line 286. |
| `TegridyTWAP` constructor `_sequencerFeed` | 301 | **R062**: same — inline comment at line 304. |
| `SwapFeeRouterAdmin.proposeReferralSplitterChange` | 186 | `// address(0) allowed to disable` (inline at line 187). |
| `SwapFeeRouterAdmin.proposePremiumAccessChange` | 316 | `// address(0) allowed to disable` (inline at line 317). |
| `SwapFeeRouterAdmin.proposePolAccumulator` | 402 | `// Zero address allowed — re-routes POL slice to treasury without changing BPS` (inline at line 403). |
| `TegridyFactory.setGuardian` | 575 | Implicit zero-check: `require(codeLen > 0 && codeLen != 23, "GUARDIAN_NOT_MULTISIG")` at line 584 — `address(0)` has code length 0, so the require fails. Defense-in-depth via the contract-only multisig gate. |

Sanity check that the codebase does enforce zero-checks where they matter: `SwapFeeRouterAdmin.proposeRevenueDistributor` at line 343 has `if (_newDistributor == address(0)) revert ZeroAddress()` — explicit per-field decisions, not an oversight.

### events-maths (4) — accepted (events at admin layer)

All 4 sites are `onlyAdmin` setters in `TegridyStaking` (`applyExtendFee`, `applyExtendFeeRecycle`, `applyPenaltyRecycle`, `applyMaxUnsettledRewards`). The callers in `TegridyStakingAdmin.execute*Change()` emit the canonical `*Executed` events right after invoking the apply path (cf. `executeRewardRateChange` at line 141, `executeTreasuryChange` at line 166, etc.). Duplicating events at the apply layer would create off-chain noise without adding audit-trail signal.

### boolean-equal (1) — accepted

`TegridyFactory.emergencyDisablePair` at line 681:

```solidity
// H-2: only cancel pending RE-ENABLEs (false), leave pending DISABLEs (true) alone.
if (_executeAfter[key] != 0 && pendingPairDisableValue[pair] == false) {
```

The explicit `== false` documents the intent of the H-2 audit fix (distinguishing pending RE-ENABLE from pending DISABLE). Refactoring to `!pendingPairDisableValue[pair]` would obscure the audit-trail comment-to-code link.

## Re-running

```bash
cd contracts
export PATH="$HOME/.local/bin:$HOME/AppData/Roaming/Python/Python312/Scripts:$PATH"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1   # Windows: keeps Slither's Unicode output decodable
slither . --config-file slither.config.json
# Outputs: slither-report.json + slither-report.sarif (both gitignored)
```

`slither.config.json` schema notes (fixed alongside this triage):
- `detectors_to_run` / `detectors_to_exclude` must be **comma-separated strings**, not JSON arrays — Slither calls `.split(",")` on them.
- `fail_high` / `fail_medium` / `fail_pedantic` / `fail_low` are **not valid Slither config keys** — they were silently ignored on the prior (broken) version. Severity gating in CI should be done by `jq`-grepping `slither-report.json` for `impact == "High" or "Medium"`.

## Refresh policy

Re-run on every PR that touches `contracts/src/**`. If new H/M findings appear, triage them in a follow-up commit before merge. This document covers the `mvp-launch` snapshot at `0693e4f` (post Echidna harness fix).
