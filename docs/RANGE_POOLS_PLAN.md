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
- **What changed.** Only identity, plus two build guards. 111 changed lines in 12 files: the
  roles and names in the next section, a gate that refuses a test-chain build (below), and
  the one line that reads `uint` from our own folder. Every other program file is byte for
  byte Raydium's. `Cargo.lock` is Raydium's, pruned to the program's own 317 crates. `README.md`
  is ours. `vendor/uint` is Raydium's copy of the `uint` crate (MIT or Apache-2.0) at the
  commit Raydium's lock named (`43a0303b9c2a23a00508816bd6d5a2e9381f143c`), unchanged, with its
  two licence files. So the build fetches nothing from Raydium.
- **It builds.** Built locally (Solana 3.1.11 tools in WSL, one patch release newer than
  upstream's pin; CI builds on the exact 3.1.10), offline: 1,523,176 bytes, no stack-size
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
| Program id | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | a placeholder, `RangePoo1PLACEHo1DERnotDep1oyed111111111111` | Nothing: nobody holds its key and no release build accepts it |
| Admin | `GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ` | vault | Make fee tiers, pause a pool, collect any fee to any account |
| Protocol-fee owner | `projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416` | vault | Collect the protocol's share of swap fees |
| Fund-fee owner | `FundHfY8oo8J9KYGyfXFFuQCHe7Z1VBNmsj84eMcdYs4` | vault | Collect the fund's share of swap fees |
| Spare-SOL collector | `Ray9LdYRLXsHzL8pr3Ceahfiz8MsS2pZagzHo1ckdfJ` | vault | Sweep SOL sent to a pool's accounts above what they need |
| Limit-order keeper | `Ray8HHtixhL9zvnokMyELCVGp622PDPJj96zcVC9RWp` | vault | Settle or close a user's limit order; the coins go to the order's owner only |
| Permission admin | `RayzVBPm6p6xtG7fU3KX4k44UexK4NjewDk2QCwoLqa` | vault | Say who may open a permission-only pool |
| Support-mint owner | `RayVyjyJQz9vAi126A4sGexKnSU1XeZaHTRcM1mZMPY` | vault | Let in a coin with unusual Token-2022 features |
| Frozen-NFT issuer list | `2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x` (an outside coin issuer) | empty | Nothing: no position NFT is ever frozen |

Also replaced: the on-chain security text (now memetics.finance, our contact, no audit claim),
the position NFT's name, symbol and link ("Memetics Range Position", "MEM-RANGE",
`memetics.finance/position/<id>.json`), and three memos that said "raydium".

**Where the money goes.** Swap fees stay in the pool for the people whose range was in use;
each position collects its own. The protocol and fund shares (set per fee tier by the admin)
can be collected only by the vault. This program has no pool-opening fee. Spare SOL goes to the
vault. None of these paths can reach a Raydium address, because none is in the code.

**How a machine checks it, on every pull request** (`.github/workflows/solana-ci.yml`). No
check fetches anything from Raydium: `solana/guards/upstream/` holds a hash of every upstream
file at each pin, the reviewed patches and the list of Raydium's keys. They were written once
from fresh clones by `node solana/guards/provenance.mjs --regenerate <scratch folder>`; anyone
can re-run it, and `git diff solana/guards/upstream` must then show no change.

1. **Same code as Raydium's, plus only the reviewed patch** (`solana/guards/provenance.mjs`, in
   `diff-guard` and `clmm-guards`). Range pools: 79 upstream files, 12 patched. cp-swap: its
   whole package, 37 files, 4 patched. `vendor/uint`: 16 files, none patched. Undoing the patch
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
   stays after the placeholder goes.

Each guard first meets copies it must refuse, so it cannot pass by checking nothing.

One kept exception: our live cp-swap carries Raydium's list of four stablecoin mints (USDP, GYEN,
ZUSD, PYUSD) that may skip a Token-2022 check. They pay no one; assessed 2026-10-10 as not
exploitable here; removing them needs a cp-swap upgrade. The guard allows them in that one file
only.

## What is left, in order

1. **Program tests on a local chain**, with copies of mainnet accounts (BAYLA, SOL). Delivers:
   every instruction run, including the vault signing admin actions through Squads. Risks:
   none on chain; it only costs time.
2. **Fee tiers.** The proposal below is the starting point. Risk: a tier, once made, cannot be
   deleted.
3. **Serve the position link before any deploy.** Each position NFT keeps the link it was born
   with, `https://memetics.finance/position/<id>.json`. Today that link returns the site's page,
   not the position's details. Nothing deploys until it serves them.
