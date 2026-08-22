# Contract Migration History

Tegridy Farms has been through multiple deployments as audit findings were addressed. This document records which address is canonical, which are deprecated, and why each migration happened. **If you find an old address referenced anywhere, check here first.**

**Verified 2026-08-06** against `contracts/broadcast/<Script>.s.sol/1/run-latest.json` and a live
`cast code` / `cast call` read. The previous revision of this file certified the **pre-relaunch**
set — including the withdraw-only staking vault `0x6266…4819` as CANONICAL — and had not been
refreshed through the **2026-06-06 relaunch (`DeployMVP`)** or the **2026-07-16 gated batch**.

> ⚠️ **Deprecated does not mean dead.** Every address on the deprecated rows below still has
> bytecode on mainnet and most are unpaused, so nothing on-chain refuses your transaction. In
> particular `VoteIncentives.setGaugeController` is a **one-shot** setter whose only check is that
> the target has code — pointing it at the Wave-0 GaugeController `0xb93264aB…`, whose
> `pairToGauge(address)` reverts, permanently bricks the bribe market with no recovery path.

For the addresses the app wires, see [`frontend/src/lib/constants.ts`](../frontend/src/lib/constants.ts)
— but note that `GAUGE_CONTROLLER_ADDRESS`, `VOTE_INCENTIVES_ADDRESS`, `COMMUNITY_GRANTS_ADDRESS`
and `MEME_BOUNTY_BOARD_ADDRESS` are deliberately zeroed there as a **UI gate**. Those contracts are
deployed and unpaused; the zero means "not surfaced", not "not deployed". The full live index is
[`CONTRACTS.md`](../CONTRACTS.md).

---

## Staking

| Address | Status | Migration reason |
|---|---|---|
| `0xcaDc93E96De58EA554c71ca609974625615E046D` | **CANONICAL** | Relaunch deployment, 2026-06-06 `DeployMVP`. Read back: `paused() == false`, `treasury() == 0x7D26…Bd7d`. Sisters: `TegridyStakingAdmin 0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3`, `TegridyStakingJbacVault 0x28317bF362d43B40fcECebF2390C43dB558c3F14`, `StakingMonitorView 0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC`. |
| `0x626644523d34B84818df602c991B4a06789C4819` | Legacy — **WITHDRAW-ONLY** | Pre-relaunch vault. **Was previously listed here as CANONICAL, which it is not.** Still holds user positions and is **unpaused**, so it will accept a deposit — never route stake/approve traffic to it. Exit only, via `<LegacyStakingExit />`. |
| `0x044A925839ac3CEC0bccC93d00230f39FFbeEe44` | Legacy — **WITHDRAW-ONLY** | Same: holds positions, unpaused, exit only. |
| `0x65D8b87917c59a0B33009493fB236bCccF1Ea421` | Deprecated, paused | v1 contract paused after Spartan C-01 finding (ABI mismatch exploiting boost calculation). Users migrated manually. Do not interact. |
| `0x00fd53d6d65db8a6edf34372ea4054c4f9fa8079` | Deprecated (pre-audit) | Early DeployFinal attempt; superseded before production TVL. |

## Restaking

| Address | Status | Migration reason |
|---|---|---|
| _none_ | **NOT DEPLOYED** | Deferred to the EIP-170 split phase. `TEGRIDY_RESTAKING_ADDRESS` is `0x0…0`; no post-relaunch restaking contract exists. |
| `0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4` | Deprecated | Pre-relaunch deployment, paired with the retired staking vault. |
| `0xfE2E5b534CFC3b35773Aa26a73bEF16b028b0268` | Deprecated | Earlier version from DeployAuditFixes batch. |
| `0xeD73d8836D04eAB05c36a5c2DAE90d2A73F8Ec76` | Deprecated | DeployFinal attempt. |

## Native DEX

| Address | Status | Migration reason |
|---|---|---|
| TegridyFactory `0xa24C7287eC56A7DEFDc70033803451240e267a52` | **CANONICAL** | Relaunch 2026-06-06. |
| TegridyRouter `0xE9F83A07b071748E795d2489651d5310fA098Db8` | **CANONICAL** | Relaunch 2026-06-06. |
| TegridyLP (TOWELI/WETH) `0x55875887B43C2E23aE424AF0FC8606Fdb058a481` | **CANONICAL** | Pair created by the relaunch factory. Read back: `token0()` = TOWELI, `token1()` = WETH, `factory()` = `0xa24C…7a52`. |
| TegridyFactory `0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6` | Deprecated | Pre-relaunch factory. |
| TegridyRouter `0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F` | Deprecated | Pre-relaunch v2 router. |
| TegridyRouter `0xe9a4fb4bb72254f420a2585ab8abac3a816c215e` | Deprecated | v1 router. |
| TegridyLP `0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6` | Deprecated | Pre-relaunch pair. |

