// The operator-facing half of launcher revenue.
//
// Two behaviours carry real money and are pinned hardest:
//   1. "Nothing to claim" is reachable ONLY from a genuine all-zero read. A failed read
//      must say so — rendering a confident zero over money we simply failed to look at
//      is the defect this entire subsystem keeps reproducing.
//   2. Withdraw is live only for the integrator wallet, because the Airlock debits
//      msg.sender and no other wallet can succeed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Address } from 'viem';

const INTEGRATOR = '0xD355A072d6bBbA275DBD83A3149f6347b06d1051' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

const account = { address: undefined as Address | undefined };
const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' }));
const publicClient = { waitForTransactionReceipt };
const walletClient = { account: {} };

vi.mock('wagmi', () => ({
  useAccount: () => account,
  usePublicClient: () => publicClient,
  useWalletClient: () => ({ data: walletClient }),
}));

// `vi.hoisted` because the sonner factory dereferences these at factory-eval time (the
// other factories only close over their targets and read them at call time, so plain
// consts are fine there).
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

const collectIntegratorFees = vi.fn();
vi.mock('../../lib/launcher/integratorFees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/launcher/integratorFees')>();
  return { ...actual, collectIntegratorFees: (...a: unknown[]) => collectIntegratorFees(...a) };
});

const hookState = {
  fees: [] as { currency: Address; amount: bigint; symbol: string; decimals: number }[],
  isLoading: false,
  error: null as string | null,
  assetsUnavailable: false,
  checkedCount: 2,
  unreadable: [] as Address[],
  refetch: vi.fn(),
};
vi.mock('../../hooks/useIntegratorFees', () => ({
  useIntegratorFees: () => hookState,
}));

import { IntegratorFeesPanel } from './IntegratorFeesPanel';

beforeEach(() => {
  vi.clearAllMocks();
  account.address = undefined;
  Object.assign(hookState, {
    fees: [],
    isLoading: false,
    error: null,
    assetsUnavailable: false,
    checkedCount: 2,
    unreadable: [],
    refetch: vi.fn(),
  });
});

describe('empty states tell the truth', () => {
  it('says "Nothing to claim" only when every balance genuinely read back zero', () => {
    render(<IntegratorFeesPanel />);
    expect(screen.getByText(/Nothing to claim/i)).toBeInTheDocument();
    expect(screen.getByText(/every\s+one read back zero/i)).toBeInTheDocument();
  });

  it('does NOT say "nothing to claim" when the balances could not be read', () => {
    hookState.unreadable = [NATIVE, OTHER];
    render(<IntegratorFeesPanel />);

    expect(screen.queryByText(/Nothing to claim/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Could not read any/i)).toBeInTheDocument();
    expect(screen.getByText(/not a zero balance/i)).toBeInTheDocument();
  });

  it('flags a PARTIAL read as incomplete rather than presenting it as a total', () => {
    hookState.fees = [{ currency: NATIVE, amount: 10n ** 18n, symbol: 'ETH', decimals: 18 }];
    hookState.unreadable = [OTHER];
    render(<IntegratorFeesPanel />);

    expect(screen.getByText(/incomplete, not a total/i)).toBeInTheDocument();
  });

  it('surfaces a hard read error as an error, not as an empty balance', () => {
    hookState.error = 'rpc down';
    render(<IntegratorFeesPanel />);

    expect(screen.queryByText(/Nothing to claim/i)).not.toBeInTheDocument();
    expect(screen.getByText(/failed read, not a zero balance/i)).toBeInTheDocument();
  });
});

describe('withdraw authorization', () => {
  beforeEach(() => {
    hookState.fees = [{ currency: NATIVE, amount: 2n * 10n ** 18n, symbol: 'ETH', decimals: 18 }];
  });

  it('disables withdraw for a non-integrator wallet but still shows the balance', () => {
    account.address = OTHER;
    render(<IntegratorFeesPanel />);

    expect(screen.getByText(/2\.0000/)).toBeInTheDocument(); // money stays visible
    expect(screen.getByRole('button', { name: /Withdraw ETH integrator fees/i })).toBeDisabled();
    expect(screen.getByText(/READ-ONLY/)).toBeInTheDocument();
  });

  it('enables withdraw for the integrator wallet', () => {
    account.address = INTEGRATOR;
    render(<IntegratorFeesPanel />);

    expect(screen.getByRole('button', { name: /Withdraw ETH integrator fees/i })).toBeEnabled();
    expect(screen.getByText(/INTEGRATOR/)).toBeInTheDocument();
  });

  it('matches the integrator case-insensitively (wallets return varied casing)', () => {
    account.address = INTEGRATOR.toLowerCase() as Address;
    render(<IntegratorFeesPanel />);
    expect(screen.getByRole('button', { name: /Withdraw ETH integrator fees/i })).toBeEnabled();
  });
});

describe('withdrawing', () => {
  beforeEach(() => {
    account.address = INTEGRATOR;
    hookState.fees = [{ currency: NATIVE, amount: 2n * 10n ** 18n, symbol: 'ETH', decimals: 18 }];
  });

  it('sends the full read balance to the connected account and refetches after', async () => {
    collectIntegratorFees.mockResolvedValue('0xhash');
    render(<IntegratorFeesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Withdraw ETH integrator fees/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // `to` is the connected account, never a typed address.
    expect(collectIntegratorFees).toHaveBeenCalledWith(publicClient, walletClient, {
      to: INTEGRATOR,
      currency: NATIVE,
      amount: 2n * 10n ** 18n,
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xhash' });
    expect(hookState.refetch).toHaveBeenCalled();
  });

  it('reports a rejected signature without claiming success or refetching', async () => {
    collectIntegratorFees.mockRejectedValue({ shortMessage: 'User rejected the request.' });
    render(<IntegratorFeesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Withdraw ETH integrator fees/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('User rejected the request.'));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(hookState.refetch).not.toHaveBeenCalled();
  });
});
