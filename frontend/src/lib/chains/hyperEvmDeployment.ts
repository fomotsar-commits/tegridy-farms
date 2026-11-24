/**
 * Our Uniswap V3 venue on HyperEVM (chain 999): the addresses the site reads and sends to.
 * Every one is null until the contracts kit deploys them and they are read back on chain
 * (SPEC-2026-11-19 step 3). While any is null HyperEVM shows nowhere (hyperEvm.ts).
 * Data only, so a test can swap this record for fake addresses and see what turns on.
 */
export interface HyperEvmDeployment {
  readonly factory: `0x${string}` | null;
  readonly positionManager: `0x${string}` | null;
  readonly quoterV2: `0x${string}` | null;
  /** Uniswap's Universal Router v2.2.0: six-field V3 swaps (universalRouter.ts). */
  readonly universalRouter: `0x${string}` | null;
  /** Uniswap's V3OpenFeeAdapter: owns the factory, sends the pool cut to `treasury`. */
  readonly feeAdapter: `0x${string}` | null;
  /** The HyperEVM treasury Safe: the site fee and the pool cut both land here. */
  readonly treasury: `0x${string}` | null;
  /**
   * The site fee on each swap made on this site, in basis points. OWNER DECISION, OPEN:
   * "the same rate as Base, or lower" (SPEC decision 2). Null keeps HyperEVM hidden.
   */
  readonly siteFeeBps: number | null;
}

export const HYPEREVM_DEPLOYMENT: HyperEvmDeployment = Object.freeze({
  factory: null,
  positionManager: null,
  quoterV2: null,
  universalRouter: null,
  feeAdapter: null,
  treasury: null,
  siteFeeBps: null,
});
