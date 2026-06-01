import { describe, it, expect } from 'vitest';
import {
  buildMevBlockerChainParams,
  isUserRejection,
  MEV_BLOCKER_FAST_RPC,
  MAINNET_CHAIN_ID_HEX,
} from './mevProtection';

describe('buildMevBlockerChainParams', () => {
  it('targets Ethereum mainnet (0x1) with the canonical protected RPC', () => {
    const p = buildMevBlockerChainParams();
    expect(p.chainId).toBe(MAINNET_CHAIN_ID_HEX);
    expect(p.chainId).toBe('0x1');
    expect(p.rpcUrls).toEqual([MEV_BLOCKER_FAST_RPC]);
    expect(p.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = buildMevBlockerChainParams();
    const b = buildMevBlockerChainParams();
    expect(a).not.toBe(b);
    expect(a.rpcUrls).not.toBe(b.rpcUrls);
    expect(a).toEqual(b);
  });
});

describe('isUserRejection', () => {
  it('treats EIP-1193 code 4001 as a user rejection', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
  });

  it('treats ACTION_REJECTED as a user rejection', () => {
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true);
  });

  it('unwraps a nested cause (viem/ethers wrapping)', () => {
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection({ cause: { cause: { code: 'ACTION_REJECTED' } } })).toBe(true);
  });

  it('does not flag other errors, non-objects, or null', () => {
    expect(isUserRejection({ code: 4902 })).toBe(false); // chain-not-added
    expect(isUserRejection(new Error('boom'))).toBe(false);
    expect(isUserRejection('nope')).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });

  it('does not infinite-loop on a self-referential cause chain', () => {
    const e: { code?: unknown; cause?: unknown } = {};
    e.cause = e;
    expect(isUserRejection(e)).toBe(false);
  });
});
