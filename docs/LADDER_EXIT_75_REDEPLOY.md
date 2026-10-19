# The room ladders keep the ladder's law: your redeploy

Owner, 2026-10-18: "the staking exit needs to be 75 on solana eth base robinhood", and, after
the island's answer on the split (section 4), "The six room ladders keep the ladder's law."

The ladder's law is the BAYLA ladder's exit, copied: leaving before your lock opens costs the
time left on the lock over four years, capped at 75%, and it stays in the pool for the stakers
who remain. Four years left costs 75%, one year left 25%, a seven-day lock left at once 7/1460
(about 0.48%). A flat 75% on a seven-day lock is a trap; "the six redeploys carry the ladder's
law or wait."

This is the EVM half. The room staking pools on Ethereum and Base are `LighthouseLadder.sol`
contracts, and their exit is compile-time, so a new schedule is a new contract. Six pools, six
broadcasts, your signature. Nothing here moves money: every pool is empty and was never funded.

What the other rails do: the BAYLA ladder on Solana already charges this schedule. The Streamflow
room pools have no early exit at any price. TOWELI staking's 75% is the venue's own call, PR #824,
and does not change. Robinhood Chain has no room ladder today; the script below deploys one under
the same law whenever a room lives there.

## What is live, and what this changes

| Room | Chain | Pool (flat 25% exit, retire after the redeploy) | Stakes | Notifier Safe |
|---|---|---|---|---|
| PEPE | Ethereum | `0xBE1905de5FCDe60E13a9F1AfA44BEfdE1C5aaA1D` | `0x6982508145454ce325ddbe47a25d4ec3d2311933` | `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d` (treasury) |
| QR | Base | `0x55B72f09d31f43834bf7Eba42f53a419a716F554` | `0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf` | `0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1` (fee Safe) |
| MFER | Base | `0xeCB3C54488A2A0dF764444f67B2Df6b8Ad4EaDd6` | `0xe3086852a4b125803c815a158249ae468a3254ca` | same |
| BNKR | Base | `0xe6abC8AcA0415aFaC426ec1242BB17afABe8Dbcf` | `0x22af33fe49fd1fa80c7149773dde5890d3c76f3b` | same |
| DRB | Base | `0x0aCB93fcFD5b1950D94064998017a2601b36D7bB` | `0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2` | same |
| JBM | Base | `0x3C339692ec7B3b96ad6F8fbEb5F5202164b44465` | `0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d` | same |

All six read `totalSupply() == 0` and hold none of their token on 2026-10-18: nobody staked,
nothing was funded. That is what makes this a replacement and not a migration. QR alone has
`periodFinish` set (1794465533, 2026-11-12): a zero-reward notify on 2026-09-13 opened a 60-day
period at rate 0, which moves no money. Phase A re-reads all six; a non-zero stake or balance
anywhere means stop.

The code side is done and merged with this runbook:

- `contracts/src/LighthouseLadder.sol`: `penaltyFor(amount, lockEnd)` is the schedule, with the
  cap `MAX_EARLY_EXIT_PENALTY_BPS = 7_500`, and both early doors charge exactly it. The flat
  `EARLY_EXIT_PENALTY_BPS` is gone. The penalty still stays in the pool as reward budget.
- `contracts/script/DeployLighthouseLadder.s.sol`: refuses any build that is not the law
  (L-INV-13 to 16: the cap, four years left at the cap, one year left at 25%, a matured lock
  free) and accepts Robinhood (4663) beside Ethereum and Base.
- `contracts/script/FundLighthouseStaking.s.sol`: refuses to fund a ladder with no schedule (the
  flat builds) or one whose one-year quote is not 25%, so neither retired flat build can be
  funded by mistake once the registry repins.
- `contracts/script/mutate-ladder-exit.sh`: proves a flat 75% and a 25% cap both fail the tests.
- The room staking card reads the pool it shows: the six above answer a flat rate and the card
  says 25%; the new build answers the cap and the card quotes each position's exit from the
  pool itself (`penaltyFor`), as tokens and as a share, with no number when a read fails. There
  is no copy switch to flip for the card.
