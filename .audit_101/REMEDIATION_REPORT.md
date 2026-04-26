# 101-Agent Audit — REMEDIATION INDEX

**Date:** 2026-04-26
**Source audits:** [`MASTER_REPORT.md`](MASTER_REPORT.md) / [`DETAILED_REPORT.md`](DETAILED_REPORT.md)
**Per-fix change logs:** [`remediation/R*.md`](remediation/) (one file per remediation pass)

This index is a one-table summary of every closed audit thread. Each row points
at the per-fix log where the diff, verification, and rationale live. Waves track
the bulletproofing rollout described in `feedback_bulletproof_mandate.md`.

| ID | Finding (one-liner) | Wave | Status |
|---|---|---|---|
| RECON1 | Initial recon: catalogue stale `.bak` / dump files, raise R-IDs | 0 | done |
| R001 | `TegridyPair` `kLast=0` short-circuit forfeits pre-feeOn fees | 1 | done |
| R002 | `TegridyRouter` cycle-path + `to==router` lockout + emergencyDisablePair race | 1 | done |
| R003 | `TegridyLending` `_positionETHValue` TWAP gate + 5th constructor arg | 1 | done |
| R004 | `TegridyFeeHook` exact-output currency-bucket drift | 1 | done |
| R005 | `TegridyStaking` partial-claim invariant + cap-shortfall forfeit | 1 | done |
| R006 | `TegridyLending` collateral-floor sandwich resistance | 1 | done |
| R007 | `TegridyNFTLending` interest dust DoS / floor minimum | 1 | done |
| R008 | Doc truth-up vs on-chain reality (FAQ / REVENUE / SECURITY / README / FIX_STATUS) | 1 | done |
| R009 | `TegridyNFTPool` rarity-snipe + CEI + `syncNFTs` rug | 1 | done |
| R010 | `TegridyLPFarming` rate-cut + boost mid-period + FoT under-pay | 1 | done |
| R011 | `TegridyDropV2` `setMerkleRoot` race + `_safeMint` CEI | 1 | done |
| R012 | `TegridyLaunchpadV2` config validation + redeploy notes | 1 | done |
| R013 | `TegridyTWAP` bootstrap deviation + reverse-direction guard | 1 | done |
| R014 | `TegridyTokenURIReader` URI hardening | 2 | done |
| R015 | `POLAccumulator` LP-mismatch + TWAP floor + tighten-only minOuts | 2 | done |
| R016 | `Toweli` token housekeeping | 2 | done |
| R017 | `VoteIncentives` orphaned-bribe rescue + per-token min + commit-reveal genesis | 2 | done |
| R018 | `GaugeController` removeGauge weight bookkeeping + commit-reveal grief | 2 | done |
| R019 | `CommunityGrants` pause coverage on retry/cancel/lapse | 2 | done |
| R020 | `MemeBountyBoard` emergencyForceCancel guard | 2 | done |
| R021 | `POLAccumulator` minOut bound + Flashbots fallback documentation | 2 | done |
| R022 | `PremiumAccess` extension `startedAt` refund + naturally-expired withdraw | 2 | done |
| R023 | `ReferralSplitter` accounting tighten | 2 | done |
| R024 | `RevenueDistributor` flash-deflation + restaker double-credit + forfeit-reclaim | 2 | done |
| R025 | `SwapFeeRouter` FoT triple-bug fix | 3 | done |
| R026 | `OwnableNoRenounce` invariant tests | 3 | done |
| R027 | `TimelockAdmin` value-binding to timelock key | 3 | done |
| R028 | `WETHFallbackLib` invariant + harness tests | 3 | done |
| R029 | `TegridyNFTLending` whitelist-by-timelock + ERC-165 check | 3 | done |
| R030 | Approval / allowance hygiene sweep | 3 | done |
| R031 | Slippage / MEV defense-in-depth | 3 | done |
| R032 | Oracle / TWAP coverage sweep | 3 | done |
| R033 | Fee-on-transfer compatibility sweep | 3 | done |
| R034 | Init / proxy storage-layout audit | 3 | done |
| R035 | Frontend doc/address drift (SecurityPage, Terms, Tokenomics, FAQ, ContractsPage) | 3 | done |
| R036 | Fuzz / invariant test additions | 3 | done |
| R037 | Deploy-script multisig + ConfigureFeePolicy + SwapFeeRouterV2 wiring | 3 | done |
| R038 | Constructor immutables sweep | 3 | done |
| R039 | Events normalization | 4 | done |
| R040 | ERC standards compliance sweep | 4 | done |
| R041 | Gas-griefing surface review | 4 | done |
| R042 | Signature replay coverage | 4 | done |
| R043 | Admin-key custody review (V1 hooks deleted; V2-only) | 4 | done |
| R045 | L2 compatibility review | 4 | done |
| R046 | HomeDashboard data-source drift | 4 | done |
| R047 | Trade / Swap UX drift | 4 | done |
| R048 | Farm page drift | 4 | done |
| R049 | Lending page LTV bug | 4 | done |
| R050 | Premium page drift | 4 | done |
| R051 | Admin page drift | 4 | done |
| R052 | Art Studio dev-only middleware lockdown | 4 | done |
| R053 | Community page drift | 4 | done |
| R054 | Leaderboard data integrity | 4 | done |
| R055 | StaticDrift sweep | 4 | done |
| R056 | LiveTowelie page drift | 4 | done |
| R057 | Wagmi config / connector drift | 4 | done |
| R058 | History / activity drift | 4 | done |
| R059 | Gallery drift | 4 | done |
| R060 | Treasury page drift | 4 | done |
| R067 | LibPointsBoost coverage | 5 | done |
| R071 | V1 hook deletion follow-up (useNFTDrop, OwnerAdminPanel, CollectionDetail) | 5 | done |
| R082 | LOW + INFO sweep — stale comments, repo-URL typos, stale dump files, `.bak` cleanup | 6 | done |

## Status legend

- **done** — diff merged on `main`, change log present in `remediation/Rxxx.md`,
  forge / tsc green at the time of commit.
- **partial** — fix landed but follow-up explicitly tracked in the matching
  `Rxxx.md` (none currently open).
- **deferred** — finding intentionally out of scope; rationale in
  `Rxxx.md` (none currently open).

## Wave reference

- **Wave 0** — pre-audit recon and `.bak` cleanup (`RECON1.md`).
- **Wave 1** — bleeding-wound HIGH/CRITICAL contracts (R001–R013).
- **Wave 2** — second-tier HIGH on POL / restaking / governance (R014–R024).
- **Wave 3** — cross-cutting Solidity hardening (R025–R038).
- **Wave 4** — frontend pages + hooks drift (R039–R060, R067, R071).
- **Wave 5** — invariant suites + Audit195_* / AuditFixes_* / R*_*.t.sol harness
  build-out. Tracked in `contracts/test/` (no per-finding `Rxxx.md`).
- **Wave 6** — LOW + INFO + janitorial (R082).

## What is NOT in this index

- Pure janitorial work (file moves, README touch-ups) without an audit-agent
  finding behind it.
- Wave 0 deploy follow-up (multisig `acceptOwnership`, VoteIncentives /
  V3Features / FeeHook redeploy) — tracked in `docs/WAVE_0_TODO.md`, not as
  remediation IDs.
- Cross-check agents 091–101 outputs — see those agent reports directly; their
  findings rolled into the Rxxx pulls listed above.
