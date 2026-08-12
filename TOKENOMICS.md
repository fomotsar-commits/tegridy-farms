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
| Burnable | **No protocol burn path.** The only mechanism that could shrink circulating float is the POL sink (below), and it is dormant — see [Sinks](#sinks--how-circulating-supply-can-shrink). |
| Owner | **None.** The token contract has no owner, no admin, no upgrade path. |
| Deployed | ~2024. See [docs/TOKEN_DEPLOY.md](docs/TOKEN_DEPLOY.md) for the CREATE2 vanity-address deployment story. |

**The token has been live for ~2 years at the canonical address above.** Full supply was minted once at deploy. There is no way to issue more TOWELI; no governance vote, no admin action, no upgrade pattern. The supply cap is enforced by the ERC-20 source itself — see [contracts/src/Toweli.sol](contracts/src/Toweli.sol).

---

## Distribution snapshot

All supply has been minted and is in circulation somewhere — in treasury, LP, staker contracts, exchanges, or individual wallets. The percentages below are the **intended historical breakdown** of how the supply was distributed from deploy. The authoritative source for the current distribution is the on-chain state itself — see the "Verify on-chain" links at the bottom of each row.

| Bucket | % of supply | Tokens | Status | Verify on-chain |
|---|---|---|---|---|
| **LP seed** | **30%** | 300,000,000 | Seeded the TOWELI/WETH pool at launch. The native pool was re-created by the 2026-06-06 relaunch and is **effectively empty**: `getReserves()` on 2026-08-06 returned ~146,258 TOWELI against ~0.0038 WETH. Treat this row as the launch intent, not as current liquidity. | [TegridyLP](https://etherscan.io/address/0x55875887B43C2E23aE424AF0FC8606Fdb058a481) + [Uniswap V2 pair](https://etherscan.io/address/0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D) |
| **Treasury** | **10%** | 100,000,000 | Held by the protocol treasury Safe; funds ongoing ops, audits, grants, and timelocked emission seeding. | [Treasury](https://etherscan.io/address/0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d) |
| **Community / future emissions** | **10%** | 100,000,000 | Reserved for continued LP farming rewards, retroactive airdrops, and governance-voted incentives. Intended to be dispensed per-season by the GaugeController — which currently has `gaugeCount() == 0`, so no gauge is registered and nothing is being dispensed through it yet. | [GaugeController](https://etherscan.io/address/0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054) |
| **Team** | **5%** | 50,000,000 | Allocated to the team with a 3-year linear vest + 6-month cliff. Subject to on-chain lockup contract where applicable. | Private vesting contract — contact the team for schedule |
| **Investors** | **0%** | 0 | **Fair launch — no VC allocation, no pre-sale, no seed round.** The protocol raised no off-chain capital. | — |
| **Circulating / public** | **45%** | 450,000,000 | Distributed to users over 2 years via: early-adopter airdrops, Uniswap V2 market buys, LP farming rewards, swap revenue, staker rewards. Floats across EOAs, staking contracts, and exchanges. | [Holder list on Etherscan](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#balances) |
| **Total** | **100%** | **1,000,000,000** | All minted once at deploy. No further issuance possible. | [Total supply verification](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#readContract) (call `totalSupply()`) |

**⚠️ Important:** these are the *intended* distribution percentages. Actual on-chain holdings have shifted over 2 years of trading, farming, staking, and airdrops. The Etherscan links above show the *current* state for each addressable bucket. The "Circulating / public" line is the residual — everything in user wallets that isn't in the named contracts.

---

## Yield flow — where the real return comes from

**The design:** TOWELI holders are not meant to rely on token emissions for yield. They earn **ETH**
from protocol swap fees. The 10% future-emissions bucket is secondary — a supplementary incentive for
LP farmers, not the core value accrual.

> **Nothing has flowed through this yet.** `SwapFeeRouter.totalETHFees()` read `0` on 2026-08-06 —
> not a single wei of swap fee has ever accrued, so no ETH has ever reached the RevenueDistributor
> or any staker. The diagram below is the wiring, not a record of payments.

```
                       ┌──────────────────────┐
                       │   Native DEX Pairs   │
                       │  (swap fee accrual)  │
                       └──────────┬───────────┘
                                  │ fee tokens
                                  ▼
                       ┌──────────────────────┐
                       │   SwapFeeRouter      │
                       │   0x6d5791A6...      │
                       └──────────┬───────────┘
                                  │
                                  ▼ (currently 100% — levers for split below)
                       ┌──────────────────────┐
                       │  RevenueDistributor  │
                       │   0xF993316E...      │
                       └──────────┬───────────┘
                                  │
                                  ▼ pro-rata by veTOWELI voting power
                       ┌──────────────────────┐
                       │       Stakers        │
                       │  (continuous ETH)    │
                       └──────────────────────┘
```

**Current state (read on-chain 2026-08-06):** `stakerShareBps() == 10000` and `polShareBps() == 0`,
so 100% of any swap fee is earmarked for stakers. The `SwapFeeRouter` has dormant levers to route a
% to a **Treasury** bucket and to a **POL Accumulator** (protocol-owned liquidity sink). Those levers
are parameterised but set to zero pending a governance proposal — see
[REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md).

Ceilings, taken from the constants in [contracts/src/SwapFeeRouter.sol](contracts/src/SwapFeeRouter.sol):
- **Stakers:** today 100%. `MIN_STAKER_SHARE_BPS = 5_000` is the hard floor, so a split can never push the staker share below **50%**.
- **POL:** 0% today. `MAX_POL_SHARE_BPS = 2_500` caps it at **25%**. Goes to [POLAccumulator](https://etherscan.io/address/0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2) — which is deployed but **not wired**: `SwapFeeRouter.polAccumulator()` currently reads `0x0…0`, so the lever has nowhere to send value even if it were raised.
- **Treasury:** 0% today. It is the *remainder* (`BPS − stakerShare − polShare`), not a separately-capped lever, so with the POL share at zero the treasury leg can reach **50%** — the mirror of the staker floor. There is no 20% cap on it.

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

**Emissions are not running.** `TegridyLPFarming.periodFinish()` reads `1781493095` — 2026-06-15 —
which is in the past, so the last funded epoch has expired and no new reward is streaming. Emissions
resume only when someone transfers TOWELI in and calls `notifyRewardAmount`. Read `periodFinish()`
before quoting an APR anywhere.

Season 1 + Season 2 drew from the 10% Community bucket. The bucket can fund multiple further seasons — pace governed by whatever the community votes the emission budget should be.

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

TOWELI has no `burn()` function. One mechanism below *could* shrink circulating float, and it is
dormant; the other is often described as a sink and is not one. **Nothing is contracting the float
today.**

### 1. POL Accumulator (dormant — lever at 0% and the destination is unset)

- When the SwapFeeRouter's POL lever is set > 0% **and** `polAccumulator` is wired (it is `0x0…0` today), a slice of every swap's fee value would route to [POLAccumulator](https://etherscan.io/address/0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2).
- The accumulator pairs that accumulated value with TOWELI to mint **TOWELI/WETH LP tokens**.
- Those LP tokens are **locked forever** — no withdrawal path, no admin function. Permanently removing the TOWELI-side of that LP from circulating supply.

Net effect when active: every epoch of fee flow reduces circulating TOWELI. Acts as a deflationary sink without requiring a `burn()` call.

### 2. Early-withdrawal penalty (a transfer to treasury, not a sink)

Locked stakers who exit before their lock end pay a **flat 25% penalty** on the withdrawn principal:

| Constant | Value |
|---|---|
| `EARLY_WITHDRAWAL_PENALTY_BPS` | `2500` (25%) |

- The penalty is flat. It does not shrink as the lock approaches maturity.
- **The entire penalty is transferred to the protocol treasury** — `safeTransfer(treasury, penalty)` in `earlyWithdraw`, per audit fix L-23. It does not reach stakers and it does not top up any reward pool. The penalty-recycle split that would have done that was removed for EIP-170 size and its bps defaulted to zero anyway.
- The penalty doesn't burn TOWELI either. It moves float from a user wallet to the treasury Safe, which is a bucket transfer, not a supply reduction.

---

## Who holds what — contracts of record

Beyond the raw distribution above, here are the on-chain addresses where TOWELI actually sits at any given time:

| Holder type | Contract / address | Typical balance source |
|---|---|---|
| Staker positions | [TegridyStaking](https://etherscan.io/address/0xcaDc93E96De58EA554c71ca609974625615E046D) | User locks |
| LP farmer positions | [TegridyLPFarming](https://etherscan.io/address/0x1171268AE5B69791c47Fd589b7825932c957e149) | LP deposits |
| Protocol treasury | [Treasury Safe](https://etherscan.io/address/0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d) | Ops reserve + early-exit penalties |
| Revenue distributor | [RevenueDistributor](https://etherscan.io/address/0xF993316E2fC079de4358c489A935E01e03E23E17) | In-flight reward claims |
| POL sink | [POLAccumulator](https://etherscan.io/address/0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2) | Locked-LP accumulator (deployed, not wired) |
| Native LP | [TegridyLP](https://etherscan.io/address/0x55875887B43C2E23aE424AF0FC8606Fdb058a481) | TOWELI/WETH native pair |
| External LP | [Uniswap V2 pair](https://etherscan.io/address/0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D) | Historical Uniswap listing |

Addresses above are the post-relaunch set, verified on-chain 2026-08-06. Pre-relaunch addresses for
each of these contracts still hold bytecode and, in the staking case, user positions — see
[CONTRACTS.md § Superseded deployments](CONTRACTS.md#superseded-deployments) before trusting any
older reference.

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
- **Yield is designed to come from ETH fees, not TOWELI emissions** — but `SwapFeeRouter.totalETHFees()` is `0`, so the RevenueDistributor has never paid anyone. This is a design, not a track record.
- **Boost ceiling 4.5×.** 0.4× at 7-day lock → 4.0× at 4-year lock + 0.5× JBAC bonus.
- **Flat 25% early-exit penalty, paid in full to the treasury** — not recycled to stakers.
- **POL sink is dormant twice over:** the lever is 0% and `SwapFeeRouter.polAccumulator()` is unset. Activation is a governance decision plus a wiring transaction; see [REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md) § fee calibration.

---

*Last verified: 2026-08-06 against mainnet reads and `contracts/src/`. Distribution percentages are the historical launch breakdown; on-chain state is the authoritative source. Contract addresses are the post-relaunch set — see [CONTRACTS.md](CONTRACTS.md).*
