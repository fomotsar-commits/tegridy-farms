# TOWELI Tokenomics

## Token

| Property      | Value                                          |
|---------------|------------------------------------------------|
| Symbol        | TOWELI                                         |
| Address       | `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`   |
| Total Supply  | 1,000,000,000 (1B) fixed                       |
| Decimals      | 18                                             |
| Mintable      | No — no owner `mint()` function on ERC20       |
| Burnable      | No protocol burn path (circulating float can only shrink via POL lock) |

TOWELI is a standard ERC20 with **no mint function and no burn function**. The 1B supply was
minted once at deploy and is immutable. There is no owner, minter role, or upgrade path that can
increase supply.

## Distribution

All allocations below are **TBD by team — placeholder** until the final allocation schedule is
published on-chain.

| Bucket      | Allocation |
|-------------|------------|
| Team        | TBD by team — placeholder |
| Investors   | TBD by team — placeholder |
| Community   | TBD by team — placeholder |
| Emissions   | TBD by team — placeholder |
| Treasury    | TBD by team — placeholder |
| Liquidity   | TBD by team — placeholder |

## Emission Curve

TOWELI has **no on-chain emission schedule baked into the token contract**. Emissions are handled
per-epoch by the LP Farming contract using the classic Synthetix-style
`notifyRewardAmount(uint256 reward)` pattern:

- The owner (multisig / governance) transfers TOWELI into `TegridyLPFarming` and calls
  `notifyRewardAmount` to begin a new reward epoch.
- `rewardRate = reward / duration` and rewards stream linearly across the epoch.
- Each epoch is **owner-funded**; there is no automatic mint.

The **reference emission budget** used by `GaugeController` when distributing vote-weighted
rewards across gauges is:

```
EMISSION_BUDGET = 1_000_000 TOWELI per epoch
```

This is the pool the controller splits across active gauges based on veTOWELI / staker votes.
The actual transferred amount per call to `notifyRewardAmount` is whatever the treasury funds
for that epoch.

## Staking Boost

Staked positions earn a multiplier based on lock duration plus an optional NFT bonus:

| Component          | Range / Value                                  |
|--------------------|------------------------------------------------|
| Lock duration base | 0.4x (7-day lock) → 4.0x (4-year lock), linear |
| JBAC NFT bonus     | +0.5x flat                                     |
| Max ceiling        | 4.5x (`MAX_BOOST_BPS_CEILING = 45000`)         |

Source: `contracts/src/TegridyLPFarming.sol:64`

```solidity
uint256 public constant MAX_BOOST_BPS_CEILING = 45000; // 4.5x in bps
```

The ceiling is enforced in the boost math so that even a 4-year lock + JBAC holder cannot exceed
4.5x. Any computed boost above 45000 bps is clamped to 45000.

## Revenue Flow

Swap fees collected by the native DEX flow through `SwapFeeRouter` and are split into three
destinations once the new split lands:

```
                       ┌──────────────────────┐
                       │   Native DEX Pairs   │
                       │  (swap fee accrual)  │
                       └──────────┬───────────┘
                                  │ fee tokens
                                  ▼
                       ┌──────────────────────┐
                       │   SwapFeeRouter      │
                       │   0xea13Cd47...      │
                       └──────────┬───────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            │ 70%                 │ 20%                 │ 10%
            ▼                     ▼                     ▼
   ┌────────────────┐   ┌───────────────────┐   ┌─────────────────┐
   │    Stakers     │   │     Treasury      │   │ POL Accumulator │
   │ (RevenueDistr.)│   │                   │   │  (locked LP)    │
   └────────────────┘   └───────────────────┘   └─────────────────┘
```

- **70% → Stakers** via `RevenueDistributor` (`0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8`)
- **20% → Treasury** multisig for ops, audits, grants funding
- **10% → POL Accumulator** (`0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca`) for protocol-owned
  liquidity

## Sinks

Even though TOWELI has no burn function, circulating float contracts over time via the
**POL (Protocol-Owned Liquidity) sink**:

- The 10% POL tranche routes fee value into the POL Accumulator.
- The accumulator pairs accumulated WETH (and other fee assets) with TOWELI to mint
  **TOWELI/WETH LP tokens**.
- Those LP tokens are **locked forever** (no withdrawal path), permanently removing the TOWELI
  side of the LP from circulating supply.

Effect: every epoch of fees reduces circulating TOWELI, acting as a deflationary sink
without requiring a `burn()` call.

## Penalties

Locked stakes that are withdrawn before their unlock timestamp pay an early-withdrawal penalty:

| Constant                        | Value              |
|---------------------------------|--------------------|
| `EARLY_WITHDRAWAL_PENALTY_BPS`  | `2500` (**25%**)   |

Source: `frontend/src/lib/constants.ts:73`

```ts
export const EARLY_WITHDRAWAL_PENALTY_BPS = 2500; // 25%
```

The 25% penalty is deducted from the withdrawn principal. Penalty proceeds are redirected to
the stakers' revenue pool, compounding rewards for users who honor their lock commitment.

## Summary

- Fixed, immutable 1B TOWELI — no mint, no protocol burn.
- Emissions are owner-funded per epoch via `notifyRewardAmount`, with a 1M TOWELI/epoch
  reference budget split by `GaugeController` votes.
- Lock-based boost 0.4x–4.0x + 0.5x JBAC NFT, hard-capped at 4.5x.
- Fee flow: 70% stakers / 20% treasury / 10% POL (locked LP sink).
- 25% early-withdrawal penalty discourages breaking locks and recycles value to stakers.
