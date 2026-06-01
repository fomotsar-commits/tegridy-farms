# Auditor Handoff Package — Tegridy Farms MVP

> Master index for the audit engagement. Start here. Every section either has
> the answer or points at the canonical document that does.

## 0. At-a-glance

| | |
|---|---|
| **Branch** | `mvp-launch` |
| **Snapshot commit** | `3285f40` (run `git log mvp-launch -5` for fresher tip) |
| **Doc last refreshed** | 2026-05-25 |
| **Codebase size in scope** | 15 contracts, ~13k LoC of Solidity 0.8.26 |
| **Compiler / toolchain** | solc 0.8.26, foundry, via_ir=true, optimizer_runs=200, evm_version=cancun, code_size_limit=24576 |
| **Build & test** | `cd contracts && forge build --skip test --skip script && forge test` |
| **Sponsor contact** | _[USER TO FILL: name, email, Signal/TG, response-time SLA]_ |
| **Engagement targets** | Spearbit (via Cantina) + Sherlock contest + Certora FV |
| **Engagement window** | _[USER TO FILL: start date — code-freeze date — auditor-questions-cutoff — report-due date]_ |
| **Deployment plan** | Phase 6 launch behind TVL cap with `PAUSE_GUARDIAN`. Multisig formation: 3 disjoint signer sets — 4-of-7 TREASURY cold, 4-of-7 MULTISIG cold (different signers), 3-of-5 PAUSE_GUARDIAN hot. Hardware-only. See `TRUST_ASSUMPTIONS_MVP.md`. |

---

## 0a. Updates since snapshot `d01a2ae`

25 security commits have landed on `mvp-launch` between `d01a2ae` and the
current tip `3285f40` (run `git log d01a2ae..mvp-launch --oneline` for the
full list). Highlights, grouped by audit ID:

- **C1 (EIP-170 contract-size launch-blocker)** — `TegridyStaking` split into
  `StakingViewLib` + `StakingRewardLib`; extend-fee + penalty-recycle systems
  deferred to a separate contract; `TegridyRestaking` deferred to Phase 7
  (also resolves H2). Commits `1fe4f0d`, `3524f6b`, `d722aaf`, `7d6a8f8`.
- **H1 RevenueDistributor** — `autoReconcileDust` permissionless premature
  forfeiture fixed via a 180-day horizon + funds-based recovery gate +
  `claimUnsettled` tracked-holder guard + `earned()` pool-cap + L2 sequencer
  sentinel; cursor-advance bug fix. Commits `aedf980`, `e7e0557`, `f433129`.
- **M-series** — M1 ReferralSplitter banned-forfeit (`aedf980`), M2 delete
  unsafe `reconcileRoundingDust` (`f28624a`), M3/M4/M5 indexer hardening
  (`1a702df`), M6 rotate factory guardian off the deployer EOA (`17293d0`),
  M8 deploy-script wrapper (`1edd9f0`), M19-PORT `acceptOwnership` flush
  ported across all timelock-bearing contracts (`edd01f2`, `e91eac5`).
- **L-series** — L1 per-tokenId shortfall attribution (`ea7ffe6`), L5 TWAP
  deviation baseline preserved across outage bypass (`d4e08a2`), L6
  `POL.executeSweepETH` WETH fallback (`d4e7164`), L7 dead backstop machinery
  removed (`433bb0e`).
- **TWAP base** — `TegridyTWAP` now uses standard `OwnableNoRenounce` instead
  of a bespoke `TWAPAdmin`; bonus-token deploy invariant codified
  (`17406ff`).
- **Frontend `/api` hardening (not in the 15-contract scope but worth
  noting)** — preview-env open-proxy gate closed in `aggregator-proxy` +
  `ratelimit`; orderbook now requires Seaport order hash on create; opensea
  reads bounded and error logs scrubbed (`3285f40`).

The 2026-05-25 deep line-by-line re-audit found ONE additional exploitable
issue (the `autoReconcileDust` HIGH above, now patched); a 2nd-pass with
seven cross-cutting agents (reentrancy / access-control / arithmetic /
economic-MEV-oracle / reward-attribution-triangle / regression-of-the-diff /
DoS-token-handling) found no new unprivileged Critical/High.

---

## 1. In-scope contracts (15)

Defined in `DeployMVP.s.sol` (the canonical deploy script). All under `src/`:

