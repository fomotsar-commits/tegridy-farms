// Launch Afterlife — wiring a GRADUATED Doppler launch into Tegridy's V4 stack
// (docs/LAUNCHER_STRATEGY.md §2.1).
//
// A Doppler launch that completes price discovery "graduates": its bonded
// liquidity migrates into a Uniswap V4 pool. The Afterlife is what Tegridy
// offers that pool AFTER graduation — the reward flywheel the protocol already
// runs for TOWELI, made available to launches that clear the structural bar:
//   1. boosted-LP farming — deposit the graduated pool's V4 PositionManager NFT
//      into a per-pool `TegridyBoostedLPStaker`, earning veTOWELI-boosted
//      emissions (Aerodrome/Curve gauge model; see TegridyBoostedLPStaker.sol).
//   2. gauge application — apply to the GaugeController for a share of protocol
//      emissions. The controller IS deployed and wired here (launcher-local
//      AFTERLIFE_GAUGE_CONTROLLER_ADDRESS, 0x6c79…1054), so a graduated launch
//      reports gauge application as 'eligible'. Its ownership still sits on the
//      flagged Safe pending re-home, so it is deliberately kept out of the
//      app-global gauge gate (see constants.ts). Boosted-LP (feature 1) stays
//      'pending-deployment' until the V4 PositionManager is wired (still zero).
//
// This module is PURE PARAM COMPUTATION ONLY. It builds typed, testable inputs —
// the V4 PoolId, the staker's five constructor args, the eligibility verdict.
// It fires NO transactions and deploys NOTHING. Availability is reported
// HONESTLY: a dependency at the zero address is 'pending-deployment', never
// fabricated as live (mirrors the rest of the launcher's gated posture).

import type { Address, Hex } from 'viem';
import { keccak256, encodeAbiParameters } from 'viem';
import type { LaunchTier } from './factSheet';
import { TOWELI_ADDRESS, TEGRIDY_STAKING_ADDRESS } from '../constants';
// GaugeController is sourced from the launcher-LOCAL address book, NOT the
// app-global `GAUGE_CONTROLLER_ADDRESS`. The global gates live gauge-voting UI on
// `isDeployed(...)` with no separate flag, and the controller's ownership is not
// yet re-homed — so afterlife reports the real address without lighting that up.
// See constants.ts (AFTERLIFE_GAUGE_CONTROLLER_ADDRESS) for the full rationale.
import { AFTERLIFE_GAUGE_CONTROLLER_ADDRESS, AFTERLIFE_V4_POSITION_MANAGER_ADDRESS } from './constants';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

function isZeroAddress(a: Address): boolean {
  return a.toLowerCase() === ZERO_ADDRESS;
}

// ─── V4 PoolKey / PoolId ─────────────────────────────────────────────────────

/**
 * The Uniswap V4 pool key. Field order is CANONICAL and load-bearing — it must
 * match `PoolKey` in v4-core (currency0, currency1, fee, tickSpacing, hooks),
 * because the PoolId is the keccak of exactly this tuple. Currencies must be
 * sorted numerically (currency0 < currency1); native ETH is the zero address.
 */
export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  /** uint24. Dynamic-fee pools use the 0x800000 flag. */
  fee: number;
  /** int24. May be negative. */
  tickSpacing: number;
  /** The pool's hook contract (zero address = no hook). */
  hooks: Address;
}

/**
 * Compute the V4 PoolId for a pool key: `keccak256(abi.encode(poolKey))`.
 *
 * v4-core's `PoolIdLibrary.toId` does `keccak256(poolKey, 0xa0)` — the raw hash
 * of the struct's five 32-byte memory slots. Because every field is a static
 * value type, `abi.encode(struct)` is byte-identical to that layout, so encoding
 * the tuple `(address, address, uint24, int24, address)` and hashing it yields
 * the same 32-byte PoolId the contract computes. This is the `allowedPoolId`
 * the `TegridyBoostedLPStaker` constructor takes and checks each deposit against.
 */
