# Price keeper (week 1: watch only)

Our own pools drift away from the outside price, because no outside bot watches them
(Jupiter does not route to our pool program). On 2026-10-16 BAYLA/SOL had drifted 21.6%
below pump.fun, and one trader made 0.243 SOL closing the gap, out of the pool's LPs.

The price keeper will close those gaps early and keep the pools within about 2% of the
outside price. **This first version only watches.** It holds no key, signs nothing and
sends nothing. It writes down, every 30 seconds, what a correction would have made, so
the owner can decide on real numbers whether to go live.

Revived 2026-10-25 (owner: "Revive the price keeper from #844 in its own PR: watch-only
first for a week"; #844 was closed unmerged on 10-24). When it goes live, **its profit goes
to the treasury** (the Squads vault), not to the pools' LPs (owner, 2026-10-25: "it should
pay to our treasury and we can distribute how we want").

## What it does on each look

1. Reads BAYLA/SOL and BAYLA/USDC from the chain: four accounts per pool in one request,
   so the reserves and the fees they owe come from the same moment. It checks right away
   that the fee tier pays the agreed split, the venue's share to our Squads vault and the
   island's share to its Workshop, even if nothing else can be read.
2. Reads BAYLA's price on pump.fun's pool (the deep one, ~333 SOL a side) from two Jupiter
   quotes: a buy and a sale back. For BAYLA/USDC it also reads SOL's price in USDC.
3. Works out the gap and the gap at which a correction starts to pay. Buying here and
   selling on pump.fun pays beyond about 2.03% (our 1% fee plus pump.fun's ~1%); buying
   on pump.fun and selling here beyond about 2.1%, because that route also gives up the
   pump.fun leg's 0.1% minimum.
4. If a correction would pay, finds its best size (capped at 0.5 SOL or 20 USDC), then
   **confirms it with real quotes at exactly those amounts**. Only the confirmed number
   counts. If the confirming quote is more than 2% off what the first quotes said, the
   outside price was moving, and nothing is counted.
5. Prints one line per pool and appends it to `keeper/log/watch-<UTC date>.jsonl`.

"Gap" in a line is how far pump.fun's price is above (+) or below (-) ours, as a share
of ours. Alerts say it the other way round, as a share of pump.fun's price ("BAYLA is
21.6% cheaper here than on pump.fun").

It alerts (in its window, and on Telegram if set up) when a pool is 3% or more off, when
pump.fun's price jumps more than 15% in a minute (the live keeper would pause then, so
those looks are not counted), when it cannot read for 10 minutes, when a fee tier stops
paying the agreed split (venue to our Squads vault, island to its Workshop), and when a
pool suddenly names a different fee tier or vault (it then stays unread until restarted
on purpose). Once a day it sends a summary. If its log cannot be written it says so and
keeps watching.

## Run it

Node 24, nothing to install. From the repository root:

```bash
node keeper/src/watch.js --once
```

```bash
node keeper/src/watch.js
```

```bash
node keeper/src/report.js
```

`--once` takes one look and prints it. Without it, it watches until stopped (Ctrl+C).
`report.js` turns the log into the week's numbers: how many hours it really ran (and for
how long it was not running), how often it could not read, in how many stretches a
correction would have paid and about what it would have made, the biggest gap among the
looks it could read, and whether a correction fits in one transaction. An unread look is
never counted as "no gap".

A laptop that sleeps misses hours. For the full week, run it on any small always-on
server (about $5 to $10 a month); it needs no key there either.

## Settings (all optional)

| Setting | What it does |
|---|---|
| `KEEPER_RPC_URL` | Solana RPC to read from. Default: the public mainnet endpoint. Never printed. |
| `JUPITER_API_KEY` | A free Jupiter key (developers.jup.ag/portal). Without it, Jupiter's keyless host, which Jupiter is retiring. |
| `KEEPER_TAKER` | Any public wallet address. With a Jupiter key, turns on the size check below. Only the address: no key. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Send alerts to Telegram too. The token is never printed. |
| `KEEPER_INTERVAL_SECONDS` | Seconds between looks. Default 30, minimum 10. |
| `KEEPER_LOG_DIR` | Where the log goes. Default `keeper/log/`. |

**The size check.** A correction must fit in one transaction (1,232 bytes). Our swap names
13 accounts that are in no lookup table, on top of Jupiter's. With `JUPITER_API_KEY` and
`KEEPER_TAKER` set, every correction that would pay is put together as instructions and
measured, never signed or sent. Jupiter's lookup tables are read from the chain, not
taken on Jupiter's word. Where the keeper cannot know one of the taker's token accounts
it counts a stand-in, so the number can only be too high: "fits" can be believed, and a
"maybe too big" says how many stand-ins it counted. If it really does not fit, going live
needs a lookup table the owner creates and signs: better to know in week 1.

## Rules it keeps

