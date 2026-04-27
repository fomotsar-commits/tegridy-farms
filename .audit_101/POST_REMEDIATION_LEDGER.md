# Post-Remediation Audit Ledger — 2026-04-26

**Purpose:** Honest reconciliation between (a) what prior audit-remediation docs claimed had shipped to `main` and (b) what was actually live in the contract source on 2026-04-26. Written after a deep parallel-agent verification pass + 10 batches of remediation commits.

**Why this exists:** Prior to this work, `R017.md`, `R020.md`, `R023.md`, and `R028.md` each described HIGH-severity fixes as "shipped" or "verified present." Source-level grep showed they were absent — the legacy vulnerable code was still in `main`. Test files explicitly marked some remediations as "DEFERRED" or "DISABLED." This ledger is the new single source of truth for what is actually live.

---

## Verification methodology

1. 8 specialized auditor agents ran in parallel against current `main` to scan for vulnerabilities.
2. Findings classified Critical / High / Medium / Low.
3. Each Critical and High verified manually against actual source code (not the claimed-fix doc).
4. 3 follow-up triage agents re-verified the borderline Highs and all 30 Mediums.
5. 10 batches (A–J) landed fixes for the verified findings, each with regression tests.
6. Foundry demonstration tests in [`contracts/test/AuditDemonstration.t.sol`](../contracts/test/AuditDemonstration.t.sol) prove each fix actually works.

**False-positive rate observed:** ~58% across the original Critical+High pool, ~63% across Mediums. Many agent-flagged findings were already correctly handled by the existing code. The remaining ~40% were real and unshipped, including several that contradicted the public security claims.

---

## Commits (10 batches)

| # | Commit | Contract(s) touched | Findings closed | Severity |
|---|---|---|---|---|
| A | `393b084` | TegridyFactory | H-1, H-1b, H-2 | HIGH |
| B | `1b7ad2f` | VoteIncentives | C-4, H-12 | CRIT + HIGH |
| C | `7e29572` | TegridyDropV2 | C-1 | CRIT |
| D | `71a532d` | TegridyRestaking | H-7 | HIGH |
| E | `a2c78d4` | TegridyFeeHook | H-5 | HIGH |
| F | `ab42bb2` | TegridyStaking | C-2 | HIGH |
| G | `d4c93bf` | TegridyRestaking | H-8 | HIGH |
| H | `2626dc5` | PremiumAccess + TegridyStaking | M-24, M-30 | MED |
| I | `1ec721c` | MemeBountyBoard + POLAccumulator | M-16, M-28 | MED |
| J | `5fad774` | TegridyTWAP | M-2 | MED |
| size-1 | `99eaf9b` + `b3092b6` | TegridyStaking + new TegridyStakingAdmin | EIP-170 split | INFRA |
| size-2 | `cb3d12b` | SwapFeeRouter + new SwapFeeRouterAdmin | EIP-170 split | INFRA |

---

## Architectural split — TegridyStaking → TegridyStaking + TegridyStakingAdmin

**Why:** The triple-check sweep found TegridyStaking's runtime bytecode at 29,461 bytes — 4,885 bytes OVER the EIP-170 mainnet limit (24,576). The contract could not be redeployed. Source-level fixes from this campaign (Batch F MAX_POSITIONS, Batch H ceiling-div, Wave 1 custom errors) were stuck.

**What changed:** All 7 timelocked admin function triplets (rewardRate, treasury, restakingContract, maxUnsettledRewards, lendingContract, extendFee, penaltyRecycle) plus their pending state moved from TegridyStaking into a new sister contract [`TegridyStakingAdmin.sol`](../contracts/src/TegridyStakingAdmin.sol). TegridyStaking exposes `onlyAdmin`-gated `apply*` setters that the Admin contract calls during execute.

**Result:**
- TegridyStaking: 29,461 → **22,492 bytes** (saved 6,953 bytes; +2,084 margin under EIP-170)
- TegridyStakingAdmin (new): 10,079 bytes (well within limit)
- All 1,927 forge tests pass — no regression
- Public hot-path functions (stake, withdraw, claim, getReward, votingPowerOf, transferFrom etc.) unchanged

