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
  pool's own average price, or it does not happen and the coins stay in the escrow. The
  person can close at any time and gets back every coin and every lamport, less the tips
  already paid.
- **What protects the person, said plainly.** Their own worst price is the wall: nothing fills
  below it. The pool-average check stops a slice being robbed by a price pushed just before it,
  but whoever runs a slice may still take up to the band from it (section 4a), so the band is
  capped at 5% and the site should suggest a tight worst price.
- **Where it stands.** Built on branch `feat/vwap-order-program` in `solana/vwap-order/`, with
  20 tests that run it beside the exact program our pools run on mainnet (and beside the pool
  upgrade waiting for the vault), all seen failing first, plus a rehearsal on copies of our real
  BAYLA/SOL pool's accounts. Audited in-house on 2026-11-24 (six reviewers; no way found to take
  an escrow or to dodge the venue's fee); what that audit found in this program is fixed here,
  each fix with a test that failed first (section 9). Not deployed, and no program address
  exists for it (only a placeholder nobody can deploy to).
- **Nothing proven could be copied** (checked 2026-11-19, section 1). Jupiter's order program
  is closed source and being retired; Kamino's is public but its licence forbids production use
  until 2028-12-04. So this is our own code, built from pieces we already run. It breaks the
  "copy proven code" rule, and an audit by our own reviewers does not change that.
- **The owner's decision, 2026-11-21:** an in-house audit on Tuesday 2026-11-24, then deploy on
  the owner's word (about 1.74 SOL of rent, section 7; the steps: `docs/VWAP_ORDER_DEPLOY.md`).
  The earlier recommendation, an outside audit and the shelf until the site version shows demand,
  stands on record.
- Two smaller choices before it goes on chain: who may upgrade it (section 8), and where the
  hour-by-hour weights come from (section 4d).

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
- About 0.0064 SOL of rent while the order is open (6,360,160 lamports at mainnet's rate as read
  2026-11-21: the order account and its two coin accounts). All of it comes back at close.
- A tip per slice, set by the person, at most 0.001 SOL. The site would suggest 0.00001 SOL
  (10,000 lamports). Tips for slices that never ran come back at close.
- The pool's normal fee on each slice, exactly as on any swap: 1% on the 1% tier, 0.75% on the
  launch tier (0.25% trade fee plus the coin creator's 0.5%).
- Up to the band, to whoever runs the slice (section 4a). The band must cover the pool's fee and
  the slice's own price move; what is left over is what a runner can take. At most 5%.

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
priority fee); and, if it chooses to, what the band leaves it (section 4a). Anyone may run slices; our keeper would. Its key holds only SOL for fees and can
take nothing from an order (section 5).

**No venue money can leak:** a slice can only swap through the pool named in the order, one of
ours, and the pool's keeper (our price robot, which swaps free of the trade fee) may not run a
slice.

## 3. Accounts and instructions

Every account is an address only this program can create, derived from the owner and an order
number the person picks.

| Account | Address from | Size | Rent while open |
|---|---|---|---|
| Order | `["order", owner, id]` | 538 bytes | 4,635,360 lamports |
| The escrow (the coin being sold) | `["in", order]` | 165 bytes | 2,039,280 lamports |
| The proceeds (the coin being bought) | `["out", order]` | 165 bytes | 2,039,280 lamports |

The order holds: the owner; the pool, its fee tier and its price record; the two coins; the total,
the worst price (as "at least this much out for the whole amount"), the start, the window length,
the number of slices (1 to 96) and one weight per slice; the band (how far below the pool's
average a slice may land, at most 5%); the tip; what has been spent and received; and the pool's
running price total at the previous slice and at the opening.

