import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

const wallet = vi.hoisted(() => ({ isConnected: false, chainId: 1 }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: wallet.isConnected }),
  useChainId: () => wallet.chainId,
}));

import { useLiquidityChainId } from './useLiquidityChainId';

const at = (url: string) =>
  renderHook(() => useLiquidityChainId(), {
    wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>,
  }).result.current;

/** The network menu's pick wins, wallet or not; the wallet's chain is the fallback. */
describe('useLiquidityChainId', () => {
  beforeEach(() => {
    wallet.isConnected = false;
    wallet.chainId = 1;
  });

  it('follows ?c= with no wallet, on a chain with a venue', () => {
    expect(at('/liquidity?c=8453')).toBe(8453);
    expect(at('/liquidity?c=4663')).toBe(4663);
  });

  it('ignores a ?c= with no venue', () => {
    expect(at('/liquidity?c=42161')).toBe(1);
    expect(at('/liquidity?c=base')).toBe(1);
  });

  // Owner, 2026-10-31: "the liquidity pools on other chains besides sol arent showing". A
  // wallet that did not switch kept the page, menu and list on its own network.
  it('follows ?c= over a connected wallet left on another chain', () => {
    wallet.isConnected = true;
    wallet.chainId = 1;
    expect(at('/liquidity?c=8453')).toBe(8453);
    expect(at('/liquidity?c=4663')).toBe(4663);
  });

  it('takes a connected wallet\'s chain when nothing was picked', () => {
    wallet.isConnected = true;
    wallet.chainId = 8453;
    expect(at('/liquidity')).toBe(8453);
    expect(at('/liquidity?c=42161')).toBe(8453);
  });
});
