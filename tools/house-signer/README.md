# house-signer

The house bidder's key lives here, and only here.

The house bidder (the bot in `frontend/scripts/house-bidder*`) reads OpenSea, the chain and
the internet, and decides what to bid. It never holds the key. This small, separate program
holds it, and signs only what matches a template pinned in its own code: a Seaport 1.6
collection bid on JBAC or GNSS, paid in WETH, at or under the price ceiling you set, with
OpenSea's 1% fee and nothing else; or one of nine plain transactions (approve, revoke, wrap,
unwrap, send home, cancel). So a bug in the bot, a poisoned OpenSea answer or a bad npm
package in the big frontend tree cannot make the house overpay, sign something else, or move
money anywhere but back to your funding wallet.

It has two dependencies, `@noble/curves` 1.9.1 and `@noble/hashes` 1.8.0 (the same versions
the frontend already uses), installed only into this folder and checked at start-up.

## What it will never sign

- A bid above the policy's `maxUnitPriceWei`, for more NFTs than `maxQty`, for a collection
  that is switched off, or for longer than `maxLifetimeSec` (30 minutes by default).
- A bid paid in anything but WETH, for anything but "any NFT of this collection" (trait and
  single-NFT bids are refused in this version), or delivering the NFT to anyone but the house.
- A bid with any fee line other than OpenSea's 1% (and, only if you set them in the policy,
  the creator's fee to the creator's own address and the venue's 0.5% to the venue Safe).
- Anything for another chain, another contract, another EIP-712 domain, a bulk-order tree,
  or typed data it did not build itself. It never takes types, a domain, a salt, a counter
  or calldata from the bot.
- A WETH approval to anyone but OpenSea's conduit, or above `maxAllowanceWei`.
- A transfer of WETH or an NFT to anyone but `fundingWallet`.
- A transaction that sends ETH (except a wrap, up to `maxWrapWei`), creates a contract, is
  EIP-7702 (type 4), or offers more gas fee than the policy allows.
- A listing (selling NFTs is off in this version).
- A gasless cancel or an on-chain cancel for an order it did not sign itself.
- Anything at all while a file named `STOP` or `STOP.txt` is in the keys folder, except
  cancels, revokes, sending things home, and the kill.

Every signature is recovered and compared with the house address before it is returned.

## Set up (once)

The keys folder is `C:\Users\jimbo\evm-keys\house-bidder\` (any other folder with
`--keys <dir>`; never anywhere inside OneDrive, which it refuses). It holds:

| File | What |
|---|---|
| `keystore.json` | the house key, encrypted with your password (made by `create`) |
| `house-bidder.env` | `HOUSE_RPC_HTTP` (comma list of RPC URLs), `HOUSE_SEND_URLS` (comma list, e.g. `https://rpc.flashbots.net/fast,https://eth.drpc.org`), `HOUSE_PIN_COMMIT` (the reviewed git commit the live signer must run at); the bot's own settings live here too |
| `policy.json` | the limits (shape below) |
| `STOP` / `STOP.txt` | present = nothing new is signed |
| `signer-audit.jsonl`, `signer-orders.jsonl` | written by the signer, append-only |

Run these from PowerShell or Windows Terminal (Git Bash hides the terminal from Node; there,
put `winpty` in front):

```
cd <repo>\tools\house-signer
npm ci --ignore-scripts
node src\cli.mjs create
```

`create` asks for a new password twice (at least 12 plain ASCII characters), makes a new key
from the operating system's random source, writes `keystore.json` (scrypt, the same strength
geth uses) and prints only the address. Write the password down somewhere safe: without it
the key is gone. It never overwrites an existing keystore.

Then put that address in `policy.json` as `house`, and have it added to the site's house
registry (`frontend/src/lib/house/houseRegistry.json`) with the collections it bids on.

`policy.json`:

```json
{
  "version": 1,
  "chainId": 1,
  "house": "0x<the address create printed>",
  "fundingWallet": "0x<the only address WETH and NFTs may go back to>",
  "collections": {
    "junglebay": { "address": "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9", "enabled": true,  "maxUnitPriceWei": "45000000000000000", "maxQty": 2, "inventoryCap": 3, "creatorFee": null },
    "gnssart":   { "address": "0xa1De9f93c56C290C48849B1393b09eB616D55dbb", "enabled": false, "maxUnitPriceWei": "16000000000000000", "maxQty": 1, "inventoryCap": 2, "creatorFee": null }
  },
  "openseaFee": { "recipient": "0x0000a26b00c1F0DF003000390027140000fAa719", "bps": 100 },
  "venueFee": null,
  "maxLifetimeSec": 1800,
  "maxAllowanceWei": "150000000000000000",
  "maxWrapWei": "200000000000000000",
  "gas": { "maxFeeGwei": 20, "priorityGwei": 0.05, "killPriorityGwei": 2, "maxGasLimit": 300000 },
  "listing": { "enabled": false, "maxLifetimeSec": 259200, "minUnitPriceWei": { "junglebay": "40000000000000000", "gnssart": "15000000000000000" } }
}
```

The signer refuses a policy that names a collection, contract, fee recipient or fee rate it
does not already know: the policy can make things stricter, never point the house somewhere
new. A new collection is a code change.

## Run it

```
node src\cli.mjs serve
```

