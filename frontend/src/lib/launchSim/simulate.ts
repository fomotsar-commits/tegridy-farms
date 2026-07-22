// Launch Simulator — PURE what-if logic (detection-as-design-tool).
//
// A dev previews their token's distribution BAND and its Fact-Sheet TIER from a
// PROPOSED allocation, BEFORE launching, so concentration can be fixed while it
// is still just numbers in a form. Nothing here touches the network or reads a
// clock except an optional injectable `now` for deterministic tests.
//
// It reuses the two shipped engines rather than reimplementing either:
//   - the detection core (`analyzeDistribution`) over the proposed holder set →
//     the descriptive distribution BAND + every component/exclusion; and
//   - the launcher gate (`buildFactSheet`) over the proposed structural config →
//     the same machine-checked Fact-Sheet TIER buyers will see.
//
// The one piece unique to a design tool is `computeBandTargets`: for each better
// band than the current one it enumerates exactly what is blocking it — the hard
// gate findings (each with a plain-language fix) and the ranked soft levers with
// per-signal guideline thresholds — so "why am I not well-distributed yet" has a
// concrete, honest answer instead of a mystery score.
//
// HONEST FRAMING: this is a projection of a hypothetical the DEV supplies, not a
// measurement of a real token. Every number is derived from their own inputs; a
// missing input self-gates to unknown, never to a flattering default. Callers
// MUST treat `hasData === false` as "nothing to show yet".

import {
  analyzeDistribution,
  resolveConfig,
  DEFAULT_CONFIG,
  BAND_RANK,
  type Band,
  type DistributionAnalysis,
  type HardFacts,
  type HolderCategory,
  type RawHolder,
  type ScoringConfig,
  type SoftSignal,
} from '../detection';
import { buildFactSheet, defaultGateConfig, type RawTokenFacts } from '../launcher/gate';
import type { LaunchFactSheet } from '../launcher/factSheet';
import { DEFAULT_FEE_CONSTITUTION } from '../launcher/config';
import { DOPPLER_MAINNET } from '../launcher/doppler.constants';

const DAY = 86_400;
// 365/12 days per month, matching LaunchPage: a 12-month lock is exactly 365
// days so it meets the flagship LP-lock floor rather than silently falling 5
// days short of it.
const MONTH = (365 / 12) * DAY;

/** Category the dev can pin on an allocation row. `auto` lets the core classify. */
export type CategoryChoice = HolderCategory | 'auto';

/** The selectable categories, in the order the editor lists them. */
export const CATEGORY_CHOICES: { value: CategoryChoice; label: string; excluded: boolean }[] = [
  { value: 'auto', label: 'Wallet (auto-classify)', excluded: false },
  { value: 'eoa', label: 'Wallet — real holder', excluded: false },
  { value: 'lp', label: 'Liquidity pool / AMM', excluded: true },
  { value: 'locker', label: 'Lock / vesting / treasury', excluded: true },
  { value: 'cex', label: 'Centralized exchange', excluded: true },
  { value: 'bridge', label: 'Bridge', excluded: true },
  { value: 'burn', label: 'Burn / dead address', excluded: true },
  { value: 'contract', label: 'Other contract', excluded: true },
];

/** One proposed allocation the dev enters. `amount` is whole tokens (a string,
 *  like the launch wizard) — decimals cancel in every share ratio, so no scaling
 *  is needed and precision never overflows. */
export interface AllocRow {
  /** Stable id for React keys + synthetic-address derivation. */
  id: string;
  /** Free-text note ("Team", "LP", "Public buyer 3"). Display only. */
  label: string;
  /** Whole-token amount as typed. Non-numeric / blank ⇒ 0 ⇒ dropped. */
  amount: string;
  category: CategoryChoice;
  /** Optional coordinated-cluster tag; rows sharing a tag form one cluster. */
  clusterId?: string;
  bundled?: boolean;
  sniper?: boolean;
}

/** Structural config that drives BOTH the detection hard-fact gate and the
 *  reused Fact-Sheet gate from ONE source of truth. */
export interface StructuralInput {
  /** Deployed from an audited, non-upgradeable template (Doppler). When true the
   *  dangerous powers are false BY CONSTRUCTION and their toggles are moot. */
  knownSafeTemplate: boolean;
  canMint: boolean;
  canPause: boolean;
  canBlacklist: boolean;
  feeOnTransfer: boolean;
  upgradeable: boolean;
  lpLocked: boolean;
  lpLockMonths: number;
  /** Admin renounced or held by a timelock (a flagship structural bar). */
  adminRenouncedOrTimelock: boolean;
  /** Insider / team float, basis points of supply (Fact-Sheet gate input). */
  teamAllocationBps: number;
  /** How much of that team float is under an on-chain vesting schedule. */
  teamAllocationVestedBps: number;
}

