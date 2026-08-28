/**
 * The chains this venue serves. Today: three — Ethereum, Base, Robinhood Chain.
 *
 * Mainnet's addresses are IMPORTED from `../constants.ts` rather than repeated
 * here. A registry that carried its own copy of the address book would be a second
 * source of truth for the same facts, and the first address to move would prove it.
 * `constants.ts` stays the single source; this file only says which chain those
 * addresses belong to and what that chain is capable of.
 *
 * THE GO/NO-GO WAS TAKEN. Base (8453) and Robinhood Chain (4663) were configured
 * 2026-08-20 on the operator's direct instruction ("fully compatible with base and
 * robinhood chain, including the launchpads and lp system"). Configured is not
 * live: both entries ship with every protocol contract ZEROED, so `contractOn()`
 * answers `not-deployed` — we serve the chain, the piece is not on it yet. The
 * addresses fill in from the broadcast artifacts of contracts/script/base/ and
 * contracts/script/robinhood/ once the Safes ceremony and Verify scripts are green
 * (docs/BASE_L2_GO_NO_GO.md, docs/ROBINHOOD_L2_LEG.md). The only non-zero facts
 * here are CHAIN facts, each verified against the chain itself: canonical WETH and
 * (on Base) the Chainlink sequencer uptime feed.
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
  CURVE_LAUNCHER_ADDRESS,
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
    curveLauncher: orNull(CURVE_LAUNCHER_ADDRESS),
    toweli: orNull(TOWELI_ADDRESS),
    staking: orNull(TEGRIDY_STAKING_ADDRESS),
    referralSplitter: orNull(REFERRAL_SPLITTER_ADDRESS),
    polAccumulator: orNull(POL_ACCUMULATOR_ADDRESS),
  },
};

/**
 * Base (8453). OP-stack L2; ETH gas. Contracts land from the broadcast artifacts
 * of contracts/script/base/{DeployBaseMVP,DeployBaseLaunchRail,DeployBaseLPFarming}
 * — until then every protocol slot is ZERO and reads answer `not-deployed`.
 *
 * The two non-zero facts are chain facts, not deployments:
 *   weth — the OP-stack predeploy, mirrored from BaseChainConfig.sol.
 *   sequencerUptimeFeed — Chainlink's canonical Base feed, mirrored from
 *     BaseChainConfig.sol / SequencerCheck.sol (re-verified against Chainlink's
 *     L2 sequencer feeds directory 2026-08-20).
 */
const BASE: ChainConfig = {
  id: 8453,
  name: 'Base',
  nativeCurrencySymbol: 'ETH',
  sequencerUptimeFeed: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
  // No veTOWELI here, ever — the sink is a remittance Safe and a fee captured on
  // Base is "queued for the bridge", not staker yield. Surfaces must say so.
  feeSink: 'remittance',
  capabilities: {
    staking: false,
    stakerYield: false,
    referrals: false,
    protocolOwnedLiquidity: false,
    indexed: false,
  },
  contracts: {
    weth: '0x4200000000000000000000000000000000000006',
    // MVP + curve LIVE on Base 8453 (2026-08-25: DeployBaseMVP + DeployCurveLauncher,
    // every slot on-chain read-back verified). Ownership handoffs to MULTISIG are
    // pending the 2-of-2 accept ceremony; the curve is MULTISIG-owned from birth.
    factory: '0x12a249A027AA7DdF184E824b4bb63ba031A39fEC',
    router: '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3',
    twap: '0xB021651dACaD5dabf83ef587297E093DfA0c95Ec',
    swapFeeRouter: '0xa24C7287eC56A7DEFDc70033803451240e267a52',
    swapFeeRouterAdmin: '0xcb03207ae13076F520b8c81Ea4FE6F08F8bC63b2',
    feeSink: '0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1', // FEE_REMITTANCE Safe — remittance sink, not a distributor
    treasury: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0', // TREASURY Safe
    curveLauncher: '0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060',
    toweli: null, // never — fixed supply, one chain
    staking: null,
    referralSplitter: null,
    polAccumulator: null,
  },
};

