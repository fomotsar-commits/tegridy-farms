# VWAP order program (on chain)

> The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md). This file is a design record
> for a program on a branch. Nothing here is deployed.

Owner, 2026-10-13: "we want the best vwap can think about making our own if we save money".
Owner, 2026-11-19: a VWAP order, "Both, site version first". The site version (the person
approves each slice in Phantom, tab open) is built in another branch. This is the other one:
the money waits in an escrow and anyone may send each slice when its time comes.

## What it means, and what the owner decides

- **What a person gets.** They put a big trade in once. It is sold (or bought) in slices across
  the day through our own pools, each slice in its own time window, sized by how busy that hour
  usually is. Every slice must get at least the person's worst price AND land close to our
  pool's own recent average price, or it does not happen and the coins stay in the escrow. The
  person can close at any time and gets back every coin and every lamport, less the tips
  already paid.
- **Where it stands.** Built on branch `feat/vwap-order-program` in `solana/vwap-order/`, with
  14 tests that run it beside the exact program our pools run on mainnet, all seen failing first. Not audited,
  not deployed, and no program address exists for it (only a placeholder nobody can deploy to).
- **Nothing proven could be copied** (checked 2026-11-19, section 1). Jupiter's order program
  is closed source and being retired; Kamino's is public but its licence forbids production use
  until 2028-12-04. So this is our own code, built from pieces we already run. It breaks the
  "copy proven code" rule until an outside audit.
- **The owner's decision:** pay for an outside audit and then deploy (about 2.8 SOL of rent,
  section 7, plus the audit), or leave it on the shelf and run only the site version. **Recommendation: leave it
  on the shelf until the site version shows people want orders it cannot carry** (a whole day,
  tab closed). BAYLA trades about $2,000 to $3,000 a day (`docs/VWAP_PLAN.md`), so today a site
  order covers what people do.
- Two smaller choices, only if it is to go on chain: who may upgrade it (section 8), and where
  the hour-by-hour weights come from (section 4d).

## 1. Is there a proven program to copy? No

