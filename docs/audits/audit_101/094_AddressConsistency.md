# Agent 094 — Address Consistency (deployed-address sources of truth)

AUDIT-ONLY. Cross-checked sources:
- `frontend/src/lib/constants.ts` (FE)
- `frontend/src/lib/contracts.ts` — re-imports from constants only; no hardcoded `0x...` (clean)
- `CONTRACTS.md` (CD)
- `README.md` (RD)
- `DEPLOY_CHEAT_SHEET.md` (CS)
- `DEPLOY_RUNBOOK.md`, `NEXT_SESSION.md`, `FIX_STATUS.md` — no `0x...` addresses (clean)
- `indexer/ponder.config.ts` (PC)
- `contracts/broadcast/*` (BC) — Foundry receipts (Apr 2026)
- `contracts/script/*.s.sol` (SC) — wiring/deploy scripts
- No `contract-deployments.json`, no Supabase migration metadata files contain on-chain addresses.

Per-contract row matrix (lowercased for compare; case-mismatches called out separately):

| Contract | FE constants.ts | CONTRACTS.md | README.md | ponder.config.ts | broadcast/run-latest | script .s.sol | Verdict |
|---|---|---|---|---|---|---|---|
| TOWELI | 0x420698cf…78f9d | 0x420698cf…78f9d | 0x420698cf…78f9d | (not registered) | n/a | 0x420698cf…78f9d (multiple) | OK |
| TegridyStaking (v2) | 0x62664452…c4819 | 0x62664452…c4819 | 0x62664452…c4819 | 0x62664452…c4819 | 0x62664452…c4819 (DeployAuditFixes) | 0x62664452…c4819 (Wire/DeployVote/DeployLPFarming/DeployFeeHook) | OK |
| TegridyStaking (v1, paused) | (omitted, comment-only) | listed Deprecated `0x65D8…` | (not in addr list) | comment-only | 0x65d8b879…a421 (DeployFinal) | mentioned in DEPLOY_CHEAT_SHEET.md L39/L50 (sed example + envOr default) | OK — v1 properly tagged paused; CS still uses v1 as `envOr` default — STALE DEFAULT (LOW) |
| TegridyRestaking | 0xfba4d340…caee4 | 0xfba4d340…caee4 | 0xfba4d340…caee4 | 0xfba4d340…caee4 | 0xfba4d340…caee4 (DeployFinal/AuditFixes) | 0xfba4d340…caee4 (Wire) | OK |
| TegridyFactory | 0x8b786163…bdcb6 | 0x8b786163…bdcb6 | 0x8b786163…bdcb6 | (not registered) | 0x8b786163…bdcb6 (DeployV2) | 0x8b786163…bdcb6 (DeployVoteIncentives) | OK |
| TegridyRouter | 0xcbcf6acc…9863f | 0xcbcf6acc…9863f | 0xcbcf6acc…9863f | (not registered) | 0xcbcf6acc…9863f (DeployTegridyRouter) | n/a | OK |
| TegridyLP (TOWELI/WETH native pair) | 0xed01d5f5…f26f6 | 0xed01d5f5…f26f6 | 0xed01d5f5…f26f6 | (not registered) | constructor arg in DeployLPFarming | n/a | OK |
| RevenueDistributor | 0x332aae55…264d8 | 0x332aae55…264d8 | 0x332aae55…264d8 | 0x332aae55…264d8 | 0x332aae55…264d8 | 0x332aae55…264d8 (Wire) | OK |
| **SwapFeeRouter** | 0xea13Cd47a37cC5B59675bfd52BFc8**ff**8691937A0 | 0xea13Cd…**ff**…937A0 | 0xea13Cd…**ff**…937A0 | 0xea13Cd47a37cC5B59675bfd52BFc8**fF**8691937A0 | 0xea13cd47…937a0 (DeployAuditFixes) **AND** 0x71eaeca0…39bd (DeploySwapFeeRouterV2 latest!) | 0xea13Cd…**ff**…937A0 (Wire) | **MEDIUM/HIGH drift — see top-5 #1 + #2** |
| POLAccumulator | 0x17215f0d…b7ca | 0x17215f0d…b7ca | 0x17215f0d…b7ca | (not registered) | 0x17215f0d…b7ca (DeployRemaining) | n/a | OK |
| TegridyTWAP | 0xddbe4cd5…4995 | 0xddbe4cd5…4995 | 0xddbe4cd5…4995 | (not registered) | 0xddbe4cd5…4995 (DeployTWAP) | n/a | OK |
| **TegridyFeeHook** | 0xb6cfeacf…0044 | 0xb6cfeacf…0044 | 0xb6cfeacf…0044 | (not registered) | (no broadcast under contracts/broadcast/DeployTegridyFeeHook.s.sol/) | n/a | INFO — no broadcast receipt on disk for the recorded mainnet address; FE/CD/RD agree but cannot be cross-verified locally |
| **TegridyLPFarming** | 0xa7ef711b…9ec1 | 0xa7ef711b…9ec1 | 0xa7ef711b…9ec1 | 0xa7ef711b…9ec1 | 0xa7ef711b…9ec1 (DeployTegridyLPFarming) | n/a | OK |
| **GaugeController** | 0xb93264ab…0fdb | 0xb93264ab…0fdb | 0xb93264ab…0fdb | NOT REGISTERED (deferred per comment line 419-420) | 0xb93264ab…0fdb (DeployGaugeController) | 0x62664452… (only TEGRIDY_STAKING ref in DeployGaugeController.s.sol) | LOW — indexer skips GaugeController, so commit-reveal events are unindexed |
| **VoteIncentives** | 0x417f44ae…cf1a | 0x417f44ae…cf1a | 0x417f44ae…cf1a | 0x417f44ae…cf1a | **0xa5a974da…5b43** (DeployVoteIncentives run-latest, 2026-04-18) — **DRIFT** | 0x417f44ae…cf1a (Wire) | **HIGH — see top-5 #3** |
| CommunityGrants | 0x8f1ba1ec…3032 | 0x8f1ba1ec…3032 | 0x8f1ba1ec…3032 | 0x8f1ba1ec…3032 | 0x8f1ba1ec…3032 (DeployAuditFixes) | 0x8f1ba1ec…3032 (Wire) | OK |
| MemeBountyBoard | 0x3457c221…f0c9 | 0x3457c221…f0c9 | 0x3457c221…f0c9 | 0x3457c221…f0c9 | 0x3457c221…f0c9 (DeployAuditFixes) | 0x3457c221…f0c9 (Wire) | OK |
| ReferralSplitter | 0xd3d46c0d…2c16 | 0xd3d46c0d…2c16 | 0xd3d46c0d…2c16 | (not registered) | 0xd3d46c0d…2c16 (DeployAuditFixes) | 0xd3d46c0d…2c16 (Wire) **BUT** DeploySwapFeeRouterV2.s.sol L12 hardcodes a *different* address `0x5A2c3382…7411` | **HIGH — see top-5 #4** |
| PremiumAccess | 0xaa16df3d…22ad | 0xaa16df3d…22ad | 0xaa16df3d…22ad | (not registered) | 0xaa16df3d…22ad (DeployAuditFixes) | 0xaa16df3d…22ad (Wire) **BUT** DeploySwapFeeRouterV2.s.sol L13 hardcodes `0x84AA3Bf4…8aF7` | **HIGH — see top-5 #5** |
| TegridyLending | 0xd471e567…367f | 0xd471e567…367f | 0xd471e567…367f | 0xd471e567…367f | 0xd471e567…367f (DeployV2) | n/a | OK |
| TegridyNFTLending | 0x05409880…b139 | 0x05409880…b139 | 0x05409880…b139 | (not registered) | 0x05409880…b139 (DeployNFTLending) | n/a | OK |
| TegridyNFTPoolFactory | 0x1c0e1771…04f0 | 0x1c0e1771…04f0 | 0x1c0e1771…04f0 | (not registered) | 0x1c0e1771…04f0 (DeployV2) | n/a | OK |
| TegridyTokenURIReader | 0xfec9aea4…1eb2 | 0xfec9aea4…1eb2 | 0xfec9aea4…1eb2 | (not registered) | 0xfec9aea4…1eb2 (DeployTokenURIReader) | n/a | OK |
| **TegridyLaunchpad (V1, deleted from src 2026-04-19)** | comment only — TEGRIDY_LAUNCHPAD_V2 placeholder = 0x0 | listed in CONTRACTS.md as "V1 source deleted… clones remain live" | LISTED in README.md L331 as deprecated 2026-04-19 (`0x5d597647…ff3c2`) | (not registered) | 0x5d597647…ff3c2 in DeployV2 broadcast (BC) | n/a | LOW — README still surfaces v1 row in deployed-contracts table even though scope decision says delete V1 duplicates from sources of truth |
| TegridyLaunchpadV2 | 0x0…0 (placeholder) | placeholder noted | not listed | (not registered) | none | n/a | INFO — pending deploy per Wave 0 |
| WETH9 | 0xc02aaa39…56cc2 | 0xc02aaa39…56cc2 | n/a | n/a | constructor arg passim | 0xc02aaa39…56cc2 (multiple scripts) | OK (canonical external) |
| Uniswap V2 Router | 0x7a250d56…488d | 0x7a250d56…488d | n/a | n/a | n/a | 0x7a250d56…488d (Wire/SFRv2) | OK |
| Uniswap V2 Factory | 0x5c69bee7…aa6f | 0x5c69bee7…aa6f | n/a | n/a | n/a | n/a | OK |
| TOWELI/WETH UniV2 LP | 0x6682ac59…104d | 0x6682ac59…104d | 0x6682ac59…104d | n/a | n/a | n/a | OK |
| Chainlink ETH/USD | 0x5f4ec3df…b8419 | 0x5f4ec3df…b8419 | n/a | n/a | n/a | n/a | OK |
| Treasury (multisig) | 0xe9b7ab8e…f53e | 0xe9b7ab8e…f53e | 0xe9b7ab8e…f53e | n/a | constructor arg | 0xe9b7ab8e…f53e (Wire/SFRv2) | OK |
| JBAC NFT | 0xd37264c7…fdda9 | 0xd37264c7…fdda9 | 0xd37264c7…fdda9 | n/a | n/a | n/a | OK |
| JBAY Gold | 0x6aa03f42…92f3 | 0x6aa03f42…92f3 | 0x6aa03f42…92f3 | n/a | n/a | n/a | OK |

