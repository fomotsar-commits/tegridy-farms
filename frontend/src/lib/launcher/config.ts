// Launcher UI config + feature gate (docs/LAUNCHER_STRATEGY.md §6).
//
// The launcher un-gates ONLY after all three launch gates pass:
//   core-loop go-live  ->  Safe re-homing  ->  TOWELI liveness.
// Until then LAUNCHER_ENABLED stays false and the page renders the standard
// "SOON" placeholder — no transaction-firing UI against a launch we can't yet run.

import type { Address } from 'viem';
import type { FeeConstitutionLine } from './factSheet';
import { TOWELI_ADDRESS } from '../constants';

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
 * EXOTIC (non-ETH) numeraire launches — token/TOWELI pools instead of token/ETH.
 * GATED OFF and shipped dormant. The ERC20-numeraire dynamic-auction path is
 * source-verified (Doppler mines the token's CREATE2 address to sort against ANY
 * numeraire; TOWELI's low address `0x42…` takes native ETH's EXACT code path and
 * currency arrangement — numeraire = currency0 — so it is the one ERC20 that behaves
 * like ETH, unlike WETH `0xC0…` which sorts to the opposite side). Because a wrong
 * numeraire price mis-prices the whole auction curve, this only flips true AFTER a
 * mainnet-fork rehearsal of the full create → graduate → locker lifecycle. Reversible:
 * set false + redeploy to re-gate.
 */
export const EXOTIC_LAUNCHES_ENABLED = false;

/** Native ETH numeraire (address(0)) — always available, the default base pair. */
export const ETH_NUMERAIRE: Address = ZERO;

/** TOWELI as an EVM launch numeraire (token/TOWELI pools). The ONLY exotic base pair
 *  on EVM — arbitrary ERC20 numeraires are deliberately not offered here. */
export const TOWELI_NUMERAIRE: Address = TOWELI_ADDRESS as Address;

/** The numeraires the EVM launcher may pair against. TOWELI is only usable when exotic
 *  launches are enabled; ETH is always allowed. */
export function allowedNumeraires(): readonly Address[] {
  return EXOTIC_LAUNCHES_ENABLED ? [ETH_NUMERAIRE, TOWELI_NUMERAIRE] : [ETH_NUMERAIRE];
}

/** True iff `numeraire` is a currently-permitted launch base pair (case-insensitive). */
export function isAllowedNumeraire(numeraire: Address): boolean {
  return allowedNumeraires().some((a) => a.toLowerCase() === numeraire.toLowerCase());
}

export function isExoticLaunchEnabled(): boolean {
  return isLauncherEnabled() && EXOTIC_LAUNCHES_ENABLED;
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
 *     streams it as REAL YIELD to veTOWELI stakers. NOT split to POL: RevenueDistributor
 *     is stakers-only (verified — it distributes ETH to veTOWELI holders); POL is a
 *     SEPARATE protocol fee stream (POLAccumulator/SwapFeeRouter), not funded by this 15%.
 *   - Creator + attention 80% — creator-directed. Creators keep the majority (what
 *     actually attracts launches) and can carve part to attention-holders/KOLs at
 *     launch (the Bags-style perpetual-split lever — the one proven cheap distribution
 *     mechanism). Default 70 creator / 10 attention; adjustable per launch.
 * Tune `Tegridy` between ~10-20% to trade sink-strength vs launcher-friendliness.
 */
export const DEFAULT_FEE_CONSTITUTION: readonly FeeConstitutionLine[] = [
  { recipient: 'Creator', role: 'creator', shareBps: 7000 },
  { recipient: 'Attention beneficiaries', role: 'attention-beneficiary', shareBps: 1000 },
  { recipient: 'Tegridy stakers', role: 'protocol-stakers', shareBps: 1500 },
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