- `LIVE_LADDER_EXIT_SCHEDULE` and `LIVE_LADDER_EXIT_BPS` in `frontend/src/lib/lighthouseLadder.ts`
  are the one switch for build-time copy: `'flat'` and `2_500n` today. llms.txt prints it.
  `scripts/verify-ladder-builds.mjs` (the daily registry job) reads every shipped ladder's exit
  and fails any pool that differs from the switch, so the switch cannot be flipped before the
  repin, and the repin cannot forget the switch.

## Phase A: preflight (no gas, no key)

From `contracts/`:

```bash
forge test --match-path "test/vendor/{LighthouseLadder,FundLighthouseGuard,DeployLighthouseLadderGate}.t.sol"
```

```bash
./script/mutate-ladder-exit.sh
```

From the repo root:

```bash
node scripts/verify-ladder-builds.mjs
```

Expect: the tests green; the mutation script ending in `OK: both mutants caught, the law passes,
source restored.`; the verifier printing six rows with build `exit25` and exit `25% flat`, then
exit 0. The window column reads `replaceable` on five and `CLOSED` on QR (the rate-0 period
above). The window that matters is money, so read it directly, from the repo root:

```bash
for p in 0xBE1905de5FCDe60E13a9F1AfA44BEfdE1C5aaA1D; do cast call $p "totalSupply()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com; cast call 0x6982508145454ce325ddbe47a25d4ec3d2311933 "balanceOf(address)(uint256)" $p --rpc-url https://ethereum-rpc.publicnode.com; done
```

```bash
for p in 0x55B72f09d31f43834bf7Eba42f53a419a716F554 0xeCB3C54488A2A0dF764444f67B2Df6b8Ad4EaDd6 0xe6abC8AcA0415aFaC426ec1242BB17afABe8Dbcf 0x0aCB93fcFD5b1950D94064998017a2601b36D7bB 0x3C339692ec7B3b96ad6F8fbEb5F5202164b44465; do cast call $p "totalSupply()(uint256)" --rpc-url https://mainnet.base.org; done
```

Every line must be `0`. A non-zero `totalSupply` means someone staked since this was written:
stop, that pool needs a migration plan, not a replacement.

## Phase A2: dry run on a fork (no gas, no key)

Both runs simulate every pool against the live chain through forge's own dry run, which exercises
every gate in the script, L-INV-13 to 16 included. Nothing is sent.

```bash
ETH_RPC_URL=https://ethereum-rpc.publicnode.com ./script/ladders-75.sh ethereum dry-run
```

```bash
BASE_RPC_URL=https://mainnet.base.org ./script/ladders-75.sh base dry-run
```

Expect, per pool: `1. LighthouseLadder: 0x...`, `before the lock -> principal minus the time left
over`, and no `L-INV` line. The addresses printed here are simulation addresses and mean nothing.

For a fuller rehearsal, deploy onto a local anvil fork and read the pools back. In one terminal:

```bash
anvil --fork-url https://mainnet.base.org --auto-impersonate --port 8545
```

In another, from `contracts/`:

```bash
./script/ladders-75.sh base anvil
```

Expect a table of five pools each reading `cap=7500 oneYearLeft=250000000000000000`, the fee
Safe as notifier and the room's token. The same with `ethereum anvil` for PEPE, forking an
Ethereum endpoint that serves historical state (publicnode refuses archive reads to anvil;
eth.drpc.org reset the connection on 2026-10-18; a keyed endpoint is surest). The anvil run
keeps its broadcast log in the temp folder, never in `contracts/broadcast/`.

## Phase B: deploy (gas, your signature, irreversible)

Each broadcast creates a permanent address with an immutable `rewardsDistribution`. No setter,
no undo. Base first, with QR as the cheap rehearsal, then Ethereum.

```bash
SIGNER="--account deployer" BASE_RPC_URL=https://mainnet.base.org ./script/ladders-75.sh base broadcast
```

```bash
SIGNER="--account deployer" ETH_RPC_URL=https://ethereum-rpc.publicnode.com ./script/ladders-75.sh ethereum broadcast
```

`SIGNER` is your keystore (`cast wallet import deployer --interactive`), `--ledger`, or
`--interactive` to type the key once, unlogged. The script refuses `--private-key`. To do one
pool at a time, append its id: `./script/ladders-75.sh base broadcast qr`.