## Revenue & fees

| Address | Status | Migration reason |
|---|---|---|
| RevenueDistributor `0xF993316E2fC079de4358c489A935E01e03E23E17` | **CANONICAL** | Relaunch 2026-06-06. |
| SwapFeeRouter `0x6d5791A660e79175F74C6D639584C98422d5956E` | **CANONICAL** | Relaunch 2026-06-06. Read back: `feeBps() == 50`, `stakerShareBps() == 10000`, `polShareBps() == 0`. **Has collected fee ETH and distributed none** — the take is parked in `ReferralSplitter` behind an uncalled `recoverCallerCredit()` (corrected 2026-08-12; this row previously said no fee had ever accrued). Admin sister `SwapFeeRouterAdmin 0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060`. |
| POLAccumulator `0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2` | Deployed, **not wired** | Relaunch 2026-06-06, but `SwapFeeRouter.polAccumulator()` still reads `0x0…0`. |
| ReferralSplitter `0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c` | **CANONICAL** | Relaunch 2026-06-06. |
| LockerClaimer `0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7` | **CANONICAL** | Deployed 2026-08-01 to give the pull-based Doppler fee locker a `msg.sender` it can actually pay. No admin surface; destinations immutable. |
| RevenueDistributor `0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8` | Deprecated | Pre-relaunch. |
| RevenueDistributor `0xf00964d5f5fb0a4d4afea0999843da31bbe9a7af` | Deprecated | DeployAuditFixes batch; superseded. |
| SwapFeeRouter `0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0` | Deprecated | Pre-relaunch. |
| SwapFeeRouter `0xd8f13c7f3e0c4139d1905914a99f2e9f77a4ad37` | Deprecated | DeployAuditFixes batch. |
| SwapFeeRouter `0x71eaeca0f75ca3d4c757b27825920e3d0fa839bd` | Deprecated | SwapFeeRouter V2 attempt. |
| SwapFeeRouter `0xc63a4824191ea415a41995de6e9cbedbc8c51436` | Deprecated | DeployV3 attempt. |
| POLAccumulator `0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca` | Deprecated | Pre-relaunch. |
| ReferralSplitter `0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16` | Deprecated | Pre-relaunch. |
| ReferralSplitter `0x2ade96633ee51400e60de00f098280f07b92b060` | Deprecated | DeployAuditFixes batch. |

## Community & access

Deployed 2026-07-16. All three read back with bytecode, `paused() == false` and
`owner() == 0x14898258122C0740106391E6e8E4F17F3b6d456E` (an EOA — no code).

| Address | Status | Migration reason |
|---|---|---|
| CommunityGrants `0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471` | **CANONICAL** | 2026-07-16 batch. |
| MemeBountyBoard `0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890` | **CANONICAL** | 2026-07-16 batch. `bountyCount() == 0`. |
| PremiumAccess `0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5` | **CANONICAL** | 2026-07-16 batch. This is the address `constants.ts` wires. |
| CommunityGrants `0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032` | Deprecated | Pre-relaunch. |
| CommunityGrants `0xeb00fb134699634215ebf5ea3a4d6ff3872a5b34` | Deprecated | DeployAuditFixes batch. |
| CommunityGrants `0xd418a6fefec2fe1e2fe65339019e3bb8d3dadfd6` | Deprecated | DeployV3 attempt. |
| MemeBountyBoard `0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9` | Deprecated | Pre-relaunch. |
| MemeBountyBoard `0xad9b32272376774d18f386a7676bd06d7e33c647` | Deprecated | DeployAuditFixes batch. |
| PremiumAccess `0xaA16dF3dC66c7A6aD7db153711329955519422Ad` | Deprecated | Pre-relaunch V1. |
| PremiumAccess `0x514553eacfcb91e05db0a5e9b09d69d7e9cbaf20` | Deprecated | DeployAuditFixes batch. |
| PremiumAccess `0x2a44cbebf23ff4a36f9cabdd716fa0bee481c60d` | Deprecated | DeployV3 attempt. |

## Governance

Deployed 2026-07-16 (`DeployGaugeController.s.sol`, `DeployVoteIncentives.s.sol`). Both read back
unpaused with `owner() == 0x14898258122C0740106391E6e8E4F17F3b6d456E`.

