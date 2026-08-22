// The graduation plan for a launch, with its migrator verified against the Airlock.
//
// The plan itself is pure (constants in, plan out) and is available synchronously — a
// surface must be able to state where launches graduate even with no RPC. The ONLY thing
// this hook adds is the on-chain check: is the migrator the plan names actually
// whitelisted in the LiquidityMigrator role? That question is what separates "an address
// is configured" from "graduation will not revert", and `Airlock.create` is the contract
// that enforces it.
//
// The check is reported in three states, never two: whitelisted, not whitelisted, and
// unreadable. A failed read must not render as "not whitelisted" — that would be a
// negative finding about a module nobody queried.

import { useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import {
  resolveEvmGraduationVenue,
  verifyMigratorModule,
  type EvmVenueOpts,
  type GraduationVenuePlan,
  type MigratorModuleCheck,
} from '../lib/launcher/graduation';
import { CHAIN_ID } from '../lib/constants';

export interface UseGraduationVenueResult {
  /** Always present — computed from constants, never gated on a client. */
  plan: GraduationVenuePlan;
  /** Null until the Airlock read resolves, or when no client is available. */
  moduleCheck: MigratorModuleCheck | null;
  isChecking: boolean;
  /**
   * True when no public client exists, so the module check never ran. Distinct from a
   * check that ran and failed (`moduleCheck.unreadable`).
   */
  checkSkipped: boolean;
}

/**
 * Resolve the EVM graduation plan and verify its migrator.
 *
 * `opts` is spread into the pure resolver on every render, so callers should pass a
 * stable object or primitives; the async check keys off the resolved migrator address
 * alone, which is derived from a module constant and therefore stable.
 */
export function useGraduationVenue(opts: EvmVenueOpts = {}): UseGraduationVenueResult {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const plan = resolveEvmGraduationVenue(opts);
  const migrator = plan.migrator.address;

  const [moduleCheck, setModuleCheck] = useState<MigratorModuleCheck | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!publicClient || !migrator) return;
    const runId = ++runIdRef.current;

    void (async () => {
      // Inside the async body: setting state directly in an effect body trips the
      // cascading-render lint, and the flag belongs to the read's lifecycle.
      setIsChecking(true);
      // `verifyMigratorModule` never throws — every failure is already an `unreadable`
      // result — so a try/catch here would be dead code that hides nothing.
      const result = await verifyMigratorModule(publicClient, migrator);
      if (runIdRef.current !== runId) return;
      setModuleCheck(result);
      setIsChecking(false);
    })();
  }, [publicClient, migrator]);

  return {
    plan,
    moduleCheck,
    isChecking,
    checkSkipped: !publicClient,
  };
}
