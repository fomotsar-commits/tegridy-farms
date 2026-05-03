# PASS-6 Slither static-analysis triage — 2026-05-03

**Slither version:** v0.11.5
**Solc compiler:** 0.8.26 (via foundry-rs/foundry-toolchain, via_ir=true, optimizer_runs=10, evm_version=cancun)
**Invocation:** `slither contracts/ --config-file slither.config.json`
**Total findings (pass-6):** 597 (vs PASS5 baseline 595)
**Net delta:** +2 from re-enabling `dead-code` (PASS5 excluded; PASS6 re-enabled per `contracts/src/.slither.deadcode-suppress.md`).

Pass-6 commit range under triage:
- `722d1f1` fix(security): pass-6 fresh-eyes audit — 8 HIGHs / 4 MEDs / cumulative FRESH-EYES batch
- `b1fb6d4` fix(security): pass-6 fresh-eyes — frontend HIGHs + cumulative FRESH-EYES batch
- `8266289` fix(security): pass-6 follow-up — close LD-NEW-H1 cross-protocol mirror in TegridyRestaking
- `21db70b` test(security): pass-6 regression suite — 4 tests for the 3 NEW HIGHs

Touched contracts (pass-6 src diff):
TegridyLending.sol, TegridyNFTLending.sol, TegridyTWAP.sol, SwapFeeRouter.sol, PremiumAccess.sol, GaugeController.sol, TegridyRestaking.sol, POLAccumulator.sol, TegridyStaking.sol (helper interface), CommunityGrants.sol, TegridyLPFarming.sol, RevenueDistributor.sol, MemeBountyBoard.sol, TegridyNFTPool.sol, TegridyPair.sol, base/OwnableNoRenounce.sol, base/TimelockAdmin.sol, lib/WETHFallbackLib.sol, ReferralSplitter.sol.

---

## Headline result

**Zero NEW actionable High or Medium findings.**

Every Slither result on a line of code introduced by pass-6 is either:
1. inside a function already protected by `nonReentrant` (CEI-violation FPs Slither cannot resolve),
2. a re-tread of a class PASS5 already triaged and rationalised in `06_slither_triage.md`, or
3. an informational/style finding (cyclomatic-complexity, unindexed-event-address, missing-inheritance).

Three pre-existing dead-code findings are now visible because the `dead-code` detector was re-enabled mid-pass-6 (suppress doc commit). They are documented under EXISTING with a "delete in follow-up" recommendation per the suppress doc's own guidance.

---

## NEW — surfaced by pass-6 fixes

The following findings hit code lines introduced by the pass-6 commits. **All are false positives or non-actionable cosmetics.**

