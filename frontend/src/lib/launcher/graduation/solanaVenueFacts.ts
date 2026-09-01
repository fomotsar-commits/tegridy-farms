// Solana graduation facts for OUR OWN venue — derived from the program, never restated.
//
// ─── WHAT CHANGED, 2026-08-23 ───────────────────────────────────────────────
//
// This file used to re-export `MIGRATION_TARGET_LABEL`, `MIGRATED_POOL_FEE_BPS` and
// `DEFAULT_LIQUIDITY_DISTRIBUTION` from `../solana/dbc` — the Meteora DBC config
// builder. That rail is retired: it graduated into Meteora DAMM v2, a venue this
// protocol does not own and could never own without deploying a different program.
//
// The surviving Solana rail is `tegridy-launch`, which graduates into OUR cp-swap
// fork. The discipline is unchanged and is the whole point of this file: a
// hand-copied "1%" or "100% locked" here would be a disclosure that keeps its old
// value after the config changes — the precise way a fee sheet becomes a lie
// without anyone editing it.
//
// ─── WHY TWO OF THESE ARE NOW `null` ────────────────────────────────────────
//
// The honest answer to "what fee will the graduated pool charge?" is **we do not
// know yet**, and it must not be guessed:
//
//   * The post-migration fee is a property of the cp-swap **AmmConfig**, and no
//     AmmConfig has ever been created. That is not an oversight — it is why
//     `migrate_to_amm` failed `AmmNotConfigured` (6015) for the entire life of the
//     previous deployment, so no launch ever graduated. The operator creates it
//     during the restart ceremony (`create_amm_config` → `update_global`), and only
//     then does a number exist to disclose.
//   * Both program ids were closed on mainnet 2026-08-13 and are permanently spent,
//     so there is not even a program to read a config from today.
//
// Publishing a plausible number now is exactly the failure this module was built to
// prevent. `null` forces every consumer to render "not yet determined" instead.

/**
 * The venue a graduated launch lands in. Unlike the fee, this IS knowable from
 * source: `tegridy-launch` CPIs `raydium_cp_swap::initialize` unconditionally
 * (`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs`), so the target is not a
 * per-config choice the way Meteora's `migrationOption` was.
 */
export const SOLANA_MIGRATION_TARGET_LABEL = 'our own cp-swap pool';

/**
 * Post-migration pool trade fee in bps.
 *
 * `null` until an AmmConfig exists — see the header. Consumers MUST render this as
 * undetermined rather than substituting a default; the EVM half of `venue.ts` has the
 * same `configured`/`planned` split and the same obligation.
 */
export const SOLANA_MIGRATION_POOL_FEE_BPS: number | null = null;

/**
 * How much of the migrated LP is permanently unrecoverable.
 *
 * 100, and this one is safe to state because it is not configurable. The program
 * **BURNS** the LP during migration rather than locking it with a custodian, and then
 * asserts the burn emptied the account (`lib.rs:1391` — "Assert the burn actually
 * emptied it"). That is a strictly stronger guarantee than the retired rail's
 * third-party permanent lock: a lock has a custodian and therefore a counterparty, a
 * burn has neither.
 *
 * If a future change makes the burn conditional, this constant becomes a lie — so the
 * disposition below says `burned`, not `locked`, to make that divergence loud.
 */
export const SOLANA_PERMANENT_LOCK_PERCENT = 100;

/** How the LP is made unrecoverable. `burned` has no custodian; `locked` would. */
export const SOLANA_LP_DISPOSITION = 'burned' as const;
