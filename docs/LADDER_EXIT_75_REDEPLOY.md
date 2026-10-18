# The room ladders move to a 75% exit: your redeploy

Owner, 2026-10-18: "the staking exit needs to be 75 on solana eth base robinhood".

This is the EVM half. The room staking pools on Ethereum and Base are `LighthouseLadder.sol`
contracts, and their early-exit penalty is a compile-time constant, so a new number is a new
contract. Six pools, six broadcasts, your signature. Nothing here moves money: every pool is
empty and was never funded.

What the other rails do: the BAYLA ladder on Solana is its own program and already charges
veYFI's schedule capped at 75%. The Streamflow room pools have no early exit at any price.
TOWELI staking moves to 75% in PR #824, with its own release. Robinhood Chain has no room
ladder today; the script below deploys one at 75% there whenever a room gets one.

## What is live, and what this changes

| Room | Chain | Pool (25% exit, retire after the redeploy) | Stakes | Notifier Safe |
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

- `contracts/src/LighthouseLadder.sol`: `EARLY_EXIT_PENALTY_BPS = 7_500`. The penalty still
  stays in the pool as reward budget for the stakers who waited. No treasury path.
- `contracts/script/DeployLighthouseLadder.s.sol`: refuses any build whose exit is not 75%
  (L-INV-13) and accepts Robinhood (4663) beside Ethereum and Base.
- `contracts/script/FundLighthouseStaking.s.sol`: refuses to fund a ladder whose exit is not
  75%, so the six old addresses cannot be funded by mistake once they are retired.
- `contracts/script/mutate-ladder-exit.sh`: proves a 25% build fails the tests.
- The room staking card reads `EARLY_EXIT_PENALTY_BPS()` from the pool it shows. It says 25%
  on the six above, 75% on the pools you deploy, and no number when the read fails. There is
  no copy switch to flip: the site cannot say 75% while a 25% pool is live.
- `scripts/verify-ladder-builds.mjs` (the daily registry job) now reads the exit of every
  shipped ladder and reports it. A 25% pool passes with a WARN until the repin PR flips
  `ACCEPT_RETIRED_EXIT_UNTIL_REPIN` to `false`; from then on a 25% pool fails the job.

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

Expect: the tests green; the mutation script ending in `OK: 25% is caught, 75% passes, source
restored.`; the verifier printing six rows with build `exit25` and exit `25%`, then exit 0. The
window column reads `replaceable` on five and `CLOSED` on QR (the rate-0 period above). The
window that matters is money, so read it directly, from the repo root:

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
every gate in the script, L-INV-13 included. Nothing is sent.

```bash
ETH_RPC_URL=https://eth.drpc.org ./script/ladders-75.sh ethereum dry-run
```

```bash
BASE_RPC_URL=https://mainnet.base.org ./script/ladders-75.sh base dry-run
```

Expect, per pool: `1. LighthouseLadder: 0x...`, `before the lock -> principal - 75%, rewards paid`,
and no `L-INV` line. The addresses printed here are simulation addresses and mean nothing.

For a fuller rehearsal, deploy onto a local anvil fork and read the pools back. In one terminal:

```bash
anvil --fork-url https://mainnet.base.org --auto-impersonate --port 8545
```

In another, from `contracts/`:

```bash
./script/ladders-75.sh base anvil
```

Expect a table of five pools each reading `exit=7500 minStake=100000000000000000000`, the fee
Safe as notifier and the room's token. The same with `--fork-url https://eth.drpc.org` and
`ethereum anvil` for PEPE. The anvil run keeps its broadcast log in the temp folder, never in
`contracts/broadcast/`.

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

If `L-INV-13` reverts, the build is not the 75% one: rebuild from trunk and run again. Do not
repin a pool that reverted.

The script prints each new address from forge's own output and reads it back. Keep the
broadcast logs: `contracts/broadcast/DeployLighthouseLadder.s.sol/8453/run-latest.json` and
`.../1/run-latest.json` are committed with the repin. Take the address from a log's
`contractAddress`, keyed by `(from, nonce)`, never from its `hash` field.

