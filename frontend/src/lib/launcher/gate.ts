// Automated two-tier launch gate — code, not opinion (docs/LAUNCHER_STRATEGY.md §2.3).
//
// The gate is a PURE function of collected on-chain facts. No human approval
// step (red-team dispositions I/K: hand-curation = issuer liability + a bus
// factor). It emits a deterministic tier and a full check-by-check audit trail.
//
// Tiers are STRUCTURAL, not quality judgements:
//   - listable (Tier-L): automated hygiene bar — audited template, no
//     mint/tax/blacklist/upgrade power, LP locked >= a short floor, team
//     allocation on-chain-vested.
//   - flagship (Tier-F): a structurally rug-impossible config — Tier-L PLUS
//     admin renounced or timelock-only, LP locked >= 12 months, no pause power,
//     and a hard cap on insider float.
// A token that meets neither is 'none' — NOT "unsafe"; its disclosures are still
// published so buyers can judge for themselves.

import type { Address, Hex } from 'viem';
import type {
  FeeConstitutionLine,
  GateCheck,
  LaunchFactSheet,
  LaunchTier,
  LiquidityDisclosure,
  ResidualPower,
  VestingSchedule,
} from './factSheet';
import { KNOWN_SAFE_TOKEN_FACTORIES } from './doppler.constants';

/** Raw facts the on-chain collector gathers about a launch. Gate input. */
export interface RawTokenFacts {
  token: Address;
  chainId: number;
  name: string;
  symbol: string;
  totalSupply: bigint;
  tokenFactory: Address | null;
  templateCodehash: Hex | null;
  powers: {
    mint: boolean;
    pause: boolean;
    blacklist: boolean;
    feeOnTransfer: boolean;
    upgrade: boolean;
    balanceLimit: boolean;
  };
  owner: Address | null;
  ownerRenounced: boolean;
  ownerIsTimelock: boolean;
  liquidity: { locked: boolean; locker: Address | null; unlockAt: number | null };
  feeConstitution: FeeConstitutionLine[];
  vesting: VestingSchedule[];
  teamAllocationBps: number;
  teamAllocationVestedBps: number;
  observedAt: number;
}

export interface GateConfig {
  /** Tier-L minimum LP lock remaining (seconds). Default 30 days. */
  listableLpLockMinSeconds: number;
  /** Tier-F minimum LP lock remaining (seconds). Default 365 days. */
  flagshipLpLockMinSeconds: number;
  /** Tier-F maximum insider/team allocation (bps of supply). Default 2000 (20%). */
  flagshipMaxTeamBps: number;
  /** Evaluation clock (unix seconds). Injectable for deterministic tests. */
  now: number;
}

const DAY = 86_400;

export function defaultGateConfig(now: number): GateConfig {
  return {
    listableLpLockMinSeconds: 30 * DAY,
    flagshipLpLockMinSeconds: 365 * DAY,
    flagshipMaxTeamBps: 2000,
    now,
  };
}

function lpLockRemaining(liq: RawTokenFacts['liquidity'], now: number): number {
  if (!liq.locked || liq.unlockAt == null) return 0;
  return Math.max(0, liq.unlockAt - now);
}

/**
 * Run the gate. Pure: (facts, config) -> ordered checks + tier.
 * Order of checks is stable so the audit trail and any UI render deterministically.
 */
export function runGate(raw: RawTokenFacts, cfg: GateConfig): { tier: LaunchTier; checks: GateCheck[] } {
  const checks: GateCheck[] = [];
  const knownSafe = raw.tokenFactory != null && KNOWN_SAFE_TOKEN_FACTORIES.has(raw.tokenFactory.toLowerCase());
  const lpRemaining = lpLockRemaining(raw.liquidity, cfg.now);
  const teamFullyVested = raw.teamAllocationBps === 0 || raw.teamAllocationVestedBps >= raw.teamAllocationBps;

  // ── Tier-L (listable) ──
  checks.push({
    id: 'template-known-safe',
    requiredFor: 'listable',
    passed: knownSafe,
    detail: knownSafe
      ? `Token deployed by a known-safe factory (${raw.tokenFactory}).`
      : 'Token was not deployed by a recognised non-upgradeable template factory.',
  });
  checks.push({
    id: 'no-mint',
    requiredFor: 'listable',
    passed: !raw.powers.mint,
    detail: raw.powers.mint ? 'Contract exposes a post-launch mint power.' : 'No post-launch mint power.',
  });
  checks.push({
    id: 'no-transfer-tax',
    requiredFor: 'listable',
    passed: !raw.powers.feeOnTransfer,
    detail: raw.powers.feeOnTransfer ? 'Contract applies a fee/tax on transfer.' : 'No fee-on-transfer.',
  });
  checks.push({
    id: 'no-blacklist',
    requiredFor: 'listable',
    passed: !raw.powers.blacklist,
    detail: raw.powers.blacklist ? 'Contract can blacklist/freeze addresses.' : 'No blacklist power.',
  });
  checks.push({
    id: 'no-upgrade',
    requiredFor: 'listable',
    passed: !raw.powers.upgrade,
    detail: raw.powers.upgrade ? 'Contract logic is upgradeable.' : 'Contract logic is not upgradeable.',
  });
  checks.push({
    id: 'lp-lock-floor',
    requiredFor: 'listable',
    passed: lpRemaining >= cfg.listableLpLockMinSeconds,
    detail: raw.liquidity.locked
      ? `LP lock has ${Math.floor(lpRemaining / DAY)}d remaining (floor ${Math.floor(cfg.listableLpLockMinSeconds / DAY)}d).`
      : 'Liquidity is not locked.',
  });
  checks.push({
    id: 'team-allocation-vested',
    requiredFor: 'listable',
    passed: teamFullyVested,
    detail:
      raw.teamAllocationBps === 0
        ? 'No team/insider allocation.'
        : `Team allocation ${raw.teamAllocationBps} bps; on-chain-vested ${raw.teamAllocationVestedBps} bps.`,
  });

  // ── Tier-F (flagship) — additional structural bars ──
  const adminNeutralised = raw.ownerRenounced || raw.ownerIsTimelock;
  checks.push({
    id: 'admin-renounced-or-timelock',
    requiredFor: 'flagship',
    passed: adminNeutralised,
    detail: raw.ownerRenounced
      ? 'Ownership renounced.'
      : raw.ownerIsTimelock
        ? 'Owner is a timelock contract.'
        : `Owner is an externally-controlled account (${raw.owner ?? 'unknown'}).`,
  });
  checks.push({
    id: 'lp-lock-12mo',
    requiredFor: 'flagship',
    passed: lpRemaining >= cfg.flagshipLpLockMinSeconds,
    detail: `LP lock ${Math.floor(lpRemaining / DAY)}d remaining (flagship floor ${Math.floor(cfg.flagshipLpLockMinSeconds / DAY)}d).`,
  });
  checks.push({
    id: 'no-pause',
    requiredFor: 'flagship',
    passed: !raw.powers.pause,
    detail: raw.powers.pause ? 'Contract can pause transfers.' : 'No pause power.',
  });
  checks.push({
    id: 'insider-float-cap',
    requiredFor: 'flagship',
    passed: raw.teamAllocationBps <= cfg.flagshipMaxTeamBps,
    detail: `Team allocation ${raw.teamAllocationBps} bps (flagship cap ${cfg.flagshipMaxTeamBps} bps).`,
  });

  const listablePass = checks.filter((c) => c.requiredFor === 'listable').every((c) => c.passed);
  const flagshipPass = listablePass && checks.filter((c) => c.requiredFor === 'flagship').every((c) => c.passed);

  const tier: LaunchTier = flagshipPass ? 'flagship' : listablePass ? 'listable' : 'none';
  return { tier, checks };
}

