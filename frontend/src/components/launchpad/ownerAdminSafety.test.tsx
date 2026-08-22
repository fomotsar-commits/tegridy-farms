// The V2 owner panel drives irreversible, money-carrying writes on a live
// drop. Three of its controls could act on something other than what the
// operator meant.
//
//  - Mint price and wallet cap ran raw parseEther/BigInt on `type=number`
//    fields. Those fields accept "1e3" and "1.5", which both throw — out of a
//    click handler, where the only thing that catches is the page's error
//    boundary. The operator sees a blank page, not a bad field.
//  - The phase grid opened on CLOSED regardless of the phase the contract was
//    actually in, so "Set Phase" was one stray click away from closing a live
//    mint while looking like a no-op.
//  - cancelSale — permanent, refunds every buyer — was guarded by
//    window.confirm, which is one Enter keypress from confirmed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';

const { writeContract, readResults } = vi.hoisted(() => ({
  writeContract: vi.fn(),
  readResults: new Map<string, unknown>(),
}));

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

vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useReadContract: (opts: { functionName: string }) => ({
    data: readResults.get(opts.functionName),
    refetch: vi.fn(),
    isError: false,
    isLoading: false,
  }),
  useWriteContract: () => ({ writeContract, data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
}));

import { OwnerAdminPanelV2 } from './OwnerAdminPanelV2';

const DROP = '0x1234567890123456789012345678901234567890';

function openPanel() {
  renderWithProviders(<OwnerAdminPanelV2 dropAddress={DROP} deployed />);
  fireEvent.click(screen.getByText('Owner Admin (V2)'));
}

beforeEach(() => {
  writeContract.mockReset();
  readResults.clear();
  readResults.set('mintPhase', 2n); // PUBLIC — a live mint
  readResults.set('paused', false);
  readResults.set('totalSupply', 10n);
  readResults.set('maxSupply', 100n);
});

describe('owner panel numeric inputs', () => {
  it('refuses an exponent-notation mint price instead of throwing on click', () => {
    openPanel();
    fireEvent.change(screen.getByPlaceholderText('0.05'), { target: { value: '1e3' } });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect((screen.getByText('Set Price') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a fractional wallet cap', () => {
    openPanel();
    fireEvent.change(screen.getByPlaceholderText('5'), { target: { value: '1.5' } });
    expect((screen.getByText('Set Cap') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the parsed wei for a well-formed price', () => {
    openPanel();
    fireEvent.change(screen.getByPlaceholderText('0.05'), { target: { value: '0.25' } });
    const btn = screen.getByText('Set Price') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'setMintPrice', args: [250_000_000_000_000_000n] }),
      expect.anything(),
    );
  });
});

describe('owner panel phase grid', () => {
  it('opens on the phase the contract is in, not on CLOSED', () => {
    openPanel();
    const publicBtn = screen.getByRole('button', { name: /Public/ });
    expect(publicBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Closed/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('will not fire a phase write that is already the on-chain phase', () => {
    openPanel();
    expect((screen.getByText('Already in this phase') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the destination phase once a different one is chosen', () => {
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /Closed/ }));
    fireEvent.click(screen.getByText(/Set Phase → Closed/));
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'setMintPhase', args: [0] }),
      expect.anything(),
    );
  });

  it('says so when the on-chain phase has not been read', () => {
    readResults.delete('mintPhase');
    openPanel();
    expect(screen.getByText(/not read yet/)).toBeTruthy();
    // With nothing to compare against, the write stays out of reach.
    expect((screen.getByText(/Set Phase →/) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('cancelling a sale', () => {
  it('requires the phrase to be typed, not a dismissable browser dialog', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    openPanel();
    fireEvent.click(screen.getByText('Cancel Sale (Irreversible)'));
    const input = screen.getByLabelText('Type CANCEL SALE to confirm');

    fireEvent.change(input, { target: { value: 'CANCEL' } });
    fireEvent.click(screen.getByText('Cancel Sale'));
    expect(writeContract).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'CANCEL SALE' } });
    fireEvent.click(screen.getByText('Cancel Sale'));
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'cancelSale' }),
      expect.anything(),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('dutch auction start time', () => {
  it('is entered as a wall-clock time and submitted as unix seconds', () => {
    openPanel();
    const field = screen.getByLabelText('Dutch auction start time') as HTMLInputElement;
    expect(field.type).toBe('datetime-local');
    fireEvent.change(field, { target: { value: '2027-01-01T00:00' } });
    const expected = Math.floor(new Date('2027-01-01T00:00').getTime() / 1000);
    expect(screen.getByText(`unix ${expected}`)).toBeTruthy();
  });
});
