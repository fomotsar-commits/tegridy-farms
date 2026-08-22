// Solana graduation facts, DERIVED from the DBC config builder rather than restated.
//
// Every value here is re-exported or computed from `../solana/dbc`, which is what
// actually goes on-chain. A hand-copied "1%" or "100% locked" in the venue module would
// be a disclosure that keeps its old value after the config changes — the precise way a
// fee sheet becomes a lie without anyone editing it.

import {
  MIGRATION_TARGET_LABEL,
  MIGRATED_POOL_FEE_BPS,
  DEFAULT_LIQUIDITY_DISTRIBUTION,
} from '../solana/dbc';

export const MIGRATE_TO_DAMM_V2_LABEL = MIGRATION_TARGET_LABEL;

/** Post-migration pool trade fee in bps, as selected by the config's migrationFeeOption. */
export const SOLANA_MIGRATION_POOL_FEE_BPS = MIGRATED_POOL_FEE_BPS;

/**
 * Percent of migrated LP that is permanently locked under the DEFAULT distribution —
 * partner-locked plus creator-locked. Computed, so an override of the default split
 * cannot leave this claiming a lock share the config no longer carries.
 */
export const SOLANA_PERMANENT_LOCK_PERCENT =
  DEFAULT_LIQUIDITY_DISTRIBUTION.partnerPermanentLockedLiquidityPercentage +
  DEFAULT_LIQUIDITY_DISTRIBUTION.creatorPermanentLockedLiquidityPercentage;