export interface SimInput {
  rows: readonly AllocRow[];
  structural: StructuralInput;
  chain?: 'ethereum' | 'solana';
  /** True once the dev opts into modelling launch bundles (enables the flag +
   *  makes "0% bundled" a measured fact rather than an un-modelled gap). */
  bundlesModeled: boolean;
  snipersModeled: boolean;
  /** Deterministic clock for tests. Defaults to now. */
  now?: number;
  config?: Partial<ScoringConfig>;
}

/** Default structural config: a clean, fixed-supply, LP-locked, fair launch —
 *  the shape a Doppler flagship launch actually has. The dev edits from here. */
export const DEFAULT_STRUCTURAL: StructuralInput = {
  knownSafeTemplate: true,
  canMint: false,
  canPause: false,
  canBlacklist: false,
  feeOnTransfer: false,
  upgradeable: false,
  lpLocked: true,
  lpLockMonths: 12,
  adminRenouncedOrTimelock: true,
  teamAllocationBps: 0,
  teamAllocationVestedBps: 0,
};

/** Effective residual powers: an audited template forces the dangerous ones
 *  false; otherwise the dev's toggles stand. `balanceLimit` is never modelled. */
export function effectivePowers(s: StructuralInput): RawTokenFacts['powers'] {
  if (s.knownSafeTemplate) {
    return { mint: false, pause: false, blacklist: false, feeOnTransfer: false, upgrade: false, balanceLimit: false };
  }
  return {
    mint: s.canMint,
    pause: s.canPause,
    blacklist: s.canBlacklist,
    feeOnTransfer: s.feeOnTransfer,
    upgrade: s.upgradeable,
    balanceLimit: false,
  };
}

/** Parse a whole-token amount string to base units (bigint). Blank/garbage ⇒ 0. */
export function parseAmount(raw: string): bigint {
  const digits = (raw ?? '').replace(/[^\d]/g, '');
  if (!digits) return 0n;
  try {
    return BigInt(digits);
  } catch {
    return 0n;
  }
}

/** Deterministic synthetic address for a row index, so distinct rows never merge
 *  in `normalizeHolders` (which keys by address). Never the zero/burn address. */
