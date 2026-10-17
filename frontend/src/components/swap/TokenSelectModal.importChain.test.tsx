import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * A pasted address is read on the FORM's chain. Until 2026-10-17 the import reads were
 * pinned to Ethereum, so Pools on Base or Robinhood (and now Swap there) looked a Base
 * token up on Ethereum, found nothing, and refused the import after 8 seconds.
 */
const reads = vi.hoisted(() => ({ calls: [] as Array<{ functionName?: string; chainId?: number; enabled?: boolean }> }));
vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useReadContract: (opts: { functionName?: string; chainId?: number; query?: { enabled?: boolean } }) => {
    reads.calls.push({ functionName: opts.functionName, chainId: opts.chainId, enabled: opts.query?.enabled });
    return { data: undefined, isLoading: false };
  },
  useReadContracts: () => ({ data: undefined, isLoading: false }),
  usePublicClient: () => null,
  useAccount: () => ({ address: undefined, isConnected: false }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import { TokenSelectModal } from './TokenSelectModal';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function pasteOn(chainId: number | undefined) {
  reads.calls = [];
  render(
    <TokenSelectModal
      open
      onClose={() => {}}
      onSelect={() => {}}
      customTokens={[]}
      tokens={[]}
      onAddCustomToken={() => {}}
      {...(chainId === undefined ? {} : { chainId })}
    />,
  );
  fireEvent.change(screen.getByPlaceholderText('Search name, symbol, or paste address'), { target: { value: BASE_USDC } });
  return reads.calls.filter((c) => c.enabled && (c.functionName === 'symbol' || c.functionName === 'decimals'));
}

describe('TokenSelectModal — a pasted address is read on the form\'s chain', () => {
  beforeEach(() => { reads.calls = []; });

  it.each([8453, 4663])('reads symbol and decimals on chain %i when the form is there', (chainId) => {
    const live = pasteOn(chainId);
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(new Set(live.map((c) => c.chainId))).toEqual(new Set([chainId]));
  });

  it('reads on Ethereum when no chain is given, as before', () => {
    const live = pasteOn(undefined);
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(new Set(live.map((c) => c.chainId))).toEqual(new Set([1]));
  });
});
