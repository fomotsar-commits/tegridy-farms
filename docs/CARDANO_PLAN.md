# Cardano on the venue: swap now, our own pools next

> The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md). This file is the plan for Cardano and the owner's rulings on it.

Owner, 2026-10-24: "i need cardano integrated in every aspect of this app. start with swap, and
lp", under the rule: battle-tested code that has never been hacked, our own only where none exists.

## The owner's rulings (2026-10-24)

1. **Swap fee: our own fee line.** The venue fee is its own output in the trader's transaction,
   paid straight to the venue's Cardano address. No aggregator holds it.
2. **LP: our own pools.** A copy of Minswap V2's audited contracts, under our keys. Never route our
   LPs into Minswap's own pools: one sixth of their swap fees goes to MIN stakers.
3. **Minswap V1's 2022 critical, found and fixed before anyone used it, is not a hack.** Minswap
   V2 and Minswap's pools may be used.
4. **The audit finding Minswap left open (CertiK MIN-01: the admin can change batchers, fee takers
   and the pool stake key instantly) is fixed, and the owner pays for a fresh audit** of what changed.

## What the research found (8 agents, wf_6a6604c5-5ad, 2026-10-24)

- **Splash (ex-Spectrum) was drained on 2026-09-13**, about $915k, inside audited code. Never route there.
  Also out: VyFi, Genius Yield (winding down), SundaeSwap V4 (three weeks old, no audit), MuesliSwap,
  CSWAP, Danogo.
- **SecondFi (ex-Yoroi) generated recoverable keys; wallets drained from 2026-06-23.** Yoroi, SecondFi
  and Ctrl are not offered. Eternl, Lace, VESPR first; Begin, Typhon, Gero, NuFi on desktop.
