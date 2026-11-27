# Our own Uniswap V3 on HyperEVM: the deploy kit

**Nothing here is deployed yet.** This folder is everything needed to put our own copy of
Uniswap V3 on HyperEVM (Hyperliquid's EVM, chain 999), and the checks that prove the copy is exact.
Plan and owner decisions: `SPEC-2026-11-19-hyperevm-uniswap-v3.md` (repo root of the main checkout,
not committed).

## In plain English

- **The contracts are Uniswap's, unchanged.** They are deployed by Uniswap's own deploy tool
  (`Uniswap/contracts` at `a677c0d4b5fb6e3357cf6d0f0315bcb135a1e1ee`, the commit Uniswap used for its
  own HyperEVM launch), from Uniswap's own compiled code. We only supply a settings file
  (`tasks/`) with our addresses.
- **The venue's cut is collected by Uniswap's own fee switch** (`V3OpenFeeAdapter`, from
  `Uniswap/protocol-fees` at `eacc9c013cf74316263cfae7a00b3361a1644795`). It is the contract that owns
  Uniswap's own V3 factory on Ethereum today. Anyone can press its two buttons, "switch the cut on
  for this pool" and "collect", but the money can only go to one address, fixed at deploy: **our
  treasury Safe**.
- **The only new contract we wrote** is `src/HyperEVMFeeAdapterDeployer.sol`. It is step 7 of
  Uniswap's own `OPStackDeployer`, copied line for line. It sets the fee switch up in one
  transaction, then hands every role to our admin Safe.

### How money moves

| Who | How they earn | On what |
|---|---|---|
| LPs | the pool's swap fee (0.01%, 0.05%, 0.3% or 1%) on every trade while the price is inside their range | every trade through that pool, from any app or bot |
| Venue, pool cut | a share of each pool's fee: **1/4 on the 0.01% and 0.05% pools, 1/6 on the 0.3% and 1% pools** (Uniswap's own mainnet schedule, unchanged). On a 0.3% pool that is 0.05% of each trade | every trade through our pools, from any app or bot |
| Venue, site fee | a cut of each swap made on our site, taken by the router in the same transaction (PAY_PORTION). The rate is the owner's decision | swaps made on our site only |
| Venue, opening fee | none: Uniswap's factory has no opening fee | — |

- A new pool pays the venue **nothing until someone presses "switch the cut on"** for it.
  `script/OpenPool.s.sol` presses it straight away, and `kit.mjs fee-job` finds any pool still at 0.
- The admin Safe can change the schedule at any time (`setFeeTierDefault`). To deploy with a
  different one, change the four constants in `src/HyperEVMFeeAdapterDeployer.sol`; the tests pin
  them, so the tests must change with them.

## What gets deployed

| Run | Contract | Settings |
|---|---|---|
| A | UnsupportedProtocol | Uniswap's revert-only stand-in for the protocols we leave out (V2, V4, Across) |
| B | UniswapV3Factory (+ every pool it opens) | 0.01% tier added, owner = admin Safe (Deploy-all does both) |
| B | QuoterV2, TickLens | wrapped HYPE |
| B | NonfungibleTokenPositionDescriptor (behind a proxy) | label "HYPE", upgrade key = admin Safe |
| B | NonfungiblePositionManager | our factory, wrapped HYPE, our descriptor |
| B | UniversalRouter 2.2.0 | our factory + position manager; V2/V4/Across slots = UnsupportedProtocol |
| C | HyperEVMFeeAdapterDeployer → V3OpenFeeAdapter | treasury = treasury Safe; owner + fee setter = admin Safe |
| Safe | `factory.setOwner(adapter)` | one admin Safe transaction: hands the factory to the fee switch |

Not deployed: Uniswap V2, V4, SwapRouter, SwapRouter02, V3Migrator, the interface Multicall
(viem uses Multicall3, already on HyperEVM).
The position images use Uniswap's NFTDescriptor library. Uniswap's tool finds it already at its
fixed address on HyperEVM and reuses it. It is a stateless drawing library: it holds nothing and has
no owner.

## What has been proved (2026-11-20)

Unit tests (`forge test`, 9 tests). They run on Uniswap's exact V3 factory code:
- **Pools:** our pools have Uniswap's canonical pool init code hash
  `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54`.
- **Roles:** only the two Safes hold a role. The deployer contract and the deployer wallet hold none.
- **The cut:** a new pool pays 0 until trigger, then Uniswap's schedule applies. Collect pays only the
  treasury, exactly 1/6 of the 0.3% fee.