| Address | Status | Migration reason |
|---|---|---|
| GaugeController `0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054` | **CANONICAL** | 2026-07-16 redeploy. `gaugeCount() == 0` — no gauge registered yet — and `pairToGauge(address)` answers normally. |
| VoteIncentives `0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF` | **CANONICAL** | 2026-07-16 redeploy, with admin sister `VoteIncentivesAdmin 0xf87Ec231BA7FA3975619309bc16C698B2ea3B300` wired in the same broadcast. `gaugeController()` is still `0x0…0`. |
| GaugeController `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` | Deprecated — **DANGEROUS** | Wave 0 2026-04-18. `pairToGauge(address)` **REVERTS** (confirmed on mainnet 2026-08-06). It has code, so `VoteIncentives.setGaugeController` accepts it and latches forever; every later bribe deposit then reverts inside `_requireGaugedPair`. **Was previously listed here as CANONICAL.** Never wire it. |
| GaugeController `0xb6E4CFCb83D846af159b9c653240426841AEB414` | Deprecated | Pre-commit-reveal version. Do not interact — vulnerable to last-epoch bribe sniping. |
| VoteIncentives `0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A` | Deprecated | Wave 0 deployment, superseded 2026-07-16. |
| VoteIncentives `0xa5a974dac4b9f8168cd3fac727997e66522f5b43` | Deprecated | Interim Wave 0 broadcast. |
| VoteIncentives `0xa799911f0b127044c72c1b7d79e8c9cd76c7d797` | Deprecated | Initial deployment. |

## Lending, NFT finance, launchpad

| Address | Contract | Status |
|---|---|---|
| `0x89BeB6cc0255B7465c01aA38a6f937efd345f14F` | TegridyNFTLending | **CANONICAL** (2026-07-16; admin sister `0x693787831e9C36A98afeDaD39F8728491f580a9C`) |
| `0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B` | TegridyNFTPoolFactory | **CANONICAL** (2026-07-16; `owner()` = `0xA360…b7F8`, a 2-of-3 Safe — unlike the rest of the batch) |
| `0x5cfEe751eAf274F68b05267012b85a867dfCd326` | TegridyTokenURIReader | **CANONICAL** (relaunch 2026-06-06) |
| `0xdFdd6D72539A425dC917F49FB834901105cA98c9` | TegridyTWAP | **CANONICAL** (relaunch 2026-06-06) |
| `0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7` | TegridyLaunchpadV2 | **CANONICAL** (2026-07-16) — the "compiled, not yet deployed" note in earlier revisions of this file is obsolete |
| _none_ | TegridyLending | **NOT DEPLOYED** — `TEGRIDY_LENDING_ADDRESS` is `0x0…0`; not redeployed after the relaunch |
| `0xd471e5675EaDbD8C192A5dA2fF44372D5713367f` | TegridyLending | Deprecated (pre-relaunch) |
| `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139` | TegridyNFTLending | Deprecated (pre-relaunch, Wave 0) |
| `0x63baD13f89186E0769F636D4Cd736eB26E2968aD` | TegridyNFTLending (pre-C-02) | Deprecated |
| `0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0` | TegridyNFTPoolFactory | Deprecated (pre-relaunch) |
| `0xfec9aea42ea966c9382eeb03f63a784579841eb2` | TegridyTokenURIReader | Deprecated (pre-relaunch, Wave 0) |
| `0x0f165D012fA46E267Bd846BdAFf9Fd4607fdD702` | TegridyTokenURIReader (pre-Wave 0) | Deprecated |
| `0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995` | TegridyTWAP | Deprecated (pre-relaunch, Wave 0) |
| `0x1394A256e127814B52244Bbd0CCB94f0007dBe25` | TegridyTWAP (pre-Wave 0) | Deprecated |
| `0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2` | TegridyLaunchpad (v1) | Deprecated 2026-04-19 — source deleted; v1 clones remain readable on-chain via the V2 Drop ABI (a strict superset) |
| `0xd36ada65d8f08de6f7030e0b50b8b2358c2ca0b3` | TegridyDrop template (v1) | Deprecated 2026-04-19 — replaced by `TegridyDropV2`, which carries the H-10 refund-flow surface (`MintPhase.CANCELLED`, `cancelSale()`, `refund()`, `paidPerWallet`) |
| `0x0728cbcde03d617b26d8c27199436bdfa22d547b` | TegridyNFTPool template (v1) | Deprecated — the 2026-07-16 factory ships its own pool template |

## Farming & fees

