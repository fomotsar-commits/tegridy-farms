# Dune Queries — Tegridy Farms (2026-06-06 relaunch)

Ready-to-paste Dune (Trino/DuneSQL) queries for the **third-party-verified** analytics
dashboard the roadmap calls for: trading volume, real yield (ETH fees), ETH distributed
to stakers, and TOWELI rewards funded. These read raw `ethereum.logs` (no contract
decoding/submission needed), filtered by the relaunch addresses below.

> Status: **live as of 2026-07-30.** All five queries are created and public on dune.com
> under `@cifurious9266`:
>   * Q1 — https://dune.com/queries/8157331 (0 rows; correct — router never used)
>   * Q2 — https://dune.com/queries/8157677 (0 rows; correct — no epoch distributed)
>   * Q3 — https://dune.com/queries/8157744 (1 row: `unique_claimers=0`, total `NULL`)
>   * Q4 — https://dune.com/queries/8157397 (**VALIDATED** — exactly `6400000`)
>   * Q5 — https://dune.com/queries/8157796 (**VALIDATED** — 4 swaps, ~0.005702 WETH)
>
> No dashboard exists yet. Q1/Q2/Q3/Q5 still carry the old divisor on dune.com and need
> the form below applied — see "Still to do" at the bottom.

## ⚠ The divisor. Read this before writing any wei→ETH conversion.

Use exactly this, everywhere:

```sql
CAST(bytearray_to_uint256(...) AS decimal(38,0)) / CAST(1000000000000000000 AS decimal(38,18))
```

**Casting the NUMERATOR is the load-bearing half**, and it is the half that is easy to
drop. `bytearray_to_uint256` returns DuneSQL's native `uint256`, not a decimal; how that
type behaves under `/` depends entirely on what it is divided by. Every alternative below
was run on real rows on Dune and produced a wrong answer:

| form | result | what goes wrong |
|---|---|---|
| `w / 1000000000000000000` | `0` | `uint256 / integer` is **integer division** — every sub-1-ETH value truncates to zero |
| `w / CAST(1e18 AS decimal(38,18))` | `6399999.999999999` | bare `uint256 / decimal` **coerces to double** |
| `CAST(w AS double) / 1e18` | `6399999.999999999` | double has ~16 significant digits |
| `CAST(w AS decimal(20,0)) / …` | **query error** | `Cannot cast uint256 to decimal(20,0)` — only `decimal(38,0)` is permitted |
| `CAST(w AS decimal(38,0)) / CAST(1e18 AS decimal(38,18))` | **correct** | exact decimal arithmetic |

Because `uint256` only casts to `decimal(38,0)`, the numerator consumes the whole 38-digit
budget and Trino clamps the quotient to **scale 6**. That is a hard ceiling, not a choice:
results are exact to 1e-6 ETH (~$0.003) and no finer. Where a total is being displayed,
**aggregate in wei and divide once at the end** — `sum(CAST(w AS decimal(38,0))) / …` —
so that rounding happens a single time instead of once per row.

### How this was caught, and why it took three tries

The first version of this doc used `/ 1e18`. Running Q4 — the only query with known
expected data — showed `6399999.999999999` instead of `6400000`, so it was "fixed" to
`/ 1000000000000000000`. Q4 then returned `6400000` and the fix looked verified.

It was not. **6,400,000 TOWELI is an exact multiple of 1e18**, so the truncating integer
divisor returns the right answer for that one value by luck. Q4 cannot tell a correct
divisor from a truncating one.

The truncation only surfaced when Q5 was created and turned out to have real data this
doc claimed did not exist. Running all three spellings side by side over its rows:

| day | `wei_raw` | `/ 1000000000000000000` | `/ 1e18` | correct form |
|---|---|---|---|---|
| 2026-06-26 | 3406244638800959 | **0** | 0.003406244638800959 | 0.003406 |
| 2026-07-02 | 1441077048338436 | **0** | 0.001441077048338436 | 0.001441 |
| 2026-07-11 | 854537831128198 | **0** | 0.000854537831128198 | 0.000855 |

Every WETH amount in this protocol's history is sub-1-ETH, so the integer divisor would
have zeroed **100% of the volume data** while still returning rows and rendering a chart.
The failure mode here is not an error — it is a plausible-looking zero.

**Lesson worth keeping: pick the acceptance test by whether it can fail.** Use Q5 to test
any change to a divisor, because its values are fractional. Q4 is a weak test and must not
be used as one.

Also corrected along the way: the funding event is **2026-06-07 06:44:23 UTC**, not 06-06.

## Which queries have data, and which correctly have none

**Q5 is not empty.** It reads the UniV2 pair's own `Swap` event, so it sees trades that
never touched SwapFeeRouter — which is why it has data when Q1 does not. 4 swaps,
~0.005702 WETH total, on 2026-06-26 / 07-02 / 07-11.

