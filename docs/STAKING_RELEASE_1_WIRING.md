# Staking release 1: what gets deployed, and every wiring step

**Status:** prepared 2026-10-14, NOT deployed. Nothing below has been sent to mainnet.
**Product change:** the early-exit fee of the NEW staking contract is **75%** of principal
(owner ruling 2026-10-14; the live contract charges 25%). Rewards are paid first and never
touched by the fee. The release also ships the source fixes for M-S6, M-S7 and M-G3
([findings](audits/audit_101/OPEN_FINDINGS_FIXED_IN_SOURCE_2026_10_14.md)).

**Signer for every step:** the owner key `0x14898258122C0740106391E6e8E4F17F3b6d456E`, which owns
every live contract today. New contracts are owned by their deployer, so ownership ends where it
is now. Each script refuses any other sender.

## Ten contracts, not nine

The findings doc listed nine and said `StakingRewardLib` could be reused. It cannot: the live
library (`0xb86A763a92A24e0951658E52d54CE50A5D52C1Ea`) predates five fixes and lacks 4 of the 7
functions the current `TegridyStaking` calls (`getReward`, `kick`, `settleRewardsOnTransfer`,
`claimUnsettledForTokenId`; selectors `151ae175`, `44e22c47`, `f83aa170`, `53042621` are absent
from its bytecode, read 2026-10-14). Linked to it, every claim, exit and NFT transfer would revert.
Forge deploys both libraries itself when the script runs, so do **not** pass `--libraries`.

| # | Contract | Replaces (live) | Constructor values (copied from the live contract) |
|---|---|---|---|
| L1 | StakingViewLib | `0x7c9d52CF71a1dff1D5D302E95e68Bce80191ab0E` | none (CREATE2 by forge) |
| L2 | StakingRewardLib | `0xb86A763a92A24e0951658E52d54CE50A5D52C1Ea` | none (CREATE2 by forge) |
| 1 | TegridyStaking (75%) | `0xcaDc93E96De58EA554c71ca609974625615E046D` | TOWELI `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`, JBAC `0xd37264c71e9af940e49795F0d3a8336afAaFDdA9`, treasury Safe `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`. **No reward rate** (owner 2026-10-18): it starts at 0 and step 2 sets it |
| 2 | TegridyStakingJbacVault | `0x28317bf362d43b40fceCEbf2390c43Db558c3f14` | JBAC, new staking |
| 3 | TegridyStakingAdmin | `0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3` | new staking |
| 4 | StakingMonitorView | `0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC` | new staking |
| 5 | TegridyTokenURIReader | `0x5cfEe751eAf274F68b05267012b85a867dfCd326` | new staking |
| 6 | TegridyLPFarming | `0x1171268AE5B69791c47Fd589b7825932c957e149` | TOWELI, LP `0x55875887B43C2E23aE424AF0FC8606Fdb058a481`, new staking, treasury Safe, 7 days |
| 7 | RevenueDistributor | `0xF993316E2fC079de4358c489A935E01e03E23E17` | new staking, treasury Safe, WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| 8 | ReferralSplitter | `0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c` | 2000 bps, new staking, treasury Safe, WETH |

The old contract's reward rate is `824300000000000000` wei/s (0.8243 TOWELI/s, 71,219.52 TOWELI/day)
and stays so. **The new contract has no rate to choose** (owner 2026-10-18): every funding spreads
the funds plus what is still scheduled over a fresh four years (`REWARDS_DURATION` = 4 × 365 days,
Synthetix `notifyRewardAmount`), so each day pays the pot ÷ 1,460. Nothing accrues after
`periodFinish`; a stretch with nothing staked, or paused, moves `periodFinish` back by that stretch.
There is no rate setter on the new staking or its admin.

## Step 1: deploy and wire (one sitting, nothing to wait for)

`contracts/script/DeployStakingRelease1.s.sol`. Before sending, it re-reads every copied value from
the live contracts and aborts if any moved since 2026-10-14. After sending, it checks every link.

| # | Call | Kind |
|---|---|---|
| 1 | deploy L1, L2, then `TegridyStaking(TOWELI, JBAC, treasury, rate)` | deploy |
| 2 | deploy `TegridyStakingJbacVault`; `staking.setJbacVault(vault)` | one-shot, instant |
| 3 | deploy `TegridyStakingAdmin`; `staking.setStakingAdmin(admin)` | one-shot, instant |
| 4 | `staking.setPauseGuardian(0xCDCA0F0621ce34012AD61bBD140f327EB778F354)` (the live guardian Safe) | instant |
| 5 | `staking.setMaxStakePerUser(10,000,000 TOWELI)` (owner 2026-10-30, was 1,000,000 from 2026-10-18; the old contract's is 50,000). **No whole-pool cap** (owner 2026-10-18): `setMaxTotalStaked` is not called, so it stays uncapped (the old contract's is 5,000,000) | instant |
| 6 | deploy `StakingMonitorView`, `TegridyTokenURIReader`, `TegridyLPFarming` | deploy |
| 7 | deploy `RevenueDistributor`; `revDist.setPauseGuardian(0xCDCA0F0621ce34012AD61bBD140f327EB778F354)` | instant |
| 8 | deploy `ReferralSplitter`; `setApprovedCaller(SwapFeeRouter 0x6d5791A660e79175F74C6D639584C98422d5956E, true)`; `completeSetup()` | one-shot, instant |
| 9 | `SwapFeeRouterAdmin(0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060).proposeRevenueDistributor(newRevDist)` | **starts a 48h timelock** |
| 10 | `SwapFeeRouterAdmin.proposeReferralSplitterChange(newSplitter)` | **starts a 48h timelock** |