| Instruction | Who signs | What it does |
|---|---|---|
| `open_order` | the person | Checks the schedule (window at least 10 minutes), both coins (section 4b) and the pool (it must be our swap program's, trading exactly these two coins, with its own price record, at a price fine enough to check, section 4a); takes the coins into the escrow and the tips into the order |
| `begin_slice` | the runner | Only in the current slice's window, once per window, never by the pool's keeper, never from inside another program. Checks that the next instruction is our pool's `swap_base_input` for exactly this slice, from the escrow into the order's proceeds, signed by the runner, and that the one after is `end_slice` for this order. Then lets the runner spend exactly this slice from the escrow, for this transaction |
| (our pool's own `swap_base_input`) | the runner | The ordinary swap. The pool's swap guard sees a swap of the transaction itself, and takes its usual fee |
| `end_slice` | the runner | Checks the escrow lost exactly the slice and nothing is still lent; that the proceeds grew by at least the person's worst price and by at least the pool's average price less the band, over both stretches of section 4a; pays the tip |
| `take_back` | the person only | Sends the whole balance of ONE of the order's two coin accounts to the person's own account, the order staying open. For a coin whose issuer froze the order's account of the other one |
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
  time that the pool program keeps for every swap. A price pushed in the same second counts for
  nothing in it, and a price held off for a minute counts a minute's share, while our price
  robot trades the pool back. This is the Uniswap V2 time-weighted average pattern the venue's
  rules already name for prices.
- **Two averages, and a slice must meet the higher** (audit 2026-11-24):
  - *Since the previous slice* (at least 5 minutes). On its own this one can be made: a price
    pushed one second after a slice and left there IS the next slice's average. It is kept
    because it is the one that holds when the market rose after the opening.
  - *Since the order was opened.* This one still remembers the price before any push made
    during the order. Its cost: when the price truly falls during the order, by the market or by
    the order's own selling in a pool nobody trades back, later slices wait instead of selling
    lower, and their coins stay in the escrow.
  - For the first slice both start at the pool's last swap before the opening, not at the
    opening itself, so a first slice may run at once in a pool that was quiet for 5 minutes.
- **What the average does not stop, and why the band is small.** Push, slice and unwind can be
  one transaction, with no risk to whoever sends it, and the same-second push is in no average:
  so a runner can always land a slice at the average less the band and keep the difference, less
  the pool fee it pays on its own two swaps. In the tests a 10% band on a slice of 2% of the
  pool's depth cost the person 5.5% of the slice. The band is therefore capped at 5% (it was
  30%), and an honest slice needs most of that for the pool's fee and its own price move: 1.25%
  for a slice of 0.25% of depth on the 1% tier, about 3% for a slice of 2% of depth.
- **A price too coarse to check is refused.** The pool keeps its price as a whole number of
  2^-32 steps, rounded down. A coin with very many units per unit of the other has a price of a
  few steps, or none, and an average of that checks nothing. An order cannot be opened on a pool
  whose price is under 65,536 steps, and a slice is refused if the average is (BAYLA/SOL reads
  about 26 million steps one way and 709 billion the other).
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
| The runner pushes the price, runs the slice, pushes it back (front-running its own slice) | Bounded, not stopped: the slice must land within the band of the pool's averages, and a push in the same second is in neither. Up to the band is the runner's, so the band is at most 5% | `a_price_pushed_just_before_the_slice_is_refused_by_the_pools_average`, `the_order_refuses_a_schedule_it_cannot_keep` |
| Someone pushes the price right after a slice and leaves it there, so the next slice's own average is the pushed price | The average since the order was opened, which the slice must also meet | `a_price_pushed_after_one_slice_and_held_is_refused_by_the_average_since_the_opening` |
| The market rose after the opening, and the runner pushes the price back down by the rise | The average since the previous slice | `a_market_that_rose_since_the_opening_is_measured_since_the_previous_slice` |
| A pool whose price is a few steps of the pool's own arithmetic, or none, so the average checks nothing | Refused at the opening and at every slice | `a_pool_whose_price_is_too_coarse_to_check_is_refused_at_the_opening_and_at_a_slice` |
| A slice handed another order's accounts (its proceeds account, another price record, another tier) | Every account is the order's own, by address | `a_slice_handed_another_orders_accounts_is_refused` |
| The runner takes the lent slice with a plain transfer, or sends the swap's proceeds to itself | The very next instruction must be our pool's swap from the escrow into the order, for exactly the slice; the one after must be `end_slice`; `end_slice` checks the escrow lost exactly the slice and nothing is still lent | `the_runner_cannot_spend_the_slice_any_other_way` |
| A slice swapped where the venue earns nothing: our keeper's free swaps, or another venue | The pool's keeper may not run a slice; only our pool's swap counts | `the_pools_keeper_pays_no_fee_so_it_may_not_run_a_slice` |
| A cancel racing a slice | A slice is one transaction. If it lands first, the close returns the rest; if the close lands first, the slice finds no order and fails | `closing_returns_every_coin_and_every_lamport_to_the_owner_only` |
| A fake pool account, or a fake price record | Read only if owned by our swap program, of the right size and name; the coins must match; the price record must be the pool's own | `a_pool_that_is_not_the_venues_is_refused` |
| A rent drain: closing someone's order to take its rent, or a tip bigger than agreed | Only the owner closes, and every coin and lamport goes to the owner's own accounts; the tip is the owner's, at most 0.001 SOL, from what the owner put in | `closing_returns_every_coin_and_every_lamport_to_the_owner_only` |
| A coin that can empty the escrow (permanent delegate) or run outside code | Refused at opening | `a_coin_with_a_permanent_delegate_is_refused` |
| A slice wrapped inside another program | Refused: both slice instructions run only as instructions of the transaction itself | `a_slice_called_from_inside_another_program_is_refused` |
| A runner running a slice early, twice, or bunching missed ones | One slice per window, in its own window only; at least 5 minutes after the previous one | `a_slice_runs_in_its_own_window_once_and_a_missed_window_stays_in_the_escrow`, `the_average_needs_five_minutes_since_the_previous_slice` |
| Blocking an order by creating its accounts first | Only this program can create those addresses; lamports sent there first do not stop Anchor's creation | not tested |
| A coin issuer freezes one of the order's coin accounts (USDC can) | Not stopped for that coin: the same power it has over the person's wallet. The person's OTHER coin is not held with it: `take_back` returns it alone. The order's rent and unpaid tips wait for the thaw and the close | `a_frozen_coin_does_not_hold_the_other_one_the_owner_takes_each_back_alone` |
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

Mainnet rent read 2026-11-21 (`solana rent`: 5,080 lamports a byte, counting 128 bytes more than
the account holds; the tests' simulator charges the older 6,960, so its figures run higher):

- **Deploying:** the program is 358,512 bytes when built with Solana 2.3.0, the version CI uses
  (this machine's build of 2026-11-24: sha256
  `f4e8692a3383d5611f6c693c0888520d23577568eaae3eacc7148e54925dcfa3`; the audited build was
  341,976 bytes, `38f7627d...`). Rent at the rate read 2026-11-21: 1,822,119,800 lamports for its
  data at exactly that size, plus 833,120 for the program account, about 1.823 SOL (worked out,
  not read again: read `solana rent` on the day); plus a little for the upload's transaction fees. It comes back only if
  the program is closed, which needs whoever may upgrade it.
- **Per order:** 6,360,160 lamports (0.0064 SOL) of rent while open, all back at close, plus the
  person's tips. A slice's three instructions used about 75,000 compute units in the tests (74,868
  on the test pool, 75,121 on copies of the real one), in one ordinary transaction (no lookup
  table needed).
- **Audit:** in-house on 2026-11-24, at the cost of our own reviewers' time. An outside audit was
  estimated, not quoted, at $15,000 to $40,000 for a program this size.

## 8. Before it could ever go on chain

Each step, with its commands: `docs/VWAP_ORDER_DEPLOY.md`.

1. The in-house audit of 2026-11-24, every finding fixed with a test that fails first; then the
   owner's word.
2. The owner makes the program's key (never made by a session); a pull request of its own puts the
   committed placeholder on `solana/guards/allowed-keys.json`, so the key check covers this program
   like the others; `solana-deploy-artifact.yml` (program `vwap-order`) pins the real id at build.
3. Done 2026-11-21: the on-chain security text, as cp-swap's `security_txt!`, and no IDL
   instructions (Anchor adds them unless built without; a stranger could claim the record first,
   as the 2026-11-15 audit found for cp-swap and the launcher).
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
LiteSVM with the clock in hand. The same 20 pass beside the pool upgrade waiting for the vault
(trunk's build, sha256 `3f36e8adb9f541701f8b82df73ff07b76824fe3941381f7d95abdb9563dc7c48`), whose
pool, price record and swap are unchanged. Seen red first (2026-11-19): against a copy whose four
instructions do nothing, all 14 of that day fail; the 15th, `nobody_can_claim_the_programs_idl_record`,
failed on 2026-11-21 before the IDL instructions were turned off (a stranger's claim went
through).
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
| The band at most 5% | `the_order_refuses_a_schedule_it_cannot_keep` |
| The average since the opening | `a_price_pushed_after_one_slice_and_held_is_refused_by_the_average_since_the_opening` |
| The average since the previous slice | `a_market_that_rose_since_the_opening_is_measured_since_the_previous_slice` |
| A price fine enough, at the opening | `a_pool_whose_price_is_too_coarse_to_check_is_refused_at_the_opening_and_at_a_slice` |
| A price fine enough, at a slice | same |
| The pool's own two coin accounts at the opening | same |
| `take_back` only from the order's own two accounts | `a_frozen_coin_does_not_hold_the_other_one_the_owner_takes_each_back_alone` |
| The proceeds account's address, in `begin_slice` and in `end_slice` | `a_slice_handed_another_orders_accounts_is_refused` |
| The tier's and the price record's address | same |

The arithmetic's own copies (the worst price rounded down, the band ignored, slice shares that do
not add up, one window too many, a start far in the past overflowing, a coarse price trusted)
each fail their test under a bare `rustc`. Two first runs taught
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
node fetch-mainnet.mjs /tmp/mainnet.json && VWAP_MAINNET_ACCOUNTS=/tmp/mainnet.json cargo test -- --ignored
```

**The rehearsal** (`rehearsal_on_the_venues_real_bayla_sol_pool`, run 2026-11-21 on accounts read
at slot 472,286,750): the pool, its tier, its two vaults, its price record and both coins (BAYLA's
real mint, with both its extensions), read from mainnet by `fetch-mainnet.mjs` (reads only) and set
at their own addresses. The pool held 72.19 SOL and 11,917,857 BAYLA. Selling 1% of its BAYLA in
4 slices, the first slice landed 1.262% under the pool's mid price (the 1% fee and a 0.25% move),
the venue's and the island's shares grew, a slice after a 5% dump in the same second was refused
by the pool's average, and the close returned the rest.

Not covered: accounts created ahead of an order; a slice run by the pool's real keeper key (the
test's tier is written by hand, with its own keeper).
