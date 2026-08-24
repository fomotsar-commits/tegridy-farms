// Where a launch actually graduates — computed, not asserted.
//
// A launch's graduation venue is decided at CREATE time by which LiquidityMigrator
// module the Airlock params name (EVM) or which migrationOption the DBC config carries
// (Solana). Neither is visible anywhere in the app today, so a creator signs a launch
// without being told which DEX ends up holding the liquidity, on what lock terms, or who
// collects the graduated pool's trade fee. This module computes that plan from the SAME
// constants the launch builder uses, so the two cannot drift.
//
// ## The one thing this module must never do
//
// It must never present the venue-owned graduation path as the live one. On EVM the
// migrator that will actually run is resolved by `airlock.ts`:
//
//     if (isDeployed(TEGRIDY_V4_MIGRATOR_ADDRESS)) builder.withV4Migrator(...)
//
// and `TEGRIDY_V4_MIGRATOR_ADDRESS` is the zero address. While it is zero the SDK falls
// back to Doppler's own `uniswapV4Migrator` and the launch graduates into a hookless
// canonical V4 pool that this protocol does not own. `resolveEvmGraduationVenue` reads
// that same constant through that same gate, so the plan it reports is the plan that
// ships. `ownership` is 'external' until the constant is set, and every consumer is
// obliged to render `disclosure` — see the honesty guard in venue.test.ts.
//
// ## ⚠ WHY THE EVM RAIL IS NOT "A LAUNCHER THAT DOES NOT GRADUATE TO US"
//
// Read this before acting on any instruction to retire non-graduating launchers.
// On 2026-08-23 the Meteora DBC rail was retired on exactly that basis, and the
// EVM rail reports `ownership: 'external'` today too — so a literal sweep would
// take it as well. That would be wrong, and expensive.
//
// The two are different IN KIND:
//
//   EVM      graduates externally ONLY because `TEGRIDY_V4_MIGRATOR_ADDRESS` is the
//            zero address. The Tegridy-owned target EXISTS —
//            `contracts/src/v4/TegridyLiquidityMigrator.sol`, written and in-repo,
//            graduating into a canonical V4 pool carrying `TegridyV4Hook`. The gap is
//            a DEPLOY plus an Airlock `setModuleState(migrator, 4)`. An address flip.
//
//   Meteora  named DAMM v2 unconditionally in its DBC config. A venue-owned Solana
//            target would have been a new PROGRAM DEPLOY, not an address flip. It
//            could never graduate to us, which is why it was the one retired.
//
// Deleting the EVM rail would also strand live mainnet revenue:
// `contracts/src/LockerClaimer.sol` (deployed 0xD2Ac3dC1…, verified 2026-08-01) is
// the only address that can originate `releaseFees()` on the Doppler locker, which is
// pull-based and pays `msg.sender` only.
//
// So `ownership: 'external'` is a statement about TODAY'S CHAIN STATE, never a verdict
// on whether a rail belongs here.
//
// This module fires nothing and reads no chain state on its own. `verifyMigratorModule`
// takes a client and is the only async surface: it asks the Airlock whether the migrator
// this plan names is actually whitelisted, so a "ready" indicator is earned by a read
// rather than by a constant being non-zero.

import type { Address, Hex } from 'viem';
import { DOPPLER_MAINNET, AIRLOCK_ABI, DopplerModuleState } from '../doppler.constants';
import { TEGRIDY_V4_MIGRATOR_ADDRESS } from '../constants';
import { MIGRATION_POOL, NATIVE_ETH } from '../airlock';
import { migrationPoolKey, migrationPoolId, type V4PoolKey } from '../lockerStream';
import { isDeployed, TEGRIDY_FACTORY_ADDRESS } from '../../constants';
import { DEFAULT_FEE_CONSTITUTION } from '../config';
import {
  SOLANA_MIGRATION_TARGET_LABEL,
  SOLANA_MIGRATION_POOL_FEE_BPS,
  SOLANA_PERMANENT_LOCK_PERCENT,
} from './solanaVenueFacts';