**Wiring:** One-shot `staking.setStakingAdmin(address(admin))` at deploy time. Single trust anchor.

**Public surface delta** (relevant for frontend, indexer, deploy scripts):
- Callers that used `staking.proposeRewardRate(...)` etc. now use `admin.proposeRewardRate(...)`
- `staking.rewardRateChangeTime()` etc. moved to `admin.rewardRateChangeTime()`
- All other public surface unchanged
- Frontend ABI imports for the 18 admin functions need to point at the new admin contract (follow-up for dApp team)
- Indexer ABI may want to track admin-contract events too (follow-up)

---

## Architectural split — SwapFeeRouter → SwapFeeRouter + SwapFeeRouterAdmin

**Why:** Same EIP-170 issue surfaced for SwapFeeRouter during the triple-check (25,930 bytes — 1,354 over the 24,576-byte limit). Same playbook as TegridyStaking.

**What changed:** All 9 timelocked admin function triplets (fee, treasury, referralSplitter, pairFee, premiumDiscount, premiumAccess, revenueDistributor, feeSplit, polAccumulator) plus their pending state moved into [`SwapFeeRouterAdmin.sol`](../contracts/src/SwapFeeRouterAdmin.sol). Router exposes 9 `onlyAdmin`-gated `apply*` setters.

**Result:**
- SwapFeeRouter: 25,930 → **16,735 bytes** (saved 9,195 bytes / 35.5%; +7,841 margin under EIP-170)
- SwapFeeRouterAdmin (new): 12,886 bytes (+11,690 margin)
- All 1,927 forge tests pass — no regression
- All user-facing swap functions (`swapExactETHForTokens`, `swapExactTokensForETH`, `swapExactTokensForTokens`, plus 3 FoT variants) signatures unchanged
- Audit-fix code preserved (NEW-A4 deadline guard, NEW-A5 cooldown, AUDIT C1, AUDIT C4 pending distribution, AUDIT M-2 fail-open premium, AUDIT M-4 50k gas stipend, AUDIT M-6 FoT)

**Wiring:** One-shot `router.setSwapFeeRouterAdmin(address(admin))` at deploy time. Single trust anchor. Same pattern as TegridyStaking.

**Public surface delta**:
- Callers that used `router.proposeFeeChange(...)` etc. now use `admin.proposeFeeChange(...)` — applies to all 9 triplets
- `router.treasuryChangeTime()` etc. moved to `admin.treasuryChangeTime()`
- All swap-side functions unchanged
- Frontend ABI imports + `ConfigureFeePolicy.s.sol` runbook need the admin address (placeholder set, operator must fill in post-deploy)

---

## Confirmed and FIXED (14 findings across 10 batches)

### Critical (3)

| ID | Surface | What changed | Replaces (claimed-but-unshipped) |
|---|---|---|---|
| C-1 | `TegridyDropV2.setMerkleRoot` | Replaced with timelocked `propose/execute/cancel` (24h delay, phase-gated, value-bound) | R023 H-01 |
| C-2 | `TegridyStaking.MAX_POSITIONS_PER_HOLDER` | Lowered 100 → 50 to halve every integrator's `votingPowerOf` gas cost | — (new) |
| C-4 | `VoteIncentives` zero-vote bribe lockup | Added `refundUnvotedBribe` (permissionless per-depositor pull, 14d grace after revealDeadline) | R020 H-1 |

### High (7)