Read 2026-11-19 (licence files through the GitHub API, feed lists through the oracles' own APIs).

| Program | Source public? | Licence | Could we copy it under our id? |
|---|---|---|---|
| Jupiter recurring (DCA) `DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M` | No: only an interface file, archived, no licence | none | No. Also refuses Token-2022 coins, and Jupiter says it is being retired; its replacement keeps the money with a custody company, off chain |
| Jupiter limit orders v2 | No | none | No |
| Kamino Limo (limit orders, "flash take") | Yes | Business Source Licence 1.1, no extra use granted, GPL from 2028-12-04 | **No production use until 2028-12-04** |
| Mango v4 conditional swaps | Yes | GPL-3.0 for its instructions | Legally yes, with copyleft duties, but it trades against Mango's own margin accounts, not slices through a pool; Mango wound down in January 2025 |
| Clockwork, Helium tuktuk | Yes | AGPL-3.0, Apache-2.0 | Only a crank (a timer), no escrow or swap |
| OpenBook v2, Phoenix | Yes | GPL/MIT, MIT | Order books, no time slices |

What we took instead, as RULES (no code): CoW Swap's TWAP order (GPL-3.0, audited): fixed
parts, each valid only in its own window, a part not filled in its window expires and its coins
stay with the owner. And the shape of Jupiter's and Kamino's "flash" fills: one instruction lends,
the next must settle, in the same transaction.

What we copied as CODE, from programs already on mainnet in this repo: the coin check and the
transfer helper (bayla-ladder's `token.rs`, itself cp-swap's), the account layouts of our cp-swap
copy (read, not changed), and Anchor's standard account checks.

## 2. How money moves

**How the person pays.**
- Their coins go into the escrow when they open the order (one transaction, one signature).
- About 0.0085 SOL of rent while the order is open (8,546,880 lamports: the order account and its
  two coin accounts). All of it comes back at close.
- A tip per slice, set by the person, at most 0.001 SOL. The site would suggest 0.00001 SOL
  (10,000 lamports). Tips for slices that never ran come back at close.
- The pool's normal fee on each slice, exactly as on any swap: 1% on the 1% tier, 0.75% on the
  launch tier (0.25% trade fee plus the coin creator's 0.5%).

**How the venue earns.** Its usual share of each slice's pool fee, nothing more:
- 1% tier: the venue gets 10.4% of the fee, which is 0.104% of the slice; the island gets 5.6% of
  the fee (0.056%); the pool's liquidity providers keep 84% (0.84%), and the venue's own liquidity
  in the pool earns its part of that.
- Launch tier: the venue gets 13% of the 0.25% trade fee (0.0325% of the slice), the island 7%
  (0.0175%), the creator keeps the 0.5% creator fee.
- Basis: the tier settings pinned in `solana/tegridy-amm/programs/cp-swap/src/states/config.rs`,
  and the test `a_slice_sells_through_the_venue_pool_pays_its_fee_and_tips_the_runner`, which
  measured a 250,000,000-unit slice paying a 2,500,000 fee with 260,000 to the venue and 140,000
  to the island.
- The program takes no fee of its own and has no fee account, so there is nothing to redirect.

**What the person signs.** Opening and closing are one transaction and one signature each, with
no durable nonce, so neither of Phantom's two hard warnings (two or more transactions in one
request; a durable nonce) arises. The person never signs a slice.

**How the runner earns.** The tip, minus its own network fee (5,000 lamports a signature, plus any
priority fee). Anyone may run slices; our keeper would. Its key holds only SOL for fees and can
take nothing from an order (section 5).

**No venue money can leak:** a slice can only swap through the pool named in the order, one of
ours, and the pool's keeper (our price robot, which swaps free of the trade fee) may not run a
slice.

## 3. Accounts and instructions

Every account is an address only this program can create, derived from the owner and an order
number the person picks.

| Account | Address from | Size | Rent while open |
|---|---|---|---|
| Order | `["order", owner, id]` | 514 bytes | 4,468,320 lamports |
| The escrow (the coin being sold) | `["in", order]` | 165 bytes | 2,039,280 lamports |
| The proceeds (the coin being bought) | `["out", order]` | 165 bytes | 2,039,280 lamports |

The order holds: the owner; the pool, its fee tier and its price record; the two coins; the total,
the worst price (as "at least this much out for the whole amount"), the start, the window length,
the number of slices (1 to 96) and one weight per slice; the band (how far below the pool's
average a slice may land, at most 30%); the tip; what has been spent and received; and the pool's
running price total at the previous slice.

| Instruction | Who signs | What it does |
|---|---|---|
| `open_order` | the person | Checks the schedule (window at least 10 minutes), both coins (section 4b) and the pool (it must be our swap program's, trading exactly these two coins, with its own price record); takes the coins into the escrow and the tips into the order |
| `begin_slice` | the runner | Only in the current slice's window, once per window, never by the pool's keeper, never from inside another program. Checks that the next instruction is our pool's `swap_base_input` for exactly this slice, from the escrow into the order's proceeds, signed by the runner, and that the one after is `end_slice` for this order. Then lets the runner spend exactly this slice from the escrow, for this transaction |
| (our pool's own `swap_base_input`) | the runner | The ordinary swap. The pool's swap guard sees a swap of the transaction itself, and takes its usual fee |
| `end_slice` | the runner | Checks the escrow lost exactly the slice and nothing is still lent; that the proceeds grew by at least the person's worst price and by at least the pool's average price less the band; pays the tip |
| `close_order` | the person only | Sends both coins' whole balances to the person's own accounts, closes the three accounts, every lamport to the person |

A slice is one transaction of these three instructions. If any check fails, all of it is undone.
A window nobody runs simply passes: its coins stay in the escrow and come back at close (CoW's
rule). A late runner cannot bunch slices together.

## 4. The hard parts

### 4a. A program cannot see a volume-weighted price. It does not need one

- **No feed covers BAYLA.** Pyth: none (searched 2026-11-19: 1,949 Hermes feeds and 4,018 Pyth Pro
  symbols, no "bayla"), and Pyth has no volume-weighted feed type at all. Switchboard: whether a
  BAYLA feed exists, the search did not complete (feeds are listed by hash, with no name index);
  anyone can make one, and it has a VWAP task type, but someone must pay for every update and its
  answer is only as good as the pools it reads.
- **What gets the person near the day's average is the slicing itself**, spread over the day and
  sized by volume. What the program must stop is a slice being robbed: someone pushing the price
  just before it, or the runner picking a bad moment.
- **For that it reads our own pool's price record**, the running total of the pool's price over
  time that the pool program keeps for every swap. The program takes the average over the time
  since the previous slice (at least 5 minutes, since the order was opened for the first slice).
  A price pushed in the same second counts for nothing in it, and a price held off for a minute
  counts a minute's share, while our price robot trades the pool back. This is the Uniswap V2
  time-weighted average pattern the venue's rules already name for prices.
- **A keeper that posts a VWAP on chain is not needed**, and would cost more than it saves: a
  server running all day, a hot key whose holder could post a low price and let every open order
  fill badly for a sandwicher to pocket, a second program to audit, and SOL for every update.

### 4b. BAYLA is a Token-2022 coin, in both directions

The escrow and the proceeds are made with the coin's own token program, and every move uses
`transfer_checked` with the coin's own decimals, which both token programs accept (cp-swap's and
bayla-ladder's way). The coin check is bayla-ladder's, word for word: a classic coin, or a
Token-2022 coin whose only extensions are the two metadata ones BAYLA and pump.fun coins carry.
Refused: a transfer fee (a slice would get less than the pool sent), a transfer hook (outside code
on every move), a permanent delegate (someone else could empty the escrow), anything newer. Unlike
bayla-ladder, a freeze authority is allowed: USDC has one, and it can freeze only the person's own
coin, as it could in their wallet. Tests: Token-2022 sold, Token-2022 bought, a permanent-delegate
coin refused.

### 4c. Which pools, and how the fee stays ours

- Only our cp-swap pools (`EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`), one pool per order,
  fixed at opening. Not range pools yet: their swap is a different instruction, and their fix
  build is not on chain. Never Jupiter or another venue.
- The slice is an ordinary swap of our pool, so its fee, the venue's share and the island's share
  are taken by the pool program exactly as for anyone else. Nothing new decides a fee.
- **Why the slice is not simply called from inside this program:** our pools' swap guard (on since
  2026-11-14) refuses a swap that another program calls, unless the pool's keeper signs it, and
  the keeper pays no trade fee. So the runner signs the swap itself, as the transaction's own
  instruction, spending from the escrow for that one instruction only.

### 4d. Slice sizes that follow the day's volume

Each slice has a weight; a slice's share is its weight over the sum (the shares add up to the
total exactly). The person's own transaction sets them, so nobody else can change them. Equal
slices when none are given.

Who supplies them: the site, from the pair's volume by hour of day over the last week. It already
reads GeckoTerminal's 15-minute candles for the 24-hour average line. **Owner's call:** weights
written into an order are public on chain and are worked out from GeckoTerminal's data, whose terms
(read 2026-10-10) forbid passing their data on. The safe alternative is weights from the chain's own
swaps (our own reading), which is the "feed" work of `docs/VWAP_PLAN.md` section 3.

## 5. Hijack list: what an attacker tries, and what stops it

| Attack | What stops it | Test |
|---|---|---|
| The runner pushes the price, runs the slice, pushes it back (front-running its own slice) | The slice must land within the band of the pool's average since the previous slice; a push in the same second is not in that average | `a_price_pushed_just_before_the_slice_is_refused_by_the_pools_average` |
| Someone else sandwiches the runner's transaction in a thin pool | The same check, and the person's worst price under it. What is left: an attacker who holds the price off for minutes against our price robot, paying the pool fee both ways, can take at most the band on one slice | same |
| The runner takes the lent slice with a plain transfer, or sends the swap's proceeds to itself | The very next instruction must be our pool's swap from the escrow into the order, for exactly the slice; the one after must be `end_slice`; `end_slice` checks the escrow lost exactly the slice and nothing is still lent | `the_runner_cannot_spend_the_slice_any_other_way` |
| A slice swapped where the venue earns nothing: our keeper's free swaps, or another venue | The pool's keeper may not run a slice; only our pool's swap counts | `the_pools_keeper_pays_no_fee_so_it_may_not_run_a_slice` |
| A cancel racing a slice | A slice is one transaction. If it lands first, the close returns the rest; if the close lands first, the slice finds no order and fails | `closing_returns_every_coin_and_every_lamport_to_the_owner_only` |
| A fake pool account, or a fake price record | Read only if owned by our swap program, of the right size and name; the coins must match; the price record must be the pool's own | `a_pool_that_is_not_the_venues_is_refused` |
| A rent drain: closing someone's order to take its rent, or a tip bigger than agreed | Only the owner closes, and every coin and lamport goes to the owner's own accounts; the tip is the owner's, at most 0.001 SOL, from what the owner put in | `closing_returns_every_coin_and_every_lamport_to_the_owner_only` |
| A coin that can empty the escrow (permanent delegate) or run outside code | Refused at opening | `a_coin_with_a_permanent_delegate_is_refused` |
| A slice wrapped inside another program | Refused: both slice instructions run only as instructions of the transaction itself | `a_slice_called_from_inside_another_program_is_refused` |
| A runner running a slice early, twice, or bunching missed ones | One slice per window, in its own window only; at least 5 minutes after the previous one | `a_slice_runs_in_its_own_window_once_and_a_missed_window_stays_in_the_escrow`, `the_average_needs_five_minutes_since_the_previous_slice` |
| Blocking an order by creating its accounts first | Only this program can create those addresses; lamports sent there first do not stop Anchor's creation | not tested |
| A coin issuer freezes the escrow (USDC can) | Not stopped: the same power it has over the person's wallet. Said in the site's small print | none |
| Whoever may upgrade this program replaces it and takes every escrow | The owner's choice in section 8 | none |

## 6. What is ours, and what is copied

Copied: the coin check and transfer helper (bayla-ladder, verbatim less its two refusals of a
mint or freeze authority), the pool's account layouts and its swap (read and called, never
changed), Anchor's account checks. Rules taken without code: CoW's windows; Jupiter's and Kamino's lend-then-settle shape.