/** Which chain rail a launch graduates on. */
export type GraduationRail = 'evm' | 'solana';

/**
 * Who owns the venue the liquidity lands in.
 *
 * 'external' — a third party's DEX (Doppler's canonical V4 pool, Meteora DAMM v2). The
 *   protocol earns only what that venue's own fee mechanism credits it.
 * 'venue-owned' — this protocol's own DEX. NOT REACHABLE on any rail today; it is
 *   returned only once the operator wires a deployed venue migrator, which is exactly
 *   what `plannedVenueMigrator` documents.
 */
export type VenueOwnership = 'external' | 'venue-owned';

/** How the LP ends up held after migration. */
export type LpDisposition =
  /** Escrowed by a locker contract for a fixed duration, then withdrawable by its recipient. */
  | 'time-locked-escrow'
  /** Locked forever with no withdrawal path for anyone (permanent lock or burn). */
  | 'permanently-locked'
  /** Sent to a burn address — permanently locked AND unownable. */
  | 'burned';

export interface GraduationMigrator {
  /** The module that will run. Null on Solana, where migration is a program instruction. */
  address: Address | null;
  label: string;
  ownership: VenueOwnership;
}

export interface GraduationPoolPlan {
  /** The venue the liquidity lands in, in plain words. */
  venue: string;
  /**
   * The pool's canonical id, when it is derivable. NULL before a token address exists —
   * the id is keccak over a PoolKey containing the token, so there is nothing to compute
   * from a wizard that has not launched yet. A null here is an unknown, not an absence.
   */
  poolId: Hex | null;
  poolKey: V4PoolKey | null;
  /** Populated exactly when `poolId` is null: why it could not be computed. */
  undeterminedReason: string | null;
  /**
   * Graduated-pool trade fee in hundredths of a bip (3000 = 0.30%).
   *
   * `null` when NO fee is knowable yet — not a default, not a zero. The own-venue
   * Solana rail is the case: its fee lives on a cp-swap AmmConfig that has never been
   * created. Rendering 0% there would state a fee the pool does not charge, which is
   * the disclosure-becomes-a-lie failure this module exists to prevent. Consumers must
   * branch and say "not yet determined".
   */
  feeHundredthsBips: number | null;
  /** Null on rails that do not expose one (Solana DAMM v2 fee tiers are program-side). */
  tickSpacing: number | null;
  /** The base pair the graduated pool is quoted in. Null on Solana (quote mint, not an EVM address). */
  numeraire: Address | null;
}

export interface LpLockTerms {
  disposition: LpDisposition;
  /** The contract/program that holds the LP. Null when not an EVM address. */
  custodian: Address | null;
  custodianLabel: string;
  /**
   * Lock length in seconds when the caller supplied one. NULL means the caller did not
   * name a launch's lock duration — never a default, because a fabricated "0" or a
   * fabricated "12 months" both read as a term nobody chose.
   */
  durationSeconds: number | null;
  /** True only when NO party can ever withdraw the LP. */
  irreversible: boolean;
  note: string;
}

export interface VenueFeeLine {
  /** Label as published in the fee constitution. */
  recipient: string;
  /** Share of the graduated pool's trade fee, in bps of 10000. */
  shareBps: number;
  role: string;
  /**
   * True when this line accrues to the protocol. The venue's revenue is the SUM of
   * these — and on an external venue it is a share of someone else's pool fee, never
   * the pool fee itself.
   */
  protocol: boolean;
}

export interface GraduationVenuePlan {
  rail: GraduationRail;
  migrator: GraduationMigrator;
  pool: GraduationPoolPlan;
  lpLock: LpLockTerms;
  feeSplit: VenueFeeLine[];
  /** Sum of the protocol lines, in bps of the graduated pool's trade fee. */
  protocolShareBps: number;
  /**
   * The sentence every surface rendering this plan MUST show. It states which migrator
   * actually runs and, while the venue migrator is unset, that graduation is external.
   */
  disclosure: string;
  /**
   * What must become true before `ownership` can be 'venue-owned'. Empty only when it
   * already is. Ordered as the operator must do them.
   */
  preconditions: string[];
}

