// The rows for a DCA schedule or limit order whose sent swap has no receipt yet.
//
// useDCA / useLimitOrders hold such an item back from running again until the
// receipt is read (see their *.unconfirmed tests). These pin the other half:
// the row says so and links the transaction, rather than quietly not swapping,
// and a limit order stuck that way (its transaction dropped or replaced) can
// still be removed.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DCASchedule } from '../../hooks/useDCA';
import type { LimitOrder } from '../../hooks/useLimitOrders';

const HASH = `0x${'ef'.repeat(32)}` as const;
const ETH = { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true };
const TOWELI = { symbol: 'TOWELI', address: `0x${'2'.repeat(40)}`, decimals: 18 };

const { dca, limit, cancelOrder } = vi.hoisted(() => ({
  dca: { schedules: [] as DCASchedule[] },
  limit: { orders: [] as LimitOrder[] },
  cancelOrder: vi.fn(),
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true }) }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../yield/DcaYieldPanel', () => ({ DcaYieldPanel: () => null }));
vi.mock('../ui/InfoTooltip', () => ({ InfoTooltip: () => null }));
vi.mock('../../hooks/useDCA', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useDCA')>()),
  useDCA: () => ({
    schedules: dca.schedules,
    activeSchedules: dca.schedules,
    dueSchedules: [],
    createSchedule: vi.fn(),
    cancelSchedule: vi.fn(),
    pauseSchedule: vi.fn(),
    resumeSchedule: vi.fn(),
  }),
}));
vi.mock('../../hooks/useLimitOrders', () => ({
  useLimitOrders: () => ({ orders: limit.orders, activeOrders: limit.orders, pastOrders: [], createOrder: vi.fn(), cancelOrder }),
}));
vi.mock('../../hooks/useCowLimitOrder', () => ({ useCowLimitOrder: () => ({ records: [] }) }));

import { DCATab } from './DCATab';
import { LimitOrderTab } from './LimitOrderTab';

function schedule(extra: Partial<DCASchedule> = {}): DCASchedule {
  return {
    id: 's1', fromToken: ETH, toToken: TOWELI, amountPerSwap: '0.01', interval: 'daily',
    totalSwaps: 5, completedSwaps: 0, createdAt: 1, lastSwapAt: 0, status: 'active', ...extra,
  };
}

function order(extra: Partial<LimitOrder> = {}): LimitOrder {
  return {
    id: 'o1', fromToken: ETH, toToken: TOWELI, amount: '0.01', targetPrice: '1',
    createdAt: 1, expiresAt: Date.now() + 86_400_000, status: 'active', ...extra,
  };
}

describe('DCA row whose last swap has no receipt yet', () => {
  it('says it is confirming and links the transaction', () => {
    dca.schedules = [schedule({ pendingTx: HASH })];
    render(<DCATab />);
    const link = screen.getByRole('link', { name: 'Confirming' });
    expect(link).toHaveAttribute('href', expect.stringContaining(`/tx/${HASH}`));
  });

  it('shows nothing of the kind for a schedule with no swap out', () => {
    dca.schedules = [schedule()];
    render(<DCATab />);
    expect(screen.queryByRole('link', { name: 'Confirming' })).toBeNull();
  });
});

describe('limit order sent but not settled', () => {
  it('links the transaction and can be removed', () => {
    limit.orders = [order({ status: 'executing', txHash: HASH })];
    render(<LimitOrderTab />);
    expect(screen.getByRole('link', { name: 'View tx' })).toHaveAttribute('href', expect.stringContaining(`/tx/${HASH}`));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(cancelOrder).toHaveBeenCalledWith('o1');
  });

  it('an active order keeps its plain Cancel and no tx link', () => {
    limit.orders = [order()];
    render(<LimitOrderTab />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View tx' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
