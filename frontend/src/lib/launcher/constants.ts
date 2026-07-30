// Afterlife address book — launcher-local, load-bearing addresses for the
// post-graduation reward wiring (afterlife.ts). Deliberately kept OUT of the
// app-global src/lib/constants.ts; see AFTERLIFE_GAUGE_CONTROLLER_ADDRESS.

import type { Address } from 'viem';

/**
 * GaugeController — Ethereum mainnet.
 *
 * PROVENANCE: read from the local Foundry broadcast
 * contracts/broadcast/DeployGaugeController.s.sol/1/run-latest.json — the CREATE
 * tx (0x7608…d912) deployed `GaugeController` at this address (constructor args:
 * staking 0xcaDc…046D + emission cap 1e24), confirmed against the DeployMVP-era
 * TegridyStaking address in src/lib/constants.ts.
 *
 * WHY THIS IS NOT WIRED INTO THE APP-GLOBAL `GAUGE_CONTROLLER_ADDRESS`: that
 * global is consumed by user-facing gauge features (useGaugeList, GaugeVoting,
 * the CommunityPage "gauges" section) that gate PURELY on
 * `isDeployed(GAUGE_CONTROLLER_ADDRESS)` — there is no separate enable flag.
 * Setting the global to a non-zero address would instantly activate on-chain
 * gauge reads AND the gauge-VOTING UI. But the controller's ownership is still on
 * 0xA360…b7F8 (the flagged Safe — see the broadcast's transferOwnership tx), NOT
 * a re-homed Safe, so lighting up the market gauge app now would be premature.
 * This afterlife-local constant lets the Afterlife eligibility logic report the
 * true deployed address WITHOUT flipping that global gate. Promote it into the
 * app-global only AFTER ownership is re-homed and the gauge app is deliberately
 * turned on.
 */
export const AFTERLIFE_GAUGE_CONTROLLER_ADDRESS =
  '0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054' as Address;

/**
 * Canonical Uniswap V4 PositionManager — Ethereum mainnet. The escrowed-NFT issuer a
 * graduated Doppler pool's LP lives under, so a per-pool boosted-LP staker is built
 * against it (afterlife.ts buildBoostedStakerDeployParams / eligibility).
 *
 * VERIFIED on-chain 2026-07-26: 23,877 bytes of code and `poolManager()` returns the
 * canonical V4 PoolManager `0x0000…08A90` — the same posm the deployed Doppler
 * v4Migrator (0x0820…) reports from its own `positionManager()` getter. Wiring this
 * flips Afterlife boosted-LP farming from 'pending-deployment' to 'eligible' for a
 * graduated launch. HONEST SCOPE: 'eligible' means the V4 infra is configured — a
 * per-pool `TegridyBoostedLPStaker` is still deployed per-launch by a re-homed-Safe
 * owner (buildBoostedStakerDeployParams requires a non-zero owner; there is no
 * fabricated default). This is app-global infra, not launcher-specific, but kept in
 * the launcher-local book alongside the gauge address for the same reason.
 */
export const AFTERLIFE_V4_POSITION_MANAGER_ADDRESS =
  '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e' as Address;

/**
 * `TegridyLiquidityMigrator` — the module that graduates a launch into a
 * canonical Uniswap V4 pool carrying `TegridyV4Hook`, i.e. a venue we own.
 *
 * ZERO until deployed, and that zero is load-bearing: while it is zero the SDK
 * resolves Doppler's own `uniswapV4Migrator` (0x0820…205f5) and launches graduate
 * into a hookless canonical pool exactly as they do today. Nothing silently
 * changes, and no Fact Sheet claim becomes false.
 *
 * ## Do NOT set this the moment the contract is deployed
 *
 * Two more things must be true first, or every graduation REVERTS:
 *
 *   1. **Whetstone must whitelist it** — `Airlock.setModuleState(migrator, 4)`.
 *      `Airlock.create` rejects a non-whitelisted module, so launches would fail
 *      at CREATE time. See docs/WHETSTONE_MIGRATOR_PETITION.md.
 *   2. **The hook must grant it a standing initializer allowance** — a 48h
 *      timelocked admin action. Without it graduation reverts at
 *      `poolManager.initialize`, and because `Airlock.migrate` is permissionless
 *      and transfers the graduated balances in BEFORE calling the migrator, that
 *      revert STRANDS them rather than merely failing.
 *
 * Set it only after both are confirmed on-chain. `isDeployed()` is the gate every
 * consumer must use — see `airlock.ts`.
 */
export const TEGRIDY_V4_MIGRATOR_ADDRESS =
  '0x0000000000000000000000000000000000000000' as Address;
