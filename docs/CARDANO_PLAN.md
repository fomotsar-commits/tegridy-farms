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

**Cancel (draft PR, 2026-10-24):** an order the batcher has not filled has Cancel order under
Your orders. It is Minswap's own owner cancel (`CancelOrderByOwner`, the order script read from
Minswap's published reference UTxO), checked out of its own bytes like the swap
(`frontend/src/lib/cardano/cancelTx.ts`). Everything the order holds comes back less a network
fee of about 0.24 ADA; no batcher fee. ⬜ A real cancel walked on mainnet by the owner, before merge.

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

**What changes without touching Minswap's code:** the deploy parameters only. Our own seed UTxO
(so new script hashes and our own pool NFT and LP policy), our pool stake credential, and our
global-settings datum: batchers, fee updater, fee-sharing taker, stake-key updater, dynamic-fee
updater, admin.

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

**How the venue earns from its pools:** the fee-sharing share of every trade fee (Minswap's bounds:
16.66% to 50% of the fee) to the venue, the batcher fee per order, and the staking rewards of the
pools' ADA (which since the Plomin hard fork need a DRep delegation to withdraw). The trade-fee
rate and the share are the owner's call; Solana's public tier is 1% with 16% to the venue.

**Order of work:** (1) vendor the contracts at the pinned commit with a provenance check like
`solana/guards/provenance.mjs`, and prove our build matches Minswap's mainnet script bytes before
changing any parameter; (2) the 48-hour role validator; (3) the batcher; (4) the LP screens,
behind their own switch; (5) the audit, owner-procured; (6) the deploy, with the owner's keys.