## Phase C: read back (no gas)

For each new pool, on its chain:

```bash
cast call <pool> "EARLY_EXIT_PENALTY_BPS()(uint256)" --rpc-url https://mainnet.base.org
```

Expect `7500`. Then `MIN_STAKE()(uint256)` answers `100000000000000000000`,
`rewardsDistribution()(address)` the Safe from the table, `stakingToken()(address)` the room's
token, and `totalSupply()(uint256)` `0`.

## Phase D: the repin PR (no gas; hand the six addresses to an agent)

One commit, all of it together, so a half-done repin cannot ship. Addresses are EIP-55
derived, never typed: `cast to-check-sum-address <addr>`.

1. `frontend/src/lib/bungalows.ts`: the six `stakePool` values on the PEPE, QR, MFER, BNKR,
   DRB and JBM rows.
2. `frontend/scripts/addresses.json`: on each of `ladder-pepe`, `ladder-qr`, `ladder-mfer`,
   `ladder-bnkr`, `ladder-drb`, `ladder-jbm` write the new address, keep `"status": "live"`,
   and change `25% early-exit penalty` to `75% early-exit penalty` in the role. Add one row per
   old pool, id `ladder-<room>-exit25-retired`, carrying the old address, `"status": "retired"`,
   `"expect": { "type": "contract" }`, and a role that says: retired on the repin date by the
   repin PR; the 25% exit build deployed 2026-09-05; never funded, never staked (the read
   date); nothing in the app routes here; never send a deposit to it. Then
   `node frontend/scripts/verify-addresses.mjs`.
3. `frontend/src/lib/bungalows.test.ts`: the `POOLS` map that pins each room to its pool.
4. `frontend/src/components/bungalow/HeldTimeLine.test.tsx`: `PEPE_LADDER`, for accuracy.
5. `docs/CONTRACTS.md`: the "Bungalow lighthouses" table gets the new six; the old six join the
   retired table with the reason.
6. `scripts/verify-ladder-builds.mjs`: `ACCEPT_RETIRED_EXIT_UNTIL_REPIN = false`. From here a
   25% pool fails the daily job. Run `node scripts/verify-ladder-builds.mjs`: six rows `fixed`,
   `75%`, exit 0.
7. `CHANGELOG.md`, one line: room staking on Ethereum and Base, leaving before the lock opens
   now costs 75%, with the date.
8. Leave `C1_UNSAFE_LADDER_POOLS` in `frontend/src/lib/lighthouseLadder.ts` alone, and leave
   `ISLAND_READ_POOLS` in `bungalows.ts` alone: the island does not read the EVM ladders today,
   so the held-time line keeps saying the pool is not counted. If the island ever lists them,
   it lists the new addresses.

Gates before merge: `npm run lint`, `npx tsc -b --noEmit`, `npm test` in `frontend/`, and
`node scripts/verify-ladder-builds.mjs` at the root. The card needs no change: it reads the
penalty from whichever pool the registry names.

## Phase E: fund last, in public (unchanged)

Open an honest position at a long lock before the first notify, then
`contracts/script/FundLighthouseStaking.s.sol` from the notifier Safe. It refuses a pool whose
exit is not 75%, so a retired address cannot be funded. Before funding any Base pool, prove the
fee Safe can execute a transaction (it never has).

## Robinhood

No room has a ladder on Robinhood Chain. The deploy script accepts chain 4663
(`test/vendor/DeployLighthouseLadderGate.t.sol` deploys there at 75%), and
`ladders-75.sh robinhood` has an empty table with the row shape to add: the room's token and a
Robinhood Safe with code as the notifier, `ROBINHOOD_RPC_URL` set.

## The fee map

The fee map and the island split map of 2026-10-18 say room staking on Ethereum and Base
leaves early at 25%. That is true until the repin lands. Regenerate them after.
