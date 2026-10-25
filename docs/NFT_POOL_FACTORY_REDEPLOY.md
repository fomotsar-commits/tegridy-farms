# NFT pool factory redeploy: the buyer pays the royalty

> The to-do list is [`TODO_OPERATOR.md`](TODO_OPERATOR.md). This page is the runbook for one item
> on it: shipping the NFT pool royalty fix to mainnet. Written 2026-10-18.

## What is wrong

The NFT pool factory on mainnet, `0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B`, makes every pool
from one template, `0x98553C2a3593c388415f866dCBa4348532ff481A`. That template is the July 16
build. When someone buys an NFT from a pool, it pays the collection's royalty out of **the pool's
own ETH**, not the buyer's. A collection whose royalty goes to someone hostile can then buy and
sell the same NFT over and over and drain the pool: on a mainnet fork, a 20 ETH pool lost 2.4 ETH
in 10 round trips.

The fix (commit `d9d5b4757`, 2026-08-08: the buyer pays the royalty on top of the price) is in the
source, not on chain. The template address is fixed inside the factory forever, so the only way to
ship the fix is a new factory, which makes its own new template.

**Nothing has been lost.** The factory has 0 pools (read 2026-10-18, block 26,220,328). But it is
not paused, and the site's NFT AMM tab lets anyone make a pool on it today.

## How money moves

On a buy from a pool:

| | Old template (live today) | New template |
|---|---|---|
| The buyer pays | the curve price + the venue fee | the curve price + the venue fee + the royalty |
| The pool owner gets | the curve price **minus the royalty** | the curve price |
| The venue gets | 0.5% of the price (50 bps) | 0.25% of the price (25 bps) |
| The collection gets | its ERC-2981 royalty, capped at 25% | the same, paid by the buyer |

On a sale into a pool, both templates take the royalty and the venue fee out of the seller's
payout. The old template's sell quote leaves the royalty out, so it shows the seller more than
they get; the new one quotes the real payout, which is what the site's NFT AMM tab already
assumes.

The pool owner earns the buy-sell spread plus any pool fee they set. The venue's cut sits in each
pool until anyone calls the factory's `claimPoolFees`; then the factory's owner withdraws it to the
treasury Safe `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`. The new factory takes 0.25% a swap,
half the live factory's 0.5% (your call of 2026-10-18), so traders pay less and the venue earns
half as much per swap. It also charges 0.006 ETH to open a pool, sent to the treasury in the same
transaction (your call of 2026-10-25; the live factory charges nothing to open); the opener's
deposit stays theirs (runbook: `POOL_OPENING_FEE_EVM.md`). It pays the same treasury and uses the
same WETH: the fork rehearsal reads those off the live factory and checks they match, and checks
the fee is 25 bps and the opening fee 0.006 ETH.

## Two calls for you

1. **Who owns the new factory.** The script sets the owner once, in the constructor, with no
   handover. The default here is the live factory's owner, the Safe
   `0xA36053477568Fb5382492F3A5970D35Fe896b7F8`, so nothing about who can steer it changes.
   `SAFE_REHOME_RUNBOOK.md` wants every contract off that Safe in the end. If you have built the new
   Admin Safe, put its address in `MULTISIG` instead, and this factory will never need moving.
2. **Pause the old factory now** (recommended). It stops new pools on the vulnerable template
   straight away. With 0 pools, it costs nothing. `unpause()` undoes it.

## Steps

Run these from `contracts/` in a checkout of `mvp-launch` that includes this runbook's PR, with
`ETH_RPC_URL` set to a mainnet RPC you trust (`https://eth.drpc.org` works for reads).

**Step 1. Pause the old factory (your Safe, 2 of 3).** In the Safe app for `0xA360…b7F8`: New
transaction, Transaction Builder, address `0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B`, method
`pause()`, value 0. Then check it:

```bash
cast call 0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B "paused()(bool)" --rpc-url "$ETH_RPC_URL"
```

You should see `true`.

**Step 2. Dry run, no key.** Nothing is sent.

```bash
MULTISIG=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 TREASURY=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 PROTOCOL_FEE_BPS=25 forge script script/DeployNFTPoolFactory.s.sol:DeployNFTPoolFactoryScript --rpc-url "$ETH_RPC_URL" --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E
```

