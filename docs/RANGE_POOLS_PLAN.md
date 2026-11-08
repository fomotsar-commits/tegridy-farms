# Range pools: the venue's own program

> The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md). This file is the plan for range pools and a record of phase 0.

Range pools let a liquidity provider put money in at a chosen price range, or with one coin
only. The venue's pool program today cannot: it is constant product by design. The owner ruled
on 2026-10-13 that range pools must be the venue's own, and that no money may ever go to
Raydium, whose open code we copy.

## Phase 0, done 2026-10-14: the code is in, ours, and it builds

- **What was copied.** Raydium's concentrated-liquidity program (github.com/raydium-io/raydium-clmm,
  Apache-2.0, the only proven range program whose licence allows a commercial copy), at commit
  `ed1eb41519d5355755f7df52b43fa9610938b60b`, into `solana/tegridy-clmm/`. Its own workspace,
  because it builds with Anchor 1.0.2 and Solana 3.1.10 while our three programs stay on 0.32.1.
- **Why that commit.** The rule is "the code that holds the money". Raydium's live program
  (`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`) is not a verified build: the public registry
  (verify.osec.io) says `is_verified: false`, and its five attempts all name older commits. So
  no hash proves it. Every other sign points at this commit: the program was last deployed at
  slot 451,479,902 (2026-09-29 00:27 UTC), two minutes before this commit was merged, and the live
  binary holds an error text ("Lamports calculate error") that first appears in this commit's
  branch. It holds nothing from Raydium's later, unmerged change. **Not proven, very likely.**
- **What changed.** Identity, two build guards, and three of the vault's powers cut (the owner's
  ruling, 2026-10-20). 135 changed lines in 18 files: the roles and names in the next section, a
  gate that refuses a test-chain build (below), the one line that reads `uint` from our own folder,
  and 24 lines that hold fees to 4% and the venue and island to 16% of each fee, let only the fund
  owner collect the island's share, and keep a reward's take-back with its funder. Every other
  program file is byte for byte Raydium's. `Cargo.lock` is Raydium's, pruned to the program's own 317 crates. `README.md`
  is ours. `vendor/uint` is Raydium's copy of the `uint` crate (MIT or Apache-2.0) at the
  commit Raydium's lock named (`43a0303b9c2a23a00508816bd6d5a2e9381f143c`), unchanged, with its
  two licence files. So the build fetches nothing from Raydium.