It asks for the password, decrypts the key and answers the bot on `\\.\pipe\house-signer`.
Before it asks, it refuses to start if:

- it is running from, or pointed at keys in, a OneDrive folder;
- `@noble/*` would load from anywhere but this folder's own `node_modules`, or at another
  version than the lockfile pins;
- a mutation test run was cut short (its backups are still in `test/.mutate-backup`);
- the git checkout has any change or untracked file, or HEAD is not `HOUSE_PIN_COMMIT`;
- the house address is not in the house registry at that commit, with every enabled
  collection listed;
- an RPC endpoint is not on Ethereum mainnet, the keystore does not hold `policy.house`, or
  the house address has code on chain.

`serve --dev` skips the git and registry checks, reports no pinned commit (so the bot's live
mode will not accept it), and sends transactions only to a local test chain
(`http://127.0.0.1:8545`); it is for trying things against an Anvil fork.

`node src\cli.mjs status` prints the house's nonce, Seaport counter, WETH balance and
allowance without asking for the password. `node src\cli.mjs address` prints the address in
`keystore.json`.

## The kill

`node src\cli.mjs kill` (or the bot's `kill`, which asks the running signer) sends, in order:

1. revoke the conduit's WETH allowance (no fill can take WETH any more),
2. bump the Seaport counter (every order the house ever signed is dead at once),
3. revoke NFT approval for every enabled collection.

The first one takes the house's lowest pending nonce, so if a house transaction is stuck it
is replaced; the kill pays the full fee cap and the kill tip so a node accepts the
replacement. If more transactions are pending than that, extra revokes replace each of them.
If one kill transaction loses the race to a transaction already in flight, it is sent again.
Every one is re-sent each block until mined or three minutes pass. The kill works with STOP
present. The standalone command asks for the password, sends, waits, prints every hash and
exits 0 when all are mined.

To stop new bids without spending gas, create `STOP` in the keys folder.

## How the bot talks to it

Newline-delimited JSON on the pipe, one request per line, answered by `id`
(BUILD-SPEC section 2.3): `hello`, `signBid`, `signCancel`, `sendTx`, `kill`, `status`.
A refusal is `{ ok: false, id, field, reason }`, where `field` is the id of the check that
refused (the pins below) or a plain word (`rpc`, `id`, `op`, `internal`, `counter`,
`broadcast`, `simulation`). Additions to the spec's shapes, all extra fields: `hello.mode`
(`live`/`dev`); `signBid.parameters.counter` (OpenSea's offer schema requires it inside
`parameters`); `sendTx` and kill entries carry `nonce`, `success` once mined, and
`replaced: true` when another transaction took the nonce; `kill` answers
`{ ok, id, txs: [{ kind, slug?, nonce, txHash, status, ... }], allMined }`.

Every collection bid is `PARTIAL_RESTRICTED` (order type 3) for any quantity, because that is
what OpenSea's own SDK signs (`restrictedByZone: true, allowPartialFills: true`).

## The pins

Every check in `src/` ends its line with `// PIN:<id>`. `node test/mutate.mjs` deletes each
one in turn, runs the tests, and requires a test named after that pin to fail; then it puts
the file back and proves it is byte-identical (sha256). The groups:

| Ids | Checks |
|---|---|
| `F.*` | `policy.json` (shape, known contracts and fee recipients, gas limits, listing off) |
| `P0`, `P3`, `P7`-`P9`, `P12`, `P15` | the bot's bid request: shape, collection, quantity, price and tick, times, the build's zone and NFT line, STOP |
| `P1`-`P14` (order) | the finished order before hashing: domain, offerer, zone, order type, conduit, WETH offer, price, NFT line, fee lines, times, salt, counter, line count |
| `P2.code`, `P15.sign`, `P16.*`, `L.order`, `A.request` | in the service: no signing while the house has code, STOP re-checked right before signing, low-s and recover-to-house, the order must be recorded, the audit line must be written |
| `C.*` | gasless cancel: only for orders this signer signed |
| `T.*` | transactions: kinds, amounts, targets, selectors, value, fees, gas, spender, funding wallet, own orders only, STOP |
| `D.*` | dev mode sends only to a local chain |
| `K.*` | keystore cipher, MAC, key, address field; password only from a terminal |
| `B.*` | start-up: OneDrive, `@noble` location and version, mutation leftovers, git tree, pinned commit, registry |
| `S.line` | the pipe refuses request lines over 64 KiB |

## Tests

```
npm test                 # node --test, about 5 s
npm run mutate           # every pin removed in turn: 165 suite runs, 15 to 25 minutes
```

`test/fixtures/viem-fixture.json` holds viem's answers for the same hashes, signatures,
calldata and transactions (made once by `scripts/make-viem-fixture.mjs` with the frontend's
viem); the signer's own code must match them byte for byte. The keystore is checked against
the Web3 Secret Storage v3 wiki vectors.

`HOUSE_SIGNER_LIVE_RPC=<mainnet RPC URL> node --test test/live.test.mjs` runs a read-only
check against mainnet: the real signBid path for a test key, then Seaport 1.6's own
`getOrderHash` must equal the signer's order hash and `validate([order])` (by `eth_call`, which
changes nothing) must accept its signature and reject a tampered one. Test keys are always
`keccak256("house-bidder test key <n>")`, never a well-known key.