```
Toweli                        (ERC20 + Permit, ownerless, fixed supply)
TegridyFactory                (V2 fork — pair registry, guardian emergency disable)
TegridyPair                   (V2 fork — k-invariant AMM, MINIMUM_LIQUIDITY locked to 0xdead)
TegridyRouter                 (V2 fork — swap/liquidity entry-point)
TegridyTWAP                   (per-pair cumulative oracle + L2 sequencer gate)
TegridyStaking                (TOWELI staking, position NFTs, rewards, stake caps)
TegridyStakingJbacVault       (JBAC NFT escrow, callable only by TegridyStaking)
TegridyStakingAdmin           (timelock wrapper over TegridyStaking governance)
TegridyRestaking              (boost-NFT escrow, deployed paused at Phase 7.0)
RevenueDistributor            (epoch ETH distribution, paginated claim, grace period)
ReferralSplitter              (swap-fee referral splitter)
SwapFeeRouter                 (router-level swap fee with referral + POL split)
SwapFeeRouterAdmin            (timelock wrapper over SwapFeeRouter governance)
POLAccumulator                (protocol-owned-liquidity buy-and-lock)
TegridyTokenURIReader         (off-chain rendering helper, view-only)
```

Plus three base/lib contracts pulled in by the above:
- `base/PauseGuardian.sol` — guardian-pause role (Aave V3 / Lido GateSeal pattern)
- `base/OwnableNoRenounce.sol` — 2-step ownership with 14-day pending-owner expiry
- `base/TimelockAdmin.sol` — timelocked propose/execute base for the *Admin contracts

## 2. Out-of-scope contracts

The following are off the `mvp-launch` branch and **NOT** part of this engagement:

```
CommunityGrants, GaugeController, MemeBountyBoard, PremiumAccess,
TegridyDropV2, TegridyFeeHook, TegridyLPFarming, TegridyLaunchpadV2,
TegridyLending, TegridyLendingAdmin, TegridyNFTLending, TegridyNFTPool,
TegridyNFTPoolFactory, VoteIncentives, VoteIncentivesAdmin
```

These were either Wave-2 deferrals or required separate hardening passes.
`SwapFeeRouter.sol:639` keeps a `PremiumAccess` null-safe fail-open path so
re-enabling it later doesn't require an SFR upgrade. Other deferred contracts
have **zero live-code dependencies** from MVP — verified via grep sweep.

## 3. Documentation index — read in this order

1. **`contracts/TRUST_ASSUMPTIONS_MVP.md`** — 259 lines, per-contract trust model + 6 cross-cutting assumptions. **Read this first.** Saves the auditor a billable week.
2. **`contracts/AUDIT_SLITHER_TRIAGE.md`** — Slither 0.11.5 result (0 H, 0 M, 96 Low, 1 Info) + per-class verification trail. All 97 findings classified as accepted patterns with code:line evidence.
3. **`contracts/AUDIT_HALMOS_RESULTS.md`** — Halmos 0.3.3 symbolic execution result (5/6 proven over 214/236/253 paths; 1 spurious failure under generic storage layout, root-caused).
4. **Repo-root `AUDITS.md`** — running ledger of all prior audit engagements / multi-agent passes.
5. **Repo-root `AUDIT_FINDINGS_2026_05_16.md`** — latest deep-attacker-pass findings (658 lines). Most are already fixed and closed via PRs `#28`, `#50`, `#51`, `#53`, `#54`, `#55`, `#57`, `#58`. See `git log mvp-launch -- src/` for the patch trail.
6. **Repo-root `DEPLOY_RUNBOOK.md`** + **`RELAUNCH_RUNBOOK.md`** + **`DEPLOY_CHEAT_SHEET.md`** — Phase-by-phase deploy procedure including multisig wiring and the verify-against-INV-1-through-INV-10 gate.

## 4. Tooling already run (summary)