## Top-5 mismatches / drifts (severity-ordered)

1. **HIGH — SwapFeeRouter EIP-55 case mismatch (`BFc8ff` vs `BFc8fF`)** between `frontend/src/lib/constants.ts:16`, `CONTRACTS.md:27`, `README.md:317` (all `BFc8ff…`) and `indexer/ponder.config.ts:404` (`BFc8fF…`). Both decode to the same address bytes, but EIP-55 only one casing is valid; one of these two strings will fail strict EIP-55 validators. Net result: ethers/viem strict mode throws or normalizes inconsistently in tooling that compares strings instead of bytes.

2. **HIGH — Latest SwapFeeRouter broadcast points to a *different* contract (`0x71eaeca0f75ca3d4c757b27825920e3d0fa839bd`) than what FE/indexer/CONTRACTS.md/README all reference (`0xea13Cd47…937A0`).** `contracts/broadcast/DeploySwapFeeRouterV2.s.sol/1/run-latest.json` has 4 transactions for the new address; constructor args reference stale `REFERRAL_SPLITTER=0x5A2c3382…7411` and `PREMIUM_ACCESS=0x84AA3Bf4…8aF7`. Script appears to have been a draft V2 redeploy that was *not* promoted into constants. Either (a) `0xea13Cd…` is still live and the V2 broadcast was abandoned (purge `DeploySwapFeeRouterV2.s.sol/1/run-latest.json` or rename), or (b) `0x71eaeca0…` is the new live contract and constants/CONTRACTS/README are stale.

