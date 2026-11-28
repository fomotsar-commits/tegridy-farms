/**
 * Our Uniswap V3 venue on HyperEVM (chain 999): the addresses the site reads and sends to.
 * Deployed 2026-11-25 by the contracts kit (contracts/hyperevm/deployments/999.json) and read
 * back on chain the same day: every contract byte-identical to Uniswap's own HyperEVM
 * deployment, the factory owned by `feeAdapter`. While any is null HyperEVM shows nowhere
 * (hyperEvm.ts). Data only, so a test can swap this record for fake addresses and see what turns on.
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
   * The site fee on each swap made on this site, in basis points. Owner, 2026-11-20: 0.5%,
   * the same as Base (SPEC decision 2). Null keeps HyperEVM hidden.
   */
  readonly siteFeeBps: number | null;
  /**
   * Our HyperEVMPoolOpener (contracts/hyperevm/src): anyone opens a pool through it for 0.23 HYPE,
   * paid to `treasury` (owner, 2026-11-26). Null (or absent) only hides the open form and the
   * pools opened through it; the rest of HyperEVM shows without it.
   */
  readonly poolOpener?: `0x${string}` | null;
}

export const HYPEREVM_DEPLOYMENT: HyperEvmDeployment = Object.freeze({
  factory: '0xcaDc93E96De58EA554c71ca609974625615E046D',
  positionManager: '0xcb03207ae13076F520b8c81Ea4FE6F08F8bC63b2',
  quoterV2: '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3',
  universalRouter: '0x8652f9389D1738598E8a732d122440cDA85FAF1A',
  feeAdapter: '0x5f30Aa592fa4dB6AB62373666334E93772c28887',
  treasury: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0',
  siteFeeBps: 50,
  poolOpener: null,
});
