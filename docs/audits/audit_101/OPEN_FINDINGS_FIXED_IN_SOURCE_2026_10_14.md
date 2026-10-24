# Four open audit findings: fixed in source, still live on chain

**Date:** 2026-10-14. **Source fix:** commit `b8b5135d`, branch `fix/audit-findings-fixed-in-source`.
**Ruling:** the owner, 2026-10-13: open audit findings are fixed, not accepted.

## The short version

Four findings were still open on paper: three rows of
[`MICROSCOPE_REMEDIATION_2026_05_01.md`](MICROSCOPE_REMEDIATION_2026_05_01.md) (M-G3, M-S6,
M-S7) and one found on 2026-09-17 in the NFT drop template (called F1 below). All four are
now fixed in the contract source, each with a test that fails on the old line.

A contract on Ethereum cannot be changed after it is deployed. **The deployed contracts still
have all four.** Nobody is exposed to any of them today (the reads are below). The fixes reach
users only when new contracts are deployed and the site is pointed at them.

## The four findings

| Finding | What was wrong | Fixed in source | Deployed contract that still has it | Exposure on 2026-10-14 |
|---|---|---|---|---|
| **M-S7** | The LP farm weighs a holder's LP by the average boost of their staking positions. The average rounded down, so a holder with several positions at different boosts was counted up to 1 bps low (under 0.01%). Example: 101 TOWELI at 4.0x and 200 TOWELI at 0.4x average 1.607973x; the farm used 1.6079x. | `b8b5135d`: the average rounds up. It can never pass the holder's best single position. | `StakingViewLib` `0x7c9d52CF71a1dff1D5D302E95e68Bce80191ab0E`, linked into `TegridyStaking` `0xcaDc93E96De58EA554c71ca609974625615E046D`, read by `TegridyLPFarming` `0x1171268AE5B69791c47Fd589b7825932c957e149`. | None. 16 live staking positions, 16 holders, no holder with two. The farm has 1 staker (528.2 LP, one position, read exact at 40,000 bps), and its rewards ended 2026-06-15 (`periodFinish` 1,781,493,095). |
| **M-S6** | The owner could add a "reward notifier" (an address allowed to fund staking rewards) in one transaction. Every other staking setting waits 48 hours. | `b8b5135d`: the owner proposes on `TegridyStakingAdmin`, waits 48 hours, then executes. The one-step setter is gone. | `TegridyStaking` `0xcaDc93E96De58EA554c71ca609974625615E046D` (with `TegridyStakingAdmin` `0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3`). | None. No notifier was ever added: 0 `RewardNotifierSet` events. A notifier can only add its own tokens; the owner can already fund directly. |
| **M-G3** | A user who picked a referrer could switch to another one at once. The 30-day wait only started after the first switch. | `b8b5135d`: picking a referrer starts the 30-day clock. | `ReferralSplitter` `0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c`. | None. 0 `ReferrerSet` and 0 `ReferrerUpdated` events ever; `totalReferralsPaid` is 0. |
| **F1** | An NFT collection owner could switch a sale between its fixed price and its falling-price (dutch) auction in one transaction, though each price needs 24 hours' notice to change. A buyer who sent more than the price shown paid the other price. The site sends the exact price, so a site buyer's mint would fail instead. | `b8b5135d`: opening a sale in one pricing mode switches the other off, so switching back needs a new 24-hour proposal. A collection cannot be created already open in one mode with the other mode's price set. A review on 2026-10-14 found that this let a sale reopen free; fixed the same day on this branch (below). | The `TegridyDropV2` template `0xA35ec3e20C4361144b0D99573DEa00B67873e872`, fixed inside `TegridyLaunchpadV2` `0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7`. | None. `getCollectionCount()` is 0: no collection exists. The site's create wizard opens every collection CLOSED with no auction. |

## F1: what changes for a collection owner

The first F1 fix had a hole. Opening the auction set the stored fixed price to 0. If nothing
had sold yet, the owner could then open the fixed-price sale at 0, with no notice and no event
saying the price changed. Every buyer would mint free, the creator would earn nothing, and
the venue's platform fee (a share of the sale's takings) would be 0. Now:

- Once an auction has opened, an allowlist or public sale cannot open until a new price has
  been proposed and has waited 24 hours. This holds even if nothing sold, and for a price of 0.
- A sale can no longer go straight from an allowlist or public sale to an auction. Opening the
  fixed-price sale switches the auction off. To run one after, close the sale, propose the
  auction and wait 24 hours.
- Each switch-off is logged: `MintPriceChanged(0)` when the auction opens over a fixed price,
  and `DutchAuctionConfigured(0, 0, 0, 0)` when a fixed-price sale opens over an auction. A
  switched-off auction reads as all zeros, not as an auction that can no longer open.
- A collection created closed may carry both prices; the first sale opened decides which stays.

The site's owner panel does not explain this yet. No collection exists today.

## What a redeploy takes

Three separate releases. Each needs new contracts, the site's addresses changed, and a
production deploy. Nothing below has been done.