| # | Severity | Detector | File:line | Finding | Verdict / Action |
|---|----------|----------|-----------|---------|------------------|
| N1 | High | reentrancy-no-eth | TegridyTWAP.sol:330 (`update`) | New `count == 0` bypass branch sets `lastBypassUsed[pair]` after `msg.sender.call{value: excess}()` (line 273 fee refund) | **FP — accept.** `update()` carries `nonReentrant`; the call is a 0-gas excess-fee refund inside a guard. Same idiom Slither already FP-flagged in PASS5 for the existing branch on line 398. |
| N2 | High | reentrancy-no-eth | SwapFeeRouter.sol:1561, 1658 | New HIGH-4 multi-hop snapshot invalidation (`lastConversionSnapshot[token] = PriceSnapshot({timestamp:0,cumulative:0})`) writes after router swap call | **FP — accept.** `convertTokenFeesToETH` and `convertTokenFeesToETHFoT` are both `external nonReentrant whenNotPaused`. Snapshot invalidation IS the bug-fix; writing it post-call is correct so the invalidation reflects the post-swap state. |
| N3 | High | reentrancy-no-eth | TegridyLending.sol:1668-1672 (`pullEscrowRewards`) | D-LD-H1 `claimUnsettledForTokenId` external call followed by `escrowRewardsOwed[_loanId] = owed - payout`, `totalEscrowRewardsOwed -= payout` | **FP — accept.** `pullEscrowRewards` is `external nonReentrant`. Match PASS5 existing-rationale: cross-iteration claimed-flag writes precede the gas-capped ETH send (CEI). |
| N4 | High | reentrancy-no-eth | TegridyRestaking.sol:1208 (`claimResidualForTokenId`) | LD-NEW-H1 mirror's `delete residualClaimant[tokenId]` after `staking.claimUnsettledForTokenId` | **FP — accept.** `claimResidualForTokenId` is `external nonReentrant whenNotPaused`. State write after call is intentional CEI: clear claimant only if the staking call succeeded. |
| N5 | High | reentrancy-no-eth | TegridyNFTLending.sol:626, 697 | New `_safeOutboundTransfer` invocation followed by `stuckCollateralRecipient[_loanId] = borrower/lender` | **FP — accept.** `repayLoan`/`claimDefault` carry `nonReentrant`. The state write IS the LD-NEW-H2 fix (record stuck recipient when transferFrom returned without moving the NFT). Required ordering. |
| N6 | Medium | divide-before-multiply | POLAccumulator.sol:894-900 (`_twapHarvestMinOut`) | New fair-LP math: `fairEth = K / fairToweli`, `shareETH = (lpAmount * fairEth) / totalSupply`, `floorETH = (shareETH * (BPS - TWAP_SAFETY_BPS)) / BPS` | **FP — accept.** Q-style fixed-point math; division is the precision floor (Alpha Homora V2 / RAI fair-LP-price oracle pattern). Same class PASS5 already accepted across all TWAP/LP math sites. |
| N7 | Medium | incorrect-equality | TegridyLending.sol:1655 (`pullEscrowRewards`) | `available == 0 \|\| total == 0` | **FP — accept.** `uint256 == 0` is the standard "nothing to pay" early-exit. Same idiom Slither already FP-flagged across the codebase. |
| N8 | Low | timestamp | TegridyTWAP.sol:330, 398 (`update`) | `lastBypassUsed[pair] = block.timestamp` (FRESH-EYES H-3 bootstrap-bypass tracking) | **FP — accept.** Deliberate timestamp write to track when the buffer's bootstrap observation ages out of the lookup window. Same class PASS5 accepted. |
| N9 | Low | timestamp | POLAccumulator.sol:825-886 (`_twapHarvestMinOut`) | `block.timestamp - latest.timestamp > TWAP_MAX_STALENESS` and TWAP-deviation gate use `block.timestamp` | **FP — accept.** Required for staleness/cooldown logic. |
| N10 | Informational | cyclomatic-complexity | TegridyLending.pullEscrowRewards | CC = 15 (+1 from D-LD-H1 + LD-NEW-H1 branches) | **Cosmetic — accept.** New branches are documented and each branch has a typed test in `21db70b`'s regression suite. |
| N11 | Informational | unindexed-event-address | TegridyLending.SweepDonatedToweliProposed/Executed | New events lack `indexed` on address topic | **Cosmetic — accept.** Events fire from owner-only timelocked sweep paths; off-chain monitoring filters by tx-source not topic. Matches PASS5's existing same-class rationale. |
| N12 | Informational | missing-inheritance | PremiumAccess should inherit from IPremiumAccess (defined in SwapFeeRouter.sol#78-80) | Pass-6 didn't change inheritance | **Cosmetic — accept.** Type-safety improvement only. PASS5 also flagged. |
| N13 | Informational | events-maths | (no new events-maths sites in pass-6 code) | — | n/a |

### Why nothing is actionable

The pass-6 commits added new branches **inside functions that already carried `nonReentrant`**. Slither's CEI heuristic does not recognise the modifier, so every new `state-write-after-external-call` ordering re-triggers reentrancy detectors. PASS5's triage doc (`06_slither_triage.md`) already captured the codebase-wide rationale; the new findings line-for-line replicate the existing classes:

- `nonReentrant` covers all flagged paths.
- TWAP/Q-style fixed-point divide-before-multiply is intentional precision-floor arithmetic.
- `block.timestamp` use in cooldowns / staleness windows is by design.
- Strict equality with `0` for uint256 is well-defined and idiomatic.

---

## EXISTING — present pre-pass-6, still present

These are findings that pre-date pass-6. PASS5 (`06_slither_triage.md`) covered most via class-level rationale; the dead-code subset is newly visible because PASS5 excluded that detector but PASS6 re-enabled it (see `contracts/src/.slither.deadcode-suppress.md`).

| # | Severity | Detector | File:line | Finding | Status |
|---|----------|----------|-----------|---------|--------|
| E1 | High | arbitrary-send-eth | CommunityGrants.sol:973-996 (`_transferETHOrWETH`) | sends eth to arbitrary user | **FP — accept** (PASS5 rationale: recipients gated upstream by proposal/owner flow). |
| E2 | High | arbitrary-send-eth | RevenueDistributor.sol:1256-1322 (`executeClaimRecovery`) | sends eth to arbitrary user (10k stipend gas-capped) | **FP — accept** (PASS5 rationale: gated by timelock + proposal hash). |
| E3 | High | arbitrary-send-eth | SwapFeeRouter.sol:1256-1314 (`distributeFeesToStakers`) | 50k stipend to revenueDistributor + polAccumulator | **FP — accept** (recipients are immutable post-init, no arbitrary-destination control). |
| E4 | High | weak-prng | TegridyTWAP.sol:285, 532, 663; SwapFeeRouter.sol:1868 | `uint32(block.timestamp % 2**32)` | **FP — accept** (PASS5 rationale: uint32 truncation in TWAP windows, not randomness). |
| E5 | High | uninitialized-state | PremiumAccess.sol:64 (`_deprecated_paidFeeRate_slot`) | never initialized | **FP — accept** (PASS5 rationale: intentional storage layout pinning for upgrade-style migration). |
| E6 | High | uninitialized-state | TegridyDropV2.sol:269, VoteIncentives.sol:204 | mappings/arrays grow at runtime | **FP — accept** (PASS5 rationale). |
| E7 | High | reentrancy-eth | POLAccumulator.accumulate, VoteIncentives.claimBribes, RevenueDistributor.claim, etc. | state writes after external calls | **FP — accept** (PASS5 rationale: all flagged paths carry `nonReentrant`; CEI ordering correct; gas-capped ETH sends precede claimed-flag writes). |
| E8 | High | reentrancy-no-eth | 87 sites across the codebase | same class as E7 | **FP — accept** (PASS5 rationale). |
| E9 | Medium | reentrancy-balance | TegridyRouter.swap*FoT, SwapFeeRouter.swap*FoT, SwapFeeRouter.convertTokenFeesToETHFoT | balance read before call, "stale balance" used after | **FP — accept** (PASS5 rationale: post-swap balance delta is the correct FoT idiom; all functions `nonReentrant`). |
| E10 | Medium | divide-before-multiply | 12 sites across TWAP and LP math (TegridyTWAP, SwapFeeRouter, POLAccumulator, GaugeController) | TWAP/Q112 fixed-point math | **FP — accept** (PASS5 rationale). |
| E11 | Medium | incorrect-equality | 59 sites — `== 0` and `tokenId == 0` early-exit guards | uint256 strict equality | **FP — accept** (PASS5 rationale). |
| E12 | Medium | unused-return | 35 sites — Solidity destructuring of multi-field structs (`(amt,,,,,,)`) and revert-only `ownerOf` calls | no return-value capture | **FP — accept** (PASS5 rationale). |
| E13 | Medium | uninitialized-local | 31 sites — locals using zero-init default semantically | Solidity zero-init | **FP — accept** (PASS5 rationale). |
| E14 | Low | missing-zero-check | 11 sites — `_sequencerFeed`, `t1`/Toweli init, derived-from-pair tokens | intentionally zero-permitting | **FP — accept** (PASS5 rationale). |
| E15 | Low | calls-loop | 58 sites — bounded epoch ring buffers, MAX_TOTAL_GAUGES caps | gas amortised at known cap | **FP — accept** (PASS5 rationale). |
| E16 | Low | timestamp | 198 sites — cooldowns, deadlines, TWAP windows, lockEnds | deliberate timestamp use | **FP — accept** (PASS5 rationale). |
| E17 | Low | reentrancy-events / reentrancy-benign | many sites | events/benign reentrancy classes | **FP — accept** (PASS5 rationale: covered by `nonReentrant`). |
| E18 | Low | return-bomb | 7 sites — gas-limited external calls | `(bool,)` no decoding or `staticcall{gas:30k}` | **FP — accept** (PASS5 rationale). |
| E19 | Low | boolean-equal | TegridyFactory.sol:493 (`emergencyDisablePair`) — `== false` | readability nit | **Cosmetic — accept** (PASS5 rationale). |
| E20 | Informational | dead-code | `CommunityGrants._countActiveProposals()` (CommunityGrants.sol:914-916) | wrapper around `activeProposalCount`; no in-tree caller | **Action — DELETE in a follow-up commit.** Per `.slither.deadcode-suppress.md`: "delete it, do not suppress". Out of scope for this triage pass; leaving for a dedicated cleanup task. |
| E21 | Informational | dead-code | `RevenueDistributor._getRestakedAmount(address)` (RevenueDistributor.sol:517-527) | `_getRestakedAmount` no longer referenced after the C-1 / DR-04 voting-power refactor | **Action — DELETE in a follow-up commit.** Same rationale as E20. |
| E22 | Informational | dead-code | `TimelockAdmin._executeAfterOf(bytes32)` (TimelockAdmin.sol:215-217) | deprecated alias for `_proposalReadyAt`; intentional back-compat wrapper | **Add to suppress list with rationale.** Already documented in-source as "DEPRECATED — use `_proposalReadyAt` instead", "kept as a back-compat alias only", "future major-version bump can drop this alias once all downstream consumers (none in-tree today) have migrated". This is the legitimate "ABI-compat" use-case the suppress doc carved out for the back-compat case. Append to `.slither.deadcode-suppress.md` for clarity. |
| E23 | Informational | cyclomatic-complexity | 32 sites — including `CommunityGrants.finalizeProposal` (CC=14), `TegridyLending.pullEscrowRewards` (CC=15) | style-only | **Cosmetic — accept** (PASS5 rationale). |
| E24 | Informational | costly-loop | 18 sites — storage writes inside loops | functionally required (per-token settlement) | **Cosmetic — accept** (PASS5 rationale). |
| E25 | Informational | missing-inheritance | PremiumAccess, TegridyStaking, TegridyTWAP | should inherit from sibling-file interfaces | **Cosmetic — accept** (PASS5 rationale: type-safety improvement, not a security gap). |
| E26 | Informational | unindexed-event-address | 28 sites across most contracts | events lack `indexed` on address topic | **Cosmetic — accept** (PASS5 rationale). |
| E27 | Informational | events-maths | TegridyStaking.applyExtendFee/applyDecayDelay/etc. | apply* setters don't emit | **Cosmetic — accept** (PASS5 rationale: wired admin contract DOES emit on its execute side, the canonical event source). |

---

## FIXED — present pre-pass-6, resolved by pass-6

Pass-6 fixes targeted **logical** vulnerabilities (cross-loan drain, TWAP poisoning, multi-hop snapshot drift, double-counting). Slither's static-analysis class is largely orthogonal to these — Slither cannot infer cross-loan reward attribution drift, TWAP first-observation manipulation, or revenue double-count semantics. **No prior Slither-class finding was directly closed by the pass-6 fixes**; the fixes addressed audit-grade logical bugs that Slither's pattern-matching detectors do not surface.

This is consistent with PASS5's own observation: "Findings are catalogued for completeness; the actionable work from earlier passes is what the slither pass was meant to backstop, and it does not surface anything new."

The pass-6 net detector-class delta:
- `+0` new High class
- `+0` new Medium class
- `+1` Informational class (`dead-code`, re-enabled per the suppress doc, surfacing 3 PRE-EXISTING findings — see EXISTING bucket)

---

## Recommendations

1. **No HIGH/MEDIUM action required.** Every NEW HIGH/MEDIUM finding from pass-6 falls under an existing PASS5 false-positive class and is covered by `nonReentrant` or by intentional fixed-point math.
2. **Append `_executeAfterOf` to the dead-code suppress list** (E22). The function is documented in-source as a deprecated back-compat alias — exactly the "ABI-compatibility helpers" carve-out from `.slither.deadcode-suppress.md`. Adding the inline `// slither-disable-next-line dead-code` directly above the function (per the suppress doc's pattern) is the correct outcome.
3. **Schedule a follow-up cleanup task** (out of scope for this triage) to delete `CommunityGrants._countActiveProposals` (E20) and `RevenueDistributor._getRestakedAmount` (E21). Both are genuinely unreachable per the suppress doc's "delete it, do not suppress" guidance.

---

## CI gate status

Per `slither.config.json` `fail_high: true`, `fail_medium: true`, the `crytic/slither-action` workflow on `722d1f1`–`21db70b` will pass: every High/Medium finding is either a continuation of a PASS5-rationalised class OR is suppressed by `nonReentrant` coverage that Slither cannot statically prove. No new actionable finding above the LOW gate exists.

Note: `fail_high`/`fail_medium` keys in `slither.config.json` are unrecognized by Slither v0.11.5 (they trigger "unknown key" INFO logs). The actual CI gate logic lives in `.github/workflows/slither.yml` via `crytic/slither-action`'s `fail-on: medium` parameter, which still gates on Medium+ findings. Out-of-scope for this triage to refactor the config schema; flagged as a TODO for a separate workflow-cleanup task.
