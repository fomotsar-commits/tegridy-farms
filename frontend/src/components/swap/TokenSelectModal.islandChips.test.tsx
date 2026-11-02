import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

/**
 * The island's coins on the form's chain come first among the chips (owner, 2026-11-01:
 * "these are the tokens we want to be always showcasing for swaps"), known by address.
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
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';
import { BUNGALOWS } from '../../lib/bungalows';

const chips = (tokens: readonly TokenInfo[], chainId: number) => {
  render(<TokenSelectModal open onClose={() => {}} onSelect={() => {}} customTokens={[]} tokens={tokens} onAddCustomToken={() => {}} chainId={chainId} />);
  return within(screen.getByTestId('token-chips')).queryAllByRole('button').map((b) => b.textContent);
};

describe('TokenSelectModal: the island’s coins lead the chips', () => {
  it('puts every island coin on Ethereum the list carries first, then the popular ones', () => {
    const island = BUNGALOWS.filter((b) => b.live && b.chain === 'ethereum').map((b) => b.address!.toLowerCase());
    const carried = DEFAULT_TOKENS.filter((t) => island.includes(t.address.toLowerCase())).map((t) => t.symbol);
    expect(carried.length).toBeGreaterThan(0);
    const shown = chips(DEFAULT_TOKENS, 1);
    expect(shown.slice(0, carried.length)).toEqual(carried);
    expect(shown).toContain('ETH');
  });

  it('never takes a copy of an island ticker at another address for the island coin', () => {
    const copy: TokenInfo = { address: '0x00000000000000000000000000000000000000c0', symbol: 'PEPE', name: 'Pepe', decimals: 18, logoURI: '' };
    expect(chips([copy], 1)).toEqual([]);
  });
});