- No Cardano aggregator (SteelSwap, DexHunter, Minswap's) has a hack on record, but all three are
  closed servers that hand back a ready-built transaction. Partner fees sit in the aggregator's
  custody until payout. Hence ruling 1.
- A Cardano DEX swap is an **order**, filled by a batcher a few blocks later. "Confirmed" is "placed".

## Part 1: the swap (open since 2026-10-24, `CARDANO_SWAP_OPEN = true`, no venue fee yet)

How the money moves on one swap, ADA in:

| Line | Amount | Goes to |
|---|---|---|
| The swap | what you pay | Minswap V2's order script, then the pool |
| Pool fee | that pool's rate (often 0.3% or 1%, and it can differ by direction) of what you pay in | the pool's LPs; Minswap keeps a share each pool sets (1/6 by default; the ADA/MIN pool keeps 1/3) |
| Batcher fee | up to 2 ADA | Minswap's batcher |
| Order deposit | 2 ADA | comes back with your coins |
| **Venue fee** | **0.5% of the ADA side** | **the venue's own address, in the same transaction** |
| Network fee | about 0.2 ADA | Cardano block producers |

The venue fee is not charged when it would be under about 1 ADA (a Cardano output must hold that
much), so swaps under about 200 ADA pay none. It is paid with the order: an order the batcher
returns (price moved past the minimum) has still paid it.

**How it opened (2026-10-24):**
1. ⬜ The venue's Cardano fee address in `frontend/src/lib/cardano/venueFee.ts`
   (`CARDANO_VENUE_FEE_ADDRESS`) is still null: the owner opened the swap without it ("Go live
   without the venue fee for now, and add it when the treasury exists"). Until it is registered the
   swap charges no venue fee and says so. A native-script multisig (two signatures) is the
   Squads-vault analog; Eternl makes one only with Eternl Pro.
2. ✅ `KOIOS_API_KEY` is set on Vercel (Koios free tier: 50,000 reads a day). Without it the public
   tier allows 5,000 a day for the whole site.
3. ✅ A real buy and a real sell were walked on mainnet, each filled at exactly the quoted amount;
   then `CARDANO_SWAP_OPEN` in `frontend/src/lib/cardano/flags.ts` was flipped.

## Part 2: our own pools (next, its own branch)

**Base:** minswap-dex-v2 main @ `c3293ad43` (2024-07-10). Its validators are unchanged since
CertiK's re-audit commit `d299bd1`. Aiken v1.0.24-alpha. Licence: `LICENSE.md` is GPL-3.0 but
`aiken.toml` and `plutus.json` say Apache-2.0: a lawyer's read is owed before deploying.

**What changes:** the deploy parameters: our own seed UTxO (so new script hashes and our own pool
NFT and LP policy), our pool stake credential, and our global-settings datum: batchers, fee
updater, fee-sharing taker, stake-key updater, dynamic-fee updater, admin, and the pool opening
fee with the address it is paid to. And two small patches to Minswap's code that the owner chose
over its untouched bytes, accepting a wider audit: the venue's fee-share floor, 1666 to 1333
(2026-10-24, draft PR #988), and the pool opening fee, checked by Minswap's factory (2026-10-25,
draft PR #1016, stacked on #988). The auditor's brief is `docs/CARDANO_AUDIT_SCOPE.md` on those
branches.

**The MIN-01 fix, recommended shape: leave Minswap's validators byte-for-byte.** Minswap V2 lets
each role be a script (`PAMSpendScript`), not only a key. So the admin and every updater role
become one small validator of our own that only lets its UTxO be spent after a change has been
announced for 48 hours and both owner keys sign. Swapping a batcher or a fee taker then takes 48
hours, as on the Solana vault. The new code is that one validator; it, the batcher and the deploy
parameters are the audit's scope. Editing Minswap's own validators instead would put their whole
audited code back in scope.

**The batcher is ours to write.** Only Minswap's `batcher-sample.ts` is public. It is an always-on
service (not Vercel): it watches our order script, builds batch transactions in order, holds a hot
key with ADA for fees and collateral, and earns the batcher fee. It cannot steal: the order script
pays every trader at least their minimum. It is also audit scope.

**How the venue earns from its pools** (owner's rulings, 2026-10-24 and 2026-10-25):

- **Opening a pool: 73 ADA, fixed.** Whoever opens a pool pays it straight to the venue's
  treasury in the transaction that opens the pool; Minswap's factory refuses the pool otherwise.
  73 ADA was about $15 at $0.2052 on 2026-10-25, the same ~$15 as 0.15 SOL on Solana and 0.006 ETH
  on Ethereum. It is set in ADA, not dollars: when ADA's price moves a lot, the owners re-set it
  through the 48-hour lock (announce, wait 48 hours, both keys), and the lock lets it be paid only
  to the treasury. The opener's own deposit all goes into the pool.
- **Trading: 1333 / 10000 of the 0.3% trade fee**, about 0.04% of each trade; LPs keep about
  0.26%. Minswap takes 0.05% of its own 0.3% pools, so LPs keep a little more here. The share
  builds up inside each pool, and the lock pays it out only to the treasury.
- **The batcher fee** on every order our own batcher fills, and **the staking rewards** of the
  pools' ADA (which since the Plomin hard fork need a DRep delegation to withdraw).
- **The split** is off chain, quarterly from the treasury, as on EVM (30/35/35, later 10/45/45).
- **Owed before any of it:** the treasury itself. `CARDANO_VENUE_FEE_ADDRESS` is null until the
  owner's two-key wallet exists, and the deploy must name it as the opening fee's receiver.

**Order of work:** (1) vendor the contracts at the pinned commit with a provenance check like
`solana/guards/provenance.mjs`, and prove our build matches Minswap's mainnet script bytes before
changing any parameter; (2) the 48-hour role validator; (3) the batcher; (4) the LP screens,
behind their own switch; (5) the audit, owner-procured; (6) the deploy, with the owner's keys.

**Step 4, the LP screens (draft, 2026-10-30):** `/cardano-pools`, a Pools tab: your positions, add,
remove, open a pool. Off (`CARDANO_OWN_POOLS_OPEN = false` in `frontend/src/lib/cardano/flags.ts`);
walked in a `--mode cardano-preview` build. Every hash, address and fee comes from ONE record,
`frontend/api/_lib/cardano-own-pools.js`, null until the deploy: while null the screens say the
pools are not open, build nothing, and the API has no own-pool reads. The record refuses any of
Minswap's script hashes, its pool stake key and its reference UTxOs. Add and remove are orders at
our order script for our batcher; opening spends our factory entry and pays the opening fee to the
treasury, checked against the chain's global setting before anything is built. An add or remove
order still open can be taken back by its owner (Cancel order, under Your pool orders): it spends
the order with `CancelOrderByOwner`, reads our order script from the record's `orderRef`, and
pays all of it back less the network fee. The deploy owes, for these screens: fill the record
from the deploy's own output, `orderRef` included; measure the pool opening's two script budgets
with the node's evaluator (the record's `openPoolBudget`, with headroom); re-measure the cancel's
pinned budget (`LP_CANCEL_EX_UNITS` in `ownPools/cancelTx.ts`, measured on the test world's order
script) if the order script's code changed; and keep the record's `batcherFeeLovelace` at least
the batcher's own `batcherFee`, or the batcher skips every order and each waits for its owner to
cancel it.