3. **HIGH — VoteIncentives latest broadcast points to `0xa5a974dac4b9f8168cd3fac727997e66522f5b43` but every source-of-truth lists `0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A`.** `contracts/broadcast/DeployVoteIncentives.s.sol/1/run-latest.json` (timestamp 2026-04-18 18:09) shows the new address. There are *five* historical VoteIncentives broadcasts on disk pointing to *five different addresses* (`0xa72ee8a1…`, `0xa799911f…`, `0xcad42933…`, `0x417F44ae…`, `0xa5a974da…`). Either the Apr-18 redeploy was never promoted into FE/indexer (constants stale) or it was a dry-run that wrote a `run-latest.json` that should be deleted. Wire-script hardcoded value (`WireAuditFixes.s.sol:36`) still says `0x417F44…`, supporting the "stale latest broadcast file" interpretation, but this should be confirmed on chain.

4. **MEDIUM — DeploySwapFeeRouterV2.s.sol has a *hardcoded ReferralSplitter* address (`0x5A2c3382B3aDf54E44E6e94C859e24D7A3c07411`, line 12) that does NOT match the current `REFERRAL_SPLITTER_ADDRESS = 0xd3d46C0d…2c16` in constants.ts.** If the script is ever re-run to redeploy SwapFeeRouter, it will wire the new router to a stale/zero referral splitter, breaking the referral fee path until manually corrected.

