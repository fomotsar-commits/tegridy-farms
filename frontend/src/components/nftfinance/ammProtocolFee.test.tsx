// The NFT AMM's protocol-fee tile, and why it is not allowed to be a literal.
//
// It read a hardcoded "0.5%" because the factory's fee getter was missing from
// the shared ABI. The factory can change that fee through its own propose →
// 24h → execute timelock, so the literal was one operator action away from
// being a confident lie on the screen a trader sizes a trade against.
//
// Two properties are pinned here: the tile shows what the factory reports, and
// when the factory cannot be read it says so instead of falling back to any
// number at all. A fallback constant is the defect, not the fix.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

import { AMMSection } from './AMMSection';
import { TEGRIDY_NFT_POOL_FACTORY_ADDRESS } from '../../lib/constants';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'AMMSection.tsx'),
  'utf-8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('AMM protocol-fee tile', () => {
  beforeEach(() => {
    wagmiMock.reset();
  });

  it('renders the fee the factory reports', () => {
    wagmiMock.setReadResult({
      functionName: 'protocolFeeBps',
      address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
      result: 50n,
    });
    renderWithProviders(<AMMSection />);
    expect(screen.getByText('0.50%')).toBeTruthy();
  });

  it('follows the factory when the fee changes — the whole point of reading it', () => {
    wagmiMock.setReadResult({
      functionName: 'protocolFeeBps',
      address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
      result: 175n,
    });
    renderWithProviders(<AMMSection />);
    expect(screen.getByText('1.75%')).toBeTruthy();
    expect(screen.queryByText('0.50%')).toBeNull();
  });

  it('says the fee is unavailable when the read fails, and shows no figure', () => {
    wagmiMock.setReadResult({
      functionName: 'protocolFeeBps',
      address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
      result: undefined,
      status: 'failure',
    });
    renderWithProviders(<AMMSection />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
    // Not "0%" either — a failed read is not a free trade.
    expect(screen.queryByText(/^\d+\.\d{2}%$/)).toBeNull();
  });

  it('says the fee is unavailable when nothing answers at all', () => {
    renderWithProviders(<AMMSection />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });
});

describe('no fee percentage is hardcoded back into the AMM', () => {
  it('carries no literal percentage in the source outside comments', () => {
    // The original defect was the string '0.5%' sitting in a const. Any bare
    // percentage literal in this file is the same class of claim coming back.
    // Double-quoted forms are excluded on purpose: those are SVG gradient stop
    // offsets, which are geometry, not a fee.
    expect(SRC).not.toMatch(/'\d+(\.\d+)?%'/);
  });

  it('reads protocolFeeBps from the factory address', () => {
    expect(SRC).toMatch(/functionName:\s*'protocolFeeBps'/);
    expect(SRC).toMatch(/address:\s*TEGRIDY_NFT_POOL_FACTORY_ADDRESS/);
  });
});