| Tool | Version | Run on | Result | Doc |
|---|---|---|---|---|
| Slither | 0.11.5 | `src/` | 0 High, 0 Medium, 96 Low, 1 Info — all triaged as accepted patterns | `AUDIT_SLITHER_TRIAGE.md` |
| Halmos | 0.3.3 | `test/halmos/MVPLaunch_HalmosSpecs.t.sol` | 5/6 properties proven symbolically (214/236/253 paths); 1 spurious FAIL (tool limitation, not bug) | `AUDIT_HALMOS_RESULTS.md` |
| Echidna | 2.3.2 | `test/echidna/MVPLaunch_AMMEchidna.t.sol` | 24h campaign in progress (TegridyPair k-invariant + reserves-LE-balances + MINIMUM_LIQUIDITY locked). 53M+ random sequences, 0 falsified at handoff time. Persisted corpus in `contracts/echidna-corpus/` (gitignored) | `contracts/echidna.config.yml` |
| Foundry invariants | (forge stable) | `test/invariants/MVPLaunch_*Invariants.t.sol` | 3/3 cross-contract reward-triangle invariants pass at 256 runs × 500 calls = 128k action sequences. INV-PERTOKEN-LE-HOLDER catches the C-1 class | `798b7a4` commit body |
| Concrete tests | forge | `test/**/*.t.sol` | **1487 / 1487 passing** as of `3285f40` (81 test suites, ~5.6 min wall time) — incl. 27/27 in `MVPLaunch_StakeCapsAndGuardian.t.sol`. Lower than the `d01a2ae` snapshot's 2614 because Wave-2 contracts + their tests were excised in the 15-of-30 MVP cut (see §2). | `git log mvp-launch` |
| Aderyn | 0.6.8 | **NOT RUN** | Cyfrin/aderyn has no Windows binary on v0.6.8. Recommended re-run on Linux/macOS host before audit start. | _[USER ACTION ITEM]_ |
| Mythril | — | **NOT RUN** | _[USER ACTION ITEM]_ — slow but worth a single overnight pass against `src/` on a Linux box. |

## 5. Threat model — load-bearing assumptions

Quoted verbatim from `TRUST_ASSUMPTIONS_MVP.md §Cross-cutting`:

1. **Three-multisig diversity**: TREASURY ≠ MULTISIG ≠ PAUSE_GUARDIAN. Enforced address-level at deploy via `DeployMVP.s.sol`. Signer-set diversity is operational and must be enforced by signers themselves (hardware vendor, jurisdiction, key storage).
2. **MULTISIG accepts ownership within 14 days**. `OwnableNoRenounce` enforces the expiry; `VerifyMVP.s.sol` `INV-2` fails loud if not accepted in time.
3. **No pair below 10 ETH reserve floor whitelisted for sensitive consumers** (lending / POL slippage). Operator policy.
4. **TOWELI is a standard ERC20 without callbacks** (no ERC-777/1363). Adding callbacks regresses every consumer.
5. **Compiler version pinned to Solidity 0.8.26**. Bumps to 0.8.27+ require full re-audit.
6. **Optimizer settings**: runs=200, via_ir=true, cancun. Changes to these change bytecode and require re-audit.

## 6. Known issues / known-acceptable patterns

For each, the verification trail is in the linked doc — auditors should sanity-check the trail and flag if they disagree.

| Pattern | Where | Why accepted | Trail |
|---|---|---|---|
| `address(0)` sentinel on sequencer-feed inputs | POLAccumulator/TegridyTWAP constructors | R062: disables L2 sequencer gating for mainnet/non-L2 deployments | `AUDIT_SLITHER_TRIAGE.md §missing-zero-check` |
| `address(0)` sentinel on referral/premium/POL splitter setters | SwapFeeRouterAdmin propose* | Allows disabling the optional component without changing BPS | `AUDIT_SLITHER_TRIAGE.md §missing-zero-check` |
| MINIMUM_LIQUIDITY locked at `0xdead` not `address(0)` | TegridyPair:169 | Defensive against ERC20 transfer-to-zero edge cases | `src/TegridyPair.sol` audit comment in-place |
| `external call` then `event` in nonReentrant function | 11 sites | Cosmetic event ordering; nonReentrant prevents reentry | `AUDIT_SLITHER_TRIAGE.md §reentrancy-events` |
| Bounded loops over user-controlled `path[]` | TegridyRouter._swap* | V2 standard, gas-economically bounded ~20 hops | `AUDIT_SLITHER_TRIAGE.md §calls-loop` |
| `MAX_CLAIM_EPOCHS = MAX_VIEW_EPOCHS = 250` | RevenueDistributor | R064-pinned. Pagination cap. Test enforced. | `test/R064_PaginationBounds.t.sol` |
| `MAX_PAIRS = 10_000` | TegridyFactory | R064-pinned. Test enforced. | `test/R064_PaginationBounds.t.sol` |
| `code.length` EOA-rejection on multisig setters | TegridyFactory.setGuardian + propose* | Defense against EIP-7702 delegated EOAs (which have non-zero code) — rejects `codeLen == 0 || codeLen == 23` | `src/TegridyFactory.sol:583-584` |
| Stake caps `maxStakePerUser`, `maxTotalStaked` enforced | TegridyStaking | Aave V3 supply-cap pattern. Constructor defaults `type(uint256).max`; DeployMVP sets launch values (50k per user, 5M global) | `MVPLaunch_StakeCapsAndGuardian.t.sol` (27/27 green) |

## 7. Reproduction commands

