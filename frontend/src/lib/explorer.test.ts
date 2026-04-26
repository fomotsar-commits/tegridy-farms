import { describe, it, expect } from 'vitest';
import {
  getChainLabel,
  getExplorerBase,
  getTxUrl,
  getAddressUrl,
  getBlockUrl,
  getTokenUrl,
} from './explorer';

const HASH = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

describe('explorer — Ethereum L1 + testnets', () => {
  it('mainnet (1) → etherscan.io', () => {
    expect(getExplorerBase(1)).toBe('https://etherscan.io');
    expect(getChainLabel(1)).toBe('Mainnet');
  });

  it('Sepolia (11155111) → sepolia.etherscan.io', () => {
    expect(getExplorerBase(11155111)).toBe('https://sepolia.etherscan.io');
    expect(getChainLabel(11155111)).toBe('Sepolia');
  });

  it('Holesky (17000) → holesky.etherscan.io', () => {
    expect(getExplorerBase(17000)).toBe('https://holesky.etherscan.io');
    expect(getChainLabel(17000)).toBe('Holesky');
  });

  it('Goerli (5) still resolves for legacy tx history', () => {
    expect(getExplorerBase(5)).toBe('https://goerli.etherscan.io');
  });
});

describe('explorer — Optimism family (AUDIT R074 M-01)', () => {
  it('OP Mainnet (10) → optimistic.etherscan.io', () => {
    expect(getExplorerBase(10)).toBe('https://optimistic.etherscan.io');
    expect(getChainLabel(10)).toBe('Optimism');
  });

  it('OP Sepolia (11155420) → sepolia-optimism.etherscan.io', () => {
    expect(getExplorerBase(11155420)).toBe('https://sepolia-optimism.etherscan.io');
    expect(getChainLabel(11155420)).toBe('OP Sepolia');
  });
});

describe('explorer — Base family', () => {
  it('Base mainnet (8453) → basescan.org', () => {
    expect(getExplorerBase(8453)).toBe('https://basescan.org');
    expect(getChainLabel(8453)).toBe('Base');
  });

  it('Base Sepolia (84532) → sepolia.basescan.org', () => {
    expect(getExplorerBase(84532)).toBe('https://sepolia.basescan.org');
    expect(getChainLabel(84532)).toBe('Base Sepolia');
  });
});

describe('explorer — Arbitrum family', () => {
  it('Arbitrum One (42161) → arbiscan.io', () => {
    expect(getExplorerBase(42161)).toBe('https://arbiscan.io');
    expect(getChainLabel(42161)).toBe('Arbitrum');
  });

  it('Arbitrum Sepolia (421614) → sepolia.arbiscan.io', () => {
    expect(getExplorerBase(421614)).toBe('https://sepolia.arbiscan.io');
    expect(getChainLabel(421614)).toBe('Arbitrum Sepolia');
  });
});

describe('explorer — Polygon family (AUDIT R074 M-02)', () => {
  it('Polygon mainnet (137) → polygonscan.com', () => {
    expect(getExplorerBase(137)).toBe('https://polygonscan.com');
    expect(getChainLabel(137)).toBe('Polygon');
  });

  it('Polygon Amoy (80002) → amoy.polygonscan.com', () => {
    expect(getExplorerBase(80002)).toBe('https://amoy.polygonscan.com');
    expect(getChainLabel(80002)).toBe('Polygon Amoy');
  });
});

describe('explorer — non-EVM-canonical chains (AUDIT R074 M-01)', () => {
  it('zkSync Era (324) → era.zksync.network', () => {
    expect(getExplorerBase(324)).toBe('https://era.zksync.network');
    expect(getChainLabel(324)).toBe('zkSync Era');
  });

  it('Linea (59144) → lineascan.build', () => {
    expect(getExplorerBase(59144)).toBe('https://lineascan.build');
    expect(getChainLabel(59144)).toBe('Linea');
  });

  it('Scroll (534352) → scrollscan.com', () => {
    expect(getExplorerBase(534352)).toBe('https://scrollscan.com');
    expect(getChainLabel(534352)).toBe('Scroll');
  });

  it('Mantle (5000) → mantlescan.xyz', () => {
    expect(getExplorerBase(5000)).toBe('https://mantlescan.xyz');
    expect(getChainLabel(5000)).toBe('Mantle');
  });

  it('Blast (81457) → blastscan.io', () => {
    expect(getExplorerBase(81457)).toBe('https://blastscan.io');
    expect(getChainLabel(81457)).toBe('Blast');
  });

  it('BNB Chain (56) → bscscan.com', () => {
    expect(getExplorerBase(56)).toBe('https://bscscan.com');
    expect(getChainLabel(56)).toBe('BNB Chain');
  });

  it('Avalanche (43114) → snowtrace.io', () => {
    expect(getExplorerBase(43114)).toBe('https://snowtrace.io');
    expect(getChainLabel(43114)).toBe('Avalanche');
  });
});

describe('explorer — fallback behaviour', () => {
  it('returns mainnet etherscan for unknown chain id (link still resolves)', () => {
    expect(getExplorerBase(999_999)).toBe('https://etherscan.io');
  });

  it('returns mainnet etherscan when chainId is undefined', () => {
    expect(getExplorerBase(undefined)).toBe('https://etherscan.io');
  });

  it('returns "Chain {id}" label for unknown ids and "Unknown Network" for undefined', () => {
    expect(getChainLabel(999_999)).toBe('Chain 999999');
    expect(getChainLabel(undefined)).toBe('Unknown Network');
    expect(getChainLabel(0)).toBe('Unknown Network');
  });
});

describe('explorer — URL builders', () => {
  it('getTxUrl composes /tx/{hash} per-chain', () => {
    expect(getTxUrl(1, HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
    expect(getTxUrl(59144, HASH)).toBe(`https://lineascan.build/tx/${HASH}`);
    expect(getTxUrl(11155420, HASH)).toBe(`https://sepolia-optimism.etherscan.io/tx/${HASH}`);
  });

  it('getAddressUrl composes /address/{addr} per-chain', () => {
    expect(getAddressUrl(8453, ADDR)).toBe(`https://basescan.org/address/${ADDR}`);
    expect(getAddressUrl(324, ADDR)).toBe(`https://era.zksync.network/address/${ADDR}`);
  });

  it('getBlockUrl composes /block/{block} and stringifies bigints', () => {
    expect(getBlockUrl(534352, 12345)).toBe('https://scrollscan.com/block/12345');
    expect(getBlockUrl(81457, 9_999_999_999_999n)).toBe('https://blastscan.io/block/9999999999999');
  });

  it('getTokenUrl composes /token/{addr} per-chain', () => {
    expect(getTokenUrl(137, ADDR)).toBe(`https://polygonscan.com/token/${ADDR}`);
    expect(getTokenUrl(80002, ADDR)).toBe(`https://amoy.polygonscan.com/token/${ADDR}`);
  });

  it('builders fall back to mainnet etherscan for unknown chain', () => {
    expect(getTxUrl(999_999, HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
    expect(getAddressUrl(undefined, ADDR)).toBe(`https://etherscan.io/address/${ADDR}`);
  });
});
