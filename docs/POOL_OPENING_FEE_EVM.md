# Opening a pool on Ethereum costs 0.006 ETH

> The to-do list is [`TODO_OPERATOR.md`](TODO_OPERATOR.md). This page is the runbook for one item
> on it: charging to open a pool on Ethereum. Written 2026-10-25.

## What this does

Your ruling of 2026-10-25: opening a pool costs **0.006 ETH on every EVM chain** (about $14 that
day; Solana charges 0.15 SOL, about $15). You chose a new factory and router for coin pools, and the
NFT pool factory charges the same.

The fee is enforced on chain. Whoever opens a pool pays exactly 0.006 ETH, and it goes straight to
the treasury Safe `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d` in the same transaction. There is
no way round it on the new contracts: a direct `createPair` call pays it, and so does a pool the
router opens inside `addLiquidity` or `addLiquidityETH`. The amount is fixed in the code. A
different amount means another new factory.

The shape is copied from Raydium cp-swap's `create_pool_fee`, the opening fee you already run on
Solana (`solana/tegridy-amm/programs/cp-swap/src/instructions/initialize.rs`): a fixed amount
moved from the person opening the pool to the fee receiver when the pool is made.

## How money moves

**Coin pools** (new factory + router):

| | When the pool is opened | On every trade afterwards |
|---|---|---|
| The opener pays | 0.006 ETH, on top of their deposit | nothing extra |
| The treasury gets | the 0.006 ETH, straight away | 1/6 of the 0.3% pool fee (0.05% of the trade), as LP tokens |
| The liquidity providers get | their whole deposit goes in the pool; the fee is never part of it | 5/6 of the 0.3% pool fee (0.25% of the trade) |

The pool contract is the same `TegridyPair` as today, so the trading fee and the treasury's share
work exactly as on today's TOWELI/ETH pool. Adding to a pool that is already open costs nothing
extra.

**NFT pools** (the NFT pool factory redeploy, #875): the opener pays 0.006 ETH on top of their own
deposit, and it goes to the treasury straight away. The deposit is still the opener's (at least
0.05 ETH, or at least one NFT) and can be withdrawn; the 0.006 ETH cannot. The 0.25% venue fee per
swap from #875 is unchanged.

🔴 **Swaps on the new coin pools: decide before the site points at them.** The site's swap runs
through the SwapFeeRouter `0x6d5791A660e79175F74C6D639584C98422d5956E`, which takes the venue's
0.5% (50 bps, read 2026-10-25) and is bound for good to the OLD router. So a pool opened on the new
factory cannot be swapped through the site's swap today, and a trade sent through the new router
directly skips that 0.5%. The site PR that fills in the new addresses must also do one of:
(a) swap new-factory pools through the new router directly (the venue then earns the 0.006 ETH and
the pool's 0.05% on those pools, not the extra 0.5%); or (b) deploy a new SwapFeeRouter bound to
the new router, so the 0.5% applies to them too. Until then, leave the site's addresses at zero.

## What does not change

- **The old factory stays free** for anyone who calls it directly. It cannot be changed.
- **Today's one coin pool stays where it is**, on the old factory, with its swaps, zaps and LP.
  The site keeps it on the old router.
- **The live launch curve stays free.** `TegridyCurveLauncher` `0xF4Dfa741aD63B3D95dC3Fc10D311caE507CE34dE`
  is bound to the old factory, so a curve that graduates there still opens its pool for free, like
  the free launch tier on Solana. Do not point a new curve launcher at the new factory: the
  launcher does not pay the fee, so its graduations would wait until someone opened the pair by
  hand (paying 0.006 ETH).
- **Base and Robinhood Chain** run the same free factory code. Charging there needs the same
  redeploy on each chain; the site already has a slot for each chain's new addresses.

## Two calls for you

1. **Who holds the new factory's two roles.** `FEE_TO_SETTER` changes where fees go (behind a
   48-hour lock); `GUARDIAN` can switch off a pair instantly in an emergency. The live factory has
   the hot deployer key `0x1489…456E` in both (`SAFE_REHOME_RUNBOOK.md`). The script refuses any
   address with no code, so this factory starts on Safes. The commands below use the Safe
   `0xA36053477568Fb5382492F3A5970D35Fe896b7F8` for both, the owner of the NFT pool factory. If you
   have built the new Admin and Guardian Safes, use those instead.