Ours, about 650 lines of Rust, half of them account lists, events and error messages: the
schedule and slice arithmetic (`math.rs`, tested on its own under a bare `rustc`), the reading of
three pool accounts (`cpswap.rs`), and the four instructions (`lib.rs`). Each could be deleted: dropping the average check leaves only the worst
price; dropping the weights leaves equal slices.

## 7. Costs

- **Deploying:** the program is 396,552 bytes when built with Solana 2.3.0 (the version CI uses;
  this machine's build has sha256 `b34fe4ddb5fcc398a26bccda7b0e37c786a4b74d0357d8bea091676e3b436261`).
  Rent for it: 2,761,206,000 lamports (2.76 SOL) at exactly that size, plus 1,141,440 for the
  program account; about 3.45 SOL with 25% room for audit fixes, so a later upgrade needs no
  extension. Plus about 0.003 SOL of transaction fees to upload it. The rent comes
  back if the program is ever closed.
- **Per order:** 8,546,880 lamports (0.0085 SOL) of rent while open, all back at close, plus the
  person's tips (the test order of 4 slices held 8,586,880 lamports: rent plus 4 tips of
  10,000). A slice's three instructions used 73,845 compute units in the tests, in one ordinary
  transaction (no lookup table needed).
- **Outside audit:** an estimate, not a quote: a program this size is a one-to-two-week job for one
  or two auditors, in the range of $15,000 to $40,000 at the firms `solana/tegridy-amm/AUDIT_RFQ.md`
  lists. No quote has been asked for.

