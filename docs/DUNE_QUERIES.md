# Dune Queries — Tegridy Farms (2026-06-06 relaunch)

Ready-to-paste Dune (Trino/DuneSQL) queries for the **third-party-verified** analytics
dashboard the roadmap calls for: trading volume, real yield (ETH fees), ETH distributed
to stakers, and TOWELI rewards funded. These read raw `ethereum.logs` (no contract
decoding/submission needed), filtered by the relaunch addresses below.

> Status: **partially live as of 2026-07-30.** Two queries are created and public on
> dune.com under `@cifurious9266`:
>   * Q1 — https://dune.com/queries/8157331 (returns 0 rows; correct, see below)
>   * Q4 — https://dune.com/queries/8157397 (**VALIDATED** — returns exactly `6400000`)
> Q2, Q3 and Q5 are not yet created, and no dashboard exists yet.
>
> ⚠ **`/ 1e18` was WRONG in every query here and has been corrected to
> `/ 1000000000000000000`.** `1e18` is a *double* literal, so dividing a
> `uint256`/`decimal(38,0)` by it coerces the whole expression to double and loses
> precision on money figures. Caught by running Q4 against known data: it rendered the
> 6,400,000 TOWELI funding as `6399999.999999999`. The integer literal keeps it exact
> decimal division and returns `6400000`. Verified on Dune, not reasoned about.
>
> ⚠ Also corrected: that funding event is **2026-06-07 06:44:23 UTC**, not 2026-06-06.
>
> Q1/Q2/Q3/Q5 return **0 rows today, and that is the correct answer** — TOWELI is dormant,
> so there are no `SwapExecuted`, `EpochDistributed` or `Claimed` events to decode. They
> start producing once the TOWELI/WETH pool is deepened (~1.31 ETH + ~50M TOWELI; see
> docs/GOLIVE_CORELOOP.md). Q4 is the only one with data because reward *funding* already
> happened. An empty chart is honest here, not broken — but do not mistake an empty result
> for a verified query: only Q4 could actually prove its decoding is right.

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
    bytearray_to_uint256(bytearray_substring(data, 97, 32)) / 1000000000000000000 AS fee_eth,
    bytearray_to_uint256(bytearray_substring(data, 65, 32))         AS amount_in_raw
  FROM ethereum.logs
  WHERE contract_address = 0x6d5791a660e79175f74c6d639584c98422d5956e
    AND topic0 = 0x764f0dc063c06f32d89a3f3af80c0db4be8a090901f589a478b447e0a51f09f1
)
SELECT
  date_trunc('day', block_time) AS day,
  count(*)                       AS swaps,
  sum(fee_eth)                   AS fees_eth_day,
  sum(sum(fee_eth)) OVER (ORDER BY date_trunc('day', block_time)) AS fees_eth_cumulative
FROM swaps
GROUP BY 1 ORDER BY 1;
```
**Approx volume:** fees ÷ fee rate (50 bps = 0.005) → `sum(fee_eth) / 0.005` ETH. For exact
per-token volume, decode `tokenIn` (word 0) / `tokenOut` (word 1) and join a price source.

## Q2 — ETH distributed to stakers (the headline "real yield paid")
`EpochDistributed.ethAmount` is word index 0 (epochId is indexed).
```sql
SELECT
  date_trunc('day', block_time) AS day,
  bytearray_to_uint256(topic1)  AS epoch_id,
  sum(bytearray_to_uint256(bytearray_substring(data, 1, 32)) / 1000000000000000000) AS eth_distributed_day,
  sum(sum(bytearray_to_uint256(bytearray_substring(data, 1, 32)) / 1000000000000000000))
      OVER (ORDER BY date_trunc('day', block_time)) AS eth_distributed_cumulative
FROM ethereum.logs
WHERE contract_address = 0xf993316e2fc079de4358c489a935e01e03e23e17
  AND topic0 = 0x00fef0383cc8c130ab79e3917bd5d847a12414e11b95bf25e1579dc3b8049312
GROUP BY 1, 2 ORDER BY 1;
```

## Q3 — Staker claims (ETH actually withdrawn by stakers)
`Claimed.ethAmount` is word index 0 (user is indexed in topic1).
```sql
SELECT
  count(DISTINCT topic1)                                              AS unique_claimers,
  sum(bytearray_to_uint256(bytearray_substring(data, 1, 32)) / 1000000000000000000)  AS eth_claimed_total
FROM ethereum.logs
WHERE contract_address = 0xf993316e2fc079de4358c489a935e01e03e23e17
  AND topic0 = 0x9cdcf2f7714cca3508c7f0110b04a90a80a3a8dd0e35de99689db74d28c5383e;
```

## Q4 — TOWELI staking rewards funded (RewardAdded)
`RewardAdded.reward` is word index 0 (TOWELI wei, 18 decimals).
```sql
SELECT
  block_time,
  bytearray_to_uint256(bytearray_substring(data, 1, 32)) / 1000000000000000000 AS toweli_funded
FROM ethereum.logs
WHERE contract_address = 0xcadc93e96de58ea554c71ca609974625615e046d
  AND topic0 = 0xde88a922e0d3b88b24e9623efeb464919c6bf9f66857a65e2bfcf2ce87a9433d
ORDER BY block_time;
-- VERIFIED on Dune 2026-07-30: exactly one row —
--   block_time 2026-06-07 06:44:23 UTC, toweli_funded 6400000
-- (an earlier note here said 2026-06-06; that was wrong.)
```

## Q5 — DEX volume from the native pair (UniV2 Swap events)
Pair `Swap(address indexed sender, uint a0In, uint a1In, uint a0Out, uint a1Out, address indexed to)`
→ topic0 `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`. WETH is token1 here
(token0 = TOWELI, verified on-chain), so WETH-side flow = words for a1In + a1Out.
```sql
SELECT
  date_trunc('day', block_time) AS day,
  sum((bytearray_to_uint256(bytearray_substring(data, 33, 32))      -- amount1In  (WETH in)
     + bytearray_to_uint256(bytearray_substring(data, 97, 32))) / 1000000000000000000) AS weth_volume_day -- amount1Out (WETH out)
FROM ethereum.logs
WHERE contract_address = 0x55875887b43c2e23ae424af0fc8606fdb058a481
  AND topic0 = 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822
GROUP BY 1 ORDER BY 1;
```
(Word map for Swap data: a0In=1..32, a1In=33..64, a0Out=65..96, a1Out=97..128.)

---

## Assemble + embed
1. Create each query on dune.com → save → add to a new **Dashboard** ("Tegridy Farms — Real Yield").
2. Counter widgets for totals (Q1 cumulative, Q2 cumulative, Q3 total, Q4); line charts for daily series.
3. Embed in the frontend: each Dune visual has **Embed → iframe**; drop into a new `/analytics` page or the
   home "By the Numbers" section beside the live on-chain `ProtocolStats` strip. Pair the on-chain strip
   (instant) with Dune (historical, third-party-verified) for the strongest trust signal.
4. USD conversion: join `prices.usd` (Dune) on WETH for ETH→USD, or multiply client-side by the Chainlink price.
