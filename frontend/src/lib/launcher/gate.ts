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
  LaunchPricingDisclosure,
  LaunchTier,
  LiquidityDisclosure,
  ResidualPower,
  VestingSchedule,
} from './factSheet';
import { KNOWN_SAFE_TOKEN_FACTORIES } from './doppler.constants';

/** Raw facts the on-chain collector gathers about a launch. Gate input. */
export interface RawTokenFacts {
  /**
   * Method names whose on-chain read did NOT land (threw, or returned null/absent), so the
   * corresponding field below is a conservative FALLBACK rather than an observation.
   *
   * The gate itself ignores this by design — a fallback fails the gate, which is the safe
   * direction. It exists for surfaces that publish PROSE about a token, where the same
   * fallback reads as a positive finding: an unread `owner` degrades to null degrades to
   * "Ownership renounced.", which is inverted, not merely unknown. Optional so every existing
   * producer and consumer is unaffected.
   */
  unreadFields?: readonly string[];
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
  /** `readable: false` means the locker was never queried — see LiquidityDisclosure. */
  liquidity: { locked: boolean; locker: Address | null; unlockAt: number | null; readable?: boolean };
  feeConstitution: FeeConstitutionLine[];
  /**
   * How the venue's line of that constitution was priced. A LAUNCH-CONFIG input like
   * `feeConstitution` itself — the on-chain collector cannot read it back, because the
   * locker stores the resulting shares and not the dials that produced them. Omitted
   * means the standard rate with neither pricing feature in force.
   */
  pricing?: LaunchPricingDisclosure;
  vesting: VestingSchedule[];
  /**
   * FALSE when the per-beneficiary schedules were never enumerated (the on-chain
   * collector cannot), as opposed to enumerated and found to be none. Absent means
   * enumerated. See LaunchFactSheet.vestingReadable.
   */
  vestingReadable?: boolean;
  teamAllocationBps: number;
  teamAllocationVestedBps: number;
  observedAt: number;
}

/**
 * Which gate check ids rest on which collector read. When the read is named in
 * `RawTokenFacts.unreadFields`, the check below it is a FALLBACK, not a finding.
 *
 * This is the same knowledge `tokenDossier.unverifiedGateChecks` already applies to
 * the PAGE. It has to exist here too, because the page's copy suppresses a rendered
 * sentence while this one governs a permanent on-chain write — and only one of those
 * two is irreversible.
 */
const CHECKS_BY_UNREAD_METHOD: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // null owner -> `ownerRenounced: true` -> the flagship admin bar PASSES on a read
  // that never landed. A fabricated pass, not a conservative fail.
  owner: ['admin-renounced-or-timelock'],
  // 0 supply / unread vested total -> 0 bps -> both allocation checks PASS.
  totalSupply: ['team-allocation-vested', 'insider-float-cap'],
  vestedTotalAmount: ['team-allocation-vested', 'insider-float-cap'],
});

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
 * Fold a set of pass/fail flags into a tier. Split out of runGate so the same
 * function can be asked the counterfactual questions "what if every unread input
 * had passed?" and "what if every one had failed?" — which is how `tierDeterminate`
 * is established, rather than asserted.
 */
function tierFrom(checks: readonly GateCheck[], passedOf: (c: GateCheck) => boolean): LaunchTier {
  const listablePass = checks.filter((c) => c.requiredFor === 'listable').every(passedOf);
  const flagshipPass = listablePass && checks.filter((c) => c.requiredFor === 'flagship').every(passedOf);
  return flagshipPass ? 'flagship' : listablePass ? 'listable' : 'none';
}

/**
 * Run the gate. Pure: (facts, config) -> ordered checks + tier + whether that tier
 * was actually DECIDED.
 *
 * Order of checks is stable so the audit trail and any UI render deterministically.
 *
 * `tier` and every `passed` are unchanged from before this function grew a third
 * state — the conservative fallbacks still resolve exactly as they did, so no
 * existing caller's tiering moves. What is new is `tierDeterminate`: false when the
 * answer would have been different had an unread input landed the other way. The
 * gate is allowed to stay conservative; the ATTESTATION is not allowed to publish a
 * conservative fallback as a finding.
 */