- **Mutants:** each test was proved to fail against four broken copies, and the restore was
  proved. The four: the cut sent elsewhere, ownership not handed over, a wrong fee schedule, and
  wrong compiler settings.

`scripts/check-adapter-bytes.mjs`: **our compiled V3OpenFeeAdapter is byte-identical to Uniswap's live
one on Ethereum** (`0xf2371551Fe3937Db7c750f4DfABe5c2fFFdcBf5A`). Only its two immutables and the
metadata hash are masked. CI runs it offline, against a pinned fingerprint.

**Dress rehearsal on a local fork of HyperEVM mainnet** (block 51,779,094). Uniswap's Deploy-all ran
unchanged with our task files. Then the fee switch was deployed, and the Safe step was done by
impersonating the Safe. `kit.mjs check` then passed. Results:
- **Byte-identical to Uniswap's own HyperEVM contracts**, apart from the addresses baked into each:
  the factory, QuoterV2, TickLens, the descriptor, the position manager and the UniversalRouter.
  - The router also differs in its cached EIP-712 domain separator, a hash of its own address.
    Proof: Uniswap's build, deployed with Uniswap's own settings at another address, differs from
    Uniswap's router in exactly that word too.
- The UnsupportedProtocol stand-in is a different compile from Uniswap's HyperEVM copy. It is held
  instead to what it must do: revert every call with `UnsupportedProtocolError()`.
- **The money path** (`script/Smoke.s.sol`) was run through OUR router in the order the site sends
  it:
  - a 0.1 HYPE buy paid the treasury exactly the site fee;
  - the sell paid it in wrapped HYPE;
  - collecting moved both coins' pool cut to the treasury, to the wei.
- A pool opened around the kit, straight on the factory, was found by `fee-job` as "cut OFF".
  A stranger's wallet then switched it on, which is what "anyone can press it" means.
- Gas measured:
  - run A: 84k;
  - run B: 20.0M in total, the largest single transaction 7.5M;
  - fee switch: about 2.9M;
  - opening one pool: about 4.6M.
  Fast blocks hold 3M, so **every step except run A needs big blocks**.

## Before the real deploy (owner)

1. **Safes on HyperEVM** (Safe app, HyperEVM network). You need a treasury Safe (where the cut
   goes) and an admin Safe (owner, fee setter, NFT-image upgrade key). They must be two different
   Safes. The Base/Robinhood pair is treasury `0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0` and
   multisig `0xBC4E8abe4b0F16FC65c5bCADd018b3C44c47Be5B`. Safe 1.4.1 and 1.3.0 L2 are both on
   HyperEVM, so try the app's "add another network" to get the same addresses. Every script
   refuses an address that has no code.
2. **Decisions** (see the spec):
   - the venue's share (default: Uniswap's schedule above);
   - the site fee;
   - no opening fee on HyperEVM;
   - whether the island's share covers it;
   - the first pools.
3. **Deployer wallet:** about **0.3 HYPE** on HyperEVM. Uniswap's own run spent about 0.02 HYPE and
   brought 1. It must also be a Hyperliquid "core" user before big blocks can be switched on: send
   0.1 HYPE to `0x2222222222222222222222222222222222222222`, or hold any coin on Hyperliquid's core
   side.
4. **Testnet first (998)**: every step below with `--chain 998`, the testnet RPC, and then
   `Smoke.s.sol`.

## The commands

On this PC, Windows' `cast.exe`/`anvil.exe` are blocked, so run Foundry **in WSL** (1.7.1, the
version CI pins). `ulimit -s unlimited` is needed or solc crashes building Uniswap's repo.
Signing steps use the keystore (`--keystore …` or `--account …`): the key is never on disk in
the clear. Run them yourself: this app does not send mainnet transactions.