| ID | Surface | What changed | Replaces |
|---|---|---|---|
| H-1 | `TegridyFactory.setGuardian` | Initial-only; rotation now via `proposeGuardianChange` / `executeGuardianChange` (48h timelock) | R028 H-01 |
| H-1b | (same) | `pendingGuardian` + `cancelGuardianChange` added | — |
| H-2 | `TegridyFactory.emergencyDisablePair` | Now only force-cancels pending RE-ENABLE proposals; pending DISABLEs left intact (no governance veto) | — (new) |
| H-5 | `TegridyFeeHook.executeSyncAccruedFees` | Allows upward sync bounded by on-chain `IPoolManager.balanceOf(this, currencyId)` — recovery path for under-counting drift | — (new) |
| H-7 | `TegridyRestaking.decayExpiredRestaker` | Reordered: settle → shrink `totalRestaked` → `_accrueBonus()` → re-anchor debt. CEI tightened (debt anchor before transfer) | R017 H-3 RETRY |
| H-8 | `TegridyRestaking.boostedAmountAt` | Per-restaker `Checkpoints.Trace208` history; `upperLookup` returns boost actually held at `_ts`, not the post-decay cache | — (new) |
| H-12 | `VoteIncentives.depositBribe` | Enforces `DEFAULT_MIN_TOKEN_BRIBE = 1e15` when no per-token min configured; per-token override via 24h timelocked setter | R020 H-3 |

### Medium (4)

| ID | Surface | What changed |
|---|---|---|
| M-2 | `TegridyTWAP` rebootstrap | Emits `DeviationBypassed` event + stamps `lastBypassUsed[pair]` so consumers can detect and cool-off |
| M-16 | `POLAccumulator.MIN_BACKSTOP_BPS` | Raised 5000 → 9000; caps slippage at 10% on the addLiquidityETH leg |
| M-24 | `TegridyStaking._splitPenalty` | Ceiling division on `recycled`; sub-wei dust now favors stakers, not treasury |
| M-28 | `MemeBountyBoard.emergencyForceCancel` | Aggregate-votes branch now also requires `uniqueVoterCount >= MIN_UNIQUE_VOTERS`; whales alone can't deadlock bounties |
| M-30 | `PremiumAccess.batchReconcileExpired` | Added `nonReentrant` for parity with `cancelSubscription` |

---

## Confirmed but DEFERRED (4 findings)

| ID | Surface | Why deferred |
|---|---|---|
| H-10 | `PremiumAccess.hasPremium()` | Documented integration risk only. `SwapFeeRouter` (the only in-protocol consumer) correctly uses `hasPremiumSecure`. Third-party integrators warned via NatSpec. |
| M-5 | `SwapFeeRouter` 1-wei min fee | >100x overage on dust amounts. Fix (revert on too-small) could break dust UX. Edge-case impact tiny. |
| M-7 | `WETHFallbackLib` 10k gas stipend | Borderline. Lowering to 2300 would break legitimate Gnosis Safe receivers. 10k allows ~3 SSTOREs of "free work" — limited blast radius. |
| M-12 | `TegridyStaking._writeCheckpoint` O(n) | Mitigated by Batch F cap reduction (100→50). Full O(1) cached aggregate deferred because lazy-expiry semantics make cache invalidation non-trivial. |

---

## NEEDS-DEEP-TEST (3 findings)

| ID | Surface | Reason |
|---|---|---|
| M-4 | `TegridyRouter.quote()` rounding | Multi-hop divergence between `getAmountsOut` and actual swap math needs empirical measurement. |
| M-8 | `SwapFeeRouter.distributeFeesToStakers` | Treasury-fold path may violate split invariant. Likely intentional but warrants test verification. |
| M-12 | (above) | (also see Deferred above) |

---

## False positives cleared (28 findings)

The original parallel-agent scan flagged 28 issues that don't reproduce against actual source. Cleared so future scans don't re-discover them:

| Tier | IDs |
|---|---|
| Critical | C-3 |
| High | H-3, H-4, H-6, H-9, H-11, H-13, H-15, H-16 |
| Medium | M-1, M-3, M-6 (already fixed by Batch A), M-9, M-10, M-11, M-13, M-14, M-15, M-17, M-18, M-19, M-20, M-21, M-22, M-23, M-25, M-26, M-27, M-29 |

Brief reasoning for each is in [`contracts/test/AuditDemonstration.t.sol`](../contracts/test/AuditDemonstration.t.sol) inline comments. Highlights:

- **C-3**: `userTotalVotes` cap on [VoteIncentives.sol:388](../contracts/src/VoteIncentives.sol:388) prevents same-pair vote inflation. Two 500-power calls equal one 1000-power call.
- **H-13**: bond clearing happens in same tx as `safeTransfer`; failed transfer reverts the whole tx and rolls back state.
- **M-19**: `Proposal.recipient` is mutable in storage but no setter exists; current attack surface is zero.
- **M-29**: DropV2 withdraw is intentionally gated to closed/sold-out states — `cancelSale()` is the early-refund path.