function syntheticAddress(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

/**
 * Turn the proposed allocation rows into the detection core's `RawHolder[]`.
 * Zero-amount rows are dropped. Behavioural flags only take effect when the dev
 * has opted into modelling them, so an un-modelled bundle is never silently 0%.
 */
export function buildHolders(input: SimInput): RawHolder[] {
  const holders: RawHolder[] = [];
  input.rows.forEach((row, i) => {
    const balance = parseAmount(row.amount);
    if (balance <= 0n) return;
    const label = row.category === 'auto' ? null : (row.category as HolderCategory);
    const clusterId = row.clusterId && row.clusterId.trim() !== '' ? row.clusterId.trim() : null;
    holders.push({
      address: syntheticAddress(i),
      balance,
      label,
      clusterId,
      bundled: input.bundlesModeled ? !!row.bundled : false,
      sniper: input.snipersModeled ? !!row.sniper : false,
    });
  });
  return holders;
}

/** Map the structural config to the detection core's hard-fact gate inputs. The
 *  dev is DECLARING the config, so a decided "no" is a known-false (renounced),
 *  which correctly never fires the gate. */
export function toHardFacts(s: StructuralInput): HardFacts {
  const powers = effectivePowers(s);
  return {
    mintAuthorityLive: powers.mint,
    freezeAuthorityLive: powers.pause,
    lpUnlocked: !s.lpLocked,
  };
}

/** Build `RawTokenFacts` for the reused Fact-Sheet gate from the same config. */
export function toRawTokenFacts(input: SimInput, totalSupply: bigint, now: number): RawTokenFacts {
  const s = input.structural;
  const powers = effectivePowers(s);
  const knownSafe = s.knownSafeTemplate;
  return {
    token: '0x0000000000000000000000000000000000000000',
    chainId: DOPPLER_MAINNET.chainId,
    name: 'Simulated token',
    symbol: 'SIM',
    totalSupply,
    tokenFactory: knownSafe ? DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address : null,
    templateCodehash: null,
    powers,
    owner: '0x0000000000000000000000000000000000000000',
    ownerRenounced: s.adminRenouncedOrTimelock,
    ownerIsTimelock: false,
    liquidity: s.lpLocked
      ? { locked: true, locker: DOPPLER_MAINNET.support.streamableFeesLocker, unlockAt: Math.round(now + s.lpLockMonths * MONTH) }
      : { locked: false, locker: null, unlockAt: null },
    feeConstitution: [...DEFAULT_FEE_CONSTITUTION],
    vesting: [],
    teamAllocationBps: Math.max(0, Math.round(s.teamAllocationBps)),
    teamAllocationVestedBps: Math.max(0, Math.round(s.teamAllocationVestedBps)),
    observedAt: now,
  };
}

// ── Band targets: the "delta to pass each band" solver ──────────────────────

/** A hard gate finding blocking a target band, with a plain-language fix. */
export interface GateBlocker {
  id: string;
  detail: string;
  forcedBand: Band;
  fix: string;
}

/** A soft-signal "lever" the dev can move, ranked by how much it contributes to
 *  the blended risk that is keeping the token out of a target band. */
export interface SoftLever {
  id: string;
  label: string;
  /** Current metric value (e.g. top-1 share, effective holders). */
  value: number;
  /** Current 0..1 risk from this signal. */
  risk: number;
  /** Share of the blended risk this signal accounts for (0..1). */
  contribution: number;
  /** True when moving THIS signal alone could reach the target cutoff. */
  sufficientAlone: boolean;
  /** The metric value that (alone) would reach the cutoff, when sufficientAlone;
   *  otherwise null and the dev should also address the other levers. */
  singleLeverTarget: number | null;
  /** Ramp endpoints: value at 0 risk and value at full risk (a stable guide). */
  guidelineGood: number;
  guidelineBad: number;
  /** 'lower' ⇒ smaller is better (top-1, clustered…); 'higher' ⇒ bigger is
   *  better (effective holders, Nakamoto). */
  direction: 'lower' | 'higher';
}

/** Everything blocking one target band. */
export interface BandTarget {
  band: Band;
  /** The current band is already at least this good. */
  met: boolean;
  /** Fired hard facts forcing a worse floor than this band. */
  gateBlockers: GateBlocker[];
  /** Blended soft risk vs this band's cutoff. */
  softRisk: number;
  softCutoff: number;
  softMet: boolean;
  /** How far the soft risk overshoots the cutoff (0 when met). */
  softGap: number;
  /** Ranked levers — only populated when soft risk exceeds the cutoff. */
  levers: SoftLever[];
}

const GATE_FIX: Record<string, string> = {
  'mint-authority-live': 'Launch from a fixed-supply template or renounce the mint authority — no post-launch minting.',
  'freeze-authority-live': 'Remove the pause/freeze authority so holdings can never be frozen.',
  'lp-unlocked': 'Lock the liquidity for a defined term instead of leaving it withdrawable.',
  'top1-cluster-over-threshold': 'Split the largest coordinated cluster across independent holders so it falls below the majority threshold.',
  'single-holder-majority': 'Reduce the largest single wallet below the majority threshold before launch.',
};

const LEVER_META: Record<string, { label: string; direction: 'lower' | 'higher' }> = {
  effectiveHolders: { label: 'Effective holder count (inverse-Simpson)', direction: 'higher' },
  top1: { label: 'Largest holder share (top 1)', direction: 'lower' },
  top10: { label: 'Top-10 combined share', direction: 'lower' },
  nakamoto: { label: 'Nakamoto coefficient', direction: 'higher' },
  gini: { label: 'Gini (secondary — address ≠ person)', direction: 'lower' },
  clustered: { label: 'Largest coordinated cluster share', direction: 'lower' },
  bundledHeld: { label: 'Bundle-acquired supply still held', direction: 'lower' },
  sniper: { label: 'Sniper-held supply', direction: 'lower' },
};

/** Invert a linear risk ramp: given a target risk, the metric value producing it.
 *  Works in both directions (for "higher is better", `good > bad`). */
function invRamp(targetRisk: number, good: number, bad: number): number {
  const r = Math.max(0, Math.min(1, targetRisk));
  return good + r * (bad - good);
}

function softCutoffFor(band: Band, cfg: ScoringConfig): number {
  return band === 'well-distributed' ? cfg.bands.wellMax : cfg.bands.mixedMax;
}

/**
 * For each band strictly better than "concentrated", enumerate exactly what is
 * blocking it: the hard gate findings (with fixes) and, when the soft blend is
 * over the cutoff, the ranked soft levers. Pure over an already-computed
 * analysis so the UI and tests share one source of truth.
 */
export function computeBandTargets(
  analysis: DistributionAnalysis,
  cfg: ScoringConfig = DEFAULT_CONFIG,
): BandTarget[] {
  const targets: Band[] = ['well-distributed', 'mixed'];
  return targets.map((band) => {
    const gateBlockers: GateBlocker[] = analysis.gate.findings
      .filter((f) => f.fired && BAND_RANK[f.forcedBand] > BAND_RANK[band])
      .map((f) => ({ id: f.id, detail: f.detail, forcedBand: f.forcedBand, fix: GATE_FIX[f.id] ?? 'Adjust the configuration flagged above.' }));

    const softRisk = analysis.soft.risk;
    const softCutoff = softCutoffFor(band, cfg);
    const softMet = softRisk <= softCutoff;
    const softGap = Math.max(0, softRisk - softCutoff);

    const levers = softMet ? [] : rankLevers(analysis, softGap, cfg);

    return {
      band,
      met: BAND_RANK[analysis.band] <= BAND_RANK[band],
      gateBlockers,
      softRisk,
      softCutoff,
      softMet,
      softGap,
      levers,
    };
  });
}

/** Rank the available soft signals by their contribution to the blended risk and
 *  attach per-signal targets/guidelines. Mirrors `blendSoftSignals`' weighting
 *  (weights renormalized over signals that were actually measured). */
function rankLevers(analysis: DistributionAnalysis, softGap: number, cfg: ScoringConfig): SoftLever[] {
  const signals = analysis.soft.signals.filter((s): s is SoftSignal & { risk: number; value: number } => s.risk != null);
  const weightTotal = signals.reduce((sum, s) => sum + s.weight, 0);
  if (weightTotal <= 0) return [];

  const rampFor = (id: string): [number, number] => (cfg.ramps as Record<string, [number, number]>)[id] ?? [0, 1];

  return signals
    .map((s) => {
      const meta = LEVER_META[s.id] ?? { label: s.id, direction: 'lower' as const };
      const weightShare = s.weight / weightTotal;
      const contribution = weightShare * s.risk;
      // Max risk this lever can remove is its whole contribution (risk → 0).
      const sufficientAlone = contribution >= softGap - 1e-9;
      const [good, bad] = rampFor(s.id);
      let singleLeverTarget: number | null = null;
      if (sufficientAlone && weightShare > 0) {
        const targetRisk = Math.max(0, s.risk - softGap / weightShare);
        singleLeverTarget = invRamp(targetRisk, good, bad);
      }
      return {
        id: s.id,
        label: meta.label,
        value: s.value,
        risk: s.risk,
        contribution,
        sufficientAlone,
        singleLeverTarget,
        guidelineGood: good,
        guidelineBad: bad,
        direction: meta.direction,
      } satisfies SoftLever;
    })
    .filter((l) => l.risk > 0.001) // a signal already at ~0 risk is not a lever
    .sort((a, b) => b.contribution - a.contribution);
}

// ── Top-level simulate ──────────────────────────────────────────────────────

export interface SimResult {
  /** False when there is nothing to measure yet — the UI must self-gate to its
   *  instructional empty state and show NO band. */
  hasData: boolean;
  analysis: DistributionAnalysis;
  factSheet: LaunchFactSheet;
  bandTargets: BandTarget[];
  /** Total supply used (sum of all proposed row balances), stringified. */
  totalSupply: string;
}

/**
 * THE ENTRY POINT. Pure: builds holders + structural facts from the proposed
 * config, runs BOTH shipped engines, and computes the band targets. No network,
 * no mutation of the input.
 */
export function simulate(input: SimInput): SimResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  // The band-target math must use the SAME fully-resolved config the detection
  // core uses internally, so deep-resolve the partial rather than shallow-merge.
  const cfg = resolveConfig(input.config);
  const holders = buildHolders(input);
  const totalSupply = holders.reduce((sum, h) => sum + (h.balance > 0n ? h.balance : 0n), 0n);

  const analysis = analyzeDistribution({
    holders,
    chain: input.chain ?? 'ethereum',
    totalSupply,
    hardFacts: toHardFacts(input.structural),
    launch: {
      // Pre-launch design projection: freshness is not the point, so age is left
      // unknown (it never fires a penalty). Bundle/sniper are only "resolved"
      // once the dev opts into modelling them.
      tokenAgeSeconds: null,
      bundledTotalSupplyShare: null,
      bundlesResolved: input.bundlesModeled,
      snipersResolved: input.snipersModeled,
    },
    config: input.config,
    observedAt: now,
  });

  const factSheet = buildFactSheet(toRawTokenFacts(input, totalSupply, now), defaultGateConfig(now));
  const bandTargets = computeBandTargets(analysis, cfg);

  return {
    hasData: analysis.metrics.includedHolders > 0,
    analysis,
    factSheet,
    bandTargets,
    totalSupply: totalSupply.toString(),
  };
}