/** Map raw powers to buyer-facing residual-power disclosures (always factual). */
function toResidualPowers(raw: RawTokenFacts): ResidualPower[] {
  const p = raw.powers;
  return [
    { power: 'mint', present: p.mint, holder: raw.owner, disclosure: p.mint ? 'The owner can mint new tokens after launch, diluting holders.' : 'Supply is fixed; no post-launch minting is possible.' },
    { power: 'pause', present: p.pause, holder: raw.owner, disclosure: p.pause ? 'Transfers can be paused by the owner, which can prevent selling.' : 'Transfers cannot be paused.' },
    { power: 'blacklist', present: p.blacklist, holder: raw.owner, disclosure: p.blacklist ? 'Specific addresses can be blocked from transferring.' : 'No address can be blacklisted.' },
    { power: 'fee-on-transfer', present: p.feeOnTransfer, holder: raw.owner, disclosure: p.feeOnTransfer ? 'A fee is taken on transfers, reducing amounts received.' : 'No fee is taken on transfers.' },
    { power: 'upgrade', present: p.upgrade, holder: raw.owner, disclosure: p.upgrade ? 'Contract logic can be upgraded, changing token behaviour later.' : 'Contract logic is immutable.' },
    { power: 'balance-limit', present: p.balanceLimit, holder: raw.owner, disclosure: p.balanceLimit ? 'A maximum wallet balance is enforced (common during price discovery).' : 'No maximum wallet balance is enforced.' },
    { power: 'owner-privileged', present: !raw.ownerRenounced && !raw.ownerIsTimelock && raw.owner != null, holder: raw.owner, disclosure: raw.ownerRenounced ? 'Ownership has been renounced.' : raw.ownerIsTimelock ? 'Owner privileges are held by a timelock contract.' : 'An externally-controlled account holds owner privileges.' },
  ];
}

function toLiquidityDisclosure(raw: RawTokenFacts, now: number): LiquidityDisclosure {
  const remaining = lpLockRemaining(raw.liquidity, now);
  return {
    locked: raw.liquidity.locked,
    locker: raw.liquidity.locker,
    unlockAt: raw.liquidity.unlockAt,
    note: raw.liquidity.locked
      ? `Liquidity is locked${raw.liquidity.unlockAt ? ` until ${new Date(raw.liquidity.unlockAt * 1000).toISOString().slice(0, 10)} (${Math.floor(remaining / DAY)}d remaining)` : ''}.`
      : 'Liquidity is not locked; it may be withdrawable by the liquidity owner.',
  };
}

/** Assemble the full Fact Sheet from raw facts (runs the gate). */
export function buildFactSheet(raw: RawTokenFacts, cfg: GateConfig = defaultGateConfig(raw.observedAt)): LaunchFactSheet {
  const { tier, checks } = runGate(raw, cfg);
  const knownSafe = raw.tokenFactory != null && KNOWN_SAFE_TOKEN_FACTORIES.has(raw.tokenFactory.toLowerCase());
  return {
    schemaVersion: 1,
    token: raw.token,
    chainId: raw.chainId,
    name: raw.name,
    symbol: raw.symbol,
    totalSupply: raw.totalSupply,
    tokenFactory: raw.tokenFactory,
    templateCodehash: raw.templateCodehash,
    knownSafeTemplate: knownSafe,
    residualPowers: toResidualPowers(raw),
    liquidity: toLiquidityDisclosure(raw, cfg.now),
    feeConstitution: raw.feeConstitution,
    vesting: raw.vesting,
    teamAllocationBps: raw.teamAllocationBps,
    teamAllocationVestedBps: raw.teamAllocationVestedBps,
    tier,
    gateChecks: checks,
    observedAt: raw.observedAt,
  };
}
