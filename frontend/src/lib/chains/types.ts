/**
 * The shape a chain has to have before this venue will serve it: a chain is a record, and
 * what differs between chains is a field on it, not a branch spread through the app.
 * Adding a chain is a go/no-go the operator takes (docs/BASE_L2_GO_NO_GO.md), not a default.
 */

export type Address = `0x${string}`;

/**
 * What a chain can actually do. Every flag is an absence somewhere else, declared
 * up front rather than discovered by a component that read a zero address and drew
 * an empty state.
 */
export interface ChainCapabilities {
  /** veTOWELI staking exists here. False everywhere TOWELI is not native. */
  readonly staking: boolean;
  /** A ReferralSplitter with a voting-power source to tier against. */
  readonly referrals: boolean;
  /** A POLAccumulator with a TOWELI pair to buy into. */
  readonly protocolOwnedLiquidity: boolean;
  /**
   * The indexer serves this chain. Independent of whether the indexer is hosted
   * at all — `VITE_INDEXER_URL` is still the gate for that, and an unhosted
   * indexer reports unavailable regardless of what this says.
   */
  readonly indexed: boolean;
  /**
   * THE APP CAN QUOTE AND EXECUTE AN AMM SWAP ON THIS CHAIN.
   *
   * This is a statement about the FRONTEND, not about the chain. The venue's
   * V2-fork factory and router are deployed and correctly wired on every chain
   * in this registry — `router.factory()` and `router.WETH()` resolve to that
   * chain's own pair — but the swap stack (useSwap / useSwapQuote /
   * useSwapAllowance / the meta-aggregator) is pinned to `CHAIN_ID` and reads
   * none of those slots. So "the contracts exist here" and "a swap can happen
   * here" are different questions, and this answers the second one.
   *
   * WHY IT MUST NOT BE INFERRED FROM `contracts.router != null`. That was the
   * shape that made the page lie: on Base and Robinhood the router IS present,
   * every quote read is disabled by the chain gate, `outputAmount` falls to 0n
   * and the CTA goes dead with no explanation — and the wrong-network banner
   * stays silent because both chains ARE configured. A visitor got a broken
   * page and no reason for it.
   *
   * SEPARATELY, AND ALSO TRUE ON 2026-09-05: neither L2 has any pool to route
   * against. Measured on-chain, three independent ways per chain —
   * `allPairsLength()` returns 0, `allPairs(0)` REVERTS (what an empty array
   * does at index 0), and each factory's account nonce is 0x1, meaning it has
   * never executed a single CREATE. `launchCount()` is 0 on both curve
   * launchers, which is why: the pair-creation path has never run. So flipping
   * this flag is necessary but NOT sufficient — wiring a chain whose factory
   * holds no pairs produces a page that quotes nothing, which is the same
   * silence in a new costume.
   *
   * 2026-10-17: ON for Base and Robinhood Chain. The swap stack now reads each
   * chain's venue (lib/chains/swapVenue.ts) and compares our pools with that
   * chain's Uniswap V2, so a chain whose own factory is still empty quotes
   * Uniswap V2 instead of nothing (read on chain the same day: 0 pairs on both).
   */
  readonly ammSwap: boolean;
}

export interface ChainContracts {
  readonly weth: Address;
  readonly factory: Address;
  readonly router: Address;
  /**
   * The factory + router that charge to open a pool (0.006 ETH, owner ruling 2026-10-25), and
   * the SwapFeeRouter bound to that router (the venue's swap fee on their pools), or null until
   * deployed here. Any null keeps today's behaviour: pools open on `factory`. All three set,
   * only NEW pools open here; a pool already on `factory` stays on `factory`/`router`.
   */
  readonly openingFactory: Address | null;
  readonly openingRouter: Address | null;
  readonly openingSwapFeeRouter: Address | null;
  readonly twap: Address;
  readonly swapFeeRouter: Address;
  readonly swapFeeRouterAdmin: Address;
  /**
   * The address in `SwapFeeRouter.revenueDistributor`: where the venue's swap fee lands.
   * The chain's treasury Safe on every chain (owner ruling 2026-11-15), so no fee pays a staker.
   */
  readonly feeSink: Address;
  readonly treasury: Address;
  /**
   * TegridyCurveLauncher — the own zero-toll launch curve. Null until the
   * operator deploys it on this chain (M.16). Unlike the Doppler rail this needs
   * no Airlock, no petition and keeps 100% of the fee, so it can go live on any
   * chain the moment its address lands here.
   */
  readonly curveLauncher: Address | null;
  /** Absent on any chain without native TOWELI. */
  readonly toweli: Address | null;
  readonly staking: Address | null;
  readonly referralSplitter: Address | null;
  readonly polAccumulator: Address | null;
}

export interface ChainConfig {
  readonly id: number;
  /** Rendered verbatim in UI. Not derived from the id. */
  readonly name: string;
  readonly nativeCurrencySymbol: string;
  /**
   * Chainlink L2 Sequencer Uptime feed, or null on a chain with no sequencer.
   *
   * Null is meaningful, not missing: SequencerCheck.sol no-ops only on chainid 1
   * and reverts `SequencerFeedNotConfigured()` on every other chain that reads
   * with a zero feed. So null here is correct for mainnet and would be a
   * configuration bug on an L2.
   */
  readonly sequencerUptimeFeed: Address | null;
  readonly capabilities: ChainCapabilities;
  readonly contracts: ChainContracts;
}

/**
 * The answer to "is this contract available on this chain", with the three cases
 * kept apart on purpose.
 *
 * `chain-unconfigured` and `not-deployed` both mean "you cannot call it", and
 * collapsing them is the same defect this codebase keeps finding: one says we do
 * not serve this chain, the other says we serve it and this piece is not live yet.
 * A UI that shows "coming soon" for a chain nobody has decided to launch on is
 * making a promise the roadmap has not made.
 */
export type ContractAvailability =
  | { readonly status: 'deployed'; readonly address: Address }
  | { readonly status: 'not-deployed' }
  | { readonly status: 'chain-unconfigured' };

export type ContractKey = keyof ChainContracts;
