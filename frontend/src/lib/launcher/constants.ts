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