export function runGate(
  raw: RawTokenFacts,
  cfg: GateConfig,
): { tier: LaunchTier; checks: GateCheck[]; tierDeterminate: boolean } {
  const checks: GateCheck[] = [];

  // Which checks rest on something nobody read. Two sources: named collector reads
  // that did not land, and a locker that was never queried at all.
  const indeterminate = new Set<string>();
  for (const method of raw.unreadFields ?? []) {
    for (const id of CHECKS_BY_UNREAD_METHOD[method] ?? []) indeterminate.add(id);
  }
  // `readable === false` means NOBODY QUERIED THE LOCKER (collector.ts's default
  // resolver reads nothing at all). `lpLockRemaining` then returns 0 and both LP
  // checks fail — a fabricated failure, and the one that collapses a FLAGSHIP launch
  // to tier 0 one screen after the wizard rendered it.
  if (raw.liquidity.readable === false) {
    indeterminate.add('lp-lock-floor');
    indeterminate.add('lp-lock-12mo');
  }

  const knownSafe = raw.tokenFactory != null && KNOWN_SAFE_TOKEN_FACTORIES.has(raw.tokenFactory.toLowerCase());
  const lpRemaining = lpLockRemaining(raw.liquidity, cfg.now);
  const teamFullyVested = raw.teamAllocationBps === 0 || raw.teamAllocationVestedBps >= raw.teamAllocationBps;

  // ── Tier-L (listable) ──
  checks.push({
    id: 'template-known-safe',
    requiredFor: 'listable',
    passed: knownSafe,
    detail: knownSafe
      ? `Token deployed by a recognised non-upgradeable template factory (${raw.tokenFactory}).`
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

  // Stamp the third state on the audit trail. Only ever `false`, never `true`: absent
  // means "this check is a reading", which keeps the digest of an all-read sheet
  // byte-identical to what it was before this field existed.
  for (const c of checks) if (indeterminate.has(c.id)) c.readable = false;

  const tier: LaunchTier = tierFrom(checks, (c) => c.passed);

  // IS THE TIER ESTABLISHED, or is it an artefact of what we failed to read?
  //
  // Resolve every indeterminate check both ways. If the tier is the same under both,
  // the unread inputs did not matter and the answer stands — a token that fails on a
  // power we PROVED is still honestly tier 'none'. If they differ, the tier is an
  // open question, and the only honest number to attest is no number at all.
  const best = tierFrom(checks, (c) => (indeterminate.has(c.id) ? true : c.passed));
  const worst = tierFrom(checks, (c) => (indeterminate.has(c.id) ? false : c.passed));

  return { tier, checks, tierDeterminate: best === worst };
}

/** Map raw powers to buyer-facing residual-power disclosures (always factual). */
function toResidualPowers(raw: RawTokenFacts): ResidualPower[] {
  const p = raw.powers;
  // `isBalanceLimitActive()` is the one power read directly off the token rather than
  // proven by template provenance, so it is the one that can degrade to a false
  // `present: false` on a 429. Unread => say so; do NOT publish "no maximum wallet
  // balance is enforced" about a call that never returned.
  const balanceLimitRead = !(raw.unreadFields ?? []).includes('isBalanceLimitActive');
  return [
    { power: 'mint', present: p.mint, holder: raw.owner, disclosure: p.mint ? 'The owner can mint new tokens after launch, diluting holders.' : 'Supply is fixed; no post-launch minting is possible.' },
    { power: 'pause', present: p.pause, holder: raw.owner, disclosure: p.pause ? 'Transfers can be paused by the owner, which can prevent selling.' : 'Transfers cannot be paused.' },
    { power: 'blacklist', present: p.blacklist, holder: raw.owner, disclosure: p.blacklist ? 'Specific addresses can be blocked from transferring.' : 'No address can be blacklisted.' },
    { power: 'fee-on-transfer', present: p.feeOnTransfer, holder: raw.owner, disclosure: p.feeOnTransfer ? 'A fee is taken on transfers, reducing amounts received.' : 'No fee is taken on transfers.' },
    { power: 'upgrade', present: p.upgrade, holder: raw.owner, disclosure: p.upgrade ? 'Contract logic can be upgraded, changing token behaviour later.' : 'Contract logic is immutable.' },
    {
      power: 'balance-limit',
      present: p.balanceLimit,
      holder: raw.owner,
      disclosure: !balanceLimitRead
        ? 'The maximum-wallet-balance setting could not be read, so this record makes no claim about it either way.'
        : p.balanceLimit
          ? 'A maximum wallet balance is enforced (common during price discovery).'
          : 'No maximum wallet balance is enforced.',
      // Only ever false — absent means read, so an all-read sheet digests unchanged.
      ...(balanceLimitRead ? {} : { readable: false as const }),
    },
    { power: 'owner-privileged', present: !raw.ownerRenounced && !raw.ownerIsTimelock && raw.owner != null, holder: raw.owner, disclosure: raw.ownerRenounced ? 'Ownership has been renounced.' : raw.ownerIsTimelock ? 'Owner privileges are held by a timelock contract.' : 'An externally-controlled account holds owner privileges.' },
  ];
}

function toLiquidityDisclosure(raw: RawTokenFacts, now: number): LiquidityDisclosure {
  const remaining = lpLockRemaining(raw.liquidity, now);
  // `readable === false` means NOBODY QUERIED THE LOCKER. Saying "not locked" there is a
  // claim, not a gap — and this sentence is folded into the on-chain disclosures digest,
  // so it is a claim we would be publishing permanently. Absent means read, so nothing
  // that already supplies a real lock state changes.
  const readable = raw.liquidity.readable !== false;
  return {
    locked: raw.liquidity.locked,
    locker: raw.liquidity.locker,
    unlockAt: raw.liquidity.unlockAt,
    readable,
    note: !readable
      ? 'The liquidity lock state could not be read on this rail, so this record makes no claim about it either way.'
      : raw.liquidity.locked
        ? `Liquidity is locked${raw.liquidity.unlockAt ? ` until ${new Date(raw.liquidity.unlockAt * 1000).toISOString().slice(0, 10)} (${Math.floor(remaining / DAY)}d remaining)` : ''}.`
        : 'Liquidity is not locked; it may be withdrawable by the liquidity owner.',
  };
}

/** Assemble the full Fact Sheet from raw facts (runs the gate). */
export function buildFactSheet(raw: RawTokenFacts, cfg: GateConfig = defaultGateConfig(raw.observedAt)): LaunchFactSheet {
  const { tier, checks, tierDeterminate } = runGate(raw, cfg);
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
    // Carried only when there is something to carry, for the same digest-stability reason
    // as the third states below: a standard-rate sheet hashes exactly as it did before.
    ...(raw.pricing ? { pricing: raw.pricing } : {}),
    vesting: raw.vesting,
    // Both third states are carried ONLY in the negative. Spreading nothing in the
    // determinate case is what keeps `disclosuresDigest` identical to its pre-fix
    // value for every sheet that was already honest — the fix moves the digest of
    // exactly the sheets that were lying, and of no others.
    ...(raw.vestingReadable === false ? { vestingReadable: false as const } : {}),
    teamAllocationBps: raw.teamAllocationBps,
    teamAllocationVestedBps: raw.teamAllocationVestedBps,
    tier,
    ...(tierDeterminate ? {} : { tierDeterminate: false as const }),
    gateChecks: checks,
    observedAt: raw.observedAt,
  };
}