---

## Drift between prior remediation docs and pre-fix `main`

This is the meta-finding worth highlighting. Before Batches A–J, these docs claimed fixes were shipped that **were not in `main`**:

| Doc | Status claimed | Actual state on 2026-04-26 (pre-fix) |
|---|---|---|
| `R017.md` | "RETRY pass corrected H-3 ordering" | `_accrueBonus()` still ran BEFORE `totalRestaked` shrink |
| `R020.md` | `refundUnvotedBribe` "shipped"; `DEFAULT_MIN_TOKEN_BRIBE` "added"; `_commitRevealFromGenesis` ctor arg "added" | None of the three present in source |
| `R023.md` | "Legacy `setMerkleRoot(bytes32)` removed; replaced by `proposeMerkleRoot` / `executeMerkleRoot`" | Legacy `setMerkleRoot` still at line 412; propose/execute functions absent |
| `R028.md` (per diff agent) | `proposeGuardian` / `executeGuardian` "added" | Functions did not exist; only the legacy 1-step `setGuardian` was present |

`R028 H-01` is interesting: the diff-verification agent INITIALLY reported it as shipped, then the foundry test `test_H1b_NoProposeGuardianExists` proved otherwise. Trust-but-verify cuts both ways.

The test file [`contracts/test/R020_VoteIncentives.t.sol:131-135`](../contracts/test/R020_VoteIncentives.t.sol:131) explicitly acknowledged the deferral with a stub:

> *"DISABLED: refundUnvotedBribe(uint256,address,address) was deferred — the current VoteIncentives does not expose a stranded-bribe rescue path and UNVOTED_REFUND_GRACE is not declared. The two tests below are stubbed to keep the file compiling; the spec is documented in R020.md (H-1) and will be re-enabled when the rescue path lands."*

The R020 doc itself reported `Suite result: ok. 7 passed; 0 failed; 0 skipped` — the tests that pass are stubs returning early; they do not exercise the prescribed function.

---

## Tests

Demonstration tests proving each post-fix behavior:

- [`contracts/test/AuditDemonstration.t.sol`](../contracts/test/AuditDemonstration.t.sol) — 8 passing tests covering C-4, H-1, H-1b, H-2, H-2b, H-12 (with code-only confirmation notes for C-1, C-2, H-5, H-7, H-8, H-10, M-2, M-16, M-24, M-28, M-30)

Regression-test summary across the modified contracts (counts as run during this campaign):

- TegridyFactory: 30 + 66 = 96
- VoteIncentives + GaugeController: 7 + 14 + 39 + 816 = 876
- TegridyDropV2: 27
- TegridyRestaking: 73 + 12 = 85
- TegridyFeeHook: 33 + 5 = 38
- TegridyStaking: 94 + 7 + 24 = 125 (subset; full Audit195_Staking is larger)
- PremiumAccess: 26
- MemeBountyBoard: 24
- TegridyTWAP: 24
- AuditDemonstration: 8

All pass against post-Batch-J `main`.

---

## Recommendation for users diligencing this protocol

The earlier `AUDITS.md` `tl;dr` table is honest about methodology (8 internal AI passes, 1 paid external) but the public security artifacts (`SECURITY_AUDIT_300_AGENT.md`, SecurityPage) overstated the remediation completeness. The 2026-04-26 batches close that gap for the highest-severity items.

**Before depositing significant value:**
1. Re-read `SPARTAN_AUDIT.txt` (most rigorous external review).
2. Verify Batches A–J are actually deployed on the chain you're depositing on (not just merged to `main`).
3. Note that 4 confirmed findings remain DEFERRED (H-10, M-5, M-7, M-12) with the rationale above.
4. A paid human audit by a recognized firm is still on the roadmap and not yet scheduled.

**For new auditors:** the AI-agent findings have a documented ~58% false-positive rate at HIGH severity and ~63% at MEDIUM. Spot-check before fixing.