| Address | Contract | Status |
|---|---|---|
| `0x1171268AE5B69791c47Fd589b7825932c957e149` | TegridyLPFarming | **CANONICAL** (2026-06-08 `DeployTegridyLPFarming`). Read back: `stakingToken()` = `0x5587…a481`, `rewardToken()` = TOWELI, `MAX_BOOST_BPS_CEILING() == 45000`. |
| `0xa7EF711Be3662B9557634502032F98944eC69ec1` | TegridyLPFarming (Wave 0) | Deprecated — staked against the pre-relaunch pair |
| `0xa5AB522C99F86dEd9F429766872101c75517D77c` | TegridyLPFarming (pre-C-01) | Deprecated |
| `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` | TegridyFeeHook | On chain since 2026-04-18, **owner stranded** — `owner()` reads `0x4e59b448…`, the Arachnid CREATE2 proxy, so every admin function is unreachable. Source patched to accept `_owner`; redeploy pending. Do not rely on its admin functions. |

## Treasury

| Address | Status | Notes |
|---|---|---|
| `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d` | **CANONICAL** | Safe, `getThreshold() == 2` over 2 owners. It is what `SwapFeeRouter.treasury()` and `TegridyStaking.treasury()` both return, and where the flat 25% early-exit penalty lands. |
| `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` | Deprecated | Pre-relaunch treasury. It is an EOA carrying an EIP-7702 delegation designator (`code == 0xef0100…`) and one of the two owners of the Safe above — it was never itself a multisig. |

---

## Outstanding wiring

### `VoteIncentives` → `GaugeController` (one-shot — get it right the first time)

`VoteIncentives.setGaugeController(address)` reverts `GaugeControllerAlreadySet` on any second call
and its only validation is `code.length > 0 && code.length != 23`. There is no unset path and no
admin override.

- **The only correct argument is `0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054`.**
- Confirm `VoteIncentives.gaugeController()` still returns `0x0…0` before calling.
- Confirm the target answers `pairToGauge(<any address>)` **without reverting** — that single read
  is what separates the live controller from the Wave-0 one.

### Other post-deploy wiring

- `GaugeController`: `proposeAddGauge(lpFarmAddress)` → wait 24h → `executeAddGauge()` per gauge. Until then `gaugeCount()` stays `0`, and a wired `VoteIncentives` rejects every bribe because no pair has a gauge.
- `VoteIncentives`: whitelist TOWELI + WETH via the built-in propose/execute pair (24h per change, one at a time).
- `LPFarming`: `TOWELI.approve(farm, amount)` + `farm.notifyRewardAmount(amount)` to fund a reward epoch.
- `TegridyStaking`: `proposeLendingContract(TEGRIDY_NFT_LENDING, true)` → wait 48h → `executeLendingContract()`.
- `SwapFeeRouter`: `proposePremiumAccessChange(PremiumAccess)` + `proposePremiumDiscountChange(5000)`.
- `SwapFeeRouter`: `polAccumulator` is unset (`0x0…0`). It must be wired before any non-zero POL share is proposed, or the lever has no destination.

### Ownership

Most protocol contracts read `owner() == 0x14898258122C0740106391E6e8E4F17F3b6d456E`, which has **no
code** — a plain EOA, not a Safe. Moving those to a Safe is outstanding. The exceptions are
`TegridyNFTPoolFactory` (owner `0xA360…b7F8`, a 2-of-3 Safe) and `TegridyFeeHook` (owner stranded on
the Arachnid proxy).

### Etherscan verification

The six Wave 0 broadcasts on 2026-04-18 failed auto-verify because `ETHERSCAN_API_KEY` in
`contracts/.env` was rejected (`Invalid API Key (#err2)|14`). Regenerate at
<https://etherscan.io/myapikey> and re-run `forge verify-contract <addr> <contract>
--etherscan-api-key $KEY` per contract for anything still unverified.

---

## Orphans & abandoned deployments

See [DEPRECATED_CONTRACTS.md](DEPRECATED_CONTRACTS.md) for contracts that have live bytecode on-chain but are **not** part of the canonical protocol (e.g. `TegridyFarm`, `FeeDistributor`, `WithdrawalFee`).

---

## Process for future migrations

1. Deploy new contract via forge script.
2. Wire new address to any consumers (via `setX()` calls with timelock where applicable). **Check first whether the setter is one-shot.**
3. Pause the old contract (if pausable) — and if it is not pausable, say so here, because an unpausable deprecated contract will still accept user funds.
4. Update [constants.ts](../frontend/src/lib/constants.ts) + [CONTRACTS.md](../CONTRACTS.md) + [README.md](../README.md) addresses in the same commit.
5. Add a row to the tables above, and move the old address to a deprecated row in the same edit.
6. Post a notice in the release changelog ([CHANGELOG.md](../CHANGELOG.md)) pointing to this file.
7. Commit the refreshed `contracts/broadcast/**/run-latest.json`. The broadcast JSON on this branch is stale for the 2026-07-16 batch, which is precisely how this file drifted.

*Last verified: 2026-08-06 (broadcast + on-chain read-back). Regression guard: `frontend/src/lib/docsAddressTruth.test.ts`.*