The September path still works too, one pool per command from PowerShell, as in
`docs/TODO_OPERATOR.md` under "PHASE B": set `EXPECTED_CHAIN_ID`, `STAKING_TOKEN` and
`REWARDS_DISTRIBUTION` from the table above and run
`forge script script/DeployLighthouseLadder.s.sol --rpc-url ... --broadcast --interactive`.

If any `L-INV-13` to `L-INV-16` reverts, the build is not the law: rebuild from trunk and run
again. Do not repin a pool that reverted.

The script prints each new address from forge's own output and reads it back. Keep the
broadcast logs: `contracts/broadcast/DeployLighthouseLadder.s.sol/8453/run-latest.json` and
`.../1/run-latest.json` are committed with the repin. Take the address from a log's
`contractAddress`, keyed by `(from, nonce)`, never from its `hash` field.

## Phase C: read back (no gas)

For each new pool, on its chain:

```bash
cast call <pool> "MAX_EARLY_EXIT_PENALTY_BPS()(uint256)" --rpc-url https://mainnet.base.org
```

Expect `7500`. Then the schedule itself, one year left quoted at the chain's own clock:

```bash
cast call <pool> "penaltyFor(uint256,uint64)(uint256)" 1000000000000000000 $(( $(cast block latest -f timestamp --rpc-url https://mainnet.base.org) + 31536000 )) --rpc-url https://mainnet.base.org
```

Expect `250000000000000000` (a block of drift moves the last digits). `MIN_STAKE()(uint256)`
answers `100000000000000000000`, `rewardsDistribution()(address)` the Safe from the table,
`stakingToken()(address)` the room's token, and `totalSupply()(uint256)` `0`.

## Phase D: the repin PR (no gas; hand the six addresses to an agent)

One commit, all of it together, so a half-done repin cannot ship. Addresses are EIP-55
derived, never typed: `cast to-check-sum-address <addr>`.

1. `frontend/src/lib/bungalows.ts`: the six `stakePool` values on the PEPE, QR, MFER, BNKR,
   DRB and JBM rows.
2. `frontend/scripts/addresses.json`: on each of `ladder-pepe`, `ladder-qr`, `ladder-mfer`,
   `ladder-bnkr`, `ladder-drb`, `ladder-jbm` write the new address, keep `"status": "live"`,
   and change `25% early-exit penalty retained in-pool` in the role to `the ladder's law: an
   early exit costs the time left over four years, capped at 75%, retained in-pool`. Add one row
   per old pool, id `ladder-<room>-flat25-retired`, carrying the old address, `"status":
   "retired"`, `"expect": { "type": "contract" }`, and a role that says: retired on the repin
   date by the repin PR; the flat 25% exit build deployed 2026-09-05; never funded, never staked
   (the read date); nothing in the app routes here; never send a deposit to it. Then
   `node frontend/scripts/verify-addresses.mjs`.
3. `frontend/src/lib/bungalows.test.ts`: the `POOLS` map that pins each room to its pool.
4. `frontend/src/components/bungalow/HeldTimeLine.test.tsx`: `PEPE_LADDER`, for accuracy.
5. `docs/CONTRACTS.md`: the "Bungalow lighthouses" table gets the new six; the old six join the
   retired table with the reason.
6. `frontend/src/lib/lighthouseLadder.ts`: `LIVE_LADDER_EXIT_SCHEDULE = 'time-left'` and
   `LIVE_LADDER_EXIT_BPS = 7_500n`. From here llms.txt says the schedule and a flat pool fails
   the daily job. Run `node scripts/verify-ladder-builds.mjs`: six rows `fixed`, `law<=75%`,
   exit 0.
7. `CHANGELOG.md`, one line: room staking on Ethereum and Base, leaving before your lock opens
   now costs the time left on it over four years, capped at 75%, with the date.
8. Leave `C1_UNSAFE_LADDER_POOLS` in `frontend/src/lib/lighthouseLadder.ts` alone, and leave
   `ISLAND_READ_POOLS` in `bungalows.ts` alone: the island does not read the EVM ladders today,
   so the held-time line keeps saying the pool is not counted. If the island ever lists them,
   it lists the new addresses.
