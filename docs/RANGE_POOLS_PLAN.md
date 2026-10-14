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
- **What changed.** Only identity. 99 changed lines in 12 files, listed in the next section.
  Every other file is byte for byte Raydium's.
- **It builds.** Built locally (Solana 3.1.11 tools in WSL, one patch release newer than
  upstream's pin; CI builds on the exact 3.1.10): 1,523,176 bytes, no stack-size warning.
  Raydium's own 200 unit tests pass on the copy (1 skipped, as upstream skips it). A build
  without the `placeholder-id` setting is refused, as it must be.
- **Nothing was deployed, no key was made, and the website did not change.**

## Who holds what: the proof that no key is anyone's but ours

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

**How a machine checks it, on every pull request** (`.github/workflows/solana-ci.yml`):

1. `clmm-guards`, provenance (`solana/guards/clmm-provenance.sh`): clones Raydium at the pinned
   commit and compares 76 files. Only the 12 identity files may differ, the change inside them
   must hash to the reviewed value, no file may be added, and all 317 locked crates must be
   ones Raydium's lock names.
2. `clmm-guards`, no outside key (`solana/guards/key-guard.mjs` and `allowed-keys.json`): every
   key in our copies of BOTH pool programs (this one and cp-swap) must be named on the list, and
   none may be one of the 39 keys the two pinned Raydium repos hard-code. Today: 14 keys, all
   named. Tried on Raydium's newest cp-swap, it refuses 19 Raydium keys, so a careless re-pin
   cannot be merged.
3. `clmm-build`: builds with the placeholder, then proves a build without it is refused.

Each guard first meets a copy it must refuse, so it cannot pass by checking nothing.

One kept exception: our live cp-swap carries Raydium's list of four stablecoin mints (USDP, GYEN,
ZUSD, PYUSD) that may skip a Token-2022 check. They pay no one; assessed 2026-10-10 as not
exploitable here; removing them needs a cp-swap upgrade. The guard allows them in that one file
only.

## What is left, in order

1. **Program tests on a local chain**, with copies of mainnet accounts (BAYLA, SOL, the
   Metaplex program). Delivers: every instruction run, including the vault signing admin actions
   through Squads. Risks: none on chain; it only costs time.
2. **Fee tiers.** Delivers: the price list LPs choose from. Risk: a tier, once made, cannot be
   deleted.
3. **Position-NFT metadata hosting** at `memetics.finance/position/<id>.json`. Today that link
   would show the site's page. It must work before deploy, because each NFT keeps the link it
   was born with.
4. **The client**: reading pools and positions, building instructions. Ported by hand from the
   Apache program (Raydium's SDK is GPL). Risk: a wrong decoder shows wrong numbers.
5. **The Range tab**: a range picker, one-coin presets, fees earned and a Claim button.
6. **The swap page's quote through ticks**, so a swap can use our range pools.
7. **The deploy pack and its rehearsal**: the owner makes the real program key, the placeholder
   and its gate are removed in one reviewed change, a verifiable build, a devnet run, then
   mainnet. Risk: the program's upgrade key decides who can change it later.
8. **An outside review**, if the owner wants one first (decision 3 below).

## What costs money

Rent is a refundable deposit, not a fee. Rate read from mainnet 2026-10-14 02:52 UTC: 5,080
lamports per byte, counting 128 bytes of overhead per account.

| What | Size | Rent | Who pays |
|---|---|---|---|
| Deploy the program, exact size | 1,523,221 bytes | 7.74 SOL, locked while it exists | the venue |
| Deploy with the tool's default (room to grow to twice the size) | 3,046,397 bytes | 15.48 SOL | the venue |
| Upload buffer during deploy | 1,523,213 bytes | 7.74 SOL, refunded at the end | the venue |
| One fee tier | 117 bytes | 0.0012 SOL | the vault |
| One pool (record 1,544, price history 4,483, range map 1,832, two vaults of 165) | 8,189 bytes | 0.0449 SOL | whoever opens it |
| One tick array (a band of prices) | 10,240 bytes | 0.0527 SOL | the first LP whose range needs it; up to 2 per position |
| One position, Metaplex NFT path (record 281, NFT account 165, NFT mint 82, name record 679) | 1,207 bytes | about 0.0087 SOL | the LP |

So peak cash for an exact-size deploy is about 15.48 SOL, settling at 7.74 SOL. CI prints the
deploy rows again from each build at that day's rate. The program's own account sizes come from
its source and match Raydium's live accounts (a live pool is 1,544 bytes, its price history
4,483). The NFT's name record is Metaplex's largest size, 679 bytes; phase 1 measures the real one.

**An outside review**: no quote has been read. Request letters exist
(`solana/tegridy-amm/AUDIT_RFQ.md`). Raydium's newest published review of this program (Sec3,
limit orders and dynamic fees, published 2026-04-23) predates the pinned commit, and no review
covers our copy.

## The owner's decisions

1. **Fee tiers and the protocol share.** Which tiers, and how much of each swap fee goes to the
   venue (protocol plus fund share) instead of to LPs.
2. **Who may open pools.** As copied, anyone can open a pool on any tier. The program also has
   permission-only pools.
3. **Whether an outside review comes first**, and from whom.
4. **Today's BAYLA liquidity.** Leave it in the current pool, or move some into a range pool.
5. **The limit-order keeper.** Now the vault, so settling someone's order takes two signatures.
   A hot key would be faster; it could settle or close orders but never take the coins.
6. **The frozen-NFT issuer list.** Now empty. A regulated coin could need it one day.
7. **Which NFT a position gets.** The Metaplex path may charge a per-NFT fee to Metaplex (not
   read); the Token-2022 path uses no outside program. The client should pick one.
