# TOWELI Tokenomics

## The token

| Property | Value |
|---|---|
| Symbol | **TOWELI** |
| Address | [`0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D) |
| Total supply | **1,000,000,000 (1B) — fixed** |
| Decimals | 18 |
| Standard | Plain ERC-20. **No permit** — `permit(...)`, `DOMAIN_SEPARATOR()` and `nonces(address)` all revert on the live contract. Approvals are two transactions. |
| Mintable | **No.** `mint(address,uint256)` is not in the deployed bytecode. |
| Burnable | **Yes, by holders.** `burn(uint256)` and `burnFrom(address,uint256)` are both live, so any holder can destroy their own TOWELI. **The protocol burns nothing** — no contract calls either one; see [Sinks](#sinks--how-circulating-supply-can-shrink). |
| Owner | **Renounced.** The contract is Ownable2Step (`owner`, `pendingOwner`, `transferOwnership`, `acceptOwnership`, `renounceOwnership` all exist) and `owner()` reads `0x0…0`, so every owner-gated path reverts for everybody. No admin, no upgrade path — by renunciation, not by absence. |
| Deployed | ~2024. See [docs/TOKEN_DEPLOY.md](TOKEN_DEPLOY.md) for the CREATE2 vanity-address deployment story. |

> ⚠️ **The live contract is not [contracts/src/Toweli.sol](../contracts/src/Toweli.sol).** Read on-chain 2026-08-12: it names itself **`Towelie`** (symbol `Toweli`) and is a token-generator template. The repo source is OZ-based with permit and no burn; the deployed bytecode is the reverse on both counts, and adds Ownable2Step. The rows above describe **what is deployed** — the repo file describes what a fresh deploy of this project's own source would produce. When they disagree, the chain wins. See [CONTRACTS.md § Core Token](CONTRACTS.md#core-token--staking) for the full selector read.

**The token has been live for ~2 years at the canonical address above.** Full supply was minted once at deploy. There is no way to issue more TOWELI; no governance vote, no admin action, no upgrade pattern. 1B is therefore a **ceiling**: holder burns can only take the float down.

---

## Distribution snapshot

All supply has been minted and is in circulation somewhere — in treasury, LP, staker contracts, exchanges, or individual wallets. The percentages below are the **intended historical breakdown** of how the supply was distributed from deploy. The authoritative source for the current distribution is the on-chain state itself — see the "Verify on-chain" links at the bottom of each row.

| Bucket | % of supply | Tokens | Status | Verify on-chain |
|---|---|---|---|---|
| **LP seed** | **30%** | 300,000,000 | Seeded the TOWELI/WETH pool at launch. The native pool was re-created by the 2026-06-06 relaunch and remains **very thin**: `getReserves()` on **2026-09-05** returned ~2,792,972 TOWELI against ~0.0797 WETH (up ~20× from the ~146,258 / ~0.0038 low read on 2026-08-02, but still ~96× shallower in WETH than the Uniswap V2 pair). Treat this row as the launch intent, not as current liquidity. | [TegridyLP](https://etherscan.io/address/0x55875887B43C2E23aE424AF0FC8606Fdb058a481) + [Uniswap V2 pair](https://etherscan.io/address/0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D) |
| **Treasury** | **10%** | 100,000,000 | Held by the protocol treasury Safe; funds ongoing ops, audits, grants, and timelocked emission seeding. | [Treasury](https://etherscan.io/address/0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d) |
| **Community / future emissions** | **10%** | 100,000,000 | Reserved for continued LP farming rewards, retroactive airdrops, and governance-voted incentives. Intended to be dispensed per-season by the GaugeController — which currently has `gaugeCount() == 0`, so no gauge is registered and nothing is being dispensed through it yet. | [GaugeController](https://etherscan.io/address/0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054) |
| **Team** | **5%** | 50,000,000 | Allocated to the team with a 3-year linear vest + 6-month cliff. Subject to on-chain lockup contract where applicable. | Private vesting contract — contact the team for schedule |
| **Investors** | **0%** | 0 | **Fair launch — no VC allocation, no pre-sale, no seed round.** The protocol raised no off-chain capital. | — |
| **Circulating / public** | **45%** | 450,000,000 | Distributed to users over 2 years via: early-adopter airdrops, Uniswap V2 market buys, LP farming rewards, swap revenue, staker rewards. Floats across EOAs, staking contracts, and exchanges. | [Holder list on Etherscan](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#balances) |
| **Total** | **100%** | **1,000,000,000** | All minted once at deploy. No further issuance possible. | [Total supply verification](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#readContract) (call `totalSupply()`) |

**⚠️ Important:** these are the *intended* distribution percentages. Actual on-chain holdings have shifted over 2 years of trading, farming, staking, and airdrops. The Etherscan links above show the *current* state for each addressable bucket. The "Circulating / public" line is the residual — everything in user wallets that isn't in the named contracts.

---

## Yield flow: stakers earn TOWELI, swap fees go to the treasury

TOWELI stakers earn TOWELI from the reward pool and nothing else. Since the owner's ruling of
2026-11-15 the venue's swap fee goes to the treasury Safe of its chain, never to stakers.

**How the venue earns on Ethereum, and where each part lands:**

1. **Swap fee.** `SwapFeeRouter` keeps 0.5% (`feeBps() == 50`) of each swap made through the
   site's own router.
2. **Referral share.** At swap time the router hands the whole fee to `ReferralSplitter`, which
   keeps 20% (`referralFeeBps() == 2000`) for the trader's referrer, or for the treasury Safe when
   there is none. The share cannot be set to zero (`proposeReferralFee` rejects `0`) and the
   splitter cannot be unwired while it is above zero.
3. **The other 80%** waits in the splitter as the router's credit until anyone calls
   `recoverCallerCredit()`, then in the router until anyone calls `distributeFeesToStakers()`.
   Despite its name, that call pays the treasury Safe
   [`0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`](https://etherscan.io/address/0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d).
4. **Pool cut.** On our own pools where it is switched on (TOWELI/WETH since 2026-10-16), the venue
   takes one sixth of the 0.3% pool fee (0.05% of the volume), minted to the treasury Safe as LP
   tokens.
5. **Opening fee.** 0.006 ETH to open a pool on the paid factory, paid straight to the treasury Safe.

**The router's split levers** divide what `distributeFeesToStakers()` pays out. Their ceilings are
constants in [contracts/src/SwapFeeRouter.sol](../contracts/src/SwapFeeRouter.sol), and every leg
lands in the treasury Safe:

- **`stakerShareBps`:** `10000` today, never below `MIN_STAKER_SHARE_BPS = 5_000` (**50%**). The
  name is old: it is the share paid to the router's `revenueDistributor` address, the treasury Safe.
- **Treasury:** the remainder (`BPS − stakerShare − polShare`), so up to **50%**; 0% today. It is
  paid to the router's `treasury` address, also the treasury Safe.
- **POL:** 0% today, capped by `MAX_POL_SHARE_BPS = 2_500` at **25%**.
  [POLAccumulator](https://etherscan.io/address/0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2) is
  deployed but not wired (`polAccumulator()` reads `0x0`), so a POL share would fold into the
  treasury leg.

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

## The other three chains do not feed this

Added 2026-09-04, because the venue went multichain on 2026-08-25 and every number above is
still an **Ethereum-only** number.

- **TOWELI exists on Ethereum and nowhere else.** No bridge, no wrapped version on Base,
  Robinhood or Solana, and none is planned. The supply table above is the whole supply.
- **Base and Robinhood Chain pay the L2 treasury Safe.** Base 8453 and Robinhood 4663 run the
  same factory/router/TWAP/fee stack without the referral share. Every swap and pool fee there
  lands in the L2 treasury Safe `0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0`, the same address on
  both chains.
- **The Solana surface is fee-capture and staking only.** The Jupiter-routed swap takes a
  platform fee into a Solana fee account; it does not touch TOWELI.
- **The bungalow lighthouses pay their own token, not TOWELI.** Thirteen resident tokens each
  stake into their own pool. The six EVM pools (`LighthouseLadder`) use **exactly the ladder
  in the next section** — 7d…4y, 0.4×…4.0×, the same linear interpolation — but a staker
  there earns that bungalow's token, and the pool's runway is whatever its own vault was
  funded with. The five Solana pools run on Streamflow and have **no early exit at all**.

## Staking boost

Lock-duration multiplier, optional NFT bonus, hard ceiling:

| Component | Range |
|---|---|
| Lock-duration base | **0.4× (7-day lock) → 4.0× (4-year lock)**, linear |
| JBAC NFT bonus | **+0.5× flat** |
| Max ceiling | **4.5× (`MAX_BOOST_BPS_CEILING = 45000`)** — defence-in-depth clamp |

Even a 4-year locker holding a JBAC NFT cannot exceed 4.5×. Any computed boost above 45000 bps is clamped. Source: [contracts/src/TegridyLPFarming.sol:64](../contracts/src/TegridyLPFarming.sol).

User-facing flavour (from [frontend/src/lib/copy.ts](../frontend/src/lib/copy.ts)):

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

The live token **does** expose `burn(uint256)` and `burnFrom(address,uint256)` — corrected 2026-08-12,
this section previously said it had neither. That is a *holder* capability: anyone can destroy their
own TOWELI, and nothing in the protocol calls either function. So the burn path is real but
unattributable — a sink only if holders choose to use it. Of the two protocol-side mechanisms below,
one *could* shrink circulating float and is dormant; the other is often described as a sink and is not
one. **Nothing the protocol controls is contracting the float today.**

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
2. **No mint function:** use Etherscan's "Read Contract" tab. There is no `mint()`, `issue()` or `rebase()`. There *is* an owner-gated surface (Ownable2Step) but `owner()` reads `0x0…0`, so none of it is reachable.
3. **Burn is real:** call `burn(uint256)` / `burnFrom(address,uint256)` in the Write tab — they exist. `totalSupply()` therefore only ever moves down. Any doc claiming the opposite is out of date; this one was, until 2026-08-12.
4. **Top holders:** [Etherscan holder list](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#balances) shows the current distribution. Contracts (TegridyStaking, LP, treasury) will be near the top; individual wallets follow.
5. **Source:** read the **Etherscan** Contract tab, not this repo. [contracts/src/Toweli.sol](../contracts/src/Toweli.sol) is the project's own source and does **not** match the deployed bytecode — it has permit and no burn; the chain has burn and no permit.

---

## Summary

- **1B TOWELI ceiling.** No mint path in the deployed bytecode; holder-callable `burn`/`burnFrom` are present, so supply can only fall. Two years live on mainnet. The live contract is a generator template, **not** this repo's `Toweli.sol`, and has **no** EIP-2612 permit.
- **Fair-launch distribution.** No VC allocation, no pre-sale.
- **LP seed 30% / Treasury 10% / Community 10% / Team 5% / Circulating 45%** — historical distribution; current on-chain state is the source of truth.
- **Stakers earn TOWELI only.** The venue's swap fee goes to the treasury Safe of its chain (owner ruling 2026-11-15).
- **On Ethereum a 20% referral share comes off each swap fee first**, to the trader's referrer or the treasury Safe. It cannot be set to zero or unwired.
- **Boost ceiling 4.5×.** 0.4× at 7-day lock → 4.0× at 4-year lock + 0.5× JBAC bonus.
- **Flat 25% early-exit penalty, paid in full to the treasury** — not recycled to stakers.
- **POL sink is dormant twice over:** the lever is 0% and `SwapFeeRouter.polAccumulator()` is unset. Activation is a governance decision plus a wiring transaction; see [REVENUE_ANALYSIS.md](archive/REVENUE_ANALYSIS.md) § fee calibration.

---

*Last verified: 2026-08-06 against mainnet reads and `contracts/src/`. Distribution percentages are the historical launch breakdown; on-chain state is the authoritative source. Contract addresses are the post-relaunch set — see [CONTRACTS.md](CONTRACTS.md).*
