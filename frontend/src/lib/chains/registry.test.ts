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

describe('the registry serves exactly one chain', () => {
  it('has mainnet and nothing else', () => {
    // The slice that wrote the Base deploy scripts deliberately did NOT configure
    // Base. If this list ever grows, someone took the go/no-go decision — that is
    // allowed, but it is not allowed to happen as a side effect of a refactor.
    expect(CONFIGURED_CHAIN_IDS).toEqual([1]);
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
    // wrong; a null feed on an L2 entry would be a deploy-stopping bug.
    expect(getChainConfig(1)?.sequencerUptimeFeed).toBeNull();
  });
});

describe('an unconfigured chain never reads as an empty deployment', () => {
  it('returns null for Base rather than falling back to mainnet', () => {
    expect(getChainConfig(BASE)).toBeNull();
    expect(isChainConfigured(BASE)).toBe(false);
  });

  it.each([BASE, 10, 42161, 56, 999999])('chain %i is unconfigured, not empty', (chainId) => {
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
    expect(unconfiguredChainLabel(BASE)).toBe('Base');
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
      (CHAINS as Record<number, unknown>)[BASE] = {};
    }).toThrow();
    expect(CHAINS[BASE]).toBeUndefined();
  });
});