Q1/Q2/Q3 return 0 rows (or a `0`/`NULL` aggregate row), **and that is the correct answer** —
TOWELI is dormant, so there are no `SwapExecuted`, `EpochDistributed` or `Claimed` events
to decode. They start producing once the TOWELI/WETH pool is deepened (~1.31 ETH + ~50M
TOWELI; see docs/GOLIVE_CORELOOP.md). An empty chart is honest here, not broken — but do
not mistake an empty result for a verified query. Only Q4 and Q5 have data, and only Q5
can catch a bad divisor.

Note that Q3 is a bare aggregate, so it returns **one row** (`0` / `NULL`) rather than zero
rows. That distinction is useful: it proves the query executed, which a 0-row result cannot.

## Relaunch addresses (lowercased for Dune varbinary literals)
| Contract | Address |
|---|---|
| SwapFeeRouter | `0x6d5791a660e79175f74c6d639584c98422d5956e` |
| RevenueDistributor | `0xf993316e2fc079de4358c489a935e01e03e23e17` |
| TegridyStaking | `0xcadc93e96de58ea554c71ca609974625615e046d` |
| TOWELI/WETH Pair | `0x55875887b43c2e23ae424af0fc8606fdb058a481` |
| TOWELI token | `0x420698cfdeddea6bc78d59bc17798113ad278f9d` |
| WETH | `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` |

## Event topic0 (keccak of the signature)
| Event (contract) | Signature | topic0 |
|---|---|---|
| SwapExecuted (SwapFeeRouter) | `SwapExecuted(address,address,address,uint256,uint256)` | `0x764f0dc063c06f32d89a3f3af80c0db4be8a090901f589a478b447e0a51f09f1` |
| EpochDistributed (RevenueDistributor) | `EpochDistributed(uint256,uint256,uint256)` | `0x00fef0383cc8c130ab79e3917bd5d847a12414e11b95bf25e1579dc3b8049312` |
| Claimed (RevenueDistributor) | `Claimed(address,uint256,uint256,uint256)` | `0x9cdcf2f7714cca3508c7f0110b04a90a80a3a8dd0e35de99689db74d28c5383e` |
| RewardAdded (TegridyStaking) | `RewardAdded(uint256)` | `0xde88a922e0d3b88b24e9623efeb464919c6bf9f66857a65e2bfcf2ce87a9433d` |

Decoding note: indexed params live in `topic1..3`; non-indexed params are packed 32-bytes-each
in `data`. `bytearray_substring(data, start, len)` is **1-indexed**; word *i* (0-based) starts
at `1 + i*32`. `bytearray_to_uint256(...)` turns a 32-byte word into a number.

---

## Q1 — Real yield: cumulative ETH fees generated (→ 100% to stakers)
`SwapExecuted.fee` is word index 3 (bytes 97..128), denominated in ETH wei.
```sql
WITH swaps AS (
  SELECT
    block_time,
    CAST(bytearray_to_uint256(bytearray_substring(data, 97, 32)) AS decimal(38,0)) AS fee_wei
  FROM ethereum.logs
  WHERE contract_address = 0x6d5791a660e79175f74c6d639584c98422d5956e
    AND topic0 = 0x764f0dc063c06f32d89a3f3af80c0db4be8a090901f589a478b447e0a51f09f1
)
SELECT
  date_trunc('day', block_time) AS day,
  count(*)                      AS swaps,
  sum(fee_wei) / CAST(1000000000000000000 AS decimal(38,18)) AS fees_eth_day,
  sum(sum(fee_wei)) OVER (ORDER BY date_trunc('day', block_time))
    / CAST(1000000000000000000 AS decimal(38,18))            AS fees_eth_cumulative
FROM swaps
GROUP BY 1 ORDER BY 1;
```
**Approx volume:** fees ÷ fee rate (50 bps = 0.005) → `sum(fees_eth) / 0.005` ETH. For exact
per-token volume, decode `tokenIn` (word 0) / `tokenOut` (word 1) and join a price source.

## Q2 — ETH distributed to stakers (the headline "real yield paid")
`EpochDistributed.ethAmount` is word index 0 (epochId is indexed).
```sql
SELECT
  date_trunc('day', block_time) AS day,
  bytearray_to_uint256(topic1)  AS epoch_id,
  sum(CAST(bytearray_to_uint256(bytearray_substring(data, 1, 32)) AS decimal(38,0)))
    / CAST(1000000000000000000 AS decimal(38,18)) AS eth_distributed_day,
  sum(sum(CAST(bytearray_to_uint256(bytearray_substring(data, 1, 32)) AS decimal(38,0))))
      OVER (ORDER BY date_trunc('day', block_time))
    / CAST(1000000000000000000 AS decimal(38,18)) AS eth_distributed_cumulative
FROM ethereum.logs
WHERE contract_address = 0xf993316e2fc079de4358c489a935e01e03e23e17
  AND topic0 = 0x00fef0383cc8c130ab79e3917bd5d847a12414e11b95bf25e1579dc3b8049312
GROUP BY 1, 2 ORDER BY 1;
```

