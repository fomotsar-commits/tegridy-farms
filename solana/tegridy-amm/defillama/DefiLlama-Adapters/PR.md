# Pull request text for `DefiLlama/DefiLlama-Adapters` (value locked)

Sent on 2026-11-28 as https://github.com/DefiLlama/DefiLlama-Adapters/pull/22424. Below are its title and
description as sent; `projects/memetics-finance/index.js` beside this file is the adapter in it. Do not
open a second pull request.

**Title**

```
Add Memetics Finance (Solana AMM, a fork of Raydium cp-swap)
```

**Body**

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

![Memetics Finance logo](https://memetics.finance/icons/a5bed999/icon-512.png)

512 x 512 PNG: https://memetics.finance/icons/a5bed999/icon-512.png

##### Current TVL:

$19.43k (this adapter, 2026-11-28 02:31 UTC, 34 pools)

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

The program's source: https://github.com/fomotsar-commits/tegridy-farms/tree/mvp-launch/solana/tegridy-amm/programs/cp-swap

##### forkedFrom (Does your project originate from another project):

Raydium (its cp-swap program, the one behind Raydium's CPMM pools)

##### methodology (what is being counted as tvl, how is tvl being calculated):

TVL is the liquidity in every pool of program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`: the balance of the pool's two token vaults, minus the trading fees that have accrued in them for the protocol owner, the fund owner and the pool's creator (those are owed out of the vaults and are not liquidity). Pools are the program's 637-byte `PoolState` accounts, found with `getProgramAccounts`. A pool that pairs a token with SOL or another major asset is valued at twice that side; a pool of two major assets counts both sides.

##### Github org/user (Optional, if your code is open source, we can track activity):

https://github.com/fomotsar-commits

##### Does this project have a referral program?

Not on these Solana pools.

---

**Notes for the reviewer**

- The adapter follows `projects/deepswap/index.js`, another Raydium cp-swap fork: same account size, same field offsets, only the program id differs.
- `timetravel: false`, because `getProgramAccounts` reads the current state only.
- At 06:31 UTC on 2026-11-27 this adapter read $20.03k and the site's own figure for these pools was $20,081 in the same minute. The $50 gap (0.25%) is the accrued fees this adapter subtracts (about $25 to $30), one pool of a separate range-pool program that this adapter does not read ($1.54), and the SOL price source.
- A volume and fees adapter for the same program is in `DefiLlama/dimension-adapters` as `dexs/memetics-finance.ts`.

**Test output** (`node test.js projects/memetics-finance/index.js`), run on the current `main` at 2026-11-28 02:31 UTC

```
--- solana ---
SOL                       18.40 k
usdc                      977.34
usdt                      56.29
Total: 19.43 k

--- tvl ---
SOL                       18.40 k
usdc                      977.00
usdt                      56.00
Total: 19.43 k

------ TVL ------
solana                    19.43 k

total                    19.43 k
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

<!-- coderabbit-ai-generated:v1 -->

## Summary by CodeRabbit

* **New Features**
  * Added Memetics Finance to Solana TVL tracking, with reported pool reserves adjusted for accrued protocol, fund, and creator fees. Pools with unreadable balances or invalid reserves are excluded from the reported total. Historical time-travel data is not supported for this integration.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->