/**
 * Robinhood Chain (4663). Arbitrum Orbit L2; ETH gas; explorer is Blockscout.
 * Chain facts verified directly against https://rpc.mainnet.chain.robinhood.com
 * 2026-08-20 (chain id, WETH symbol/decimals, Safe factories present) — see
 * docs/ROBINHOOD_L2_LEG.md.
 *
 * sequencerUptimeFeed is null here NOT because the chain lacks a sequencer (it
 * has one) but because Chainlink publishes no uptime feed for 4663 yet. The leg
 * deploys src/AttestedSequencerUptimeFeed.sol and THAT address must land in this
 * field in the same change-set that fills the contract slots below — an L2 entry
 * going live with a null feed is a deploy-stopping bug (SequencerCheck reverts
 * off-mainnet on a zero feed), and the deploy scripts structurally prevent the
 * contracts from shipping without one.
 */
const ROBINHOOD: ChainConfig = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrencySymbol: 'ETH',
  sequencerUptimeFeed: '0x12a249A027AA7DdF184E824b4bb63ba031A39fEC', // AttestedSequencerUptimeFeed, LIVE 2026-08-25 (owner=MULTISIG, attestor=PAUSE_GUARDIAN)
  feeSink: 'remittance',
  capabilities: {
    staking: false,
    stakerYield: false,
    referrals: false,
    protocolOwnedLiquidity: false,
    indexed: false,
  },
  contracts: {
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    // MVP + curve LIVE on Robinhood 4663 (2026-08-25: DeployRobinhoodMVP via
    // dry-run->ethers replay + DeployCurveLauncher, every slot read-back verified).
    // The AttestedSequencerUptimeFeed is the sequencerUptimeFeed above (deployed first).
    factory: '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3',
    router: '0xB021651dACaD5dabf83ef587297E093DfA0c95Ec',
    twap: '0xa24C7287eC56A7DEFDc70033803451240e267a52',
    swapFeeRouter: '0xE9F83A07b071748E795d2489651d5310fA098Db8',
    swapFeeRouterAdmin: '0xdFdd6D72539A425dC917F49FB834901105cA98c9',
    feeSink: '0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1', // FEE_REMITTANCE Safe
    treasury: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0', // TREASURY Safe
    curveLauncher: '0xA2e7E7Fae91846E4c92af7f4b43b24CDd9aBF4F5',
    toweli: null,
    staking: null,
    referralSplitter: null,
    polAccumulator: null,
  },
};

/**
 * Every chain the venue is configured for, keyed by chain id.
 *
 * Three entries since 2026-08-20. Growing this list is a decision, and the memo
 * that takes it names what has to be true first.
 */
export const CHAINS: Readonly<Record<number, ChainConfig>> = Object.freeze({
  [MAINNET.id]: MAINNET,
  [BASE.id]: BASE,
  [ROBINHOOD.id]: ROBINHOOD,
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

/**
 * The wrong-chain message for a mainnet-only rail, said honestly per chain.
 *
 * Three different sentences, because three different things are true:
 *   - a SERVED chain whose rail is not deployed yet ("Base is supported, the
 *     launch rail isn't there yet") — a roadmap fact, not a user error;
 *   - an UNSERVED chain ("we don't serve this chain");
 *   - no chain at all.
 * Collapsing them into "switch to Ethereum Mainnet" was fine when Ethereum was
 * the only entry; with three chains it would tell a Base user their supported
 * chain is wrong, which is false.
 */
export function launchWrongChainMessage(chainId: number | undefined | null): string {
  const config = getChainConfig(chainId);
  if (config && config.id !== DEFAULT_CHAIN_ID) {
    return `Token launches run on Ethereum today — ${config.name} is supported by the app, but its launch rail isn't deployed there yet. Switch to Ethereum to launch.`;
  }
  if (!config && chainId != null) {
    return `This app doesn't serve ${unconfiguredChainLabel(chainId)}. Switch to Ethereum to launch.`;
  }
  return 'Switch your wallet to Ethereum mainnet to launch.';
}