You should see `Script ran successfully`, `Protocol fee (bps): 25` and about 7.6 million gas
(0.0009 ETH at the 0.12 gwei of 2026-10-18). If you chose another owner in call 1, change
`MULTISIG` here and in step 3.

**Step 3. Deploy (your key).** One transaction. The factory's constructor makes the template.

```bash
MULTISIG=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 TREASURY=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 PROTOCOL_FEE_BPS=25 forge script script/DeployNFTPoolFactory.s.sol:DeployNFTPoolFactoryScript --rpc-url "$ETH_RPC_URL" --account deployer --broadcast
```

Use `--ledger` instead of `--account deployer` if the key is on a Ledger. Add
`--verify --etherscan-api-key <key>` if you have a live Etherscan key. Write down the two
addresses it prints: `TegridyNFTPoolFactory deployed` and `Pool template`.

**Step 4. Rehearse the real deployment on a fork.** Same checkout, so the template's code matches
this tree byte for byte.

```bash
NEW_FACTORY=<factory address from step 3> forge test --match-path "test/fork/NFTPoolRoyaltyForkRehearsal.t.sol" -vv
```

You should see `3 passed`, and `pool ETH lost over the round trips: 2.4…` for the old factory.
If `test_newFactory_at25Bps_toTheSameTreasury_andTheBuyerPays` fails, stop: do not point the site at it.

**Step 5. Hand the factory address to a session.** It opens the site switch PR (below). Merging it
is a production deploy, so it waits for your word.

## The site switch (the follow-up PR)

After step 4 passes, one PR points the site at the new factory:

- `frontend/src/lib/constants.ts`: `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` to the new factory, with the
  new template in the comment. The NFT AMM tab, its reads and its pool scans all key off this one
  constant. Its ABI already reads `getBuyQuote` as royalty-inclusive, which is what the new
  template returns.
- `frontend/scripts/addresses.json`: new `nft-pool-factory` and `nft-pool-template` rows with the
  deploy receipt as evidence. The old two rows stay, marked retired and paused.
- `docs/CONTRACTS.md` (lines 122 and 178), `docs/MIGRATION_HISTORY.md` (line 113, old row
  superseded), `docs/SAFE_REHOME_RUNBOOK.md` (line 116) and `scripts/verify-ownership.mjs`
  (line 105): the new address.
- `frontend/src/lib/docsAddressTruth.test.ts`: add the old factory and template to `SUPERSEDED`, so
  no doc can present them as current again.
- `contracts/broadcast/DeployNFTPoolFactory.s.sol/1/`: commit the new `run-*.json`.
- `CHANGELOG.md`: one line.

## What was checked on 2026-10-18

- **The live template is the pre-fix build.** Its code has no `getBuyQuoteWithRoyalty` or
  `getSellQuoteWithRoyalty`; it does have `getBuyQuote`, `swapETHForNFTs` and `swapNFTsForETH`
  (the scan is not blind). The live factory reads: owner `0xA360…b7F8`, fee 50 bps, fee recipient
  `0x7D26…Bd7d`, WETH `0xC02a…6Cc2`, 0 pools, not paused.
- **Fork rehearsal** (`contracts/test/fork/NFTPoolRoyaltyForkRehearsal.t.sol`, 3/3 passed): on the
  live factory a 20 ETH pool loses 2.4 ETH in 10 round trips; on a factory from this script (live
  owner, treasury and WETH, 25 bps) it loses nothing. Control runs with `NEW_FACTORY` set to the
  live factory: the new-factory check fails, first on "new template lacks the fix", and since the
  fee change on "protocol fee is not 25 bps".
- **CI test** (`contracts/test/TegridyNFTPoolFactory_Deploy.t.sol`, 4/4): the script defaults to
  25 bps, its factory has the right terms and costs the pool nothing; the script refuses a
  non-mainnet chain and an owner with no code. With the pre-fix pool source put back, the
  round-trip test fails with a 2.45 ETH loss, so it tells the two builds apart. With the default
  still at 50, the 25 bps test failed.
- **Dry run** of step 2 against mainnet: succeeded with `Protocol fee (bps): 25`, about 7.6 million
  gas. Pool template 13,450 bytes and factory 12,443 bytes, both under the 24,576-byte limit.