2. **The swap decision above**, before the site PR.

## Steps

Run these from `contracts/` in a checkout of `mvp-launch` that includes this runbook's PR, with
`ETH_RPC_URL` set to a mainnet RPC you trust.

**Step 1. Dry run, no key.** Nothing is sent.

```bash
FEE_TO_SETTER=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 GUARDIAN=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 TREASURY=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 forge script script/DeployPoolOpeningFeeAMM.s.sol:DeployPoolOpeningFeeAMMScript --rpc-url "$ETH_RPC_URL" --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E
```

You should see `Script ran successfully` and `Opening fee (wei): 6000000000000000`.

**Step 2. Deploy (your key).** Two transactions: the factory, then the router bound to it.

```bash
FEE_TO_SETTER=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 GUARDIAN=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 TREASURY=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 forge script script/DeployPoolOpeningFeeAMM.s.sol:DeployPoolOpeningFeeAMMScript --rpc-url "$ETH_RPC_URL" --account deployer --broadcast
```

Use `--ledger` instead of `--account deployer` if the key is on a Ledger. Write down the two
addresses it prints.

**Step 3. Check them** (put in the two addresses):

```bash
cast call <factory> "POOL_OPENING_FEE()(uint256)" --rpc-url "$ETH_RPC_URL"
cast call <factory> "feeTo()(address)" --rpc-url "$ETH_RPC_URL"
cast call <router> "factory()(address)" --rpc-url "$ETH_RPC_URL"
```

You should see `6000000000000000`, the treasury `0x7D26…Bd7d`, and the factory's address.

**Step 4. Hand both addresses to a session.** It opens the site PR (below). Merging it is a
production deploy, so it waits for your word.

**NFT pools** ride the NFT pool factory redeploy in [`NFT_POOL_FACTORY_REDEPLOY.md`](NFT_POOL_FACTORY_REDEPLOY.md):
same steps, same script. That script now also refuses a factory without the 0.006 ETH fee.

## The site PR (the follow-up)

- `frontend/src/lib/constants.ts`: `TEGRIDY_OPENING_FACTORY_ADDRESS` and
  `TEGRIDY_OPENING_ROUTER_ADDRESS` to the two new addresses. While they are zero the site behaves
  exactly as today. Once set, the liquidity tab opens new pools on the new factory, shows "Opening
  this pool costs 0.006 ETH", and asks the wallet for the deposit plus 0.006 ETH (it reads the fee
  from the factory). Pairs already on the old factory keep using the old router.
- The swap decision above, and listing the new factory's pools in the pool table
  (`hooks/useVenuePairs.ts` reads one factory).
- `frontend/scripts/addresses.json`, `docs/CONTRACTS.md`, `contracts/broadcast/…/1/` run file, and
  one `CHANGELOG.md` line.

## What was checked on 2026-10-25

- Live reads: old factory `feeTo` = the treasury Safe, 1 pair, `feeToSetter` and `guardian` = the
  deployer EOA; the live curve launcher's `FACTORY()` = the old factory; the NFT factory
  `0xbB8E…5B` is paused with 0 pools; the SwapFeeRouter's `router()` = the old router.
- The treasury Safe takes 0.006 ETH in about 6,700 gas (estimated against mainnet), well inside
  the 30,000 the fee transfer allows.
- `contracts/test/PoolOpeningFee.t.sol`: a direct open, a router open with tokens and with ETH, and
  an NFT pool open each pay exactly 0.006 ETH to the treasury; paying nothing, too little or too
  much reverts; adding to an existing pool pays nothing; the fee is never pooled liquidity or an
  NFT deposit. Each test fails against the free build it replaces (mutation check in the PR).
- `contracts/test/PoolOpeningFeeAMM_Deploy.t.sol`: the script's factory charges 0.006 ETH, its
  router is bound to it, and it refuses a non-mainnet chain and roles held by a plain key.