/** Hundredths-of-a-bip to a percent string ('3000' -> '0.3'). */
export function feePercent(hundredthsOfBip: number): string {
  return String(hundredthsOfBip / 10_000);
}

/**
 * The venue migrator this protocol INTENDS to graduate through, and its state today.
 *
 * Separated from `resolveEvmGraduationVenue` so a surface can describe the planned venue
 * without any risk of it being mistaken for the resolved one: `configured` is the literal
 * `isDeployed(TEGRIDY_V4_MIGRATOR_ADDRESS)` gate that `airlock.ts` branches on, so the two
 * cannot disagree about what will run.
 */
export function plannedVenueMigrator(): {
  address: Address;
  configured: boolean;
  venue: string;
  preconditions: string[];
} {
  return {
    address: TEGRIDY_V4_MIGRATOR_ADDRESS,
    configured: isDeployed(TEGRIDY_V4_MIGRATOR_ADDRESS),
    venue: `Tegridy DEX (TegridyFactory ${TEGRIDY_FACTORY_ADDRESS})`,
    preconditions: [
      'Deploy the venue graduation migrator and verify it on Etherscan.',
      'Whetstone whitelists it on the Airlock: setModuleState(migrator, 4). Airlock.create rejects a non-whitelisted module, so launches fail at CREATE time without this.',
      'Grant the standing initializer allowance the migrator needs. Airlock.migrate transfers the graduated balances in BEFORE calling the migrator, so a revert there strands them rather than merely failing.',
      'Only then set TEGRIDY_V4_MIGRATOR_ADDRESS in frontend/src/lib/launcher/constants.ts and redeploy.',
    ],
  };
}

export interface EvmVenueOpts {
  /** The launched token. Omit before a launch exists — the pool id then reports as unknown. */
  token?: Address | null;
  /** Base pair. Defaults to native ETH, matching the launch builder's default. */
  numeraire?: Address;
  /** The launch's LP lock, in seconds. Omit when unknown; it is never defaulted. */
  lockDurationSeconds?: number | null;
  /**
   * The launch's real resolved fee constitution, when the caller has one (post-resolve,
   * or read back from the locker). Falls back to the published DEFAULT_FEE_CONSTITUTION
   * template, which is what a launch that has not chosen attention splits actually gets.
   */
  feeConstitution?: readonly { recipient: string; shareBps: number; role: string }[];
}

const PROTOCOL_ROLES: ReadonlySet<string> = new Set(['protocol-stakers', 'protocol-pol']);

/**
 * The graduation plan for an EVM launch, as it will actually execute today.
 *
 * The migrator is chosen by the SAME `isDeployed(TEGRIDY_V4_MIGRATOR_ADDRESS)` gate
 * `airlock.ts` uses. While that constant is zero this returns Doppler's own migrator with
 * `ownership: 'external'` and a disclosure that says so in the first sentence.
 */
