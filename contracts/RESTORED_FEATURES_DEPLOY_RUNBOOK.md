# Restored deferred-features — deploy runbook

The 9 features cut in `10e1dcc` ("Phase 0 MVP cut") were restored from `10e1dcc^`,
de-drifted against the current codebase, and have their original test suites green
(~460 tests) + full-suite regression gate passing (104 suites / 2025 tests / 0 failed).
The **NFT Launchpad V2** (`TegridyDropV2` + `TegridyLaunchpadV2`, also cut in `10e1dcc`)
was likewise recovered from git on 2026-06-02 — see its row below + `AUDIT_LAUNCHPADV2_2026_06_02.md`.
This runbook turns "deploy-ready" into "deployed" for all 10.

## ✅ GATE CLEARED 2026-06-02 — pre-deploy audit wave complete

The mandated per-feature re-audit ran on 2026-06-02 (multi-agent adversarial wave +
per-finding verification against the real code). Result: **all features deploy-ready, no
open Critical/High/Medium.**

- **9 restored features** — 7 clean with zero surviving exploits; **2 HIGH found + fixed**
  (commit `1b9b269`): `VoteIncentives.claimBribesBatch` missing the claim-window gate
  (cross-pool over-share / insolvency) and `CommunityGrants.createProposal` reverting on the
  `internal` `userPositionCount` selector (feature-bricking; fixed via ERC-721 `balanceOf`,
  staking contract untouched). Report: `AUDIT_BATCH3_DEPLOY_READINESS_2026_06_02.md`.
- **NFT Launchpad V2** (recovered from git this session) — factory + clone-init seam clean
  (template `_disableInitializers`, atomic clone-init, msg.sender-bound salt verified);
  **1 MEDIUM found + fixed** (commit `8360d73`): `setMintPhase` zero-price `PUBLIC` toggle
  (H19 toggle-to-free). Report: `AUDIT_LAUNCHPADV2_2026_06_02.md`.

The de-drift edits (`powerOfLiveUnsafe`, the `positions`-mapping read, `WETHFallbackLib`,
`SafeERC721Call`) were re-verified against the live code in the wave, and each contract was
checked against its frontend call sites. **Mainnet deploy is now an operator action** — but
keep the per-feature discipline (deploy + verify + accept-ownership one feature at a time).

## Prerequisites (already-deployed MVP contracts — plug their addresses in)

From `frontend/src/lib/constants.ts` / the DeployMVP broadcast: `TOWELI`, `TEGRIDY_STAKING`,
`TEGRIDY_FACTORY`, `TEGRIDY_LP` (TOWELI/WETH pair), `TEGRIDY_TWAP`, `TREASURY`, `JBAC_NFT`,
`WETH` (canonical `0xC02a…6Cc2`). `MULTISIG` = the relaunch 3-of-N safe. `SEQUENCER_FEED`
is optional (leave unset = `address(0)` on mainnet; set only on an L2 with a sequencer
uptime feed).

## Per-feature deploy (each is its own audit wave — deploy independently)

`forge script script/<Script>.s.sol --rpc-url $RPC --account <keystore> --broadcast --verify`