- **It builds.** Built locally (Solana 3.1.11 tools in WSL, one patch release newer than
  upstream's pin; CI builds on the exact 3.1.10), offline: 1,523,176 bytes (1,522,736 after the vault-power fixes of 2026-10-20), no stack-size
  warning. Raydium's own 200 unit tests pass on the copy (1 skipped, as upstream skips it). A
  build without the `placeholder-id` setting is refused, and so is a build with `devnet` or
  `localnet` unless `test-chain-keys` is also named.
- **Nothing was deployed, no key was made, and the website did not change.**

## Who holds what

Raydium's code names nine roles by address. Each is replaced. "Vault" is the venue's Squads vault
`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` (two signatures needed). Devnet copies of each
role use the venue's devnet key `GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a`.

| Role | Raydium's address | Ours | What it can do |
|---|---|---|---|
| Program id | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | `7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso`, made by the owner on 2026-10-21 | Claimed by the first deploy; afterwards only its upgrade authority, the vault, can change the program |
| Admin | `GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ` | vault | Make and change fee tiers (at most 4% of a swap; at most 16% of each fee to the venue and the island together; tick spacing above 0), pause a pool, turn its limit orders on, collect the protocol's share |
| Protocol-fee owner | `projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416` | vault | Collect the protocol's share of swap fees |
| Fund-fee owner | `FundHfY8oo8J9KYGyfXFFuQCHe7Z1VBNmsj84eMcdYs4` | vault, as each tier is born; the same proposal then hands each tier's fund share to the island's Workshop, its one hand-over (since 2026-11-03 the vault can never move it again) | Collect the fund's share of swap fees |
| Spare-SOL collector | `Ray9LdYRLXsHzL8pr3Ceahfiz8MsS2pZagzHo1ckdfJ` | vault | Nothing since 2026-11-03: its sweep is deleted from the source (on chain from the upgrade after #22), and nothing reads the key. The sweep could trim users' refundable deposits |
| Limit-order keeper | `Ray8HHtixhL9zvnokMyELCVGp622PDPJj96zcVC9RWp` | vault | Settle or close a user's limit order; the coins go to the order's owner only. Since 2026-11-03 a new pool takes no limit order until the admin turns them on |
| Permission admin | `RayzVBPm6p6xtG7fU3KX4k44UexK4NjewDk2QCwoLqa` | vault | Nothing since 2026-11-03: permissioned pools and their permissions are deleted (the owner's ruling), and nothing reads the key |
| Support-mint owner | `RayVyjyJQz9vAi126A4sGexKnSU1XeZaHTRcM1mZMPY` | vault | Let in a coin with unusual Token-2022 features. Since 2026-11-03 the source ignores such a record (on chain from the upgrade after #22), so it lets in nothing |
| Frozen-NFT issuer list | `2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x` (an outside coin issuer) | empty | Nothing: no position NFT is ever frozen |

Also replaced: the on-chain security text (now memetics.finance, our contact, no audit claim),
the position NFT's name, symbol and link ("Memetics Range Position", "MEM-RANGE",
`memetics.finance/position/<id>.json`), and three memos that said "raydium" (never sent: Raydium's
own calls to them are commented out).

**Where the money goes.** Swap fees stay in the pool for the people whose range was in use;
each position collects its own. The protocol share can be collected only by the vault. The fund
share can be collected only by the tier's fund owner, the island's Workshop: Raydium's code let
the admin collect it too, and the venue removed that (the owner's ruling, 2026-10-20). No tier may
charge more than 4% of a swap, nor give the venue and the island together more than 16% of each
fee; both are checked when a tier is made and when it is changed, and since 2026-11-03 no pool can
carry a dynamic fee at all. Two exceptions: a fee is rounded up to the coin's smallest unit, so a
very small swap can pay more than 4% (and a Token-2022 coin's own transfer fee comes on top); and
when a swap fills a limit order where no LP's range is in use, the LPs' share of that fee goes to
the venue's share. The ceilings bind every tier this build makes; a later upgrade must check any
tier made before it. Opening a pool costs 0.5 SOL, paid to the vault through `create_pool`, the
one instruction that opens one (owner, 2026-10-25; "Decided 2026-10-25", below). Until the vault upgrades
the program on mainnet, the program there charges nothing to open a pool. Spare SOL sent to a
pool's accounts stays there: the sweep is deleted (2026-11-03). None of these paths can reach a
Raydium address, because none is in the code. Each path was run on a local chain (below).

**How the vault can still move the island's share**, each by a proposal (two signatures, then 48
hours):

- it can no longer point a handed-over share anywhere else, itself included (the owner's ruling,
  2026-11-03; check V6): `update_amm_config`'s param 4 works only while the vault still holds the
  share, so after a tier's one hand-over only a program upgrade can move it. Until the upgrade
  after #22 the program on chain still allows it;
- re-split a tier: set the island's part to nothing, then raise the venue's part into the room,
  within the 16% ceiling. The vault keeps this rate setting on purpose: phase two of the split
  needs it;
- let in a Token-2022 coin (support-mint) whose owner can move coins out of any account (a
  permanent delegate), which would reach the pool's vault: so the vault lets in no such coin.
  This one closes with the upgrade after #22: since 2026-11-03 the source checks every coin's
  Token-2022 features, a support-mint record or not, as the swap-pool program's does.

**What else the vault can still do**, kept on purpose (the owner's ruling, 2026-10-20):

1. **Pause a pool**: deposits, LP withdrawals with their fees and rewards, swaps and new limit
   orders, in any mix (`update_pool_status`). A pause does not stop the venue or the island
   collecting their shares, nor a limit order's owner taking their coins out. It is the only brake
   there is. The same instruction turns a pool's limit orders on, and it is the rescue when a
   reward coin's vault is frozen ("Fixed in the source 2026-11-03", below). It writes the whole
   status byte, so every proposal states every bit.
2. **Nothing it does is fast**: a pause, like every vault action, takes effect 48 hours after its
   second approval at the earliest. The lock protects everyone from a hasty change, and it also
   means the brake is slow. One exception would be an operation owner: a key the vault adds
   (`update_operation_account`) can change any pool's reward window and rate at once, with no
   proposal, and since 2026-11-03 it is the only key besides the vault that can start a reward. So
   the vault adds none unless it means to.
3. Change a tier's fee within the 4% and 16% ceilings, on every pool of that tier at once.
4. Move a reward's window before it opens, or change its rate, paying for what it adds. After the
   end the unpaid rest goes back to whoever started the reward, with anything the vault paid in, so
   the vault never tops up a reward it did not start. If that person loses their key, the rest
   stays in the pool for good. Moving a pool's owner (`transfer_reward_owner`) changes nothing since
   2026-11-03: no instruction reads it.
5. Upgrade the program itself: the vault holds its upgrade authority.

Also: with the frozen-NFT issuer list empty, the vault never lets in a coin whose issuer may freeze
it (its only remedy would be freezing the pool's vault, which stops every LP).

**How a machine checks it, on every pull request** (`.github/workflows/solana-ci.yml`). No
check fetches anything from Raydium: `solana/guards/upstream/` holds a hash of every upstream
file at each pin, the reviewed patches and the list of Raydium's keys. They were written once
from fresh clones by `node solana/guards/provenance.mjs --regenerate <scratch folder>`; anyone
can re-run it, and `git diff solana/guards/upstream` must then show no change.

1. **Same code as Raydium's, plus only the reviewed patch** (`solana/guards/provenance.mjs`, in
   `diff-guard` and `clmm-guards`). Range pools: 79 upstream files, 32 patched. cp-swap: its
   whole package, 37 files, 8 patched (2026-11-03; the `patched` lists in `provenance.mjs` are the
   record). `vendor/uint`: 16 files, none patched. Undoing the patch
   on our file must give back Raydium's exact file. No file may be added anywhere in either
   package, a `build.rs` included. The patch and the lockfile are each pinned by hash, so even a
   crate swapped for another version Raydium's lock lists fails. cp-swap's workspace is pinned
   too: its `Cargo.toml` whole (no `[patch]` table, release profile, members), the 301 crates
   cp-swap builds with in the shared `Cargo.lock`, and `programs/` must hold exactly its three
   folders. Nothing may be committed in a build folder (`target/`). **This check is the wall.**
2. **No outside key** (`solana/guards/key-guard.mjs` and `allowed-keys.json`). Every key in all
   four Solana programs (both pool programs, tegridy-launch, bayla-ladder) must be named on the
   list, and none may be one of the 39 keys the two pinned Raydium repositories hard-code.
   Today: 22 keys, all named. It reads a key written plain, glued to other letters, escaped,
   split across string literals or `concat!`, or as 32 numbers in any notation. It refuses the
   shapes that build a key it cannot read (a file read in, a build-time value outside the one
   gated test arm, a renamed key type, 32-byte arrays, `stringify!`), a build script, a cargo
   config folder, a `[patch]` table however the TOML spells it, and any file it cannot read.
   It also refuses build flags (`RUSTFLAGS`, `--config`) in the two workflows that build these
   programs. It is a second check, not the wall: Rust can compute a key at build time in ways no
   scan follows. For the pool copies the wall is check 1; for our own programs it is a person
   reading the change. Outside checks tried 39 disguises on 2026-10-14; every one is refused,
   and all are tests (`frontend/src/test/solanaGuardTampers.test.ts`).
   A pull request that changes a pin, the reviewed patch, the allow-list or a guard may change
   nothing else but the programs they pin, so the person reading it reads it alone; CI prints
   the changed guard lines (`provenance.mjs --pr-files`).
3. **The build** (`clmm-build`): builds with the placeholder, then proves a build without it is
   refused, and that `devnet` or `localnet` is refused without `test-chain-keys`. Those two
   settings would give every power to one test key or to a key read at build time; the gate
   stays after the placeholder goes. Since 2026-11-03 it also proves that a `devnet`, `localnet`
   or `paramset` build declares an id nobody can deploy at, so only a release build carries the
   mainnet id, and it runs the copy's own unit tests with upstream's.

Each guard first meets copies it must refuse, so it cannot pass by checking nothing.

One kept exception: our live cp-swap carries Raydium's list of four stablecoin mints (USDP, GYEN,
ZUSD, PYUSD) that may skip a Token-2022 check. They pay no one; assessed 2026-10-10 as not
exploitable here. The source deleted the list on 2026-11-03, as Raydium itself did; the live
program keeps it until the next cp-swap upgrade. The guard allows the four in that one file only,
where a unit test now names them to prove they meet the same check as every coin.

## Fixed in the source 2026-11-03 (the audit's range-pool round)

The audit of 2026-11-03 found no critical bug in this program. Each finding below is fixed in the
source, or routed, with a test seen failing on the code before the fix: the unit tests run in CI,
the local chain's checks are in [RESULTS.md](../solana/clmm-localnet/RESULTS.md). **None of it is on
chain yet.** It rides the program upgrade after #22, which itself upgrades to the source before this
round. The release build is 1,374,528 bytes, 152,176 fewer than before.

Until that upgrade, the program on chain (today's, and #22's after it) still lets anyone open a
range pool with `create_customizable_pool` and its fee coin of choice, with limit orders on;
today's also charges nothing to open one (#22 adds the 0.5 SOL). A pool opened that way holds its
pair's one `create_pool` address on its tier for good, with the fee coin it chose. No dynamic-fee
setting exists, and only the vault could make one, so no pool can get a dynamic fee meanwhile (read
2026-11-03 at slot 465,158,817: the program's only accounts are its two fee tiers). The upgrade
changes no pool already open: such a pool keeps limit orders on (status 0) until the vault sets 32.

| Finding | What it was | What changed | Proved by |
|---|---|---|---|
| CL-03, DG-02, CR-4 | `create_customizable_pool` let whoever opened a pair first fix that pool's fee coin and dynamic fee for good, and every opener could fill reward slots 1 and 2 for good | `create_customizable_pool` deleted; `create_pool` opens the same pool with the defaults. `initialize_reward`'s pool-owner clause deleted (the owner's ruling, 2026-11-03), as Orca's pools give an opener no reward power | D1, R4, unit test |
| CR-1, CO-1, CR-7 | The dynamic fee lacks Orca's limit, an order filled across a price gap skips it, and its settings were frozen at a pool's opening | `create_dynamic_fee_config` and `update_dynamic_fee_config` deleted, with both instructions that could switch a pool's dynamic fee on, so no pool can carry one. The swap's dynamic-fee code stays as Raydium wrote it, unreachable | D1, D2, D3, D5, unit tests |
| (the owner's ruling) | `create_permissioned_pool` let a holder of the vault's permission open more pools per pair, choosing the fee coin and naming any owner; Raydium added it in July 2026 | Deleted, with `create_permission_pda`, `close_permission_pda` and the Permission account, which nothing else read | D5, D6, D7, unit tests |
| CD-2 | `collect_excess_lamports` let the vault trim users' refundable rent deposits | Deleted. Its key constant stays, read by nothing, so the deploy pack's count of eight vault keys holds | D4, unit test |
| CO-2 | Limit orders were on in every pool, with no site support or keeper behind them | A new pool starts with them off; the vault turns them on per pool | O0, unit test |
| CL-09 | A fee tier with tick spacing 0 was accepted, and pools divide by it | Refused, as Uniswap v3's `enableFeeAmount` refuses it | T10 |
| CD-1 | A `localnet` or `paramset` build kept the mainnet program id | Both now declare the devnet build's id, which nobody can deploy at | unit test under each setting, in CI |
| CL-07 | A reward coin whose vault is frozen or paused blocks every withdrawal that would pay it | Nothing: a rescue exists (below) | A4 |
| PARI-4 (round 1) | The vault could point a tier's island share at any account, itself included, collect it and point it back, in one proposal | `update_amm_config`'s param 4 works only while the vault still holds the share (the owner's ruling, 2026-11-03), as in swap pools | V6 |
| ME-2 | Just-in-time liquidity takes most of the LP fee on a big swap | **An owner-approved exception, 2026-11-03**: left as every major exchange leaves it. No code | |

**Who can start a reward now.** Only the vault, or an operation owner the vault names. A pool's
opener still becomes its owner, but no instruction reads a pool's owner any more. Nothing was exposed
before the ruling either: every reward needs the operation account, which does not exist and only the
vault can make (slot 465,158,817). An operation owner can also change any pool's reward window and
rate with no proposal ("What else the vault can still do", 2), so a reward someone else pays for now
takes a vault proposal, or an operator the vault trusts with every pool.

**The status byte is written whole.** `update_pool_status` sets all six bits at once: open or add
(1), withdraw (2), collect fees (4), collect rewards (8), swap (16), new limit orders (32); a set bit
turns that action off. A pool born on this build reads 32. Lifting a pause with 0, as Raydium's own
tools do, would turn limit orders on too, so on such a pool a swap pause is 48 and lifting it is 32.

**The rescue for a frozen reward coin (CL-07).** If a reward coin's issuer freezes or pauses a
pool's reward vault, every withdrawal that would pay that reward fails, principal included. The
vault then proposes `update_pool_status` with 8 added to the pool's status (40 on a pool at 32). Once it executes, 48 hours later, LPs withdraw as usual: they are paid no reward, and what each
position earned stays owed to it. When the coin moves again, the vault sets the byte back. The site
already leaves the reward accounts out while collection is off. Measured on the local chain: check A4.

## What is left, in order

1. **Program tests on a local chain: done 2026-10-20.** Every instruction a visitor or the venue
   uses ran on a local validator against copies of mainnet's BAYLA, wrapped SOL, Squads and token
   programs, with each admin action signed by the vault's real address through a real Squads
   2-of-2 and a time lock. 104 checks over 35 of the program's 39 instructions (the other four are
   deprecated paths the site never uses); each check was first run against a broken input that had
   to turn it red. After the owner's ruling on the vault's powers, the checks of the three fixes (K1-K6,
   R11, R13, R14, V9) were also seen failing on the unchanged program, then all 104 passed on the
   changed one. Harness and results: `solana/clmm-localnet/` and its
   [RESULTS.md](../solana/clmm-localnet/RESULTS.md).
2. **Fee tiers: decided by the owner 2026-10-20** (below). Their one vault proposal is the first
   mainnet step after the deploy; it executes after its 48-hour lock and after the public notice in
   the changelog. Risk: a tier, once made, cannot be deleted. **2026-10-21/22:** the program was
   deployed 2026-10-21 (`7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso`, CI's rebuild matches the
   chain); the notice went public the same day and the proposal is #19. #19's second approval came
   through the Squads app minutes after the first, so the chain allows its execute from
   2026-10-23 13:45:21 UTC. The owner then ruled (2026-10-22) to update the promise date: the notice
   now names 2026-10-23 14:00 UTC, and the page holds the execute until then. One sitting is left,
   the execute, from that time, in a folder of its own (`stage.mjs --tiers-only`), because the
   deploy's folder is in use: no 10-26 approval sitting.
3. **Serve the position link before any position can exist.** Each position NFT keeps the link it
   was born with, `https://memetics.finance/position/<id>.json`. No position can be made before the
   fee tiers execute, so the page refuses to approve or execute them until the link answers 404 for
   this program (#912, whose answer must name the program). It is no longer a gate before the
   deploy: the real address must stay private until the deploy (step 7).
4. **The client**: reading pools and positions, building instructions. Ported by hand from the
   Apache program (Raydium's SDK is GPL). It opens positions through the Token-2022 path only.
   Risk: a wrong decoder shows wrong numbers.
5. **The Range tab**: a range picker, one-coin presets, fees earned and a Claim button.
6. **The swap page's quote through ticks**, so a swap can use our range pools.
7. **The deploy pack and its rehearsal: built and rehearsed 2026-10-20** (`solana/clmm-deploy/`,
   its [README](../solana/clmm-deploy/README.md)). The owner makes the real program key (a key
   folder of its own) and signs every mainnet step. **The address stays private until the
   deploy**: anyone who knew it could block it for good with a little SOL at its data address (the
   rehearsal did it). So `program-id-change.mjs` runs on deploy day on this computer only, two
   local builds must match, and the change is published right after the deploy, when CI must build
   the same bytes (`ci-matches-chain.mjs`). The devnet practice run uses a throwaway address. An
   exact-size deploy (7.74 SOL locked, not the tool's default of twice the size) and the hand-over
   to the vault in one run; the tiers' proposal on a local page that refuses any other proposal,
   with the second approval held to the notice's end - 48 hours so the chain's own lock enforces
   the notice (an approval made around the page skips that hold: then only the page holds the
   execute, see step 2). The whole folder ran end to end on a local chain with the owner's own Solana tool
   and the real page in a browser, every refusal tried. Peak cash: about 7.77 SOL in the paying
   wallet, on top of the pool pack's if its Day 0 has not run. Risk: the program's upgrade key
   decides who can change it later.
8. **Our own hard internal review before any mainnet date**: an adversarial review of the
   111-line diff and of the deploy pack, as its own step. **An outside review after launch**
   (owner decision 2026-10-20).

## Fee tiers (decided by the owner 2026-10-20; the vault signs them)

Two tiers to start; more can be added later, none removed. Each is born with the island split
our cp-swap tiers carry since 2026-10-19.

| Tier | Price steps (tick spacing) | For | LPs keep | The venue's share | The island's share |
|---|---|---|---|---|---|
| 1% | 120 | meme coins, BAYLA/SOL | 0.84% of each swap | 0.104% | 0.056% |
| 0.25% | 60 | SOL against a dollar coin | 0.21% | 0.026% | 0.014% |

How LPs earn: each swap through their range pays the tier's fee, and 84% of it stays with the
positions whose range was in use; each position collects its own. How the venue earns: 10.4% of
each fee, collected by the vault. How the island earns: 5.6% of each fee, collected by its
Workshop (`island-workshop-wallet` in `frontend/scripts/addresses.json`). In the program that is
`trade_fee_rate` 10,000 or 2,500, `protocol_fee_rate` 104,000 and `fund_fee_rate` 56,000 (all per
million). One vault proposal makes both tiers and points each one's fund owner at the Workshop
(per tier `create_amm_config`, then `update_amm_config` with param 4, as cp-swap's tiers were
made): one 48-hour wait, and no moment when one tier exists without the other.
Each tier costs the vault 0.0012 SOL in rent.

**The vault can no longer move the island's share** once a tier hands it over (check V6), nor
collect it (check V9); it can still change a tier's rates within the ceilings ("How the vault can
still move the island's share", above). The island can watch for such a proposal through its 48
hours.

Sources: our cp-swap's own tiers (`CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy` and
`BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW`) carry the same 104,000 and 56,000 since Squads
proposal 13 (2026-10-19), so a swap pays the same split in either kind of pool. Raydium's live
range program has 21 tiers, from 0.01% to 4%, every one sending 16% of each fee to Raydium; it
pairs 0.25% with spacing 60 and 1% with spacing 120 (read 2026-10-14).

## What costs money

Rent is a refundable deposit, not a fee. Rate read from mainnet 2026-10-14 and again 2026-10-20:
5,080 lamports per byte, counting 128 bytes of overhead per account. Every size below was
**measured** on the local chain on 2026-10-20 (the local chain charges 6,960 a byte, so only the
bytes carry over; the costs are at mainnet's rate).

| What | Size | Cost | Who pays |
|---|---|---|---|
| Deploy the program, exact size (measured: the program's data account, with the vault-power fixes) | 1,522,781 bytes | 7.74 SOL rent, locked while it exists | the venue |
| Deploy with the tool's default (room to grow to twice the size) | 3,045,517 bytes | 15.47 SOL rent | the venue |
| Upload buffer during deploy | 1,522,773 bytes | 7.74 SOL rent, moved into the program's data by the deploy itself | the venue |
| The program's own account | 36 bytes | 0.0008 SOL rent | the venue |
| About 1,500 upload transactions, at 5,000 lamports each | | about 0.008 SOL in fees, plus any priority fee | the venue |
| One fee tier | 117 bytes | 0.0012 SOL rent | the vault |
| The operation account, needed once before any pool can carry a reward | 3,529 bytes | 0.0186 SOL rent | the vault |
| One pool for BAYLA/SOL (record 1,544, price history 4,483, range map 1,832, a SOL vault of 165, a BAYLA vault of 170 because BAYLA is Token-2022) | 8,194 bytes | 0.0449 SOL rent | whoever opens it |
| Opening a pool, once the upgrade of 2026-10-25 is on mainnet | | 0.5 SOL, a fee, not a deposit: it goes to the vault and never comes back | whoever opens it |
| One tick array (a band of 60 prices) | 10,240 bytes | 0.0527 SOL rent | the first LP whose range needs it; up to 2 per position |
| One position, Token-2022 NFT (record 281, NFT mint 469 with its name and link inside, NFT account 170) | 920 bytes | 0.0066 SOL rent | the LP |
| One reward stream's vault | 165 (SPL Token) or 170 (Token-2022) bytes | 0.0015 SOL rent | whoever funds the reward |
| One limit order, and once per wallet its counter (81 bytes) | 173 bytes | 0.0015 SOL rent, and 0.0011 once | the order's owner |

So peak cash for an exact-size deploy is about **7.77 SOL**, not twice the rent: the deploy moves
the buffer's SOL into the program's data in the same instruction, so the paying wallet never holds
two buffers' worth (measured in the deploy pack's rehearsal, 2026-10-20). It settles at 7.74 SOL
locked, with about 0.008 SOL spent on upload fees. CI prints the deploy rows again from each build
at that day's rate.

**The vault needs SOL before rewards can start.** It held 0.0152 SOL on 2026-10-20 (read at slot
459,289,546). Two tiers take 0.0025 of it; the operation account, which every reward stream needs
(even one a pool's opener pays for), takes 0.0186 more. So the vault must be topped up by at
least 0.006 SOL before the first reward, and by 0.0015 more for each reward the vault itself
funds. Squads proposal accounts are paid by the member who proposes, not by the vault.

**An outside review**: no quote has been read. Request letters exist
(`solana/tegridy-amm/AUDIT_RFQ.md`). Raydium's newest published review of this program (Sec3,
limit orders and dynamic fees, published 2026-04-23) predates the pinned commit, and no review
covers our copy.

## Decided 2026-10-14

The owner ruled on 2026-10-13 that range pools are the venue's own and pay Raydium nothing, and
left the rest to the builder. Decided on that basis:

1. **Position NFTs: Token-2022 only.** The site never offers the Metaplex path, so no outside
   program is paid. The program still has that path; a stranger calling it directly pays
   Metaplex from their own wallet, never from the venue's (measured 2026-10-20: 0.01 SOL kept in
   the name record, the vault untouched).
2. **Anyone may open a pool**, as with our cp-swap today.
3. **The limit-order keeper is the vault.** Settling an order takes two signatures; the coins can
   only go to the order's owner.
4. **The frozen-NFT issuer list stays empty.** No position NFT is ever frozen.
5. **Today's BAYLA liquidity stays where it is.** LPs choose whether to move.
6. **An outside review stays on the to-do list**, with no quote yet.

## Decided 2026-10-20

1. **Fee tiers**: 1% (spacing 120) and 0.25% (spacing 60), with the island split (table above).
2. **Review**: our own hard internal review before mainnet; an outside review after launch.
3. **The deploy**: exact size; the owner makes the real program key and signs every mainnet step;
   the upgrade authority goes to the vault right after the deploy; devnet first.
4. **The vault's powers**: "Fix 1, 2, 4; keep 3, 5", with a 4% fee ceiling. Fixed in the program:
   only the Workshop collects the island's share; fees at most 4% of a swap and 16% of each fee to the
   venue and the island together; a reward's unpaid rest stays with whoever started it. Kept and
   disclosed ("What else the vault can still do", above): the pause, and the 48 hours.

## Decided 2026-10-25

1. **Opening a pool costs 0.5 SOL, paid to the vault** (owner: "we should be charging a fee to
   open pools everywhere"; 0.5 SOL for range pools, above the 0.15 SOL our cp-swap's public tier
   charges). The program charges it, not the site: `create_pool`, `create_customizable_pool` and
   `create_permissioned_pool` each name the vault as the account `create_pool_fee` and move
   `CREATE_POOL_FEE` (500,000,000 lamports) to it from the opener, the way cp-swap's
   `initialize.rs` charges its `create_pool_fee`. A wrong receiver is refused (Anchor's address
   check), a transaction built without the account is refused, and an opener short of the 0.5 SOL
   cannot open a pool (checks P2, P4 to P7, X18, X19 in `solana/clmm-localnet`). `create_customizable_pool`
   and `create_permissioned_pool` were deleted on 2026-11-03, and X18 and X19 with them.
2. **A constant, not a fee-tier field.** cp-swap keeps the amount on each fee tier. Here it is one
   number in the program, so every tier charges it, a tier made before the upgrade too, and no
   proposal can set it to zero for one tier. Changing it takes a program upgrade, which waits the
   same 48 hours as a tier change would. Nothing about a tier changes: its layout, the
   `create_amm_config` and `update_amm_config` instructions, and vault proposal #19's bytes.
3. **Paid to the vault itself**, a wallet, not cp-swap's wrapped-SOL account
   (`2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa`): putting SOL into a wrapped-SOL account needs
   the SPL Token program to sync it, and a range pool's two coins may both be Token-2022, so the
   instruction may hold no SPL Token program. The vault then also received this program's spare SOL; that sweep was deleted on 2026-11-03.
4. **The order.** The fee is only in the program once the vault executes the upgrade. Vault
   proposal **#19**, which makes the range fee tiers, was approved 2/2 on 2026-10-21 and may be
   executed at any time. **Executed before the upgrade, #19 opens range pools to anyone for free**
   until the upgrade lands. It also makes the 0.25% tier the owner no longer wants (one 1% tier
   only), so it is to be cancelled and replaced by a proposal for the 1% tier alone (pull request
   #1015). **That proposal too must not execute before the upgrade has executed**, for the same
   reason. The upgrade waits 48 hours after its second approval. Its SOL: the upload holds about
   7.76 SOL (1,527,109 bytes at 5,080 lamports a byte, read 2026-10-25) until the upgrade
   executes, then returns it to the wallet that paid; the program's data account must first grow
   by 10,240 bytes (4,336 are missing; the loader's smallest step is 10,240), about 0.052 SOL
   locked for good. The owner deferred the upload: `docs/TODO_OPERATOR.md`.

## Decided 2026-11-03

1. **The audit's range-pool findings are fixed in the source**, never accepted (the owner's rule),
   except one ("Fixed in the source 2026-11-03", above).
2. **A pool's opener starts no reward** (CR-4, the rest of CL-03): `initialize_reward`'s pool-owner
   clause is deleted, rather than making the vault every pool's owner.
3. **Just-in-time liquidity (ME-2) stays**, an owner-approved exception: every major exchange has
   it, and any fix would be new code.
4. **Permissioned pools are deleted** (owner: "Yes, delete it"): `create_permissioned_pool`, with
   `create_permission_pda`, `close_permission_pda` and the Permission account, which nothing else
   read. `create_pool` is the one way to open a range pool. Raydium added the instruction in July
   2026 (commit `01b7f6af`); none of its accounts exists on mainnet (slot 465,158,817).
5. **A tier's island share is handed over once** (owner: "Yes, build it"; "no we should ask the
   island for an address to route their share"): the vault hands it over while it still holds it,
   and after that only a program upgrade can move it. This reverses the 2026-10-20 "keep 5" for
   range pools; swap pools get the same rule (#1113). The percentages do not change: the island
   gets 35% of the venue's cut now and 45% in phase two, so the vault keeps the rate setting.
   Both live range tiers' island shares already belong to the Workshop (slot 465,177,666), so after
   the upgrade neither can move.

## Still the owner's

1. **The mainnet date**, after the internal review.
2. **Who does the outside review after launch**, and when.
3. **The vault's top-up** before the first reward (above).
