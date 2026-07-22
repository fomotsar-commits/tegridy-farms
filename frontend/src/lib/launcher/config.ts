// Launcher UI config + feature gate (docs/LAUNCHER_STRATEGY.md §6).
//
// The launcher un-gates ONLY after all three launch gates pass:
//   core-loop go-live  ->  Safe re-homing  ->  TOWELI liveness.
// Until then LAUNCHER_ENABLED stays false and the page renders the standard
// "SOON" placeholder — no transaction-firing UI against a launch we can't yet run.

import type { Address } from 'viem';
import type { FeeConstitutionLine } from './factSheet';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/**
 * Master gate. GO-LIVE 2026-07-22 (operator-authorized "do it all"): flipped true after
 * the §5 fork rehearsal passed in-session — real createDynamicAuction mined green
 * (status 1), token deployed as the whitelisted DopplerERC20V1 Solady clone (0xdb7b…),
 * 266 launcher tests green, integrator address verified on-chain. The §1 TOWELI-liveness
 * / pool-depth gates were explicitly WAIVED by the operator after the dormancy trade-off
 * was surfaced. Reversible: set back to false + redeploy to re-gate at any time.
 */
export const LAUNCHER_ENABLED = true;

/**
 * Address that captures Doppler integrator fees (withIntegrator) — ~80-95% of trade
 * fees, routed per DEFAULT_FEE_CONSTITUTION.
 * OPERATOR-CHOSEN 2026-07-22: a fresh single-key EOA (verified on-chain: valid EIP-55
 * checksum, no code, nonce 0). The runbook recommended a re-homed multisig Safe here;
 * the operator explicitly elected this hot wallet after that trade-off was surfaced.
 * If the key is ever compromised, re-point this and redeploy — fees only, no admin power.
 */
export const LAUNCHER_INTEGRATOR_ADDRESS: Address = '0xD355A072d6bBbA275DBD83A3149f6347b06d1051';

/** The launcher is usable only when enabled AND a real integrator is configured. */
export function isLauncherEnabled(): boolean {
  return LAUNCHER_ENABLED && LAUNCHER_INTEGRATOR_ADDRESS !== ZERO;
}

/**
 * Fee constitution — bps of the 1% total trade fee (fee tier 10000; sums to 10000).
 * "Constitutional" = fixed at launch and published in the Fact Sheet, never a
 * marketing dial.
 *
 * FINALIZED 2026-07-17 (research-backed):
 *   - Total 1% — the market's tolerated rate; fee CUTS don't buy share (BonkFun's
 *     0.3% lost to pump.fun's 1.25%), so we sit at the standard, not below.
 *   - Doppler 5% — the fixed protocol floor (>=5% to the Airlock owner, enforced in
 *     airlock.ts feeConstitutionToBeneficiaries).
 *   - Tegridy 15% — BELOW Clanker's observed 20% survivor ceiling on purpose: our
 *     draw is the day-2 Afterlife economy, not the cheapest fee, so we can be visibly
 *     more creator-friendly than the incumbent. Routes to RevenueDistributor, which
 *     sub-splits stakers (real yield) / POL internally.
 *   - Creator + attention 80% — creator-directed. Creators keep the majority (what
 *     actually attracts launches) and can carve part to attention-holders/KOLs at
 *     launch (the Bags-style perpetual-split lever — the one proven cheap distribution
 *     mechanism). Default 70 creator / 10 attention; adjustable per launch.
 * Tune `Tegridy` between ~10-20% to trade sink-strength vs launcher-friendliness.
 */
export const DEFAULT_FEE_CONSTITUTION: readonly FeeConstitutionLine[] = [
  { recipient: 'Creator', role: 'creator', shareBps: 7000 },
  { recipient: 'Attention beneficiaries', role: 'attention-beneficiary', shareBps: 1000 },
  { recipient: 'Tegridy stakers + POL', role: 'protocol-stakers', shareBps: 1500 },
  { recipient: 'Doppler', role: 'doppler', shareBps: 500 },
] as const;

/** Total trade-fee tier passed to Doppler withMarketCapRange (hundredths of a bip). 10000 = 1%. */
export const LAUNCH_FEE_TIER = 10_000;

/** Launch tiers offered in the wizard (maps to gate.ts tiers). */
export const LAUNCH_TIERS = [
  {
    id: 'flagship' as const,
    label: 'Flagship',
    curve: 'Dynamic Dutch auction (Doppler V4)',
    blurb: 'Full price discovery. Requires the strictest structural config — renounced or timelock admin, 12-month LP lock, capped insider float. Eligible for the Launch Afterlife fast-track.',
  },
  {
    id: 'listable' as const,
    label: 'Community',
    curve: 'Static / multicurve (Doppler V4)',
    blurb: 'Simpler curve. Automated hygiene bar (audited template, no mint/tax/blacklist/upgrade, LP locked, vesting on-chain). Still gated, still Fact-Sheeted.',
  },
] as const;

export type LaunchTierId = (typeof LAUNCH_TIERS)[number]['id'];