## Q3 — Staker claims (ETH actually withdrawn by stakers)
`Claimed.ethAmount` is word index 0 (user is indexed in topic1).
```sql
SELECT
  count(DISTINCT topic1) AS unique_claimers,
  sum(CAST(bytearray_to_uint256(bytearray_substring(data, 1, 32)) AS decimal(38,0)))
    / CAST(1000000000000000000 AS decimal(38,18)) AS eth_claimed_total
FROM ethereum.logs
WHERE contract_address = 0xf993316e2fc079de4358c489a935e01e03e23e17
  AND topic0 = 0x9cdcf2f7714cca3508c7f0110b04a90a80a3a8dd0e35de99689db74d28c5383e;
```
Bare aggregate → returns **one row** even with no matching logs. Today: `0` / `NULL`.

## Q4 — TOWELI staking rewards funded (RewardAdded)
`RewardAdded.reward` is word index 0 (TOWELI wei, 18 decimals).
```sql
SELECT
  block_time,
  CAST(bytearray_to_uint256(bytearray_substring(data, 1, 32)) AS decimal(38,0))
    / CAST(1000000000000000000 AS decimal(38,18)) AS toweli_funded
FROM ethereum.logs
WHERE contract_address = 0xcadc93e96de58ea554c71ca609974625615e046d
  AND topic0 = 0xde88a922e0d3b88b24e9623efeb464919c6bf9f66857a65e2bfcf2ce87a9433d
ORDER BY block_time;
-- VERIFIED on Dune 2026-07-30 with this exact form: one row —
--   block_time 2026-06-07 06:44:23 UTC, toweli_funded 6400000
--
-- ⚠ Do NOT use this query to validate a divisor. 6,400,000 TOWELI is an exact
-- multiple of 1e18, so a truncating integer divisor also returns 6400000 here.
-- Use Q5, whose amounts are all fractional.
```

## Q5 — DEX volume from the native pair (UniV2 Swap events)
Pair `Swap(address indexed sender, uint a0In, uint a1In, uint a0Out, uint a1Out, address indexed to)`
→ topic0 `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`. WETH is token1 here
(token0 = TOWELI, verified on-chain), so WETH-side flow = words for a1In + a1Out.
```sql
SELECT
  date_trunc('day', block_time) AS day,
  count(*)                      AS swaps,
  sum(CAST(bytearray_to_uint256(bytearray_substring(data, 33, 32)) AS decimal(38,0))   -- amount1In  (WETH in)
    + CAST(bytearray_to_uint256(bytearray_substring(data, 97, 32)) AS decimal(38,0)))  -- amount1Out (WETH out)
    / CAST(1000000000000000000 AS decimal(38,18)) AS weth_volume_day
FROM ethereum.logs
WHERE contract_address = 0x55875887b43c2e23ae424af0fc8606fdb058a481
  AND topic0 = 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822
GROUP BY 1 ORDER BY 1;
-- VERIFIED on Dune 2026-07-30 — this query HAS data (this doc used to claim it did not):
--   2026-06-26  1 swap   0.003406 WETH  (3406244638800959 wei)
--   2026-07-02  2 swaps  0.001441 WETH  (1441077048338436 wei)
--   2026-07-11  1 swap   0.000855 WETH  ( 854537831128198 wei)
-- 4 swaps, ~0.005702 WETH total. THIS IS THE DIVISOR ACCEPTANCE TEST — every amount is
-- sub-1-ETH, so a truncating divisor shows 0 here while Q4 still looks correct.
```
(Word map for Swap data: a0In=1..32, a1In=33..64, a0Out=65..96, a1Out=97..128.)

---

## Still to do
1. **Apply the numerator cast to Q1/Q2/Q3/Q5 on dune.com.** Only Q4 has been updated to the
   correct form so far. Q1/Q2/Q3 return no rows so their output looks the same either way —
   but they are public and would silently publish zeros the moment real data arrives.
2. Build the **Tegridy Farms — Real Yield** dashboard from the five queries.
3. Embed it (step below).

## Assemble + embed
1. Create each query on dune.com → save → add to a new **Dashboard** ("Tegridy Farms — Real Yield").
2. Counter widgets for totals (Q1 cumulative, Q2 cumulative, Q3 total, Q4); line charts for daily series.
3. Embed in the frontend: each Dune visual has **Embed → iframe**; drop into a new `/analytics` page or the
   home "By the Numbers" section beside the live on-chain `ProtocolStats` strip. Pair the on-chain strip
   (instant) with Dune (historical, third-party-verified) for the strongest trust signal.
4. USD conversion: join `prices.usd` (Dune) on WETH for ETH→USD, or multiply client-side by the Chainlink price.
