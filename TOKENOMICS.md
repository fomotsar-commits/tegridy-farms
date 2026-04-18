# TOWELI Tokenomics

## The token

| Property | Value |
|---|---|
| Symbol | **TOWELI** |
| Address | [`0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D) |
| Total supply | **1,000,000,000 (1B) — fixed** |
| Decimals | 18 |
| Standard | ERC-20 + ERC-2612 (permit) |
| Mintable | **No.** No `mint()` function exists on the contract. |
| Burnable | **No protocol burn path.** The circulating float can only shrink via the POL sink (below). |
| Owner | **None.** The token contract has no owner, no admin, no upgrade path. |
| Deployed | ~2024. See [docs/TOKEN_DEPLOY.md](docs/TOKEN_DEPLOY.md) for the CREATE2 vanity-address deployment story. |

**The token has been live for ~2 years at the canonical address above.** Full supply was minted once at deploy. There is no way to issue more TOWELI; no governance vote, no admin action, no upgrade pattern. The supply cap is enforced by the ERC-20 source itself — see [contracts/src/Toweli.sol](contracts/src/Toweli.sol).

---

## Distribution snapshot

All supply has been minted and is in circulation somewhere — in treasury, LP, staker contracts, exchanges, or individual wallets. The percentages below are the **intended historical breakdown** of how the supply was distributed from deploy. The authoritative source for the current distribution is the on-chain state itself — see the "Verify on-chain" links at the bottom of each row.

| Bucket | % of supply | Tokens | Status | Verify on-chain |
|---|---|---|---|---|
| **LP seed** | **30%** | 300,000,000 | Seeded the TOWELI/WETH pool at launch; most remains in live liquidity pools, actively earning swap fees for LPs. | [TegridyLP](https://etherscan.io/address/0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6) + [Uniswap V2 pair](https://etherscan.io/address/0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D) |
| **Treasury** | **10%** | 100,000,000 | Held by the protocol treasury address; funds ongoing ops, audits, grants, and timelocked emission seeding. | [Treasury](https://etherscan.io/address/0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e) |
| **Community / future emissions** | **10%** | 100,000,000 | Reserved for continued LP farming rewards, retroactive airdrops, and governance-voted incentives. Dispensed per-season by the GaugeController voting mechanism. | [GaugeController](https://etherscan.io/address/0xb6E4CFCb83D846af159b9c653240426841AEB414) |
| **Team** | **5%** | 50,000,000 | Allocated to the team with a 3-year linear vest + 6-month cliff. Subject to on-chain lockup contract where applicable. | Private vesting contract — contact the team for schedule |
| **Investors** | **0%** | 0 | **Fair launch — no VC allocation, no pre-sale, no seed round.** The protocol raised no off-chain capital. | — |
| **Circulating / public** | **45%** | 450,000,000 | Distributed to users over 2 years via: early-adopter airdrops, Uniswap V2 market buys, LP farming rewards, swap revenue, staker rewards. Floats across EOAs, staking contracts, and exchanges. | [Holder list on Etherscan](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#balances) |
| **Total** | **100%** | **1,000,000,000** | All minted once at deploy. No further issuance possible. | [Total supply verification](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#readContract) (call `totalSupply()`) |

**⚠️ Important:** these are the *intended* distribution percentages. Actual on-chain holdings have shifted over 2 years of trading, farming, staking, and airdrops. The Etherscan links above show the *current* state for each addressable bucket. The "Circulating / public" line is the residual — everything in user wallets that isn't in the named contracts.

---

## Yield flow — where the real return comes from

**Crucially:** TOWELI holders don't rely on token emissions for yield. They earn **ETH** from protocol swap fees, paid out of the live DEX activity. The 10% future-emissions bucket is secondary — a supplementary incentive for LP farmers, not the core value accrual.

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
                                  ▼ (currently 100% — levers for split below)
                       ┌──────────────────────┐
                       │  RevenueDistributor  │
                       │   0x332aaE55...      │
                       └──────────┬───────────┘
                                  │
                                  ▼ pro-rata by veTOWELI voting power
                       ┌──────────────────────┐
                       │       Stakers        │
                       │  (continuous ETH)    │
                       └──────────────────────┘
```

**Current state (as of 2026-04):** 100% of swap fees → stakers. The `SwapFeeRouter` has dormant levers to route % to a **Treasury** bucket and to a **POL Accumulator** (protocol-owned liquidity sink). Those levers are parameterised but set to zero pending a governance proposal — see [REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md).

Documented ceiling for each lever:
- **Stakers:** today 100%. If a treasury / POL split activates, this drops to 70–90%.
- **Treasury:** 0–20% (cap). Goes to the 10% Treasury bucket for ops.
- **POL:** 0–10% (cap). Goes to [POLAccumulator](https://etherscan.io/address/0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca), which auto-compounds protocol-owned LP — see "Sinks" below.

---

## Emissions

TOWELI **has no emission schedule baked into the token contract.** Emissions are opt-in distributions from the Community bucket, funded per-epoch by the Treasury:

- The treasury (or its multisig proxy) transfers TOWELI into `TegridyLPFarming` and calls `notifyRewardAmount(uint256)` to begin a new reward epoch.
- `rewardRate = reward / duration` and rewards stream linearly across the epoch.
- **Each epoch is explicitly owner-funded.** There is no automatic mint. If the treasury doesn't fund the next epoch, emissions simply stop.

Reference budget used by `GaugeController` when splitting rewards across LP gauges:

```
EMISSION_BUDGET = 1,000,000 TOWELI per epoch (reference; actual amount per-call)
```

Current season: **Season 2 (2026-01-01 → 2026-06-01), 26M TOWELI across LP farming rewards.**

Season 1 + Season 2 draw from the 10% Community bucket. The bucket will last multiple seasons — pace governed by whatever the community votes the emission budget should be.

---

## Staking boost

Lock-duration multiplier, optional NFT bonus, hard ceiling:

| Component | Range |
|---|---|
| Lock-duration base | **0.4× (7-day lock) → 4.0× (4-year lock)**, linear |
| JBAC NFT bonus | **+0.5× flat** |
| Max ceiling | **4.5× (`MAX_BOOST_BPS_CEILING = 45000`)** — defence-in-depth clamp |

Even a 4-year locker holding a JBAC NFT cannot exceed 4.5×. Any computed boost above 45000 bps is clamped. Source: [contracts/src/TegridyLPFarming.sol:64](contracts/src/TegridyLPFarming.sol).

User-facing flavour (from [frontend/src/lib/copy.ts](frontend/src/lib/copy.ts)):

| Lock | Boost | Label |
|---|---|---|
| 7 days | 0.4× | The Taste Test |
| 30 days | 1.0× | One Month of Integrity |
| 90 days | 1.5× | The Harvest Season |
| 1 year | 2.5× | The Long Haul |
| 2 years | 3.5× | In It For The Kids |
| 4 years | 4.0× | Till Death Do Us Farm |

---

## Sinks — how circulating supply can shrink

Even though TOWELI has no `burn()` function, circulating float can **contract over time** via two paths:

### 1. POL Accumulator (active lever, currently 0%)

- When the SwapFeeRouter's POL lever is set > 0%, a slice of every swap's fee value routes to [POLAccumulator](https://etherscan.io/address/0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca).
- The accumulator pairs that accumulated value with TOWELI to mint **TOWELI/WETH LP tokens**.
- Those LP tokens are **locked forever** — no withdrawal path, no admin function. Permanently removing the TOWELI-side of that LP from circulating supply.

Net effect when active: every epoch of fee flow reduces circulating TOWELI. Acts as a deflationary sink without requiring a `burn()` call.

### 2. Early-withdrawal penalty redistribution

Locked stakers who exit before their lock end pay a **25% penalty** on the withdrawn principal:

| Constant | Value |
|---|---|
| `EARLY_WITHDRAWAL_PENALTY_BPS` | `2500` (25%) |

- Penalty proceeds route to the RevenueDistributor, **compounding the reward pool for stakers who honour their lock**.
- The penalty itself doesn't burn TOWELI — it redistributes. But it permanently attributes tokens to the staker bucket rather than circulating.

---

## Who holds what — contracts of record

Beyond the raw distribution above, here are the on-chain addresses where TOWELI actually sits at any given time:

| Holder type | Contract / address | Typical balance source |
|---|---|---|
| Staker positions | [TegridyStaking](https://etherscan.io/address/0x626644523d34B84818df602c991B4a06789C4819) | User locks |
| LP farmer positions | [TegridyLPFarming](https://etherscan.io/address/0xa5AB522C99F86dEd9F429766872101c75517D77c) | LP deposits |
| Protocol treasury | [Treasury](https://etherscan.io/address/0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e) | Ops reserve |
| Revenue distributor | [RevenueDistributor](https://etherscan.io/address/0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8) | In-flight reward claims |
| POL sink | [POLAccumulator](https://etherscan.io/address/0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca) | Locked-LP accumulator |
| Native LP | [TegridyLP (V2 clone)](https://etherscan.io/address/0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6) | TOWELI/WETH deep liquidity |
| External LP | [Uniswap V2 pair](https://etherscan.io/address/0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D) | Historical Uniswap listing |

Any balance not in the contracts above is in EOA wallets, exchange hot-wallets, or aggregator custody — part of the "Circulating / public" bucket.

---

## Verifying the supply yourself

1. **Total supply check:** go to [Etherscan → TOWELI → Contract → Read](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#readContract) and call `totalSupply()`. Expect `1e27` (1,000,000,000 with 18 decimals).
2. **No mint function:** use Etherscan's "Read Contract" tab. There is no `mint()`, `issue()`, `rebase()`, or owner-gated function that could change supply.
3. **Top holders:** [Etherscan holder list](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#balances) shows the current distribution. Contracts (TegridyStaking, LP, treasury) will be near the top; individual wallets follow.
4. **Source:** [contracts/src/Toweli.sol](contracts/src/Toweli.sol) in this repo matches the verified Etherscan source. Standard OpenZeppelin ERC20 + ERC20Permit, no bells or whistles.

---

## Summary

- **Fixed 1B TOWELI supply.** No mint. No burn function. Two years live on mainnet.
- **Fair-launch distribution.** No VC allocation, no pre-sale.
- **LP seed 30% / Treasury 10% / Community 10% / Team 5% / Circulating 45%** — historical distribution; current on-chain state is the source of truth.
- **Yield comes from ETH fees, not TOWELI emissions.** Staker yield is paid in ETH by the RevenueDistributor, funded by continuous DEX swap activity.
- **Boost ceiling 4.5×.** 0.4× at 7-day lock → 4.0× at 4-year lock + 0.5× JBAC bonus.
- **25% early-exit penalty** recycles to stakers who honour their locks.
- **POL sink is parameterised but dormant.** Activation is a governance decision; see [REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md) § fee calibration.

---

*Last updated: 2026-04-18. Distribution percentages are the historical launch breakdown; on-chain state is the authoritative source.*