export function resolveEvmGraduationVenue(opts: EvmVenueOpts = {}): GraduationVenuePlan {
  const planned = plannedVenueMigrator();
  const numeraire = opts.numeraire ?? NATIVE_ETH;
  const token = opts.token ?? null;

  const migrator: GraduationMigrator = planned.configured
    ? {
        address: planned.address,
        label: 'Tegridy graduation migrator',
        ownership: 'venue-owned',
      }
    : {
        address: DOPPLER_MAINNET.modules.uniswapV4Migrator.address,
        label: 'Doppler UniswapV4Migrator (external)',
        ownership: 'external',
      };

  // The pool key is pure keccak input; without a token there is nothing to hash, and a
  // placeholder token would produce a real-looking id for a pool that will never exist.
  const poolKey = token ? migrationPoolKey(token, numeraire) : null;
  const poolId = token ? migrationPoolId(token, numeraire) : null;

  const feeConstitution = opts.feeConstitution ?? DEFAULT_FEE_CONSTITUTION;
  const feeSplit: VenueFeeLine[] = feeConstitution.map((l) => ({
    recipient: l.recipient,
    shareBps: l.shareBps,
    role: l.role,
    protocol: PROTOCOL_ROLES.has(l.role),
  }));
  const protocolShareBps = feeSplit.reduce((n, l) => n + (l.protocol ? l.shareBps : 0), 0);

  const disclosure = planned.configured
    ? `Launches graduate through the Tegridy migrator at ${planned.address}. Liquidity lands in a pool this protocol operates.`
    : `Launches currently graduate through Doppler's own migrator at ${DOPPLER_MAINNET.modules.uniswapV4Migrator.address} — an external venue. Venue graduation is NOT live: the Tegridy migrator address is unset, and the protocol earns only its published share of the graduated pool's fee, not the pool itself.`;

  return {
    rail: 'evm',
    migrator,
    pool: {
      venue: planned.configured
        ? planned.venue
        : 'Uniswap V4 (canonical PoolManager), pool created by Doppler',
      poolId,
      poolKey,
      undeterminedReason: token
        ? null
        : 'No token address yet. The pool id is the keccak of a pool key containing the token, so it exists only once the launch does.',
      feeHundredthsBips: MIGRATION_POOL.fee,
      tickSpacing: MIGRATION_POOL.tickSpacing,
      numeraire,
    },
    lpLock: {
      // NOT burned. The Doppler path escrows the position NFT in the StreamableFeesLocker
      // and the recipient may withdraw it once lockDuration elapses. Calling that
      // "LP burned" — the phrasing the venue-owned design uses — would be false today.
      disposition: 'time-locked-escrow',
      custodian: DOPPLER_MAINNET.support.streamableFeesLocker,
      custodianLabel: 'Doppler StreamableFeesLocker (V1)',
      durationSeconds:
        typeof opts.lockDurationSeconds === 'number' && Number.isFinite(opts.lockDurationSeconds)
          ? opts.lockDurationSeconds
          : null,
      irreversible: false,
      note: 'The graduated LP position is escrowed by the locker for the launch’s lock duration and its trade fees stream to the beneficiaries below. It is not burned: after the lock elapses the position’s recipient can withdraw it.',
    },
    feeSplit,
    protocolShareBps,
    disclosure,
    preconditions: planned.configured ? [] : planned.preconditions,
  };
}

/**
 * The graduation plan for the Solana rail.
 *
 * REWRITTEN 2026-08-23 for the own venue. This used to describe the Meteora DBC rail,
 * which graduated into DAMM v2 — a venue this protocol does not own. That rail is
 * retired. `tegridy-launch` graduates into OUR cp-swap fork instead.
 *
 * ⚠ THE VENUE IS OURS AND THE RAIL IS STILL NOT LIVE. Those are different claims and
 * this function must keep them apart. Marking Solana `venue-owned` because Meteora is
 * gone would publish a graduation promise the chain cannot keep — the exact failure the
 * module header exists to prevent — because BOTH program ids were closed on mainnet
 * 2026-08-13 and are permanently spent, and the cp-swap AmmConfig has never been
 * created (which is why `migrate_to_amm` failed AmmNotConfigured 6015 for the whole
 * life of the previous deployment, so no launch ever graduated).
 *
 * So: `ownership: 'venue-owned'` — true of the DESIGN, and the migrator is our own
 * program — while `preconditions` carries the three things that are not yet true, and
 * the pool fee stays `null` because no AmmConfig exists to read one from.
 */
