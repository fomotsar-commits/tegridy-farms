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
| Building a batch and simulating it against our compiled contracts (`aiken tx simulate`), then reading it back with `verify.ts` before signing | next |
| Watching the chain (hosted Ogmios + Kupo, a Koios key of its own as backup) and sending | then |
| Railway service, heartbeat alert, fee cap | last |

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
