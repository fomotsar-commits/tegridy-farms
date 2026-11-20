// An order row's "@ price" is a price, not an amount anyone receives or pays, so it keeps its
// rounding to the nearest digit shown: a price of 0.5 at no decimals reads 1, never 0.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LimitOrder } from '../../hooks/useLimitOrders';

const ETH = { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true };
const TOWELI = { symbol: 'TOWELI', address: `0x${'2'.repeat(40)}`, decimals: 18 };

const { limit } = vi.hoisted(() => ({ limit: { orders: [] as LimitOrder[] } }));

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true }) }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../../hooks/useLimitOrders', () => ({
  useLimitOrders: () => ({ orders: limit.orders, activeOrders: limit.orders, pastOrders: [], createOrder: vi.fn(), cancelOrder: vi.fn() }),
}));
vi.mock('../../hooks/useCowLimitOrder', () => ({ useCowLimitOrder: () => ({ records: [] }) }));

import { LimitOrderTab } from './LimitOrderTab';

const order = (targetPrice: string): LimitOrder => ({
  id: `o-${targetPrice}`, fromToken: ETH, toToken: TOWELI, amount: '0.01', targetPrice,
  createdAt: 1, expiresAt: Date.now() + 86_400_000, status: 'active',
});

describe('limit order row: the target price keeps its rounding', () => {
  it.each([
    ['0.5', '1'],
    ['2.6', '3'],
    ['1234.5', '1235'],
    ['2.4', '2'],
  ])('a price of %s reads "@ %s"', (price, shown) => {
    limit.orders = [order(price)];
    render(<LimitOrderTab />);
    expect(screen.getByText(/^@ /).textContent).toBe(`@ ${shown}`);
  });
});
