import { describe, it, expect } from 'vitest';
import {
  CHAINS,
  CONFIGURED_CHAIN_IDS,
  DEFAULT_CHAIN_ID,
  contractOn,
  feesBecomeStakerYieldOn,
  getChainConfig,
  isChainConfigured,
  unconfiguredChainLabel,
} from './registry';
import type { ChainConfig } from './types';
import {
  CHAIN_ID,
  SWAP_FEE_ROUTER_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
  isDeployed,
} from '../constants';

const BASE = 8453;
const ROBINHOOD = 4663;

describe('the registry serves the three decided chains', () => {
  it('has mainnet, Robinhood Chain and Base — the 2026-08-20 go/no-go', () => {
    // The one-chain era ended by OPERATOR DIRECTIVE ("fully compatible with base
    // and robinhood chain, including the launchpads and lp system"), not by
    // refactor drift. If this list grows again, the same rule applies: a new
    // entry is a decision with a memo, never a side effect.
    expect(CONFIGURED_CHAIN_IDS).toEqual([1, ROBINHOOD, BASE]);
    expect(CHAIN_ID).toBe(1);
    expect(DEFAULT_CHAIN_ID).toBe(1);
  });

  it('mainnet resolves to a config', () => {
    const config = getChainConfig(1);
    expect(config).not.toBeNull();
    expect(config?.name).toBe('Ethereum');
    expect(isChainConfigured(1)).toBe(true);
  });

  it('mainnet declares no sequencer feed, which is the fact and not a gap', () => {
    // SequencerCheck.sol no-ops on chainid 1 alone. A non-null feed here would be
    // wrong; a null feed on a LIVE L2 entry would be a deploy-stopping bug (the
    // structural test below pins that).
    expect(getChainConfig(1)?.sequencerUptimeFeed).toBeNull();
  });
});

describe('the L2 entries are configured, honest, and LIVE (MVP + curve deployed 2026-08-25)', () => {
  it.each([BASE, ROBINHOOD])('chain %i is served', (chainId) => {
    expect(isChainConfigured(chainId)).toBe(true);
    expect(getChainConfig(chainId)).not.toBeNull();
  });

  it.each([BASE, ROBINHOOD])(
    'chain %i answers deployed for the core protocol (MVP live), never chain-unconfigured',
    (chainId) => {
      // The MVP + curve landed 2026-08-25 (on-chain read-back verified). Every core
      // slot now resolves to a real address; the three-way ContractAvailability
      // expresses "served AND deployed", not "served, nothing on it yet".
      for (const key of ['factory', 'router', 'twap', 'swapFeeRouter', 'feeSink', 'treasury'] as const) {
        expect(contractOn(chainId, key).status).toBe('deployed');
      }
    },
  );

  it('the curve launchpad is LIVE on both L2s at its verified address', () => {
    expect(contractOn(BASE, 'curveLauncher')).toEqual({
      status: 'deployed',
      address: '0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060',
    });
    expect(contractOn(ROBINHOOD, 'curveLauncher')).toEqual({
      status: 'deployed',
      address: '0xA2e7E7Fae91846E4c92af7f4b43b24CDd9aBF4F5',
    });
  });

  it.each([BASE, ROBINHOOD])('chain %i knows its canonical WETH — a chain fact, not a deployment', (chainId) => {
    const weth = contractOn(chainId, 'weth');
    expect(weth.status).toBe('deployed');
  });

  it('the WETH facts match the chain config libraries on the contracts side', () => {
    expect(contractOn(BASE, 'weth')).toEqual({
      status: 'deployed',
      address: '0x4200000000000000000000000000000000000006', // BaseChainConfig.WETH
    });
    expect(contractOn(ROBINHOOD, 'weth')).toEqual({
      status: 'deployed',
      address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // RobinhoodChainConfig.WETH
    });
  });

  it.each([BASE, ROBINHOOD])('chain %i never claims TOWELI, staking, referrals or POL', (chainId) => {
    const config = getChainConfig(chainId)!;
    expect(config.contracts.toweli).toBeNull();
    expect(config.contracts.staking).toBeNull();
    expect(config.capabilities.staking).toBe(false);
    expect(config.capabilities.referrals).toBe(false);
    expect(config.capabilities.protocolOwnedLiquidity).toBe(false);
    expect(config.feeSink).toBe('remittance');
  });

  it('Base carries the canonical Chainlink sequencer uptime feed', () => {
    expect(getChainConfig(BASE)?.sequencerUptimeFeed).toBe(
      '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
    );
  });

  it('no L2 entry may go live with a null sequencer feed — structural, not per-entry', () => {
    // SequencerCheck reverts off-mainnet on a zero feed, so an L2 whose core
    // contracts are deployed while its feed is null is a configuration that
    // bricks in production. Robinhood's feed is null TODAY precisely because its
    // contracts are all still not-deployed; the AttestedSequencerUptimeFeed
    // address must land in the same change-set that fills them, and this test is
    // the tripwire that makes forgetting it a red build instead of a live incident.
    for (const chainId of CONFIGURED_CHAIN_IDS) {
      if (chainId === 1) continue;
      const config = getChainConfig(chainId)!;
      const anyCoreLive = (['factory', 'router', 'twap', 'swapFeeRouter'] as const).some(
        (key) => contractOn(chainId, key).status === 'deployed',
      );
      if (anyCoreLive) {
        expect(config.sequencerUptimeFeed, `chain ${chainId} is live with a null feed`).not.toBeNull();
      }
    }
  });
});

