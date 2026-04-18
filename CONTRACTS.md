# Tegriddy Farms — Canonical Contract Index

Generated from `frontend/src/lib/constants.ts` on 2026-04-17. Chain: Ethereum Mainnet (chainId 1).

All addresses are EIP-55 checksummed. Etherscan links use `https://etherscan.io/address/...`.

---

## Core Token + Staking

| Contract | Address | Source | Status |
|---|---|---|---|
| **TOWELI** — Fixed-supply ERC20 governance/reward token (1B supply). | [`0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`](https://etherscan.io/address/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D) | `contracts/src/TOWELI.sol` | Live |
| **TegridyStaking** — veTOWELI lockup (7d–4y), 0.4x–4.0x boost, 25% early-exit penalty, +0.5x JBAC bonus. Post-C-01 v2. | [`0x626644523d34B84818df602c991B4a06789C4819`](https://etherscan.io/address/0x626644523d34B84818df602c991B4a06789C4819) | `contracts/src/TegridyStaking.sol` | Live |
| **TegridyRestaking** — Auto-compounding restake wrapper over TegridyStaking. | [`0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4`](https://etherscan.io/address/0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4) | `contracts/src/TegridyRestaking.sol` | Live |
| **TegridyStaking (v1)** — Legacy paused vault, superseded 2026-04-17 per DEPLOY_CHEAT_SHEET §1 Gap A. | `0x65D8…` (paused) | `contracts/src/TegridyStaking.sol` | Deprecated |

---

## Native DEX

| Contract | Address | Source | Status |
|---|---|---|---|
| **TegridyFactory** — Uniswap V2-compatible pair factory for TOWELI markets. | [`0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6`](https://etherscan.io/address/0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6) | `contracts/src/TegridyFactory.sol` | Live |
| **TegridyRouter** — Swap/add/remove liquidity router with fee-on-transfer support. | [`0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F`](https://etherscan.io/address/0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F) | `contracts/src/TegridyRouter.sol` | Live |
| **TegridyLP (TOWELI/WETH pair)** — Native DEX LP token for TOWELI/WETH. | [`0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6`](https://etherscan.io/address/0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6) | `contracts/src/TegridyPair.sol` | Live |
| **SwapFeeRouter** — Routes DEX swap fees to RevenueDistributor + POLAccumulator. | [`0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0`](https://etherscan.io/address/0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0) | `contracts/src/SwapFeeRouter.sol` | Live |
| **POLAccumulator** — Protocol-owned-liquidity sink; buys TOWELI and LPs it. | [`0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca`](https://etherscan.io/address/0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca) | `contracts/src/POLAccumulator.sol` | Live |
| **TegridyTWAP** — Time-weighted average price oracle over native pairs. | [`0x1394A256e127814B52244Bbd0CCB94f0007dBe25`](https://etherscan.io/address/0x1394A256e127814B52244Bbd0CCB94f0007dBe25) | `contracts/src/TegridyTWAP.sol` | Live |
| **TegridyFeeHook** — Per-pair dynamic fee hook. | _pending_ | `contracts/src/TegridyFeeHook.sol` | Not yet deployed — pending CREATE2 salt mining. |
| **TegridyLPFarming** — Fixed-schedule LP farming rewards vault (C-01 fix). | [`0xa5AB522C99F86dEd9F429766872101c75517D77c`](https://etherscan.io/address/0xa5AB522C99F86dEd9F429766872101c75517D77c) | `contracts/src/TegridyLPFarming.sol` | Live |

---

## Revenue

| Contract | Address | Source | Status |
|---|---|---|---|
| **RevenueDistributor** — Streams protocol revenue pro-rata to veTOWELI stakers. | [`0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8`](https://etherscan.io/address/0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8) | `contracts/src/RevenueDistributor.sol` | Live |
| **ReferralSplitter** — Splits referral rebates between referrer and protocol. | [`0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16`](https://etherscan.io/address/0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16) | `contracts/src/ReferralSplitter.sol` | Live |

---

## Governance

| Contract | Address | Source | Status |
|---|---|---|---|
| **GaugeController** — veTOWELI-weighted gauge voting for emissions allocation (H-2 commit-reveal). | [`0xb6E4CFCb83D846af159b9c653240426841AEB414`](https://etherscan.io/address/0xb6E4CFCb83D846af159b9c653240426841AEB414) | `contracts/src/GaugeController.sol` | Live |
| **VoteIncentives** — Bribes market for gauge voters. | [`0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A`](https://etherscan.io/address/0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A) | `contracts/src/VoteIncentives.sol` | Live |
| **CommunityGrants** — Grant disbursement multisig with milestone gating. | [`0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032`](https://etherscan.io/address/0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032) | `contracts/src/CommunityGrants.sol` | Live |
| **MemeBountyBoard** — On-chain bounties for meme submissions, voted by veTOWELI. | [`0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9`](https://etherscan.io/address/0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9) | `contracts/src/MemeBountyBoard.sol` | Live |

---

## NFT Finance

| Contract | Address | Source | Status |
|---|---|---|---|
| **TegridyLending** — ERC20 money market collateralized by TOWELI and LP tokens. | [`0xd471e5675EaDbD8C192A5dA2fF44372D5713367f`](https://etherscan.io/address/0xd471e5675EaDbD8C192A5dA2fF44372D5713367f) | `contracts/src/TegridyLending.sol` | Live |
| **TegridyNFTLending** — NFT-backed peer-to-pool loans against JBAC/Gold and approved collections. | [`0x63baD13f89186E0769F636D4Cd736eB26E2968aD`](https://etherscan.io/address/0x63baD13f89186E0769F636D4Cd736eB26E2968aD) | `contracts/src/TegridyNFTLending.sol` | Live |
| **TegridyNFTPoolFactory** — Deploys isolated NFT lending pools per collection. | [`0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0`](https://etherscan.io/address/0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0) | `contracts/src/TegridyNFTPoolFactory.sol` | Live |
| **TegridyTokenURIReader** — Fallback tokenURI resolver for non-standard ERC721s. | [`0x0f165D012fA46E267Bd846BdAFf9Fd4607fdD702`](https://etherscan.io/address/0x0f165D012fA46E267Bd846BdAFf9Fd4607fdD702) | `contracts/src/TegridyTokenURIReader.sol` | Live |
| **TegridyDrop** — Per-drop ERC721 template deployed by the Launchpad. | _per-drop clones_ | `contracts/src/TegridyDrop.sol` | Live (template) |
| **TegridyLaunchpad** — NFT launch factory that clones TegridyDrop. | [`0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2`](https://etherscan.io/address/0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2) | `contracts/src/TegridyLaunchpad.sol` | Live |

---

## Premium / Access

| Contract | Address | Source | Status |
|---|---|---|---|
| **PremiumAccess** — Subscription gate for premium features; accepts TOWELI + JBAC passes. | [`0xaA16dF3dC66c7A6aD7db153711329955519422Ad`](https://etherscan.io/address/0xaA16dF3dC66c7A6aD7db153711329955519422Ad) | `contracts/src/PremiumAccess.sol` | Live |

---

## External Dependencies

| Contract | Address | Purpose | Status |
|---|---|---|---|
| **WETH9** | [`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`](https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2) | Canonical wrapped ETH. | Live (external) |
| **Uniswap V2 Factory** | [`0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`](https://etherscan.io/address/0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f) | Fallback AMM factory. | Live (external) |
| **Uniswap V2 Router02** | [`0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`](https://etherscan.io/address/0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D) | External routing fallback. | Live (external) |
| **TOWELI/WETH Uniswap V2 LP** | [`0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D`](https://etherscan.io/address/0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D) | External LP token (GeckoTerminal pair). | Live (external) |
| **Chainlink ETH/USD Feed** | [`0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`](https://etherscan.io/address/0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419) | USD pricing for lending/LTV. | Live (external) |
| **JBAC NFT** | [`0xd37264c71e9af940e49795F0d3a8336afAaFDdA9`](https://etherscan.io/address/0xd37264c71e9af940e49795F0d3a8336afAaFDdA9) | Jungle Bay Ape Club — grants +0.5x staking bonus. | Live (external) |
| **JBAY Gold Card** | [`0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3`](https://etherscan.io/address/0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3) | Premium access pass. | Live (external) |
| **Treasury (multisig)** | [`0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e`](https://etherscan.io/address/0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e) | Protocol treasury wallet. | Live |

---

## Notes

- **TegridyFeeHook** is the only core contract not yet on chain; deployment is blocked on CREATE2 salt mining to land the hook at a canonical hook address.
- The v1 `TegridyStaking` at `0x65D8…` remains paused and should not be surfaced in the UI.
- Source of truth for all addresses is `frontend/src/lib/constants.ts`. Update this file alongside any constants change.
