# Pull request text for `DefiLlama/dimension-adapters` (volume, fees, revenue)

The owner opens this pull request. Tick "Allow edits by maintainers". The only file in it is
`dexs/memetics-finance.ts`, copied from the folder beside this file. Where the body says
`<link>`, paste the link of the value-locked pull request.

**Title**

```
Add Memetics Finance (Solana AMM): volume, fees and revenue
```

**Body** (their template, filled in; paste everything below the line)

---

##### Name (to be shown on DefiLlama):

Memetics Finance

##### Twitter Link:

https://x.com/junglebayac

##### List of audit links if any:

None for this program yet. It is a fork of Raydium's cp-swap, which was audited upstream; the fork's own changes have not had an outside audit, so we do not claim one. Every change from upstream is listed at the top of `programs/cp-swap/src/lib.rs`.

##### Website Link:

https://memetics.finance

##### Logo (High resolution, will be shown with rounded borders):

(attached to the TVL pull request: <link>)

##### Current TVL:

$20.03k (2026-11-27, 34 pools; TVL adapter: <link>)

##### Treasury Addresses (if the protocol has treasury)

Solana: `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` (a Squads multisig vault)

##### Chain:

Solana

##### Coingecko ID (so your TVL can appear on Coingecko, leave empty if not listed): (https://api.coingecko.com/api/v3/coins/list)

##### Coinmarketcap ID (so your TVL can appear on Coinmarketcap, leave empty if not listed): (https://api.coinmarketcap.com/data-api/v3/map/all?listing_status=active,inactive,untracked&start=1&limit=10000)

##### Short Description (to be shown on DefiLlama):

Memetics Finance is a constant-product AMM on Solana where anyone can open a pool for any pair. Every swap pays a 1% trade fee, and liquidity providers keep 84% of it.

##### Token address and ticker if any:

None on Solana.

##### Category (full list at https://defillama.com/categories) \*Please choose only one:

Dexs

##### Oracle Provider(s): Specify the oracle(s) used (e.g., Chainlink, Band, API3, TWAP, etc.):

None. A swap is priced from the pool's own two reserves.

##### Implementation Details: Briefly describe how the oracle is integrated into your project:

Not applicable.

##### Documentation/Proof: Provide links to documentation or any other resources that verify the oracle's usage:

The program's source and its notes on the fork: https://github.com/fomotsar-commits/tegridy-farms/tree/mvp-launch/solana/tegridy-amm

##### forkedFrom (Does your project originate from another project):

