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
| `src/sweep.ts`: above the float cap, the excess swept to the two-key treasury (the owner's ruling, 2026-10-27), on as soon as the settings name the treasury; the treasury must be a script needing two keys or more, and every sweep is read back before the key signs it | done; no treasury exists yet, so it is off |
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
  wallet holds is lost: the collateral, the float, and every fee earned (up to the float cap). A
  replacement is named through the 48-hour lock. Before a key is retired, lower `floatCap` to
  just above `sweep.keep` and the collateral, and the next check sweeps the rest to the treasury.
- **Its earnings stay in its own wallet, capped.** Until the two-key treasury exists, above the
  cap it stops and alerts. Once the settings name the treasury, above the cap it sweeps the
  excess there, down to `sweep.keep`, and goes on (the owner's ruling, 2026-10-27).

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
limits; every one required and range-checked; and, once the treasury exists, `sweep`). The environment holds the rest: `OGMIOS_URL` and
`OGMIOS_WS` (Demeter puts the key in the host name), `KUPO_URL`, `KOIOS_URL` and `KOIOS_TOKEN`,
`BATCHER_KEY_FILE`, `HC_PING_URL_CARDANO_BATCHER` and `HC_PING_URL_CARDANO_BATCHER_ALERTS`. Every
log line and every alarm ping is scrubbed of the endpoints, the Koios token and the ping URLs.
**It signs only with `BATCHER_LIVE=1`**, and then only once both alarm checks have answered
(healthchecks.io's "OK"; a check that does not exist answers "OK (not found)", which is not an
answer); otherwise it prepares and judges every batch and signs nothing. When it stops itself it
stays up, its alerts check failing, until a person redeploys (Railway restarts any exit but 0,
and a restarted batcher would read as recovered). It exits 3 only when EMURGO's library broke,
and `src/supervise.ts`, the container's process, starts it again in the same container (so
Railway's ten restarts stay for real crashes). What broke it is written beside the key
(`<key file>.set-aside.json`): a UTxO that broke it alone is never read again; the orders of a
batch that broke it are each tried alone first, so the one to blame is found and the rest go on.

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
- **Above the float cap**: with the treasury named, it sweeps (below); without, it stops.
- **Its own wallet or settings wrong**, or without two plain ADA UTxOs (one of at least 5 ADA for
  collateral, a float of at least 10 ADA): it stops and says why. With no
  order to batch, these are still checked at the first round and every 10 minutes, so a stop
  comes back after any redeploy. With every fee UTxO of at least 10 ADA in a batch still in
  flight, it waits (a stranger's dust at its address is never a fee UTxO).
- **A batch in flight one of whose orders another spent first** (a cancel that won the race),
  its pool not: it can never land, so it is let go at once, and the other pools do not wait out
  its window.
- Anyone can make orders: each is read as strictly as the contract reads it (and as the ledger
  can carry it), and the rest are left alone with a reason, logged once. Datums of hash-only
  orders: at most 20 lookups a round, oldest orders first, a miss asked again after an hour.
- **Bytes from strangers are walked before EMURGO's library reads them** (`src/cbor.ts`): a datum
  nested about 1,600 deep breaks the library's memory for the whole process. One unreadable UTxO
  is left out with its reason, never the whole answer. Bytes that break the library anyway are
  named by the UTxO they came from, wherever they are read (Kupo, Koios, selection, datums).
- **Every batch sent is looked for in the blocks** (chain-sync) until its window closes; while the
  last three never landed, the alerts check fails (the submitting node is not passing them on).
  A lost chain-sync starts again at the new tip, so batches awaiting a block then are not judged.

## Run it on Railway (the owner's steps)

The owner's rulings: a new Railway project of its own, no public port, its key made on the
server and never copied, its earnings capped in its own wallet. Everything below is done once,
in this order. Nothing is funded until a redeploy has shown the key survives, and nothing signs
until a week of dry runs is clean.

1. **Railway: New Project** (not the indexer's), *Deploy from GitHub repo*, this repository,
   branch `mvp-launch`. In the service's settings: **Root Directory** `/cardano/batcher`, **Config
   file** `/cardano/batcher/railway.json` (it builds the `Dockerfile`, redeploys only when
   `cardano/batcher/` changes, and restarts a crashed batcher at most ten times), and turn on
   **Wait for CI** (a change whose CI is red is never deployed). Wait for CI waits for **every**
   workflow on the commit, not only the batcher's: today "Mirror to GitLab" fails on every push to
   `mvp-launch` until its secret `GITLAB_MIRROR_SSH_KEY` is set (`docs/GIT_HOSTING.md` 2C), and
   while it does, every batcher deploy is skipped with no notice. Set that secret first. After
   each merge that touches `cardano/batcher/`, open the deployments, click **Show Skipped**, and
   check the merge commit is the one running. Do **not** generate a domain: the batcher listens on
   no port. On the Railway account: two-factor on, and **no other members** in this project
   (anyone in it can open a shell in the service and read the key).
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
   the 48-hour lock). Send the address plain ADA UTxOs: about 5 ADA for collateral, and the float,
   at least 10 ADA and well under the cap (two float UTxOs let a batch be in flight while the
   next pool's goes). **Wait until the lock has executed**: the global setting must name the
   hash before step 6, or the first order stops the dry run ("not among the global setting's
   batchers").
6. **A dry run.** Set `BATCHER_SETTINGS` to the settings JSON (the deployment's hashes and
   reference-script UTxOs from our deploy, the key hash and address from step 4, the fee per
   order, the float cap; "How it runs" above lists them) and, as **sealed** variables,
   `OGMIOS_URL`, `OGMIOS_WS`, `KUPO_URL` (Demeter puts the key in the host name), `KOIOS_URL` =
   `https://api.koios.rest/api/v1` and `KOIOS_TOKEN` (the batcher's own Koios key, never the
   site's). Deploy. Without `BATCHER_LIVE` it prepares and judges every batch and signs nothing;
   every report and every email says `DRY RUN`. **Within a minute of the start both checks must
   turn green** (the first report goes out after the first round; a check never pinged stays grey
   and alerts no one): if not, a ping URL is wrong. Run it a week, counted from the first
   `"kind":"prepared"` line (each report says how many batches were prepared): with no real
   order, place one small order per pool, or the week judges nothing.
7. **Go live**, once the dry run is clean: set `BATCHER_LIVE` = `1`. It signs nothing until both
   checks have answered "OK" (`alarm-unreachable` in the log until then), so a wrong ping URL,
   even one naming a check that does not exist, keeps it from signing rather than signing with
   no alarm. After changing any ping URL, see both checks green again.
8. **Once the two-key treasury exists, name it**, and the batcher sweeps instead of stopping at
   the cap. Add to `BATCHER_SETTINGS`:
   `"sweep": {"treasury": "<the treasury's address>", "treasuryScript": "<its payment script, hex>", "keep": "30000000"}`.
   The address is the role timelock's `treasury` (cardano/role-timelock), exactly. The script is
   the shared wallet's payment script; if the wallet does not show it, rebuild it from the two
   members' payment key hashes and check it against the address:
   `node scripts/treasury-script.ts all <key hash> <key hash> --address <the treasury's address>`
   (try `2` in place of `all` if it says the address is not paid to it). The batcher refuses a
   treasury paid to one key, a script needing fewer than two distinct keys, or a script the
   address is not paid to. `keep` is the float left after a sweep: at least 10 ADA, and at
   least 10 ADA below `floatCap`. A dry run prepares each sweep and sends nothing.

**What the emails mean.**
- `cardano-batcher` DOWN: the process is gone (Railway gave up after ten restarts, or the
  project is down). Open Railway's logs.
- `cardano-batcher-alerts` DOWN: read the reason in the email.
  - `STOPPED: ...`: it stopped itself (refusals in a row; its wallet or settings; the float cap,
    below): it stays up and idle until you fix the cause and redeploy.
  - `the last N batches sent never reached a block`: the submitting node takes them and passes
    none on. It stays DOWN until one lands.
  - `no round has reached a source for N minutes` names the last problem (Demeter or Koios down,
    a wrong key).
  - `ALERT (n): ...` is something to read (our engine and the contract disagreeing on an order,
    every batch refused as expired): at most one such email an hour, and the next healthy ping
    clears it.
  - `could not start: ...`: a variable is wrong (it names which); fix it, and Railway retries.
  - `STOPPED (fatal ...)`: EMURGO's library broke; the container starts the batcher again by
    itself, with what broke it set aside.
  healthchecks.io emails only when a check changes. So when a new reason comes while the check
  is already DOWN, the batcher first pings it UP ("not recovered: a new problem follows") and
  then DOWN again: an UP email straight before a DOWN one means "read the DOWN one".
- **The float cap, and the sweep.** The batcher keeps every fee it earns. How money moves: each
  order's batcher fee lands at the batcher's own address, each batch's network fee is paid from
  it, and what is left grows its plain ADA. Above `floatCap` (counting only that plain ADA: a gift
  carrying tokens is never its to spend), with the treasury named, one sweep sends everything
  above `sweep.keep`, less a network fee of about 0.2 ADA, to the treasury, and batching goes on;
  never the collateral UTxO, never a UTxO a batch in flight spends. Before the key signs, the
  sweep is read back: it may spend only the UTxOs chosen and pay only two outputs, exactly
  `keep` back to the batcher and the rest to the treasury, in ADA alone, with nothing else in
  it. A plain ADA gift is swept with the rest (it becomes the treasury's). Without a treasury
  named, it stops above the cap, as before: the only way on is to raise `floatCap` and redeploy.
  A sweep the node refuses for anything but a spent input or a closed window stops the batcher
  (a person is needed); `swept` lines and each report say how much went.

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