5. **MEDIUM — DeploySwapFeeRouterV2.s.sol hardcodes `PREMIUM_ACCESS = 0x84AA3Bf462ca7C07Ba20E4A1fA2ff8Fb78f08aF7` (line 13) — does NOT match canonical `0xaA16dF3dC66c7A6aD7db153711329955519422Ad`.** Same blast radius as #4.

## Counts

- Sources cross-referenced: 9 distinct artifact types (FE constants, FE contracts, CONTRACTS.md, README.md, DEPLOY_CHEAT_SHEET.md, DEPLOY_RUNBOOK.md / NEXT_SESSION.md / FIX_STATUS.md, indexer ponder.config, foundry broadcast tree, deploy/wire .s.sol scripts).
- Distinct contracts/external-deps tracked: 30
- OK rows (full agreement across populated columns): 23
- Drift rows (≥2 sources disagree, including stale broadcasts): 5
- Stale-broadcast-only rows (broadcast file conflicts but FE/indexer/docs agree): 2 (VoteIncentives, SwapFeeRouter)
- Hardcoded-mismatch in deploy scripts: 2 (DeploySwapFeeRouterV2.s.sol L12, L13)
- EIP-55 case mismatches (same bytes, different casing across files): 1 (SwapFeeRouter `ff` vs `fF`)
- V1 deprecated still surfaced: 1 (TegridyLaunchpad V1 row in README.md L331; v1 staking only in DEPLOY_CHEAT_SHEET.md as sed example/envOr default — informational, not user-facing)
- Indexer registration coverage: 9 of ~14 in-scope core contracts; missing: Factory, Router, POLAccumulator, TWAP, FeeHook, TokenURIReader, NFTLending, NFTPoolFactory, GaugeController, ReferralSplitter, PremiumAccess. (HIGH gap for analytics, but out of scope for "address consistency"; flagging as INFO.)

No zero-padding inconsistencies found beyond the SwapFeeRouter `ff/fF` case difference.

EIP-55 validation note: actual byte-level agreement on every drift case except #1 (true case mismatch). Drifts #2/#3 are different-bytes drifts; #4/#5 are different-bytes hardcodes inside an as-yet-unbroadcast script.
