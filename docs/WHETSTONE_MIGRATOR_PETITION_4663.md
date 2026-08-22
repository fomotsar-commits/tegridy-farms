# Whetstone petition — Robinhood Chain (4663) rider

**Status: DRAFT for the operator to send. Nothing here has been sent to Whetstone.**

This is a RIDER to [WHETSTONE_MIGRATOR_PETITION.md](./WHETSTONE_MIGRATOR_PETITION.md) — the
mainnet petition remains the primary document, its §15 pre-send checklist governs both, and
the two should travel in ONE conversation: same module family, same asking party, same
receiving Safe. Do not send this alone, and do not send either without re-running every
on-chain read the day of (§0 rule of the main petition: a stale `owner()` invalidates the
document).

## The ask

One additional `setModuleState` Safe transaction, on one additional chain:

| | Robinhood Chain (4663) |
|---|---|
| Airlock | `0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862` (verified source on robinhoodchain.blockscout.com) |
| Airlock owner | `0x21E2ce70511e4FE542a97708e89520471DAa7A66` — **the same 3-of-6 Safe as mainnet and Base** (owner set byte-identical; verified 2026-08-22 via `getOwners()`/`getThreshold()` on both chains) |
| Call | `setModuleState([<TegridyLiquidityMigrator on 4663>], [4])` — `4` = `ModuleState.LiquidityMigrator` |
| Module address | filled in after `contracts/script/robinhood/DeployRobinhoodGraduationStack.s.sol` broadcasts and the contract verifies on Blockscout — never petition with an address that does not yet carry verified code |

The module is the SAME `TegridyLiquidityMigrator` source the mainnet petition describes —
verbatim, same commit, deployed per-chain because its constructor binds per-chain
immutables (Airlock, PoolManager, PositionManager, Permit2, our hook, our Safe). Every
behavioral claim, invariant count, and security argument in the main petition applies
unchanged; this rider only adds the chain-specific facts.

## Chain-specific facts Whetstone will check (all verified 2026-08-22)

- The canonical Uniswap V4 stack the module mints into is live on 4663 and is the SAME
  PoolManager Doppler's own `UniswapV4Initializer` uses: `0x8366a39CC670B4001A1121B8F6A443A643e40951`.
  PositionManager `0x58daec3116aae6D93017bAAea7749052E8a04fA7` cross-binds to it
  (`poolManager()` read).
- 4663 currently has NO V4-shaped migrator at all (`v4Migrator: ZERO_ADDRESS` in
  Whetstone's own SDK) — launches wanting a canonical-V4 graduation on this chain today
  have no option. This module fills a gap rather than displacing a Whetstone product.
- `migrate()` never re-validates module state (Airlock source, verified on Blockscout), so
  granting the whitelist creates no obligation Whetstone cannot instantly withdraw for
  FUTURE launches via `setModuleState → 0` — a mechanism this Safe('s deployer) has already
  exercised twice on 4663 (the Rehype add-then-remove, 2026-07-23) and once on Base. The
  main petition's §9.5 withdraw-on-request undertaking extends to this chain.

## Honesty notes for the sender

- **Precedent, stated plainly: no third-party module has ever been whitelisted on any
  Airlock we can read** (mainnet, Base, 4663 — every state-4 migrator is Whetstone-authored,
  including both `@author Whetstone Research` Rehype modules). This petition asks for a
  first. If Whetstone prefers to review/bless/co-own the module rather than whitelist an
  external one — the shape their `src/extensions/CustomUniswapV3Migrator` suggests — that
  outcome satisfies the directive too, and the sender should say so explicitly.
- Until the whitelist lands, 4663 launches use stock modules and the frontend must keep
  saying so (the venue probe reads `getModuleState` live and treats anything else as
  "unknown", never "whitelisted").
- Prerequisites on OUR side before sending, in order: 4663 Safes ceremony (M.1) →
  `DeployRobinhoodMVP` + Verify green (M.2) → `DeployRobinhoodGraduationStack` broadcast +
  Blockscout verification → the hook admin's 48h initializer allowance for the migrator
  proposed (it can run in parallel with the petition; both must be live before any launch
  selects the module).