```bash
# once: Uniswap's deploy tool at the pinned commit, plus the two libraries it needs
git clone https://github.com/Uniswap/contracts ~/uniswap-contracts && cd ~/uniswap-contracts
git checkout a677c0d4b5fb6e3357cf6d0f0315bcb135a1e1ee
git submodule update --init --depth 1 lib/forge-std lib/openzeppelin-contracts
python3 -m venv .venv && .venv/bin/pip install -r script/hyperevm/requirements.txt
export TENDERLY_PUBLIC_RPC_URL=http://localhost:1 TENDERLY_ACCESS_KEY=dummy   # their foundry.toml needs these
ulimit -s unlimited
KIT=<repo>/contracts/hyperevm; RPC=https://rpc.hyperliquid.xyz/evm   # fallback https://hyperliquid.drpc.org
KEY=(--keystore <path-to-keystore>); DEPLOYER=<deployer address>

# big blocks ON (Uniswap's tool; Hyperliquid's official Python SDK)
PRIVATE_KEY=$(cast wallet private-key "${KEY[@]}") .venv/bin/python script/hyperevm/toggle_big_blocks.py on

# run A: the revert-only stand-in
node $KIT/scripts/kit.mjs task --run A --uniswap . --chain 999 --rpc $RPC
forge script script/deploy/Deploy-all.s.sol --rpc-url $RPC --sig "run()" "${KEY[@]}" --sender $DEPLOYER \
  --broadcast --slow --with-gas-price 1000000000 --priority-gas-price 0 --skip '*/node_modules/*'
node $KIT/scripts/kit.mjs record --run A --chain 999 --broadcast broadcast/Deploy-all.s.sol/999/run-latest.json

# run B: Uniswap V3 + the router (about 10 min of big blocks; never Ctrl-C midway)
node $KIT/scripts/kit.mjs task --run B --uniswap . --chain 999 --rpc $RPC --admin-safe <ADMIN SAFE> --unsupported <from run A>
forge script script/deploy/Deploy-all.s.sol --rpc-url $RPC --sig "run()" "${KEY[@]}" --sender $DEPLOYER \
  --broadcast --slow --with-gas-price 1000000000 --priority-gas-price 0 --skip '*/node_modules/*'
node $KIT/scripts/kit.mjs record --run B --chain 999 --broadcast broadcast/Deploy-all.s.sol/999/run-latest.json

# run C: the fee switch (prints the Safe transaction to make next)
cd $KIT && TREASURY_SAFE=<TREASURY SAFE> ADMIN_SAFE=<ADMIN SAFE> V3_FACTORY=<from run B> \
  forge script script/DeployFeeAdapter.s.sol --rpc-url $RPC "${KEY[@]}" --sender $DEPLOYER --broadcast --slow
node scripts/kit.mjs record --run adapter --chain 999 --broadcast broadcast/DeployFeeAdapter.s.sol/999/run-latest.json

# read it all back: every contract byte for byte against Uniswap's, and who holds what
node scripts/kit.mjs check --chain 999 --rpc $RPC
node scripts/check-adapter-bytes.mjs --live <adapter> --rpc $RPC
```

Then, in the **admin Safe**, make the one transaction `DeployFeeAdapter` printed: `to` = our factory,
`data` = `setOwner(<adapter>)`. Read the proposal back before signing. Run `kit.mjs check` again: it
should end "factory is handed to the adapter".

Open the first pools (big blocks still ON, from the deployer or an ops wallet):

```bash
node scripts/kit.mjs sqrt-price --rpc $RPC --a <coin A> --b <coin B> --price <how many B for 1 A>
NPM=<…> FEE_ADAPTER=<…> TOKEN_A=<…> TOKEN_B=<…> FEE=3000 SQRT_PRICE_X96=<from above> \
  forge script script/OpenPool.s.sol --rpc-url $RPC "${KEY[@]}" --sender <wallet> --broadcast --slow
```

Big blocks OFF afterwards (`toggle_big_blocks.py off`), so normal transactions land in 1-second blocks.

Daily, or whenever: `node scripts/kit.mjs fee-job --chain 999 --rpc $RPC --from-block <run B's block>`.
It lists every pool, whether its cut is on, and what is waiting. It prints the two
permissionless `cast send` lines, which any wallet with a little HYPE can send.

If a broadcast halts midway, do not start over. Follow Uniswap's runbook
(`script/hyperevm/README.md` in their repo, "If the broadcast halts midway"). The factory trap:
if the run died between creating the factory and its `enableFeeAmount(100, 1)` / `setOwner`
calls, the deployer still owns it. Check `owner()` first.

## Rehearse it yourself (local fork, no money)

```bash
anvil --fork-url https://rpc.hyperliquid.xyz/evm --fork-block-number <head-20> --gas-limit 30000000 --port 8546
# anvil's first dev key as the deployer; two stand-in "Safes" given code so the scripts accept them
cast rpc anvil_setCode <admin stand-in> 0x00 --rpc-url http://127.0.0.1:8546   # same for the treasury stand-in
# then the commands above against http://127.0.0.1:8546 with --private-key <anvil key> instead of a keystore,
# and kit.mjs record/check with --file <scratch path> so deployments/999.json is never written.
# Safe step: cast rpc anvil_impersonateAccount <admin> ; cast send <factory> <data> --from <admin> --unlocked
REHEARSAL=yes NPM=… UNIVERSAL_ROUTER=… FEE_ADAPTER=… TREASURY_SAFE=… forge script script/Smoke.s.sol --tc Smoke --broadcast …
```
