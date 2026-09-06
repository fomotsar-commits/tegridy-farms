/**
 * The shape a chain has to have before this venue will serve it.
 *
 * WHY THIS EXISTS. Adding a second chain used to mean editing every surface that
 * had baked a mainnet address, a mainnet explorer, or the assumption that a fee
 * captured is a fee paid. This module is the seam: a chain is a record, and the
 * things that differ between chains are fields on it rather than branches spread
 * through the app.
 *
 * WHAT IT DOES NOT DO. It does not add a chain. `registry.ts` has exactly one
 * entry — mainnet — and the decision to add another is a go/no-go the operator
 * takes, not a config default. See docs/BASE_L2_GO_NO_GO.md.
 */

export type Address = `0x${string}`;

/**
 * Where a chain's captured protocol fees actually go.
 *
 * This is the field the honesty rules hang off, so it is worth being blunt about.
 *
 *   'distributor'  The chain has a RevenueDistributor and a veTOWELI to read. A
 *                  fee captured here becomes staker yield on this chain, and a
 *                  surface may say so.
 *
 *   'remittance'   The chain captures fees into a Safe that an operator later
 *                  bridges. Nothing on this chain pays a staker. The captured
 *                  amount is real; the yield is not, until a bridge cycle lands
 *                  and reconciles somewhere else. A surface that renders a
 *                  remittance balance as staker yield is publishing a future
 *                  event as a past one.
 *
 * A second chain without veTOWELI can only ever be 'remittance', because
 * RevenueDistributor's constructor takes a votingEscrow and TOWELI is fixed-supply
 * on one chain.
 */
export type FeeSinkKind = 'distributor' | 'remittance';

/**
 * What a chain can actually do. Every flag is an absence somewhere else, declared
 * up front rather than discovered by a component that read a zero address and drew
 * an empty state.
 */
export interface ChainCapabilities {
  /** veTOWELI staking exists here. False everywhere TOWELI is not native. */
  readonly staking: boolean;
  /** Fees captured here reach stakers without leaving the chain. */
  readonly stakerYield: boolean;
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
   */
  readonly ammSwap: boolean;
}

export interface ChainContracts {
  readonly weth: Address;
  readonly factory: Address;
  readonly router: Address;
  readonly twap: Address;
  readonly swapFeeRouter: Address;
  readonly swapFeeRouterAdmin: Address;
  /** The address in `SwapFeeRouter.revenueDistributor`. Read `feeSink` for what it IS. */
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
  readonly feeSink: FeeSinkKind;
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