```bash
# Clone & build
git clone <repo>
git checkout mvp-launch
cd contracts
forge build --skip test --skip script

# Full test suite (modulo Invariant/Fuzz — those run on the nightly cron)
forge test --no-match-test "(Invariant|invariant|Fuzz|fuzz|testFuzz)"

# Slither
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1   # Windows only
slither . --config-file slither.config.json

# Halmos
export HALMOS_ALLOW_DOWNLOAD=1
halmos --match-contract MVPLaunch_HalmosSpecs \
       --solver-timeout-assertion 10000 \
       --storage-layout generic

# Echidna (24h campaign)
echidna test/echidna/MVPLaunch_AMMEchidna.t.sol \
        --contract MVPLaunch_AMMEchidna \
        --config echidna.config.yml \
        --timeout 86400 --test-limit 1000000000

# Foundry invariants (cross-contract reward triangle, 128k action seqs)
forge test --match-path "test/invariants/MVPLaunch_*Invariants.t.sol"
```

## 8. Deployment + roles (what auditors should know about the launch shape)

- `DeployMVP.s.sol` is the canonical deployment script. It requires env vars `TREASURY`, `MULTISIG`, `PAUSE_GUARDIAN` and **fails loud** at deploy if any two are equal.
- After deploy, `VerifyMVP.s.sol` enforces 10 post-deploy invariants (`INV-1` ... `INV-10`) including: ownership transferred, one-shot setters wired, pauseGuardian wired on all 5 contracts that have it, stake caps non-zero, TegridyRestaking paused at launch, JBAC vault bound, TWAP factory set, pair set, guardian disjoint from owner.
- TegridyRestaking ships **paused** at Phase 6 launch. Owner unpause-only.
- Phase 7.0 unpauses restaking after TVL milestones; out-of-scope for this engagement.

## 9. What we want auditors to look at hardest

In rough priority (per the threat priority map mentioned in user memory `project_threat_priority_map.md` and the most-recent attacker-pass `AUDIT_FINDINGS_2026_05_16.md`):

1. **AMM core**: TegridyPair k-invariant under fee-on-transfer, mint-without-mint, swap-without-input edge cases. Echidna covers this; humans should review.
2. **RevenueDistributor claim path**: cross-source attribution (staking + restaking), grace-period boundary conditions, per-epoch claimed-cap. The FRESH-2026 ex-restaker fix is the most recent invariant change here.
3. **TegridyStaking penalty + reward accounting**: `_splitPenalty` rounding, `_creditRewardPool` zero-stake fallback, recycle-bps composition. Ceiling-vs-floor rounding is intentional and documented.
4. **OwnableNoRenounce 2-step**: 14-day expiry window. INV-2 gate.
5. **Timelock surfaces**: every propose+execute pair on the *Admin contracts. SAME_VALUE / SAME_SETTER guards.
6. **PauseGuardian role separation**: guardian can pause but not unpause; owner can rotate guardian instantly. Halmos `check_pauseAuth` proves the negative for unauthorized callers.

## 10. Out-of-scope / deferred / parking lot

- **TegridyFeeHook (Uniswap V4)**: deferred to next wave. Would require clean redeploy from a non-Arachnid address.
- **Forta + OpenZeppelin Defender Sentinels**: monitoring infrastructure, off-chain — out of code scope.
- **Multisig formation operational details**: hardware vendor selection, jurisdiction, key recovery procedure — out of code scope.
- **Aderyn second-opinion run**: pending a Linux/macOS host (no Windows binary). _[USER ACTION ITEM]_

## 11. Auditor logistics — sponsor to fill in before kickoff

- **Engagement window**: _[start — code-freeze — questions-cutoff — report-due]_
- **Primary contact**: _[name + multiple-channel + response-time SLA]_
- **Escalation contact**: _[backup name + channel]_
- **Shared Slack / Telegram / Signal channel**: _[invite link]_
- **Bug report template**: severity scale, reproducer format, expected response time
- **Bounty / contest pricing**: _[per-finding $ tier breakdown, max payout, exclusivity rules]_
- **Disclosure policy**: _[embargo window after report delivery before public]_

## 12. Glossary

- **Tier A/B/C**: composite exploit-impact ranking per contract (from `project_threat_priority_map.md`).
- **Wave-2**: contracts deferred from MVP launch (lending, gauges, NFT pools etc).
- **MVP cut**: the 15-of-30 contract subset on `mvp-launch`. See §1.
- **FRESH-2026**: the 2026-05-18 deep-attacker-pass audit batch that closed 21 findings via PR `#50`.
- **R-prefixed checks**: rolling bulletproofing review series (R014, R028, R062, R064, ...). Audit commit messages reference these.