- **BAYLA's outside price comes only through pump.fun's one pool.** A quote through any
  other pool is refused, so a thin or odd pool can never become the price it follows.
- **The SOL/USDC step bans every Raydium venue**, by the names Jupiter itself lists, and a
  route that still crosses one is refused (owner, 2026-10-13: no money to Raydium, ever).
- A price that came through our own pools is never an outside price.
- **It follows the outside price; it never sets one.** There is no target price anywhere
  in it. A correction keeps no position: each middle step passes on only what the step
  before it guarantees, and what a fill gives above that (at most 0.1% of one
  correction's BAYLA or SOL) is left over and sold on the next correction.
- Unread is never "no gap": a pool it could not read is logged as unread.
- Text that Jupiter or an RPC sends is never repeated into an alert, and every answer is
  read with a size cap.

## How money would move on a live correction

Example: today's best BAYLA/SOL correction, 0.144 SOL in.

- **Our pool's 1% fee:** 0.84% stays in the pool for its LPs; 0.104% goes to the venue
  (collectable only by the Squads vault) and 0.056% to the island's Workshop, the agreed
  split live since 2026-10-19.
- **pump.fun's ~1% on the other side** goes to pump.fun, its LPs and BAYLA's creator
  account (the island's Workshop, not ours). The exact split is not confirmed. This is the
  keeper's money (the owner's), not venue money.
- **Jupiter** charges no fee on the call the keeper uses (`/swap/v2/build`).
- **Jito and validators** get the tip (~0.00001 SOL) and the network fee (0.000005 SOL).
- **The treasury gets the profit:** about 0.0007 SOL here. Whatever the keeper holds above
  the owner's float is sent to the Squads vault (`config.js` `PROFIT_TO`), and the owner
  decides from there how it is shared. LPs do not get it: they still pay the gap, as they
  do now when a stranger closes it; the difference is who keeps it.
- **Why it still protects LPs:** what a pool loses to a correction grows with the square of
  the gap. One 20% gap costs LPs about ten times more than ten 2% gaps, so closing gaps
  early shrinks their loss even though the profit goes to the treasury. Expect small
  amounts: this is upkeep, not income.
- **Trade-off:** the keeper will make corrections that visitors now make through our own
  swap page, and those visitor trades pay the venue 0.5% on their Jupiter leg. On 10-16
  that came to 0.0124 SOL in site fees, while the visitor kept 0.243 SOL of profit after
  every fee. The treasury keeps that profit instead, so the venue still comes out ahead.

## Before it may go live (week 2, the owner's call)

- The owner creates the keeper's wallet on the server himself and funds it from his own
  wallet: about 1 SOL and 25 USDC. **Never from the Squads vault**, which would put venue
  money in a hot wallet. Claude never sees the key.
- Each correction is one transaction, sent as a Jito bundle. Its last leg's minimum out is
  (money in + costs + minimum profit), and every middle leg passes on only the previous
  leg's minimum, so a correction that would not pay is cancelled by the chain. Buys on our
  pool use exact-out (`swap_base_output`), so no BAYLA is left over there; that needs an
  exact port of the program's exact-out maths, tested against the Rust.
- It signs only for our pool program, Jupiter, the token and system programs and the Jito
  tip, and refuses anything else.
- **Profit to the treasury.** Anything the keeper holds above the float is sent to the
  Squads vault: SOL straight to the vault, USDC to the vault's own USDC account. If the
  vault has no USDC account yet, USDC profit waits in the keeper until the owner says how
  to open one. The float itself is never sent anywhere: it stays the owner's.
- Stops itself after losing 0.02 SOL in a day, after 5 failed sends in a row, or on a
  price that fails its checks. A big outside jump pauses it and alerts the owner.
- The pool page (`frontend/src/lib/solana/lp/poolPast.ts`) labels the keeper's swaps, and
  the fine print says the venue runs it and that its profit goes to the treasury, not to
  the pool's LPs. Its trades are never counted as volume or as traction. Other sites will
  count them anyway.
- A lookup table, if the size check says a correction does not fit.
- `test/watchOnly.test.mjs` is changed on purpose, in its own reviewed change. Until then
  it fails on the known ways to sign or send: any network call outside three files, any
  host but the four it uses, any Jupiter path that trades, any write method, any npm
  package, dynamic import, child process or crypto signing, in every file the keeper
  runs. No list catches every spelling, so review still matters.

Not watched: SOL/USDC (an outsider's ~$140 pool; a fix pays under a cent) and TOWELI on
Ethereum (0.19% off, and the EVM side is frozen).

## Tests

```bash
node --test "keeper/test/*.test.mjs"
```

Recorded mainnet answers and stand-in fetches; no network. CI runs them in the "Price
keeper unit tests" step. To record fresh answers (the recorder checks every value and
prints only what passed; it never writes a file itself):

```bash
node keeper/scripts/record-fixtures.mjs > keeper/test/fixtures/mainnet.json
```