## 8. Before it could ever go on chain

1. The owner's word, then an outside audit, every finding fixed with a test that fails first.
2. The owner makes the program's key (never made by a session), and a pull request of its own puts
   it on `solana/guards/allowed-keys.json`, so the key check covers this program like the others.
3. The on-chain security text, as cp-swap's `security_txt!`.
4. **Who may upgrade it.** Whoever can upgrade it can take every escrow. Recommended: the Squads
   vault, whose 48-hour lock gives people time to close their orders before any upgrade lands; or
   no one at all once the audit's fixes are in (then a bug can never be fixed, only avoided).
5. The site: an open and a close screen (one transaction each; SOL is wrapped and unwrapped in the
   same transaction), and the keeper's slice loop on its own key, never the price robot's.
6. A row in `frontend/scripts/addresses.json`.

## 9. Tests

`solana/vwap-order/litesvm-tests/` runs the order program beside our pool program's mainnet build
(sha256 `9f0150e3349cc415a23c37185ee77f17667b0d433b2ccf7506a9a2e814666146`, the build mainnet runs
since proposal #35), with the swap guard on and a keeper named, as mainnet's 1% tier has them, in
LiteSVM with the clock in hand. Seen red first (2026-11-19): against a copy whose four instructions do nothing, all 14 fail.
Then each check was taken out in a copy of its own, and each copy fails the test beside it:

| Check taken out | Test that fails |
|---|---|
| The next instruction must be our pool's swap | `the_runner_cannot_spend_the_slice_any_other_way` |
| The swap spends exactly the slice | `volume_weights_set_each_slice_and_the_swap_must_spend_exactly_it` |
| The swap pays into the order | `the_runner_cannot_spend_the_slice_any_other_way` |
| The swap names the order's own pool | `the_runner_cannot_spend_the_slice_any_other_way` |
| The instruction after the swap is this order's end | `the_runner_cannot_spend_the_slice_any_other_way` |
| The person's worst price | `a_slice_below_the_persons_worst_price_is_refused_and_nothing_moves` |
| The pool's average less the band | `a_price_pushed_just_before_the_slice_is_refused_by_the_pools_average` |
| 5 minutes since the previous slice | `the_average_needs_five_minutes_since_the_previous_slice` |
| One slice per window | `a_slice_runs_in_its_own_window_once_and_a_missed_window_stays_in_the_escrow` |
| The pool's keeper may not run a slice | `the_pools_keeper_pays_no_fee_so_it_may_not_run_a_slice` |
| A slice only as the transaction's own instruction | `a_slice_called_from_inside_another_program_is_refused` |
| The coin check | `a_coin_with_a_permanent_delegate_is_refused` |
| The pool must be our swap program's | `a_pool_that_is_not_the_venues_is_refused` |
| Only the owner closes | `closing_returns_every_coin_and_every_lamport_to_the_owner_only` |
| At most 96 slices | `the_order_refuses_a_schedule_it_cannot_keep` |

The arithmetic's own copies (the worst price rounded down, the band ignored, slice shares that do
not add up, one window too many) each fail their test under a bare `rustc`. Two first runs taught
two tests: the swap's bytes sent to another program, and a third instruction that is not this
order's end, both now in `the_runner_cannot_spend_the_slice_any_other_way`.

