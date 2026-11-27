# Our own VWAP

> The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md). This file is a record, not a to-do list.

Owner, 2026-10-13: "we want the best vwap can think about making our own if we save money".
VWAP means volume-weighted average price: the average price a coin traded at, where a big
trade counts for more than a small one. It can mean three different things here.

| Meaning | What it is | Status |
|---|---|---|
| A number | The 24h average on the swap form, beside your trade | Built (2026-10-14) |
| An order | A big trade spread over hours so it lands near the average | Site version built (2026-11-19); an on-chain version is being designed |
| A feed | Our averages offered to other sites or bots | Not built; needs our own indexing |

## 1. The number (built, costs nothing)

The Solana swap form shows one line, for example "BAYLA 24h average: 0.000005153 SOL · this
trade 1.2% above". The same line is on our pool's review. How it is worked out is in a closed
drop-down under it. It never stops or changes a trade.

- **Source.** The 15-minute candles of the pair's busiest pool on GeckoTerminal, read through
  our own server (`frontend/api/_lib/gecko-read.js`, cached at the edge), so it adds no outside
  account and no bill. Code: `frontend/src/lib/solana/swap/pairAverage.ts`.
- **Sum.** Each candle's typical price, (high + low + close) / 3, weighted by its volume, over
  candles that opened in the last 24 hours. Prices and volume are both in the pair's quote coin
  (checked on 2026-10-14: the volume in quote-coin terms times the SOL price equals the volume in
  dollars on each candle compared), so the sum is total quote coin over total base coin.
- **The wrong-coin trap.** GeckoTerminal prices a pool's first-named coin. Each answer names its
  two coins, and the number is turned round when the coin asked for is the other one. Candles
  for any other pair are "could not be read". Tests pin this with real answers kept in
  `frontend/src/lib/geckoTerminal/fixtures/`.
- **The floor.** Under 20 trades, or under $1,000 of trading in 24 hours, or trades in fewer
  than 8 separate quarter-hours, the line says "not enough trading to average". Why: BAYLA
  traded $2,146 in 234 trades in the 24 hours read on 2026-10-14; at $1,000 and 20 trades, one $100 trade is a
  tenth of the day and would set the number on its own, and 8 quarter-hours means trading
  spread over at least two hours, not one burst. BAYLA/USDC's own pools are below this floor
  today, so for that pair the line says so.
- **Not read is not a number.** A read that failed says "could not be read" and is tried again
  after 30 seconds (the free feed rate-limits); a number is read again every 2 minutes.

### Our own pools are not in it (measured, below the 5% bar)

GeckoTerminal does not list our pool program (`EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`):
both of its pools answer "Not Found" (BAYLA/SOL `ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4`,
BAYLA/USDC `J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm`, read 2026-10-14).

Their share, read from the chain for 2026-10-07 11:10 to 2026-10-14 11:10 UTC with keyless
reads: 7 swaps, all in BAYLA/SOL, about 1.09 SOL or $118 in all; plus 3 deposits there and
1 in BAYLA/USDC, which are not trades. The BAYLA pools GeckoTerminal lists traded about
$21,635 in the same week. Our share: about 0.54%, under the 5% bar, so it is not added.

**How and when to add it.** Measure again each month, or when our pools' volume grows. The
method: list each pool's transactions (`getSignaturesForAddress`), read each one
(`getTransaction`), keep the swaps, and take the change in the pool's quote-coin account as the
trade's size. At 5% or more of the week, add a server read in the style of `gecko-read.js`:
it reads our two pools' recent swaps from the chain, turns each into a time, a price and a
volume, and caches the answer at the edge for about a minute; the page adds those trades into
the same sums. About a day of work, still at no cost while the keyless chain reads keep up.

## 2. A VWAP order (site version built 2026-11-19)

Owner, 2026-11-19: "i want to be able to place order based on a volume weighted average price", then
"Both, site version first". The site version is the "slice it" helper recommended below, with the
24h average as its price check:

- **Where.** The Solana swap form's VWAP tab (`components/solana/vwap/`). The page runs the order
  (`lib/solana/swap/vwapRun.ts`) in the one tab holding the browser's lock for the wallet; the money
  stays in the wallet and each slice is an Instant swap through Jupiter that the wallet approves.
