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
| The venue gets | | 0.5% of each trade made on the site, through the new pools' own SwapFeeRouter, paid out the same way as today's |
| The liquidity providers get | their whole deposit goes in the pool; the fee is never part of it | 5/6 of the 0.3% pool fee (0.25% of the trade) |

The pool contract is the same `TegridyPair` as today, so the trading fee and the treasury's share
work exactly as on today's TOWELI/ETH pool. Adding to a pool that is already open costs nothing
extra.

**NFT pools** (the NFT pool factory redeploy, #875): the opener pays 0.006 ETH on top of their own
deposit, and it goes to the treasury straight away. The deposit is still the opener's (at least
0.05 ETH, or at least one NFT) and can be withdrawn; the 0.006 ETH cannot. The 0.25% venue fee per
swap from #875 is unchanged.

**How the new pools are swapped (your word 2026-10-27: "do whats best").** The site's swap runs
through the SwapFeeRouter `0x6d5791A660e79175F74C6D639584C98422d5956E`, which takes the venue's
0.5% (50 bps, read 2026-10-25) and is bound for good to the OLD router, so it cannot reach a pool on
the new factory. The same script therefore deploys a second SwapFeeRouter: the same contract with
the same 0.5%, treasury, RevenueDistributor and ReferralSplitter, bound to the new router. On the
site, the swap prices our pool on both factories (each net of its own 0.5%), takes the better one,
and signs through that pool's SwapFeeRouter; Uniswap still wins whenever it pays more. The pool
list shows both factories' pools. Nothing about today's pool changes.

Referrers: the referral splitter `0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c` pays a referrer 20%
of the venue fee, and only through a SwapFeeRouter it has approved. Until its owner (the deployer
key `0x1489…456E`) approves the new one (step 5), that 20% stays with the venue instead; nothing is
lost either way.

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

## One call for you

**Who holds the new contracts' roles.** `FEE_TO_SETTER` changes where the factory's fees go
   (behind a 48-hour lock) and becomes the owner of the new SwapFeeRouter and its admin contract;
   `GUARDIAN` can switch off a pair instantly in an emergency. The live factory and SwapFeeRouter
   have the hot deployer key `0x1489…456E` there (`SAFE_REHOME_RUNBOOK.md`). The script refuses any
   address with no code, so these start on Safes. The commands below use the Safe
   `0xA36053477568Fb5382492F3A5970D35Fe896b7F8` for both, the owner of the NFT pool factory. If you
   have built the new Admin and Guardian Safes, use those instead.

## Steps

Run these from `contracts/` in a checkout of `mvp-launch` that includes this runbook's PR, with
`ETH_RPC_URL` set to a mainnet RPC you trust.

**Step 1. Dry run, no key.** Nothing is sent.

```bash
FEE_TO_SETTER=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 GUARDIAN=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 TREASURY=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 REVENUE_DISTRIBUTOR=0xF993316E2fC079de4358c489A935E01e03E23E17 REFERRAL_SPLITTER=0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c PAUSE_GUARDIAN=0xCDCA0F0621ce34012AD61bBD140f327EB778F354 forge script script/DeployPoolOpeningFeeAMM.s.sol:DeployPoolOpeningFeeAMMScript --rpc-url "$ETH_RPC_URL" --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E
```

You should see `Script ran successfully`, `Opening fee (wei): 6000000000000000` and
`Swap fee (bps): 50`. The distributor, splitter and pause guardian are the live SwapFeeRouter's
own (read 2026-10-27).

**Step 2. Deploy (your key).** Eight transactions: the factory, the router, the SwapFeeRouter, its
admin contract, wiring the admin, setting the pause guardian, and offering each of the last two to
the Safe.

```bash
FEE_TO_SETTER=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 GUARDIAN=0xA36053477568Fb5382492F3A5970D35Fe896b7F8 TREASURY=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 REVENUE_DISTRIBUTOR=0xF993316E2fC079de4358c489A935E01e03E23E17 REFERRAL_SPLITTER=0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c PAUSE_GUARDIAN=0xCDCA0F0621ce34012AD61bBD140f327EB778F354 forge script script/DeployPoolOpeningFeeAMM.s.sol:DeployPoolOpeningFeeAMMScript --rpc-url "$ETH_RPC_URL" --account deployer --broadcast
```

Use `--ledger` instead of `--account deployer` if the key is on a Ledger. Write down the four
addresses it prints.

**Step 3. The Safe accepts ownership (2 of 3).** In the Safe app for `0xA360…b7F8`, one batch:
`acceptOwnership()` on the new SwapFeeRouter, and `acceptOwnership()` on its admin contract,
within 14 days of step 2.

**Step 4. Check them, then rehearse on a fork** (put in the addresses):

```bash
cast call <factory> "POOL_OPENING_FEE()(uint256)" --rpc-url "$ETH_RPC_URL"
cast call <router> "factory()(address)" --rpc-url "$ETH_RPC_URL"
cast call <swapFeeRouter> "router()(address)" --rpc-url "$ETH_RPC_URL"
cast call <swapFeeRouter> "owner()(address)" --rpc-url "$ETH_RPC_URL"
NEW_FACTORY=<factory> NEW_ROUTER=<router> NEW_SWAP_FEE_ROUTER=<swapFeeRouter> forge test --match-path "test/fork/PoolOpeningFeeForkRehearsal.t.sol" -vv
```

You should see `6000000000000000`, the factory's address, the router's address, the Safe, and
`3 passed`.

**Step 5 (optional). Let referrers earn on the new pools.** The referral splitter's owner (the
deployer key) approves the new SwapFeeRouter as a caller, through the splitter's timelock. Until
then the referrer share goes to the venue.

**Step 6. Hand the four addresses to a session.** It opens the site PR (below). Merging it is a
production deploy, so it waits for your word.

**NFT pools** ride the NFT pool factory redeploy in [`NFT_POOL_FACTORY_REDEPLOY.md`](NFT_POOL_FACTORY_REDEPLOY.md):
same steps, same script. That script now also refuses a factory without the 0.006 ETH fee.

## The site PR (the follow-up)

- `frontend/src/lib/constants.ts`: `TEGRIDY_OPENING_FACTORY_ADDRESS`,
  `TEGRIDY_OPENING_ROUTER_ADDRESS` and `TEGRIDY_OPENING_SWAP_FEE_ROUTER_ADDRESS` to the new
  addresses. While any is zero the site behaves exactly as today. Once all three are set: the
  liquidity tab opens new pools on the new factory, shows "Opening this pool costs 0.006 ETH", and
  asks the wallet for the deposit plus 0.006 ETH (read from the factory); the pool list shows both
  factories' pools; the swap prices both and signs through the matching SwapFeeRouter. Pairs
  already on the old factory keep using the old router and the live SwapFeeRouter.
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
  router is bound to it, its SwapFeeRouter is bound to that router at 50 bps with the admin wired
  and both offered to the Safe, a swap on a new pool through it keeps exactly 0.5% of the input,
  and it refuses a non-mainnet chain, roles held by a plain key and any swap fee but the live 50.
- 2026-10-27, mainnet fork (`test/fork/PoolOpeningFeeForkRehearsal.t.sol`, 3/3): with the live
  distributor, referral splitter and pause guardian wired in, opening TOWELI/ETH pays the treasury
  Safe 0.006 ETH, and a 0.1 ETH swap on that pool through the new SwapFeeRouter keeps 0.0005 ETH.
