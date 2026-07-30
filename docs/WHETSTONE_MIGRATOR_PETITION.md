# Whetstone module-whitelist petition — `TegridyLiquidityMigrator`

**Status: DRAFT for the operator to send. Nothing here has been sent to Whetstone.**
Claude does not contact third parties; review this, then send it yourself.

---

## What we are asking for

One call from the Airlock owner:

```solidity
// Airlock 0xde3599a2ec440b296373a983c85c365da55d9dfa
// owner   0x21E2ce70511e4FE542a97708e89520471DAa7A66  (Whetstone multisig)
setModuleState([<TegridyLiquidityMigrator address>], [ModuleState.LiquidityMigrator]) // state 4
```

Until that lands, `Airlock.create` reverts for any launch that names our migrator, so
this gate blocks the entire feature. **It is the long pole — start it before the audit
finishes, not after.**

## Who we are

Tegridy Farms — an existing Doppler integrator on Ethereum mainnet. We already launch
through the canonical Airlock using the stock whitelisted modules
(`DopplerERC20V1Factory` / `UniswapV4Initializer` / `UniswapV4Migrator`), with
`withIntegrator` pointed at our own fee address. This petition does not change how we
launch; it changes only where a launch's liquidity graduates **to**.

## What the module does

`TegridyLiquidityMigrator` implements `ILiquidityMigrator` (your MIT interface) and
graduates a completed auction into a **canonical Uniswap V4 pool that carries our own
hook**, `TegridyV4Hook`, instead of a hookless pool.

- `initialize(asset, numeraire, data)` — decodes a tick spacing, builds the `PoolKey`
  with `hooks = TegridyV4Hook` and `fee = LPFeeLibrary.DYNAMIC_FEE_FLAG`, stores it, and
  returns `address(0)` (a V4 pool has no address of its own — same convention your
  `UniswapV4Migrator` uses, so `DERC20.lockPool` is a no-op on this path).
- `migrate(sqrtPriceX96, token0, token1, recipient)` — initializes the pool at the
  supplied price, and mints **one full-range position** from the balances the Airlock
  transferred in.

Both entrypoints are `onlyAirlock`.

## The part you will want to check first

**The LP position is minted to the Airlock-supplied `recipient` — the launch's own
timelock. We do not keep it, and we cannot: `recipient` is passed to us by
`Airlock.migrate`, and it is the only address we mint to.**

Our economic interest is the hook's swap-fee skim on the graduated pool, which is an
ongoing claim on trade flow and nothing else. We are not asking for a module that
retains a launch's liquidity, redirects it, or introduces a withdrawal path. Any residue
left over after the mint is refunded to `recipient` in the same call.

## Risk surface

| Concern | Answer |
| --- | --- |
| Can the module keep the launch's liquidity? | No. Single mint, `owner = recipient`; residue refunded to `recipient`. |
| Can it be called by anyone? | No. `initialize` and `migrate` are both `onlyAirlock`. |
| Upgradeable / owner-controlled? | No. No proxy, no owner, no setters. Every parameter is immutable at construction. |
| What if `migrate` reverts? | `Airlock.migrate` transfers balances in **before** calling us, so a revert would strand them. `sweepStuck(token)` is a permissionless recovery that can only ever send to an **immutable** `rescueRecipient` set at deploy — the caller chooses nothing. |
| Does the hook block trading? | It has a pause guardian (swaps halt, liquidity removal stays open) and a bounded dynamic fee with immutable floor/ceiling. Neither can seize or lock LP principal. |
| Fee ceiling | Enforced by immutables `minFeePips` / `maxFeePips` in the hook constructor; a compromised param admin cannot exceed them. |

## Licensing — we did not fork anything of yours

We read your `UniswapV4Migrator.sol` to understand the Airlock's call sequence, and then
wrote an independent implementation. We are aware Doppler core is **BUSL-1.1** with no
registered Additional Use Grant (`doppler-license-grants.whetstoneresearch.eth` was
unregistered when we checked on 2026-07-16 and again on 2026-07-28), so production
forking is barred until 2027-12-31.

The only Doppler files we depend on are the MIT-licensed ones — `ILiquidityMigrator`,
and conventions from `TickLibrary` / `BeneficiaryData`. Our migrator does **not** use
`StreamableFeesLocker`; fee routing goes to our own `RevenueDistributor`. If you read
anything in our implementation as a derivative of the BUSL sources, tell us and we will
change it.

## Audit status

The migrator and `TegridyV4Hook` are going into an external audit that was already
scheduled for our V4 work. **We are not asking to be whitelisted ahead of that report** —
we expect to send it to you as part of this request. This petition is being opened early
only because we assume your review has its own lead time.

## Contact / addresses

| Item | Value |
| --- | --- |
| Migrator address | _(fill in after deploy)_ |
| `TegridyV4Hook` address | _(fill in after deploy)_ |
| Deployer | `0x1489…456E` |
| Integrator address (existing launches) | `0xD355…1051` |
| Audit report | _(attach)_ |
| Contact | _(operator to supply)_ |

---

## Operator checklist before sending

- [ ] Deploy `TegridyV4Hook` (`DeployV4.s.sol`, HookMiner salt) and the migrator; fill in both addresses.
- [ ] Etherscan-verify both.
- [ ] Attach the audit report.
- [ ] Confirm `rescueRecipient` is the rebuilt multisig, **not** the deployer EOA.
- [ ] Grant the hook's standing initializer allowance (`proposeInitializerAllowed` → 48h → `executeInitializerAllowed`) — without it graduation reverts even once Whetstone whitelists us.
- [ ] Decide whether to disclose the fee-skim rate up front. Recommended: yes. It is readable on-chain anyway, and leading with it is a better posture than having them find it.
