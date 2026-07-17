// Launcher UI config + feature gate (docs/LAUNCHER_STRATEGY.md §6).
//
// The launcher un-gates ONLY after all three launch gates pass:
//   core-loop go-live  ->  Safe re-homing  ->  TOWELI liveness.
// Until then LAUNCHER_ENABLED stays false and the page renders the standard
// "SOON" placeholder — no transaction-firing UI against a launch we can't yet run.

import type { Address } from 'viem';
import type { FeeConstitutionLine } from './factSheet';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Master gate. Flip to true only when all §6 gates pass. */
export const LAUNCHER_ENABLED = false;

/**
 * Multisig that captures Doppler integrator fees (withIntegrator).
 * PLACEHOLDER until a re-homed Safe exists — must NOT be the flagged deployer
 * or the old 0xA360 Safe (see pending operator tasks). Zero keeps the gate shut.
 */
export const LAUNCHER_INTEGRATOR_ADDRESS: Address = ZERO;

/** The launcher is usable only when enabled AND a real integrator is configured. */
export function isLauncherEnabled(): boolean {
  return LAUNCHER_ENABLED && LAUNCHER_INTEGRATOR_ADDRESS !== ZERO;
}

/**
 * Draft fee constitution — bps of the 1% trade fee (sums to 10000).
 * "Constitutional" = fixed at launch and published in the Fact Sheet, never a
 * marketing dial. Confirm final numbers before go-live.
 */
export const DEFAULT_FEE_CONSTITUTION: readonly FeeConstitutionLine[] = [
  { recipient: 'Creator', role: 'creator', shareBps: 6000 },
  { recipient: 'Attention beneficiaries', role: 'attention-beneficiary', shareBps: 1500 },
  { recipient: 'Tegridy stakers + POL', role: 'protocol-stakers', shareBps: 2000 },
  { recipient: 'Doppler', role: 'doppler', shareBps: 500 },
] as const;

/** Launch tiers offered in the wizard (maps to gate.ts tiers). */
export const LAUNCH_TIERS = [
  {
    id: 'flagship' as const,
    label: 'Flagship',
    curve: 'Dynamic Dutch auction (Doppler V4)',
    blurb: 'Full price discovery. Structurally rug-impossible config required (renounced/timelock admin, 12-month LP lock, capped insider float). Eligible for the Launch Afterlife fast-track.',
  },
  {
    id: 'listable' as const,
    label: 'Community',
    curve: 'Static / multicurve (Doppler V4)',
    blurb: 'Simpler curve. Automated hygiene bar (audited template, no mint/tax/blacklist/upgrade, LP locked, vesting on-chain). Still gated, still Fact-Sheeted.',
  },
] as const;

export type LaunchTierId = (typeof LAUNCH_TIERS)[number]['id'];