Raydium (its cp-swap program, the one behind Raydium's CPMM pools)

##### methodology (what is being counted as tvl, how is tvl being calculated):

- Volume: what traders sent into each swap of program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`, before fees, read from the `SwapEvent` the program logs. Counted in SOL, USDC or USDT wherever the pool holds one of them; when a swap sends the pool's other token, that amount is valued at the price the swap itself traded at. Swaps by the protocol's own price-keeping bot are left out (see below).
- Fees: the trade fee each swap paid, which the same event carries (1% of the amount sent in on every pool today), plus the flat fee in SOL to open a pool.
- Revenue: 16% of each trade fee, and the pool creation fee. Of the 16%, 10.4% goes to the protocol's multisig treasury and 5.6% is set aside for the fund owner named on the fee tier, the wallet of the community the protocol shares its fees with.
- Protocol revenue: the multisig treasury's part alone: 10.4% of each trade fee, and the pool creation fee.
- Supply side revenue: 84% of each trade fee, which stays in the pool for its liquidity providers.

##### Github org/user (Optional, if your code is open source, we can track activity):

https://github.com/fomotsar-commits

##### Does this project have a referral program?

Not on these Solana pools.

---

**The questions a review asks**

- **Related listing.** New protocol. Its TVL adapter is <link>. After merge the listing needs `dimensions: { dexs: "memetics-finance", fees: "memetics-finance" }` on the server side.
- **Why RPC and not Allium.** The closest adapter is `dexs/deepswap.ts`, another Raydium cp-swap fork, and this one reads the same `SwapEvent`. It reads it over RPC because the program has about 200 transactions a day and under 6,000 since it launched (six pages of signatures), and because an outside contributor cannot run an Allium query to test it. Pages of signatures are cached and transactions are fetched one at a time, so the test passes on the public endpoint. If you would rather have it on `helpers/alliumSolanaEvents.ts`, say so and we will switch.
- **The protocol's own bot is not volume.** Each fee tier names a keeper: the protocol's price-keeping bot, which the program has charged no trade fee since November 2026 (`states/config.rs`, `swap_fee_rates`). Everyone else pays a fee of at least one unit, because the fee is rounded up. So a swap whose event carries a trade fee of 0 is the keeper's, and the adapter leaves it out of volume. It pays no fee, so it adds nothing to fees either.
- **Why this differs from the site.** The site's volume figure counts every swap in the pools, the keeper's included, and covers the protocol's other programs and chains. This adapter counts fee-paying swaps of this one program.
- **Is a zero correct?** An hour with no swap is common. Whole days without one happened in October 2026, while the first pools were opening (the first pool on 2026-10-03, the first swap on 2026-10-08), and are not expected now.
- **Did the fee or the split change?** The trade fee has been 1% since the fee tier was created on 2026-10-01. The split changed once: until 2026-10-19 07:58:54 UTC the whole 16% that is not the liquidity providers' went to the treasury; since then 10.4% goes to the treasury and 5.6% to the fund owner (transaction `3v8upWGzBvmfsC9nnGpV8CLFhzCnbaDoMsQM3hzupT68k4aqqhnrCQgo5V1bu5bhDdTSADPLA2NKdtm9RJf78yje`). The adapter has that second as a time guard. Rates are read from the fee tier accounts.
- **Why revenue is larger than protocol revenue.** Revenue is everything that does not go to liquidity providers: 16% of each trade fee, and the pool creation fee. Protocol revenue is only what the multisig treasury collects: 10.4% of each trade fee, and the pool creation fee. The other 5.6% is set aside for the fund owner's wallet, which is not the treasury, and it is not a payout to holders of a token, so it is in neither protocol revenue nor holders revenue. It has its own label, "Swap Fees To Fund Owner". If you would rather see it under supply side revenue, say so and we will move it.
- **Does fees over volume make sense?** Swap fees are 1.00% of volume on every day tested, and fees equal revenue plus supply side revenue.
- **Pool creation fees.** 0.15 SOL per pool, read from the transfer the program makes into the treasury's wrapped SOL account, only while a call of the program is running.
- **Refill.** New adapter. `start` is 2026-10-03; every day since can be refilled.

**Test output** (`pnpm test dexs memetics-finance`, the last 24 hours, public endpoint)

```
Start Date:	Thu, 26 Nov 2026 06:00:00 GMT
End Date:	Fri, 27 Nov 2026 06:00:00 GMT

SOLANA
End timestamp: 1795759199 (2026-11-27T05:59:59.000Z)
Daily volume: 124.73
Daily fees: 1.25
Daily revenue: 0.20
Daily protocol revenue: 0.13
Daily supply side revenue: 1.05

label                   | Daily fees         | Daily supply side revenue | Daily revenue
---                     | ---                | ---                       | ---
Token Swap Fees         | 1.2510000000000001 |                           |
Swap Fees To LPs        |                    | 1.0509                    |
Swap Fees To Treasury   |                    |                           | 0.13000000000000003
Swap Fees To Fund Owner |                    |                           | 0.07
```

**Three past days** (`pnpm test dexs memetics-finance <the day after>`), each held against a separate script that reads the same transactions and prices SOL once, at noon:

| Day (UTC) | Volume | Swap fees | To LPs | To fund owner | To treasury | Pool creation fees | Separate script: volume, swap fees, pools opened |
|---|---|---|---|---|---|---|---|
| 2026-10-17, before the split | $26.00 | $0.2621 | $0.2202 | none | $0.0419 | $31 | $26.14, $0.2614, two (0.30 SOL) |
| 2026-10-22 | $236.37 | $2.3622 | $1.9842 | $0.1323 | $0.2456 | $16 | $236.15, $2.3615, one (0.15 SOL) |
| 2026-11-06 | $455.08 | $4.5454 | $3.8158 | $0.2544 | $0.4723 | $14 | $456.23, $4.5623, one (0.15 SOL) |

Revenue for a day is the fund owner and treasury columns plus the pool creation fees; protocol revenue is the treasury column plus the pool creation fees. The test rounds each hourly figure of $10 or more to whole dollars (`adapters/utils/runAdapter.ts`), which is why a pool creation fee prints as a whole number and why, in the hour a pool opens, the printed totals can differ by under a dollar.

For the last 24 hours the separate script reads $122.03 of volume in pools that hold SOL, USDC or USDT. The adapter's figure is $2.70 higher: it also counts 4 swaps in pools that hold none of the three, which DefiLlama prices, and it prices SOL hour by hour.