Not copied, on purpose: `maxUnsettledRewards` (live = the constructor default 100,000 TOWELI,
asserted); `restakingContract` (none live); lending whitelist (none live); reward notifiers (none
were ever added; the owner funds directly). After this release any of those needs a proposal on
the new `TegridyStakingAdmin` and **48 hours**. The reward rate is not one of them: only a funding changes it.

## Step 2: fund the new staking (right after step 1)

`contracts/script/FundStakingRelease1.s.sol` with `NEW_STAKING` and `STAKING_FUND_TOWELI_WEI`:
`TOWELI.approve(newStaking, X)` then `newStaking.notifyRewardAmount(X)` (at least 1,000 TOWELI).
Emission runs from the deploy block. Rewards are paid only from what is funded, and an early exit
while the pool is short **forfeits** the unpaid part (test/StakingBoostResidual_2026_08_12.t.sol),
on top of the 75% fee. Fund before the site sends anyone here, and keep it ahead of the rate.

## Step 3: re-point the swap router (48 hours after step 1, within 7 days)

`contracts/script/ExecuteStakingRelease1Repoint.s.sol` with `NEW_REVENUE_DISTRIBUTOR` and
`NEW_REFERRAL_SPLITTER`:

| # | Call | Effect |
|---|---|---|
| 11 | old `ReferralSplitter.withdrawTreasuryFees()` | 0.0000006 ETH treasury share to the treasury Safe |
| 12 | `SwapFeeRouter.recoverCallerCredit()` | 0.0000024 ETH router credit back into the router's fee pot |
| 13 | `SwapFeeRouterAdmin.executeRevenueDistributor()` | swap-fee ETH share now goes to stakers of the NEW contract |
| 14 | `SwapFeeRouterAdmin.executeReferralSplitterChange()` | referral fees now recorded on the NEW splitter |

If 7 days pass after the ready time, the proposals expire: `cancelRevenueDistributor()` /
`cancelReferralSplitterChange()`, propose again, wait another 48 hours.

## Step 4: the site (on this branch, filled after steps 1 and 2)

The site side is built on the same branch. Every new address is a placeholder until the deploy:
`frontend/scripts/fill-staking-release.mjs` reads all ten from the step-1 receipt, checks every link
above on chain (and that step 2 put reward TOWELI in), then writes them into `constants.ts`,
`addresses.json`, `CONTRACTS.md`, `MIGRATION_HISTORY.md`, `TOKENOMICS.md` and `README.md`.
`frontend/scripts/fill-staking-release.test.mjs` and `verify-addresses.mjs` stay red until it has run.
From `frontend/`, in the checkout the deploy ran from: `node scripts/fill-staking-release.mjs`.

The first contract keeps a card on the Farm page (claim, its ETH share, withdraw, early exit at
its 25%, the pause exits, Auto-Max off; no stake), and every fee shown comes from the contract
it belongs to (`STAKING_CONTRACT` / `OLD_STAKING_CONTRACT` in `constants.ts`).

## Owner decisions this release does NOT take

- **LockerClaimer** (`0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7`) has an immutable
  `revenueDistributor` = the OLD distributor. Any Doppler launch that named it keeps sending the
  protocol fee there forever; it then pays only the OLD contract's stakers. It has forwarded
  nothing so far (0 events since its creation). For new launches: deploy a new one with
  `REVENUE_DISTRIBUTOR=<new>` (script/DeployLockerClaimer.s.sol, needs `REDEPLOY_ACK`) and point
  the launcher's `protocolFeeSink()` at it.
- **Factory fee** (`TegridyFactory 0xa24C7287eC56A7DEFDc70033803451240e267a52`): `feeTo` is the
  treasury Safe today. An expired proposal to the OLD distributor still sits in it. To send AMM
  protocol fees to stakers: `cancelFeeToChange()`, `proposeFeeToChange(newRevDist)`, wait 48h,
  `executeFeeToChange()` within 7 days. This changes who earns that fee, so it is not in the
  scripts.
- **LP farm rewards**: the old farm's rewards ended 2026-06-15. The new farm has none until
  `TOWELI.approve(newFarm, Y)` and `newFarm.notifyRewardAmount(Y, 604800)`. Its one staker
  (528.2 LP) withdraws from the old farm and stakes again.
- **GaugeController / VoteIncentives** keep reading the OLD staking (switched off on the site).
  Replace them only if they are switched back on.
- **Do not pause the old staking.** Its 16 positions (750,084.49 TOWELI) can only stay or leave
  there; pausing blocks `withdraw`, `earlyWithdraw` and `getReward`. Its reward pool is short of
  what it owes (owner decision, separate).
- **Base / Robinhood**: `script/base/*` and `script/robinhood/*` deploy the same
  `TegridyStaking` source, so any future L2 staking deploy from this source charges 75%.
- **LighthouseLadder** (`ladder-pepe` on mainnet, and the source) keeps its own 25%
  (`EARLY_EXIT_PENALTY_BPS = 2_500`), described in the registry as "TOWELI parity". That parity
  is now broken; it is a different contract and was not changed.