**1. Staking (M-S6 and M-S7).** The staking contract links its library at deploy time, and
seven deployed contracts the site uses store the staking address permanently (`immutable`
in source; read back on chain for the last two), so nine are replaced together:
`StakingViewLib`, `TegridyStaking`, then `TegridyStakingAdmin`, `StakingMonitorView`,
`TegridyStakingJbacVault`, `TegridyTokenURIReader`, `TegridyLPFarming`, `RevenueDistributor`
and `ReferralSplitter` (which also carries M-G3). `StakingRewardLib` is unchanged and can be
reused. `GaugeController` and `VoteIncentives` also store the staking address; they are
deployed but switched off on the site, so they need replacing only if they are kept.

Positions cannot be moved. The old staking contract keeps running for its 16 positions
(750,084.49 TOWELI). Each holder exits the old one when their lock allows and stakes in the
new one. The LP farm's one staker withdraws and stakes again. One-time setters
(`setStakingAdmin`, and `setApprovedCaller` before `completeSetup`) can be wired at once.
Anything set through `TegridyStakingAdmin`, such as a reward funder, waits 48 hours from its
proposal, whoever owns it.

**2. Referral splitter alone (M-G3).** Deploy a new `ReferralSplitter`, approve the swap
router as a caller, finish setup, then point the router at it through `SwapFeeRouterAdmin`
(propose, wait, execute). Before retiring the old splitter, its 0.000003 ETH must come out:
0.0000024 ETH of router credit (`SwapFeeRouter.recoverCallerCredit()`) and 0.0000006 ETH of
treasury share. Release 1 replaces this splitter anyway.

**3. NFT launchpad (F1).** Deploy a new `TegridyLaunchpadV2`; its constructor deploys the
fixed template. No collection exists, so nothing moves.

**Who signs:** every deployed contract above is owned by `0x14898258122C0740106391E6e8E4F17F3b6d456E`
(read 2026-10-14), which has no contract code: a single key. The same key deployed them all.
The owner signs every deploy and wiring step.

### Gas estimate

Basis: the gas each contract used when it was first deployed (its creation receipt on
mainnet), plus 200 gas per byte the fix added, plus an assumed 50,000 gas per wiring call.
Gas price: 0.0636 gwei, read from `eth.drpc.org` at block 26,187,815 on 2026-10-14. Gas
prices move, so the 1 and 10 gwei columns show the range.

| Release | Gas | At 0.0636 gwei | At 1 gwei | At 10 gwei |
|---|---|---|---|---|
| 1. Staking, 9 contracts + about 25 wiring calls | 23,182,403 | 0.00147 ETH | 0.023 ETH | 0.23 ETH |
| 1, also replacing `GaugeController` and `VoteIncentives` | 32,958,433 | 0.00210 ETH | 0.033 ETH | 0.33 ETH |
| 2. Referral splitter alone + about 4 calls | 3,848,482 | 0.00024 ETH | 0.0038 ETH | 0.038 ETH |
| 3. NFT launchpad + about 2 calls | 7,057,673 | 0.00045 ETH | 0.0071 ETH | 0.071 ETH |

Creation gas read from mainnet receipts: `TegridyStaking` 5,525,449; `StakingViewLib` 293,021;
`TegridyStakingAdmin` 1,997,946; `StakingMonitorView` 684,361; `TegridyStakingJbacVault`
434,443; `TegridyTokenURIReader` 1,374,580; `TegridyLPFarming` 2,584,561; `RevenueDistributor`
5,109,360; `ReferralSplitter` 3,645,682; `TegridyLaunchpadV2` with its template 6,884,073;
`GaugeController` 4,101,308; `VoteIncentives` 5,424,722.

## Contract sizes after the fix

Measured with `forge build --sizes` (solc 0.8.26, via-IR, 200 runs). The limit is 24,576 bytes.

| Contract | Before | After | Room left |
|---|---|---|---|
| TegridyStaking | 24,521 | 24,489 | 87 |
| TegridyStakingAdmin | 8,907 | 10,308 | 14,268 |
| StakingViewLib | 1,106 | 1,129 | 23,447 |
| ReferralSplitter | 16,192 | 16,206 | 8,370 |
| TegridyDropV2 | 21,554 | 21,922 | 2,654 |

`TegridyStaking` got smaller: the M-S6 change added 16 bytes, and folding the admin check
from six inlined copies into one shared function saved 48. No safety check was removed.

## How the reads were made

Contract state: `cast call` against `https://eth.drpc.org` at block 26,187,815. Event
counts: the keyless Blockscout API (`eth.blockscout.com`, `module=logs`), from block
25,000,000, before any of these contracts existed. Creation transactions: Blockscout
`getcontractcreation`; their gas from `cast receipt`. Positions per holder: every `Transfer`
event of `TegridyStaking` (18), replayed to the current owner of each token.

## Not covered here

- The ledger's 24 Medium findings with no row (listed in its §3) are still unverified.
- The audit's 19 Low and 4 Info findings: the repository names only 9 of them, and none was
  rechecked in this pass.
