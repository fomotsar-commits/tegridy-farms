# The batcher for our own Cardano pools

Our pools (`cardano/minswap-dex-v2/`, a copy of Minswap V2 with one constant patched) only
move when a whitelisted **batcher** sends a transaction that applies queued orders to a pool.
Minswap runs its own; no production batcher is public (its `batcher-sample.ts` runs against a
fake chain). So this is new code, and it is in the audit's scope.

**Status: being built. Nothing here runs, holds a key or touches mainnet yet.**

| Piece | State |
|---|---|
| `src/math.ts`: the contract's integer math, ported line by line from `math.ak` | done; every `math.ak` test vector and a real mainnet fill reproduced |
| `src/types.ts`, `src/plutus.ts`, `src/chain.ts`: pool and order data read as strictly as the contract's own casts; data hashed from Plutus's own serialisation | done |
| `src/engine.ts`: the order engine (SwapExactIn, SwapExactOut, Deposit, Withdraw; anything else refused by name) | done |
| `src/verify.ts`: reads a batch exactly as the pool contract does and recomputes it | done; 11 real Minswap V2 batches reproduced to the unit, 10 tampered ones rejected naming the rule |
| `src/plan.ts`, `src/build.ts`, `src/prepare.ts`: each batch built, every script run against our compiled contracts (`aiken tx simulate`), rebuilt with the exact budgets, run again, then read back with `verify.ts` before signing | done; reviewed, its 7 findings fixed |
| `src/fee.ts`: the ledger's own minimum fee, not EMURGO's estimate (EMURGO misses reference scripts a stranger attaches) | done; 12 real mainnet batches all paid 6,380 to 6,644 lovelace over it, never under |
| Watching the chain (hosted Ogmios + Kupo, a Koios key of its own as backup), the node's own evaluator in place of Aiken's, and sending | next |
| Railway service, heartbeat alert, fee cap | last |

## What a batch costs (our contracts, mainnet prices)

| Orders | Network fee | Scripts' memory, of 16.5M a transaction may use |
|---|---|---|
| 1 | 0.662 ADA | 1.43M |
| 5 | 0.809 ADA | 2.80M |
| 10 | 0.998 ADA | 4.57M |
| 25 | 1.560 ADA | 9.85M |

The batcher pays this from the batcher fee each order carries. Under Aiken's limits a batch
tops out at about 38 simple swaps; a bigger one is refused as `BatchTooBig`, to be split.

## Before it runs on mainnet

- **Register the pool-batching script's reward account with the legacy certificate** (the
  Shelley `stake_registration`, certificate 0). Every batch withdraws from that account, and
  the ledger refuses a withdrawal from an unregistered one. Conway's own registration
  certificate needs the script to approve it, and the batching script only approves
  withdrawals, so it can never be registered that way. If a later era removes the legacy certificate
  before we register, the script needs a new version.
- **Read the account's balance for every batch** (`batchingRewardBalance`): the ledger only
  lets a withdrawal take all of it, and anyone can pay into it (a governance deposit's refund
  can name any reward account). It is normally 0; anything in it goes to the batcher.
- **Judge with the node's evaluator (Ogmios), not Aiken.** Aiken 1.0.24 uses its built-in cost
  model, gives each script a fixed 14M memory (the chain gives the whole transaction 16.5M), and
  cannot run a batch whose inputs carry a reference script that nothing in the batch uses (the
  chain can). Today its memory figures match mainnet's exactly and its steps run 14 to 28%
  high, so it is safe, but cautious. Read the protocol parameters (prices, cost model) every
  epoch.
- **Keep the float in plain ADA UTxOs at the batcher's key**, and a collateral UTxO of about
  5 ADA. Anything else sent to that address is never spent by a batch.

## The owner's rulings (2026-10-25)

- **Runs on Railway**, in a new project of its own (not the indexer's), with no public port.
- **Reads the chain from hosted Ogmios + Kupo** (Demeter.run), with a **second Koios key used
  only by the batcher**. Never the site's `KOIOS_API_KEY`: the site needs its daily allowance.
- **Its signing key is made on the server and never copied.** If it is lost, only the small
  float is lost; a replacement is named through the 48-hour lock.
- **Its earnings stay in its own wallet, capped.** Above the cap it stops and alerts; once the
  two-key treasury exists, they are swept there.

## What it can and cannot do

The contract pays every trader at least the minimum they signed, so a batcher (or a thief
holding its key) **cannot take traders' or LPs' coins** or change any pool setting. For the at
least 48 hours a key takes to replace, it could reorder trades within each trader's slippage,
charge up to each trader's maximum batcher fee, ignore orders, and spend its own wallet.
Keep the float small.

## Never copy unpatched

- Minswap's SDK and samples carry **Minswap's** contract hashes and addresses: copied as they
  are, our orders would go into Minswap's pools.
- Minswap's reference-script address carries **Minswap's stake key**.
- Minswap's `batcher-sample.ts` builds the pool's ADA from the datum reserve: wrong once a pool
  has a fee share, as all of ours do. Value reserves and datum reserves differ by the share.

## Run the tests

```
npm ci --ignore-scripts
npm test
npm run typecheck
```

Node 24 runs the TypeScript directly (type stripping): erasable syntax only.
