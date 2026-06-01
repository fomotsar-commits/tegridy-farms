# Restored deferred-features — deploy runbook

The 9 features cut in `10e1dcc` ("Phase 0 MVP cut") were restored from `10e1dcc^`,
de-drifted against the current codebase, and have their original test suites green
(~460 tests) + full-suite regression gate passing (104 suites / 2025 tests / 0 failed).
This runbook turns "deploy-ready" into "deployed."

## ⛔ GATE — re-audit before ANY mainnet deploy

These contracts are **TESTED, NOT RE-AUDITED**. The original cut deferred them to
"next-wave **audited** releases — each ships in its own audit wave." Two things changed
since they were last audited and MUST be reviewed per feature before mainnet:

1. **The restore baseline** — these are pre-cut (`10e1dcc^`) contracts; confirm no
   intervening fix on the kept contracts invalidates an assumption.
2. **The de-drift edits** (behavior-preserving, but new): `VotePowerOracle.powerOf →
   powerOfLiveUnsafe` (Grants/Bounties/Gauge/VoteIncentives); `TegridyLending` reads the
   staking `positions` mapping instead of the moved `getPosition`; `WETHFallbackLib.
   safeTransferETHOrWrapNoRevert` (+2 events) restored verbatim; the `SafeERC721Call` lib
   restored. Frontend ABI/call-site re-alignment (commits d3a567c, fe60a2d) is off-chain
   but should be cross-checked against the final audited signatures.

Do not skip the audit wave. The protocol mandate is audited-before-mainnet.

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

- All 9 are independent of each other; deploy in any order (one audit wave at a time).
- They depend only on already-deployed MVP contracts (staking/factory/pair/twap/token).
  Token Lending additionally needs `PAIR` + `TWAP` (the ETH-floor guard).
- Gauge Controller and Vote Incentives are designed to partner (bribes direct gauge
  emissions) — deploy/whitelist them together if shipping governance as one wave.
