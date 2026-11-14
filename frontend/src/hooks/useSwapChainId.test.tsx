import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

const wallet = vi.hoisted(() => ({ isConnected: false, chainId: 1 }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: wallet.isConnected }),
  useChainId: () => wallet.chainId,
}));

import { useSwapChainId } from './useSwapChainId';

const at = (url: string) =>
  renderHook(() => useSwapChainId(), {
    wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>,
  }).result.current;

/** The network picked (`?c=`) wins, wallet or not; with no pick, the wallet's chain. */
describe('useSwapChainId', () => {
  beforeEach(() => {
    wallet.isConnected = false;
    wallet.chainId = 1;
  });

  it('follows ?c= with no wallet, on a chain the swap runs on', () => {
    expect(at('/swap?c=8453')).toBe(8453);
    expect(at('/swap?c=4663')).toBe(4663);
  });

  it('ignores a ?c= the swap does not run on', () => {
    expect(at('/swap?c=42161')).toBe(1);
    expect(at('/swap?c=base')).toBe(1);
  });

  it('follows ?c= over a connected wallet on another network', () => {
    wallet.isConnected = true;
    wallet.chainId = 4663;
    expect(at('/swap?c=8453')).toBe(8453);
    expect(at('/swap?c=1')).toBe(1);
  });

  it('takes a connected wallet\'s chain when nothing was picked', () => {
    wallet.isConnected = true;
    wallet.chainId = 8453;
    expect(at('/swap')).toBe(8453);
    expect(at('/swap?c=42161')).toBe(8453);
  });
});
