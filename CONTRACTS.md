# Tegridy Farms — Canonical Contract Index

Chain: Ethereum Mainnet (chainId 1). All addresses are EIP-55 checksummed. Etherscan links use `https://etherscan.io/address/...`.

**Verified 2026-08-06** against `contracts/broadcast/<Script>.s.sol/1/run-latest.json` and a live
`cast code` / `cast call` read of every row marked Live. The previous revision of this file was
generated from `constants.ts` on **2026-04-17** and had not been refreshed through either the
**2026-06-06 relaunch (`DeployMVP`)** or the **2026-07-16 gated batch** — every core address in it
was superseded. Pre-relaunch addresses are listed under [Superseded deployments](#superseded-deployments)
so an old reference can be traced, never mixed into the live set.

> ⚠️ **Operator warning.** Several superseded contracts still have bytecode on mainnet, so nothing
> on-chain stops you from wiring one. `VoteIncentives.setGaugeController` in particular is a
> **one-shot** setter (`if (gaugeController != address(0)) revert GaugeControllerAlreadySet();`)
> whose only check is that the target has code. Pointing it at the Wave-0 GaugeController
> `0xb93264aB…` — whose `pairToGauge(address)` **reverts** — permanently bricks bribe deposits with
> no recovery path. Copy addresses from the Live tables below, never from an older doc or commit.

> **`address(0)` in `frontend/src/lib/constants.ts` is a UI gate, not a deployment fact.**
> `GAUGE_CONTROLLER_ADDRESS`, `VOTE_INCENTIVES_ADDRESS`, `COMMUNITY_GRANTS_ADDRESS` and
> `MEME_BOUNTY_BOARD_ADDRESS` are all zeroed in `constants.ts` to keep the surfaces hidden in the
> app, yet the contracts below **are deployed, unpaused and owned**. Do not read a zero there as
> "not deployed"; read it as "not surfaced".

---

## Core Token + Staking

| Contract | Address | Source | Status |
|---|---|---|---|
| **TOWELI** — ERC20 governance/reward token, 1B minted once, no mint path. | [`0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`](https://etherscan.io/address/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D) | ⚠️ **not this repo's source** — see the note below | Live |
| **TegridyStaking** — veTOWELI lockup (7d–4y), 0.4x–4.0x boost, flat 25% early-exit penalty paid to the treasury, +0.5x JBAC bonus. | [`0xcaDc93E96De58EA554c71ca609974625615E046D`](https://etherscan.io/address/0xcaDc93E96De58EA554c71ca609974625615E046D) | `contracts/src/TegridyStaking.sol` | Live (relaunch 2026-06-06, `DeployMVP`) — `paused() == false`, `treasury() == 0x7D26…Bd7d` |
| **TegridyStakingAdmin** — EIP-170 admin sister of the staking vault. | [`0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3`](https://etherscan.io/address/0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3) | `contracts/src/TegridyStakingAdmin.sol` | Live (relaunch 2026-06-06) |
| **TegridyStakingJbacVault** — JBAC custody sister for the staking boost. | [`0x28317bF362d43B40fcECebF2390C43dB558c3F14`](https://etherscan.io/address/0x28317bF362d43B40fcECebF2390C43dB558c3F14) | `contracts/src/TegridyStakingJbacVault.sol` | Live (relaunch 2026-06-06) |
| **StakingMonitorView** — Read-only view sister (EIP-170 split). | [`0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC`](https://etherscan.io/address/0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC) | `contracts/src/StakingMonitorView.sol` | Live (relaunch 2026-06-06) |
| **TegridyRestaking** — Auto-compounding restake wrapper. | _not deployed_ | `contracts/src/TegridyRestaking.sol` | Deferred — `TEGRIDY_RESTAKING_ADDRESS` is `0x0…0`; the pre-relaunch instance is retired (see below). |

> 🔴 **The live TOWELI is not this repo's `Toweli.sol`.** Selector scan of `cast code` plus live
> `cast call`, 2026-08-12. The deployed contract names itself **`Towelie`** (symbol `Toweli`) and is a
> token-generator template, not the OZ-based source in `contracts/src/`. What is actually there:
> `burn(uint256)` ✅, `burnFrom(address,uint256)` ✅, Ownable2Step — `owner()`, `pendingOwner()`,
> `transferOwnership`, `acceptOwnership`, `renounceOwnership` — ✅ with `owner()` currently `0x0`
> (renounced). What is **absent**: `permit(...)`, `DOMAIN_SEPARATOR()`, `nonces(address)` (all three
> revert), and `mint(address,uint256)`. So the token is **not EIP-2612**, and it **is** burnable by any
> holder. `contracts/src/Toweli.sol` documents intended behaviour and is what a fresh deploy would
> produce; it is not what is at `0x420698…78F9D`. Verify against Etherscan's Contract tab, never
> against the repo file. Anything that reads a permit signature or assumes a fixed float off this
> address is wrong.

**Legacy staking vaults — WITHDRAW-ONLY.** Both still hold user positions and are **unpaused**
(read back 2026-08-06), so they accept deposits. Never route stake/approve traffic to them; the app
surfaces them through `<LegacyStakingExit />` for affected wallets only.

| Address | Status |
|---|---|
| [`0x044A925839ac3CEC0bccC93d00230f39FFbeEe44`](https://etherscan.io/address/0x044A925839ac3CEC0bccC93d00230f39FFbeEe44) | Legacy, withdraw-only (`constants.ts` `LEGACY_STAKING_ADDRESSES`) |
| [`0x626644523d34B84818df602c991B4a06789C4819`](https://etherscan.io/address/0x626644523d34B84818df602c991B4a06789C4819) | Legacy, withdraw-only — **was previously documented here as the canonical vault** |

---

## Native DEX

| Contract | Address | Source | Status |
|---|---|---|---|
| **TegridyFactory** — Uniswap V2-compatible pair factory for TOWELI markets. | [`0xa24C7287eC56A7DEFDc70033803451240e267a52`](https://etherscan.io/address/0xa24C7287eC56A7DEFDc70033803451240e267a52) | `contracts/src/TegridyFactory.sol` | Live (relaunch 2026-06-06) |
| **TegridyRouter** — Swap/add/remove liquidity router with fee-on-transfer support. | [`0xE9F83A07b071748E795d2489651d5310fA098Db8`](https://etherscan.io/address/0xE9F83A07b071748E795d2489651d5310fA098Db8) | `contracts/src/TegridyRouter.sol` | Live (relaunch 2026-06-06) |
| **TegridyLP (TOWELI/WETH pair)** — Native DEX LP token. | [`0x55875887B43C2E23aE424AF0FC8606Fdb058a481`](https://etherscan.io/address/0x55875887B43C2E23aE424AF0FC8606Fdb058a481) | `contracts/src/TegridyPair.sol` | Live — read back: `token0()` = TOWELI, `token1()` = WETH, `factory()` = `0xa24C…7a52` |
| **SwapFeeRouter** — Routes DEX swap fees to RevenueDistributor + POLAccumulator. | [`0x6d5791A660e79175F74C6D639584C98422d5956E`](https://etherscan.io/address/0x6d5791A660e79175F74C6D639584C98422d5956E) | `contracts/src/SwapFeeRouter.sol` | Live (relaunch 2026-06-06) — `feeBps() == 50`, `stakerShareBps() == 10000`, `polShareBps() == 0`. **Has collected fee ETH; has distributed none.** `accumulatedETHFees()` and `totalPendingDistribution()` are both `0` because the whole take is still parked in `ReferralSplitter` — see the revenue note below. |
| **SwapFeeRouterAdmin** — EIP-170 admin sister of the fee router. | [`0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060`](https://etherscan.io/address/0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060) | `contracts/src/SwapFeeRouterAdmin.sol` | Live (relaunch 2026-06-06) |
| **POLAccumulator** — Protocol-owned-liquidity sink; buys TOWELI and LPs it. | [`0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2`](https://etherscan.io/address/0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2) | `contracts/src/POLAccumulator.sol` | Deployed 2026-06-06 but **not wired** — `SwapFeeRouter.polAccumulator()` reads `0x0…0`, so no fee value can reach it today. |
| **TegridyTWAP** — Time-weighted average price oracle over native pairs. | [`0xdFdd6D72539A425dC917F49FB834901105cA98c9`](https://etherscan.io/address/0xdFdd6D72539A425dC917F49FB834901105cA98c9) | `contracts/src/TegridyTWAP.sol` | Live (relaunch 2026-06-06) — needs 4× `update()` bootstrap after LP seed (audit H-18) |
| **TegridyFeeHook** — Per-pair dynamic fee hook; address ends `0x0044` encoding `AFTER_SWAP`+`AFTER_SWAP_RETURNS_DELTA` V4 permissions. | [`0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044`](https://etherscan.io/address/0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044) | `contracts/src/TegridyFeeHook.sol` | On chain since 2026-04-18 — **owner stranded**: `owner()` reads `0x4e59b448…` (the Arachnid CREATE2 proxy), so every admin function is unreachable. Patched constructor accepts `_owner`; redeploy pending. |
| **TegridyLPFarming** — Boosted LP farming rewards vault. | [`0x1171268AE5B69791c47Fd589b7825932c957e149`](https://etherscan.io/address/0x1171268AE5B69791c47Fd589b7825932c957e149) | `contracts/src/TegridyLPFarming.sol` | Live (2026-06-08, `DeployTegridyLPFarming`) — `stakingToken()` = `0x5587…a481`, `rewardToken()` = TOWELI, `MAX_BOOST_BPS_CEILING() == 45000` |

---

## Revenue

| Contract | Address | Source | Status |
|---|---|---|---|
| **RevenueDistributor** — Streams protocol revenue pro-rata to veTOWELI stakers. | [`0xF993316E2fC079de4358c489A935E01e03E23E17`](https://etherscan.io/address/0xF993316E2fC079de4358c489A935E01e03E23E17) | `contracts/src/RevenueDistributor.sol` | Live (relaunch 2026-06-06) |
| **ReferralSplitter** — Sits between `SwapFeeRouter` and the staker rail: takes the referral share off the top, credits the remainder back. | [`0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c`](https://etherscan.io/address/0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c) | `contracts/src/ReferralSplitter.sol` | Live (relaunch 2026-06-06) — `referralFeeBps() == 2000`, `MAX_REFERRAL_FEE() == 3000`. **Holds the protocol's entire swap-fee take.** |
| **LockerClaimer** — Permissionless `claim(tokenId)` puller for the Doppler fee locker; forwards the ETH leg to RevenueDistributor, ERC20 leg to Treasury. | [`0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7`](https://etherscan.io/address/0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7) | `contracts/src/LockerClaimer.sol` | Live (2026-08-01) — no admin surface; destinations immutable |

---

## Governance

Deployed **2026-07-16**. Every row below was read back on 2026-08-06: bytecode present,
`paused() == false`, `owner() == 0x14898258122C0740106391E6e8E4F17F3b6d456E` (an EOA — it has no
code, so it is not a Safe).

| Contract | Address | Source | Status |
|---|---|---|---|
| **GaugeController** — veTOWELI-weighted gauge voting for emissions allocation. | [`0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054`](https://etherscan.io/address/0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054) | `contracts/src/GaugeController.sol` | Live — `gaugeCount() == 0` (no gauge registered yet); `pairToGauge(address)` answers normally |
| **VoteIncentives** — Bribes market for gauge voters. | [`0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF`](https://etherscan.io/address/0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF) | `contracts/src/VoteIncentives.sol` | Live — `gaugeController()` is still `0x0…0`. **`setGaugeController` is one-shot: the only correct argument is `0x6c79522D…1054`.** |
| **VoteIncentivesAdmin** — EIP-170 admin sister of VoteIncentives. | [`0xf87Ec231BA7FA3975619309bc16C698B2ea3B300`](https://etherscan.io/address/0xf87Ec231BA7FA3975619309bc16C698B2ea3B300) | `contracts/src/VoteIncentivesAdmin.sol` | Live — wired via `setVoteIncentivesAdmin` in the same broadcast |
| **CommunityGrants** — Grant disbursement with milestone gating. | [`0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471`](https://etherscan.io/address/0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471) | `contracts/src/CommunityGrants.sol` | Live |
| **MemeBountyBoard** — On-chain bounties for meme submissions, voted by veTOWELI. | [`0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890`](https://etherscan.io/address/0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890) | `contracts/src/MemeBountyBoard.sol` | Live — `bountyCount() == 0` |

---

## NFT Finance

| Contract | Address | Source | Status |
|---|---|---|---|
| **TegridyLending** — ERC20 money market collateralized by TOWELI and LP tokens. | _not deployed_ | `contracts/src/TegridyLending.sol` | Deferred — `TEGRIDY_LENDING_ADDRESS` is `0x0…0`; the pre-relaunch instance is retired (see below). |
| **TegridyNFTLending** — NFT-backed peer-to-pool loans against JBAC/Gold and approved collections. | [`0x89BeB6cc0255B7465c01aA38a6f937efd345f14F`](https://etherscan.io/address/0x89BeB6cc0255B7465c01aA38a6f937efd345f14F) | `contracts/src/TegridyNFTLending.sol` | Live (2026-07-16) — `paused() == false` |
| **TegridyNFTLendingAdmin** — EIP-170 admin sister. | [`0x693787831e9C36A98afeDaD39F8728491f580a9C`](https://etherscan.io/address/0x693787831e9C36A98afeDaD39F8728491f580a9C) | `contracts/src/TegridyNFTLendingAdmin.sol` | Live (2026-07-16) |
| **TegridyNFTPoolFactory** — Deploys isolated NFT lending pools per collection. | [`0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B`](https://etherscan.io/address/0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B) | `contracts/src/TegridyNFTPoolFactory.sol` | Live (2026-07-16) — `owner()` = `0xA360…b7F8` (differs from the rest of the batch) |
| **TegridyTokenURIReader** — Fallback tokenURI resolver for non-standard ERC721s. | [`0x5cfEe751eAf274F68b05267012b85a867dfCd326`](https://etherscan.io/address/0x5cfEe751eAf274F68b05267012b85a867dfCd326) | `contracts/src/TegridyTokenURIReader.sol` | Live (relaunch 2026-06-06) |
| **TegridyLaunchpadV2** — Click-deploy factory for V2 drops. | [`0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7`](https://etherscan.io/address/0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7) | `contracts/src/TegridyLaunchpadV2.sol` | Live (2026-07-16) — `paused() == false` |
| **TegridyDropV2** — Per-drop ERC721 template with `contractURI` (ERC-7572). | _per-drop clones_ | `contracts/src/TegridyDropV2.sol` | Template deployed with the V2 factory; clones minted per collection |

---

## Premium / Access

| Contract | Address | Source | Status |
|---|---|---|---|
| **PremiumAccess** — Subscription gate for premium features. | [`0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5`](https://etherscan.io/address/0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5) | `contracts/src/PremiumAccess.sol` | Live (2026-07-16) — `paused() == false`; this is the address `constants.ts` wires |

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
| **Treasury (Safe)** | [`0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`](https://etherscan.io/address/0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d) | Protocol treasury. Read back 2026-08-06: `getThreshold() == 2` over 2 owners. It is the address `SwapFeeRouter.treasury()` and `TegridyStaking.treasury()` both return. | Live |

---

## Superseded deployments

Listed only so an old reference can be traced. **Every one of these still has bytecode on
mainnet** — presence of code proves nothing about whether an address is current.

| Contract | Superseded address | Replaced by |
|---|---|---|
| GaugeController (Wave 0) | `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` — `pairToGauge(address)` **reverts**; wiring it into `VoteIncentives.setGaugeController` bricks the bribe market permanently | `0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054` |
| GaugeController (pre-commit-reveal) | `0xb6E4CFCb83D846af159b9c653240426841AEB414` — deprecated | `0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054` |
| VoteIncentives | `0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A` — deprecated | `0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF` |
| CommunityGrants | `0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032` — deprecated | `0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471` |
| MemeBountyBoard | `0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9` — deprecated | `0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890` |
| PremiumAccess (V1) | `0xaA16dF3dC66c7A6aD7db153711329955519422Ad` — deprecated | `0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5` |
| TegridyStaking | `0x626644523d34B84818df602c991B4a06789C4819` — legacy, withdraw-only (unpaused) | `0xcaDc93E96De58EA554c71ca609974625615E046D` |
| TegridyRestaking | `0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4` — retired with the relaunch | _not redeployed_ |
| TegridyFactory | `0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6` — deprecated | `0xa24C7287eC56A7DEFDc70033803451240e267a52` |
| TegridyRouter | `0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F` — deprecated | `0xE9F83A07b071748E795d2489651d5310fA098Db8` |
| TegridyLP pair | `0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6` — deprecated | `0x55875887B43C2E23aE424AF0FC8606Fdb058a481` |
| SwapFeeRouter | `0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0` — deprecated | `0x6d5791A660e79175F74C6D639584C98422d5956E` |
| RevenueDistributor | `0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8` — deprecated | `0xF993316E2fC079de4358c489A935E01e03E23E17` |
| POLAccumulator | `0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca` — deprecated | `0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2` |
| ReferralSplitter | `0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16` — deprecated | `0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c` |
| TegridyTWAP | `0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995` — deprecated | `0xdFdd6D72539A425dC917F49FB834901105cA98c9` |
| TegridyTokenURIReader | `0xfec9aea42ea966c9382eeb03f63a784579841eb2` — deprecated | `0x5cfEe751eAf274F68b05267012b85a867dfCd326` |
| TegridyLPFarming | `0xa5AB522C99F86dEd9F429766872101c75517D77c` (pre-C-01) and `0xa7EF711Be3662B9557634502032F98944eC69ec1` (Wave 0) — both deprecated | `0x1171268AE5B69791c47Fd589b7825932c957e149` |
| TegridyNFTLending | `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139` — deprecated | `0x89BeB6cc0255B7465c01aA38a6f937efd345f14F` |
| TegridyNFTPoolFactory | `0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0` — deprecated | `0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B` |
| TegridyLending | `0xd471e5675EaDbD8C192A5dA2fF44372D5713367f` — retired with the relaunch | _not redeployed_ |
| Treasury | `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` — an EOA carrying an EIP-7702 delegation designator (`code == 0xef0100…`), and one of the two owners of the live Safe. Never the treasury itself. | `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d` |

See [docs/MIGRATION_HISTORY.md](docs/MIGRATION_HISTORY.md) for why each migration happened and
[docs/DEPRECATED_CONTRACTS.md](docs/DEPRECATED_CONTRACTS.md) for orphaned bytecode that was never
part of the protocol.

---

## Notes

- `frontend/src/lib/constants.ts` is the wiring the app actually uses, and this file must be updated
  in the same commit as any change to it — but note the four zeroed governance/community constants
  above: for those, the broadcast artefacts plus an on-chain read are the source of truth.
- The broadcast JSON committed to this branch is **stale for the 2026-07-16 batch** — the refreshed
  `run-latest.json` files exist only in the operator's working checkout. Verify with `cast code`
  before acting on any address, in this file or any other.
- **The swap-fee rail has earned and has never distributed.** Do not describe staker yield in the past
  tense, and do not describe the rail as unused either — both were published here before. The
  mechanism, which does not go stale: `SwapFeeRouter._recordReferralFee` forwards the **whole** fee to
  `ReferralSplitter` at swap time; the splitter keeps `referralFeeBps` (2000) for the referrer or, with
  no qualified referrer, for the treasury — that slice is never staker yield — and credits the
  remaining ~80% back as `callerCredit`, which only moves on a **permissionless**
  `SwapFeeRouter.recoverCallerCredit()` call that has never been made. `RevenueDistributor` therefore
  holds `0` and `totalDistributed()` reads `0`: **zero epochs, zero claims, ever.** The splitter is also
  not removable — `proposeReferralFee` rejects `0` and `applyReferralSplitter(address(0))` reverts
  `ReferralFeeNonZero()` while the share is above zero. Quote the mechanism; a wei figure is stale after
  the next swap.
- The regression guard for this file lives at `frontend/src/lib/docsAddressTruth.test.ts`.

*Last verified: 2026-08-06 (broadcast + on-chain read-back).*
