# Agent 62 — First-Depositor / Share-Inflation Attack Surface

Lens: classic Uniswap-V2 first-LP donation attack, ERC4626 inflation, MasterChef
`accRewardPerShare` first-staker dump, NFT-pool curve manipulation, RevenueDistributor /
RestakeShares first-epoch concentration, virtual-shares / minimum-liquidity defenses,
bondingCurve `initialPrice` griefing.

Working dir: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src`. Read-only.

---

## Inventory of share-issuance / accumulator surfaces

| Contract | Surface | Pattern | Defenses observed |
|---|---|---|---|
| `TegridyPair.sol` | LP token (`_mint(to, liquidity)`) | Uniswap-V2 LP shares | MIN_INITIAL_TOKENS (≥1000 each), `rawLiquidity > MINIMUM_LIQUIDITY * 1000`, `MINIMUM_LIQUIDITY = 1000` locked to `0xdead`, `MIN_TO != address(this)` |
| `TegridyStaking.sol` | NFT positions + `accRewardPerToken` accumulator | MasterChef-style `rewardPerTokenStored` over `totalBoostedStake`, individual position `rewardDebt` | `_accumulateRewards` always advances `lastUpdateTime` even when `_totalBoosted == 0` (forfeit empty-period emission, line 692); `MIN_STAKE = 100e18`; ACC_PRECISION = 1e18 (DS-N1-M1 fix) |
| `TegridyRestaking.sol` | `accBonusPerShare` accumulator over `totalRestaked` | MasterChef pattern | H-01 fix: when `totalRestaked == 0`, `lastBonusRewardTime` advances (line 357), no first-restaker dump |
| `TegridyLPFarming.sol` | Synthetix `rewardPerTokenStored` over `totalEffectiveSupply` | Synthetix StakingRewards | DR2-03 fix: empty-window emission FORFEIT (modifier always advances `lastUpdateTime` per Synthetix reference); `RewardsForfeitedDuringEmptyPeriod` event |
| `RevenueDistributor.sol` | Per-epoch pull-distribute, snapshot at `T-1` | Pro-rata epoch shares — no share token | `MIN_DISTRIBUTE_STAKE = 1000e18` (M-12), permissionless gate `STAKE_TOO_LOW`, snapshot lookback via `totalBoostedStakeAtTimestamp(T-1)` (REV-M-01) |
| `VoteIncentives.sol` | `share = bribeAmount * userVotes / totalGaugeVotes` | Pro-rata per (epoch, pair, token) | `MIN_BRIBE_CLAIM_QUORUM = 100e18`, `SelfBribeClaimForbidden`, `SNAPSHOT_LOOKBACK = 1h`, `MIN_EPOCH_INTERVAL = 7d` |
| `TegridyNFTPool.sol` | NFT/ETH AMM with linear bonding curve | Sudoswap-style; **no shares minted** — only owner can deposit/withdraw | `_spotPrice > 0`, `MAX_DELTA`, `MAX_FEE_BPS`, but **MAX_SPOT_PRICE missing in `initialize`** — see F-62-1 |
| `TegridyStakingJbacVault.sol` | NFT escrow only | Not share-based | n/a |
| `TegridyLending.sol`, `TegridyNFTLending.sol` | Per-loan offer/escrow | P2P, not pool | n/a |
| `TegridyDropV2.sol`, `TegridyLaunchpadV2.sol` | ERC721 / token sale accounting | `totalSupply` is NFT-count, no fungible shares | n/a |
| `POLAccumulator.sol` | Reads external `IERC20(lpToken).totalSupply()` | No internal share-issuance | n/a |
| `MemeBountyBoard.sol`, `CommunityGrants.sol`, `PremiumAccess.sol` | Claim accounting | Not share-based | n/a |

Net: TegridyPair has the canonical first-LP defense; LPFarming/Restaking/Staking
have the empty-period forfeit defense; RevenueDistributor and VoteIncentives have
quorum / snapshot defenses. The only material finding in this lens is on
TegridyNFTPool's missing init-time price cap. Everything else either has the right
pattern or is not share-based at all.

---

## F-62-1 — `TegridyNFTPool.initialize()` lacks `MAX_SPOT_PRICE` check (LOW; init-only self-DoS)

**File:** `contracts/src/TegridyNFTPool.sol`
**Lines:** 219-255 (`initialize`), constants at 111 and check at 445
**Function:** `initialize(address,PoolType,uint256 _spotPrice,uint256,uint256,address,uint256,address,address)`

The on-chain cap that the proposer-side enforces (line 445):
```
if (newPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();
```
where `MAX_SPOT_PRICE = 1_000_000 ether` (line 111), is **not mirrored in
`initialize()`**. Initialize only requires:
```solidity
require(_spotPrice > 0, "ZERO_PRICE"); // line 234
```

`TegridyNFTPoolFactory.createPool` likewise does not validate `_spotPrice`
against `MAX_SPOT_PRICE` (factory line 194 onwards just passes through).

### Recipe (self-DoS — pool creator only griefs themselves)
1. Attacker calls `factory.createPool(collection, BUY, _spotPrice = type(uint256).max / 50, …)`
   with the required MIN_DEPOSIT.
2. Pool initializes with `spotPrice = ~ 2.3e75`.
3. The `_minLiquidityBuffer()` math at line 905 computes
   `maxItems * spotPrice` (maxItems is capped at 100). With spotPrice near
   `uint256.max / 50`, `100 * spotPrice` overflows under Solidity 0.8.26 checked
   arithmetic and reverts.
4. Every call path that reads `_minLiquidityBuffer()` (sells, withdrawETH) reverts.
   Pool is bricked from inception.

The DEEP-NFTPOOL-V3-05 fix that added MAX_SPOT_PRICE was applied only to
`proposeSpotPrice`. The same overflow vector is reachable at init and bypasses
the timelock entirely.

### Severity
LOW. The bricked pool only DoSes the creator's own deposits — there are no
shareholders to dilute. But because the factory accepts MIN_DEPOSIT or
`initialTokenIds`, an attacker who passes `initialTokenIds = []` and 0.05 ETH
can still self-grief their own ETH (the ETH ends up in a pool that can never
sell back, since `swapNFTsForETH` reads `_minLiquidityBuffer`). Owner can
still call `withdrawETH(amount)` without triggering the buffer for `amount = 0`,
but any real withdraw / swap reverts. Mainly a footgun, mirrored by the same
fix already applied at the proposer side.

### Suggested defense
Add to `initialize()` before line 246:
```solidity
require(_spotPrice <= MAX_SPOT_PRICE, "SPOT_PRICE_TOO_HIGH");
```
Or duplicate the check in `TegridyNFTPoolFactory.createPool` for early revert.

---

## Notes / dead-ends

### N-1: TegridyPair first-LP — FULLY DEFENDED
`contracts/src/TegridyPair.sol:127-172` enforces:
- `amount0 >= 1000 && amount1 >= 1000` (line 150)
- `rawLiquidity > MINIMUM_LIQUIDITY * 1000` i.e. > 1_000_000 (line 155)
- Locks 1000 LP to `0xdead` (line 157)
- Mint-to-self refused (line 139)

Donation attack recipe — a first depositor mints with 1 wei of each, then
donates 1e18 to inflate share price — is blocked at line 150. The `1000x`
multiplier on MINIMUM_LIQUIDITY further raises the floor relative to vanilla
Uniswap V2. Standard `_mintFee` follows V2 reference (1/6 to feeTo).

### N-2: TegridyStaking first-staker dump — DEFENDED
`contracts/src/TegridyStaking.sol:672-693` (`_accumulateRewards`):
- Line 674: `if (block.timestamp > lastUpdateTime && _totalBoosted > 0 && !paused())`
- Line 692: `lastUpdateTime = block.timestamp;` (UNCONDITIONAL, even if totalBoosted = 0)

This is the Synthetix-style "forfeit empty-period emission" pattern. First staker
does NOT receive the cumulative `elapsed * rewardRate` of empty-pool window.
Pause-aware (DS2-04 fix). MIN_STAKE = 100e18 prevents 1-wei stake.

ACC_PRECISION bumped from 1e12 → 1e18 (BATCH-N1 M1) so dust-rounding-to-zero
under low rates is mitigated.

### N-3: TegridyRestaking first-restaker dump — DEFENDED
`contracts/src/TegridyRestaking.sol:332-360` (`updateBonus` modifier) explicitly
documents AUDIT FIX H-01: `else if (totalRestaked == 0) { lastBonusRewardTime = block.timestamp; }`
prevents the gap-period reward from being banked for the first restaker after a
drain.

### N-4: LPFarming Synthetix forfeit — DEFENDED
`contracts/src/TegridyLPFarming.sol:189-203` (DR2-03) restored the unconditional
`lastUpdateTime` advance and emits `RewardsForfeitedDuringEmptyPeriod` for
observability. `rewardPerToken()` returns `rewardPerTokenStored` unchanged when
`totalEffectiveSupply == 0` (line 249), so no division by zero and no banking.

### N-5: RevenueDistributor first-epoch concentration — DEFENDED
- `MIN_DISTRIBUTE_STAKE = 1000e18` blocks distribute paths until enough stake exists.
- `MIN_DISTRIBUTE_AMOUNT` floors the distributable.
- Snapshot pinned to `T-1` via `totalBoostedStakeAtTimestamp` (REV-M-01) so a
  same-block stake cannot capture the new epoch.
- No share token is issued; pro-rata is computed at claim time using historical
  voting power. Donating ETH to the contract just adds to the next epoch — split
  pro-rata across all stakers, not concentrated to the donor.

### N-6: VoteIncentives self-bribe / dust-share — DEFENDED
- `MIN_BRIBE_CLAIM_QUORUM = 100e18` (line 205): prevents `share = bribe * 1 / 1`
  when only the briber voted.
- `SelfBribeClaimForbidden`: briber locked out of their own pool.
- `SNAPSHOT_LOOKBACK = 1h`: stake-then-advance attack closed.
- `MIN_EPOCH_INTERVAL = 7 days`: dust-bucket spam closed.
- `MIN_BRIBE_AMOUNT = 0.001 ether`: Velodrome dust-spam DoS closed.

### N-7: NFTPool — no shares, but spotPrice manipulation
`TegridyNFTPool` is a Sudoswap-style AMM. Pool owner is the only depositor
(`withdrawETH`/`withdrawNFTs` are `onlyOwner`), so there's no shared-pool
first-depositor inflation. Pool owner's spotPrice setting affects only their
own pool's pricing. Router discovery hijack via CREATE2 was already fixed
(DEEP-NFTPOOL-09 includes `block.chainid`, `address(this)`, `msg.sender`,
`_allPools.length`, `nftCollection`, `_poolType` in salt). Per-collection cap
`MAX_POOLS_PER_COLLECTION` blocks discovery-spam.

The only loose thread is the missing MAX_SPOT_PRICE check in `initialize`
(F-62-1).

### N-8: TegridyStakingJbacVault — escrow only
Vault holds NFTs deposited from staking-side `stakeWithBoost`. No share token
issued, no asset-share accounting. Owner-only withdraw paths plus stranded-
recovery permissionless retry.

### N-9: TegridyDropV2 / Launchpad / Toweli — fixed-supply ERC20 / ERC721
- `Toweli` mints fixed `TOTAL_SUPPLY` once at construction (line 107) — no
  ongoing share issuance.
- `TegridyDropV2.totalSupply` is the count of minted ERC721s, not a fungible
  share denominator.
- `TegridyLaunchpadV2` does not implement share-based accounting.

### N-10: Ancillary — POL / FeeHook / Router
`POLAccumulator` consumes `IERC20(lpToken).totalSupply()` only as a denominator
for harvest math against external pair shares; no internal mint. The TWAP-derived
floors with `TWAP_SAFETY_BPS` haircut (lines 945-949) defeat the inflate-then-burn
attack on pair price.

`TegridyFeeHook` exposes only `claimFees` to users — pull pattern, no shares.

`TegridyRouter` / `TegridyFactory` delegate to TegridyPair which has the V2
defenses already noted.

---

## Summary

One LOW-severity gap surfaced (F-62-1, missing MAX_SPOT_PRICE check in
`TegridyNFTPool.initialize`, self-DoS only). Every share-issuing or accumulator-
based contract in the codebase has the relevant defense in place:

- Uniswap-V2 LP first-mint: MIN_INITIAL_TOKENS + 1000x MINIMUM_LIQUIDITY + 0xdead lock
- MasterChef/Synthetix accumulator first-staker dump: empty-period emission forfeit
  (unconditional `lastUpdateTime` advance) — TegridyStaking, TegridyRestaking, TegridyLPFarming
- RevenueDistributor first-epoch / dilution: MIN_DISTRIBUTE_STAKE + T-1 snapshot
- VoteIncentives self-bribe / dust: MIN_BRIBE_CLAIM_QUORUM + self-bribe forbidden + 1h snapshot lookback + 7d epoch cadence
- ERC4626 vault inflation: not applicable — no contract in the suite implements ERC4626
- bondingCurve initialPrice: only NFTPool, owner-isolated, F-62-1 the only quibble
