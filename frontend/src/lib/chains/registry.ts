/**
 * The chains this venue serves. Today: one.
 *
 * Mainnet's addresses are IMPORTED from `../constants.ts` rather than repeated
 * here. A registry that carried its own copy of the address book would be a second
 * source of truth for the same facts, and the first address to move would prove it.
 * `constants.ts` stays the single source; this file only says which chain those
 * addresses belong to and what that chain is capable of.
 *
 * ADDING A CHAIN is one `ChainConfig` literal and one line in `CHAINS`. It is
 * deliberately that cheap, and deliberately not done: the Base scripts exist
 * (contracts/script/base/) and the decision does not. Until an operator takes it
 * and a deployment is verified on-chain, every lookup for any other chain answers
 * `chain-unconfigured`, which is the correct resting state.
 */

import {
  TOWELI_ADDRESS,
  WETH_ADDRESS,
  TEGRIDY_FACTORY_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_TWAP_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  SWAP_FEE_ROUTER_ADMIN_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
  REFERRAL_SPLITTER_ADDRESS,
  POL_ACCUMULATOR_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TREASURY_ADDRESS,
  CHAIN_ID,
  isDeployed,
} from '../constants';
import { getChainLabel } from '../explorer';
import type {
  Address,
  ChainConfig,
  ContractAvailability,
  ContractKey,
} from './types';

/** Zero is "no deployment", never an address to call. */
const ZERO = '0x0000000000000000000000000000000000000000';

/** Null for an undeployed slot, so a caller cannot accidentally pass zero to a read. */
function orNull(address: string): Address | null {
  return isDeployed(address) ? (address as Address) : null;
}

const MAINNET: ChainConfig = {
  id: CHAIN_ID,
  name: 'Ethereum',
  nativeCurrencySymbol: 'ETH',
  // Mainnet has no sequencer. Null here is the fact, not a gap — SequencerCheck.sol
  // no-ops on chainid 1 alone and refuses the no-op everywhere else.
  sequencerUptimeFeed: null,
  // TOWELI, veTOWELI and the RevenueDistributor are all here, so a fee captured on
  // this chain reaches a staker on this chain.
  feeSink: 'distributor',
  capabilities: {
    staking: isDeployed(TEGRIDY_STAKING_ADDRESS),
    stakerYield: isDeployed(REVENUE_DISTRIBUTOR_ADDRESS),
    referrals: isDeployed(REFERRAL_SPLITTER_ADDRESS),
    protocolOwnedLiquidity: isDeployed(POL_ACCUMULATOR_ADDRESS),
    indexed: true,
  },
  contracts: {
    weth: WETH_ADDRESS,
    factory: TEGRIDY_FACTORY_ADDRESS,
    router: TEGRIDY_ROUTER_ADDRESS,
    twap: TEGRIDY_TWAP_ADDRESS,
    swapFeeRouter: SWAP_FEE_ROUTER_ADDRESS,
    swapFeeRouterAdmin: SWAP_FEE_ROUTER_ADMIN_ADDRESS,
    feeSink: REVENUE_DISTRIBUTOR_ADDRESS,
    treasury: TREASURY_ADDRESS,
    toweli: orNull(TOWELI_ADDRESS),
    staking: orNull(TEGRIDY_STAKING_ADDRESS),
    referralSplitter: orNull(REFERRAL_SPLITTER_ADDRESS),
    polAccumulator: orNull(POL_ACCUMULATOR_ADDRESS),
  },
};

/**
 * Every chain the venue is configured for, keyed by chain id.
 *
 * One entry. A second one is a decision, and the memo that takes it names what has
 * to be true first.
 */
export const CHAINS: Readonly<Record<number, ChainConfig>> = Object.freeze({
  [MAINNET.id]: MAINNET,
});

/** Sorted so anything rendering a chain list is deterministic. */
export const CONFIGURED_CHAIN_IDS: readonly number[] = Object.freeze(
  Object.keys(CHAINS)
    .map(Number)
    .sort((a, b) => a - b),
);

/** The chain everything defaults to when no wallet has told us otherwise. */
export const DEFAULT_CHAIN_ID: number = MAINNET.id;

export function isChainConfigured(chainId: number | undefined | null): boolean {
  return chainId != null && Object.prototype.hasOwnProperty.call(CHAINS, chainId);
}

/**
 * The chain's config, or null when we do not serve it.
 *
 * Null rather than a default: returning mainnet for an unknown chain id is how a
 * wallet on the wrong network ends up reading mainnet balances and rendering them
 * as if they were on the chain the user is looking at.
 */
export function getChainConfig(chainId: number | undefined | null): ChainConfig | null {
  if (chainId == null) return null;
  return CHAINS[chainId] ?? null;
}

/**
 * Look up one contract on one chain, with the three outcomes kept distinct.
 *
 * Callers branch on `status`. There is no overload that returns a bare address,
 * because the whole point is that "we do not serve this chain" cannot silently
 * become an address-shaped zero four call sites later.
 */
export function contractOn(
  chainId: number | undefined | null,
  key: ContractKey,
): ContractAvailability {
  const config = getChainConfig(chainId);
  if (!config) return { status: 'chain-unconfigured' };
  const address = config.contracts[key];
  if (address == null || address === ZERO) return { status: 'not-deployed' };
  return { status: 'deployed', address };
}

/**
 * A name for a chain we do not serve, for the copy that has to mention it.
 *
 * Borrows `explorer.ts`'s label table, which already knows that "Chain 8453" is a
 * more honest fallback than any guess. Used for messages like "Base is not
 * configured" — which is a different sentence from "Base has nothing deployed yet",
 * and only one of them is true.
 */
export function unconfiguredChainLabel(chainId: number | undefined | null): string {
  return getChainLabel(chainId ?? undefined);
}

/**
 * Whether fees captured on this chain can honestly be described as staker yield.
 *
 * False on any chain whose sink is a remittance Safe. Nothing about the capture is
 * in doubt on such a chain; what is in doubt is whether it has reached anyone, and
 * the answer is not yet.
 */
export function feesBecomeStakerYieldOn(chainId: number | undefined | null): boolean {
  const config = getChainConfig(chainId);
  if (!config) return false;
  return config.feeSink === 'distributor' && config.capabilities.stakerYield;
}