| Feature | Script | Required env (beyond MULTISIG) | Optional env (default) | Post-deploy: set in constants.ts |
|---|---|---|---|---|
| LP Farming | `DeployTegridyLPFarming.s.sol` | `TEGRIDY_LP`, `TEGRIDY_STAKING` | — | `LP_FARMING_ADDRESS` |
| Premium / Gold Card | `DeployPremiumAccess.s.sol` | `TOWELI`, `JBAC_NFT`, `TREASURY`, `MONTHLY_FEE` | — | `PREMIUM_ACCESS_ADDRESS` |
| Meme Bounties | `DeployMemeBountyBoard.s.sol` | `TOWELI`, `STAKING`, `WETH`, `TREASURY` | `SEQUENCER_FEED` (0x0) | `MEME_BOUNTY_BOARD_ADDRESS` |
| Community Grants | `DeployCommunityGrants.s.sol` | `STAKING`, `TOWELI`, `TREASURY`, `WETH` | — | `COMMUNITY_GRANTS_ADDRESS` |
| Gauge Controller | `DeployGaugeController.s.sol` | `STAKING` | `EMISSION_BUDGET` (1,000,000e18) | `GAUGE_CONTROLLER_ADDRESS` |
| Vote Incentives (+Admin) | `DeployVoteIncentives.s.sol` | `STAKING`, `TREASURY`, `WETH`, `FACTORY`, `TOWELI` | `BRIBE_FEE_BPS` (300) | `VOTE_INCENTIVES_ADDRESS` |
| NFT AMM (pool factory) | `DeployNFTPoolFactory.s.sol` | `TREASURY`, `WETH` | `PROTOCOL_FEE_BPS` (50) | `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` |
| NFT Lending (+Admin) | `DeployNFTLending.s.sol` | `TREASURY`, `WETH` | `PROTOCOL_FEE_BPS` (500), `SEQUENCER_FEED` (0x0) | `TEGRIDY_NFT_LENDING_ADDRESS` |
| Token Lending (+Admin) | `DeployTegridyLending.s.sol` | `TREASURY`, `WETH`, `PAIR`, `TWAP` | `PROTOCOL_FEE_BPS` (500), `SEQUENCER_FEED` (0x0) | `TEGRIDY_LENDING_ADDRESS` |
| NFT Launchpad V2 | `DeployLaunchpadV2.s.sol` | — (`TREASURY` + `WETH` are constants in the script) | `SEQUENCER_FEED` (0x0); fee 500 bps | `TEGRIDY_LAUNCHPAD_V2_ADDRESS` |

REVIEW the optional economic params before mainnet — defaults are the last-known live
values, logged by each script at deploy time.

## Per-feature post-deploy steps

1. **`MULTISIG.acceptOwnership()`** on the deployed contract (OwnableNoRenounce is 2-step).
   For Vote Incentives, Token Lending, and NFT Lending, accept on BOTH the main contract
   AND its Admin sister (the Admin holds ALL governance entrypoints — fee/treasury/
   whitelist/origination/min-APR/sweep — so a missed acceptance leaves it owned by the
   deployer EOA). (NFT Pool Factory sets `owner = MULTISIG` in the constructor — no acceptance.)
2. Set the address in `frontend/src/lib/constants.ts` (table above). The frontend
   auto-un-gates that feature the moment the address is non-zero (`isDeployed()`); no
   component change needed.
3. Fund / configure as the feature needs (e.g. LP Farming: `TOWELI.approve` +
   `notifyRewardAmount`; Gauge/VoteIncentives: whitelist gauges, `advanceEpoch`).
4. Indexer (optional, off-chain): the Ponder handlers for these were pruned in the cut.
   Activity/history/leaderboard feeds stay empty until re-wired; the UIs themselves work
   (they read on-chain via wagmi). Re-add handlers + the address env vars when ready.

## Coupling / ordering notes

- All 10 are independent of each other; deploy in any order (one feature at a time).
- **NFT Launchpad V2** deploys the `TegridyDropV2` clone template inside its constructor —
  verify BOTH `TegridyLaunchpadV2` and its `dropTemplate()` address on Etherscan. Creator
  collections are EIP-1167 minimal-proxy clones of that template; the create-collection
  wizard frontend is already wired to the v2 ABI and auto-un-gates on a non-zero address.
- They depend only on already-deployed MVP contracts (staking/factory/pair/twap/token).
  Token Lending additionally needs `PAIR` + `TWAP` (the ETH-floor guard).
- Gauge Controller and Vote Incentives are designed to partner (bribes direct gauge
  emissions) — deploy/whitelist them together if shipping governance as one wave.
