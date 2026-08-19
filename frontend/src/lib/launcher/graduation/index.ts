// Graduation venue — the read side of "where does a launch's liquidity end up".
//
// Two halves, deliberately separate: `venue` computes the plan from launch constants and
// verifies the migrator against the Airlock; `feeLine` reads what the protocol's fee sink
// has actually been credited. Neither writes anything.

export {
  resolveEvmGraduationVenue,
  resolveSolanaGraduationVenue,
  plannedVenueMigrator,
  verifyMigratorModule,
  feePercent,
  type GraduationRail,
  type VenueOwnership,
  type LpDisposition,
  type GraduationMigrator,
  type GraduationPoolPlan,
  type LpLockTerms,
  type VenueFeeLine,
  type GraduationVenuePlan,
  type MigratorModuleCheck,
  type EvmVenueOpts,
  type AirlockReadClient,
} from './venue';

export {
  readFeeLine,
  feeLineStatement,
  claimAuthorityStatement,
  LOCKER_CLAIMER_ABI,
  EXPECTED_SINK_DESTINATIONS,
  type FeeLineRead,
  type FeeCredit,
  type SinkDestinations,
} from './feeLine';
