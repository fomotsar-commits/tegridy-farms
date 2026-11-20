// A recent CoW swap's row names what the order sells, which the visitor pays: rounded UP at the
// fourth decimal, never below, as the limit tab's CoW order row does.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true }),
  useChainId: () => 1,
}));

const records = vi.hoisted(() => [
  {
    uid: '0xabc',
    sellToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    buyToken: { symbol: 'TOWELI', address: '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca', decimals: 18 },
    // 1.23451 USDC: the fourth decimal rounds down to the nearest, and up to 1.2346.
    sellAmount: '1234510',
    buyAmountMin: '1',
    createdAt: 0,
    status: 'open',
  },
]);
vi.mock('../../hooks/useCowSwap', () => ({
  useCowSwap: () => ({ getQuote: vi.fn(async () => null), placeSwap: vi.fn(), isPlacing: false, records }),
}));

import { CowSwapPanel } from './CowSwapPanel';

const ARROW = String.fromCodePoint(0x2192);

describe('CowSwapPanel recent swaps', () => {
  it('a sell of 1.23451 USDC reads 1.2346, not 1.2345', () => {
    render(<CowSwapPanel fromToken={null} toToken={null} inputAmount="" slippage={0.5} />);
    expect(screen.getByText(new RegExp(`USDC ${ARROW} TOWELI$`)).textContent).toBe(`1.2346 USDC ${ARROW} TOWELI`);
  });
});