9. `scripts/check-interface-selectors.mjs`: delete the `EARLY_EXIT_PENALTY_BPS()` entry from
   `KNOWN_SUPERSEDED_FRONTEND_SELECTORS`, and the matching ABI entry and read in
   `frontend/src/lib/contracts.ts` and `EvmLadderPoolLive.tsx`: once no live pool answers the
   flat getter, the card has one shape to read and the guard has nothing to excuse.

Gates before merge: `npm run lint`, `npx tsc -b --noEmit`, `npm test` in `frontend/`, and
`node scripts/verify-ladder-builds.mjs` at the root. The card needs no change: it reads the
exit from whichever pool the registry names.

## Phase E: fund last, in public (unchanged)

Open an honest position at a long lock before the first notify, then
`contracts/script/FundLighthouseStaking.s.sol` from the notifier Safe. It refuses a pool that is
not the law, so a retired address cannot be funded. Before funding any Base pool, prove the fee
Safe can execute a transaction there (its only transaction so far is the zero notify on QR).

## Robinhood Chain (4663): prepared, not deployed

Owner, 2026-10-18: "do the same for robinhood too even though we wont be using it right now".
No room coin lives on Robinhood Chain and no ladder exists there, so there is nothing to deploy
and no address to write down. The registry says so in a note row with no address
(`frontend/scripts/addresses.json`, section `robinhood`). What is ready:

- The deploy script accepts chain 4663 and ships the same build, the ladder's law (L-INV-13 to
  16); `test/vendor/DeployLighthouseLadderGate.t.sol` deploys there in the test EVM.
- The notifier is the chain's fee-remittance Safe, `0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1`:
  the same address and the same two signers as on Base (`0x14898258122C0740106391E6e8E4F17F3b6d456E`
  and `0x28d7CB2F4D73C2750Ba0055c771871fec79260f8`, 2 of 2). Read on 4663 on 2026-10-18: 171 bytes
  of code, threshold 2, nonce 0, so it has never executed there. Prove it can before funding.
- The ladder and its deploy script read no sequencer feed; the chain's attested feed
  `0x12a249A027AA7DdF184E824b4bb63ba031A39fEC` is not involved.
- The card already maps `robinhood` to chain 4663 and labels it Robinhood Chain; the explorer
  is Blockscout, `https://robinhoodchain.blockscout.com`. The daily verifier reads 4663 through
  `RH_RPC` (default `https://rpc.mainnet.chain.robinhood.com`).

The day a room lives there, its ladder is one command per phase, the token being the only
input. From `contracts/`:

```bash
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com ROBINHOOD_STAKING_TOKEN=0x<room token> ROBINHOOD_POOL_ID=<room> ./script/ladders-75.sh robinhood dry-run
```

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --auto-impersonate --port 8548
```

```bash
ANVIL_RPC=http://127.0.0.1:8548 ROBINHOOD_STAKING_TOKEN=0x<room token> ROBINHOOD_POOL_ID=<room> ./script/ladders-75.sh robinhood anvil
```

```bash
SIGNER="--account deployer" ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com ROBINHOOD_STAKING_TOKEN=0x<room token> ROBINHOOD_POOL_ID=<room> ./script/ladders-75.sh robinhood broadcast
```

Rehearsed on 2026-10-18 with the chain's WETH (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, 18
decimals) standing in for a room token: the dry run against the live chain and the anvil fork
both deploy and read back the cap and the one-year quote, the fee Safe as notifier and WETH as
the staking token. That proves the path, not a pool: nothing was broadcast, and WETH is not a
room.

After a real deploy: read the cap and the one-year quote back on Blockscout or with `cast call`
against the Robinhood RPC, then the repin PR adds `robinhood` to the room's `chain` type in
`frontend/src/lib/bungalows.ts` (today `'ethereum' | 'base' | 'solana' | 'tbd'`), the room's row
with `poolKind: 'ladder'`, and a `ladder-<room>` registry row under `robinhood` with its broadcast.
Nothing but the room ladder goes to an L2: there is no veTOWELI on Base or Robinhood, ever.

## The fee map

The fee map and the island split map of 2026-10-18 say room staking on Ethereum and Base
leaves early at 25%. That is true until the repin lands. Regenerate them after, with the law's
words: the time left on the lock over four years, capped at 75%.
