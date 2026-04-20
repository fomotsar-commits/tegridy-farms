# Contract Migration History

Tegridy Farms has been through multiple deployments as audit findings were addressed. This document is the single source of truth for which address is canonical, which are deprecated, and why each migration happened. **If you find an old address referenced anywhere, check here first.**

For the current canonical set, see [`frontend/src/lib/constants.ts`](../frontend/src/lib/constants.ts) and the README [Deployed contracts](../README.md#deployed-contracts-ethereum-mainnet) section.

---

## Staking

| Address | Status | Migration reason |
|---|---|---|
| `0x626644523d34B84818df602c991B4a06789C4819` | **CANONICAL** | Current audit-fixed v2 deployment (C-01 Spartan TF-01 fix applied). |
| `0x65D8b87917c59a0B33009493fB236bCccF1Ea421` | Deprecated, paused | v1 contract paused after Spartan C-01 finding (ABI mismatch exploiting boost calculation). Users migrated manually. Do not interact. |
| `0x00fd53d6d65db8a6edf34372ea4054c4f9fa8079` | Deprecated (pre-audit) | Early DeployFinal attempt; superseded before production TVL. |

## Restaking

| Address | Status | Migration reason |
|---|---|---|
| `0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4` | **CANONICAL** | Current deployment paired with canonical staking. |
| `0xfE2E5b534CFC3b35773Aa26a73bEF16b028b0268` | Deprecated | Earlier version from DeployAuditFixes batch. |
| `0xeD73d8836D04eAB05c36a5c2DAE90d2A73F8Ec76` | Deprecated | DeployFinal attempt. |

## Native DEX

| Address | Status | Migration reason |
|---|---|---|
| TegridyFactory `0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6` | **CANONICAL** | — |
| TegridyRouter `0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F` | **CANONICAL** | v2 with refactored fee routing. |
| TegridyRouter `0xe9a4fb4bb72254f420a2585ab8abac3a816c215e` | Deprecated | v1 router, superseded by v2. |
| TegridyLP (TOWELI/WETH) `0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6` | **CANONICAL** | Uniswap V2-style pair. |

## Revenue & fees

| Address | Status | Migration reason |
|---|---|---|
| RevenueDistributor `0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8` | **CANONICAL** | — |
| RevenueDistributor `0xf00964d5f5fb0a4d4afea0999843da31bbe9a7af` | Deprecated | DeployAuditFixes batch; superseded. |
| SwapFeeRouter `0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0` | **CANONICAL** | — |
| SwapFeeRouter `0xd8f13c7f3e0c4139d1905914a99f2e9f77a4ad37` | Deprecated | DeployAuditFixes batch. |
| SwapFeeRouter `0x71eaeca0f75ca3d4c757b27825920e3d0fa839bd` | Deprecated | SwapFeeRouter V2 attempt. |
| SwapFeeRouter `0xc63a4824191ea415a41995de6e9cbedbc8c51436` | Deprecated | DeployV3 attempt. |
| POLAccumulator `0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca` | **CANONICAL** | — |

## Community

| Address | Status | Migration reason |
|---|---|---|
| CommunityGrants `0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032` | **CANONICAL** | — |
| CommunityGrants `0xeb00fb134699634215ebf5ea3a4d6ff3872a5b34` | Deprecated | DeployAuditFixes batch. |
| CommunityGrants `0xd418a6fefec2fe1e2fe65339019e3bb8d3dadfd6` | Deprecated | DeployV3 attempt. |
| MemeBountyBoard `0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9` | **CANONICAL** | — |
| MemeBountyBoard `0xad9b32272376774d18f386a7676bd06d7e33c647` | Deprecated | DeployAuditFixes batch. |
| ReferralSplitter `0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16` | **CANONICAL** | — |
| ReferralSplitter `0x2ade96633ee51400e60de00f098280f07b92b060` | Deprecated | DeployAuditFixes batch. |
| PremiumAccess `0xaA16dF3dC66c7A6aD7db153711329955519422Ad` | **CANONICAL** | — |
| PremiumAccess `0x514553eacfcb91e05db0a5e9b09d69d7e9cbaf20` | Deprecated | DeployAuditFixes batch. |
| PremiumAccess `0x2a44cbebf23ff4a36f9cabdd716fa0bee481c60d` | Deprecated | DeployV3 attempt. |

## Governance

| Address | Status | Migration reason |
|---|---|---|
| GaugeController `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` | **CANONICAL** | Wave 0 redeploy 2026-04-18 — H-2 commit-reveal voting (closes bribe arbitrage). |
| GaugeController `0xb6E4CFCb83D846af159b9c653240426841AEB414` | Deprecated | Pre-commit-reveal version. Do not interact — vulnerable to last-epoch bribe sniping. |
| VoteIncentives `0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A` | **CANONICAL** | — |
| VoteIncentives `0xa799911f0b127044c72c1b7d79e8c9cd76c7d797` | Deprecated | Initial deployment. |

## V3 features

| Address | Contract | Status |
|---|---|---|
| `0xd471e5675EaDbD8C192A5dA2fF44372D5713367f` | TegridyLending | CANONICAL |
| `0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2` | TegridyLaunchpad (v1) | **DEPRECATED 2026-04-19** — source deleted; V1 clones remain live on-chain, readable via V2 Drop ABI (strict superset). Use `TegridyLaunchpadV2` going forward. |
| `0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0` | TegridyNFTPoolFactory | CANONICAL |
| `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139` | TegridyNFTLending | CANONICAL (Wave 0 redeploy 2026-04-18 — C-02 grace period) |
| `0x63baD13f89186E0769F636D4Cd736eB26E2968aD` | TegridyNFTLending (pre-C-02) | Deprecated |
| `0xfec9aea42ea966c9382eeb03f63a784579841eb2` | TegridyTokenURIReader | CANONICAL (Wave 0 redeploy 2026-04-18 — points at v2 staking) |
| `0x0f165D012fA46E267Bd846BdAFf9Fd4607fdD702` | TegridyTokenURIReader (pre-Wave 0) | Deprecated |
| `0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995` | TegridyTWAP | CANONICAL (Wave 0 redeploy 2026-04-18) |
| `0x1394A256e127814B52244Bbd0CCB94f0007dBe25` | TegridyTWAP (pre-Wave 0) | Deprecated |
| `0xd36ada65d8f08de6f7030e0b50b8b2358c2ca0b3` | TegridyDrop template (cloned per collection) | **DEPRECATED 2026-04-19** — V1 source deleted. V2 drop template (`TegridyDropV2`) auto-deploys with the V2 factory constructor. |
| `0x0728cbcde03d617b26d8c27199436bdfa22d547b` | TegridyNFTPool template (cloned per collection) | CANONICAL |

## Farming & fees (Wave 0)

| Address | Contract | Status |
|---|---|---|
| `0xa7EF711Be3662B9557634502032F98944eC69ec1` | TegridyLPFarming | CANONICAL (Wave 0 redeploy 2026-04-18 — C-01 `MAX_BOOST_BPS_CEILING=45000`) |
| `0xa5AB522C99F86dEd9F429766872101c75517D77c` | TegridyLPFarming (pre-C-01) | Deprecated |
| `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` | TegridyFeeHook | Live 2026-04-18, **owner stranded** on Arachnid CREATE2 proxy. Source patched to accept `_owner`; redeploy pending. Do not rely on admin functions until redeploy. |

## V2 Launchpad (compiled, not yet deployed)

> **Update 2026-04-19:** V1 TegridyLaunchpad + TegridyDrop source was deleted.
> V2 is now the only launchpad source tree; V1 clones on mainnet remain live
> and readable via the V2 Drop ABI (strict superset at the read surface).

| Contract | Status |
|---|---|
| TegridyLaunchpadV2 | Foundry tests pass; placeholder `0x0…0` in `constants.ts` until broadcast. |
| TegridyDropV2 | Per-clone template auto-deployed by the V2 factory constructor. |

---

## Wave 0 outstanding work (mirror of /contracts badges)

The `/contracts` page surfaces four badge types that map 1:1 to these
buckets. This table is the single authoritative list — if you update one,
update the other.

### `pending deploy` — not broadcast yet

| Contract | Source | Script | Reason |
|---|---|---|---|
| `TegridyLaunchpadV2` | `contracts/src/TegridyLaunchpadV2.sol` | `DeployLaunchpadV2.s.sol` | Click-deploy factory with ERC-7572 `contractURI()` — frontend wizard final step gates on `isDeployed()` until broadcast. |

### `redeploy queued` — live, but source patched for an audit finding

| Contract | Current address | Script | Patch |
|---|---|---|---|
| `TegridyFeeHook` | `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` | `DeployTegridyFeeHook.s.sol` (now consumes `cast create2` salt) | Constructor accepts `_owner` instead of `msg.sender`. Initial deploy stranded ownership on Arachnid CREATE2 proxy `0x4e59b44…`. |
| `VoteIncentives` | `0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A` | `DeployVoteIncentives.s.sol` | Partner the Wave 0 commit-reveal GaugeController (H-2). Existing bytecode points at the deprecated pre-commit-reveal controller. |
| `TegridyLending` | `0xd471e5675EaDbD8C192A5dA2fF44372D5713367f` | Per-contract deploy script | Redeploy (formerly paired with V1 refund-flow bundle; V1 retired 2026-04-19). |
| ~~`TegridyLaunchpad (V1)`~~ | ~~`0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2`~~ | ~~`DeployV3Features.s.sol`~~ | **RETIRED 2026-04-19.** V1 launchpad + drop template source deleted; `TegridyLaunchpadV2` and `TegridyDropV2` now carry the refund-flow surface. |
| `TegridyNFTPoolFactory` | `0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0` | Per-contract deploy script | Factory redeploy queued (formerly in V3Features bundle). |
| ~~`TegridyDrop` template~~ | ~~`0xd36ada65d8f08de6f7030e0b50b8b2358c2ca0b3`~~ | ~~(side-effect of V3Features)~~ | **RETIRED 2026-04-19** — replaced by `TegridyDropV2`, which already carries the H-10 refund-flow surface (`MintPhase.CANCELLED`, `cancelSale()`, `refund()`, `paidPerWallet`). |
| `TegridyNFTPool` template | `0x0728cbcde03d617b26d8c27199436bdfa22d547b` | Per-contract deploy script | Factory re-wire; template source is stable. |

**Blockers:** deployer `0xaA0caB9826f714A7be8FAC8fC98e87Fc27A54512` needs an
ETH top-up (~0.013 ETH across both scripts) before the bundle + incentives
can broadcast.

### `awaiting multisig` — Wave 0 address is live; owner not yet accepted

Multisig `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe` must call
`acceptOwnership()` on each before owner-only functions unlock.

| Contract | Address |
|---|---|
| `TegridyLPFarming` | `0xa7EF711Be3662B9557634502032F98944eC69ec1` |
| `TegridyNFTLending` | `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139` |
| `GaugeController` | `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` |

(Wave 0 `TokenURIReader` and `TegridyTWAP` are stateless and carry no
owner. `TegridyFeeHook` is in `redeploy queued` — its current owner is the
Arachnid proxy, not the multisig.)

### Post-deploy wiring (no badge, but required for launch)

- `LPFarming`: `TOWELI.approve(farm, amount)` + `farm.notifyRewardAmount(amount)` — fund first 7-day reward epoch.
- `TegridyStaking`: `proposeLendingContract(TEGRIDY_NFT_LENDING, true)` → wait 48h → `executeLendingContract()`.
- `TegridyStaking`: same 2-step for the new `TegridyLending` from V3Features once it redeploys.
- `GaugeController`: `proposeAddGauge(lpFarmAddress)` → wait 24h → `executeAddGauge()` per gauge.
- `VoteIncentives` (when redeployed): whitelist TOWELI + WETH via the built-in propose/execute pair (24h per change, one at a time).
- `SwapFeeRouter`: `proposePremiumAccessChange(PremiumAccess)` + `proposePremiumDiscountChange(5000)` after VoteIncentives lands.

### Etherscan verification follow-up

All six Wave 0 broadcasts on 2026-04-18 failed auto-verify because
`ETHERSCAN_API_KEY` in `contracts/.env` is `Invalid API Key (#err2)|14`.
Regenerate at <https://etherscan.io/myapikey> and re-run `forge
verify-contract <addr> <contract> --etherscan-api-key $KEY` per contract.

---

## Orphans & abandoned deployments

See [DEPRECATED_CONTRACTS.md](DEPRECATED_CONTRACTS.md) for contracts that have live bytecode on-chain but are **not** part of the canonical protocol (e.g. `TegridyFarm`, `FeeDistributor`, `WithdrawalFee`).

---

## Process for future migrations

1. Deploy new contract via forge script.
2. Wire new address to any consumers (via `setX()` calls with timelock where applicable).
3. Pause the old contract (if pausable).
4. Update [constants.ts](../frontend/src/lib/constants.ts) + [README.md](../README.md) addresses in the same commit.
5. Add a row to the table above.
6. Post a notice in the release changelog ([CHANGELOG.md](../CHANGELOG.md)) pointing to this file.

*Last updated: 2026-04-19 (Wave 0 outstanding-work section added; contract badges surfaced on /contracts to match).*