export function resolveSolanaGraduationVenue(): GraduationVenuePlan {
  return {
    rail: 'solana',
    migrator: {
      address: null,
      label: SOLANA_MIGRATION_TARGET_LABEL,
      // The migrator IS ours — tegridy-launch CPIs our cp-swap fork unconditionally.
      // `address: null` because both program ids are spent and the restart has not
      // happened, so there is no address to name yet.
      ownership: 'venue-owned',
    },
    pool: {
      venue: SOLANA_MIGRATION_TARGET_LABEL,
      poolId: null,
      poolKey: null,
      undeterminedReason:
        'Solana pool addresses are program-derived at migration time and are not EVM pool keys.',
      // null, deliberately. The fee lives on the cp-swap AmmConfig, which has never
      // been created. A plausible default here would be a fee sheet that is a lie.
      feeHundredthsBips: SOLANA_MIGRATION_POOL_FEE_BPS,
      tickSpacing: null,
      numeraire: null,
    },
    lpLock: {
      disposition: 'permanently-locked',
      custodian: null,
      custodianLabel: 'burned at migration — no custodian',
      durationSeconds: null,
      irreversible: true,
      note:
        `${SOLANA_PERMANENT_LOCK_PERCENT}% of migrated LP is BURNED during migration, not locked with a ` +
        'custodian, and the program asserts the burn emptied the account before it completes. ' +
        'That is stronger than a permanent lock: a lock has a counterparty, a burn has none.',
    },
    // Still deliberately empty. The own-curve fee split is snapshotted per launch on the
    // BondingCurve account (trade_fee_bps + creator_fee_share_bps), so a constitution
    // published here would be a second source of truth that drifts from the account.
    feeSplit: [],
    protocolShareBps: 0,
    disclosure:
      'Solana launches graduate into Tegridy’s own cp-swap pool, and the migrated LP is burned. ' +
      'THE RAIL IS NOT LIVE: both programs were closed on 2026-08-13 and their ids are permanently ' +
      'spent, so nothing can be launched or graduated until the redeploy. The graduated pool’s trade ' +
      'fee is not yet determined because its AmmConfig has never been created.',
    preconditions: [
      'Both program ids were closed on mainnet 2026-08-13 and are permanently spent — a restart needs fresh keypairs and new declare_id! values.',
      'The cp-swap AmmConfig has never been created; until create_amm_config and update_global both run, migrate_to_amm fails AmmNotConfigured (6015) and no launch can graduate.',
      'No launch has ever graduated on this rail, so the migration path is unproven on mainnet.',
    ],
  };
}

/** What an on-chain check of the resolved migrator found. */
export interface MigratorModuleCheck {
  migrator: Address;
  /** The Airlock's own `getModuleState`. Null when the read failed. */
  state: number | null;
  /** True only when the read landed AND returned LiquidityMigrator (4). */
  whitelisted: boolean;
  /**
   * True when the read did not land. A green "whitelisted" indicator must be earned by a
   * real read, so `whitelisted` stays false here and callers must show this instead of a
   * negative finding about the module.
   */
  unreadable: boolean;
}

/** Minimal read surface — a real viem PublicClient satisfies it; tests supply a mock. */
export interface AirlockReadClient {
  // Mirrors lockerStream.LockerReadClient: a real client's readContract infers a literal
  // functionName from the abi and is not assignable to a plain signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract(args: any): Promise<unknown>;
}

/**
 * Ask the Airlock whether the migrator a plan names is whitelisted in the
 * LiquidityMigrator role.
 *
 * This is the read that earns a "graduation will succeed" indicator. A non-zero constant
 * proves only that someone typed an address; `Airlock.create` rejects a module that is not
 * in state 4, so this is the check that distinguishes configured from usable.
 *
 * Never throws. A transport failure resolves to `unreadable: true` with
 * `whitelisted: false` — an unknown, which callers must not render as "not whitelisted".
 */
export async function verifyMigratorModule(
  client: AirlockReadClient,
  migrator: Address,
  airlock: Address = DOPPLER_MAINNET.airlock,
): Promise<MigratorModuleCheck> {
  try {
    const raw = await client.readContract({
      address: airlock,
      abi: AIRLOCK_ABI,
      functionName: 'getModuleState',
      args: [migrator],
    });
    const state = typeof raw === 'bigint' ? Number(raw) : Number(raw as number | string);
    if (!Number.isFinite(state)) {
      return { migrator, state: null, whitelisted: false, unreadable: true };
    }
    return {
      migrator,
      state,
      whitelisted: state === DopplerModuleState.LiquidityMigrator,
      unreadable: false,
    };
  } catch {
    return { migrator, state: null, whitelisted: false, unreadable: true };
  }
}