export function computeV4PoolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'currency0', type: 'address' },
        { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'hooks', type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

// ─── Boosted-LP staker deploy params ─────────────────────────────────────────

/**
 * Address book for Afterlife wiring. Defaults are read from `constants.ts`;
 * every field is overridable so the pure logic (and its gating) is deterministic
 * under test.
 *
 * `positionManager` defaults to the canonical Uniswap V4 PositionManager
 * (AFTERLIFE_V4_POSITION_MANAGER_ADDRESS in ./constants, verified on-chain), so a
 * graduated launch reports boosted-LP farming as 'eligible' — the V4 infra is wired.
 * That is NOT "farming is live": a per-pool TegridyBoostedLPStaker is still deployed
 * per-launch by a re-homed-Safe owner (buildBoostedStakerDeployParams requires a
 * non-zero owner — no fabricated default). `gaugeController` likewise defaults to the
 * real deployed mainnet address (AFTERLIFE_GAUGE_CONTROLLER_ADDRESS) — deliberately
 * kept out of the app-global gauge gate, which is not yet turned on (ownership not
 * re-homed).
 */
export interface AfterlifeAddressBook {
  /** Emissions reward token — TOWELI. */
  rewardToken: Address;
  /** veTOWELI boost source — TegridyStaking. */
  staking: Address;
  /** Uniswap V4 PositionManager (the escrowed NFT's issuer). */
  positionManager: Address;
  /** GaugeController — the real deployed mainnet controller (launcher-local). */
  gaugeController: Address;
}

export function defaultAfterlifeAddressBook(): AfterlifeAddressBook {
  return {
    rewardToken: TOWELI_ADDRESS,
    staking: TEGRIDY_STAKING_ADDRESS,
    positionManager: AFTERLIFE_V4_POSITION_MANAGER_ADDRESS,
    gaugeController: AFTERLIFE_GAUGE_CONTROLLER_ADDRESS,
  };
}

/**
 * Inputs to assemble a `TegridyBoostedLPStaker` deployment for a graduated pool.
 * `positionManager` and `owner` are REQUIRED (no safe default exists for either —
 * the PositionManager is not in constants, and the owner must be a re-homed Safe,
 * never a fabricated default). `rewardToken`/`staking` default to the address book.
 */
export interface BoostedStakerDeployOpts {
  /** Uniswap V4 PositionManager address. */
  positionManager: Address;
  /** Owner of the new staker — MUST be a re-homed Safe, not the flagged deployer. */
  owner: Address;
  /** Override reward token (default: address book / TOWELI). */
  rewardToken?: Address;
  /** Override staking/boost source (default: address book / TegridyStaking). */
  staking?: Address;
  /** Override the address-book source for the defaults above. */
  addresses?: AfterlifeAddressBook;
}

/**
 * The five `TegridyBoostedLPStaker` constructor arguments, in constructor order:
 *   (IERC20 rewardToken_, address staking_, address positionManager_,
 *    bytes32 allowedPoolId_, address owner_)
 */
export interface BoostedStakerDeployParams {
  rewardToken: Address;
  staking: Address;
  positionManager: Address;
  allowedPoolId: Hex;
  owner: Address;
  /** Positional tuple ready for ABI-encoding the deploy. */
  args: readonly [Address, Address, Address, Hex, Address];
}

/**
 * Build the constructor args for a per-pool boosted-LP staker over a GRADUATED
 * pool. Pure: no deploy, no tx. `allowedPoolId` is derived from `graduatedPoolKey`
 * so the staker only ever accepts the graduated pool's positions.
 *
 * Invariants are validated up front — mirroring the Solidity constructor's own
 * `ZeroAddress` / `WrongPool` reverts (and adding an owner-non-zero guard, since
 * a zero owner would strand admin) — so you can never assemble params that would
 * deploy a bricked or free-farmable staker.
 */
export function buildBoostedStakerDeployParams(
  graduatedPoolKey: V4PoolKey,
  opts: BoostedStakerDeployOpts,
): BoostedStakerDeployParams {
  const book = opts.addresses ?? defaultAfterlifeAddressBook();
  const rewardToken = opts.rewardToken ?? book.rewardToken;
  const staking = opts.staking ?? book.staking;
  const positionManager = opts.positionManager;
  const owner = opts.owner;

  if (isZeroAddress(rewardToken)) throw new Error('afterlife: rewardToken is the zero address');
  if (isZeroAddress(staking)) throw new Error('afterlife: staking is the zero address');
  if (isZeroAddress(positionManager)) {
    throw new Error('afterlife: positionManager is the zero address (V4 PositionManager not configured)');
  }
  if (isZeroAddress(owner)) {
    throw new Error('afterlife: owner is the zero address (must be a re-homed Safe)');
  }

  // V4 requires currency0 < currency1. An unsorted (or equal) key hashes to a
  // PoolId that matches NO real pool, so the deployed staker would reject every
  // deposit (WrongPool) and strand a funded deploy — enforce it before hashing.
  if (BigInt(graduatedPoolKey.currency0) >= BigInt(graduatedPoolKey.currency1)) {
    throw new Error('afterlife: pool currencies must be sorted currency0 < currency1');
  }

  const allowedPoolId = computeV4PoolId(graduatedPoolKey);
  // The constructor rejects a zero PoolId (WrongPool). A well-formed key never
  // hashes to zero, but guard explicitly rather than emit params that revert.
  if (allowedPoolId === ZERO_BYTES32) throw new Error('afterlife: computed allowedPoolId is zero');

  return {
    rewardToken,
    staking,
    positionManager,
    allowedPoolId,
    owner,
    args: [rewardToken, staking, positionManager, allowedPoolId, owner] as const,
  };
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

export type AfterlifeFeature = 'boosted-lp-farming' | 'gauge-application';

/**
 * - `eligible`: launch graduated AND every contract this feature needs is deployed.
 * - `pending-deployment`: launch qualifies structurally, but a required contract
 *    is at the zero address (not yet deployed / not configured).
 * - `not-applicable`: launch has not graduated to a V4 pool, so afterlife wiring
 *    does not apply yet.
 */
export type AfterlifeStatus = 'eligible' | 'pending-deployment' | 'not-applicable';

/** One dependency contract and whether it is deployed. */
export interface AfterlifeDependency {
  label: string;
  address: Address;
  deployed: boolean;
}

export interface AfterlifeFeatureEligibility {
  feature: AfterlifeFeature;
  status: AfterlifeStatus;
  /** Plain-language, factual reason for the status. */
  reason: string;
  requires: AfterlifeDependency[];
}

/** A graduated (or not-yet-graduated) launch, as far as afterlife wiring cares. */
export interface AfterlifeLaunch {
  token: Address;
  tier: LaunchTier;
  /** True once the Doppler launch has migrated/graduated to its V4 pool. */
  graduated: boolean;
  /** The graduated V4 pool key; present once `graduated` is true. */
  poolKey?: V4PoolKey | null;
}

export interface AfterlifeEligibility {
  token: Address;
  graduated: boolean;
  /**
   * Flagship-tier launches get the afterlife "fast-track" (config.ts / LAUNCH_TIERS).
   * This does not itself gate the features below — graduation + deployed contracts do.
   */
  fastTrack: boolean;
  features: AfterlifeFeatureEligibility[];
  /** True iff at least one feature is currently 'eligible'. */
  anyAvailable: boolean;
}

function dep(label: string, address: Address): AfterlifeDependency {
  return { label, address, deployed: !isZeroAddress(address) };
}

/**
 * Report which afterlife features a launch qualifies for, honestly gated.
 *
 * A launch must have GRADUATED (have a V4 pool) before any afterlife wiring
 * applies. Given graduation, each feature is `eligible` only if its dependency
 * contracts are deployed; otherwise `pending-deployment`. Zero-address
 * dependencies are NEVER reported as available.
 */
export function afterlifeEligibility(
  launch: AfterlifeLaunch,
  addresses: AfterlifeAddressBook = defaultAfterlifeAddressBook(),
): AfterlifeEligibility {
  const graduated = launch.graduated && launch.poolKey != null;
  const fastTrack = launch.tier === 'flagship';

  // ── boosted-LP farming ──
  const boostedReqs: AfterlifeDependency[] = [
    dep('TOWELI (reward token)', addresses.rewardToken),
    dep('TegridyStaking (boost source)', addresses.staking),
    dep('Uniswap V4 PositionManager', addresses.positionManager),
  ];
  const boosted: AfterlifeFeatureEligibility = (() => {
    if (!graduated) {
      return {
        feature: 'boosted-lp-farming',
        status: 'not-applicable',
        reason: 'Launch has not graduated to a V4 pool; boosted-LP farming applies only after graduation.',
        requires: boostedReqs,
      };
    }
    const missing = boostedReqs.filter((r) => !r.deployed);
    if (missing.length > 0) {
      return {
        feature: 'boosted-lp-farming',
        status: 'pending-deployment',
        reason: `Requires deployed ${missing.map((m) => m.label).join(', ')} before a boosted-LP staker can be deployed for this pool.`,
        requires: boostedReqs,
      };
    }
    return {
      feature: 'boosted-lp-farming',
      status: 'eligible',
      reason: 'A per-pool TegridyBoostedLPStaker can be deployed for this graduated pool.',
      requires: boostedReqs,
    };
  })();

  // ── gauge application ──
  const gaugeReqs: AfterlifeDependency[] = [dep('GaugeController', addresses.gaugeController)];
  const gauge: AfterlifeFeatureEligibility = (() => {
    if (!graduated) {
      return {
        feature: 'gauge-application',
        status: 'not-applicable',
        reason: 'Launch has not graduated to a V4 pool; gauge application applies only after graduation.',
        requires: gaugeReqs,
      };
    }
    if (!gaugeReqs[0]?.deployed) {
      return {
        feature: 'gauge-application',
        status: 'pending-deployment',
        reason: 'GaugeController is not yet deployed (address is zero); gauge emissions are unavailable.',
        requires: gaugeReqs,
      };
    }
    return {
      feature: 'gauge-application',
      status: 'eligible',
      reason: 'This graduated pool can apply to the GaugeController for emissions.',
      requires: gaugeReqs,
    };
  })();

  const features = [boosted, gauge];
  return {
    token: launch.token,
    graduated,
    fastTrack,
    features,
    anyAvailable: features.some((f) => f.status === 'eligible'),
  };
}