4. **The client**: reading pools and positions, building instructions. Ported by hand from the
   Apache program (Raydium's SDK is GPL). It opens positions through the Token-2022 path only.
   Risk: a wrong decoder shows wrong numbers.
5. **The Range tab**: a range picker, one-coin presets, fees earned and a Claim button.
6. **The swap page's quote through ticks**, so a swap can use our range pools.
7. **The deploy pack and its rehearsal**: the owner makes the real program key, the placeholder
   and its gate are removed in one reviewed change (the test-chain gate stays), a verifiable
   build that is given no features, a devnet run, then mainnet. Risk: the program's upgrade key
   decides who can change it later.
8. **An outside review.** On the to-do list; no quote has been read.

## Proposed fee tiers (the vault signs them)

Two tiers to start; more can be added later, none removed.

| Tier | Price steps (tick spacing) | For | LPs keep | The venue's share |
|---|---|---|---|---|
| 1% | 120 | meme coins, BAYLA/SOL | 0.84% of each swap | 0.16% (16% of the fee) |
| 0.25% | 60 | SOL against a dollar coin | 0.21% | 0.04% (16% of the fee) |

How LPs earn: each swap through their range pays the tier's fee, and 84% of it stays with the
positions whose range was in use. How the venue earns: 16% of each fee, collected by the vault.
In the program that is `trade_fee_rate` 10,000 or 2,500, `protocol_fee_rate` 160,000 and
`fund_fee_rate` 0 (all per million). Each tier costs the vault 0.0012 SOL in rent.

Sources, read from mainnet 2026-10-14 06:28 UTC:

- Our cp-swap's own 1% tier (`CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy`) sends 16% of each
  fee to the venue. The same split means a swap costs the same in either kind of pool.
- Raydium's live range program has 21 tiers, from 0.01% to 4%. Every one sends 16% of each fee to
  Raydium (12% protocol, 4% fund). It pairs 0.25% with spacing 60 and 1% with spacing 120.

## What costs money

Rent is a refundable deposit, not a fee. Rate read from mainnet 2026-10-14 02:52 UTC and again
at 06:28 UTC: 5,080 lamports per byte, counting 128 bytes of overhead per account.

| What | Size | Cost | Who pays |
|---|---|---|---|
| Deploy the program, exact size | 1,523,221 bytes | 7.74 SOL rent, locked while it exists | the venue |
| Deploy with the tool's default (room to grow to twice the size) | 3,046,397 bytes | 15.48 SOL rent | the venue |
| Upload buffer during deploy | 1,523,213 bytes | 7.74 SOL rent, refunded at the end | the venue |
| The program's own account | 36 bytes | 0.0008 SOL rent | the venue |
| About 1,500 upload transactions, at 5,000 lamports each | | about 0.008 SOL in fees, plus any priority fee | the venue |
| One fee tier | 117 bytes | 0.0012 SOL rent | the vault |
| One pool (record 1,544, price history 4,483, range map 1,832, two vaults of 165) | 8,189 bytes | 0.0449 SOL rent | whoever opens it |
| One tick array (a band of prices) | 10,240 bytes | 0.0527 SOL rent | the first LP whose range needs it; up to 2 per position |
| One position, Token-2022 NFT (record 281, NFT mint 469 with its name and link inside, NFT account 170) | 920 bytes | about 0.0066 SOL rent | the LP |

So peak cash for an exact-size deploy is about 15.49 SOL, settling at 7.74 SOL locked, with about
0.01 SOL spent on fees. CI prints the deploy rows again from each build at that day's rate. The
program's own account sizes come from its source and match Raydium's live accounts (a live pool
is 1,544 bytes, its price history 4,483). The position's NFT sizes are computed from the source
for the longest link; phase 1 measures them.

**An outside review**: no quote has been read. Request letters exist
(`solana/tegridy-amm/AUDIT_RFQ.md`). Raydium's newest published review of this program (Sec3,
limit orders and dynamic fees, published 2026-04-23) predates the pinned commit, and no review
covers our copy.

## Decided 2026-10-14

The owner ruled on 2026-10-13 that range pools are the venue's own and pay Raydium nothing, and
left the rest to the builder. Decided on that basis:

1. **Position NFTs: Token-2022 only.** The site never offers the Metaplex path, so no outside
   program is paid. The program still has that path; a stranger calling it directly pays
   Metaplex from their own wallet, never from the venue's.
2. **Anyone may open a pool**, as with our cp-swap today.
3. **The limit-order keeper is the vault.** Settling an order takes two signatures; the coins can
   only go to the order's owner.
4. **The frozen-NFT issuer list stays empty.** No position NFT is ever frozen.
5. **Today's BAYLA liquidity stays where it is.** LPs choose whether to move.
6. **An outside review stays on the to-do list**, with no quote yet.

## Still the owner's

1. **Fee tiers and the venue's share.** The proposal above is the starting point.
2. **Whether the outside review comes before mainnet**, and from whom.