describe('an unconfigured chain never reads as an empty deployment', () => {
  it.each([10, 42161, 56, 999999])('chain %i is unconfigured, not empty', (chainId) => {
    // 'chain-unconfigured' and 'not-deployed' are different facts. If an
    // unconfigured chain answered 'not-deployed', every surface would render the
    // "not live yet" state for a chain nobody has decided to launch on.
    expect(contractOn(chainId, 'swapFeeRouter')).toEqual({ status: 'chain-unconfigured' });
    expect(contractOn(chainId, 'router')).toEqual({ status: 'chain-unconfigured' });
    expect(contractOn(chainId, 'toweli')).toEqual({ status: 'chain-unconfigured' });
  });

  it('treats a missing chain id as unconfigured, not as the default chain', () => {
    // A disconnected wallet must not silently read mainnet addresses.
    expect(getChainConfig(undefined)).toBeNull();
    expect(getChainConfig(null)).toBeNull();
    expect(contractOn(undefined, 'router')).toEqual({ status: 'chain-unconfigured' });
    expect(isChainConfigured(undefined)).toBe(false);
  });

  it('names an unconfigured chain honestly', () => {
    expect(unconfiguredChainLabel(42161)).toBe('Arbitrum');
    expect(unconfiguredChainLabel(999999)).toBe('Chain 999999');
    expect(unconfiguredChainLabel(undefined)).toBe('Unknown Network');
  });
});

describe('contract lookup on the configured chain', () => {
  it('returns the live address from constants, not a copy', () => {
    expect(contractOn(1, 'swapFeeRouter')).toEqual({
      status: 'deployed',
      address: SWAP_FEE_ROUTER_ADDRESS,
    });
    expect(contractOn(1, 'feeSink')).toEqual({
      status: 'deployed',
      address: REVENUE_DISTRIBUTOR_ADDRESS,
    });
  });

  it('reports not-deployed for a slot the chain genuinely lacks', () => {
    const config = getChainConfig(1)!;
    for (const key of ['toweli', 'staking', 'referralSplitter', 'polAccumulator'] as const) {
      const expected = config.contracts[key] == null ? 'not-deployed' : 'deployed';
      expect(contractOn(1, key).status).toBe(expected);
    }
  });

  it('never hands back the zero address under a deployed status', () => {
    const config = getChainConfig(1)!;
    for (const key of Object.keys(config.contracts) as (keyof typeof config.contracts)[]) {
      const result = contractOn(1, key);
      if (result.status === 'deployed') {
        expect(result.address).not.toBe('0x0000000000000000000000000000000000000000');
      }
    }
  });
});

describe('capabilities are derived from the address book, never asserted over it', () => {
  it('each flag matches whether its contract is actually deployed', () => {
    const config = getChainConfig(1)!;
    const { capabilities, contracts } = config;
    expect(capabilities.staking).toBe(contracts.staking != null);
    expect(capabilities.referrals).toBe(contracts.referralSplitter != null);
    expect(capabilities.protocolOwnedLiquidity).toBe(contracts.polAccumulator != null);
    expect(capabilities.stakerYield).toBe(isDeployed(contracts.feeSink));
  });
});

describe('the fee-sink kind is what decides whether "yield" is a true word', () => {
  it('mainnet fees reach stakers on mainnet', () => {
    expect(getChainConfig(1)?.feeSink).toBe('distributor');
    expect(feesBecomeStakerYieldOn(1)).toBe(true);
  });

  it('a chain we do not serve yields nothing, and saying otherwise would be a claim we cannot back', () => {
    expect(feesBecomeStakerYieldOn(BASE)).toBe(false);
    expect(feesBecomeStakerYieldOn(undefined)).toBe(false);
  });

  it('a remittance chain would report false even with a live fee sink', () => {
    // Guards the rule rather than a current entry: any second chain without
    // veTOWELI captures fees into a Safe and pays nobody until a bridge cycle
    // lands elsewhere. This asserts the function reads `feeSink`, so such a chain
    // cannot be added and read as yield-bearing by default.
    const mainnet = getChainConfig(1)!;
    // Typed as `ChainConfig`, not left to infer from `'remittance' as const`.
    // Inferred, `feeSink` had the single literal type `'remittance'`, so the
    // `=== 'distributor'` below was a comparison the compiler could settle on its
    // own — the whole expression folded to a literal `false` and the assertion
    // was `expect(false).toBe(false)`, which is true of any program.
    const remittanceChain: ChainConfig = { ...mainnet, id: BASE, feeSink: 'remittance' };
    expect(remittanceChain.feeSink === 'distributor' && remittanceChain.capabilities.stakerYield).toBe(false);
  });
});

describe('the registry is not mutable at runtime', () => {
  it('cannot be extended by assignment', () => {
    expect(Object.isFrozen(CHAINS)).toBe(true);
    expect(() => {
      (CHAINS as Record<number, unknown>)[999999] = {};
    }).toThrow();
    expect(CHAINS[999999]).toBeUndefined();
    // And an existing entry cannot be swapped out from under its consumers.
    expect(() => {
      (CHAINS as Record<number, unknown>)[BASE] = {};
    }).toThrow();
    expect(CHAINS[BASE]?.name).toBe('Base');
  });
});
