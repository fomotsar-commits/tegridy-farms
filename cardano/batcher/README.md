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
| `src/ogmios.ts`: the node's own answers and its evaluator, the judge of every batch | done; mainnet's node re-judged all 12 real Minswap batches at exactly the budgets they declared, and judges ours live (40 swaps, which Aiken refuses, fit) |
| `src/kupo.ts`, `src/koios.ts`, `src/view.ts`: UTxOs from Kupo (primary) or Koios (backup), rebuilt into the exact outputs the chain holds | done; every real Minswap UTxO recorded rebuilt to the byte against the transaction that made it, amounts past 2^53 included |
| `src/follow.ts`: chain-sync, a round per block | done; follows mainnet live |
| `src/select.ts`, `src/watcher.ts`, `src/main.ts`: what to batch next, and the loop (failover, in-flight inputs, halving, set-aside, refusals, float cap, dry run) | done |
| `Dockerfile`, `docker-entrypoint.sh`, `railway.json`, `src/heartbeat.ts`: the Railway service (its key made only at the top of its own volume, a dry run unless told otherwise) and its alarm (two healthchecks.io checks) | done; CI builds the image and boots it as Railway would (`cardano-ci.yml` jobs `batcher`, `batcher-image`); not yet run on Railway itself |
| Our own deployment (#988) on mainnet, then a week of dry runs before the key signs | next |

## What a batch costs (our contracts, mainnet prices)

| Orders | Network fee | Scripts' memory, of 16.5M a transaction may use |
|---|---|---|
| 1 | 0.662 ADA | 1.43M |
| 5 | 0.809 ADA | 2.80M |
| 10 | 0.998 ADA | 4.57M |
| 25 | 1.560 ADA | 9.85M |

The batcher pays this from the batcher fee each order carries. By the chain's own limits a batch
holds about 40 simple swaps (Aiken's per-script limit stops at about 38); a bigger one is
refused as `BatchTooBig`, to be split.

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
- **The judge is the node's evaluator (Ogmios), never Aiken** (`src/main.ts` only uses Ogmios).
  Aiken 1.0.24 uses its built-in cost model, gives each script a fixed 14M memory (the chain
  gives the whole transaction 16.5M), and cannot run a batch whose inputs carry a reference
  script nothing in the batch uses (the chain can). Its memory figures match mainnet's exactly
  and its steps run 14 to 28% high: the tests still use it, offline. Protocol parameters are read
  every round.
- **Keep the float in plain ADA UTxOs at the batcher's key**, and a collateral UTxO of about
  5 ADA. Anything else sent to that address is never spent by a batch.

## The owner's rulings (2026-10-25)

- **Runs on Railway**, in a new project of its own (not the indexer's), with no public port.
- **Reads the chain from hosted Ogmios + Kupo** (Demeter.run), with a **second Koios key used
  only by the batcher**. Never the site's `KOIOS_API_KEY`: the site needs its daily allowance.
- **Its signing key is made on the server and never copied.** If it is lost, everything its
  wallet holds is lost: the collateral, the float, and the fees earned since the last sweep (up to
  the float cap). A replacement is named through the 48-hour lock; sweep the wallet before a key
  is retired.
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

## How it runs

```
node src/main.ts settings.json            # a round per block; a dry run unless BATCHER_LIVE=1
node src/main.ts settings.json --once     # one round, then exit (no alarm)
```

`settings.json` holds no secrets (the deployment's hashes and reference-script UTxOs, the batcher
key's hash and its own enterprise address, the fee per order, the float cap, the window and the
limits; every one required and range-checked). The environment holds the rest: `OGMIOS_URL` and
`OGMIOS_WS` (Demeter puts the key in the host name), `KUPO_URL`, `KOIOS_URL` and `KOIOS_TOKEN`,
`BATCHER_KEY_FILE`, `HC_PING_URL_CARDANO_BATCHER` and `HC_PING_URL_CARDANO_BATCHER_ALERTS`. Every
log line and every alarm ping is scrubbed of those. **It signs only with `BATCHER_LIVE=1`**, and
then only once both alarm checks have answered; otherwise it prepares and judges every batch and
signs nothing. When it stops itself it stays up, its alerts check failing, until a person
redeploys (Railway restarts any exit but 0, and a restarted batcher would read as recovered). It
exits 3 only when EMURGO's library broke: the orders it broke on are written beside the key
(`set-aside.json`) and the restarted process sets them aside, so no order can break every restart.

Each round reads its UTxOs, the tip and the node's answers from one source: Ogmios + Kupo (once
Kupo shows it is connected, indexed and covering every pattern asked; until then, and whenever
it fails, Koios). The batching account's balance comes from Koios either way (Ogmios cannot see
it), and the last value read stands in when Koios is down. A batch is judged by that source's
node and signed only after it passed. Its inputs are held until its window closes (about 4
minutes after it is built), sent or not. The rules:

- **A source failing, a tip far from the clock, or a node that cannot see an input yet is never
  held against an order.** Only a script that ran and failed is (Ogmios's 3012 inside a 3010).
- **Too big** (bytes, memory by the chain's own limit, or a fee the collateral cannot cover):
  halved, oldest orders kept.
- **Refused for the batch itself** (by the scripts, by the read-back, or the node will not judge
  it): halved the same way; an order failing alone is set aside for `quarantineSlots`, the round
  goes on without it, and a refusal by the node or the read-back is an alert (our engine and the
  contract disagree; five in a row raise a louder one). It never stops the batcher: that would
  hand anyone who found such an order a switch that stops every pool.
- **Refused at submission**: an input gone, the window passed, or the batching account changed is
  normal (ten in a row raise an alert); any other refusal counts, and `maxRefusalsInARow` of them
  in a row stop the batcher.
- **Its own wallet or settings wrong**, above the float cap, or without two plain ADA UTxOs (one
  of at least 5 ADA for collateral): it stops and says why. With every fee UTxO in a batch still
  in flight, it waits.
- Anyone can make orders: each is read as strictly as the contract reads it (and as the ledger
  can carry it), and the rest are left alone with a reason, logged once. Datums of hash-only
  orders: at most 20 lookups a round, oldest orders first, a miss asked again after an hour.
- **Bytes from strangers are walked before EMURGO's library reads them** (`src/cbor.ts`): a datum
  nested about 1,600 deep breaks the library's memory for the whole process. One unreadable UTxO
  is left out with its reason, never the whole answer.
- **Every batch sent is looked for in the blocks** (chain-sync) until its window closes; three in
  a row that never landed raise an alert (the submitting node is not passing them on). A lost
  chain-sync starts again at the new tip, so batches awaiting a block then are not judged.

## Run it on Railway (the owner's steps)

The owner's rulings: a new Railway project of its own, no public port, its key made on the
server and never copied, its earnings capped in its own wallet. Everything below is done once,
in this order. Nothing is funded until a redeploy has shown the key survives, and nothing signs
until a week of dry runs is clean.

1. **Railway: New Project** (not the indexer's), *Deploy from GitHub repo*, this repository,
   branch `mvp-launch`. In the service's settings: **Root Directory** `/cardano/batcher`, **Config
   file** `/cardano/batcher/railway.json` (it builds the `Dockerfile`, redeploys only when
   `cardano/batcher/` changes, and restarts a crashed batcher at most ten times), and turn on
   **Wait for CI** (a change whose CI is red is never deployed). Do **not** generate a domain: the
   batcher listens on no port. On the Railway account: two-factor on, and **no other members**
   in this project (anyone in it can open a shell in the service and read the key).
2. **Add a volume**, mounted at `/data`. It holds the key. A service with a volume never runs two
   deployments at once (Railway's own rule), so there is only ever one batcher. Leave Railway's
   **volume backups off**: each backup is a copy of the key, which the ruling forbids (turning
   them on is the owner's call to make, knowingly). A deleted volume can be restored only from
   Railway's email link, within 48 hours: never delete it while its wallet holds anything.
3. **The alarm.** On healthchecks.io (`docs/OPS_SCHEDULER.md` section 2: two-factor, daily
   reminders), add two checks, Simple schedule, **period 5 minutes, grace 10 minutes**:
   `cardano-batcher` (the dead-man: only silence makes it DOWN) and `cardano-batcher-alerts`
   (whether it works). Put their ping URLs in **sealed** variables
   `HC_PING_URL_CARDANO_BATCHER` and `HC_PING_URL_CARDANO_BATCHER_ALERTS`.
4. **Make the key.** Variables: `BATCHER_KEY_FILE` = `/data/batcher.skey`, `BATCHER_MAKE_KEY` =
   `1`. Deploy. The log shows one `key-made` line with the **key hash** and the **address**, and
   the service stops (exit 0). The key itself is shown nowhere and never leaves the volume; a key
   anywhere but the top of the mounted volume is refused before anything runs. **Then remove
   `BATCHER_MAKE_KEY` and redeploy:** the log must show `key-found` with the **same hash**, then
   `waiting` (no settings yet). A different hash, or none, means the key did not survive: stop
   here, fund nothing.
5. **Name it a batcher and fund it.** Put the key hash in our global setting's batchers (through
   the 48-hour lock). Send the address two plain ADA UTxOs: about 5 ADA for collateral, and the
   float (well under the cap).
6. **A dry run.** Set `BATCHER_SETTINGS` to the settings JSON (the deployment's hashes and
   reference-script UTxOs from our deploy, the key hash and address from step 4, the fee per
   order, the float cap; "How it runs" above lists them) and, as **sealed** variables,
   `OGMIOS_URL`, `OGMIOS_WS`, `KUPO_URL` (Demeter puts the key in the host name), `KOIOS_URL` =
   `https://api.koios.rest/api/v1` and `KOIOS_TOKEN` (the batcher's own Koios key, never the
   site's). Deploy. Without `BATCHER_LIVE` it prepares and judges every batch and signs nothing;
   every report says `DRY RUN`. **Within 5 minutes both checks must turn green** (a check never
   pinged stays grey and alerts no one): if not, a ping URL is wrong. Run it a week.
7. **Go live**, once the step-5 registration has executed (else the batcher stops at once: its key
   is not among the global setting's batchers) and the dry run is clean: set `BATCHER_LIVE` =
   `1`. It signs nothing until both checks have answered (`alarm-unreachable` in the log until
   then), so a wrong ping URL keeps it from signing rather than signing with no alarm.

**What the emails mean.**
- `cardano-batcher` DOWN: the process is gone (Railway gave up after ten restarts, or the
  project is down). Open Railway's logs.
- `cardano-batcher-alerts` DOWN: read the reason in the email. `STOPPED: ...` means it stopped
  itself (the float cap: sweep the wallet; refusals in a row; its wallet or settings): it stays
  up and idle until you fix the cause and redeploy. `no round has reached a source for N minutes`
  names the last problem (Demeter or Koios down, a wrong key). `ALERT (n): ...` is something to
  read (our engine and the contract disagreeing on an order, every batch refused as expired,
  batches that never reach a block): at most one such email an hour, and the next healthy ping
  clears it. `STOPPED (fatal ...)`: EMURGO's library broke; Railway restarts it with the order it
  broke on set aside.

## Traps met building it (never undo these)

- **Plain `JSON.parse` changes a pool.** A pool holds about 9.2 x 10^18 unissued LP tokens;
  read as a JavaScript number it becomes another pool, and the node rejects every batch built on
  it. Kupo and Ogmios send amounts as bare numbers: everything goes through `src/json.ts`.
- **Kupo's flags are bare** (`?unspent`, never `?unspent=`: Node's URLSearchParams writes the
  second, which Kupo refuses), and a pattern Kupo does not index answers `[]`, exactly like
  "nothing there".
- **Ogmios's 3010 is not always a verdict.** "The pool was spent meanwhile" arrives as 3010 too,
  holding 3004, 3110 or 3117: counted as a verdict, a block's lag would set good orders aside.
- **Ogmios cannot see our batching account**: it leaves out a registered account delegated to
  no pool and no DRep, which a withdraw-zero script account is. Koios's `account_info` can.
- **Koios scans big sets slowly** (Minswap's orders: 32 s; its pools: 113 s): fine for our own
  small deployment as a backup, and the reason Kupo is the primary.

## Run the tests

```
npm ci --ignore-scripts
npm test
npm run typecheck
```

Node 24 runs the TypeScript directly (type stripping): erasable syntax only. The tests that run
scripts need `AIKEN=<path to Aiken 1.0.24>`; the live ones need `OGMIOS_URL` (e.g.
`https://api.koios.rest/api/v1/ogmios`, keyless) and `OGMIOS_WS` (e.g.
`wss://api.koios.rest/api/v1/ogmios`). Recorded answers are refreshed with
`node scripts/fetch-source-fixtures.ts` and `node scripts/fetch-ogmios-fixtures.ts`.