Checks no test can reach while the others hold, kept as a second wall: `end_slice`'s "the escrow
lost exactly the slice and nothing is still lent" and `begin_slice`'s "no slice is open" (the
three instructions are one transaction, pinned by `begin_slice`). The swap's signer must be the
runner, but without that check the token program refuses the swap anyway, as only the runner was
lent the slice. The key check (`solana/guards/key-guard.mjs`) passes on the program and refuses it
with Raydium's admin key added, or with Raydium's own pool program in place of ours.

Run them from WSL (the operator's Windows box cannot run the Solana tools), Solana 2.3.0:

```
cd solana/vwap-order/programs/vwap-order && rustc --edition 2021 --test src/math.rs -o /tmp/vwap_math && /tmp/vwap_math
cargo test --lib
cargo build-sbf -- --locked
cd ../../../tegridy-amm/programs/cp-swap && cargo build-sbf -- --locked
cd ../../tests/cpi-caller && cargo build-sbf -- --locked
cd ../../../vwap-order/litesvm-tests && cargo test
```

Not covered: BAYLA's second extension (`TokenMetadata`; the test coin has only `MetadataPointer`,
and the check is bayla-ladder's, which takes BAYLA on mainnet), accounts created ahead of an order,
and real mainnet depth (the test pool is 100,000 units of each coin).