- **Sizes.** Slices follow the hours the pair traded over the last 7 days (hourly candles of its
  top pool, `pairAverage.ts` `hourlyProfile`), each between half and twice an even slice; even
  slices when that cannot be read.
- **Price.** A slice goes only while its quote, and the quote its transaction was built from, is
  no worse than the person's limit (0.5%, 1% or 3%) from the 24h average in section 1, both at the
  quoted amount and at the least the swap can pay out (the quote less its 1% slippage). Otherwise
  it waits and tries again each minute; what a slice does not spend goes with the next one.
- **Safety.** A slice is recorded before the wallet is asked and its signature before the first
  send (a signature the browser will not keep is not sent); a signature after Stop, or more than 45 s after the wallet was asked, is not sent; a slice
  sent and not confirmed holds every other one until the chain answers ("did not land" only after
  10 minutes, no note, no status, no history, and its blockhash too old to land).
- **Money.** Each slice pays the usual Jupiter platform fee to the venue; a route that cannot carry
  the fee is never sent as a slice (it waits and tries again). Our own pools are not
  used for slices: a swap there always shows its review first (owner, 2026-10-13).

The rest of this section is the earlier comparison of order designs, kept as the record.

A VWAP order buys or sells a large amount in slices across a day, so the whole lands near the
day's average instead of moving the price at once. No true VWAP order exists on Solana today.

| Option | Who holds the money | Cost to us | What the venue earns | Risk |
|---|---|---|---|---|
| Jupiter's recurring orders (the DCA tab today) | Jupiter's program | Nothing | Nothing | Refuses Token-2022 coins such as BAYLA, both ways; Jupiter is retiring it |
| Jupiter's trigger orders (newer system) | A third party, Jupiter's login provider | Nothing in money; an API key and a login token passed through our server | Nothing | Custody by someone else; the key and the login are ours to run |
| Our own order program | The person's own escrow, one per order | Build roughly 3 to 4 weeks; an outside audit; about 2 to 3 SOL of rent to deploy a program of 300 to 400 KB; each order locks about 0.0064 SOL of rent, paid back when it closes | Our usual fee on each slice | New on-chain code holding money: against our "copy proven code" rule until audited |
| A "slice it" helper on the site, no program | The person's own wallet | Website only, roughly a week | Our usual fee on each slice | Each slice is signed by hand; it stops when the tab closes |

2026-11-19: the owner asked for both, the site version first. The program is designed and built on
a branch, not audited and not deployed, with measured costs: `docs/VWAP_ORDER_PROGRAM.md`.

**Our own order program, in more detail.** Each order would be an escrow account the person
funds and can cancel at any time. Anyone may execute the next slice once its time comes, but
only inside a price band, and the program pays them a small tip for it. The hard part is the
band: a program cannot see a volume-weighted price, and no on-chain price feed we know of
covers BAYLA (check Pyth and Switchboard before building).
Our pool program keeps 100 price observations per pool (a time-weighted price, not
volume-weighted), and our pools are thin, so that price is easy to push. The honest band is
the person's own limit price, set when the order is made. A keeper that posts a VWAP on chain
would be a signer to trust and a key to guard.

**Recommendation: build no order now.** BAYLA trades about $2,000 to $3,000 a day, and on
2026-10-10 only 5 of 178 trades were over $100: nobody needs a day-long order yet. When someone does, build the
"slice it" helper first: no new money-holding code, every slice goes through the swap page's
normal rules and pays the venue its normal fee, and the 24h average line already sits beside
each slice. Build the program only with real demand, money for an outside audit, and someone to
maintain it.

## 3. A feed (not built)

Selling or giving our averages to other sites means passing data on. GeckoTerminal's and other
providers' terms, read on 2026-10-10, do not allow passing their data on without a paid
licence, so a feed cannot be built on the numbers above.

Our own feed would need our own indexing: a service that reads every swap of the pools that
matter (the busiest BAYLA/SOL pool and ours) from the chain, stores them, and computes
candles and averages. `indexer-solana/` already reads one kind of Solana pool into a database;
it would need a reader for each pool program, a paid chain-data plan (keyless reads are rate
limited) and hosting. Not worth it until other sites ask for it.
